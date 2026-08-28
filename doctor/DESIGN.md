# `doctor/` — design for PLAN §4.9 step 3 (`atelier doctor`)

`atelier doctor` judges an app folder (or a corpus of them) against the 2.0 runtime the host lane built
(`host/`), names the first-class 2.0 answer for every 1.x habit that breaks in the fleet (OR6), generates
`module.json` from a literal `export const meta` (OR10), performs the mechanical rewrites the plan promises
(§4.8 N1, N4), and publishes the portability table (§4.8: the seed's 58 × 33 CSV becomes the doctor's output).

Seed: `design/atelier2/r2/spike-migration-local-1/` (static greps, the hook set, the row list, the report
shape). Ported: the greps, the hook set, the row ids and the CSV header. Not ported: the spike's own worker
(`worker.mjs` + `router.js`) — the 2.0 probe runs the backend inside the REAL host worker
(`host/worker/runtime.mjs` via `host/worker/spawn.mjs`, DESIGN §4.1); the 53-workers-at-once RSS sum and the
B5-top-level-vs-recursive Tailwind comparison, which were spike measurements, not doctor duties.

The doctor never writes into the folder it judges: every output goes under `--out <dir>` (default `./doctor-out`);
`--write` (default off) applies the rewrites and `module.json` in place, and only then.

## 1. Three lanes, file layout

```
doctor/
  DESIGN.md              this file
  SKILL.md               the corrected agent-contract-2 skill (no `visibility` key) — §7
  cli.mjs                atelier doctor [dir|corpus] --out <dir> [--write] [--json] [--no-probe] [--chrome <dir>] [--env-keys <file>]
  rules/                 LANE A — static rules + rewrites (pure: (files) → findings; no process, no network)
    catalogue.mjs        the rule catalogue as DATA (§2) — one entry per rule id; everything else reads it
    walk.mjs             listModules / walkSourceFiles / walkClientFiles — 1.x walkJsxFiles exclusions verbatim (never enters data/, node_modules/, [._-]* names)
    static.mjs           runs every rule's `detect.static` over the walked files → findings with file:line + excerpt
    scope.mjs            brace-balanced regions: `mountRoutes(<router>, <ctx>) { … }` span and the ctx parameter name (no parser; the 1.x meta reader's balancer)
    meta.mjs             extractMetaStatically (1.x server.js L453–620, verbatim as in the seed's common.mjs) → module.json (§3)
    env.mjs              process.env key classification (operator | shell-published | node | laptop | config | other)
    rewrite.mjs          the mechanical transforms of §2 (N1, N4-backend) → {file, line, from, to} + rewritten text; byte-exact, tested
  probe/                 LANE B — the runtime probe through the real host worker (§4)
    run.mjs              per module: bundleBackend → codeDir; WorkerSpec; spawnWorker({os: unprivileged(), runtime: entry.mjs}); collect; stop()
    entry.mjs            the worker entry the probe hands to spawnWorker: installs hooks.mjs, then imports host/worker/runtime.mjs and calls main()
    hooks.mjs            the seed's hook set (listen, child_process, fs, process.env Proxy, egress, process.exit/on('SIG…'), ctx reads) reporting on fd 3 as {t:'doctor', …}
  report/                LANE C — table, verdicts, output files (§5)
    columns.mjs          the seed's CSV header verbatim + the new columns appended after M4
    table.mjs            merge static + probe + tailwind rows → portability.csv, rows.md, modules.md, summary.json
    verdict.mjs          per-module verdict line + the final VERDICT line
    daily.mjs            the 18 daily module ids (sort order and the `daily` column only)
    write.mjs            <out>/doctor/<module>/{report.json, module.json, config-keys.json, rewrite/…}; --write applier
  test/                  node --test doctor/test/*.test.js (macOS, no root, no network)
    fixtures/            small app folders, one per rule family; a mount-throw app; a listen/spawn/env/egress app; a 2.0 folder with module.json
```

Dependencies: none new. Lane A uses `node:fs`/`node:path` only. Lane B imports `host/worker/spawn.mjs`,
`host/adapters/os.mjs` (`unprivileged()`), `host/supervisor/bundle.mjs` (`bundleBackend`) and
`host/supervisor/tailwind.mjs` (`buildSheet`, `scanSources`, `LONG_LINE`) — the host's pinned esbuild/tailwind.
Lane C is pure. `cli.mjs` is the only file that touches the filesystem outside `--out`.

CLI wiring: ONE line in `cli.js` — `['doctor', './doctor/cli.mjs'],` in the `VERBS` map (the verb strips itself
from argv, like the collection verbs; `doctor` becomes a reserved standalone-mode name, as the file's NOTE says).
No `bin/atelier-doctor.js`.

## 2. The rule catalogue — DATA

`doctor/rules/catalogue.mjs` exports `RULES: Rule[]`. Every other file reads it; a rule is never coded
anywhere else. Shape:

```js
/** @typedef {{
 *   id: string,                       // seed row id (D1…D13, D2w, N1…N8, N2op, I1…I5, M1…M4) or a new one (N9…, R1…)
 *   family: '§4.8'|'NEW'|'info'|'mobile'|'runtime',
 *   plan: string,                     // where the rule comes from: '§4.8 N1', 'OR6', 'OR10', 'OR14', 'DESIGN §9.12', 'RESULT surprise 6', …
 *   title: string,
 *   severity: 'breaks-in-fleet'|'degrades'|'note',
 *   detect: {
 *     static?: [{ files: 'backend'|'frontend'|'all', re: RegExp, scope?: 'module'|'mountRoutes'|'outside-mountRoutes' }],
 *     runtime?: string[]              // hook observations that count: 'listen','spawn','envRead','egress','writeOutside','selfData','signal','exit','resources','state'
 *   },
 *   count: (staticHits, probe, tw) => number,   // the CSV cell, seed semantics preserved for seed ids
 *   answer: string,                   // the first-class 2.0 answer, verbatim in the report ("expects an operator reverse proxy the fleet does not have — …")
 *   rewrite: null | { kind: 'mechanical', transform: string, applies: 'backend'|'frontend'|'both', notes: string },
 *   evidence: string                  // what the corpus run must show (the seed's numbers are the baseline)
 * }} Rule */
```

The catalogue. Severity is what the finding means for the app in a fleet pod (`breaks-in-fleet` = a user-visible
failure or a dead worker; `degrades` = runs, but wrong/partial/silently defaulted; `note` = information).
"Static" = regex over the walked source files; "runtime" = the probe's hooks (§4); "AST" = the brace-balanced
scope of `scope.mjs` (there is no parser).

| id | plan | detects (static / runtime) | severity | first-class 2.0 answer named in the report | mechanical rewrite | evidence the corpus run must show |
|---|---|---|---|---|---|---|
| D1 | §4.8 "Also" | backend `authenticate(` / `authenticate:` | breaks-in-fleet | the shell is the only gate (P3); an auth module is local-only — no fleet equivalent, keep it for `npx atelier` | — | 1/58 (auth) |
| D2 | OR6, §4.7 | backend `.listen(`; runtime `listen` hook (host:port or unix path) | breaks-in-fleet | "expects an operator reverse proxy the fleet does not have — first-class equivalent:" per reason: URL shapes → the 2.0 router (`:param`, `/*`, bare `/`, every method); SSE/long-poll → plain streamed HTTP under `/api/<company>/<slug>`; a public hostname → dynos (§12); the bound port is also a self-collision at every save (§4.3 last-good). Fixed port numbers are named (`0.0.0.0:7475`). | — (the router move is not mechanical) | 8/53 listen at mount (agent ×2, artifacts, spaces, intercom, blitzfeed, …); the port strings match the seed's |
| D2w | OR6 (3), §4.7 | `WebSocketServer` / `from 'ws'` / `on('upgrade'` | breaks-in-fleet | WebSocket is the 2.1 upgrade lane; in 2.0.0 use SSE or `ctx.broadcast` (the proxy answers 426 to Upgrade) | — | 4/58 |
| D3 | §4.8 "Also" | `ctx.module('<other id>')` static (an id other than the module's own or `ctx.id`) | breaks-in-fleet | `ctx.module` is worker-local (one process per app); cross-app state goes through HTTP (the peer-call primitive, N5) | — | 0/58 |
| D4 | §4.8 "Also" | `user.workspaces` / `user?.workspaces` | breaks-in-fleet | `req.user = {id, name, claims}` only (§4.4); membership is the shell's | — | 2/58 |
| D5 | §4.8 (meta.chrome) | literal meta `chrome:` key | note | not a break: the bootstrap advertises `chromes` (§4.1); the key is dropped from module.json and named | — | 52/58 pin `catalyst-chrome` |
| D6 | DESIGN §9.12 | `ctx.port` / `ctx.host` static | degrades; **breaks-in-fleet** when the same statement is a `.listen(` (bind) | `ctx.host`/`ctx.port` are the PUBLIC origin's host/port (443 / 1844) — compose URLs from them, never bind them; a worker has no port (see D2) | — | 13/58 read them; the bind cases are a subset of D2 |
| D7 | §4.8 "Also" | `ctx.broadcast(`; static `topic:` inside the event | note; `degrades` when a `topic` is passed | the host stamps `topic = company/slug`; a passed topic is ignored with one stderr warning (runtime.mjs); delivery is per-app invalidation with cursors (§4.4) | — | 45/58 |
| D8 | §4.8 "Also" | `atelier add|publish|package|list` / `collections.js` | degrades | collections from a pod are 2.1 (copy-app-between-computers) | — | 4/58 |
| D9 | §4.8 "Also" [S:B6] | backend `Authorization` header reads / `Bearer` | breaks-in-fleet | `Authorization` never reaches a worker (header allowlist §4.4); identity is `req.user` | — | 6/58 |
| D10 | §4.8 "Also" [S:B6] | backend `Location: '/…'` not under `/api/` | note | the proxy rewrites a root-absolute `Location` (response allowlist §4.4); root-absolute links in HTML bodies are not rewritten — named per line | — | 1/58 |
| D11 | §4.8 "Also" [S:B6] | `req.on('close'` | degrades | disconnect = `res.on('close') && !res.writableFinished` (proxy.mjs); `req` 'close' fires early on Node ≥ 16 | — | 3/58 |
| D12 | §4.8 laptop binaries | static `spawn|exec|execFile|…('<bin>'` (first word; SQL verbs excluded); runtime `spawn` hook (binary, never run) | breaks-in-fleet unless the binary is in `IMAGE_BINS` (`node npm npx git sh bash python3 curl tar gzip` — catalogue data) | the image has no laptop binaries; ship the tool as an npm dep (two-phase install as the worker uid, §4.3) or drop the feature | — | 29/58 static; the runtime list ⊆ static list per module |
| D13 | §4.8 laptop paths | static `'/Users|/Volumes|/opt/homebrew|/usr/local|/Applications/'`; `os.homedir()` / `~/.config`; env `HOME|PWD|USER|TMPDIR|SHELL|LOGNAME`; runtime `writeOutside` matching `~/` | breaks-in-fleet (`/Users`, `/Volumes`, homedir writes) · degrades (`HOME` reads: it is `<scratch>/home`) | the only writable places are `ctx.dataDir` and `TMPDIR`; `HOME` is the worker's 0700 scratch home (row W) | — | 28/58 static; 2/53 die on `~/pro/…` at mount (mlx-tts, sous) |
| N1 | §4.8 N1 | static: `path.join(<dirvar>,'data')`, `` `${…}/data` ``, `'./data'`, `__dirname/…/data`; runtime `selfData` (any touch of `<app>/data`) and `writeOutside` matching `<app>` | breaks-in-fleet (the worker cannot write into the 2750 app folder; a real worker dies at its first write — 7/7 corpus deaths) | `ctx.dataDir` is the only data path (`/work/.atelier/data/<instance>`, outside the folder, survives a rename) | **yes** — see the N1 transform below | 19/58 static (9 daily); 10 touched it at mount, 7 died; 13 mix both paths (sub-count `N1mix`, new column) |
| N2 | OR14, §4.8 N2 | static `process.env.X` / `process.env['X']` for every X not in shell/node/laptop classes; runtime `envRead` keys (Node internals filtered: `WATCH_REPORT_DEPENDENCIES`, `NODE_V8_COVERAGE`, …) | degrades (silent defaults — surprise 6; **breaks-in-fleet** when the key is an operator `.env` secret, N2op) | the portal/spine config channel: the host injects the app's keys into that worker's env only (stdin config lane, row W) — the read stays `process.env.X`, the SOURCE changes; the doctor emits the key manifest the portal needs (`config-keys.json`, names only, never values) | **manifest, not code** (§9.1) | 27/58, 7 on operator keys; the runtime key set ⊆ static set + Node noise |
| N2op | OR14 | keys ∈ the operator's `.env` key NAMES (`--env-keys <file>`: names read, values never) | breaks-in-fleet | fleet-wide operator secrets are never an app's config; each app's keys are set per app in the portal | manifest | 7/58 (dashboard sites forms artifacts channels flights blitz-portal); 21 names |
| N3 | §4.8 N3, DESIGN §9.12 | static/runtime reads of `HOST`, `PORT`, `BASE_URL`; runtime `egress` to `…:undefined` | degrades (published in 2.0, so it runs — flagged because a missing default is `http://127.0.0.1:undefined/…`) | `HOST/PORT/BASE_URL` are published from `ctx.baseUrl` into the worker env (§4.3 Workers); prefer `ctx.baseUrl` | — | 10/58, all daily; 0 `:undefined` egress under the probe (the probe publishes them like the host) |
| N4 | §4.8 N4 | `/api/global/` literal, backend and frontend; runtime `egress` with `/api/global/` | breaks-in-fleet (company ≠ global) | `/api/${ctx.workspace}/` in the backend; in the frontend the workspace from `self()`/`useRoute` | **yes, backend only** — see the N4 transform; frontend hits are named per line | 11/58 (10 daily) |
| N5 | §4.7 row 4, §10 item 8 | static `localhost:<port>` / `127.0.0.1:<port>`; runtime `egress` to loopback (the jobs beacon `127.0.0.1:1844/api/global/jobs/beacon`) | breaks-in-fleet (a peer app is another worker on a Unix socket; `1844` is the dev shell and answers 401 without the token) | the peer-call primitive `ctx.peer('<slug>')` → `/api/<company>/<slug>` (design, §10 item 8); until it lands, the app's own routes | — | 22/58 static, 7 daily beacon at mount |
| N6 | §4.8 N6 | `/_atelier/` (except the 2.0 host's own `/_atelier/health`, `/_atelier/report`), `atelier.config.json`, `ATELIER_ROOT`, `ATELIER_SHELL` | breaks-in-fleet | shell internals are gone; each string is named with its line; `/_atelier/report` is the kit's error lane (OR16), the rest has no successor | — | 8/58 |
| N7 | §4.8 N7, R11 | client `.js/.jsx` outside the top level (1.x exclusions) | note (not a break: `tailwind.mjs scanSources` and `bundle.mjs walkFiles` are recursive) | the recursive scan is built; column kept for the seed's comparability | — | 12/58 |
| N8 | §4.3 last-good (teardown) | `process.on('SIG…')`, `process.exit(`; runtime `signal`/`exit` hooks attributed to app frames | degrades (`process.exit` in app code skips the runtime's teardown and orphans children; a SIG handler races the runtime's) | return a teardown from `mountRoutes`; the runtime owns SIGTERM | — | 8/58 |
| N9 (new) | §4.3 last-good, §10 item 1 | `new DatabaseSync(` / `require('better-sqlite3')(` without `timeout` / `busy_timeout` / `PRAGMA busy_timeout` in the same file | degrades (load-beside overlap → `database is locked`, flights 10/12 saves) | set a busy timeout on every open; the supervisor retries the mount once after the old worker exits | — | flights ≥ 1; count reported |
| N10 (new) | OR10 | `export const meta` in `frontend.jsx` (declared / literal / computed / absent) | note (literal → module.json generated); **degrades** when computed (no module.json can be generated — write it by hand) | `module.json` `{name, icon, group, primary, color}` is the only meta; `chrome`, `isChrome`, `hidden`, `eager` are dropped and each named | **yes** — module.json generation (§3) | 58/58 declared, 58/58 literal, 0 computed |
| N11 (new) | DESIGN §9.7 | a 2.0 folder's `module.json` carrying `visibility` or any key outside the five | note | the registrar drops unknown keys; an app is its chat's (OR8), company-wide apps are dynos (§12) — there is no visibility switch | **yes** — the key is dropped in the generated/rewritten module.json | 0 in the 1.x corpus; the agent-contract-2 starter app has it |
| R1 (new, runtime) | RESULT surprise 6 | probe state ≠ `mounted` (`load-error`, `mount-throw`, `died`, `timeout`, `bundle-error`, `spawn-eagain`) | breaks-in-fleet | the failure class and `file:line:col` from the control message (`load-failed` + `classifyWorkerFailure`) | — | 7/53 broken at mount, all on N1/D13 |
| R2 (new, runtime) | R14 | `resources` in the READY message non-empty (timers, children, sockets) | note ("stays resident — RLIMIT_DATA is its memory lever") | `ctx.suspendable()` when the background work is optional | — | ~40/53 resident, ≤ 13 idle-stop candidates |
| R3 (new, runtime) | §4.3 teardown | READY `teardown:false`, or `stop()` ends in `killed:true` (drain deadline) | degrades | return a teardown; children must die inside 2 s | — | 43/58 export one; killed count reported |
| I1–I5 | seed info | relative backend imports (bundled by `bundleBackend`; run-time `HERE`-located files still come from the live folder); internet egress at mount; `TopBarCenter`/`eager`; `@atelier/kit`; `useRoute` | note | as the seed | — | seed counts |
| M1–M4 | §4.8 mobile | `100vh`, `h-screen`, `fixed`+`bottom-0`, sub-16 px inputs (client files only) | note | OR5: `100dvh`, safe-area insets, ≥ 16 px inputs | — | 10/58 (5 daily) |

Regexes are the seed's `RX`, `SPAWN`, `ENVREAD`, `CTXMOD`, `REL_IMPORT`, `MOBILE` verbatim (in `catalogue.mjs`),
plus the new ones for N9–N11; `count()` per seed id keeps the seed's semantics (the sum over backend + frontend
hits, `D2` = runtime listens or a static hit, `D12` = the union of static and runtime binaries, …) so the
58 numbers reproduce.

### The two code rewrites (`rules/rewrite.mjs`)

Every transform is a pure function `(text) → {text, edits:[{line, from, to}]}`, byte-exact in tests, applied to
a COPY under `<out>/doctor/<module>/rewrite/<rel>`; only files with ≥ 1 edit are written.

**N1 — self-pathed data dir → `ctx.dataDir`.** Inside the brace-balanced `mountRoutes(<r>, <ctx>) { … }`
span (`scope.mjs`; the second parameter's name is `<ctx>`, whatever the module calls it):
`path.join(<X>, 'data')`, `path.join(<X>, 'data', <rest…>)`, `path.resolve(<X>, 'data'…)`, `` `${<X>}/data` ``
and `` `${<X>}/data/<tail>` `` → `<ctx>.dataDir`, `path.join(<ctx>.dataDir, <rest…>)`, `` `${<ctx>.dataDir}/<tail>` ``,
where `<X>` is one of `__dirname`, `HERE`, `ROOT`, `DIR`, `MODULE_DIR`, `dirname(...)`, `fileURLToPath(...)`
(the seed's `self_data` alternatives). Outside that span (module scope — sites' `path.join(HERE,'data')` ×4,
every one of the 7 deaths) the rewrite is NOT mechanical: `ctx` does not exist yet. Finding text: "hoist into
`mountRoutes` — `ctx.dataDir` is only known there" with the line. The mix case (a module using both `ctx.dataDir`
and a folder path) is counted as `N1mix` — a rename of `ctx.dataDir` would split its state (surprise 3).

**N4 — `/api/global/` → `/api/${ctx.workspace}/`, backend only.** Inside the `mountRoutes` span, in a
template literal: `/api/global/` → `/api/${<ctx>.workspace}/`; in a `'…'`/`"…"` string: the string becomes a
template literal with the same substitution (quotes → backticks; a string containing a backtick or `${` is
left alone and named). Outside the span: named, not rewritten. Frontend: named per line with the answer
(`self()`/`useRoute` carry the workspace); no rewrite.

**No other code rewrite exists.** N2 is a manifest (§9.1); N3 needs no change (published); D2/D2w/N5/N6/N8/N9
are design changes named per line.

## 3. `module.json` generation (OR10, rule N10/N11)

`rules/meta.mjs`:
1. `extractMetaStatically(src)` — the 1.x reader verbatim (server.js L453–620; brace-balanced literal → `new
   Function('return (…)')`): `{meta}` | `{meta:{}, error}`. The sandbox fallback (a child process for computed
   metas) is not ported: 0/58 needed it; a computed meta is a `degrades` finding ("write module.json by hand").
2. `moduleJsonOf(meta)` → `{name, icon, group, primary, color}` — only the keys present, in that order; every
   other key (`chrome`, `isChrome`, `hidden`, `eager`, `visibility`, …) is dropped and listed in
   `report.json.meta.dropped` with the reason from the catalogue (D5 for `chrome`, I3 for `eager`, N11 for
   `visibility`). `primary` stays a boolean (a request the spine records, §2).
3. A folder that already has `module.json`: `discovery.checkModuleJson` (the host's validator) runs; unknown
   keys → N11; a 1.x `export const meta` beside it → N10 note "module.json is the truth; the meta is ignored".
4. Written to `<out>/doctor/<module>/module.json` (2-space JSON + newline); with `--write`, into the folder
   (never overwriting an existing `module.json` unless its only change is the N11 key drop).

Evidence: 58/58 generated, byte-equal to the seed's `out/module.json/<app>/module.json` minus its
`"visibility": "chat"` line (the seed added the key v1 does not have).

## 4. The runtime probe (lane B) — the real host worker

Why a probe at all: 7/53 corpus backends die at mount, and no grep sees `mkdirSync` at import time in a
transitive file. Why greps anyway: **"mounted" hides most breaks** (surprise 6) — with `process.env` scrubbed
the modules do not fail, they default (`SPACES_PORT → 7402`, `BASE_URL → undefined`). So a rule's runtime
evidence is always a HOOK observation (a listen, a spawn, an env key read, an egress target, a write outside
dataDir) joined with the static hit; `dynamic_state` alone decides only R1. No rule counts "mounted" as
evidence of anything.

**Process shape** — exactly the host's, on the laptop adapter:
- `bundleBackend({appDir})` (host/supervisor/bundle.mjs) → `<out>/doctor/<module>/probe/rev-1/backend.js` (+ map).
  This is `codeDir` — the worker imports the bundle, never the folder, as in production; a bundle failure is
  state `bundle-error` (R1) with the classified `file:line:col`.
- `WorkerSpec`: `instance = 'i-' + sha256(module id).slice(0,16)`, `slug = <id>`, `company = 'doctor'`,
  `name` from the generated module.json, `uid = process.getuid()`, `rev = 1`, `codeDir`, `appDir = <folder>`
  (cwd; `HERE`-relative reads resolve there, as in production), `dataDir = <out>/doctor/<module>/probe/data`,
  `tmpDir = …/probe/tmp`, `scratchDir = …/probe/scratch` (`HOME = scratch/home`), `sockDir`/`sock` under
  `/tmp/atelier-doctor/<instance>/w.sock` (macOS 104-byte socket cap), `baseUrl =
  'https://doctor.portal.pa1nd.de/api/doctor/<slug>'`, `origin = 'https://doctor.portal.pa1nd.de'`,
  `configEnv = {}` (deliberately empty: the OR14 channel carries nothing, so every default surfaces),
  `rlimits = {data: 1024 MB, core: 0, nproc: 64, nofile: 1024}` (ignored by `unprivileged()`).
- `spawnWorker({os: unprivileged(), spec, runtime: doctor/probe/entry.mjs, lockSocket: false, hostEnv: {PATH, NODE_ENV: 'production'}, readyTimeoutMs: 8000, onControl, onLog})`.
  Row W env exactly (`PATH, NODE_ENV, APP_ID, HOME, HOST, PORT, BASE_URL, TMPDIR, ATELIER_WORKER`), `HOST/PORT/BASE_URL`
  published from the spec as the host does (`publishedAddress`), so N3 is judged against the real 2.0 env, not
  the spike's scrubbed one.
- `entry.mjs`: `import './hooks.mjs'` (side effects first), then `const rt = await import('../../host/worker/runtime.mjs'); await rt.main()`.
  `runtime.mjs`'s own guard (`argv[1] === runtime.mjs`) does not fire for the entry, so `main()` is called
  explicitly — the real runtime code path: chdir → import bundle → frozen ctx (13 keys) → router → mountRoutes →
  resources → listen on the socket → READY on fd 3. The runtime is not edited.
- After READY: wait 500 ms (post-mount timers and beacons fire — flights' crawl, the jobs beacon), then
  `handle.stop(2000)` → SIGTERM → the module's teardown → exit, or the pgroup SIGKILL at the deadline
  (`killed:true` → R3). Timeouts: 8 s to READY (`no-ready` → state `timeout`), 2 s drain. Parallelism 8.
  A corpus run is bounded at 58 × (8 + 0.5 + 2) / 8 ≈ 80 s worst case and is run as ONE background task.

**Hooks (`hooks.mjs`)** — the seed's set, installed before the runtime loads, observing and (where the fleet
would refuse) refusing; every observation is sent on fd 3 as `{t:'doctor', kind, …}` (the control lane the
host already parses; `spawnWorker` forwards unknown `t` to `onControl`) and summarised once at READY/exit as
`{t:'doctor', kind:'summary', …}`:
- `process.env` → Proxy: every `get`/`has` key (attributed, below) — N2/N2op/N3.
- `net.Server.prototype.listen` → recorded `host:port` / `unix:<path>`, never bound, `'listening'` emitted on
  the next tick so awaiting code proceeds — D2. Exception: the runtime's own `server.listen(spec.sock)` (a
  runtime.mjs frame) passes through for real; it is the READY path.
- `child_process.*` → the binary recorded, never run; ENOENT-shaped errors as in the seed — D12.
- `fs` writes outside `dataDir`/`tmpDir`/`<out>` → recorded and refused with EACCES (the fleet's worker owns
  nothing else; on the laptop there is no uid drop, so the refusal is the hook's — said in the report as
  `jail: hook-emulated`); reads/writes under `<app>/data` recorded — N1, D13. The runtime's own
  `unlinkSync(spec.sock)` and mkdirs are attributed to it and pass.
- `fetch`, `http/https.request`, `net.Socket.connect` → target recorded, refused (`ENETUNREACH`; no network in
  the probe) — N4, N5, I2. Loopback targets and `/api/global/` paths are classified from the recorded URL.
- `process.exit`, `process.on('SIG…')` → recorded — N8. The runtime's SIGTERM/uncaught handlers are attributed
  to it and not counted.
- `ctx` reads are NOT hooked: the runtime freezes `ctx` and hands it to the bundle's default export inside
  `main()`, out of reach of a pre-import hook (ESM bindings cannot be wrapped from outside). D3/D6/D7 are
  static rules; the seed's `ctx.port(undefined)` runtime signal is moot in 2.0 (both are published, §9.12).
  The same holds for the router (no route count column; the seed's `routes` number is dropped).
- **Attribution:** each hook captures `new Error().stack` and marks the observation `runtime` when the first
  non-hook frame is `host/worker/runtime.mjs` or `host/worker/spawn.mjs`, else `app`. Only `app` observations
  count. The runtime's `PWD/…` deletes, `readConfig` reads, `Number(process.env.PORT)`, `unlinkSync(sock)`
  and `server.listen(sock)` are therefore invisible to the rules.
- Node's own env reads (`WATCH_REPORT_DEPENDENCIES`, `NODE_V8_COVERAGE`, `WS_NO_BUFFER_UTIL`, `FORCE_COLOR`,
  `DEBUG`, `NODE_DEBUG`, `NO_COLOR`, `TERM`, `COLORTERM`, …) are filtered by the catalogue's `NODE_NOISE` list
  (surprise 7).

**What the probe records per module** (`report.json.runtime`): `state` (`mounted | bundle-error | load-error |
mount-throw | died | timeout | spawn-eagain`), `error` (message + `file:line:col`), `importMs`, `mountMs`,
`resources` (from READY), `teardown` (from READY), `stop` (`{code, signal, killed}`), `envReads`, `listens`,
`spawns`, `writesOutside` (≤ 12), `selfData` (≤ 12), `egress` (≤ 12),
`signalHandlers`, `processExit`, `rss` (the worker's `process.memoryUsage().rss` at READY). `--no-probe` skips lane B (static-only run; runtime columns empty).

**What the probe is not:** a security jail (no uid drop on macOS — DESIGN §4.6), a network test, an RSS
budget (the 53-workers-at-once sum was a spike measurement; §4.3 carries the numbers).

**Tailwind (kept from the seed as one column):** `buildSheet({chromeDir: --chrome, appDir})` once per module
through the host's `tailwind.mjs` (recursive scan, lines > 8 KB split) → `tw_cold_max_ms` (one cold build,
not the seed's max of three) and the new `long_lines` column (files with a line > `LONG_LINE`). Evidence:
toybox/worldclock no longer exceed 50 ms (the split is built in). Without `--chrome`, the app-only sheet.

## 5. Output contract (lane C)

Per module — `<out>/doctor/<module>/`:
- `report.json` — `{module, dir, daily, files:{source, client, subfolderClient}, meta:{declared, literal, error, keys, dropped:[{key, rule, reason}]}, moduleJson, configKeys:{operator:[…], config:[…], shell:[…], laptop:[…]}, findings:[{rule, severity, file, line, excerpt, answer, rewrite?:{to}}], rewrites:[{file, line, from, to}], runtime:{…§4}, tailwind:{coldMs, longLines}, cells:{D1…M4, …new}, verdict:{level:'BREAKS'|'DEGRADES'|'CLEAN', line}}`.
- `module.json` — generated (§3).
- `config-keys.json` — `{operator:[names], config:[names], shell:[names], laptop:[names]}` — names only, never
  values; the portal's input for OR14.
- `rewrite/<rel path>` — the rewritten copies (only files with edits).
- `probe/` — `rev-1/` (bundle), `data/`, `tmp/`, `scratch/`, `worker.log` (stdout/stderr lines).

Corpus — `<out>/doctor/`:
- `portability.csv` — header = the seed's, verbatim and in order:
  `module,daily,dynamic_state,meta_literal,tw_cold_max_ms,D1,D2,D2w,D3,D4,D5,D6,D7,D8,D9,D10,D11,D12,D13,N1,N2,N2op,N3,N4,N5,N6,N7,N8,I1,I2,I3,I4,I5,M1,M2,M3,M4`
  (37 fields; the plan's "33" is the rule-column count plus `dynamic_state`), then the NEW columns appended
  after `M4`: `N1mix,N9,N10,N11,R1,R2,R3,long_lines,resident,teardown,killed,config_keys,operator_keys,verdict`.
  Rows: daily first in `daily.mjs` order, then alphabetical (the seed's sort). `dynamic_state` values are the
  probe states of §4 (`mounted`, `mount-throw`, `load-error`, `no-backend`, plus the new `bundle-error`,
  `died`, `timeout`, `spawn-eagain`, `skipped` under `--no-probe`).
- `rows.md` — `| row | family | break | modules /N | daily /18 |` for every catalogue id (seed ids first).
- `modules.md` — `| module | daily | 2.0 worker | breaks (row: count) | verdict |`.
- `summary.json` — the seed's keys (`modules, daily, dynStates, brokenAtMount, outsideRows, metaLiteral,
  metaDeclared, twMax, twWorst, twOver, mobile, subfolder`) minus `rss`, plus `verdicts:{BREAKS, DEGRADES, CLEAN}`,
  `rewrites:{modules, edits}`, `configKeys:{modules, operator}`.
- `verdict.txt` — the final line.

Stdout: one line per module as it finishes —
`DOCTOR <module> <state> BREAKS|DEGRADES|CLEAN breaks=<n> degrades=<n> notes=<n> rewrites=<n> — <ids sorted by severity, e.g. N1:4 D2:1 N5:2>`
— then `rows.md`, then the last line always
`VERDICT: DOCTOR <clean>/<N> clean, <degrades> degrade, <breaks> break in the fleet (<daily breaks>/18 daily); module.json <literal>/<N>; rewrites <edits> edits in <modules> modules; probe <mounted>/<withBackend> mounted, <broken> broken at mount [<ids>]; tailwind max <ms> ms (<module>)`
or `VERDICT: FAIL — <reason>` when a lane crashed. `--json` prints `summary.json` instead of the tables (the
per-module lines and the VERDICT line still go to stderr).

Per-module verdict: `BREAKS` = any `breaks-in-fleet` finding or probe state ∉ {mounted, no-backend, skipped};
`DEGRADES` = else any `degrades`; `CLEAN` = else. The corpus verdict never says PASS/FAIL about the corpus —
the corpus is a laptop corpus and 37/58 are expected to break; PASS/FAIL is reserved for the doctor's own run
(a lane crash = FAIL). The tests pin the seed's 58-module counts as the regression baseline (§8).

## 6. CLI — `doctor/cli.mjs`

```
atelier doctor [<dir>|<corpus>] [--out <dir>] [--write] [--json] [--no-probe] [--chrome <dir>] [--env-keys <file>] [--jobs <n>]
```
- `<dir>` = a folder with `frontend.jsx`/`backend.js`/`module.json` → one module. A folder whose CHILDREN are
  such folders (and which is none itself) → corpus mode (every child matching the seed's `listModules`:
  name starts alphanumeric, has `frontend.jsx` or `backend.js`). Default: the current directory.
- `--out <dir>` default `./doctor-out`; the doctor refuses an `--out` inside the judged folder(s).
- `--write` applies rewrites + module.json into the folder. Refused unless the folder is inside a git work tree
  with no uncommitted change to the files it would touch (every write is undoable by `git checkout`); refused
  in corpus mode unless `--write` is given together with `--yes-corpus` (58 folders at once is a deliberate act).
- `--env-keys <file>` = a `.env`-shaped file whose KEY NAMES define N2op (values are never read past `=`);
  default none (N2op = 0 and the report says so).
- `--chrome <dir>` the chrome folder for the Tailwind column; `--jobs` probe parallelism (8).
- Exit code: 0 when the run completed (whatever the verdicts), 1 on a lane crash, 2 on usage.

## 7. The skill correction (`doctor/SKILL.md`)

The agent-contract-2 skill (`r2/spike-agent-contract-2/skill-v3/SKILL.md`) documents a `visibility` key
(`"chat" | "company"`, "promote = set visibility company") that v1 does not have (DESIGN §9.7: OR8/§12 and
`protocol/registry` drop it; the registrar ignores it). `doctor/SKILL.md` is that skill with:
- the module.json example and key list reduced to `{name, icon, group, primary, color}` — "No other keys";
- the "Promote" sentence replaced by: an app belongs to its chat (OR8) — everyone in the conversation sees it,
  nobody else; a company-wide app is a dyno app (§12), not a key;
- the LIVE line without `(visibility: chat; …)`;
- everything else verbatim. The spike is not edited. N11 is the doctor rule that catches a folder written from
  the old text.

## 8. Tests — `node --test doctor/test/*.test.js` (macOS, no root, no network, < 30 s)

- `rules.test.js` — for every catalogue id: one positive and one negative fixture snippet; the cell count; the
  `scope` variants for N1/N4 (inside vs outside `mountRoutes`, renamed ctx parameter).
- `meta.test.js` — literal meta → module.json byte-exact; computed meta → `{error}` + the degrades finding;
  dropped keys listed with their rule; existing module.json with `visibility` → N11 and the dropped-key output.
- `rewrite.test.js` — N1 and N4 transforms byte-exact on fixtures (join with rest args, template literal with
  tail, string → template, backtick/`${` left alone, outside-span untouched, edits' line numbers).
- `walk.test.js` — the 1.x exclusions: a fixture with `data/`, `node_modules/`, `_private/`, `.hidden/`,
  `backend.js` in a subfolder; nothing under `data/` is ever opened (an unreadable file plants the proof).
- `probe.test.js` — the real `spawnWorker` + `entry.mjs` on fixtures: (a) a clean app → `mounted`, teardown
  true, zero app-attributed observations; (b) an app that listens on 7475, spawns `ffmpeg`, reads
  `process.env.SPACES_PORT`, writes `<app>/data/x`, fetches `127.0.0.1:1844/api/global/jobs/beacon` → every
  observation present and attributed `app`, the write refused EACCES, state still `mounted`; (c)
  `mkdirSync('<app>/data')` at import → `load-error` with `file:line`; (d) a `process.exit(0)` in
  `mountRoutes` → recorded; (e) a bundle syntax error → `bundle-error`. The worker never touches the fixture
  folder (mtime + tree hash equal before/after).
- `report.test.js` — the CSV header equals the seed's header string exactly for its first 37 fields; column
  order; `rows.md` shape; verdict lines; `summary.json` keys.
- `cli.test.js` — `doctor <fixtures corpus> --out <tmp> --no-probe`: exits 0, writes only under `--out`,
  refuses `--out` inside the corpus, refuses `--write` on a dirty tree, `--json` prints valid JSON.
- `corpus.test.js` (skipped unless `ATELIER_CORPUS` is set) — the 58-module run reproduces the seed's module
  counts for the seed ids (N1 19, N2 27, N2op 7 with `--env-keys`, N3 10, N4 11, N5 22, N6 8, N7 12, D2 8,
  D5 52, D7 45, meta literal 58/58) within ±0 (static) and the probe's broken-at-mount set ⊇ {auth, meet-vault,
  mlx-tts, projects, screenmap, sites, sous}.

## 9. Resolutions of ambiguous plan text

1. **"The doctor rewrites `process.env.X` reads to this channel" (OR14, §4.8 N2).** The channel IS the worker's
   env: the host injects the app's keys over the stdin config lane and the runtime assigns them to
   `process.env` before the import. A code rewrite would change nothing. The doctor's N2 deliverable is the key
   manifest (`config-keys.json`, names only) the portal needs to hold those keys per app, plus the `degrades`
   finding per read ("silently defaults under an empty channel — surprise 6"). N2op keys are named as
   `breaks-in-fleet`: an operator's fleet-wide secret never becomes an app's config.
2. **"58 × 33".** The seed's header has 37 fields (5 identity + 32 rule columns). It is preserved verbatim;
   new columns go after `M4`. Nobody's spreadsheet moves.
3. **`meta.chrome` (D5).** Not a break (surprise 2, §4.8): the bootstrap advertises `chromes`. Severity `note`;
   the key is dropped from module.json and named.
4. **D10 root-absolute `Location`.** The proxy rewrites it (§4.4 response allowlist). Severity `note`; the
   grep stays for HTML-body links, which are not rewritten.
5. **N7 subfolder JSX.** Built (recursive `scanSources`/`walkFiles`). Severity `note`; column kept.
6. **N1 outside `mountRoutes`.** Not mechanical (no `ctx` at module scope) — and that is where every corpus
   death is. The finding says "hoist"; the rewrite runs only inside the span. Claiming a mechanical rewrite
   for the 7 that die would be a lie the corpus run would expose.
7. **N4 in the frontend.** Not mechanical (no `ctx`); named per line.
8. **Sidecar wording (OR6, §4.7).** The D2 answer text is the plan's sentence — "expects an operator reverse
   proxy that the fleet does not have — here is the first-class equivalent" — followed by the equivalent
   chosen by what the module does (a `ws` import → D2w's SSE/`ctx.broadcast` line; an SSE/long-poll route →
   streamed HTTP; a public share link → dynos). Never "forbidden".
9. **`ctx.host`/`ctx.port` (DESIGN §9.12 vs MODULES.md's "bind `ctx.host`").** The doctor follows §9.12: a
   bind is D2 + D6 `breaks-in-fleet`; a URL composition is D6 `degrades` only when the module also expects a
   loopback meaning (`localhost`/`127.0.0.1` nearby, N5). MODULES.md's sentence is amended by the docs fork
   (§9.12), not by the doctor.
10. **The probe on macOS is not the jail.** `unprivileged()` skips chown/chmod/setpriv; the EACCES for writes
    outside dataDir is the hook's emulation of the fleet's ownership (`jail: hook-emulated` in the report). The
    Linux drill of the host lane owns the real rows.
11. **The corpus root.** Not hardcoded: `atelier doctor /Users/pa1nd/pro/003-atelier-modules --out …`
    (the seed's `CORPUS` constant is gone); the operator's `.env` names only via `--env-keys`.
12. **One dispatch line.** `cli.js`'s `VERBS` map takes `['doctor', './doctor/cli.mjs']`; the verb reads
    `argv[2…]` like `add`/`list`. The only 1.x file touched by step 3.
