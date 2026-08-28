// shell/local/settings.mjs — the instance settings of `npx atelier` (DESIGN §5.2, §5.5): system
// defaults ← atelier.config.json ← env, as 1.x resolved them, plus the `--port=` flag; and the two
// ignored-settings lists, printed once at start.
export const DEFAULT_PORT = 1844
// honoured here, ignored in the fleet (the fleet value is the company's: §5.5)
export const FLEET_IGNORED = ['port', 'host', 'baseUrl', 'env', 'defaultChrome', 'label', 'modules']
// 1.x surfaces that do not exist in 2.0 — ignored in both modes
export const GONE_IN_2 = ['hotReload', 'auth', 'revalidateMs', 'observe']

const envOr = (env, config, envKey, configKey, fallback) => {
  const e = env[envKey]
  if (e != null && e !== '') return e
  if (config[configKey] != null) return config[configKey]
  return fallback
}

/** settings(config, env, flags) → { port, bind, baseUrl, nodeEnv, label, defaultChrome } */
export function settings(config = {}, env = {}, flags = {}) {
  const port = Number(flags.port ?? envOr(env, config, 'PORT', 'port', DEFAULT_PORT))
  const bind = String(envOr(env, config, 'HOST', 'host', '127.0.0.1'))
  return {
    port, bind,
    baseUrl: String(envOr(env, config, 'BASE_URL', 'baseUrl', `http://localhost:${port}`)),
    nodeEnv: String(envOr(env, config, 'NODE_ENV', 'env', 'production')),
    label: envOr(env, config, 'ATELIER_LABEL', 'label', null),
    defaultChrome: envOr(env, config, 'ATELIER_DEFAULT_CHROME', 'defaultChrome', null),
  }
}

/** ignoredSettings(config) → the lines to print once (only keys the config actually has) */
export function ignoredSettings(config = {}) {
  const out = []
  const fleet = FLEET_IGNORED.filter((k) => config[k] !== undefined)
  if (fleet.length) out.push(`settings honoured here, ignored in the fleet: ${fleet.join(', ')}`)
  for (const k of GONE_IN_2) if (config[k] !== undefined) out.push(`ignored in 2.0: ${k}`)
  return out
}

/** parseFlags(argv) → { port?, open } | { error } — `--port=N`, `--open` */
export function parseFlags(argv = []) {
  const out = { open: false }
  for (const a of argv) {
    const m = /^--port=(\d+)$/.exec(a)
    if (m) { out.port = Number(m[1]); continue }
    if (a === '--open') { out.open = true; continue }
    return { error: `unknown flag ${a} (usage: atelier [--port=N] [--open])` }
  }
  return out
}
