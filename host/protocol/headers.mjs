// host/protocol/headers.mjs — protocol/headers applied at runtime, both ways, plus the body
// budget (DESIGN §6.5; PLAN §4.4 "Header policy", "Transport" — streamed bodies with byte
// counters, 1 MiB in / 4 MiB out verified in C3, 64 MiB per-app cap, 413 past it).
//
// The lists and the two filters are protocol/'s; this module only wires them to node streams:
//   inbound(req, {user})   framing check on the RAW headers → filterRequestHeaders → the identity
//                          stamp. Every inbound `x-atelier-*` was stripped by the filter, so the
//                          stamp REPLACES whatever the caller sent (C3: a forged x-atelier-user is
//                          a no-op). `authorization` and `cookie` never reach a worker (B6).
//   outbound(headers, {mount, companyOrigin})   framing check → filterResponseHeaders with
//                          cookieCredentialed:false (the shell applies the cookie cut, OR12) →
//                          a root-absolute `location` is rewritten onto the app's mount
//                          (`/x` → `/api/<company>/<slug>/x`); relative and absolute pass as they
//                          are; protocol-relative was cut by the filter (B6 surprise 1). The host
//                          emits the final company-origin path, so the shell rewrites nothing.
//   countedBody({cap})     a Transform that counts bytes and destroys the stream past `cap`
//                          (err.code = 'BODY_CAP'); `.bytes` is the counter both directions read.
import { Transform } from 'node:stream'
import { filterRequestHeaders, filterResponseHeaders, rejectFraming, BODY_CAP_DEFAULT } from '../../protocol/index.js'

export { BODY_CAP_DEFAULT }
export const VERIFIED_IN_BYTES = 1024 * 1024        // C3 row: POST 1 MiB body, counted at the host
export const VERIFIED_OUT_BYTES = 4 * 1024 * 1024   // C3 row: GET 4 MiB chunked, counted at the shell
export const USER_HEADERS = ['x-atelier-user', 'x-atelier-name', 'x-atelier-claims']

// userHeaders(user) → the three internal identity headers. HTTP header values are latin1: the name is
// percent-encoded and the claims JSON is ASCII-escaped (worker/runtime.mjs `userFromHeaders` reverses both).
const asciiJson = (v) => JSON.stringify(v ?? {}).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
export function userHeaders(user) {
  return {
    'x-atelier-user': String(user.id),
    'x-atelier-name': encodeURIComponent(String(user.name ?? '')),
    'x-atelier-claims': asciiJson(user.claims),
  }
}
// stampUser(headers, user) → the headers with the three internal identity headers set, after the strip.
export const stampUser = (headers, user) => ({ ...headers, ...userHeaders(user) })

// inbound(req, {user, cap}) → {ok:true, headers, stripped, dropped, contentLength}
//                           | {ok:false, status:400|413, reason:'framing'|'body-cap'}
export function inbound(req, { user, cap = BODY_CAP_DEFAULT } = {}) {
  const raw = req.headers ?? {}
  if (rejectFraming(raw)) return { ok: false, status: 400, reason: 'framing' }
  const cl = raw['content-length'] !== undefined ? Number(raw['content-length']) : null
  if (cl !== null && cl > cap) return { ok: false, status: 413, reason: 'body-cap' }
  const f = filterRequestHeaders(raw)
  const headers = user ? stampUser(f.headers, user) : f.headers
  return { ok: true, headers, stripped: f.stripped, dropped: f.dropped, contentLength: cl }
}

export const isRootAbsolute = (v) => typeof v === 'string' && v.startsWith('/') && !v.startsWith('//')

// outbound(headers, {mount, companyOrigin}) → {ok:true, headers, stripped} | {ok:false, reason:'framing'}
export function outbound(headers, { mount = '', companyOrigin } = {}) {
  const raw = headers ?? {}
  if (rejectFraming(raw)) return { ok: false, reason: 'framing' }
  const f = filterResponseHeaders(raw, { cookieCredentialed: false, companyOrigin })
  const out = f.headers
  if (out.location !== undefined && mount) {
    const loc = Array.isArray(out.location) ? out.location[0] : out.location
    if (isRootAbsolute(loc)) out.location = mount + loc
  }
  return { ok: true, headers: out, stripped: f.stripped }
}

// countedBody({cap}) → Transform. `.bytes` counts what passed; the (cap+1)th byte destroys the
// stream with err.code 'BODY_CAP' — a request answers 413 if headers are still open, a response
// is cut (the shell sees a truncated body, never an over-budget one).
export function countedBody({ cap = BODY_CAP_DEFAULT } = {}) {
  const t = new Transform({
    transform(chunk, _enc, cb) {
      t.bytes += chunk.length
      if (t.bytes > cap) { const e = new Error(`body over ${cap} bytes`); e.code = 'BODY_CAP'; return cb(e) }
      cb(null, chunk)
    },
  })
  t.bytes = 0
  t.cap = cap
  return t
}
