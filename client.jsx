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
// Workspace is not exposed as a shell-API constant. The canonical way for
// a module to know its workspace is to derive it from its own bundle URL
// (see the ROUTE/API/TOPIC snippet every frontend.jsx starts with):
//
//   const ROUTE = new URL('.', import.meta.url).pathname
//                   .replace(/^\/modules\//, '').replace(/\/$/, '');
//   const WS    = ROUTE.split('/')[0];   // 'global' or '<workspace>'
//
// One source of truth (the bundle URL), one less shell global to keep in
// sync with reality.

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

  // Connection signal — three states emitted via `atelier:connection`:
  //   • 'online'   — WS open, server reachable.
  //   • 'offline'  — WS down past the jitter grace AND HTTP probe failed too.
  //                  Standard "server is gone" banner.
  //   • 'unauthed' — WS down because session expired. HTTP probe returns 401.
  //                  Distinct banner with a "sign in" affordance — auto-
  //                  reconnect won't help; the user has to re-authenticate.
  // Brief WS reconnects (dev-server restart) absorb in the grace window
  // and never reach 'offline' / 'unauthed'.
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

  // Probe the shell's `/_atelier/whoami`. Server-alive AND authed → 200;
  // server-alive BUT unauthed → 401; server-gone or network error → throw.
  // The probe is what disambiguates 'offline' from 'unauthed' for the
  // banner — WebSocket close codes don't carry HTTP semantics cleanly.
  async function probeAuth() {
    const r = await fetch('/_atelier/whoami', { cache: 'no-store', credentials: 'same-origin' });
    return r.status;
  }

  function armOfflineTimer() {
    if (offlineTimer) return;
    offlineTimer = setTimeout(async () => {
      offlineTimer = null;
      if (ws && ws.readyState === 1) return;          // race: reconnected during grace
      try {
        const status = await probeAuth();
        if (status === 200) {
          // Server alive, session valid — the WS will reconnect itself.
          return;
        }
        if (status === 401) {
          setConnState('unauthed');
          return;
        }
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
    // Topics are qualified (`<ws>/<id>`); the server doesn't tag the
    // connection, and the client subscribes to whichever qids it cares
    // about. No `?ws=` needed on the upgrade URL.
    try {
      ws = new WebSocket(`${proto}//${window.location.host}/_atelier/ws`);
    } catch (err) {
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
function TopBar({ workspace, showWorkspace = false, right, center, subtitle, env, sidebarCollapsed, onToggleSidebar }) {
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
          {showWorkspace && (
            <>
              <span className="font-mono text-11 text-fg-muted">·</span>
              <span className="font-mono text-11 text-fg-secondary">{workspace}</span>
            </>
          )}
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

/* WorkspacePicker — clickable badge that opens a dropdown of workspaces.
 *
 * Active state = the current `workspace` prop. Mounted only when the user
 * has at least one non-`global` workspace; the synthetic `global` is the
 * fallback context whose modules are merged into every workspace's rail
 * (so they're always-available, not a separate destination). Closes on
 * outside click, ESC, or selection. */
function WorkspacePicker({ workspaces, active, onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = active || (workspaces[0]?.id ?? '');
  const chip = (active || workspaces[0]?.id || '·')[0];

  return (
    <div ref={ref} className="relative flex-none">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={[
          'w-full flex items-center gap-2 px-3 h-10 border-b border-subtle cursor-pointer text-left',
          'bg-transparent transition-colors duration-fast ease-enter',
          open ? 'bg-card' : 'hover:bg-card',
        ].join(' ')}
      >
        <span
          className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-xs font-mono text-[10px] font-semibold bg-accent-primary-wash text-accent-primary-hi"
          style={{ border: '1px solid rgba(215,153,33,0.35)' }}
        >
          {chip}
        </span>
        <span className={[
          'font-sans text-13 font-medium flex-1 overflow-hidden text-ellipsis whitespace-nowrap',
          active ? 'text-fg-primary' : 'text-fg-muted',
        ].join(' ')}>
          {label}
        </span>
        <Icon name="chevrons-up-down" size={12} color="var(--color-fg-muted)" />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-2 right-2 top-[calc(100%-2px)] z-20 bg-raised border border-subtle rounded-sm shadow-lg py-1"
        >
          {workspaces.map((w) => (
            <WorkspaceOption
              key={w.id}
              label={w.name || w.id}
              chip={(w.id || '?')[0]}
              selected={active === w.id}
              onClick={() => { setOpen(false); onPick(w.id); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkspaceOption({ label, chip, selected, onClick }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={[
        'w-full flex items-center gap-2 px-2.5 py-1.5 text-left cursor-pointer bg-transparent',
        'transition-colors duration-fast ease-enter',
        selected ? 'bg-card-hi' : 'hover:bg-card',
      ].join(' ')}
    >
      <span
        className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-xs font-mono text-[10px] font-semibold bg-accent-primary-wash text-accent-primary-hi"
        style={{ border: '1px solid rgba(215,153,33,0.35)' }}
      >
        {chip}
      </span>
      <span className={[
        'flex-1 font-sans text-13 overflow-hidden text-ellipsis whitespace-nowrap',
        selected ? 'text-fg-display' : 'text-fg-primary',
      ].join(' ')}>
        {label}
      </span>
      {selected && <Icon name="check" size={12} color="var(--color-fg-display)" />}
    </button>
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
  workspace,
  workspaces = [],
  onPickWorkspace,
  showWorkspace = false,
  onAddModule,
  headerLabel = 'modules',
  footer,
  collapsed = false,
}) {
  const empty = ungrouped.length === 0 && groups.length === 0;
  // qid is `<ws>/<id>`; the page URL has the same shape.
  const itemHref = (m) => `/${m.qid}`;
  const renderItem = (m) => (
    <RailItem
      key={m.qid || m.id}
      mod={m}
      active={(m.qid || m.id) === activeId}
      href={itemHref(m)}
      onActivate={() => onSelect && onSelect(m)}
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
      {showWorkspace && (
        <WorkspacePicker
          workspaces={workspaces}
          active={workspace || null}
          onPick={onPickWorkspace}
        />
      )}

      <div className="flex-1 overflow-auto px-1.5">
        <div className="flex items-center gap-1.5 pb-1 px-1.5 pt-2.5">
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

/* ConnectionBanner — full-width notice rendered below the TopBar.
 *
 * Two distinct failure modes, two distinct banners:
 *   • 'offline'  — server unreachable. Red. Auto-reconnect is in flight.
 *   • 'unauthed' — session expired. Amber. Reconnect won't help; we offer
 *                  a sign-in button that reloads through the auth takeover.
 *
 * Driven by the `atelier:connection` window event from wireWsBridge. */
function ConnectionBanner() {
  const [state, setState] = useState('online');
  useEffect(() => {
    const onConn = (e) => setState(e.detail?.state ?? 'online');
    window.addEventListener('atelier:connection', onConn);
    return () => window.removeEventListener('atelier:connection', onConn);
  }, []);
  if (state === 'online') return null;

  if (state === 'unauthed') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex-none flex items-center justify-center gap-2.5 px-3 h-7 border-b overflow-hidden"
        style={{
          background: 'var(--color-signal-warning-wash)',
          borderBottomColor: 'rgba(215, 153, 33, 0.4)',
          animation: 'banner-in var(--duration-base) var(--ease-enter)',
        }}
      >
        <span
          className="inline-block rounded-full flex-none"
          style={{
            width: 6, height: 6,
            background: 'var(--color-signal-warning)',
            boxShadow: '0 0 0 3px var(--color-signal-warning-wash)',
          }}
        />
        <span className="font-mono text-11 tracking-caps lowercase text-fg-secondary">
          session expired
        </span>
        <span className="font-mono text-11 text-fg-muted lowercase">
          — sign in again to continue
        </span>
        <button
          onClick={() => window.location.reload()}
          className="font-mono text-11 px-2 py-0.5 rounded-xs bg-card border border-default hover:bg-card-hi cursor-pointer text-fg-primary"
        >
          sign in
        </button>
      </div>
    );
  }

  // offline
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex-none flex items-center justify-center gap-2.5 px-3 h-7 border-b overflow-hidden"
      style={{
        background: 'var(--color-signal-danger-wash)',
        borderBottomColor: 'rgba(204, 36, 29, 0.35)',
        animation: 'banner-in var(--duration-base) var(--ease-enter)',
      }}
    >
      <span
        className="inline-block rounded-full flex-none"
        style={{
          width: 6, height: 6,
          background: 'var(--color-signal-danger)',
          boxShadow: '0 0 0 3px var(--color-signal-danger-wash)',
          animation: 'atelier-pulse 1.8s var(--ease-enter) infinite',
        }}
      />
      <span className="font-mono text-11 tracking-caps lowercase text-fg-secondary">
        server unreachable
      </span>
      <span className="font-mono text-11 text-fg-muted lowercase">
        — data shown may be stale · reconnecting
      </span>
      <Spinner size={11} color="var(--color-fg-muted)" />
    </div>
  );
}

/* AppShell — outer frame: TopBar on top, LeftRail + main as horizontal split.
 *
 * `notice` is an optional full-width slot rendered between the topBar and the
 * body split — used today for the connection banner. */
function AppShell({ topBar, notice, left, children, width, height, full = false }) {
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
      {notice}
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

// Load a module's compiled frontend via dynamic ESM import. The URL is
// fully qualified — `/modules/<ws>/<id>/frontend.js`. Same-named modules
// in different workspaces get distinct URLs, so the browser cache keys
// them naturally.
async function loadModule(entry) {
  const url = `/modules/${entry.qid}/frontend.js`;
  try {
    const mod = await import(url);
    const Module = typeof mod.default === 'function' ? mod.default : null;
    const TopBarCenter = typeof mod.TopBarCenter === 'function' ? mod.TopBarCenter : null;
    if (!Module && !TopBarCenter) {
      throw new Error(`module ${entry.qid} has no default export and no slot exports`);
    }
    return { status: 'ok', Module, TopBarCenter, meta: mod.meta || {} };
  } catch (err) {
    console.error(`[atelier] failed to load module '${entry.qid}':`, err);
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

// URL convention. Every URL is workspace-qualified.
//
//   /                       cold landing — App immediately redirects to
//                            the first available workspace's home.
//   /<ws>/                  workspace home — no module selected.
//   /<ws>/<id>              module page.
//
// parseUrl returns { ws, id }. Both may be null when the URL hasn't been
// canonicalized yet (typically only the very first render at `/`).
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

// Build a URL for the SPA.
function buildUrl(ws, id) {
  if (!ws) return '/';
  if (!id) return `/${encodeURIComponent(ws)}/`;
  return `/${encodeURIComponent(ws)}/${encodeURIComponent(id)}`;
}

// Flatten the user object (workspaces.modules) into a single list of
// entries. Every module has a workspace. qid = `<ws>/<id>` and is the key
// for `loaded`, dirty tracking, hot-reload moduleId, etc.
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

// When the auth module's handleUnauth has injected `boot.takeover`, the
// shell hands the entire surface to its bundle — no chrome, no other
// modules. The takeover component reads `window.__ATELIER__.takeover`
// itself for state (unauth/denied/reason/attemptedUrl/etc.) and decides
// what to render.
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
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center p-10 grid-bg">
        <div className="max-w-[520px] bg-card border border-[rgba(251,73,52,0.4)] rounded-sm px-4 py-3.5 font-mono text-12 text-fg-primary">
          <div className="text-[#fb4934] text-11 tracking-caps lowercase mb-1.5">auth · takeover failed</div>
          <div className="whitespace-pre-wrap break-words text-fg-secondary">{state.message}</div>
        </div>
      </div>
    );
  }
  const { Component } = state;
  return <Component />;
}

function App() {
  // Auth module's handleUnauth took over → render only its bundle, no chrome.
  if (window.__ATELIER__?.takeover) return <Takeover />;

  const boot = window.__ATELIER__ || { mode: 'host', user: { id: 'local', workspaces: [] } };
  const user = boot.user || { id: 'local', workspaces: [] };
  const allModules = flattenUserModules(user);
  const wsList = user.workspaces || [];

  const [urlState, setUrlState] = useState(parseUrl);      // { ws, id }
  const [loaded, setLoaded] = useState({});                // qid → load entry
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const toggleSidebar = () => setSidebarCollapsed((c) => !c);

  // Canonicalize URL: if no workspace in the path, pick a default and
  // history.replaceState to /<ws>/. Default = first workspace the user
  // has access to that actually has modules — landing on an empty
  // workspace (e.g. `global` when all modules live in `$bigcorp/`) is
  // unhelpful. Falls back to the first listed workspace if none have
  // modules.
  const defaultWs = (wsList.find((w) => (w.modules || []).length > 0) || wsList[0])?.id || null;

  useEffect(() => {
    if (urlState.ws || !defaultWs) return;
    const target = buildUrl(defaultWs, null);
    window.history.replaceState(null, '', target);
    setUrlState(parseUrl());
  }, [urlState.ws, defaultWs]);

  const effectiveWorkspace = urlState.ws || defaultWs;

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

  // Load every accessible module's bundle once. With workspace-qualified
  // URLs the same module id in different workspaces gets distinct bundles,
  // so we don't refetch on workspace switch — picker does a full reload
  // anyway, and rail navigation within a workspace is just module
  // switching.
  useEffect(() => {
    (async () => {
      for (const m of allModules) {
        if (!m.hasFrontend) continue;
        const res = await loadModule(m);
        setLoaded((l) => ({ ...l, [m.qid]: res }));
      }
    })();
  }, []);

  useEffect(() => {
    const onPop = () => setUrlState(parseUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Resolve the active module. URL fully identifies it — workspace+id.
  const activeMod = (urlState.ws && urlState.id)
    ? allModules.find((m) => m.workspace === urlState.ws && m.id === urlState.id)
    : null;
  const activeQid = activeMod?.qid || null;

  // URL points at a (ws, id) pair that doesn't exist — tidy back to the
  // workspace home if the workspace is real, else root.
  useEffect(() => {
    if (urlState.id === null) return;
    if (activeMod) return;
    const wsExists = wsList.some((w) => w.id === urlState.ws);
    const target = wsExists ? buildUrl(urlState.ws, null) : '/';
    window.history.replaceState(null, '', target);
    setUrlState(parseUrl());
  }, [activeQid, activeMod, urlState.ws, urlState.id, wsList.length]);

  // Hot reload — module-aware, qid-keyed. Active module / shell / ambient
  // module / unknown id → full reload. Other modules → mark dirty; the next
  // navigation to that module does a full page load.
  const activeQidRef = useRef(null);
  activeQidRef.current = activeQid;
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const dirtyRef = useRef(new Set());

  useEffect(() => {
    const unsub = window.__atelier?.subscribe?.('shell', (frame) => {
      if (frame.type !== 'reload') return;
      const id = frame.moduleId;
      if (id === 'shell' || id === activeQidRef.current) {
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
  }, []);

  // SPA navigation. Full-page when the target module is dirty.
  function navigateTo(target) {
    const here = window.location.pathname + window.location.search;
    if (here !== target) {
      window.history.pushState(null, '', target);
      window.dispatchEvent(new CustomEvent('atelier:navigate', { detail: { url: target } }));
    }
    setUrlState(parseUrl());
  }

  function navigateToItem(item) {
    const target = buildUrl(item.workspace, item.id);
    if (item.qid && dirtyRef.current.has(item.qid)) { window.location.assign(target); return; }
    navigateTo(target);
  }

  // Pick a workspace from the picker. Full reload — workspace switch is
  // treated like a login session boundary (cache busts, bundles re-fetch,
  // WS reconnects). Preserve the current module id if the destination
  // workspace has a module of the same name.
  function pickWorkspace(ws) {
    const curId = urlState.id;
    const preserve = curId && allModules.some((m) => m.workspace === ws && m.id === curId)
      ? curId : null;
    window.location.assign(buildUrl(ws, preserve));
  }

  const entry = activeMod ? loaded[activeMod.qid] : null;
  const ActiveModule = entry?.status === 'ok' ? entry.Module : null;
  const activeName = entry?.meta?.name || activeMod?.meta?.name || activeMod?.id;

  useEffect(() => {
    document.title = activeName ? `Atelier · ${activeName}` : 'Atelier';
  }, [activeName]);

  // TopBarCenter slot — first module that exports one wins; subsequent
  // claimants are warned about and ignored. Eligible modules match the
  // same rail-composition rule (current workspace OR global) so a global
  // `mission-control` keeps its topbar slot from inside any workspace.
  // Workspace-mounted slot wins over global if both exist (parallel to
  // rail shadowing).
  let TopBarCenterSlot = null;
  let topBarCenterClaimedBy = null;
  const slotCandidates = allModules
    .filter((m) => m.workspace === effectiveWorkspace || m.workspace === 'global')
    // workspace-scoped candidate beats global when ids match
    .sort((a, b) => (a.workspace === 'global' ? 1 : 0) - (b.workspace === 'global' ? 1 : 0));
  for (const m of slotCandidates) {
    const e = loaded[m.qid];
    if (e?.status !== 'ok' || !e.TopBarCenter) continue;
    if (TopBarCenterSlot) {
      console.warn(
        `[atelier] both "${topBarCenterClaimedBy}" and "${m.qid}" export TopBarCenter; keeping the first.`
      );
      continue;
    }
    TopBarCenterSlot = e.TopBarCenter;
    topBarCenterClaimedBy = m.qid;
  }

  // Rail composition is a UI choice (server doesn't care): show this
  // workspace's modules PLUS the global ones, so a tab in `bigcorp` still
  // has the rail-level affordances global modules provide. When the user
  // is inside `global` itself, this naturally collapses to just global
  // modules. Sorted by id; workspace mounts win over the global mount
  // when the same id exists in both.
  const railById = new Map();
  for (const m of allModules) {
    if (m.workspace !== 'global' && m.workspace !== effectiveWorkspace) continue;
    const existing = railById.get(m.id);
    if (!existing || m.workspace !== 'global') {
      railById.set(m.id, m);
    }
  }
  const wsModules = [...railById.values()].sort((a, b) => a.id.localeCompare(b.id));

  // Group/ungrouped split. Bootstrap meta seeds first paint; runtime meta
  // (from the loaded bundle) wins once available so live edits take effect.
  // Ambient-only modules (loaded ok but no default export) are filtered out.
  const ungrouped = [];
  const groups = [];
  const groupIndex = new Map();
  for (const m of wsModules) {
    const e = loaded[m.qid];
    if (e?.status === 'ok' && !e.Module) continue;
    const meta = { ...(m.meta || {}), ...(loaded[m.qid]?.meta || {}) };
    const item = {
      id: m.id,
      qid: m.qid,
      workspace: m.workspace,
      name: meta.name || m.id,
      icon: meta.icon || 'square',    // documented fallback in README
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

  // Picker shows non-global workspaces. `global` is the rail's baseline
  // (always merged in via railById above), not a destination — so when
  // the user has any $-workspaces they pick between those. With no
  // $-workspaces the picker hides entirely.
  const pickerWorkspaces = wsList.filter((w) => w.id !== 'global');
  const showPicker = pickerWorkspaces.length >= 1;

  return (
    <AppShell
      full
      topBar={
        <TopBar
          workspace={effectiveWorkspace || ''}
          showWorkspace={showPicker && !!effectiveWorkspace}
          subtitle={activeName}
          env={boot.env}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
          center={TopBarCenterSlot ? <TopBarCenterSlot /> : null}
        />
      }
      notice={<ConnectionBanner />}
      left={
        <LeftRail
          ungrouped={ungrouped}
          groups={groups}
          activeId={activeMod?.qid || null}
          onSelect={navigateToItem}
          onAddModule={() => navigateTo(buildUrl(effectiveWorkspace, null))}
          workspace={effectiveWorkspace || null}
          workspaces={pickerWorkspaces}
          onPickWorkspace={pickWorkspace}
          showWorkspace={showPicker}
          headerLabel={boot.mode === 'standalone' ? 'module' : 'modules'}
          collapsed={sidebarCollapsed}
        />
      }
    >
      {!activeMod
        ? <EmptyWorkspace workspace={effectiveWorkspace || ''} showWorkspace={showPicker && !!effectiveWorkspace} />
        : ActiveModule
          ? <ModuleErrorBoundary moduleId={activeMod.qid}><ActiveModule /></ModuleErrorBoundary>
          : <LoadingScreen modules={allModules} loaded={loaded} activeQid={activeMod.qid} />}
    </AppShell>
  );
}

function EmptyWorkspace({ workspace, showWorkspace = false }) {
  const snippet = `export default function Module() {
  return <div className="p-8">hello</div>;
}`;
  const breadcrumb = showWorkspace ? `atelier · ${workspace}` : 'atelier';
  return (
    <div className="flex-1 min-h-0 grid-bg flex items-center justify-center relative overflow-auto">
      <div className="max-w-[560px] px-12 py-10">
        <div className="font-mono text-11 tracking-caps text-fg-muted lowercase mb-3.5">
          {breadcrumb}
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

function LoadingScreen({ modules, loaded, activeQid }) {
  const mod = modules.find((m) => m.qid === activeQid);
  const state = mod ? loaded[mod.qid] : undefined;
  if (state?.status === 'error') {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center p-10 grid-bg">
        <div className="max-w-[520px] bg-card border border-[rgba(251,73,52,0.4)] rounded-sm px-4 py-3.5 font-mono text-12 text-fg-primary">
          <div className="text-[#fb4934] text-11 tracking-caps lowercase mb-1.5">
            {mod?.qid} · failed to load
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
        <span className="label">loading {mod?.qid ?? ''}…</span>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
