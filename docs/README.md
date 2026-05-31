# Atelier

The app shell + module runner. Discovers sibling modules, mounts their backends, serves their frontends, and renders whatever **chrome** (theme) you install around them — one runtime hosting many small modules.

> **Platform.** Atelier runs anywhere **Node 24+** does — there's no OS-specific install layer (an instance is a folder you run; your process manager / PaaS / reverse proxy is your concern). Recursive file-watching (hot reload) works on macOS, Linux, and Windows on Node 24.

**The rest of the docs:**
- **[Modules](./MODULES.md)** — building a module (shape, `ctx`, real-time, hot-reload, slots), plus the special modules: the **chrome** and a pointer to auth.
- **[Workspaces](./WORKSPACES.md)** — the multi-tenant model: `global` + `$<ws>/`, the `qualifiedId`, the rail and picker.
- **[Auth](./AUTH.md)** — the trusted auth slot: `authenticate` / `authorize`, the `user` object, request gating across all three surfaces.

This page is the shell itself: running an instance, what lives in `atelier/`, and configuration.

## Running an instance

An atelier instance is a **folder you run** — there is no install step, no launchd, no `~/.atelier/`. The folder holds (or path-mounts via config) your modules and a chrome, plus an optional `atelier.config.json`.

```
npm install
npm run dev                                # http://localhost:1844 (PORT= to override), hot reload
npm run dev:module -- <id>                 # standalone — just one module
npm run dev:module -- <workspace>/<id>     # standalone — a workspace module
```

`npm run dev` is just `node server.js`. Point a browser at the port; you'll see an "add a chrome" screen until a chrome is installed (the shell ships none). Standalone mode (`dev:module`) runs a single module in isolation — it shows no chrome unless the requested module is itself one.

### One folder = one instance

There is no dev/prod mode. To run a second instance — a "production" one, staging, a per-tenant one — **run a second folder** (or the same folder with different startup settings). Each instance's behavior is resolved from three layers, lowest to highest:

1. **System defaults** — `port: 1844`, `hotReload: true`, `auth: false`, no chrome.
2. **`atelier.config.json`** in the instance folder — the source of truth (see [Configuration](#configuration--discovery)).
3. **Environment variables** at startup — they override the file, so a PaaS can inject a dynamic `PORT` / `BASE_URL`.

A typical "production" folder sets something like `{ "hotReload": false, "auth": "<auth-module>", "chrome": "<chrome>", "port": 1844 }` and sits behind your own reverse proxy. atelier doesn't manage processes, TLS, or hostnames — that's your platform's job.

## What lives in `atelier/`

- `server.js` — runner, router, discovery, settings resolution (defaults ← config ← env), WebSocket multiplex (`/_atelier/ws`), hot-reload broadcaster, the auth slot, chrome-slot resolution.
- `build.js` — build pipeline (esbuild JSX + Tailwind v4 + oxide).
- `discovery.js` — discovery rules (reserved names, workspaces) + `atelier.config.json` parsing.
- `index.html` — template; React + ReactDOM UMD. A single inline rule resets margins and hints `color-scheme`; the shell paints zero pixels (no favicon, theme-color, or icon library — those belong to the chrome).
- `client.jsx` — slim router + bundle loader + error fallback. Loads the chrome bundle (`chromeQid` resolved server-side) and renders it as the root; wires the WS multiplex + `window.__atelier.self` / `.subscribe`.

The shell defines **no design tokens** — they live in the active chrome's `styles.css`, injected via `<link>` at load. Chromes are ordinary (hidden, global) modules; two ship in the repo to copy — `catalyst-chrome/` (publishes `@atelier/kit`) and `gruvbox-chrome/`. How to write one is in [Modules → the chrome](./MODULES.md#special-module-the-chrome).

## Configuration & discovery

### Selecting which modules are enabled — `atelier.config.json`

Optional, and the instance's source of truth. Without it, every discovered module runs with system defaults. With it, you set instance **settings** and **filter** which modules run. Drop it at the instance root (next to `atelier/`):

```json
{
  "label": "studio",
  "port": 1844,
  "chrome": "~/skins/catalyst-chrome",
  "hotReload": true,
  "auth": false,
  "modules": ["kanban", "polish", { "workspace": "bigcorp", "modules": ["!wip"] }]
}
```

#### Settings

All optional; resolved **defaults ← config ← environment** (env wins, so a PaaS can inject a dynamic port):

| Key | Default | Env | Meaning |
|---|---|---|---|
| `port` | `1844` | `PORT` | listen port |
| `baseUrl` | `http://localhost:<port>` | `BASE_URL` | external URL modules build links from |
| `chrome` | _(election)_ | `ATELIER_CHROME` | path/id of the chrome module; overrides alphabetical election among installed chromes |
| `hotReload` | `true` | `ATELIER_HOT_RELOAD` | file watchers + backend hot-swap; set `false` when deployed |
| `auth` | `false` | `ATELIER_AUTH` | path/id of the auth module, or `false` to run ungated (see [AUTH.md](./AUTH.md)) |
| `revalidateMs` | `30000` | `ATELIER_REVALIDATE_MS` | how often live WebSocket sockets re-run `authenticate` (only when `auth` is set) — so logout/permission changes propagate without a reconnect; see [AUTH.md](./AUTH.md) |
| `label` | `null` | `ATELIER_LABEL` | optional instance name a chrome may display |
| `modules` | _(all run)_ | — | the module filter below |

#### Module filter — top-level entries

Each entry in a list is one of:

| Entry | Meaning |
|---|---|
| `"foo"` | Include the global module `foo` (= `global/foo`) |
| `"!foo"` | Deny the global module `foo` |
| `"./path"`, `"~/path"`, `"/abs/path"` | Mount the directory as a global module. `id` defaults to `basename(path)` |
| `{ "path": "./dir" }` | Same. Allow `"id": "..."` to override the dir name |
| `{ "workspace": "bigcorp" }` | Include all of workspace `bigcorp` |
| `{ "workspace": "!bigcorp" }` | Deny all of `bigcorp` |
| `{ "workspace": "bigcorp", "modules": [...] }` | Include `bigcorp` with an internal filter — the same bare-name / `!deny` / path rules apply to its `modules:` |

#### How the filter behaves

- **No config file (or no `modules` key)** — everything runs.
- **List has any allow markers** (bare name, path, `{workspace: "ws"}`, or `{workspace: "ws", modules: [...]}`) → **allow mode**: only explicitly listed things run. Workspaces not listed are excluded entirely.
- **List has any deny markers** (`"!foo"`, `{"workspace": "!ws"}`) → **deny mode**: everything runs *except* the listed denials. Workspaces not denied stay included.
- **Mixing allow + deny at the same level** → config error, filter falls back to "no filter applied at this level" (everything runs). A one-line warning logs at startup.
- **Empty list `[]`** → "filter to nothing" at this scope.
- **Paths are additive** — they always mount, regardless of allow/deny mode. They bypass the name filter.
- **Inside a workspace's `modules: [...]`** — the same bare-name / deny / path rules apply (you can't nest a `{ "workspace" }` object one level deeper). Bare names refer to that workspace's modules. Paths inside a workspace default to `<that-workspace>/<basename>`.

#### Examples

```json
{ "modules": ["kanban"] }
```
Only `global/kanban`. No workspaces.

```json
{ "modules": ["!archived"] }
```
All globals except `archived`. All workspaces, untouched.

```json
{ "modules": [{ "workspace": "bigcorp" }] }
```
Only `bigcorp`, all its modules. No globals, no other workspaces.

```json
{ "modules": ["kanban", { "workspace": "bigcorp", "modules": ["!wip"] }] }
```
`global/kanban` + all of `bigcorp` except `bigcorp/wip`.

```json
{ "modules": ["~/work/external-mod", "kanban"] }
```
`global/kanban` + the external folder mounted as `global/<basename>`. No workspaces.

#### When the filter applies

The `modules` filter is re-read **per request**, so editing it is live: when `hotReload` is on, the file change triggers a reload; backends no longer in the list are unmounted on the next reconcile, and newly-listed ones mount on the next request. (Settings — `port`, `chrome`, `auth`, etc. — are read once at startup; changing them needs a restart.)

#### Bypass — standalone mode

`npm run dev:module -- <id>` (i.e. `node server.js <id>`) loads just that one module regardless of the filter. A bare id resolves to `global/<id>`; pass `<workspace>/<id>` for a workspace module. A standalone id that resolves to no module **fails fast** — the shell lists the available modules and exits. (A typo in `atelier.config.json` is never fatal by contrast: an unresolvable **path** entry warns once, and an unknown bare name is silently dropped by the filter.)

### What counts as a module

`discoverModules` walks the instance root and treats any sibling directory with a `frontend.jsx` or `backend.js` as a module — skipping reserved names, `_`/`.`-prefixed folders, and recursing into `$<ws>/` workspaces. The complete set of special names, prefixes, and files is in **[Modules → Folder & file conventions](./MODULES.md)**.
