// doctor/report/seed-rules.mjs — the report lane's copy of the catalogue's REPORT-FACING fields
// (DESIGN §2 table: id, family, title, severity, the first-class 2.0 answer). The catalogue proper
// (`rules/catalogue.mjs`, lane A) is the truth and wins whenever it carries an id; this table is the
// fallback for an id the loaded catalogue does not know (and the whole catalogue while lane A is stubbed),
// so a runtime observation is never reported without its answer. No regexes, no counts — those are lane A's.

const R = (id, family, plan, title, severity, answer) => ({ id, family, plan, title, severity, answer })

export const SEED_RULES = Object.freeze([
  R('D1', '§4.8', '§4.8 "Also"', 'auth module (local-only)', 'breaks-in-fleet', 'the shell is the only gate (P3); an auth module is local-only — no fleet equivalent, keep it for `npx atelier`'),
  R('D2', '§4.8', 'OR6, §4.7', 'sidecar listen() (fleet-unreachable)', 'breaks-in-fleet', 'expects an operator reverse proxy the fleet does not have — first-class equivalent: URL shapes → the 2.0 router (`:param`, `/*`, bare `/`, every method); SSE/long-poll → plain streamed HTTP under `/api/<company>/<slug>`; a public hostname → dynos (§12); the bound port is also a self-collision at every save (§4.3 last-good)'),
  R('D2w', '§4.8', 'OR6 (3), §4.7', 'WebSocket sidecar (2.1)', 'breaks-in-fleet', 'WebSocket is the 2.1 upgrade lane; in 2.0.0 use SSE or `ctx.broadcast` (the proxy answers 426 to Upgrade)'),
  R('D3', '§4.8', '§4.8 "Also"', 'cross-worker ctx.module', 'breaks-in-fleet', '`ctx.module` is worker-local (one process per app); cross-app state goes through HTTP (the peer-call primitive, N5)'),
  R('D4', '§4.8', '§4.8 "Also"', 'req.user.workspaces', 'breaks-in-fleet', '`req.user = {id, name, claims}` only (§4.4); membership is the shell\'s'),
  R('D5', '§4.8', '§4.8 (meta.chrome)', 'meta.chrome pinned', 'note', 'not a break: the bootstrap advertises `chromes` (§4.1); the key is dropped from module.json'),
  R('D6', '§4.8', 'DESIGN §9.12', 'ctx.port/ctx.host', 'degrades', '`ctx.host`/`ctx.port` are the PUBLIC origin\'s host/port (443 / 1844) — compose URLs from them, never bind them; a worker has no port (see D2)'),
  R('D7', '§4.8', '§4.8 "Also"', 'ctx.broadcast', 'note', 'the host stamps `topic = company/slug`; a passed topic is ignored with one stderr warning; delivery is per-app invalidation with cursors (§4.4)'),
  R('D8', '§4.8', '§4.8 "Also"', 'collections verbs from a pod', 'degrades', 'collections from a pod are 2.1 (copy-app-between-computers)'),
  R('D9', '§4.8', '§4.8 "Also" [S:B6]', 'Authorization-based app scheme', 'breaks-in-fleet', '`Authorization` never reaches a worker (header allowlist §4.4); identity is `req.user`'),
  R('D10', '§4.8', '§4.8 "Also" [S:B6]', 'root-absolute Location in backend', 'note', 'the proxy rewrites a root-absolute `Location` (response allowlist §4.4); root-absolute links in HTML bodies are not rewritten'),
  R('D11', '§4.8', '§4.8 "Also" [S:B6]', "req.on('close') footgun", 'degrades', "disconnect = `res.on('close') && !res.writableFinished` (proxy.mjs); `req` 'close' fires early on Node ≥ 16"),
  R('D12', '§4.8', '§4.8 laptop binaries', 'spawns laptop binaries', 'breaks-in-fleet', 'the image has no laptop binaries; ship the tool as an npm dep (two-phase install as the worker uid, §4.3) or drop the feature'),
  R('D13', '§4.8', '§4.8 laptop paths', 'laptop paths (/Users, ~/…, HOME/PWD)', 'breaks-in-fleet', 'the only writable places are `ctx.dataDir` and `TMPDIR`; `HOME` is the worker\'s 0700 scratch home (row W)'),
  R('N1', 'NEW', '§4.8 N1', 'self-pathed data dir / writes into the app folder', 'breaks-in-fleet', '`ctx.dataDir` is the only data path (`/work/.atelier/data/<instance>`, outside the folder, survives a rename)'),
  R('N2', 'NEW', 'OR14, §4.8 N2', 'process.env config/secrets', 'degrades', 'the portal/spine config channel: the host injects the app\'s keys into that worker\'s env only — the read stays `process.env.X`, the SOURCE changes; `config-keys.json` names the keys the portal needs (names only, never values); under an empty channel the read silently defaults'),
  R('N2op', 'NEW', 'OR14', '…of which operator .env keys', 'breaks-in-fleet', 'fleet-wide operator secrets are never an app\'s config; each app\'s keys are set per app in the portal'),
  R('N3', 'NEW', '§4.8 N3, DESIGN §9.12', 'env HOST/PORT/BASE_URL', 'degrades', '`HOST/PORT/BASE_URL` are published from `ctx.baseUrl` into the worker env (§4.3 Workers); prefer `ctx.baseUrl` — a missing default is `http://127.0.0.1:undefined/…`'),
  R('N4', 'NEW', '§4.8 N4', 'hardcoded /api/global/ (company ≠ global)', 'breaks-in-fleet', '`/api/${ctx.workspace}/` in the backend; in the frontend the workspace from `self()`/`useRoute`'),
  R('N5', 'NEW', '§4.7 row 4, §10 item 8', 'peer-app / shell calls over loopback', 'breaks-in-fleet', 'a peer app is another worker on a Unix socket; `1844` is the dev shell and answers 401 without the token — the peer-call primitive `ctx.peer(\'<slug>\')` → `/api/<company>/<slug>` (§10 item 8); until it lands, the app\'s own routes'),
  R('N6', 'NEW', '§4.8 N6', 'shell internals (/_atelier/*, atelier.config.json, ATELIER_ROOT)', 'breaks-in-fleet', 'shell internals are gone; `/_atelier/report` is the kit\'s error lane (OR16), the rest has no successor'),
  R('N7', 'NEW', '§4.8 N7, R11', 'client JS/JSX in subfolders', 'note', 'the recursive scan is built (`tailwind.mjs scanSources`, `bundle.mjs walkFiles`); column kept for the seed\'s comparability'),
  R('N8', 'NEW', '§4.3 last-good (teardown)', "process.on('SIG…') / process.exit in app code", 'degrades', 'return a teardown from `mountRoutes`; the runtime owns SIGTERM (`process.exit` skips the teardown and orphans children)'),
  R('I1', 'info', 'seed info', 'relative imports in backend', 'note', 'bundled by `bundleBackend`; run-time `HERE`-located files still come from the live folder'),
  R('I2', 'info', 'seed info', 'internet egress at mount', 'note', 'egress stays open (P13)'),
  R('I3', 'info', 'seed info', 'TopBarCenter/eager', 'note', 'dropped in the fleet document'),
  R('I4', 'info', 'seed info', '@atelier/kit import', 'note', 'as the seed'),
  R('I5', 'info', 'seed info', 'useRoute', 'note', 'as the seed'),
  R('M1', 'mobile', '§4.8 mobile', '100vh', 'note', 'OR5: `100dvh`'),
  R('M2', 'mobile', '§4.8 mobile', 'h-screen', 'note', 'OR5: `100dvh`'),
  R('M3', 'mobile', '§4.8 mobile', 'fixed+bottom-0 bar', 'note', 'OR5: safe-area insets'),
  R('M4', 'mobile', '§4.8 mobile', 'sub-16px input', 'note', 'OR5: ≥ 16 px inputs'),
  R('N1mix', 'NEW', '§4.8 N1 (surprise 3)', 'both ctx.dataDir and a folder-relative data/', 'degrades', 'a rename of `ctx.dataDir` would split the state — move everything to `ctx.dataDir`'),
  R('N9', 'NEW', '§4.3 last-good, §10 item 1', 'sqlite open without a busy timeout', 'degrades', 'set a busy timeout on every open; the supervisor retries the mount once after the old worker exits'),
  R('N10', 'NEW', 'OR10', 'export const meta → module.json', 'note', '`module.json` `{name, icon, group, primary, color}` is the only meta; `chrome`, `isChrome`, `hidden`, `eager` are dropped; a computed meta cannot be generated — write module.json by hand'),
  R('N11', 'NEW', 'DESIGN §9.7', 'module.json key outside the five', 'note', 'the registrar drops unknown keys; an app is its chat\'s (OR8), company-wide apps are dynos (§12) — there is no visibility switch'),
  R('R1', 'runtime', 'RESULT surprise 6', 'worker broken at mount', 'breaks-in-fleet', 'the failure class and `file:line:col` from the control message (`load-failed` + `classifyWorkerFailure`)'),
  R('R2', 'runtime', 'R14', 'stays resident (timers, children, sockets)', 'note', 'stays resident — RLIMIT_DATA is its memory lever; `ctx.suspendable()` when the background work is optional'),
  R('R3', 'runtime', '§4.3 teardown', 'no teardown / killed at the drain deadline', 'degrades', 'return a teardown; children must die inside 2 s'),
])

export const SEED_RULE_BY_ID = Object.freeze(Object.fromEntries(SEED_RULES.map((r) => [r.id, r])))

/** Constants the observation classifier needs when the catalogue does not export them (seed report.mjs + DESIGN §4). */
export const NODE_NOISE = new Set(['WATCH_REPORT_DEPENDENCIES', 'NODE_V8_COVERAGE', '__CF_USER_TEXT_ENCODING', 'WS_NO_BUFFER_UTIL', 'FORCE_COLOR', 'DEBUG', 'NODE_ENV', 'APP_ID', 'PATH', 'NODE_OPTIONS', 'LANG', 'LC_ALL', 'NODE_DEBUG', 'NO_COLOR', 'TERM', 'COLORTERM', 'ATELIER_WORKER', 'CI'])
export const SHELL_KEYS = new Set(['HOST', 'PORT', 'BASE_URL'])
export const LAPTOP_KEYS = new Set(['HOME', 'PWD', 'USER', 'TMPDIR', 'SHELL', 'XPC_SERVICE_NAME', 'LOGNAME'])
export const IMAGE_BINS = new Set(['node', 'npm', 'npx', 'git', 'sh', 'bash', 'python3', 'curl', 'tar', 'gzip'])
