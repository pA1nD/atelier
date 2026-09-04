/* atelier 2.0 client — the fork of the 1.x client (shell/DESIGN.md §4; PLAN §4.9 step 4b).
 *
 * Built by the shell (client/build.mjs → esbuild, one bundle) and served at /assets/client.js as
 * an ES module after the React + ReactDOM UMDs (client/index.html). The chrome (rail, topbar,
 * banner, layout, fonts, tokens — everything visual) is a separate module the shell advertises in
 * the bootstrap; the client ships zero styled pixels.
 *
 * What the client does:
 *   • one events socket per document (client/bridge.js): per-topic cursors kept across sockets,
 *     resume / gap / snapshot, the tab liveness probe and the foreground hook
 *   • window.__atelier: subscribe, self (three-base, client/self.js), navigate, useRoute
 *   • URL routing `/<company>/<app>[/<rest>]` (client/route.js)
 *   • the chrome from the bootstrap (exactly the document's chrome), the active app lazily; every
 *     asset URL carries `?rev=N` — never `?v=` — except a chrome by DIGEST (`boot.chromeBase`, step 7
 *     ship C): `/_chrome/<digest>/…`, immutable, no cache-buster (client/chrome.js)
 *   • each loaded app subscribes on its instance topic: an invalidate → `GET /_atelier/topics/
 *     <instance>` → `{rev, error}` → re-import at the new rev (+ the sheet swap when active), the
 *     overlay for a build/load failure of the running save
 *   • the document subscribes on `company:<c>` → `GET /_atelier/rail` → module rows replaced in
 *     state; a moved chrome digest FOR THIS ROUTE → full reload (a chrome cannot swap inside a
 *     document): an app document is compared against its row's `chromeDigest`, an app-less one
 *     against the rail's default — never an app document against the default (client/chrome.js)
 *   • the per-app stylesheet swap on SPA navigation (client/sheet.js)
 *   • the picker → a full page load (client/picker.js: portal POST in the fleet, href locally)
 *   • the waking fallback (client/waking.js) when the shell answers 503 {waking:true}
 *   • the always-on error reporter (client/reporter.js → POST /_atelier/report)
 *
 * Gone from 1.x: the `shell` topic (reserved), `?v=` cache busting, `meta.eager`, `TopBarCenter`,
 * the takeover boot, the observe-gated reporter, `/_atelier/client-errors`, `boot.backendErrors`
 * (always empty — the overlay is fed by topic snapshots).
 * ========================================================================= */

import { resolveModuleChrome, missingChrome } from '../chrome-resolve.js';
import { createBridge } from './bridge.js';
import { self as selfOf } from './self.js';
import { parseUrl, buildUrl } from './route.js';
import { swapSheet, sheetHref } from './sheet.js';
import { chromeUrl, railDefault, chromeMoved, targetDigest } from './chrome.js';
import { pickTarget, performPick } from './picker.js';
import { createReporter } from './reporter.js';
import { isWakingResponse, startWakePoll, wakeUrl, WAKE_GIVE_UP_MS, WAKE_GIVE_UP_FLEET_MS } from './waking.js';

const { useState, useEffect, useRef } = React;

/* =========================================================================
 * Bootstrap (shell/DESIGN.md §2.1). ONE company per document.
 * ========================================================================= */
const boot = window.__ATELIER__ || { mode: 'host', user: { id: 'local', name: 'local', workspaces: [] }, companies: [], chromes: [] };
const COMPANY = boot.workspace || boot.user?.workspaces?.[0]?.id || null;

// Module rows: bootstrap shape `{id, instance, rev, hasFrontend, meta}` → the client's rows.
function rowsOf(list, company) {
  const out = [];
  for (const m of list || []) {
    if (!m || !m.id) continue;
    out.push({
      id: m.id, qid: `${company}/${m.id}`, workspace: company,
      instance: m.instance || null, rev: m.rev ?? null,
      hasFrontend: m.hasFrontend !== false, meta: m.meta || {},
      chromeDigest: m.chromeDigest ?? null,               // the digest ITS computer reports (step 7 ship C); null = the default
    });
  }
  return out;
}
// The live rows, readable outside React (self().subscribe maps qid → instance through them).
let currentModules = rowsOf(boot.user?.workspaces?.find((w) => w.id === COMPANY)?.modules, COMPANY);
const rowByQid = (qid) => currentModules.find((m) => m.qid === qid) || null;
const instanceFor = (company, app) => (company === COMPANY ? rowByQid(`${company}/${app}`)?.instance || null : null);

/* =========================================================================
 * The events socket + window.__atelier
 * ========================================================================= */
// A fork served through the host's dev shell (a `?token=` in the document URL) keeps working; the
// 2.0 document has no token in its URL — the browser talks to the shell, never the host.
const DEV_TOKEN = (() => { try { return new URLSearchParams(window.location.search).get('token'); } catch { return null; } })();
const withDevToken = (url) => (DEV_TOKEN ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(DEV_TOKEN)}` : url);

// Locally the shell learns the document's company from `?company=` (the fleet derives it from the Host
// and ignores the query) — the socket's `company:<c>` ACL and /_atelier/rail need it.
const withCompany = (url) => (COMPANY ? `${url}${url.includes('?') ? '&' : '?'}company=${encodeURIComponent(COMPANY)}` : url);
const WS_URL = withDevToken(withCompany(`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/_atelier/ws`));
const bridge = createBridge({
  url: WS_URL, WebSocket: window.WebSocket, fetch: (u, o) => window.fetch(u, o), now: () => Date.now(),
  setTimeout: (f, ms) => window.setTimeout(f, ms), clearTimeout: (t) => window.clearTimeout(t),
  setInterval: (f, ms) => window.setInterval(f, ms), clearInterval: (t) => window.clearInterval(t),
  isHidden: () => document.visibilityState === 'hidden',
  onState: (state) => { try { window.dispatchEvent(new CustomEvent('atelier:connection', { detail: { state } })); } catch {} },
  snapshotUrl: (topic) => withDevToken(withCompany(`/_atelier/topics/${encodeURIComponent(topic)}`)),
  whoamiUrl: withDevToken('/_atelier/whoami'),
});
// The foreground hook (§4.4 tab liveness): hidden time is measured inside the bridge with Date.now().
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') bridge.onHidden(); else bridge.onForeground('visibilitychange');
});
window.addEventListener('online', () => bridge.onForeground('online'));
window.addEventListener('pageshow', (e) => { if (e.persisted) bridge.onForeground('pageshow'); });

const subscribe = (topic, handler) => bridge.subscribe(topic, handler);
bridge.start();

window.__atelier = window.__atelier || {};
Object.assign(window.__atelier, {
  subscribe,
  withDevToken,
  // Workspace-aware self-identity for a module frontend (client/self.js): pass `import.meta.url`.
  //   const self = window.__atelier.self(import.meta.url);
  //   self.subscribe((ev) => { … });     // invalidations on the app's instance topic — never hardcode
  //   fetch(self.api + '/items');         // /api/<company>/<app>/items
  self: (metaUrl) => selfOf(metaUrl, { instanceFor, subscribe }),
  bridge,                                 // the drill's debug hook (bridge.state(), bridge.mark())
});

/* =========================================================================
 * URL routing — every URL is company-qualified (client/route.js).
 * ========================================================================= */
const parseHere = () => parseUrl(window.location.pathname);

window.__atelier.navigate = (sub, opts) => {
  const { ws, id } = parseHere();
  if (!ws || !id) return;                 // not inside an app — nothing to route
  const target = buildUrl(ws, id, sub || '');
  if (target !== window.location.pathname) {
    window.history[opts && opts.replace ? 'replaceState' : 'pushState'](null, '', target);
  }
  window.dispatchEvent(new CustomEvent('atelier:route'));
};

window.__atelier.useRoute = () => {
  const R = window.React;
  const [, bump] = R.useState(0);
  R.useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener('popstate', on);
    window.addEventListener('atelier:route', on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('atelier:route', on);
    };
  }, []);
  return { path: parseHere().rest, navigate: window.__atelier.navigate };
};

/* =========================================================================
 * The error reporter — always on (client/reporter.js). Reports carry the ACTIVE app's
 * instance and rev; `activeRef` is kept current by App.
 * ========================================================================= */
const activeRef = { qid: null, rev: null };
const reporter = createReporter({
  fetch: (u, o) => window.fetch(u, o),
  context: () => { const m = activeRef.qid ? rowByQid(activeRef.qid) : null; return m && m.instance ? { instance: m.instance, rev: activeRef.rev ?? m.rev ?? null } : null; },
  url: withDevToken('/_atelier/report'),
  page: () => window.location.href,
  ua: navigator.userAgent,
});
reporter.install(window, console);

/* =========================================================================
 * Bundle loading — `/modules/<c>/<s>/frontend.js?rev=N` always (the host serves exactly that
 * revision, ETag "rev-N"); the loader returns {Module, chrome, meta} only.
 * ========================================================================= */
const bundleUrl = (qid, rev) => withDevToken(`/modules/${qid}/frontend.js${rev != null ? `?rev=${encodeURIComponent(rev)}` : ''}`);

async function loadModuleBundle(qid, rev, url = bundleUrl(qid, rev)) {
  try {
    const mod = await import(url);
    const Module = typeof mod.default === 'function' ? mod.default : null;
    const ChromeFn = typeof mod.chrome === 'function' ? mod.chrome : null;
    return { status: 'ok', Module, chrome: ChromeFn, hasDefault: !!Module, meta: mod.meta || {}, rev };
  } catch (err) {
    console.error(`[atelier] failed to load bundle '${qid}':`, err);
    return { status: 'error', err, rev };
  }
}

// A failed import does not say why; ask the shell whether the computer is waking — THAT app's (`app` = its slug: a
// multi-pod company's probe names the computer that is asleep, and the shell wakes it), the company's freshest without one.
async function probeWaking(app = null) {
  try {
    const r = await window.fetch(withDevToken(wakeUrl(COMPANY, app)), { cache: 'no-store', credentials: 'same-origin' });
    if (isWakingResponse(r)) return true;
    if (!r.ok) return false;
    const j = await r.json().catch(() => ({}));
    return j && j.ok === false;
  } catch { return false; }
}

async function fetchJson(url) {
  const r = await window.fetch(withDevToken(url), { cache: 'no-store', credentials: 'same-origin' });
  if (isWakingResponse(r)) { const e = new Error('waking'); e.waking = true; throw e; }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* =========================================================================
 * Plain fallbacks — deliberately ugly so a broken setup is loud.
 * ========================================================================= */
const PRE_STYLE = { padding: 24, margin: 0, minHeight: '100vh', colorScheme: 'light dark', fontFamily: 'ui-monospace, monospace', fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' };

function ChromeMissingFallback({ qid, err }) {
  const body = err
    ? `atelier — chrome '${qid}' failed to load.\n\n${String(err?.stack || err?.message || err)}`
    : `atelier — no chrome installed.\n\n`
      + `The shell ships no theme. Add a chrome module: a folder with a\n`
      + `frontend.jsx exporting\n\n`
      + `    export const meta = { isChrome: true, hidden: true }\n`
      + `    export function chrome(props) { /* render the shell UI */ }\n\n`
      + `Discover it as a global module, or name it in atelier.config.json.`;
  return React.createElement('pre', { style: PRE_STYLE }, body);
}

// The company's computer is asleep or restarting: poll /_atelier/wake (2 s → 10 s; the shell wakes it on the first
// miss) and reload on ok. `app` = the active app's slug, so a multi-pod company's poll names the computer that is
// asleep. Bounded like the shell's page (60 s locally, 180 s in the fleet — a cold pod birth; `boot.portal` says which):
// past it the copy says the wake is taking unusually long; a tab coming back to the front probes again (waking.js).
function WakingFallback({ company, app }) {
  const [tries, setTries] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => startWakePoll({
    fetch: (u, o) => window.fetch(withDevToken(u), o),
    setTimeout: (f, ms) => window.setTimeout(f, ms), clearTimeout: (t) => window.clearTimeout(t),
    company, app, reload: () => window.location.reload(), onTick: () => { setTries((n) => n + 1); setGaveUp(false); }, onGiveUp: () => setGaveUp(true),
    giveUpMs: boot.portal ? WAKE_GIVE_UP_FLEET_MS : WAKE_GIVE_UP_MS, document,
  }), [company, app]);
  return React.createElement('pre', { style: PRE_STYLE }, gaveUp
    ? `atelier — the computer for '${company}' is taking unusually long to wake.\n\nThis page has stopped checking. Wait a minute, then reload it.`
    : `atelier — the computer for '${company}' is waking up.\n\nThis page reloads itself when it answers${tries ? ` (checked ${tries}×)` : ''}.`);
}

// Dev overlay for a backend that failed to (re)load, scoped to the ACTIVE app. Fed by the app's
// topic snapshot (`error`); clears itself when the next snapshot carries none.
function BackendErrorOverlay({ error }) {
  if (!error) return null;
  const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  return React.createElement('div', {
    style: { position: 'fixed', inset: 0, zIndex: 2147483647, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(2px)', colorScheme: 'dark', font: `13px/1.6 ${mono}` },
  },
    React.createElement('div', { style: { width: 'min(820px, 100%)', maxHeight: '85vh', overflow: 'auto', background: '#0a0a0a', color: '#ededed', border: '1px solid #2a2a2a', borderRadius: 12, boxShadow: '0 24px 70px rgba(0,0,0,0.6)' } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px', borderBottom: '1px solid #2a2a2a' } },
        React.createElement('span', { style: { padding: '2px 8px', borderRadius: 6, fontWeight: 600, fontSize: 11, background: 'rgba(248,113,113,0.12)', color: '#f87171', border: '1px solid rgba(248,113,113,0.4)', textTransform: 'uppercase', letterSpacing: '.05em' } }, 'Backend Error'),
        React.createElement('span', { style: { color: '#a1a1a1' } }, error.qid),
      ),
      React.createElement('pre', { style: { margin: 0, padding: '18px 20px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, error.message),
      React.createElement('div', { style: { padding: '10px 20px', borderTop: '1px solid #2a2a2a', color: '#7a7a7a', fontSize: 12 } }, 'Clears automatically when the backend reloads cleanly.'),
    ),
  );
}

// The chrome is the React root; a throw in its render is contained to its subtree so the
// client (and its socket) stays mounted and a chrome edit reloads to recover.
class ChromeErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error('[atelier] chrome render error:', err, info?.componentStack || ''); }
  render() {
    if (!this.state.err) return this.props.children;
    const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';
    const msg = (this.state.err && (this.state.err.stack || this.state.err.message)) || String(this.state.err);
    return React.createElement('div', {
      style: { position: 'fixed', inset: 0, zIndex: 2147483647, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(2px)', colorScheme: 'dark', font: `13px/1.6 ${mono}` },
    },
      React.createElement('div', { style: { width: 'min(820px, 100%)', maxHeight: '85vh', overflow: 'auto', background: '#0a0a0a', color: '#ededed', border: '1px solid #2a2a2a', borderRadius: 12, boxShadow: '0 24px 70px rgba(0,0,0,0.6)' } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px', borderBottom: '1px solid #2a2a2a' } },
          React.createElement('span', { style: { padding: '2px 8px', borderRadius: 6, fontWeight: 600, fontSize: 11, background: 'rgba(248,113,113,0.12)', color: '#f87171', border: '1px solid rgba(248,113,113,0.4)', textTransform: 'uppercase', letterSpacing: '.05em' } }, 'Chrome Error'),
          React.createElement('span', { style: { color: '#a1a1a1' } }, this.props.qid || ''),
        ),
        React.createElement('pre', { style: { margin: 0, padding: '18px 20px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, msg),
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 20px', borderTop: '1px solid #2a2a2a', color: '#7a7a7a', fontSize: 12 } },
          React.createElement('span', null, 'The chrome crashed while rendering — fix it and the page reloads automatically.'),
          React.createElement('button', { onClick: () => window.location.reload(), style: { background: '#ededed', color: '#0a0a0a', border: 'none', borderRadius: 6, padding: '4px 10px', fontWeight: 600, cursor: 'pointer', font: 'inherit' } }, 'Reload'),
        ),
      ),
    );
  }
}

// Per-app render-crash boundary; resets when the app's component identity changes (a hot swap).
class ModuleCrashBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error(`[atelier] module '${this.props.qid}' render crashed:`, err, info?.componentStack || ''); }
  componentDidUpdate(prev) {
    if (this.state.err && prev.moduleType !== this.props.moduleType) this.setState({ err: null });
  }
  render() {
    if (!this.state.err) return this.props.children;
    const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';
    const msg = (this.state.err && (this.state.err.stack || this.state.err.message)) || String(this.state.err);
    return React.createElement('div', { style: { padding: 24, colorScheme: 'dark', font: `13px/1.6 ${mono}` } },
      React.createElement('div', { style: { maxWidth: 820, background: '#0a0a0a', color: '#ededed', border: '1px solid #2a2a2a', borderRadius: 12, overflow: 'hidden' } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px', borderBottom: '1px solid #2a2a2a' } },
          React.createElement('span', { style: { padding: '2px 8px', borderRadius: 6, fontWeight: 600, fontSize: 11, background: 'rgba(248,113,113,0.12)', color: '#f87171', border: '1px solid rgba(248,113,113,0.4)', textTransform: 'uppercase', letterSpacing: '.05em' } }, 'Render Error'),
          React.createElement('span', { style: { color: '#a1a1a1' } }, this.props.qid || '')),
        React.createElement('pre', { style: { margin: 0, padding: '18px 20px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, msg),
        React.createElement('div', { style: { padding: '10px 20px', borderTop: '1px solid #2a2a2a', color: '#7a7a7a', fontSize: 12 } }, 'Clears automatically when the module renders without throwing.')));
  }
}

/* =========================================================================
 * App
 * ========================================================================= */
function App() {
  const user = boot.user || { id: 'local', name: 'local', workspaces: [] };
  const chromeQid = boot.chromeQid || null;
  const chromeRev = boot.chromeRev ?? null;
  const chromeBase = boot.chromeBase || null;             // `/_chrome/<digest>` when the document is composed by digest
  // The shell advertises exactly the document's chrome: an app pinning another `meta.chrome`
  // renders the error below; `requiredChromeForQid` never crosses chromes.
  const defaultChromeQid = boot.defaultChromeQid || boot.chromeQid || null;
  const availableChromes = boot.chromes || (chromeQid ? [chromeQid] : []);

  const [modules, setModulesState] = useState(() => currentModules);
  const setModules = (rows) => { currentModules = rows; setModulesState(rows); };
  const wsList = (user.workspaces || []).map((w) => (w.id === COMPANY ? { ...w, modules } : w));
  const [urlState, setUrlState] = useState(parseHere);
  const [loaded, setLoaded] = useState({});             // qid → load entry
  const [chromeEntry, setChromeEntry] = useState(null);
  const [backendErrors, setBackendErrors] = useState([]);   // [{qid, message}] from topic snapshots
  const [waking, setWaking] = useState(false);

  // Canonicalise `/`: land on the company's primary app, else its home.
  useEffect(() => {
    if (urlState.ws || !COMPANY) return;
    const primary = modules.find((m) => m.meta?.primary);
    const target = primary ? buildUrl(COMPANY, primary.id) : buildUrl(COMPANY, null);
    window.history.replaceState(null, '', target);
    setUrlState(parseHere());
  }, [urlState.ws]);
  const effectiveWorkspace = urlState.ws || COMPANY;

  // The chrome bundle at the chrome's revision — by digest the immutable `/_chrome/<digest>/frontend.js` (client/chrome.js).
  useEffect(() => {
    if (!chromeQid) return;
    let cancelled = false;
    loadModuleBundle(chromeQid, chromeRev, withDevToken(chromeUrl({ chromeQid, chromeRev, chromeBase }, 'frontend.js'))).then(async (res) => {
      if (cancelled) return;
      if (res.status === 'error' && await probeWaking()) { setWaking(true); return; }
      setChromeEntry(res);
    });
    return () => { cancelled = true; };
  }, [chromeQid]);

  // Loading is LAZY: the chrome plus the app being viewed, nothing else. `loadingRef` dedupes;
  // `revRef` is the rev each qid is being IMPORTED at (set when the import starts — the sheet swap
  // and the ≤-known dedupe read it), `runningRef` the rev whose bundle is RENDERING (set when the
  // import commits — error reports read it: an error thrown by the old bundle during a re-import
  // window belongs to the old rev); `tokenRef` guards out-of-order re-imports.
  const loadingRef = useRef(new Set());
  const revRef = useRef(new Map());
  const runningRef = useRef(new Map());
  const tokenRef = useRef(new Map());
  const importAt = (qid, rev) => {
    const token = (tokenRef.current.get(qid) || 0) + 1;
    tokenRef.current.set(qid, token);
    revRef.current.set(qid, rev);
    loadModuleBundle(qid, rev).then(async (res) => {
      if (tokenRef.current.get(qid) !== token) return;   // superseded by a newer rev
      if (res.status === 'error' && await probeWaking(qid.split('/')[0] === COMPANY ? qid.split('/')[1] : null)) { setWaking(true); return; }
      if (res.status === 'ok') runningRef.current.set(qid, rev);
      setLoaded((l) => ({ ...l, [qid]: res }));
    });
  };
  const loadOne = (qid) => {
    if (!qid || loadingRef.current.has(qid)) return;
    loadingRef.current.add(qid);
    importAt(qid, rowByQid(qid)?.rev ?? null);
  };

  // popstate / sub-route nav → re-parse the URL.
  useEffect(() => {
    const onPop = () => setUrlState(parseHere());
    window.addEventListener('popstate', onPop);
    window.addEventListener('atelier:route', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('atelier:route', onPop);
    };
  }, []);

  const activeMod = (urlState.ws && urlState.id) ? modules.find((m) => m.workspace === urlState.ws && m.id === urlState.id) : null;
  const activeQid = activeMod?.qid || null;
  activeRef.qid = activeQid;
  activeRef.rev = activeQid ? (runningRef.current.get(activeQid) ?? null) : null;   // never the importing rev; the reporter falls back to the row's rev before the first import commits

  useEffect(() => { if (activeMod?.hasFrontend) loadOne(activeMod.qid); }, [activeQid]);

  // The per-app sheet: on every navigation the link moves to the route's sheet (the initial
  // document already carries it — an equal href is a no-op).
  useEffect(() => {
    const href = activeMod
      ? sheetHref({ company: activeMod.workspace, slug: activeMod.id, rev: revRef.current.get(activeMod.qid) ?? activeMod.rev }, { qid: chromeQid, rev: chromeRev, base: chromeBase })
      : sheetHref(null, { qid: chromeQid, rev: chromeRev, base: chromeBase });
    if (href) swapSheet(document, href);
  }, [activeQid]);

  // A URL that points nowhere → tidy back to a real place (1.x behaviour).
  useEffect(() => {
    const wsExists = wsList.some((w) => w.id === urlState.ws);
    if (urlState.id === null) {
      if (!urlState.ws || wsExists) return;
      window.history.replaceState(null, '', '/');
      setUrlState(parseHere());
      return;
    }
    if (activeMod) return;
    window.history.replaceState(null, '', wsExists ? buildUrl(urlState.ws, null) : '/');
    setUrlState(parseHere());
  }, [activeQid, activeMod, urlState.ws, urlState.id, wsList.length, modules]);

  // ---- topic state: {rev, error} per app from its instance topic ----------------------------
  const activeQidRef = useRef(activeQid); activeQidRef.current = activeQid;
  const applyTopic = (qid, snap) => {
    if (!snap || typeof snap !== 'object') return;
    setBackendErrors((prev) => {
      const next = prev.filter((e) => e.qid !== qid);
      if (snap.error && snap.error.message) next.push({ qid, message: snap.error.hint || snap.error.message });   // the hint is `file:line:col message — fix`
      return next;
    });
    if (snap.rev == null) return;
    const known = revRef.current.get(qid);
    if (known != null && Number(snap.rev) <= Number(known)) return;
    setModules(currentModules.map((m) => (m.qid === qid ? { ...m, rev: snap.rev } : m)));
    if (!loadingRef.current.has(qid)) return;          // never imported here: its first visit imports the current rev
    importAt(qid, snap.rev);
    if (activeQidRef.current === qid) {
      const m = rowByQid(qid);
      if (m) swapSheet(document, sheetHref({ company: m.workspace, slug: m.id, rev: snap.rev }, null));
    }
  };
  const subsRef = useRef(new Map());                     // qid → unsubscribe
  useEffect(() => {
    for (const qid of Object.keys(loaded)) {
      if (subsRef.current.has(qid)) continue;
      const m = rowByQid(qid);
      if (!m || !m.instance) continue;
      const topic = m.instance;
      subsRef.current.set(qid, subscribe(topic, (ev) => {
        if (ev.type === 'snapshot') { applyTopic(qid, ev.snapshot); return; }
        if (ev.type === 'invalidate') { fetchJson(withCompany(`/_atelier/topics/${encodeURIComponent(topic)}`)).then((s) => applyTopic(qid, s)).catch((e) => { if (e.waking) setWaking(true); }); return; }
        if (ev.type === 'waking') setWaking(true);
      }));
    }
  }, [loaded]);
  useEffect(() => () => { for (const off of subsRef.current.values()) off(); subsRef.current.clear(); }, []);

  // ---- the rail: `company:<c>` → /_atelier/rail → module rows; a moved chrome digest FOR THIS ROUTE → reload ----
  // (client/chrome.js: the active app's row `chromeDigest`, the rail's default on an app-less route — the digest the
  // shell composed THIS document with; `railDefaultRef` remembers the default for navigation across computers)
  const railDefaultRef = useRef(null);
  const applyRail = (rail) => {
    if (!rail || typeof rail !== 'object') return;
    railDefaultRef.current = railDefault(rail);
    const active = activeQidRef.current ? activeQidRef.current.split('/')[1] : null;
    if (chromeMoved(chromeRev, rail, active)) { window.location.reload(); return; }
    if (Array.isArray(rail.modules)) {
      const rows = rowsOf(rail.modules, COMPANY);
      for (const r of rows) { const known = revRef.current.get(r.qid); if (known != null && r.rev != null && Number(r.rev) < Number(known)) r.rev = known; }
      setModules(rows);
    }
  };
  useEffect(() => {
    if (!COMPANY) return;
    return subscribe(`company:${COMPANY}`, (ev) => {
      if (ev.type === 'snapshot') { applyRail(ev.snapshot); return; }
      if (ev.type === 'invalidate') { fetchJson(withCompany('/_atelier/rail')).then(applyRail).catch((e) => { if (e.waking) setWaking(true); }); return; }
      if (ev.type === 'waking') setWaking(true);
    });
  }, []);

  // ---- chrome resolution (chrome-resolve.js: the same rule as the shell's) ----
  function chromeForMeta(meta) { return resolveModuleChrome(meta?.chrome, availableChromes, defaultChromeQid); }
  function requiredChromeForQid(qid) {
    const [ws, id] = (qid || '').split('/');
    if (!ws || !id) return defaultChromeQid;
    const m = modules.find((x) => x.qid === qid);
    return chromeForMeta((loaded[qid]?.meta) || m?.meta || {});
  }
  function pinnedChromeMissing(qid) {
    const [ws, id] = (qid || '').split('/');
    if (!ws || !id) return null;
    const m = modules.find((x) => x.qid === qid);
    return missingChrome(((loaded[qid]?.meta) || m?.meta || {}).chrome, availableChromes);
  }

  function navigateTo(target) {
    const here = window.location.pathname + window.location.search;
    if (here !== target) {
      window.history.pushState(null, '', target);
      window.dispatchEvent(new CustomEvent('atelier:navigate', { detail: { url: target } }));
    }
    setUrlState(parseHere());
  }
  function navigateByQid(qid) {
    const [ws, id] = String(qid || '').split('/');
    if (!ws) return;
    const target = id ? buildUrl(ws, id) : buildUrl(ws, null);
    if (ws !== COMPANY) {                                   // another company is another document
      const t = pickTarget(boot, ws);
      performPick(document, t && t.kind === 'assign' ? { kind: 'assign', href: target } : t);
      return;
    }
    if (requiredChromeForQid(id ? qid : null) !== chromeQid) { window.location.assign(target); return; }
    // another computer's app may render another chrome digest (its host's): that document is another page load
    const want = targetDigest({ row: id ? rowByQid(qid) : null, railDefault: railDefaultRef.current, bootRev: chromeRev });
    if (chromeRev != null && want != null && String(want) !== String(chromeRev)) { window.location.assign(target); return; }
    navigateTo(target);
  }
  // The picker: a full page load in both modes (client/picker.js). Our own company's home is an app-less document: it
  // renders the rail's DEFAULT digest, so from an app document on another digest it is a page load too (client/chrome.js).
  function pickWorkspace(ws) {
    if (ws === COMPANY) {
      const target = buildUrl(ws, null);
      const want = targetDigest({ row: null, railDefault: railDefaultRef.current, bootRev: chromeRev });
      if (chromeRev != null && want != null && String(want) !== String(chromeRev)) { window.location.assign(target); return; }
      navigateTo(target); return;
    }
    performPick(document, pickTarget(boot, ws));
  }

  if (waking) return React.createElement(WakingFallback, { company: COMPANY || '', app: activeQid ? activeQid.split('/')[1] : null });
  if (!chromeQid) return React.createElement(ChromeMissingFallback, { qid: null });
  if (!chromeEntry) return null;                          // still loading — empty body, no flash
  if (chromeEntry.status !== 'ok' || typeof chromeEntry.chrome !== 'function') {
    return React.createElement(ChromeMissingFallback, { qid: chromeQid, err: chromeEntry.err || new Error('module exports no `chrome` function') });
  }
  const Chrome = chromeEntry.chrome;

  const entry = activeMod ? loaded[activeMod.qid] : null;
  const missingChromeName = activeMod ? pinnedChromeMissing(activeMod.qid) : null;
  let active;
  if (!activeMod) {
    active = { kind: 'none' };
  } else if (missingChromeName) {
    active = {
      kind: 'error', qid: activeMod.qid,
      err: new Error(`This module is pinned to the "${missingChromeName}" chrome via meta.chrome, but that chrome isn't installed on this instance. Install it (mount the chrome module), or remove meta.chrome to use the default chrome.`),
    };
  } else if (!entry) {
    active = { kind: 'loading', qid: activeMod.qid };
  } else if (entry.status === 'error') {
    active = { kind: 'error', qid: activeMod.qid, err: entry.err };
  } else if (!entry.Module) {
    active = { kind: 'error', qid: activeMod.qid, err: new Error('no default export') };
  } else {
    const M = entry.Module;
    active = { kind: 'ready', qid: activeMod.qid, element: React.createElement(ModuleCrashBoundary, { qid: activeMod.qid, moduleType: M }, React.createElement(M)) };
  }

  // The chrome contract (chromeApi: 2): the 1.x prop set minus slot claims.
  return React.createElement(React.Fragment, null,
    React.createElement(ChromeErrorBoundary, { qid: chromeQid },
      React.createElement(Chrome, {
        boot, user,
        modules, workspaces: wsList, workspace: effectiveWorkspace || '',
        activeQid, active, loadedModules: loaded,
        navigate: navigateByQid, pickWorkspace,
      })),
    React.createElement(BackendErrorOverlay, { error: backendErrors.find((e) => e.qid === activeQid) || null }),
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
