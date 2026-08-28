// host/supervisor/discovery.mjs — /work/apps scan by module.json (PLAN OR10, DESIGN §6.1).
// Pure over a node-fs-shaped object (`readdirSync`, `readFileSync`, `existsSync`) so a test
// drives it with a fake; the default is node's fs. Never writes.
//
// Rules: a folder is an app iff `module.json` parses; a name not matching SLUG_RE is refused
// (`bad-slug`); `_*`, `.*`, `-*` and space-prefixed names are ignored; a folder holding
// `CLAIM-REFUSED.txt` is skipped until the file is deleted; meta = allowMeta(json) — unknown keys
// (`visibility` included) are dropped silently; a module.json that is missing, invalid or has no
// `name` is a build-class problem with `file:line:col` + hint (DESIGN §6.3).
import nodeFs from 'node:fs'
import path from 'node:path'
import { SLUG_RE, allowMeta } from '../../protocol/index.js'

export const IGNORED_NAME_RE = /^[._\- ]/

/** @typedef {{file:'module.json', line:number, col:number, message:string, hint:string}} ModuleJsonProblem */

// jsonErrorPosition(src, message) → {line, col} from V8's JSON.parse message: `(line L column C)` /
// `at position N` when present; else the `Unexpected token 'x', ..."<10 chars><token>…"` snippet
// (10 chars of context precede the token) or, on a short input, the token's last occurrence.
export function jsonErrorPosition(src, message) {
  const toLineCol = (pos) => { const before = src.slice(0, Math.max(0, Math.min(pos, src.length))); return { line: before.split('\n').length, col: before.length - before.lastIndexOf('\n') } }
  const lc = /line (\d+) column (\d+)/.exec(message)
  if (lc) return { line: +lc[1], col: +lc[2] }
  const pos = /position (\d+)/.exec(message)
  if (pos) return toLineCol(+pos[1])
  if (/Unexpected end of JSON input/.test(message)) return toLineCol(src.length)
  const tok = /Unexpected token '(.)'/s.exec(message)?.[1]
  const snip = /, (\.\.\.)?"(.*)" is not valid JSON$/s.exec(message)
  if (snip) {
    const i = src.indexOf(snip[2])
    if (snip[1] && i >= 0) return toLineCol(i + 10)
  }
  if (tok) { const i = src.lastIndexOf(tok); if (i >= 0) return toLineCol(i) }
  return { line: 1, col: 1 }
}

// checkModuleJson(dir, fs) → {ok:true, json, meta, requested, dropped, invalid} | {ok:false, error: ModuleJsonProblem}
export function checkModuleJson(dir, fs = nodeFs) {
  const file = path.join(dir, 'module.json')
  let src
  try { src = fs.readFileSync(file, 'utf8') } catch {
    return { ok: false, error: { file: 'module.json', line: 1, col: 1, message: 'module.json missing — this folder is not an app yet', hint: `write ${file} with {"name": "...", "icon": "..."}` } }
  }
  let json
  try { json = JSON.parse(src) } catch (e) {
    const { line, col } = jsonErrorPosition(src, e.message)
    return { ok: false, error: { file: 'module.json', line, col, message: `invalid JSON: ${e.message.split('\n')[0]}`, hint: 'fix the JSON (quotes, commas, braces)' } }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, error: { file: 'module.json', line: 1, col: 1, message: 'module.json must be a JSON object', hint: 'write {"name": "<app name>"}' } }
  }
  if (typeof json.name !== 'string' || !json.name.trim()) {
    const lines = src.split('\n')
    const i = lines.findIndex((l) => l.includes('"name"'))
    const loc = i < 0 ? { line: 1, col: 1 } : { line: i + 1, col: lines[i].indexOf('"name"') + 1 }
    return { ok: false, error: { file: 'module.json', ...loc, message: 'missing or invalid "name" (non-empty string required)', hint: 'add "name": "<app name>" to module.json' } }
  }
  const m = allowMeta(json)
  return { ok: true, json, meta: m.meta, requested: m.requested, dropped: m.dropped, invalid: m.invalid }
}

/**
 * discover(appsDir, fs) → {apps, refused, skipped, problems, unreadable}
 *   unreadable: true when the apps root itself could not be listed (EACCES/ENOENT/not mounted yet) —
 *               the caller must not treat the empty `apps` as "every folder is gone" (reconcile(null))
 *   apps:     [{slug, dir, meta, requested, dropped, invalid}]   claimable rows (registrar.claim input)
 *   refused:  [{slug, dir, code:'bad-slug', error}]              the registrar writes CLAIM-REFUSED.txt
 *   skipped:  [{name, dir, reason:'ignored-name'|'claim-refused'|'not-a-dir'|'no-module-json'}]
 *   problems: [{slug, dir, error: ModuleJsonProblem}]             module.json present but invalid → build report
 */
export function discover(appsDir, fs = nodeFs, { links = false } = {}) {
  const out = { apps: [], refused: [], skipped: [], problems: [], unreadable: false }
  let ents
  try { ents = fs.readdirSync(appsDir, { withFileTypes: true }) } catch { out.unreadable = true; return out }
  // `links` (ATELIER_APPS_LINKS=1, local mode only — DESIGN §8 H1 of shell/): a symlink to a directory
  // counts as a folder; the fleet keeps `not-a-dir` for a link the agent planted under /work/apps
  const isDir = (ent, dir) => ent.isDirectory() || (links && ent.isSymbolicLink?.() && (() => { try { return fs.statSync(dir).isDirectory() } catch { return false } })())
  for (const ent of ents) {
    const name = ent.name, dir = path.join(appsDir, name)
    if (!isDir(ent, dir)) { out.skipped.push({ name, dir, reason: 'not-a-dir' }); continue }
    if (IGNORED_NAME_RE.test(name)) { out.skipped.push({ name, dir, reason: 'ignored-name' }); continue }
    if (fs.existsSync(path.join(dir, 'CLAIM-REFUSED.txt'))) { out.skipped.push({ name, dir, reason: 'claim-refused' }); continue }
    if (!fs.existsSync(path.join(dir, 'module.json'))) { out.skipped.push({ name, dir, reason: 'no-module-json' }); continue }
    if (!SLUG_RE.test(name)) { out.refused.push({ slug: name, dir, code: 'bad-slug', error: `folder name '${name}' is not a slug (one DNS label: [a-z][a-z0-9-]*, no leading/trailing -)` }); continue }
    const c = checkModuleJson(dir, fs)
    if (!c.ok) { out.problems.push({ slug: name, dir, error: c.error }); continue }
    out.apps.push({ slug: name, dir, meta: c.meta, requested: c.requested, dropped: c.dropped, invalid: c.invalid })
  }
  return out
}
