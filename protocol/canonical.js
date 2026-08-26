// Canonical JSON for signing (PLAN §4.4, seed spike-c3/common.mjs): keys sorted at every
// depth, no whitespace, undefined-valued keys dropped (JSON semantics). Two implementations
// agree on the bytes iff they agree on this function — the identity vectors pin it.

export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',') + ']'
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
  }
  return JSON.stringify(v)
}

export const b64u = (buf) => Buffer.from(buf).toString('base64url')
export const unb64u = (s) => Buffer.from(s, 'base64url')
