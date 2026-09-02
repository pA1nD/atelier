// shell/index.mjs — createShell({cfg, providers, log}) (DESIGN §1): wires the route matrix, the
// document, the assets, the proxy and the events socket around the five providers. One shell,
// constructed once; `handle(req, res)` and `upgrade(req, socket, head)` are the two entry points,
// `listen()` binds `cfg.bind:cfg.port`, `close(drainMs)` drains. Every request ends in one
// `trace({method, path, status, lane, ms})` call (the log line, the tests' lane table).
import http from 'node:http'
import { companyTopic } from '../protocol/index.js'
import { dispatch } from './routes.mjs'
import { createAssets } from './assets.mjs'
import { createEventsSocket } from './events.mjs'
import { createWakingMarks, createWaker } from './waking.mjs'
import { createMetrics } from './metrics.mjs'
import { createChromeStore } from './chrome-store.mjs'

export const LISTENER_DRAIN_MS = 25_000

// a response shim for the upgrade path: lanes that refuse an upgrade write a plain HTTP response onto the socket
function socketResponse(socket) {
  let sent = false
  return {
    get headersSent() { return sent },
    writeHead(status, headers = {}) {
      sent = true
      const lines = [`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ''}`, 'connection: close']
      for (const [k, v] of Object.entries(headers)) for (const x of [].concat(v)) lines.push(`${k}: ${x}`)
      try { socket.write(lines.join('\r\n') + '\r\n\r\n') } catch {}
    },
    end(body) { try { if (body) socket.write(body); socket.end() } catch {} },
    destroy() { try { socket.destroy() } catch {} },
    flushHeaders() {},
    on() {}, once() {},
  }
}

/**
 * createShell({ cfg, providers: {identity, registry, gate, bus, hostLink}, log, trace, assets, now })
 *   → { listen(), close(drainMs), handle(req, res), upgrade(req, socket, head), events, assets, metrics, start(), stop() }
 */
export function createShell({ cfg, providers, log = () => {}, trace = null, assets = null, now = Date.now, repoRoot, clientDir }) {
  const { identity, registry, gate, bus, hostLink } = providers
  for (const [k, v] of Object.entries({ identity, registry, gate, bus, hostLink })) if (!v) throw new Error(`createShell: provider ${k} is missing`)
  assets ??= createAssets({ repoRoot, clientDir, nodeEnv: cfg.nodeEnv, log })
  // the chrome store (step 7 ship C): `cfg.chromeStore` = `${ARTIFACTS_MOUNT}/_chromes` in the fleet (the portal sets it),
  // nothing locally — without it `/_chrome/<digest>/…` is 404 and every document composes the chrome row's path
  const chromeStore = cfg.chromeStore ? createChromeStore({ root: cfg.chromeStore, log }) : null
  const metrics = createMetrics({ now })
  const events = createEventsSocket({ bus, registry, log, now, metrics })
  const entryCache = new Map()
  const marks = createWakingMarks()
  const waker = createWaker({ registry, now, log })
  const watches = new Map()
  const ensureWatch = (company) => {
    if (watches.has(company)) return
    watches.set(company, registry.watch(company, () => { bus.publish(companyTopic(company)); log(`rail: ${company} changed → company:${company} invalidate`) }))
  }
  const server = http.createServer((req, res) => handle(req, res))
  server.on('upgrade', (req, socket, head) => upgrade(req, socket, head))
  server.keepAliveTimeout = 65_000

  const base = (req) => ({ req, cfg, providers, gate, assets, chromeStore, events, metrics, log, now, entryCache, marks, waker, ensureWatch, method: req.method, rawUrl: req.url, hostCompany: null, identity: null, person: null, credential: 'none', company: null, op: false, upgrade: false })

  function finish(ctx, out, t0) {
    const res = ctx.res
    if (!out.handled) {
      const headers = { ...(out.headers ?? {}) }
      const hsts = gate.hsts?.(ctx.req)
      if (hsts) headers['strict-transport-security'] = hsts
      if (out.body !== undefined && !res.headersSent) {
        const buf = Buffer.isBuffer(out.body) ? out.body : Buffer.from(out.body)
        headers['content-length'] = buf.length
        res.writeHead(out.status, headers)
        res.end(ctx.method === 'HEAD' ? undefined : buf)
      } else if (!res.headersSent) { headers['content-length'] = 0; res.writeHead(out.status, headers); res.end() }
    }
    const rec = { method: ctx.method, path: ctx.path ?? ctx.rawUrl, status: out.status ?? res.statusCode, lane: out.lane, ms: now() - t0, upgrade: ctx.upgrade }
    trace?.(rec)
    if (rec.status >= 400 || rec.lane === 'document') log(`${ctx.upgrade ? 'ws' : 'req'} ${rec.method} ${rec.path} → ${rec.status} [${rec.lane}] ${rec.ms} ms`)
  }

  async function handle(req, res) {
    const t0 = now()
    const ctx = { ...base(req), res }
    try {
      const out = await dispatch(ctx)
      finish(ctx, out, t0)
    } catch (e) {
      log(`req ${req.method} ${req.url}: ${e?.stack ?? e}`)
      if (!res.headersSent) { const b = Buffer.from('{}'); res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'cache-control': 'no-store' }); res.end(b) } else res.destroy()
      trace?.({ method: req.method, path: req.url, status: 500, lane: 'error', ms: now() - t0 })
    }
  }

  async function upgrade(req, socket, head) {
    const t0 = now()
    const res = socketResponse(socket)
    const ctx = { ...base(req), res, socket, head, upgrade: true }
    try {
      const out = await dispatch(ctx)
      finish(ctx, out, t0)
      if (!out.handled) socket.destroy()
    } catch (e) { log(`ws ${req.url}: ${e?.stack ?? e}`); try { socket.destroy() } catch {} }
  }

  let started = false
  return {
    server, events, assets, chromeStore, metrics, entryCache, marks,
    start() { if (started) return; started = true; bus.start?.(); registry.start?.(); for (const c of registry.companies?.() ?? []) ensureWatch(c.id) },
    stop() { started = false; for (const off of watches.values()) { try { off() } catch {} } watches.clear(); registry.stop?.(); bus.stop?.() },
    handle, upgrade,
    listen: ({ port = cfg.port, host = cfg.bind } = {}) => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => { server.off('error', reject); const a = server.address(); log(`shell: listening ${a.address}:${a.port} (${cfg.mode})`); resolve({ port: a.port, host: a.address }) })
    }),
    close(drainMs = LISTENER_DRAIN_MS) {
      this.stop(); events.close(); hostLink.close?.(); assets.close?.(); chromeStore?.close()
      return new Promise((resolve) => {
        server.closeIdleConnections?.()
        const t = setTimeout(() => server.closeAllConnections?.(), drainMs); t.unref?.()
        server.close(() => { clearTimeout(t); resolve() })
      })
    },
  }
}
