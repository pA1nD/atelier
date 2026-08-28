// shell/local/meta.mjs — the literal `export const meta = {…}` reader (the 1.x server.js
// extractMetaStatically, ported; DESIGN §5.3 step 1). Nothing executes: a brace-balanced scan of the
// source, then the literal alone is evaluated in an empty scope — a module-scope reference inside it
// throws, and that message is the diagnostic. The 1.x sandbox fallback (a child process running the
// module's top level) is dropped: a meta that is not a literal reads as `{}` with `error` set.
export function extractMetaStatically(src) {
  const re = /export\s+const\s+meta\s*=\s*\{/.exec(String(src ?? ''))
  if (!re) return { meta: {} }
  const start = src.indexOf('{', re.index)
  if (start < 0) return { meta: {} }
  let depth = 0
  let str = null          // the open string delimiter (', ", or `)
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (str) {
      if (c === '\\') { i++; continue }
      if (c === str) str = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { str = c; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        try { return { meta: new Function('return (' + src.slice(start, i + 1) + ')')() || {} } }
        catch (e) { return { meta: {}, error: e.message } }
      }
    }
  }
  return { meta: {} }
}
