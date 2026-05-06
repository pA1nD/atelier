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
npm run dev                   # port 5172, hot reload, discovers workspace siblings
npm run dev:module -- <name>  # standalone — only <name>
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

**Optional backend** — `backend.js`:

```js
export default {
  mountRoutes(router, ctx) {
    router.get(`/api/${ctx.id}/hello`, (req, res) => res.json({ ok: true }));
  },
};
```

**Optional skills** — `<module>/.claude/skills/<skill-name>/SKILL.md`. This is the same path Claude Code natively loads when the module directory is the workspace, so for dev just `cd <module> && claude` and the skill is live — no install step, no symlink. A skill is a markdown file with YAML frontmatter. Two scopes:

| Frontmatter                | Behavior on `npm run atelier -- install <module>` |
|---------------------------|-----|
| `scope: global`           | Also copied to `~/.claude/skills/<skill-name>/` so any Claude session on this machine can load it. Removed from there on `uninstall <module>`. |
| *(missing or anything else)* | Stays bundled with the module at `~/.atelier/<module>/.claude/skills/`. Available when someone opens Claude Code inside that module directory; not visible to other sessions. |

Example:

```
kanban/
├── frontend.jsx
├── backend.js
├── README.md               ← documents the dev recipe below
└── .claude/
    └── skills/
        └── atelier-kanban/
            └── SKILL.md    ← frontmatter includes `scope: global`
```

**Skills route via `$ATELIER_URL`.** The canonical pattern inside a `SKILL.md` is:

```bash
URL=${ATELIER_URL:-http://atelier:1844}
```

Prod is the default. During dev, the module's README should show how to opt into a dev server — usually `cd <module>; ATELIER_URL=http://localhost:5172 claude "…"`.

## Hot reload

In dev, the server watches the workspace with `fs.watch` and pushes to the client over the shared WebSocket (`/_atelier/ws`, topic `'shell'`). Any change — new module folder, edited `.jsx`/`.css` — triggers a full page reload. Editing `server.js` or `atelier.js` still needs a manual restart.

The installed agent does the same over `~/.atelier/`, so `npm run atelier -- update` reloads the browser automatically.

## Real-time transport — `/_atelier/ws`

Atelier exposes one shared WebSocket per browser tab at `/_atelier/ws`. Every real-time event in the workspace flows through it, multiplexed by **topic**. The shell uses topic `'shell'` for its own events (hot reload, etc.); each module gets a topic equal to its id.

**Why one WebSocket and not per-module SSE.** Browsers cap HTTP/1.1 to 6 concurrent connections per origin. Each SSE eats one slot, so once you had hot-reload + N module SSEs + multiple tabs, page navigations stalled intermittently. WebSocket per-origin limits are an order of magnitude higher (Chrome ~255 globally), so a single multiplexed WS per tab is effectively unbounded for localhost dev. The same pattern is used by Vite, Next.js, and Webpack dev-server.

**Wire format.** Each frame is JSON: `{ topic, ...event }`. The shell stamps `topic` on the way out; the client filters on the way in.

### Server side — `ctx.broadcast(event)`

Modules emit real-time events via the per-mount `ctx`:

```js
export default {
  mountRoutes(router, ctx) {
    router.post('/api/mine/run', async (req, res) => {
      const id = doSomething();
      ctx.broadcast({ type: 'run-started', id });   // → topic 'mine'
      // …
      ctx.broadcast({ type: 'run-finished', id, ok: true });
      res.json({ ok: true, id });
    });
  },
};
```

The shell tags every emitted event with the module's id as `topic` — modules can only emit under their own name. There is no global `broadcast`; misnaming someone else's topic isn't possible.

### Client side — `window.__atelier.subscribe(topic, handler)`

Frontends subscribe to topics they care about:

```js
const unsub = window.__atelier.subscribe('mine', (frame) => {
  if (frame.type === 'run-finished') refresh();
});
// when no longer interested
unsub();
```

The shell owns the WebSocket. Multiple subscribers — across modules, across components — share the same connection. Auto-reconnect with exponential backoff is built in, so dev-server restarts recover transparently.

For initial state on page mount (a new subscriber doesn't see what already happened before they connected), modules expose a normal HTTP snapshot endpoint and call it once. Mission Control's `/api/mission-control/state` is a worked example.

### Per-module backend hot-swap (dev only)

Editing any file under `<module>/` (not just `backend.js`) re-imports *just that module's* backend — the atelier process keeps running, other modules are untouched. Used when several agents iterate on different modules in parallel; one agent's typo can't crash the others.

The shell:
- Runs a **chokidar** watcher on the whole module directory (dev only — prod under launchd stays untouched). Watching the dir (not the file) survives atomic saves that change inode, and catches edits to transitive imports (`parser.js`, `lib/*.js`, etc.) — not just `backend.js`. Ignores `node_modules/`, `data/`, and dotfiles; uses `awaitWriteFinish` so a mid-write read can't hit a half-flushed file.
- On change, **bundles** the module with esbuild (`packages: 'external'`, first-party transitive imports baked in, `import.meta.url` preserved for each module's own `fileURLToPath(import.meta.url)`) and imports the bundle via a base64 `data:` URL. Each bundle has unique bytes → a unique URL → Node's import cache naturally serves the new version; old versions drop out when nothing references them.
- If the import throws, keeps the old version running and logs `reload failed, keeping current version — <message>`.
- If it imports cleanly, strips the old module's routes, calls its teardown (if any), and mounts the new version. Log line: `↻ reloaded <module> backend`.
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

    router.get('/api/mine', ...);

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

`ctx.module(id)` returns a **plain object** keyed by module id. Every caller that asks for the same id gets the same object. Owners read from it lazily; consumers write directly. The shell stays neutral about meaning — it provides the registry, modules agree on the shape.

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

**Slot survives hot-reload of either side.** The registry lives on `globalThis.__atelierModuleSlots` — a single Map that's created once per `npm run dev` lifetime. A module reload swaps that module's `mountRoutes`, but the slot keeps its contents.

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

**4. Don't edit `atelier/server.js` / `atelier/client.jsx` / `atelier/atelier.js` from inside a module task.** The shell is cross-cutting; changes there are their own task with their own authorization. If your module needs something the shell doesn't provide, name the gap and ask.

## What lives here

- `server.js` — runner, router, discovery, WebSocket multiplex (`/_atelier/ws`), hot-reload broadcaster
- `atelier.js` — build pipeline (esbuild JSX + Tailwind v4 + oxide) **and** the install CLI
- `index.html` — template; React + ReactDOM + Lucide from CDN
- `styles.css` — webfonts + Tailwind v4 `@theme` tokens + base styles
- `client.jsx` — host shell (TopBar, LeftRail, AppShell) + app bootstrap. A RAF-debounced `MutationObserver` calls `lucide.createIcons()` when modules render `<i data-lucide="…">` tags, so modules never touch lucide themselves.

## What modules get

Ambient only — no shared UI library, no imports:

- **React** on `window.React` (UMD). Modules destructure hooks when they need them: `const { useState } = React`.
- **Tailwind** classes from `styles.css`. Modules use `className=` freely.
- **Lucide icons** via the DOM convention `<i data-lucide="kanban-square" className="w-3.5 h-3.5" />`. The shell's MutationObserver turns them into SVGs.

That's it. A module is React + Tailwind + the browser.

## Design source of truth

Tokens live in [`styles.css`](styles.css). Reusable primitives that aren't yet imported by any module sit in [`../kit/`](../kit/) as a living gallery — look at each one and decide whether to promote, copy into a module, or cull.

## Selecting which modules are enabled — `atelier.config.json`

Optional. Without this file every module in the workspace is enabled in dev and every sibling ships to prod — the default behavior. With it, you whitelist a subset per environment.

Drop the file at the workspace root (next to `atelier/`):

```json
{
  "modules": {
    "dev":  ["mission-control", "kanban", "polish"],
    "prod": ["mission-control", "kanban", "agents"]
  }
}
```

Accepted shapes:

| Shape | Meaning |
|---|---|
| `{ "modules": ["a", "b"] }` | Same allowlist for dev and prod. |
| `{ "modules": { "dev": ["a"], "prod": ["b"] } }` | Each env filtered independently. |
| `{ "modules": { "prod": ["a"] } }` | Dev = all (missing key ⇒ no filter). Prod = filtered. |
| `{ "modules": { "dev": ["a"] } }` | Dev = filtered. Prod = all. |
| Missing file or invalid JSON | All modules enabled. |

**Where the filter applies:**

- **Dev runtime** (`npm run dev`) — the runner reads the config on every request and filters discovered modules by the `dev` list. Editing the file triggers the existing workspace fs.watch and the browser reloads with the new set; backends not in the list are unmounted, new ones mount on the next request.
- **Deploy CLI** (`npm run atelier -- install` / `update`) — when no module args are passed, `discoverSiblings` is filtered by the `prod` list before rsync, so only those modules land in `~/.atelier/`. The config itself ships alongside `.env`, so the installed prod runtime applies the same filter at request time. **Modules previously installed but no longer in the `prod` list are removed in the same step** — their `~/.atelier/<name>/` directory is deleted and any global skills they shipped are stripped from `~/.claude/skills/`. Net effect: the install becomes exactly what the config asks for, in one command.

**Bypasses — explicit user intent always wins:**

- Standalone mode: `npm run dev:module -- <name>` and `node atelier/server.js <name>` load just `<name>` regardless of config (so a module excluded for this env can still be inspected).
- Explicit CLI args: `npm run atelier -- install <name>` / `update <name>` deploys exactly those modules, ignores the prod list, and never reconciles — modules outside `<name>` are left untouched.

Unknown ids in the config (typos, deleted modules) trigger a one-time warning in the runtime log and during the deploy step. Never fatal.

## Folders excluded from module discovery

`discoverModules` in [server.js](./server.js) walks the workspace root and treats any sibling directory with a `frontend.jsx` or `backend.js` as a module — except for the cases below.

- **First character is not `[a-zA-Z0-9]`.** Folders starting with `_`, `.`, `-`, space, etc. are skipped (`_agents/`, `_archive/`, `.git/`, etc.). Prefix a folder with `_` or `.` to keep it out of discovery without renaming.
- **Reserved names** (the `SKIP` set):
  - `atelier` — the shell itself.
  - `api` — every module registers under `/api/<module-id>/…`; a module by this name would make endpoint URLs ambiguous.
  - `assets` — `/assets/<name>.(js|css)` serves host static files; a module here would be silently shadowed.
  - `modules` — `/modules/<id>/frontend.js` serves module bundles; same shadowing risk.
- **No `frontend.jsx` and no `backend.js`.** Plain content directories (e.g. `research pack/`) aren't modules.
