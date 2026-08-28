# `doctor/probe/` — lane B: the runtime probe through the real host worker

Mounts a module's `backend.js` inside the REAL 2.0 worker (`host/worker/runtime.mjs` behind
`host/worker/spawn.mjs`, on the laptop adapter `unprivileged()`) with observation hooks installed
before the runtime loads, on a bounded time budget, and reports what the fleet would refuse. Design:
`doctor/DESIGN.md` §4; the seed's hook set: `design/atelier2/r2/spike-migration-local-1/worker.mjs`.

```
common.mjs   pure: KINDS / LISTS (the observation kinds and their report lists), attributeStack()
hooks.mjs    the hooks — loaded ONLY inside the worker (it reads ATELIER_WORKER and patches globals on import)
entry.mjs    the worker entry handed to spawnWorker({runtime}): import hooks.mjs, then runtime.mjs → main()
run.mjs      probeModule / probeCorpus / probeSpec / probeLine — the host side
```

Tests: `node --test doctor/test/probe.test.js` (fixtures `doctor/test/fixtures/probe-clean`,
`probe-dirty`; the other cases are throwaway apps under `/tmp`). ~1.5 s, no root, no network.

## `probeModule({id, dir, out, name, os, readyMs, settleMs, drainMs, closeMs, log})` → report

1. `bundleBackend({appDir: dir})` (host/supervisor/bundle.mjs) → `<out>/doctor/<id>/probe/rev-1/backend.js`
   + `.map`. The worker imports the bundle, never the folder. A bundle failure is state `bundle-error`
   with the classified `file:line:col` + hint; no `backend.js` is `no-backend`.
2. The `WorkerSpec` (`probeSpec`) — the host's shape: `instance = 'i-' + sha256(id)[0:16]`,
   `company 'doctor'`, `uid = process.getuid()`, `rev 1`, `appDir = dir` (the worker's cwd — `HERE`-relative
   reads resolve there, as in production), `dataDir/tmpDir/scratchDir` under `<out>/doctor/<id>/probe/`,
   socket `/tmp/atelier-doctor/<instance>/w.sock` (macOS 104-byte cap; removed afterwards), `baseUrl
   https://doctor.portal.pa1nd.de/api/doctor/<id>`, `configEnv {}` (deliberately empty: every default
   surfaces), the host's rlimits (ignored by `unprivileged()`).
3. `spawnWorker({os: unprivileged(), spec, runtime: entry.mjs, lockSocket: false, hostEnv: {PATH, NODE_ENV:
   'production'}, readyTimeoutMs: readyMs})` — the real spawn plan (row W env exactly; `HOST/PORT/BASE_URL`
   published from the spec, so N3 is judged against the real 2.0 env), the real runtime code path
   (chdir → import → frozen ctx → router → mountRoutes → resources → listen → READY on fd 3).
4. After READY: `settleMs` (post-mount timers and beacons fire), then `handle.stop(drainMs)` → SIGTERM →
   the module's teardown → exit 0, or the pgroup SIGKILL at the deadline (`stop.killed: true`, R3). Then
   ≤ `closeMs` for the control lane to close (the exit summary is its last line).
5. A rejection maps to `state` / `died.where`: `no-ready` → `timeout` / `ready-wait`; `spawn-eagain`;
   `MOUNT-ERROR` → `mount-throw` / `mount`; `RUNTIME-DEAD` (exited before READY, e.g. `process.exit` in
   `mountRoutes`) → `died` / `process`; `LOAD-ERROR` / `ERR_MODULE_NOT_FOUND` → `load-error` / `import`.
   `died.error` is `{message, file, line, col}` mapped through the bundle's source map to the SOURCE file.

Budget per module: bundle + `readyMs` 7000 + `settleMs` 500 + `drainMs` 2000 (+ ≤ `closeMs` 1000) — 9.5 s
plus the bundle; `DEFAULTS` in run.mjs. `probeCorpus(modules, {jobs: 8, onModule})` runs a pool; a
58-module corpus is ≤ 58 × 10.5 / 8 ≈ 76 s worst case (measured: every module mounts or dies in < 1 s;
the whole corpus in ~5 s).

## The hooks (`hooks.mjs`) and attribution

| hook | records | refuses? | rule |
|---|---|---|---|
| `process.env` Proxy (`get`/`has`) | the key | no | N2, N2op, N3 |
| `net.Server.prototype.listen` | `host:port` / `unix:<path>` | never bound; `'listening'` on the next tick | D2 |
| `child_process.*` | the binary (first word), the function, the `script` a node/sh/python spawn runs (shortened) | never run; ENOENT-shaped error / 127 | D12 |
| `fs` writes (sync, callback, promises, `createWriteStream`, `node:sqlite` `DatabaseSync`) — every written path: `rename` source + destination, `copyFile`/`cp`/`link`/`symlink` destination | op + path, `inApp` | EACCES outside `dataDir`/`TMPDIR`/`HOME`/`<probe dir>`/socket dir/`/dev/null` | N1, D13 |
| `fs` reads and writes under `<app>/data` | op + path, `write` | (writes: as above) | N1 |
| `fetch`, `http/https.request/get`, `net.Socket.prototype.connect` | `via` + target, `loopback` | ENETUNREACH — no network in the probe | N4, N5, I2 |
| `process.on/once/…('SIG…')` | the signal | no | N8 |
| `process.exit` | the code | no — passed through after the summary | N8 |
| `ctx.module(id)` (the runtime's slot map is pre-seeded with a recording `Map`) | id, `cross` (≠ own slug) | no | D3 |

Every hook captures the stack; `attributeStack` marks the observation `app` when the first frame outside
`hooks.mjs`/`entry.mjs`/`node:` internals is the bundle or its deps, `runtime` when it is
`host/worker/runtime.mjs` or `spawn.mjs`, `node` when there is none. Only `app` observations are sent
(`{t:'doctor', kind, by:'app', …, frame}` on fd 3, one line per distinct observation, 40 per kind); the
others are counted in `skipped`. So the runtime's `PORT`/`HOST`/`ATELIER_WORKER` reads, its
`server.listen(sock)`, `unlinkSync(sock)` and `process.on('SIGTERM')` never reach the rules. One
`{kind:'summary'}` line at process exit carries the full counts and the env-read tallies;
`{kind:'stats', rss}` follows READY. Node's own reads of `WATCH_REPORT_DEPENDENCIES` and the like are
`node`-attributed here; a dependency's reads (`ws` → `WS_NO_BUFFER_UTIL`) are `app` and left to the
catalogue's `NODE_NOISE` filter (lane A/C).

`ctx` reads are not hooked (the runtime freezes `ctx` inside `main()`); D6/D7 are static rules.

## The report (the `runtime` block of `report.json`, DESIGN §5)

```
{ module, dir, state, mounted, died: null | {where, code, error:{message, file, line, col, hint?}},
  importMs, mountMs, resources, teardown, stop: {code, signal, killed} | null, exitedEarly, rss,
  jail: 'hook-emulated', hooks: {counts:{envRead, listen, spawn, writeOutside, selfData, egress, ctxModule, signal, exit}, skipped:{runtime, node}, summary?: 'missing'},
  envReads: [{key, n, frame}], envSpread: n (enumerations of process.env — a child env being built; not config reads), listens: [{target, frame}], spawns: [{bin, fn, script?, frame}],
  writesOutside: [{op, path, inApp, frame}], selfData: [{op, path, write, frame}], egress: [{via, target, loopback, frame}],
  ctxModule: [{id, cross, frame}], signalHandlers: [{signal, frame}], processExit: [{code, frame}],
  control: {error, http5xx, broadcast, suspendable}, asyncErrors: [{message, file, line, col}], stderrTail: [...], ms, budgetMs }
```
States: `mounted | no-backend | bundle-error | load-error | mount-throw | died | timeout | spawn-eagain`
(`STATES`). Lists hold ≤ 12 samples; `hooks.counts` are the full counts (from the exit summary; when the
worker was SIGKILLed — `timeout` — `hooks.summary === 'missing'` and the counts are the streamed
samples). Paths are shortened: `<app>/…`, `<probe>/…`, `~/…`. Frames are `file:line:col` in the SOURCE
(bundle positions go through the source map).

Files under `<out>/doctor/<id>/probe/`: `rev-1/backend.js` (+ `.map`), `data/`, `tmp/`, `scratch/home/`,
`worker.log` (`[stdout]`/`[stderr]` lines). The module folder is never written to — the tests hash the
fixture tree before and after.

## What the probe is not

Not a security jail (no uid drop on macOS — the EACCES is the hook's emulation of the fleet's ownership,
`jail: 'hook-emulated'`; a native module writing through its own binding — `better-sqlite3` — is not
intercepted, `node:sqlite` is), not a network test, not an RSS budget (`rss` is one sample at READY).

## Cross-lane interfaces (what is stubbed here)

- `name` (module.json's `name` → `ctx.name`) is an argument; lane A's `rules/meta.mjs` supplies it
  through the CLI. Default: the id.
- Classification of the observations into rule cells (loopback + `/api/global/` → N4/N5, `IMAGE_BINS`,
  `NODE_NOISE`, `~/` in `writesOutside` → D13, R1–R3) is lane C's (`report/`), from the lists above;
  `probeLine(report)` is the probe's own one-liner (`PROBE <module> <state> …`), not the `DOCTOR` line.
- The `--no-probe` / `--jobs` flags and the corpus listing are `cli.mjs`'s; `probeCorpus` takes
  `[{id, dir, name?}]`.
