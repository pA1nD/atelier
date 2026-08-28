# host/drill/joint — the real host against the real spine registrar (fsn-01)

The last proof of PLAN §4.9 step 2: the integrated host (this repo, branch `host`) registers with the
spine's registrar lane (agent-orchestrator branch `step2-spine`, `src/registry/serve.ts` = the channel
routes standalone, built to `dist/`) instead of `fake-spine.mjs`. One backgrounded task, ≤ 20 min,
throwaway namespace `spike-step2-joint` (trap-deleted), last line `VERDICT:`:

```
(cd <agent-orchestrator step2-spine worktree> && npm run build)      # dist/registry/serve.js
bash host/drill/joint/run.sh > host/drill/joint/run.log
```

`run.sh` (laptop) pins BOTH digests from `metal/clusters/prod/spine.yaml` — the orchestrator image
(node:24-slim) for pod `spine`, the agent image for pod `computer` — tars the host tree + the drill apps
(blitzfeed from `003-atelier-modules`, the probe app from `../step2/probe`) and the spine's `dist/`,
ships `remote.sh` + the two templates, runs `remote.sh` on fsn-01, copies `out/` back.

`remote.sh` (fsn-01): pod `spine` runs `node dist/registry/serve.js` (`REGISTRY_CHAT=chat-drill`, a
random session epoch, `REGISTRY_COMPANY=acme`, data dir `/tmp/reg/data`, every request one JSON line in
`spine.jsonl`) behind Service `spine` → `http://spine.spike-step2-joint.svc:7999`. The bootstrap it
minted (`Registrar.bootstrapFor` = HMAC-SHA256(channel secret, `chat-drill:<epoch>:host-bootstrap`),
recomputed on fsn-01 from `channel-secret` before the pod is created) goes into the computer pod as
`ATELIER_BOOTSTRAP`, which the launcher writes to `/run/atelier/bootstrap.token` (0400) — the host's
`CHANNEL_URL` → `ATELIER_SPINE_URL` points at the Service. The computer pod is `../step2/pod.yaml.tpl`'s
§4.3 shape unchanged. Direct calls to the spine (a forced register, a revoked token, an oversize batch,
a rename) are `curl` from inside the computer pod with the credentials the spine log shows.

Rows (`VERDICT` per row): **(1)** register → `host_id/epoch/token`; a forced second register revokes
the host's token (`401 host-epoch-moved`) and the host re-registers by itself at its next call.
**(2)** heartbeats every 10 s with `visible_apps`/`last_served_at`/`pod_ip`, on the computer row.
**(3)** two claims → `201 claimed`; a rename PUT → `200 renamed:true` (and back); `rm -rf` a folder →
`POST unlink` → `tombstone_at`; the folder re-created within 24 h → `200 revived:true`, same instance id,
same uid, LIVE again. **(4)** `modules-changed` carries uid + rev (persisted, `set-running` at the
spine); `kill -9` the host → the launcher restarts it → `register().apps` returns the same uid/rev.
**(5)** the ring: seq per (stream, instance) via `/_drill/events`; 129 frames → `400 batch-too-large`;
a forced register right after a heartbeat + a save → the host's events push hits `401`, re-registers,
the retried batch is `stale-epoch` per event, the instance is re-queued and re-minted under the new
stream (case A, ≤ 3 attempts — the race is the 10 ms flush timer vs the re-registration round trip);
an injected frame under the revoked epoch with the live token → `rejected stale-epoch`. **(6)** a
syntax-error save → exactly ONE `POST /v1/host/event {kind:'app-error', error}` accepted by
`parseAppError` (the `lane:app-error` row) while `/state` keeps serving. **(7)** `PUT
/_drill/config/<instance>` (the admin plane's config write, stood in) → a save → the respawned worker
sees `DRILL_CONFIG=from-spine` after the uid drop; the spine log shows the `GET /v1/apps/<i>/config`.
**(8)** `kill -TERM 1` → `POST /v1/host/draining` → container restart → the second life registers
(`draining_at` cleared).

Evidence: `out/` (spine.jsonl, states, rings, launcher logs of both lives, agent.log, the probe JSON)
— copied to `design/atelier2/r2/spike-step2-joint/out/`, numbers in its `RESULT.md`.
