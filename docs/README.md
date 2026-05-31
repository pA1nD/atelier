# Atelier

The app shell + module runner. Discovers sibling modules, mounts their backends, serves their frontends, renders the shared UI chrome (TopBar, LeftRail, AppShell).

> **Platform.** Atelier runs anywhere **Node 24+** does — there's no OS-specific install layer (an instance is a folder you run; your process manager / PaaS / reverse proxy is your concern). Recursive file-watching (hot reload) works on macOS, Linux, and Windows on Node 24.

## Running an instance

An atelier instance is a **folder you run** — there is no install step, no launchd, no `~/.atelier/`. The folder holds (or path-mounts via config) your modules and a chrome, plus an optional `atelier.config.json`.

```
npm install
npm run dev                                # http://localhost:1844 (PORT= to override), hot reload
npm run dev:module -- <id>                 # standalone — just one module
npm run dev:module -- <workspace>/<id>     # standalone — a workspace module
```

`npm run dev` is just `node server.js`. Point a browser at the port; you'll see an "add a chrome" screen until a chrome is installed (the shell ships none). Standalone mode (`dev:module`) runs a single module in isolation — it shows no chrome unless the requested module is itself one.

### One folder = one instance

There is no dev/prod mode. To run a second instance — a "production" one, staging, a per-tenant one — **run a second folder** (or the same folder with different startup settings). Each instance's behavior is resolved from three layers, lowest to highest:

1. **System defaults** — `port: 1844`, `hotReload: true`, `auth: false`, no chrome.
2. **`atelier.config.json`** in the instance folder — the source of truth (see [Configuration](#configuration--discovery)).
3. **Environment variables** at startup — they override the file, so a PaaS can inject a dynamic `PORT` / `BASE_URL`.

A typical "production" folder sets something like `{ "hotReload": false, "auth": "<auth-module>", "chrome": "<chrome>", "port": 1844 }` and sits behind your own reverse proxy. atelier doesn't manage processes, TLS, or hostnames — that's your platform's job.

### Module dependencies

Most modules are one file and need nothing. A module that imports a third-party package declares it in its own `<module>/package.json`; run `npm install` inside that module's directory and its `node_modules/` resolves locally (the bundle preserves `import.meta.url`, so resolution walks up from the module's own `backend.js`). The shell never installs module deps for you.

### Runtime state

Backends write persistent state under `ctx.dataDir` (`<module>/data/`). It's per-instance and the shell never touches it — back it up however your platform backs up a folder. Keep `<module>/.claude/` definitional content (skills, agents, commands, hooks) in source; treat `.claude/`'s runtime dirs (`agent-memory/`, `projects/`, …) as local state.

### Workspaces are part of the folder

Workspace modules (`$<ws>/<id>/`) are first-class at runtime. Since "deploying" is now just "having the folder," there's no special workspace step — a `$<ws>/` directory ships with the instance folder like anything else.

## Building modules

### Module convention

A sibling directory of `atelier/` is a module iff it contains `frontend.jsx` or `backend.js`. The directory name is the id and default display name.

**Minimal module** — one file:

```jsx
// hello/frontend.jsx
export default function Module() {
  return <div className="p-8">hello</div>;
}
```

**Optional metadata** — custom icon / name / group:

```jsx
export const meta = { icon: 'activity', name: 'Activity', group: 'marketing' };
export default function Module() { ... }
```

Supported keys:
- `icon` — a rail-icon name the **active chrome** renders (catalyst maps lucide-style names like `kanban` / `shield-check` to its Heroicon set; the shell ships no icons).
- `name` — display name (rail label).
- `group` — rail section: modules with the same `group` render under a shared header; untagged modules live under the default "modules" section.
- `primary` — boolean; the module the shell lands on at `/` for its workspace.
- `hidden` — boolean; keep the module out of the rail and `defaultUser` (chromes set this on themselves).
- `chrome` — boolean; marks a global-workspace module as the chrome (global-workspace only).
- `color` — reserved for future use.

`meta` is optional; the rail falls back to `icon: 'square'` and `name: <dir>`.

Meta is parsed server-side at discovery time (esbuild-transform `frontend.jsx` → import via `data:` URL) and shipped in the HTML bootstrap, so grouping renders correctly on first paint — no flicker.

**Optional backend** — `backend.js`. Routes are scoped: the shell mounts them at `/api/<workspace>/<id>`, so handlers register *relative* paths.

```js
export default {
  mountRoutes(router, ctx) {
    // Mounts at /api/global/hello/say (or /api/<ws>/hello/say in a workspace).
    router.get('/say', (req, res) => res.json({ ok: true }));
  },
};
```

`ctx` exposes exactly: `id`, `name`, `workspace`, `qualifiedId` (`'<workspace>/<id>'`), `label`, `port`, `baseUrl`, `dataDir`, `log`, `broadcast`, `module` — and nothing else (no CORS or auth helpers; a module that needs CORS sets its own response headers). URLs you return in response bodies — for clients to follow — should be built off the module's mount point (`/api/${ctx.qualifiedId}/...`), not hardcoded.

**Frontend self-reference (workspace-aware, never hardcoded)** — a module's `frontend.jsx` must derive its API base and WS topic from where it's actually mounted, so the same bundle works in any workspace (`global` is just the default). Use the shell helper — pass it this bundle's `import.meta.url`:

```js
const self = window.__atelier.self(import.meta.url);
// self.workspace 'global' | '<ws>'   self.id 'kanban'   self.qid '<ws>/kanban'
// self.api  '/api/<ws>/kanban'        self.topic '<ws>/kanka' (the WS topic)

self.subscribe((frame) => { … });        // listens on self.topic — workspace-aware
const unsub = self.subscribe(handler);    // returns an unsubscribe fn
fetch(self.api + '/items');               // hits /api/<ws>/kanban/items
```

This mirrors how backend routes are workspace-scoped: just as `router.get('/items')` becomes `/api/<ws>/<id>/items` without the module naming its workspace, `self.subscribe(...)` listens on `<ws>/<id>` without hardcoding it. **Never write a literal topic or `/api/<name>/...` path** — the workspace can change (the same module mounted under a different `$<ws>/`), and a hardcoded topic would silently miss its own frames. For cross-module calls, reach peers under the same workspace: `/api/${self.workspace}/<peer>/...`.

**Optional skills** — `<module>/.claude/skills/<skill-name>/SKILL.md`. This is the same path Claude Code natively loads when the module directory is the workspace, so for dev just `cd <module> && claude` and the skill is live — no install step, no symlink. A skill is a markdown file with YAML frontmatter.

The shell doesn't read or interpret any of this — `<module>/.claude/` is just part of the module folder and travels with it like any other source. Whether and how skills get aggregated into agent sessions, or installed into `~/.claude/skills/`, is a module-space concern, not the shell's.

### Workspaces

Atelier runs as one shell that hosts multiple isolated tenants. Every module belongs to exactly one **workspace**:

- The **`global` workspace** is synthetic — root-folder modules belong to it. There is no `$global/` directory on disk (the name is reserved). `cd atelier-clone && ls` listing kanban/ + posts/ next to atelier/ is the global workspace.
- A `$<name>/` directory at the workspace root is a workspace. Its sibling subdirectories are that workspace's modules. The same module conventions apply one level deeper.

```
atelier/                    ← shell
auth/                       ← module:  global/auth
kanban/                     ← module:  global/kanban
$bigcorp/                   ← workspace
  kanban/                   ←   module: bigcorp/kanban
    frontend.jsx
    backend.js
  posts/                    ←   module: bigcorp/posts
$othercorp/
  kanban/                   ←   module: othercorp/kanban
```

Every module's identity is its **qualifiedId** (`'<workspace>/<id>'`) — that single string anchors URLs, API routes, asset paths, WebSocket topics, slot keys, and watchers.

| Surface | Shape | Examples |
|---|---|---|
| SPA page URL | `/<ws>/<id>` | `/global/kanban`, `/bigcorp/posts` |
| API base | `/api/<ws>/<id>` | `/api/global/kanban`, `/api/bigcorp/posts` |
| Module bundle | `/modules/<ws>/<id>/frontend.js` | `/modules/global/kanban/frontend.js` |
| Module asset | `/modules/<ws>/<id>/<rest>` | `/modules/global/kanban/screenshots/board.png` |
| WebSocket topic | `<ws>/<id>` | `global/kanban`, `bigcorp/posts` |
| Slot key (`ctx.module`) | scoped to caller's workspace | `ctx.module('posts')` inside `bigcorp/kanban` ≠ same in `global/kanban` |
| Data dir on disk | `<source>/data/` | `kanban/data/`, `$bigcorp/kanban/data/` |

The URL is the only source of truth for "which workspace am I in." There is no cookie, no Referer chain, no header precedence. The picker writes a new URL on workspace switch (full reload, like a session change).

**Why a synthetic `global` instead of letting root modules be "workspace-less"?**

Symmetry. Every module has the same identity shape (`<ws>/<id>`), the same URL pattern, the same WS topic format. Module source doesn't branch on "am I in a workspace right now" — it just is in one. The bundle reads its URL at runtime to know which one. The cost is two extra characters per URL for the common case (`/global/kanban` vs `/kanban`), which we judged worth paying once to keep the rest of the model uniform.

**Rail composition**

The left rail in a workspace shows that workspace's modules **plus** the global modules — so a workspace tab still has the rail-level affordances global modules provide. When a workspace module shares its id with a global one, the workspace version wins. From inside `global`, the rail shows just global's modules.

**The picker** (top of LeftRail) lists every non-`global` workspace the user has access to. With zero `$-workspaces`, the picker hides entirely. Picking a workspace navigates to `/<new-ws>/<preserved-id>` (or `/<new-ws>/` if the current module doesn't exist there) — full page reload so caches, bundles, and the WS reconnect cleanly.

**Reserved names** (rejected as both module dir names and workspace names — `$<reserved>/` is silently skipped with a warning):

- `atelier` — the shell itself
- `api` — `/api/<ws>/<id>/...` is the module route namespace
- `assets` — `/assets/<name>.(js|css)` serves shell static files
- `modules` — `/modules/<ws>/<id>/...` serves module bundles + assets
- `global` — the synthetic workspace name for root-folder modules

Workspace folder names (after the `$`) must match `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`. A `$workspace+lab/` is rejected (the `+` fails the regex).

For the auth and access-control story (auth module slot, `req.user`, takeover, `defaultUser`), see [AUTH.md](./AUTH.md).

## Runtime & communication

### Hot reload

When `hotReload` is enabled (the default), the server watches the instance folder with `fs.watch` and pushes to the client over the shared WebSocket (`/_atelier/ws`, topic `'shell'`). Any change — new module folder, edited `.jsx`/`.css` — triggers a full page reload, and a module's `backend.js` hot-swaps in place. Editing the shell itself (`server.js`, `build.js`, `discovery.js`, `client.jsx`) still needs a manual restart.

Set `hotReload: false` in a deployed instance's config (or `ATELIER_HOT_RELOAD=0`) to disable all file watchers and backend hot-swap.

### Real-time transport — `/_atelier/ws`

Atelier exposes one shared WebSocket per browser tab at `/_atelier/ws`. Every real-time event in the workspace flows through it, multiplexed by **topic**. Topics are qualified ids:

- `'shell'` — shell events (hot reload, etc.). The client always subscribes.
- `'<workspace>/<id>'` — events from one module mount. Same-named modules in different workspaces have distinct topics; they can't cross-talk.

The server stamps `topic` on every emitted frame and broadcasts to all connected clients. The client-side subscriber map decides what each frame actually delivers.

**Why one WebSocket and not per-module SSE.** Browsers cap HTTP/1.1 to 6 concurrent connections per origin. Each SSE eats one slot, so once you had hot-reload + N module SSEs + multiple tabs, page navigations stalled intermittently. WebSocket per-origin limits are an order of magnitude higher (Chrome ~255 globally), so a single multiplexed WS per tab is effectively unbounded for localhost dev. The same pattern is used by Vite, Next.js, and Webpack dev-server.

**Wire format.** Each frame is JSON: `{ topic, ...event }`. The shell stamps `topic` on the way out; the client filters on the way in.

#### Server side — `ctx.broadcast(event)`

Modules emit real-time events via the per-mount `ctx`:

```js
export default {
  mountRoutes(router, ctx) {
    router.post('/run', async (req, res) => {
      const id = doSomething();
      ctx.broadcast({ type: 'run-started', id });   // → topic '<workspace>/mine'
      // …
      ctx.broadcast({ type: 'run-finished', id, ok: true });
      res.json({ ok: true, id });
    });
  },
};
```

The shell **always** stamps the emitted event's `topic` with the module's `qualifiedId` (`<ws>/<id>`, workspace-aware) — `ctx.broadcast` takes only the event payload; a module **cannot** choose or override the topic, so it can only emit under its own identity. (If a module passes a `topic` field it's ignored, and the shell logs a dev warning — don't hardcode it.) There is no global `broadcast`.

#### Client side — `window.__atelier.subscribe(topic, handler)`

Frontends subscribe to their own module's topic via the workspace-aware `self` helper (above) — never a hardcoded string:

```js
const self = window.__atelier.self(import.meta.url);
const unsub = self.subscribe((frame) => {       // listens on '<ws>/<id>'
  if (frame.type === 'run-finished') refresh();
});
unsub();   // when no longer interested
```

`self.subscribe(handler)` is just `window.__atelier.subscribe(self.topic, handler)` — use the low-level form directly only to listen on another known topic (e.g. the shell's `'shell'` topic).

The shell owns the WebSocket. Multiple subscribers — across modules, across components — share the same connection. Auto-reconnect with exponential backoff is built in, so dev-server restarts recover transparently.

For initial state on page mount (a new subscriber doesn't see what already happened before they connected), a module exposes a normal HTTP snapshot endpoint (e.g. a `/state` GET) and calls it once on mount, then keeps in sync via the subscription.

#### Per-module backend hot-swap (dev only)

Editing any file under `<module>/` (not just `backend.js`) re-imports *just that module's* backend — the atelier process keeps running, other modules are untouched. Used when several agents iterate on different modules in parallel; one agent's typo can't crash the others.

The shell:
- Runs a native recursive `fs.watch` on the whole module directory (only when `hotReload` is on). Watching the dir (not the file) survives atomic saves that change inode, and catches edits to transitive imports (`parser.js`, `lib/*.js`, etc.) — not just `backend.js`. Ignores `node_modules/`, `data/`, dotfiles, and `_`-prefixed segments; a 150ms debounce plus a newest-`.js`-mtime dedupe coalesce duplicate OS events, and a half-written read just fails the rebuild so the next event reloads cleanly.
- On change, **bundles** the module with esbuild (`packages: 'external'`, first-party transitive imports baked in, `import.meta.url` preserved for each module's own `fileURLToPath(import.meta.url)`) and imports the bundle via a base64 `data:` URL. Each bundle has unique bytes → a unique URL → Node's import cache naturally serves the new version; old versions drop out when nothing references them.
- If the import throws, keeps the old version running and logs `reload failed, keeping current version — <message>`.
- If it imports cleanly, strips the old module's routes, calls its teardown (if any), and mounts the new version. Log line: `↻ reloaded <qualifiedId> backend`.
- macOS `fs.watch` can fire ~2 events per save; the debounced callback dedupes by `mtimeMs` so a duplicate OS event is dropped while two genuine edits still trigger two reloads.

**Routes are stripped automatically.** The shell tracks exactly which routes each module added (via a scoped router) and removes them on swap.

**Closure state resets automatically.** A re-bundled import is a fresh module graph with its own closure, so module-level variables (e.g. an in-memory cache, a child-process `Map`, a subscribers Set) re-initialize. No module code needed.

**Side effects need a teardown.** Anything a module registers *outside* its own closure — `fs.watch` handles, `setInterval` / `setTimeout`, `child_process.spawn`ed children, long-lived response objects — survives a re-import. The module must opt into cleaning them up by returning a function from `mountRoutes`. (Real-time clients that subscribe via the shared WS are managed by the shell — modules don't need to clean those up.)

```js
export default {
  mountRoutes(router, ctx) {
    const watcher = fs.watch(...);
    const timer  = setInterval(...);
    const child  = spawn(...);

    router.get('/things', ...);

    // Called by the shell before this module is swapped out, AND on
    // process exit (SIGINT/SIGTERM/uncaught throw).
    return () => {
      watcher.close();
      clearInterval(timer);
      child.kill('SIGTERM');
    };
  },
};
```

Rule of thumb: if your module spawns processes, opens files/sockets, or holds long-lived connections, return a teardown. If it's pure request handlers on closure state, no teardown is needed.

(A module that spawns a child or opens a watcher returns a teardown that kills the child and closes the watcher — that function runs on both hot-swap and process exit.)

### Cross-module config — `ctx.module(id)`

For when one module has a small piece of context that another module wants — without HTTP between them, without import coupling, without inventing module-private files.

`ctx.module(id)` returns a **plain object** keyed by `(caller's workspace, target id)`. Every caller within the same workspace that asks for the same id gets the same object. Owners read from it lazily; consumers write directly. The shell stays neutral about meaning — it provides the registry, modules agree on the shape.

```js
// Most common use — a module stashes its OWN long-lived state so it survives a
// hot-reload (module-scope variables reset on re-import; a slot persists):
const slot = ctx.module(ctx.id);
slot.watcher ??= fs.watch(/* … */);     // set up once, not on every reload

// Cross-module — a consumer hands context to another module without HTTP or
// imports: it writes the owner's slot; the owner reads it lazily at use time.
ctx.module('search').indexRoot = '/data/corpus';   // from some other module
const root = ctx.module(ctx.id).indexRoot;          // inside the 'search' module
```

**Read at use time, not at mount time.** Modules mount concurrently in an arbitrary order (a consumer may mount before the owner it writes to), so any cross-module read *at mount time* is racy. Reading on demand makes order irrelevant: whoever wrote last is what the owner sees the next time it looks.

**Slot survives hot-reload of either side.** The registry lives on `globalThis.__atelierModuleSlots` — a single Map keyed by `'<callerWorkspace>/<targetId>'`, created once per process lifetime. A module reload swaps that module's `mountRoutes`, but the slot keeps its contents — which is exactly why it's the right home for a watcher, a child-process handle, or a cache.

**Workspace is a tenancy boundary.** A `global` module and a `$alpha` module can't leak state through a shared slot — `ctx.module('search')` inside `global/kanban` and inside `$alpha/kanban` resolve to different slots. A workspace-aware infrastructure module that genuinely wants to look across workspaces uses persisted records (with a workspace column) instead of the slot primitive.

**No methods, no validation, no events.** The slot is plain data. Validation belongs to whoever reads — log a warning and ignore garbage. If you find yourself wanting subscribe/notify, push for it on the shell rather than reinventing it module-side.

**Conventions when using a slot:**
- Owners document the keys they accept in their own source — there's no central registry.
- Use the target module's id as the slot key (`ctx.module('search')` addresses `search`'s slot; `ctx.module(ctx.id)` is your own).
- Treat the slot as a contract surface: don't write keys you don't own without coordinating, and don't read keys whose owner hasn't documented them.

### Module conventions

A few rules so modules compose cleanly with the shell and with each other:

**1. Don't register process-level signal handlers.** The shell owns `SIGINT` / `SIGTERM` / `'exit'` — see `teardownAllBackends` in [server.js](../server.js). It calls every mounted module's teardown before exit. Modules that register their own handlers can preempt the shell via `process.exit()` and skip other modules' cleanups, leaving children orphaned. If your module spawns children, kill them in your teardown — that path runs on both hot-swap *and* process exit.

**2. Spawned children must be tracked and torn down.** Anything from `child_process.spawn` / `fork` / `execFile` needs a `.kill('SIGTERM')` in the teardown. The shell-side teardown handler is the only thing that prevents children from getting reparented to the init process on Ctrl+C. Audit your module: every `spawn(...)` should have a matching kill in the returned function.

**3. Set a "shutting down" flag if your child has restart logic.** SIGTERM is async — your child's `proc.on('exit', ...)` handler fires *after* teardown returns. If that handler schedules a respawn (e.g. backoff after crash), it'll relaunch a child after the parent has already torn down. Set a module-scoped boolean inside teardown that the exit/respawn paths check:

```js
let shuttingDown = false;
proc.on('exit', () => {
  if (shuttingDown) return;     // ← teardown ran; don't respawn
  setTimeout(restart, backoff);
});
return () => { shuttingDown = true; proc.kill('SIGTERM'); };
```

**4. Use `ctx.qualifiedId` when you need to build absolute URLs the client will follow.** Response bodies returning URLs (e.g. `mediaUrl`, `metaUrl`) should be `'/api/' + ctx.qualifiedId + '/...'` — never a literal `/api/<your-name>/...` string, which only works under `global`.

**5. Don't edit `atelier/server.js` / `atelier/client.jsx` / `atelier/build.js` / `atelier/discovery.js` from inside a module task.** The shell is cross-cutting; changes there are their own task with their own authorization. If your module needs something the shell doesn't provide, name the gap and ask.

## Shell internals & chrome

### What lives here

- `server.js` — runner, router, discovery, settings resolution (defaults ← config ← env), WebSocket multiplex (`/_atelier/ws`), hot-reload broadcaster, auth slot, chrome-slot resolution
- `build.js` — build pipeline (esbuild JSX + Tailwind v4 + oxide)
- `discovery.js` — discovery rules (reserved names, workspaces) + `atelier.config.json` parsing
- `index.html` — template; React + ReactDOM from CDN. A single inline rule resets margins and hints `color-scheme`; the shell paints zero pixels (no favicon, theme-color, or icon library — those belong to the chrome).
- `client.jsx` — slim router + bundle loader + error fallback. Loads the chrome bundle (`chromeQid` resolved server-side) and renders it as the root. Wires the WS multiplex (`window.__atelier.subscribe`).
- Chromes are ordinary modules. Two ship in the repo to copy: `catalyst-chrome/` (Tailwind/Catalyst, publishes `@atelier/kit`) and `gruvbox-chrome/` (the former builtin skin).

### Chrome slot

The shell ships zero visual bytes. Everything you see — rail, topbar, fonts, colors, picker, banner, favicon, theme-color, even the icon library — lives in a `chrome`-slot module. The chrome named by your config's `chrome` setting wins; otherwise the first global-workspace module whose `meta.chrome === true` (alphabetical by qualifiedId). **There is no default chrome** — with none installed the client renders a plain "add a chrome" screen.

To make a chrome: copy `catalyst-chrome/` or `gruvbox-chrome/` somewhere, edit, and point your `atelier.config.json` at it:

```json
{ "chrome": "~/my-skin", "modules": ["~/my-skin"] }
```

Your chrome's `frontend.jsx` must export a `chrome` function and `meta = { chrome: true, hidden: true }`, and inject any icon library it needs (the shell ships none — see the `ensureLucide` IIFE in either bundled chrome). The shell calls `chrome(props)` and renders the result as the root. See [`gruvbox-chrome/frontend.jsx`](../../gruvbox-chrome/frontend.jsx) for the full props contract.

#### Writing a custom chrome with real dependencies

The shell detects chrome modules at request time and routes their `frontend.jsx` through `esbuildBuild` (full bundling, `react`/`react-dom`/`react/jsx-runtime` aliased to `atelier/shims/*` so the chrome shares the shell's React instance). That means a chrome can ship its own `node_modules/` and use bare specifiers freely:

```jsx
// my-chrome/frontend.jsx
import * as Headless from '@headlessui/react'
import { motion } from 'motion/react'
import { ChevronDownIcon } from '@heroicons/react/16/solid'
import clsx from 'clsx'

export const meta = { chrome: true, hidden: true }

export function chrome({ modules, active, navigate, ... }) {
  return <div className="...">{/* whatever */}</div>
}
```

Drop a `package.json` in the chrome folder, `npm install` your deps, and the shell takes care of bundling. Module size is uncapped (catalyst-chrome's bundle is ~3 MB with Headless UI + motion + heroicons; cached after first build).

#### Publishing primitives to companion modules — `@atelier/kit`

A chrome can also ship a `kit.js` (or `kit.jsx`) alongside its `frontend.jsx`. When the shell sees this file, it injects an import map per request:

```html
<script type="importmap">
  {"imports": {"@atelier/kit": "/modules/<chromeQid>/kit.js"}}
</script>
```

Companion modules then write vanilla ESM imports:

```jsx
// some-module/frontend.jsx
import { Button, Dialog, Input, Field, Label } from '@atelier/kit'

export default function MyModule() {
  return (
    <Field>
      <Label>Email</Label>
      <Input type="email" />
      <Button>Send</Button>
    </Field>
  )
}
```

The browser resolves `@atelier/kit` to the active chrome's bundled kit. No bundling on the module side (per-file transform stays fast), no runtime registry, no `window.__atelier.kit` global — the kit's shape is a real ES module file you can Cmd-click into.

A chrome's `kit.js` is just a barrel re-export — what to publish is **chrome-defined**. There's no enforced contract: a module that imports `Foo` from `@atelier/kit` is implicitly paired with whichever chrome exports a compatible `Foo`. If you swap to a different chrome, those modules either get re-themed (the new chrome ships the same names with compatible props) or break — that's on the chrome author and the module author to coordinate. Themes are not drop-in by design; co-design chrome + its companion modules. The canonical example: [`catalyst-chrome/kit.js`](https://github.com/pA1nD/atelier) barrels Catalyst's `Button`, `Dialog`, `Sidebar*`, `Navbar*`, `Field*`, `Table*`, etc., and the paired `$modulesV2/*` modules import from there.

### What modules get

Ambient only — no shared UI library, no imports:

- **React** on `window.React` (UMD). Modules destructure hooks when they need them: `const { useState } = React`.
- **Tailwind** classes from whichever chrome is mounted (tokens come from the active chrome's `styles.css`). Modules use `className=` freely.
- **Rail icons** are named by a module's `meta.icon` (a string) and rendered by the **active chrome** — the shell ships none. (Catalyst maps the name to a Heroicon; another chrome may use a different set.)
- **`window.__atelier.subscribe(topic, handler)`** + **`window.__atelier.self(import.meta.url)`** — the shared WS multiplex. `self` returns your module's workspace-aware identity (`{ workspace, id, qid, topic, api, subscribe }`); prefer `self.subscribe(cb)` over a hardcoded topic. For cross-module work this plus backend `ctx.module(id)` slots and `@atelier/kit` is the surface; there is no frontend method-call registry.

That's it. A module is React + Tailwind + the browser, plus a thin WS subscribe primitive.

### Design source of truth

Tokens live in the active chrome's `styles.css`, which the chrome injects via `<link>` at load time — the shell defines none. Each chrome supplies its own; `catalyst-chrome/styles.css` and `gruvbox-chrome/styles.css` are the two in this repo to crib from.

## Configuration & discovery

### Selecting which modules are enabled — `atelier.config.json`

Optional, and the instance's source of truth. Without it, every discovered module runs with system defaults. With it, you set instance **settings** and **filter** which modules run. Drop it at the instance root (next to `atelier/`):

```json
{
  "label": "studio",
  "port": 1844,
  "chrome": "~/skins/catalyst-chrome",
  "hotReload": true,
  "auth": false,
  "modules": ["kanban", "polish", { "workspace": "bigcorp", "modules": ["!wip"] }]
}
```

#### Settings

All optional; resolved **defaults ← config ← environment** (env wins, so a PaaS can inject a dynamic port):

| Key | Default | Env | Meaning |
|---|---|---|---|
| `port` | `1844` | `PORT` | listen port |
| `baseUrl` | `http://localhost:<port>` | `BASE_URL` | external URL modules build links from |
| `chrome` | _(election)_ | `ATELIER_CHROME` | path/id of the chrome module; overrides alphabetical election among installed chromes |
| `hotReload` | `true` | `ATELIER_HOT_RELOAD` | file watchers + backend hot-swap; set `false` when deployed |
| `auth` | `false` | `ATELIER_AUTH` | path/id of the auth module, or `false` to run ungated (see [AUTH.md](./AUTH.md)) |
| `revalidateMs` | `30000` | `ATELIER_REVALIDATE_MS` | how often live WebSocket sockets re-run `authenticate` (only when `auth` is set) — so logout/permission changes propagate without a reconnect; see [AUTH.md](./AUTH.md) |
| `label` | `null` | `ATELIER_LABEL` | optional instance name a chrome may display |
| `modules` | _(all run)_ | — | the module filter below |

#### Module filter — top-level entries

Each entry in a list is one of:

| Entry | Meaning |
|---|---|
| `"foo"` | Include the global module `foo` (= `global/foo`) |
| `"!foo"` | Deny the global module `foo` |
| `"./path"`, `"~/path"`, `"/abs/path"` | Mount the directory as a global module. `id` defaults to `basename(path)` |
| `{ "path": "./dir" }` | Same. Allow `"id": "..."` to override the dir name |
| `{ "workspace": "bigcorp" }` | Include all of workspace `bigcorp` |
| `{ "workspace": "!bigcorp" }` | Deny all of `bigcorp` |
| `{ "workspace": "bigcorp", "modules": [...] }` | Include `bigcorp` with an internal filter (recursive — same rules as top level for its `modules:`) |

#### How the filter behaves

- **No config file (or no `modules` key)** — everything runs.
- **List has any allow markers** (bare name, path, `{workspace: "ws"}`, or `{workspace: "ws", modules: [...]}`) → **allow mode**: only explicitly listed things run. Workspaces not listed are excluded entirely.
- **List has any deny markers** (`"!foo"`, `{"workspace": "!ws"}`) → **deny mode**: everything runs *except* the listed denials. Workspaces not denied stay included.
- **Mixing allow + deny at the same level** → config error, filter falls back to "no filter applied at this level" (everything runs). A one-line warning logs at startup.
- **Empty list `[]`** → "filter to nothing" at this scope.
- **Paths are additive** — they always mount, regardless of allow/deny mode. They bypass the name filter.
- **Inside a workspace's `modules: [...]`** — same rules recurse. Bare names refer to that workspace's modules. Paths inside a workspace default to `<that-workspace>/<basename>`.

#### Examples

```json
{ "modules": ["kanban"] }
```
Only `global/kanban`. No workspaces.

```json
{ "modules": ["!archived"] }
```
All globals except `archived`. All workspaces, untouched.

```json
{ "modules": [{ "workspace": "bigcorp" }] }
```
Only `bigcorp`, all its modules. No globals, no other workspaces.

```json
{ "modules": ["kanban", { "workspace": "bigcorp", "modules": ["!wip"] }] }
```
`global/kanban` + all of `bigcorp` except `bigcorp/wip`.

```json
{ "modules": ["~/work/external-mod", "kanban"] }
```
`global/kanban` + the external folder mounted as `global/<basename>`. No workspaces.

```json
{ "modules": [{ "workspace": "bigcorp", "modules": [
  { "path": "~/work/notes", "id": "ideas" }
]}]}
```
Only `bigcorp`. Inside it, every discovered `bigcorp/<id>` plus an external folder mounted as `bigcorp/ideas`.

#### When the filter applies

The `modules` filter is re-read **per request**, so editing it is live: when `hotReload` is on, the file change triggers a reload; backends no longer in the list are unmounted on the next reconcile, and newly-listed ones mount on the next request. (Settings — `port`, `chrome`, `auth`, etc. — are read once at startup; changing them needs a restart.)

#### Bypass — standalone mode

`npm run dev:module -- <id>` (i.e. `node server.js <id>`) loads just that one module regardless of the filter. A bare id resolves to `global/<id>`; pass `<workspace>/<id>` for a workspace module.

Unknown ids in the config (typos, deleted modules) trigger a one-time warning in the log. Never fatal.

### Folders excluded from module discovery

`discoverModules` in [server.js](../server.js) walks the workspace root and treats any sibling directory with a `frontend.jsx` or `backend.js` as a module — except for the cases below.

- **First character is not `[a-zA-Z0-9]` or `$`.** Folders starting with `_`, `.`, `-`, space, etc. are skipped (`_agents/`, `_archive/`, `.git/`, etc.). Prefix a folder with `_` or `.` to keep it out of discovery without renaming. The `$` prefix is reserved — it marks workspaces; discovery recurses one level into a `$<name>/` folder rather than treating it as a module.
- **Reserved names** — apply both to module dirs and to workspace names (`$<reserved>/` is rejected the same way):
  - `atelier` — the shell itself.
  - `api` — `/api/<ws>/<id>/…` is every module's route namespace.
  - `assets` — `/assets/<name>.(js|css)` serves host static files.
  - `modules` — `/modules/<ws>/<id>/...` serves module bundles and assets.
  - `global` — the synthetic workspace name for root-folder modules; a `$global/` directory would collide.
- **No `frontend.jsx` and no `backend.js`.** Plain content directories (e.g. `research pack/`) aren't modules.
