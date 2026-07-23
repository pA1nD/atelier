/* atelier client — shell-side router + bundle loader.
 *
 * Compiled by esbuild, served at /assets/client.js, loaded as an ES module
 * after React + ReactDOM (UMD served by the shell — see index.html). The chrome
 * (rail, topbar, banner, layout, fonts, tokens — everything visual) lives
 * in a separate `chrome`-slot module. The shell ships no default chrome.
 *
 * What the shell does:
 *   • Establishes the shared WebSocket multiplex (window.__atelier.subscribe)
 *   • Resolves which chrome module is active (server tells us via
 *     window.__ATELIER__.chromeQid) and dynamic-imports its bundle
 *   • Owns URL routing (`/<workspace>/<id>`) and exposes the per-module
 *     sub-route below it to modules (window.__atelier.useRoute → /<ws>/<id>/<rest>)
 *   • Loads each accessible module's bundle (parallel) and tracks state
 *   • Renders the chrome component with active-module state
 *   • Handles takeover boot (auth handed off) by rendering the auth bundle
 *     bare — chrome is bypassed for takeover so login UI ships its own visuals
 *
 * What the shell does NOT do:
 *   • Render any styled UI. The only visible bytes from the shell are the
 *     plaintext error fallbacks below (chrome bundle missing/failed). If
 *     you see those, something is genuinely broken.
 * ========================================================================= */

import { resolveModuleChrome, missingChrome } from './chrome-resolve.js';

const { useState, useEffect, useRef } = React;

/* =========================================================================
 * Shared WebSocket multiplex — one connection per tab, multiple topics.
 *
 * Frames are JSON `{ topic, ...event }`. Modules call:
 *   const unsub = window.__atelier.subscribe(topic, (event) => { … });
 *
 * Reconnects with exponential backoff. Emits `atelier:connection` window
 * events ('online' | 'offline' | 'unauthed') used by the chrome's banner.
 * ========================================================================= */
(function wireWsBridge() {
  if (typeof window === 'undefined') return;
  if (window.__atelier?.subscribe) return;
  window.__atelier = window.__atelier || {};

  const subscribers = new Map();
  let ws = null;
  let backoff = 250;
  let reconnectTimer = null;

  const OFFLINE_GRACE_MS = 2500;
  let connState = 'online';
  let offlineTimer = null;
  function setConnState(next) {
    if (connState === next) return;
    connState = next;
    try {
      window.dispatchEvent(new CustomEvent('atelier:connection', { detail: { state: next } }));
    } catch {}
  }

  async function probeAuth() {
    const r = await fetch('/_atelier/whoami', { cache: 'no-store', credentials: 'same-origin' });
    return r.status;
  }

  function armOfflineTimer() {
    if (offlineTimer) return;
    offlineTimer = setTimeout(async () => {
      offlineTimer = null;
      if (ws && ws.readyState === 1) return;
      try {
        const status = await probeAuth();
        if (status === 200) return;
        if (status === 401) { setConnState('unauthed'); return; }
        setConnState('offline');
      } catch {
        setConnState('offline');
      }
    }, OFFLINE_GRACE_MS);
  }
  function clearOfflineTimer() {
    if (!offlineTimer) return;
    clearTimeout(offlineTimer);
    offlineTimer = null;
  }

  function dispatch(frame) {
    const topic = frame?.topic;
    if (!topic) return;
    const fns = subscribers.get(topic);
    if (!fns) return;
    for (const fn of fns) {
      try { fn(frame); } catch (err) {
        console.warn('[atelier] subscribe handler threw:', err);
      }
    }
  }

  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      ws = new WebSocket(`${proto}//${window.location.host}/_atelier/ws`);
    } catch {
      armOfflineTimer();
      scheduleReconnect();
      return;
    }
    ws.onmessage = (m) => {
      let frame;
      try { frame = JSON.parse(m.data); } catch { return; }
      dispatch(frame);
    };
    ws.onopen = () => {
      backoff = 250;
      clearOfflineTimer();
      setConnState('online');
    };
    ws.onclose = () => {
      ws = null;
      armOfflineTimer();
      scheduleReconnect();
    };
    ws.onerror = () => { /* close fires next */ };
  }
  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 5000);
  }

  window.__atelier.subscribe = (topic, handler) => {
    if (!topic || typeof handler !== 'function') return () => {};
    let set = subscribers.get(topic);
    if (!set) { set = new Set(); subscribers.set(topic, set); }
    set.add(handler);
    if (!ws) connect();
    return () => {
      const s = subscribers.get(topic);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) subscribers.delete(topic);
    };
  };

  // Workspace-aware self-identity for a module frontend. Pass `import.meta.url`
  // and get back the module's qualifiedId (`<ws>/<id>`, `global` the default),
  // its WS topic, and its API base — all derived from where the module is
  // actually mounted, so the SAME module works in any workspace without
  // hardcoding it. This mirrors how backend routes are workspace-scoped:
  //
  //   const self = window.__atelier.self(import.meta.url);
  //   self.subscribe((frame) => { … });        // listens on '<ws>/<id>' — never hardcode
  //   fetch(self.api + '/items');                // hits /api/<ws>/<id>/items
  window.__atelier.self = (metaUrl) => {
    let qid = '';
    try { qid = new URL('.', metaUrl).pathname.replace(/^\/modules\//, '').replace(/\/+$/, ''); } catch {}
    const [workspace = '', id = ''] = qid.split('/');
    return {
      workspace,
      id,
      qid,
      topic: qid,
      api: qid ? '/api/' + qid : '',
      subscribe: (handler) => window.__atelier.subscribe(qid, handler),
    };
  };

  connect();
})();

/* =========================================================================
 * URL routing — every URL is workspace-qualified.
 *
 *   /                  cold landing — App redirects to the first non-empty
 *                       workspace's home.
 *   /<ws>/             workspace home — no module selected.
 *   /<ws>/<id>         module page.
 *   /<ws>/<id>/<rest…> module sub-route — the shell owns ws+id; `rest` is the
 *                       active module's own space, surfaced via
 *                       window.__atelier.useRoute() (below).
 * ========================================================================= */
function parseUrl() {
  const p = window.location.pathname;
  const m = p.match(
    /^\/([a-zA-Z0-9][a-zA-Z0-9_-]*)(?:\/([a-zA-Z0-9][a-zA-Z0-9_-]*)(?:\/(.*))?)?\/?$/
  );
  if (!m) return { ws: null, id: null, rest: '' };
  return {
    ws: decodeURIComponent(m[1]),
    id: m[2] ? decodeURIComponent(m[2]) : null,
    rest: m[3] ? decodeURIComponent(m[3].replace(/\/+$/, '')) : '',
  };
}

function buildUrl(ws, id, rest) {
  if (!ws) return '/';
  if (!id) return `/${encodeURIComponent(ws)}/`;
  const base = `/${encodeURIComponent(ws)}/${encodeURIComponent(id)}`;
  const sub = rest ? String(rest).replace(/^\/+|\/+$/g, '') : '';
  return sub ? `${base}/${sub}` : base;
}

/* Module sub-routing API — exposed on window.__atelier so modules reach it the
 * same way they reach `subscribe`/`self` (the chrome stays uninvolved). A module
 * reads and drives its own subpath with:
 *
 *   const { path, navigate } = window.__atelier.useRoute()
 *     path                      — subpath after /<ws>/<id> ('' at the module root)
 *     navigate(sub, {replace})  — push (or replace) /<ws>/<id>/<sub>
 *
 * Back/forward, deep-links, and navigate() all re-render the calling module with
 * the new `path` — no history.* calls or hashchange juggling in the module. The
 * topic/qid a module subscribes on is derived from its bundle URL, not the page
 * path, so sub-routing never affects its WebSocket subscription. */
window.__atelier.navigate = (sub, opts) => {
  const { ws, id } = parseUrl();
  if (!ws || !id) return;                 // not inside a module — nothing to route
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
  return { path: parseUrl().rest, navigate: window.__atelier.navigate };
};

/* =========================================================================
 * Module bundle loader.
 *
 * Each module's compiled frontend lives at `/modules/<ws>/<id>/frontend.js`
 * (workspace-qualified — same id in different workspaces gets distinct
 * URLs and distinct browser cache entries). Returns the namespace plus a
 * handful of well-known shape flags (default export → rendered module;
 * TopBarCenter → topbar slot claimer; chrome → chrome slot claimer; meta →
 * icon/name/group).
 * ========================================================================= */
async function loadModuleBundle(qid, bust) {
  // `bust` (a monotonic token) is appended only when re-importing a changed
  // bundle for hot reload: ES module specifiers are URL-keyed, so a fresh
  // query string is what makes the browser fetch + evaluate the new code
  // instead of handing back the cached module. The first (cold) load passes
  // no token — distinct from every later `?v=N`.
  const url = `/modules/${qid}/frontend.js${bust ? `?v=${bust}` : ''}`;
  try {
    const mod = await import(url);
    const Module = typeof mod.default === 'function' ? mod.default : null;
    const TopBarCenter = typeof mod.TopBarCenter === 'function' ? mod.TopBarCenter : null;
    const ChromeFn = typeof mod.chrome === 'function' ? mod.chrome : null;
    return {
      status: 'ok',
      Module,
      TopBarCenter,
      chrome: ChromeFn,
      hasDefault: !!Module,
      meta: mod.meta || {},
    };
  } catch (err) {
    console.error(`[atelier] failed to load bundle '${qid}':`, err);
    return { status: 'error', err };
  }
}

// Hot reload re-imports a module's JS, but the chrome's Tailwind stylesheet is
// a static <link> baked into the document at load. A class the edited module
// *newly* introduces isn't generated into the served CSS until that <link> is
// re-fetched — which a hot-swap, unlike a full reload, never does on its own.
// So re-point the link at a cache-busted URL: the server rebuilds the CSS,
// scanning the module's fresh source, and the class appears. FOUC-free — the
// new sheet loads alongside the old one and the old is dropped only once the
// new is live, so styles never blink off mid-swap. No-op if the chrome ships
// no styles.css (no link to refresh).
let _cssBust = 0;
function refreshChromeStyles() {
  const cur = typeof document !== 'undefined' && document.getElementById('atelier-chrome-styles');
  if (!cur) return;
  const base = (cur.getAttribute('href') || '').split('?')[0];
  if (!base) return;
  const next = cur.cloneNode(false);
  next.setAttribute('href', `${base}?v=${++_cssBust}`);
  const drop = () => { try { cur.remove(); } catch {} };
  next.addEventListener('load', drop);
  next.addEventListener('error', drop);   // a rebuild that 500s shouldn't strand two links
  cur.removeAttribute('id');               // the replacement owns the id from here
  cur.parentNode.insertBefore(next, cur.nextSibling);
}

function flattenUserModules(user) {
  if (!user) return [];
  const out = [];
  for (const ws of user.workspaces || []) {
    for (const m of ws.modules || []) {
      out.push({
        id: m.id,
        qid: `${ws.id}/${m.id}`,
        workspace: ws.id,
        hasFrontend: m.hasFrontend !== false,
        meta: m.meta || {},
      });
    }
  }
  return out;
}

/* =========================================================================
 * Takeover — auth handed off the entire response. Render the auth bundle
 * bare (no chrome). The takeover page owns its own visuals.
 * ========================================================================= */
function Takeover() {
  const [state, setState] = useState({ kind: 'loading' });
  useEffect(() => {
    const bundle = window.__ATELIER__?.moduleBundle;
    if (!bundle) {
      setState({ kind: 'error', message: 'auth bundle missing in takeover bootstrap' });
      return;
    }
    import(bundle)
      .then((m) => {
        const C = typeof m.default === 'function' ? m.default : null;
        if (!C) setState({ kind: 'error', message: 'auth module has no default export' });
        else setState({ kind: 'ok', Component: C });
      })
      .catch((err) => setState({ kind: 'error', message: String(err?.message || err) }));
  }, []);
  if (state.kind === 'loading') return null;
  if (state.kind === 'error') {
    return React.createElement('pre',
      { style: { padding: 24, colorScheme: 'light dark', fontFamily: 'ui-monospace, monospace' } },
      'atelier: takeover failed\n' + state.message);
  }
  const { Component } = state;
  return React.createElement(Component);
}

/* =========================================================================
 * Plain fallbacks rendered when the chrome itself can't load. The shell
 * paints zero styled pixels — these are deliberately ugly so misconfigured
 * chromes are loud.
 * ========================================================================= */
function ChromeMissingFallback({ qid, err }) {
  const body = err
    ? `atelier — chrome '${qid}' failed to load.\n\n${String(err?.stack || err?.message || err)}`
    : `atelier — no chrome installed.\n\n`
      + `The shell ships no theme. Add a chrome module: a folder with a\n`
      + `frontend.jsx exporting\n\n`
      + `    export const meta = { isChrome: true, hidden: true }\n`
      + `    export function chrome(props) { /* render the shell UI */ }\n\n`
      + `Discover it as a global module, or name it in atelier.config.json.`;
  return React.createElement('pre',
    { style: { padding: 24, margin: 0, minHeight: '100vh', colorScheme: 'light dark', fontFamily: 'ui-monospace, monospace', fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' } },
    body);
}

/* =========================================================================
 * App boot
 * ========================================================================= */
// Dev overlay for a backend that failed to (re)load — a centered, Next.js-style
// error modal scoped to the ACTIVE module (the one whose page you're on, so it
// never blocks an unrelated module's page). Streamed live over the 'shell' WS
// topic and seeded from the bootstrap. NOT dismissible — it clears itself the
// moment the backend reloads cleanly (the shell broadcasts a clear). Neutral
// pixels, no chrome tokens. The module's /api returns the same error.
function BackendErrorOverlay({ error }) {
  if (!error) return null;
  const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  return React.createElement('div', {
    style: {
      position: 'fixed', inset: 0, zIndex: 2147483647,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(2px)',
      colorScheme: 'dark', font: `13px/1.6 ${mono}`,
    },
  },
    React.createElement('div', {
      style: {
        width: 'min(820px, 100%)', maxHeight: '85vh', overflow: 'auto',
        background: '#0a0a0a', color: '#ededed',
        border: '1px solid #2a2a2a', borderRadius: 12,
        boxShadow: '0 24px 70px rgba(0,0,0,0.6)',
      },
    },
      React.createElement('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '14px 20px', borderBottom: '1px solid #2a2a2a',
        },
      },
        React.createElement('span', {
          style: {
            padding: '2px 8px', borderRadius: 6, fontWeight: 600, fontSize: 11,
            background: 'rgba(248,113,113,0.12)', color: '#f87171',
            border: '1px solid rgba(248,113,113,0.4)',
            textTransform: 'uppercase', letterSpacing: '.05em',
          },
        }, 'Backend Error'),
        React.createElement('span', { style: { color: '#a1a1a1' } }, error.qid),
      ),
      React.createElement('pre', {
        style: { margin: 0, padding: '18px 20px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      }, error.message),
      React.createElement('div', {
        style: { padding: '10px 20px', borderTop: '1px solid #2a2a2a', color: '#7a7a7a', fontSize: 12 },
      }, 'Clears automatically when the backend reloads cleanly.'),
    ),
  );
}

// The chrome is the React root. A throw in its render used to crash the whole
// client — blank page, and the WS/hot-reload listener (in App's effect) died
// with it, so a fix couldn't auto-recover. This boundary contains the crash to
// the chrome subtree: the rest of the client (incl. that listener) stays
// mounted, the error is shown, and a chrome edit reloads to recover. (A
// *module's* render error is already caught by the chrome's own boundary.)
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

// Per-module render-crash boundary, owned by the shell so every chrome gets it.
// A module that throws WHILE RENDERING (the common case while an agent is mid-
// edit) is caught here — isolated to its own subtree, surfaced as a dev overlay,
// never crashing the chrome or sibling modules. Crucially it RESETS when the
// module's code hot-swaps: the shell passes the live module component as
// `moduleType`, and a hot-swap re-imports it into a NEW function identity, so
// the moment the crash is fixed the new code renders — no manual reload. (This
// inner boundary catches before any boundary the chrome wraps modules in; a
// chrome boundary that only reset on navigation used to leave a render crash
// stuck until you navigated away or hard-refreshed.)
class ModuleCrashBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error(`[atelier] module '${this.props.qid}' render crashed:`, err, info?.componentStack || ''); }
  componentDidUpdate(prev) {
    // New module component identity (hot-swap, or navigation to another module)
    // → clear the crash so the fresh code gets a chance to render. If it still
    // throws, getDerivedStateFromError catches it again — no loop.
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

function App() {
  // Auth module's handleUnauth took over → render only its bundle, no chrome.
  if (window.__ATELIER__?.takeover) return React.createElement(Takeover);

  const boot = window.__ATELIER__ || { mode: 'host', user: { id: 'local', workspaces: [] } };
  const user = boot.user || { id: 'local', workspaces: [] };
  const allModules = flattenUserModules(user);
  const wsList = user.workspaces || [];
  const chromeQid = boot.chromeQid || null;
  // Multi-chrome: a module may pin its chrome via `meta.chrome`; the shell
  // resolves it server-side (this document already booted in `chromeQid`). The
  // client mirrors that resolution ONLY to decide SPA push vs full reload — a
  // chrome can't swap inside a live document (its styles + import map are baked
  // at load). Defaults make this inert: with no `meta.chrome` anywhere, every
  // module resolves to `defaultChromeQid` and navigation stays SPA, as before.
  const defaultChromeQid = boot.defaultChromeQid || boot.chromeQid || null;
  const availableChromes = boot.chromes || [];

  const [urlState, setUrlState] = useState(parseUrl);
  const [loaded, setLoaded] = useState({});            // qid → load entry
  const [chromeEntry, setChromeEntry] = useState(null); // load entry for chrome
  const [backendErrors, setBackendErrors] = useState(() => boot.backendErrors || []);

  // The current workspace is derived purely from the URL — there is no separate
  // sticky state and no sessionStorage. Navigating anywhere (rail click, picker,
  // or a pasted URL) switches workspace because it switches the URL. `global` is
  // a normal workspace here, not a shared baseline. `defaultWs` is only used to
  // decide where a bare `/` lands: the first workspace with modules — and since
  // the server orders `global` first, that's `global` whenever it has any.
  const defaultWs = (wsList.find((w) => (w.modules || []).length > 0) || wsList[0])?.id || null;

  // Canonicalize URL: with no workspace in the path (`/`), land on the default
  // workspace — its `meta.primary` module if any, else its home.
  useEffect(() => {
    if (urlState.ws || !defaultWs) return;
    const primary = allModules.find((m) => m.workspace === defaultWs && m.meta?.primary)
                 || allModules.find((m) => m.meta?.primary);
    const target = primary
      ? buildUrl(primary.workspace, primary.id)
      : buildUrl(defaultWs, null);
    // If the landing module needs a different chrome, load it as a fresh
    // document so it boots in the right one (rare: only a primary that pins a chrome).
    if (requiredChromeForQid(primary ? primary.qid : null) !== chromeQid) {
      window.location.replace(target);
      return;
    }
    window.history.replaceState(null, '', target);
    setUrlState(parseUrl());
  }, [urlState.ws]);
  const effectiveWorkspace = urlState.ws || defaultWs;

  // Load the chrome bundle.
  useEffect(() => {
    if (!chromeQid) return;
    let cancelled = false;
    loadModuleBundle(chromeQid).then((res) => {
      if (cancelled) return;
      setChromeEntry(res);
    });
    return () => { cancelled = true; };
  }, [chromeQid]);

  // Bundle loading is LAZY: a page load costs the chrome plus the module being
  // viewed, not the whole instance. The one exception is modules that declared
  // `meta.eager` — they contribute UI or listeners to every page (a topbar
  // slot claimer must set it, or its slot never renders), so they load at boot,
  // in parallel. Everything else loads on first visit and stays loaded for the
  // rest of the SPA session. `loadingRef` dedupes across effects and re-renders.
  const loadingRef = React.useRef(new Set());
  const loadOne = (qid) => {
    if (!qid || loadingRef.current.has(qid)) return;
    loadingRef.current.add(qid);
    loadModuleBundle(qid).then((res) => setLoaded((l) => ({ ...l, [qid]: res })));
  };
  useEffect(() => {
    for (const m of allModules) if (m.hasFrontend && m.meta?.eager) loadOne(m.qid);
  }, []);

  // popstate / programmatic sub-route nav → re-parse URL. `atelier:route` is
  // fired by window.__atelier.navigate; ws+id are unchanged on a sub-route nav,
  // so activeMod stays the same and the module re-renders without remounting
  // (stable element identity → its WS subscriptions persist).
  useEffect(() => {
    const onPop = () => setUrlState(parseUrl());
    window.addEventListener('popstate', onPop);
    window.addEventListener('atelier:route', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('atelier:route', onPop);
    };
  }, []);

  // Resolve active module from URL.
  const activeMod = (urlState.ws && urlState.id)
    ? allModules.find((m) => m.workspace === urlState.ws && m.id === urlState.id)
    : null;
  const activeQid = activeMod?.qid || null;

  // Lazy half of the loading strategy: the module being viewed loads on
  // demand — initial landing and every SPA navigation to a first visit.
  useEffect(() => {
    if (activeMod?.hasFrontend) loadOne(activeMod.qid);
  }, [activeQid]);

  // URL points somewhere that doesn't exist → tidy back to a real place.
  //   • /<ws>/<id> with no such module → workspace home (if the ws exists) else root.
  //   • /<ws>/ for a workspace that doesn't exist → root.
  // Root ('/') and a real workspace home are left alone. Redirecting to '/'
  // lets the canonicalization effect above land on the default (global)
  // workspace's primary module or home.
  useEffect(() => {
    const wsExists = wsList.some((w) => w.id === urlState.ws);
    if (urlState.id === null) {
      if (!urlState.ws || wsExists) return;
      window.history.replaceState(null, '', '/');
      setUrlState(parseUrl());
      return;
    }
    if (activeMod) return;
    const target = wsExists ? buildUrl(urlState.ws, null) : '/';
    window.history.replaceState(null, '', target);
    setUrlState(parseUrl());
  }, [activeQid, activeMod, urlState.ws, urlState.id, wsList.length]);

  // Hot reload — module-aware. A chrome or shell change can't swap inside a
  // live document (the chrome's styles + import map are baked at load; a
  // shell / discovery change needs a fresh bootstrap), and a brand-new module
  // the bootstrap never saw needs discovery to re-run to appear — those still
  // full-reload. Every *known* module hot-swaps instead: re-import just its
  // frontend bundle (cache-busted) in the background and merge the new version
  // into the live tree. The chrome, the WebSocket, the React runtime, and
  // every other module stay mounted — only the changed module's subtree (its
  // body, plus any slot it contributes to the chrome) re-renders with the new
  // code. No full-page load, no loading bar, no flash. (backend.js edits
  // hot-swap server-side and never send a reload frame, so they don't arrive
  // here.)
  //
  // Trade-off: a swap brings in a new component identity, so React remounts
  // that module's subtree and its local state resets — exactly what the old
  // full reload did, now scoped to the one module. Preserving state across an
  // edit would need react-refresh machinery in the build, which the shell
  // deliberately omits.
  const bustRef = useRef(new Map());   // qid → latest cache-bust token
  useEffect(() => {
    const unsub = window.__atelier?.subscribe?.('shell', (frame) => {
      if (frame.type === 'backend-error') {
        setBackendErrors((prev) => {
          const next = prev.filter((e) => e.qid !== frame.qid);
          if (frame.message) next.push({ qid: frame.qid, message: frame.message });
          return next;
        });
        return;
      }
      if (frame.type !== 'reload') return;
      const id = frame.moduleId;
      if (id === 'shell' || id === chromeQid) {
        // A chrome can't hot-swap its component/JS (its styles + import map are
        // baked into the document at load) → full reload. But a chrome edit
        // that touched ONLY its stylesheet just needs the stylesheet re-fetched
        // — refresh it in place, no reload, no viewport jump. Smooth theme /
        // token / color tweaks. (A component edit clears cssOnly server-side.)
        if (id === chromeQid && frame.cssOnly) { refreshChromeStyles(); return; }
        window.location.reload();
        return;
      }
      if (!allModules.some((m) => m.qid === id)) { window.location.reload(); return; }
      // Never imported in this document (lazy loading) → nothing to swap; its
      // first visit imports fresh code anyway. The stylesheet may still need
      // the edit's new classes, so refresh that half only.
      if (!loadingRef.current.has(id)) { refreshChromeStyles(); return; }
      // Known module: re-import its bundle in the background, then merge it.
      // The token guards against an out-of-order resolution clobbering newer
      // code if two edits land close together.
      const token = (bustRef.current.get(id) || 0) + 1;
      bustRef.current.set(id, token);
      loadModuleBundle(id, token).then((res) => {
        if (bustRef.current.get(id) !== token) return;   // superseded by a newer edit
        setLoaded((l) => ({ ...l, [id]: res }));
      });
      // Re-fetch the chrome stylesheet so any Tailwind class the edit newly
      // introduced is generated and applied (the JS swap alone wouldn't bring
      // it in). Runs for inactive edits too, so the CSS is ready before an SPA
      // navigation — which also never re-fetches the stylesheet.
      refreshChromeStyles();
    });
    return () => { try { unsub?.(); } catch {} };
  }, [chromeQid]);

  // Which chrome a target module needs (meta.chrome → default). Used only to
  // pick SPA vs full-load; a different chrome means a fresh document. Shared
  // logic (chrome-resolve.js) so it always matches the server's resolution.
  function chromeForMeta(meta) {
    return resolveModuleChrome(meta?.chrome, availableChromes, defaultChromeQid);
  }
  function requiredChromeForQid(qid) {
    const [ws, id] = (qid || '').split('/');
    if (!ws || !id) return defaultChromeQid;          // workspace home / none → default
    const m = allModules.find((x) => x.qid === qid);
    return chromeForMeta((loaded[qid]?.meta) || m?.meta || {});
  }
  // If a module pins a chrome (meta.chrome) that ISN'T installed, return that
  // chrome's name so we render a clear error instead of silently using the
  // default. Null when no chrome is pinned, or the pinned chrome is present.
  function pinnedChromeMissing(qid) {
    const [ws, id] = (qid || '').split('/');
    if (!ws || !id) return null;
    const m = allModules.find((x) => x.qid === qid);
    const chrome = ((loaded[qid]?.meta) || m?.meta || {}).chrome;
    return missingChrome(chrome, availableChromes);
  }

  function navigateTo(target) {
    const here = window.location.pathname + window.location.search;
    if (here !== target) {
      window.history.pushState(null, '', target);
      window.dispatchEvent(new CustomEvent('atelier:navigate', { detail: { url: target } }));
    }
    setUrlState(parseUrl());
  }

  function navigateByQid(qid) {
    const [ws, id] = qid.split('/');
    if (!ws) return;
    // Workspace follows the URL: navigating to any module — global or not —
    // switches into that module's workspace.
    const target = id ? buildUrl(ws, id) : buildUrl(ws, null);
    // A different chrome can't swap inside this document → load a fresh one.
    const crossesChrome = requiredChromeForQid(id ? qid : null) !== chromeQid;
    if (crossesChrome) { window.location.assign(target); return; }
    navigateTo(target);
  }

  function pickWorkspace(ws) {
    const curId = urlState.id;
    const preserve = curId && allModules.some((m) => m.workspace === ws && m.id === curId)
      ? curId : null;
    // Same SPA path as switching modules — every workspace's bundles are already
    // loaded client-side and the rail/active module derive from the URL, so no
    // full reload is needed. Hard-load only if the destination needs a different
    // chrome (which can't swap inside a live document).
    const target = buildUrl(ws, preserve);
    const targetQid = preserve ? `${ws}/${preserve}` : null;
    const crossesChrome = requiredChromeForQid(targetQid) !== chromeQid;
    if (crossesChrome) {
      window.location.assign(target);
      return;
    }
    navigateTo(target);
  }

  // Chrome resolution: wait for chrome bundle; render fallback on missing/failed.
  if (!chromeQid) return React.createElement(ChromeMissingFallback, { qid: null });
  if (!chromeEntry) return null;       // still loading — empty body, no flash
  if (chromeEntry.status !== 'ok' || typeof chromeEntry.chrome !== 'function') {
    return React.createElement(ChromeMissingFallback, {
      qid: chromeQid,
      err: chromeEntry.err || new Error(`module exports no \`chrome\` function`),
    });
  }
  const Chrome = chromeEntry.chrome;

  // Compose active-module state for chrome.
  const entry = activeMod ? loaded[activeMod.qid] : null;
  const missingChromeName = activeMod ? pinnedChromeMissing(activeMod.qid) : null;
  let active;
  if (!activeMod) {
    active = { kind: 'none' };
  } else if (missingChromeName) {
    // A module that pins an uninstalled chrome is an error, not a fallback.
    active = {
      kind: 'error',
      qid: activeMod.qid,
      err: new Error(
        `This module is pinned to the "${missingChromeName}" chrome via meta.chrome, ` +
        `but that chrome isn't installed on this instance. Install it (mount the ` +
        `chrome module), or remove meta.chrome to use the default chrome.`
      ),
    };
  } else if (!entry) {
    active = { kind: 'loading', qid: activeMod.qid };
  } else if (entry.status === 'error') {
    active = { kind: 'error', qid: activeMod.qid, err: entry.err };
  } else if (!entry.Module) {
    active = { kind: 'error', qid: activeMod.qid, err: new Error('no default export') };
  } else {
    const M = entry.Module;
    // Wrap in the shell's crash boundary, keyed on the module component so a
    // hot-swap (new M identity) resets a stuck render error — see ModuleCrashBoundary.
    active = {
      kind: 'ready',
      qid: activeMod.qid,
      element: React.createElement(ModuleCrashBoundary, { qid: activeMod.qid, moduleType: M }, React.createElement(M)),
    };
  }

  return React.createElement(React.Fragment, null,
    React.createElement(ChromeErrorBoundary, { qid: chromeQid },
      React.createElement(Chrome, {
        boot,
        user,
        modules: allModules,
        workspaces: wsList,
        workspace: effectiveWorkspace || '',
        activeQid,
        active,
        loadedModules: loaded,
        navigate: navigateByQid,
        pickWorkspace,
      })),
    React.createElement(BackendErrorOverlay, {
      error: backendErrors.find((e) => e.qid === activeQid) || null,
    }),
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
