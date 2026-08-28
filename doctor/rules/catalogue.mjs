// doctor/rules/catalogue.mjs — the rule catalogue as DATA (DESIGN §2). Every other file reads it; a rule
// is never coded anywhere else. Regexes are the seed's (spike-migration-local-1/doctor-static.mjs RX,
// SPAWN, ENVREAD, CTXMOD, REL_IMPORT, MOBILE) plus the new ones for N9–N11; `count()` per seed id keeps
// the seed's report.mjs semantics so the 58 corpus numbers reproduce.
//
// Rule shape — see DESIGN §2. `detect.static[]` entries:
//   files    'backend' | 'frontend' | 'all'        which walked files the regex runs over
//   re       the regex (run with the g flag over the file text)
//   scope    'mountRoutes' | 'outside-mountRoutes' | undefined (= anywhere); backend files only — a
//            frontend has no mountRoutes span, so a scoped entry never matches there
//   env      for ENVREAD entries: the env classes (env.mjs) this rule owns
//   classify ({match, key, index, line, lineText, text, scanned, file, scope}) → {skip?, severity?, answer?}
//   answer / severity   per-entry overrides of the rule's
// `count(s, p, tw)`: s = the module's StaticResult (static.mjs), p = the probe's runtime record (lane B,
// DESIGN §4 `report.json.runtime`; null when --no-probe), tw = {coldMs, longLines} (unused by the rules).
import { splitArgs } from './scope.mjs'

export const META_KEYS = ['name', 'icon', 'group', 'primary', 'color']   // module.json — the only meta (OR10, protocol/registry META_ALLOW)

export const IMAGE_BINS = new Set(['node', 'npm', 'npx', 'git', 'sh', 'bash', 'python3', 'curl', 'tar', 'gzip'])
export const SQL_VERBS = /^(PRAGMA|ALTER|COMMIT|BEGIN|DROP|ROLLBACK|DELETE|ANALYZE|CREATE|INSERT|UPDATE|SELECT|VACUUM|WITH)$/i

// env classes (env.mjs). NODE_NOISE = the seed report.mjs list (RESULT surprise 7) + CI.
export const NODE_NOISE = new Set(['WATCH_REPORT_DEPENDENCIES', 'NODE_V8_COVERAGE', '__CF_USER_TEXT_ENCODING', 'WS_NO_BUFFER_UTIL', 'FORCE_COLOR', 'DEBUG', 'NODE_ENV', 'PATH', 'NODE_OPTIONS', 'LANG', 'LC_ALL', 'NODE_DEBUG', 'NO_COLOR', 'TERM', 'COLORTERM', 'CI'])
export const SHELL_PUBLISHED = new Set(['HOST', 'PORT', 'BASE_URL'])          // N3 (DESIGN §9.12, row W)
export const ROW_W_ENV = new Set(['APP_ID', 'ATELIER_WORKER', 'TMPDIR'])       // the rest of the worker env the host sets; TMPDIR is also laptop (D13 counts it)
export const LAPTOP_D13 = new Set(['HOME', 'PWD', 'USER', 'TMPDIR', 'SHELL', 'XPC_SERVICE_NAME', 'LOGNAME'])   // the seed's D13 env set
export const LAPTOP = new Set([...LAPTOP_D13])
export const SHELL_KEYS = SHELL_PUBLISHED, LAPTOP_KEYS = LAPTOP_D13        // the names lane C (report/lanes.mjs) imports
export const CONFIG_SUFFIX_RE = /(_KEY|_TOKEN|_SECRET|PASSWORD|PASSPHRASE|_API|_URL|_PORT|_HOST|_DIR|_PATH|_MODEL|_BIN)$|^ATELIER_/

export const HOST_INTERNAL_PATHS = ['/_atelier/health', '/_atelier/report']   // the 2.0 host's own — not N6

// The seed's greps, verbatim (keys are the seed's; `homedir`, `sqlite_open`, `shell_internals` (lookahead) are new).
export const RX = {
  api_global: /\/api\/global\//g,
  localhost_port: /(localhost|127\.0\.0\.1):\d{4,5}/g,
  user_workspaces: /user\??\.workspaces/g,
  authorization: /(headers\s*\[\s*['"]authorization['"]\]|headers\.authorization|['"]Authorization['"]\s*:|Authorization:\s*`?Bearer)/g,
  req_on_close: /req\.on\(\s*['"]close['"]/g,
  ctx_port_host: /\bctx\.(port|host)\b/g,
  ctx_dataDir: /ctx\.dataDir/g,
  ctx_label: /\bctx\.label\b/g,
  self_data: /(?:__dirname|import\.meta\.url|fileURLToPath|\bHERE\b|\bROOT\b|MODULE_DIR|\bDIR\b|dirname\()[^\n;]*['"`](?:\.\/)?data(?:\/|['"`])|path\.join\([^)\n]*['"]data['"]|['"`]\.\/data(?:\/|['"`])|`\$\{[^}]*\}\/data(?:\/|`)/g,
  listen: /\.listen\s*\(/g,
  ws: /WebSocketServer|from ['"]ws['"]|require\(['"]ws['"]\)|on\(\s*['"]upgrade['"]/g,
  proc_signal: /process\.on\(\s*['"]SIG/g,
  proc_exit: /process\.exit\(/g,
  broadcast: /ctx\.broadcast\(/g,
  authenticate: /\bauthenticate\s*(\(|:)/g,
  abs_path: /['"`]\/(Users|Volumes|opt\/homebrew|usr\/local|Applications)\//g,
  homedir: /os\.homedir\(\)|homedir\(\)|['"`]~\/\.config/g,
  root_abs_location: /Location['"]?\s*:\s*['"`]\/(?!api\/)/g,
  topbar_eager: /TopBarCenter|\beager\s*:\s*true/g,
  kit: /@atelier\/kit/g,
  use_route: /useRoute\(/g,
  collections: /\batelier (add|publish|package|list)\b|collections\.js/g,
  sqlite: /better-sqlite3|node:sqlite|DatabaseSync/g,
  sqlite_open: /new\s+DatabaseSync\s*\(|require\(\s*['"]better-sqlite3['"]\s*\)\s*\(|new\s+Database\s*\(/g,
  shell_internals: /\/_atelier\/(?!health\b|report\b)|atelier\.config\.json|ATELIER_ROOT|ATELIER_SHELL/g,
}
export const SPAWN = /\b(spawn|execFile|exec|execSync|execFileSync|spawnSync|fork)\s*\(\s*(['"`])([^'"`\n]+)\2/g
export const ENVREAD = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)|process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g
export const CTXMOD = /ctx\.module\(\s*(?:(['"])([^'"]+)\1|(ctx\.id))\s*\)/g
export const REL_IMPORT = /^\s*import\s[^'"]*['"]\.{1,2}\/|import\(\s*['"]\.{1,2}\//gm
export const MOBILE = {
  vh100: /100vh/g,
  h_screen: /\b(min-|max-)?h-screen\b/g,
  fixed_bottom: /className=\s*(["'`])(?:(?!\1)[^])*?\bfixed\b(?:(?!\1)[^])*?\bbottom-0\b|className=\s*(["'`])(?:(?!\2)[^])*?\bbottom-0\b(?:(?!\2)[^])*?\bfixed\b/g,
  small_input: /<(input|textarea|select|Input|Textarea|Select)\b[^>]*className=\s*(["'`])[^"'`]*\btext-(xs|sm|\[1[0-5]px\])\b/g,
}
export const SQLITE_GUARD = /busy_timeout|\btimeout\b/i

// module.json keys the doctor drops, with the rule that names them (DESIGN §3)
export const DROPPED_META_KEYS = {
  chrome: { rule: 'D5', reason: 'not a break: the bootstrap advertises `chromes` (§4.1); the pin is dropped from module.json' },
  eager: { rule: 'I3', reason: 'eager/TopBarCenter are dropped in the fleet document' },
  visibility: { rule: 'N11', reason: 'no visibility switch: an app is its chat\'s (OR8); a company-wide app is a dyno (§12); the registrar drops the key' },
  '*': { rule: 'N10', reason: 'module.json is {name, icon, group, primary, color} only (OR10); every other key is dropped by the registrar' },
}

const arr = (x) => (Array.isArray(x) ? x : [])
const g = (s, k) => (s.greps?.backend?.[k] || 0) + (s.greps?.frontend?.[k] || 0)
const gb = (s, k) => s.greps?.backend?.[k] || 0
const P = (p) => p || {}
const envKeys = (s, p) => new Set([...Object.keys(s.env || {}), ...arr(P(p).envReads)])
const LOOPBACK_EGRESS = /^(?:https?:\/\/|ws:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/)/
const INTERNET_EGRESS = /https?:\/\/(?!127\.0\.0\.1|localhost|\[::1\])/
const MOUNTED_STATES = new Set(['mounted', 'no-backend', 'skipped'])

const SIDECAR = 'expects an operator reverse proxy that the fleet does not have — here is the first-class equivalent: '

// D2's equivalent is chosen by what the module does (DESIGN §9.8)
function sidecarAnswer({ text, lineText }) {
  const eq = new RegExp(RX.ws.source).test(text)
    ? 'WebSocket is the 2.1 upgrade lane; in 2.0.0 use SSE or `ctx.broadcast` (the proxy answers 426 to Upgrade)'
    : /text\/event-stream|long-?poll/i.test(text)
      ? 'SSE/long-poll → plain streamed HTTP under `/api/<company>/<slug>` through the 2.0 router'
      : /public|share|tunnel|hostname/i.test(lineText) ? 'a public hostname → dynos (§12)'
        : 'the 2.0 router (`:param`, `/*`, bare `/`, every method) under `/api/<company>/<slug>`'
  const port = /(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}|\b\d{4,5}\b/.exec(lineText)?.[0]
  return SIDECAR + eq + '; the bound port is also a self-collision at every save (§4.3 last-good)' + (port ? ` — fixed address \`${port}\`` : '')
}

/** @type {import('./catalogue.mjs').Rule[]} */
export const RULES = [
  {
    id: 'D1', family: '§4.8', plan: '§4.8 "Also"', title: 'auth module (local-only)', severity: 'breaks-in-fleet',
    detect: { static: [{ files: 'backend', re: RX.authenticate }] },
    count: (s) => (gb(s, 'authenticate') ? 1 : 0),
    answer: 'the shell is the only gate (P3); an auth module is local-only — no fleet equivalent, keep it for `npx atelier`',
    rewrite: null, evidence: '1/58 (auth)',
  },
  {
    id: 'D2', family: '§4.8', plan: 'OR6, §4.7', title: 'sidecar listen() (fleet-unreachable)', severity: 'breaks-in-fleet',
    detect: { static: [{ files: 'backend', re: RX.listen, classify: (c) => ({ answer: sidecarAnswer(c) }) }], runtime: ['listen'] },
    count: (s, p) => arr(P(p).listens).length || (gb(s, 'listen') ? 1 : 0),
    answer: SIDECAR + 'URL shapes → the 2.0 router (`:param`, `/*`, bare `/`, every method); SSE/long-poll → plain streamed HTTP under `/api/<company>/<slug>`; a public hostname → dynos (§12); the bound port is also a self-collision at every save (§4.3 last-good)',
    rewrite: null, evidence: '8/53 listen at mount (agent ×2, artifacts, spaces, intercom, blitzfeed, …); the port strings match the seed\'s',
  },
  {
    id: 'D2w', family: '§4.8', plan: 'OR6 (3), §4.7', title: 'WebSocket sidecar (2.1)', severity: 'breaks-in-fleet',
    detect: { static: [{ files: 'backend', re: RX.ws }] },
    count: (s) => (gb(s, 'ws') ? 1 : 0),
    answer: 'WebSocket is the 2.1 upgrade lane; in 2.0.0 use SSE or `ctx.broadcast` (the proxy answers 426 to Upgrade)',
    rewrite: null, evidence: '4/58',
  },
  {
    id: 'D3', family: '§4.8', plan: '§4.8 "Also"', title: 'cross-worker ctx.module', severity: 'breaks-in-fleet',
    detect: { static: [{ files: 'all', re: CTXMOD, classify: ({ match, module }) => (match[3] || match[2] === module ? { skip: true } : {}) }] },
    count: (s) => (arr(s.crossModule).length ? 1 : 0),
    answer: '`ctx.module` is worker-local (one process per app); cross-app state goes through HTTP (the peer-call primitive, N5)',
    rewrite: null, evidence: '0/58',
  },
  {
    id: 'D4', family: '§4.8', plan: '§4.8 "Also"', title: 'req.user.workspaces', severity: 'breaks-in-fleet',
    detect: { static: [{ files: 'all', re: RX.user_workspaces }] },
    count: (s) => g(s, 'user_workspaces'),
    answer: '`req.user = {id, name, claims}` only (§4.4); membership is the shell\'s',
    rewrite: null, evidence: '2/58',
  },
  {
    id: 'D5', family: '§4.8', plan: '§4.8 (meta.chrome)', title: 'meta.chrome pinned', severity: 'note',
    detect: { meta: 'chrome' },
    count: (s) => (s.meta?.chrome ? 1 : 0),
    answer: 'not a break: the bootstrap advertises `chromes` (§4.1); the key is dropped from module.json and named',
    rewrite: null, evidence: '52/58 pin `catalyst-chrome`',
  },
  {
    id: 'D6', family: '§4.8', plan: 'DESIGN §9.12', title: 'ctx.port/ctx.host', severity: 'degrades',
    detect: { static: [{ files: 'all', re: RX.ctx_port_host, classify: ({ lineText }) => (/\.listen\s*\(/.test(lineText) ? { severity: 'breaks-in-fleet', answer: 'a bind of `ctx.host`/`ctx.port`: they are the PUBLIC origin\'s host/port (443 / 1844) — a worker has no port (see D2); compose URLs from them, never bind them' } : {}) }] },
    count: (s) => g(s, 'ctx_port_host'),
    answer: '`ctx.host`/`ctx.port` are the PUBLIC origin\'s host/port (443 / 1844) — compose URLs from them, never bind them; a worker has no port (see D2)',
    rewrite: null, evidence: '13/58 read them; the bind cases are a subset of D2',
  },
  {
    id: 'D7', family: '§4.8', plan: '§4.8 "Also"', title: 'ctx.broadcast', severity: 'note',
    detect: {
      static: [{
        files: 'all', re: RX.broadcast,
        classify: ({ match, text, scanned }) => {
          const open = match.index + match[0].length - 1
          const call = splitArgs(text, open, scanned.mask)
          const args = call ? text.slice(open + 1, call.close) : ''
          return /\btopic\s*:/.test(args) ? { severity: 'degrades', answer: 'a passed `topic` is ignored with one stderr warning (runtime.mjs): the host stamps `topic = company/slug`' } : {}
        },
      }],
    },
    count: (s) => g(s, 'broadcast'),
    answer: 'the host stamps `topic = company/slug`; a passed topic is ignored with one stderr warning (runtime.mjs); delivery is per-app invalidation with cursors (§4.4)',
    rewrite: null, evidence: '45/58',
  },
  {
    id: 'D8', family: '§4.8', plan: '§4.8 "Also"', title: 'collections verbs from a pod', severity: 'degrades',
    detect: { static: [{ files: 'all', re: RX.collections }] },
    count: (s) => g(s, 'collections'),
    answer: 'collections from a pod are 2.1 (copy-app-between-computers)',
    rewrite: null, evidence: '4/58',
  },
  {
    id: 'D9', family: '§4.8', plan: '§4.8 "Also" [S:B6]', title: 'Authorization-based app scheme', severity: 'breaks-in-fleet',
    detect: { static: [{ files: 'backend', re: RX.authorization }] },
    count: (s) => gb(s, 'authorization'),
    answer: '`Authorization` never reaches a worker (header allowlist §4.4); identity is `req.user`',
    rewrite: null, evidence: '6/58',
  },
  {
    id: 'D10', family: '§4.8', plan: '§4.8 "Also" [S:B6]', title: 'root-absolute Location in backend', severity: 'note',
    detect: { static: [{ files: 'backend', re: RX.root_abs_location }] },
    count: (s) => gb(s, 'root_abs_location'),
    answer: 'the proxy rewrites a root-absolute `Location` (response allowlist §4.4); root-absolute links in HTML bodies are not rewritten',
    rewrite: null, evidence: '1/58',
  },
  {
    id: 'D11', family: '§4.8', plan: '§4.8 "Also" [S:B6]', title: "req.on('close') footgun", severity: 'degrades',
    detect: { static: [{ files: 'all', re: RX.req_on_close }] },
    count: (s) => g(s, 'req_on_close'),
    answer: "disconnect = `res.on('close') && !res.writableFinished` (proxy.mjs); `req` 'close' fires early on Node ≥ 16",
    rewrite: null, evidence: '3/58',
  },
  {
    id: 'D12', family: '§4.8', plan: '§4.8 laptop binaries', title: 'spawns laptop binaries', severity: 'breaks-in-fleet',
    detect: {
      static: [{
        files: 'all', re: SPAWN,
        classify: ({ match }) => {
          const bin = match[3].split(/\s/)[0]
          if (SQL_VERBS.test(bin)) return { skip: true }
          if (IMAGE_BINS.has(bin)) return { severity: 'note', answer: `\`${bin}\` is in the image (IMAGE_BINS)` }
          return { answer: `\`${bin}\`: the image has no laptop binaries; ship the tool as an npm dep (two-phase install as the worker uid, §4.3) or drop the feature` }
        },
      }],
      runtime: ['spawn'],
    },
    count: (s, p) => new Set([...arr(s.spawn), ...arr(P(p).spawns)]).size,
    answer: 'the image has no laptop binaries; ship the tool as an npm dep (two-phase install as the worker uid, §4.3) or drop the feature',
    rewrite: null, evidence: '29/58 static; the runtime list ⊆ static list per module',
  },
  {
    id: 'D13', family: '§4.8', plan: '§4.8 laptop paths', title: 'laptop paths (/Users, ~/…, HOME/PWD)', severity: 'breaks-in-fleet',
    detect: {
      static: [
        { files: 'all', re: RX.abs_path },
        { files: 'all', re: RX.homedir, severity: 'degrades', answer: '`HOME` is the worker\'s 0700 scratch home (row W); the only writable places are `ctx.dataDir` and `TMPDIR`' },
        { files: 'all', re: ENVREAD, env: ['laptop'], severity: 'degrades', answer: '`HOME` is the worker\'s 0700 scratch home (`<scratch>/home`, row W); PWD/USER/SHELL/LOGNAME are the worker\'s, not the laptop\'s' },
      ],
      runtime: ['writeOutside'],
    },
    count: (s, p) => g(s, 'abs_path') + Object.keys(s.env || {}).filter((k) => LAPTOP_D13.has(k)).length + arr(P(p).writesOutside).filter((w) => /~\//.test(w) && !/<app>/.test(w)).length,
    answer: 'the only writable places are `ctx.dataDir` and `TMPDIR`; `HOME` is the worker\'s 0700 scratch home (row W)',
    rewrite: null, evidence: '28/58 static; 2/53 die on `~/pro/…` at mount (mlx-tts, sous)',
  },
  {
    id: 'N1', family: 'NEW', plan: '§4.8 N1', title: 'self-pathed data dir / writes into the app folder', severity: 'breaks-in-fleet',
    detect: {
      static: [
        { files: 'backend', re: RX.self_data, scope: 'mountRoutes', answer: '`ctx.dataDir` is the only data path (`/work/.atelier/data/<instance>`, outside the folder, survives a rename) — mechanical rewrite inside `mountRoutes` (rules/rewrite.mjs N1)' },
        { files: 'backend', re: RX.self_data, scope: 'outside-mountRoutes', answer: 'hoist into `mountRoutes` — `ctx.dataDir` is only known there (the worker cannot write into the 2750 app folder; a real worker dies at its first write)' },
        { files: 'frontend', re: RX.self_data, severity: 'degrades', answer: 'a frontend has no data path: the app\'s data lives under `ctx.dataDir` and is served by its own routes' },
      ],
      runtime: ['selfData', 'writeOutside'],
    },
    count: (s, p) => g(s, 'self_data') + new Set([...arr(P(p).selfData), ...arr(P(p).writesOutside).filter((w) => /<app>/.test(w))]).size,
    answer: '`ctx.dataDir` is the only data path (`/work/.atelier/data/<instance>`, outside the folder, survives a rename)',
    rewrite: { kind: 'mechanical', transform: 'N1', applies: 'backend', notes: 'inside the mountRoutes span only: path.join/resolve(<X>, \'data\'[, rest]) and `${<X>}/data[/tail]` → <ctx>.dataDir / path.join(<ctx>.dataDir, rest) / `${<ctx>.dataDir}/tail`; <X> ∈ __dirname HERE ROOT DIR MODULE_DIR dirname(…) fileURLToPath(…)' },
    evidence: '19/58 static (9 daily); 10 touched it at mount, 7 died; 13 mix both paths (N1mix)',
  },
  {
    id: 'N1mix', family: 'NEW', plan: 'RESULT surprise 3', title: 'uses both ctx.dataDir and a folder-relative data/', severity: 'note',
    detect: { static: [] },
    count: (s) => (g(s, 'self_data') > 0 && g(s, 'ctx_dataDir') > 0 ? 1 : 0),
    answer: 'a rename of `ctx.dataDir` would split this module\'s state: move every folder path to `ctx.dataDir` (N1)',
    rewrite: null, evidence: '13/58',
  },
  {
    id: 'N2', family: 'NEW', plan: 'OR14, §4.8 N2', title: 'process.env config/secrets', severity: 'degrades',
    detect: { static: [{ files: 'all', re: ENVREAD, env: ['config', 'other'] }], runtime: ['envRead'] },
    count: (s, p) => [...envKeys(s, p)].filter((k) => !NODE_NOISE.has(k) && !SHELL_PUBLISHED.has(k) && !ROW_W_ENV.has(k) && !LAPTOP_D13.has(k) && !/^XDG_/.test(k)).length,
    answer: 'the portal/spine config channel: the host injects the app\'s keys into that worker\'s env only (stdin config lane, row W) — the read stays `process.env.X`, the SOURCE changes; under an empty channel the read silently defaults (surprise 6); the key is listed in `config-keys.json` (names only, never values)',
    rewrite: { kind: 'manifest', transform: 'config-keys.json', applies: 'both', notes: 'no code change (DESIGN §9.1): the manifest names the keys the portal holds per app' },
    evidence: '27/58, 7 on operator keys; the runtime key set ⊆ static set + Node noise',
  },
  {
    id: 'N2op', family: 'NEW', plan: 'OR14', title: '…of which operator .env keys', severity: 'breaks-in-fleet',
    detect: { static: [{ files: 'all', re: ENVREAD, env: ['operator'] }], runtime: ['envRead'] },
    count: (s, p) => [...envKeys(s, p)].filter((k) => s.operatorKeys?.has(k)).length,
    answer: 'fleet-wide operator secrets are never an app\'s config; each app\'s keys are set per app in the portal',
    rewrite: { kind: 'manifest', transform: 'config-keys.json', applies: 'both', notes: 'listed under `operator` in the manifest' },
    evidence: '7/58 (dashboard sites forms artifacts channels flights blitz-portal); 21 names',
  },
  {
    id: 'N3', family: 'NEW', plan: '§4.8 N3, DESIGN §9.12', title: 'env HOST/PORT/BASE_URL', severity: 'degrades',
    detect: { static: [{ files: 'all', re: ENVREAD, env: ['shell-published'], classify: ({ key }) => (SHELL_PUBLISHED.has(key) ? {} : { skip: true }) }], runtime: ['envRead', 'egress'] },
    count: (s, p) => [...envKeys(s, p)].filter((k) => SHELL_PUBLISHED.has(k)).length,
    answer: '`HOST/PORT/BASE_URL` are published from `ctx.baseUrl` into the worker env (§4.3 Workers) — it runs; a missing default is `http://127.0.0.1:undefined/…`; prefer `ctx.baseUrl`',
    rewrite: null, evidence: '10/58, all daily; 0 `:undefined` egress under the probe',
  },
  {
    id: 'N4', family: 'NEW', plan: '§4.8 N4', title: 'hardcoded /api/global/', severity: 'breaks-in-fleet',
    detect: {
      static: [
        { files: 'backend', re: RX.api_global, scope: 'mountRoutes', answer: '`/api/${ctx.workspace}/` — mechanical rewrite inside `mountRoutes` (rules/rewrite.mjs N4)' },
        { files: 'backend', re: RX.api_global, scope: 'outside-mountRoutes', answer: '`/api/${ctx.workspace}/` — `ctx` is only known inside `mountRoutes`; move the URL there (company ≠ global)' },
        { files: 'frontend', re: RX.api_global, answer: 'the workspace comes from `self()`/`useRoute` in the frontend (company ≠ global); no rewrite' },
      ],
      runtime: ['egress'],
    },
    count: (s) => g(s, 'api_global'),
    answer: '`/api/${ctx.workspace}/` in the backend; in the frontend the workspace from `self()`/`useRoute`',
    rewrite: { kind: 'mechanical', transform: 'N4', applies: 'backend', notes: 'inside the mountRoutes span: template literal → `/api/${<ctx>.workspace}/`; \'…\'/"…" string → a template literal with the same substitution; a string holding a backtick or `${` is left alone and named' },
    evidence: '11/58 (10 daily)',
  },
  {
    id: 'N5', family: 'NEW', plan: '§4.7 row 4, §10 item 8', title: 'peer-app / shell calls over loopback', severity: 'breaks-in-fleet',
    detect: { static: [{ files: 'all', re: RX.localhost_port }], runtime: ['egress'] },
    count: (s, p) => g(s, 'localhost_port') + arr(P(p).egress).filter((e) => LOOPBACK_EGRESS.test(e)).length,
    answer: 'a peer app is another worker on a Unix socket; `1844` is the dev shell and answers 401 without the token — the peer-call primitive `ctx.peer(\'<slug>\')` → `/api/<company>/<slug>` (design, §10 item 8); until it lands, the app\'s own routes',
    rewrite: null, evidence: '22/58 static, 7 daily beacon at mount',
  },
  {
    id: 'N6', family: 'NEW', plan: '§4.8 N6', title: 'shell internals (/_atelier/*, atelier.config.json, ATELIER_ROOT)', severity: 'breaks-in-fleet',
    detect: { static: [{ files: 'all', re: RX.shell_internals, classify: ({ match }) => ({ answer: /\/_atelier\//.test(match[0]) ? '`/_atelier/*` shell routes are gone; `/_atelier/report` is the kit\'s error lane (OR16), nothing else has a successor' : `\`${match[0]}\` is gone with the 1.x shell — no successor` }) }] },
    count: (s) => g(s, 'shell_internals'),
    answer: 'shell internals are gone; each string is named with its line; `/_atelier/report` is the kit\'s error lane (OR16), the rest has no successor',
    rewrite: null, evidence: '8/58',
  },
  {
    id: 'N7', family: 'NEW', plan: '§4.8 N7, R11', title: 'client JS/JSX in subfolders', severity: 'note',
    detect: { walk: 'subfolderClient' },
    count: (s) => arr(s.files?.subfolderClient).length,
    answer: 'not a break: `tailwind.mjs scanSources` and `bundle.mjs walkFiles` are recursive with the 1.x exclusions; column kept for the seed\'s comparability',
    rewrite: null, evidence: '12/58',
  },
  {
    id: 'N8', family: 'NEW', plan: '§4.3 last-good (teardown)', title: "process.on('SIG…') / process.exit in app code", severity: 'degrades',
    detect: { static: [{ files: 'all', re: RX.proc_signal }, { files: 'all', re: RX.proc_exit }], runtime: ['signal', 'exit'] },
    count: (s, p) => g(s, 'proc_signal') + g(s, 'proc_exit') + arr(P(p).signalHandlers).length + (P(p).processExit ? 1 : 0),
    answer: 'return a teardown from `mountRoutes`; the runtime owns SIGTERM (`process.exit` skips the runtime\'s teardown and orphans children; a SIG handler races the runtime\'s)',
    rewrite: null, evidence: '8/58',
  },
  {
    id: 'N9', family: 'NEW', plan: '§4.3 last-good, §10 item 1', title: 'sqlite open without a busy timeout', severity: 'degrades',
    detect: { static: [{ files: 'backend', re: RX.sqlite_open, classify: ({ text }) => (SQLITE_GUARD.test(text) ? { skip: true } : {}) }] },
    count: (s) => s.sqlite?.unguarded || 0,
    answer: 'set a busy timeout on every open (`timeout` option / `PRAGMA busy_timeout`): load-beside overlap → `database is locked`; the supervisor retries the mount once after the old worker exits',
    rewrite: null, evidence: 'flights ≥ 1; count reported',
  },
  {
    id: 'N10', family: 'NEW', plan: 'OR10', title: 'export const meta → module.json', severity: 'note',
    detect: { meta: 'literal' },
    count: (s) => (s.meta?.computed ? 1 : 0),
    answer: '`module.json` `{name, icon, group, primary, color}` is the only meta; `chrome`, `isChrome`, `hidden`, `eager` are dropped and each named; a computed meta cannot be read statically — write module.json by hand',
    rewrite: { kind: 'mechanical', transform: 'module.json', applies: 'frontend', notes: 'rules/meta.mjs: the literal meta → module.json' },
    evidence: '58/58 declared, 58/58 literal, 0 computed',
  },
  {
    id: 'N11', family: 'NEW', plan: 'DESIGN §9.7', title: 'module.json with keys outside the five', severity: 'note',
    detect: { meta: 'module.json' },
    count: (s) => arr(s.existingModuleJson?.dropped).length,
    answer: 'the registrar drops unknown keys; an app is its chat\'s (OR8), company-wide apps are dynos (§12) — there is no visibility switch',
    rewrite: { kind: 'mechanical', transform: 'module.json', applies: 'frontend', notes: 'the key is dropped in the generated/rewritten module.json' },
    evidence: '0 in the 1.x corpus; the agent-contract-2 starter app has it',
  },
  {
    id: 'R1', family: 'runtime', plan: 'RESULT surprise 6', title: 'probe state ≠ mounted', severity: 'breaks-in-fleet',
    detect: { runtime: ['state'] },
    count: (s, p) => (p && p.state && !MOUNTED_STATES.has(p.state) ? 1 : 0),
    answer: 'the failure class and `file:line:col` from the control message (`load-failed` + `classifyWorkerFailure`)',
    rewrite: null, evidence: '7/53 broken at mount, all on N1/D13',
  },
  {
    id: 'R2', family: 'runtime', plan: 'R14', title: 'stays resident (timers, children, sockets after mount)', severity: 'note',
    detect: { runtime: ['resources'] },
    count: (s, p) => (p?.resources && Object.values(p.resources).some((v) => (Array.isArray(v) ? v.length : v) > 0) ? 1 : 0),
    answer: 'stays resident — RLIMIT_DATA is its memory lever; `ctx.suspendable()` when the background work is optional',
    rewrite: null, evidence: '~40/53 resident, ≤ 13 idle-stop candidates',
  },
  {
    id: 'R3', family: 'runtime', plan: '§4.3 teardown', title: 'no teardown / killed at the drain deadline', severity: 'degrades',
    detect: { runtime: ['teardown', 'killed'] },
    count: (s, p) => (p && (p.teardown === false || p.stop?.killed) ? 1 : 0),
    answer: 'return a teardown from `mountRoutes`; children must die inside 2 s',
    rewrite: null, evidence: '43/58 export one; killed count reported',
  },
  {
    id: 'I1', family: 'info', plan: 'seed info', title: 'relative imports in backend', severity: 'note',
    detect: { static: [{ files: 'backend', re: REL_IMPORT }] },
    count: (s) => s.relImportsBackend || 0,
    answer: 'bundled by `bundleBackend`; run-time `HERE`-located files still come from the live folder',
    rewrite: null, evidence: 'seed counts',
  },
  {
    id: 'I2', family: 'info', plan: 'seed info', title: 'internet egress at mount', severity: 'note',
    detect: { runtime: ['egress'] },
    count: (s, p) => arr(P(p).egress).filter((e) => INTERNET_EGRESS.test(e)).length,
    answer: 'egress stays open (P13)',
    rewrite: null, evidence: 'seed counts',
  },
  {
    id: 'I3', family: 'info', plan: 'seed info', title: 'TopBarCenter/eager', severity: 'note',
    detect: { static: [{ files: 'all', re: RX.topbar_eager }], meta: 'eager' },
    count: (s) => g(s, 'topbar_eager') + (s.meta?.eager ? 1 : 0),
    answer: 'dropped in the fleet document',
    rewrite: null, evidence: 'seed counts',
  },
  {
    id: 'I4', family: 'info', plan: 'seed info', title: '@atelier/kit import', severity: 'note',
    detect: { static: [{ files: 'all', re: RX.kit }] },
    count: (s) => (g(s, 'kit') ? 1 : 0),
    answer: 'as the seed', rewrite: null, evidence: 'seed counts',
  },
  {
    id: 'I5', family: 'info', plan: 'seed info', title: 'useRoute', severity: 'note',
    detect: { static: [{ files: 'all', re: RX.use_route }] },
    count: (s) => (g(s, 'use_route') ? 1 : 0),
    answer: 'as the seed', rewrite: null, evidence: 'seed counts',
  },
  {
    id: 'M1', family: 'mobile', plan: '§4.8 mobile', title: '100vh', severity: 'note',
    detect: { static: [{ files: 'frontend', re: MOBILE.vh100 }] },
    count: (s) => s.mobile?.vh100 || 0,
    answer: 'OR5: `100dvh`', rewrite: null, evidence: '10/58 (5 daily) across M1–M4',
  },
  {
    id: 'M2', family: 'mobile', plan: '§4.8 mobile', title: 'h-screen', severity: 'note',
    detect: { static: [{ files: 'frontend', re: MOBILE.h_screen }] },
    count: (s) => s.mobile?.h_screen || 0,
    answer: 'OR5: `h-dvh` / `100dvh`', rewrite: null, evidence: 'seed counts',
  },
  {
    id: 'M3', family: 'mobile', plan: '§4.8 mobile', title: 'fixed+bottom-0 bar', severity: 'note',
    detect: { static: [{ files: 'frontend', re: MOBILE.fixed_bottom }] },
    count: (s) => s.mobile?.fixed_bottom || 0,
    answer: 'OR5: safe-area insets (`env(safe-area-inset-bottom)`)', rewrite: null, evidence: 'seed counts',
  },
  {
    id: 'M4', family: 'mobile', plan: '§4.8 mobile', title: 'sub-16px input', severity: 'note',
    detect: { static: [{ files: 'frontend', re: MOBILE.small_input }] },
    count: (s) => s.mobile?.small_input || 0,
    answer: 'OR5: ≥ 16 px inputs (iOS zooms on focus below that)', rewrite: null, evidence: 'seed counts',
  },
]

export const RULE_BY_ID = Object.fromEntries(RULES.map((r) => [r.id, r]))
export const SEED_IDS = ['D1', 'D2', 'D2w', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13', 'N1', 'N2', 'N2op', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'I1', 'I2', 'I3', 'I4', 'I5', 'M1', 'M2', 'M3', 'M4']
export const NEW_IDS = ['N1mix', 'N9', 'N10', 'N11', 'R1', 'R2', 'R3']
export const SEVERITY_RANK = { 'breaks-in-fleet': 0, degrades: 1, note: 2 }
