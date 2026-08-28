// doctor/rules/walk.mjs — the corpus listing and the 1.x file walks (seed common.mjs, ported).
//
//   isModuleDir(dir)             a folder with frontend.jsx, backend.js or module.json
//   listModules(corpusDir, opts) the seed's listModules: every child whose name starts alphanumeric
//                                and which has frontend.jsx or backend.js (or module.json); sorted by
//                                name; `opts.daily` (a Set of ids) stamps `daily` — lane C's list
//   walkJsxFiles(dir)            1.x walkJsxFiles verbatim: skips `node_modules`, `data`, every
//                                `[._-]`-prefixed name (file or folder), `backend.js`; `.jsx`/`.js` only —
//                                the client-reachable files (N7 counts the ones outside the top level)
//   walkSourceFiles(dir)         the same exclusions but INCLUDING backend.js and `.mjs`/`.cjs` — every
//                                file the rules read
//
// A skipped directory is never entered (`data/` may hold 7.5 GB; `node_modules/` a native build): the
// exclusion is by NAME before readdir, so a planted unreadable file under data/ is never opened.
import fs from 'node:fs'
import path from 'node:path'

const SKIP = new Set(['node_modules', 'data'])
const PRIVATE = /^[._-]/

export function isModuleDir(dir) {
  return ['frontend.jsx', 'backend.js', 'module.json'].some((f) => fs.existsSync(path.join(dir, f)))
}

export function listModules(corpusDir, { daily = new Set() } = {}) {
  return fs.readdirSync(corpusDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^[a-zA-Z0-9]/.test(e.name))
    .map((e) => moduleEntry(path.join(corpusDir, e.name), daily))
    .filter((m) => m.hasFrontend || m.hasBackend || m.hasModuleJson)
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function moduleEntry(dir, daily = new Set()) {
  const id = path.basename(dir)
  return {
    id, dir,
    hasFrontend: fs.existsSync(path.join(dir, 'frontend.jsx')),
    hasBackend: fs.existsSync(path.join(dir, 'backend.js')),
    hasModuleJson: fs.existsSync(path.join(dir, 'module.json')),
    daily: daily.has(id),
  }
}

function walk(dir, accept) {
  const out = []
  const rec = (d) => {
    let names
    try { names = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const ent of names) {
      if (PRIVATE.test(ent.name) || SKIP.has(ent.name)) continue
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) { rec(p); continue }
      if (accept(ent.name)) out.push(p)
    }
  }
  rec(dir)
  return out
}

export function walkJsxFiles(dir) {
  return walk(dir, (name) => name !== 'backend.js' && /\.(jsx|js)$/.test(name))
}

export function walkSourceFiles(dir) {
  return walk(dir, (name) => /\.(jsx|js|mjs|cjs)$/.test(name))
}

// subfolderClientFiles(dir, clientFiles?) → the client files outside the top level, relative (N7)
export function subfolderClientFiles(dir, clientFiles = walkJsxFiles(dir)) {
  return clientFiles.filter((f) => path.dirname(f) !== dir).map((f) => path.relative(dir, f))
}
