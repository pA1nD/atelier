# `shell/drill/` — the shell in front of the real host, and the browser rows (DESIGN §7.3)

## `smoke.sh` — no browser, one background task, ends in `VERDICT:` (≤ 3 min)

`bash shell/drill/smoke.sh > /tmp/shell-smoke.log` starts one real `host/index.mjs` (local mode,
fixture app `hello` with a relative import, the chrome when `~/pro/001-atelier/catalyst-chrome` exists)
and the shell with the local providers on 18440/18450/18460, then runs 23 rows: host up, rail with a rev,
document (chromeApi 2, one sheet with `?rev=`, preloads after the import map incl. the entry's relative
import, no `?v=`/`?token=`, no-store + CSP nonce), app-less document, API through the shell with
`req.user.id === 'local'` and a forged `x-atelier-user` dropped, module asset ETag `"rev-N"`, assets,
WS `subscribed` on the instance + `company:global`, a good save → one `invalidate` → snapshot rev moved →
the API answers the new marker, a broken save → `invalidate` + `snapshot.error {file, line, col, hint}`
with the rev unchanged and the API still on the old rev, the fix clears it, frames contiguous with 0 gaps,
`pong{at}` → `ping{at}`, `kill -STOP` → the waking page in ≤ 1.2 s and `503 {waking:true}` on a fetch,
`kill -CONT` → 200. Last run 2026-08-29: `VERDICT: PASS — 23 rows`.

## The browser rows through `npx atelier` (horse-browser, Chrome, 2026-08-29)

Setup: `/tmp/atelier-drill/` with `weather/` and `toybox/` copied from `003-atelier-modules` (no
`module.json` — the generator wrote them) and `catalyst-chrome` symlinked; `ATELIER_ROOT=/tmp/atelier-drill
PORT=18440 NODE_ENV=production node cli.js` as one bounded background task (`timeout 480`). Note:
`resolveRoot` picks the PARENT of `$PWD` when `ATELIER_ROOT` is unset (1.x rule) — the first run rooted at
`/tmp` and wrote a `module.json` into a stranger's `/tmp/esb-probe`; and the generator writes THROUGH a
symlinked module folder (the chrome's `module.json` landed in `~/pro/001-atelier/catalyst-chrome`, removed
by hand). Both are lane B's discovery surfaces — recorded here, not fixed here.

| row | result |
|---|---|
| a. `/global/weather`, `/global/toybox` render inside catalyst-chrome | PASS — live Open-Meteo data on screen; 16 resources, 0 failed loads (only `/favicon.ico` 404); bootstrap `chromeApi: 2`, `chromes: ['global/catalyst-chrome']`; ONE shell `<link>` = the app sheet `styles.css?rev=1` (the second stylesheet on the page is the chrome's own rsms.me Inter, injected by chrome JS); preloads after the import map; 492 246 B transferred (≤ 500 KB budget); `out/a-weather.png` |
| b. API through the shell from the page | PASS — `/api/global/toybox/skills` 200 with a forged `x-atelier-user: admin` (stripped; `/_atelier/whoami` = `local`); weather's own `/current?lat…`/`/forecast?lat…` calls 200 (a bare `/current` is the app's own 400) |
| c. a save while the page is open | PASS — `toybox/backend.js` edited twice → the socket's `invalidate` → the client fetched `/_atelier/topics/<instance>`, re-imported `frontend.js?rev=3` with NO navigation (a page-lifetime marker survived, navigation count 1), the sheet moved to `styles.css?rev=3`, `fetch(/api/global/toybox/skills)` returned the new field; `out/c-toybox-after-save.png`. The gap/300-events row is the unit test's (`shell/test/events.test.js`) and the smoke's contiguity row |
| d. hard reload (`Page.reload ignoreCache`) | PASS — renders, 0 failed loads, every `/modules/*` URL carries `?rev=N`, no `?v=` and no `?token=` on any host URL (the only `?v=4.1` is rsms.me's font) |
| e. SPA navigation weather → toybox → weather by rail click | PASS — no navigation (marker kept), `#atelier-chrome-styles` moved to `/modules/global/toybox/styles.css?rev=1` and back, exactly one link at rest; cost not measured here (§10 item 13) |
| f. the waking page | covered by `smoke.sh` (SIGSTOP/SIGCONT rows); the CLI restart after `kill -9` is lane B's `cli-local-spawn.test.js` |
| g. `atelier <id>` unchanged | lane B's (`cli-local.test.js`: the dispatch line fires only for a bare `atelier`) |

Seen in the host log during the run, not the shell's: the chrome staged as an app builds `FAILED (never
live)` — `alert.jsx:4:22 Could not resolve "./text"` (extensionless imports in the host's per-file
transform); the chrome's ASSETS come from `ATELIER_CHROME_DIR` (the dev shell's bundle) and rendered fine,
its `/api/global/catalyst-chrome/*` backend does not answer until that resolves.
