// host/protocol/server.mjs — the pod-IP listener, the host's only non-loopback TCP socket
// (DESIGN §4.3 "protocol/server.mjs", §6.5, §9 item 5; PLAN §4.3 "Network", §4.4 "Transport").
//
// Every route is behind the bearer (auth.bearer: token + epoch); the app lanes add the identity
// assertion (auth.verifyRequest) bound to the resolved instance. Bodies are streamed by the
// supervisor's proxy (worker/proxy.mjs applies headers.mjs); this file never buffers an app body.
//
//   GET|… /api/<company>/<slug>/<rest>    → supervisor.handle(row, req, res, user, {slot:'prod'})   404 when unresolved / not deployed
//   GET   /modules/<company>/<slug>/<rel> → supervisor.asset(row, rel, {rev, slot:'prod'})     ?rev=N = an older kept rev
//   (the PROD slot on every app lane — this port is the company's road, DESIGN §10.3 D3; the dev shell serves dev)
//   POST  /_atelier/report                → the kit's frontend report (body.instance must be a row of this host)
//   GET   /_atelier/apps                  → [{instance, slug, company, rev, state, deployed_rev, prod_rev, dev_rev, prod_state, dev_state}]  bearer only
//   GET   /_host/healthz                  → {api, hostId, epoch, uptime, apps}       bearer only
//   GET   /_host/metrics                  → the PLAN §4.5 rows, Prometheus text      bearer only
//   anything else → 404 `{}`; an Upgrade → 426 (no WS lane in 2.0.0, B6)
//
// `req.url` reaches the supervisor untouched: the mount prefix `/api/<company>/<slug>` is
// derivable from the row and is stripped by serve.mjs/proxy.mjs before the worker's router.
// mTLS: `cfg.hostTls = 'cert.pem,key.pem,ca.pem'` turns the listener into https with
// requestCert + rejectUnauthorized. In the fleet it is mandatory (PLAN §4.3 "Beyond uid": a worker's
// dial is TLS-refused before HTTP) — index.mjs refuses to start a fleet host without it; the
// explicit `plain` value is the step-2 drill's opt-out, logged as INSECURE on every start.
// `refuse()` (index.mjs): a non-null reason answers every request 503 — the host-fault state (the
// `.atelier` tree renamed or removed) — before any route runs.
// `close(drainMs)`: stop accepting, close idle keep-alive sockets, let in-flight requests finish for
// up to drainMs (the §4.7 25 s long-poll fits), then cut what is left.
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import { SLUG_RE, PROTOCOL, fromFrontendReport } from '../../protocol/index.js'
import { createMetrics, PROM_CONTENT_TYPE } from '../metrics.mjs'

export const REPORT_BODY_CAP = 64 * 1024
export const DEFAULT_HOST_PORT = 1845

export function json(res, status, body, extra = {}) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store', ...extra })
  res.end(buf)
}

// parseMount(pathname) → {kind:'api'|'modules', company, slug, rest, rel} | null
// company and slug must be one DNS label each (protocol/registry SLUG_RE) — nothing else routes.
export function parseMount(pathname) {
  const m = /^\/(api|modules)\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(pathname)
  if (!m) return null
  const [, kind, company, slug, tail] = m
  if (!SLUG_RE.test(company) || !SLUG_RE.test(slug)) return null
  return { kind, company, slug, rest: '/' + (tail ?? ''), rel: tail ?? '' }
}

// safeRel(rel) → the decoded relative asset path or null (B6 surprise 5: normalise before the gate).
export function safeRel(rel) {
  let d
  try { d = decodeURIComponent(rel) } catch { return null }
  if (!d || d.startsWith('/') || d.includes('\0')) return null
  const parts = d.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null
  return d
}

export function readJson(req, cap = REPORT_BODY_CAP) {
  return new Promise((resolve, reject) => {
    const cl = Number(req.headers['content-length'])
    if (Number.isFinite(cl) && cl > cap) { const e = new Error('body too large'); e.status = 413; req.resume(); return reject(e) }
    const chunks = []; let size = 0, over = false
    req.on('data', (c) => { if (over) return; size += c.length; if (size > cap) { over = true; const e = new Error('body too large'); e.status = 413; reject(e); req.destroy(); return } chunks.push(c) })
    req.on('end', () => { if (over) return; try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch { const e = new Error('bad json'); e.status = 400; reject(e) } })
    req.on('error', reject)
  })
}

export const appsView = (supervisor) => supervisor.apps().map((r) => ({ instance: r.instance, slug: r.slug, company: r.company, rev: r.rev ?? null, state: r.state, deployed_rev: r.deployed_rev ?? null, prod_rev: r.prod_rev ?? null, dev_rev: r.dev_rev ?? null, prod_state: r.prod_state ?? null, dev_state: r.dev_state ?? null }))
export const findInstance = (supervisor, instance) => (typeof instance === 'string' && instance ? supervisor.apps().find((r) => r.instance === instance) ?? null : null)

// serveAssetResult(req, res, asset): the one asset response shape — server and dev shell share it
// (same-bytes, DESIGN §8.1). ETag = the revision; `no-cache` = revalidate every time.
export function serveAssetResult(req, res, asset, { encode } = {}) {
  const etag = `"rev-${asset.rev}"`
  const headers = { 'content-type': asset.type, etag, 'cache-control': 'no-cache' }
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': 'no-cache' }); return res.end() }
  let body = asset.body
  if (encode) { const r = encode(body, asset.type); if (r) { body = r.body; Object.assign(headers, r.headers) } }
  headers['content-length'] = body.length
  res.writeHead(200, headers)
  res.end(body)
}

// The frontend report path when errors/report.mjs is not wired: protocol fromFrontendReport with
// the host's running rev, then collector.report('frontend', …).
export function frontendReportHandler({ collector, now = Date.now }) {
  return (body, { instance }) => {
    const r = fromFrontendReport(body, now(), { rev: collector.running(instance) })
    if (!r.ok) return r
    const { message, stack, sample } = r.ev
    collector.report('frontend', instance, r.ev.rev, { message, stack, sample })
    return { ok: true }
  }
}

export function tlsOptions(spec) {
  const [cert, key, ca] = String(spec).split(',').map((s) => s.trim())
  return { cert: fs.readFileSync(cert), key: fs.readFileSync(key), ca: fs.readFileSync(ca), requestCert: true, rejectUnauthorized: true }
}

/**
 * createServer({ cfg, auth, supervisor, collector, registrar, log, frontendReport, listen, metrics })
 *   listen: {path} for a Unix socket (tests) or {port, host}; default cfg.hostPort on 0.0.0.0.
 *   metrics: the host's metrics.mjs recorder — `/_host/metrics` renders whatever it holds.
 */
export const LISTENER_DRAIN_MS = 25_000
export const HOST_TLS_PLAIN = 'plain'

/** closeDraining(server, drainMs) — the one listener shutdown (the dev shell shares it). */
export function closeDraining(server, drainMs = LISTENER_DRAIN_MS) {
  return new Promise((resolve) => {
    server.closeIdleConnections?.()
    const t = setTimeout(() => server.closeAllConnections?.(), drainMs)
    t.unref?.()
    server.close(() => { clearTimeout(t); resolve() })
  })
}

export function createServer({ cfg = {}, auth, supervisor, collector, registrar, log = () => {}, frontendReport, listen: listenOpts, refuse = () => null, metrics = createMetrics() }) {
  const report = frontendReport ?? frontendReportHandler({ collector })
  const startedAt = Date.now()
  const where = listenOpts ?? { port: cfg.hostPort ?? DEFAULT_HOST_PORT, host: cfg.hostBind ?? '0.0.0.0' }
  const tls = cfg.hostTls && cfg.hostTls !== HOST_TLS_PLAIN ? cfg.hostTls : null

  async function handle(req, res) {
    const fault = refuse()
    if (fault) { req.resume(); return json(res, 503, { error: 'host fault', reason: fault }) }
    let url
    try { url = new URL(req.url, 'http://host') } catch { return json(res, 400, {}) }
    const p = url.pathname
    if (p === '/_host/healthz' && req.method === 'GET') {
      if (!auth.bearer(req).ok) return json(res, 401, {})
      return json(res, 200, { api: PROTOCOL, hostId: registrar.hostId, epoch: registrar.epoch, uptime: Math.round((Date.now() - startedAt) / 1000), apps: supervisor.apps().length })
    }
    if (p === '/_host/metrics' && req.method === 'GET') {
      if (!auth.bearer(req).ok) return json(res, 401, {})
      const buf = Buffer.from(metrics.exposition())
      res.writeHead(200, { 'content-type': PROM_CONTENT_TYPE, 'content-length': buf.length, 'cache-control': 'no-store' })
      return res.end(buf)
    }
    if (p === '/_atelier/apps' && req.method === 'GET') {
      if (!auth.bearer(req).ok) return json(res, 401, {})
      return json(res, 200, appsView(supervisor))
    }
    if (p === '/_atelier/report' && req.method === 'POST') {
      if (!auth.bearer(req).ok) return json(res, 401, {})
      let body
      try { body = await readJson(req) } catch (e) { return json(res, e.status ?? 400, {}) }
      const row = findInstance(supervisor, body?.instance)
      if (!row) return json(res, 404, {})
      const v = auth.verifyRequest(req, { company: row.company, slug: row.slug, instance: row.instance })
      if (!v.ok) return json(res, 401, {})
      const r = report(body, { instance: row.instance })
      return r.ok ? json(res, 200, { ok: true }) : json(res, 400, { ok: false, reason: r.reason })
    }
    const mount = parseMount(p)
    if (!mount) return json(res, 404, {})
    if (!auth.bearer(req).ok) return json(res, 401, {})
    const row = supervisor.resolve(mount.company, mount.slug)
    if (!row) return json(res, 404, {})
    const v = auth.verifyRequest(req, { company: mount.company, slug: mount.slug, instance: row.instance })
    if (!v.ok) return json(res, 401, {})
    if (mount.kind === 'api') {
      registrar.served?.(row.instance)
      return supervisor.handle(row, req, res, v.user, { slot: 'prod' })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, {})
    const rel = safeRel(mount.rel)
    if (!rel) return json(res, 404, {})
    const revQ = url.searchParams.get('rev')
    const rev = revQ !== null && /^\d+$/.test(revQ) ? Number(revQ) : undefined
    const asset = await supervisor.asset(row, rel, { rev, slot: 'prod' })
    if (!asset) return json(res, 404, {})
    return serveAssetResult(req, res, asset)
  }

  const onRequest = (req, res) => { handle(req, res).catch((e) => { log(`server: 500 ${req.method} ${req.url}: ${e?.stack ?? e}`); if (!res.headersSent) json(res, 500, {}); else res.destroy() }) }
  const server = tls ? https.createServer(tlsOptions(tls), onRequest) : http.createServer(onRequest)
  server.on('upgrade', (req, socket) => { socket.end('HTTP/1.1 426 Upgrade Required\r\nconnection: close\r\ncontent-length: 0\r\n\r\n') })

  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      const done = () => { server.off('error', reject); const a = server.address(); log(`server: listening ${typeof a === 'string' ? a : `${a.address}:${a.port}`}${tls ? ' (mTLS)' : cfg.hostTls === HOST_TLS_PLAIN ? ' (INSECURE: plain HTTP by ATELIER_HOST_TLS=plain)' : ''}`); resolve(a) }
      if (where.path) { try { fs.unlinkSync(where.path) } catch {} server.listen(where.path, done) } else server.listen(where.port, where.host, done)
    }),
    close: (drainMs = LISTENER_DRAIN_MS) => closeDraining(server, drainMs),
    address: () => server.address(),
  }
}
