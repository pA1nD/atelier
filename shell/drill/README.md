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

The full run of DESIGN §7.3 rows a–g with the evidence and the six fixes it produced is
`design/atelier2/r2/spike-local-step4/RESULT.md` (screenshots beside it and in `out/`). In one line each:

| row | result |
|---|---|
| a. `/global/weather`, `/global/toybox` in catalyst-chrome | PASS — live data, 0 console errors, 0 failed loads but `/favicon.ico`, `chromeApi: 2`, one shell `<link>` (`?rev=`), preloads after the import map, 396 KB |
| b. API through the shell | PASS — forged `x-atelier-user`/`authorization` stripped, `whoami` = `local`, the chrome's own `/api/global/catalyst-chrome/docs` 200 |
| c. save → invalidate → re-import without navigation; offline + 300 broadcasts over the ring → exactly one `gap`, one snapshot, `resumed` at 301; `kill -STOP` the shell → the 1 s probe kills the socket, `-CONT` → resumed; broken save → overlay `backend.js:43:1 … — fix …`, the fix clears it | PASS |
| d. hard reload | PASS — `?rev=` everywhere, no `?v=`/`?token=` |
| e. SPA weather ↔ toybox | PASS — one sheet at rest, no CSS leak, swap 4–33 ms |
| f. waking page | PASS — host `-STOP` → 503 in 1.0 s + `WakingFallback`; `-CONT` → self-reload; `kill -9` → CLI restart in 0.5 s, API back in 2.1 s, the tab re-snapshots on the new epoch |
| g. 1.x unchanged | PASS — `atelier weather` standalone with 0 `shell/` imports; `atelier list` |

Setup note kept from the first run: `resolveRoot` picks the PARENT of `$PWD` when `ATELIER_ROOT` is unset (1.x
rule) — run a dev checkout with `ATELIER_ROOT=<instance>`; and the `module.json` generator writes THROUGH a
symlinked module folder (copy the chrome, or accept the file in its real folder).
