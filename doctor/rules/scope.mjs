// doctor/rules/scope.mjs — brace-balanced regions without a parser (DESIGN §2 "AST").
//
//   scan(text)              → {mask, spans}: a Uint8Array over the text (CODE | STRING | TEMPLATE |
//                             COMMENT | REGEX per character; the code inside a template hole `${…}`
//                             is CODE) plus the string/template/comment/regex spans in source order
//                             (a template span lists its holes).
//   findMountRoutes(text)   → the `mountRoutes(<router>, <ctx>) { … }` span: {start, end, bodyStart,
//                             bodyEnd, line, ctxName, routerName, params} or null when the file has no
//                             brace-bodied mountRoutes (method shorthand, `mountRoutes: (r, c) => {`,
//                             `mountRoutes: function (r, c) {`, `async` in every form). `ctxName` is
//                             null when the second parameter is missing or destructured.
//   lineOf(text, index)     → 1-based line, lineColOf → {line, col}.
//   splitArgs(text, open, mask) → the top-level argument slices of a call whose `(` is at `open`.
//
// The balancer is the 1.x meta reader's (server.js extractMetaStatically: strings and escapes) plus
// comments, template holes and a regex-literal heuristic — a `//` comment holding an apostrophe
// ("don't") is the common case the meta reader never met inside a 2000-line mountRoutes body.
export const CODE = 0, STRING = 1, TEMPLATE = 2, COMMENT = 3, REGEX = 4

const REGEX_BEFORE = /[(,=:[!&|?{};+\-*%<>~^]$/
const REGEX_KEYWORD = /(?:^|[^\w$])(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/

export function scan(text) {
  const n = text.length
  const mask = new Uint8Array(n)
  const spans = []
  let i = 0

  const fill = (s, e, v) => { for (let k = s; k < e && k < n; k++) mask[k] = v }

  function regexAllowed(at) {
    let j = at - 1
    while (j >= 0 && /\s/.test(text[j])) j--
    if (j < 0) return true
    const before = text.slice(Math.max(0, j - 12), j + 1)
    if (REGEX_BEFORE.test(before)) return true
    return REGEX_KEYWORD.test(before)
  }

  function lexTemplate() {
    const s = i
    const holes = []
    i++
    while (i < n) {
      const c = text[i]
      if (c === '\\') { i += 2; continue }
      if (c === '`') { i++; break }
      if (c === '$' && text[i + 1] === '{') {
        const hs = i
        i += 2
        const bodyStart = i
        lexCode(true)                 // stops AT the matching '}'
        holes.push({ start: hs, bodyStart, bodyEnd: i, end: i + 1 })
        i++                           // past '}'
        continue
      }
      i++
    }
    const e = Math.min(i, n)
    fill(s, e, TEMPLATE)
    for (const h of holes) fill(h.bodyStart, h.bodyEnd, CODE)
    // the hole delimiters `${` and `}` count as template, the code between as CODE — re-run the
    // nested lexer's own spans: they were pushed while lexing the hole, so nothing to do here
    spans.push({ type: 'template', start: s, end: e, holes })
  }

  function lexRegex() {
    const s = i
    i++
    let cls = false
    while (i < n) {
      const c = text[i]
      if (c === '\\') { i += 2; continue }
      if (c === '\n') break
      if (cls) { if (c === ']') cls = false; i++; continue }
      if (c === '[') { cls = true; i++; continue }
      if (c === '/') { i++; break }
      i++
    }
    while (i < n && /[a-z]/i.test(text[i])) i++
    fill(s, i, REGEX)
    spans.push({ type: 'regex', start: s, end: Math.min(i, n) })
  }

  // lexCode(untilBrace): lexes code; when untilBrace, returns with i AT the '}' that closes depth 0.
  function lexCode(untilBrace) {
    let depth = 0
    while (i < n) {
      const c = text[i], d = text[i + 1]
      if (c === '/' && d === '/') {
        const s = i
        while (i < n && text[i] !== '\n') i++
        fill(s, i, COMMENT); spans.push({ type: 'comment', start: s, end: i }); continue
      }
      if (c === '/' && d === '*') {
        const s = i
        const e = text.indexOf('*/', i + 2)
        i = e < 0 ? n : e + 2
        fill(s, i, COMMENT); spans.push({ type: 'comment', start: s, end: i }); continue
      }
      if (c === '"' || c === "'") {
        const s = i
        i++
        while (i < n && text[i] !== c && text[i] !== '\n') { if (text[i] === '\\') i++; i++ }
        i++
        const e = Math.min(i, n)
        fill(s, e, STRING); spans.push({ type: 'string', quote: c, start: s, end: e }); continue
      }
      if (c === '`') { lexTemplate(); continue }
      if (c === '/' && regexAllowed(i)) { lexRegex(); continue }
      if (untilBrace) {
        if (c === '{') depth++
        else if (c === '}') { if (depth === 0) return; depth-- }
      }
      i++
    }
  }

  lexCode(false)
  spans.sort((a, b) => a.start - b.start)
  return { mask, spans }
}

export function lineOf(text, index) {
  let line = 1
  for (let k = 0; k < index && k < text.length; k++) if (text.charCodeAt(k) === 10) line++
  return line
}

export function lineColOf(text, index) {
  const before = text.slice(0, index)
  const nl = before.lastIndexOf('\n')
  return { line: before.split('\n').length, col: index - nl }
}

// matchBrace(text, open, mask) → index of the '}' / ')' / ']' matching the opener at `open`, or -1.
export function matchBrace(text, open, mask) {
  const o = text[open]
  const c = o === '{' ? '}' : o === '(' ? ')' : o === '[' ? ']' : null
  if (!c) return -1
  let depth = 0
  for (let k = open; k < text.length; k++) {
    if (mask[k] !== CODE) continue
    if (text[k] === o) depth++
    else if (text[k] === c) { depth--; if (depth === 0) return k }
  }
  return -1
}

// splitArgs(text, open, mask) → [{start, end, text}] for the top-level arguments of the call whose
// '(' is at `open`; `end` is exclusive; `close` is the index of the matching ')'.
export function splitArgs(text, open, mask) {
  const close = matchBrace(text, open, mask)
  if (close < 0) return null
  const args = []
  let depth = 0, s = open + 1
  for (let k = open + 1; k < close; k++) {
    if (mask[k] !== CODE) continue
    const ch = text[k]
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) { args.push({ start: s, end: k }); s = k + 1 }
  }
  if (close > s || args.length) args.push({ start: s, end: close })
  const out = args.map((a) => {
    let st = a.start, en = a.end
    while (st < en && /\s/.test(text[st])) st++
    while (en > st && /\s/.test(text[en - 1])) en--
    return { start: st, end: en, text: text.slice(st, en) }
  }).filter((a) => a.text.length)
  return { args: out, close }
}

const IDENT = /^[A-Za-z_$][\w$]*$/

// findMountRoutes(text, scanned?) → span | null. The first `mountRoutes` in CODE (not a string, not a
// comment) that is followed by a parameter list and a brace body.
export function findMountRoutes(text, scanned = scan(text)) {
  const { mask } = scanned
  const re = /\bmountRoutes\b/g
  let m
  while ((m = re.exec(text))) {
    if (mask[m.index] !== CODE) continue
    let k = m.index + m[0].length
    const ws = () => { while (k < text.length && /\s/.test(text[k])) k++ }
    ws()
    if (text[k] === ':' || text[k] === '=') { k++; ws() }
    if (text.startsWith('async', k) && /\s|\(/.test(text[k + 5] || '')) { k += 5; ws() }
    if (text.startsWith('function', k)) { k += 8; ws(); while (k < text.length && /[\w$]/.test(text[k])) k++; ws() }
    if (text[k] !== '(') continue
    const paren = splitArgs(text, k, mask)
    if (!paren) continue
    k = paren.close + 1
    ws()
    if (text.startsWith('=>', k)) { k += 2; ws() }
    if (text[k] !== '{') continue
    const close = matchBrace(text, k, mask)
    if (close < 0) continue
    const params = paren.args.map((a) => a.text.replace(/=[^]*$/, '').trim())
    const name = (p) => (p && IDENT.test(p) ? p : null)
    return {
      start: k, end: close, bodyStart: k + 1, bodyEnd: close,
      line: lineOf(text, m.index),
      routerName: name(params[0]), ctxName: name(params[1]), params,
    }
  }
  return null
}
