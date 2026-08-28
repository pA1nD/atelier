# `host/worker/` — the workers lane (PLAN §4.3 "Workers", DESIGN §4.1, §6.2)

One OS process per app instance, a child of the host, uid `20000+i`, gid = uid, no supplementary
groups. It loads the last-good bundle with the 1.x backend contract verbatim and serves it on a
Unix socket the host alone dials. Everything Linux-only goes through `host/adapters/os.mjs`; the
logic is unit-tested on macOS with `node --test`, the uid/gid/EACCES facts are the Linux drill's.

```
spawn.mjs     spawnPlan(spec)  → SpawnSpec row W (argv/env/cwd/uid/rlimits/umask/stdio/detached)
              spawnWorker(...) → READY wait on fd 3, control lane → onControl, stop() = SIGTERM → pgroup SIGKILL
jail.mjs      jailPlan / installPlan → Step[]; applyJail; afterReady; claimRoundTrip §6.2(a); dataFileRoundTrip §6.2(b)
runtime.mjs   the worker process: router (b6 port), frozen ctx, req.user, health, control messages, teardown on SIGTERM
proxy.mjs     proxyRequest: HTTP over the socket, streamed both ways, protocol/headers filters, 502/504/426/400/413/404
install.mjs   installDeps: scratch layout → thaw → manifest copy (as the worker) → npm (row I) → freeze.py (row F)
freeze.py     freeze | thaw | cleanup — port of r2/spike-g2-install-freeze/freeze.py, instance-keyed, dirfd-relative
```

Tests: `node --test host/test/worker-*.test.js` (jail, spawn, router, runtime, proxy, install). The
runtime and proxy suites spawn real processes and real Unix sockets under `/tmp` through
`unprivileged()`; the jail, spawn and install suites drive the `memory()` adapter and assert the
plans byte-exact.

## Interfaces (current state)

### `spawn.mjs`

`WorkerSpec` = DESIGN §4.1 plus two fields: `name` (module.json name → `ctx.name`/`ctx.label`,
defaults to the slug) and `scratchDir` (`scratch/<inst>`; `HOME` = `<scratchDir>/home`; derived
from `dataDir`'s parent when absent). `spawnPlan(spec, {hostEnv, runtime})` returns the row-W
SpawnSpec: `argv = ['node', '--max-old-space-size=<(data − 576 MB) × 0.85, min 256>', runtime.mjs]`,
env exactly `{PATH, NODE_ENV, APP_ID, HOME, HOST, PORT, BASE_URL, TMPDIR, ATELIER_WORKER}` — no
config key: that env is handed to the root wrapper chain (`sh` → `prlimit` → `setpriv`) before the
uid drop, so a config key such as `LD_PRELOAD` would execute as userns-root. The OR14 config goes
over the worker's stdin instead (`configEnvOf(spec)` → `{env, dropped}`: the fixed keys and
`LD_*`/`DYLD_*`/`NODE_*`/`ATELIER_*` are dropped; `configPayload(spec)` = `{"env":{K:V}}` written
once, then EOF), `cwd '/'`, `uid = gid = spec.uid`, `groups []`, `rlimits`, `oomScoreAdj 1000`,
`umask 002`, `stdio ['pipe','pipe','pipe','pipe']` (stdin = the config lane, fd 3 = control),
`detached true` (own process group, for the SIGKILL sweep). `HOST`/`PORT`/`BASE_URL` come from `spec.origin` and
`spec.baseUrl` (§9.12). `PATH`/`NODE_ENV` come from `hostEnv` (an explicit argument, default
`process.env`) — nothing else of the host's env reaches a worker.

`spawnWorker({os, spec, onControl, onExit, onLog, readyTimeoutMs = 8000, hostEnv, runtime, lockSocket = true, log})`
→ `Promise<handle>`; `handle = {pid, sock, ready, child, exited, kill(signal), stop(drainMs = 2000)}`.
On READY the socket is locked `0:0 0700` (`jail.afterReady`) before the promise resolves.
Rejections are Errors with `error: 'no-ready' | 'spawn-eagain' | 'load-failed'`, `msg`, and for
`load-failed` the runtime's `code` (`LOAD-ERROR | MOUNT-ERROR | ERR_MODULE_NOT_FOUND | RUNTIME-DEAD`)
and `detail` (the control message: message, stack, file, line, col). Exit 134, a signal, or a
spawn `error` before READY is `spawn-eagain`; any other exit before READY is `load-failed` /
`RUNTIME-DEAD`. `stop()` sends SIGCONT (a no-op on a running worker; a watchdog-stopped one could
not run its teardown otherwise), then SIGTERM, waits ≤ `drainMs` for the exit, then SIGKILLs the
process group (`kill(-pid)`) and the pid; it resolves `{code, signal, killed}`.

### `runtime.mjs` (the worker)

Reads `ATELIER_WORKER` (the spec JSON minus `configEnv`/`rlimits`), the config document on stdin
(`readConfig(0)` → assigned to `process.env` after the uid drop, before the import; row-W keys win),
and writes NDJSON to fd 3.
Order: uncaught-exception/rejection handlers → SIGTERM handler → `chdir(appDir)` →
`import(codeDir/backend.js)` → frozen `ctx` → router → `mountRoutes` → resource snapshot →
listen on `spec.sock` → `{t:'ready', mountMs, importMs, resources, teardown}`.

- `ctx` keys, exactly: `id, name, workspace, qualifiedId, label, port, host, baseUrl, dataDir, log, broadcast, module, suspendable`
  (MODULES.md's twelve + `suspendable`). `Object.freeze`d. `port`/`host` are the published `PORT`/`HOST`.
- `ctx.broadcast(event)` → `{t:'broadcast', event}` with any `topic` the module passed removed (one
  stderr warning); the host stamps `topic = company/slug`.
- `ctx.module(id)` → one plain object per `company/id` on `globalThis.__atelierModuleSlots`, worker-local.
- Router = spike-b6's `router.js` verbatim API (`get/post/put/delete/patch/head/options/all`,
  `:param`, trailing `/*` incl. the bare parent, bare `/`, HEAD→GET, first match wins) +
  `req.json()` memoized with the 10 MiB → 413 cap, `res.json(data, status)`. `createRouter({onError})`
  is the runtime's hook for `{t:'http5xx'}`.
- `req.user = {id, name, claims}` from `x-atelier-user` / `x-atelier-name` (percent-encoded) /
  `x-atelier-claims` (ASCII-escaped JSON) — the proxy's headers; `null` when absent. Inbound
  `x-atelier-*` never reach the worker (the proxy strips them).
- `/_atelier/health` → `{rev, uptime}` before the router; the proxy answers 404 for `/_atelier/*`
  from the outside.
- Control messages after READY: `{t:'http5xx', method, path, status, message, file?, line?, col?}` for a
  handler throw (with its location) and for any response ≥ 500; `{t:'error', kind:'backend', message,
  stack, file?, line?, col?}` for uncaught exceptions / unhandled rejections (the process stays up);
  `{t:'broadcast', event}`; `{t:'suspendable'}`.
- `resources` = `process.getActiveResourcesInfo()` counted by type after mount, minus the process's
  own baseline taken before the import (so a `setInterval` at module top level counts). The
  socket server is not in it. Empty = idle-stop candidate (R14).
- SIGTERM: `server.close()` + idle keep-alive sockets closed → `await teardown?.()` → wait ≤ 1.5 s
  (`CHILD_DRAIN_MS`, below the host's 2 s) for the in-flight responses AND the `ProcessWrap` handles
  to go → `exit(0)`. Never a bare exit before teardown; never an exit with a response half-sent.
- The runtime deletes `PWD, OLDPWD, SHLVL, _, __CF_USER_TEXT_ENCODING` from its own env at start:
  the spawn wrapper's `sh` exports the first four, macOS injects the last. `process.env` inside the
  worker is row W exactly; `/proc/<pid>/environ` still shows the shell's exports.

### `proxy.mjs`

`proxyRequest({sock, req, res, user, path = req.url, bodyCap = 64 MiB, timeoutMs = 30 s})` →
`Promise<{status, bytesIn, bytesOut}>`. `path` is the mount-relative path + query the supervisor
already stripped. `rejectFraming` runs on the raw headers first (400); `filterRequestHeaders` then
`userHeaders(user)`; the response goes through `filterResponseHeaders(…, {cookieCredentialed:false})`.
Bodies are piped, never buffered; the body cap is counted on the way in (413). ECONNREFUSED/ENOENT
→ 502 `{error:'worker unavailable'}`; no response headers within `timeoutMs` → 504; `Upgrade` → 426;
`/_atelier/*` → 404. Client gone = `res.on('close')` with `!res.writableFinished` → the upstream
request is destroyed (long-poll/SSE release).

### `jail.mjs`

Constants `AGENT {1000,1000}`, `AGENT_DATA_GID 19999`, `WORKER_UID_BASE 20000`, `WORKER_UID_MAX 65535`,
`INSTANCE_RE`, `appgid(spec) = spec.uid` (the same values `hygiene.mjs` carries; one source once
the integrator wires it). `jailPlan(spec)` → for `dataDir` (`<uid>:19999 2770`), `tmpDir`
(`<uid>:<uid> 0700`), `sockDir` (`0:<uid> 0730`): `mkdir(mode) → chmod(mode) → chown`. The chmod
sits between mkdir and chown because the host runs under umask 077 (row H): root owns the inode at
that moment, so it needs no FOWNER, and a directory's setgid bit survives the following chown
(the kernel kills SUID/SGID on chown for regular files only). `installPlan(spec, scratchDir)` is
the same shape for `scratch/<inst>` (`0:<uid> 0750`), `home/` (`0700`), `build/` (`0755`).
`applyJail(os, steps, log)` logs `[priv] <op> <path>: ok|<errno>`, tolerates `EEXIST` on mkdir —
the existing inode is lstat'ed: root-owned → its chmod/chown run (the socket dir, 0710 after READY,
is re-set 0730); already `<uid>:<gid>` as planned → they are skipped as `owned` (a re-spawn or
resume: root cannot chmod the worker's `data/<inst>` under the plan caps); a foreign owner or a
non-directory → `EOWNER`/`ENOTDIR` — and stops on any other errno. `afterReady` = socket `0:0` then `0700`, then the socket dir `0710` (the
worker cannot fill the `/run/atelier` tmpfs for life; `jailPlan` re-sets `0730` before the next
spawn). The two round trips act on an fd (`fdTrip`): `claimRoundTrip(os, appDir, uid)` =
`setgroups([uid]) → openDir O_NOFOLLOW → fstat (directory, uid 1000, gid 1000 or <uid>; else
ELOOP/EOWNER/ENOTDIR, nothing touched) → fchown 0:<uid> → fchmod 2750 → fchown 1000:<uid> → close →
setgroups(previous)`. `dataFileRoundTrip(os, file, uid)` = `openFile O_NOFOLLOW → fstat (regular
file, nlink 1, uid 1000; else ELOOP/EMLINK/ENOTREG/EOWNER) → fchown 0:19999 → fchmod 0660 → fchown
<uid>:19999 → close`. Nothing is ever chowned or chmodded by path inside an agent-owned directory.

### `install.mjs` + `freeze.py`

`installDeps({os, dirfd, spec, log, hostEnv, freeze, beforeFreeze, timeoutMs})` →
`{ok:true, ms, files}` | `{ok:false, class:'install'|'freeze-abort'|'setuid-refused', message}`.
Privileged flow: `installPlan` → `freeze.py thaw` (a no-op when `build/` is still the worker's) →
`sh -c 'cp package.json [package-lock.json]'` as the worker (it reads the 2750 folder through
appgid; root cannot) → `npm install --no-audit --no-fund` (row I: env
`{PATH, NODE_ENV, APP_ID, HOME=<scratch>/home, npm_config_cache=$HOME/.npm-cache}`, umask 022, cwd
`<scratch>/build`) → `await beforeFreeze?.()` → `freeze.py freeze`. `FREEZE-ABORT` → `freeze.py cleanup`,
class `setuid-refused` when the reason names a setuid/setgid file, else `freeze-abort`.
`freeze.py` argv: `<mode> <instance> <slug> <uid> <appgid> --dirfd 3`, spawned as `0:0` with
`--clear-groups`, env `{PATH}`, umask 022, `stdio ['ignore','pipe','pipe', dirfd]` — it opens
`scratch` relative to the inherited `.atelier` dirfd, so a renamed `/work/.atelier` cannot redirect
the walk; the app folder is opened by name (`/work/apps/<slug>`, `O_NOFOLLOW`, must be 1000-owned)
inside the forked uid-1000 child that performs the rename. Verdict line always last:
`FREEZE-OK <mode> <slug> k=v …` or `FREEZE-ABORT <mode> <slug>: <reason>` (`parseFreeze`).
`freeze.py freeze` SIGKILLs every process of the worker uid before the walk (g2 mechanism step 1):
the supervisor stops the live worker in `beforeFreeze` so its teardown runs; a worker still alive
there dies without it. Unprivileged: `npm install` in the app folder as the current user with the
host's `HOME`, no scratch, no freeze (logged).

## What the Linux drill (host/drill, DESIGN §8.2 rows 6 and 8) must still prove

1. The spawn wrapper end to end: `groups=[<uid>]` only, `RLIMIT_DATA` → in-worker `RangeError` with
   `oom_kill 0`, `fork` EAGAIN at `nproc 64`, `oom_score_adj 1000` on the worker, umask 002 on files
   it creates in dataDir (0660 with sqlite's 0644 request → the runtime's db helper still chmods).
2. Row W env keys from inside the worker (`process.env`) — and what `/proc/<pid>/environ` shows
   with the image's `/bin/sh` (dash exports fewer variables than bash).
3. `jailPlan` on ext4 under `hostUsers:false`: `data/<inst>` ends `<uid>:19999 2770` with the setgid
   bit intact after the chown; the agent (groups `{1000, 19999}`) reads and writes it, a peer uid
   gets EACCES; `tmp/<inst>` 0700; `w/<inst>` 0730 — the worker binds, cannot list, a peer cannot
   connect; after READY the socket is `0:0 0700` and the dir `0710`; a resumed worker re-binds in the
   dir re-set to 0730 by `prepareDirs`.
4. `claimRoundTrip` under `{SETUID, SETGID, CHOWN, KILL}`: the setgid bit sticks with `setgroups([uid])`
   around the chmod (PLAN §10 item 3, site (a)); `dataFileRoundTrip` on an agent-created `-wal` (site (b)).
5. `freeze.py` 10/10 (g2 run-3 shape): cold install ≤ 5 s, freeze ≤ 100 ms, thaw/no-op/freeze#2 rc=0,
   the setuid plant refused + cleanup, symlink/hardlink traps, tree `1000:<uid>` with no g/o write,
   the worker `createRequire`s the dep — now with `--dirfd 3` and the instance-keyed scratch.
6. The credential rows from a worker: `/work/.claude`, `/run/atelier/*.token`, `/control`,
   `last-good/<peer>`, `data/<peer>`, `/run/atelier/dev/shell.sock` all EACCES; `127.0.0.1:1844`
   without the token → 401.
7. Teardown under the real launcher: SIGTERM → every worker's teardown line, sqlite WAL flushed,
   the pgroup sweep finds nothing when the module's teardown killed its children.
