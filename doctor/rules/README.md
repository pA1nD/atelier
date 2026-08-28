# `doctor/rules/` — lane A: the static rules and the mechanical rewrites

Pure over file texts (DESIGN §2): `(files) → findings`, no process, no network; the only filesystem access is
the 1.x walk in `walk.mjs`, which never enters `data/`, `node_modules/` or a `[._-]`-prefixed name.

| file | role |
|---|---|
| `catalogue.mjs` | the rule catalogue as DATA — `RULES: Rule[]`, one entry per id (D1–D13, D2w, N1–N11, N1mix, N2op, R1–R3, I1–I5, M1–M4): `detect.static[]` (files, regex, scope, env class, `classify`), `count(s, probe, tw)` with the seed's semantics, the first-class 2.0 `answer`, `rewrite`, `evidence`. Also the seed's regexes (`RX`, `SPAWN`, `ENVREAD`, `CTXMOD`, `REL_IMPORT`, `MOBILE`), `IMAGE_BINS`, `NODE_NOISE`, `SHELL_PUBLISHED`/`SHELL_KEYS`, `LAPTOP_D13`/`LAPTOP_KEYS`, `META_KEYS`, `DROPPED_META_KEYS` |
| `walk.mjs` | `listModules(corpusDir, {daily})`, `moduleEntry(dir)`, `isModuleDir`, `walkJsxFiles` (1.x verbatim: skips `node_modules`, `data`, `[._-]*`, `backend.js`; `.jsx/.js`), `walkSourceFiles` (+ `backend.js`, `.mjs/.cjs`), `subfolderClientFiles` |
| `scope.mjs` | `scan(text)` → a per-character mask (code / string / template / comment / regex) and the spans; `findMountRoutes(text)` → the brace-balanced `mountRoutes(<router>, <ctx>) { … }` span with the ctx parameter's name (every form: method shorthand, `async`, `mountRoutes: (r, c) => {`, `mountRoutes: function`); `splitArgs`, `matchBrace`, `lineColOf` |
| `meta.mjs` | `extractMetaStatically` (1.x server.js, verbatim), `metaOf`, `moduleJsonOf` → `{name, icon, group, primary, color}` + `dropped:[{key, rule, reason}]`, `serializeModuleJson`, `checkExistingModuleJson` (the host's `discovery.checkModuleJson`), `readMeta({dir})` |
| `env.mjs` | `classifyEnv(key, operatorKeys)` → operator · shell-published · node · laptop · config · other; `scanEnvReads`, `readEnvKeyNames` (a `.env` text → key NAMES, values never read), `configKeysOf` → the `config-keys.json` manifest |
| `static.mjs` | `analyzeModule(entry, {operatorKeys})` / `analyzeFiles(id, files)` → the StaticResult; `detectInText(text, {rule, kind})` for one rule; `cellsOf(s, probe, tw)`; `runStatic({id, dir, envKeys})` (lane C's entry, adds static-only `cells`) |
| `rewrite.mjs` | `rewriteN1`, `rewriteN4`, `rewriteBackend(text)` → `{text, edits:[{rule, line, from, to}], skipped:[{rule, line, reason}]}`; `rewriteModule({dir})` (lane C's entry) |

## Findings

`{rule, severity, file, line, col, evidence, excerpt, answer, scope?, key?, rewrite?:{to}}` — `evidence` and
`excerpt` are the same trimmed source line (the brief names the first, lane C reads the second). `scope` is
`mountRoutes` / `outside-mountRoutes` on the N1/N4 backend findings; `key` is the env key or the dropped
meta key; `rewrite.to` is set when `rewrite.mjs` produced an edit on that line.

Severity varies per finding where DESIGN says so: D6 is `breaks-in-fleet` on a `.listen(` line, D7 `degrades`
when a `topic:` is passed, D12 `note` for an `IMAGE_BINS` binary (SQL verbs are skipped), D13 `degrades` for
`HOME`/`os.homedir()` reads, N1 `degrades` in a frontend, N10 `degrades` for a computed meta. The D2 answer is
the plan sentence ("expects an operator reverse proxy that the fleet does not have — here is the first-class
equivalent: …") followed by the equivalent chosen from the file (`ws` → D2w's line, `text/event-stream` →
streamed HTTP, else the router) and the fixed address on the line.

## Counts (`rule.count(s, probe, tw)`)

The seed's `report.mjs` lambdas, so the 58-module numbers reproduce (`rules.test.js` pins them under
`ATELIER_CORPUS`): N1 19, N1mix 13, N2 27, N2op 7 (with `ATELIER_ENV_KEYS`), N3 10, N4 11, N5 17 static (the
seed's 22 adds the probe's loopback egress), N6 8, N7 12, N8 8, D2 8, D5 52, D6 13, D7 45, D12 27 static, D13 28,
meta literal 58/58. Two deliberate differences from the seed: N7 counts the subfolder client FILES (the seed
counted Tailwind candidates; the module count is the same 12), and N6 excludes the 2.0 host's own
`/_atelier/health` and `/_atelier/report`.

`probe` is lane B's `report.json.runtime` object (DESIGN §4) — `null` or `{}` when there was no probe. The
fields the counts read, with the string conventions the probe must use:
`state`, `listens[]`, `spawns[]` (binary names), `envReads[]` (keys), `writesOutside[]` (paths; the app folder
abbreviated `<app>`, the scratch home `~`), `selfData[]`, `egress[]` (URLs — loopback = N5, internet = I2),
`signalHandlers[]`, `processExit` (truthy), `resources` (object; any non-empty value = R2), `teardown`
(boolean), `stop.killed`. `tw` is unused by the rules.

## Rewrites

Inside the `mountRoutes` span only (DESIGN §9.6/§9.7), using the span's own ctx parameter name:
- N1: `path.join|resolve(<X>, 'data')` → `<ctx>.dataDir`; `…(<X>, 'data', rest…)` → `path.join(<ctx>.dataDir, rest…)`;
  `…(<X>, 'data/tail')` → `path.join(<ctx>.dataDir, 'tail')`; `` `${<X>}/data` `` → `<ctx>.dataDir`;
  `` `${<X>}/data/tail` `` → `` `${<ctx>.dataDir}/tail` ``. `<X>` ∈ `__dirname HERE ROOT DIR MODULE_DIR dirname(…) path.dirname(…) fileURLToPath(…)`.
- N4: in a template literal `/api/global/` → `/api/${<ctx>.workspace}/`; a `'…'`/`"…"` string becomes a template
  literal with the substitution; a string holding a backtick or `${` is left alone and listed in `skipped`.
Comments and (for N1) strings are never rewritten. A span without a ctx parameter rewrites nothing
(`skipped` names the line). N4 line numbers are taken after N1 ran; N1 never changes the line count.

## Cross-lane

Lane C (`report/lanes.mjs`) imports `RULES`/`NODE_NOISE`/`IMAGE_BINS`/`SHELL_KEYS`/`LAPTOP_KEYS`, `listModules`,
`runStatic`, `readMeta`, `classifyEnv`, `rewriteModule` — all real here. Nothing from lane B is imported; the
probe record is an input to `count()` only (the contract above). `meta.mjs` imports the host's
`host/supervisor/discovery.mjs` (`checkModuleJson`) — real code, not a stub.

## Tests

`node --test doctor/test/rules.test.js doctor/test/rewrite.test.js doctor/test/meta.test.js doctor/test/walk.test.js`
— every id positive + negative, the severity variants, the scope balancer (comments with apostrophes, regex
literals, template holes, every `mountRoutes` form), N1/N4 byte-exact, module.json byte-equal to the seed's
58 outputs minus their `visibility` line, the 1.x walk exclusions with an unreadable `data/`, the 12
subfolder-JSX shapes, the count contract with a synthetic probe record. `ATELIER_CORPUS=<dir>` (and
`ATELIER_ENV_KEYS=<.env>`) turns on the 58-module baseline.
