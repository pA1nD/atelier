# `host/` — the Atelier 2.0 host (PLAN §4.9 step 2)

One root process per computer that discovers the apps under `/work/apps`, builds each save into a
revision (backend bundle + per-file frontend transform + one Tailwind sheet), runs every app in its
own worker at uid `20000+i`, serves the shell over the protocol port with the identity assertion of
`protocol/`, keeps the agent's dev shell on loopback, and reports every build/runtime failure to the
agent (`agent.log`, the dev shell) and to the spine (the app-error lane). `DESIGN.md` is the design;
this file is how to run it.

```
host/
  index.mjs            the wiring (this is what runs): config → adapter → dirfd → agent.log → collector →
                       registrar/transport → events → supervisor(spawn, proxy, jail, install) → watchdog →
                       protocol server + dev shell → boot order → host-ready → scan → teardown on SIGTERM
  entrypoint.sh        PID 1 in the pod (bash reaper) → launcher.mjs
  launcher.mjs         root: the boot plan (markers, tokens), spawns the host (fd 3 = .atelier dirfd) and the session supervisor;
                       restarts either in place (0.5→30 s, parked after 10 exits/10 min); a parked host ends the container (exit 3),
                       so does a supervisor boot storm (10 lives in a row dead within 30 s of the spawn: exit 4)
  hygiene.mjs          env rows, constants, the boot plan as data
  metrics.mjs          the PLAN §4.5 rows (save→verdict, tailwind, resume, restarts, watchdog trips, event batches) → /_host/metrics
  adapters/os.mjs      linuxRoot() | unprivileged() | memory() — every privileged/Linux-only call
  supervisor/          discovery, watcher, bundle, tailwind, last-good store, serve, the Supervisor
  worker/              spawn (row W), jail (ownership plans), runtime (the worker process), proxy, install + freeze.py
  errors/              collector, agent.log, push (→ spine), frontend report, watchdog, limits
  protocol/            auth, headers, events, registrar (+ spineTransport / localTransport), server (:1845), devshell (:1844)
  test/                node --test host/test/*.test.js (macOS and Linux, no root)
  drill/               the Linux drills on fsn-01: launcher/ (rows 1–3 of DESIGN §8.2), step2/ (the integrated host, rows a–g)
```

## Run it: the fleet pod

The container's command is `bash /app/host/entrypoint.sh` with the §4.3 pod shape (`hostUsers: false`,
`runAsUser: 0`, caps `{SETUID, SETGID, CHOWN, KILL}`, no `fsGroup`, `/work` volume, tmpfs `/run/atelier`,
`/control`). The launcher reads the pod env (`ATELIER_BOOTSTRAP` becomes `/run/atelier/bootstrap.token`,
`CHANNEL_URL` becomes the host's `ATELIER_SPINE_URL`) and starts the host with row H's env and fd 3 =
the `.atelier` dirfd, and the image's session supervisor with row S's env (the spine's rows — `CHAT_ID`,
`PERSONA*`, `CHANNEL_*`, `ANTHROPIC_*`, `CLAUDE_MODEL`, `OPENAI_VOICE_TOKEN`, `HORSE_BROWSER_*`,
`FLEET_EGRESS*` … — minus every `ATELIER_*`, `HOME=/work`; `hygiene.mjs` `SESSION_KEEP` is the list).
The per-pod leaf arrives as pod env `ATELIER_HOST_TLS_CERT`/`_KEY`/`_CA` (PEM); the image's wrapper
(`/app/host/entrypoint.sh`) writes them to `/run/atelier/tls/{cert,key,ca}.pem` 0400 root, unsets them
and sets `ATELIER_HOST_TLS` before exec'ing `host/entrypoint.sh` — and the launcher drops the three
under every row anyway (`NEVER_BELOW`, with the bootstrap), so no process below it ever holds a PEM.
The host registers at `ATELIER_SPINE_URL` (DESIGN §7 routes), loads the last-good
snapshots, runs the startup permission audit (nothing listens while a credential or a snapshot is
readable by a foreign uid), binds both listeners, writes `/run/atelier/host-ready` once the registrar
has an epoch (the readiness probe), then scans the folder. A renamed or removed `/work/.atelier` is a
host fault: 503 on both listeners, no scans or spawns, `host-ready` unlinked, until the operator
restores the tree.

Ports: `<pod IP>:1845` the protocol port (mTLS — mandatory in the fleet — plus bearer `<epoch>.<token>`
+ the identity assertion; never `0.0.0.0`, so a worker has no loopback path), `127.0.0.1:1844` +
`/run/atelier/dev/shell.sock` the dev shell (dev token only, from `/run/atelier/session/dev.token`
for the agent; the token is stripped from the URL before a request reaches a worker).

Knobs (`ATELIER_*`, DESIGN §1.2): `ATELIER_WORK` `/work`, `ATELIER_RUN` `/run/atelier`, `ATELIER_CONTROL`
`/control`, `ATELIER_CHROME_DIR` (the chrome folder — it needs no node_modules of its own, `@import 'tailwindcss'` falls back to the host's; unset = app-less documents and pass-through app CSS),
`ATELIER_HOST_PORT` 1845, `ATELIER_DEV_PORT` 1844, `ATELIER_SPINE_URL` (unset = local mode),
`ATELIER_HOST_TLS` `cert,key,ca` (mTLS on 1845; required in fleet mode — a fleet host without it exits 2; the literal `plain` is the drill's opt-out, logged INSECURE), `ATELIER_GIT_COMMIT=0` (no row-G commit per LIVE rev).

## Run it: local dev (laptop, no root)

```
ATELIER_WORK=/tmp/w ATELIER_RUN=/tmp/r node host/index.mjs
```

Local mode = no `ATELIER_SPINE_URL`: the registrar answers from `$ATELIER_WORK/.atelier/registry.json`,
identity is `local`, company `local`, the shell key pair is minted per process. Without a launcher the
host creates the tree itself (`.atelier/{data,last-good,scratch,tmp}`, `apps`, `$ATELIER_RUN/{dev,session,w}`)
and mints `$ATELIER_RUN/dev.token` when none exists. `unprivileged()` is the adapter: mkdirs are real,
chown/chmod/uid drop are logged no-ops (`jail: lifecycle-only`), workers run as you, `npm install`
events are plain rebuilds. Keep `ATELIER_RUN` short — macOS caps a socket path at 104 bytes.

Then, with `T=$(cat /tmp/r/dev.token)`:

```
mkdir -p /tmp/w/apps/notes && echo '{"name":"Notes"}' > /tmp/w/apps/notes/module.json   # + backend.js / frontend.jsx
curl "http://127.0.0.1:1844/_atelier/apps?token=$T"                 # [{instance, slug, company, rev, state}]
curl "http://127.0.0.1:1844/api/local/notes/state?token=$T"         # proxied to the worker (mount stripped)
curl "http://127.0.0.1:1844/modules/local/notes/frontend.js?token=$T"
curl "http://127.0.0.1:1844/_atelier/events?app=<instance>&token=$T"  # the collector's recent app errors
open "http://127.0.0.1:1844/local/notes?token=$T"                   # the 1.x document (needs index.html, client.jsx, shims/ beside host/);
                                                                    # every URL it loads carries the token (a module import's referer is the importing module)
tail -f /tmp/w/.atelier/agent.log                                   # LIVE / FAILED / STOPPED / RESUMED / KILLED
```

A save = one revision: syntax error → the previous revision keeps serving, one `FAILED (users still on
rev N) <file:line:col> <message> — <fix>` line; good save → bundle + css + worker swap under the new rev
(`ETag: "rev-N"` on `/modules/*`); a worker that dies is relaunched with backoff and requests are held
(never a 502) while it resumes from `current`.

## Metrics

`GET /_host/metrics` on the protocol port answers the PLAN §4.5 rows as Prometheus text, behind the
same bearer as `/_host/healthz`:

```
curl -s --cacert ca.pem --cert client.pem --key client-key.pem \
  -H "authorization: Bearer $EPOCH.$TOKEN" https://<pod IP>:1845/_host/metrics
```

`atelier_host_save_verdict_ms` (the watcher's quiescence firing → LIVE or the app-error, alarm 1 s),
`atelier_host_tailwind_build_ms{phase=cold|warm}` (alarm 50 ms cold), `atelier_host_worker_resume_ms`
(snapshot → READY, alarm 100 ms), `atelier_host_worker_restarts_total`,
`atelier_host_watchdog_trips_total{kind=rss|cpu|disk|shm}` and `atelier_host_events_batch` (frames per
push to the spine). Everything is labelled `app=<slug>`, every alarm line rides in the HELP text, and
each series is a bounded ring — DESIGN §6.6.

## Tests

```
node --test host/test/*.test.js protocol/test/*.test.js     # 401 tests, ~7 s, no root
```

Every lane's file runs the privileged behaviour through `memory()` and real processes through
`unprivileged()`. The Linux-only rows (uid drop, ownership, inotify budget, rlimits, freeze) are the
drills: `bash host/drill/step2/run.sh > host/drill/step2/run.log` (one background task, ≤ 20 min,
throwaway namespace `spike-host-step2` on fsn-01, last line `VERDICT:`) — see `drill/step2/README.md`.

## Where things are on disk (DESIGN §3)

`/work/apps/<slug>` `1000:<uid> 2750` the agent's folder · `/work/.atelier/<inst>/` markers (`slug`,
`uid`, `revision.json`, `current`, `registered.json`) · `.atelier/data/<inst>` `<uid>:19999 2770` ctx.dataDir ·
`.atelier/last-good/<inst>/rev-N/` the built revisions (`backend.js`, `frontend/*.js`, `styles.css`) ·
`.atelier/tmp/<inst>` the worker's TMPDIR · `.atelier/scratch/<inst>` npm scratch · `.atelier/agent.log`
`0:1000 0640` · `/run/atelier/w/<inst>/w-<rev>.sock` the worker socket · `/run/atelier/host-ready` the
readiness sentinel.
