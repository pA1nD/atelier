// host/supervisor/tailwind.mjs — one Tailwind sheet per app (PLAN §4.3 "CSS", R11, DESIGN §6.4;
// seeds spike-b5/tw.mjs + r2/spike-migration-local-3/tw.mjs "merged" mode).
//
// The sheet = the chrome's `styles.css` compiled with `compile()` from @tailwindcss/node
// (`base` = the chrome dir, so `@import 'tailwindcss'` and the chrome's own imports resolve
// there) and `Scanner({sources:[]}).scanFiles(contents)` over an EXPLICIT list: the chrome
// folder's and the app folder's `.jsx/.js/.tsx/.ts/.html` files, walked recursively with the 1.x
// exclusions (bundle.mjs walkFiles), every line > 8 KB split at 200 chars before scanning (the
// oxide scanner is ~2 ms/KB on one long line). No resident compiler — a shared one leaks
// candidates across apps by construction — so every call compiles fresh (b5: 4.9 ms median app).
// No chrome dir → the app's own `styles.css` passed through unchanged ('' when absent).
// A compile failure (a broken chrome sheet or app sheet) throws {problems} classified `css`.
import nodeFs from 'node:fs'
import path from 'node:path'
import { compile } from '@tailwindcss/node'
import { Scanner } from '@tailwindcss/oxide'
import { walkFiles } from './bundle.mjs'

export const SCAN_EXTS = ['jsx', 'js', 'tsx', 'ts', 'html']
export const LONG_LINE = 8 * 1024
export const SPLIT_AT = 200

// splitLongLines(text) — lines longer than LONG_LINE are cut into SPLIT_AT-char lines.
export function splitLongLines(text, max = LONG_LINE, at = SPLIT_AT) {
  const lines = String(text).split('\n')
  let touched = false
  const out = []
  for (const l of lines) {
    if (l.length <= max) { out.push(l); continue }
    touched = true
    for (let i = 0; i < l.length; i += at) out.push(l.slice(i, i + at))
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

function cssProblem(file, e) {
  const text = e?.message ?? String(e)
  const m = /(\d+):(\d+)/.exec(text)
  return { file, line: e?.line ?? (m ? +m[1] : 1), col: e?.column ?? (m ? +m[2] : 1), message: text.split('\n')[0], hint: /Expected "}"|unclosed|Unexpected end/i.test(text) ? 'close the rule with } (an unclosed brace would be silently repaired by the browser — treated as a build failure)' : `fix the CSS at that position (${text.split('\n')[0]})` }
}

/**
 * buildSheet({chromeDir, appDir, fs}) → {css, ms, candidates, chrome:boolean}
 *   chromeDir set   → chrome styles.css compiled, scan = chrome ∪ app
 *   chromeDir unset → the app's styles.css bytes as they are ('' when absent), no compile
 * throws {problems:[{file,line,col,message,hint}]} on a compile failure.
 */
export async function buildSheet({ chromeDir, appDir, fs = nodeFs }) {
  const t0 = performance.now()
  if (!chromeDir) {
    let css = ''
    try { css = fs.readFileSync(path.join(appDir, 'styles.css'), 'utf8') } catch {}
    return { css, ms: performance.now() - t0, candidates: 0, chrome: false }
  }
  const entry = path.join(chromeDir, 'styles.css')
  let src
  try { src = fs.readFileSync(entry, 'utf8') } catch { return { css: '', ms: performance.now() - t0, candidates: 0, chrome: false } }
  let compiler
  try { compiler = await compile(src, { base: chromeDir, from: entry, onDependency: () => {} }) } catch (e) { throw { problems: [cssProblem('chrome/styles.css', e)] } }
  const contents = scanSources([chromeDir, appDir], fs)
  const candidates = new Scanner({ sources: [] }).scanFiles(contents.map(({ content, extension }) => ({ content, extension })))
  let css
  try { css = compiler.build(candidates) } catch (e) { throw { problems: [cssProblem('chrome/styles.css', e)] } }
  return { css, ms: performance.now() - t0, candidates: candidates.length, chrome: true }
}
