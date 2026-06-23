# Modules

A module is the unit of feature in atelier — a folder with a `frontend.jsx` and/or a `backend.js`. The shell discovers it, mounts its backend, serves its frontend, and gives it a thin, stable contract: an HTTP route namespace, a real-time channel, a slot for cross-module state, and (from the active chrome) UI primitives. Everything else is just React, Tailwind, and the browser.

This page covers building an ordinary module, then the two **special modules** — the **chrome** (which owns the visuals) and the **auth** module (covered in [AUTH.md](./AUTH.md)).

## Folder & file conventions

The shell discovers modules by walking the instance root (and one level into each `$<ws>/`). A handful of names and prefixes are special — this is the complete set:

| Name / prefix | Meaning |
|---|---|
| `frontend.jsx` / `backend.js` | A directory containing **either** is a **module** (its dir name is the id). A folder with neither is ignored. |
| `$<name>/` | A **workspace** (see [Workspaces](./WORKSPACES.md)) — discovery recurses one level in; its subdirectories are that workspace's modules. |
| `_` · `.` · `-` · space prefix | **Excluded** from discovery (`_archive/`, `.git/`, …). Prefix a folder with `_` or `.` to keep it out without renaming. |
| `atelier` · `api` · `assets` · `modules` · `global` | **Reserved** — rejected as both a module dir name and a workspace name: the shell itself (`atelier`) + its URL namespaces (`/api`, `/assets`, `/modules`) + the synthetic `global` workspace. |
| `data/` | Per-module **runtime state** (`<module>/data/`) — never served to clients, ignored by the hot-reload watcher, never touched by the shell. |
| `node_modules/` | A module's own **dependencies** — resolved at runtime, never served, ignored by the watcher. |
| `package.json` | A module's deps manifest (optional — only if it imports npm packages). |
| `.claude/` | The module's **definitional content** (skills, commands, hooks) — travels with the folder; the shell doesn't read it. |
| `kit.js` / `kit.jsx` | **Chrome only** — a chrome publishing `@atelier/kit` (see [the chrome](#special-module-the-chrome)). |
| `styles.css` | **Chrome only** — the chrome's design tokens, injected via `<link>` (the shell ships none). |

A module id (and a workspace name, after the `$`) must match `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`; anything else is skipped with a one-line warning.

## Module convention

A module is just code — its directory name is the id and default display name. (Modules inside a `$<ws>/` workspace work the same, one level deeper — see [Workspaces](./WORKSPACES.md).)

**Minimal module** — one file:

```jsx
// hello/frontend.jsx
export default function Module() {
  return <div className="p-8">hello</div>;
}
```

**Optional metadata** — `export const meta`:

```jsx
export const meta = { icon: 'activity', name: 'Activity', group: 'marketing' };
export default function Module() { ... }
```

Supported keys:
- `icon` — a rail-icon *name* (a string) the **active chrome** renders; the shell ships no icons. Don't `import` an icon library in a module — module frontends are transformed per-file, not bundled, so only `react` / `react-dom` / `@atelier/kit` resolve; just name the icon and let the chrome draw it. The catalyst chrome renders any [lucide](https://lucide.dev/icons) name (e.g. `chef-hat`, `layout-dashboard`, `shield-check`); an unknown name falls back to a square.
- `name` — display name (rail label).
- `group` — rail section: modules with the same `group` render under a shared header; untagged modules live under the default "modules" section.
- `primary` — boolean; the module the shell lands on at `/` for its workspace.
- `hidden` — boolean; keep the module out of the rail and `defaultUser` (chromes set this on themselves).
- `chrome` — boolean; marks a global-workspace module as the chrome (see [Special module: the chrome](#special-module-the-chrome)).
- `color` — reserved for future use.

`meta` is optional; the rail falls back to `icon: 'square'` and `name: <dir>`. It's parsed server-side at discovery time (esbuild-transform `frontend.jsx` → import via `data:` URL) and shipped in the HTML bootstrap, so grouping renders correctly on first paint — no flicker.

### Backend — `backend.js`

Routes are scoped: the shell mounts them at `/api/<workspace>/<id>`, so handlers register *relative* paths.

```js
export default {
  mountRoutes(router, ctx) {
    // Mounts at /api/global/hello/say (or /api/<ws>/hello/say in a workspace).
    router.get('/say', (req, res) => res.json({ ok: true }));
  },
};
```

`ctx` exposes exactly: `id`, `name`, `workspace`, `qualifiedId` (`'<workspace>/<id>'`), `label`, `port`, `baseUrl`, `dataDir`, `log`, `broadcast`, `module` — and nothing else (no CORS or auth helpers; a module that needs CORS sets its own response headers). URLs you return in response bodies — for clients to follow — should be built off the module's mount point (`/api/${ctx.qualifiedId}/...`), never hardcoded.

The router gives handlers `req.params`, `req.query`, `req.json()` (memoized, async; rejects with a `413` past a 10 MB body cap), `req.user` (see [AUTH.md](./AUTH.md)), and `res.json(data, status?)`.

### Frontend self-reference (workspace-aware, never hardcoded)

A module's `frontend.jsx` must derive its API base and WS topic from where it's actually mounted, so the same bundle works in any workspace (`global` is just the default). Use the shell helper — pass it this bundle's `import.meta.url`:

```js
const self = window.__atelier.self(import.meta.url);
// self.workspace 'global' | '<ws>'   self.id 'kanban'   self.qid '<ws>/kanban'
// self.api  '/api/<ws>/kanban'        self.topic '<ws>/kanban' (the WS topic)

self.subscribe((frame) => { … });        // listens on self.topic — workspace-aware
const unsub = self.subscribe(handler);    // returns an unsubscribe fn
fetch(self.api + '/items');               // hits /api/<ws>/kanban/items
```

This mirrors how backend routes are workspace-scoped: just as `router.get('/items')` becomes `/api/<ws>/<id>/items` without naming the workspace, `self.subscribe(...)` listens on `<ws>/<id>` without hardcoding it. **Never write a literal topic or `/api/<name>/...` path** — the workspace can change (the same module under a different `$<ws>/`), and a hardcoded topic would silently miss its own frames. For cross-module calls, reach peers under the same workspace: `/api/${self.workspace}/<peer>/...`.

### Dependencies

Most modules are one file and need nothing. A module that imports a third-party package declares it in its own `<module>/package.json`; run `npm install` inside that module's directory and its `node_modules/` resolves locally (the bundle preserves `import.meta.url`, so resolution walks up from the module's own `backend.js`). The shell never installs module deps for you.

### Runtime state

Backends write persistent state under `ctx.dataDir` (`<module>/data/`). It's per-instance and the shell never touches it — back it up however your platform backs up a folder. Keep `<module>/.claude/` definitional content (skills, commands, hooks) in source; treat `.claude/`'s runtime dirs (`agent-memory/`, `projects/`, …) as local state.

### Skills

`<module>/.claude/skills/<skill-name>/SKILL.md` — the same path Claude Code natively loads when the module directory is the workspace, so for dev just `cd <module> && claude` and the skill is live (no install, no symlink). The shell doesn't read or interpret any of this — `<module>/.claude/` is just part of the module folder and travels with it. How skills get aggregated or installed is a module-space concern, not the shell's.

## Real-time — `/_atelier/ws`

Atelier exposes **one shared WebSocket per browser tab** at `/_atelier/ws`, multiplexed by **topic**. Topics are qualified ids:

- `'<workspace>/<id>'` — events from one module mount. Same-named modules in different workspaces have distinct topics; they can't cross-talk.
- `'shell'` — shell events (hot reload, etc.); the client always subscribes.

Each frame is JSON `{ topic, ...event }`. The shell stamps `topic` on the way out; the client filters on the way in.

> **Why one WebSocket and not per-module SSE.** Browsers cap HTTP/1.1 to 6 connections per origin; each SSE eats one, so hot-reload + N module SSEs + multiple tabs stalled navigations. A single multiplexed WS per tab is effectively unbounded (Chrome ~255). Same pattern as Vite/Next/Webpack dev-server.

### Server side — `ctx.broadcast(event)`

```js
router.post('/run', async (req, res) => {
  const id = doSomething();
  ctx.broadcast({ type: 'run-started', id });
  ctx.broadcast({ type: 'run-finished', id, ok: true });
  res.json({ ok: true, id });
});
```

The shell **always** stamps the emitted event's `topic` with the module's `qualifiedId` (workspace-aware) — `ctx.broadcast` takes only the payload; a module **cannot** choose or override the topic, so it can only emit under its own identity. (If a module passes a `topic`, it's ignored and the shell logs a dev warning — don't hardcode it.) There is no global `broadcast`.

### Client side — `self.subscribe(handler)`

```js
const self = window.__atelier.self(import.meta.url);
const unsub = self.subscribe((frame) => {        // listens on '<ws>/<id>'
  if (frame.type === 'run-finished') refresh();
});
unsub();   // when no longer interested
```

`self.subscribe(handler)` is `window.__atelier.subscribe(self.topic, handler)` — use the low-level `window.__atelier.subscribe(topic, handler)` directly only to listen on another known topic (e.g. `'shell'`). The shell owns the socket; subscribers across modules and components share it, with auto-reconnect + backoff so dev restarts recover transparently. For initial state on mount (a new subscriber doesn't see prior events), expose an HTTP snapshot endpoint (e.g. `/state`) and call it once, then keep in sync via the subscription.

## Hot reload (dev)

When `hotReload` is on (the default), editing a **`.js`** file under `<module>/` (its `backend.js` or any first-party `.js` it imports) re-imports *just that module's* backend — the atelier process keeps running, other modules untouched (one agent's typo can't crash the others). The shell:

- Runs a native recursive `fs.watch` on the module directory. Watching the dir (not the file) survives atomic saves that change inode, and catches edits to transitive imports (`parser.js`, `lib/*.js`) — not just `backend.js`. Ignores `node_modules/`, `data/`, dotfiles, `_`-prefixed segments; a 150 ms debounce + newest-`.js`-mtime dedupe coalesce duplicate OS events.
- **Bundles** the module with esbuild (`packages: 'external'`, first-party transitive imports baked in, `import.meta.url` preserved) and imports via a base64 `data:` URL. Unique bytes → unique URL → Node's import cache serves the new version.
- If the import throws, keeps the old version and logs `reload failed, keeping current version`. If it imports cleanly, strips the old routes, calls teardown, mounts the new version (`↻ reloaded <qualifiedId> backend`).

Editing the **shell** itself (`server.js`, `build.js`, `discovery.js`, `client.jsx`) still needs a manual restart. Set `hotReload: false` (or `ATELIER_HOT_RELOAD=0`) to disable all watchers + backend hot-swap in a deployed instance.

**Closure state resets automatically** — a re-bundled import is a fresh module graph, so module-level variables (an in-memory cache, a child-process `Map`, a subscribers Set) re-initialize. **Side effects need a teardown** — anything registered *outside* the closure (`fs.watch`, `setInterval`, `spawn`ed children, long-lived sockets) survives a re-import, so return a cleanup function from `mountRoutes`:

```js
export default {
  mountRoutes(router, ctx) {
    const watcher = fs.watch(...);
    const timer  = setInterval(...);
    const child  = spawn(...);
    router.get('/things', ...);
    // Runs before this module is swapped out, AND on process exit.
    return () => { watcher.close(); clearInterval(timer); child.kill('SIGTERM'); };
  },
};
```

Rule of thumb: spawns a process, opens a file/socket, or holds a long-lived connection → return a teardown. Pure request handlers on closure state → none needed. (Real-time WS clients are managed by the shell; modules don't clean those up.)

## Cross-module state — `ctx.module(id)`

For when one module has a small piece of context another wants — without HTTP, import coupling, or module-private files. `ctx.module(id)` returns a **plain object** keyed by `(caller's workspace, target id)`; every caller in the same workspace asking for the same id gets the same object.

```js
// Most common — stash your OWN long-lived state so it survives hot-reload
// (module-scope vars reset on re-import; a slot persists):
const slot = ctx.module(ctx.id);
slot.watcher ??= fs.watch(/* … */);     // set up once, not on every reload

// Cross-module — a consumer writes the owner's slot; the owner reads it lazily:
ctx.module('search').indexRoot = '/data/corpus';   // from some other module
const root = ctx.module(ctx.id).indexRoot;          // inside the 'search' module
```

- **Read at use time, not mount time.** Modules mount in arbitrary order, so cross-module reads at mount are racy; read on demand and order is irrelevant.
- **Survives hot-reload of either side** — the registry lives on `globalThis.__atelierModuleSlots`, a Map created once per process; a reload swaps `mountRoutes` but the slot keeps its contents (why it's the right home for a watcher / child handle / cache).
- **Workspace is a tenancy boundary** — `ctx.module('search')` in `global/kanban` and in `$alpha/kanban` resolve to different slots; cross-workspace sharing uses persisted records, not the slot.
- **No methods, no validation, no events** — plain data; validation belongs to whoever reads. Owners document the keys they accept in their own source; address a target by its id (`ctx.module('search')`), your own via `ctx.module(ctx.id)`.

## Module conventions

A few rules so modules compose cleanly with the shell and each other:

1. **Don't register process-level signal handlers.** The shell owns `SIGINT`/`SIGTERM`/`'exit'` and calls every module's teardown before exit. A module's own handler can preempt it via `process.exit()` and skip others' cleanups, orphaning children. Kill children in your teardown — that path runs on both hot-swap *and* process exit.
2. **Spawned children must be tracked and torn down** — every `spawn`/`fork`/`execFile` needs a `.kill('SIGTERM')` in the teardown, or it gets reparented to init on Ctrl+C.
3. **Set a "shutting down" flag if your child has restart logic.** SIGTERM is async; a child's `exit` handler fires after teardown returns. Guard respawns:
   ```js
   let shuttingDown = false;
   proc.on('exit', () => { if (shuttingDown) return; setTimeout(restart, backoff); });
   return () => { shuttingDown = true; proc.kill('SIGTERM'); };
   ```
4. **Use `ctx.qualifiedId` (or `self`) for absolute URLs the client follows** — never a literal `/api/<your-name>/...`, which only works under `global`.
5. **Don't edit the shell** (`atelier/server.js` / `client.jsx` / `build.js` / `discovery.js`) from a module task. The shell is cross-cutting; changes there are their own task with their own authorization. If your module needs something the shell doesn't provide, name the gap and ask.

## What a module gets (ambient)

No shared UI library to import, no build config:

- **React** on `window.React` (UMD) — `const { useState } = React`.
- **Tailwind** classes from whichever chrome is mounted (tokens from the active chrome's `styles.css`); use `className=` freely.
- **Rail icon** named by `meta.icon`, rendered by the active chrome (the shell ships none).
- **`window.__atelier.self(import.meta.url)`** → `{ workspace, id, qid, topic, api, subscribe }`, and **`window.__atelier.subscribe(topic, handler)`** — the WS multiplex. Plus backend `ctx.module(id)` slots and `@atelier/kit`. There is no frontend method-call registry.
- **`window.__atelier.useRoute()`** → `{ path, navigate }` — the module's own URL sub-route (everything after `/<ws>/<id>`). See [Frontend routing](#frontend-routing).

That's it. A module is React + Tailwind + the browser, plus thin WS + routing primitives.

---

## Frontend routing

The shell owns exactly two path segments — `/<workspace>/<id>` — and **everything after them is the module's own space**. A module reads and drives that subpath with one hook:

```jsx
const { path, navigate } = window.__atelier.useRoute();
//  path                       → subpath after /<ws>/<id>, no leading slash
//                               '' at the module root; e.g. on /vault/drive/a/b → 'a/b'
//  navigate('a/b')            → pushState  /vault/drive/a/b
//  navigate('a/b', {replace:true})
//  navigate('')               → back to the module root /vault/drive
```

Back/forward, deep-links, and your own `navigate()` calls **all re-render the module with the new `path`** — there are no `history.*` calls, no `hashchange` listeners, and no event-suppression to get right. The URL is the single source of truth; mirror it into render and you're done:

```jsx
export default function Module() {
  const { path, navigate } = window.__atelier.useRoute();
  if (!path) return <Index onOpen={(id) => navigate(`item/${id}`)} />;
  const [, id] = path.split('/');               // 'item/<id>'
  return <Detail id={id} onClose={() => navigate('')} />;
}
```

What you can rely on:

- **`path` is free-form.** The shell never parses or validates it — `a/b/c`, `item/42`, `settings`, whatever your module means. Slash-separated is just a convention you choose.
- **Deep-links and refresh work.** Loading `/<ws>/<id>/a/b` directly serves the SPA and your module mounts with `path === 'a/b'`.
- **No remount on sub-nav.** A subpath change re-renders the module in place (same `ws`+`id` → stable identity), so component state, effects, and **WebSocket subscriptions survive** — `self.subscribe`'s topic is your qid, never the route. Switching module or workspace (a different `ws`/`id`) remounts as usual and resets the subpath.
- **The shell owns `/<ws>/<id>`.** A module routes *within* its own subtree; it can't claim a top-level path or another module's space. To send the user to a different module, that's a chrome affordance (the rail / `navigate(qid)` the chrome receives), not `useRoute`.

`useRoute` is opt-in: a module that keeps its sub-view state in memory and never touches the URL is perfectly fine. `location.hash` and `?query` still work too — but `useRoute` is the supported way to get deep-linkable, back/forward-correct sub-views.

---

## Sidecar servers

Some modules need a **second HTTP server on their own port** — a public surface the shell's request lane can't serve. The shipped `sites` module is the reference: it runs a dedicated `http.createServer` on `SITES_DOCS_PORT` (default `7322`) to serve published pages at `/p/<id>/…` — arbitrary path depth, its own auth, public visitors — none of which fits the shell's scoped, no-wildcard `/api/<ws>/<id>` router.

Reach for a sidecar when you need one of:

- **URL shapes the module router won't match** — wildcards, deep/arbitrary paths, a bare `/`. The shell router is exact-prefix under `/api/<ws>/<id>`, no wildcards.
- **A surface outside the shell's auth** — something an unauthenticated visitor or another service hits directly, with the module enforcing its own scheme.
- **Its own CORS, content types, or protocol**, independent of the shell.

If you only need module API routes, use the `mountRoutes` router — not a sidecar.

### The shell's role is small

A sidecar is **plain Node `http`** — there's no "sidecar API." What the shell gives you, via `ctx` / env:

- **`ctx.baseUrl`** (and `process.env.BASE_URL`) — the instance's external URL, so the sidecar and anything it spawns build correct links.
- **`ctx.log(msg)`** — log through the shell.
- **`ctx.broadcast(event)`** — push onto the module's own WS topic from inside the sidecar.
- **Teardown on shutdown** — the shell fires every module's teardown on `SIGINT` / `SIGTERM` / exit, so your sidecar (and any child process) is closed, not orphaned.

The shell does **not** allocate the port, proxy to it, gate it, or expose it. Those are yours (and the operator's).

### Lifecycle — start in `mountRoutes`, close in teardown

A sidecar is a long-lived listener, so it lives by the [hot-reload teardown contract](#hot-reload-dev): `mountRoutes` re-runs on every reload, so you **must** close the old server or the next reload hits `EADDRINUSE`.

```js
import http from 'node:http'
const PORT = Number(process.env.MYMOD_PORT || 7400)

export default {
  async mountRoutes(router, ctx) {
    // ... your /api routes on `router` ...

    const server = http.createServer((req, res) => { /* raw URL routing */ })
    server.on('error', (e) => {                       // never crash the shell
      if (e.code === 'EADDRINUSE') ctx.log(`mymod · port ${PORT} in use — sidecar not started`)
    })
    server.listen(PORT, '127.0.0.1', () => ctx.log(`mymod · sidecar on http://127.0.0.1:${PORT}`))

    return () => { try { server.close() } catch {} }   // ← closes on reload AND on shutdown
  },
}
```

### Exposure & auth — you own both

A sidecar sits **outside** the shell's three pillars (frontend rail / HTTP presence / WS ACL — see [Auth](./AUTH.md)). `authenticate` and `authorize` never run for it. So:

- **Bind to `127.0.0.1`**, not `0.0.0.0`. Let the **operator's reverse proxy / tunnel** (nginx, cloudflared, …) map a public hostname to the port — the shell doesn't proxy to it. (`sites` is fronted by a cloudflared tunnel → `DOCS_PORT`.)
- **Enforce your own auth** on anything non-public. The shell can't help — a sidecar that needs to know who's calling must carry its own scheme (`sites` uses signed per-document tokens: `/d/<id>/<token>/<user>/…`). Treat it like any service you put on the internet.
- **Pick the port from a module-specific env var** with a sensible default (`MYMOD_PORT`), and document it. Avoiding collisions across the shell port and other sidecars is the operator's job.

### Patterns from the shipped modules — examples, not rules

Atelier has no opinion past the points above. The rest is just how the shipped modules *happen* to solve recurring sidecar problems — borrow or ignore freely; none of it is part of the contract.

- **For a *public* sidecar, consider a separate child process (a suggestion, for security).** A sidecar can run in-process — `sites`' docs server is a plain `http.createServer` in the module's own process — or as a spawned child — `dashboard` runs its MCP server via `spawn` (tracked + torn down per the [hot-reload rules](#hot-reload-dev)). For a surface facing the open internet we lean toward the **child-process** shape: a crash or compromise on the public listener can't reach the shell's process, other modules' in-memory state, or their file handles. The cost is IPC (a port, or files as the channel) instead of shared closure state — weigh isolation vs. simplicity per surface.

- **Telling whether the public hostname really lands on *this* instance (one author's technique).** When a tunnel/proxy can point a hostname at more than one machine — e.g. while migrating between hosts — a `200` from the public URL does **not** prove *your* sidecar answered it; another machine's tunnel can serve the same name. One way the author's modules handle this: each public sidecar stamps a **per-process random nonce** on every response (an `x-atelier-origin` header), and a status probe fetches the public URL *and* `127.0.0.1:<port>` and compares — equal ⇒ this instance is the live origin, different/absent ⇒ it's served elsewhere. This is illustrative only (it's how the cloudflared-tunnel status across `devops` / `sites` / `dashboard` is kept honest) — **not** an atelier feature, header, or requirement. It's an ordinary thing you can do on top of a plain `http` sidecar; pick your own header, or a different approach entirely.

---

## Special module: the chrome

The shell ships **zero visual bytes** — no rail, topbar, fonts, colors, favicon, or icon set. All of it lives in a **chrome**: a global-workspace module that exports `meta = { chrome: true, hidden: true }` and a `chrome(props)` function the shell renders as the root. The chrome named by `atelier.config.json`'s `chrome` setting wins; otherwise the first global module with `meta.chrome === true` (alphabetical by qualifiedId). **There is no default chrome** — with none installed the client renders a plain "add a chrome" screen.

Two ship in the repo to copy: `catalyst-chrome/` (Tailwind/Catalyst, publishes `@atelier/kit`) and `gruvbox-chrome/`. To make your own, copy one, edit, and point your config at it:

```json
{ "chrome": "~/my-skin", "modules": ["~/my-skin"] }
```

See [`gruvbox-chrome/frontend.jsx`](../../gruvbox-chrome/frontend.jsx) for the full `chrome(props)` props contract (`boot, user, modules, workspaces, workspace, activeQid, active, loadedModules, navigate, pickWorkspace`).

### A chrome can bring real dependencies

The shell detects chrome modules at request time and routes their `frontend.jsx` through full esbuild **bundling** (`react`/`react-dom`/`react/jsx-runtime` aliased to `atelier/shims/*` so the chrome shares the shell's React instance). So a chrome can ship its own `node_modules/` and use bare specifiers:

```jsx
// my-chrome/frontend.jsx
import * as Headless from '@headlessui/react'
import { ChevronDownIcon } from '@heroicons/react/16/solid'
import clsx from 'clsx'

export const meta = { chrome: true, hidden: true }
export function chrome({ modules, active, navigate, ... }) { return <div>{/* … */}</div> }
```

Drop a `package.json`, `npm install`, and the shell bundles it. Size is uncapped (catalyst's bundle is ~3 MB with Headless UI + heroicons; cached after first build). The chrome injects its own icon set and `styles.css` (`<link>` at load) — the shell defines no tokens.

### Publishing primitives — `@atelier/kit`

A chrome can ship a `kit.js` (or `kit.jsx`) beside its `frontend.jsx`. When the shell sees it, it injects an import map per request:

```html
<script type="importmap">{"imports": {"@atelier/kit": "/modules/<chromeQid>/kit.js"}}</script>
```

Companion modules then write plain ESM imports — `import { Button, Dialog, Input, Field } from '@atelier/kit'` — and the browser resolves them to the active chrome's bundled kit. No bundling on the module side, no runtime registry, no `window.__atelier.kit` global — the kit is a real ES module file you can Cmd-click into.

A chrome's `kit.js` is a barrel re-export; **what to publish is chrome-defined**, and there's no enforced contract. A module importing `Foo` from `@atelier/kit` is implicitly paired with whichever chrome exports a compatible `Foo` — swap chromes and modules either get re-themed (same names, compatible props) or break. **Themes are not drop-in by design**: co-design a chrome with its companion modules. (`catalyst-chrome/kit.js` barrels Catalyst's `Button`, `Dialog`, `Sidebar*`, `Field*`, `Table*`, etc.)

## Special module: auth

The other special module is the one named in the `auth` setting — it gates every request, owns identity/sessions, and produces the `user` object (which drives the rail, the API/WS access boundary, and login). It's the single trusted layer between the shell and the modules. See **[AUTH.md](./AUTH.md)** for the full contract (`authenticate` / `authorize` / `handleUnauth`, the `user` shape, and the three pillars of enforcement).
