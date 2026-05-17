/* atelier · builtin chrome
 *
 * The shell's default visual layer. It claims the `chrome` slot by exporting
 * a top-level `chrome` function plus `meta = { chrome: true, hidden: true }`.
 * The shell ships zero pixels — everything you see (rail, topbar, connection
 * banner, takeover wrapping, empty-state, loading screen, fonts, colors,
 * scrollbars) lives here.
 *
 * If you want a custom chrome:
 *   1. Copy this folder into a module (any global-workspace module).
 *   2. Edit the JSX/CSS.
 *   3. Keep `meta = { chrome: true, hidden: true }` and the `chrome` named
 *      export. First global module claiming the slot wins.
 *
 * Contract — props the shell hands the `chrome` function:
 *   boot           — { mode, env }                       (passthrough)
 *   user           — { id, name, workspaces }            (post-auth user)
 *   modules        — [{ qid, id, workspace, hasFrontend, meta }]
 *   workspaces     — [{ id, modules: [{id, meta}] }]
 *   workspace      — string  (currently routed workspace)
 *   activeQid      — string|null
 *   active         — { kind: 'none'|'loading'|'error'|'ready', element?, err?, qid? }
 *   loadedModules  — { [qid]: { hasDefault, TopBarCenter, meta, status, err } }
 *   navigate       — (qid: string) => void               (SPA push)
 *   pickWorkspace  — (wsId: string) => void              (full reload)
 *
 * Chrome owns:
 *   • TopBar, LeftRail, sidebar toggle (incl. ⌘\ binding)
 *   • Workspace picker
 *   • Connection banner (listens to `atelier:connection`)
 *   • Module error boundary wrapping `active.element`
 *   • Loading + empty + load-error placeholders
 *   • Lucide MutationObserver that auto-stamps <i data-lucide="…"> children
 *   • The stylesheet (loaded at module-import time below)
 * ========================================================================= */

const { useState, useEffect, useRef, useLayoutEffect } = React;

/* =========================================================================
 * Stylesheet loader — ensures the chrome's styles.css is appended to <head>
 * exactly once at module import, before first paint. Idempotent under hot
 * reload (id-keyed).
 *
 * The stylesheet path is derived from `import.meta.url` so the chrome works
 * regardless of which workspace it's mounted under (the builtin lives at
 * `global/atelier-chrome`; a custom chrome could be `global/my-skin`).
 * ========================================================================= */
(function ensureChromeStyles() {
  if (typeof document === 'undefined') return;
  const id = 'atelier-chrome-styles';
  if (document.getElementById(id)) return;
  let href;
  try { href = new URL('./styles.css', import.meta.url).href; }
  catch { return; }
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
})();

/* =========================================================================
 * Lucide auto-stamper
 *
 * Modules write <i data-lucide="name" /> and we replace those placeholders
 * with SVGs on every DOM mutation. RAF-debounced (coalesces many mutations
 * into one createIcons call) and self-disconnecting during the sweep (so
 * the SVG replacements themselves don't re-trigger the observer — no loop).
 * Top-level (not inside a component) so it runs once per chrome import.
 * ========================================================================= */
(function wireLucideObserver() {
  if (typeof document === 'undefined') return;
  if (window.__atelierLucideWired) return;
  window.__atelierLucideWired = true;
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
  schedule();
})();

/* =========================================================================
 * Atoms — Icon, Spinner, AtelierMark, SidebarToggle
 * ========================================================================= */

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

/* =========================================================================
 * TopBar — brand + workspace + subtitle + center slot + right slot.
 * ========================================================================= */
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

/* =========================================================================
 * Workspace picker — opens a dropdown of workspaces. The shell shows it
 * only when there's at least one non-`global` workspace.
 * ========================================================================= */
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

/* =========================================================================
 * LeftRail — picker + module list with optional groups.
 * ========================================================================= */
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
    </a>
  );
}

/* =========================================================================
 * ConnectionBanner — listens to window's `atelier:connection` event.
 *   • 'offline'  — server unreachable. Red. WS keeps trying.
 *   • 'unauthed' — session expired. Amber. Sign-in CTA reloads through auth.
 * ========================================================================= */
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

/* =========================================================================
 * Outer frame — TopBar + notice + LeftRail + main split.
 * ========================================================================= */
function AppShell({ topBar, notice, left, children }) {
  return (
    <div className="relative flex flex-col overflow-hidden rounded-sm bg-canvas text-fg-primary font-sans border border-default w-screen h-screen">
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
 * Empty + Loading + Error placeholders rendered into <main>
 * ========================================================================= */
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

function LoadingBody({ qid }) {
  return (
    <div className="flex-1 flex items-center justify-center grid-bg">
      <div className="flex flex-col items-center gap-2">
        <Spinner size={16} />
        <span className="label">loading {qid ?? ''}…</span>
      </div>
    </div>
  );
}

function ErrorBody({ qid, err }) {
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center p-10 grid-bg">
      <div className="max-w-[520px] bg-card border border-[rgba(251,73,52,0.4)] rounded-sm px-4 py-3.5 font-mono text-12 text-fg-primary">
        <div className="text-[#fb4934] text-11 tracking-caps lowercase mb-1.5">
          {qid} · failed to load
        </div>
        <div className="whitespace-pre-wrap break-words text-fg-secondary">
          {String(err?.message || err)}
        </div>
      </div>
    </div>
  );
}

/* Per-module render-error boundary — keeps one broken module from blanking
 * the entire shell. Reset on qid change. */
class ModuleErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }
  static getDerivedStateFromError(err) {
    return { err };
  }
  componentDidCatch(err, info) {
    console.error('[atelier-chrome] module render crashed:', err, info);
  }
  componentDidUpdate(prev) {
    if (prev.qid !== this.props.qid && this.state.err) {
      this.setState({ err: null });
    }
  }
  render() {
    if (this.state.err) {
      return (
        <div className="flex-1 min-h-0 flex items-center justify-center p-10 grid-bg">
          <div className="max-w-[520px] bg-card border border-[rgba(251,73,52,0.4)] rounded-sm px-4 py-3.5 font-mono text-12 text-fg-primary">
            <div className="text-[#fb4934] text-11 tracking-caps lowercase mb-1.5">
              {this.props.qid} · render error
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

/* =========================================================================
 * Chrome — the slot the shell mounts as the root component.
 *
 * Composition logic (rail + topBarCenter slot) lives here, not in the shell,
 * so a custom chrome can rule on what to show and where.
 * ========================================================================= */
export function chrome({
  boot,
  user,
  modules,
  workspaces,
  workspace,
  activeQid,
  active,
  loadedModules,
  navigate,
  pickWorkspace,
}) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const toggleSidebar = () => setSidebarCollapsed((c) => !c);

  // ⌘\ toggles the rail. Bound here (chrome owns the sidebar).
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

  // TopBarCenter slot resolution — first eligible module wins (workspace
  // candidates beat global on id-collision; otherwise alphabetical by qid).
  let TopBarCenterSlot = null;
  let claimedBy = null;
  const candidates = modules
    .filter((m) => m.workspace === workspace || m.workspace === 'global')
    .sort((a, b) => (a.workspace === 'global' ? 1 : 0) - (b.workspace === 'global' ? 1 : 0));
  for (const m of candidates) {
    const e = loadedModules[m.qid];
    if (e?.status !== 'ok' || !e.TopBarCenter) continue;
    if (TopBarCenterSlot) {
      console.warn(`[atelier-chrome] both "${claimedBy}" and "${m.qid}" export TopBarCenter; keeping the first.`);
      continue;
    }
    TopBarCenterSlot = e.TopBarCenter;
    claimedBy = m.qid;
  }

  // Rail composition: current workspace's modules + always-global modules.
  // Workspace mounts win over global on id-collision; alphabetical otherwise.
  // Hidden modules (e.g. chrome modules) excluded.
  const railById = new Map();
  for (const m of modules) {
    if (m.workspace !== 'global' && m.workspace !== workspace) continue;
    const loadedMeta = loadedModules[m.qid]?.meta || {};
    const merged = { ...(m.meta || {}), ...loadedMeta };
    if (merged.hidden) continue;
    if (merged.chrome) continue;        // never list a chrome in the rail
    const existing = railById.get(m.id);
    if (!existing || m.workspace !== 'global') {
      railById.set(m.id, { ...m, meta: merged });
    }
  }
  const wsModules = [...railById.values()].sort((a, b) => a.id.localeCompare(b.id));

  // Skip modules whose bundle loaded but has no default export (slot-only).
  const ungrouped = [];
  const groups = [];
  const groupIndex = new Map();
  for (const m of wsModules) {
    const loaded = loadedModules[m.qid];
    if (loaded?.status === 'ok' && !loaded.hasDefault) continue;
    const meta = m.meta || {};
    const item = {
      id: m.id,
      qid: m.qid,
      workspace: m.workspace,
      name: meta.name || m.id,
      icon: meta.icon || 'square',
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

  // Picker hides `global` (it's the rail's baseline, not a destination).
  const pickerWorkspaces = (workspaces || []).filter((w) => w.id !== 'global');
  const showPicker = pickerWorkspaces.length >= 1;

  // Title reflects active module (use live meta if available).
  const activeMeta = activeQid ? (loadedModules[activeQid]?.meta || {}) : {};
  const activeMod = activeQid ? modules.find((m) => m.qid === activeQid) : null;
  const activeName = activeMeta.name || activeMod?.meta?.name || activeMod?.id;
  useEffect(() => {
    document.title = activeName ? `Atelier · ${activeName}` : 'Atelier';
  }, [activeName]);

  // Resolve body content from active state.
  let body;
  if (active.kind === 'none') {
    body = <EmptyWorkspace workspace={workspace || ''} showWorkspace={showPicker && !!workspace} />;
  } else if (active.kind === 'loading') {
    body = <LoadingBody qid={active.qid} />;
  } else if (active.kind === 'error') {
    body = <ErrorBody qid={active.qid} err={active.err} />;
  } else {
    body = <ModuleErrorBoundary qid={active.qid}>{active.element}</ModuleErrorBoundary>;
  }

  return (
    <AppShell
      topBar={
        <TopBar
          workspace={workspace || ''}
          showWorkspace={showPicker && !!workspace}
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
          activeId={activeQid}
          onSelect={(item) => navigate(item.qid)}
          onAddModule={() => navigate(`${workspace}/`)}
          workspace={workspace || null}
          workspaces={pickerWorkspaces}
          onPickWorkspace={pickWorkspace}
          showWorkspace={showPicker}
          headerLabel={boot.mode === 'standalone' ? 'module' : 'modules'}
          collapsed={sidebarCollapsed}
        />
      }
    >
      {body}
    </AppShell>
  );
}

export const meta = { chrome: true, hidden: true };
