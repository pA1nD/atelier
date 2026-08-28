// shell/proxy.mjs — the streamed proxy through a hostLink (DESIGN §3.2–3.3; PLAN §4.4 "Header
// policy", "Transport"). protocol/headers decides, this file only wires it to node streams:
//
//   request:  rejectFraming(RAW) → 400; filterRequestHeaders keeps the allowlist and strips
//             `cookie`, `authorization`, `x-forwarded-*` and EVERY inbound `x-atelier-*` (a forged
//             identity header is dropped before the hostLink adds the real one); the body is piped
//             through countedBody({cap}) — the (cap+1)th byte is a 413 while headers are open.
//   response: filterResponseHeaders({cookieCredentialed, companyOrigin}) — `set-cookie` and
//             `www-authenticate` never pass; on cookie-credentialed routes every `access-control-*`
//             is cut except an ACAO equal to the company origin; `location` passes unchanged (the
//             host already rewrote a root-absolute one onto the mount); the body streams through a
//             counted transform — past the cap the response is cut, never over-budget.
//   dial:     DIAL/TIMEOUT before headers → 503 {waking:true} + Retry-After: 2 + x-atelier-waking: 1
//             (a fetch cannot follow a gate redirect; the client shows its waking fallback);
//             after headers → the response is cut.
import { Transform } from 'node:stream'
import { filterRequestHeaders, filterResponseHeaders, rejectFraming, BODY_CAP_DEFAULT } from '../protocol/index.js'

export { BODY_CAP_DEFAULT }
export const WAKING_BODY = JSON.stringify({ waking: true })
export const WAKING_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '2', 'x-atelier-waking': '1' }

export function countedBody({ cap = BODY_CAP_DEFAULT } = {}) {
  const t = new Transform({
    transform(chunk, _enc, cb) {
      t.bytes += chunk.length
      if (t.bytes > cap) { const e = new Error(`body over ${cap} bytes`); e.code = 'BODY_CAP'; return cb(e) }
      cb(null, chunk)
    },
  })
  t.bytes = 0
  return t
}

export function json(res, status, body, extra = {}) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store', ...extra })
  res.end(buf)
}

/**
 * proxyRequest({ req, res, hostLink, hostRow, app, person, credential, companyOrigin, forwardPath, capIn, capOut, log })
 *   → Promise<{ status, bytesIn, bytesOut, stripped }>
 *   forwardPath: the normalised path + the original query — what is signed and what is sent
 */
export async function proxyRequest({ req, res, hostLink, hostRow, app, person, credential = 'none', companyOrigin = null, forwardPath, capIn = BODY_CAP_DEFAULT, capOut = BODY_CAP_DEFAULT, log = () => {} }) {
  const raw = req.headers ?? {}
  if (rejectFraming(raw)) { req.resume(); json(res, 400, {}); return { status: 400 } }
  const cl = raw['content-length'] !== undefined ? Number(raw['content-length']) : null
  if (cl !== null && cl > capIn) { req.resume(); json(res, 413, {}); return { status: 413 } }
  const f = filterRequestHeaders(raw)
  const forged = f.stripped.filter((n) => n.startsWith('x-atelier-'))
  if (forged.length) log(`proxy: stripped ${forged.join(',')} from ${person?.id ?? '?'} ${req.method} ${forwardPath}`)

  const path = forwardPath ?? req.url
  const cin = countedBody({ cap: capIn })
  const noBody = req.method === 'GET' || req.method === 'HEAD'
  let up
  try {
    up = await hostLink.request({ hostRow, app, person, method: req.method, path, headers: f.headers, body: noBody ? null : req.pipe(cin) })
  } catch (e) {
    if (res.headersSent) { res.destroy(); return { status: 0, error: e.code } }
    if (e.code === 'BODY_CAP') { json(res, 413, {}); return { status: 413 } }
    if (e.code === 'DIAL' || e.code === 'TIMEOUT') {
      log(`proxy: ${e.code} ${hostRow.ip}:${hostRow.port} ${req.method} ${path}`)
      res.writeHead(503, { ...WAKING_HEADERS, 'content-length': Buffer.byteLength(WAKING_BODY) }); res.end(WAKING_BODY)
      return { status: 503, error: e.code }
    }
    log(`proxy: upstream ${e.code ?? ''} ${e.message} ${req.method} ${path}`)
    json(res, 502, {}); return { status: 502, error: e.code }
  }
  const out = filterResponseHeaders(up.headers, { cookieCredentialed: credential === 'cookie', companyOrigin })
  const cout = countedBody({ cap: capOut })
  res.writeHead(up.status, out.headers)
  res.flushHeaders?.()
  if (req.method === 'HEAD') { up.body.resume(); res.end(); return { status: up.status, bytesIn: cin.bytes, bytesOut: 0, stripped: out.stripped } }
  await new Promise((resolve) => {
    const done = () => resolve()
    cout.on('error', (e) => { log(`proxy: response cut (${e.code ?? e.message}) ${req.method} ${path}`); res.destroy(); done() })
    up.body.on('error', (e) => { log(`proxy: upstream body ${e.code ?? e.message}`); res.destroy(); done() })
    res.on('close', done)
    res.on('finish', done)
    up.body.pipe(cout).pipe(res)
  })
  return { status: up.status, bytesIn: cin.bytes, bytesOut: cout.bytes, stripped: out.stripped }
}
