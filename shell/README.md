# `shell/` — the Atelier 2.0 shell: how to run it, what is inside

`DESIGN.md` is the design (PLAN §4.9 steps 4/4b). This file is the current state: `npx atelier` = the 2.0 shell
(the route matrix, the document, the proxy, the events socket — the second half of this file) in front of one
`host/` process per workspace, on a laptop, no root (the first half).

```
shell/
  cli-local.mjs          the `npx atelier` entry (cli.js dispatches a bare `atelier` here)
  local/discover.mjs     1.x discovery (discovery.js, unchanged) + slug refusals + the chrome election + module.json generation
  local/meta.mjs         the literal `export const meta` reader (server.js extractMetaStatically, ported)
  local/stage.mjs        <root>/.atelier/local/<ws>/apps/<id> → symlink to the module folder
  local/hosts.mjs        one host per workspace: port plan, env rows, dev-token mint, spawn / restart / stop, registry rows
  local/settings.mjs     port/host/env/label/defaultChrome as 1.x resolved them (+ --port=N); the ignored-settings lines
  local/serve.mjs        startShell(): createShell + the five local providers built from the CLI's workspace object
  test/                  node --test shell/test/*.test.js
```

## Run it

```
cd <instance folder>            # the folder holding your modules and atelier.config.json
ATELIER_ROOT=$PWD node /path/to/atelier/cli.js          # a dev checkout: ATELIER_ROOT names the instance
npx atelier                                             # installed as a dependency: the node_modules owner is the instance
PORT=18440 npx atelier          # on this Mac 1844 is the 1.x atelier's; hosts then take 18450+k / 18460+k
npx atelier --port=18440 --open
```

The instance folder resolves exactly as 1.x (`discovery.js resolveRoot`: `ATELIER_ROOT` → the `node_modules`
owner → the parent of `PWD`). Flags are `--port=N` and `--open` only; anything else (`atelier <id>`,
`atelier add …`) never reaches this code. `ATELIER_1X=1 npx atelier` is the 1.x host mode.

What it prints at start, in order: the ignored settings (once), `[<ws>] host k pid N dev 127.0.0.1:P+10+k`
per host, `Atelier · local · <root> · http://localhost:<P>`, the jail line, the chrome, one line per host.
Every host line after that is `[<ws>] [host] …` (the host's own stderr).

## What happens

1. **Discover** — `local/discover.mjs`: a module is a folder with `frontend.jsx` or `backend.js`; root
   folders are workspace `global`, `$<ws>/` folders are workspaces; `atelier.config.json` `modules`
   (allow/deny, `{workspace}` blocks, path entries) applies as in 1.x host mode. New in 2.0: an id or a
   workspace that is not one DNS label (`SLUG_RE`, lowercase) is refused — `'My_App' is not a slug —
   rename the folder` — and never mounted. The chrome is elected as 1.x did (`defaultChrome`, else the
   alphabetically first global module whose literal meta has `isChrome: true`); one chrome per run.
2. **module.json** — the host needs one per app. Absent → written next to the module's files from the
   literal meta (`name` — defaults to the folder name — `icon`, `group`, `primary`, `color`), mode 0644,
   one log line `wrote <dir>/module.json from the literal meta`. Present → read, never rewritten.
3. **Stage** — `local/stage.mjs`: `<root>/.atelier/local/<ws>/apps/<id>` is a symlink to the module folder
   (relative imports, `data/`, `node_modules` resolve in place). Stale links go; a real folder inside
   `apps/` is never removed. The chrome is staged too (`global/<chrome>`) so its backend answers under
   `/api/global/<chrome>/…` (DESIGN §8). The host takes symlinks with `ATELIER_APPS_LINKS=1` (host H1;
   refused in the fleet).
4. **Hosts** — `local/hosts.mjs`: workspace order `global` first (host 0), then alphabetical; host k gets
   `ATELIER_DEV_PORT=P+10+k`, `ATELIER_HOST_PORT=P+20+k`, `ATELIER_WORK=<root>/.atelier/local/<ws>`,
   `ATELIER_RUN=/tmp/atelier-<hash8(root)>/<ws>`, `ATELIER_COMPANY=<ws>`, `ATELIER_ORIGIN=http://localhost:<P>`,
   `ATELIER_CHROME_DIR`, `NODE_ENV`, `ATELIER_GIT_COMMIT=0`, `ATELIER_APPS_LINKS=1`; the CLI's env is NOT
   spread (an explicit inherit list: PATH, HOME, LANG, TMPDIR, proxies). The dev token is minted by the CLI
   (`$ATELIER_RUN/dev.token`, 0600, fresh per run) before the spawn; the host reads it and never mints its own.
   A host that dies restarts with 0.5 → 30 s backoff; 10 exits in 10 min park it (the CLI says why);
   SIGINT/SIGTERM close the shell, SIGTERM every host, wait ≤ 5 s, SIGKILL the rest, exit 0.
5. **Live** — the root and every `$<ws>/` folder are watched (debounced 300 ms): a new/removed module or a
   config change → rescan → restage → hosts started/stopped → `workspace.onChange` listeners (the
   registry's rail refresh). A chrome change needs a restart (one chrome per run) and says so.

`ctx.dataDir` is the host's: `<root>/.atelier/local/<ws>/.atelier/data/<instance>/` — outside the module
folder, keyed by instance; a 1.x module's own `<module>/data/` is not read.

## Settings

Honoured here, ignored in the fleet (printed once as `settings honoured here, ignored in the fleet: …`):
`port`, `host`, `baseUrl`, `env` (default here is `production`), `defaultChrome`, `label`, `modules`.
Ignored in both modes (printed once each as `ignored in 2.0: <key>`): `hotReload`, `auth`, `revalidateMs`,
`observe`. Env overrides as 1.x: `ATELIER_ROOT`, `PORT`, `HOST`, `BASE_URL`, `NODE_ENV`,
`ATELIER_DEFAULT_CHROME`, `ATELIER_LABEL`.

## The jail on this machine

`jail: lifecycle-only (no uid drop) — apps are not isolated from each other on this machine`: without root
the host's adapter is `unprivileged()` — workers run as you, chown/chmod are logged no-ops, the watchdog
(RSS kill, CPU throttle) still runs. Any worker reads any folder you can read.

## How the CLI wires the shell (`local/serve.mjs`)

`startShell({cfg, workspace, log})` builds the five local providers from the CLI's `workspace` object and
calls `createShell`: `hosts.workspaces()` (`[{id, port, token}]`) is registry-local's `workspaces()`,
`discover()` (the rows of the last scan) its `discover()`, `chrome` (`{qid, dir}`) the one chrome of the run,
`onChange(fn)` the hook where `registry.refresh()` runs after the CLI's rescan (a new folder, a new
`$<ws>/`, a config change) — the registry compares the mount table and, when it moved, the shell
publishes `company:<ws>` and every tab refetches `/_atelier/rail`. The dev token rides in
`x-atelier-dev-token` from `hosts.row(ws)`; the identity assertion is minted per request; nothing
token-like ever reaches a browser URL.

## Tests

```
node --test shell/test/*.test.js        # local-discover, local-stage, cli-local (fakes), cli-local-spawn (real hosts, ~10 s)
```

`cli-local-spawn.test.js` runs `node cli.js` over two fixture apps in two workspaces on a free port
triple: document 200 and API 200 through the shell with no `token=` anywhere, a save through the symlink
becomes a new revision, SIGTERM exits 0 and leaves neither host process behind.

---

## The shell core

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
  metrics.mjs        GET /_atelier/metrics: proxy p50/p99 per host, frames/s + gaps, resume ms, bootstrap bytes, cache age — operator or local only
  config.mjs         cfg from atelier.config.json + env (local) / env (fleet); the ignored-settings lines
  providers/         identity- gate- registry- bus- hostlink- ×{local,fleet}.mjs (+ hostlink-base.mjs)
  test/              node --test shell/test/*.test.js   (65 tests, ~16 s, no host process; fixtures.mjs = the fakes)
  drill/smoke.mjs    the shell with local providers in front of the REAL host on this Mac (one background task, VERDICT)
```

## Run the tests

```
node --test shell/test/*.test.js                       # the shell alone, fakes for every provider
bash shell/drill/smoke.sh > /tmp/shell-smoke.log        # + the real host: document, API, WS save → invalidate, broken save, SIGSTOP → waking (≤ 3 min, ends in VERDICT:)
```

`shell/drill/smoke.mjs` is the same wiring without the CLI: a fixed workspace table stands in for
`local/hosts.mjs` and a fixed row list for `local/discover.mjs`, in front of one real `host/index.mjs`.

## The provider interfaces as built (deltas to DESIGN §1 are marked ⊕)

- `identity.resolve(req)` → `{ok, person:{id,name,claims}, credential:'cookie'|'none', epoch, op}` | `{ok:false, reason}`; `identity.session(req)`.
  `op` ⊕ — `true` on an operator session (the spine's `op` on the row, or `op: true` in the person's claims through the portal); it admits `/_atelier/metrics` and nothing else.
- `registry`: `company(host)`, `companies()` ⊕ (`[{id,name,href}]` — the picker rows; fleet `[]`), `apps(c)`, `resolve(c,s)`,
  `byInstance(instance)` ⊕ (the socket and `/_atelier/topics` name topics by instance, not by company), `present(personId, instance)`,
  `hostOf(row)` → `HostRow {hostId, epoch, token, ip, port, tls, heartbeatAt, drainingAt}` ⊕ (the computer the APP lives on — what `/api`, `/modules`,
  the entry imports, `/_atelier/report` and an app document's waking state dial; in the fleet the spine's `host` on the row, v36; locally the workspace's host),
  `host(c)` → the company's freshest `HostRow` (an app-less document's "is anything up" probe only), `chrome(c)` → `{qid, dir, digest}`, `watch(c, fn)`,
  `noteProbe(c, probe)` ⊕ (the document probe feeds `heartbeatAt`/`epoch` locally), `refresh(c?)` ⊕ (lane B's fs.watch and the bus's
  unknown-qid frame call it), `unreachableAt(c)` ⊕ (the last failed `/_atelier/apps` fetch — the last rows the host answered are served stale meanwhile, across `refresh()` and the poll too),
  `cacheAgeMs()` ⊕ (fleet only — the age of the oldest live apps-cache entry, the metrics route's cache-staleness row),
  `start()/stop()` (the 5 s unref'd safety poll, local). An `AppRow` carries `primary` (applied locally from
  module.json, the registry's applied value in the fleet) and `isChrome` for the chrome staged as an app (hidden from the rail).
- `gate`: `https(req)`, `hsts(req)` ⊕ (the HSTS value; `null` locally), `hostAllowed(req)`, `ticket(req,res)`, `unauthDocument(req, {company, path})`, `origin(req, credential)`.
- `bus`: `ring`, `start()/stop()`, `publish(topic)`, `onAppend(fn)`, `snapshot(topic, {person})` ⊕ (the `company:<c>` snapshot is the person's rows — presence-filtered, PLAN §4.1), `reprobe(company, probe)` ⊕ (a document-route probe
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
- `GET /_atelier/metrics` is not the client's: Prometheus text exposition of the PLAN §4.5 rows the shell owns (proxy p50/p99 and
  outcomes per host, document-socket frames/s + gaps per topic, resume ms, open sockets, bus ingest, bootstrap bytes per company,
  registry cache age). Admitted to an **operator session** or to **local mode**; to anyone else it is 404, the same answer a
  stranger gets from lane 5. Read it with `curl -s localhost:1844/_atelier/metrics` locally. Rows and costs: DESIGN §3.6.
- A fetch that meets a waking host gets `503 {"waking":true}` + `x-atelier-waking: 1` + `Retry-After: 2`; a document gets the waking page.
  A host that just failed a probe or a dial stays "waking" for 2 s per shell (no dial on fetches in that window), then the next request dials.
- `client/index.html` must carry the five slots `<!--__STYLES__-->`, `<!--__BOOTSTRAP__-->`, `<!--__IMPORTMAP__-->`, `<!--__PRELOADS__-->`,
  `<!--__CLIENT__-->` with the React UMD tags between STYLES and BOOTSTRAP (`document.mjs FALLBACK_TEMPLATE` is the reference); until it
  exists the shell serves the fallback and bundles the 1.x `client.jsx`.

## Ports on this Mac

The 1.x atelier owns 1844. Drills use 18440 (shell), 18450 (host dev), 18460 (host protocol).
