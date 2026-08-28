// shell/providers/hostlink-base.mjs — the wire to a host, shared by the two hostLink providers
// (DESIGN §1.5, §3.3). One dial per request: connect capped at `dialMs` (1 s — a sleeping
// computer costs one second, never a hung request), then an IDLE timeout of `idleMs` between
// bytes (not total: SSE and the 25 s long-poll live). Bodies stream both ways; nothing here
// buffers an app body. The identity assertion is minted here for every request (§3.1) and the
// provider adds its credential (`credential(hostRow)`): the dev token locally, the bearer with
// epoch in the fleet. Errors carry `code`: 'DIAL' (refused / no connect within dialMs),
// 'TIMEOUT' (idle), 'BODY_CAP' (from the counted request body).
import http from 'node:http'
import https from 'node:https'
import { IDENTITY_HEADER } from '../minter.mjs'

export const DIAL_MS = 1000
export const IDLE_MS = 30_000
export const PROBE_PATH = '/_host/healthz'
const DIAL_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EPIPE'])

export const linkError = (code, message) => Object.assign(new Error(message ?? code), { code })

/**
 * createHostLink({ kind, minter, credential, transport, dialMs, idleMs, log })
 *   credential(hostRow) → headers to add (the provider's)
 *   transport(hostRow)  → { lib: http|https, options: {…tls} }   (default: plain http)
 */
export function createHostLink({ kind, minter, credential, transport = () => ({ lib: http, options: {} }), dialMs = DIAL_MS, idleMs = IDLE_MS, log = () => {} }) {
  const agents = { http: new http.Agent({ keepAlive: true, maxSockets: 64 }), https: new https.Agent({ keepAlive: true, maxSockets: 64 }) }

  function dial({ hostRow, method, path, headers, body, idle = idleMs }) {
    return new Promise((resolve, reject) => {
      const t = transport(hostRow)
      const lib = t.lib ?? http
      const req = lib.request({ host: hostRow.ip, port: hostRow.port, method, path, headers, agent: lib === https ? agents.https : agents.http, timeout: dialMs, ...(t.options ?? {}) })
      let connected = false, responded = false, upstream = null
      const fail = (code, msg) => { const e = linkError(code, msg); if (!responded) reject(e); else upstream?.destroy(e); req.destroy(e) }
      const onConnect = () => { connected = true; req.setTimeout(idle) }
      req.on('socket', (s) => { if (s.connecting) s.once('connect', onConnect); else onConnect() })   // a reused keep-alive socket is already connected
      req.on('timeout', () => fail(connected ? 'TIMEOUT' : 'DIAL', connected ? `host idle > ${idle} ms` : `host dial > ${dialMs} ms`))
      req.on('error', (e) => { if (e?.code === 'DIAL' || e?.code === 'TIMEOUT' || e?.code === 'BODY_CAP') { if (!responded) reject(e); return } fail(!connected || DIAL_CODES.has(e?.code) ? 'DIAL' : 'UPSTREAM', e?.message) })
      req.on('response', (res) => { responded = true; upstream = res; resolve({ status: res.statusCode, headers: res.headers, body: res }) })
      if (body && typeof body.pipe === 'function') {
        body.on('error', (e) => req.destroy(e?.code ? e : linkError('UPSTREAM', e?.message)))
        body.pipe(req)
      } else req.end(body ?? undefined)
    })
  }

  return {
    kind, dialMs, idleMs, minter,
    // request({hostRow, app, person, method, path, headers, body}) → {status, headers, body}
    request({ hostRow, app, person, method, path, headers = {}, body = null }) {
      const h = { ...headers, ...credential(hostRow), [IDENTITY_HEADER]: minter.header({ hostId: hostRow.hostId, instance: app.instance, method, path, person }) }
      return dial({ hostRow, method, path, headers: h, body })
    },
    // json({hostRow, path}) → {status, json} — the small host views (healthz, apps, events); credential only, no assertion
    async json({ hostRow, path, method = 'GET', body = null, idle = dialMs }) {
      const payload = body === null ? null : Buffer.from(JSON.stringify(body))
      const headers = { accept: 'application/json', ...credential(hostRow), ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) }
      const r = await dial({ hostRow, method, path, headers, body: payload, idle })
      const chunks = []
      for await (const c of r.body) chunks.push(c)
      const text = Buffer.concat(chunks).toString('utf8')
      let json = null; try { json = text ? JSON.parse(text) : null } catch { json = null }
      return { status: r.status, json }
    },
    // probe(hostRow) → {ok:true, hostId, epoch, apps} | {ok:false, code}
    async probe(hostRow) {
      try {
        const r = await this.json({ hostRow, path: PROBE_PATH })
        if (r.status !== 200 || !r.json) return { ok: false, code: `HTTP_${r.status}` }
        return { ok: true, hostId: r.json.hostId ?? hostRow.hostId, epoch: r.json.epoch ?? null, apps: r.json.apps ?? 0 }
      } catch (e) { log(`hostlink: probe ${hostRow.ip}:${hostRow.port} ${e.code ?? e.message}`); return { ok: false, code: e.code ?? 'UPSTREAM' } }
    },
    close() { agents.http.destroy(); agents.https.destroy() },
  }
}
