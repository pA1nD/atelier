# Authentication

Atelier is single-user by default. Authentication is opt-in: drop in a module that exports `authenticate`, the shell starts gating requests; remove it, the shell stops. The auth module owns all policy — identity, session, workspace membership, per-document ACLs, the login and denied UI. The shell only does dispatch.

For the workspace model itself (URL shape, `$<ws>/` folders, the synthetic `global` workspace, rail composition, picker behavior), see [README.md](./README.md). This document covers the *auth* layer that lives on top of it.

## The auth module slot

The shell scans discovered modules at startup. The **first** module whose `backend.js` default export includes an `authenticate` function claims the auth slot. Subsequent ones are logged once and ignored — same precedence rule as everywhere else.

Discovery order is alphabetical by qualifiedId. Only `global`-workspace modules are eligible — auth gates the whole shell and must work before any workspace selection. Workspace modules (`$bigcorp/auth`) exporting `authenticate` are skipped by the slot search and treated as ordinary modules.

If no module claims the slot, **the shell does not gate anything**. Every request gets `req.user = defaultUser` (synthesized from discovery, full access). This is the dev default.

If you want a specific auth module to win, use `atelier.config.json` to limit which modules mount in that environment.

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

  // Authed-only routes (e.g. /logout, account settings, admin UI).
  // Reachable only when authenticate returned a user. Same contract as any
  // other module's mountRoutes — routes are scoped, register relative paths.
  mountRoutes(router, ctx) {
    // Mounts at /api/global/auth/me
    router.get('/me', (req, res) => res.json(req.user));
  },
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

The shape the shell injects into every page bootstrap and sets as `req.user` on every request:

```js
{
  id,                // required; uniquely identifies this user
  name?,             // display name
  avatar?,           // url
  workspaces?,       // [{ id, name?, modules: [{ id, meta }] }]
  // anything else the auth module wants modules or chrome to consume
}
```

Everything except `id` is optional. The chrome reads `user.workspaces` to populate the LeftRail and the picker. Modules read whatever fields they care about.

**`user.workspaces` is the ground truth** for "what does this user have access to." Each entry includes `modules` — the list of modules visible to this user in that workspace. The synthetic `global` workspace always appears at index 0 with whatever global modules the user can see; non-global workspaces follow in alphabetical order.

**The shape is identical in no-auth and auth mode.** Only the content differs: in no-auth, the shell synthesizes the user from raw discovery; in auth, the auth module produces it. Module code never branches on "is auth installed."

### `defaultUser`

The shell builds `defaultUser` from raw discovery on every request and passes it to `authenticate`:

```js
defaultUser = {
  id: 'local',
  name: 'local',
  workspaces: [
    { id: 'global',   modules: <all root-folder modules with frontends> },
    { id: 'bigcorp',  modules: <all $bigcorp/<mod>> },
    // ...one per discovered $<ws>/, plus 'global' first
  ],
}
```

The auth module can:

- Return it unchanged — user sees everything (escape hatch / debug).
- Filter it — user sees a subset (drop workspaces, drop modules within a workspace).
- Replace it — user sees what the auth module synthesized from its own data store.
- Return null — unauth handoff.

When no auth module is installed, the shell uses `defaultUser` as-is. This is how `npm run dev` keeps working with zero configuration.

## Per-request flow

1. Build `defaultUser` from current discovery.
2. If no auth module installed → `req.user = defaultUser` → route normally.
3. Otherwise: `result = await authModule.authenticate(req, defaultUser)`.
   - `result === null` → `authModule.handleUnauth(req, res, ctx)`. Shell is done; the auth module owns the response.
   - `result` is a user object → `req.user = result` → route normally.

For page requests, the user object is injected into the bootstrap as `window.__ATELIER__.user`. The client renders the rail, topbar, and workspace picker from that object — no fetch, no API call. A single server-side string replace produces the rail.

For API requests, `req.user` is set on the request the module receives.

### Auth runs before the index responds

The shell's `serveIndex` calls `authenticateRequest` **first**, before any workspace inference, before any 302 canonicalization, before any cookie set. This means a logged-out visitor never sees workspace-membership info leak in headers or in the HTML — the unauth handler owns the response start to finish.

### Order of layers in the HTTP handler

```
/  or /index.html       → serveIndex (auth-first)
/assets/*               → public shell assets (no auth) — needed for the takeover bundle to load
/modules/<ws>/<id>/...  → AUTH-GATED module assets
/_atelier/whoami        → AUTH-GATED identity probe
/api/<ws>/<id>/...      → AUTH-GATED module API
/<ws>/, /<ws>/<id>      → SPA fallback → serveIndex (auth-first)
```

The auth module's `authenticate` is expected to whitelist its own bundle path (`/modules/global/auth/...`) and its own login endpoints (`/api/global/auth/login`, etc.) so unauthenticated visitors can fetch them during the takeover render. This is module-side convention, not shell-enforced.

## WebSocket gating

The shared shell WebSocket at `/_atelier/ws` goes through the **same `authenticate` slot** as HTTP. An upgrade is just an HTTP request with a `Connection: Upgrade` header — cookies are present in `req.headers`, the auth module reads them the same way it does for any other request, and returns a user or null.

Per upgrade:

1. Path-check `/_atelier/ws`; anything else is dropped.
2. `await mountPendingBackends()` so a freshly-installed auth module claims the slot before its first upgrade.
3. `result = await authModule.authenticate(req, defaultUser)` — same call as HTTP.
4. `null` → write `HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n` and destroy the socket. `handleUnauth` does **not** run: the WS handshake has nowhere to render an HTML takeover or a JSON body. The browser surfaces "WS connection failed" to JS; the client's reconnect loop retries after the user signs in (the post-login cookie is sent on the next attempt).
5. user → `wss.handleUpgrade(...)`; the connection is admitted with `ws.user = result` attached for downstream use (per-frame ACL filtering, server-side disconnects, etc.).

No new auth-module contract surface. The same `authenticate` function gates both surfaces.

### Topic-level filtering inside the WS

Topics are fully qualified (`'<workspace>/<id>'`). The server doesn't filter fan-out — every frame goes to every connected client. The client-side subscriber map decides what's actually delivered to handlers. Because topics carry the workspace, same-named modules in different workspaces can't cross-broadcast.

For per-user/per-workspace WS-level filtering (e.g. "only members of `bigcorp` see `bigcorp/*` frames"), the auth module can attach an ACL to `ws.user` and the shell would need to consult it before send. **This is not implemented yet** — `wsBroadcastFromModule` currently fans out to every client. If you need it, ask before adding; the surface is straightforward but the contract needs thought.

### Limitation: WS connections survive session invalidation

`authenticate` runs at the upgrade only — once a socket is admitted, it stays admitted for its lifetime. If the auth module deletes a session (logout, admin revoke, expiry), the matching WS connection keeps receiving frames until the client closes it.

In practice this is usually not visible:

- **User-initiated logout** — the auth module's frontend typically navigates the page right after `POST /logout`, which closes the WS naturally. The window where the stale WS receives frames is a few ms of data the same logged-in user already had access to.
- **Server-initiated invalidation** — the next HTTP request from the affected client gets `401` (HTTP path runs `authenticate` per request), so any user action after revocation hits the takeover. Idle WS connections continue to stream until the user does anything.

The shell does not provide a `disconnectClients` helper today. If a future auth module needs to force-tear connections (admin force-logout, hard expiry) the shape is straightforward to add — it's the symmetric peer to `ctx.broadcast`, only the shell can do it because the shell owns the connected-clients set, and `ws.user` is already attached. Add it when there's a use case; not before.

## The connection banner

When the WebSocket drops, the client distinguishes "server gone" from "session expired" via a one-shot probe to `/_atelier/whoami`:

- WS is up + probe returns `200` → banner hidden, `state = 'online'`.
- WS dropped + probe returns `401` → amber banner: "session expired — sign in again." Reload button triggers the takeover.
- WS dropped + probe fails (network error, 5xx) → red banner: "server unreachable — reconnecting." Auto-reconnect with exponential backoff.

The probe is gated by `authenticate` (sits in the gated lane) so a 401 is unambiguous "session is dead." Auth modules that return a 200 HTML body for `/_atelier/whoami` would confuse this — auth modules MUST return either 200 JSON for authed or 401 for unauthed on that path. The shell handles the response body itself when authed.

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
  moduleBundle: '/modules/global/auth/frontend.js',
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

## Module-side consumption

Modules see the user through `req.user` per request, and learn their workspace context through `ctx.workspace`:

```js
// kanban/backend.js
export default {
  mountRoutes(router, ctx) {
    // ctx.id          = 'kanban'             (directory name)
    // ctx.workspace   = 'global' for root,
    //                   '<ws>' for $<ws>/kanban
    // ctx.qualifiedId = '<workspace>/<id>'   = 'global/kanban' or 'bigcorp/kanban'

    router.get('/boards', (req, res) => {
      // req.user is always populated — synthesized in dev, real in prod.
      const userId = req.user.id;
      // ...
    });
  },
};
```

`req.user` is always set by the time a module's route runs. No `if (auth)` branches.

Modules whose handlers don't care about identity ignore `req.user` and work in either mode. Modules that need user-aware behavior (a personal kanban board, an inbox-per-user, an admin route) read `req.user.id` / `req.user.name` / etc.

## Module portability — workspace-blind module source

A module's `backend.js` and `frontend.jsx` are identical whether the module lives at the root (`<id>/`) or inside a workspace (`$<ws>/<id>/`). The shell handles the workspace-aware addressing transparently:

**Shell (transparent):**

- **Backend routes scoped at mount.** The shell hands `mountRoutes` a router pre-scoped to `/api/<ws>/<id>`; the module registers relative paths (`router.get('/things', ...)`). Identical source, mounts at the right URL.
- **`ctx.broadcast(event)` tags the topic with `ctx.qualifiedId`** = `<workspace>/<id>`. Same-named modules in different workspaces have distinct topics; identical source.
- **`ctx.dataDir`** is `<source>/data/` regardless of mount workspace — for a `$bigcorp/kanban/`, that's `$bigcorp/kanban/data/`. Identical source.
- **`ctx.module(id)`** keys the slot registry by `(callerWorkspace, id)` automatically — `global` and `$bigcorp` get separate slots for the same target id. Identical source.

**Module (one explicit pattern, frontend-only):**

The frontend bundle is shipped to the browser; the browser sets `import.meta.url` to the URL it loaded it from. The module derives its API base and WS topic from there:

```jsx
// kanban/frontend.jsx — works at /modules/global/kanban/ and /modules/<ws>/kanban/.
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
const API = '/api/' + ROUTE;     // '/api/global/kanban' or '/api/<ws>/kanban'
const TOPIC = ROUTE;             // 'global/kanban' or '<ws>/kanban'

// Use them everywhere:
fetch(`${API}/spaces`);
window.__atelier.subscribe(TOPIC, (frame) => { /* … */ });
```

| `import.meta.url` (browser-set at load) | `ROUTE` | `API` | `TOPIC` |
|---|---|---|---|
| `…/modules/global/kanban/frontend.js` | `global/kanban` | `/api/global/kanban` | `global/kanban` |
| `…/modules/bigcorp/kanban/frontend.js` | `bigcorp/kanban` | `/api/bigcorp/kanban` | `bigcorp/kanban` |

Why this shape:

- **Standards-based.** `import.meta.url` is plain ES module spec; the browser sets it from the actual fetched URL. Nothing Atelier-specific.
- **Symmetric with the backend.** Backend modules already locate themselves with `fileURLToPath(import.meta.url)`. Frontend modules use the same primitive.
- **No shell magic.** No bundle rewrite, no `define`-injected identifier, no shell-injected ambient global, no per-request runtime helper. The bundle reads its own URL and computes the rest.
- **Same bytes, different context.** The bundle is identical on disk for global vs. workspace; the browser populates `import.meta.url` to the URL it fetched it from.

### Cross-module calls

A module that needs to call another module's API derives the workspace from `ROUTE` and addresses the peer in the same workspace:

```js
const WS = ROUTE.split('/')[0];                // 'global' or '<workspace>'
const AGENTS_API = `/api/${WS}/agents`;        // peers in the same workspace
const AGENTS_TOPIC = `${WS}/agents`;
```

This means a workspace-scoped activity calls a workspace-scoped agents; a global activity calls a global agents. Cross-workspace calls (e.g. `bigcorp/activity` → `global/agents`) are an explicit policy choice the calling module makes — they're not automatic.

### Checklist for making a module workspace-portable

1. **Backend** — write relative paths in `router.<verb>('/...', handler)`. Use `ctx.dataDir` for storage. Use `ctx.broadcast(event)` for live events. Use `ctx.module(id)` for cross-module slot access. Use `'/api/' + ctx.qualifiedId + '/...'` when building absolute URLs in response bodies.
2. **Frontend** — paste the ROUTE / API / TOPIC block at the top of `frontend.jsx`. Use `${API}` everywhere you'd otherwise write `/api/<your-name>`. Use `TOPIC` where you'd subscribe to your own qualified id.
3. **Drop a copy into the workspace** — `cp -r kanban $bigcorp/` (or symlink the source files except `data/`). Each workspace gets its own `data/` for free.
4. **Optional** — an `atelier.config.json` workspace block can list specific workspace modules to enable per env.

Modules that follow this checklist work as both global modules AND inside any workspace, with one source. The shell-side parts are automatic.

## What the shell does not do

- **No helpers for the auth module.** No `serveTakeover`, no `isApiRequest`, no shared utility module. The auth module re-implements anything it needs — those handful of lines belong with the policy that uses them. Atelier is not a helper library; that is what modules are for.
- **No event or hook for the rail.** The bootstrap is injected once per page load; hot-reload triggers full reload via the existing WS ping. Same mechanism as today.
- **No 401-vs-403 convention enforced.** The auth module sets whatever status it wants in `handleUnauth`. Modules consuming gated APIs read the auth module's docs. (Exception: `/_atelier/whoami` must follow 200/401 so the connection banner can distinguish offline from unauthed.)
- **No `Denied` component, no `meta.public` opt-out, no role/ACL system in the shell.** Everything beyond "is there a user?" lives in the auth module's data and code.
- **No per-frame WS ACL filtering.** Topics are workspace-qualified so cross-workspace leakage isn't possible by accident, but every connected client receives every broadcast for topics it subscribes to. If you need per-user filtering inside one workspace, the auth module needs to push that policy into the shell — coordinate before adding.

## Summary of shell responsibilities

1. **`$<name>/` recursive discovery** — one level deep; same module rules apply. Hot-reload watches the new dirs too; `_*` and `data/` segments are excluded from the watcher.
2. **`/<workspace>/<id>` URL routing** — every module has a qualifiedId; URLs/topics/slots all use it directly. The synthetic `global` workspace anchors root-folder modules.
3. **Scoped router per mount** — each module gets a sub-router rooted at `/api/<workspace>/<id>`; module source uses relative paths.
4. **Auth slot detection** — first `global`-workspace module exporting `authenticate` wins; later ones logged & ignored. Workspace modules are not eligible.
5. **`defaultUser` builder** — synthesized from discovery on every request.
6. **Per-request dispatch** — call `authenticate(req, defaultUser)` if auth installed; on null, call `handleUnauth`; otherwise set `req.user` and route.
7. **WebSocket upgrade gate** — `/_atelier/ws` upgrades go through the same `authenticate` slot. On null, the shell writes a bare `401` and destroys the socket (no `handleUnauth` — no body to render). On allow, `ws.user` is attached to the connection. Per-frame ACL filtering is not implemented.
8. **`/_atelier/whoami` identity probe** — gated by the same `authenticate`; returns 200 JSON for authed users, 401 for unauthed. Drives the connection banner.
9. **`client.jsx` takeover branch** — when `boot.takeover` is present, mount the auth bundle full-screen instead of `AppShell`.
10. **TopBar workspace picker** — rendered when the user has any non-`global` workspaces; hidden otherwise.
11. **Connection banner** — amber for unauth (session expired), red for offline (server unreachable). Distinguishes via the whoami probe.

That is the entire authentication system at the shell level. Everything else is the auth module.
