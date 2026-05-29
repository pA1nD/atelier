# Changelog

Still pre-1.0 — anything in the shell surface (URLs, ctx shape, config schema) can move between minor versions until 1.0. The pace will slow as real users land, but for now: assume any 0.x bump may break a module that hardcoded an internal.

## 0.4.0

**The carve-back — smaller core, production posture.** Atelier shrinks to its three pillars — **modules, workspaces, auth** — and sheds the machinery that grew around them. Several breaking changes; all mechanical.

### Removed

- **The install CLI is gone.** No more `npm run atelier -- install/update/uninstall/status`, no launchd plist, no `/etc/hosts` wiring, no `~/.atelier/` deploy, no rsync. **An instance is just a folder you run** (`npm run dev`, or `node atelier/server.js`). Run two instances as two folders (or one folder with different startup config). `atelier.js` was split into **`build.js`** (the esbuild/Tailwind pipeline) and **`discovery.js`** (discovery rules + config parsing); the install half was deleted. This also drops atelier's only macOS-specific coupling — it now runs anywhere Node does.
- **No default theme.** The shell ships zero pixels and zero visual assumptions. `atelier/builtin-chrome/` was removed; the gruvbox skin lives on as a standalone, opt-in chrome (`gruvbox-chrome/`, peer of `catalyst-chrome`). With no chrome installed the client renders a plain "add a chrome" screen. `index.html` no longer ships a favicon, theme-color, background color, or the Lucide icon library — each chrome injects its own (both shipped chromes now do via an `ensureLucide` IIFE).
- **The dev/prod concept is gone.** Atelier no longer reads or sets `NODE_ENV` and has no environment notion. The config's `{ "modules": { "dev": [...], "prod": [...] } }` object form is removed — `modules` is now a flat array.
- **The frontend cross-module registry is gone.** `window.__atelier.callModule` / `registerModule` / `unregisterModule` / `hasModule` were removed (they existed for an agentic topbar system no longer present). The real cross-module surfaces remain: the WS multiplex (`window.__atelier.subscribe` / `ctx.broadcast`), backend slots (`ctx.module`), and `@atelier/kit`.

### Changed

- **`atelier.config.json` is the instance's source of truth, with three precedence layers: system defaults ← config file ← environment variables** (env wins, so a PaaS can inject a dynamic `PORT`). All settings optional:

  | Setting | Default | Env override | Notes |
  |---|---|---|---|
  | `port` | `1844` | `PORT` | |
  | `baseUrl` | `http://localhost:<port>` | `BASE_URL` | |
  | `chrome` | _(none → election)_ | `ATELIER_CHROME` | path/id of the chrome module; overrides alphabetical election |
  | `hotReload` | `true` | `ATELIER_HOT_RELOAD` | gates all file watchers + backend hot-swap; set `false` when deployed |
  | `auth` | `false` _(ungated)_ | `ATELIER_AUTH` | path/id of the auth module; see below |
  | `label` | `null` | `ATELIER_LABEL` | optional instance name a chrome may show (replaces the dev/prod badge) |
  | `modules` | _(all run)_ | — | flat allow/deny/path/workspace filter (grammar unchanged) |

- **Auth is explicit.** A module exporting `authenticate` no longer auto-claims the gate — you name it via `auth`, or leave `auth: false` to run ungated. This closes the "a stray export silently gates the shell — or a missing one silently exposes it" footgun. An ungated instance whose `baseUrl` isn't localhost logs a startup warning.
- **`ctx.env` → `ctx.label`** and **`window.__ATELIER__.env` → `window.__ATELIER__.label`** (string from config, or `null`).

### Migration

- Replace any `npm run atelier -- install` workflow with running the folder directly; for a "prod" instance, run a second folder whose config sets `auth`, `hotReload: false`, and a `port`.
- Flatten `{ "modules": { "dev": [...], "prod": [...] } }` to `{ "modules": [...] }` per instance folder.
- If you relied on auto-detected auth, add `"auth": "<your-auth-module>"`.
- If a module read `ctx.env`, read `ctx.label` (or drop it).
- A custom chrome must inject its own icon library (the shell no longer ships Lucide) — see `ensureLucide` in either shipped chrome.
- A characterization test suite now ships at `atelier/test/` (`npm test`, zero new deps). Run it after any shell change.

## 0.3.0

**Chrome-slot extraction.** The shell no longer ships any pixels. Every visual concern — rail, topbar, workspace picker, connection banner, takeover wrapping, fonts, colors, scrollbars, design tokens — moved into a `chrome`-slot module. The default `atelier/builtin-chrome/` is shipped inside the shell; any global-workspace module exporting `meta = { chrome: true }` claims the slot and replaces it.

### What changed

- **New slot: `chrome`.** First global-workspace module whose `meta.chrome === true` wins (mirrors the auth-slot pattern). Custom chromes beat the builtin; among customs, alphabetical by qualifiedId. Fallback is `global/atelier-chrome` (the builtin).
- **`atelier/builtin-chrome/`** is the default skin — a real module folder shipped with the shell. `frontend.jsx` exports `chrome(props)` and `meta = { chrome: true, hidden: true }`. `styles.css` carries all Tailwind tokens, fonts, base styles, keyframes. Copy the folder to write a custom skin.
- **Server resolves `chromeQid` per request** and injects it into the bootstrap (`window.__ATELIER__.chromeQid`). The shell's `client.jsx` dynamic-imports the chrome bundle and renders its `chrome` named export as the root component.
- **Shell ships zero visual bytes.** `atelier/styles.css` is gone (moved into the builtin). `index.html` keeps only a one-line inline `<style>` (`html,body{margin:0;background:#1d2021}`) to prevent a white flash before the chrome's CSS lands. `client.jsx` shrunk to a router + bundle loader + error fallback (no Icon, Spinner, TopBar, LeftRail, etc.).
- **Chrome props contract:**
  ```js
  chrome({
    boot,           // { mode, env }
    user,           // post-auth user
    modules,        // [{ qid, id, workspace, hasFrontend, meta }]
    workspaces,     // [{ id, modules }]
    workspace,      // currently routed workspace
    activeQid,      // string | null
    active,         // { kind: 'none' | 'loading' | 'error' | 'ready', element?, err?, qid? }
    loadedModules,  // { [qid]: { hasDefault, TopBarCenter, meta, status, err } }
    navigate,       // (qid: string) => void  (SPA push)
    pickWorkspace,  // (wsId: string) => void  (full reload)
  })
  ```
- **Chrome owns:** rail + topbar + sidebar toggle (⌘\), workspace picker, `ConnectionBanner` (listens to `atelier:connection` events itself), module error boundary, loading + empty + load-error placeholders, lucide MutationObserver, the stylesheet.
- **Shell still owns:** URL routing (`/<ws>/<id>`), `window.__atelier.subscribe` (WS multiplex), `window.__atelier.callModule` (registry), bundle loading, hot-reload subscription, takeover passthrough.
- **Hidden modules in rail.** Modules with `meta.hidden === true` are addressable (assets, bundle imports) but never rendered in the rail. Chrome modules are auto-hidden via `meta.chrome` as well.
- **Tokens, banner, takeover styling — all chrome.** A custom chrome with a different palette is now a CSS-only edit. Takeover (unauth handoff) currently bypasses chrome and renders the auth bundle bare — auth modules ship their own takeover visuals (chrome-wrapped takeover is a future enhancement; see Known limitations).

### Writing a custom chrome

```bash
cp -r atelier/builtin-chrome ~/my-skin
# Edit ~/my-skin/frontend.jsx — same Chrome export, different visuals.
# Edit ~/my-skin/styles.css — new tokens, new layout.
# Register the path in atelier.config.json:
#   { "modules": [{ "path": "~/my-skin", "id": "my-skin" }] }
```

Both `my-skin/frontend.jsx` and `builtin-chrome/frontend.jsx` will be discovered as chrome candidates; `my-skin` wins (custom beats builtin).

### Migrating a v2 module to v3

**Nothing.** Module contract is unchanged. Modules still:
- Export `default function Module()` (rail entry)
- Export `TopBarCenter` (topbar slot — chrome still resolves it)
- Use `window.__atelier.subscribe`, `window.__atelier.callModule`
- Live in `frontend.jsx` / `backend.js`
- See the same `ctx` on the backend (qualifiedId, workspace, broadcast, etc.)

The only architectural change is at the shell level. v2 modules continue to work in v3 unmodified.

### Known limitations in 0.3.0

- **Takeover bypasses chrome.** When the auth module hands off (no user), the shell loads the auth bundle bare — no chrome wrapping, so chrome's `ConnectionBanner` / fonts / colors don't apply during the login flow. Auth modules ship their own takeover visuals. A future commit can pass `chromeQid` into the takeover bootstrap and let the chrome render around the auth body.
- **Builtin chrome bypasses `atelier.config.json` filters.** Even if a user's config excludes everything, the shell still resolves a chrome (otherwise nothing would render). Modules with `meta.chrome === true` from path entries can still be installed and win the slot.
- **CSS scan base is `atelier/`.** Tailwind scans modules' `frontend.jsx` files relative to `HOST_DIR`. Pre-existing behavior; unchanged.

### Files removed / cleaned up

- `atelier/styles.css` (moved into `atelier/builtin-chrome/styles.css`)
- `~70%` of `atelier/client.jsx` (every visual component, lucide observer, helpers)
- `index.html` lost its `<link rel="stylesheet" href="/assets/styles.css">` — replaced by chrome-injected stylesheet
- `/assets/styles.css` now 404s — chrome serves at `/modules/<chromeQid>/styles.css`

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
