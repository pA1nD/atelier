// shell/config.mjs — the shell's configuration (DESIGN §1 `cfg`, §5.5 the ignored-settings log).
// Local mode: `atelier.config.json` (the 1.x reader, discovery.js `loadConfig`) + env overrides
// (`PORT`, `HOST`, `NODE_ENV`, `ATELIER_DEFAULT_CHROME`, `ATELIER_LABEL`, as 1.x). Fleet: env only.
// Settings read locally and IGNORED in the fleet (the fleet value in parentheses) are logged once
// each as `ignored in the fleet: <key>`: port (the shell's own), host (pod IP / loopback), baseUrl
// (the company origin), env (production), defaultChrome (the pinned chrome), label (the company
// name), modules (the registry). Ignored in BOTH modes — 1.x surfaces that do not exist in 2.0,
// logged locally once as `ignored in 2.0: <key>`: hotReload (always on), auth (the gate is the
// portal), revalidateMs, observe (compiled out; the error reporter is always on).
import { loadConfig } from '../discovery.js'

export const FLEET_IGNORED = ['port', 'host', 'baseUrl', 'env', 'defaultChrome', 'label', 'modules']
export const GONE_IN_2 = ['hotReload', 'auth', 'revalidateMs', 'observe']
export const DEFAULT_PORT = 1844
export const DEFAULT_DOMAIN = 'portal.pa1nd.de'
// `csp.fontHosts` (DESIGN §2.3): the fleet serves the chrome's fonts itself (`/_chrome/<digest>/fonts/`, step 7 ship C) —
// its default is `[]`; a local instance runs the chrome FOLDER, and catalyst-chrome's frontend.jsx loads Inter from rsms.me
// there, so local keeps that host. An `atelier.config.json` `csp.fontHosts` overrides either.
export const LOCAL_FONT_HOSTS = ['https://rsms.me']
export const FLEET_FONT_HOSTS = []
export const DEFAULT_FONT_HOSTS = LOCAL_FONT_HOSTS

/**
 * createConfig({ mode, root, config, env }) → { cfg, ignored }
 *   config: the parsed atelier.config.json (default: read from `root`); env: process.env-like
 */
export function createConfig({ mode = 'local', root = null, config, env = process.env } = {}) {
  const c = config ?? (root ? loadConfig(root) : {})
  const ignored = []
  if (mode === 'fleet') for (const k of FLEET_IGNORED) if (c[k] !== undefined) ignored.push(`ignored in the fleet: ${k}`)
  for (const k of GONE_IN_2) if (c[k] !== undefined) ignored.push(`ignored in 2.0: ${k}`)
  const port = Number(env.PORT ?? (mode === 'local' ? c.port : undefined) ?? DEFAULT_PORT)
  const domain = env.ATELIER_DOMAIN ?? DEFAULT_DOMAIN
  const portalOrigin = mode === 'fleet' ? (env.ATELIER_PORTAL_ORIGIN ?? `https://${domain}`) : null
  const cfg = {
    mode, port,
    bind: env.HOST ?? (mode === 'local' ? c.host : undefined) ?? '127.0.0.1',
    nodeEnv: env.NODE_ENV ?? (mode === 'local' ? c.env : undefined) ?? 'production',
    label: env.ATELIER_LABEL ?? (mode === 'local' ? c.label : undefined) ?? null,
    defaultChrome: env.ATELIER_DEFAULT_CHROME ?? (mode === 'local' ? c.defaultChrome : undefined) ?? null,
    domain, portalOrigin,
    csp: { fontHosts: Array.isArray(c.csp?.fontHosts) ? c.csp.fontHosts : (mode === 'fleet' ? FLEET_FONT_HOSTS : LOCAL_FONT_HOSTS) },
    origin: (company) => (mode === 'fleet' ? `https://${company}.${domain}` : `http://localhost:${port}`),
    root,
  }
  return { cfg, ignored }
}
