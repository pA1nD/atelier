/* atelier client — shell-side router + bundle loader.
 *
 * Compiled by esbuild, served at /assets/client.js, loaded as an ES module
 * after React + ReactDOM (UMD from CDN — see index.html). The chrome
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
async function loadModuleBundle(qid) {
  const url = `/modules/${qid}/frontend.js`;
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
      { style: { padding: 24, color: '#fb4934', fontFamily: 'ui-monospace, monospace' } },
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
      + `    export const meta = { chrome: true, hidden: true }\n`
      + `    export function chrome(props) { /* render the shell UI */ }\n\n`
      + `Discover it as a global module, or name it in atelier.config.json.`;
  return React.createElement('pre',
    { style: { padding: 24, margin: 0, minHeight: '100vh', colorScheme: 'light dark', fontFamily: 'ui-monospace, monospace', fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' } },
    body);
}

/* =========================================================================
 * App boot
 * ========================================================================= */
function App() {
  // Auth module's handleUnauth took over → render only its bundle, no chrome.
  if (window.__ATELIER__?.takeover) return React.createElement(Takeover);

  const boot = window.__ATELIER__ || { mode: 'host', user: { id: 'local', workspaces: [] } };
  const user = boot.user || { id: 'local', workspaces: [] };
  const allModules = flattenUserModules(user);
  const wsList = user.workspaces || [];
  const chromeQid = boot.chromeQid || null;

  const [urlState, setUrlState] = useState(parseUrl);
  const [loaded, setLoaded] = useState({});            // qid → load entry
  const [chromeEntry, setChromeEntry] = useState(null); // load entry for chrome

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

  // Load every accessible module's bundle (parallel). Chrome bundle is
  // loaded separately above; module bundles populate `loaded` as they
  // resolve so chrome can re-render with live meta / slot exports.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const m of allModules) {
        if (!m.hasFrontend) continue;
        const res = await loadModuleBundle(m.qid);
        if (cancelled) return;
        setLoaded((l) => ({ ...l, [m.qid]: res }));
      }
    })();
    return () => { cancelled = true; };
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

  // Hot reload — module-aware. Active module / chrome / shell / ambient
  // module / unknown id → full reload. Other modules → mark dirty; next
  // navigation does a full page load.
  const activeQidRef = useRef(null);
  activeQidRef.current = activeQid;
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const dirtyRef = useRef(new Set());
  useEffect(() => {
    const unsub = window.__atelier?.subscribe?.('shell', (frame) => {
      if (frame.type !== 'reload') return;
      const id = frame.moduleId;
      if (id === 'shell' || id === activeQidRef.current || id === chromeQid) {
        window.location.reload();
        return;
      }
      const entry = loadedRef.current[id];
      if (entry?.TopBarCenter) {
        window.location.reload();
        return;
      }
      const known = allModules.some((m) => m.qid === id);
      if (!known) {
        window.location.reload();
        return;
      }
      dirtyRef.current.add(id);
    });
    return () => { try { unsub?.(); } catch {} };
  }, [chromeQid]);

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
    if (qid && dirtyRef.current.has(qid)) { window.location.assign(target); return; }
    navigateTo(target);
  }

  function pickWorkspace(ws) {
    const curId = urlState.id;
    const preserve = curId && allModules.some((m) => m.workspace === ws && m.id === curId)
      ? curId : null;
    // Same SPA path as switching modules — every workspace's bundles are already
    // loaded client-side and the rail/active module derive from the URL, so no
    // full reload is needed. Hard-load only if the preserved module was marked
    // dirty by hot reload (mirrors navigateByQid).
    const target = buildUrl(ws, preserve);
    if (preserve && dirtyRef.current.has(`${ws}/${preserve}`)) {
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
  let active;
  if (!activeMod) {
    active = { kind: 'none' };
  } else if (!entry) {
    active = { kind: 'loading', qid: activeMod.qid };
  } else if (entry.status === 'error') {
    active = { kind: 'error', qid: activeMod.qid, err: entry.err };
  } else if (!entry.Module) {
    active = { kind: 'error', qid: activeMod.qid, err: new Error('no default export') };
  } else {
    const M = entry.Module;
    active = { kind: 'ready', qid: activeMod.qid, element: React.createElement(M) };
  }

  return React.createElement(Chrome, {
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
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
