# `shell/` — the Atelier 2.0 shell (PLAN §4.9 steps 4/4b; design in `DESIGN.md`)

The company document, the route matrix, the assertion minter, the streamed proxy and the events
socket, built once over five provider objects (`identity`, `registry`, `gate`, `bus`, `hostLink`)
with a local and a fleet implementation each. `npx atelier` (local mode) is this shell with the
local providers in front of one `host/index.mjs` per workspace; step 5 swaps in the fleet providers.
Nothing in `shell/` does module work (P10) and the host is always a separate process reached over a
token-bearing link (P11).

```
shell/
  index.mjs          createShell({cfg, providers, log, trace}) → {listen, close, handle, upgrade, start, stop}
  routes.mjs         the lane list (normalise → https → Host → ticket → assets → documents → fetches → presence → Origin → authorize → proxy)
  document.mjs       bootstrap (chromeApi 2), head order (sheet < UMDs < bootstrap < import map < preloads < client), CSP, escaping
  assets.mjs         /assets/{react,react-dom,client,chrome-resolve}.js — prod UMDs, bundled client.js, ETag/304, gzip; the document template
  proxy.mjs          protocol/headers both ways, counted bodies (413 past the cap), DIAL/TIMEOUT → 503 {waking:true}
  minter.mjs         one Ed25519 pair per process; header() = protocol/identity mint (30 s, fresh nonce, closed person set)
  events.mjs         /_atelier/ws: sub/resume/gap on cursor lag, pong{at} → ping{at} echo, ws.ping 10 s × 2 misses, budget 8 → 4001
  waking.mjs         the 503 waking page, /_atelier/wake, hostState() (heartbeat/draining in the fleet, a 1 s probe in both modes)
  config.mjs         cfg from atelier.config.json + env (local) / env (fleet); the ignored-settings lines
  providers/         identity- gate- registry- bus- hostlink- ×{local,fleet}.mjs (+ hostlink-base.mjs)
  test/              node --test shell/test/*.test.js   (54 tests, ~3 s, no host process; fixtures.mjs = the fakes)
  drill/smoke.mjs    the shell with local providers in front of the REAL host on this Mac (one background task, VERDICT)
```

## Run the tests

```
node --test shell/test/*.test.js                       # the shell alone, fakes for every provider
bash shell/drill/smoke.sh > /tmp/shell-smoke.log        # + the real host: document, API, WS save → invalidate, broken save, SIGSTOP → waking (≤ 3 min, ends in VERDICT:)
```

`npx atelier` itself (discovery, staging, host spawning, `shell/cli-local.mjs`, the one `cli.js` line)
is lane B's; until it lands, `shell/drill/smoke.mjs` shows the wiring: a fixed workspace table stands
in for `shell/local/hosts.mjs` and a fixed row list for `shell/local/discover.mjs`.

## The provider interfaces as built (deltas to DESIGN §1 are marked ⊕)

- `identity.resolve(req)` → `{ok, person:{id,name,claims}, credential:'cookie'|'none', epoch}` | `{ok:false, reason}`; `identity.session(req)`.
- `registry`: `company(host)`, `companies()` ⊕ (`[{id,name,href}]` — the picker rows; fleet `[]`), `apps(c)`, `resolve(c,s)`,
  `byInstance(instance)` ⊕ (the socket and `/_atelier/topics` name topics by instance, not by company), `present(personId, instance)`,
  `host(c)` → `HostRow {hostId, epoch, token, ip, port, tls, heartbeatAt, drainingAt}`, `chrome(c)` → `{qid, dir, digest}`, `watch(c, fn)`,
  `noteProbe(c, probe)` ⊕ (the document probe feeds `heartbeatAt`/`epoch` locally), `refresh(c?)` ⊕ (lane B's fs.watch and the bus's
  unknown-qid frame call it), `unreachableAt(c)` ⊕ (the last failed `/_atelier/apps` fetch — the last known rows are served stale meanwhile),
  `start()/stop()` (the 5 s unref'd safety poll, local). An `AppRow` carries `primary` (applied locally from
  module.json, the registry's applied value in the fleet) and `isChrome` for the chrome staged as an app (hidden from the rail).
- `gate`: `https(req)`, `hsts(req)` ⊕ (the HSTS value; `null` locally), `hostAllowed(req)`, `ticket(req,res)`, `unauthDocument(req, {company, path})`, `origin(req, credential)`.
- `bus`: `ring`, `start()/stop()`, `publish(topic)`, `onAppend(fn)`, `snapshot(topic)`, `reprobe(company, probe)` ⊕ (a document-route probe
  with a new host epoch re-registers that host's topics), local `invalidate(company, instance)` for drills.
- `hostLink`: `request({hostRow, app, person, method, path, headers, body})` → `{status, headers, body}` (throws `{code:'DIAL'|'TIMEOUT'|'BODY_CAP'}`),
  `probe(hostRow)`, `json({hostRow, path})` ⊕ (the small host views: apps, events), `dialMs` 1000, `close()`.

## What the client (lane C) gets from this shell

- `window.__ATELIER__` exactly as DESIGN §2.1, with `companies` (`href` per workspace locally) and `portal` (fleet).
- The events socket is at `/_atelier/ws?company=<c>` locally (the fleet derives the company from the Host; the query is ignored there).
  Frames are protocol/events'. The tab's 1 s liveness is `{op:'pong', at}` → `{type:'ping', at}` — the protocol's message set has no
  client `ping`, so the echo is named this way; a `pong` also marks the socket live for the budget.
- `GET /_atelier/topics/<instance>` → `{stream, seq, rev, error}` (`error` is `{message, hint, file, line, col, rev, kind}` locally, always `null`
  in the fleet); `GET /_atelier/rail?company=<c>` (fleet: no query) → `{stream, seq, modules:[bootstrap rows], chrome:{qid,digest}, chromeRev}`;
  `GET /_atelier/wake?company=<c>` → `{ok}`; `POST /_atelier/report` ≤ 64 KiB, signed with `app = body.instance`.
- A fetch that meets a waking host gets `503 {"waking":true}` + `x-atelier-waking: 1` + `Retry-After: 2`; a document gets the waking page.
  A host that just failed a probe or a dial stays "waking" for 2 s per shell (no dial on fetches in that window), then the next request dials.
- `client/index.html` must carry the five slots `<!--__STYLES__-->`, `<!--__BOOTSTRAP__-->`, `<!--__IMPORTMAP__-->`, `<!--__PRELOADS__-->`,
  `<!--__CLIENT__-->` with the React UMD tags between STYLES and BOOTSTRAP (`document.mjs FALLBACK_TEMPLATE` is the reference); until it
  exists the shell serves the fallback and bundles the 1.x `client.jsx`.

## Ports on this Mac

The 1.x atelier owns 1844. Drills use 18440 (shell), 18450 (host dev), 18460 (host protocol).
