// shell/local/serve.mjs — the shell `npx atelier` puts in front of the hosts.
//
// STUB (lane B, until lane A's `createShell` in shell/index.mjs lands — DESIGN §1, §2): a plain
// reverse proxy from `http://localhost:<P>` to the workspace's host dev shell, adding the dev
// token as a header so no token ever reaches a browser URL. The path's company label picks the
// host (`/<ws>/…`, `/api/<ws>/…`, `/modules/<ws>/…`); anything else (`/assets/*`, `/_atelier/*`,
// `/modules/global/<chrome>/*`, `/`) goes to host 0. The document, the API, the module assets and
// the WS are therefore the host's 1.x set (r2/spike-host-devshell) — not the 2.0 document. What it
// keeps from the design: inbound `x-atelier-*`, `cookie`, `authorization` are stripped; `set-cookie`
// never comes back; a host that is down answers `503 {waking:true}` (Retry-After 2) on fetch routes
// and a plain waking page on document routes, with a 1 s dial cap. Replacing this file's
// `startShell` with `createShell({cfg, providers, log})` is lane A's integration; `workspace`
// carries what the local providers need (root, config, hosts.workspaces(), hosts.row(ws), chrome, discover()).
import http from 'node:http'
import { DEV_TOKEN_HEADER } from '../../host/protocol/auth.mjs'

export const DIAL_MS = 1000
const STRIP_REQ = /^(cookie|authorization|x-atelier-.*|x-forwarded-.*|host|connection|keep-alive|proxy-.*|transfer-encoding|upgrade)$/i
const STRIP_RES = /^(set-cookie|www-authenticate|connection|keep-alive|transfer-encoding)$/i
const FETCH_RE = /^\/(api|modules|assets|_atelier|_host)\//

export const WAKING_HTML = '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Atelier — waking</title><pre>waking the workspace host… this page retries every 3 s</pre>'

// companyOf(pathname, known) → the workspace a path names, or null
export function companyOf(pathname, known) {
  const segs = pathname.split('/').filter(Boolean)
  const first = segs[0], second = segs[1]
  if (first === 'api' || first === 'modules') return second && known(second) ? second : null
  return first && known(first) ? first : null
}

/** startShell({ cfg, workspace, log }) → { listen(): Promise<{port}>, close(): Promise<void> } */
export function startShell({ cfg, workspace, log = () => {} }) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 })
  const hosts = workspace.hosts
  const known = (ws) => hosts.workspaces().some((w) => w.id === ws)
  const hostFor = (pathname) => { const ws = companyOf(pathname, known) ?? hosts.workspaces()[0]?.id; return ws ? hosts.row(ws) : null }
  const fwdHeaders = (req, row) => {
    const h = {}
    for (const [k, v] of Object.entries(req.headers)) if (!STRIP_REQ.test(k)) h[k] = v
    h[DEV_TOKEN_HEADER] = row.token
    h.host = `127.0.0.1:${row.port}`
    return h
  }
  const waking = (req, res) => {
    if (res.headersSent) { res.destroy(); return }
    if (FETCH_RE.test(req.url) || req.method !== 'GET') { res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '2', 'x-atelier-waking': '1', 'cache-control': 'no-store' }); res.end('{"waking":true}'); return }
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '3', 'cache-control': 'no-store' }); res.end(WAKING_HTML)
  }
  function onRequest(req, res) {
    let pathname
    try { pathname = new URL(req.url, 'http://local').pathname } catch { res.writeHead(400); return res.end('{}') }
    const row = hostFor(pathname)
    if (!row) return waking(req, res)
    const up = http.request({ host: row.ip, port: row.port, method: req.method, path: req.url, headers: fwdHeaders(req, row), agent, timeout: DIAL_MS })
    up.on('timeout', () => { if (!up.socket?.connecting) return; up.destroy(new Error('dial timeout')) })
    up.on('error', (e) => { log(`proxy ${req.method} ${req.url}: ${e.code ?? e.message}`); waking(req, res) })
    up.on('response', (r) => {
      const h = {}
      for (const [k, v] of Object.entries(r.headers)) if (!STRIP_RES.test(k)) h[k] = v
      res.writeHead(r.statusCode, h)
      r.pipe(res)
    })
    req.pipe(up)
  }
  function onUpgrade(req, socket, head) {
    let pathname
    try { pathname = new URL(req.url, 'http://local').pathname } catch { return socket.destroy() }
    if (pathname !== '/_atelier/ws') { try { socket.write('HTTP/1.1 426 Upgrade Required\r\nconnection: close\r\ncontent-length: 0\r\n\r\n') } catch {}; return socket.destroy() }
    const row = hostFor(pathname)
    if (!row) { try { socket.write('HTTP/1.1 503 Service Unavailable\r\nretry-after: 2\r\nconnection: close\r\ncontent-length: 0\r\n\r\n') } catch {}; return socket.destroy() }
    const headers = fwdHeaders(req, row)
    headers.connection = 'Upgrade'; headers.upgrade = req.headers.upgrade
    const up = http.request({ host: row.ip, port: row.port, method: 'GET', path: req.url, headers, timeout: DIAL_MS })
    up.on('error', () => socket.destroy())
    up.on('response', (r) => { try { socket.write(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`) } catch {}; socket.destroy(); r.resume() })
    up.on('upgrade', (r, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${r.statusCode} ${r.statusMessage}`]
      for (const [k, v] of Object.entries(r.headers)) lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      socket.write(lines.join('\r\n') + '\r\n\r\n')
      if (upHead?.length) socket.write(upHead)
      if (head?.length) upSocket.write(head)
      upSocket.pipe(socket); socket.pipe(upSocket)
      upSocket.on('error', () => socket.destroy()); socket.on('error', () => upSocket.destroy())
      upSocket.on('close', () => socket.destroy()); socket.on('close', () => upSocket.destroy())
    })
    up.end()
  }
  const server = http.createServer(onRequest)
  server.on('upgrade', onUpgrade)
  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(cfg.port, cfg.bind, () => { server.off('error', reject); resolve({ port: server.address().port }) })
      })
    },
    close() {
      agent.destroy()
      return new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) })
    },
    kind: 'stub-proxy',
  }
}
