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
 *   • Owns URL routing (`/<workspace>/<id>`)
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

  connect();
})();

/* =========================================================================
 * URL routing — every URL is workspace-qualified.
 *
 *   /                  cold landing — App redirects to the first non-empty
 *                       workspace's home.
 *   /<ws>/             workspace home — no module selected.
 *   /<ws>/<id>         module page.
 * ========================================================================= */
function parseUrl() {
  const p = window.location.pathname;
  const m = p.match(
    /^\/([a-zA-Z0-9][a-zA-Z0-9_-]*)(?:\/([a-zA-Z0-9][a-zA-Z0-9_-]*))?\/?$/
  );
  if (!m) return { ws: null, id: null };
  return {
    ws: decodeURIComponent(m[1]),
    id: m[2] ? decodeURIComponent(m[2]) : null,
  };
}

function buildUrl(ws, id) {
  if (!ws) return '/';
  if (!id) return `/${encodeURIComponent(ws)}/`;
  return `/${encodeURIComponent(ws)}/${encodeURIComponent(id)}`;
}

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

  // Canonicalize URL: if no workspace in the path, redirect to the first
  // non-empty workspace (or first listed if all are empty). If any module
  // declares `meta.primary: true`, land on that module instead of the
  // workspace home — prefer one in the chosen defaultWs, fall back to any.
  const defaultWs = (wsList.find((w) => (w.modules || []).length > 0) || wsList[0])?.id || null;
  useEffect(() => {
    if (urlState.ws || !defaultWs) return;
    const primary = allModules.find((m) => m.workspace === defaultWs && m.meta?.primary)
                 || allModules.find((m) => m.meta?.primary);
    const target = primary
      ? buildUrl(primary.workspace, primary.id)
      : buildUrl(defaultWs, null);
    window.history.replaceState(null, '', target);
    setUrlState(parseUrl());
  }, [urlState.ws, defaultWs]);
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

  // popstate → re-parse URL.
  useEffect(() => {
    const onPop = () => setUrlState(parseUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Resolve active module from URL.
  const activeMod = (urlState.ws && urlState.id)
    ? allModules.find((m) => m.workspace === urlState.ws && m.id === urlState.id)
    : null;
  const activeQid = activeMod?.qid || null;

  // URL points at a non-existent (ws, id) → tidy back to workspace home or root.
  useEffect(() => {
    if (urlState.id === null) return;
    if (activeMod) return;
    const wsExists = wsList.some((w) => w.id === urlState.ws);
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
    const target = id ? buildUrl(ws, id) : buildUrl(ws, null);
    if (qid && dirtyRef.current.has(qid)) { window.location.assign(target); return; }
    navigateTo(target);
  }

  function pickWorkspace(ws) {
    const curId = urlState.id;
    const preserve = curId && allModules.some((m) => m.workspace === ws && m.id === curId)
      ? curId : null;
    window.location.assign(buildUrl(ws, preserve));
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
