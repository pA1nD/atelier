# Changelog

Still pre-1.0 — anything in the shell surface (URLs, ctx shape, config schema) can move between minor versions until 1.0. The pace will slow as real users land, but for now: assume any 0.x bump may break a module that hardcoded an internal.

## 0.8.0

**Multiple chromes per instance, plus a loud-failure / fault-isolation pass.** An instance can now run more than one chrome at once — each module renders inside the chrome it names (a breaking chrome-key rename comes with it). Alongside that, the shell stops failing silent or crashing on a module's mistakes: a backend that won't load, a chrome that throws while rendering, and a module's uncaught async error now each surface *in place* — attributed and isolated — instead of a silent no-op or a whole-shell crash.

### Added
- **Per-module chrome (`meta.chrome`)** — a module renders inside the chrome named by `meta.chrome: '<chromeId>'`, else the instance default. The available chromes come from discovery (every mounted `meta.isChrome` module); the default is the `defaultChrome` setting, else the alphabetically-first mounted chrome. A module pinning a chrome that isn't installed shows a clear **"chrome not installed" error — no silent fallback**. Crossing modules on different chromes is a full page reload (a chrome's `styles.css` + `@atelier/kit` import map are baked per document); navigating within one chrome stays an SPA transition. **With no `meta.chrome` anywhere, behavior is byte-identical to a single-chrome instance.** Shared resolution logic lives in `chrome-resolve.js` (imported by the server, the client, and the tests, so the document's chrome and the client's reload decision can't drift). The `/api` presence-gate and asset infra-exemptions now cover **every** mounted `meta.isChrome` module (via `chromeQids`), not just the single active chrome as in 0.6.1 — required because any module may now pin any mounted chrome, and still operator-controlled (a module can't self-exempt without becoming a chrome, which removes it from every rail).

### ⚠️ Renamed (breaking)
- **Config setting `chrome` → `defaultChrome`** (env `ATELIER_CHROME` → `ATELIER_DEFAULT_CHROME`).
- **`meta.chrome` (boolean, "this module *is* a chrome") → `meta.isChrome`.**
- **`meta.theme` (string, "which chrome this module renders in") → `meta.chrome`.**

### Migration
- In `atelier.config.json`, rename the `chrome` setting → `defaultChrome`.
- In each chrome module, rename `meta.chrome: true` → `meta.isChrome: true`.
- In each themed module, rename `meta.theme: '<id>'` → `meta.chrome: '<id>'`.
- **A chrome that filters its rail on a module's `meta.chrome` must now read `meta.isChrome`** — the bare `meta.chrome` is now the per-module chrome pin (a truthy string), so the old check would hide every themed module from the rail.

### Changed
- **A backend that fails to (re)load now fails *loud*, not silent.** Previously a hot-reload failure was logged to stderr and the old/no backend was silently kept — so an agent editing a backend saw "nothing changed" and had to dig through the launchd log or the shell source to find out why (the most common surprise across past sessions). Now the failure surfaces where the work actually happens: the module's own `/api/<ws>/<id>/*` returns a **`500` carrying the error + the actionable fix** (e.g. *"a node_modules dep can't resolve from the `data:` URL a backend is loaded from — use `createRequire(import.meta.url)('pkg')`"*), and the error is **streamed to the frontend** as a centered, Next.js-style error overlay (streamed live over the WebSocket + seeded into the bootstrap). The overlay is scoped to the **active module** and **auto-clears** the instant the backend reloads cleanly — never dismissed by hand. **Isolated:** keyed by qualifiedId, so only the broken module is affected — viewing any other module's page, the chrome, and the shell keep running normally. The error frame and the bootstrap seed are **delivered under the same per-module ACL as a module's WS frames**, so in an auth-gated multi-tenant instance a backend error — its message and stack — reaches only users who can see that module, never another tenant.
- **A chrome render error no longer blanks the whole client.** The chrome is the React root, so a throw in its render used to crash everything (a blank page) *and* take down the WS/hot-reload listener, so a fix couldn't auto-recover. A shell-level error boundary now contains it: a centered "Chrome Error" overlay shows the error, the rest of the client stays mounted, and **editing the chrome auto-reloads to recover** — no manual reload. (A *module's* render error was already caught by the chrome's own boundary.)
- **A module's uncaught async error no longer crashes the shell.** A backend that throws *outside* a request — a rogue `setInterval`, an unhandled rejection in a background task — used to take the whole shell down (deliberately, with an attributing crash banner). It's now **attributed to the module and isolated**: surfaced via that module's `500` + overlay, while the shell and every other module + connected user stay alive. A genuinely *shell-level* fault (no module in the stack) still crashes loudly. Limits: a synchronous infinite loop, `process.exit()`, or OOM in a module are still fatal — in-process isolation isn't a sandbox. Documented under **Error handling** in MODULES.md.
- **Explicit instance root via `ATELIER_ROOT`.** The folder modules are discovered in is still inferred from `PWD` by default (unchanged), but a managed launcher (launchd/systemd/Docker/PaaS) that doesn't reliably set `PWD` can now set `ATELIER_ROOT=/path/to/instance` to name it explicitly. The resolved root is printed at startup (`Atelier · <mode> · <root> · env=<env>`) so a misconfigured launch is obvious instead of silently discovering the wrong folder.
- **React/ReactDOM are vendored, not CDN-loaded.** They're now `dependencies` in `package.json` (pinned `18.3.1`) and served by the shell from `node_modules` at `/assets/react.js` + `/assets/react-dom.js`, instead of `index.html` fetching them from `unpkg.com`. A fresh checkout boots offline, with no third-party runtime dependency. The ambient `window.React` / shim architecture is unchanged.
- **`env` setting (`NODE_ENV`) — frontend build mode + dev warnings.** `development` (the default, matching an unset `NODE_ENV`) serves the unminified React UMD and defines the bundle's `process.env.NODE_ENV=development`, so **React + bundled-library dev warnings show while you develop** (invalid hooks, missing keys, readable errors); `production` **minifies the chrome bundle** (dropping the large inline source map), strips bundled-library dev branches via the `process.env.NODE_ENV` define, and serves the minified React UMD. It's the bare `NODE_ENV` (like `PORT`/`BASE_URL`), `env` in the config, and **independent of `hotReload`** (two separate knobs). This *deliberately re-introduces atelier reading `NODE_ENV`*, which 0.4.0 had removed — but scoped narrowly to the frontend build, not a sweeping dev/prod mode.
- **A JS `import` of CSS now fails the bundle loudly** with an actionable error, instead of being silently dropped. Chrome styles ship via `styles.css` + the render-blocking `<link>`, never a JS `import`.
- **`meta` is read statically, without running `frontend.jsx`.** Discovery now parses the top-level `meta` object literal from source rather than transform-and-importing the module first; the import path remains only as a fallback for a computed/spread `meta`. A frontend's top-level code no longer executes in Node at discovery (and it's faster).

### Removed
- **The undocumented `atelier.requires` README-frontmatter feature** (and its hand-rolled YAML-subset parser) — it only ever logged an advisory warning, no module used it, and nothing was documented.

### Tests
- Five new suites cover the release's server-observable surface: multi-chrome resolution + election (`server-multichrome`, `chrome-resolve`), backend load-failure `500` + bootstrap seed (`backend-error`), module uncaught-async isolation (`crash-isolation`), the dev/prod React UMD swap + loud `.css`-import error (`bundle`), and `ATELIER_ROOT` precedence (`root`). Suite now 83.

### Docs
- MODULES.md gains a **Per-module chrome — `meta.chrome`** section and an **Error handling** section (the failure surfaces and how each is isolated); docs/README.md's settings table adds the `env`, `defaultChrome` (`ATELIER_DEFAULT_CHROME`), and `ATELIER_ROOT` rows and lists `chrome-resolve.js` among the shell files.

## 0.7.0

**Per-module URL sub-routing (`useRoute`) + the workspace context is now derived purely from the URL.** Modules get a real, deep-linkable subpath below `/<ws>/<id>` without touching `history.*`; in exchange, the sticky per-tab workspace from 0.6.0 is gone — the address bar is the single source of truth for which workspace you're in. One additive API, one behavior change to know about (the rail no longer carries global modules into every workspace).

### ⚠️ Behavior change — workspace selection & rail composition
- **The current workspace is derived from the URL; the sticky per-tab choice (`sessionStorage('atelier:ws')`) introduced in 0.6.0 is removed.** Navigating anywhere switches workspace because it switches the URL. Clicking a **global** module now enters the `global` workspace instead of staying in your current one (the 0.6.0 "stay put" behavior is reverted).
- **The rail shows only the current workspace's own modules.** `global` is now a normal workspace, not a shared baseline — its modules appear in the rail only when you're in `global`, no longer alongside every workspace's modules. **Upgrade note for multi-workspace instances:** a global module (global search, settings, etc.) that you relied on being present in *every* workspace's rail will no longer appear in non-`global` rails. No module API changed and nothing a module hardcoded breaks — but the on-screen rail composition does. (Rail rendering itself lives in the chrome; the shell change is the workspace derivation + what it hands the chrome.)
- **The workspace picker now navigates in-page (SPA `pushState`)** instead of forcing a full page reload — every workspace's bundles are already loaded client-side and the rail/active module derive from the URL, so the WebSocket stays connected. It hard-reloads only when the preserved module was marked dirty by hot reload (mirrors a rail click).

### Added
- **`window.__atelier.useRoute()` → `{ path, navigate }`** — per-module URL sub-routing. The shell owns exactly two segments (`/<ws>/<id>`); everything after is the module's own free-form space. `path` is the subpath (`''` at the module root); `navigate(sub, { replace })` pushes/replaces `/<ws>/<id>/<sub>`. Back/forward, deep-links, refresh, and `navigate()` all re-render the module with the new `path` — **no remount**, so component state, effects, and WebSocket subscriptions survive (a module's WS topic is its qid, never the route). Opt-in; `location.hash`/`?query` still work. Exposed on `window.__atelier` the same way as `self`/`subscribe`, so the chrome stays uninvolved. Documented in MODULES.md → **Frontend routing**.
- **Deep-path SPA fallback** — the server now serves `index.html` for `/<ws>/<id>/<rest…>`, so a `useRoute` deep-link or refresh lands the module with its subpath intact. Can't shadow assets: module assets live under `/modules/` and `/api/`, never under `/<ws>/<id>/…`.

### Changed
- **CSS class scan walks every module's directory, not just chrome modules.** A non-chrome module that splits its UI across sibling files (not just `frontend.jsx`) now gets Tailwind classes generated from all of them — previously only the chrome was walked and a feature module's non-`frontend.jsx` classes were silently dropped. `walkJsxFiles` now also skips `backend.js` (server-only) and `[._-]`-prefixed names, mirroring exactly what the asset server refuses to serve, so the scanner only sees client-reachable source. The scan no longer needs each module's `meta`.

### Docs
- New **Frontend routing** section in MODULES.md (the `useRoute` contract, deep-link/no-remount guarantees, the "shell owns `/<ws>/<id>`" boundary); `meta.icon` clarified (name a string, don't import an icon library); sidecar pattern notes (public-sidecar child-process isolation, origin-nonce technique) added as examples-not-rules.
- WORKSPACES.md rail & picker section rewritten to the URL-derived model above.

## 0.6.1

**Docs reorganized into four navigable pages + two non-breaking security fixes for the asset/API boundary.** A contract audit confirmed 0.6.0's surface needs no breaking changes for 1.0; this patch closes two boundary gaps it surfaced (fixed *before* any freeze, not after) and makes the docs both accurate and navigable.

### Security
- **Symlink-safe module asset serving** — the `/modules/<ws>/<id>/<rest>` containment check was lexical (`path.resolve`), which doesn't follow symlinks; a symlink planted inside a module dir could escape it and serve host files / another tenant's `data/` to any authed user. It now re-asserts containment against the real (symlink-resolved) path. Verified it still serves legit assets through symlinked module dirs (the symlinked-instance shape, e.g. a path-mounted chrome).
- **A module can no longer self-exempt from the `/api` gate** — the infra-exemption keyed off the *target module's own* `meta.chrome`/`meta.hidden`, so a (possibly vibe-coded) module could remove its entire API from both the presence gate and `authorize` by declaring `hidden: true`. It now keys off the server-resolved active chrome (`resolveChromeQid`) only. The trusted layer stays unbypassable by module declaration — restoring the core invariant that a feature module is never the boundary.

### Docs
- Split the single docs page into four renderer pages — **Atelier**, **Modules**, **Workspaces**, **Auth** — each its own page in the docs viewer; added a consolidated **Folder & file conventions** table in Modules (every reserved name, prefix, and special file in one place) that the other pages point at instead of duplicating.
- Accuracy pass against the code: a standalone unknown id is **fatal** (was "never fatal"); only config **path** misses warn (bare-name typos drop silently); `$<reserved>/` warns (was "silently skipped"); backend hot-reload fires on `.js` only; updated the gate-exemption wording to match the fix above; verified every cross-doc anchor resolves.

### Tests
- Added a symlink-escape guard (an asset can't escape its module dir via symlink) and a "hidden module can't self-exempt" regression; the `http-acl` `widget` fixture is now the active chrome. Suite now 60.

## 0.6.0

**Multi-tenant HTTP access control + the `authorize` hook, workspace-aware module WebSockets, and a contract-accuracy pass toward a stable 1.0.** The HTTP API now enforces the same per-module boundary the WS ACL does, and the auth module can enforce *below* the boundary (read/write, payload) — completing the trusted-enforcement model across all three surfaces (frontend, HTTP, WS). Enforcement lives only in the shell and the trusted auth module; a feature module (which may be vibe-coded) is never the boundary. A contract audit found no breaking changes needed for 1.0 — the surface is additive-extensible; this release makes the docs match it.

### Added
- **HTTP presence gate** — every `/api/<ws>/<id>/…` request is checked against the user's `user.workspaces` (`userModuleSet`) before dispatch; not in it → `403`. Closes the cross-tenant hole where any authed user could call any module's API (the HTTP twin of 0.5.0's WS ACL). No-op on ungated instances; the configured auth module's own routes are exempt (you can't gate the gate).
- **`authorize(req, user, target)` auth-slot hook (optional)** — runs after the presence gate and before the module router, with `target = { qualifiedId, method, path }` and a memoized `req.json()` (the module handler shares the same parse — a request body is read once). Falsy/throw → `403`; a thrown `statusCode` is honored (e.g. a `413` from an oversized body). This is the trusted home for below-module policy: read vs write, sub-resource rules, payload inspection.
- **Infrastructure modules are exempt from the presence gate** — a chrome or any `hidden` module. Infra is excluded from `buildDefaultUser`, so it's in nobody's `user.workspaces`; without this, the active chrome's own API (e.g. its `/docs`) `403`'d for every authed user. Exempted alongside the auth module's own routes.
- **`window.__atelier.self(import.meta.url)`** — workspace-aware frontend self-identity: `{ workspace, id, qid, topic, api, subscribe(cb) }`. A module subscribes to its own `<ws>/<id>` topic and builds its API path without ever hardcoding the workspace — the WS analog of how backend routes are workspace-scoped, so the same bundle is portable across workspaces. Backend `ctx.broadcast` still always stamps the topic with the module's qualifiedId; it now logs a dev-time warning if a module passes a hardcoded `topic`.

### Changed
- **`docs/AUTH.md`** now opens with the **three-pillars** mental model (frontend / HTTP / WS) and the **`authenticate` → presence → `authorize`** request lifecycle — what each hook is for and what happens between them.
- **`allowedTopics` builds on a shared `userModuleSet`** — one source of truth for the module boundary across the rail (frontend), the HTTP presence gate, and the WS ACL.
- **Sticky per-tab workspace (`client.jsx`)** — the selected workspace now persists per browser tab (`sessionStorage`). Clicking a **global** module keeps you in your current workspace instead of switching to `global`; only entering a workspace module (in the rail or via a direct URL) or the workspace picker changes it. Different tabs can hold different workspaces.

### Tests
- `test/http-acl.test.js` + an `http-acl` fixture (a gate exporting `authenticate` + `authorize`, plus feature modules + a `hidden` infra module): cross-tenant `403`, read-grant allows GET / denies POST, write-grant POST where the handler sees the body `authorize` already read, payload-level deny, auth-module-route exemption, infra-module exemption, and the ungated no-op. Suite now 58.

### Docs (freeze-readiness)
- `README.md` + `AUTH.md` made accurate + complete toward a 1.0 freeze: the full `meta` set (`icon`/`name`/`group`/`primary`/`hidden`/`chrome`/`color`), the `revalidateMs` config row, `user.logout` (chrome sign-out convention) + `modules[].access`, `ctx` documented as a closed set (no `cors`), and the workspace-aware WS pattern (use `self()`, never hardcode a topic). Removed stale carve-back references (the Lucide `data-lucide` icon convention → now "the chrome renders `meta.icon`").

## 0.5.0

**Multi-tenant WebSocket access control.** The shared WS now enforces per-module permissions, so one instance can safely host multiple tenants.

### Added
- **Per-module WS ACL** — `wsBroadcastFromModule` delivers a module's frames only to clients whose user can see that module, keyed off the same `user.workspaces[].modules[]` the chrome renders the rail from. Per-module (not just per-workspace); `global` modules are gated identically (no exception); only the `'shell'` topic always sends. `ws.allowed` is precomputed at the WS upgrade → O(1) per frame, so it scales to hundreds of concurrent sockets.
- **Live session re-validation** — every `revalidateMs` (default `30000`; env `ATELIER_REVALIDATE_MS`) each open socket re-runs `authenticate`: `null` → close (code `4001`); a changed user → refresh `ws.user` + `ws.allowed`. Revocation *and* mid-session permission changes propagate without a reconnect. Runs only when an auth module is configured.

### Changed
- **`user.workspaces[].modules` is now a security boundary**, not just a rail hint — the auth module must return it accurately and completely. `docs/AUTH.md` rewritten (the two "not implemented" WS sections are now the real model).

### Tests
- `test/ws-acl.test.js` + a multi-tenant fixture (two orgs, per-module membership): cross-org + per-module isolation, global-module gating, revoke-closes-socket, grant-flows-after-revalidation. Suite now 50.

## 0.4.0

**The carve-back — smaller core, production posture.** Atelier shrinks to its three pillars — **modules, workspaces, auth** — and sheds the machinery that grew around them. Several breaking changes; all mechanical.

### Removed

- **The install CLI is gone.** No more `npm run atelier -- install/update/uninstall/status`, no launchd plist, no `/etc/hosts` wiring, no `~/.atelier/` deploy, no rsync. **An instance is just a folder you run** (`npm run dev`, or `node atelier/server.js`). Run two instances as two folders (or one folder with different startup config). `atelier.js` was split into **`build.js`** (the esbuild/Tailwind pipeline) and **`discovery.js`** (discovery rules + config parsing); the install half was deleted. This also drops atelier's only macOS-specific coupling — it now runs anywhere Node does.
- **No default theme.** The shell ships zero pixels and zero visual assumptions. The former built-in chrome was removed; a skin now lives as a standalone, opt-in chrome you install. With no chrome installed the client renders a plain "add a chrome" screen. `index.html` no longer ships a favicon, theme-color, background color, or the Lucide icon library — each chrome injects its own (e.g. via an `ensureLucide` IIFE).
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
- A custom chrome must inject its own icon library (the shell no longer ships Lucide) — see the `ensureLucide` pattern in a chrome's `frontend.jsx`.
- A characterization test suite now ships at `atelier/test/` (`npm test`, zero new deps). Run it after any shell change.

## 0.3.0

**Chrome-slot extraction.** The shell no longer ships any pixels. Every visual concern — rail, topbar, workspace picker, connection banner, takeover wrapping, fonts, colors, scrollbars, design tokens — moved into a `chrome`-slot module. The default `atelier/builtin-chrome/` is shipped inside the shell; any global-workspace module exporting `meta = { chrome: true }` claims the slot and replaces it.

### What changed

- **New slot: `chrome`.** First global-workspace module whose `meta.chrome === true` wins (mirrors the auth-slot pattern). Custom chromes beat the builtin; among customs, alphabetical by qualifiedId. Fallback is `global/builtin-chrome` (the builtin).
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

### Files removed / cleaned up

- `wireWorkspaceConstant` IIFE in `client.jsx` (and its only consumer was rewritten to use `import.meta.url`-derived workspace)
- `applyModuleFilter`, the v1 flat-list config parser, the cookie helpers, and `buildAllowedQids` in `atelier.js` / `server.js`
- All v1 URL references in README, AUTH.md, all module READMEs, and all SKILL.md files

### Migration metrics for this rewrite

42 modules migrated. 213 backend route prefixes stripped, 177 frontend literal API URLs rewritten, 34 ROUTE/API/TOPIC blocks inserted, 225 doc URL references swept. 37/42 modules verified booting + responding to a safe read-only endpoint under both global and workspace mounts; the 5 non-200 results were env-config, auth-module exclusion, dep-resolution, and an auth-required surface.

## 0.1.0 and earlier

Initial scaffold + the v1 workspaces design (`/w/<ws>/<id>` URLs, `?ws=` query precedence, sticky-context localStorage, root-fallthrough rail composition). Captured at git tag `0.1` for reference.
