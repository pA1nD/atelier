// host/supervisor/tailwind.mjs — one Tailwind sheet per app (PLAN §4.3 "CSS", R11, DESIGN §6.4;
// seeds spike-b5/tw.mjs + r2/spike-migration-local-3/tw.mjs "merged" mode).
//
// The sheet = the chrome's `styles.css` compiled with `compile()` from @tailwindcss/node
// (`base` = the chrome dir, so the chrome's own imports resolve there; `@import 'tailwindcss'`
// resolves from the chrome dir when it ships the package, else from the HOST's node_modules —
// one Tailwind per host, a chrome folder carries no build dependency) and `Scanner({sources:[]}).scanFiles(contents)` over an EXPLICIT list: the chrome
// folder's and the app folder's `.jsx/.js/.tsx/.ts/.html` files, walked recursively with the 1.x
// exclusions (bundle.mjs walkFiles), every line > 8 KB split at 200 chars before scanning (the
// oxide scanner is ~2 ms/KB on one long line). No resident compiler — a shared one leaks
// candidates across apps by construction — so every call compiles fresh (b5: 4.9 ms median app).
// No chrome dir → the app's own `styles.css` passed through unchanged ('' when absent).
// A compile failure (a broken chrome sheet or app sheet) throws {problems} classified `css`.
// `chromeBase` (step 7 ship C, decision 8): when the host holds a chrome RELEASE, every relative
// `url()` of the chrome's source — `fonts/InterVariable.woff2` — is rewritten to `<chromeBase>/…`
// (`/_chrome/<digest>/fonts/…`) before the compile: the app sheet is served at
// `/modules/<c>/<app>/styles.css`, where a relative url would name the app's folder.
import nodeFs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { compile } from '@tailwindcss/node'
import { Scanner } from '@tailwindcss/oxide'
import { walkFiles } from './bundle.mjs'

export const SCAN_EXTS = ['jsx', 'js', 'tsx', 'ts', 'html']
export const LONG_LINE = 8 * 1024
export const SPLIT_AT = 200

// splitLongLines(text) — lines longer than LONG_LINE are cut into lines of at most SPLIT_AT chars, every cut placed
// after the last space or quote in the window so no token is split: a class that straddled a cut never reached the
// scanner (`fixed inset-x-0 bot|tom-0` in a minified chrome bundle — `.bottom-0` missing from every sheet, 2026-09-02).
// A window without a space or quote is cut hard.
export function splitLongLines(text, max = LONG_LINE, at = SPLIT_AT) {
  const lines = String(text).split('\n')
  let touched = false
  const out = []
  for (const l of lines) {
    if (l.length <= max) { out.push(l); continue }
    touched = true
    let i = 0
    while (i < l.length) {
      let end = Math.min(i + at, l.length)
      if (end < l.length) {
        const win = l.slice(i, end)
        const k = Math.max(win.lastIndexOf(' '), win.lastIndexOf('"'), win.lastIndexOf("'"), win.lastIndexOf('`'))
        if (k > 0) end = i + k + 1
      }
      out.push(l.slice(i, end)); i = end
    }
  }
  return touched ? out.join('\n') : String(text)
}

// scanSources(dirs, fs) → [{abs, content, extension}] — the explicit list, contents read here
// (never oxide auto-discovery; the host process holds the app group during the read).
export function scanSources(dirs, fs = nodeFs) {
  const out = []
  for (const dir of dirs) {
    if (!dir) continue
    for (const f of walkFiles(dir, { exts: SCAN_EXTS, fs })) {
      let content
      try { content = fs.readFileSync(f.abs, 'utf8') } catch { continue }
      out.push({ abs: f.abs, content: splitLongLines(content), extension: path.extname(f.abs).slice(1) })
    }
  }
  return out
}

// rebaseUrls(css, base) → css with every RELATIVE url() rebased under `base` (a root-relative, absolute,
// data:/blob: url or a fragment is left alone; `../` prefixes cannot leave the bundle)
export function rebaseUrls(css, base) {
  if (!base) return css
  const root = String(base).replace(/\/+$/, '')
  return String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, quote, raw) => {
    const u = raw.trim()
    if (!u || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(u)) return m
    const [pathPart, tail = ''] = (() => { const i = u.search(/[?#]/); return i < 0 ? [u] : [u.slice(0, i), u.slice(i)] })()
    const rel = path.posix.normalize(pathPart).replace(/^(?:\.\.\/)+/, '').replace(/^\.\/?/, '')
    return `url(${quote}${root}/${rel}${tail}${quote})`
  })
}

function cssProblem(file, e) {
  const text = e?.message ?? String(e)
  const m = /(\d+):(\d+)/.exec(text)
  return { file, line: e?.line ?? (m ? +m[1] : 1), col: e?.column ?? (m ? +m[2] : 1), message: text.split('\n')[0], hint: /Expected "}"|unclosed|Unexpected end/i.test(text) ? 'close the rule with } (an unclosed brace would be silently repaired by the browser — treated as a build failure)' : `fix the CSS at that position (${text.split('\n')[0]})` }
}

/**
 * buildSheet({chromeDir, appDir, fs, chromeBase, source}) → {css, ms, candidates, chrome:boolean}
 *   chromeDir set   → chrome styles.css compiled, scan = chrome ∪ app
 *   chromeDir unset → the app's styles.css bytes as they are ('' when absent), no compile
 *   chromeBase      → relative url() in the chrome's source rebased under it (`/_chrome/<digest>`)
 *   source          → the chrome's sheet source in place of `<chromeDir>/styles.css` (the release verb's rewritten copy)
 * throws {problems:[{file,line,col,message,hint}]} on a compile failure.
 */
const HOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// tailwindResolver(): the css resolver for compile() — `tailwindcss` / `tailwindcss/<file>.css`
// from the chrome dir first (its own copy wins), else the host's; every other id → default resolution.
export function tailwindResolver({ hostRoot = HOST_ROOT } = {}) {
  const pkgDir = (from) => path.dirname(createRequire(path.join(from, 'x.js')).resolve('tailwindcss/package.json'))
  return async (id, base) => {
    if (id !== 'tailwindcss' && !id.startsWith('tailwindcss/')) return undefined
    let dir
    try { dir = pkgDir(base) } catch { try { dir = pkgDir(hostRoot) } catch { return undefined } }
    return path.join(dir, id === 'tailwindcss' ? 'index.css' : id.slice('tailwindcss/'.length))
  }
}

export async function buildSheet({ chromeDir, appDir, fs = nodeFs, chromeBase = null, source = null }) {
  const t0 = performance.now()
  if (!chromeDir) {
    let css = ''
    try { css = fs.readFileSync(path.join(appDir, 'styles.css'), 'utf8') } catch {}
    return { css, ms: performance.now() - t0, candidates: 0, chrome: false }
  }
  const entry = path.join(chromeDir, 'styles.css')
  let src = source
  if (src === null) { try { src = fs.readFileSync(entry, 'utf8') } catch { return { css: '', ms: performance.now() - t0, candidates: 0, chrome: false } } }
  if (chromeBase) src = rebaseUrls(src, chromeBase)
  let compiler
  try { compiler = await compile(src, { base: chromeDir, from: entry, onDependency: () => {}, customCssResolver: tailwindResolver() }) } catch (e) { throw { problems: [cssProblem('chrome/styles.css', e)] } }
  const contents = scanSources([chromeDir, appDir], fs)
  const candidates = new Scanner({ sources: [] }).scanFiles(contents.map(({ content, extension }) => ({ content, extension })))
  let css
  try { css = compiler.build(candidates) } catch (e) { throw { problems: [cssProblem('chrome/styles.css', e)] } }
  return { css, ms: performance.now() - t0, candidates: candidates.length, chrome: true }
}
