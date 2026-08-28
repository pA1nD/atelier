// shell/local/discover.mjs — 1.x discovery over the instance folder (DESIGN §5.2, §5.3 steps 1–3).
//
// The rules are `discovery.js`, unchanged: a module is a folder with `frontend.jsx` or `backend.js`;
// root folders are the `global` workspace, `$<ws>/` folders are workspaces; `atelier.config.json`'s
// `modules` filter (allow/deny, `{workspace}` blocks, path entries) applies exactly as in server.js's
// host-mode `getModules`. Meta is the literal `export const meta` (meta.mjs). What is new for 2.0:
// every id and workspace must be one DNS label (SLUG_RE — a company id and an app slug on the wire);
// a folder that is not is refused with the doctor's wording; the chrome is elected as 1.x did
// (`defaultChrome` setting, else alphabetical among global modules whose literal meta has
// `isChrome: true`) and the host needs a `module.json` per app (OR10) — generated once from the
// literal meta when absent.
import nodeFs from 'node:fs'
import path from 'node:path'
import {
  RESERVED_NAMES, GLOBAL_WORKSPACE, isSpecialDir, isWorkspaceDir, workspaceName, CONFIG_FILENAME,
  loadModuleConfig, shouldIncludeModule, collectConfigPaths, resolvePathEntry,
} from '../../discovery.js'
import { SLUG_RE, META_ALLOW } from '../../protocol/index.js'
import { extractMetaStatically } from './meta.mjs'

export const MODULE_JSON = 'module.json'
export const notASlug = (name) => `'${name}' is not a slug — rename the folder`

// readModuleAt(dir, name, workspace, fs) → a row or null (1.x readModuleAt + the literal meta)
export function readModuleAt(dir, name, workspace, fs = nodeFs) {
  if (isSpecialDir(name)) return null
  if (RESERVED_NAMES.has(name)) return null
  let stat
  try { stat = fs.statSync(dir) } catch { return null }
  if (!stat.isDirectory()) return null
  const hasFrontend = fs.existsSync(path.join(dir, 'frontend.jsx'))
  const hasBackend = fs.existsSync(path.join(dir, 'backend.js'))
  if (!hasFrontend && !hasBackend) return null
  let meta = {}, metaError = null
  if (hasFrontend) {
    let src = ''
    try { src = fs.readFileSync(path.join(dir, 'frontend.jsx'), 'utf8') } catch {}
    const r = extractMetaStatically(src)
    meta = r.meta ?? {}
    metaError = r.error ?? null
  }
  return { workspace, id: name, qid: `${workspace}/${name}`, dir, hasFrontend, hasBackend, meta, metaError, isChrome: meta.isChrome === true }
}

/**
 * discover(root, { fs, log, defaultChrome }) → { modules, chrome, refused }
 *   modules:  rows accepted for staging, sorted by qid (chromes included — the chrome is staged as an
 *             app too so its backend answers, DESIGN §8 "the chrome's backend")
 *   chrome:   the elected chrome row (global, isChrome) or null
 *   refused:  [{qid, dir, reason}] — an id or workspace that is not one DNS label (never mounted)
 */
export function discover(root, { fs = nodeFs, log = () => {}, defaultChrome = null } = {}) {
  const found = []
  let names = []
  try { names = fs.readdirSync(root) } catch {}
  for (const name of names) {
    if (name.startsWith('$') && !isWorkspaceDir(name) && /^\$[a-zA-Z0-9]/.test(name)) { log(`! ${name}/ is not a valid workspace dir (reserved name or invalid characters) — skipping`); continue }
    if (isWorkspaceDir(name)) {
      const ws = workspaceName(name)
      const wsDir = path.join(root, name)
      let subs = []
      try { subs = fs.readdirSync(wsDir) } catch { continue }
      for (const sub of subs) { const m = readModuleAt(path.join(wsDir, sub), sub, ws, fs); if (m) found.push(m) }
      continue
    }
    const m = readModuleAt(path.join(root, name), name, GLOBAL_WORKSPACE, fs)
    if (m) found.push(m)
  }
  found.sort((a, b) => a.qid.localeCompare(b.qid))

  // the config filter + path entries (server.js getModules, host mode)
  const parsed = loadModuleConfig(root)
  const filtered = found.filter((m) => shouldIncludeModule(parsed, m, { globalWorkspace: GLOBAL_WORKSPACE }))
  const seen = new Set(filtered.map((m) => m.qid))
  for (const entry of collectConfigPaths(parsed, { globalWorkspace: GLOBAL_WORKSPACE })) {
    const abs = resolvePathEntry(entry.path, root)
    const m = abs ? readModuleAt(abs, entry.id || path.basename(abs), entry.workspace, fs) : null
    if (!m) { log(`! ${CONFIG_FILENAME}: path '${entry.path}' is not a module dir (no frontend.jsx or backend.js)`); continue }
    if (seen.has(m.qid)) continue
    seen.add(m.qid); filtered.push(m)
  }

  // 2.0: one DNS label per id and per workspace (company)
  const modules = [], refused = []
  for (const m of filtered) {
    if (!SLUG_RE.test(m.id)) { refused.push({ qid: m.qid, dir: m.dir, reason: notASlug(m.id) }); continue }
    if (!SLUG_RE.test(m.workspace)) { refused.push({ qid: m.qid, dir: m.dir, reason: notASlug(`$${m.workspace}`) }); continue }
    if (m.metaError) log(`! ${m.qid}: meta is not a literal (${m.metaError}) — reading it as {}`)
    modules.push(m)
  }
  return { modules, chrome: electChrome(modules, defaultChrome, log), refused }
}

// electChrome(modules, defaultChrome, log) → the 1.x resolveDefaultChromeQid over rows: the setting
// when it names a mounted global chrome (by qid, or by the basename of a path), else the first by qid
export function electChrome(modules, defaultChrome = null, log = () => {}) {
  const chromes = modules.filter((m) => m.isChrome && m.workspace === GLOBAL_WORKSPACE).sort((a, b) => a.qid.localeCompare(b.qid))
  if (defaultChrome) {
    const wantId = path.basename(String(defaultChrome))
    const hit = chromes.find((m) => m.qid === defaultChrome || m.qid === `${GLOBAL_WORKSPACE}/${wantId}`)
    if (hit) return hit
    log(`! config defaultChrome '${defaultChrome}' is not a mounted chrome module — falling back to discovery`)
  }
  return chromes[0] ?? null
}

// moduleJsonFromMeta(row) → {name, icon?, group?, primary?, color?} — META_ALLOW keys of the literal
// meta that are set; `name` defaults to the folder name (the host requires a non-empty name)
export function moduleJsonFromMeta(row) {
  const out = {}
  for (const k of META_ALLOW) if (row.meta?.[k] !== undefined) out[k] = row.meta[k]
  if (typeof out.name !== 'string' || !out.name.trim()) out.name = row.id
  return out
}

/**
 * ensureModuleJson(row, { fs, log }) → { json, wrote } — present: read as is (never rewritten);
 * absent: written next to the module's files from the literal meta, mode 0644, one log line.
 */
export function ensureModuleJson(row, { fs = nodeFs, log = () => {} } = {}) {
  const file = path.join(row.dir, MODULE_JSON)
  if (fs.existsSync(file)) {
    let json = null
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    return { json, wrote: false }
  }
  const json = moduleJsonFromMeta(row)
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', { mode: 0o644 })
  log(`wrote ${file} from the literal meta`)
  return { json, wrote: true }
}
