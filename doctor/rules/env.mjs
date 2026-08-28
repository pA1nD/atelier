// doctor/rules/env.mjs — process.env key classification (PLAN OR14, DESIGN §2 N2/N2op/N3/D13, §9.1).
//
//   classifyEnv(key, operatorKeys)  → 'operator' | 'shell-published' | 'node' | 'laptop' | 'config' | 'other'
//   scanEnvReads(text)              → [{key, index, line, col}] for every `process.env.X` / `process.env['X']`
//   readEnvKeyNames(src)            → Set of the KEY NAMES in a `.env`-shaped text (values never read past `=`)
//   configKeysOf(keysByClass)       → {operator, config, shell, laptop} — the manifest (names only, sorted)
//
// Classes and what the rules do with them:
//   operator        a name from the operator's `.env` (--env-keys) → N2op, breaks-in-fleet
//   shell-published HOST PORT BASE_URL (N3: published from ctx.baseUrl into the worker env, row W) and the
//                   other row-W keys the host sets (APP_ID, ATELIER_WORKER, NODE_ENV is node) — never N2
//   node            Node's own reads + terminal noise (NODE_NOISE, RESULT surprise 7) — never a finding
//   laptop          the laptop's session env: HOME PWD USER SHELL LOGNAME XPC_SERVICE_NAME (D13 — the seed's set
//                   minus TMPDIR, which is row W; PATH LANG LC_ALL XDG_* are laptop too but the seed excluded
//                   them from D13, so they stay out of the D13 count: LAPTOP_D13 vs LAPTOP)
//   config          looks like app config by suffix (_KEY _TOKEN _SECRET … _PORT _HOST _DIR _PATH _MODEL _BIN)
//   other           any other key — app config from the portal's point of view (N2, in the manifest as config)
import { ENVREAD, NODE_NOISE, SHELL_PUBLISHED, ROW_W_ENV, LAPTOP, LAPTOP_D13, CONFIG_SUFFIX_RE } from './catalogue.mjs'
import { lineColOf } from './scope.mjs'

export function classifyEnv(key, operatorKeys = new Set()) {
  if (operatorKeys.has(key)) return 'operator'
  if (SHELL_PUBLISHED.has(key) || ROW_W_ENV.has(key)) return 'shell-published'
  if (NODE_NOISE.has(key)) return 'node'
  if (LAPTOP.has(key) || /^XDG_/.test(key)) return 'laptop'
  if (CONFIG_SUFFIX_RE.test(key)) return 'config'
  return 'other'
}

export const isN2Key = (key, operatorKeys) => ['operator', 'config', 'other'].includes(classifyEnv(key, operatorKeys))
export const isN3Key = (key) => SHELL_PUBLISHED.has(key)
export const isD13Key = (key) => LAPTOP_D13.has(key)

export function scanEnvReads(text) {
  const out = []
  const re = new RegExp(ENVREAD.source, 'g')
  let m
  while ((m = re.exec(text))) {
    const key = m[1] || m[2]
    out.push({ key, index: m.index, ...lineColOf(text, m.index) })
  }
  return out
}

export function readEnvKeyNames(src) {
  return new Set([...src.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1]))
}

// configKeysOf(env, operatorKeys) — env: {KEY: class} (static) plus optional runtime keys → the manifest
export function configKeysOf(env, operatorKeys = new Set(), runtimeKeys = []) {
  const keys = new Set([...Object.keys(env), ...runtimeKeys])
  const out = { operator: [], config: [], shell: [], laptop: [] }
  for (const k of [...keys].sort()) {
    const c = classifyEnv(k, operatorKeys)
    if (c === 'operator') out.operator.push(k)
    else if (c === 'config' || c === 'other') out.config.push(k)
    else if (c === 'shell-published') { if (SHELL_PUBLISHED.has(k)) out.shell.push(k) }
    else if (c === 'laptop') out.laptop.push(k)
  }
  return out
}
