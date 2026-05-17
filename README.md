# Atelier

The app shell + module runner. Discovers sibling modules, mounts their backends, serves their frontends, renders the shared UI chrome (TopBar, LeftRail, AppShell).

> **Platform.** The install layer (LaunchAgent + `/etc/hosts` + `osascript`) is **macOS-only** today. Dev (`npm run dev`) is platform-agnostic and runs anywhere Node 18+ does. PRs adding Linux (systemd / `/etc/hosts`) and Windows (Task Scheduler) install paths are welcome.

## Install

One-time setup on a Mac. Clones this repo, builds into `~/.atelier/`, maps `atelier` to localhost, and wires an auto-starting launchd agent.

```
git clone git@github.com:pA1nD/atelier.git
cd atelier
npm install
npm run atelier -- install
```

Open **[http://atelier:1844/](http://atelier:1844/)**.

The `install` command rsyncs the runtime into `~/.atelier/atelier/`, copies every sibling module directory into `~/.atelier/`, runs `npm ci --omit=dev` inside the install, appends `127.0.0.1 atelier` to `/etc/hosts` (one sudo prompt), and bootstraps a user-scope LaunchAgent. Login starts it (`RunAtLoad`); crashes restart it (`KeepAlive`). Logs live at `/tmp/atelier.log`.

## Update

Pulls latest source and redeploys.

```
npm run atelier -- update              # pull + redeploy runtime + every installed module
npm run atelier -- update <name>       # redeploy one module only
```

Update runs `git pull --ff-only`, re-rsyncs the runtime, and refreshes whichever modules you listed (or all currently-installed ones if you list nothing). It finishes with `launchctl kickstart -k` so the agent picks up the new code immediately.

## Add or remove a module

```
npm run atelier -- install <name>      # deploy a sibling module
npm run atelier -- uninstall <name>    # remove it from ~/.atelier/
```

To narrow what ships by default — or to disable a noisy module in dev without renaming its directory — drop an [`atelier.config.json`](#selecting-which-modules-are-enabled--atelierconfigjson) at the workspace root.

## Uninstall everything

```
npm run atelier -- uninstall
```

Boots the agent out, removes the plist, strips the `/etc/hosts` entry, deletes `~/.atelier/`. **Destructive** — everything under `~/.atelier/` goes, runtime data included. Copy anything you care about aside first.

### Known limitation: workspace modules don't ship yet

The deploy CLI walks the root level only — `$<ws>/<mod>/` directories are skipped, so workspace modules aren't rsynced to `~/.atelier/`. The runtime supports them; the install/update CLI does not yet. As an interim, use a path-config entry inside the workspace block:

```json
{
  "modules": {
    "prod": [
      { "workspace": "bigcorp", "modules": [
        { "path": "./$bigcorp/kanban", "id": "kanban" }
      ]}
    ]
  }
}
```

Path-config entries are honored by the deploy CLI; they rsync to `~/.atelier/<id>/` (flat — workspace dir is not preserved in the install today). The runtime then re-mounts them under their workspace per the config. Roadmap item: native `$<ws>/` deploy.

## Runtime data stays on prod

`install` and `update` are rsync-based and carve out runtime state so deploys never clobber it. Two rules, both enforced by `DEPLOY_FILTERS` in [atelier.js](./atelier.js):

- **`<module>/data/`** — never shipped, never deleted. Backends write here via `ctx.dataDir` (passed into `mountRoutes`). The dev copy of `data/` isn't deployed; prod files survive every `install` / `update`.
- **`.claude/` at any depth** — include-first. Only definitional paths ship: `agents/`, `skills/`, `commands/`, `hooks/`, `CLAUDE.md`, `settings.json`. Everything else — `agent-memory/`, `projects/`, `todos/`, `plans/`, `shell-snapshots/`, `settings.local.json`, and any future Claude Code runtime dir — stays resident on prod. The include-first design means anything Claude adds in the future is protected by default.

"At any depth" is literal: the rule fires the same for `<module>/.claude/` at the module root and for `<module>/lib/foo/bar/.claude/` nested deep. `node_modules/` is excluded before descent, so a `.claude/` inside `node_modules/` is never considered.

Deletion semantics track the two rules:

- **Shipped paths → dev wins.** `--delete` removes prod-only files under `.claude/agents/`, `.claude/skills/`, etc. to match the dev tree.
- **Excluded paths → prod wins.** `data/`, `.claude/agent-memory/`, `.claude/projects/`, and friends are untouched even when dev has no counterpart.

`.env` files are treated as source and ship as-is (e.g. `_agents/<name>/.env` for per-agent secrets).

The same rules apply to `_agents/<name>/` dirs — they're shaped like modules and filtered identically.

**Per-module dependencies.** Most modules are one file and need nothing. A module that imports a third-party package (e.g. `abstract` → `pngjs`) declares it in its own `<module>/package.json` (and ideally `package-lock.json`). On `install` / `update`, after rsync'ing the module the deploy runs `npm ci --omit=dev` (or `npm install --omit=dev` if there's no lockfile) inside `~/.atelier/<module>/`, so its `node_modules/` exists at the install location. `node_modules/` is never rsynced — it's installed at the destination — which keeps deploys fast and avoids platform-specific binaries crossing machines. Resolution at runtime walks up from the module's own `backend.js` (the bundle preserves `import.meta.url`), so each module's deps stay scoped to that module.

**Contract for module authors:** write runtime state only via `ctx.dataDir`. Put hand-authored Claude Code skills / agents / commands / hooks under `<module>/.claude/...` (any depth) — they'll ship. Don't commit anything from `.claude/agent-memory/` or other runtime dirs; they're treated as prod state and filtered out of deploys anyway.

## Status

```
npm run atelier -- status
```

Shows the install paths, the module list, and the LaunchAgent state.

## Dev

Iterate against the repo directly — no install needed.

```
npm run dev                                # port 5172, hot reload, discovers workspace siblings
npm run dev:module -- <id>                 # standalone — only the global module <id>
npm run dev:module -- <workspace>/<id>     # standalone — workspace module
```

Dev (5172) and the installed agent (1844) can run side-by-side.

## Module convention

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

Supported keys: `icon` (lucide name — see [lucide.dev](https://lucide.dev/icons)), `name` (display name), `group` (rail section — modules with the same `group` render under a shared header; untagged modules live under the default "modules" section), `color` (reserved for future use). `meta` is optional; the rail falls back to `icon: 'square'` and `name: <dir>`.

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

`ctx` exposes: `id`, `name`, `workspace`, `qualifiedId` (`'<workspace>/<id>'`), `env`, `port`, `baseUrl`, `dataDir`, `log`, `broadcast`, `module`. URLs you return in response bodies — for clients to follow — should be built off the module's mount point (`/api/${ctx.qualifiedId}/...`), not hardcoded.

**Optional frontend self-reference** — every module's `frontend.jsx` derives its API base and WS topic from its own bundle URL. Paste this snippet near the top:

```js
// ROUTE = '<workspace>/<id>' — derived from this bundle's own URL.
const ROUTE = (() => {
  try {
    return new URL('.', import.meta.url).pathname
      .replace(/^\/modules\//, '').replace(/\/$/, '');
  } catch { return ''; }
})();
const API = '/api/' + ROUTE;     // '/api/global/kanban' or '/api/<ws>/kanban'
const TOPIC = ROUTE;             // 'global/kanban' or '<ws>/kanban'
```

Use `${API}/foo` everywhere you'd otherwise hardcode `'/api/<your-name>/foo'`, and `TOPIC` for `window.__atelier.subscribe(TOPIC, …)`. Same bundle bytes work whether the module is mounted globally or in a workspace — the browser sets `import.meta.url` to the URL it fetched the bundle from. For cross-module calls, derive the workspace once (`const WS = ROUTE.split('/')[0]`) and reach peers as `/api/${WS}/<peer>/...`.

**Optional skills** — `<module>/.claude/skills/<skill-name>/SKILL.md`. This is the same path Claude Code natively loads when the module directory is the workspace, so for dev just `cd <module> && claude` and the skill is live — no install step, no symlink. A skill is a markdown file with YAML frontmatter.

The shell doesn't read or interpret any of this — it just rsyncs `<module>/.claude/skills/` to `~/.atelier/<module>/.claude/skills/` alongside the rest of the module's definitional content on `install` / `update`. Skill discovery, scope (`scope: global`), Mission Control session aggregation, and the optional host install into `~/.claude/skills/` are all module-space concerns:

- **Mission Control** merges every module's `scope: global` skills into every MC-spawned session. See `mission-control/`.
- **`skills/`** module — manage host install: copies into `~/.claude/skills/<name>/` and rewrites `$ATELIER_URL` to this atelier's literal base URL so the host copy is self-contained.

Inside `SKILL.md`, the canonical pattern for reaching atelier is `$ATELIER_URL` (set by MC inside containers; rewritten to a literal URL on host install). The path component inside scripts now needs the workspace: `${ATELIER_URL}/api/<workspace>/<module>/...`. For module-internal scripts spawned by Mission Control, the workspace prefix is injected per-session — see [AUTH.md](./AUTH.md).

## Workspaces

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

The left rail in a workspace shows that workspace's modules **plus** the global modules — so a workspace tab still has the rail-level affordances global modules provide (mission-control, activity, etc.). When a workspace module shares its id with a global one, the workspace version wins. From inside `global`, the rail shows just global's modules.

**The picker** (top of LeftRail) lists every non-`global` workspace the user has access to. With zero `$-workspaces`, the picker hides entirely. Picking a workspace navigates to `/<new-ws>/<preserved-id>` (or `/<new-ws>/` if the current module doesn't exist there) — full page reload so caches, bundles, and the WS reconnect cleanly.

**Reserved names** (rejected as both module dir names and workspace names — `$<reserved>/` is silently skipped with a warning):

- `atelier` — the shell itself
- `api` — `/api/<ws>/<id>/...` is the module route namespace
- `assets` — `/assets/<name>.(js|css)` serves shell static files
- `modules` — `/modules/<ws>/<id>/...` serves module bundles + assets
- `global` — the synthetic workspace name for root-folder modules

Workspace folder names (after the `$`) must match `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`. A `$workspace+lab/` is rejected (the `+` fails the regex).

For the auth and access-control story (auth module slot, `req.user`, takeover, `defaultUser`), see [AUTH.md](./AUTH.md).

## Hot reload

In dev, the server watches the workspace with `fs.watch` and pushes to the client over the shared WebSocket (`/_atelier/ws`, topic `'shell'`). Any change — new module folder, edited `.jsx`/`.css` — triggers a full page reload. Editing `server.js` or `atelier.js` still needs a manual restart.

The installed agent does the same over `~/.atelier/`, so `npm run atelier -- update` reloads the browser automatically.

## Real-time transport — `/_atelier/ws`

Atelier exposes one shared WebSocket per browser tab at `/_atelier/ws`. Every real-time event in the workspace flows through it, multiplexed by **topic**. Topics are qualified ids:

- `'shell'` — shell events (hot reload, etc.). The client always subscribes.
- `'<workspace>/<id>'` — events from one module mount. Same-named modules in different workspaces have distinct topics; they can't cross-talk.

The server stamps `topic` on every emitted frame and broadcasts to all connected clients. The client-side subscriber map decides what each frame actually delivers.

**Why one WebSocket and not per-module SSE.** Browsers cap HTTP/1.1 to 6 concurrent connections per origin. Each SSE eats one slot, so once you had hot-reload + N module SSEs + multiple tabs, page navigations stalled intermittently. WebSocket per-origin limits are an order of magnitude higher (Chrome ~255 globally), so a single multiplexed WS per tab is effectively unbounded for localhost dev. The same pattern is used by Vite, Next.js, and Webpack dev-server.

**Wire format.** Each frame is JSON: `{ topic, ...event }`. The shell stamps `topic` on the way out; the client filters on the way in.

### Server side — `ctx.broadcast(event)`

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

The shell tags every emitted event with the module's `qualifiedId` as `topic` — modules can only emit under their own identity. There is no global `broadcast`; misnaming someone else's topic isn't possible.

### Client side — `window.__atelier.subscribe(topic, handler)`

Frontends subscribe to topics they care about. The canonical pattern uses `TOPIC` derived from the bundle URL:

```js
const unsub = window.__atelier.subscribe(TOPIC, (frame) => {
  if (frame.type === 'run-finished') refresh();
});
// when no longer interested
unsub();
```

The shell owns the WebSocket. Multiple subscribers — across modules, across components — share the same connection. Auto-reconnect with exponential backoff is built in, so dev-server restarts recover transparently.

For initial state on page mount (a new subscriber doesn't see what already happened before they connected), modules expose a normal HTTP snapshot endpoint and call it once. Mission Control's `/state` is a worked example.

### Per-module backend hot-swap (dev only)

Editing any file under `<module>/` (not just `backend.js`) re-imports *just that module's* backend — the atelier process keeps running, other modules are untouched. Used when several agents iterate on different modules in parallel; one agent's typo can't crash the others.

The shell:
- Runs a **chokidar** watcher on the whole module directory (dev only — prod under launchd stays untouched). Watching the dir (not the file) survives atomic saves that change inode, and catches edits to transitive imports (`parser.js`, `lib/*.js`, etc.) — not just `backend.js`. Ignores `node_modules/`, `data/`, dotfiles, and path segments starting with `_`; uses `awaitWriteFinish` so a mid-write read can't hit a half-flushed file.
- On change, **bundles** the module with esbuild (`packages: 'external'`, first-party transitive imports baked in, `import.meta.url` preserved for each module's own `fileURLToPath(import.meta.url)`) and imports the bundle via a base64 `data:` URL. Each bundle has unique bytes → a unique URL → Node's import cache naturally serves the new version; old versions drop out when nothing references them.
- If the import throws, keeps the old version running and logs `reload failed, keeping current version — <message>`.
- If it imports cleanly, strips the old module's routes, calls its teardown (if any), and mounts the new version. Log line: `↻ reloaded <qualifiedId> backend`.
- macOS `fs.watch` can fire ~2 events per save; the debounced callback dedupes by `mtimeMs` so a duplicate OS event is dropped while two genuine edits still trigger two reloads.

**Routes are stripped automatically.** The shell tracks exactly which routes each module added (via a scoped router) and removes them on swap.

**Closure state resets automatically.** A re-bundled import is a fresh module graph with its own closure, so module-level variables (e.g. kanban's in-memory cache, agents' `children` Map, a subscribers Set) re-initialize. No module code needed.

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

For a worked example see [../agents/backend.js](../agents/backend.js) — it kills supervised children and closes the `_agents/` watcher on teardown.

## Cross-module config — `ctx.module(id)`

For when one module has a small piece of context that another module wants — without HTTP between them, without import coupling, without inventing module-private files.

`ctx.module(id)` returns a **plain object** keyed by `(caller's workspace, target id)`. Every caller within the same workspace that asks for the same id gets the same object. Owners read from it lazily; consumers write directly. The shell stays neutral about meaning — it provides the registry, modules agree on the shape.

```js
// consumer (mc-lab/backend.js): tell mission-control where to point agents
ctx.module('mission-control').apiProxy = {
  urlTemplate: 'http://host.docker.internal:5181/_at_{sessionId}',
};

// owner (mission-control/backend.js): read at use time
const ap = ctx.module('mission-control').apiProxy;
if (ap?.urlTemplate) {
  const baseUrl = ap.urlTemplate.replace('{sessionId}', sess.id);
  // …inject as ANTHROPIC_BASE_URL on docker exec
}

// consumer clears
delete ctx.module('mission-control').apiProxy;
```

**Read at use time, not at mount time.** Modules mount in alphabetical order (`mc-lab` before `mission-control`) and async `mountRoutes` runs concurrently, so any cross-module read at mount time is racy. Reading on demand makes order irrelevant: whoever wrote last is what the owner sees the next time it looks.

**Slot survives hot-reload of either side.** The registry lives on `globalThis.__atelierModuleSlots` — a single Map keyed by `'<callerWorkspace>/<targetId>'` that's created once per `npm run dev` lifetime. A module reload swaps that module's `mountRoutes`, but the slot keeps its contents.

**Workspace is a tenancy boundary.** A `global` module and a `$alpha` module can't leak state through a shared slot — `ctx.module('mission-control')` inside `global/kanban` and inside `$alpha/kanban` resolve to different slots. A workspace-aware infrastructure module that genuinely wants to look across workspaces uses persisted records (with a workspace column) instead of the slot primitive.

**No methods, no validation, no events.** The slot is plain data. Validation belongs to whoever reads — log a warning and ignore garbage. If you find yourself wanting subscribe/notify, push for it on the shell rather than reinventing it module-side.

**Conventions when using a slot:**
- Owners document the keys they accept in their own source — there's no central registry.
- Use the owner's id as the slot key (`ctx.module('mission-control')` is for MC, not for the consumer that's writing).
- Treat the slot as a contract surface: don't write keys you don't own without coordinating, and don't read keys whose owner hasn't documented them.

For a worked example see [../mission-control/backend.js](../mission-control/backend.js) (reads `apiProxy` to optionally route agent traffic) and [../mc-lab/backend.js](../mc-lab/backend.js) (writes it when its capture proxy is up).

## Module conventions

A few rules so modules compose cleanly with the shell and with each other:

**1. Don't register process-level signal handlers.** The shell owns `SIGINT` / `SIGTERM` / `'exit'` — see `teardownAllBackends` in [server.js](./server.js). It calls every mounted module's teardown before exit. Modules that register their own handlers can preempt the shell via `process.exit()` and skip other modules' cleanups, leaving children orphaned. If your module spawns children, kill them in your teardown — that path runs on both hot-swap *and* process exit.

**2. Spawned children must be tracked and torn down.** Anything from `child_process.spawn` / `fork` / `execFile` needs a `.kill('SIGTERM')` in the teardown. The shell-side teardown handler is the only thing that prevents children from getting reparented to launchd on Ctrl+C. Audit your module: every `spawn(...)` should have a matching kill in the returned function.

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

**5. Don't edit `atelier/server.js` / `atelier/client.jsx` / `atelier/atelier.js` from inside a module task.** The shell is cross-cutting; changes there are their own task with their own authorization. If your module needs something the shell doesn't provide, name the gap and ask.

## What lives here

- `server.js` — runner, router, discovery, WebSocket multiplex (`/_atelier/ws`), hot-reload broadcaster, auth slot, chrome-slot resolution
- `atelier.js` — build pipeline (esbuild JSX + Tailwind v4 + oxide), module-config parsing, install CLI
- `index.html` — template; React + ReactDOM + Lucide from CDN. A single inline `<style>` sets the body background to prevent a flash before the chrome's stylesheet loads. Otherwise the shell paints zero pixels.
- `client.jsx` — slim router + bundle loader + error fallback. Loads the chrome bundle (`chromeQid` resolved server-side) and renders it as the root. Wires the WS multiplex and the `callModule` registry.
- `builtin-chrome/` — the default skin. A real module folder with `frontend.jsx` (rail + topbar + banner + layout + lucide observer) and `styles.css` (webfonts + Tailwind `@theme` tokens + base styles). Copy this folder to write a custom chrome.

## Chrome slot

The shell ships zero visual bytes. Everything you see — rail, topbar, fonts, colors, picker, banner — lives in a `chrome`-slot module. The first global-workspace module whose `meta.chrome === true` wins; otherwise the builtin (`global/atelier-chrome`) takes the slot.

To swap the skin: copy `atelier/builtin-chrome/` somewhere, edit, register via `atelier.config.json`:

```json
{ "modules": [{ "path": "~/my-skin", "id": "my-skin" }] }
```

Your chrome's `frontend.jsx` must export a `chrome` function and `meta = { chrome: true, hidden: true }`. The shell calls `chrome(props)` and renders the result as the root. See [`builtin-chrome/frontend.jsx`](builtin-chrome/frontend.jsx) for the full props contract.

## What modules get

Ambient only — no shared UI library, no imports:

- **React** on `window.React` (UMD). Modules destructure hooks when they need them: `const { useState } = React`.
- **Tailwind** classes from whichever chrome is mounted (default tokens in `builtin-chrome/styles.css`). Modules use `className=` freely.
- **Lucide icons** via the DOM convention `<i data-lucide="kanban-square" className="w-3.5 h-3.5" />`. The chrome's MutationObserver turns them into SVGs.
- **`window.__atelier.subscribe(topic, handler)`** — shared WS multiplex.
- **`window.__atelier.registerModule(id, api)` / `callModule(id, method, ...)`** — opt-in cross-module method registry. Module that wants to expose a callable API does `registerModule`; callers do `callModule`. Missing target = warn-and-no-op (no crash).

That's it. A module is React + Tailwind + the browser, plus a thin WS subscribe primitive.

## Design source of truth

Tokens live in [`builtin-chrome/styles.css`](builtin-chrome/styles.css) — the default chrome's stylesheet, which the chrome bundle injects via `<link>` at load time. A custom chrome supplies its own `styles.css` with whatever tokens it wants. Reusable primitives that aren't yet imported by any module sit in [`../kit/`](../kit/) as a living gallery — look at each one and decide whether to promote, copy into a module, or cull.

## Selecting which modules are enabled — `atelier.config.json`

Optional. Without this file every discovered module is enabled in dev, and every sibling ships to prod. With it, you can filter what runs per environment, mount external folders as modules, or scope a filter to one workspace.

Drop the file at the workspace root (next to `atelier/`):

```json
{
  "modules": {
    "dev":  ["kanban", "polish", { "workspace": "bigcorp" }],
    "prod": ["kanban", "agents", { "workspace": "bigcorp", "modules": ["!wip"] }]
  }
}
```

### Top-level entries

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

### How the filter behaves

- **No config file (or no `modules` key)** — everything runs.
- **List has any allow markers** (bare name, path, `{workspace: "ws"}`, or `{workspace: "ws", modules: [...]}`) → **allow mode**: only explicitly listed things run. Workspaces not listed are excluded entirely.
- **List has any deny markers** (`"!foo"`, `{"workspace": "!ws"}`) → **deny mode**: everything runs *except* the listed denials. Workspaces not denied stay included.
- **Mixing allow + deny at the same level** → config error, filter falls back to "no filter applied at this level" (everything runs). A one-line warning logs in dev and during deploy.
- **Empty list `[]`** → "filter to nothing" at this scope.
- **Paths are additive** — they always mount, regardless of allow/deny mode. They bypass the name filter.
- **Inside a workspace's `modules: [...]`** — same rules recurse. Bare names refer to that workspace's modules. Paths inside a workspace default to `<that-workspace>/<basename>`.

### Examples

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

### Where the filter applies

- **Dev runtime** (`npm run dev`) — read on every request. Editing the file triggers an HMR reload; backends not in the list are unmounted on the next reconcile, new ones mount on the next request.
- **Deploy CLI** (`npm run atelier -- install` / `update`) — when no module args are passed, the filtered set is rsynced to `~/.atelier/`. The config itself ships, so the prod runtime applies the same filter at request time. **Modules previously installed but no longer in the prod set are removed in the same step** — their `~/.atelier/<name>/` directory is deleted. Host-installed skills under `~/.claude/skills/` are managed by the `skills` module and are not touched by the deploy CLI. Net effect: the install becomes exactly what the config asks for, in one command.

### Bypasses — explicit intent always wins

- Standalone mode: `npm run dev:module -- <id>` and `node atelier/server.js <id>` load just that module regardless of config. A bare id resolves to `global/<id>`; pass `<workspace>/<id>` for workspace-scoped.
- Explicit CLI args: `npm run atelier -- install <name>` / `update <name>` deploys exactly those modules, ignores the prod filter, and never reconciles — modules outside `<name>` are left untouched.

Unknown ids in the config (typos, deleted modules) trigger a one-time warning in the runtime log and during the deploy step. Never fatal.

## Folders excluded from module discovery

`discoverModules` in [server.js](./server.js) walks the workspace root and treats any sibling directory with a `frontend.jsx` or `backend.js` as a module — except for the cases below.

- **First character is not `[a-zA-Z0-9]` or `$`.** Folders starting with `_`, `.`, `-`, space, etc. are skipped (`_agents/`, `_archive/`, `.git/`, etc.). Prefix a folder with `_` or `.` to keep it out of discovery without renaming. The `$` prefix is reserved — it marks workspaces; discovery recurses one level into a `$<name>/` folder rather than treating it as a module.
- **Reserved names** — apply both to module dirs and to workspace names (`$<reserved>/` is rejected the same way):
  - `atelier` — the shell itself.
  - `api` — `/api/<ws>/<id>/…` is every module's route namespace.
  - `assets` — `/assets/<name>.(js|css)` serves host static files.
  - `modules` — `/modules/<ws>/<id>/...` serves module bundles and assets.
  - `global` — the synthetic workspace name for root-folder modules; a `$global/` directory would collide.
- **No `frontend.jsx` and no `backend.js`.** Plain content directories (e.g. `research pack/`) aren't modules.
