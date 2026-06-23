# Workspaces

Atelier runs as **one shell hosting many isolated tenants**. Every module belongs to exactly one **workspace**, and that workspace is part of its identity — it shows up in every URL, API route, WebSocket topic, slot key, and data dir. `global` is the default; other workspaces are `$<name>/` folders.

For *who* may see each workspace and its modules (per-user access), see [AUTH.md](./AUTH.md). This page is the workspace **model** itself.

## The model

- The **`global` workspace** is synthetic — root-folder modules belong to it. There is no `$global/` directory on disk (the name is reserved). A clone with `kanban/` + `posts/` next to `atelier/` is the global workspace.
- A **`$<name>/` directory** at the instance root is a workspace; its sibling subdirectories are that workspace's modules. The same module conventions (see [Modules](./MODULES.md)) apply one level deeper.

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

Workspace modules are first-class at runtime. Since "deploying" is just "having the folder," a `$<ws>/` directory ships with the instance like anything else — there's no special workspace step.

## qualifiedId — one identity, everywhere

Every module's identity is its **qualifiedId** (`'<workspace>/<id>'`). That single string anchors every surface:

| Surface | Shape | Examples |
|---|---|---|
| SPA page URL | `/<ws>/<id>` | `/global/kanban`, `/bigcorp/posts` |
| API base | `/api/<ws>/<id>` | `/api/global/kanban`, `/api/bigcorp/posts` |
| Module bundle | `/modules/<ws>/<id>/frontend.js` | `/modules/global/kanban/frontend.js` |
| Module asset | `/modules/<ws>/<id>/<rest>` | `/modules/global/kanban/screenshots/board.png` |
| WebSocket topic | `<ws>/<id>` | `global/kanban`, `bigcorp/posts` |
| Slot key (`ctx.module`) | scoped to caller's workspace | `ctx.module('posts')` in `bigcorp/kanban` ≠ same in `global/kanban` |
| Data dir on disk | `<source>/data/` | `kanban/data/`, `$bigcorp/kanban/data/` |

A module never hardcodes its workspace. Backends register relative routes (the shell prefixes `/api/<ws>/<id>`); frontends derive theirs from `window.__atelier.self(import.meta.url)` (see [Modules → Real-time](./MODULES.md)). The **same bundle bytes** run unchanged whether mounted at `global/kanban` or `bigcorp/kanban`.

**The URL is the only source of truth** for "which workspace am I in" — no cookie, no Referer chain, no header precedence. The picker writes a new URL on switch (full reload, like a session change).

### Why a synthetic `global` instead of "workspace-less" root modules?

Symmetry. Every module has the same identity shape (`<ws>/<id>`), URL pattern, and WS topic format, so module source never branches on "am I in a workspace right now" — it just is in one, and reads its URL at runtime to know which. The cost is two characters per URL in the common case (`/global/kanban` vs `/kanban`) — paid once to keep the rest of the model uniform.

## Rail & picker

**Rail composition.** The left rail shows **only the current workspace's own modules**. `global` is a normal workspace, not a shared baseline — its modules appear in the rail only when you're in `global`, not in every other workspace. (Which modules a given *user* sees is the auth module's call — see [AUTH.md](./AUTH.md); the rail is drawn from `user.workspaces`.)

**The current workspace is derived from the URL — nothing is persisted.** It is whatever `<ws>` the address bar holds; there is no sticky per-tab choice and no `sessionStorage`. Navigating anywhere switches workspace because it switches the URL: clicking a module in the rail, picking a workspace, or opening a `/<ws>/<id>` URL all move you into that module's workspace — `global` included. A bare `/` lands on the **default workspace**: the first one that has modules, which is `global` whenever it has any (the server lists `global` first).

**The picker** (top of the LeftRail) lists every workspace the user can access that has at least one visible module — `global` included. Picking a workspace navigates to `/<new-ws>/<preserved-id>` (or `/<new-ws>/` if the current module doesn't exist there) via an in-page (SPA) transition — every workspace's bundles are already loaded client-side and the rail and active module both derive from the URL, so no full reload is needed and the WebSocket stays connected. It hard-reloads only when the preserved module was marked dirty by hot reload (mirrors a rail click).

## Naming rules

A workspace folder name (after the `$`) must match `^[a-zA-Z0-9][a-zA-Z0-9_-]*$` — e.g. `$workspace+lab/` is rejected (the `+` fails the regex), skipped with a one-line warning.

The names `atelier`, `api`, `assets`, `modules`, and `global` are **reserved** — `$<reserved>/` is skipped with a one-line warning. They, and the full set of special folder/file names, are documented in **[Modules → Folder & file conventions](./MODULES.md)**.

## Enabling / filtering workspaces

Which workspaces and modules an instance runs is set by the `modules` filter in `atelier.config.json` — `{ "workspace": "bigcorp" }`, `{ "workspace": "!bigcorp" }`, or `{ "workspace": "bigcorp", "modules": [...] }`. See [Atelier → Configuration](./README.md#configuration--discovery) for the full filter grammar.
