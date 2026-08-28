// host/worker/proxy.mjs — HTTP over the worker's Unix socket (DESIGN §4.1, PLAN §4.4 transport).
// Streams both ways with byte counters (C3: 1 MiB in / 4 MiB out), applies protocol/headers both
// ways, sets the three internal identity headers from the VERIFIED user (never from the request —
// filterRequestHeaders strips every inbound x-atelier-*), and maps failures:
//   ECONNREFUSED/ENOENT → 502 {error:'worker unavailable'}   no response headers within timeoutMs → 504
//   Upgrade → 426 (no WebSocket lane in 2.0.0)                 ambiguous framing → 400   body past cap → 413
//   /_atelier/* → 404 (the worker's health route is host-only)
// Disconnect = res 'close' with !writableFinished (never req 'close': it fires once the body is consumed, b6 surprise 4).
import http from 'node:http'
import { filterRequestHeaders, filterResponseHeaders, rejectFraming, BODY_CAP_DEFAULT } from '../../protocol/index.js'

export const PROXY_TIMEOUT_MS = 30_000

// HTTP header values are latin1: the name is percent-encoded and the claims JSON is ASCII-escaped
// (runtime.mjs `userFromHeaders` reverses both).
const asciiJson = (v) => JSON.stringify(v ?? {}).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
export function userHeaders(user) {
  return {
    'x-atelier-user': String(user.id),
    'x-atelier-name': encodeURIComponent(String(user.name ?? '')),
    'x-atelier-claims': asciiJson(user.claims),
  }
}

const HOST_ONLY = /^\/_atelier(?:\/|$)/

/**
 * @param {{sock:string, req:import('node:http').IncomingMessage, res:import('node:http').ServerResponse,
 *   user:{id:string,name?:string,claims?:object}, path?:string, bodyCap?:number, timeoutMs?:number}} o
 *   `path` = the mount-relative path (+query) to forward; defaults to req.url.
 * @returns {Promise<{status:number, bytesIn:number, bytesOut:number}>}
 */
export function proxyRequest({ sock, req, res, user, path = req.url, bodyCap = BODY_CAP_DEFAULT, timeoutMs = PROXY_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let bytesIn = 0, bytesOut = 0, settled = false
    const done = (status) => { if (settled) return; settled = true; resolve({ status, bytesIn, bytesOut }) }
    const reply = (status, body) => {
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' })
      if (!res.writableEnded) res.end(JSON.stringify(body))
      req.resume()
      done(status)
    }
    if (req.headers.upgrade !== undefined) return reply(426, { error: 'upgrade not supported' })
    if (rejectFraming(req.headers)) return reply(400, { error: 'bad framing' })
    if (HOST_ONLY.test(path)) return reply(404, { error: 'not found' })

    const { headers } = filterRequestHeaders(req.headers)
    Object.assign(headers, userHeaders(user))
    const up = http.request({ socketPath: sock, method: req.method, path, headers })
    let responded = false
    const headerTimer = setTimeout(() => {
      if (responded) return
      up.destroy(Object.assign(new Error('worker timeout'), { code: 'ETIMEDOUT' }))
      reply(504, { error: 'worker timeout' })
    }, timeoutMs)

    up.on('response', (r) => {
      responded = true
      clearTimeout(headerTimer)
      const { headers: h } = filterResponseHeaders(r.headers, { cookieCredentialed: false })
      res.writeHead(r.statusCode, h)
      r.on('data', (c) => { bytesOut += c.length })
      r.on('error', () => { res.destroy(); done(r.statusCode) })
      r.pipe(res)
      res.on('finish', () => done(r.statusCode))
    })
    up.on('error', (e) => {
      clearTimeout(headerTimer)
      if (settled) return
      if (res.headersSent) { res.destroy(); return done(res.statusCode) }
      reply(502, { error: 'worker unavailable', code: e.code })
    })
    req.on('data', (c) => {
      bytesIn += c.length
      if (bytesIn > bodyCap) { up.destroy(Object.assign(new Error('body too large'), { code: 'E2BIG' })); reply(413, { error: 'body too large' }) }
    })
    req.on('error', () => { up.destroy() })
    req.pipe(up)
    res.on('close', () => { if (!res.writableFinished) { up.destroy(); done(res.statusCode ?? 0) } })
  })
}
