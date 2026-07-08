# Changelog

Still pre-1.0 — anything in the shell surface (URLs, ctx shape, config schema) can move between minor versions until 1.0. The pace will slow as real users land, but for now: assume any 0.x bump may break a module that hardcoded an internal.

## 0.15.0

**Collections: sharing is now one shape and four verbs.** Breaking — a hard before/after. The only thing atelier shares is a **collection**: a git repo whose top-level folders are modules. `atelier package` produces them, so the norm costs authors one command — and buys uniform channels (subscribe once, every future cut is one command away), full history on everything that enters an instance, and transports that are just "where a git repo lives."

- **`atelier package <module> [--to <collection>] [--data]`** — cut a *verified* snapshot into `_collections/<collection>/` (git-committed). The gate: every source file must esbuild-transform, `backend.js` must bundle, a chrome must bundle whole — a cut that doesn't build never lands, so agents can trash the working tree all day while the collection keeps serving the last good cut. A module pinning a chrome via `meta.chrome` offers the chrome into the collection alongside (what arrives elsewhere is the app as its author saw it). `--data` ships `data/` deliberately; `node_modules`, `.git`, `.env*`, and install provenance never travel.
- **`atelier publish <collection> [--to <git-url> | --serve | --bundle]`** — move cuts, never working trees. `--to` pushes (`github:owner/repo` goes over ssh, origin is remembered); `--serve` hosts the collection's repo over plain http via git's dumb protocol — the zero-infrastructure LAN share, and the same trick makes any static host a distribution point; `--bundle` writes a single-file clone source for AirDrop/USB/chat with history intact.
- **`atelier add`** — rewritten: it is `git clone`. Sources always wear a scheme (`github:owner/repo`, any git url, `http(s)://` served collections, local paths and `.bundle` files) and subscribe under `_collections/` (a full clone — the mirror's history is a future update's merge base); bare names (`studio`, `studio/crm`) always name subscriptions — pull `--ff-only`, install what's missing, never touch what's installed (`--force` replaces one module, its live `data/` preserved by rename at swap time, as before). Each install writes a `.atelier` provenance file (collection, mirror commit). Resolution is syntax-directed: the same command means the same thing on every machine.
- **`atelier update [<collection>[/<module>]]`** — the counterpart of add: add only creates, update only upgrades. It reasons from the `.atelier` provenance (the mirror commit you installed from = the merge base): untouched modules swap to the new cut silently — build-gated and atomic, live `data/` and `.env*` preserved; edited modules are the operator's call — the merge is staged and verified *before* the prompt (merge with your edits on top / overwrite / skip / show), `--merge`/`--overwrite` decide headlessly, and with no TTY edited modules are skipped and reported, never decided. True conflicts are never auto-resolved and never leave markers in a running module: the half-merged tree lands in `<module>/.update-merge/` with a copy-pasteable agent hand-off; `--continue` refuses leftover markers, re-gates, and swaps in; `--abort` discards. A merge or new cut that doesn't build never lands.
- **`atelier list`** — your collections (authored and subscribed — same shape) and what they offer, with installed marks.

**Removed** (no fallbacks): the npm-pack fetch path — npm packages, tarball urls, and bare module folders are no longer installable specs; `--marketplace`, `--list`, `--from`, and the `marketplaces` config key; the bare `owner/repo` shorthand (write `github:owner/repo`). If it isn't a collection, atelier doesn't move it.

## 0.14.0

**Computed `meta` now works.** `` name: `Hi ${x}` `` — or any meta built from module-scope constants — used to be silently dropped, `chrome:` pin included: the static parse can't read it, and the old in-process fallback died on the standard top-level patterns (`window.__atelier.self(…)`, a bare `@atelier/kit` import). Valid JavaScript losing declared behavior was the real bug. A pure object literal is still the fast path (read from source, nothing executes); a computed meta now falls back to a **disposable sandbox process** — the module bundled with every bare import stubbed to inert proxies, browser globals proxied, evaluated, `meta` read as JSON, process killed (so top-level timers/side effects die with it, and nothing ever executes inside the server). If both paths fail, discovery warns loudly with the module and the exact reason instead of silently degrading. Cached by mtime — one sandbox run per edit, zero cost for literal metas.

## 0.13.1

**A backend that fails to load now heals itself the moment it can.** Observed in the wild: `atelier add` into a *running* instance copied the module folder, the shell hot-mounted it before `npm install` finished, and the backend stayed bricked on `Cannot find module` until a restart. Three layers fixed:

- **Self-heal.** While a backend is in a load-error state, the watcher stops ignoring `node_modules`/`data` events and retries the load (debounced) — so `npm install` finishing in the module folder remounts it automatically. Zero change to the healthy path.
- **Fresh retries.** Node's ESM loader caches a *rejected* evaluation by specifier, so an unchanged bundle (same `data:` URL) replayed the cached failure forever — even a `touch` couldn't revive it. Every load is now salted with a URL fragment (payload and inline sourcemap stay byte-identical), so a retry is a real retry.
- **`atelier add` stages before it lands.** The module is copied to a discovery-invisible staging dir, its dependencies install *there*, and only the complete folder is renamed into place (atomic) — a running instance never sees a half-installed module. On `--force`, the old module keeps serving until the swap, and its **live** `data/` is carried over by rename at swap time — anything the running module wrote during the dependency install comes along, not a start-of-run snapshot.

**Missing module dependencies now fail with the fix in the message.** A backend whose `createRequire(…)('pkg')` can't resolve a package — a module folder that landed without its `node_modules` (cloned instance, hand-copied folder, a failed install) — used to surface Node's bare `Cannot find module 'pkg'`. The error (on the module's `/api`, in the overlay, and in the log) now explains that a module ships its dependencies in its own package.json and prints the copy-pasteable remedy: `(cd <module dir> && npm install)` — and thanks to the self-heal above, running it brings the module up with no further action.

## 0.13.0

**Private module stores — a marketplace is any git repo you can clone.** Marketplace and kit entries now take two forms: a public GitHub `owner/repo` (fetched as an anonymous tarball, exactly as before) or **any git url** — `git+ssh://…`, `git@host:…`, `https://….git` — fetched with a shallow clone that rides *your* git auth (ssh keys, credential helper). Private team stores, self-hosted GitLab/Gitea, and local `file://` repos all work in `atelier add` (`--marketplace`, `--list`, bare names, `--from`) and in `npm create --kit`. Failure stays loud: a clone that can't authenticate says so and points at your access setup.

## 0.12.0

**Declared system needs — the `atelier` field, checked by `atelier add`.** A module can now declare in its own package.json what the folder can't carry:

```json
"atelier": { "os": ["darwin"], "bins": { "ffmpeg": "brew install ffmpeg" }, "env": ["SOME_API_KEY"], "note": "…" }
```

Also in `atelier add`: **`--marketplace <owner/repo>`** registers a marketplace without installing anything (and shows what it offers), **`--list`** browses everything your marketplaces offer with installed-markers, and bare names now treat your marketplaces as a **set** — a name found in several stops and asks you to pick with `--from` instead of silently taking the first.

After installing a module (and its npm deps), `atelier add` checks the declaration and prints an **ACTION NEEDED** block for anything missing — each absent bin with its author-supplied install hint, each unset env var, an OS mismatch — while the module still installs and runs (degrade-gracefully stays the rule). Nothing beyond `npm install` is ever executed unless you pass **`--yes`**, which runs the missing bins' hints (the same trust already extended to npm lifecycle scripts) and re-checks honestly afterwards. The shell itself never reads the field — it's an installer/tooling convention, documented in docs/MODULES.md.

## 0.11.0

**`atelier add` — the module installer, and the sharing convention it implements.** Installing a module is now a first-class terminal act: *copy the folder, install its npm deps*. No marketplace-side dependency bookkeeping — a module's own `package.json` is its whole dependency manifest, and marketplace manifests are marketing-only.

### Added
- **`atelier add <spec>`** — a new subcommand on the `atelier` bin (`cli.js` dispatches; everything else runs the server exactly as before). A bare `<spec>` names a folder of a **marketplace repo** (a public github repo whose top-level folders are modules), resolved via `--from <owner/repo>` or the new `marketplaces` list in `atelier.config.json`; any other spec is fetched via `npm pack` (registry name, git url, tarball url, local folder). `--workspace <ws>` targets `$<ws>/`.
- **The shipping convention** (docs/MODULES.md → *Sharing modules*): `package.json` owns a module's deps and installers run `npm install` in the folder — loudly failing with the folder kept in place for a manual retry; `data/` never ships and survives reinstalls; modules degrade gracefully around needs a folder can't carry; pin `meta.chrome` or inline what you borrow.
- **Never overwrite silently** — an existing module folder is refused (it may carry local edits); `--force` replaces it, preserving its `data/`.
- **Live filter append** — on instances with an allow-mode `modules` filter, the installed module is added to `atelier.config.json` (re-read per request, so no restart).
- **`marketplaces` config key** — tooling-only (the server ignores it): github `owner/repo` entries bare names resolve against, in order.

### Notes
- **Hardening:** the `uncaughtException` / `unhandledRejection` handlers now register **before** the first backend mount — an async fault thrown while the very first backends come up gets the fail-loud isolation banner instead of killing the process raw.
- **No other server behavior change** — discovery, routing, and the module contract are untouched; the bin entry moved from `server.js` to the `cli.js` dispatcher. `add` becomes a reserved word for standalone mode (`node server.js add` remains the escape hatch for a module literally named "add").
- Marketplace manifests (`.atelier/marketplace.json`) are **marketing-only** from here on: store identity + per-app copy/screenshots. Install semantics live in each module.

## 0.10.0

**Atelier is now an npm package — install the shell as a dependency and run it with `atelier`.** `npm install @pa1nd/atelier` makes an instance a plain npm project: a `package.json` that depends on the shell, nothing vendored (`npm create @pa1nd/atelier my-studio` scaffolds one). The subfolder layout — a checkout at `<instance>/atelier/` — keeps working unchanged; both are first-class.

### Added
- **Published as `@pa1nd/atelier`** (MIT) with an **`atelier` bin** — `server.js` is the bin, so `npx atelier` (or a scaffolded `"dev": "atelier"` script) boots the instance, and `atelier <id>` is standalone mode, exactly as `node server.js <id>` was.
- **Instance-root resolution understands the dependency layout** — `resolveRoot` (discovery.js) picks ROOT in priority order: `ATELIER_ROOT` (explicit, unchanged) → shell installed under `node_modules` (the instance is the folder that *owns* that `node_modules`; splits on the first marker so a pnpm nested store resolves to the consumer project, not the store) → legacy parent-of-PWD (shell as a subfolder — behavior identical to 0.9.x). Unit-tested in `test/root-resolve.test.js`.
- **Hoisting-agnostic vendor assets** — `/assets/react.js` and `/assets/react-dom.js` locate the React UMD builds via Node resolution (`createRequire` against the package's own root) instead of a hardcoded `<shell>/node_modules/…` path, so they serve whether the shell's dependencies are nested (dev checkout) or hoisted (installed as a dependency).

### Notes
- **No module-authoring contract change** — module shape, `ctx`, `window.__atelier`, URLs, and the config schema are unchanged. This release changes how the shell itself is obtained and where it may live on disk.
- In a monorepo whose hoisting puts the shell in the repo-root `node_modules`, ROOT resolves to the repo root — set `ATELIER_ROOT` to the intended instance folder. Same escape hatch for `npx` without a local install or a global install. The resolved root prints at startup, so a wrong one is obvious.
- Shell files don't hot-reload — **restart instances to pick this up.**

## 0.9.2

**A module render crash now recovers on hot-swap.** A module that throws *while rendering* (frequent while an agent is mid-edit) is caught by a shell-owned per-module boundary that surfaces a neutral "Render Error" overlay in the module's own subtree — and, crucially, **resets the instant the module's code hot-swaps**. So the moment the crash is fixed the module re-renders, with no manual reload. Previously the crash was caught by a chrome's error boundary that reset only on navigation (a different module), so a render error stayed stuck — still showing the error even after the fix — until you navigated away or hard-refreshed. The boundary is isolated (it never crashes the chrome or sibling modules) and applies to every chrome.

## 0.9.1

**Hot reload ignores content-identical touches.** The frontend file-watchers now hash the changed file and broadcast a reload only when its bytes actually differ from what was last served. A no-op rewrite — an editor saving an unchanged buffer, a formatter that changes nothing, a tool re-touching a file it just wrote on the next message — bumps mtime but no longer reloads the page. Real edits, new files, and deletions still reload (a directory, a delete, a >2 MB asset, or a first sighting reads as changed and is never suppressed). Mirrors the mtime-dedupe the backend reload path already does. Fixes spurious reloads where a just-edited module file was re-touched with identical content on the next interaction.

## 0.9.0

**Hot-swap module reloads — edits land in place instead of full-reloading.** A reload frame for a known module now re-imports just that module's bundle and merges it into the live tree; the chrome, the WebSocket, the React runtime, and every other module stay mounted. No loading bar, no viewport jump. Full reloads are reserved for when a fresh document is genuinely needed (a chrome's component/JS, a shell/discovery change, a brand-new module the bootstrap never saw).

### Added
- **Module hot-swap** — a reload frame for a known module re-imports its frontend bundle (cache-busted) in the background and swaps it into the live React tree instead of `window.location.reload()`. Only the changed module's subtree (its body, plus any slot it contributes to the chrome) remounts; everything else persists. The module's local React state resets on the swap — exactly what a full reload did, now scoped to the one module. State-preserving Fast Refresh is intentionally **not** implemented (it would need react-refresh machinery in the build; the shell keeps its zero-config per-file transform).
- **Multi-file modules** — the hot-swap version (`?v=N`) propagates from the entry onto the module's own **relative** imports, so editing a sibling file (`./helper.js`, `./sections/*.jsx`) re-fetches the whole module graph, not just the entry. ES module specifiers are URL-keyed and a relative import drops the base's query, so without this an edited sibling was served from the browser's stale module cache. Bare specifiers (`react`, `@atelier/kit`) carry no leading dot and are left alone — the shared chrome kit isn't needlessly re-fetched. **Cold loads carry no `?v` and are byte-identical to before.**
- **Stylesheet refresh on swap** — a swap re-fetches the active chrome's `styles.css` (FOUC-free: the new sheet loads alongside the old, the old drops only once the new is live) so a Tailwind utility class the edit newly introduced is generated and applied without a reload.
- **Chrome CSS-only edits hot-swap** — editing only a chrome's `styles.css` refreshes the stylesheet in place (no reload, no viewport jump) — smooth theme / token / color tweaks. The reload frame carries `cssOnly`, set true iff **every** file changed in the 150ms debounce window was a `.css`; a single component file clears it. A chrome's component / `.jsx` / `kit` edit still full-reloads (its styles + `@atelier/kit` import map are baked into the document at load).

### Notes
- **No module-authoring contract change** — module shape, `ctx`, `window.__atelier`, URLs, and config schema are all unchanged. This is a hot-reload / dev-experience release.
- Shell files don't hot-reload — **restart instances to pick this up.**

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
