// Shared fakes for the protocol-server lane's tests (host/test/protocol-*.test.js). Not a test file.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { mint } from '../../protocol/index.js'

export const tmp = () => fs.mkdtempSync(path.join('/tmp', 'atp-'))   // short: macOS caps a socket path at 104 bytes
export const keys = () => generateKeyPairSync('ed25519')

export function fakeRegistrar({ hostId = 'computer-1', epoch = 'e1', token = 'tok1', startedAt = Date.now() - 10_000, publicKey = null, principal = { id: 'p-agent', name: 'Bayard' }, company = 'acme', origin = 'http://127.0.0.1:1844', apps = new Map() } = {}) {
  const r = { hostId, epoch, token, startedAt, principal, company, origin, served: [], publicKey: () => publicKey, apps: () => apps }
  r.served.push = Array.prototype.push
  r.served = (i) => { r.servedList.push(i) }
  r.servedList = []
  return r
}

export function fakeCollector() {
  const running = new Map(), reports = [], recent = new Map()
  return {
    running: (i) => running.get(i), setRunning: (i, rev) => running.set(i, rev),
    report: (kind, instance, rev, detail) => reports.push({ kind, instance, rev, detail }),
    recent: (i) => recent.get(i) ?? [], reports, setRecent: (i, v) => recent.set(i, v),
  }
}

// fakeSupervisor({rows}): resolve/apps/handle/asset. handle echoes the user and counts the body
// bytes as JSON; `?big=N` streams N bytes back in 64 KiB chunks. asset serves per-rev bytes.
export function fakeSupervisor({ rows = [], assets = {} } = {}) {
  const handled = []
  return {
    rows, handled,
    apps: () => rows,
    workers: () => rows.filter((r) => r.state === 'live').map((r) => ({ instance: r.instance, pid: 1, uid: r.uid, dataDir: r.dataDir, sock: r.sock })),
    resolve: (company, slug) => rows.find((r) => r.company === company && r.slug === slug) ?? null,
    handle: (row, req, res, user) => new Promise((resolve) => {
      let bytes = 0
      req.on('data', (c) => { bytes += c.length })
      req.on('end', () => {
        handled.push({ instance: row.instance, method: req.method, url: req.url, user, bytes })
        const big = /[?&]big=(\d+)/.exec(req.url)
        if (big) {
          res.writeHead(200, { 'content-type': 'application/octet-stream' })
          let n = Number(big[1]); const chunk = Buffer.alloc(65536, 0x78)
          const pump = () => { while (n > 0) { const c = n >= chunk.length ? chunk : chunk.subarray(0, n); n -= c.length; if (!res.write(c)) return res.once('drain', pump) } res.end(); resolve() }
          return pump()
        }
        const body = JSON.stringify({ ok: true, instance: row.instance, user, method: req.method, url: req.url, bytes })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(body); resolve()
      })
    }),
    asset: async (row, rel, { rev } = {}) => {
      const a = assets[row.instance]?.[rel]
      if (!a) return null
      const want = rev ?? row.rev
      const hit = a.find((x) => x.rev === want)
      return hit ? { body: Buffer.from(hit.body), type: hit.type, rev: hit.rev } : null
    },
  }
}

export const assertionFor = (priv, { hostId, instance, method, path: p, person = { id: 'p1', name: 'Ada' }, now = Math.floor(Date.now() / 1000) }) =>
  mint(priv, { aud: hostId, app: instance, method, path: p, person }, { now })

// request(target, opts) → {status, headers, body:Buffer}. target = {socketPath} | {port, host}
export function request(target, { method = 'GET', path: p = '/', headers = {}, body, onData } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...target, method, path: p, headers }, (res) => {
      const chunks = []; let bytes = 0
      res.on('data', (c) => { bytes += c.length; if (onData) onData(c); else chunks.push(c) })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), bytes }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('socket', (s) => s.on('error', () => {}))     // a server that cuts a body mid-write (413) EPIPEs the client after the response
    if (body && typeof body.pipe === 'function') body.pipe(req)
    else req.end(body)
  })
}

export const memoryFsx = () => { const files = new Map(); return { files, readFile: (p) => files.get(p)?.data ?? null, writeFile: (p, data, mode) => files.set(p, { data: String(data), mode }) } }
export const platformTmp = () => os.tmpdir()
