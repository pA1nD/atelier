// Header policy (PLAN §4.4 "Header policy", seeds spike-c3 RESULT.md strip row + surprise 5,
// spike-b6 RESULT.md surprises 1-3). Three lists and two filters; nothing here is runtime.
//
// ORDER (review 2026-08-26): the proxy calls rejectFraming(raw) on the RAW header set BEFORE
// either filter — after filtering, `transfer-encoding` is gone (hop-by-hop) and a CL+TE
// conflict is invisible. The proxy re-frames the body it forwards; `content-length` passes
// only because the proxy's own framing agrees with it (bounded by BODY_CAP_DEFAULT).
//
// Inbound: only the pass list reaches a worker. `authorization` never does (b6 surprise 2:
// artifacts' bearer uploads must move to `?token=` or `req.user`); every `x-atelier-*` is
// stripped and re-minted by the shell (C3: a forged x-atelier-identity from a client is a 401
// at the host only because the shell replaced it). `host` is NOT a list item: the proxy's
// own dial sets it (C3 saw `host`/`connection` at the worker — those came from the dial).
// Hop-by-hop = the fixed list PLUS every token the message's own `connection` header names
// (RFC 7230 §6.1), both ways.
// Outbound: `set-cookie` never reaches the company origin. `www-authenticate` is stripped on
// BOTH paths — a deliberate tightening of §4.4 (which scopes it to cookie routes): it is not on
// the response allowlist either way, and a Basic-auth dialog on the company origin is chrome
// phishing (OR1); an app's own challenge scheme has no consumer on the assertion path. On
// cookie-credentialed routes the shell answers preflights itself and cuts every
// `access-control-*` except an `access-control-allow-origin` equal to the request's own company
// origin; on the assertion path (OR14) `access-control-*` passes.
// Location (b6 surprise 1, OR7): root-absolute passes and the shell rewrites it onto the mount;
// relative passes unchanged (the browser resolves it against the company-origin request URL);
// absolute passes unchanged whatever the origin — an app may send a person to its OAuth
// provider, nothing is prohibited to an app (OR7). Only protocol-relative `//host` is cut: the
// shell's root-absolute rewrite would otherwise turn `//evil/x` into a mount-relative path or a
// foreign origin depending on which check ran first (b6 surprise 1) — an app wanting a foreign
// origin writes the scheme.

export const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']
export const BODY_CAP_DEFAULT = 64 * 1024 * 1024   // §4.4 body budget: streamed, per-app cap (C3 verified 1 MiB in / 4 MiB out)

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
// RFC 7230 §6.1: the tokens named by the message's own `connection` header are hop-by-hop too.
const connectionTokens = (entries) => {
  const out = new Set()
  for (const [name, value] of entries) if (name === 'connection') for (const v of [].concat(value)) for (const t of String(v).split(',')) { const tok = t.trim().toLowerCase(); if (tok) out.add(tok) }
  return out
}

// filterRequestHeaders(headers) → {headers, stripped, dropped}. Strip wins over pass; anything
// on neither list is dropped silently (`dropped` for the debug log, `stripped` for the audit line).
export function filterRequestHeaders(headers) {
  const out = {}, stripped = [], dropped = []
  const entries = lower(headers)
  const conn = connectionTokens(entries)
  for (const [name, value] of entries) {
    if (conn.has(name) || inList(name, INBOUND_STRIP)) stripped.push(name)
    else if (inList(name, INBOUND_PASS)) out[name] = value
    else dropped.push(name)
  }
  return { headers: out, stripped, dropped }
}

// locationAllowed(value): everything but protocol-relative `//host` (see the header comment).
export function locationAllowed(value) {
  return !String(value).startsWith('//')
}

// filterResponseHeaders(headers, {cookieCredentialed, companyOrigin}) → {headers, stripped}.
export function filterResponseHeaders(headers, { cookieCredentialed = false, companyOrigin } = {}) {
  const out = {}, stripped = []
  const entries = lower(headers)
  const conn = connectionTokens(entries)
  for (const [name, value] of entries) {
    if (conn.has(name) || RESPONSE_STRIP_ALWAYS.includes(name)) { stripped.push(name); continue }
    if (name.startsWith('access-control-')) {
      if (!cookieCredentialed) { out[name] = value; continue }
      if (name === 'access-control-allow-origin' && companyOrigin && value === companyOrigin) { out[name] = value; continue }
      stripped.push(name); continue
    }
    if (!RESPONSE_ALLOW.includes(name)) { stripped.push(name); continue }
    if (name === 'location' && !locationAllowed(value)) { stripped.push(name); continue }
    out[name] = value
  }
  return { headers: out, stripped }
}

// rejectFraming(headers) → true when the message's framing is ambiguous: both content-length and
// transfer-encoding present (request smuggling), or content-length not a single integer.
// Call it on the RAW headers, before filterRequestHeaders / filterResponseHeaders.
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
