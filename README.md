# Atelier

The app shell + module runner. Discovers sibling modules, mounts their backends, serves their frontends, renders the shared UI chrome (TopBar, LeftRail, AppShell).

## Install

One-time setup on any Mac. Clones this repo, builds into `~/.atelier/`, maps `atelier` to localhost, and wires an auto-starting launchd agent.

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

`.env` files are treated as source and ship as-is (e.g. `_agents/<name>/.env` for telegram-paired agents).

The same rules apply to `_agents/<name>/` dirs — they're shaped like modules and filtered identically.

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

In dev, the server watches the workspace with `fs.watch` and pushes to the client via SSE (`/_atelier/hot`). Any change — new module folder, edited `.jsx`/`.css` — triggers a full page reload. Editing `server.js` or `atelier.js` still needs a manual restart.

The installed agent does the same over `~/.atelier/`, so `npm run atelier -- update` reloads the browser automatically.

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

**Side effects need a teardown.** Anything a module registers *outside* its own closure — `fs.watch` handles, `setInterval` / `setTimeout`, `process.on` listeners, `child_process.spawn`ed children, SSE response objects held by subscribers — survives a re-import. The module must opt into cleaning them up by returning a function from `mountRoutes`:

```js
export default {
  mountRoutes(router, ctx) {
    const watcher = fs.watch(...);
    const timer  = setInterval(...);
    process.on('SIGTERM', handle);

    router.get('/api/mine', ...);

    // Optional. Called by the shell before this module is swapped out.
    return () => {
      watcher.close();
      clearInterval(timer);
      process.removeListener('SIGTERM', handle);
    };
  },
};
```

Rule of thumb: if your module spawns processes, opens files/sockets, or holds long-lived connections, return a teardown. If it's pure request handlers on closure state, no teardown is needed.

For a worked example see [../agents/backend.js](../agents/backend.js) — it kills supervised children, closes the `_agents/` watcher, ends SSE subscribers, and removes its SIGTERM listeners on teardown.

## What lives here

- `server.js` — runner, router, discovery, hot-reload broadcaster
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

Tokens and primitives were ported from `_design/project/`. The design bundle stays in the repo for reference when porting additional screens.
