/* Atelier client — host shell + app boot.
 *
 * Compiled by esbuild and served at /assets/client.js. Runs after React,
 * ReactDOM, and Lucide (all UMD from CDN — see index.html).
 *
 * Shape:
 *   • Small private helpers (Icon, Spinner) — used by the chrome,
 *     (StatusDot is commented out below — bring back when modules report status),
 *     never exposed to modules.
 *   • Shell components (AtelierMark, TopBar, LeftRail, RailItem, AppShell).
 *   • App boot — reads window.__ATELIER__, discovers modules, renders.
 *
 * Modules are plain React components: default-export a function, optionally
 * `export const meta = { icon, name, color, group }`. They get React + Tailwind +
 * the browser — that's the whole contract. A boot-time MutationObserver
 * (see wireLucideObserver below) auto-stamps any `<i data-lucide="…">`
 * tag the module renders, so modules don't need to touch lucide either.
 */

const { useState, useEffect, useRef } = React;

/* =========================================================================
 * Lucide auto-stamper
 *
 * Modules write <i data-lucide="name" /> and we replace those placeholders
 * with SVGs on every DOM mutation. RAF-debounced (coalesces many mutations
 * into one createIcons call) and self-disconnecting during the sweep (so
 * the SVG replacements themselves don't re-trigger the observer — no loop).
 * ========================================================================= */
(function wireLucideObserver() {
  let raf = 0;
  let observer;
  const opts = { childList: true, subtree: true };
  const stamp = () => {
    raf = 0;
    if (!window.lucide) return;
    observer.disconnect();
    window.lucide.createIcons();
    observer.observe(document.body, opts);
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(stamp); };
  observer = new MutationObserver(schedule);
  observer.observe(document.body, opts);
  schedule();   // initial sweep once the DOM is ready
})();

/* =========================================================================
 * Cross-module API registry
 *
 * Modules can publish a small API and call into other modules via
 * `window.__atelier.callModule(id, method, ...args)`. If the target module
 * isn't installed (or hasn't registered yet), the call no-ops with a clear
 * console warning instead of crashing — so a workflows module can
 * `callModule('mission-control', 'spawnSession', ...)` without depending on
 * mission-control being present at runtime.
 *
 * Symmetrical: `register(id, api)` from the module's mount, `unregister(id)`
 * on teardown if needed.
 * ========================================================================= */
(function wireModuleRegistry() {
  if (typeof window === 'undefined') return;
  window.__atelier = window.__atelier || {};
  if (window.__atelier.callModule) return;     // hot-reload safe
  const registry = new Map();
  window.__atelier.registerModule = (id, api) => {
    if (registry.has(id)) {
      console.warn(`[atelier] registerModule: "${id}" already registered, overwriting.`);
    }
    registry.set(id, api);
  };
  window.__atelier.unregisterModule = (id) => registry.delete(id);
  window.__atelier.hasModule = (id) => registry.has(id);
  window.__atelier.callModule = (id, method, ...args) => {
    const api = registry.get(id);
    if (!api) {
      console.warn(
        `[atelier] callModule: no "${id}" module installed; "${method}" call ignored. ` +
        `Install/enable the "${id}" module to surface this action.`
      );
      return null;
    }
    if (typeof api[method] !== 'function') {
      console.warn(`[atelier] callModule: "${id}" doesn't expose method "${method}".`);
      return null;
    }
    return api[method](...args);
  };
})();

/* =========================================================================
 * Shared WebSocket multiplex — one connection per tab, multiple topics.
 *
 * The shell owns a single WebSocket to `/_atelier/ws`. Frames are JSON
 * objects of shape `{ topic, ...event }`. Modules call:
 *
 *   const unsub = window.__atelier.subscribe(topic, (event) => { … });
 *   unsub();   // when no longer interested
 *
 * Why this exists: HTTP/1.1 caps browsers at 6 concurrent connections per
 * origin. Each SSE held one of those slots, so once you had hot-reload + a
 * module SSE + multiple atelier tabs, page navigations stalled
 * intermittently. WebSocket per-origin limits are an order of magnitude
 * higher (Chrome ~255 globally), so a single multiplexed WS per tab is
 * effectively unbounded for localhost dev.
 *
 * Reconnect: native EventSource auto-retried; WebSocket doesn't. We
 * implement a small exponential backoff so the page recovers if the dev
 * server restarts (common during shell edits).
 * ========================================================================= */
(function wireWsBridge() {
  if (typeof window === 'undefined') return;
  if (window.__atelier?.subscribe) return;     // already wired (hot-reload safe)
  window.__atelier = window.__atelier || {};

  const subscribers = new Map();   // topic → Set<handler>
  let ws = null;
  let backoff = 250;
  let reconnectTimer = null;

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
    } catch (err) {
      scheduleReconnect();
      return;
    }
    ws.onmessage = (m) => {
      let frame;
      try { frame = JSON.parse(m.data); } catch { return; }
      dispatch(frame);
    };
    ws.onopen = () => { backoff = 250; };
    ws.onclose = () => { ws = null; scheduleReconnect(); };
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

  // Open eagerly so subscribers wired during initial render don't race
  // with the WS handshake. The connection is per-tab and shared.
  connect();
})();

/* =========================================================================
 * Private helpers — used by the chrome only. Not exported, not on window.
 * ========================================================================= */

/* Icon — lucide renderer. Used by TopBar, LeftRail, RailItem for chrome
 * icons. Modules write <i data-lucide> directly (see wireLucideObserver). */
function Icon({ name, size = 16, color, className = '', style }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!name || !window.lucide || !ref.current) return;
    ref.current.innerHTML = '';
    const el = document.createElement('i');
    el.setAttribute('data-lucide', name);
    ref.current.appendChild(el);
    window.lucide.createIcons({ attrs: { width: size, height: size, 'stroke-width': 1.6 } });
  }, [name, size]);
  return (
    <span
      ref={ref}
      className={['inline-flex items-center justify-center', className].join(' ')}
      style={{ width: size, height: size, color: color || 'currentColor', ...style }}
    />
  );
}

/* StatusDot — halo'd dot used by RailItem for module status.
 * Commented out until modules actually report status; every rail item was
 * hardcoded to 'idle' so the dots just added visual noise. Restore the
 * StatusDot usage in RailItem + the `status` field in App()'s rail-item
 * builder when reviving. */
// function StatusDot({ kind = 'idle', size = 6, pulse = false, className = '', style }) {
//   const tone = {
//     ok:     { bg: 'var(--color-signal-success)', ring: 'var(--color-signal-success-wash)' },
//     warn:   { bg: 'var(--color-signal-warning)', ring: 'var(--color-signal-warning-wash)' },
//     danger: { bg: 'var(--color-signal-danger)',  ring: 'var(--color-signal-danger-wash)' },
//     info:   { bg: 'var(--color-signal-info)',    ring: 'var(--color-signal-info-wash)' },
//     idle:   { bg: 'var(--color-fg-muted)',       ring: 'transparent' },
//   }[kind] || { bg: 'var(--color-fg-muted)', ring: 'transparent' };
//   return (
//     <span
//       className={[
//         'inline-block rounded-full flex-none align-middle',
//         pulse ? 'animate-pulse-dot' : '',
//         className,
//       ].join(' ')}
//       style={{
//         width: size, height: size,
//         background: tone.bg,
//         boxShadow: tone.ring === 'transparent' ? 'none' : `0 0 0 3px ${tone.ring}`,
//         ...style,
//       }}
//     />
//   );
// }

/* Spinner — braille dots, used by LoadingScreen. */
function Spinner({ color = 'var(--color-accent-primary)', size = 14 }) {
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((x) => (x + 1) % frames.length), 90);
    return () => clearInterval(id);
  }, []);
  return (
    <span
      className="inline-block font-mono text-center leading-none"
      style={{ color, fontSize: size, width: size }}
    >
      {frames[i]}
    </span>
  );
}

/* =========================================================================
 * Shell
 * ========================================================================= */

/* AtelierMark — the 4-quadrant logo. Kept as an SVG literal because the
 * geometry is load-bearing and it renders crisper than an icon font. */
function AtelierMark({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3"  y="3"  width="8" height="8" rx="1" stroke="#d79921" strokeWidth="1.5" />
      <rect x="13" y="3"  width="8" height="8" rx="1" stroke="#689d6a" strokeWidth="1.5" />
      <rect x="3"  y="13" width="8" height="8" rx="1" stroke="#689d6a" strokeWidth="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1" stroke="#d79921" strokeWidth="1.5" fill="rgba(215,153,33,0.18)" />
    </svg>
  );
}

/* SidebarToggle — far-left topbar button. State lives in the surrounding frame;
 * the button is dumb. Leading bar dims when the rail is gone — only state cue. */
function SidebarToggle({ collapsed, onClick }) {
  return (
    <button
      onClick={onClick}
      title={collapsed ? 'show sidebar  ⌘\\' : 'hide sidebar  ⌘\\'}
      aria-label={collapsed ? 'show sidebar' : 'hide sidebar'}
      aria-pressed={!collapsed}
      className={[
        'h-6.5 px-1.5 inline-flex items-center rounded-sm cursor-pointer',
        'bg-transparent border border-transparent',
        'hover:bg-card hover:border-default',
        'transition-colors duration-fast ease-enter',
        collapsed ? 'text-fg-secondary' : 'text-fg-display',
      ].join(' ')}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5"
              stroke="currentColor" strokeWidth="1.2" opacity="0.7" />
        <rect x="1.5" y="2.5" width="4" height="11" rx="1.5"
              fill="currentColor" opacity={collapsed ? 0.18 : 0.85} />
      </svg>
    </button>
  );
}

/* TopBar — 44px chrome with brand + workspace + optional subtitle + right slot.
 *
 * `center` is an optional slot for ambient modules to plug in (e.g. mission
 * control). Rendered between the brand chunk and the right slot, true-centered
 * when present (a hidden mirror of the left chunk reserves equal space on the
 * right so the center node sits at the actual middle of the bar). */
function TopBar({ workspace = 'personal', right, center, subtitle, env, sidebarCollapsed, onToggleSidebar }) {
  return (
    <div className="flex-none flex items-center px-3 h-[var(--header-h)] bg-raised border-b border-subtle">
      <div className="group flex items-center h-full pr-25">
        {onToggleSidebar && (
          <div
            className={[
              'overflow-hidden flex items-center',
              'w-0 opacity-0 group-hover:w-10 group-hover:opacity-100',
              'transition-[width,opacity] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]',
            ].join(' ')}
          >
            <SidebarToggle collapsed={sidebarCollapsed} onClick={onToggleSidebar} />
          </div>
        )}
        <div className="flex items-center gap-2">
          <AtelierMark />
          <span className="relative inline-block">
            <span
              className="font-display italic text-16 text-fg-display tracking-[-0.015em]"
              title={env === 'dev' ? 'dev environment' : undefined}
            >
              atelier
            </span>
            {env === 'dev' && (
              <span
                aria-hidden="true"
                className="absolute left-0 right-0 bottom-1 h-px overflow-hidden pointer-events-none"
              >
                <span
                  className="absolute top-0 left-0 h-px w-2 rounded-full"
                  style={{
                    background: 'var(--color-signal-warning)',
                    animation: 'atelier-scan 1.6s var(--ease-enter) infinite alternate',
                  }}
                />
              </span>
            )}
          </span>
          <span className="font-mono text-11 text-fg-muted">·</span>
          <span className="font-mono text-11 text-fg-secondary">{workspace}</span>
          {subtitle && (
            <>
              <span className="font-mono text-11 text-fg-muted">/</span>
              <span className="font-mono text-11 text-fg-primary">{subtitle}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center min-w-0">{center}</div>
      <div className="flex-none flex items-center">{right}</div>
    </div>
  );
}

/* LeftRail — workspace switcher + header label + scrollable module list.
 *
 * Modules split into `ungrouped` (rendered under the default "modules" header,
 * matching pre-grouping layout) and `groups` (each rendered as its own headered
 * section). A module joins a group by exporting `meta.group = '<name>'` — the
 * group header is just that name, lowercased. Groups are optional. */
function LeftRail({
  ungrouped,
  groups,
  activeId,
  onSelect,
  workspace = 'personal',
  onAddModule,
  headerLabel = 'modules',
  footer,
  collapsed = false,
}) {
  const empty = ungrouped.length === 0 && groups.length === 0;
  const renderItem = (m) => (
    <RailItem
      key={m.id}
      mod={m}
      active={m.id === activeId}
      href={`/${m.id}`}
      onActivate={() => onSelect && onSelect(m.id)}
    />
  );
  // Width-animated shell with a fixed-width inner so content doesn't reflow
  // mid-transition. Inner fades slightly to soften the entrance/exit.
  return (
    <aside
      aria-hidden={collapsed}
      className={[
        'flex-none overflow-hidden border-subtle bg-raised',
        'transition-[width,border-right-width] duration-[260ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
        collapsed ? 'w-0 border-r-0' : 'w-(--rail-w) border-r',
      ].join(' ')}
    >
    <div
      className={[
        'flex flex-col h-full w-(--rail-w)',
        'transition-opacity duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
        collapsed ? 'opacity-0' : 'opacity-100',
      ].join(' ')}
      inert={collapsed ? '' : undefined}
    >
      <div className="flex-none flex items-center gap-2 px-3 h-10 border-b border-subtle">
        <span
          className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-xs font-mono text-[10px] font-semibold bg-accent-primary-wash text-accent-primary-hi"
          style={{ border: '1px solid rgba(215,153,33,0.35)' }}
        >
          {workspace[0]}
        </span>
        <span className="font-sans text-13 text-fg-primary font-medium flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
          {workspace}
        </span>
        <Icon name="chevrons-up-down" size={12} color="var(--color-fg-muted)" />
      </div>

      <div className="flex items-center gap-1.5 pt-2.5 pb-1 px-3">
        <span className="flex-1 font-mono text-[10px] tracking-caps text-fg-muted lowercase">
          {headerLabel}
        </span>
        <button
          onClick={onAddModule}
          className="w-[18px] h-[18px] inline-flex items-center justify-center bg-transparent border border-transparent text-fg-secondary rounded-sm cursor-pointer hover:bg-card hover:text-fg-primary transition-colors duration-fast ease-enter"
        >
          <Icon name="plus" size={12} />
        </button>
      </div>

      <div className="flex-1 overflow-auto px-1.5">
        {empty && (
          <div className="font-mono text-11 text-fg-subtle leading-[1.6] px-1.5 py-1">
            <span className="text-fg-muted">no modules yet.</span>
          </div>
        )}
        {ungrouped.map(renderItem)}
        {groups.map((g) => (
          <div key={g.name}>
            <div className="flex items-center gap-1.5 pt-3 pb-1 px-1.5">
              <span className="flex-1 font-mono text-[10px] tracking-caps text-fg-muted lowercase">
                {g.name}
              </span>
            </div>
            {g.items.map(renderItem)}
          </div>
        ))}
      </div>

      {footer}
    </div>
    </aside>
  );
}

/* RailItem — one row in LeftRail. CSS hover; active wins over hover.
 *
 * Renders as an <a href> so the browser handles cmd/ctrl/middle/shift-click
 * natively (open in new tab/window). Plain left-click is intercepted to keep
 * SPA navigation; modifier clicks fall through to default browser behavior. */
function RailItem({ mod, active, href, onActivate }) {
  const handleClick = (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onActivate?.();
  };
  return (
    <a
      href={href}
      onClick={handleClick}
      className={[
        'flex items-center gap-2 px-2 py-1.5 rounded-sm cursor-pointer mb-px no-underline text-inherit hover:border-b-transparent!',
        'transition-[background-color] duration-fast ease-enter border-l-2',
        active ? 'bg-card-hi border-accent-primary' : 'border-transparent hover:bg-card',
      ].join(' ')}
    >
      <Icon
        name={mod.icon}
        size={14}
        color={active ? 'var(--color-fg-display)' : 'var(--color-fg-secondary)'}
      />
      <span
        className={[
          'flex-1 font-sans text-13 overflow-hidden text-ellipsis whitespace-nowrap',
          active ? 'text-fg-display' : 'text-fg-primary',
        ].join(' ')}
      >
        {mod.name}
      </span>
      {mod.count != null && (
        <span className="font-mono text-[10px] text-fg-muted">{mod.count}</span>
      )}
      {/* <StatusDot kind={mod.status} /> */}
    </a>
  );
}

/* AppShell — outer frame: TopBar on top, LeftRail + main as horizontal split. */
function AppShell({ topBar, left, children, width, height, full = false }) {
  const sizeClasses = full ? 'w-screen h-screen' : '';
  const sizeStyle = full ? undefined : { width: width ?? 1400, height: height ?? 880 };
  return (
    <div
      className={[
        'relative flex flex-col overflow-hidden rounded-sm',
        'bg-canvas text-fg-primary font-sans border border-default',
        sizeClasses,
      ].join(' ')}
      style={sizeStyle}
    >
      {topBar}
      <div className="flex-1 flex overflow-hidden">
        {left}
        <main className="flex-1 overflow-hidden flex flex-col bg-canvas">
          {children}
        </main>
      </div>
    </div>
  );
}

/* =========================================================================
 * App boot
 * ========================================================================= */

// Load a module's compiled frontend via dynamic ESM import. A module
// usually exports `default Module` (rendered in the main surface). It can
// also export named slot components — currently `TopBarCenter` — to occupy
// shell slots regardless of which module is "active". A module exporting
// only a slot component (no default) is "ambient": always mounted, never
// shown in the rail.
//
// Returns { status: 'ok'|'error', Module?, TopBarCenter?, meta?, err? }.
async function loadModule(id) {
  try {
    const mod = await import(`/modules/${id}/frontend.js`);
    const Module = typeof mod.default === 'function' ? mod.default : null;
    const TopBarCenter = typeof mod.TopBarCenter === 'function' ? mod.TopBarCenter : null;
    if (!Module && !TopBarCenter) {
      throw new Error(`module ${id} has no default export and no slot exports`);
    }
    return { status: 'ok', Module, TopBarCenter, meta: mod.meta || {} };
  } catch (err) {
    console.error(`[atelier] failed to load module '${id}':`, err);
    return { status: 'error', err };
  }
}

// Catches runtime errors thrown inside a module so one broken module doesn't
// blank the whole shell. Keeps the rail visible; shows the error in-place.
class ModuleErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }
  static getDerivedStateFromError(err) {
    return { err };
  }
  componentDidCatch(err, info) {
    console.error('[atelier] module render crashed:', err, info);
  }
  componentDidUpdate(prev) {
    // Reset when the user switches to a different module.
    if (prev.moduleId !== this.props.moduleId && this.state.err) {
      this.setState({ err: null });
    }
  }
  render() {
    if (this.state.err) {
      return (
        <div className="flex-1 min-h-0 flex items-center justify-center p-10 grid-bg">
          <div className="max-w-[520px] bg-card border border-[rgba(251,73,52,0.4)] rounded-sm px-4 py-3.5 font-mono text-12 text-fg-primary">
            <div className="text-[#fb4934] text-11 tracking-caps lowercase mb-1.5">
              {this.props.moduleId} · render error
            </div>
            <div className="whitespace-pre-wrap break-words text-fg-secondary">
              {String(this.state.err?.stack || this.state.err?.message || this.state.err)}
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// URL convention: '/' = empty state, '/<module-id>' = that module.
function parseUrl() {
  const m = window.location.pathname.match(/^\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

function App() {
  const boot = window.__ATELIER__ || { mode: 'host', modules: [] };
  const [path, setPath] = useState(parseUrl);
  const [loaded, setLoaded] = useState({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const toggleSidebar = () => setSidebarCollapsed((c) => !c);

  // ⌘\ toggles the rail. Bound at the app level so any frame can see it.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    (async () => {
      for (const m of boot.modules.filter((m) => m.hasFrontend)) {
        const res = await loadModule(m.id);
        setLoaded((l) => ({ ...l, [m.id]: res }));
      }
    })();
  }, []);

  useEffect(() => {
    const onPop = () => setPath(parseUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const active = path ? boot.modules.find((m) => m.id === path) : null;

  // URL points at a module that no longer exists (e.g. folder deleted) —
  // tidy URL back to '/' and show empty state.
  useEffect(() => {
    if (path !== null && !active) {
      window.history.replaceState(null, '', '/');
      setPath(null);
    }
  }, [path, active]);

  // Hot reload — module-aware. The shell broadcasts `{ topic: 'shell',
  // type: 'reload', moduleId }` per changed module via the shared WS.
  // Active module / shell / ambient module / unknown id → full reload now.
  // Other modules → mark dirty; navigating to a dirty module does a full
  // page load so the user lands on the fresh version.
  const activeIdRef = useRef(null);
  activeIdRef.current = active?.id || null;
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const dirtyRef = useRef(new Set());

  useEffect(() => {
    const unsub = window.__atelier?.subscribe?.('shell', (frame) => {
      if (frame.type !== 'reload') return;
      const id = frame.moduleId;
      if (id === 'shell' || id === activeIdRef.current) {
        window.location.reload();
        return;
      }
      // Ambient modules (e.g. mission-control's topbar widget) are always
      // mounted regardless of which path is active, so they need a force
      // reload too — there's no "navigate to it" moment to drain dirty on.
      const entry = loadedRef.current[id];
      if (entry?.TopBarCenter) {
        window.location.reload();
        return;
      }
      const known = boot.modules.some((m) => m.id === id);
      if (!known) {
        window.location.reload();
        return;
      }
      dirtyRef.current.add(id);
    });
    return () => { try { unsub?.(); } catch {} };
  }, []);

  function navigate(id) {
    if (id && dirtyRef.current.has(id)) {
      window.location.assign(`/${id}`);
      return;
    }
    const target = id ? `/${id}` : '/';
    if (window.location.pathname !== target) {
      window.history.pushState(null, '', target);
      // pushState doesn't fire popstate, so ambient modules can't observe SPA
      // navs by listening to popstate alone. Broadcast a custom event so they
      // can react (e.g. mission-control's page-scoped moduleId).
      window.dispatchEvent(new CustomEvent('atelier:navigate', { detail: { moduleId: id } }));
    }
    setPath(id);
  }

  const entry = active ? loaded[active.id] : null;
  const ActiveModule = entry?.status === 'ok' ? entry.Module : null;
  const activeName = entry?.meta?.name || active?.meta?.name || active?.id;

  useEffect(() => {
    document.title = activeName ? `Atelier · ${activeName}` : 'Atelier';
  }, [activeName]);

  // Find a TopBarCenter slot component from any loaded module. First module
  // that exports one wins; if multiple modules try to claim the slot we warn
  // and keep the first. A module that exports ONLY TopBarCenter (no default)
  // is "ambient" — always mounted, never shown in the rail.
  let TopBarCenterSlot = null;
  let topBarCenterClaimedBy = null;
  for (const m of boot.modules) {
    const e = loaded[m.id];
    if (e?.status !== 'ok' || !e.TopBarCenter) continue;
    if (TopBarCenterSlot) {
      console.warn(
        `[atelier] both "${topBarCenterClaimedBy}" and "${m.id}" export TopBarCenter; ` +
        `keeping the first.`
      );
      continue;
    }
    TopBarCenterSlot = e.TopBarCenter;
    topBarCenterClaimedBy = m.id;
  }

  // Server seeds meta in the bootstrap so grouping is correct on first paint.
  // Once the module's frontend finishes importing, its runtime meta wins —
  // that way live edits take effect on hot-reload without a server restart.
  // Ambient-only modules (no default export) are filtered out of the rail.
  const ungrouped = [];
  const groups = [];
  const groupIndex = new Map();
  for (const m of boot.modules) {
    const e = loaded[m.id];
    // Hide ambient-only (slot-only) modules from the rail. We treat any
    // module that loaded successfully but exposes no default Module as
    // ambient — its UI lives elsewhere (a slot), not in the main surface.
    if (e?.status === 'ok' && !e.Module) continue;
    const meta = { ...(m.meta || {}), ...(loaded[m.id]?.meta || {}) };
    const item = {
      id: m.id,
      name: meta.name || m.id,
      icon: meta.icon,
      // status: 'idle',  // revive when StatusDot returns (see RailItem)
    };
    if (meta.group) {
      let g = groupIndex.get(meta.group);
      if (!g) {
        g = { name: meta.group, items: [] };
        groups.push(g);
        groupIndex.set(meta.group, g);
      }
      g.items.push(item);
    } else {
      ungrouped.push(item);
    }
  }

  return (
    <AppShell
      full
      topBar={
        <TopBar
          workspace="personal"
          subtitle={activeName}
          env={boot.env}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
          center={TopBarCenterSlot ? <TopBarCenterSlot /> : null}
        />
      }
      left={
        <LeftRail
          ungrouped={ungrouped}
          groups={groups}
          activeId={active?.id || null}
          onSelect={navigate}
          onAddModule={() => navigate(null)}
          workspace="personal"
          headerLabel={boot.mode === 'standalone' ? 'module' : 'modules'}
          collapsed={sidebarCollapsed}
        />
      }
    >
      {!active
        ? <EmptyWorkspace />
        : ActiveModule
          ? <ModuleErrorBoundary moduleId={active.id}><ActiveModule /></ModuleErrorBoundary>
          : <LoadingScreen modules={boot.modules} loaded={loaded} activeId={active.id} />}
    </AppShell>
  );
}

function EmptyWorkspace() {
  const snippet = `export default function Module() {
  return <div className="p-8">hello</div>;
}`;
  return (
    <div className="flex-1 min-h-0 grid-bg flex items-center justify-center relative overflow-auto">
      <div className="max-w-[560px] px-12 py-10">
        <div className="font-mono text-11 tracking-caps text-fg-muted lowercase mb-3.5">
          atelier · personal
        </div>
        <div
          className="font-display italic text-fg-display leading-[1.05] mb-5 [text-wrap:balance]"
          style={{ fontSize: 54, letterSpacing: '-0.02em' }}
        >
          a quiet workspace<br />for loud thoughts.
        </div>
        <div className="font-sans text-[15px] text-fg-secondary leading-[1.55] max-w-[420px] [text-wrap:pretty] mb-8">
          the bench is clear. add a module to get started.
        </div>

        <div className="pt-5 border-t border-subtle">
          <div className="font-mono text-11 tracking-caps text-fg-muted lowercase mb-3">
            scaffold a hello module
          </div>
          <div className="font-mono text-11 text-fg-muted mb-1">hello/frontend.jsx</div>
          <pre className="font-mono text-12 text-fg-primary bg-well border border-subtle rounded-xs px-2.5 py-2 leading-snug mb-3 overflow-x-auto">{snippet}</pre>
          <div className="font-mono text-11 text-fg-muted leading-body">
            that's it. create the folder, save the file — it appears in the rail.
          </div>
        </div>
      </div>
    </div>
  );
}

function LoadingScreen({ modules, loaded, activeId }) {
  const mod = modules.find((m) => m.id === activeId);
  const state = mod ? loaded[mod.id] : undefined;
  if (state?.status === 'error') {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center p-10 grid-bg">
        <div className="max-w-[520px] bg-card border border-[rgba(251,73,52,0.4)] rounded-sm px-4 py-3.5 font-mono text-12 text-fg-primary">
          <div className="text-[#fb4934] text-11 tracking-caps lowercase mb-1.5">
            {mod?.id} · failed to load
          </div>
          <div className="whitespace-pre-wrap break-words text-fg-secondary">
            {String(state.err?.message || state.err)}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex-1 flex items-center justify-center grid-bg">
      <div className="flex flex-col items-center gap-2">
        <Spinner size={16} />
        <span className="label">loading {mod?.id ?? ''}…</span>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
