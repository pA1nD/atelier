# host/drill/rows — DESIGN §8.2 rows 5–8 on the integrated host (fsn-01)

One backgrounded task, ≤ 25 min, throwaway namespace `spike-step2-rows` (trap-deleted), last line `VERDICT:`:

```
bash host/drill/rows/run.sh > host/drill/rows/run.log
```

The pod, the fake spine and the staging are `host/drill/step2`'s (its `pod.yaml.tpl`, `peer.yaml.tpl`,
`fake-spine.mjs`; `npm ci` in the stage init container; PID 1 = the real `entrypoint.sh` → `launcher.mjs` →
`index.mjs` in FLEET mode). Queries go through the dev shell on loopback with the dev token (`?token=`) from
inside the pod — the protocol port with the identity assertion is step 2's row (b). The apps under `apps/`
are copied in as uid 1000 after Ready:

- `probe` — row 6 from inside a worker (denied paths, `127.0.0.1:1844` without / with a wrong token → 401,
  env keys = row W) and the row 7 attacks: `/burn` (100 % of one core in 200 ms slices until `/burn-stop`),
  `/alloc` (2 GB in untouched 64 MB pieces → the in-worker `RangeError` under RLIMIT_DATA), `/fork?n=200`
  (200 concurrent `sleep` children → EAGAIN at RLIMIT_NPROC).
- `hello` — the peer whose `/ping` latency is sampled every 50 ms during the burn.
- `deps` — row 8: copied WITHOUT its `package.json`; the agent's later `cp` of it is the install trigger.
  Deps: `loot-pkg` (g2's hostile postinstall from `loot-pkg-1.0.0.tgz`: reads the credential / tokens /
  PID 1's env, plants a symlink + 0777/0666 + a 4755 copy of `/bin/true` when `/tmp/loot-suid` exists),
  `better-sqlite3@^12` (native prebuild), `core-js`. `/deps` createRequire's all three.
- `locker` — row 5 / PLAN §10 item 1: `node:sqlite` with `locking_mode=EXCLUSIVE` in its dataDir, writing
  every 50 ms; a new worker's mount throws `SQLITE_BUSY` while the old one lives.

Rows in `remote.sh`: **3'** `kill -9` the real host under a 50 ms loop on `hello` (Ready back ≤ 3 s, ≤ 2
non-200); **6** the probe's verdict + `last-good` EACCES as uid 1000; **7a** burn 25 s → the watchdog's
`cpu throttled` report with its cycle count in agent.log, `State: T` samples of the worker at 20 ms, peer
p50/p99/max, worker pid unchanged; **7b** `/alloc` → `RangeError`, `memory.events oom_kill 0`, pid
unchanged; **7c** `/fork` → spawned ≤ 64, EAGAIN > 0, spawned + EAGAIN = 200; **8a** hostile install →
`FREEZE-ABORT … setuid/setgid` + `cleanup rc=0`, no `node_modules` in the app folder, an `install failed`
line for the agent; **8b** the gate removed, `package.json` re-saved → thaw (no-op) → install → freeze ≤
100 ms → LIVE at a new rev, `/deps` = `{sqlite:42, loot:'1.0.0', corejs:'ok'}`, the tree as uid 1000
(`1000:<uid>`, no g/o-write, no setuid, all group-readable); **8c** a third save → thaw / no-op / freeze#2
rc=0; **5** ten saves of `locker` → LIVE / mount-retry / FAILED counts.

Evidence: `out/` (host log, agent.log, the probe / alloc / fork JSON, peer latency samples, worker State
samples, install logs a/b/c, the locker's lines, the spine's JSON lines, the final tree) — copied to
`design/atelier2/r2/spike-host-step2-rows/out/`, numbers in its `RESULT.md`.

## Row 9 — the release protocol (DESIGN §10.3), `run-deploy.sh` / `remote-deploy.sh` / `loop.mjs`

One backgrounded task, ≤ 30 min, throwaway namespace `spike-step7-deploy` (trap-deleted), last line `VERDICT:`:

```
bash host/drill/rows/run-deploy.sh > host/drill/rows/run-deploy.log
```

The same pod + fake spine as rows 5–8 (the spine answers `/v1/host/release` 404 — the host tolerates it and keeps
`releases.jsonl`); the code tree adds `shell/proxy.mjs` (the waking-bytes test imports it). Rows: **9t** the whole
`node --test host/test/*.test.js` inside the pod as uid 1000; **9a** `atelier deploy locker -m "first release"` (the
CLI as uid 1000 with the session's dev token) → green, the export `prod/<inst>/<c12>` is `0:<uid> 0750` / files 0640,
EACCES as uid 1000, readable as the worker uid, the prod worker's cwd; **9b** the `deploy` hook ran as the worker uid
in the export with the spine's `DRILL_CONFIG` and no token-shaped key, `DATA_DIR` = prod data, and the dev shell
refuses the worker's token-less dial (401); **9c** a second deploy backs prod data up: `backup/<inst>/<id>` is
`0:19999 0750` — EACCES for the worker, listable as uid 1000 (group 19999), `locker.sqlite` inside; **9d** three
deploys of `locker` (node:sqlite, EXCLUSIVE lock, writing every 50 ms) under `loop.mjs` on the peer — one identity
assertion per request against `:1845` (the shell's road) every 50 ms — 0 non-200, no lower rev after a higher one,
max latency < the 10 s hold. Evidence in `out-deploy/` (the in-pod test log, every deploy's stream, the export tree,
the hook's env, the prod loop samples, agent.log, the final tree).

## Row 9s — the seeded road under the real permission model (DESIGN §10.3 "seeded rows"), `run-seeded.sh` / `remote-seeded.sh` / `seed.sh`

One backgrounded task, ≤ 15 min, throwaway namespace `spike-seeded` (trap-deleted), last line `VERDICT:`:

```
bash host/drill/rows/run-seeded.sh > host/drill/rows/run-seeded.log
```

The same pod + fake spine as row 9, with two patches applied to the step-2 template on the node: `ATELIER_SEEDED_APPS=1`
in the session container's env (the portal-host image's ENV — the launcher keeps `ATELIER_*` for the host) and `seed.sh`
before the launcher (root makes `/work/apps` 0755 → chown 1000; uid 1000 copies `hello` in as `seedy` with `.atelier-seeded`
+ `.image-stamp` through a `.seeding` rename — the portal entrypoint's shape). Why it exists (review 2026-09-02): B1 was
invisible to the Mac suite — `setgroups` is a no-op unprivileged and `world()` folders are 0755 — while on the pod the
claimed folder is `1000:<uid> 2750` and the host is userns root WITHOUT `DAC_OVERRIDE`, so an ungrouped read is EACCES.
Rows: **9s-a** Ready ⇒ LIVE (S1) — the FIRST `/_atelier/apps` answer after the pod turns Ready already shows `seedy`
prod-live at rev 1 with a 40-hex `deployed_rev`, no dev slot; the host log has `rev 1 LIVE (prod)`, `host: ready … seeded
host: after the first scan`, never `module.json missing`, never a `(dev)` line; **9s-b** the model is real and the road
holds the gid (B1): the folder is `2750 1000:<uid>`, root cannot read its `module.json`, the host's env carries the flag;
**9s-c** the prod road (the signer from the peer, `:1845`) → 200 `pong`; **9s-d** `releases.jsonl` = ONE adopt row
(commit = `deployed_rev`, `at` a ms epoch), the fake spine saw the POST; **9s-e** R14 on the pod (S2): 70 s quiet → `rev 1
STOPPED`, no worker process, the next request 200 + `RESUMED`; **9s-f** a re-seed over the kept `/work` (uid 1000 changes a
byte) → rev 2 LIVE within a sweep, a new id, a second adopt row. Evidence in `out-seeded/`.
