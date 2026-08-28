# host/drill/step2 — the integrated host on the pinned agent image (fsn-01)

One backgrounded task, ≤ 20 min, throwaway namespace `spike-host-step2` (trap-deleted), last line `VERDICT:`:

```
bash host/drill/step2/run.sh > host/drill/step2/run.log
```

`run.sh` (laptop) pins the digest from `metal/clusters/prod/spine.yaml` (`AGENT_IMAGE`), tars `host/`,
`protocol/`, `package.json` + lock, the dev-shell assets and `drill-apps/` (blitzfeed copied from
`003-atelier-modules` + `module.json` + a one-rule `styles.css`; the probe app from `probe/`), ships it
with `remote.sh`, `inpod.sh` and the two pod templates, runs `remote.sh` on fsn-01, copies `out/` back.

`remote.sh` (fsn-01): a `peer` pod runs `fake-spine.mjs` (DESIGN §7 routes on :7999, every call as a
JSON line in `/tmp/spine.jsonl`, `validateAppError` on `/v1/host/event`, the shell key + bearer pair in
`/tmp/spine-state.json`) and `signer.mjs` (bearer + protocol/identity assertion → one request, prints
`STATUS <code> ETAG <etag> <ms>ms` + body). The `computer` pod is the §4.3 shape (`hostUsers: false`,
root, caps `{SETUID,SETGID,CHOWN,KILL}`, no fsGroup, `restartPolicy: Always`, 2Gi emptyDir `/work`, tmpfs
`/run/atelier`, `CHANNEL_URL` = the peer, `ATELIER_BOOTSTRAP` = the fake spine's secret); its `stage`
init container receives the tree and runs `npm ci --omit=dev` (the Linux esbuild/tailwind binaries);
PID 1 is the real `entrypoint.sh` → `launcher.mjs` → `index.mjs` (the image's session supervisor is
the launcher drill's sleeping stub). The apps are copied in as uid 1000 after Ready, as the agent would.

Rows: **(a)** `inpod.sh` — owner:group:mode of every §3 path, the process tree (host root + fd 3, workers
`20000+i` with no groups, umask 002, CapEff 0, cwd = the app folder, rlimits, env keys), the agent's
view as uid 1000. **(b)** `/api/acme/blitzfeed/state` 200 with the assertion; 401 without it, without
the bearer, with a wrong key, with an assertion bound to the other app; `/modules/…/frontend.js` and
`styles.css` 200 with `ETag "rev-N"`, `backend.js` 404; `/_host/healthz`; the dev shell 401/200 by token.
**(c)** the probe app from inside: uid/gid/groups/umask/cwd, env keys = row W + the spine-held
`DRILL_CONFIG`, the frozen ctx (MODULES.md keys), `req.user` from the assertion, dataDir writable,
EACCES on PID 1's environ, both tokens, `.claude`, `/control`, `agent.log`, `last-good`, `data`, the
peer's dataDir and socket dir, the dev-shell socket, its own app folder. **(d)** a syntax-error save as
uid 1000 → `FAILED (users still on rev N)` in agent.log, `/state` still 200, exactly ONE
`POST /v1/host/event {kind:'app-error', error:{…}}` that `validateAppError` accepts; the good save →
one new rev for bundle + css (same ETag) + worker (new pid), `current` → `rev-N`, the previous rev via
`?rev=`. **(e)** `kill -9` the worker under a 40-request loop from the peer → relaunched, 0 non-200,
host pid unchanged, `host-ready` present, `KILLED signal SIGKILL` + `RESUMED`. **(f)** the frames at the
spine: `{stream:'computer-drill:<epoch>', topic:<instance>, seq, type:'invalidate'}`, seq per topic
(blitzfeed 1,2 — the two LIVE revs; probe 1), `modules-changed` with uid + rev, register/heartbeats.
**(g)** `kill -TERM 1` → draining at the spine, `host: stopped`, container restart, second life boots
from last-good (`stopped` rows) and the first request resumes the worker (held, 200).

Evidence: `out/` (launcher/host logs of both lives, agent.log, the spine's JSON lines, the probe JSON,
inpod.txt, the final tree) — copied to `design/atelier2/r2/spike-host-step2/out/`, numbers in its
`RESULT.md`.
