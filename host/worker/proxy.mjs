// host/worker/proxy.mjs — HTTP over the worker's Unix socket (DESIGN §4.1, PLAN §4.4 transport).
// Streams both ways with byte counters (C3: 1 MiB in / 4 MiB out), applies host/protocol/headers.mjs
// both ways — `inbound()` (framing check, content-length precheck, the request filter, the identity
// stamp from the VERIFIED user: every inbound x-atelier-* was stripped first), `outbound()` (the
// response filter; a root-absolute `Location` rewritten onto the app's mount — the host emits the
// final company-origin path, the shell rewrites nothing, DESIGN L1.6), `countedBody()` (the per-app
// body budget, both directions) — and maps failures:
//   ECONNREFUSED/ENOENT → 502 {error:'worker unavailable'}   no response headers within timeoutMs → 504
//   Upgrade → 426 (no WebSocket lane in 2.0.0)                 ambiguous framing → 400   body past cap → 413
//   a response past cap → cut (res destroyed)                  /_atelier/* → 404 (the worker's health route is host-only)
// Disconnect = res 'close' with !writableFinished (never req 'close': it fires once the body is consumed, b6 surprise 4).
import http from 'node:http'
import { inbound, outbound, countedBody, userHeaders, BODY_CAP_DEFAULT } from '../protocol/headers.mjs'

export { userHeaders }
export const PROXY_TIMEOUT_MS = 30_000

const HOST_ONLY = /^\/_atelier(?:\/|$)/

/**
 * @param {{sock:string, req:import('node:http').IncomingMessage, res:import('node:http').ServerResponse,
 *   user:{id:string,name?:string,claims?:object}, path?:string, mount?:string, bodyCap?:number, timeoutMs?:number}} o
 *   `path` = the mount-relative path (+query) to forward; defaults to req.url. `mount` = `/api/<company>/<slug>`
 *   (the Location rewrite base; no rewrite without it).
 * @returns {Promise<{status:number, bytesIn:number, bytesOut:number}>}
 */
export function proxyRequest({ sock, req, res, user, path = req.url, mount = '', bodyCap = BODY_CAP_DEFAULT, timeoutMs = PROXY_TIMEOUT_MS }) {
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
    const inb = inbound(req, { user, cap: bodyCap })
    if (!inb.ok) return reply(inb.status, { error: inb.reason === 'framing' ? 'bad framing' : 'body too large' })
    if (HOST_ONLY.test(path)) return reply(404, { error: 'not found' })

    const up = http.request({ socketPath: sock, method: req.method, path, headers: inb.headers })
    let responded = false
    const headerTimer = setTimeout(() => {
      if (responded) return
      up.destroy(Object.assign(new Error('worker timeout'), { code: 'ETIMEDOUT' }))
      reply(504, { error: 'worker timeout' })
    }, timeoutMs)

    up.on('response', (r) => {
      responded = true
      clearTimeout(headerTimer)
      const o = outbound(r.headers, { mount })
      if (!o.ok) { r.resume(); return reply(502, { error: 'bad framing' }) }
      res.writeHead(r.statusCode, o.headers)
      const out = countedBody({ cap: bodyCap })
      out.on('error', () => {})                                   // BODY_CAP: the cut below
      r.on('error', () => { res.destroy(); done(r.statusCode) })
      r.pipe(out).pipe(res)
      out.on('error', (e) => { bytesOut = out.bytes; if (e.code === 'BODY_CAP') { up.destroy(); res.destroy(); done(r.statusCode) } })
      res.on('finish', () => { bytesOut = out.bytes; done(r.statusCode) })
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
