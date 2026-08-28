# `host/supervisor/` — the app supervisor (PLAN §4.9 step 2, DESIGN §4.1 / §6.1)

One table of app instances on one computer. Per instance: one live worker (or none — resumed
lazily from the last-good snapshot), one revision counter, one watcher over the app folder. Every
other lane reaches it through the surface in `index.mjs`; it reaches them through the injected
collaborators (`spawn`, `proxy`, `jail`, `install`, `report`, `registrar`, `onSwap`).

## Modules

| file | does |
|---|---|
| `discovery.mjs` | `/work/apps` scan by `module.json` (OR10): `discover(appsDir, fs)` → `{apps, refused, skipped, problems}`; `checkModuleJson(dir, fs)` → meta via `protocol/registry allowMeta` or a classified problem (`file:line:col` + hint). Pure over a node-fs-shaped object. |
| `watcher.mjs` | the exclusion-list watcher: one non-recursive `fs.watch` per non-excluded directory (exclusion applied at registration — g8: a recursive watch registers node_modules too, 18 299 watches for 5 corpus apps; this shape stays ≤ 2 k), events only mark the folder dirty, quiescence = two fingerprints (path+size+mtime of the non-excluded set) `quiesceMs` apart identical, every quiescence pass is a full rescan (queue overflow safe), `watch error` → re-register. Exclusions: `node_modules/`, `data/`, `.atelier`, dotfiles, `_*`, `package.json`, `package-lock.json`, `CLAIM-REFUSED.txt`. `package.json`/lockfile at the root → `onInstall()`. Heal rule: while `isBroken()`, the root `node_modules` entry and the root lockfile/package.json pass as changes. |
| `bundle.mjs` | esbuild for one app. `bundleBackend` = the snapshot (`packages:'external'`, first-party `import.meta.url` → the source file URL, target node24, esm, source map with app-relative `sources`); every disk read happens in the host process (stdin entry + `onResolve`/`onLoad` plugin) so esbuild's Go service never stats inside a `2750` app folder. `transformFrontend` = 1.x `getJsx` per file (classic JSX, es2020, `.jsx` → `.js`, `?rev=N` on relative imports, a relative import that resolves to nothing fails the build). `classifyWorkerFailure`, `fromEsbuild`, `formatHint`, `sourceMapLookup`: the failure classes → `{file, line, col, message, hint}`. |
| `tailwind.mjs` | one sheet per app: the chrome's `styles.css` compiled with `compile()` (`base` = chrome dir) and `Scanner({sources:[]}).scanFiles` over the explicit chrome ∪ app file list (1.x `walkJsxFiles` exclusions, lines > 8 KB split at 200 chars). No resident compiler. No chrome → the app's `styles.css` bytes unchanged. A compile failure → `{problems}` classified `css`. |
| `lastgood.mjs` | the revision store under the `.atelier` dirfd: `last-good/<inst>/rev-N/{backend.js, backend.js.map, frontend/<rel>.js, styles.css}` written to `rev-N.tmp-<pid>`, every file fsynced, renamed; `0:<uid> 0750` dirs / `0640` files set by chmod-then-chown through the adapter (the host's own inodes, created under umask 077); `<inst>/revision.json` (`rev` = counter, `live` = the rev `current` names, `sha256`, `bytes`, `builtAt`, `host`, `chrome`, `protocol`, `fingerprint`, `slug`); `<inst>/current` symlink swapped by rename; `commitGit` = row G (`git init/add/commit` as uid 1000, cleared groups, exact env, never fatal). |
| `serve.mjs` | the request side: `handle(row, req, res, user)` captures `row.live` ({rev, sock}) once and proxies; a stopped row resumes first (requests held); `asset(row, rel, {rev})` serves `styles.css` / `*.js` from the CURRENT rev dir (or a kept older rev when `rev` is given), static files from the app folder (1.x deny rules, symlink containment). `protocol/server.mjs` and `protocol/devshell.mjs` call the same two functions — the same-bytes property. |
| `index.mjs` | `createSupervisor(...)` — apps table, `boot()` (rows from `last-good/*` + markers, never the folder), `scan()` (discover → `registrar.claim` → watch → build when the fingerprint differs from `revision.json`), the build (module.json → bundle + transform + sheet with the app gid held → rev dir → new worker beside the old → swap under one rev → old worker stopped 500 ms later; MOUNT-ERROR retried once after the old worker exited), idle-stop (only empty READY `resources` or `{t:'suspendable'}`, 60 s without a request), resume from `current`, `kill()`/crash → report + restart with backoff, teardown. |

## Interfaces (DESIGN §4.1 terms)

To the **workers** lane (injected, never imported):
- `spawn({os, spec, onControl, onExit, readyTimeoutMs})` → `Promise<{pid, sock, kill(signal), stop(drainMs)}>`, rejecting `{error:'no-ready'|'spawn-eagain'|'load-failed', msg}`. `spec` is the §4.1 `WorkerSpec`; `spec.sock` is **per rev** (`<sockDir>/w-<rev>.sock`): load-beside needs the new worker bound while the old one serves, and a proxy's keep-alive pool is keyed by socket path. Control messages the supervisor consumes: `ready` (`resources`, `teardown`), `load-failed` (`code`, `message`, `file/line/col` in bundle coordinates — mapped back through the rev's source map), `suspendable`, `error` → `report('backend')`, `http5xx` → `report('http')`, `broadcast` → `onBroadcast(appRow, event)`.
- `proxy({sock, req, res, user, bodyCap, timeoutMs})` → `Promise<{status, …}>`.
- `jail` (optional): `{jailPlan, applyJail, claimRoundTrip}` — applied before every spawn and at claim. Without it the supervisor creates `data/<inst>`, `tmp/<inst>`, the socket dir itself (local mode).
- `install` (optional): `installDeps({os, dirfd, spec, log})` — run on a root `package.json`/lockfile change; success → rebuild. Without it the change is a plain rebuild.

To the **errors** lane: `report(kind, instance, rev, detail)` with `kind ∈ build|backend|http|worker`; `detail = {message, hint?, file?, line?, col?, stack?, sample?}`; the `hint` of every build failure is `formatHint(problem)` = `file:line:col message — fix`. `onSwap(instance, rev)` after every swap (the collector's `setRunning`, the events lane's invalidate).

To the **protocol-server** lane: `apps()`, `workers()`, `resolve(company, slug)`, `handle`, `asset(row, rel, {rev})` (the third argument carries `?rev=N`), `rebuild`, `stop`, `kill`, `teardown`, `boot`, `scan`.

From the **registrar**: `claim({slug, meta, dir})` → `{instance, uid, …} | {refused}` (also called on the first scan for every boot row — the adopt), `unlink(instance)` when a folder vanishes, `served(instance)` per proxied request, `reconcile(rows)` after a scan, `company`, `origin`, optional `appConfig(instance)` → the OR14 env.

`log` is the agent.log writer: a function `(line) => void` or an object with `.write(line)`. Lines: `[<slug>] rev N LIVE in <ms> ms` · `FAILED (users still on rev M | see nothing — never live) <hint>` · `STOPPED` · `RESUMED <ms> ms` · `KILLED <why>` (agentlog prefixes the ISO time).

## Tests

```
cd .claude/worktrees/host-supervisor && node --test host/test/supervisor*.test.js
```

31 tests + the shared harness file (`supervisor-harness.test.js`: a minimal real worker runtime speaking the fd-3 control lane, a test-local `spawnWorker`/`proxyRequest` over `unprivileged()`, a fake registrar). Real esbuild, real Tailwind (chrome fixture with `node_modules` symlinked), real workers on Unix sockets under `/tmp`; `memory()` records the row G git spec; a recording `setgroups` asserts the app-group rule.

## What the Linux drill (host/drill, §8.2) must still prove for this lane

1. Reads inside a `1000:<uid> 2750` app folder succeed with the gid held and fail without it: watch registration, fingerprint walks, `module.json`, static assets, the esbuild plugin's reads (the Go service itself never touches the folder).
2. inotify budget ≤ 2 k watches over the 5 corpus apps after `npm install`; a 16 384-event burst → one build after quiet; `watch error` re-registration.
3. Rev dirs land `0:<uid> 0750` / files `0640` under the host's umask 077 (chmod-then-chown on root-owned inodes), `last-good/<inst>` EACCES to uid 1000, readable by the worker uid.
4. `git commit` as uid 1000 with cleared groups in a `2750 1000:<uid>` folder (row G).
5. The real `worker/runtime.mjs`: READY `resources` semantics (idle-stop decisions), MOUNT-ERROR/LOAD-ERROR `file/line/col` in bundle coordinates → source-mapped hints, `stop(drainMs)` with the process-group SIGKILL.
6. Socket dir `0:<uid> 0730` with per-rev socket names; `afterReady` chown on `spec.sock`.
7. Save → LIVE p50 ≤ 350 ms / max ≤ 1.1 s on the corpus apps in a pod (g4), one-sheet CSS ≤ 50 ms cold for the median app (b5).

Open (not built here): `spawn-eagain` is reported and the rev dir removed, with no automatic retry until the next save; `?rev=N` window pruning is timer-based (10 min after a swap; everything but `current` pruned at boot).
