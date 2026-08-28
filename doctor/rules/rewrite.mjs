// doctor/rules/rewrite.mjs — the two mechanical code rewrites (DESIGN §2 "The two code rewrites").
//
//   rewriteN1(text)        self-pathed data dir → `<ctx>.dataDir`, inside the mountRoutes span only
//   rewriteN4(text)        `/api/global/` → `/api/${<ctx>.workspace}/`, inside the span, backend only
//   rewriteBackend(text)   both, collected over the SAME original text and applied once →
//                          {text, edits:[{rule, line, from, to}], skipped:[{rule, line, reason}]}
//   rewriteModule({dir})   lane C's entry: every backend source file of the folder (walk.mjs) with ≥ 1 edit →
//                          [{file, text, edits, skipped, partial, leftover}] — the copies lane C writes under
//                          <out>/doctor/<module>/rewrite/; `leftover` = the folder's self-pathed data/ lines
//                          (file:line, over EVERY walked source file — a bridge script is a top-level .js the
//                          1.x walk buckets as client) no N1 edit reached, `partial` = leftover.length > 0
//                          (the applier refuses the N1 edits of a partial module without --write-partial: a
//                          backend on ctx.dataDir beside a bridge on <app>/data is a split state)
//
// Every transform is a pure function (text) → {text, edits, skipped}; byte-exact; edits are applied from
// the last to the first so offsets stay valid; `line` is the 1-based line of the edit in the ORIGINAL
// text (both transforms read the original, so a multi-line N1 call collapsing to `ctx.dataDir` never
// shifts an N4 line). Outside the span nothing is touched: `ctx` does not exist at module scope (DESIGN
// §9.6) — the static rule names those lines ("hoist"). A span without a ctx parameter (`mountRoutes(router)`,
// destructured) rewrites nothing and is reported in `skipped`.
//
// N1 rewrites only a path that IS the data dir: `<X>` must be `__dirname`, a `dirname(fileURLToPath(import.meta.url))`
// call, or an identifier the file defines at module scope as the module dir (`const HERE = path.dirname(fileURLToPath(
// import.meta.url))`, `= __dirname`, `= fileURLToPath(new URL('.', import.meta.url))`); a name alone (drive's
// `ROOT = path.join(os.homedir(), …)`) is skipped and named. A `..` in the tail or the rest (`'data', '..',
// 'secrets.json'`) resolves back out of data/ and is skipped and named.
import nodeFs from 'node:fs'
import path from 'node:path'
import { scan, findMountRoutes, splitArgs, lineOf, CODE, STRING, TEMPLATE, COMMENT } from './scope.mjs'
import { walkJsxFiles, walkSourceFiles } from './walk.mjs'
import { RX } from './catalogue.mjs'

const DIR_CALL = /^(?:path\.)?dirname\s*\(|^fileURLToPath\s*\(/
const DIR_DEF = /^(?:__dirname|(?:path\.)?dirname\s*\(\s*fileURLToPath\s*\(\s*import\.meta\.url\s*\)\s*\)|fileURLToPath\s*\(\s*new URL\s*\(\s*['"]\.\/?['"]\s*,\s*import\.meta\.url\s*\)\s*\)|(?:path\.)?dirname\s*\(\s*new URL\s*\(\s*import\.meta\.url\s*\)\s*\.pathname\s*\)|new URL\s*\(\s*['"]\.\/?['"]\s*,\s*import\.meta\.url\s*\)\s*\.pathname)$/
const IDENT = /^[A-Za-z_$][\w$]*$/
const DATA_LIT = /^(['"])data(?:\/(.*))?\1$/s
const DOTDOT = /(^|\/)\.\.(\/|$)/
const REST_DOTDOT = /^(['"`])\.\.(\/|\1)/

// the identifiers the file defines at module scope as the module dir
function dirIdents(text, { mask }) {
  const out = new Set()
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g
  let m
  while ((m = re.exec(text))) {
    if (mask[m.index] !== CODE) continue
    let k = m.index + m[0].length
    const s = k
    while (k < text.length && text[k] !== '\n' && text[k] !== ';' && mask[k] !== COMMENT) k++
    if (DIR_DEF.test(text.slice(s, k).trim())) out.add(m[1])
  }
  return out
}

function applyEdits(text, edits) {
  let out = text
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.to + out.slice(e.end)
  return out
}
const finish = (text, edits, skipped) => ({
  text: applyEdits(text, edits),
  edits: edits.sort((a, b) => a.start - b.start).map(({ rule, line, from, to }) => ({ rule, line, from, to })),
  skipped,
})
const noCtx = (rule, span) => ({ rule, line: span.line, reason: 'mountRoutes has no ctx parameter — add `(router, ctx)`' })

function collectN1(text, scanned, span) {
  const edits = [], skipped = []
  if (!span) return { edits, skipped }
  if (!span.ctxName) { skipped.push(noCtx('N1', span)); return { edits, skipped } }
  const { mask } = scanned
  const ctx = span.ctxName
  const idents = dirIdents(text, scanned)
  const inSpan = (i) => i >= span.bodyStart && i < span.bodyEnd
  // isDir(t) → true | false | 'unresolved' (a dir-looking identifier the file does not define as the module dir)
  const isDir = (t) => (t === '__dirname' || idents.has(t) ? true : IDENT.test(t) ? (/^(HERE|ROOT|DIR|MODULE_DIR)$/.test(t) ? 'unresolved' : false) : DIR_CALL.test(t) && /import\.meta\.url/.test(t))
  const skip = (i, reason) => skipped.push({ rule: 'N1', line: lineOf(text, i), reason })

  // path.join(<X>, 'data'[, rest…]) / path.resolve(…)
  const call = /path\.(join|resolve)\s*\(/g
  let m
  while ((m = call.exec(text))) {
    if (!inSpan(m.index) || mask[m.index] !== CODE) continue
    const open = m.index + m[0].length - 1
    const parsed = splitArgs(text, open, mask)
    if (!parsed || parsed.args.length < 2) continue
    const [a0, a1, ...rest] = parsed.args
    const lit = DATA_LIT.exec(a1.text)
    if (!lit) continue
    const dir = isDir(a0.text)
    if (dir === 'unresolved') { skip(m.index, `\`${a0.text}\` is not the module dir here (no module-scope \`const ${a0.text} = dirname(fileURLToPath(import.meta.url))\`) — rewrite by hand`); continue }
    if (!dir) continue
    const q = lit[1], tail = lit[2]
    if ((tail && DOTDOT.test(tail)) || (rest[0] && REST_DOTDOT.test(rest[0].text))) { skip(m.index, 'resolves outside data/ (a `..` segment) — not the data dir; rewrite by hand'); call.lastIndex = parsed.close + 1; continue }
    const restText = rest.length ? text.slice(rest[0].start, parsed.close) : ''
    const parts = [`${ctx}.dataDir`]
    if (tail) parts.push(`${q}${tail}${q}`)
    if (restText) parts.push(restText)
    const to = parts.length === 1 ? parts[0] : `path.${m[1]}(${parts.join(', ')})`
    edits.push({ rule: 'N1', start: m.index, end: parsed.close + 1, line: lineOf(text, m.index), from: text.slice(m.index, parsed.close + 1), to })
    call.lastIndex = parsed.close + 1
  }

  // `${<X>}/data` and `${<X>}/data/<tail>` — the template starts with the hole
  for (const sp of scanned.spans) {
    if (sp.type !== 'template' || !inSpan(sp.start) || !sp.holes.length) continue
    const h = sp.holes[0]
    if (h.start !== sp.start + 1) continue
    const expr = text.slice(h.bodyStart, h.bodyEnd).trim()
    const after = text.slice(h.end, sp.end - 1)            // between `}` and the closing backtick
    if (after !== '/data' && !after.startsWith('/data/')) continue
    const dir = isDir(expr)
    if (dir === 'unresolved') { skip(sp.start, `\`${expr}\` is not the module dir here (no module-scope \`const ${expr} = dirname(fileURLToPath(import.meta.url))\`) — rewrite by hand`); continue }
    if (!dir) continue
    if (DOTDOT.test(after.slice('/data'.length))) { skip(sp.start, 'resolves outside data/ (a `..` segment) — not the data dir; rewrite by hand'); continue }
    const to = after === '/data' ? `${ctx}.dataDir` : '`${' + ctx + '.dataDir}' + after.slice('/data'.length) + '`'
    edits.push({ rule: 'N1', start: sp.start, end: sp.end, line: lineOf(text, sp.start), from: text.slice(sp.start, sp.end), to })
  }
  return { edits, skipped }
}

function collectN4(text, scanned, span) {
  const edits = [], skipped = []
  if (!span) return { edits, skipped }
  if (!span.ctxName) { skipped.push(noCtx('N4', span)); return { edits, skipped } }
  const { mask, spans } = scanned
  const ctx = span.ctxName
  const inSpan = (i) => i >= span.bodyStart && i < span.bodyEnd
  const NEEDLE = '/api/global/'
  const REPL = '/api/${' + ctx + '.workspace}/'
  const done = new Set()
  const nonWs = (i, step) => { while (i >= 0 && i < text.length && /\s/.test(text[i])) i += step; return text[i] }
  const re = /\/api\/global\//g
  let m
  while ((m = re.exec(text))) {
    const i = m.index
    if (!inSpan(i)) continue
    if (mask[i] === TEMPLATE) {
      // the innermost template holding the hit; one that holds escaped code (\` or \${) is a served snippet
      const tp = spans.filter((s) => s.type === 'template' && s.start <= i && i < s.end).at(-1)
      if (tp && /\\`|\\\$\{/.test(text.slice(tp.start, tp.end))) {
        if (!done.has(tp.start)) { done.add(tp.start); skipped.push({ rule: 'N4', line: lineOf(text, i), reason: 'inside a template that holds escaped code — a served snippet, user-facing text; rewrite by hand' }) }
        continue
      }
      edits.push({ rule: 'N4', start: i, end: i + NEEDLE.length, line: lineOf(text, i), from: NEEDLE, to: REPL })
      continue
    }
    if (mask[i] !== STRING) continue                       // a comment (or code) — not rewritten
    const sp = spans.find((s) => s.type === 'string' && s.start <= i && i < s.end)
    if (!sp || done.has(sp.start)) continue
    done.add(sp.start)
    const inner = text.slice(sp.start + 1, sp.end - 1)
    if (inner.includes('`') || inner.includes('${')) {
      skipped.push({ rule: 'N4', line: lineOf(text, i), reason: 'the string holds a backtick or `${` — rewrite by hand' })
      continue
    }
    let to = '`' + inner.split(NEEDLE).join(REPL) + '`'
    if (nonWs(sp.end, 1) === ':' && /[{,]/.test(nonWs(sp.start - 1, -1) ?? '')) to = `[${to}]`     // an object key: a template needs the computed form
    edits.push({ rule: 'N4', start: sp.start, end: sp.end, line: lineOf(text, sp.start), from: text.slice(sp.start, sp.end), to })
  }
  return { edits, skipped }
}

export function rewriteN1(text) {
  const scanned = scan(text)
  const { edits, skipped } = collectN1(text, scanned, findMountRoutes(text, scanned))
  return finish(text, edits, skipped)
}

export function rewriteN4(text) {
  const scanned = scan(text)
  const { edits, skipped } = collectN4(text, scanned, findMountRoutes(text, scanned))
  return finish(text, edits, skipped)
}

export function rewriteBackend(text) {
  const scanned = scan(text)
  const span = findMountRoutes(text, scanned)
  const a = collectN1(text, scanned, span)
  const b = collectN4(text, scanned, span)
  const skipped = [...a.skipped, ...b.skipped]
  // an N4 hit inside an N1 call's range (`path.join(HERE, 'data', '/api/global/x')`) would collide — named, not edited
  const n4 = b.edits.filter((e) => {
    const hit = a.edits.find((n) => e.start < n.end && n.start < e.end)
    if (hit) skipped.push({ rule: 'N4', line: e.line, reason: 'inside an N1 rewrite on the same line — rewrite by hand' })
    return !hit
  })
  return finish(text, [...a.edits, ...n4], skipped)
}

// the self-pathed data/ hits (the seed's self_data grep) on lines no N1 edit reached, as `<rel>:<line>`
function leftoverOf(rel, text, edits) {
  const edited = new Set(edits.filter((e) => e.rule === 'N1').map((e) => e.line))
  const re = new RegExp(RX.self_data.source, 'g')
  const out = []
  let m
  while ((m = re.exec(text))) { const line = lineOf(text, m.index); if (!edited.has(line)) out.push(`${rel}:${line}`) }
  return [...new Set(out)]
}

export async function rewriteModule({ dir, fs = nodeFs }) {
  const client = new Set(walkJsxFiles(dir))
  const out = []
  const leftover = []
  for (const abs of walkSourceFiles(dir)) {
    const rel = path.relative(dir, abs)
    const text = fs.readFileSync(abs, 'utf8')
    if (!abs.endsWith('backend.js') && client.has(abs)) { leftover.push(...leftoverOf(rel, text, [])); continue }
    const rw = rewriteBackend(text)
    leftover.push(...leftoverOf(rel, text, rw.edits))
    if (rw.edits.length) out.push({ file: rel, text: rw.text, edits: rw.edits, skipped: rw.skipped })
  }
  for (const r of out) { r.partial = leftover.length > 0; r.leftover = leftover }
  return out
}
