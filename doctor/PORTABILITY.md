# Portability table — `atelier doctor` over the 1.x corpus

Run 2026-08-29 on the laptop: `node doctor/cli.mjs /Users/pa1nd/pro/003-atelier-modules --out …/spike-doctor-step3/out --env-keys ~/pro/atelier/.env --jobs 6` (branch `doctor`, after the round-2 review fixes). 58 modules, 53 with a backend; every backend mounted inside the real host worker (`host/worker/runtime.mjs` behind `doctor/probe/entry.mjs`), no root, no network, corpus tree hash unchanged before/after. Machine-readable: `portability.csv` (58 rows × 52 columns, the seed's 37-column header first, then `N1mix,N9,N10,N11,R1,R2,R3,D14,long_lines,resident,teardown,killed,config_keys,operator_keys,verdict`), `doctor/<module>/report.json` per module. module.json: 57 generated (midnight-chrome is a chrome — D14, none); "module.json 58/58" in the VERDICT counts literal metas.

**VERDICT: DOCTOR 4/58 clean, 9 degrade, 45 break in the fleet (17/18 daily); module.json 58/58; rewrites 32 edits in 7 modules; probe 48/53 mounted, 5 broken at mount [sites(load-error), auth(mount-throw), meet-vault(load-error), projects(mount-throw), screenmap(mount-throw)]; tailwind max n/a**

## Rows

| row | family | break | modules /58 | daily /18 |
|---|---|---|---|---|
| D1 | §4.8 | auth module (local-only) | 1 | 0 |
| D2 | §4.8 | sidecar listen() (fleet-unreachable) | 10 | 5 |
| D2w | §4.8 | WebSocket sidecar (2.1) | 4 | 2 |
| D3 | §4.8 | cross-worker ctx.module | 0 | 0 |
| D4 | §4.8 | req.user.workspaces | 2 | 1 |
| D5 | §4.8 | meta.chrome pinned | 52 | 15 |
| D6 | §4.8 | ctx.port/ctx.host | 13 | 5 |
| D7 | §4.8 | ctx.broadcast | 45 | 17 |
| D8 | §4.8 | collections verbs from a pod | 4 | 3 |
| D9 | §4.8 | Authorization-based app scheme | 6 | 5 |
| D10 | §4.8 | root-absolute Location in backend | 2 | 0 |
| D11 | §4.8 | req.on('close') footgun | 3 | 2 |
| D12 | §4.8 | spawns laptop binaries | 29 | 11 |
| D13 | §4.8 | laptop paths (/Users, ~/…, HOME/PWD) | 28 | 10 |
| N1 | NEW | self-pathed data dir / writes into the app folder | 19 | 9 |
| N2 | NEW | process.env config/secrets | 27 | 14 |
| N2op | NEW | …of which operator .env keys | 7 | 6 |
| N3 | NEW | env HOST/PORT/BASE_URL | 10 | 10 |
| N4 | NEW | hardcoded /api/global/ | 11 | 10 |
| N5 | NEW | peer-app / shell calls over loopback | 21 | 10 |
| N6 | NEW | shell internals (/_atelier/*, atelier.config.json, ATELIER_ROOT) | 8 | 4 |
| N7 | NEW | client JS/JSX in subfolders | 12 | 4 |
| N8 | NEW | process.on('SIG…') / process.exit in app code | 8 | 5 |
| I1 | info | relative imports in backend | 19 | 9 |
| I2 | info | internet egress at mount | 2 | 2 |
| I3 | info | TopBarCenter/eager | 1 | 1 |
| I4 | info | @atelier/kit import | 42 | 13 |
| I5 | info | useRoute | 27 | 11 |
| M1 | mobile | 100vh | 6 | 4 |
| M2 | mobile | h-screen | 1 | 0 |
| M3 | mobile | fixed+bottom-0 bar | 2 | 0 |
| M4 | mobile | sub-16px input | 1 | 1 |
| N1mix | NEW | uses both ctx.dataDir and a folder-relative data/ | 13 | 7 |
| N9 | NEW | sqlite open without a busy timeout | 4 | 2 |
| N10 | NEW | export const meta → module.json | 0 | 0 |
| N11 | NEW | module.json with keys outside the five | 0 | 0 |
| R1 | runtime | probe state ≠ mounted | 5 | 1 |
| R2 | runtime | stays resident (timers, children, sockets after mount) | 30 | 11 |
| R3 | runtime | no teardown / killed at the drain deadline | 11 | 3 |
| D14 | §4.8 | multi-chrome (local-only) | 1 | 0 |

## Modules

| module | daily | 2.0 worker | breaks (row: count) | verdict |
|---|---|---|---|---|
| dashboard | Y | mounted | D2:1 D5:1 D7:3 D8:1 D9:1 D12:1 D13:1 N2:5 N2op:2 N4:2 N6:1 N8:5 | BREAKS |
| jobs | Y | mounted | D5:1 D7:1 N3:1 N4:3 N5:1 | BREAKS |
| agent | Y | mounted | D2:2 D2w:1 D5:1 D7:12 D9:7 D11:4 D12:3 D13:22 N1:41 N2:54 N3:1 N4:2 N5:11 N7:14 N8:17 | BREAKS |
| audio-player | Y | mounted | D5:1 D6:1 D7:10 D13:4 | BREAKS |
| sites | Y | load-error — EACCES: permission denied (doctor: the worker owns nothing outside ctx.dataDir), mkdir '/U | D2:1 D2w:1 D5:1 D7:4 D9:1 D12:1 D13:1 N1:5 N2:11 N2op:8 N3:2 N4:1 N6:2 N1mix:1 | BREAKS |
| spaces | Y | mounted | D2:1 D5:1 D11:1 N2:1 N9:1 | BREAKS |
| shipmate | Y | mounted | D6:4 D7:36 D8:30 D12:3 D13:7 N1:2 N2:2 N3:2 N4:4 N5:1 N6:7 N7:3 N8:1 N1mix:1 | BREAKS |
| forms | Y | mounted | D5:1 D7:3 D9:1 D12:1 D13:1 N2:5 N2op:3 N3:1 | BREAKS |
| pipeline | Y | mounted | D5:1 D7:1 | DEGRADES |
| artifacts | Y | mounted | D2:1 D5:1 D6:1 D7:5 D9:1 D12:2 N2:7 N2op:3 N3:1 N4:1 N5:1 | BREAKS |
| mining | Y | mounted | D7:1 N3:1 N4:1 N5:1 | BREAKS |
| news | Y | mounted | D5:1 D7:6 D12:1 N1:1 N2:1 N3:1 N4:1 N5:1 N8:1 N1mix:1 | BREAKS |
| signal | Y | mounted | D5:1 D7:10 D12:1 D13:3 N1:5 N2:1 N1mix:1 | BREAKS |
| channels | Y | mounted | D5:1 D6:1 D7:2 D13:2 N1:3 N2:1 N2op:1 N5:8 N1mix:1 | BREAKS |
| flights | Y | mounted | D5:1 D7:18 D12:1 D13:3 N1:4 N2:5 N2op:2 N3:1 N4:1 N5:3 N7:1 N8:5 N1mix:1 N9:1 | BREAKS |
| requests | Y | mounted | D4:1 D6:4 D7:11 D12:3 D13:1 N2:2 N5:4 N6:7 | BREAKS |
| bookmarks | Y | mounted | D5:1 D7:2 D8:2 D12:1 N1:2 N2:4 N3:1 N4:1 N5:2 | BREAKS |
| accounts | Y | mounted | D5:1 D7:11 N1:2 N2:2 N7:5 N1mix:1 | BREAKS |
| address-book |  | mounted | D5:1 D13:1 N9:1 | BREAKS |
| agents |  | mounted | D5:1 D7:20 D12:4 D13:1 N5:11 | BREAKS |
| agents_old |  | mounted | D5:1 D7:4 D12:1 D13:2 N5:12 | BREAKS |
| atelier-config |  | mounted | D5:1 D6:6 D7:4 D12:3 D13:9 N1:1 N2:1 N6:23 N8:1 | BREAKS |
| auth |  | mount-throw — EACCES: permission denied (doctor: the worker owns nothing outside ctx.dataDir), mkdir '/U | D1:1 D4:6 D5:1 D10:1 N1:2 N2:1 N4:3 N6:5 N7:14 | BREAKS |
| benchmarks |  | mounted | D5:1 D6:1 | DEGRADES |
| blitz-portal |  | mounted | D5:1 D6:1 D7:16 D9:4 D12:1 D13:1 N2:4 N2op:3 N5:2 N7:3 | BREAKS |
| blitzfeed |  | mounted | D2:1 D5:1 N2:1 | BREAKS |
| blitzwiki |  | no-backend | D5:1 | CLEAN |
| claude-md |  | mounted | D5:1 D7:3 | DEGRADES |
| computers |  | mounted | D5:1 D7:5 D12:2 D13:2 | BREAKS |
| contacts |  | mounted | D5:1 D7:5 | DEGRADES |
| devops |  | mounted | D5:1 D7:4 D12:1 | DEGRADES |
| drive |  | mounted | D5:1 D7:3 N5:1 | BREAKS |
| email |  | mounted | D5:1 D7:1 D13:2 N9:2 | BREAKS |
| gwx |  | mounted | D5:1 D7:3 D13:2 | BREAKS |
| hb-stealth |  | mounted | D5:1 D12:1 N5:1 | BREAKS |
| horse-browser |  | mounted | D5:1 D6:3 D7:7 D13:6 N2:2 | BREAKS |
| insta-feed |  | mounted | D7:4 D12:1 | BREAKS |
| intercom |  | mounted | D2:1 D2w:1 D5:1 D6:7 D7:20 D12:3 D13:3 N1:1 N2:4 N7:7 N1mix:1 | BREAKS |
| investors |  | no-backend | D5:1 | CLEAN |
| kit |  | no-backend | D5:1 | CLEAN |
| latency-map |  | mounted | D5:1 D7:12 D12:1 D13:4 N7:1 | BREAKS |
| llm |  | mounted | D2:1 D5:1 D7:1 D11:1 D12:2 N1:2 N2:5 N5:3 N8:5 N1mix:1 | BREAKS |
| meet-vault |  | load-error — EACCES: permission denied (doctor: the worker owns nothing outside ctx.dataDir), mkdir '/U | D5:1 D7:21 D12:5 D13:1 N1:2 N2:3 N5:2 N6:1 N7:6 N1mix:1 | BREAKS |
| midnight-chrome |  | no-backend | D14:1 | BREAKS |
| mlx-tts |  | mounted | D2:1 D5:1 D6:1 D7:9 D12:1 D13:2 N2:5 N5:1 | BREAKS |
| module-dev |  | mounted | D5:1 D6:2 D7:1 D8:3 D13:2 N2:1 N6:9 | BREAKS |
| profile |  | mounted | D5:1 D7:1 | DEGRADES |
| projects |  | mount-throw — EACCES: permission denied (doctor: the worker owns nothing outside ctx.dataDir), mkdir '/U | D5:1 D7:8 D12:2 D13:2 N1:3 N2:2 N5:1 | BREAKS |
| revive |  | mounted | D5:1 D7:1 | DEGRADES |
| screenmap |  | mount-throw — EACCES: permission denied (doctor: the worker owns nothing outside ctx.dataDir), mkdir '/U | D5:1 D7:1 D12:1 N1:2 N5:1 | BREAKS |
| sessions |  | mounted | D5:1 D7:6 D13:1 | BREAKS |
| sous |  | mounted | D2:1 D2w:1 D5:1 D6:2 D7:29 D10:1 D12:1 D13:5 N1:2 N2:16 N5:4 N7:13 N8:5 N1mix:1 | BREAKS |
| speech |  | mounted | D5:1 D7:2 D12:1 N1:1 N1mix:1 | BREAKS |
| statusbar |  | mounted | D5:1 D7:3 D13:2 N7:2 | BREAKS |
| toybox |  | mounted | D5:1 | DEGRADES |
| voicelab |  | mounted | D5:1 D7:8 D12:3 N1:1 N2:4 N7:1 N1mix:1 | BREAKS |
| weather |  | mounted | D5:1 | DEGRADES |
| worldclock |  | no-backend |  | CLEAN |
