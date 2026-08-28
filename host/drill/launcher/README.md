# The launcher lane — `host/entrypoint.sh`, `host/launcher.mjs`, `host/hygiene.mjs`

The root process tree of PLAN §4.3 (R1) as built in step 2, DESIGN §2.1–2.2. State: code and
laptop tests complete; the Linux drill (`run.sh`) is written and has not been run yet.

## What runs where

```
PID 1  bash host/entrypoint.sh            reaper: trap TERM → kill -TERM launcher; wait; wait; exit $?
 └─ node host/launcher.mjs                root: bootPlan → spawn host (row H) + session supervisor (row S)
     ├─ sh -c 'umask 77; exec "$@"' … node host/index.mjs        root, fd 3 = /work/.atelier dirfd
     └─ sh -c 'umask 22; exec "$@"' … setpriv --reuid=1000 --regid=1000 --groups=19999 -- node /app/session-supervisor.mjs
```

`hygiene.mjs` is policy as data: the constants (`AGENT`, `AGENT_DATA_GID=19999`, `WORKER_UID_BASE`,
`WORKER_UID_MAX`, `appgid`, `INSTANCE_RE`, `SECRETS`), `scrub(env, keep)` (a NEW object from an
explicit key list, `PREFIX*` allowed, `ATELIER_BOOTSTRAP` never copied), the env rows `hostEnv`,
`sessionEnv`, `helperEnv`, and `bootPlan(cfg, {bootstrap, devToken})` — the ordered step list
(umask 0 → markers → `/run/atelier/{dev,session}` → dirfd → stale `host-ready` unlink → lost+found →
`/work/apps` → `/work` chown iff 0:0 → tmux 0700 + chown, X11 1777 → tokens (unlink, `wx` 0400) →
session copy chown, session dir chown → umask 077). There is no chmod op at all.

`launcher.mjs`: `runPlan(steps, {os, io, log})` executes the plan through the adapter (`os`) and a
tiny `io` (`umask`, exclusive `write`, `unlink`) and logs `[launcher] +<s>s <op> <path> [mode]: ok|FAILED <errno>`;
`createLauncher({os, io, env, log, clock, exit, signals, hostArgv?, sessionArgv?, devToken?, cfg?}).boot()`
runs the plan (a failure → exit 2 before any spawn), spawns H and S, and applies:

- host exit → unlink `host-ready`, one JSON line `{"at","code","signal","exits"}` appended to
  `/control/.host-crash` by the uid-1000 helper (row X: `sh -c 'cat >> /control/.host-crash'`, env `{PATH}`,
  `--clear-groups`, umask 077, the line on stdin), SIGKILL of every process of a worker uid (20000–65535,
  `orphanedWorkers()` over `/proc` — a dead host's detached workers), restart at once after the first exit
  in the window, then after `min(30 s, 0.5 s × 2^(n−2))` where n = exits in the last 10 min; the 10th exit
  in 10 min parks the host (`host: parked after 10 exits/10 min`), the pod stays up, the session
  supervisor is untouched.
- session supervisor exit → SIGTERM the host, SIGKILL after 10 s, exit with the supervisor's code or
  `128 + signal`.
- SIGTERM → SIGTERM the host first, then the supervisor, `grace − 5 s` (`ATELIER_GRACE_S`, default 40)
  for both to exit, SIGKILL at the deadline, exit with the supervisor's code.
- a `kill` EPERM or a spawn failure arrives as a ChildProcess `error` event: logged, treated as an exit.
- nothing else exits the launcher (auth/limit/claude-gone are the session supervisor's relaunches).

Container restart (restartPolicy Always, `/run/atelier` and `/work` outlive the container): the plan
tolerates every existing marker (EEXIST → audited, a wrong owner/mode is logged and left), unlinks
the previous life's `host-ready`, reclaims the 1000-owned `/run/atelier/session` (chown 0:0, the
only chown of a non-fresh inode) so it can re-mint the dev token into it, and chowns it back.

## Tests

```
cd <worktree> && node --test host/test/launcher*.test.js      # 21 tests, macOS
```

`launcher.test.js` — the plan byte-exact; execution order and end-state on `memory()` for a fresh
and a migrated volume; the failing-step path; env rows H/S/X exact; spawn rows H/S exact (argv
after the wrapper, uid/gid/groups, umask, cwd, stdio with fd 3 = dirfd); the minted token.
`launcher-signals.test.js` — restart policy with a fake clock (0.5 → 30 s, park at 10/10 min,
window reset), the crash helper spec, SIGTERM order and budget, exit-code mirroring, EPERM and
spawn-error events. `launcher-process.test.js` — the real launcher as a child process under a
mkdtemp with `unprivileged()` + `realIo()`: modes on disk, fd 3 seen by the host, the helper's line
in `.host-crash`, the restart, SIGTERM/exit mirroring end to end (no uid drop on the laptop).

## The Linux drill (`run.sh` → fsn-01, one backgrounded task, ≤ 20 min, ends in `VERDICT:`)

`run.sh` pins the image digest from `metal/clusters/prod/spine.yaml`, tars `host/`, `protocol/`,
`package.json` and the assets that exist in the repo, ships them with `remote.sh`/`inpod.sh`/
`pod.yaml.tpl` to `/tmp/spike-host-launcher-code` on fsn-01 and runs `remote.sh` under `timeout`.
`remote.sh` creates ns `spike-host-launcher` (deleted in a trap; only `ghcr-pull` is copied from
`agents`), applies the userns pod (`hostUsers:false`, `runAsUser:0`, caps drop ALL add
SETUID/SETGID/CHOWN/KILL, no fsGroup, `Always`, grace 40, emptyDirs `/work` `/control`
`/run/atelier`, `/dev/shm` 1Gi, readiness `test -f /run/atelier/host-ready`), stages the code
through an init container (`kubectl cp` + tar), and runs the rows. The image's
`/app/session-supervisor.mjs` is replaced by `session-supervisor-stub.mjs` (a sleeper that exits 1
on SIGTERM; the real one is g3's drill) and, when the shipped tree has no `host/index.mjs`,
`host-stub.mjs` stands in for the host (fd 3 check, `host-ready`, HTTP 200 on the pod IP :1845,
teardown on SIGTERM).

What it must still prove (nothing below has run yet):

1. Ready ≤ 4 s after the container start.
2. `inpod.sh`: PID 1 bash; launcher/host root, host fd 3 → `/work/.atelier`; session supervisor
   uid 1000 gid 1000 supplementary `19999`, CapEff 0, umask 022, cwd `/work`; host umask 077, cwd `/`;
   env rows from `/proc/<pid>/environ`; every §3 path the launcher owns at its `uid:gid mode`
   (incl. `/tmp/.X11-unix` 1777 — mkdir(2) honours the sticky bit on Linux, not on macOS);
   tokens 0400 with the right readers (1000 reads its copy, not the host's; 20001 neither);
   zero non-1000-owned inodes in `/work` + `/control` as uid 1000 outside `.atelier`; the agent can
   rename `.atelier` and fd 3 still resolves; root cannot create in `/work`; tmux as uid 1000 through
   `/tmp/tmux-1000`; `node --test host/test/launcher*.test.js` inside the pod.
3. `kill -9` the host: new host pid, launcher and supervisor pids unchanged, Ready back ≤ 3 s,
   ≤ 2 non-200 in the peer's 50 ms curl loop, one `.host-crash` line `1000:1000 0600` with
   `signal:"SIGKILL", exits:1`.
4. `kill -TERM 1`: host torn down first (previous logs), supervisor exit 1 mirrored as the container
   exit code, in-place restart, Ready again, dev token re-minted, `session` dir reclaimed and chowned back.
5. Ten host kills in the second life → parked; pod stays Running (unready), supervisor pid unchanged,
   11 crash lines.
6. Pod delete with grace 40 → gone in < 40 s.

Rows 4–9 of DESIGN §8.2 (worker jail, watchdogs, install, corpus apps, sqlite teardown) belong to
the other lanes and run in this same harness once their code exists: `run.sh` already ships the tree
and `inpod.sh` is the place to add their `PASS|FAIL` lines.

## Open

- The adapter has no `writeFile`/`unlink`; the launcher carries its own `io` (plain `node:fs`, no
  privilege involved). Proposal for `adapters/os.mjs`: `writeFile(p, data, mode)` (`wx`) and `unlink(p)`
  so the memory fake records them too.
- `os.spawnSync` takes no stdin; the crash helper uses `os.spawn` with `stdio[0]='pipe'` and writes the
  line to `child.stdin` (`memory()`'s fake child has no stdin — the line is unit-tested as `crashLine()`,
  the file is the drill's row 3).
- The `sh -c` wrapper adds `PWD`, `SHLVL`, `_` to every child env; the rows are exact modulo those.
