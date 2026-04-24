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

Boots the agent out, removes the plist, strips the `/etc/hosts` entry, deletes `~/.atelier/`.

## Status

```
npm run atelier -- status
```

Shows the install paths, the module list, and the LaunchAgent state.

## Dev

Iterate against the repo directly — no install needed.

```
npm run dev                   # port 5173, hot reload, discovers workspace siblings
npm run dev:module -- <name>  # standalone — only <name>
```

Dev (5173) and the installed agent (1844) can run side-by-side.

## Module convention

A sibling directory of `atelier/` is a module iff it contains `frontend.jsx` or `backend.js`. The directory name is the id and default display name.

**Minimal module** — one file:

```jsx
// hello/frontend.jsx
export default function Module() {
  return <div className="p-8">hello</div>;
}
```

**Optional metadata** — custom icon / name:

```jsx
export const meta = { icon: 'activity', name: 'Activity' };
export default function Module() { ... }
```

Icons are lucide names ([lucide.dev](https://lucide.dev/icons)). `meta` is optional; the rail falls back to `icon: 'square'` and `name: <dir>`.

**Optional backend** — `backend.js`:

```js
export default {
  mountRoutes(router, ctx) {
    router.get(`/api/${ctx.id}/hello`, (req, res) => res.json({ ok: true }));
  },
};
```

**Optional skills** — `<module>/skills/<skill-name>/SKILL.md`. A skill is a markdown file with YAML frontmatter. Two scopes:

| Frontmatter                | Behavior on `npm run atelier -- install <module>` |
|---------------------------|-----|
| `scope: global`           | Copied to `~/.claude/skills/<skill-name>/` so any Claude session on this machine can load it. Removed from there on `uninstall <module>`. |
| *(missing or anything else)* | Stays bundled with the module at `~/.atelier/<module>/skills/`. Useful for module-local tooling that only the app (or a backend agent) needs. |

Example:

```
kanban/
├── frontend.jsx
├── backend.js
└── skills/
    └── atelier-kanban/
        └── SKILL.md         ← frontmatter includes `scope: global`
```

## Hot reload

In dev, the server watches the workspace with `fs.watch` and pushes to the client via SSE (`/_atelier/hot`). Any change — new module folder, edited `.jsx`/`.css` — triggers a full page reload. Editing `server.js` or `atelier.js` still needs a manual restart.

The installed agent does the same over `~/.atelier/`, so `npm run atelier -- update` reloads the browser automatically.

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
