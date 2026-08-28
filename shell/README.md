# `shell/` — how to run it (lane B: local mode)

`DESIGN.md` is the design (PLAN §4.9 steps 4/4b). This file is the current state of the local wiring:
`npx atelier` = the 2.0 shell in front of one `host/` process per workspace, on a laptop, no root.

```
shell/
  cli-local.mjs          the `npx atelier` entry (cli.js dispatches a bare `atelier` here)
  local/discover.mjs     1.x discovery (discovery.js, unchanged) + slug refusals + the chrome election + module.json generation
  local/meta.mjs         the literal `export const meta` reader (server.js extractMetaStatically, ported)
  local/stage.mjs        <root>/.atelier/local/<ws>/apps/<id> → symlink to the module folder
  local/hosts.mjs        one host per workspace: port plan, env rows, dev-token mint, spawn / restart / stop, registry rows
  local/settings.mjs     port/host/env/label/defaultChrome as 1.x resolved them (+ --port=N); the ignored-settings lines
  local/serve.mjs        STUB shell — a reverse proxy to the hosts' dev shells (see "What is stubbed")
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

## What is stubbed (lane A's seam)

`local/serve.mjs` `startShell({cfg, workspace, log})` is a **reverse proxy** to the hosts' dev shells, not
the 2.0 shell: the path's company label (`/<ws>/…`, `/api/<ws>/…`, `/modules/<ws>/…`) picks the host, anything
else goes to host 0; the dev token rides in `x-atelier-dev-token` (never in a URL); inbound `x-atelier-*`,
`cookie`, `authorization` are stripped; `set-cookie` never comes back; a host that is down answers
`503 {waking:true}` on fetch routes and a plain waking page on documents (1 s dial cap). The document is
therefore the host's 1.x document (r2/spike-host-devshell), the WS the host's 1.x frame set, and the WS
always goes to host 0. `createShell({cfg, providers, log})` (DESIGN §1–3) replaces it; `workspace`
carries what the local providers need: `root`, `config`, `settings`, `chrome` (`{qid, dir, …}`), `hosts.workspaces()` (`[{id, port, token}]`, registry-local's
`workspaces()`), `hosts.row(ws)` (the HostRow of §1.2), `discover()` (the rows of the last scan, registry-local's
`discover()`), `staged()`, `onChange(fn)` (where registry-local's `refresh()` hooks in).

## Tests

```
node --test shell/test/*.test.js        # local-discover, local-stage, cli-local (fakes), cli-local-spawn (real hosts, ~10 s)
```

`cli-local-spawn.test.js` runs `node cli.js` over two fixture apps in two workspaces on a free port
triple: document 200 and API 200 through the shell with no `token=` anywhere, a save through the symlink
becomes a new revision, SIGTERM exits 0 and leaves neither host process behind.
