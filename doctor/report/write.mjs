// doctor/report/write.mjs — the --out layout (DESIGN §5) and the --write applier (§6). Everything the
// doctor writes goes through here; the judged folder is touched only by `applyWrite`, only under --write.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { toCsv, rowsMd, modulesMd } from './table.mjs'

export const MODULE_JSON_KEYS = Object.freeze(['name', 'icon', 'group', 'primary', 'color'])

const json = (o) => JSON.stringify(o, null, 2) + '\n'

/** `<out>/doctor/<module>/{report.json, module.json, config-keys.json, rewrite/<rel>}`. Returns the paths written. */
export function writeModuleOut({ outDir, report, rewrites = [] }) {
  const dir = path.join(outDir, 'doctor', report.module)
  fs.mkdirSync(dir, { recursive: true })
  const written = []
  const put = (rel, body) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); written.push(p) }
  put('report.json', json(report))
  if (report.moduleJson) put('module.json', json(report.moduleJson))
  put('config-keys.json', json(report.configKeys ?? { operator: [], config: [], shell: [], laptop: [] }))
  for (const r of rewrites) if (r.edits?.length && typeof r.text === 'string') put(path.join('rewrite', r.file), r.text)
  return written
}

/** `<out>/doctor/{portability.csv, rows.md, modules.md, summary.json, verdict.txt}`. */
export function writeCorpusOut({ outDir, rows, rules, summary, verdictLine }) {
  const dir = path.join(outDir, 'doctor')
  fs.mkdirSync(dir, { recursive: true })
  const files = {
    'portability.csv': toCsv(rows),
    'rows.md': rowsMd(rows, rules),
    'modules.md': modulesMd(rows, rules),
    'summary.json': json(summary),
    'verdict.txt': verdictLine + '\n',
  }
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body)
  return Object.keys(files).map((n) => path.join(dir, n))
}

export class WriteRefused extends Error {}

/** An existing module.json may be replaced only when its sole change is the N11 key drop (DESIGN §3.4). */
export function canReplaceModuleJson(existingText, generated) {
  let existing
  try { existing = JSON.parse(existingText) } catch { return false }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return false
  const kept = Object.fromEntries(Object.entries(existing).filter(([k]) => MODULE_JSON_KEYS.includes(k)))
  const hasUnknown = Object.keys(existing).length !== Object.keys(kept).length
  return hasUnknown && JSON.stringify(kept) === JSON.stringify(generated)
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/** The files --write would touch, relative to `dir`. */
export function writeTargets({ dir, moduleJson, rewrites = [] }) {
  const targets = rewrites.filter((r) => r.edits?.length && typeof r.text === 'string').map((r) => r.file)
  if (moduleJson) {
    const p = path.join(dir, 'module.json')
    if (!fs.existsSync(p)) targets.push('module.json')
    else if (canReplaceModuleJson(fs.readFileSync(p, 'utf8'), moduleJson)) targets.push('module.json')
  }
  return targets
}

/**
 * Apply the rewrites and module.json INTO the judged folder. Refused (WriteRefused) unless the folder is inside
 * a git work tree and none of the files it would touch has an uncommitted change — every write stays
 * undoable by `git checkout`. A file whose N1 edits are `partial` (rewrite.mjs: other lines of the folder keep
 * a self-pathed data/ — a bridge process on `<app>/data` beside a backend on `ctx.dataDir` is a split state)
 * is refused unless `writePartial` (--write-partial). Returns the files written (relative to `dir`).
 */
export function applyWrite({ dir, moduleJson, rewrites = [], writePartial = false }) {
  const targets = writeTargets({ dir, moduleJson, rewrites })
  if (!targets.length) return []
  if (!writePartial) {
    const partial = rewrites.filter((r) => r.partial && r.edits?.some((e) => e.rule === 'N1'))
    if (partial.length) throw new WriteRefused(`--write refused: the N1 rewrite of ${partial.map((r) => path.join(path.basename(dir), r.file)).join(', ')} is partial — a self-pathed data/ stays at ${partial[0].leftover.join(', ')}; pass --write-partial to apply it anyway`)
  }
  let top
  try { top = git(dir, ['rev-parse', '--show-toplevel']).trim() } catch { top = '' }
  if (!top) throw new WriteRefused(`--write refused: ${dir} is not inside a git work tree`)
  const dirty = git(dir, ['status', '--porcelain', '--', ...targets]).split('\n').filter(Boolean)   // `XY path` — the first column may be a space
  if (dirty.length) throw new WriteRefused(`--write refused: uncommitted changes in ${dir}: ${dirty.map((l) => l.slice(3)).join(', ')}`)
  const written = []
  for (const r of rewrites) {
    if (!targets.includes(r.file)) continue
    fs.writeFileSync(path.join(dir, r.file), r.text)
    written.push(r.file)
  }
  if (targets.includes('module.json')) { fs.writeFileSync(path.join(dir, 'module.json'), json(moduleJson)); written.push('module.json') }
  return written
}

/** `--out` must not lie inside any judged folder (DESIGN §6). */
export function outInside(outDir, dirs) {
  const o = path.resolve(outDir)
  return dirs.map((d) => path.resolve(d)).find((d) => o === d || o.startsWith(d + path.sep)) ?? null
}
