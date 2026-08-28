// doctor/rules/rewrite.mjs — the two mechanical code rewrites (DESIGN §2 "The two code rewrites").
//
//   rewriteN1(text)        self-pathed data dir → `<ctx>.dataDir`, inside the mountRoutes span only
//   rewriteN4(text)        `/api/global/` → `/api/${<ctx>.workspace}/`, inside the span, backend only
//   rewriteBackend(text)   both, N1 then N4 → {text, edits:[{rule, line, from, to}], skipped:[{rule, line, reason}]}
//   rewriteModule({dir})   lane C's entry: every backend source file of the folder (walk.mjs) with ≥ 1 edit →
//                          [{file, text, edits, skipped}] — the copies lane C writes under <out>/doctor/<module>/rewrite/
//
// Every transform is a pure function (text) → {text, edits, skipped}; byte-exact; edits are applied from
// the last to the first so offsets stay valid; `line` is the 1-based line of the edit in the ORIGINAL
// text. Outside the span nothing is touched: `ctx` does not exist at module scope (DESIGN §9.6) — the
// static rule names those lines ("hoist"). A span without a ctx parameter (`mountRoutes(router)`,
// destructured) rewrites nothing and is reported in `skipped`.
import nodeFs from 'node:fs'
import path from 'node:path'
import { scan, findMountRoutes, splitArgs, lineOf, CODE, STRING, TEMPLATE } from './scope.mjs'
import { walkJsxFiles, walkSourceFiles } from './walk.mjs'

const DIR_IDENT = /^(__dirname|HERE|ROOT|DIR|MODULE_DIR)$/
const DIR_CALL = /^(?:path\.)?dirname\s*\(|^fileURLToPath\s*\(/
const isDirExpr = (t) => DIR_IDENT.test(t) || DIR_CALL.test(t)
const DATA_LIT = /^(['"])data(?:\/(.*))?\1$/s

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

export function rewriteN1(text) {
  const scanned = scan(text)
  const span = findMountRoutes(text, scanned)
  const edits = [], skipped = []
  if (!span) return finish(text, edits, skipped)
  if (!span.ctxName) {
    skipped.push({ rule: 'N1', line: span.line, reason: 'mountRoutes has no ctx parameter — add `(router, ctx)`' })
    return finish(text, edits, skipped)
  }
  const { mask } = scanned
  const ctx = span.ctxName
  const inSpan = (i) => i >= span.bodyStart && i < span.bodyEnd

  // path.join(<X>, 'data'[, rest…]) / path.resolve(…)
  const call = /path\.(join|resolve)\s*\(/g
  let m
  while ((m = call.exec(text))) {
    if (!inSpan(m.index) || mask[m.index] !== CODE) continue
    const open = m.index + m[0].length - 1
    const parsed = splitArgs(text, open, mask)
    if (!parsed || parsed.args.length < 2) continue
    const [a0, a1, ...rest] = parsed.args
    if (!isDirExpr(a0.text)) continue
    const lit = DATA_LIT.exec(a1.text)
    if (!lit) continue
    const q = lit[1], tail = lit[2]
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
    if (!isDirExpr(expr)) continue
    const after = text.slice(h.end, sp.end - 1)            // between `}` and the closing backtick
    if (after === '/data') {
      edits.push({ rule: 'N1', start: sp.start, end: sp.end, line: lineOf(text, sp.start), from: text.slice(sp.start, sp.end), to: `${ctx}.dataDir` })
    } else if (after.startsWith('/data/')) {
      const to = '`${' + ctx + '.dataDir}' + after.slice('/data'.length) + '`'
      edits.push({ rule: 'N1', start: sp.start, end: sp.end, line: lineOf(text, sp.start), from: text.slice(sp.start, sp.end), to })
    }
  }
  return finish(text, edits, skipped)
}

export function rewriteN4(text) {
  const scanned = scan(text)
  const span = findMountRoutes(text, scanned)
  const edits = [], skipped = []
  if (!span) return finish(text, edits, skipped)
  if (!span.ctxName) {
    skipped.push({ rule: 'N4', line: span.line, reason: 'mountRoutes has no ctx parameter — add `(router, ctx)`' })
    return finish(text, edits, skipped)
  }
  const { mask, spans } = scanned
  const ctx = span.ctxName
  const inSpan = (i) => i >= span.bodyStart && i < span.bodyEnd
  const NEEDLE = '/api/global/'
  const REPL = '/api/${' + ctx + '.workspace}/'
  const done = new Set()
  const re = /\/api\/global\//g
  let m
  while ((m = re.exec(text))) {
    const i = m.index
    if (!inSpan(i)) continue
    if (mask[i] === TEMPLATE) {
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
    edits.push({ rule: 'N4', start: sp.start, end: sp.end, line: lineOf(text, sp.start), from: text.slice(sp.start, sp.end), to: '`' + inner.split(NEEDLE).join(REPL) + '`' })
  }
  return finish(text, edits, skipped)
}

export function rewriteBackend(text) {
  const a = rewriteN1(text)
  const b = rewriteN4(a.text)
  // N4 edits carry line numbers of the N1-rewritten text; N1 never changes the line count, so they hold
  return { text: b.text, edits: [...a.edits, ...b.edits], skipped: [...a.skipped, ...b.skipped] }
}

export async function rewriteModule({ dir, fs = nodeFs }) {
  const client = new Set(walkJsxFiles(dir))
  const out = []
  for (const abs of walkSourceFiles(dir)) {
    if (!abs.endsWith('backend.js') && client.has(abs)) continue
    const rw = rewriteBackend(fs.readFileSync(abs, 'utf8'))
    if (rw.edits.length) out.push({ file: path.relative(dir, abs), text: rw.text, edits: rw.edits, skipped: rw.skipped })
  }
  return out
}
