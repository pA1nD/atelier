# `host/` — design for PLAN §4.9 step 2

The one document the five build lanes follow. It states the current design only; the
reasons and the measurements live in `design/atelier2/PLAN.md` (§0 OR1–OR16, §0.1 R1/R2/R6/R14,
§4.3, §4.4) and the spike folders named there. Numbers here are the acceptance bar (§8).

Vocabulary (fixed): **launcher** = the root process the PID-1 reaper runs; **host** = the root
child of the launcher (`host/index.mjs`) — its app supervisor is `host/supervisor/`; **session
supervisor** = the image's `/app/session-supervisor.mjs` at uid 1000 (not in this repo);
**worker** = one process per app instance at uid `20000+i`; **dev shell** = the local-mode shell
inside the host; **shell** = the fleet portal service (step 4/5, not here); **spine** = the
orchestrator (`agent-orchestrator`, step-2 spine lane, not here).

Rules for every lane: new code only under `host/` (protocol/ fixes with vectors + tests); never
edit `server.js`, `build.js`, `client.jsx`, `discovery.js`, `cli.js`, `index.html`, `shims/`
(the dev shell READS `index.html`, `client.jsx`, `shims/`, `node_modules/react*` as assets);
`protocol/` is imported, never re-implemented; no new runtime dependency (esbuild 0.28.0,
tailwind 4.2.4, ws 8.21.0, react 18 are in `package.json`; python3 is in the image for
`freeze.py`); every Linux-only call goes through `host/adapters/os.mjs` (§5); comments and docs
describe the current state only.

## 1. Files and owners

```
host/
  DESIGN.md                      architect
  adapters/os.mjs                architect (committed; lanes import, never edit — propose changes in PR text)
  index.mjs                      integrator (wires everything; §1.1)
  entrypoint.sh                  launcher   PID-1 reaper (bash), execs nothing else
  launcher.mjs                   launcher   root, ~60 lines, steps §2.1
  hygiene.mjs                    launcher   env scrub, token files, marker mkdirs, group constants
  metrics.mjs                    integrator the PLAN §4.5 rows: bounded rings + counters, Prometheus exposition (§6.6)
  supervisor/index.mjs           supervisor Supervisor class: apps table, revisions, swap, idle/resume
  supervisor/discovery.mjs       supervisor /work/apps scan by module.json (pure over a readdir fn)
  supervisor/watcher.mjs         supervisor exclusion list + 100 ms fingerprint quiescence + overflow rescan
  supervisor/bundle.mjs          supervisor esbuild: backend snapshot bundle, per-file frontend transform, failure → classified
  supervisor/tailwind.mjs        supervisor one sheet per app (chrome styles.css + scan chrome∪app), long-line split
  supervisor/lastgood.mjs        supervisor rev dirs under the dirfd, fsync+rename, checksum, `current`, revision.json, git commit as 1000
  supervisor/serve.mjs           supervisor request → (instance, rev) → proxy or asset; held during resume
  worker/spawn.mjs               workers    SpawnSpec builder + READY wait + fd-3 control lane
  worker/jail.mjs                workers    the dir/socket/ownership plan per instance (chown round trips)
  worker/runtime.mjs             workers    the process a worker runs: router (b6 port), ctx, req.user, teardown, resources report
  worker/proxy.mjs               workers    HTTP over the Unix socket: headers, streaming, 502/504 mapping
  worker/install.mjs             workers    two-phase npm install (scratch as worker uid → freeze.py)
  worker/freeze.py               workers    port of r2/spike-g2-install-freeze/freeze.py (freeze|thaw|cleanup)
  errors/collector.mjs           errors     one entry point `report()`; fingerprint, tally, running rev, fan-out
  errors/report.mjs              errors     POST /_atelier/report body → protocol fromFrontendReport
  errors/agentlog.mjs            errors     /work/.atelier/agent.log writer (0640 root:1000, try/catch, stderr mirror)
  errors/push.mjs                errors     app-error → spine (validateAppError, retry, one in flight)
  errors/watchdog.mjs            errors     RSS kill, CPU throttle, disk statfs/du, /dev/shm per uid
  errors/limits.mjs              errors     the rlimit numbers + `rlimitsFor(instance)`
  protocol/server.mjs            protocol-server  the pod-IP listener (bearer+epoch, mTLS hook), routes
  protocol/auth.mjs              protocol-server  assertion verify (protocol/identity), nonce cache, dev token, bearer
  protocol/headers.mjs           protocol-server  protocol/headers both ways + body caps + framing reject
  protocol/events.mjs            protocol-server  invalidation queue → coalesced batches ≤128 → transport
  protocol/registrar.mjs         protocol-server  register/heartbeat/claims/tombstones/reconcile/uid map
  protocol/devshell.mjs          protocol-server  Unix socket + 127.0.0.1:1844, dev token, the 1.x document
  test/adapters.test.js          architect
  test/launcher*.test.js         launcher       test/supervisor*.test.js  supervisor
  test/worker*.test.js           workers        test/errors*.test.js      errors
  test/protocol*.test.js         protocol-server
  drill/launcher/{run.sh,remote.sh,pod.yaml.tpl,inpod.sh}   launcher (the harness every lane's Linux tests run in, §8.2)
```

`host/protocol/*.mjs` (runtime) is distinct from `protocol/*.js` (pure wire format) — import the
latter as `../../protocol/index.js`.

### 1.1 `host/index.mjs` — what the integrator wires

```js
const cfg = config(process.env)                       // §1.2
const os  = cfg.privileged ? linuxRoot() : unprivileged()
const dirfd = cfg.dirfd ?? os.openDir(cfg.work + '/.atelier')      // fd 3 from the launcher in the fleet
const log = agentLog({ os, path: os.at(dirfd, 'agent.log') })
const collector = createCollector({ log, now: os.now })            // errors
const transport = cfg.spineUrl ? spineTransport(cfg) : localTransport(cfg, dirfd)   // §7
const registrar = createRegistrar({ os, dirfd, transport, cfg, log })
const supervisor = createSupervisor({ os, dirfd, cfg, log, report: collector.report, registrar,
                                      onSwap: (inst, rev) => { events.invalidate(inst); collector.setRunning(inst, rev) } })
const events = createEvents({ transport, hostId: registrar.hostId, epoch: () => registrar.epoch })
collector.sink(push({ transport }))                                 // app-error → spine
collector.sink(log.appError)                                        // and agent.log, always
const watchdog = createWatchdog({ os, workers: supervisor.workers, report: collector.report, kill: supervisor.kill, dataRoot: os.at(dirfd, 'data') })
const server = createServer({ cfg, auth: createAuth({ registrar, os }), supervisor, collector, registrar })
const dev = createDevShell({ cfg, os, supervisor, collector, registrar, principal: registrar.principal })
await registrar.register()          // bootstrap → token+epoch (or local identity)
await supervisor.boot()             // serve every last-good snapshot BEFORE scanning folders
await server.listen(); await dev.listen()
writeSentinel(os, cfg.run + '/host-ready')                           // the kube readiness probe
supervisor.scan(); watchdog.start(); registrar.heartbeat(10_000)
process.on('SIGTERM', () => teardown(/* order §2.3 */))
```

Boot order is load-bearing (OR8): snapshots are served and `host-ready` written before the first
folder scan, first build or any spine round trip completes (registration failure = serve
snapshots, retry registration with backoff, no `host-ready` until the registrar has an epoch
in fleet mode; local mode has no registrar wait).

### 1.2 Configuration (`config(env)` in `index.mjs`; env only, set by the launcher)

| env | default | meaning |
|---|---|---|
| `ATELIER_WORK` | `/work` | the volume; apps at `$ATELIER_WORK/apps` |
| `ATELIER_RUN` | `/run/atelier` | tmpfs; tokens, sentinels, sockets |
| `ATELIER_CONTROL` | `/control` | spine control mount (read by nothing in the host; the launcher writes `.host-crash` there) |
| `ATELIER_DIRFD` | unset | fd number of the `.atelier` dirfd inherited from the launcher (`3`) |
| `ATELIER_CHROME_DIR` | unset | the chrome folder (frontend.jsx, kit.js, styles.css, node_modules); no chrome → app-less documents only |
| `ATELIER_HOST_PORT` | `1845` | protocol listener, bound on `0.0.0.0` (the pod IP) |
| `ATELIER_DEV_PORT` | `1844` | dev shell loopback port (token-only) |
| `ATELIER_SPINE_URL` | unset | registrar lane base URL; unset = local mode (folder registry, identity `{id:'local'}`) |
| `ATELIER_COMPANY` | `local` | local mode only; in the fleet the registrar learns it at registration |
| `ATELIER_ORIGIN` | `http://127.0.0.1:1844` | local mode only; fleet: from registration (`https://<company>.portal.pa1nd.de`) |
| `ATELIER_HOST_TLS` | unset | `cert.pem,key.pem,ca.pem` → mTLS on the protocol port (step 5 turns it on) |
| `NODE_ENV` | `production` | bundle mode for chrome/kit (`development` keeps source maps) |

Tokens are never env: bootstrap at `$ATELIER_RUN/bootstrap.token`, dev token at
`$ATELIER_RUN/dev.token` (both 0400 root, read once at boot, held in memory).

## 2. Process tree and spawn sites

```
PID 1  bash entrypoint.sh (reaper)                          root, all pod env
 └─ node host/launcher.mjs                                  root, all pod env (holds the bootstrap secret)
     ├─ node host/index.mjs                                 root, fd 3 = .atelier dirfd, env §2.2 row H
     │   ├─ <wrapper> node host/worker/runtime.mjs          uid 20000+i, gid 20000+i, groups [], env row W
     │   ├─ <wrapper> npm install (scratch)                 uid 20000+i, env row I
     │   ├─ python3 host/worker/freeze.py                   root, groups [], env row F
     │   └─ git commit                                      uid 1000, gid 1000, groups [], env row G
     └─ setpriv … node /app/session-supervisor.mjs          uid 1000, gid 1000, groups [19999], env row S
         └─ tmux → claude (spawned by the session supervisor, umask 022 — not ours)
```

Constants (`hygiene.mjs`, imported everywhere): `AGENT = {uid:1000, gid:1000}`,
`AGENT_DATA_GID = 19999`, `WORKER_UID_BASE = 20000`, `WORKER_UID_MAX = 65535`,
`appgid(instance) = uid(instance)`.

### 2.1 `entrypoint.sh` (PID 1) and `launcher.mjs` steps

`entrypoint.sh`: `#!/bin/bash` · `trap 'kill -TERM $c' TERM` · `node /app/host/launcher.mjs & c=$!` ·
`wait $c; wait $c` · `exit $?`. Bash reaps every orphan (g1: 0 zombies); it never runs node itself.

`launcher.mjs`, in this order, each step logged `[launcher] +<s>s <step>: ok|FAILED <errno>`;
a FAILED step before (4) exits 2 (a genuine fault; the kubelet restarts):

0. `chown 0:0 /work` iff it is `1000:1000` — a MIGRATED volume (the per-conversation recipe chowns it whole);
   root holds no DAC_OVERRIDE under the four caps and is "other" on it, so step 1's first `mkdir` would be
   EACCES (D0 row c) on every such boot. Taken back here, handed over in step 2: a chown round trip, no
   uid-1000 process alive yet. A fresh `0:0` volume passes through.
1. `mkdir` the root-owned markers with their final modes (`mkdirSync(p, {mode})`, never chmod after
   chown): `/work/.atelier` 0755, `/work/.atelier/data` 0711, `/work/.atelier/last-good` 0711,
   `/work/.atelier/scratch` 0711, `/run/atelier` 0711, `/run/atelier/dev` 0710 (then `chown 0:1000`),
   `/run/atelier/session` 0700 (then `chown 1000:1000` after step 3b). EEXIST is fine; a marker that
   exists with the wrong owner/mode is logged and left (the host's audit refuses to serve, §6.5).
   Open `/work/.atelier` as a dirfd (`os.openDir`, §5) and keep it for the launcher's life.
1b. `chown 1000:1000 /work/lost+found` if it exists and is `0:0`.
2. `chown 1000:1000 /work` — always (fresh, or taken back in step 0; a chown touches no mode, so a migrated
   `2775` stays `2775`). `mkdir /work/apps` 0755 + `chown 1000:1000` iff missing (before the `/work` chown, while root can).
3. `mkdir -m 0700 /tmp/tmux-1000` + `chown 1000:1000`; `mkdir -m 1777 /tmp/.X11-unix` (root, no chown).
3b. Tokens: write `$ATELIER_RUN/bootstrap.token` (0400 root) from `process.env.ATELIER_BOOTSTRAP`;
   mint 32 random bytes hex as the dev token → `$ATELIER_RUN/dev.token` (0400 root) and
   `$ATELIER_RUN/session/dev.token` (0400, then `chown 1000:1000` the file, then the dir).
   Every write is `writeFileSync(path, data, {mode, flag:'wx'})` under `umask 077`.
4. Spawn the host (row H). fd 3 = the dirfd. Restart policy on exit: unlink `$ATELIER_RUN/host-ready`;
   append one JSON line `{"at":ms,"code":c,"signal":s,"exits":n}` to `/control/.host-crash`
   through a uid-1000 helper (`os.spawnSync` row X); SIGKILL every process whose uid is a worker's
   (20000–65535: a host that died without its teardown leaves its workers as detached process groups
   holding sockets, sqlite locks and CPU — `orphanedWorkers()` over `/proc`); restart at once after
   the first exit in the window, then 0.5 s doubling to 30 s (`storm()`, one rule for both children);
   the 10th exit in 10 min PARKS the host (log `host: parked after 10 exits/10 min — ending the container`)
   and the container ENDS: the session supervisor is SIGTERMed (its own drain; SIGKILL after 10 s) and
   the launcher exits `HOST_PARKED_EXIT` (3) once it is gone, whatever it exited with. A Running pod with
   no host would be unready to kube (`host-ready` gone), deaf to the shell and still pasted into by the
   spine, and nothing restarts a parked host — the kubelet's backoff and the spine's condemn at ≥ 40 s
   (PLAN §4.3 lifecycle) own the storm from there.
5. Spawn the session supervisor (row S) in parallel — never after the host is ready. Its exit is a
   RESTART IN PLACE under the same storm rule (at once, then 0.5 s doubling to 30 s; the 10th exit in
   10 min parks it — the host keeps serving, the pod stays Ready, and the spine's supervisor-silent
   verdict on the stale `/control/.supervisor-ready` owns the pod: condemned when no app is served,
   released otherwise): an agent death never touches the host (PLAN §4.3). No `.host-crash` line for it;
   the supervisor's own boot is written for a restart inside one pod (the image's launch chain
   continue → fresh, the sentinel rewritten; it kills the previous life's tmux server before its first
   launch — die() never signals tmux or claude — and a launch whose new-session did not take is a
   die()). A BOOT DEATH is a life that ended inside `supBootMs` (30 s) of its spawn; `parkExits` (10)
   of them IN A ROW is a boot storm (log `session supervisor: 10 lives in a row died within 30 s of
   the spawn — a boot storm; ending the container (exit 4)`) and the container ENDS: the host is torn
   down as on SIGTERM (its drain; SIGKILL at grace − 5 s) and the launcher exits `SUP_BOOT_STORM_EXIT`
   (4) once it is gone. Ten lives that never got through their boot mean the container's state is what
   is wrong (a tmux server the next life cannot reclaim, a `/control` it cannot write, a seed it cannot
   install) and only a container restart clears it; a respawn in place would loop for ever, an in-place
   park would leave the chat deaf behind a serving host with nothing to rebuild it. The backoff before
   the verdict is the storm rule's (ten boot deaths take ≥ 90 s — never a tight loop); a life that
   outlived the boot window resets the row, and the window rule owns the mixed case (parked in place).
6. Signals: SIGTERM → SIGTERM the host first, wait ≤ `grace − 5 s` (grace = `ATELIER_GRACE_S`,
   default 40) for its exit while forwarding SIGTERM to the session supervisor (a pending restart of
   either child is cancelled); then exit with the supervisor's code — its last exit's when it was down —
   or `128 + signal` when it died by signal. Supervisor exit → step 5 policy; host exit → step 4 policy;
   neither ends the container on its own. The launcher exits only on SIGTERM, a failed plan step (2),
   a parked host (3) or a supervisor boot storm (4). `sup.kill` EPERM arrives as a ChildProcess `error` event (handled, logged,
   treated as exited). The launcher never exits for a policy reason (auth/limit/claude-gone are the
   session supervisor's relaunches).

### 2.2 Spawn table — env, argv, umask, groups, cwd, stdio at every site

`scrub(env, keep)` (`hygiene.mjs`) builds a NEW object from an explicit key list; nothing is
spread from `process.env` anywhere. `SECRETS = [ATELIER_BOOTSTRAP, CHANNEL_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY]`.

| row | who spawns | argv (before wrapper) | uid:gid / groups | env (exact) | umask | cwd | stdio |
|---|---|---|---|---|---|---|---|
| H host | launcher | `node /app/host/index.mjs` | 0:0 / inherited (root's) | pod env minus `SECRETS` minus `CHANNEL_*`, plus `ATELIER_DIRFD=3`, `ATELIER_RUN`, `ATELIER_WORK`, `ATELIER_CONTROL`, `ATELIER_SPINE_URL` (= pod `CHANNEL_URL`), `HOME=/root`, `NODE_ENV=production` | 077 | `/` | `['ignore','inherit','inherit', dirfd]` |
| S session supervisor | launcher | `node /app/session-supervisor.mjs` | 1000:1000 / `[19999]` via `setpriv --groups` | pod env minus `ATELIER_BOOTSTRAP` (keeps `CHANNEL_TOKEN`, `CHANNEL_URL`, `CHANNEL_CHAT`, `PERSONA*`, `STORY_TEXT`, `TERM`, `LANG`, `ANTHROPIC_*`, `DISABLE_AUTOUPDATER`, `PATH`), plus `HOME=/work` | 022 (it sets 077 itself for its own writes) | `/work` | `['ignore','inherit','inherit']` |
| X control helper | launcher | `sh -c 'cat >> /control/.host-crash'` (stdin = the line) | 1000:1000 / `[]` | `{PATH}` | 077 | `/` | `['pipe','ignore','inherit']` |
| W worker | host | `node --max-old-space-size=<cap−576 MB, min 256> host/worker/runtime.mjs` (args: none; everything via env + fd 3) | `20000+i` : same / `[]` | `{PATH, NODE_ENV, APP_ID=<instance>, HOME=<scratch>/<inst>/home, HOST, PORT, BASE_URL, ATELIER_WORKER=<json §4.1>}` + the app's spine-held config keys (OR14) | 002 | `/` (the worker `chdir`s to its app dir itself) | `['ignore','pipe','pipe','pipe']` — fd 3 = control lane |
| I install | host | `npm install --no-audit --no-fund` | `20000+i` : same / `[]` | `{PATH, NODE_ENV, APP_ID, HOME=<scratch>/<inst>/home, npm_config_cache=$HOME/.npm-cache}` | 022 | `<scratch>/<inst>/build` | `['ignore','pipe','pipe']` |
| F freeze | host | `python3 host/worker/freeze.py freeze|thaw|cleanup <slug> <uid> <appgid>` | 0:0 / `[]` (`setpriv --clear-groups`) | `{PATH}` | 022 | `/` | `['ignore','pipe','pipe']` |
| G git | host | `git -C /work/apps/<slug> init -q` + `.gitignore` (`set -C`, once at claim/adopt); `add -A . && commit -q -m <message>` + `rev-parse` at a deploy (§10.3 D7 — no per-save commit) | 1000:1000 / `[]` | `{PATH, HOME=/work, GIT_AUTHOR_NAME=atelier, GIT_AUTHOR_EMAIL=atelier@local, GIT_COMMITTER_NAME=atelier, GIT_COMMITTER_EMAIL=atelier@local}` | 022 | `/` (node chdirs before the uid drop; root cannot enter the 2750 folder — `git -C` does, as 1000) | `['ignore','pipe','pipe']` |
| A archive | host | `git -C /work/apps/<slug> archive --format=tar <commit>` (stdout = row T's stdin) | 1000:1000 / `[]` | row G's | 022 | `/work/apps/<slug>` | `['ignore','pipe','pipe']` |
| T extract | host | `tar -x -C /work/.atelier/prod/<inst>/<commit12>.tmp -f -` (then chmod-then-chown `0:<uid>` 0750/0640 over what it wrote) | 0:0 / `[]` | `{PATH}` | 077 | `/` | `['pipe','pipe','pipe']` |
| K hook | host | `node host/worker/hookrun.mjs <module.json deploy\|test\|smoke>` (hookrun reads the config on stdin after the drop, then `sh -c <cmd>`) | `20000+i` : same / `[]` | row W + `DATA_DIR` (+ `ATELIER_SOCK`, `BASE_URL=http://localhost` for smoke) — no config key in the env | 002 | `/work/.atelier/prod/<inst>/<commit12>` | `['pipe','pipe','pipe']` — stdin = the config lane |
| C copy | host | `cp -dR <src>/. <dst>` (links kept; umask 007 → 0660/0770 at creation; NEVER `--preserve=ownership` — GNU cp creates each inode without its g/o bits and chmods them back after the chown — nor `timestamps` — cp would utimensat the destination dir itself, a `<uid>` inode; both EPERM without FOWNER) then `find <dst> -mindepth 1 -exec chown -h <uid>:19999 {} +` · `rm -rf <dir>` · `du -sk <dir>` · `find <dir> -mindepth 1 -maxdepth 1 -print -quit` (prod data ↔ rehearsal copy / backup) | 0:0 / `[19999]` | `{PATH}` | 007 / 022 | `/` | `['ignore','pipe','pipe']` |

Wrapper for W, I and K (built by `os.spawn`, §5): `sh -c 'umask 002; echo 1000 > /proc/self/oom_score_adj; exec "$@"' sh prlimit --data=<bytes> --core=0 --nproc=<n> --nofile=<n> -- setpriv --reuid=<u> --regid=<g> --clear-groups -- <argv>`.
Row C runs `setpriv --reuid=0 --regid=0 --groups=19999`: a `<uid>:19999 2770` data dir is EACCES to userns-root without the group (no DAC caps).
`oom_score_adj` is raised on the wrapper itself before the drop (inherited across exec, needs no
cap). Rlimits (`errors/limits.mjs`): `data` 1 GiB default (`≥ 1024M`, floor: 512M aborts node at
boot), `core 0`, `nproc 64`, `nofile 1024`; never `RLIMIT_AS`. Worker `--max-old-space-size` =
`(data − 576 MB) × 0.85` in MB, min 256.

Group rule at every site: workers, install, freeze, git, helper → `--clear-groups`; the session
supervisor alone carries `[19999]`; the host adds an `appgid` to its own supplementary groups
(`os.setgroups`) for the duration of a read of that app's folder (§6.2) and drops it after.

### 2.3 Teardown order (host SIGTERM)

1. `registrar.draining()` → spine `draining_at` (fleet), stop accepting new connections
   (`server.close(drainMs)` / the dev shell: idle keep-alive sockets closed, in-flight requests
   finish for up to 20 s — the §4.7 25 s long-poll fits inside the 30 s cap — then cut).
2. `watchdog.stop()`: SIGCONT every SIGSTOPped worker (a stopped process cannot run a teardown).
3. Every worker: SIGCONT → SIGTERM → wait ≤ 2 s for exit (the runtime stops accepting, runs the
   module teardown, finishes its in-flight responses ≤ 1.5 s, exits) → `SIGKILL` the process group
   at the deadline.
4. Pending event batch flushed once (best effort, 1 s cap), agent.log line `host: stopped`.
5. Exit 0. The launcher forwards this order in §2.1 step 6 so it completes before PID 1 exits.

## 3. Filesystem contract

`<inst>` = instance id, format `i-<16 lowercase hex>` (`INSTANCE_RE` in `hygiene.mjs`); `<uid>` = `20000+i`;
`<agid>` = 19999. "who" = who creates it; the mode is set at creation (mkdir with mode / write
with mode); the ONLY chmod-after-chown sites are the two round trips of §6.2.

| path | owner:group mode | who | notes |
|---|---|---|---|
| `/work` | `1000:1000` (0755 fresh, 2775 migrated) | launcher, every boot (taken back 0:0 for the markers, then to the agent — steps 0/2) | agent owns it: can rename `.atelier` → the host works through the dirfd and treats a renamed/missing `.atelier` as a fault (`readlinkFd(dirfd) !== /work/.atelier` checked every 5 s) |
| `/work/lost+found` | `1000:1000 0700` | launcher (chown only) | before the `/work` chown |
| `/work/apps` | `1000:1000 0755` | launcher iff missing | |
| `/work/apps/<slug>` | `1000:<uid> 2750` | agent (mkdir); host round trip §6.2(a) at claim | the worker reads its sources through appgid; peers EACCES |
| `/work/apps/<slug>/node_modules` | `1000:<uid>` dirs 0750 files 0640 (`|050`/`|040` normalised) | freeze.py | never written by root; installed in scratch, renamed in as uid 1000 |
| `/work/apps/<slug>/CLAIM-REFUSED.txt` | `1000:1000 0644` | registrar via row G-style uid-1000 write | the only host write into an app folder, as uid 1000, `O_NOFOLLOW`, `wx` |
| `/work/apps/<slug>/.git` | `1000:1000` | git as 1000 (row G) | one commit per RELEASE (`atelier deploy`), one `adopt:` commit for a pre-release row; `.gitignore` (`data/ .env .env.* node_modules/ CLAIM-REFUSED.txt .atelier`) written once, never over the agent's |
| `/work/.atelier` | `0:0 0711` | launcher | the dirfd root; markers below are `at(dirfd, …)` writes; a worker cannot enumerate its peers' instance ids |
| `/work/.atelier/agent.log` | `0:1000 0640` | host (`errors/agentlog.mjs`) | agent reads; workers cannot (groups cleared) |
| `/work/.atelier/registry.json` | `0:0 0600` | registrar, local mode only | the folder registry (§7 `localTransport`) |
| `/work/.atelier/<inst>/` | `0:0 0711` | host at claim | markers, every one `0600` (the host's alone): `slug`, `uid`, `revision.json` (`{rev, live, sha256, bytes, builtAt, host, chrome, protocol, fingerprint, slug, prod:{rev, commit, deployedAt, message, legacy?}}`), `current` → `../last-good/<inst>/rev-N` (the PROD rev; symlink, atomic rename), `current-dev` → the DEV rev, `registered.json` (`{instance, slug, uid, company}`), `releases.jsonl` (the last 50 release rows), `backups.json` (backup sizes) |
| `/work/.atelier/chrome` | `0:0 0755` | host (`hostDirs`) | the chrome cache (step 7 ship C, `host/chrome/fetch.mjs`): `<digest>/` (dirs 0755, files 0644 — `frontend.js`, `kit.js`, `styles.css`, `chrome.css`, `fonts/*.woff2`, `manifest.json` last) fetched from the spine (`GET /v1/host/chrome/<digest>`) and verified (every sha, the recomputed digest), `current` → `<digest>` (symlink, atomic rename); current + previous kept, older pruned at a swap, `.tmp-*` swept at boot; the host alone reads it — every app sheet compiles against `current` (ATELIER_CHROME_DIR is the fallback while no release is held) |
| `/work/.atelier/data` | `0:0 0711` | launcher | |
| `/work/.atelier/data/<inst>` | `<uid>:<agid> 2770` | host at claim (mkdir, chown) | `ctx.dataDir`; agent in group via 19999; peers EACCES; data files 0660 (worker umask 002, agent umask 002 inside — the worker chmods sqlite `-wal`/`-shm` it creates to 0660, round trip §6.2(b) for agent-created ones) |
| `/work/.atelier/data-dev` | `0:0 0711` | host (`hostDirs`) | |
| `/work/.atelier/data-dev/<inst>` | `<uid>:<agid> 2770` | host at the dev spawn (`jailPlan`) | the DEV slot's `ctx.dataDir` (§10.3 D1) — the same plan as `data/<inst>`; Bayard may `cp -a` prod → dev, never the reverse |
| `/work/.atelier/prod` | `0:0 0711` | host (`hostDirs`) | |
| `/work/.atelier/prod/<inst>/<commit12>` | `0:<uid> 0750`; files 0640; `node_modules` `0:<uid>` (`|050`/`|040`) | host at a deploy (rows A/T, then `freeze.py --dest`) | the released commit's export = the prod worker's cwd (`createRequire` base, static files); no `.git`, no `data/`; the current and the previous release's are kept, older ones removed; EACCES to uid 1000 |
| `/work/.atelier/rehearsal/<inst>` | `0:<uid> 0750` | host at a deploy | `data/` `<uid>:19999 2770` = the `cp -a` copy of prod data the rehearsal worker and hooks run against; deleted when the rehearsal ends |
| `/work/.atelier/backup` | `0:0 0711` | host (`hostDirs`) | |
| `/work/.atelier/backup/<inst>/<YYYYMMDDTHHMMSSZ-revN-commit12>` | `0:19999 0750`; inside: `0:19999` (one chown pass after the copy), modes from umask 027 (files 0640, dirs 0750), times = the copy's — root owns every byte, the agent reads through gid 19999, the app's uid never owns (so never chmods) its own backups; neither modes nor times are "preserved": that would be a chmod/utimensat on a foreign inode | host under the gate (row C) | the pre-migration snapshot of prod data (a deploy's `backup`, a restore's `snapshot`); listed only once its `backups.json` marker landed (a half-copied dir is swept, never restorable); last 3 per app, ≤ 1 GiB total; never auto-restored (`atelier restore`) |
| `/work/.atelier/last-good` | `0:0 0711` | launcher | |
| `/work/.atelier/last-good/<inst>` | `0:<uid> 0750` | host at claim | the worker resumes from it; agent EACCES |
| `/work/.atelier/last-good/<inst>/rev-N/` | `0:<uid> 0750`; files 0640 | host per LIVE build | `backend.js` (bundle), `frontend/<file>.js` (transformed), `styles.css`, `revision.json`; written to `rev-N.tmp-<pid>`, fsynced, renamed; the previous rev kept, older pruned |
| `/work/.atelier/scratch` | `0:0 0711` | launcher | |
| `/work/.atelier/scratch/<inst>` | `0:<uid> 0750` | host at first install | `home/` `<uid>:<uid> 0700` (npm HOME + cache), `build/` `<uid>:<uid> 0755` (package.json copy, node_modules) |
| `/work/.atelier/tmp/<inst>` | `<uid>:<uid> 0700` | host at claim | worker `TMPDIR` (keeps `/dev/shm` clean) |
| `/run/atelier` | `0:0 0711` | launcher | tmpfs; the mount arrives `1777` and the launcher's plan chmods it `0711` right after its mkdir — before the tokens and before any uid-1000 process exists (`chmodIfRootOwned`); the host refuses to start when `$run`, `$run/w` or `.atelier/tmp` exist owned by another uid |
| `/run/atelier/bootstrap.token` | `0:0 0400` | launcher | read once by the host, exchanged at registration |
| `/run/atelier/dev.token` | `0:0 0400` | launcher | the host's copy |
| `/run/atelier/session/` | `1000:1000 0700` | launcher (populated before chown) | `dev.token` `1000:1000 0400` — the agent's copy |
| `/run/atelier/host-ready` | `0:0 0644` | host after the audit passed and both listeners are up (fleet: after registration) | the kube readiness probe (step 5); unlink + exclusive create (`wx`) — a pre-existing entry is never adopted; unlinked by the launcher on host exit, by the host at teardown and on a host fault |
| `/run/atelier/dev/` | `0:1000 0710` | launcher | |
| `/run/atelier/dev/shell.sock` | `0:1000 0660` | host (dev shell) | agent connects; workers EACCES |
| `/run/atelier/w/<inst>/` | `0:<uid> 0730` at spawn → `0710` once the LAST spawn of the instance in flight is READY | host at spawn (`jailPlan`, re-set before every spawn) / `lockSockDir` from the supervisor (`row.spawning` counts the spawns in flight — the dir is shared by the dev, prod and rehearsal workers, so one worker's READY never drops the bit under another's `listen`; drill row 9e found the prod resume doing exactly that to the rehearsal worker) | socket dir: the worker binds, cannot list; after READY it cannot write there either (no filling the `/run/atelier` tmpfs for life) |
| `/run/atelier/w/<inst>/w-<slot>-<rev>.sock` | `<uid>:<uid>` at bind → `0:0 0700` after READY | worker binds; host chowns+chmods after READY | one name per slot and rev (`dev`, `prod`, `rehearsal` — §10.3 D5); the rehearsal socket stays `<uid>`-dialable (the smoke step's `ATELIER_SOCK`) until the rehearsal ends; `prepareDirs` re-sets the dir 0730 before the next spawn so a resumed worker can re-bind |
| `/control/.host-crash` | `1000:1000 0600` | launcher via the uid-1000 helper | JSON lines; the spine reads it (spine lane) |
| `/tmp/tmux-1000` | `1000:1000 0700` | launcher | |
| `/tmp/.X11-unix` | `0:0 1777` | launcher | |

Local mode (`unprivileged()`): the same tree under `ATELIER_WORK`, every chown/chmod a logged
no-op, sockets under `$ATELIER_RUN` (a short path: macOS caps a socket path at 104 bytes).

## 4. Interfaces between lanes

All typedefs live in the owning module's JSDoc; this section is the contract. Every factory
takes its collaborators as arguments so a lane tests alone with fakes.

### 4.1 supervisor ⇄ workers

```js
// worker/spawn.mjs (workers)
/** @typedef {{instance:string, slug:string, company:string, uid:number, rev:number,
 *   codeDir:string,      // last-good/<inst>/rev-N (the bundle to import) — NEVER the app folder
 *   appDir:string,       // /work/apps/<slug> (cwd; createRequire base via the rewritten import.meta.url)
 *   dataDir:string, tmpDir:string, sockDir:string, sock:string,
 *   baseUrl:string, origin:string, configEnv:Record<string,string>,
 *   rlimits:{data:number,core:number,nproc:number,nofile:number}}} WorkerSpec */
/** @typedef {{t:'ready', mountMs:number, importMs:number, resources:Record<string,number>, teardown:boolean}
 *  | {t:'error', kind:'backend', message:string, stack?:string, file?:string, line?:number, col?:number, sample?:object}
 *  | {t:'http5xx', method:string, path:string, status:number, message:string, file?:string, line?:number, col?:number}
 *  | {t:'broadcast', event:object}
 *  | {t:'suspendable'}
 *  | {t:'load-failed', code:'LOAD-ERROR'|'MOUNT-ERROR'|'ERR_MODULE_NOT_FOUND'|'RUNTIME-DEAD', message:string, file?:string, line?:number, col?:number}} ControlMsg */
export function spawnWorker({ os, spec, onControl, onExit, readyTimeoutMs = 8000 })
  // → Promise<{pid, sock, kill(signal), stop(drainMs=2000)}>; rejects {error:'no-ready'|'spawn-eagain'|'load-failed', msg}
  // Control lane = NDJSON on fd 3 (worker → host only); host → worker = signals only.
  // A spawn failure (EAGAIN, exit 134 before READY) is `spawn-eagain`, never a broken app.
```

```js
// worker/runtime.mjs (workers) — reads env.ATELIER_WORKER (the WorkerSpec as JSON) and fd 3.
//   1. process.chdir(spec.appDir)  2. import(pathToFileURL(codeDir + '/backend.js'))
//   3. ctx = Object.freeze({ id: slug, name, workspace: company, qualifiedId: `${company}/${slug}`, label: name,
//        port: <PORT env>, host: <HOST env>, baseUrl, dataDir, log(...a) → stderr line, broadcast(ev) → {t:'broadcast'},
//        module(id) → globalThis.__atelierModuleSlots slot (worker-local; dies with the process),
//        suspendable() → {t:'suspendable'} })
//   4. router = createRouter() (b6 port, verbatim API: get/post/put/delete/patch/head/options/all, ':param', '/*', bare '/',
//      req.params/query/json() (10 MiB cap → 413)/res.json(data, status); first match wins; HEAD→GET)
//   5. teardown = await mod.default.mountRoutes(router, ctx)  (throw → {t:'load-failed', code:'MOUNT-ERROR'})
//   6. http.createServer on spec.sock: `/_atelier/health` (host-only: {rev, uptime}) before the router;
//      req.user = { id, name, claims } parsed from `x-atelier-user`, `x-atelier-name`, `x-atelier-claims` (JSON) — set by
//      the proxy, never from the outside (headers.mjs strips inbound x-atelier-*);
//      a handler throw → 500 {error} + {t:'http5xx'}; any response ≥ 500 → {t:'http5xx'}
//   7. process.on('uncaughtException'|'unhandledRejection') → {t:'error', kind:'backend'} (process stays up)
//   8. after listen: resources = process.getActiveResourcesInfo() counted by type minus the server itself → {t:'ready'}
//   9. SIGTERM → server.close(); await teardown?.(); process.exit(0). Never a bare exit before teardown.
```

```js
// worker/proxy.mjs (workers)
export function proxyRequest({ sock, req, res, user, bodyCap, timeoutMs = 30_000 })
  // → Promise<{status, bytesIn, bytesOut}>. Streams both ways; applies headers.mjs filters; sets x-atelier-user/name/claims;
  //   ECONNREFUSED/ENOENT → 502 {error:'worker unavailable'}; timeout on headers → 504; Upgrade → 426 (no WS lane in 2.0.0).
  //   Disconnect = res.on('close') && !res.writableFinished (never req.on('close')).
```

```js
// worker/jail.mjs (workers) — pure plan + apply
export function jailPlan(spec) → Step[]        // [{op:'mkdir'|'chown'|'chmod'|'setgroups'|'unlink', path, mode?, uid?, gid?}] — asserted in tests
export function applyJail(os, steps)           // runs the plan through the adapter; each step logged `[priv] <op> <path>: ok|<errno>`
export function afterReady(os, spec)           // chown w.sock 0:0, chmod 0700
export function claimRoundTrip(os, appDir, uid) // §6.2(a): chown 0:<uid> → setgroups([uid]) → chmod 2750 → chown 1000:<uid> → drop group
```

```js
// worker/install.mjs (workers)
export async function installDeps({ os, dirfd, spec, log }) // → {ok, ms, files} | {ok:false, class:'install'|'freeze-abort'|'setuid-refused', message}
  // scratch/<inst>/{home,build} → copy package.json (+lock) as the worker → npm (row I) → freeze.py freeze (row F)
  // → on abort: freeze.py cleanup. Triggered by the supervisor on a package.json/package-lock.json change (§6.1).
```

```js
// supervisor/index.mjs (supervisor) — what the other lanes call
/** @typedef {{instance, slug, company, uid, rev:number|null, state:'live'|'stopped'|'loading'|'failed'|'unclaimed', pid?:number, sock?:string, dataDir, dir}} AppRow */
export function createSupervisor({ os, dirfd, cfg, log, report, registrar, onSwap, spawn = spawnWorker, proxy = proxyRequest })
  // .boot()                → Promise<void>   resume table from last-good + markers; no folder read
  // .scan()                → Promise<void>   discovery → registrar.claim per new folder → build
  // .apps()                → AppRow[]
  // .workers()             → [{instance, slug, pid, uid, dataDir, sock, rev, rlimits}]   (the watchdog's input; `slug` labels its metrics rows)
  // .resolve(company, slug)→ AppRow | null
  // .handle(row, req, res, user)  → Promise<void>   proxy to the live worker; resume if stopped (requests held, never 502)
  // .asset(row, rel)       → Promise<{body:Buffer, type:string, rev:number} | null>   frontend js / styles.css / static file of the CURRENT rev
  // .kill(instance, reason)→ void   watchdog: SIGKILL + state 'failed' + restart with backoff (0.5→30 s)
  // .stop(instance)        → Promise<void>   idle-stop (SIGTERM, drain 2 s, pgroup SIGKILL)
  // .rebuild(instance)     → Promise<void>   the watcher's entry point
  // .teardown()            → Promise<void>   §2.3 step 2
```

### 4.2 supervisor → errors, errors → spine

```js
// errors/collector.mjs (errors)
/** @typedef {'build'|'backend'|'frontend'|'http'|'worker'} Kind */
export function createCollector({ log, now })
  // .report(kind, instance, rev, detail)   detail = {message, stack?, file?, line?, col?, hint?, sample?:{url?,ua?,request?:{method,path,status}}}
  //     → fingerprint (protocol/app-errors fingerprint), tally per (instance, fingerprint) over a 1 s window, then
  //       one AppErrorEvent {instance, rev, kind, fingerprint, count, firstAt, lastAt, message, stack?, file?, line?, col?, hint?, sample?}
  //       to every sink; rev < running(instance) → dropped (`stale-rev`) before any sink.
  // .setRunning(instance, rev)               the registration fact (supervisor onSwap; registrar at boot)
  // .running(instance) → number|undefined
  // .sink(fn)                                fn(AppErrorEvent) — agent.log always, push in fleet mode
  // .recent(instance, n=50) → AppErrorEvent[]   the dev shell's /_atelier/events?app=
// errors/push.mjs (errors)
export function push({ transport, backoffMs = [500, 2000, 8000, 30000] }) → (ev) => void
  // validateAppError(ev) first (a refused event is a host bug: log `push: schema ${reason}` and drop);
  // transport.appError({kind:'app-error', error: ev}); one in flight, queue ≤ 200, retry on 5xx/network, drop on 4xx with a log line.
// errors/report.mjs (errors)
export function frontendReport({ collector }) → (body, {instance}) => {ok} | {ok:false, reason}
  // protocol fromFrontendReport(body, now, {rev: collector.running(instance)}) → collector.report('frontend', …)
```

The `hint` on every build failure is the classification line `<file>:<line>:<col> <message> — <fix>`
of `supervisor/bundle.mjs` (8 classes, table in §6.3); `formatForAgent` prints it verbatim.

### 4.3 protocol-server → supervisor, supervisor → protocol-server

```js
// protocol/auth.mjs (protocol-server)
export function createAuth({ registrar, os, nonceMax = 10_000 })
  // .verifyRequest(req, {company, slug, instance}) → {ok:true, user:{id,name,claims}} | {ok:false, status:401, reason}
  //     order: bearer host token (+epoch) → protocol/identity verify(pub, header, {hostId, instanceId, method, path, now, hostStartedAt, nonces})
  //     hostStartedAt = registrar.startedAt (the C3 restart fence); reason logged host-side only, body is `{}`
  // .devRequest(req) → {ok:true, user} | {ok:false}   token in `?token=` or `x-atelier-dev-token`; user = registrar.principal
  //     (`x-atelier-user`/`x-atelier-name` accepted ONLY with the dev token — the agent's act-as switch)
// protocol/server.mjs (protocol-server)
export function createServer({ cfg, auth, supervisor, collector, registrar })   // .listen(), .close()
  // routes (all after auth):
  //   GET|…  /api/<company>/<slug>/<rest>     → supervisor.handle(row, req, res, user)      (404 when resolve() is null)
  //   GET    /modules/<company>/<slug>/<rel>  → supervisor.asset(row, rel)  (`?rev=N` addresses an older kept rev; 404 past the window)
  //   POST   /_atelier/report                 → errors/report (body.instance must resolve to a row of this host)
  //   GET    /_atelier/apps                   → [{instance, slug, company, rev, state}]      (the shell's debug view; bearer only)
  //   GET    /_host/healthz                   → {api:'atelier/2', hostId, epoch, uptime, apps:n}   (bearer only)
  //   GET    /_host/metrics                   → the PLAN §4.5 rows, Prometheus text exposition          (bearer only, §6.6)
  //   anything else → 404; Upgrade → 426
// protocol/events.mjs (protocol-server)
export function createEvents({ transport, hostId, epoch, flushMs = 10, maxBatch = 128 })
  // .invalidate(instance)   one per instance per flush (idempotent); seq per topic, stream `${hostId}:${epoch()}`
  // frames = {stream, topic:instance, seq, type:'invalidate'} (protocol/events validEvent); batches ≤ 128 → transport.events(batch)
```

The supervisor never imports the protocol lane; it emits through `onSwap(instance, rev)` and
`report()`. `serve.mjs` is the supervisor's request side (`handle`/`asset`); `server.mjs` and
`devshell.mjs` are two callers of the same two functions — the same-bytes property (§8.1).

### 4.4 registrar inputs and outputs

```js
// protocol/registrar.mjs (protocol-server)
export function createRegistrar({ os, dirfd, transport, cfg, log, now = Date.now })
  // state: hostId (= computer id, from registration; local: 'local'), epoch (random 16 hex per host start; local: same),
  //        startedAt (ms), company, origin, principal ({id,name} of the chat's agent identity; local {id:'local',name:'local'}),
  //        token (in memory only), apps Map(instance → {slug, uid, rev, tombstone_at})
  // .register()            bootstrap token → transport.register() → {hostId, epoch, token, company, origin, principal, apps[], shellPublicKeyHex}
  //                        local: read registry.json. Retries with backoff forever; the host serves snapshots meanwhile.
  // .claim({slug, meta, dir}) → {instance, uid, adopted|claimed|revived} | {refused:{code, error}}
  //                        uid = persisted apps.uid or the lowest free 20000+i (< 65536), written to <inst>/uid and registered;
  //                        meta split by protocol/registry allowMeta (primary → requested); refusal → CLAIM-REFUSED.txt as uid 1000
  // .unlink(instance)      tombstone (24 h); folder re-created by the same computer → revive with the same instance id
  // .modulesChanged(instance, rev)   → transport.modulesChanged({apps:[{instance, slug, rev}]})  (spine calls setRunning)
  // .heartbeat(ms)         every 10 s: transport.heartbeat({visible_apps, last_served_at, pod_ip, chrome_digest}); visible_apps = live workers + served in 10 min;
  //                        chrome_digest = the digest the host HOLDS (`chromeDigest()`, the cache's current; null = none). `beat()` returns the answer;
  //                        its `chrome: {digest, version} | null` (the register answer's too) → `onChrome` (host/chrome/fetch.mjs createChromeCache.want)
  // .chromeFetch(digest)   GET /v1/host/chrome/<digest> through call() → {digest, version, files:{path: base64}} (15 s bound)
  // .served(instance)      bumps last_served_at (called by serve.mjs on every proxied request)
  // .reconcile(rows)       boot: rows with no folder → unlink, only after /work/apps is readable + 5 s settle, ≤ 5 rows per pass (more → one loud log, next pass)
  // .draining()            preStop: transport.draining()
  // .publicKey()           the shell's assertion key (fleet); local: a key the dev shell mints with
```

Inputs the registrar takes from other lanes: `discovery.mjs` rows `{slug, dir, meta}` (supervisor
calls `claim`), `onSwap` revs (supervisor calls `modulesChanged`), `served` (serve.mjs).

## 5. The adapter seam — `host/adapters/os.mjs`

One object, three implementations: `linuxRoot()`, `unprivileged()`, `memory(state)`. Every
privileged or Linux-only operation in the host goes through it; a lane module that imports
`node:child_process` or calls `fs.chownSync` directly fails review. Pure argv builders
`setprivArgv`, `prlimitArgv` are exported for tests.

| method | linuxRoot | unprivileged | memory |
|---|---|---|---|
| `openDir(p) → fd` | `O_RDONLY\|O_DIRECTORY\|O_NOFOLLOW` (pins the inode) | same | records, returns 3, 4, … |
| `at(fd, rel) → path` | `/proc/self/fd/<fd>/<rel>` — the `*at` form node lacks; resolves from the pinned inode, never by name | `<realpath>/<rel>` | `<registered>/<rel>` |
| `readlinkFd(fd)` | `/proc/self/fd/<fd>` target (the rename/missing check) | the opened path | the registered path |
| `mkdir(p, mode)` `chown` `lchown` `chmod` `lstat` | real | mkdir/lstat real; chown/chmod → `{skipped:true}` | recorded on `state.fs` |
| `setgroups(g)` `getgroups()` `uid()` | real (CAP_SETGID) | skipped / real / real | recorded |
| `spawn(spec)` `spawnSync(spec)` | wraps `SpawnSpec` (§2.2) in `sh -c` (umask, oom self-raise) + `prlimit` + `setpriv` | runs argv with umask only (no drop, no limits) | returns a fake child the test drives (`child.exit()`, `child.stdio[3].emit('data')`) |
| `kill(pid, sig)` | real (CAP_KILL) | real | recorded; `child.onSignal` |
| `rssKb(pid)` `cpuJiffies(pid)` `statfs(p)` `pidsOfUid(uid)` | `/proc`, `statfsSync` | `null` / `null` / real / `[]` | from `state.procs`, `state.statfs` |
| `now()` `platform` | `Date.now()` | same | `state.now` |

`index.mjs` picks `linuxRoot()` iff `platform === 'linux' && uid() === 0`; else `unprivileged()`
and logs `jail: lifecycle-only (no uid drop)` once. Nothing else in `host/` branches on the
platform. `freeze.py` is Linux-only by nature; `install.mjs` under `unprivileged()` runs npm in
the app folder as the current user and skips freeze (logged).

## 6. Behaviour rules per lane (the measured ones)

### 6.1 supervisor
- Discovery: a folder under `/work/apps` is an app iff `module.json` parses; names not matching
  `SLUG_RE` (protocol/registry) → `CLAIM-REFUSED.txt` `bad slug`; `_*`, `.*`, `-*`, space-prefixed
  ignored; a folder with `CLAIM-REFUSED.txt` is skipped until the file is deleted. Meta read =
  `allowMeta(json)`; unknown keys (incl. `visibility`) dropped silently.
- Watcher: ONE recursive watch per app folder, exclusion list `node_modules/`, `data/`, `.atelier`,
  dotfiles, `_*`, `package.json`, `package-lock.json`, `CLAIM-REFUSED.txt`; quiescence = two
  fingerprints (path+size+mtime of the non-excluded set) 100 ms apart identical; overflow or
  `watcher error` → full rescan; heal rule: while an app is in load-error state, `node_modules`/lockfile
  events pass; `package.json`/lockfile events go to `installDeps` (§4.1) and, on success, a rebuild — but only
  when the manifest CONTENT (package.json + package-lock.json) actually changed (`manifestHash`): the
  two-phase install writes package-lock.json back into the app folder, and gating on the fs event alone
  would loop the installer on the freeze's own byte-identical lockfile rewrite.
  Budget: ≤ 2 k inotify watches for 5 corpus apps (g8: 1 687).
- Build = one revision: rev counter `revision.json.rev + 1` (bumped on LIVE and FAILED alike,
  persisted in the marker dir before the worker starts); frontend per-file transform (esbuild
  `transform`, classic JSX `React.createElement`/`React.Fragment`, es2020, `.jsx` → `.js` siblings),
  backend bundle (`packages:'external'`, first-party `import.meta.url` rewritten to the source file
  URL, `target:'node24'`), CSS (§6.4). A failure of any of the three, of `mountRoutes`, or a missing
  `module.json` → `report('build', …)` with the classification hint; users stay on the old rev.
- Load-beside (the DEV slot only — §10.3 D3/D13): the new dev worker spawned from the new rev dir
  while the old dev worker serves; on READY the three swap atomically under one rev (a request
  captures `slot.rev` and `slot.sock` once); the old worker is stopped 500 ms after the swap (§2.3
  step 2 shape). If READY fails with `load-failed` (`MOUNT-ERROR`) and the old dev worker exists,
  retry the mount ONCE after it has exited (the sqlite overlap rule). PROD never overlaps: a
  release stops the old worker under the gate and starts the new one (§10.3 D9) — §10 item 1 is
  closed by the ruling.
- Old revisions: the previous rev dir is kept and addressable via `?rev=N` for 10 min after a swap,
  then pruned; `current` always names the live one.
- Idle-stop (R14): only when the READY report's `resources` is empty (nothing but the IPC server) or
  `{t:'suspendable'}` arrived, and no request for 60 s; resume from `current` on the next request
  with requests held (≤ 100 ms in a pod), never 502; a broken folder never affects a resume.
- Boot: table from `last-good/*/` + markers; every row starts `stopped` (lazy resume); the first
  scan re-claims folders and rebuilds only folders whose fingerprint differs from `revision.json`.
- Sweep = a net, not a retry loop: every `scan()` (the 30 s rescan, §9.12) rebuilds a folder only when
  its fingerprint differs from the last state this supervisor BUILT — `row.attempted`, recorded by
  `build()` before its first failure path whatever the outcome was, falling back to the live rev's
  `fingerprint` for a boot row. A build that FAILED is that folder's answer: since the rev counter
  bumps on LIVE and FAILED alike, rebuilding an unchanged broken folder would mint a rev every 30 s,
  and the app-error fold is per (instance, rev) — the agent would hear the identical `file:line` as a
  new save each sweep. Same rule for a `module.json` that does not parse (discovery's `problems`).
- Git (row G, §10.3 D7): `git init -q` + the `.gitignore` once at claim/adopt as uid 1000 (`set -C`: the agent's own file stays); the commit is the deploy's (`atelier deploy` = `git add -A && git commit -m <message>`) — history is releases, a save commits nothing; failures logged, never fatal.

### 6.2 workers — ownership round trips (the only foreign-inode chmods)
Both act on an fd, never on a path: the entry lives in an agent-owned directory the agent can swap
for a symlink between discovery and the round trip, and `chown(2)`/`chmod(2)` follow symlinks.
(a) at claim, the agent-created `1000:1000` folder: `setgroups([<uid>])` → open
`O_DIRECTORY|O_NOFOLLOW` → `fstat` must be a directory owned by 1000 with gid 1000 or `<uid>`
(anything else — a symlink `ELOOP`, a swapped-in root inode `EOWNER`, a file `ENOTDIR` — is refused
and left untouched) → `fchown 0:<uid>` → `fchmod 2750` → `fchown 1000:<uid>` → close → restore
groups. (b) agent-created sqlite `-wal`/`-shm` inside dataDir found `0644`: open `O_NOFOLLOW` →
`fstat` must be a regular file with one link owned by 1000 → `fchown 0:19999` → `fchmod 0660` →
`fchown <uid>:19999` (the watchdog's du pass reports them; the runtime's db helper chmods its own).
`freeze.py` chmods only inodes root owns at that moment and refuses setuid/setgid files before any
chown.
- Jail plan per instance (§3 rows): socket dir `0:<uid> 0730`; after READY socket `0:0 0700`; spawn
  cwd `/`; worker chdir; env exactly row W; `--clear-groups`; rlimits §2.2; oom self-raise.
- Install: cold ≤ 3 s for a lockless 4.4 k-inode tree in a pod (g2: 1 844 ms), freeze ≤ 100 ms
  (45 ms), thaw → no-op install → freeze#2 all rc=0; setuid plant → `FREEZE-ABORT` + `cleanup`,
  nothing lands in the app folder. `node_modules` in the app folder ends `1000:<uid>`, no g/o write.

### 6.3 errors
- Build classes (hint text is the fix line; `bundle.mjs` produces `{file,line,col,message,hint}`):
  jsx syntax · css unclosed/invalid · missing relative import (multi-file save: "write the imported
  file, then re-save") · missing package (`run npm install <pkg> in <dir> and re-save`) · backend
  syntax/LOAD-ERROR · MOUNT-ERROR ("mountRoutes must only register routes…") · RUNTIME-DEAD (worker
  exited during load) · module.json missing/invalid/`name` missing. Each with `file:line:col`.
- Runtime: worker `{t:'error'}` → `backend`; `{t:'http5xx'}` → `http` with `sample.request`;
  watchdog kills and crashes → `worker` (message names the cause: `rss 412 MB > 384 MB`, `cpu
  throttled 80 cycles`, `disk 96 %`, `exit 134`); frontend reports → `frontend`.
- agent.log line format: `<ISO> [<slug>] rev <N> <LIVE in <ms> ms | FAILED (users still on rev M) <hint> | STOPPED | RESUMED <ms> ms | KILLED <why>>`;
  appends try/caught, ENOSPC mirrored to stderr, never throws into the caller.
- Push: only in fleet mode; a rev older than `running` never leaves the collector; the spine does the
  10-min fold and the 6/h·12/h caps — the host tallies 1 s only.
- Watchdog (120 ms tick): RSS > cap (`data − 640 MB`, min 256 MB) → SIGKILL + `worker` report; CPU >
  35 % of one core over the tick → SIGSTOP for `min(400, 120·(1−0.35/pct))` ms then SIGCONT (a throttle,
  never a kill; peer latency stays < 200 ms); statfs of `/work` every 5 s → ≥ 95 % used → SIGSTOP
  the worker whose dataDir grew most (du every 60 s, `du -s` per dataDir + `/dev/shm` per uid) +
  report, SIGCONT when < 90 %. All through the adapter.

### 6.4 CSS (supervisor/tailwind.mjs)
One sheet per app = the chrome dir's `styles.css` compiled with `compile()` from
`@tailwindcss/node` (`base` = chrome dir) and `Scanner({sources:[]}).scanFiles(contents)` over an
EXPLICIT list: the chrome folder's and the app folder's `.jsx/.js/.tsx/.ts/.html` files, walked
recursively with the 1.x exclusions (`node_modules`, `data`, dotfiles, `_*`), every line > 8 KB split
at 200 chars before scanning. No resident compiler; recompiled on every save; a chrome change
rebuilds every app sheet. No chrome dir → the app's own `styles.css` passed through unchanged.
Budget: ≤ 50 ms cold in-process for the median corpus app (b5: 4.9 ms), ≤ 200 ms for a 5 k-candidate app.

**The chrome dir** (step 7 ship C, R-CHROME decisions 7–8; `host/chrome/fetch.mjs`): the release the
host HOLDS — the cache's `current` under `/work/.atelier/chrome/<digest>/` (§3) — else `ATELIER_CHROME_DIR`
(local mode; the system host's `/opt/chrome` while the spine names no release). The spine names the
computer's effective release in every register and heartbeat answer (`chrome: {digest, version} | null`);
the host fetches what it does not hold after `registered` resolves (never on the boot path), verifies
every sha and the recomputed digest, swaps `current` and — once the supervisor has booted — reports the
held digest at once (one beat) and `supervisor.rebuildAll()`: every prod slot gets a NEW rev of the same
code with a sheet compiled against the new chrome (`store.clone`, no gate, no restart; `current` moves,
the previous rev stays addressable for the window, one `onSwap` → `modulesChanged` → the company's
frames, so a tab on that app reloads once with the new chrome), every linked row a dev rebuild. With a
digest held the sheet build rewrites every RELATIVE `url()` of the chrome's source to
`/_chrome/<digest>/…` (`buildSheet({chromeBase})` — the bundle's `fonts/…` are served by the shell there);
`revision.json.chrome` is the digest (the folder's name without one). A fetch that fails or is refused
keeps `current` (the cached fallback) and retries at the next beat; no cache and no folder = no chrome dir,
as before a release. The dev shell serves the same dir (`chrome.dir()`) and the cache's files at
`/_chrome/<digest>/<path>`, so render-verify sees the digest the company sees.

### 6.5 protocol-server
- Auth order and reasons are protocol/identity's; `hostStartedAt` is mandatory; nonce cache per
  process, pruned at 10 000. A missing bearer, wrong epoch, missing/invalid assertion → 401 `{}`.
- Header policy both ways = `protocol/headers.js` (`filterRequestHeaders`, `filterResponseHeaders`
  with `cookieCredentialed:false` on the host side — the shell applies the cookie cut — `rejectFraming`);
  body budget streamed, 64 MiB default, counted, 413 past it.
- Dev shell: Unix socket `0:1000 0660` in the `0710` dir + `127.0.0.1:1844`; every request needs the
  dev token (401 otherwise, including the document); identity = `registrar.principal`; act-as
  headers only with the token; serves the 1.x document: `index.html` with
  `window.__ATELIER__ = {mode:'host', label:null, observe:false, user:{id,name,workspaces:[{id:company, modules}]}, workspace, workspaces, chromeQid, defaultChromeQid, chromes, backendErrors}`,
  import map `@atelier/kit → /modules/global/<chrome>/kit.js`, ONE `<link>` to the app's sheet (or the
  chrome sheet on app-less documents), `/assets/{react,react-dom}.js` (production UMDs when
  `NODE_ENV=production`), `/assets/client.js` (transform of `../client.jsx`), `/assets/chrome-resolve.js`,
  `/modules/global/<chrome>/{frontend.js,kit.js,styles.css}` (esbuild bundle with `react*` aliased to
  `../shims/*`, minified in production), `/_atelier/whoami`, `/_atelier/ws` (accept; frames from
  worker `{t:'broadcast'}` stamped `topic = company/slug`; `shell` topic reserved), `/_atelier/events?app=`
  (collector.recent), gzip when accepted. Byte-identical to the protocol server for `/modules/*`.
- Startup audit (before either listener binds — nothing is served, not even a snapshot, while it
  fails): refuse to serve (log + retry every 5 s) while any of `/work/.claude`, `/control`,
  `bootstrap.token`, `dev.token`, `/work/.claude.json`, `/work/.mcp.json`, `/work/.claude/settings.json`,
  `last-good/<inst>`, `data/<inst>` is readable by a uid outside its owner set (mode bits check via
  `lstat`; absent paths are logged as not checked; the memory adapter tests the rule).
- mTLS on the protocol port is mandatory in the fleet: a fleet host without `ATELIER_HOST_TLS` exits 2;
  the explicit value `plain` is the step-2 drill's opt-out (logged INSECURE on every start). The
  port binds the pod IP (never `0.0.0.0`: no loopback path for a worker); local mode binds `127.0.0.1`.
- The dev token never reaches a worker: `?token=` is deleted from the URL forwarded to
  `supervisor.handle` (the rest of the query kept).
- `refuse()`: while the host is in the fault state (§I1 item 17) every request on both listeners
  is answered 503 `{error:'host fault', reason}` before auth or any route.

### 6.6 Metrics (`metrics.mjs`)
`GET /_host/metrics` on the protocol port, behind the same bearer as `/_host/healthz` (401 without it,
503 under the host fault, 404 for any method but GET), `text/plain; version=0.0.4` — the PLAN §4.5 rows
this host owns. Every name is prefixed `atelier_host_` and carries its alarm line in its HELP text.

| family | type | labels | fed by |
|---|---|---|---|
| `atelier_host_save_verdict_ms` (+ `_last_ms`) | summary | `app`, `outcome=live\|error` | supervisor: the watcher's quiescence firing → the swap (LIVE) or the app-error emitted — alarm 1 s |
| `atelier_host_save_verdicts_total` | counter | `app`, `outcome=live\|error` | the same clock's outcome |
| `atelier_host_tailwind_build_ms` (+ `_last_ms`) | summary | `app`, `phase=cold\|warm` | `buildSheet`'s own ms; `cold` = this app's first compiled sheet of this host life — alarm 50 ms cold |
| `atelier_host_worker_resume_ms` (+ `_last_ms`) | summary | `app` | the last-good snapshot resume → the worker's READY, BOTH roads into `resume()`: the request that wakes an idle-stopped worker and the crash ladder's respawn — alarm 100 ms is the wake's (the ladder's backoff is outside the clock) |
| `atelier_host_worker_restarts_total` | counter | `app` | one per rung of the crash ladder (`restartLater`) |
| `atelier_host_watchdog_trips_total` | counter | `app`, `kind=rss\|cpu\|disk\|shm` | the RSS kill, each CPU throttle cycle, the disk stop, the shm stop |
| `atelier_host_events_batch` (+ `_last`) | summary | — | frames per push to the spine (`_count` = pushes, `_sum` = frames) |
| `atelier_host_metrics_series_dropped_total` | counter | — | samples not recorded because a family already holds `MAX_APPS` (128) series |

- `app` is the slug. The save clock starts at the quiescence firing — the save DETECTED, not the build
  started, so a save that queues behind a running build carries that wait — and is consumed by that
  save's verdict; a save that reaches none (the folder vanished, the host entered fault) is dropped,
  never carried into the next save. A build the SCAN triggered is not a save and records no verdict.
- The save `outcome` is a LABEL on the latency, not only on the counter: the 1 s alarm is written for the
  error path, so a slow LIVE build must not fire it and a slow error must not be diluted by fast live
  saves sharing one 128-sample ring. Two series per app instead of one.
- No chrome dir = no Tailwind compile (the app's own `styles.css` passes through) and no sample.
- Bounded by construction: `RING` (128) samples per series — p50/p99 are nearest-rank over that window,
  `_sum`/`_count` count the whole host life — and `MAX_APPS` (128) series per family. The cap counts
  LIVE apps: `gone()` calls `metrics.forget(slug)`, so a host that creates and deletes apps all day is
  not blind to the 129th — only a host serving 128 at once is, and it says so in
  `atelier_host_metrics_series_dropped_total`.
- The host DOES batch its invalidations (coalesced per instance, ≤ 128 per push), so the batch size is
  the host's to report; the other half of that PLAN row — the per-host SHARE of shell ingest time — is
  the shell's: a host cannot see what its batch cost the ring.
- One recorder per host process, created in `index.mjs` and handed to the supervisor, the watchdog, the
  events lane and the protocol server. A lane built without it records into its own — no null checks on
  a hot path, and nothing scrapes it.

## 7. The spine transport (fleet) and its local twin

`transport` is one object with the methods below; `spineTransport(cfg)` speaks HTTP to
`ATELIER_SPINE_URL`, `localTransport(cfg, dirfd)` answers from `.atelier/registry.json` in
process. Both are in `protocol/registrar.mjs` (protocol-server lane); every other lane fakes
the object. The spine's routes do not exist yet — this table is the step-2 spine lane's
contract; until it ships, `host/drill` runs in local mode and the fleet transport is tested
against a fake server in `test/protocol-registrar.test.js`.

| method | HTTP (bearer = registrar token; `register` uses the bootstrap secret) | body → reply |
|---|---|---|
| `register()` | `POST /v1/host/register` | `{pod_ip, host_started_at}` → `{host_id, epoch, token, company, origin, chat, principal:{id,name}, apps:[{instance, slug, uid, rev, deployed_rev}], shell_public_key_hex, chrome}` — the previous epoch is revoked here; `chrome` = `{digest, version}` the computer's effective release, null while the spine names none (§6.4) |
| `heartbeat(b)` | `POST /v1/host/heartbeat` | `{visible_apps, last_served_at, pod_ip, chrome_digest}` → `{ok, config:[{instance, updated}], chrome}` — `chrome_digest` = the digest the host holds (null = none); `chrome` as on register |
| `putApp(instance, b)` | `PUT /v1/apps/<instance>` | `{slug, meta}` (protocol/registry `BODY_KEYS`; `company`/`computer` never sent) → `201 {claimed}` \| `200 {adopted\|updated\|renamed, revived?}` \| `403/409/400 {error}`; the uid is not in this body — it travels in `modulesChanged` and comes back in `register().apps` |
| `unlink(instance)` | `POST /v1/apps/<instance>/unlink` | → `{tombstone_at}` |
| `modulesChanged(b)` | `POST /v1/host/modules-changed` | `{apps:[{instance, slug, uid, rev}]}` → `{ok}` (spine: `setRunning`, `apps.uid` persisted) |
| `events(batch)` | `POST /v1/host/events` | `[{stream, topic, seq, type:'invalidate'}]` ≤ 128 → `{accepted, rejected}` |
| `appError(b)` | `POST /v1/host/event` | `{kind:'app-error', error:<AppErrorEvent>}` → `{ok}` (the spine reuses `parseAppError`) |
| `appConfig(instance)` | `GET /v1/apps/<instance>/config` | → `{env:{K:V}}` (OR14; fetched at every worker spawn, never cached to disk) |
| `draining()` | `POST /v1/host/draining` | → `{ok}` |
| `chrome(digest)` | `GET /v1/host/chrome/<digest>` | → `{digest, version, files:{<path>: base64}}` (~1.2 MB; its own 15 s bound) · `404 unknown-digest` · `503 no chrome store` — the bundle the register/heartbeat answers' `chrome` named (§6.4); the local twin answers 404 (the fixed folder is the chrome) |

Transport rules: 5 s connect / 30 s total timeout; a `401 host-epoch-moved` on any call →
`register()` again; the host token lives in memory only.

## 8. Test plan

### 8.1 `node --test host/test/*.test.js` (macOS and Linux, no root)

The integrator adds `host/test/*.test.js` to `package.json`'s `test` script. Every lane's file
uses `memory()` for privileged behaviour and `unprivileged()` for real processes on the
laptop (Unix sockets under a short `mkdtemp` in `/tmp`). Linux-root-only tests are in the same
files, gated `if (process.platform !== 'linux' || process.getuid() !== 0 || !process.env.ATELIER_DRILL) test.skip(...)`,
and run inside the drill pod (§8.2).

| lane | file(s) | what is asserted (pass line) |
|---|---|---|
| architect | `adapters.test.js` | `memory()` records; `setprivArgv`/`prlimitArgv` exact; wrapper argv for row W byte-exact |
| launcher | `launcher.test.js`, `launcher-signals.test.js`, `launcher-process.test.js` | step order 1→5 as recorded calls (markers before any chown; lost+found before `/work`; chown iff `0:0`; mkdir-with-mode never chmod-after-chown); token files 0400 `wx`; env at rows H/S/X exact (no `ATELIER_BOOTSTRAP` anywhere below the launcher, no `CHANNEL_TOKEN` in H); the storm rule for BOTH children (0.5→30 s, park after 10/10 min, windows independent): a parked host ends the container (supervisor SIGTERM → SIGKILL 10 s, exit 3 whatever it exited with, a pending supervisor restart cancelled), a supervisor exit is a respawn in place (host untouched, no crash line, never a container exit; a runtime storm's park = the host serves on) while a BOOT storm (10 lives in a row dead within 30 s of the spawn) ends the container (host SIGTERM → SIGKILL at grace − 5 s, exit 4, a pending host restart cancelled; a long life resets the row, the window rule then parks in place); `host-ready` unlinked + `.host-crash` line via the uid-1000 helper on host exit; SIGTERM order, restart timers cancelled, `128+sig` mirroring with fake clock; the real-process rows (a host crash and a supervisor exit both restarted, SIGTERM mirrors) |
| supervisor | `supervisor-discovery.test.js`, `-watcher`, `-bundle`, `-tailwind`, `-lastgood`, `-swap`, `-idle` | module.json rule + slug refusals; exclusion list (100 `data/` writes → 0 rebuilds; a `node_modules` storm → 1 rebuild after quiescence); two-fingerprint quiescence; real esbuild bundle with `import.meta.url` rewritten (createRequire resolves from the app folder); the 8 failure classes with `file:line:col` + hint; one-sheet CSS over a 3-file chrome fixture, long line split, no candidate leak between two apps; rev dirs fsync+rename, `current` swap, checksum, previous kept, `?rev=` window; 200 four-fetch observations across 3 saves → 0 mixed revs, 0 non-2xx (real workers, `unprivileged()`); a syntax error / throwing mount / half-written save → users on old rev, report called once each; a broken save and an unparsable `module.json` each survive three sweeps as ONE rev and ONE report while a change the watcher missed is still built; MOUNT-ERROR retry after old exit; idle-stop only on empty resources; resume held, never 502; broken folder while stopped → served from snapshot |
| workers | `worker-spawn.test.js`, `-runtime`, `-router`, `-proxy`, `-jail`, `-install` | SpawnSpec → exact argv/env/cwd/stdio for linuxRoot and unprivileged; READY parsed from fd 3, 8 s timeout, EAGAIN/134 → `spawn-eagain`; router = b6's 20 asserts + `req.json` 413 + HEAD→GET; ctx frozen, `req.user` only from internal headers; teardown runs on SIGTERM before exit (child process of the module killed); resources report shape; proxy streams 1 MiB in / 4 MiB out with byte counts, 502/504/426 mapping, header filters; jailPlan step list per §3 byte-exact; claimRoundTrip order; install orchestration with a fake spawn (scratch layout, freeze argv, cleanup on abort). Drill-gated: real uid drop rows (secret EACCES, peer dir/socket EACCES, `groups=[uid]`, env keys exact, `RLIMIT_DATA` RangeError in-worker, fork EAGAIN at the cap), freeze.py 10/10 |
| errors | `errors-collector.test.js`, `-report`, `-agentlog`, `-push`, `-watchdog`, `-limits` | fingerprint = protocol's; 1 s tally → count; stale-rev dropped before sinks; setRunning reset; frontend `rev-mismatch`; agent.log lines, mode 0640 root:1000 (memory), ENOSPC swallowed + stderr; push validates first, one in flight, retry ladder, 4xx drop; watchdog with fake `/proc`: RSS kill at cap, throttle duty cycle bounded 400 ms, no kill on CPU, statfs 95 % → SIGSTOP the largest dataDir, SIGCONT at 90 %; limits: 512M refused, default 1 GiB, core 0, `--max-old-space-size` formula |
| protocol-server | `protocol-auth.test.js`, `-headers`, `-server`, `-events`, `-registrar`, `-devshell`, `-samebytes` | verify with `hostStartedAt`, nonce replay 401, epoch-moved 401, dev token paths; act-as only with token; headers both ways + framing + 413; routes with a fake supervisor (404 unresolved, `?rev=`, report → collector, Upgrade 426); events: seq per topic, one invalidate per instance per flush, batch ≤ 128, stream = `hostId:epoch`; registrar against a fake spine server: register/heartbeat/claim/adopt/409 → `CLAIM-REFUSED.txt` (as uid 1000, memory-recorded), tombstone/revive, uid 20000+i persisted and reused, reconcile settle + ≤ 5 per pass, `401 host-epoch-moved` → re-register; local transport twin; dev shell: 401 without token on socket and loopback, document bootstrap shape, import map, one `<link>`; `/modules/<c>/<s>/frontend.js` and `styles.css` bytes identical via `server` and `devshell` |

### 8.2 The Linux drill — `host/drill/launcher/run.sh` (one backgrounded task, ≤ 20 min, ends in `VERDICT:`)

Pattern of `r2/spike-g3-step1/run.sh` + `r2/spike-g1-launcher-tree/pod.yaml.tpl`: the laptop
script pins the image digest from `metal/clusters/prod/spine.yaml` (`AGENT_IMAGE`), tars
`host/`, `protocol/`, `node_modules/{esbuild,@esbuild,tailwindcss,@tailwindcss,ws,react,react-dom}`,
`index.html`, `client.jsx`, `chrome-resolve.js`, `shims/`, three portable corpus modules + the
starter app + a chrome fixture into `/tmp/spike-host-launcher-code` on fsn-01, `remote.sh`
creates ns `spike-host-launcher` (copies `ghcr-pull` from `agents`, read only), applies the
userns pod (`hostUsers:false`, `runAsUser:0`, caps `drop ALL add [SETUID,SETGID,CHOWN,KILL]`, no
fsGroup, `restartPolicy: Never`, emptyDir `/work` + `/control` + `/run/atelier`, `/dev/shm` 1Gi,
`command: [bash, /code/host/entrypoint.sh]`, readiness `test -f /run/atelier/host-ready`), runs
`inpod.sh`, copies `out/` back, deletes the namespace in a `trap`. Production namespaces are
never touched; `/var/lib/spine`, `/var/lib/agents`, Longhorn volumes never read.

`inpod.sh` proves, in this order, each line `PASS|FAIL <row>` and the last line a verdict:
1. Ready ≤ 4 s after container start (`host-ready` present; `readyq` loop, 1 s).
2. Process tree: PID 1 bash; launcher root; host root with fd 3 → `/work/.atelier`; session
   supervisor uid 1000 groups `1000,19999` (a stub `/app/session-supervisor.mjs` that sleeps —
   the real one is drilled in g3); zero root-owned inodes in `/work` + `/control` as uid 1000
   (`find ! -uid 1000` over both, `.atelier` excluded by design and listed separately).
3. `kill -9` the host → new host pid, launcher + supervisor pids unchanged, Ready true within 3 s,
   `.host-crash` has one line owned 1000; snapshots served across the blink (peer curl loop
   at 50 ms → ≤ 2 non-200).
4. `node --test` of every drill-gated test with `ATELIER_DRILL=1` as root (§8.1 rows).
5. Three corpus apps + starter: save → LIVE p50 ≤ 350 ms / max ≤ 1.1 s (g4 real corpus), a broken
   save → users on the old rev and an agent.log line ≤ 300 ms; resume from snapshot ≤ 100 ms held.
6. Jail rows from a worker (uid 20001): credential EACCES, peer dataDir EACCES, peer socket
   EACCES, `/run/atelier/dev/shell.sock` EACCES, `127.0.0.1:1844` without token → 401,
   `/run/atelier/*.token` EACCES, env keys = row W exactly; last-good EACCES as uid 1000.
7. Watchdogs: CPU burn → throttle cycles > 0, peer max < 200 ms, worker alive; 2 GB alloc →
   in-worker `RangeError` (RLIMIT_DATA) with `oom_kill 0`; fork 200 → EAGAIN at 64.
8. Install: cold install rc=0 ≤ 5 s, freeze ≤ 100 ms, thaw/no-op/freeze#2 rc=0, setuid plant
   refused, tree `1000:<uid>`, worker `createRequire`s the dep.
9. SIGTERM the pod: teardown lines for every worker, WAL flushed (sqlite integrity ok), PID 1
   exit within grace; 0 processes left (`ps` before the ns delete).
10. `VERDICT: PASS — <numbers>` or `VERDICT: FAIL — <first failed row>`.

Gates carried from PLAN §10: item 1 (sqlite overlap ruling) — the drill's row 5 includes one
sqlite-writing app and records whether the single mount retry suffices; item 2 (g2 skeptic pass)
— row 8 re-runs the run-3 shape; item 3 — the `−FOWNER` set is the drill's cap set, rows 6 and 8
are sites (a) and (b).

## 9. Resolutions of ambiguous or contradictory plan text

1. **`host-crash` "via `/control`"** — `/control` is `1000:1000 0700`; root cannot write there.
   The launcher appends the line through a uid-1000 helper (row X) and unlinks `host-ready`; no
   channel change, the spine reads the marker (spine lane).
2. **`O_PATH` dirfd and `*at` syscalls** — node exposes neither. The dirfd is
   `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` (pins the inode identically) and every relative write is a
   `/proc/self/fd/<fd>/<rel>` path (the kernel resolves from the pinned inode; a renamed
   `.atelier` is detected by `readlinkFd`). Both behind the adapter.
3. **Marker dir vs data/last-good/scratch** — all four under `/work/.atelier`: `<inst>/` (markers),
   `data/<inst>`, `last-good/<inst>`, `scratch/<inst>`; instance ids are `i-<16 hex>` so no clash.
4. **Worker control lane** — the plan names "IPC on a Unix socket" and "READY"; app stdout is app
   logs, node's `'ipc'` channel dies under `env -i`/setpriv (`NODE_CHANNEL_FD`). Control is NDJSON
   on fd 3 (worker → host), signals host → worker, `/_atelier/health` on the socket for probes.
5. **Ports** — protocol listener `1845` on the pod IP; dev shell `127.0.0.1:1844` (the 1.x port the
   agent's tools already use) + the Unix socket. mTLS on 1845 is a config hook, turned on in step 5.
6. **Registrar lane** — the spine has only the step-1 interim `/v1/event` app-error lane under
   `CHANNEL_TOKEN`, which the host must not hold. §7 fixes the host-side contract; the host never
   uses `CHANNEL_TOKEN`. `uid` and `rev` travel in `modules-changed` (protocol/registry's PUT
   body is closed to `{slug, company, meta, computer}`).
7. **`visibility` in module.json** — the agent-contract-2 skill mentions it; OR8/§12 and
   protocol/registry drop it. The registrar ignores it (dropped key); the skill is updated in step 3.
8. **sqlite overlap (§10 item 1, gating)** — default in force: load-beside + one mount retry after
   the old worker exits; no `exclusiveData` declaration in step 2.
9. **Host vs session supervisor naming** — "host supervisor" in the plan = `host/index.mjs` +
   `supervisor/`; "session supervisor" = the image's uid-1000 process, spawned but not built here.
10. **Chrome source** — a folder (`ATELIER_CHROME_DIR`); the pinned-digest fetch of §10 item 6 is
    step 5. No chrome → app-less documents and pass-through app CSS.
11. **Readiness probe** — the host writes `/run/atelier/host-ready`; the step-1 probe still reads
    `/control/.supervisor-ready` until the step-5 pod spec moves it (nothing in step 2 edits a spec).
12. **HOST/PORT/BASE_URL for workers** — `BASE_URL = ctx.baseUrl`
    (`<origin>/api/<company>/<slug>`), `HOST` = the origin's hostname, `PORT` = its port (443 / 1844).
    `ctx.host`/`ctx.port` are therefore the PUBLIC origin's host and port — the address a module
    composes URLs from — and must not be bound (a worker has no port; `listen()` is OR6's doctor
    finding). MODULES.md's "bind address" wording for `ctx.host` is amended when step 3 forks the docs;
    `worker-spawn.test.js` pins the choice.
13. **Per-instance `oom_score_adj`** — self-raise to 1000 in the spawn wrapper before the drop; the
    host never writes another process's file (EACCES under the plan caps).
14. **`agent.log` location** — `/work/.atelier/agent.log` `0:1000 0640` (agent reads, workers cannot);
    the plan names the file, not the path.
15. **Package.json test script** — `host/test/*.test.js` is added by the integrator, the only
    file outside `host/` touched by step 2 besides `protocol/` fixes.

## 11. Lane notes — launcher (`entrypoint.sh`, `launcher.mjs`, `hygiene.mjs`, `test/launcher*.test.js`, `drill/launcher/`)

Deviations from §2.1–§2.2 as built, current state (details in `host/drill/launcher/README.md`):

1. **The plan is data.** `hygiene.bootPlan(cfg, {bootstrap, devToken})` returns the ordered step list
   (§2.1 steps 1–3b); `launcher.runPlan` executes it through the adapter plus a three-method `io`
   (`umask`, exclusive `write`, `unlink`) — the adapter has no file write/unlink. Proposed adapter
   additions: `writeFile(p, data, mode)` (`wx`) and `unlink(p)`, recorded by `memory()`.
2. **umask 0 while the plan runs.** `mkdir(2)`/`open(2)` mask the mode with the umask, so the plan
   opens with `umask 000` (every step carries its full mode: 0755/0711/0710/0700/1777/0400) and closes
   with `umask 077` for the launcher's own writes from then on. No chmod op exists in the plan.
3. **Container-restart steps** (restartPolicy Always; `/run/atelier` and `/work` outlive the container):
   the plan unlinks the previous life's `host-ready` before anything is spawned, unlinks each token
   before its `wx` write (re-minted every launcher life), and reclaims an existing 1000-owned
   `/run/atelier/session` with `chown 0:0` before populating it (root cannot create inside it
   otherwise) — the only chown of a non-fresh inode; it is chowned back after the token lands.
   An existing marker with the wrong owner/mode is logged `exists <uid>:<gid> <mode> — wrong (want …), left`.
4. **Env rows are explicit key lists** (`scrub` never spreads): H = `PATH LANG LC_ALL TERM TZ ATELIER_*`
   plus the launcher-set keys (`ATELIER_DIRFD=3`, `ATELIER_RUN/WORK/CONTROL`, `ATELIER_SPINE_URL` =
   pod `CHANNEL_URL`, `HOME=/root`, `NODE_ENV=production`); S = `PATH LANG LC_ALL TERM TZ CHAT_ID PERSONA*
   STORY_TEXT CHANNEL_URL CHANNEL_TOKEN CHANNEL_CHAT ANTHROPIC_* DISABLE_AUTOUPDATER HORSE_BROWSER_*
   FLEET_EGRESS* PIP_USER NPM_CONFIG_PREFIX` plus `HOME=/work` (what k8s.ts `buildSessionPod` and the
   Containerfile set); X = `PATH`. `ATELIER_BOOTSTRAP` is never copied by `scrub` under any list. The
   adapter's `sh -c` wrapper adds `PWD`, `SHLVL`, `_` to every child.
5. **Row X is `os.spawn`, not `spawnSync`** (`spawnSync` has no stdin): `stdio[0]='pipe'`, the JSON line
   written to `child.stdin`. `memory()`'s fake child has no stdin, so the line is unit-tested as
   `crashLine()` and the file is the drill's row 3.
6. **Backoff window:** delay = 0 for n = 1, else `min(30 s, 0.5 s × 2^(n−2))`, with n = host exits in
   the last 10 min (one crash is not a loop: the blink after a `kill -9` is the host's boot alone —
   §I1 rows); the 10th exit in the window parks the host and ends the container (exit 3, the supervisor
   SIGTERMed first). The session supervisor has a window of its own under the same rule (`supExitTimes`);
   parked, it stays down while the host serves — unless the park is a BOOT storm (`supBootDeaths`: ten
   lives in a row each dead within `supBootMs` = 30 s of the spawn), which ends the container (exit 4,
   the host SIGTERMed first). `exits` in the crash line is the launcher-life total.
   Before every restart the launcher SIGKILLs the dead host's workers (`orphanedWorkers()`: every
   `/proc/<pid>/status` whose real uid is in 20000–65535; root + CAP_KILL) — measured: without it the
   first life's four workers ran on beside the second life's, the sqlite one holding its lock.
7. **`host-ready` at boot:** the launcher also unlinks it in the plan (item 3); the host writes it, the
   launcher unlinks it on every host exit, the host at teardown.
8. **Entry points:** the host is `host/index.mjs` next to the launcher (`import.meta.url`-relative;
   `/app/host/index.mjs` in the image); the session supervisor is `/app/session-supervisor.mjs`. The
   launcher drill replaces the latter with a sleeping stub and the host with `drill/launcher/host-stub.mjs`
   (its rows are the launcher's supervision of the host process; the real host under the same launcher
   is `drill/step2` and `drill/rows`) — no env knob for either.
9. **Drill status:** `host/drill/launcher/run.sh` (rows 1–3 of §8.2 plus the container restart, the
   park storm and the grace-40 delete) is written, not yet run on fsn-01.

## Lane: supervisor — interfaces as built and deviations (current state)

Code: `host/supervisor/{index,discovery,watcher,bundle,tailwind,lastgood,serve}.mjs`, tests
`host/test/supervisor*.test.js` (31 + a shared harness), notes `host/supervisor/README.md`.

1. **Watcher shape (§6.1 "ONE recursive watch per app folder")** — one NON-recursive `fs.watch` per
   non-excluded directory, exclusions applied at registration (g8: node's recursive watch registers
   node_modules as well — 18 299 watches for 5 corpus apps; registration-time exclusion holds the
   ≤ 2 k budget the same row names). Deep `node_modules` writes are therefore invisible; the heal rule
   keys on the root `node_modules` entry and the root `package.json`/lockfile events. Every quiescence
   pass is a full fingerprint walk (queue overflow safe); a `watch error` re-registers.
2. **Socket per rev (§3 `w.sock`)** — `spec.sock = <sockDir>/w-<rev>.sock`. Load-beside needs the new
   worker bound while the old serves the same instance, and a proxy's keep-alive pool is keyed by
   socket path (measured in the swap test: the old worker kept answering under one name). The dir
   stays `0:<uid> 0730`; `afterReady` chowns whatever `spec.sock` names.
3. **`asset(row, rel, {rev})`** — the third argument carries `?rev=N` (the protocol server / dev shell
   parse the query); js/css come from the rev dir, static files from the folder with the gid held.
4. **`revision.json`** = `{rev, live, sha256, bytes, builtAt, host, chrome, protocol, fingerprint, slug}`:
   `rev` is the counter (bumped on LIVE and FAILED, persisted before the build), `live` the rev
   `current` names, `fingerprint` the watcher fingerprint the live rev was built from (boot compares).
5. **Log interface** — `log(line)` or `log.write(line)`; the supervisor emits `[<slug>] rev N LIVE in
   <ms> ms | FAILED (users still on rev M | see nothing — never live) <hint> | STOPPED | RESUMED <ms> ms
   | KILLED <why>`; `errors/agentlog.mjs` prefixes the ISO time.
6. **Injection, not import** — `spawn` and `proxy` are required arguments (the workers lane's
   `spawnWorker`/`proxyRequest`); `jail` and `install` are optional (without them the supervisor mkdirs
   `data/<inst>`, `tmp/<inst>`, the socket dir itself and treats an install event as a rebuild —
   local mode). `registrar.appConfig(instance)` is called when present (OR14), else `{}`.
7. **App-group rule (§6.2)** — a ref-counted `os.setgroups` set (two concurrent builds never drop each
   other's gid); discovery holds every known gid for its walk; the watcher reads through a
   group-holding fs proxy; esbuild never touches the disk itself (stdin entry + JS `onResolve`/`onLoad`)
   because its Go service inherits the host's groups only at its first spawn.
8. **MOUNT-ERROR retry** — the old worker is stopped BEFORE the single retry (§6.1); when the retry fails
   too the row is `stopped` and the next request resumes the old rev from `current` (held ≤ resume
   time, never 502). A frontend-only app (no `backend.js`) is LIVE with no worker; `handle` → 404.
9. **`INSTANCE_RE`** is a local copy in `lastgood.mjs` (hygiene.mjs is the launcher lane's) — the
   integrator may re-point the import. `spawn-eagain` → `report('worker')`, rev dir removed, users
   unchanged, no automatic retry before the next save.
10. **Drill rows owed by this lane** — README "What the Linux drill must still prove": gid-held reads
    inside `2750` folders (watch registration, fingerprint, module.json, static, esbuild plugin reads),
    the inotify budget and overflow behaviour, rev-dir modes under umask 077, row G git, the real
    runtime's READY resources and bundle-coordinate error positions, per-rev socket names in the 0730 dir.

## 10. Lane sections (append-only; current state)

### 10.1 workers — `host/worker/`, `host/test/worker-*.test.js`

Built to §4.1/§6.2 as written; the deviations, each a fact the code needs, are:

1. **WorkerSpec gains `name` and `scratchDir`.** `name` = module.json `name` → `ctx.name`/`ctx.label`
   (defaults to the slug). `scratchDir` = `scratch/<inst>` → `HOME = <scratchDir>/home` (row W); when
   the supervisor omits it, `spawn.mjs` derives it from `dataDir`'s parent (`…/scratch/<inst>`).
2. **Row W env gains `TMPDIR = spec.tmpDir`** (§3 names `tmp/<inst>` as the worker's `TMPDIR`; R6
   closure). Order of keys: config keys first, then `PATH, NODE_ENV, APP_ID, HOME, HOST, PORT,
   BASE_URL, TMPDIR, ATELIER_WORKER`; a config key never overrides a fixed one. `PATH`/`NODE_ENV`
   come from an explicit `hostEnv` argument (default `process.env`), never a spread.
3. **The runtime scrubs `PWD, OLDPWD, SHLVL, _, __CF_USER_TEXT_ENCODING`** from its own `process.env`
   at start — the `sh -c` wrapper exports the first four, macOS injects the last. "env keys = row W
   exactly" (§8.2 row 6) is asserted from inside the worker; `/proc/<pid>/environ` carries the shell's
   exports too.
4. **Row W spawns `detached: true`** (own process group) so `stop()` can `kill(-pid, SIGKILL)` at the
   drain deadline (§2.3 step 2, migration-local-2 rule 1).
5. **`spawnWorker` locks the socket itself** (`jail.afterReady`: `0:0 0700`) on READY, before the
   promise resolves; option `lockSocket:false` for laptop tests. Extra options: `hostEnv`, `runtime`,
   `onLog(stream, line, spec)` (stdout/stderr lines; default = the host's stderr prefixed
   `[company/slug]`), `log`. The handle also exposes `ready` (the READY message), `child`, `exited`.
   Rejections are Errors carrying `error`, `msg`, and for `load-failed` `code` + `detail`.
6. **`jailPlan` emits `mkdir(mode) → chmod(mode) → chown`** per directory (not mkdir → chown): the
   host runs under umask 077 (row H), so the mkdir mode alone lands as 0700. The chmod is on a
   root-owned inode (no FOWNER) and precedes the chown; a directory's setgid bit survives the chown.
   The only chmod-after-chown sites remain §6.2 (a)/(b). `jailPlan` covers `data/<inst>`,
   `tmp/<inst>`, `w/<inst>`; `last-good/<inst>` and the marker dir are the supervisor's (it writes
   there); `installPlan` covers `scratch/<inst>/{home,build}`.
7. **Constants live in `jail.mjs` for now** (`AGENT`, `AGENT_DATA_GID`, `WORKER_UID_BASE`,
   `WORKER_UID_MAX`, `INSTANCE_RE`, `appgid`) — identical to §2's; the integrator points one file at
   the other once `hygiene.mjs` exists.
8. **`freeze.py` argv is `<mode> <instance> <slug> <uid> <appgid> --dirfd 3`** and row F's stdio is
   `['ignore','pipe','pipe', dirfd]`: scratch is instance-keyed (`scratch/<inst>`, not `i-<slug>`)
   and opened relative to the inherited `.atelier` dirfd (§9.2). `thaw` is a no-op when `build/` is
   still the worker's (nothing frozen), so every install runs thaw → copy → npm → freeze.
9. **`installDeps` takes `beforeFreeze`** (async hook): `freeze.py freeze` SIGKILLs every process of
   the worker uid (g2 step 1), so the supervisor stops the live worker there (teardown runs) rather
   than losing it mid-request. Also `hostEnv`, `freeze` (script path), `timeoutMs` (10 min).
   The manifest copy into `build/` runs as the worker via `sh -c 'cp …'` (root cannot read the
   2750 folder without appgid).
10. **`proxyRequest` takes `path`** (the mount-relative path + query the supervisor stripped;
    default `req.url`) and answers **404 for `/_atelier/*`** so the worker's health route stays
    host-only. Identity headers: `x-atelier-name` is percent-encoded, `x-atelier-claims` is
    ASCII-escaped JSON (header values are latin1); `runtime.mjs` reverses both.
11. **`createRouter({onError})`** — a superset of b6's `createRouter()`: the runtime's hook for
    `{t:'http5xx'}` on a handler throw. `req.json()` is memoized (MODULES.md). A response ≥ 500 that
    did not throw is reported from `res.on('finish')`.
12. **Resources report** = `getActiveResourcesInfo()` after mount minus a baseline taken before the
    import (top-level timers count), the socket server excluded by construction (not yet listening).
    Child processes are `ProcessWrap`; the SIGTERM drain waits ≤ 1 s for them (inside the host's 2 s).

Stubs: none. Not built here (other lanes): `hygiene.mjs` constants, `errors/limits.mjs`
`rlimitsFor` (the spec carries `rlimits`), the supervisor's calls into `spawnWorker`/`installDeps`,
the drill harness (README lists the rows this lane owes it).

## L1. errors lane — state after build (host-errors)

Files: `errors/{collector,report,agentlog,push,watchdog,limits}.mjs`, `test/errors-*.test.js`,
`test/errors.helpers.js` (the fake clock), `errors/README.md`. Interfaces are §4.2's; the
additions and readings below are current state.

- `createCollector` sinks receive `(ev, {running})` — the running rev rides beside the event so
  `agentLog.appError` writes `FAILED (users still on rev M)` without a second lookup.
- `agentLog({os, path, slugOf})`: `slugOf(instance) → slug` is the integrator's
  (`supervisor.resolve` by instance); without it the line names the instance. FAILED (build) and
  KILLED (worker) lines are written by the collector sink; the supervisor writes LIVE / STOPPED /
  RESUMED through `log.live/.stopped/.resumed` and never logs FAILED itself (one line per failure).
- `exitDetail(code, signal)` (collector.mjs) is the `worker` detail the workers lane passes to
  `report` on a spawn `onExit` (`exit 134` / `signal SIGSEGV` + the fix hint).
- `push({transport, running})` takes `running = collector.running` and drops an event that went
  stale in the queue. The transport signals a spine answer as an `Error` with integer `.status`
  (no `.status` = network); 401/408/429 and 5xx retry on the ladder, other 4xx drop.
- `createWatchdog` reads `rev` and `rlimits?.data` from `supervisor.workers()` rows
  (`{instance, pid, uid, dataDir, sock, rev, rlimits?}`) — `rev` is the report's rev, `rlimits.data`
  moves the RSS cap for a worker with a non-default limit. `du`/`find` run AS THE WORKER UID via
  `os.spawnSync({uid, gid, groups: []})` (a `2770 <uid>:19999` dataDir is EACCES to userns-root).
  `/dev/shm` per uid: stop at 256 MB, resume below 128 MB (defaults). One CPU `worker` report per
  minute after 25 throttle cycles, stable message, numbers in the hint.
- `frontendReport` bounds a flooding tab at 60 accepted reports per instance per minute.
- Adapter note for the architect: `memory().spawnSync` calls `state.answers.spawnSync` twice per
  call (`rec()` + the explicit call); the errors tests keep their answers idempotent.

## L1. protocol-server lane — current state and deviations (append-only)

Implemented: `host/protocol/{auth,headers,events,registrar,server,devshell}.mjs`, tests
`host/test/protocol-{auth,headers,events,registrar,server,devshell,samebytes}.test.js` +
`protocol-fixtures.mjs`, `host/protocol/README.md`. Interfaces as §4.3/§4.4 with these additions:

1. **Bearer wire shape:** `Authorization: Bearer <epoch>.<token>` — the pair `register()` returned;
   reasons `no-bearer | bad-bearer | unregistered | epoch-moved | bad-token`. The shell gets the pair
   from the spine (spine/shell lanes).
2. **`createAuth({registrar, os, cfg, devToken?, now?, log?})`** — `cfg.run` locates `dev.token`
   (read once); `devToken` overrides for tests. `now` is unix seconds. `.bearer(req)` is exported
   beside `.verifyRequest` / `.devRequest` (the bearer-only routes use it).
3. **`createEvents({transport, hostId, epoch})`** — `hostId` and `epoch` may be FUNCTIONS; the
   integrator passes `() => registrar.hostId` and `() => registrar.epoch` (neither exists at
   construction, §1.1 order). `.drain(capMs)` is the §2.3 step-3 flush; `.stop()` clears timers.
4. **`createRegistrar`** takes `fsx` (plain file reads/writes with a mode; default node:fs),
   `liveWorkers()` (the supervisor's live instances, the heartbeat's `visible_apps` input),
   `backoffMs`, `now`. `apps` rows carry `meta` (the dev shell's rail). `claim` reads the
   `<inst>/uid` marker before allocating (a uid on disk is never re-allocated). `.beat()` is
   one heartbeat (tests); `.stop()` ends the interval. `reconcile(null)` = `/work/apps` unreadable.
5. **`createServer`** takes `frontendReport` (errors/report.mjs's function; default = protocol
   `fromFrontendReport` + `collector.report`), `listen: {path} | {port, host}` (tests use a
   Unix socket), `log`. `supervisor.asset(row, rel, {rev})` — a THIRD argument carries `?rev=N`
   (the supervisor lane may ignore it and serve the current rev). `req.url` is passed untouched;
   serve.mjs/proxy.mjs strip `/api/<company>/<slug>`. `/_atelier/report` requires bearer AND an
   assertion with `app = body.instance`.
6. **`outbound()` rewrites a root-absolute `location` onto the mount on the HOST** (the brief's
   "Location rewritten only when root-absolute"); the shell must not rewrite again —
   protocol/headers.js's comment ("the shell rewrites it onto the mount") describes the same
   rewrite, done once, here.
7. **`createDevShell`** takes `auth` (the same object as the server), `chromeSheet()` (the
   supervisor lane's compiled chrome sheet; pass-through until wired), `sockPath`/`devPort`
   overrides (`devPort: null` = socket only), `repoRoot`. It exposes `.broadcast(instance, ev)`,
   `.invalidate(instance)`, `.backendError(instance, msg)` for the integrator (worker
   `{t:'broadcast'}`, `onSwap`, load failures). The dev token is also accepted from the `?token=`
   of a same-origin `referer`. A browser sends the DOCUMENT's URL as referer only for `fetch()`
   and `<link>`/`<script>` sub-requests; a module import sends the IMPORTING MODULE's URL and a
   WebSocket handshake sends none — so the document carries `?token=` on every URL the host
   writes (script srcs, the sheet link, the import map), and `client.jsx` carries it onto the
   URLs it builds (`frontend.js` imports, the `/_atelier/ws` handshake; `withDevToken`, a no-op
   without a token in the document URL). The reload frame is `{type:'reload', moduleId:<company>/<slug>,
   rev, cssOnly}` — the client matches `moduleId` against its module qids and re-imports
   `frontend.js?rev=<rev>`; a failed save (any report with `file` + `hint`) is also the
   `{type:'backend-error', qid, message}` frame, cleared (`message:null`) by the next swap
   [S:host-devshell]. The bootstrap adds `workspace` and `workspaces` beside 1.x's fields (§6.5).
8. Local mode's shell key: `localTransport(...).keys` (Ed25519, minted per process) — its public
   half comes back as `shell_public_key_hex`; the local shell process (step 4) signs with it.

## I1. Integrator — `host/index.mjs`, `host/README.md`, `host/drill/step2/` (current state)

`index.mjs` wires the lanes in §1.1's order; what it adds or reads differently:

1. **`config(env)`** = §1.2 plus `fleet = !!ATELIER_SPINE_URL`, `dirfd` only when `ATELIER_DIRFD` is
   numeric (unset = local mode: the host creates the launcher's rows itself and mints `dev.token` when
   none exists), `ATELIER_GIT_COMMIT=0` disables row G. `podIp()` = the first non-internal IPv4.
2. **Host-owned directories**: `.atelier/tmp` and `$run/w` (0711 root) are the host's — the launcher's
   plan does not create the parents `jailPlan` mkdirs into (`hostDirs()`).
3. **Startup audit (§6.5)** is `audit(os, cfg, dirfd)` in `index.mjs` → `{bad, absent}`:
   `bootstrap.token`/`dev.token`/`.claude.json`/`.mcp.json`/`.claude/settings.json` without g/o bits,
   `/work/.claude` and `/control` without o bits, every `last-good/<inst>` and `data/<inst>` without
   o bits; a non-empty `bad` logs and retries every 5 s BEFORE either listener binds (snapshots are
   loaded, nothing is served); `absent` is logged once as "not present (not checked)".
4. **`registrar.appConfig()` → `{env:{K:V}}`** (§7); the supervisor reads `.env` (was passing the
   whole reply as `configEnv`).
5. **`supervisor.workers()` rows carry `rev` and `rlimits`** — the watchdog's report rev and RSS cap.
6. **The mount is stripped in `supervisor/serve.mjs`** (`mountRelative(req.url, row)` → the proxy's
   `path`): the worker's router sees `/state`, not `/api/<company>/<slug>/state`.
7. **Log routing**: every supervisor line goes to stderr; `LIVE` / `STOPPED` / `RESUMED` also to
   `agent.log`; `FAILED` / `KILLED` reach `agent.log` through the collector sink only (one line each).
8. **Install**: `installDeps` is wired with `beforeFreeze: () => supervisor.stop(instance)` (the freeze
   SIGKILLs the worker uid; the supervisor stops the live worker first, the rebuild spawns the next).
9. **Dev shell chrome sheet**: `chromeSheet()` = `buildSheet({chromeDir, appDir: null})` when
   `ATELIER_CHROME_DIR` is set.
10. **Teardown** (§2.3): `host-ready` unlinked → `registrar.draining()` (fleet, ≤ 2 s) → both listeners
    drained (`close(20 s)`: new connections refused, in-flight requests finish) → `watchdog.stop()`
    (SIGCONT) → `supervisor.teardown()` → `events.drain(1000)` → `host: stopped` → exit 0; the whole
    sequence is capped at 30 s.
11. **`package.json` `test`** now includes `host/test/*.test.js` (§9.15).
12. **Discovery of new folders**: `index.mjs` watches `$work/apps` itself (non-recursive `fs.watch`,
    debounced 300 ms → `supervisor.scan()`, scans serialized) and rescans every 30 s; the per-app
    watchers cover saves inside a folder. A folder discovery skipped as `no-module-json` (a scaffold
    in progress) gets one non-recursive watch of its own (`pendingWatches`, ≤ 32) so its `module.json`
    landing triggers a rescan instead of the 30 s net; closed once it became an app or vanished. The
    sweep only builds folders that CHANGED since the last build (§6.1 "Sweep = a net").
13. **Paths that leave the host process are real**: the supervisor hands `codeDir`, `dataDir`, `tmpDir`
    to workers (and `dataDir` to the watchdog's `du` as the worker uid) as `/work/.atelier/…`, never the
    host's `/proc/self/fd/N/…` form (`realPath()` over `readlinkFd(dirfd)`); the dirfd form stays for the
    host's own marker and rev-dir writes.
14. **Modes under umask 077**: every file or dir the host creates with a mode sets it explicitly
    (chmod on the root-owned inode, before any chown) — `agent.log` 0640, the registrar's marker dir
    0711 and markers 0600, `host-ready` 0644 (`wx` after an unlink), `$run` 0711 (the launcher closes
    the 1777 tmpfs mount root first; `ensureDirs` is the second check and refuses a `$run`, `$run/w`
    or `.atelier/tmp` owned by another uid — exit 2).
15. **The Linux drill `host/drill/step2/`** runs the integrated host in FLEET mode against a fake
    spine on a peer pod (`fake-spine.mjs`: the §7 routes, `validateAppError` on the app-error lane,
    every call logged as JSON lines) with a signer (`signer.mjs`: bearer + protocol/identity assertion)
    dialing the pod IP from outside; one real 1.x module (blitzfeed) + a probe app; rows (a)–(g) in
    `remote.sh`; evidence in `design/atelier2/r2/spike-host-step2/` (RESULT.md: PASS a–g, 2026-08-28).
16. **The step-2 review fixes** (jail / lifecycle / protocol lenses), all unit-tested:
    - `claimRoundTrip` / `dataFileRoundTrip` act on an `O_NOFOLLOW` fd after an `fstat` guard (§6.2);
      the adapter grew `openFile`, `fstat`, `fchown`, `fchmod` (the memory twin refuses a `link` entry
      with `ELOOP`).
    - OR14 config never enters the env the root wrapper chain receives: `spawnPlan` keeps row W only;
      `configEnvOf(spec)` drops the fixed keys and `LD_*`/`DYLD_*`/`NODE_*`/`ATELIER_*`; the rest goes
      to the worker's stdin as one JSON document (`{env:{K:V}}`, then EOF) and `runtime.mjs` assigns
      it to `process.env` after the uid drop, before the bundle import.
    - `worker/proxy.mjs` is the caller of `host/protocol/headers.mjs` (`inbound`, `outbound` with the
      mount — the root-absolute `Location` rewrite happens here, L1.6; `countedBody` cuts a response
      past the per-app cap). `stampUser`/`userHeaders` share one latin1-safe encoding.
    - The worker's SIGTERM path waits for in-flight responses (≤ 1.5 s) before `exit(0)`; `stop()`
      sends SIGCONT before SIGTERM; teardown resumes the watchdog's stopped workers first (§2.3).
    - Boot reconcile gets the DISCOVERED folders (`discover().apps`; `reconcile(null)` when the apps
      root is unreadable — `discover().unreadable`), and every row the registrar tombstoned leaves
      the table (`gone(row, {unlink:false})`).
    - The crash ladder is not reset by a resume; a resumed worker resets it after `stableMs` (60 s)
      of uptime; a LIVE build resets it at once.
    - A snapshot write failure (`nextRev`/`write`: ENOSPC, EIO, EACCES) is a `build` report with a
      hint, last-good keeps serving, the `rev-N.tmp` is removed; `boot()` sweeps `rev-N.tmp-<pid>`
      dirs a previous host life left (`store.sweepTmp`).
    - A jail failure (`applyJail` not ok) is a `worker` report with a host-side hint, never a spawn.
    - A two-phase install holds requests that would resume a stopped worker (`row.installing`;
      `serve.mjs` awaits it) — the freeze's SIGKILL is not reported as a crash.
    - Row G writes `.git/info/exclude` and commits are serialized per app (`row.git`).
    - Both listeners `close(drainMs)` = `closeDraining` (idle sockets closed, in-flight finish, cut at
      the deadline).
    - The push lanes (`events`, `appError`) go through `registrar.lane` = `call()`: a
      `401 host-epoch-moved` re-registers and retries once; `events.mjs` re-queues the instances of
      frames the ring rejected as `stale-epoch`/`unregistered` and re-mints them under the new stream.
17. **The host-fault state**: the dirfd check (every 5 s, and `treeOk()` before every build and spawn)
    finding `.atelier` renamed or removed → `enterFault(why)`: 503 on both listeners, no scans, no
    builds, no resumes, `host-ready` unlinked, one `worker` report per app (OR16), the log line
    repeated every 5 s; never a fresh boot — the operator restores the tree.

## I1. Drill rows — the launcher (`host/drill/launcher/`) and the integrated rows (`host/drill/rows/`) on fsn-01 (current state)

Two backgrounded fsn-01 drills on the pinned agent image, throwaway namespaces, last line `VERDICT:`,
evidence in `design/atelier2/r2/spike-host-step2-rows/`. Both bind the §4.3 pod (`hostUsers:false`,
root, caps `{SETUID,SETGID,CHOWN,KILL}` — **no DAC_OVERRIDE**, no fsGroup, `restartPolicy: Always`).

- **`drill/launcher/`** (DESIGN §8.2 rows 1–6, the launcher supervising the host PROCESS): PID 1 =
  the real `entrypoint.sh` → `launcher.mjs`; the host is `host-stub.mjs` (fd-3 check, `host-ready`,
  HTTP 200 on :1845) and the session supervisor the sleeper — neither has dependencies. The stub is
  shipped AS `host/index.mjs` (the `code` mount is idmapped and 501-owned; container-root cannot
  overwrite a file there in place). PASS: Ready ≤ 4 s after the container start; `inpod` 61/0 (the
  tree at its `uid:gid mode` incl. `/tmp/.X11-unix 1777`, tokens with the right readers, env rows
  H/S/X, umasks, the tmux/X11 rules, `node --test launcher*` inside the pod); `kill -9` the host →
  a fresh host pid, launcher + supervisor pids unchanged, host-ready back < 0.5 s, **1/189 non-200**
  in the peer's 50 ms loop (the stub is the server, only it restarts), one `.host-crash` line
  `1000:1000 0600 {signal:SIGKILL, exits:1}`; `kill -TERM 1` → supervisor exit 1 mirrored as the
  container exit, in-place restart, dev token re-minted, the `session` dir reclaimed; ten kills →
  parked at 10/10 min → the container ends (exit 3, the supervisor SIGTERMed first) → the kubelet
  restarts it → Ready again, 11 crash lines (row 5's expectation since 2026-08-30; its re-run on
  fsn-01 is owed — the measured pass predates the rule); pod delete grace 40 → gone in ~1 s.
- **`drill/rows/`** (rows 5–8 on the INTEGRATED host, step-2's pod + fake spine): apps `probe`,
  `hello`, `locker`, `deps` copied in as uid 1000 after Ready; queried through the dev shell on
  loopback with the dev token.
  - **row 3′ (host kill, integrated)**: the door IS the host, so `kill -9` is a full :1844 outage of
    ~180 ms (a few 50 ms probes) — recorded, not gated at ≤ 2 (that is the launcher stub's row). The
    launcher SIGKILLs the dead host's detached orphan workers (`orphanedWorkers()` over `/proc`,
    uid 20000–65535) before restarting; the second life resumes them fresh — the fix for the g4
    sqlite double-worker hazard. Crash→ready ~180 ms; all four pre-kill workers gone after.
  - **row 6 (jail from a worker)**: credential / peer dataDir / peer socket / dev-shell socket /
    both tokens / `.claude` / `/control` / `agent.log` / `last-good` / `data` all EACCES;
    `127.0.0.1:1844` without a token and with a wrong token → 401; env keys = row W + the spine-held
    `DRILL_CONFIG`; `last-good/<inst>` EACCES as uid 1000.
  - **row 7 (watchdogs)**: CPU burn → the `cpu throttled 25+ cycles/min` report in agent.log, the
    worker seen `State: T` ~420/1200 samples, the peer's `hello` p50 ~1 ms / **max < 5 ms**, worker
    pid unchanged. A single 2 GB `Buffer` → in-worker `RangeError` (`ERR_MEMORY_ALLOCATION_FAILED`),
    `memory.events oom_kill 0`, pid unchanged; the chunked 64 MB-piece variant walls the same way.
    Fork 200 → ~57 spawned + ~143 `EAGAIN` at RLIMIT_NPROC 64; the storm can exhaust the uid's
    thread budget and abort the worker (the jail containing it) — the supervisor resumes it either
    way (recorded).
  - **row 8 (install)**: the hostile `loot-pkg` postinstall's 4755 plant → `FREEZE-ABORT
    setuid/setgid … refused` + `cleanup rc=0`, nothing lands in the app folder, the agent gets a
    `[deps] rev N FAILED … setuid-refused` line. The gate removed → thaw (no-op) → cold `npm install`
    rc=0 (~1.3 s warm, a native `better-sqlite3@12` prebuild + the postinstall dep + `core-js`) →
    freeze ~23 ms (≤ 100 ms) → LIVE at a new rev; `/deps` from the worker = `{sqlite:42, loot:'1.0.0',
    corejs:'ok'}`; the tree as uid 1000 is `1000:<uid>`, no g/o-write, no setuid, all group-readable;
    0 `KILLED` lines. A THIRD save → thaw / no-op install / freeze#2 rc=0.
  - **row 5 (the sqlite overlap gate, PLAN §10 item 1)**: `locker` holds an EXCLUSIVE `node:sqlite`
    lock in its dataDir and writes every 50 ms; **10 of 10 saves went LIVE, 0 FAILED, each needing
    exactly ONE mount retry after the old worker exited** (10 retries / 10 saves), rows and writes
    preserved (count 54 → ~450). The single retry after the old worker exits is SUFFICIENT — the
    mount-then-swap-then-retry rule (§6.1) is confirmed; kill-old-then-mount is not needed.

Two defects the rows drill found and fixed (both unit-tested):
1. **A dead host orphaned its workers.** The host spawns workers detached (`setsid`, §2.2); on a
   `kill -9` of the host they were reparented to PID 1 and kept their sockets, sqlite locks and CPU
   beside the next life's workers. `launcher.mjs` now `orphanedWorkers()` + SIGKILL before every
   restart (§2.1 step 4). Also: the FIRST host exit in a window now restarts at once (0 ms) — one
   crash is not a loop, and the blink after a kill is the host's boot alone.
2. **A re-install after a freeze failed.** `freeze.py` hands `scratch/build` to the agent (1000) for
   the rename and leaves it there; the next install's `applyJail(installPlan)` wanted it `<uid>:<uid>`
   and refused the agent-owned dir with `EOWNER` BEFORE thaw could reclaim it. `installDeps` now drops
   build's three plan steps when build already exists — thaw moves the frozen tree back and re-owns
   build to the worker (`host/worker/install.mjs`).
3. **The two-phase install looped.** The freeze copies package-lock.json back into the watched app
   folder; the watcher fired `onInstall` on that fs event, which ran another install, whose freeze
   rewrote the (byte-identical) lockfile — an endless thaw/freeze loop every ~2 s. It was masked by
   defect 2 (the re-install failed at applyJail) until that was fixed. The watcher now gates
   `onInstall` on the manifest CONTENT (`manifestHash` over package.json + package-lock.json), so an
   identical lockfile rewrite — or a bare touch — does not re-trigger the installer (`supervisor/watcher.mjs`).


### 10.3 slots and releases — `host/supervisor/{slots,deploy}.mjs`, `serve.mjs`, `host/worker/hook.mjs`, `host/devcli.mjs` (LEDGER R-DEPLOY v2, 2026-09-02)

Every app row carries two slots (D3). **`row.dev`** is the agent's tree (`/work/apps/<slug>`): the watcher, `build()`,
`installThenRebuild` and the mount retry drive it alone, it hot-reloads on every save, the dev shell (`127.0.0.1:1844`,
the dev token) serves it, nobody else sees it. **`row.prod`** is the released commit's export
(`/work/.atelier/prod/<inst>/<commit12>`): the protocol port (`:1845`, the shell's road) serves it, the registry's `rev`
and `deployed_rev` describe it, boot resumes it. `handle(row, req, res, user, {slot})` / `asset(row, rel, {rev, slot})`
name the slot (`protocol/server.mjs` → `prod`, `devshell.mjs` → `dev`); a row without a prod slot answers 404
`{"error":"not deployed"}` on `:1845` (a new folder is dev-only until its first deploy, D14/D17). Data: prod =
`data/<inst>` (unchanged), dev = `data-dev/<inst>` (D1). Sockets `w-<slot>-<rev>.sock` (D5). The dev worker is never
resident: idle-stopped 10 min after the last dev request whatever it holds, resumed on demand; prod keeps the R14 rule
(D18). A dev swap fires the dev shell's reload frame only (`onDevSwap`); `onSwap` — `modulesChanged`, the events
invalidate, `collector.setRunning` — fires for prod releases only. Dev-slot failures reach the agent through the
app-error lane with the head `dev:` and **the PROD rev** (`row.prod?.rev ?? 0`: the spine keeps one running rev per
instance and drops lower ones — a dev counter would silence every later prod error).

**The verb** (D6): `atelier deploy <slug> -m "<message>"` (`host/devcli.mjs`, `/usr/local/bin/atelier` in the image)
= `POST /_atelier/deploy {app, message, commit?, noBackup?}` on the dev shell with the dev token (401 without it, 404
`unknown app`, 409 `deploy in progress`, 400 no message), answered as an NDJSON stream of `{t:'step', name, ms, ok,
note?}` lines ending in ONE `{t:'verdict', outcome: green|red|failed, kind, slug, rev, commit, url, api, step?, error?,
backup?, rehearsal:{ms, partial?}, release}` line; `atelier rollback <slug> <commit>` = the same verb with `commit`
(7–40 hex, resolved `git rev-parse --verify <c>^{commit}` as uid 1000); `atelier releases|backups <slug>` read
`GET /_atelier/releases|backups?app=`; `atelier restore <slug> <backup-id>` = `POST /_atelier/restore`. Exit 0 green ·
2 red · 3 failed · 1 usage/transport. Every word the host or the CLI prints is `deploy.mjs` `MESSAGES`
(`docs/atelier2-plan/LANES-DEPLOY-MESSAGES.md` is its source; the skill quotes it).

**The protocol** (`deploy.mjs`; one NDJSON line + one agent.log line `[<slug>] deploy <c12> "<msg>": <step> ok|FAILED
<ms> ms` per step):

| # | step | what | on failure |
|---|---|---|---|
| 1 | `commit` | the dev tree committed as uid 1000 (row G: `add -A`, `commit -m`, `rev-parse HEAD`; `nothing to commit` = the HEAD); a rollback resolves its commit instead | verdict `red` at `commit` — the CLI line and the agent.log `RED` line, no app-error (nothing was rehearsed) |
| 2 | `rehearsal` = `copy` → `export` → `install` → `build` → `hook` → `boot` → `probe` → `test` → `smoke`, ≤ 240 s | prod untouched: `cp -a` prod data → `rehearsal/<inst>/data` (> 1 GiB → skipped, `partial`); `git archive <commit>` as 1000 \| `tar -x` as root into `prod/<inst>/<c12>.tmp`, chmod-then-chown `0:<uid>` (rows A/T); `installDeps({dest})` when the export has a `package.json` (row I as the worker in scratch, `freeze.py --dest` renames `node_modules` in as root — same setuid refusal); the three artefacts into `rev-N` from the export; `module.json` `deploy` as the worker with `DATA_DIR` = the copy (row K, ≤ 60 s); a worker booted against the copy (`w-rehearsal-<rev>.sock`, READY ≤ 8 s); probe `GET /_atelier/health` then `healthz ?? '/'` (< 500, ≤ 5 s); `test` (≤ 60 s) and `smoke` (≤ 30 s, `ATELIER_SOCK` = the rehearsal socket, `BASE_URL=http://localhost`); stop, delete the copy | verdict `red`: ONE `build` report `rehearsal red at <step>: <error>` + hint `nothing deployed — <slug> stays on rev N (<c12>); fix and run atelier deploy again` at the prod rev; the rev dir removed; the export kept for the next attempt of the same commit |
| — | the data question | BEFORE the rehearsal and again BEFORE the gate (D11): prod data > 1 GiB or free space < 2× its size → `red` at `backup` (`backup impossible: …`) unless `--no-backup`; an UNKNOWN answer — the `find -quit` or `du` child failed, was killed or timed out, EACCES — is `red` at `backup` too (`backup impossible: could not read/measure the data dir (…)`) and `--no-backup` does not lift it: unknown never means "no data", a migration never runs on prod data without a snapshot behind it | prod never stopped; nothing exported |
| 3 | the gate (D9): `drain` (inflight 0, ≤ 2 s) → `stop` old (its own 2 s drain) → `backup` (`cp -a` prod data → `backup/<inst>/<id>`, ≤ 30 s; last 3 / ≤ 1 GiB, oldest pruned, the newest always kept) → `migrate` (the hook on PROD data, ≤ 60 s; a rollback runs none) → `start` (≤ 8 s) → `probe` (≤ 5 s) → `release` | `slot.gate` is a promise: a prod request arriving while it is set waits ≤ `GATE_HOLD_MS` (10 s), then answers the shell's exact waking bytes (503 `{"waking":true}`, `retry-after: 2`, `x-atelier-waking: 1`, `cache-control: no-store` — `protocol-samebytes` pins them to `shell/proxy.mjs`); the host is the only party that knows in-flight counts | verdict `failed` (D10): `slot.state = 'down'`, every request 503 `{"error":"app down after a failed deploy","backup":"<id>"}` (no waking flag) until a green deploy or a restore; ONE `worker` report `deploy of <c12> failed at <step>: <error> — <slug> is DOWN` + hint naming the backup; no automatic rollback, no automatic restore. DOWN is on disk: `revision.json.prod.down = {step, error, backup, commit, rev, at}` — a host restart boots the app DOWN and says so (`[<slug>] boot: rev N stays DOWN (…)`), a config stamp on a DOWN app is noted and never released; `prod.releasing = {id, commit, rev, backup, at}` is written before the migration and cleared by `record`, so a host that dies inside the gate boots DOWN too (never the old rev over migrated data). The new rev dir is pinned for the whole verb (`row.releasing`, kept by the rev-dir prune) |
| 4 | `record` | `revision.json.prod = {rev, commit, deployedAt, message}` + `current` → the new rev (D4); `onSwap` (`modulesChanged`, invalidate, `setRunning`); the release row `{id, instance, kind, commit, message, at, by, verdict, rev, rehearsal:{ms, partial, steps}, backup, error, changelog:null}` appended to `<inst>/releases.jsonl` (0600, last 50) then `registrar.release()` = `POST /v1/host/release` (≤ 30 s; a 404/5xx/network failure is logged, never blocks); `atelier_host_deploy_ms{app,outcome}` + `_total`; agent.log `[<slug>] rev N LIVE (prod) commit <c12> in <ms> ms`; the export two releases back removed | — |

Red and failed deploys record a release row too (`verdict` red/failed, `error` = the report's message). Ids: `r-<16 hex>`;
an adopt's `adopt-<commit12>` (the spine replays by id).

**Restore** (`atelier restore <slug> <id> [--yes]`): refused unless the app is DOWN or the caller passed `--yes` (409,
`<slug> is live: restore replaces its prod data with backup <id> (everything written since is lost) — run atelier restore
<slug> <id> --yes to confirm`); the data question first (the snapshot impossible → `restore RED at snapshot: …`, nothing
moved) → the gate → drain → stop → `snapshot` (today's prod data as a backup row like the deploy's, the same caps) →
`restore` (the backup copied into `data/<inst>.restore` as `<uid>:19999`, then two renames: `data/<inst>` → `.old`,
`.restore` → `data/<inst>`, then `.old` removed — prod is never left empty by a copy that died halfway; boot puts a
`.old` back when no `data/<inst>` exists and sweeps both leftovers) → start the CURRENT prod rev → probe → release; a row
`{kind:'restore'}`; the backup stays, the DOWN marker is cleared. **Config release** (D16): the heartbeat reply's `config: [{instance, updated}]` reaches
`supervisor.onConfigStamp`; a prod worker spawned before that stamp (`slot.configAt`) is restarted under the gate
(stop → start, the config is fetched at spawn) → probe → a row `{kind:'config'}`; at most one per app per beat; a
stopped worker just notes the stamp (the next resume fetches the config). **Adopt** (D14): a row whose `revision.json`
has no `prod` block boots serving from `current` (the folder, `legacy`) and is adopted on the first scan: `git init` +
`.gitignore` + `git commit -m "adopt: the tree serving rev N"` as 1000, `prod = {rev, commit, legacy: true}`,
`current-dev` minted, one row `{kind:'adopt', id: adopt-<c12>}` → the spine's `deployed_rev`; it serves exactly as
before (the bundle from the rev dir, static files and `createRequire` from the folder) until its first deploy moves it
onto an export; the `prod` block is the idempotence marker across restarts. At every boot the host re-announces the
prod commit it holds to the spine (`adopt-<c12>`, skipped when the register reply already carries that
`deployed_rev`) so a migrated registry (`deployed_rev = "legacy"`) converges.

**The socket dir under two spawns.** `w/<inst>` is one dir for the dev, prod and rehearsal sockets; its write bit is
opened before every bind and dropped after READY — by the supervisor when `row.spawning` (spawns of the instance in
flight) reaches 0, never from one worker's READY (`afterReady` locks the socket inode only). The install hold makes the
overlap ordinary: prod is stopped for the freeze, the first request after it resumes prod while the rehearsal worker of
the same deploy is binding (row 9e's second run: `listen EACCES … w-rehearsal-6.sock`).

**The install hold.** `freeze.py` SIGKILLs every process of the worker uid and BOTH slots run as it: at
`beforeFreeze` the supervisor stops the dev worker and holds prod under its gate (`holdProd`: stop, the gate released
when `row.installing` settles) — requests wait for the freeze (kill + chown walk + rename) and a cold resume of the
prod worker; past the 10 s hold they get the waking 503. The rehearsal's own install (`withInstalling`) takes the same
hold — so a deploy of an app WITH dependencies is not "prod untouched" for the length of the freeze; drill row 9e
measures it (the numbers land in its VERDICT line). A dev install arriving meanwhile runs after it. Its install is
`freeze.py take` (build/ back to the worker WITHOUT touching the agent's tree — a thaw would move the dev tree's
`node_modules` into the export) → npm → `freeze.py --dest`.

**Ownership** (the review lens): every new row is root-created under the dirfd tree and chmod-then-chown'ed while
root owns it (`ownTree` over the export, the jail plans for `data-dev/`, `rehearsal/`, `backup/`, `prod/`); root never
writes into the agent's tree (the export is a `git archive` stream as 1000 into a root `tar -x`; the `.gitignore` and
every git step run as 1000); the hook's config never enters the env the root wrapper chain receives (stdin, as row W);
`cp`/`rm -rf`/`du`/`find`/`chown` on `<uid>:19999 2770` data run as root with group 19999 (no DAC caps — root cannot even
`readdir` that dir itself, so "does prod have data" is a `find -quit` child, row C); the copy never preserves ownership (GNU cp's way is a chmod after the chown: modes come from umask 007 at creation, one chown pass follows — the CAP_CHOWN direction only); every path a child receives is
the real one, never the host's `/proc/self/fd/N/…` form; git runs from cwd `/` (node chdirs before the uid drop —
root cannot enter the 2750 app folder, `git -C` does as 1000); the rehearsal socket is `0:<uid> 0770` (connect
needs write on the inode: the host and the smoke hook's worker uid both dial it); the worker reads its export
through its gid, uid 1000 gets EACCES; the backup is `0:19999 0750` — the agent reads, no worker traverses. Each
of these five is a row-9 drill finding (2026-09-02): none shows on a laptop, every one bites under the userns caps.

**The apps view** (`GET /_atelier/apps`, both doors): rows carry `rev`/`state` (the prod slot's; `undeployed` before
the first deploy), `deployed_rev` (40 hex or null), `prod_rev`, `dev_rev`, `prod_state` (`live|stopped|loading|failed|
down|null`), `dev_state`. `supervisor.workers()` lists every slot's worker with `key` (`<inst>/<slot>`) and `slot` — the
watchdog keys its state by `key` and passes `slot` into `kill(instance, why, slot)`; the heartbeat's `visible_apps`
counts prod workers only. Three workers of one app can be live at once (dev + prod + rehearsal), each under its own
`rlimits.data` (1 GiB) — the pod's 8 Gi is the ceiling, not a per-app one; a rehearsal worker's watchdog kill is not
reported on its own (the rehearsal step it served goes red, and that is the chat's one message).

Local mode (`unprivileged()`): the same paths under `ATELIER_WORK`, chown/chmod no-ops, `cp`/`rm`/`du`/`tar`/`git` as
the developer, the installer runs npm in the export itself (no installer wired → the dev tree's `node_modules` is copied
into the export), freeze skipped as today.

Tests: `host/test/supervisor-deploy.test.js` (real workers, git, hooks: green / red at every rehearsal step / the gate
under a 20 ms request loop, the 3 s and the past-the-hold hook / failed after the gate + restore / rollback / config /
adopt / backups + the refusal / the release door absent; the 2026-09-02 review rows: the data question failing CLOSED
for EACCES, a killed `find`, a failed or silent `du`; restore `--yes` + the snapshot + a copy that dies; the rev-dir prune
fired mid-verb; DOWN across a restart, the `releasing` marker, the torn `commitProd`; the install with a real dependency),
`supervisor-slots`, `worker-hook`, `devcli`, the verbs in
`protocol-devshell`, `release` + `config` in `protocol-registrar`, the pointers + git in `supervisor-lastgood`, the
plans in `worker-jail`, `--dest` in `worker-install`, the waking bytes in `protocol-samebytes`; the existing suites run
on the slot model. Drill row 9: `host/drill/rows/run-deploy.sh` (the suite inside the pod as uid 1000; the export's
ownership; the hook's uid/env; the backup's readers; `locker` 3/3 green under the prod loop from the peer; `deps` — the
only place `freeze.py --dest` can run: the chown walk needs CAP_CHOWN, a laptop's suite reaches the ownership guard only).
