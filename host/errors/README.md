# `host/errors/` — app errors reach the agent, always (OR16)

The host is the single collector of everything an app does wrong; the spine delivers it into
the chat (mid-turn injection, a new turn when idle, coalesced). Silence means LIVE. This folder
is the host half: PLAN §4.3 "App errors reach the agent, always", §0 OR16/OR19, DESIGN §4.2,
§6.3. The wire shape and the coalescing policy are `protocol/app-errors.js` — imported, never
re-implemented; the spine runs the same file (ported, vectors copied: `agent-orchestrator/docs/step1-contract.md`).

## Modules and interfaces

| file | one line | interface |
|---|---|---|
| `collector.mjs` | the one entry point; fingerprint, the 1 s tally, stale-rev, fan-out | `createCollector({log, now, timers})` → `.report(kind, instance, rev, detail)`, `.setRunning(instance, rev)`, `.running(instance)`, `.sink(fn)`, `.recent(instance, n)`, `.flush()`; `exitDetail(code, signal)` |
| `report.mjs` | `POST /_atelier/report` body → a `frontend` event | `frontendReport({collector})` → `(body, {instance})` → `{ok, fingerprint}` \| `{ok:false, reason}` |
| `agentlog.mjs` | `/work/.atelier/agent.log` writer, `0:1000 0640`, never throws | `agentLog({os, path, slugOf})` → `.line`, `.live/.failed/.stopped/.resumed/.killed`, `.appError` (the sink), `.lost`; `formatAppError(ev, {slug, running})` |
| `push.mjs` | app-error → spine through `registrar.lane.appError` (re-registers on `401 host-epoch-moved`) | `push({transport, running, log})` → `sink(ev)` with `.size() .inFlight() .dropped() .idle() .stop()` |
| `watchdog.mjs` | RSS kill, CPU throttle, disk + /dev/shm stop/resume | `createWatchdog({os, workers, report, kill, dataRoot, now, timers, log})` → `.start() .stop() .tick() .diskTick() .duTick() .state()` |
| `limits.mjs` | the rlimit numbers | `rlimitsFor(instance, {data?})`, `maxOldSpaceMb(data)`, `nodeArgv(rlimits)`, `rssCapKb(data)` |

Wiring (DESIGN §1.1): `collector.sink(log.appError)` always; `collector.sink(push({transport, running: collector.running}))`
in fleet mode; the supervisor calls `report('build', …)` with the classification `hint` and
`setRunning` on every swap; the workers lane forwards `{t:'error'}` → `backend`, `{t:'http5xx'}` →
`http` (with `sample.request`), a death → `worker` with `exitDetail(code, signal)`; the protocol
server routes `POST /_atelier/report` to `frontendReport`; the dev shell reads `collector.recent`.

## What each rule does here (and what is the spine's)

- **Fingerprint** = `protocol fingerprint({kind, file, line, message})` — kind + `file:line` + the
  message's first 80 chars. Identical on both sides by construction.
- **The 1 s tally** (host): the first report of a `(instance, fingerprint, rev)` goes out at once —
  a build error has a ~300 ms budget to the agent's context [S:g4] — and every further report in
  the next second folds into ONE trailing event with `count/firstAt/lastAt`. A storm of 1 000
  exceptions a second is two events a second; the spine adds the trailing count to the same record.
  A report from a newer rev closes the open tally: the fold never crosses a save.
- **The 10-min fold, 6/h per app, 12/h per chat, "+N more"** are the spine's (`coalesce`/`flush`
  over the same protocol file). The host does not pre-empt them.
- **stale-rev**: `rev < running(instance)` is dropped before any sink; `running` is the registration
  fact (`setRunning` from the supervisor's swap / the registrar at boot), never learned from an
  error. A rev above running passes — a save's build error is proof of the save. An event that
  went stale while the push queue waited is dropped at dequeue.
- **Frontend reports**: only `{url, ua, message, stack}` are read from the body; the body's `rev`
  must EQUAL the running rev (`rev-mismatch` otherwise — a stale tab or a looping page can neither
  mint deliveries nor move `running`); the instance is the route's, never the body's; at most
  60 accepted reports per instance per minute (`rate-limited`). Nothing about the person is
  carried — the shell's id stays in the shell.
- **Caps**: message 1000, stack 4000, hint 200, url 1024, ua 200 chars (protocol constants);
  `sample` is `{url?, ua?, request?:{method, path, status}}` and nothing else.
- **Push body** is exactly the step-1 contract: `{kind:'app-error', error:<AppErrorEvent>}` via
  `transport.appError()` (`POST /v1/host/event`, DESIGN §7 — the registrar's epoch-bound lane;
  the host never holds `CHANNEL_TOKEN`). `validateAppError` runs first (a refused event is a host
  bug, logged `push: schema …`); one request in flight; queue ≤ 200 with the oldest dropped past
  it; retry ladder 500 → 2 000 → 8 000 → 30 000 ms (then 30 000) on 5xx/network/401/408/429; other
  4xx dropped with a log line. The transport signals a spine answer as an Error with `.status`.
- **agent.log** lines (§6.3): `<ISO> [<slug>] rev <N> LIVE in <ms> ms | FAILED (users still on rev M) <hint> | STOPPED | RESUMED <ms> ms | KILLED <why>`;
  runtime kinds: `<kind> ×N (GET /api/x → 500) file:line:col <message> — fix: <hint>`. The
  supervisor writes LIVE/STOPPED/RESUMED itself; FAILED and KILLED come from the collector sink so
  a build failure is one line, not two. Created `0640`, chowned `0:1000` once through the
  adapter; every append try/caught, mirrored to stderr with the line on failure, counted in `.lost`.

## Watchdogs (all through `host/adapters/os.mjs`)

| loop | cadence | rule |
|---|---|---|
| RSS | 120 ms | `VmRSS > data − 640 MB (min 256 MB)` → `kill(instance, 'rss 412M > 384M')` (the supervisor SIGKILLs, marks failed, restarts with backoff) + one `worker` report |
| CPU | 120 ms | jiffies over the REAL elapsed time > 35 % of one core → `SIGSTOP` for `min(400, elapsed·(1 − 0.35/pct))` ms, then `SIGCONT`; never a kill. ≥ 25 cycles in a minute → one `worker` report per minute with a stable message (numbers in the hint) |
| disk | 5 s statfs, 60 s du | `/work` ≥ 95 % used → `SIGSTOP` the running worker whose dataDir grew most since the last du pass (one per tick) + report; every disk-stopped worker gets `SIGCONT` below 90 %. `du -s -k <dataDir>` runs AS THE WORKER UID (the dir is `<uid>:19999 2770`; userns-root without `DAC_READ_SEARCH` cannot enter it) |
| shm | with du | `find /dev/shm -uid <uid> -type f -printf %k` (as the worker) ≥ 256 MB → `SIGSTOP` + report; `SIGCONT` below 128 MB. Defaults, not measured — /dev/shm is one shared 1 GiB tmpfs the host can neither split nor chmod (R6) |

A worker stopped for two reasons resumes when the last one clears; `stop()` (teardown) resumes
everything so SIGTERM can reach the module's teardown.

**ENOSPC — what the host can and cannot tell** [S:data-storage-4]. Longhorn's ext4 has 0 reserved
blocks and userns-root is not fs-root, so nobody has margin: one app fills a 20 Gi computer in
~45 s. The watchdog's 95 % stop is the only soft line. When the volume is full: the host's
snapshot of a save fails (`FAILED (users still on rev M) mkdir rev-N: ENOSPC` — last-good keeps
serving), `agent.log` appends fail (mirrored to stderr, counted in `.lost`), the peer's SQLite
inserts fail `SQLITE_FULL` (reads survive; the worker stays up). What the host cannot see: a save
cut by ENOSPC that left a truncated-but-valid file (it builds and goes LIVE when space returns —
the agent's own tool saw the ENOSPC, the host never can), the agent's transcript writes failing
under `/work/.claude` (not sampled), and which non-worker filled the volume (only dataDirs are
attributed). Recovery is online: `kubectl patch pvc` +N Gi is visible in ~72 s, no restart.

## Limits (`limits.mjs`, row W of DESIGN §2.2)

`RLIMIT_DATA` 1 GiB default AND floor (512M aborts node at boot: the limit counts V8's CodeRange
reserve; a burst ends as an in-worker `RangeError` at ≈ data − 576 MB, never a kernel OOM);
`RLIMIT_CORE 0`; `RLIMIT_NPROC 64` (per uid = per worker); `RLIMIT_NOFILE 1024`; never `RLIMIT_AS`.
`--max-old-space-size = (data − 576 MB) × 0.85` MB, min 256 (380 for the default). RSS cap =
`data − 640 MB`, min 256 MB (384 MB for the default).

## Tests

`node --test host/test/errors*.test.js` — 41 tests: fingerprint = protocol's, the 1 s tally,
stale-rev before sinks, setRunning reset, per-rev fold; frontend `rev-mismatch`/allowlist/rate;
agent.log lines, `0640` + `0:1000` (memory adapter) and a real file under `unprivileged()`,
ENOSPC swallowed + stderr; push validates first, exact body, one in flight, the ladder, 4xx drop,
queue cap, stale at dequeue; watchdog with a fake `/proc`: RSS kill at cap, throttle ≤ 400 ms, no
kill on CPU, one CPU report per minute, disk 95 % → SIGSTOP the largest grower, SIGCONT at 90 %,
du/find as the worker uid, shm stop/resume, loops on injected timers; limits: 512M refused,
default 1 GiB, core 0, the formulas. `host/test/errors.helpers.js` is the fake clock.

## What the Linux drill (DESIGN §8.2) must still prove

1. `du -s -k` of a `<uid>:19999 2770` dataDir as the worker uid through the row-W wrapper
   (`prlimit` + `setpriv --clear-groups`) returns rc 0 in ≤ 50 ms warm for a 26 k-file tree;
   `find /dev/shm -uid <uid> -printf` as the worker counts its own files (GNU findutils in the image).
2. The RSS kill lands at `rss > 384M` on a 2 GB alloc before the RLIMIT_DATA `RangeError`, with
   `oom_kill 0` in the container's `memory.events` (§8.2 row 7).
3. The CPU throttle: burn → cycles > 0, peer max < 200 ms, worker alive; the `worker` report
   after 25 cycles arrives once.
4. Disk: a fill to 95 % SIGSTOPs the filling worker within one statfs tick (5 s) and the report
   names it; freeing to < 90 % resumes it.
5. `agent.log` stat `0:1000 0640` under the dirfd; a full volume → the line on stderr and
   `.lost` > 0, host alive.
6. The push against the real registrar lane: `401 host-epoch-moved` → re-registration by the
   registrar's `call()` and the retried event delivered once.

## Open (this lane)

- `host/adapters/os.mjs` `memory().spawnSync` invokes `state.answers.spawnSync` twice per call
  (once inside `rec()`, once after) — a stateful fake answer is consumed twice. The tests here
  keep their answers idempotent; the architect's fix is to drop the second call.
- The `workers()` rows must carry `rev` (the report's rev) and `rlimits.data` when a worker runs
  with a non-default limit — recorded in DESIGN.md's lane section.
- agent.log rotation is not in the plan; the file grows with the computer.
