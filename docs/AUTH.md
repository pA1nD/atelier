# Auth

Atelier is ungated by default. Authentication is opt-in: name a module in the `auth` setting and the shell gates every request through it; leave `auth` unset (the default) and the shell doesn't gate. The auth module owns all policy — identity, session, workspace membership, per-document ACLs, the login and denied UI. The shell enforces only the **module boundary** (who may see, call, and receive each module); the auth module owns everything finer.

For the workspace model itself (URL shape, `$<ws>/` folders, the synthetic `global` workspace, rail composition, picker behavior), see [README.md](./README.md). This document covers the *auth* layer that lives on top of it.

> **Recommendation while auth matures (pre-1.0): don't make this slot your only wall.** The contract below works and is tested, but it is young — it hasn't yet earned the mileage you should demand of the single security boundary of an internet-facing deployment. For now, terminate authentication **outside** atelier and keep the instance itself where strangers can't reach it: bound to loopback or a trusted network (an office LAN you control, a mesh VPN like Tailscale), or behind a reverse proxy / identity-aware endpoint that handles login before a request ever reaches the shell. The auth slot then runs *behind* that wall as the identity layer, not the perimeter — an auth module that reads the proxy's authenticated-user header (e.g. `X-Forwarded-User`) and maps it to `user.workspaces` is the natural fit, and multi-tenant gating works exactly as documented. This is a temporary posture: as the slot hardens over coming versions it graduates to being trustable as the perimeter itself.

## Where auth sits: the single trusted layer

Before anything else, hold one picture in your head: **auth is the single trusted layer between the shell and the modules.** The shell ships zero policy and serves the same floor to everyone; the modules are untrusted features (any may be vibe-coded); and *everything bound for identity or a module passes through the auth module first.* It is the one place — the only place — where "who are you" and "may you" are decided.

```
┌───────────────────────────────────────────────────────────────────┐
│ SHELL  ·  always on  ·  trusts nobody  ·  ships zero policy
│   serves /assets so even the login UI can load · routes every
│   request · runs the WS multiplex · hot-reloads
│   enforces ONLY the mechanical module boundary (presence) —
│   never "what may you do"
└───────────────────────────────────────────────────────────────────┘
                    │  every request for identity or a module
                    ▼
╔═══════════════════════════════════════════════════════════════════╗
║ AUTH MODULE  ·  the SINGLE TRUSTED GATE  ·  all policy lives here
║   authenticate → who are you?      (null → handleUnauth owns response)
║   authorize    → may you do this?  (read / write · payload)
║   nothing below runs until this layer says yes
╚═══════════════════════════════════════════════════════════════════╝
                    │  only what auth allowed
                    ▼
┌───────────────────────────────────────────────────────────────────┐
│ MODULES  ·  UNTRUSTED features (may be vibe-coded)
│   run only after the shell + auth let the request through
│   a module's own permission check is a courtesy, never the boundary
└───────────────────────────────────────────────────────────────────┘
```

- **The shell is transport, not policy.** It serves the public floor (`/assets/*`, the client bundle — so the login screen can even render), routes `/api/<ws>/<id>`, and runs the WS multiplex. The one decision it makes by itself is the *mechanical* module boundary (presence) — and only because that's the same `user.workspaces` data the auth module already produced.
- **The auth module is the single trusted gate.** Every request headed for identity, a module API, a module asset, or the WS upgrade passes through `authenticate`; API requests additionally pass `authorize`. Policy lives nowhere else.
- **Modules are untrusted.** They're the product, but they sit *below* the gate by design: a request reaches a module only after the gate allowed it, so a sloppy or vibe-coded module can't become a tenant-isolation hole.

**Ungated instances** (the `auth: false` default) simply remove the middle band — there is no auth module, every request gets the full-access `defaultUser`, and nothing is gated. The trusted-layer picture above is what you get the moment you name an `auth` module.

## The mental model: three pillars

Auth touches three surfaces, and it pays to hold them apart. On each one the shell enforces only the **module boundary** — mechanical, dumb, trusted — and the trusted **auth module** owns everything below it. Feature modules are *never* trusted to enforce their own permissions: any module may be vibe-coded, so a check inside one is a courtesy, not a boundary. Real enforcement lives only in the shell and the auth module.

| Pillar | Governs | Shell enforces (the module boundary) | Auth module owns (below the boundary) |
| --- | --- | --- | --- |
| **Frontend** | what you **see** | the rail + bootstrap are built from `user.workspaces` — you only see modules in your view | per-module UI hints (show/hide *within* a module) — display only, **untrusted** |
| **HTTP** | what you can **call** | the presence gate: `/api/<ws>/<id>` is reachable only if that module is in `user.workspaces` | **`authorize`** — read/write, payload inspection, sub-resource rules |
| **WS** | what you **receive** | the per-frame ACL: a module's frames reach you only if it's in `user.workspaces` | sub-room membership (`<ws>/<id>/<room>`) — e.g. who's in an admins-only room |

The single structure behind all three is **`user.workspaces[].modules[]`** — what `authenticate` returns. The shell reads it to draw the rail (frontend), gate the API (HTTP), and gate frames (WS). Get that one list right and the module boundary holds on all three surfaces at once.

> **What's wired today:** the module boundary on all three pillars, plus the HTTP **`authorize`** hook. `authorize` is the first *below-boundary* lever, and the template the other two follow — the decision lives in the trusted auth module; the shell only carries and enforces it. The below-boundary levers for the frontend (a per-module `permissions` object passed to the component) and WS (`rooms` sub-room membership) are designed but **not yet wired** — when they land, they'll be two optional fields on the per-module entry the auth module already returns, needing no breaking change.

### The request lifecycle: `authenticate` → `authorize`

A request to a module API passes through two distinct auth-module hooks, in order, with the shell's mechanical presence gate *between* them:

```
request
   │
   ▼
authenticate(req, defaultUser)        ─ identity: who is this session?
   │   └─ null ──▶ handleUnauth        (auth module owns the whole response: login / redirect / 401)
   ▼  user   (cached as req.user / ws.user; user.workspaces = what you can see)
presence gate   (shell, mechanical)   ─ boundary: is this module in user.workspaces?
   │   └─ no ──▶ 403
   ▼  yes
authorize(req, user, target)          ─ permission: may you do THIS, here, with this payload?
   │   └─ falsy / throw ──▶ 403        (auth module; OPTIONAL — omit it and presence alone gates)
   ▼  ok
module router                          ─ the untrusted module runs ONLY now
```

- **`authenticate(req, defaultUser)` — *who are you?*** Returns the `user` (whose `user.workspaces` is the access view) or `null`. `null` means *not signed in* → `handleUnauth` takes over the entire response. It runs on **every** surface — page, API, asset, and the WS upgrade — and its result is reused as `req.user` / `ws.user`. It must stay cheap (a session lookup): it's also re-run on every live WS socket each `revalidateMs`.

- **presence — *may you see this module?*** Between the hooks, the shell matches the request's module (`<ws>/<id>`) against the set built from `user.workspaces` (`userModuleSet`). Not in it → `403`, the request dies here. This is the *same* decision the rail and the WS ACL make, it needs no auth-module code, and it runs whenever auth is configured. The configured auth module's own routes are exempt — you can't gate the gate.

- **`authorize(req, user, target)` — *may you do this exact thing?*** Runs only for `/api/<ws>/<id>` requests that passed presence. `target = { qualifiedId, method, path }`, and `req.json()` is available — so the hook can decide on the verb (read vs write), the sub-path, or the **payload itself**. Return falsy (or throw) → `403`; the module router never runs. It's **optional**: omit it and presence alone gates (the right default for instances that don't need read/write yet).

**Why two hooks, not one.** `authenticate` *can* see the request — so why not refuse there? Because folding authorization in overloads it on three axes: **outcome** — `authenticate`'s `null` means "log in" (a 401/takeover), but a below-module denial means "you're in, just not for this" (a 403, no redirect); **input** — payload checks need the parsed body, which `authenticate` never gets (it also runs on WS upgrades and assets, where there is no body); **lifecycle** — `authenticate`'s answer ("who you are") is cheap and reused across the bootstrap, the WS ACL, and the re-validation tick, whereas a per-request, per-payload verdict is none of those. Two hooks with clean contracts — *who are you* vs *may you do this* — beat one hook that has to branch on the surface it's running for.

## The auth module

### The auth module slot

Auth is **explicit and opt-in**: the `auth` setting in `atelier.config.json` names the gating module (a path, or a `global`-workspace module id), or is `false` (the default) to run ungated. A module exporting `authenticate` does **not** gate the shell unless it's the configured one — so a stray export can't silently gate the instance, and a missing one can't silently expose it. `ATELIER_AUTH` overrides the setting at startup.

Only `global`-workspace modules are eligible — auth gates the whole shell and must work before any workspace selection. A workspace module (`$bigcorp/auth`) named as `auth` is ignored. The named module must be mounted (listed in `modules`, or path-mounted).

With `auth: false` (or unset), **the shell does not gate anything**. Every request gets `req.user = defaultUser` (synthesized from discovery, full access). An ungated instance whose `baseUrl` isn't localhost logs a startup warning.

### The contract

The auth module's backend exports — `authenticate` is the only required one; the rest are optional:

```js
// auth/backend.js
export default {
  // IDENTITY. Called for every request — page, API, asset, WS upgrade.
  // Free-form: sees full URL + headers (cookies). May refuse based on session,
  // URL pattern, role — anything. Returns the user object the shell uses for
  // this request (user.workspaces = the access view), or null → handleUnauth.
  async authenticate(req, defaultUser) { ... },

  // PERMISSION (optional). Runs only for /api/<ws>/<id> requests that passed
  // the shell's presence gate, AFTER authenticate and BEFORE the module router.
  // target = { qualifiedId, method, path }. `await req.json()` reads the body
  // (memoized — the module handler gets the same parse). Return falsy or throw
  // → 403, and the module never runs. This is where below-the-boundary policy
  // lives: read vs write, sub-resource rules, payload inspection.
  async authorize(req, user, target) { ... },

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

### The `user` object

The shape the shell injects into every page bootstrap and sets as `req.user` on every request:

```js
{
  id,                // uniquely identifies this user — set it (the shell uses it for /_atelier/whoami)
  name?,             // display name (chrome shows it; falls back to a local pref when absent)
  avatar?,           // url (convention; no shell behavior)
  workspaces?,       // [{ id, name?, modules: [{ id, meta?, access? }] }]  — see below
  logout?,           // url the chrome POSTs to sign out (e.g. '/api/global/auth/logout');
                     //   present → the chrome shows a "Sign out" item. Convention, not shell-read.
  // anything else the auth module wants modules or chrome to consume
}
```

What each consumer relies on:
- **Shell** hard-depends only on `id` and `workspaces[].id` + `workspaces[].modules[].id` — that set is the security boundary (presence gate + WS ACL). `workspaces[].modules[].access` (`'read'`|`'write'`) is read by `authorize` (it's what the auth module carries; the shell passes it through).
- **Chrome** reads `name`, `workspaces[].name`, `workspaces[].modules[].meta` (rail), and `logout` (sign-out).
- Everything else is convention the auth module adds for modules/chrome; the shell ignores it.

**`user.workspaces` is the ground truth** for "what does this user have access to." Each entry includes `modules` — the list of modules visible to this user in that workspace. The synthetic `global` workspace always appears at index 0 with whatever global modules the user can see; non-global workspaces follow in alphabetical order.

**The shape is identical in no-auth and auth mode.** Only the content differs: in no-auth, the shell synthesizes the user from raw discovery; in auth, the auth module produces it. Module code never branches on "is auth installed."

#### `defaultUser`

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

When `auth` is off (the default), the shell uses `defaultUser` as-is — the zero-config local experience.

## Request gating

### Per-request flow

1. Build `defaultUser` from current discovery.
2. If `auth` is off (the default) → `req.user = defaultUser` → route normally.
3. Otherwise: `result = await authModule.authenticate(req, defaultUser)`.
   - `result === null` → `authModule.handleUnauth(req, res, ctx)`. Shell is done; the auth module owns the response.
   - `result` is a user object → `req.user = result` → route normally.

For page requests, the user object is injected into the bootstrap as `window.__ATELIER__.user`. The client renders the rail, topbar, and workspace picker from that object — no fetch, no API call. A single server-side string replace produces the rail.

For `/api/<ws>/<id>/…` requests, after `req.user` is set the shell applies the module boundary before dispatching to the module: **(a)** the **presence gate** — the request's module must be in `user.workspaces` (else `403`); **(b)** the optional **`authorize`** hook — if the auth module exports it, the shell calls `authorize(req, user, { qualifiedId, method, path })` and a falsy/thrown result is a `403`. Only then does the module's router run. The configured auth module's own routes skip both. See the [request lifecycle](#the-request-lifecycle-authenticate--authorize) above.

#### Auth runs before the index responds

The shell's `serveIndex` calls `authenticateRequest` **first**, before any workspace inference, before any 302 canonicalization, before any cookie set. This means a logged-out visitor never sees workspace-membership info leak in headers or in the HTML — the unauth handler owns the response start to finish.

#### Gating at a glance — lanes & exemptions

Every request lane, what gates it, and the special cases — collected so none is a surprise. The shell enforces the module boundary; the auth module owns everything finer.

| Lane | Gate | Special cases / exemptions |
| --- | --- | --- |
| `/assets/*` — shell JS/CSS | **none (public)** | Served pre-auth so the login takeover can load. |
| `/` · `/<ws>/<id>` — page / bootstrap | `authenticate` (auth-first) | Unauth → `handleUnauth` owns the whole response. **The chrome isn't loaded pre-auth**, so the auth module ships its own takeover design. |
| `/_atelier/whoami` | `authenticate` | `200` authed / `401` not — drives the connection banner. |
| `/_atelier/inflight` | `authenticate` | Exists only when the `observe` setting is on (else `404`). Shows every in-flight request's method + URL to **any** authed user, across tenants — a debugging tool for instances whose users are trusted operators. |
| `/_atelier/client-errors` (POST) | `authenticate` | Exists only when `observe` is on (else `404`). Ingests the client reporter's error payloads and fans them out as `client-error` frames on the shell topic — delivery ACL-gated by the page's module (like `backend-error`), so a stack never reaches a client that can't see that module. |
| `/modules/<ws>/<id>/*` — bundles | `authenticate` **only** | **Not** presence-gated — bundles are code, not tenant data. This is why the chrome bundle (and every module bundle) loads for any authed user. |
| `/api/<ws>/<id>/*` — module API | `authenticate` → **presence** → **`authorize`** | Exempt from presence + authorize: the **auth module's own routes** (can't gate the gate) and **any mounted chrome** (every `meta.isChrome` module — resolved server-side from discovery). Chromes are in nobody's `workspaces` but are shared scaffolding (e.g. a chrome's `/docs`), and with `meta.chrome` any installed chrome may be the active one for some module — so the exemption covers the whole chrome set, not just the default. A feature module **can't** self-exempt via `meta`: declaring `meta.isChrome` only turns it into a hidden chrome (gone from every rail and workspace), and the set is operator-controlled (only *mounted* chromes qualify). |
| WS `/_atelier/ws` — frames | per-frame **ACL** (presence) | `'shell'` topic **always** reaches every client (hot-reload + shell events, never module data). Read and write both receive (level is an HTTP concern). **No `global` exception** — global modules are gated per-user. Sub-room / infra-topic ACL not yet wired. |
| **ungated** — `auth: false` (default) | **none** | Every request gets the full-access `defaultUser` (`id: 'local'`); presence / authorize / ACL are all no-ops. |

The auth module's `authenticate` is expected to whitelist its own bundle path (`/modules/global/auth/...`) and its own login endpoints (`/api/global/auth/login`, etc.) — by returning a synthetic guest for those paths — so unauthenticated visitors can fetch them during the takeover. This is module-side convention, not shell-enforced.

#### HTTP authorization: presence gate + `authorize`

`authenticate` answers "is there a user." It does **not**, on its own, stop an authed user from calling *another tenant's* module API — the request would otherwise dispatch straight to the module router, and the (untrusted) module would be the only thing between the caller and the data. So for every `/api/<ws>/<id>/…` request the shell adds two trusted layers in front of the module router (the HTTP twin of the WS ACL below):

1. **Presence gate (shell, mechanical).** The request's module (`<ws>/<id>`) must be in `userModuleSet(user)` — the exact set built from `user.workspaces`, shared with the rail and the WS ACL. Not in it → `403`. This closes the cross-tenant hole with no auth-module code, and it's the *same* boundary on all three pillars.
2. **`authorize` (auth module, optional).** If exported, it runs after presence and before dispatch, with `target = { qualifiedId, method, path }` and a memoized `req.json()` — so it can gate on verb (read/write), sub-path, or payload. Falsy/throw → `403`. A throw may carry `statusCode` (e.g. a `413` propagated from reading an oversized body); otherwise the shell sends `403`.

Both layers exempt two things: (a) the configured **auth module's own** qualifiedId — you can't gate the gate (login must be reachable), and it governs its own surface through `authenticate`; and (b) **any mounted chrome** — resolved server-side from discovery (every `meta.isChrome` module), **never** trusted from a module's self-declared `meta` beyond actually being a mounted chrome. Chromes are excluded from `buildDefaultUser`, so they're in nobody's `user.workspaces` and the presence gate would `403` them for everyone, but a chrome (and its own API, e.g. a help/docs endpoint) is shared scaffolding every authed user loads, not tenant data — and with `meta.chrome` any installed chrome may be active for some module, so the whole chrome set is exempt, not just the default. A feature module can't opt its own API out of the gate by exporting `meta.hidden`/`meta.isChrome`: that only makes it a hidden chrome (gone from every rail and workspace), and the set is operator-controlled (only *mounted* chromes qualify). With no auth module the user is the full-access `defaultUser`, so the presence gate is a no-op and `authorize` is never called.

**Assets are *not* presence-gated.** `/modules/<ws>/<id>/…` stays auth-gated (logged-in only) but not restricted to your own modules: bundles are code shipped to the browser, not tenant data, and presence-gating them would block the (hidden, often un-railed) chrome bundle that every client must load. The tenant-data boundary is the API (`/api`) + WS frames; that's what these two layers and the WS ACL cover.

### WebSocket gating

The shared shell WebSocket at `/_atelier/ws` goes through the **same `authenticate` slot** as HTTP. An upgrade is just an HTTP request with a `Connection: Upgrade` header — cookies are present in `req.headers`, the auth module reads them the same way it does for any other request, and returns a user or null.

Per upgrade:

1. Path-check `/_atelier/ws`; anything else is dropped.
2. `await mountPendingBackends()` so a freshly-installed auth module claims the slot before its first upgrade.
3. `result = await authModule.authenticate(req, defaultUser)` — same call as HTTP.
4. `null` → write `HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n` and destroy the socket. `handleUnauth` does **not** run: the WS handshake has nowhere to render an HTML takeover or a JSON body. The browser surfaces "WS connection failed" to JS; the client's reconnect loop retries after the user signs in (the post-login cookie is sent on the next attempt).
5. user → `wss.handleUpgrade(...)`; the connection is admitted with `ws.user = result` attached and a per-module topic ACL (`ws.allowed`) precomputed from it — see "Per-module WS ACL" below.

No new auth-module contract surface. The same `authenticate` function gates both surfaces.

#### Per-module WS ACL

Topics are fully qualified (`'<workspace>/<id>'`), and the shell **gates the fan-out per frame**: a client receives a module's frames only if its user can see that module. The check uses the *same* `user.workspaces[].modules[]` the chrome renders the rail from — so **"if you can see the module, you receive its frames; if you can't, you don't,"** per-module, not just per-workspace. There is **no `global` exception** — a global module's frames reach a user only if it's in their view; globals usually *are* granted to all, but the auth module can withhold one, and then that user sees neither the rail entry nor its frames. The only topic that always reaches every client is `'shell'` (hot-reload and other shell events — never module data).

This makes `user.workspaces[].modules` a **security boundary**, not just a rail hint — the auth module must return it accurately and completely.

Mechanics: at the WS upgrade the shell precomputes `ws.allowed = Set('<ws>/<id>' …)` from the user's view, so the per-frame check is a single `ws.allowed.has(topic)` — **O(1) per client**, which matters when one broadcast fans to hundreds of sockets. With no auth module the user is the full-access `defaultUser`, so the ACL is a no-op (everyone sees everything).

#### Live session invalidation + permission changes

`authenticate` runs at the upgrade, but the shell also **re-validates every live socket on an interval** (`revalidateMs`, default 30 000 ms; env `ATELIER_REVALIDATE_MS`). Each cycle re-runs `authenticate` against the socket's original upgrade request:

- returns `null` → the session ended (logout / admin revoke / expiry) → the socket is closed (code `4001`);
- returns a **changed** user → `ws.user` + `ws.allowed` are refreshed, so a granted or revoked module takes effect on the live socket **without a reconnect**.

So both revocation *and* mid-session permission changes propagate within one interval. The cost: `authenticate` is called once per open socket per interval, so it must be a cheap session lookup. The interval only runs when an auth module is configured (an ungated user never changes). User-initiated logout still closes the WS instantly by navigating the page; the interval is the backstop that also catches *external* changes (admin actions, expiry) the client never initiated.

### The connection banner

When the WebSocket drops, the client distinguishes "server gone" from "session expired" via a one-shot probe to `/_atelier/whoami`:

- WS is up + probe returns `200` → banner hidden, `state = 'online'`.
- WS dropped + probe returns `401` → amber banner: "session expired — sign in again." Reload button triggers the takeover.
- WS dropped + probe fails (network error, 5xx) → red banner: "server unreachable — reconnecting." Auto-reconnect with exponential backoff.

The probe is gated by `authenticate` (sits in the gated lane) so a 401 is unambiguous "session is dead." Auth modules that return a 200 HTML body for `/_atelier/whoami` would confuse this — auth modules MUST return either 200 JSON for authed or 401 for unauthed on that path. The shell handles the response body itself when authed.

### Takeover render

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

## For module authors

### Running ungated vs gated

Ungated is the default — leave `auth` unset (or `false`) and the shell never gates (`req.user = defaultUser`, full access):

```json
{ "modules": ["kanban", "posts"] }
```

To gate an instance, name the auth module (and make sure it's mounted):

```json
{ "auth": "auth", "modules": ["auth", "kanban", "posts"] }
```

`auth` is a bare global module id or a path; `ATELIER_AUTH` overrides it at startup. Two instances can share a folder and differ only here — one ungated for local work, one gated for exposure.

### Module-side consumption

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

### Module portability — workspace-blind module source

A module's `backend.js` and `frontend.jsx` are identical whether the module lives at the root (`<id>/`) or inside a workspace (`$<ws>/<id>/`). The shell handles the workspace-aware addressing transparently:

**Shell (transparent):**

- **Backend routes scoped at mount.** The shell hands `mountRoutes` a router pre-scoped to `/api/<ws>/<id>`; the module registers relative paths (`router.get('/things', ...)`). Identical source, mounts at the right URL.
- **`ctx.broadcast(event)` tags the topic with `ctx.qualifiedId`** = `<workspace>/<id>`. Same-named modules in different workspaces have distinct topics; identical source.
- **`ctx.dataDir`** is `<source>/data/` regardless of mount workspace — for a `$bigcorp/kanban/`, that's `$bigcorp/kanban/data/`. Identical source.
- **`ctx.module(id)`** keys the slot registry by `(callerWorkspace, id)` automatically — `global` and `$bigcorp` get separate slots for the same target id. Identical source.

**Module (one explicit pattern, frontend-only):**

The frontend bundle is shipped to the browser; the browser sets `import.meta.url` to the URL it loaded it from. Pass that to the shell helper, which derives the module's workspace-aware identity:

```jsx
// kanban/frontend.jsx — works at /modules/global/kanban/ and /modules/<ws>/kanban/.
const self = window.__atelier.self(import.meta.url);
// self.workspace · self.id · self.qid · self.api ('/api/<ws>/kanban') · self.topic ('<ws>/kanban')

fetch(`${self.api}/spaces`);
self.subscribe((frame) => { /* … */ });        // listens on self.topic
```

| `import.meta.url` (browser-set at load) | `self.qid` | `self.api` | `self.topic` |
|---|---|---|---|
| `…/modules/global/kanban/frontend.js` | `global/kanban` | `/api/global/kanban` | `global/kanban` |
| `…/modules/bigcorp/kanban/frontend.js` | `bigcorp/kanban` | `/api/bigcorp/kanban` | `bigcorp/kanban` |

`self()` just wraps `new URL('.', import.meta.url)` parsing — there's no shell magic, no injected identifier; the bundle reads its own URL. (Server-side, `meta` is extracted by importing the file from a `data:` URL where that parsing yields an empty id — harmless, since `self()` is only called in the browser.)

Why this shape:

- **Standards-based.** `import.meta.url` is plain ES module spec; the browser sets it from the actual fetched URL. Nothing Atelier-specific.
- **Symmetric with the backend.** Backend modules already locate themselves with `fileURLToPath(import.meta.url)`. Frontend modules use the same primitive.
- **No shell magic.** No bundle rewrite, no `define`-injected identifier, no shell-injected ambient global, no per-request runtime helper. The bundle reads its own URL and computes the rest.
- **Same bytes, different context.** The bundle is identical on disk for global vs. workspace; the browser populates `import.meta.url` to the URL it fetched it from.

#### Cross-module calls

A module that needs to call another module's API uses its own workspace (from `self`) and addresses the peer in the same workspace:

```js
const self = window.__atelier.self(import.meta.url);
const SEARCH_API = `/api/${self.workspace}/search`;   // a peer in the same workspace
const SEARCH_TOPIC = `${self.workspace}/search`;
```

This means a workspace-scoped module calls a workspace-scoped peer; a global module calls a global peer. Cross-workspace calls (e.g. `bigcorp/kanban` → `global/search`) are an explicit policy choice the calling module makes — they're not automatic.

#### Checklist for making a module workspace-portable

1. **Backend** — write relative paths in `router.<verb>('/...', handler)`. Use `ctx.dataDir` for storage. Use `ctx.broadcast(event)` for live events. Use `ctx.module(id)` for cross-module slot access. Use `'/api/' + ctx.qualifiedId + '/...'` when building absolute URLs in response bodies.
2. **Frontend** — paste the ROUTE / API / TOPIC block at the top of `frontend.jsx`. Use `${API}` everywhere you'd otherwise write `/api/<your-name>`. Use `TOPIC` where you'd subscribe to your own qualified id.
3. **Drop a copy into the workspace** — `cp -r kanban $bigcorp/` (or symlink the source files except `data/`). Each workspace gets its own `data/` for free.
4. **Optional** — an `atelier.config.json` workspace block can list specific workspace modules to enable per env.

Modules that follow this checklist work as both global modules AND inside any workspace, with one source. The shell-side parts are automatic.

## Shell scope

### What the shell does not do

- **No helpers for the auth module.** No `serveTakeover`, no `isApiRequest`, no shared utility module. The auth module re-implements anything it needs — those handful of lines belong with the policy that uses them. Atelier is not a helper library; that is what modules are for.
- **No event or hook for the rail.** The bootstrap is injected once per page load; hot-reload triggers full reload via the existing WS ping. Same mechanism as today.
- **No 401-vs-403 convention enforced.** The auth module sets whatever status it wants in `handleUnauth`. Modules consuming gated APIs read the auth module's docs. (Exception: `/_atelier/whoami` must follow 200/401 so the connection banner can distinguish offline from unauthed.)
- **No `Denied` component, no `meta.public` opt-out, no role/ACL system in the shell.** Everything beyond "is there a user?" and the mechanical module boundary (presence) lives in the auth module's data and code.
- **No per-document/per-record ACL primitive.** The shell's gates are per-*module* (the presence gate and the WS ACL, both driven by `user.workspaces[].modules`). Going *finer* than the module — read vs write, which records within a module — is the **auth module's** job via the `authorize` hook (trusted, payload-aware), **not** the feature module's handlers: a feature module may be vibe-coded, so its own checks are a convenience, never the boundary.

### Summary of shell responsibilities

1. **`$<name>/` recursive discovery** — one level deep; same module rules apply. Hot-reload watches the new dirs too; `_*` and `data/` segments are excluded from the watcher.
2. **`/<workspace>/<id>` URL routing** — every module has a qualifiedId; URLs/topics/slots all use it directly. The synthetic `global` workspace anchors root-folder modules.
3. **Scoped router per mount** — each module gets a sub-router rooted at `/api/<workspace>/<id>`; module source uses relative paths.
4. **Auth slot** — the `auth` setting names the gating module (path or global id), or `false` (default) for ungated. A stray `authenticate` export does not gate; only the configured module does. Workspace modules aren't eligible.
5. **`defaultUser` builder** — synthesized from discovery on every request.
6. **Per-request dispatch + HTTP authorization** — call `authenticate(req, defaultUser)` when `auth` is configured; on null, call `handleUnauth`; otherwise set `req.user`. For `/api/<ws>/<id>/…` then enforce the module boundary before routing: the presence gate (module must be in `user.workspaces`) and, if exported, `authorize(req, user, target)` — either failing is a `403`. The auth module's own routes and the active chrome (resolved server-side, not trusted from module `meta`) are exempt.
7. **WebSocket gate + per-module ACL** — `/_atelier/ws` upgrades go through the same `authenticate` slot. On null, the shell writes a bare `401` and destroys the socket. On allow, `ws.user` is attached and a per-module topic ACL (`ws.allowed`) is precomputed from `user.workspaces`; the fan-out delivers a module's frames only to clients that can see it. Live sockets are re-validated on an interval (`revalidateMs`), so revocation and permission changes propagate without a reconnect.
8. **`/_atelier/whoami` identity probe** — gated by the same `authenticate`; returns 200 JSON for authed users, 401 for unauthed. Drives the connection banner.
9. **`client.jsx` takeover branch** — when `boot.takeover` is present, mount the auth bundle full-screen instead of `AppShell`.
10. **TopBar workspace picker** — rendered when the user has any non-`global` workspaces; hidden otherwise.
11. **Connection banner** — amber for unauth (session expired), red for offline (server unreachable). Distinguishes via the whoami probe.

That is the entire authentication system at the shell level. Everything else is the auth module.
