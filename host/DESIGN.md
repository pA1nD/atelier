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

1. `mkdir` the root-owned markers with their final modes (`mkdirSync(p, {mode})`, never chmod after
   chown): `/work/.atelier` 0755, `/work/.atelier/data` 0711, `/work/.atelier/last-good` 0711,
   `/work/.atelier/scratch` 0711, `/run/atelier` 0711, `/run/atelier/dev` 0710 (then `chown 0:1000`),
   `/run/atelier/session` 0700 (then `chown 1000:1000` after step 3b). EEXIST is fine; a marker that
   exists with the wrong owner/mode is logged and left (the host's audit refuses to serve, §6.5).
   Open `/work/.atelier` as a dirfd (`os.openDir`, §5) and keep it for the launcher's life.
1b. `chown 1000:1000 /work/lost+found` if it exists and is `0:0`.
2. `chown 1000:1000 /work` iff `/work` is `0:0`; a `1000:1000` volume is left untouched.
   `mkdir /work/apps` 0755 + `chown 1000:1000` iff missing (before the `/work` chown, while root can).
3. `mkdir -m 0700 /tmp/tmux-1000` + `chown 1000:1000`; `mkdir -m 1777 /tmp/.X11-unix` (root, no chown).
3b. Tokens: write `$ATELIER_RUN/bootstrap.token` (0400 root) from `process.env.ATELIER_BOOTSTRAP`;
   mint 32 random bytes hex as the dev token → `$ATELIER_RUN/dev.token` (0400 root) and
   `$ATELIER_RUN/session/dev.token` (0400, then `chown 1000:1000` the file, then the dir).
   Every write is `writeFileSync(path, data, {mode, flag:'wx'})` under `umask 077`.
4. Spawn the host (row H). fd 3 = the dirfd. Restart policy on exit: unlink `$ATELIER_RUN/host-ready`;
   append one JSON line `{"at":ms,"code":c,"signal":s,"exits":n}` to `/control/.host-crash`
   through a uid-1000 helper (`os.spawnSync` row X); backoff 0.5 s doubling to 30 s; after 10 exits
   in 10 min stop restarting (log `host: parked after 10 exits/10 min`, the pod stays up).
5. Spawn the session supervisor (row S) in parallel — never after the host is ready.
6. Signals: SIGTERM → SIGTERM the host first, wait ≤ `grace − 5 s` (grace = `ATELIER_GRACE_S`,
   default 40) for its exit while forwarding SIGTERM to the session supervisor; then exit with the
   supervisor's code. Supervisor exit → SIGTERM the host, wait ≤ 10 s (SIGKILL after), exit with
   the supervisor's code, or `128 + signal` when it died by signal. Host exit alone → step 4 policy.
   `sup.kill` EPERM arrives as a ChildProcess `error` event (handled, logged, treated as exited).
   The launcher never exits for a policy reason (auth/limit/claude-gone are the session
   supervisor's relaunches).

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
| G git | host | `git -C /work/apps/<slug> add -A . && git commit -qm 'rev N'` (`git init -q` once) | 1000:1000 / `[]` | `{PATH, HOME=/work, GIT_AUTHOR_NAME=atelier, GIT_AUTHOR_EMAIL=atelier@local, GIT_COMMITTER_NAME=atelier, GIT_COMMITTER_EMAIL=atelier@local}` | 022 | `/work/apps/<slug>` | `['ignore','pipe','pipe']` |

Wrapper for W and I (built by `os.spawn`, §5): `sh -c 'umask 002; echo 1000 > /proc/self/oom_score_adj; exec "$@"' sh prlimit --data=<bytes> --core=0 --nproc=<n> --nofile=<n> -- setpriv --reuid=<u> --regid=<g> --clear-groups -- <argv>`.
`oom_score_adj` is raised on the wrapper itself before the drop (inherited across exec, needs no
cap). Rlimits (`errors/limits.mjs`): `data` 1 GiB default (`≥ 1024M`, floor: 512M aborts node at
boot), `core 0`, `nproc 64`, `nofile 1024`; never `RLIMIT_AS`. Worker `--max-old-space-size` =
`(data − 576 MB) × 0.85` in MB, min 256.

Group rule at every site: workers, install, freeze, git, helper → `--clear-groups`; the session
supervisor alone carries `[19999]`; the host adds an `appgid` to its own supplementary groups
(`os.setgroups`) for the duration of a read of that app's folder (§6.2) and drops it after.

### 2.3 Teardown order (host SIGTERM)

1. `registrar.draining()` → spine `draining_at` (fleet), stop accepting new connections
   (`server.close()`, dev shell closes).
2. Every worker: SIGTERM → wait ≤ 2 s for exit (the runtime runs the module teardown, closes its
   socket, exits) → `SIGKILL` the process group at the deadline.
3. Pending event batch flushed once (best effort, 1 s cap), agent.log line `host: stopped`.
4. Exit 0. The launcher forwards this order in §2.1 step 6 so it completes before PID 1 exits.

## 3. Filesystem contract

`<inst>` = instance id, format `i-<16 lowercase hex>` (`INSTANCE_RE` in `hygiene.mjs`); `<uid>` = `20000+i`;
`<agid>` = 19999. "who" = who creates it; the mode is set at creation (mkdir with mode / write
with mode); the ONLY chmod-after-chown sites are the two round trips of §6.2.

| path | owner:group mode | who | notes |
|---|---|---|---|
| `/work` | `1000:1000` (0755 fresh, 2775 migrated) | launcher chowns once | agent owns it: can rename `.atelier` → the host works through the dirfd and treats a renamed/missing `.atelier` as a fault (`readlinkFd(dirfd) !== /work/.atelier` checked every 5 s) |
| `/work/lost+found` | `1000:1000 0700` | launcher (chown only) | before the `/work` chown |
| `/work/apps` | `1000:1000 0755` | launcher iff missing | |
| `/work/apps/<slug>` | `1000:<uid> 2750` | agent (mkdir); host round trip §6.2(a) at claim | the worker reads its sources through appgid; peers EACCES |
| `/work/apps/<slug>/node_modules` | `1000:<uid>` dirs 0750 files 0640 (`|050`/`|040` normalised) | freeze.py | never written by root; installed in scratch, renamed in as uid 1000 |
| `/work/apps/<slug>/CLAIM-REFUSED.txt` | `1000:1000 0644` | registrar via row G-style uid-1000 write | the only host write into an app folder, as uid 1000, `O_NOFOLLOW`, `wx` |
| `/work/apps/<slug>/.git` | `1000:1000` | git as 1000 (row G) | one commit per LIVE revision |
| `/work/.atelier` | `0:0 0755` | launcher | the dirfd root; markers below are `at(dirfd, …)` writes |
| `/work/.atelier/agent.log` | `0:1000 0640` | host (`errors/agentlog.mjs`) | agent reads; workers cannot (groups cleared) |
| `/work/.atelier/registry.json` | `0:0 0600` | registrar, local mode only | the folder registry (§7 `localTransport`) |
| `/work/.atelier/<inst>/` | `0:0 0711` | host at claim | markers: `slug` (0644), `uid` (0644), `revision.json` (0644, `{rev, sha256, bytes, builtAt, host, chrome, protocol}`), `current` → `../last-good/<inst>/rev-N` (symlink, atomic rename), `registered.json` (0600: `{instance, slug, uid, company}`) |
| `/work/.atelier/data` | `0:0 0711` | launcher | |
| `/work/.atelier/data/<inst>` | `<uid>:<agid> 2770` | host at claim (mkdir, chown) | `ctx.dataDir`; agent in group via 19999; peers EACCES; data files 0660 (worker umask 002, agent umask 002 inside — the worker chmods sqlite `-wal`/`-shm` it creates to 0660, round trip §6.2(b) for agent-created ones) |
| `/work/.atelier/last-good` | `0:0 0711` | launcher | |
| `/work/.atelier/last-good/<inst>` | `0:<uid> 0750` | host at claim | the worker resumes from it; agent EACCES |
| `/work/.atelier/last-good/<inst>/rev-N/` | `0:<uid> 0750`; files 0640 | host per LIVE build | `backend.js` (bundle), `frontend/<file>.js` (transformed), `styles.css`, `revision.json`; written to `rev-N.tmp-<pid>`, fsynced, renamed; the previous rev kept, older pruned |
| `/work/.atelier/scratch` | `0:0 0711` | launcher | |
| `/work/.atelier/scratch/<inst>` | `0:<uid> 0750` | host at first install | `home/` `<uid>:<uid> 0700` (npm HOME + cache), `build/` `<uid>:<uid> 0755` (package.json copy, node_modules) |
| `/work/.atelier/tmp/<inst>` | `<uid>:<uid> 0700` | host at claim | worker `TMPDIR` (keeps `/dev/shm` clean) |
| `/run/atelier` | `0:0 0711` | launcher | tmpfs |
| `/run/atelier/bootstrap.token` | `0:0 0400` | launcher | read once by the host, exchanged at registration |
| `/run/atelier/dev.token` | `0:0 0400` | launcher | the host's copy |
| `/run/atelier/session/` | `1000:1000 0700` | launcher (populated before chown) | `dev.token` `1000:1000 0400` — the agent's copy |
| `/run/atelier/host-ready` | `0:0 0644` | host after both listeners are up (fleet: after registration) | the kube readiness probe (step 5); unlinked by the launcher on host exit and by the host at teardown |
| `/run/atelier/dev/` | `0:1000 0710` | launcher | |
| `/run/atelier/dev/shell.sock` | `0:1000 0660` | host (dev shell) | agent connects; workers EACCES |
| `/run/atelier/w/<inst>/` | `0:<uid> 0730` | host at spawn | socket dir: the worker binds, cannot list |
| `/run/atelier/w/<inst>/w.sock` | `<uid>:<uid>` at bind → `0:0 0700` after READY | worker binds; host chowns+chmods after READY | the dir keeps 0730 so a resumed worker can re-bind |
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
  // .workers()             → [{instance, pid, uid, dataDir, sock}]   (the watchdog's input)
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
  // .heartbeat(ms)         every 10 s: transport.heartbeat({visible_apps, last_served_at, pod_ip}); visible_apps = live workers + served in 10 min
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
  events pass; `package.json`/lockfile events go to `installDeps` (§4.1) and, on success, a rebuild.
  Budget: ≤ 2 k inotify watches for 5 corpus apps (g8: 1 687).
- Build = one revision: rev counter `revision.json.rev + 1` (bumped on LIVE and FAILED alike,
  persisted in the marker dir before the worker starts); frontend per-file transform (esbuild
  `transform`, classic JSX `React.createElement`/`React.Fragment`, es2020, `.jsx` → `.js` siblings),
  backend bundle (`packages:'external'`, first-party `import.meta.url` rewritten to the source file
  URL, `target:'node24'`), CSS (§6.4). A failure of any of the three, of `mountRoutes`, or a missing
  `module.json` → `report('build', …)` with the classification hint; users stay on the old rev.
- Load-beside: new worker spawned from the new rev dir while the old serves; on READY the three
  swap atomically under one rev (a request captures `row.rev` and `row.sock` once); the old worker
  is stopped 500 ms after the swap (§2.3 step 2 shape). If READY fails with `load-failed`
  (`MOUNT-ERROR`) and the old worker exists, retry the mount ONCE after the old worker has exited
  (the sqlite overlap rule; kill-old-then-mount is not offered in step 2 — §10 item 1 is open).
- Old revisions: the previous rev dir is kept and addressable via `?rev=N` for 10 min after a swap,
  then pruned; `current` always names the live one.
- Idle-stop (R14): only when the READY report's `resources` is empty (nothing but the IPC server) or
  `{t:'suspendable'}` arrived, and no request for 60 s; resume from `current` on the next request
  with requests held (≤ 100 ms in a pod), never 502; a broken folder never affects a resume.
- Boot: table from `last-good/*/` + markers; every row starts `stopped` (lazy resume); the first
  scan re-claims folders and rebuilds only folders whose fingerprint differs from `revision.json`.
- Every LIVE rev → `git add -A . && git commit` as uid 1000 (row G), failures logged, never fatal.

### 6.2 workers — ownership round trips (the only foreign-inode chmods)
(a) at claim, the agent-created `1000:1000` folder: `chown 0:<uid>` → `setgroups([<uid>])` →
`chmod 2750` → `chown 1000:<uid>` → restore groups. (b) agent-created sqlite `-wal`/`-shm` inside
dataDir found `0644`: same round trip to `0660 <uid>:19999` (the watchdog's du pass reports them;
the runtime's db helper chmods its own). `freeze.py` chmods only inodes root owns at that moment
and refuses setuid/setgid files before any chown.
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
One sheet per app = `ATELIER_CHROME_DIR/styles.css` compiled with `compile()` from
`@tailwindcss/node` (`base` = chrome dir) and `Scanner({sources:[]}).scanFiles(contents)` over an
EXPLICIT list: the chrome folder's and the app folder's `.jsx/.js/.tsx/.ts/.html` files, walked
recursively with the 1.x exclusions (`node_modules`, `data`, dotfiles, `_*`), every line > 8 KB split
at 200 chars before scanning. No resident compiler; recompiled on every save; a chrome change
rebuilds every app sheet. No chrome dir → the app's own `styles.css` passed through unchanged.
Budget: ≤ 50 ms cold in-process for the median corpus app (b5: 4.9 ms), ≤ 200 ms for a 5 k-candidate app.

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
- Startup audit (before `host-ready`): refuse to serve (log + retry every 5 s) while any of
  `/work/.claude`, `/control`, `bootstrap.token`, `last-good/<inst>`, `data/<inst>` is readable by a
  uid outside its owner set (mode bits check via `lstat`; the memory adapter tests the rule).

## 7. The spine transport (fleet) and its local twin

`transport` is one object with the methods below; `spineTransport(cfg)` speaks HTTP to
`ATELIER_SPINE_URL`, `localTransport(cfg, dirfd)` answers from `.atelier/registry.json` in
process. Both are in `protocol/registrar.mjs` (protocol-server lane); every other lane fakes
the object. The spine's routes do not exist yet — this table is the step-2 spine lane's
contract; until it ships, `host/drill` runs in local mode and the fleet transport is tested
against a fake server in `test/protocol-registrar.test.js`.

| method | HTTP (bearer = registrar token; `register` uses the bootstrap secret) | body → reply |
|---|---|---|
| `register()` | `POST /v1/host/register` | `{pod_ip, host_started_at}` → `{host_id, epoch, token, company, origin, chat, principal:{id,name}, apps:[{instance, slug, uid, rev}], shell_public_key_hex}` — the previous epoch is revoked here |
| `heartbeat(b)` | `POST /v1/host/heartbeat` | `{visible_apps, last_served_at, pod_ip}` → `{ok}` |
| `putApp(instance, b)` | `PUT /v1/apps/<instance>` | `{slug, meta}` (protocol/registry `BODY_KEYS`; `company`/`computer` never sent) → `201 {claimed}` \| `200 {adopted\|updated\|renamed, revived?}` \| `403/409/400 {error}`; the uid is not in this body — it travels in `modulesChanged` and comes back in `register().apps` |
| `unlink(instance)` | `POST /v1/apps/<instance>/unlink` | → `{tombstone_at}` |
| `modulesChanged(b)` | `POST /v1/host/modules-changed` | `{apps:[{instance, slug, uid, rev}]}` → `{ok}` (spine: `setRunning`, `apps.uid` persisted) |
| `events(batch)` | `POST /v1/host/events` | `[{stream, topic, seq, type:'invalidate'}]` ≤ 128 → `{accepted, rejected}` |
| `appError(b)` | `POST /v1/host/event` | `{kind:'app-error', error:<AppErrorEvent>}` → `{ok}` (the spine reuses `parseAppError`) |
| `appConfig(instance)` | `GET /v1/apps/<instance>/config` | → `{env:{K:V}}` (OR14; fetched at every worker spawn, never cached to disk) |
| `draining()` | `POST /v1/host/draining` | → `{ok}` |

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
| launcher | `launcher.test.js`, `launcher-signals.test.js` | step order 1→5 as recorded calls (markers before any chown; lost+found before `/work`; chown iff `0:0`; mkdir-with-mode never chmod-after-chown); token files 0400 `wx`; env at rows H/S/X exact (no `ATELIER_BOOTSTRAP` anywhere below the launcher, no `CHANNEL_TOKEN` in H); backoff 0.5→30 s, park after 10/10 min; `host-ready` unlinked + `.host-crash` line via the uid-1000 helper on host exit; SIGTERM order and `128+sig` mirroring with fake clock |
| supervisor | `supervisor-discovery.test.js`, `-watcher`, `-bundle`, `-tailwind`, `-lastgood`, `-swap`, `-idle` | module.json rule + slug refusals; exclusion list (100 `data/` writes → 0 rebuilds; a `node_modules` storm → 1 rebuild after quiescence); two-fingerprint quiescence; real esbuild bundle with `import.meta.url` rewritten (createRequire resolves from the app folder); the 8 failure classes with `file:line:col` + hint; one-sheet CSS over a 3-file chrome fixture, long line split, no candidate leak between two apps; rev dirs fsync+rename, `current` swap, checksum, previous kept, `?rev=` window; 200 four-fetch observations across 3 saves → 0 mixed revs, 0 non-2xx (real workers, `unprivileged()`); a syntax error / throwing mount / half-written save → users on old rev, report called once each; MOUNT-ERROR retry after old exit; idle-stop only on empty resources; resume held, never 502; broken folder while stopped → served from snapshot |
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
13. **Per-instance `oom_score_adj`** — self-raise to 1000 in the spawn wrapper before the drop; the
    host never writes another process's file (EACCES under the plan caps).
14. **`agent.log` location** — `/work/.atelier/agent.log` `0:1000 0640` (agent reads, workers cannot);
    the plan names the file, not the path.
15. **Package.json test script** — `host/test/*.test.js` is added by the integrator, the only
    file outside `host/` touched by step 2 besides `protocol/` fixes.

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
