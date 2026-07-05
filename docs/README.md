# Atelier

The app shell + module runner. Discovers sibling modules, mounts their backends, serves their frontends, and renders whatever **chrome** (theme) you install around them — one runtime hosting many small modules.

## Why atelier is shaped this way

Atelier is a **harness for building apps fast — especially with coding agents.** Its shape is deliberate: it fixes the things that are hard to get right *across* an app, so each app you build can stay small, self-contained, and safe. It is a separation of concerns into three layers, frozen-to-flexible:

- **The shell is the fixed baseline.** It owns the cross-cutting machinery — the build step, routing, the real-time WebSocket, hot reload, workspaces, auth, and the module boundary. These are *frozen*: you build **on** them, you never rebuild them, and because they don't move you can trust them.
- **The chrome owns visual coherence.** One theme wraps every app, so dozens of independently-built apps look like one product — and no single app can reach in and restyle the whole system. Visuals are the chrome's job, not each app's.
- **A module is just your feature** — a `frontend.jsx` and/or a `backend.js`. No build to configure, no dependencies to vendor, no design system to invent. Thin by design.

**The constraints are the point.** By freezing the baseline and the visuals, every app stays **small enough to fit in one context window** — small enough that an agent (or a person) can hold the whole thing in its head, hammer out the feature, and never touch the parts that would break everything else. The things you *can't* easily do here — bring your own React, router, or bundler, or restyle the shell — are exactly the things that would make an app large, inconsistent, or unsafe. What looks like a limitation is a paved path: it removes the setup, dependency, and consistency work that derails a build, and leaves you writing the one thing that matters — the feature.

The payoff: **many small, independent codebases compose into one large, coherent, multi-tenant system.** Each module is a context-window-sized unit of work; the shell and the chrome are what let dozens of them add up to something far bigger than any one of them — sharing one runtime, one React instance, one visual language, and one trust boundary.

## What each layer can and can't do

The split above is enforced by *how each layer is built and loaded* — so the mechanism tells you exactly what's possible, and keeps you from fighting the harness.

**The shell** — the frozen core (`server.js`, `build.js`, `discovery.js`, `client.jsx`, `chrome-resolve.js`).
- *Owns:* discovery, routing (`/<ws>/<id>`), the build pipeline, the single WebSocket multiplex, hot reload, workspaces, the auth slot + module boundary, and the `window.__atelier` / `ctx` surface.
- *A module can't touch it* — no adding middleware, changing routing, opening a second socket, or widening `ctx`. **Why good:** the contract every module depends on stays stable and trustworthy; changing the core is a deliberate edit, never a side effect of a feature.

**The chrome** — visuals (one global module, `meta.isChrome`).
- *Can:* ship a real component library + icon set — it's **fully bundled** by esbuild with its own `node_modules` and bare-specifier imports — publish primitives via `@atelier/kit`, and own the rail / topbar / fonts / colors / tokens / `styles.css`.
- *A module can't restyle the shell or override the chrome* — it renders *inside* its assigned chrome and borrows the chrome's kit + tokens. **Why good:** dozens of independently-built apps stay visually coherent, and no one app can break the look of the whole.

**A module frontend** (`frontend.jsx`) — transformed **per-file** (not bundled), sharing the shell's single React via a global.
- *Can:* be a React component with hooks, subscribe to its own real-time topic (`self().subscribe`), deep-route within its subpath (`useRoute`), and import sibling files + `@atelier/kit`.
- *Can't `import` an npm package or icon library, and must not `import React`* — only `react` / `react-dom` / `@atelier/kit` resolve, and JSX compiles to the global `React.createElement`. **Why good:** zero per-module build + instant hot-reload, and one React instance — so hooks, context, and the live channel work *across* the module/shell/chrome boundary instead of fracturing into N Reacts.

**A module backend** (`backend.js`) — bundled with dependencies kept **external**, hot-loaded from a `data:` URL.
- *Can:* mount scoped routes under `/api/<ws>/<id>`, `ctx.broadcast`, persist under `ctx.dataDir`, keep long-lived state across reloads via `ctx.module`, and import sibling files.
- *Can't statically `import pkg from 'pkg'` for a node_modules dependency* — a `data:` URL has no path to resolve bare specifiers from; load them with `createRequire(import.meta.url)('pkg')`. **Why good:** the whole backend hot-swaps atomically with no process restart — edit a handler and it's live.

**Across all of them, the shell owns the tenant gate.** Which users reach which workspaces is enforced from `user.workspaces` — never from a module's self-declared `meta` — and a module can't exempt its routes or topics from the gate. **Why good:** a sloppy or vibe-coded module can't *accidentally* serve one tenant's data to another, because auth was never its job. The flip side is stated just as plainly: module **code** is trusted like any dependency — a backend runs in the shell's process and can open sidecars or touch the disk — so install modules the way you install packages: from authors you trust.

> **Platform.** Atelier runs anywhere **Node 24+** does — there's no OS-specific install layer (an instance is a folder you run; your process manager / PaaS / reverse proxy is your concern). Recursive file-watching (hot reload) works on macOS, Linux, and Windows on Node 24.

**The rest of the docs:**
- **[Install](./INSTALL.md)** — creating an instance (`npm create`), installing modules (`atelier add`), marketplaces & kits, and the shipping convention.
- **[Modules](./MODULES.md)** — building a module (shape, `ctx`, real-time, hot-reload, slots), plus the special modules: the **chrome** and a pointer to auth.
- **[Workspaces](./WORKSPACES.md)** — the multi-tenant model: `global` + `$<ws>/`, the `qualifiedId`, the rail and picker.
- **[Auth](./AUTH.md)** — the trusted auth slot: `authenticate` / `authorize`, the `user` object, request gating across all three surfaces.

This page is the shell itself: running an instance, what lives in `atelier/`, and configuration.

## Running an instance

An atelier instance is a **folder you run** — no launchd, no `~/.atelier/`. The folder holds (or path-mounts via config) your modules and a chrome, plus an optional `atelier.config.json`. The shell itself can live in either of two places:

**As a dependency** — `npm install @pa1nd/atelier`, or scaffold a fresh instance with `npm create @pa1nd/atelier my-studio` — optionally pulling a whole **starter kit** of modules (chrome included) with `-- --kit <kit>`; kits and specs are the scaffolder's feature, documented at [create-atelier](https://github.com/pA1nD/create-atelier). The shell runs itself from `node_modules` via its `atelier` bin:

```
npx atelier                                # http://localhost:1844 (PORT= to override), hot reload
npx atelier <id>                           # standalone — just one module
npx atelier <workspace>/<id>               # standalone — a workspace module
```

**As a subfolder** — a checkout of this repo at `<instance>/atelier/`:

```
npm install
npm run dev                                # http://localhost:1844 (PORT= to override), hot reload
npm run dev:module -- <id>                 # standalone — just one module
npm run dev:module -- <workspace>/<id>     # standalone — a workspace module
```

Either way it's the same server (`npm run dev` and the `atelier` bin are both just `server.js`). Install modules into the instance with **`npx atelier add <spec>`** — see [Install](./INSTALL.md). Point a browser at the port; you'll see an "add a chrome" screen until a chrome is installed (the shell ships none). Standalone mode runs a single module in isolation — it shows no chrome unless the requested module is itself one.

> **Which folder is the instance?** Resolved in priority order: **1.** `ATELIER_ROOT=/path/to/instance` — explicit; for **managed launchers** (launchd, systemd, Docker, a PaaS) that may not set `PWD`, and for monorepos whose hoisting puts the shell in the repo-root `node_modules`. **2.** Shell installed as a dependency — the instance is the folder that *owns* the `node_modules` the shell runs from (a pnpm nested store resolves to the consumer project, not the store). **3.** Subfolder layout — the parent of the folder you run from, inferred from `PWD` (your shell's logical working directory — so it still points at the instance even when `atelier/` is a shared symlink). The resolved root is printed at startup (`Atelier · <mode> · <root> · env=<env>`), so a wrong one is obvious.

### One folder = one instance

There is no dev/prod mode. To run a second instance — a "production" one, staging, a per-tenant one — **run a second folder** (or the same folder with different startup settings). Each instance's behavior is resolved from three layers, lowest to highest:

1. **System defaults** — `port: 1844`, `hotReload: true`, `auth: false`, no chrome.
2. **`atelier.config.json`** in the instance folder — the source of truth (see [Configuration](#configuration--discovery)).
3. **Environment variables** at startup — they override the file, so a PaaS can inject a dynamic `PORT` / `BASE_URL`.

A typical "production" folder sets something like `{ "hotReload": false, "auth": "<auth-module>", "defaultChrome": "<chrome>", "port": 1844 }` and sits behind your own reverse proxy. atelier doesn't manage processes, TLS, or hostnames — that's your platform's job.

## What lives in `atelier/`

- `server.js` — runner, router, discovery, settings resolution (defaults ← config ← env), WebSocket multiplex (`/_atelier/ws`), hot-reload broadcaster, the auth slot, chrome-slot resolution.
- `build.js` — build pipeline (esbuild JSX + Tailwind v4 + oxide).
- `discovery.js` — discovery rules (reserved names, workspaces) + `atelier.config.json` parsing.
- `index.html` — template; React + ReactDOM UMD. A single inline rule resets margins and hints `color-scheme`; the shell paints zero pixels (no favicon, theme-color, or icon library — those belong to the chrome).
- `client.jsx` — slim router + bundle loader + error fallback. Loads the chrome bundle (`chromeQid` resolved server-side) and renders it as the root; wires the WS multiplex + `window.__atelier.self` / `.subscribe`.
- `chrome-resolve.js` — the *one* implementation of "which chrome does a module render in?" (`meta.chrome` → default). Imported by `server.js` (Node), by `client.jsx` (browser, served at `/assets/chrome-resolve.js`), and by the tests — so the document's chrome and the client's SPA-vs-reload decision can't drift.

**Shell files are pinned to the running process.** Unlike modules (which hot-reload), `server.js`, `build.js`, `discovery.js`, `client.jsx`, and `chrome-resolve.js` only take effect on an **explicit restart**. The shell's served bytes — the `/assets/client.js` bundle and the `index.html` template — are built/read **once at process start** and held for the process lifetime, so the running server and what it ships to the browser always match; editing a shell file can never half-apply (a freshly-recompiled client against a stale server). This is deliberate: a change to the cross-cutting core should be a conscious restart, not a silent live-swap. (Module and chrome bundles under `/modules/*` are *not* pinned — they hot-reload, which is the point of a module.)

The shell defines **no design tokens** — they live in the active chrome's `styles.css`, injected via `<link>` at load. Chromes are ordinary (hidden, global) modules you install or write — **none ships with the shell**. How to write one is in [Modules → the chrome](./MODULES.md#special-module-the-chrome).

## Configuration & discovery

### Selecting which modules are enabled — `atelier.config.json`

Optional, and the instance's source of truth. Without it, every discovered module runs with system defaults. With it, you set instance **settings** and **filter** which modules run. Drop it at the instance root (next to `atelier/`):

```json
{
  "label": "studio",
  "port": 1844,
  "defaultChrome": "~/chromes/my-chrome",
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
| `env` | `development` | `NODE_ENV` | frontend build mode — `development` (default, like an unset `NODE_ENV`) ships React + bundled-library dev warnings, unminified, with an inline sourcemap; `production` minifies the chrome bundle (dropping the inline sourcemap), strips bundled-library dev branches via the `process.env.NODE_ENV` define, and serves the minified React UMD. Independent of `hotReload`. |
| `defaultChrome` | _(election)_ | `ATELIER_DEFAULT_CHROME` | path/id of the **default** chrome module; overrides alphabetical election among installed chromes. A module can pin a different installed chrome with `meta.chrome` ([Per-module chrome](./MODULES.md#per-module-chrome--metachrome)) |
| `hotReload` | `true` | `ATELIER_HOT_RELOAD` | file watchers + backend hot-swap; set `false` when deployed |
| `auth` | `false` | `ATELIER_AUTH` | path/id of the auth module, or `false` to run ungated (see [AUTH.md](./AUTH.md)) |
| `revalidateMs` | `30000` | `ATELIER_REVALIDATE_MS` | how often live WebSocket sockets re-run `authenticate` (only when `auth` is set) — so logout/permission changes propagate without a reconnect; see [AUTH.md](./AUTH.md) |
| `label` | `null` | `ATELIER_LABEL` | optional instance name a chrome may display |
| `marketplaces` | `[]` | — | marketplace repos — github `owner/repo` or any clonable git url — the [`atelier add`](./INSTALL.md#install-modules) installer resolves bare module names against (register with `atelier add --marketplace`). Tooling-only — the server ignores it |
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

The `modules` filter is re-read **per request**, so editing it is live: when `hotReload` is on, the file change triggers a reload; backends no longer in the list are unmounted on the next reconcile, and newly-listed ones mount on the next request. (Settings — `port`, `defaultChrome`, `auth`, etc. — are read once at startup; changing them needs a restart.)

#### Bypass — standalone mode

`npm run dev:module -- <id>` (i.e. `node server.js <id>`) loads just that one module regardless of the filter. A bare id resolves to `global/<id>`; pass `<workspace>/<id>` for a workspace module. A standalone id that resolves to no module **fails fast** — the shell lists the available modules and exits. (A typo in `atelier.config.json` is never fatal by contrast: an unresolvable **path** entry warns once, and an unknown bare name is silently dropped by the filter.)

### What counts as a module

`discoverModules` walks the instance root and treats any sibling directory with a `frontend.jsx` or `backend.js` as a module — skipping reserved names, `_`/`.`-prefixed folders, and recursing into `$<ws>/` workspaces. The complete set of special names, prefixes, and files is in **[Modules → Folder & file conventions](./MODULES.md)**.
