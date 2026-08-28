// host/worker/proxy.mjs — real sockets: a fake worker on a Unix socket, a front listener on 127.0.0.1 that
// calls proxyRequest. Streams 1 MiB in / 4 MiB out with byte counts (C3), header filters both ways,
// the identity headers from the verified user, 502/504/426/400/413/404 mapping, client disconnect.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { PassThrough } from 'node:stream'
import { proxyRequest, userHeaders } from '../worker/proxy.mjs'

const MB = 1024 * 1024
const user = { id: 'p1', name: 'Björn', claims: { role: 'admin' } }

async function harness(t, opts = {}) {
  const root = fs.mkdtempSync(path.join('/tmp', 'atp-'))
  const sock = path.join(root, 'w.sock')
  const seen = { closed: 0, requests: [] }
  const worker = http.createServer((req, res) => {
    seen.requests.push({ method: req.method, url: req.url, headers: req.headers })
    const p = req.url.split('?')[0]
    if (p === '/echo') { res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'a=1', 'x-custom': 'no', etag: '"e1"', 'www-authenticate': 'Basic', location: '/x' }); return res.end(JSON.stringify({ headers: req.headers, url: req.url })) }
    if (req.url === '/upload') { let n = 0; req.on('data', (c) => { n += c.length }); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ bytes: n })) }); return }
    if (req.url === '/big') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); const chunk = Buffer.alloc(MB, 1); let i = 0; const w = () => { while (i < 4) { i++; if (!res.write(chunk)) return res.once('drain', w) } res.end() }; return w() }
    if (req.url === '/slow') { res.on('close', () => { seen.closed++ }); return }
    if (req.url === '/fail') { res.writeHead(503, { 'content-type': 'text/plain' }); return res.end('nope') }
    if (req.url === '/rel') { res.writeHead(302, { location: 'items/2' }); return res.end() }
    if (req.url === '/abs') { res.writeHead(302, { location: 'https://accounts.example/oauth' }); return res.end() }
    res.writeHead(404); res.end()
  })
  await new Promise((r) => worker.listen(sock, r))
  const calls = []
  const front = http.createServer(async (req, res) => {
    const out = await proxyRequest({ sock: opts.sock ?? sock, req, res, user, path: req.url.replace(/^\/api\/acme\/demo/, '') || '/', mount: '/api/acme/demo', ...opts.proxy })
    calls.push(out)
  })
  await new Promise((r) => front.listen(0, '127.0.0.1', r))
  const port = front.address().port
  t.after(() => { front.close(); worker.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const send = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => { const buf = Buffer.concat(chunks); let json = null; try { json = JSON.parse(buf.toString()) } catch {} ; resolve({ status: res.statusCode, headers: res.headers, buf, json }) })
      res.on('error', () => resolve({ status: 'cut', headers: res.headers, buf: Buffer.concat(chunks), json: null }))   // a body cut mid-stream (the response cap)
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
  return { sock, seen, calls, send, port }
}
const last = (calls) => calls[calls.length - 1]

test('headers both ways + the identity headers from the verified user', async (t) => {
  const { send, calls } = await harness(t)
  const r = await send('GET', '/api/acme/demo/echo?q=1', { headers: { cookie: 'sid=1', authorization: 'Bearer x', 'x-atelier-identity': 'forged', 'x-atelier-user': 'forged', 'x-forwarded-for': '1.2.3.4', accept: 'application/json', range: 'bytes=0-1', 'if-none-match': '"e0"' } })
  assert.equal(r.status, 200)
  assert.equal(r.json.url, '/echo?q=1')
  const h = r.json.headers
  assert.equal(h.cookie, undefined)
  assert.equal(h.authorization, undefined)
  assert.equal(h['x-atelier-identity'], undefined)
  assert.equal(h['x-forwarded-for'], undefined)
  assert.equal(h.accept, 'application/json')
  assert.equal(h.range, 'bytes=0-1')
  assert.equal(h['if-none-match'], '"e0"')
  assert.equal(h['x-atelier-user'], 'p1')
  assert.equal(h['x-atelier-name'], encodeURIComponent('Björn'))
  assert.equal(h['x-atelier-claims'], '{"role":"admin"}')
  // response: allowlist only — set-cookie / www-authenticate / x-custom never reach the company origin; etag + location pass
  assert.equal(r.headers['set-cookie'], undefined)
  assert.equal(r.headers['www-authenticate'], undefined)
  assert.equal(r.headers['x-custom'], undefined)
  assert.equal(r.headers.etag, '"e1"')
  assert.equal(r.headers.location, '/api/acme/demo/x', 'a root-absolute Location is rewritten onto the mount by the HOST (L1.6)')
  assert.equal(r.headers['content-type'], 'application/json')
  assert.equal(last(calls).status, 200)
})

test('streams 1 MiB in and 4 MiB out with byte counts; a worker 5xx passes through', async (t) => {
  const { send, calls } = await harness(t)
  const up = await send('POST', '/api/acme/demo/upload', { headers: { 'content-type': 'application/octet-stream', 'content-length': String(MB) }, body: Buffer.alloc(MB, 7) })
  assert.deepEqual(up.json, { bytes: MB })
  assert.equal(last(calls).bytesIn, MB)
  const big = await send('GET', '/api/acme/demo/big')
  assert.equal(big.status, 200)
  assert.equal(big.buf.length, 4 * MB)
  assert.equal(last(calls).bytesOut, 4 * MB)
  const f = await send('GET', '/api/acme/demo/fail')
  assert.equal(f.status, 503)
  assert.equal(f.buf.toString(), 'nope')
  assert.equal(last(calls).status, 503)
})

test('Location: relative and absolute pass unchanged; only root-absolute is rewritten onto the mount; no mount → unchanged', async (t) => {
  const { send } = await harness(t)
  assert.equal((await send('GET', '/api/acme/demo/rel')).headers.location, 'items/2')
  assert.equal((await send('GET', '/api/acme/demo/abs')).headers.location, 'https://accounts.example/oauth')
  const h2 = await harness(t, { proxy: { mount: '' } })
  assert.equal((await h2.send('GET', '/api/acme/demo/echo')).headers.location, '/x')
})

test('the body budget cuts a response past the cap (the shell sees a truncated body, never an over-budget one); bytesOut counts what passed', async (t) => {
  const { send, calls } = await harness(t, { proxy: { bodyCap: 1000 * 1000 } })
  const r = await send('GET', '/api/acme/demo/big')
  assert.equal(r.status, 'cut'); assert.ok(r.buf.length < 4 * MB, `got ${r.buf.length}`)
  assert.equal(last(calls).status, 200)
  assert.ok(last(calls).bytesOut >= 1000 * 1000 && last(calls).bytesOut < 4 * MB, `bytesOut ${last(calls).bytesOut}`)
})

test('502 when the socket is gone, 504 without response headers in time, 426 on Upgrade, 404 for /_atelier/*, 413 past the body cap', async (t) => {
  const { send, calls } = await harness(t, { sock: '/tmp/atp-nope.sock', proxy: { timeoutMs: 200, bodyCap: 1000 } })
  const gone = await send('GET', '/api/acme/demo/echo')
  assert.equal(gone.status, 502)
  assert.equal(gone.json.error, 'worker unavailable')
  assert.equal(last(calls).status, 502)
  const h2 = await harness(t, { proxy: { timeoutMs: 150, bodyCap: 1000 } })
  const slow = await h2.send('GET', '/api/acme/demo/slow')
  assert.equal(slow.status, 504)
  assert.deepEqual(slow.json, { error: 'worker timeout' })
  const upg = await h2.send('GET', '/api/acme/demo/echo', { headers: { upgrade: 'websocket', connection: 'upgrade' } })
  assert.equal(upg.status, 426)
  const health = await h2.send('GET', '/api/acme/demo/_atelier/health')
  assert.equal(health.status, 404)
  assert.equal(h2.seen.requests.filter((r) => r.url.startsWith('/_atelier')).length, 0)
  const big = await h2.send('POST', '/api/acme/demo/upload', { headers: { 'content-type': 'application/octet-stream', 'content-length': '5000' }, body: Buffer.alloc(5000, 1) }).catch((e) => ({ status: 'err', e }))
  assert.equal(big.status, 413)
  assert.equal(last(h2.calls).status, 413)
})

test('client disconnect (res close, not finished) releases the worker', async (t) => {
  const { seen, calls, port } = await harness(t, { proxy: { timeoutMs: 5000 } })
  const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/acme/demo/slow' })
  req.on('error', () => {})
  req.end()
  await new Promise((r) => setTimeout(r, 100))
  req.destroy()
  const t0 = Date.now()
  while (seen.closed === 0 && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 20))
  assert.equal(seen.closed, 1)
  assert.equal(calls.length, 1)
})

test('ambiguous framing (content-length + transfer-encoding) is refused with 400 before any dial', async () => {
  const req = new PassThrough()
  Object.assign(req, { method: 'POST', url: '/x', headers: { 'content-length': '5', 'transfer-encoding': 'chunked' } })
  const res = { headersSent: false, writableEnded: false, status: null, body: '', writeHead(s) { this.status = s; this.headersSent = true }, end(b) { this.body = b; this.writableEnded = true; this.writableFinished = true }, on() {} }
  const out = await proxyRequest({ sock: '/tmp/never.sock', req, res, user })
  assert.equal(res.status, 400)
  assert.deepEqual(out, { status: 400, bytesIn: 0, bytesOut: 0 })
})

test('userHeaders is latin1-safe (percent-encoded name, ASCII-escaped claims)', () => {
  const h = userHeaders({ id: 'p1', name: 'Ünïcode 名', claims: { k: 'ä' } })
  for (const v of Object.values(h)) assert.ok(/^[\x20-\x7e]*$/.test(v), v)
  assert.equal(h['x-atelier-claims'], '{"k":"\\u00e4"}')
})
