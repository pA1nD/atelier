# Authentication and Workspaces

Atelier is single-user by default. Authentication is opt-in: drop in a module that exports `authenticate`, the shell starts gating requests; remove it, the shell stops. The auth module owns all policy — identity, session, workspace membership, per-document ACLs, the login and denied UI. The shell only does dispatch.

## Workspaces

A workspace is a folder at the workspace root prefixed with `$`. Inside it, the same module conventions as root: a directory with `frontend.jsx` or `backend.js` is a module.

```
atelier/                    ← shell
auth/                       ← global module (no $ prefix)
  backend.js
  frontend.jsx
kanban/                     ← global module
  frontend.jsx
$bigcorp/                   ← workspace
  kanban/
    frontend.jsx
  posts/
    frontend.jsx
$othercorp/                 ← workspace
  kanban/
    frontend.jsx
```

Discovery walks the root the same way it does today, with one extra step: any directory whose name starts with `$` is recursed one level deeper for modules. Modules inside a workspace inherit every existing rule — `meta`, `.claude/`, `data/`, per-module `package.json`, deploy filters.

On disk: `$bigcorp/`. On the wire: `/w/bigcorp/...` and `/api/w/bigcorp/...`. The `$` is the discovery marker; the URL drops it and prefixes `/w/` to disambiguate workspaces from global modules sharing the same name.

| Class | On disk | URL | Visibility |
|---|---|---|---|
| Global | `<name>/` at root | `/<name>` | Any authenticated user (subject to auth module) |
| Workspace | `$<ws>/<name>/` | `/w/<ws>/<name>` | Members of `<ws>` (subject to auth module) |

The auth module is global by definition — it must be reachable before workspace selection happens.

### Naming conventions — slash everywhere except URLs

Outside of URL paths (which keep `/w/` to disambiguate), workspaces and modules use `<workspace>/<module>` slash form anywhere a qualified identifier is needed:

| Surface | Global module | Workspace module |
|---|---|---|
| URL path | `/kanban`, `/api/kanban/...` | `/w/bigcorp/kanban`, `/api/w/bigcorp/kanban/...` |
| WebSocket topic | `kanban` | `bigcorp/kanban` |
| Slot registry key (`ctx.module(id)`) | `kanban` | `bigcorp/kanban` |
| `dev:module` argument | `kanban` | `bigcorp/kanban` |

The slash itself disambiguates — global module names cannot contain slashes, so any slashed id is workspace-qualified. URLs are the one exception because a workspace-prefixed URL would collide with a global module of the same name.

## Workspace as a runtime context

A workspace is a *context* the user is in, not a place they navigate to. Two state slots together describe the runtime:

- **URL** — names the active module. `/<id>` for global modules; `/w/<ws>/<id>` for workspace-scoped modules. Workspace appears in the URL only when the module itself lives in a workspace; otherwise the URL stays clean.
- **Sticky context** — the workspace the user is currently "in". Stored in `localStorage` under `atelier:workspace` (string id, or `'global'` for none). Survives reloads.

The two are not redundant: a user in workspace `Penguin` can navigate to a global module like `/activity` without leaving Penguin. The picker still says "Penguin"; reloading `/activity` restores it; clicking a workspace-scoped module (e.g. `kanban` if `$Penguin/kanban` exists) moves the URL into `/w/Penguin/kanban`.

### Active module resolution

Given URL id `<id>` and effective workspace `<ws>`:

1. If `<ws>` is set and a workspace-scoped module exists at `<ws>/<id>` → use it.
2. Otherwise, if a global module exists at `<id>` → use it.
3. Otherwise the URL is invalid — replace with the workspace landing (`/w/<ws>` or `/`).

This is what makes `/w/Penguin/abstract` work for a global `abstract` module: there's no `$Penguin/abstract`, so resolution falls through to the global one. The user stays in Penguin context; the global abstract is what loads.

### Effective workspace

```
explicit URL (/w/<ws>/...)  →  use that workspace, also persist as sticky.
clean URL (/<id>, /)        →  use whatever localStorage holds.
```

Picking a workspace from the picker is the only action that changes the sticky context. Clicking a rail item never changes context — it only changes the active module.

### Rail composition — workspace shadows global

Inside workspace `<ws>`, the rail merges the workspace's modules with the global modules into a single list. When a workspace module shares its `id` with a global one (e.g. both `$Penguin/kanban/` and `kanban/` exist), the **workspace module shadows the global**: the global one is hidden, the workspace one is shown in its `meta.group`. One entry, no duplicate. The user picks "global" from the picker to see the global version.

### Workspace switching

The picker is the single affordance for switching. When the user picks `<ws>`:

- Sticky context becomes `<ws>` (or `null` for "global").
- Active module is preserved if possible:
  - If the new context has a workspace-scoped version of the active id → URL becomes `/w/<ws>/<id>`.
  - Else if a global version exists → URL stays at `/<id>` (no workspace prefix).
  - Else if there's no active module → URL becomes `/w/<ws>` (workspace landing) or `/`.

The picker is rendered iff `user.workspaces` is non-empty OR a workspace is currently sticky. With zero workspaces installed and no sticky context, the chrome looks identical to single-tenant atelier.

## The auth module slot

The shell scans discovered modules at startup. The **first** module whose `backend.js` default export includes an `authenticate` function claims the auth slot. Subsequent ones are logged once and ignored — same precedence rule as everywhere else.

Discovery order is alphabetical. If you want a specific auth module to win, use `atelier.config.json` to limit which modules mount in that environment.

If no module claims the slot, **the shell does not gate anything**. Every request gets `ctx.user = defaultUser` (synthesized from discovery, full access). This is the dev default.

## The contract

The auth module exports four things:

```js
// auth/backend.js
export default {
  // Per-request gate. Called for every request — page or API.
  // Free-form: sees full URL, headers, body. May refuse based on session,
  // URL pattern, role, individual document — anything.
  // Returns the user object the shell uses for this request, or null.
  async authenticate(req, defaultUser) { ... },

  // Owns the entire response when authenticate returned null.
  // Sets status (401/403/redirect/...), body, takeover render — whatever.
  // The shell hands off completely; no further processing happens.
  async handleUnauth(req, res, ctx) { ... },

  // Authed-only routes (e.g. /api/auth/logout, account settings, admin UI).
  // Reachable only when authenticate returned a user. Same contract as any
  // other module's mountRoutes.
  mountRoutes(router, ctx) { ... },
};
```

```jsx
// auth/frontend.jsx
// Renders inside the normal Atelier shell when a user is signed in.
// Typically account settings, admin UI for managing membership, etc.
export default function Module() { ... }
```

The takeover view (login form, denied page, OAuth redirect target, MFA challenge) is whatever response `handleUnauth` produces. The auth module is responsible for serving its own bundle if it wants a React-rendered takeover. The shell does not provide helpers for this — same `index.html` template, different injected bootstrap, served by the auth module itself.

## The `user` object

The shape the shell injects into every page bootstrap and sets as `ctx.user` on every request:

```js
{
  id,                // required; uniquely identifies this user
  name?,             // display name
  avatar?,           // url
  workspaces?,       // [{ id, name?, modules: [{ id, meta }] }]
  modules?,          // [{ id, meta }]   global modules visible to this user
  // anything else the auth module wants modules or chrome to consume
}
```

Everything except `id` is optional. The chrome reads `user.modules` and `user.workspaces` to populate the LeftRail. Modules read whatever fields they care about.

**The shape is identical in no-auth and auth mode.** Only the content differs: in no-auth, the shell synthesizes the user; in auth, the auth module produces it. Module code never branches on "is auth installed."

### `defaultUser`

The shell builds `defaultUser` from raw discovery on every request and passes it to `authenticate`:

```js
defaultUser = {
  id: 'local',
  name: 'local',
  modules: <every global module discovered>,
  workspaces: <every $workspace, with all its discovered modules>,
}
```

The auth module can:

- Return it unchanged — user sees everything (escape hatch / debug).
- Filter it — user sees a subset.
- Replace it — user sees what the auth module synthesized from its own data store.
- Return null — unauth handoff.

When no auth module is installed, the shell uses `defaultUser` as-is. This is how `npm run dev` keeps working with zero configuration.

## Per-request flow

1. Build `defaultUser` from current discovery.
2. If no auth module installed → `ctx.user = defaultUser` → route normally.
3. Otherwise: `result = await authModule.authenticate(req, defaultUser)`.
   - `result === null` → `authModule.handleUnauth(req, res, ctx)`. Shell is done; the auth module owns the response.
   - `result` is a user object → `ctx.user = result` → route normally.

For page requests (`serveIndex`), the user object is also injected into the bootstrap as `window.__ATELIER__.user`. The client renders the rail, topbar, and active workspace from that object — no fetch, no API call. This matches today's pattern: a single server-side string replace produces the rail.

For API requests, `ctx.user` is set on the request context the module receives.

## WebSocket gating

The shared shell WebSocket at `/_atelier/ws` goes through the **same `authenticate` slot** as HTTP. An upgrade is just an HTTP request with a `Connection: Upgrade` header — cookies are present in `req.headers`, the auth module reads them the same way it does for any other request, and returns a user or null.

Per upgrade:

1. Path-check `/_atelier/ws`; anything else is dropped.
2. `await mountPendingBackends()` so a freshly-installed auth module claims the slot before its first upgrade.
3. `result = await authModule.authenticate(req, defaultUser)` — same call as HTTP.
4. `null` → write `HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n` and destroy the socket. `handleUnauth` does **not** run: the WS handshake has nowhere to render an HTML takeover or a JSON body. The browser surfaces "WS connection failed" to JS; the client's reconnect loop retries after the user signs in (the post-login cookie is sent on the next attempt).
5. user → `wss.handleUpgrade(...)`; the connection is admitted with `ws.user = result` attached for downstream use (per-frame ACL filtering, server-side disconnects, etc.).

No new auth-module contract surface. The same `authenticate` function gates both surfaces; auth modules that already work over HTTP gate the WS for free.

### Limitation: WS connections survive session invalidation

`authenticate` runs at the upgrade only — once a socket is admitted, it stays admitted for its lifetime. If the auth module deletes a session (logout, admin revoke, expiry), the matching WS connection keeps receiving frames until the client closes it.

In practice this is usually not visible:

- **User-initiated logout** — the auth module's frontend typically navigates the page right after `POST /logout`, which closes the WS naturally. The window where the stale WS receives frames is a few ms of data the same logged-in user already had access to.
- **Server-initiated invalidation** — the next HTTP request from the affected client gets `401` (HTTP path runs `authenticate` per request), so any user action after revocation hits the takeover. Idle WS connections continue to stream until the user does anything.

The shell does not provide a `disconnectClients` helper today. If a future auth module needs to force-tear connections (admin force-logout, hard expiry) the shape is straightforward to add — it's the symmetric peer to `ctx.broadcast`, only the shell can do it because the shell owns the connected-clients set, and `ws.user` is already attached. Add it when there's a use case; not before.

## Takeover render

When `authenticate` returns null and `handleUnauth` runs, the auth module decides everything:

- HTTP status — `401` for "no session," `403` for "logged in but denied," anything else with a reason.
- Response body — JSON for API requests (detect via `Accept` header or path prefix), HTML for page requests.
- For HTML: read `atelier/index.html` and inject a takeover bootstrap:

```js
window.__ATELIER__ = {
  takeover: {
    state: 'unauth' | 'denied',   // or whatever taxonomy the auth module uses
    attemptedUrl: req.url,
    user: <if logged in but denied>,
    reason: <optional>,
  },
  moduleBundle: '/modules/auth/frontend.js',
};
```

The shell's `client.jsx` checks for `boot.takeover` and, if present, mounts the auth module's bundle full-screen with no chrome. The auth module reads `window.__ATELIER__.takeover` and renders accordingly.

There is no `LoggedOut` named export, no `Takeover` prop convention. The auth module's frontend is a normal module frontend that branches on what the bootstrap injected. One bundle, two bootstrap shapes, one branch in `client.jsx`.

## Disabling auth in dev

Use the existing `atelier.config.json` mechanism — no new flag, no environment variable:

```json
{
  "modules": {
    "dev":  ["kanban", "posts"],
    "prod": ["auth", "kanban", "posts"]
  }
}
```

Auth not in the dev list → no auth module mounted → shell uses `defaultUser` → full access.

## Module portability — the same source works global or workspace

A module copy-pasted into a workspace folder (`$bigcorp/kanban/` next to the global `kanban/`) needs to address its own API, its own WS topic, and its own data dir correctly without shell-side rewriting of bundle bytes or special identifiers in the source. The contract is split between the shell and the module:

**Shell (transparent):**

- Backend route auto-prefix. Routes registered as `/api/${ctx.id}/...` mount at `/api/<id>/...` for global modules, `/api/w/<ws>/<id>/...` for workspace modules. Module source is identical.
- WS topic auto-scope. `ctx.broadcast(...)` emits with topic `<id>` (global) or `<ws>/<id>` (workspace). Module source is identical.
- `ctx.dataDir` is the module's own folder regardless of where it lives on disk — `kanban/data/` or `$bigcorp/kanban/data/`. Module source is identical.
- Slot registry keyed by qualified id. `ctx.module('kanban')` reaches the global slot; `ctx.module('bigcorp/kanban')` reaches the workspace slot. Same Map, just qualified keys.

**Module (one explicit pattern):**

The frontend bundle is shipped to the browser; the browser sets `import.meta.url` to the URL it loaded it from. The module derives its API base and WS topic from there:

```jsx
// kanban/frontend.jsx — works at /modules/kanban/ and /modules/w/<ws>/kanban/.
//
// The shell extracts `meta` server-side at discovery by importing this file
// from a `data:` URL. `new URL('.', dataUrl)` throws there, so the derivation
// is wrapped in try/catch with an empty-string fallback. In the browser the
// import URL is a real path and the math runs as designed.
const ROUTE = (() => {
  try {
    return new URL('.', import.meta.url).pathname
      .replace(/^\/modules\//, '').replace(/\/$/, '');
  } catch { return ''; }
})();
const API = '/api/' + ROUTE;             // '/api/kanban'  |  '/api/w/Penguin/kanban'
const TOPIC = ROUTE.replace(/^w\//, ''); // 'kanban'       |  'Penguin/kanban'

// Use them everywhere:
fetch(`${API}/spaces`);
window.__atelier.subscribe(TOPIC, (frame) => { /* … */ });
```

| `import.meta.url` (browser-set at load) | `ROUTE` | `API` | `TOPIC` |
|---|---|---|---|
| `…/modules/kanban/frontend.js` | `kanban` | `/api/kanban` | `kanban` |
| `…/modules/w/Penguin/kanban/frontend.js` | `w/Penguin/kanban` | `/api/w/Penguin/kanban` | `Penguin/kanban` |

Why this shape:

- **Standards-based.** `import.meta.url` is plain ES module spec; the browser sets it from the actual fetched URL. Nothing Atelier-specific.
- **Symmetric with the backend.** Backend modules already locate themselves with `fileURLToPath(import.meta.url)`. Frontend modules use the same primitive.
- **No shell magic.** No bundle rewrite, no `define`-injected identifier, no shell-injected ambient global, no per-request runtime helper. The bundle reads its own URL and computes the rest.
- **Same bytes, different context.** The bundle is identical on disk for global vs. workspace; the browser populates `import.meta.url` to the URL it fetched it from.

`<base>` is the HTML primitive for "set the document base URL" but it doesn't fit Atelier: the rail loads many module bundles into one document, all sharing one `document.baseURI`, so a per-module base isn't expressible. Use `import.meta.url` instead.

### Checklist for making a module workspace-portable

1. **Backend** — write routes as `router.<verb>('/api/${ctx.id}/...', handler)`. Use `ctx.dataDir` for storage. Use `ctx.broadcast(event)` for live events. Use `ctx.module(id)` with full qualified ids for cross-module reads. **Do not** hardcode `/api/<your-name>/...`. (Existing module convention; nothing new.)
2. **Frontend** — add the three lines above (`ROUTE`, `API`, `TOPIC`) at the top of `frontend.jsx`. Use `${API}` everywhere you'd otherwise write `/api/<your-name>`. Use `TOPIC` where you'd subscribe to your own id.
3. **Drop a copy into the workspace** — `cp -r kanban $bigcorp/` (or symlink the source files except `data/`). Each workspace gets its own `data/` for free.
4. **Optional** — an `atelier.config.json` workspace block can list specific workspace modules to enable per env.

A module that does nothing on this list still works as a *global* module; it just isn't workspace-portable. To take it into a workspace, do the migration above. There is no shell-side opt-in for portability — the contract is "use the patterns and it works."

## Module-side consumption

Modules see the user through `req.user` per request, and learn their workspace context through `ctx.workspace`:

```js
// kanban/backend.js
export default {
  mountRoutes(router, ctx) {
    // ctx.id        = 'kanban'  (directory name, unchanged)
    // ctx.workspace = 'bigcorp' for $bigcorp/kanban, null for global kanban
    router.get(`/api/${ctx.id}/boards`, (req, res) => {
      // req.user is always populated — synthesized in dev, real in prod.
      const userId = req.user.id;
      // ...
    });
  },
};
```

`req.user` is always set by the time a module's route runs. No `if (auth)` branches.

Module source does not need to know whether it's mounted globally or inside a workspace. The shell auto-prefixes routes, scopes WS topics, and qualifies slot keys. The same module source works in either context.

## What the shell does not do

- **No helpers for the auth module.** No `serveTakeover`, no `isApiRequest`, no shared utility module. The auth module re-implements anything it needs — those handful of lines belong with the policy that uses them. Atelier is not a helper library; that is what modules are for.
- **No event or hook for the rail.** The bootstrap is injected once per page load; hot-reload triggers full reload via the existing WS ping. Same mechanism as today.
- **No 401-vs-403 convention enforced.** The auth module sets whatever status it wants in `handleUnauth`. Modules consuming gated APIs read the auth module's docs.
- **No `Denied` component, no `meta.public` opt-out, no role/ACL system in the shell.** Everything beyond "is there a user?" lives in the auth module's data and code.

## Summary of shell deltas

1. **`$<name>/` recursive discovery** — one level deep; same module rules apply. Hot-reload watches the new dirs too; `_*` and `data/` are excluded from the watcher (workspaces have their own `_inbox/`, `_generations/`, etc., that should not trigger reloads).
2. **`/w/<workspace>/...` URL routing** — workspace module routes auto-prefixed by the shell, so module source is unchanged. WS topics auto-scoped to `<workspace>/<module>`. Slot keys qualified to `<workspace>/<module>`.
3. **Auth slot detection** — first module exporting `authenticate` wins; later ones logged & ignored.
4. **`defaultUser` builder** — synthesized from discovery on every request.
5. **Per-request dispatch** — call `authenticate(req, defaultUser)` if auth installed; on null, call `handleUnauth`; otherwise set `req.user` and route.
6. **WebSocket upgrade gate** — `/_atelier/ws` upgrades go through the same `authenticate` slot. On null, the shell writes a bare `401` and destroys the socket (no `handleUnauth` — no body to render). On allow, `ws.user` is attached to the connection. WS connections survive subsequent session invalidation; see "WebSocket gating" above.
7. **`client.jsx` takeover branch** — when `boot.takeover` is present, mount the auth bundle full-screen instead of `AppShell`.
8. **TopBar workspace picker** — rendered only when `user.workspaces` is non-empty; hidden completely otherwise.
9. **Standalone dev** — `npm run dev:module -- bigcorp/kanban` loads only the workspace module (slash form).

That is the entire authentication system at the shell level. Everything else is the auth module.
