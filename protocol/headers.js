// Header policy (PLAN §4.4 "Header policy", seeds spike-c3 RESULT.md strip row + surprise 5,
// spike-b6 RESULT.md surprises 2-3). Three lists and two filters; nothing here is runtime.
//
// Inbound: only the pass list reaches a worker. `authorization` never does (b6 surprise 2:
// artifacts' bearer uploads must move to `?token=` or `req.user`); every `x-atelier-*` is
// stripped and re-minted by the shell (C3: a forged x-atelier-identity from a client is a 401
// at the host only because the shell replaced it). `host` is NOT a list item: the proxy's
// own dial sets it (C3 saw `host`/`connection` at the worker — those came from the dial).
// Outbound: `set-cookie` and `www-authenticate` from a host never reach the company origin
// (a Basic-auth dialog on the company origin is chrome phishing — OR1). On cookie-credentialed
// routes the shell answers preflights itself and cuts every `access-control-*` except an
// `access-control-allow-origin` equal to the request's own company origin; on the assertion
// path (OR14) `access-control-*` passes.

export const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']

export const INBOUND_STRIP = {
  exact: ['cookie', 'authorization', ...HOP_BY_HOP],
  prefix: ['x-atelier-', 'x-forwarded-', 'proxy-'],
}
export const INBOUND_PASS = {
  exact: ['accept', 'accept-encoding', 'accept-language', 'content-type', 'content-length', 'if-none-match',
    'if-modified-since', 'if-range', 'range', 'last-event-id', 'origin', 'user-agent'],
  prefix: ['access-control-request-'],
}
export const RESPONSE_ALLOW = ['content-type', 'content-length', 'content-encoding', 'content-disposition', 'location',
  'etag', 'cache-control', 'content-range', 'accept-ranges', 'last-modified', 'vary', 'retry-after']
export const RESPONSE_STRIP_ALWAYS = ['set-cookie', 'www-authenticate', ...HOP_BY_HOP]

const inList = (name, list) => list.exact.includes(name) || list.prefix.some((p) => name.startsWith(p))
const lower = (headers) => Object.entries(headers ?? {}).map(([k, v]) => [String(k).toLowerCase(), v])

// filterRequestHeaders(headers) → {headers, stripped, dropped}. Strip wins over pass; anything
// on neither list is dropped silently (`dropped` for the debug log, `stripped` for the audit line).
export function filterRequestHeaders(headers) {
  const out = {}, stripped = [], dropped = []
  for (const [name, value] of lower(headers)) {
    if (inList(name, INBOUND_STRIP)) stripped.push(name)
    else if (inList(name, INBOUND_PASS)) out[name] = value
    else dropped.push(name)
  }
  return { headers: out, stripped, dropped }
}

// Location passes only when root-absolute (`/x`, not `//host`) or absolute on the company origin.
// The shell rewrites root-absolute ones onto the mount (b6 surprise 1); a foreign absolute
// location would send the person off-origin from a 3xx a worker chose.
export function locationAllowed(value, companyOrigin) {
  const v = String(value)
  if (v.startsWith('/')) return !v.startsWith('//')
  if (!companyOrigin) return false
  try { return new URL(v).origin === companyOrigin } catch { return false }
}

// filterResponseHeaders(headers, {cookieCredentialed, companyOrigin}) → {headers, stripped}.
export function filterResponseHeaders(headers, { cookieCredentialed = false, companyOrigin } = {}) {
  const out = {}, stripped = []
  for (const [name, value] of lower(headers)) {
    if (RESPONSE_STRIP_ALWAYS.includes(name)) { stripped.push(name); continue }
    if (name.startsWith('access-control-')) {
      if (!cookieCredentialed) { out[name] = value; continue }
      if (name === 'access-control-allow-origin' && companyOrigin && value === companyOrigin) { out[name] = value; continue }
      stripped.push(name); continue
    }
    if (!RESPONSE_ALLOW.includes(name)) { stripped.push(name); continue }
    if (name === 'location' && !locationAllowed(value, companyOrigin)) { stripped.push(name); continue }
    out[name] = value
  }
  return { headers: out, stripped }
}

// rejectFraming(headers) → true when the message's framing is ambiguous: both content-length and
// transfer-encoding present (request smuggling), or content-length not a single integer.
export function rejectFraming(headers) {
  const h = Object.fromEntries(lower(headers))
  const cl = h['content-length']
  if (cl !== undefined) {
    if (h['transfer-encoding'] !== undefined) return true
    const values = Array.isArray(cl) ? cl : String(cl).split(',')
    if (values.length !== 1 || !/^\d+$/.test(String(values[0]).trim())) return true
  }
  return false
}
