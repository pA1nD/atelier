# Changelog

Still pre-1.0 — anything in the shell surface (URLs, ctx shape, config schema) can move between minor versions until 1.0. The pace will slow as real users land, but for now: assume any 0.x bump may break a module that hardcoded an internal.

## 0.2.0

**Workspaces + scoped-router shell rewrite.** Big breaking architecture change in pre-release territory — every module needs a small migration. The migration is mechanical and described below.

### What changed at the shell level

- **Every module now has a workspace.** Root-folder modules belong to the synthetic `global` workspace; modules inside `$<name>/` belong to that workspace. Identity is `<workspace>/<id>` everywhere — URLs, API routes, asset paths, WebSocket topics, slot keys, watchers.
- **URLs got a workspace segment.** `/<workspace>/<id>` for SPA pages, `/api/<workspace>/<id>/...` for module API, `/modules/<workspace>/<id>/...` for module assets and bundles. The old `/<id>` and `/api/<id>/...` shapes are gone. There is no `/w/` prefix for workspaces (an earlier draft used `/w/<ws>/...`; the final v2 model dropped it for symmetry).
- **Workspace lives in the URL only.** No cookies, no Referer parsing, no `?ws=` query, no `X-Atelier-Workspace` header, no `atelier_ws` cookie, no localStorage stickiness. The picker writes a new URL on switch (full reload).
- **Scoped sub-router per mount.** The shell hands each module a `router` already scoped to `/api/<workspace>/<id>` — modules register *relative* paths (`router.get('/spaces', ...)`). The shell-side auto-prefix machinery is gone.
- **WebSocket topics are qualifiedIds.** Topic = `<workspace>/<id>` (always). The server stamps the topic; the client subscribes to whichever ones it cares about. Same-named modules in different workspaces have distinct topics.
- **Frontend bundles self-derive their workspace.** Every `frontend.jsx` starts with a `ROUTE/API/TOPIC` block that reads `import.meta.url` and computes the rest. Same bundle bytes work in any workspace.
- **`atelier.config.json` got nested workspace blocks.** `{ "modules": [ "kanban", { "workspace": "bigcorp", "modules": ["!wip"] } ] }`. Supports allow/deny per scope, path entries (`"./external"`, `"~/lab/mod"`, `{ "path": "...", "id": "..." }`), and workspace-deny via `{ "workspace": "!ws" }`. Old flat-list format is gone.
- **Auth slot scoped to `global` workspace.** Only `global`-workspace modules are eligible to claim the auth slot. Workspace modules exporting `authenticate` are skipped.
- **Reserved names updated.** `global` is now reserved (you can't have a `$global/` directory on disk because root-folder modules already constitute the synthetic `global` workspace). `w` is no longer reserved.
- **Connection banner.** When the WebSocket drops, the shell distinguishes "server gone" (red) from "session expired" (amber) via a one-shot probe to `/_atelier/whoami`.
- **`window.__atelier.workspace` removed.** The shell no longer exposes a frozen workspace constant. Modules that need their workspace at runtime derive it from `import.meta.url` (the same `ROUTE.split('/')[0]` they already use for cross-module calls).

### Migrating a v1 module to v2

**Backend (`backend.js`):**
1. Strip `/api/<your-name>/` from every `router.get/post/put/delete/patch(...)` path — make them relative (`router.get('/spaces', ...)`).
2. URLs you return in response bodies should use `'/api/' + ctx.qualifiedId + '/...'` instead of a hardcoded `/api/<your-name>/...` literal. `ctx.qualifiedId` is new in v2.
3. `ctx.broadcast(event)` continues to work — no source change needed; the shell tags the topic with the qualifiedId automatically.

**Frontend (`frontend.jsx`):**
1. Paste the canonical `ROUTE/API/TOPIC` block near the top:
   ```js
   const ROUTE = (() => {
     try {
       return new URL('.', import.meta.url).pathname
         .replace(/^\/modules\//, '').replace(/\/$/, '');
     } catch { return ''; }
   })();
   const API = '/api/' + ROUTE;
   const TOPIC = ROUTE;
   ```
2. Replace every literal `'/api/<your-name>/foo'` with `` `${API}/foo` ``.
3. Replace `window.__atelier.subscribe('<your-name>', ...)` with `window.__atelier.subscribe(TOPIC, ...)`.
4. For cross-module calls, derive once and use: `const WS = ROUTE.split('/')[0]; const PEER_API = `/api/${WS}/<peer>`;`

**Docs (`README.md`, `.claude/skills/**/SKILL.md`):**
- Replace `/api/<your-name>/foo` references with `/api/<workspace>/<your-name>/foo` (use `<workspace>` as a placeholder).
- Replace subscribe topic references with `<workspace>/<your-name>`.

### Known limitations in 0.2.0

- **Workspace modules don't deploy yet.** `npm run atelier -- install` / `update` only ships root-folder modules. `$<ws>/<mod>/` directories are silently skipped by the deploy CLI. The runtime supports workspace modules; the deploy CLI does not. As an interim, use path-config entries (`{ "path": "/path/to/mod", "id": "name" }`) which mount to a flat `~/.atelier/<id>/` destination regardless of source workspace.
- **No per-frame WebSocket ACL filtering.** Every connected client receives every broadcast they subscribe to. Topics are workspace-qualified so cross-workspace leakage isn't possible by accident, but per-user filtering within one workspace would need an auth-module-driven policy push.
- **WS connections survive session invalidation.** `authenticate` runs at upgrade only; an admin force-logout doesn't disconnect existing sockets. The next HTTP request gets 401, so any user action hits the takeover, but idle WS streams continue.
- **Chrome extension `vendor/atelier-downloads-bridge/`** (under `mission-control`) still has hardcoded v1 URL paths. Out-of-band fix when the extension is next updated.

### Files removed / cleaned up

- `wireWorkspaceConstant` IIFE in `client.jsx` (and its only consumer was rewritten to use `import.meta.url`-derived workspace)
- `applyModuleFilter`, the v1 flat-list config parser, the cookie helpers, and `buildAllowedQids` in `atelier.js` / `server.js`
- All v1 URL references in README, AUTH.md, all module READMEs, and all SKILL.md files

### Migration metrics for this rewrite

42 modules migrated. 213 backend route prefixes stripped, 177 frontend literal API URLs rewritten, 34 ROUTE/API/TOPIC blocks inserted, 225 doc URL references swept. 37/42 modules verified booting + responding to a safe read-only endpoint under both global and workspace mounts; the 5 non-200 results were env-config (browser-use needs `BROWSER_USE_API_KEY`), auth-module exclusion, dep-resolution (studio's esbuild reach), and an auth-required surface (tables wants a writer identity).

## 0.1.0 and earlier

Initial scaffold + the v1 workspaces design (`/w/<ws>/<id>` URLs, `?ws=` query precedence, sticky-context localStorage, root-fallthrough rail composition). Captured at git tag `0.1` for reference.
