/* Atelier client — host shell + app boot.
 *
 * Compiled by esbuild and served at /assets/client.js. Runs after React,
 * ReactDOM, and Lucide (all UMD from CDN — see index.html).
 *
 * Shape:
 *   • Small private helpers (Icon, StatusDot, Spinner) — used by the chrome,
 *     never exposed to modules.
 *   • Shell components (AtelierMark, TopBar, LeftRail, RailItem, AppShell).
 *   • App boot — reads window.__ATELIER__, discovers modules, renders.
 *
 * Modules are plain React components: default-export a function, optionally
 * `export const meta = { icon, name, color }`. They get React + Tailwind +
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

/* StatusDot — halo'd dot used by RailItem for module status. */
function StatusDot({ kind = 'idle', size = 6, pulse = false, className = '', style }) {
  const tone = {
    ok:     { bg: 'var(--color-signal-success)', ring: 'var(--color-signal-success-wash)' },
    warn:   { bg: 'var(--color-signal-warning)', ring: 'var(--color-signal-warning-wash)' },
    danger: { bg: 'var(--color-signal-danger)',  ring: 'var(--color-signal-danger-wash)' },
    info:   { bg: 'var(--color-signal-info)',    ring: 'var(--color-signal-info-wash)' },
    idle:   { bg: 'var(--color-fg-muted)',       ring: 'transparent' },
  }[kind] || { bg: 'var(--color-fg-muted)', ring: 'transparent' };
  return (
    <span
      className={[
        'inline-block rounded-full flex-none align-middle',
        pulse ? 'animate-pulse-dot' : '',
        className,
      ].join(' ')}
      style={{
        width: size, height: size,
        background: tone.bg,
        boxShadow: tone.ring === 'transparent' ? 'none' : `0 0 0 3px ${tone.ring}`,
        ...style,
      }}
    />
  );
}

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

/* TopBar — 44px chrome with brand + workspace + optional subtitle + right slot. */
function TopBar({ workspace = 'personal', right, subtitle }) {
  return (
    <div className="flex-none flex items-center gap-2.5 px-3 h-[var(--header-h)] border-b border-subtle bg-raised">
      <div className="flex items-center gap-2">
        <AtelierMark />
        <span className="font-display italic text-16 text-fg-display tracking-[-0.015em]">
          atelier
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
      <div className="flex-1" />
      {right}
    </div>
  );
}

/* LeftRail — workspace switcher + header label + scrollable module list. */
function LeftRail({
  modules,
  activeId,
  onSelect,
  workspace = 'personal',
  onAddModule,
  headerLabel = 'modules',
  footer,
  collapsed = false,
}) {
  if (collapsed) return null;
  return (
    <aside className="flex-none flex flex-col overflow-hidden border-r border-subtle bg-raised w-[var(--rail-w)]">
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
        {modules.length === 0 ? (
          <div className="font-mono text-11 text-fg-subtle leading-[1.6] px-1.5 py-1">
            <span className="text-fg-muted">no modules yet.</span>
          </div>
        ) : (
          modules.map((m) => (
            <RailItem
              key={m.id}
              mod={m}
              active={m.id === activeId}
              onClick={() => onSelect && onSelect(m.id)}
            />
          ))
        )}
      </div>

      {footer}
    </aside>
  );
}

/* RailItem — one row in LeftRail. CSS hover; active wins over hover. */
function RailItem({ mod, active, onClick }) {
  return (
    <div
      onClick={onClick}
      className={[
        'flex items-center gap-2 px-2 py-1.5 rounded-sm cursor-pointer mb-px',
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
      <StatusDot kind={mod.status} />
    </div>
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

// Hot reload: server pushes 'reload' on any file change under the project root.
// The simplest thing that works — full page reload, no HMR state preservation.
if (!window.__atelierHotWired) {
  window.__atelierHotWired = true;
  const es = new EventSource('/_atelier/hot');
  es.onmessage = () => window.location.reload();
}

// Load a module's compiled frontend via dynamic ESM import. The module should
// `export default Module` and may `export const meta = { icon, color, name }`.
async function loadModule(id) {
  try {
    const mod = await import(`/modules/${id}/frontend.js`);
    return { Module: mod.default, meta: mod.meta || {} };
  } catch (err) {
    console.error(`[atelier] failed to load module '${id}':`, err);
    return null;
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

  function navigate(id) {
    const target = id ? `/${id}` : '/';
    if (window.location.pathname !== target) {
      window.history.pushState(null, '', target);
    }
    setPath(id);
  }

  const entry = active ? loaded[active.id] : null;
  const ActiveModule = entry?.Module;
  const activeName = (entry?.meta?.name) || active?.id;

  const railModules = boot.modules.map((m) => {
    const meta = loaded[m.id]?.meta || {};
    return {
      id: m.id,
      name: meta.name || m.id,
      icon: meta.icon,
      status: 'idle',
    };
  });

  return (
    <AppShell
      full
      topBar={<TopBar workspace="personal" subtitle={activeName} />}
      left={
        <LeftRail
          modules={railModules}
          activeId={active?.id || null}
          onSelect={navigate}
          onAddModule={() => navigate(null)}
          workspace="personal"
          headerLabel={boot.mode === 'standalone' ? 'module' : 'modules'}
        />
      }
    >
      {!active
        ? <EmptyWorkspace />
        : ActiveModule
          ? <ActiveModule />
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
  return (
    <div className="flex-1 flex items-center justify-center grid-bg">
      <div className="flex flex-col items-center gap-2">
        <Spinner size={16} />
        <span className="label">
          {state === false ? `failed to load ${mod?.id}` : `loading ${mod?.id ?? ''}…`}
        </span>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
