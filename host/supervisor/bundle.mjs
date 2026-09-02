// host/supervisor/bundle.mjs — esbuild for one app (PLAN §4.3 "Last-good", DESIGN §6.1, §6.3).
//
//   bundleBackend   the snapshot: `backend.js` bundled with `packages:'external'`, first-party
//                   `import.meta.url` rewritten to the SOURCE file URL (createRequire and HERE
//                   resolve from the app folder), target node24, esm, + source map. Every disk
//                   read happens in THIS process (stdin entry + onResolve/onLoad plugin): esbuild's
//                   Go service inherits the host's groups at its first spawn, so it must never
//                   stat inside a `1000:appgid 2750` app folder itself (§6.2 group rule).
//   transformFrontend  1.x build.js `getJsx` per file: classic JSX (`React.createElement` /
//                   `React.Fragment`, the global React — never `import React`), es2020, esm;
//                   `.jsx` → `.js` siblings; relative import specifiers carry `?rev=N` so a new
//                   revision re-fetches the whole first-party graph (1.x `?v=`, DESIGN §4.3
//                   `?rev=N`); an extensionless `./x` / a `./x.jsx` / a folder import is rewritten
//                   to the served `.js` path (servedSpecifier, as the 1.x bundler resolved them);
//                   a relative import that resolves to nothing is a build failure (the
//                   half-written multi-file save).
//   classify        the failure classes → {file, line, col, message, hint}; `formatHint` prints
//                   `file:line:col message — hint` (DESIGN §6.3, seed agent-contract-1).
import nodeFs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

export const SERVE_DENY_RE = /^[._-]/   // 1.x resolveAssetSource + walkJsxFiles: private by name
const SKIP_DIRS = new Set(['node_modules', 'data'])

// walkFiles(dir, {exts, fs}) → [{abs, rel}] with 1.x's walkJsxFiles exclusions (node_modules, data,
// `[._-]`-prefixed names, backend.js). `exts` = extensions without the dot.
export function walkFiles(dir, { exts, fs = nodeFs } = {}) {
  const out = []
  const walk = (d, rel) => {
    let ents
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))   // name order, whatever the filesystem returns: the Tailwind scan is deterministic (a chrome digest must not depend on it)
    for (const ent of ents) {
      if (SERVE_DENY_RE.test(ent.name) || SKIP_DIRS.has(ent.name)) continue
      const abs = path.join(d, ent.name), r = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) { walk(abs, r); continue }
      if (!ent.isFile()) continue
      if (ent.name === 'backend.js') continue
      const ext = path.extname(ent.name).slice(1)
      if (!exts || exts.includes(ext)) out.push({ abs, rel: r })
    }
  }
  walk(dir, '')
  return out
}

// ---------------------------------------------------------------------------------------------
// classification

export const formatHint = (e) => `${e.file}:${e.line}:${e.col} ${e.message} — ${e.hint}`

const RELATIVE_RE = /Could not resolve "(\.{1,2}\/[^"]+)"/
const BARE_RE = /Could not resolve "([^"]+)"/
function jsxHint(text, file) {
  if (/Unexpected end of file/.test(text)) return 'close the open JSX element / brace before the end of the file'
  if (/Expected .* but found/.test(text)) return `fix the syntax at that position (${text})`
  const rel = RELATIVE_RE.exec(text)
  if (rel) return `create ${rel[1]} next to ${file} (a multi-file save: write the imported file, then re-save) or fix the import path`
  const bare = BARE_RE.exec(text)
  if (bare) return `run npm install ${bare[1]} in the app folder, then re-save`
  return 'fix the syntax at that position'
}
function cssHint(text) {
  if (/Expected "}"/.test(text) || /Unexpected end of file|unclosed/i.test(text)) return 'close the rule with } (an unclosed brace would be silently repaired by the browser — treated as a build failure)'
  return `fix the CSS at that position (${text})`
}
function backendHint(text) {
  const rel = RELATIVE_RE.exec(text)
  if (rel) return `create ${rel[1]} next to backend.js (a multi-file save: write the imported file, then re-save) or fix the import path`
  if (/Unexpected end of file/.test(text)) return 'close the open brace / parenthesis before the end of the file'
  return `fix the syntax at that position (${text})`
}
const HINTS = { jsx: jsxHint, css: (t) => cssHint(t), backend: backendHint }

// fromEsbuild(kind, file, err) → problems[] — esbuild columns are 0-based (+1); `file` is the
// fallback when a message carries no location.
export function fromEsbuild(kind, file, err) {
  const msgs = err?.errors?.length ? err.errors : [{ text: err?.message ?? String(err) }]
  return msgs.map((m) => {
    const f = m.location?.file || file
    return { file: f, line: m.location?.line ?? 1, col: m.location?.column != null ? m.location.column + 1 : 1, message: m.text, hint: HINTS[kind](m.text, f) }
  })
}

// locateImport(src, spec) → {line, col} of the first `import … 'spec'` line (1-based), else 1:1.
export function locateImport(src, spec) {
  const lines = String(src).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const c = Math.max(l.indexOf(`'${spec}'`), l.indexOf(`"${spec}"`))
    if (c >= 0 && /^\s*(import|export)\b|require\(/.test(l)) return { line: i + 1, col: c + 1 }
  }
  return { line: 1, col: 1 }
}

// classifyWorkerFailure(msg, {appDir, fs, map}) — a worker's {t:'load-failed'} / spawn rejection →
// one problem. `map` (optional) is the bundle's source map lookup: (line, col) → {file, line, col}.
export function classifyWorkerFailure(msg, { appDir, fs = nodeFs, map } = {}) {
  const src = (() => { try { return fs.readFileSync(path.join(appDir, 'backend.js'), 'utf8') } catch { return '' } })()
  const loc = () => {
    if (map && msg.line) { const m = map(msg.line, msg.col ?? 1); if (m) return { file: m.file, line: m.line, col: m.col } }
    return { file: 'backend.js', line: msg.line ?? 1, col: msg.col ?? 1 }
  }
  const text = msg.message ?? ''
  if (msg.code === 'MOUNT-ERROR') return { ...loc(), message: `mountRoutes threw: ${text}`, hint: 'mountRoutes must only register routes — move the failing work into a handler (or guard it), nothing was mounted' }
  if (msg.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (package|module)/.test(text)) {
    const pkg = /package '([^']+)'/.exec(text)?.[1] ?? /module '[^']*?([^/']+)'/.exec(text)?.[1] ?? /'([^']+)'/.exec(text)?.[1] ?? '?'
    return { file: 'backend.js', ...locateImport(src, pkg), message: `Cannot find package '${pkg}'`, hint: `run npm install ${pkg} in ${appDir} and re-save backend.js, or remove the import` }
  }
  if (msg.code === 'RUNTIME-DEAD') return { file: 'backend.js', line: 1, col: 1, message: text || 'the worker exited during load', hint: 'the worker exited during load — check backend.js for top-level code that exits or throws' }
  if (msg.code === 'spawn-eagain' || msg.code === 'no-ready') return { file: 'backend.js', line: 1, col: 1, message: text || msg.code, hint: msg.code === 'no-ready' ? 'the worker never reported READY within the timeout — check backend.js for top-level work that blocks (await a network call at import, a sync loop)' : 'the host could not spawn the worker (process cap or memory) — not an app bug; retried automatically' }
  return { ...loc(), message: text || 'load failed', hint: /SyntaxError|Unexpected/.test(text) ? 'fix the syntax at that position' : 'fix the top-level code at that position (it threw during import)' }
}

// ---------------------------------------------------------------------------------------------
// source map lookup (base64 VLQ, mappings only) — maps a bundle position back to file:line:col

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function decodeVlqLine(seg, st) {
  const out = []
  let i = 0
  while (i < seg.length) {
    let shift = 0, value = 0, c
    do { c = B64.indexOf(seg[i++]); value += (c & 31) << shift; shift += 5 } while (c & 32)
    out.push((value & 1) ? -(value >> 1) : value >> 1)
  }
  return out
}
// sourceMapLookup(mapJson) → (line, col) => {file, line, col} | null   (all 1-based in and out)
export function sourceMapLookup(map) {
  const lines = String(map.mappings).split(';')
  let src = 0, sl = 0, sc = 0
  const table = lines.map((l) => {
    let gc = 0
    const segs = []
    for (const s of l.split(',')) {
      if (!s) continue
      const f = decodeVlqLine(s)
      gc += f[0]
      if (f.length >= 4) { src += f[1]; sl += f[2]; sc += f[3]; segs.push({ gc, src, sl, sc }) }
    }
    return segs
  })
  return (line, col = 1) => {
    const segs = table[line - 1]
    if (!segs?.length) return null
    let best = segs[0]
    for (const s of segs) if (s.gc <= col - 1) best = s
    return { file: map.sources[best.src], line: best.sl + 1, col: best.sc + 1 }
  }
}

// ---------------------------------------------------------------------------------------------
// backend bundle

const RESOLVE_EXTS = ['', '.js', '.mjs', '.cjs', '/index.js', '/index.mjs']
function resolveRelative(fs, fromDir, spec) {
  const base = path.resolve(fromDir, spec)
  for (const ext of RESOLVE_EXTS) {
    const p = base + ext
    try { if (fs.statSync(p).isFile()) return p } catch {}
  }
  return null
}

/**
 * bundleBackend({appDir, fs}) → {code, map, inputs:[rel]} | null (no backend.js)
 * throws {problems:[…]} on failure (classified; the caller reports them).
 */
export async function bundleBackend({ appDir: appDirIn, fs = nodeFs, target = 'node24' }) {
  let appDir = appDirIn
  try { appDir = fs.realpathSync(appDirIn) } catch {}   // esbuild reports locations relative to the REAL working dir
  const entry = path.join(appDir, 'backend.js')
  let entrySrc
  try { entrySrc = fs.readFileSync(entry, 'utf8') } catch { return null }
  const inputs = new Set(['backend.js'])
  const rewrite = (abs, text) => text.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(abs).href))
  const hostReads = {
    name: 'atelier-host-reads',
    setup(b) {
      b.onResolve({ filter: /^\.\.?\// }, (args) => {
        const fromDir = args.importer ? path.dirname(args.importer) : args.resolveDir
        const p = resolveRelative(fs, fromDir, args.path)
        if (!p) return { errors: [{ text: `Could not resolve "${args.path}"` }] }
        inputs.add(path.relative(appDir, p))
        return { path: p, namespace: 'app' }
      })
      b.onLoad({ filter: /.*/, namespace: 'app' }, (args) => {
        let text
        try { text = fs.readFileSync(args.path, 'utf8') } catch (e) { return { errors: [{ text: `Could not read "${args.path}": ${e.code}` }] } }
        return { contents: rewrite(args.path, text), loader: 'js', resolveDir: path.dirname(args.path) }
      })
    },
  }
  let r
  try {
    r = await esbuild.build({
      stdin: { contents: rewrite(entry, entrySrc), resolveDir: appDir, sourcefile: 'backend.js', loader: 'js' },
      absWorkingDir: appDir, bundle: true, format: 'esm', platform: 'node', target, write: false,
      packages: 'external', sourcemap: true, outfile: 'backend.js', logLevel: 'silent', plugins: [hostReads],
    })
  } catch (e) {
    throw { problems: fromEsbuild('backend', 'backend.js', e) }
  }
  let code = '', map = null
  for (const f of r.outputFiles) {
    if (f.path.endsWith('.map')) {
      const m = JSON.parse(f.text)   // sources come back as `app:/abs/path` (the plugin namespace) — name them app-relative
      m.sources = m.sources.map((s) => { const abs = s.replace(/^app:/, ''); return path.isAbsolute(abs) ? path.relative(appDir, abs) : abs.replace(/^<stdin>$/, 'backend.js') })
      map = JSON.stringify(m)
    } else code = f.text
  }
  return { code, map, inputs: [...inputs] }
}

// ---------------------------------------------------------------------------------------------
// frontend per-file transform

const IMPORT_RES = [
  /(\bfrom\s*)(["'])(\.{1,2}\/[^"'?]*)(\2)/g,
  /(\bimport\s*\(\s*)(["'])(\.{1,2}\/[^"'?]*)(\2)/g,
  /(\bimport\s+)(["'])(\.{1,2}\/[^"'?]*)(\2)/g,
]
// servedSpecifier(fromDir, spec, fs) → the specifier the browser fetches, or null when nothing on disk
// answers it. As the 1.x bundler resolved them: an exact file as written (`.jsx` → its `.js` sibling
// in the served tree), an extensionless `./x` → `x.jsx` | `x.js`, a folder → its `index.jsx` | `index.js`.
export function servedSpecifier(fromDir, spec, fs = nodeFs) {
  const target = path.resolve(fromDir, spec)
  const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
  if (/\.jsx$/.test(spec)) return isFile(target) ? spec.replace(/\.jsx$/, '.js') : null
  if (/\.js$/.test(spec)) return isFile(target) || isFile(target.slice(0, -3) + '.jsx') ? spec : null
  if (isFile(target)) return spec
  if (isFile(`${target}.jsx`) || isFile(`${target}.js`)) return `${spec}.js`
  if (isFile(path.join(target, 'index.jsx')) || isFile(path.join(target, 'index.js'))) return `${spec.replace(/\/$/, '')}/index.js`
  return null
}
// versionRelativeImports(code, rev) — 1.x server.js `versionRelativeImports`, `?rev=` instead of `?v=`.
export function versionRelativeImports(code, rev) {
  let out = String(code)
  for (const re of IMPORT_RES) out = out.replace(re, (_, a, q, p) => `${a}${q}${p}?rev=${rev}${q}`)
  return out
}
function relativeSpecifiers(code) {
  const out = []
  for (const re of IMPORT_RES) for (const m of String(code).matchAll(re)) out.push(m[3])
  return out
}

/**
 * transformFrontend({appDir, rev, fs}) → {files: Map<rel, code>}   rel = source path with `.jsx` → `.js`
 * throws {problems} on the first file that fails (syntax, or a relative import that resolves to nothing).
 */
export async function transformFrontend({ appDir, rev, fs = nodeFs }) {
  const sources = walkFiles(appDir, { exts: ['jsx', 'js'], fs })
  const byOut = new Map()
  for (const s of sources) {   // a `.jsx` shadows a `.js` sibling of the same name (1.x)
    const out = s.rel.replace(/\.jsx$/, '.js')
    if (!byOut.has(out) || s.rel.endsWith('.jsx')) byOut.set(out, s)
  }
  const files = new Map()
  const problems = []
  for (const [out, s] of byOut) {
    let src
    try { src = fs.readFileSync(s.abs, 'utf8') } catch (e) { problems.push({ file: s.rel, line: 1, col: 1, message: `unreadable: ${e.code}`, hint: 'the file vanished or is unreadable — re-save it' }); continue }
    const rewrites = new Map()   // spec → the served specifier (`./x` → `./x.js`, `./x.jsx` → `./x.js`, `./dir` → `./dir/index.js`)
    for (const spec of relativeSpecifiers(src)) {
      const served = servedSpecifier(path.dirname(s.abs), spec, fs)
      if (!served) { problems.push({ file: s.rel, ...locateImport(src, spec), message: `Could not resolve "${spec}"`, hint: jsxHint(`Could not resolve "${spec}"`, s.rel) }); continue }
      if (served !== spec) rewrites.set(spec, served)
    }
    let code
    try {
      const r = await esbuild.transform(src, { loader: 'jsx', format: 'esm', jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', target: 'es2020', sourcefile: s.rel, minify: false, logLevel: 'silent' })
      code = r.code
    } catch (e) { problems.push(...fromEsbuild('jsx', s.rel, e)); continue }
    if (rewrites.size) for (const re of IMPORT_RES) code = code.replace(re, (m, a, q, p) => rewrites.has(p) ? `${a}${q}${rewrites.get(p)}${q}` : m)
    files.set(out, versionRelativeImports(code, rev))
  }
  if (problems.length) throw { problems }
  return { files }
}
