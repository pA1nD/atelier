// shell/proxy.mjs + providers/hostlink-{local,fleet}: header lists both ways, counted bodies, the
// 503-waking mapping, SSE chunks flushed before end, the assertion verified at the fake host.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { PassThrough } from 'node:stream'
import { proxyRequest } from '../proxy.mjs'
import { createMinter } from '../minter.mjs'
import { createHostLinkLocal } from '../providers/hostlink-local.mjs'
import { createHostLinkFleet } from '../providers/hostlink-fleet.mjs'
import { verify, publicKeyFromHex } from '../../protocol/index.js'

const person = { id: 'local', name: 'local', claims: {} }
const app = { instance: 'i-0123456789abcdef', company: 'acme', slug: 'todo' }
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))

// a fake host that records what it saw and answers by path
function fakeHost() {
  const seen = []
  const server = http.createServer(async (req, res) => {
    const chunks = []; try { for await (const c of req) chunks.push(c) } catch { return res.destroy() }   // the shell cut the request (BODY_CAP)
    const body = Buffer.concat(chunks)
    seen.push({ method: req.method, url: req.url, headers: req.headers, bytes: body.length })
    const u = new URL(req.url, 'http://h')
    if (u.pathname.endsWith('/headers')) {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'a=b', 'www-authenticate': 'Basic realm=x', 'x-custom': '1', 'location': '/api/acme/todo/next', 'access-control-allow-origin': u.searchParams.get('acao') ?? 'https://evil.example', 'access-control-allow-credentials': 'true', 'etag': '"rev-3"' })
      return res.end('{}')
    }
    if (u.pathname.endsWith('/big')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); const chunk = Buffer.alloc(64 * 1024, 1); for (let i = 0; i < 64; i++) res.write(chunk); return res.end() }
    if (u.pathname.endsWith('/sse')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: one\n\n'); setTimeout(() => { res.write('data: two\n\n'); res.end() }, 300); return }
    if (u.pathname.endsWith('/echo')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ bytes: body.length })) }
    if (u.pathname.endsWith('/slow')) { setTimeout(() => { res.writeHead(200); res.end('late') }, 800); return }
    res.writeHead(404); res.end()
  })
  return { server, seen }
}

// the shell side: a listening server whose only handler proxies to the fake host
function rig({ hostLink, hostRow, credential = 'none', companyOrigin = null, capIn, capOut }) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://s')
    proxyRequest({ req, res, hostLink, hostRow, app, person, credential, companyOrigin, forwardPath: u.pathname + u.search, capIn, capOut }).catch((e) => { if (!res.headersSent) { res.writeHead(500); res.end(String(e)) } })
  })
  return server
}

test('request headers: forged x-atelier-*, cookie, authorization never reach the host; identity + dev token added; assertion verifies with the forwarded path', async () => {
  const host = fakeHost(); const hp = await listen(host.server)
  const now = Math.floor(Date.now() / 1000)
  const minter = createMinter()
  const link = createHostLinkLocal({ minter })
  const hostRow = { hostId: 'local', ip: '127.0.0.1', port: hp, token: 'dev-secret' }
  const shell = rig({ hostLink: link, hostRow }); const sp = await listen(shell)
  const r = await fetch(`http://127.0.0.1:${sp}/api/acme/todo/headers?q=1&acao=x`, { headers: { cookie: 'sess=1', authorization: 'Bearer nope', 'x-atelier-user': 'admin', 'x-atelier-identity': 'forged.sig', 'x-forwarded-for': '1.2.3.4', 'user-agent': 'ua/1', 'if-none-match': '"rev-2"' } })
  assert.equal(r.status, 200)
  const h = host.seen[0].headers
  assert.equal(h.cookie, undefined); assert.equal(h.authorization, undefined); assert.equal(h['x-atelier-user'], undefined); assert.equal(h['x-forwarded-for'], undefined)
  assert.equal(h['x-atelier-dev-token'], 'dev-secret'); assert.equal(h['user-agent'], 'ua/1'); assert.equal(h['if-none-match'], '"rev-2"')
  assert.ok(h['x-atelier-identity'] && !h['x-atelier-identity'].startsWith('forged'))
  const v = verify(publicKeyFromHex(minter.publicKeyHex), h['x-atelier-identity'], { hostId: 'local', instanceId: app.instance, method: 'GET', path: host.seen[0].url, now: now + 1, hostStartedAt: now - 5 })
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.equal(host.seen[0].url, '/api/acme/todo/headers?q=1&acao=x')
  // response headers on the assertion path (credential none): set-cookie / www-authenticate / x-custom cut, location as-is, ACAO passes
  assert.equal(r.headers.get('set-cookie'), null); assert.equal(r.headers.get('www-authenticate'), null); assert.equal(r.headers.get('x-custom'), null)
  assert.equal(r.headers.get('location'), '/api/acme/todo/next'); assert.equal(r.headers.get('etag'), '"rev-3"')
  assert.equal(r.headers.get('access-control-allow-origin'), 'x')
  shell.close(); host.server.close(); link.close()
})

test('cookie-credentialed routes: every access-control-* cut except an ACAO equal to the company origin; the fleet bearer carries the epoch', async () => {
  const host = fakeHost(); const hp = await listen(host.server)
  const link = createHostLinkFleet({ minter: createMinter() })
  const hostRow = { hostId: 'c-9', ip: '127.0.0.1', port: hp, epoch: 'e1', token: 'tok', tls: null }
  const shell = rig({ hostLink: link, hostRow, credential: 'cookie', companyOrigin: 'https://acme.portal.pa1nd.de' }); const sp = await listen(shell)
  const bad = await fetch(`http://127.0.0.1:${sp}/api/acme/todo/headers`)
  assert.equal(bad.headers.get('access-control-allow-origin'), null); assert.equal(bad.headers.get('access-control-allow-credentials'), null)
  const good = await fetch(`http://127.0.0.1:${sp}/api/acme/todo/headers?acao=${encodeURIComponent('https://acme.portal.pa1nd.de')}`)
  assert.equal(good.headers.get('access-control-allow-origin'), 'https://acme.portal.pa1nd.de'); assert.equal(good.headers.get('access-control-allow-credentials'), null)
  assert.equal(host.seen[0].headers.authorization, 'Bearer e1.tok')
  shell.close(); host.server.close(); link.close()
})

test('counted bodies: 1 MiB in / 4 MiB out streamed; 413 at cap+1', async () => {
  const host = fakeHost(); const hp = await listen(host.server)
  const link = createHostLinkLocal({ minter: createMinter() })
  const hostRow = { hostId: 'local', ip: '127.0.0.1', port: hp, token: 't' }
  const shell = rig({ hostLink: link, hostRow, capIn: 1024 * 1024 }); const sp = await listen(shell)
  const inBody = Buffer.alloc(1024 * 1024, 7)
  const r = await fetch(`http://127.0.0.1:${sp}/api/acme/todo/echo`, { method: 'POST', body: inBody, headers: { 'content-type': 'application/octet-stream' } })
  assert.deepEqual(await r.json(), { bytes: 1024 * 1024 })
  const big = await fetch(`http://127.0.0.1:${sp}/api/acme/todo/big`)
  assert.equal((await big.arrayBuffer()).byteLength, 4 * 1024 * 1024)
  const over = await fetch(`http://127.0.0.1:${sp}/api/acme/todo/echo`, { method: 'POST', body: Buffer.alloc(1024 * 1024 + 1), headers: { 'content-type': 'application/octet-stream' } })
  assert.equal(over.status, 413)
  // a chunked body past the cap (no content-length): 413 too (the request is cut mid-stream)
  const chunked = await new Promise((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port: sp, method: 'POST', path: '/api/acme/todo/echo', headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); res.on('error', () => resolve(res.statusCode)) })
    rq.on('error', (e) => resolve('error:' + e.code))
    for (let i = 0; i < 5; i++) rq.write(Buffer.alloc(300 * 1024))
    rq.end()
  })
  assert.ok(chunked === 413 || String(chunked).startsWith('error'), String(chunked))
  shell.close(); host.server.close(); link.close()
})

test('framing: content-length + transfer-encoding on the raw request is a 400', async () => {
  const host = fakeHost(); const hp = await listen(host.server)
  const link = createHostLinkLocal({ minter: createMinter() })
  const shell = rig({ hostLink: link, hostRow: { hostId: 'local', ip: '127.0.0.1', port: hp, token: 't' } }); const sp = await listen(shell)
  const status = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: sp, method: 'POST', path: '/api/acme/todo/echo', headers: { 'content-length': '3', 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode) })
    req.on('error', () => resolve('error'))
    req.end('abc')
  })
  assert.ok(status === 400 || status === 'error', String(status))   // node itself refuses CL+TE on some versions — either way, never proxied
  assert.equal(host.seen.length, 0)
  shell.close(); host.server.close(); link.close()
})

test('ECONNREFUSED → 503 {waking:true} within dialMs; idle timeout between bytes → TIMEOUT', async () => {
  const link = createHostLinkLocal({ minter: createMinter(), dialMs: 500, idleMs: 300 })
  const dead = http.createServer(); const dp = await listen(dead); await new Promise((r) => dead.close(r))
  const shell = rig({ hostLink: link, hostRow: { hostId: 'local', ip: '127.0.0.1', port: dp, token: 't' } }); const sp = await listen(shell)
  const t0 = Date.now()
  const r = await fetch(`http://127.0.0.1:${sp}/api/acme/todo/x`)
  assert.equal(r.status, 503); assert.deepEqual(await r.json(), { waking: true })
  assert.equal(r.headers.get('retry-after'), '2'); assert.equal(r.headers.get('x-atelier-waking'), '1')
  assert.ok(Date.now() - t0 < 1500)
  // an upstream that answers nothing for 800 ms with idle 300 ms → 503 waking (TIMEOUT before headers)
  const host = fakeHost(); const hp = await listen(host.server)
  const shell2 = rig({ hostLink: link, hostRow: { hostId: 'local', ip: '127.0.0.1', port: hp, token: 't' } }); const sp2 = await listen(shell2)
  const slow = await fetch(`http://127.0.0.1:${sp2}/api/acme/todo/slow`)
  assert.equal(slow.status, 503)
  shell.close(); shell2.close(); host.server.close(); link.close()
})

test('SSE: the first chunk reaches the client before the upstream ends', async () => {
  const host = fakeHost(); const hp = await listen(host.server)
  const link = createHostLinkLocal({ minter: createMinter() })
  const shell = rig({ hostLink: link, hostRow: { hostId: 'local', ip: '127.0.0.1', port: hp, token: 't' } }); const sp = await listen(shell)
  const r = await fetch(`http://127.0.0.1:${sp}/api/acme/todo/sse`)
  const reader = r.body.getReader()
  const t0 = Date.now()
  const first = await reader.read()
  assert.equal(Buffer.from(first.value).toString(), 'data: one\n\n')
  assert.ok(Date.now() - t0 < 250, 'first chunk waited for the end')
  let rest = ''; for (;;) { const { value, done } = await reader.read(); if (done) break; rest += Buffer.from(value).toString() }
  assert.equal(rest, 'data: two\n\n')
  shell.close(); host.server.close(); link.close()
})

test('probe: /_host/healthz with the credential; a dead port is {ok:false} within dialMs', async () => {
  const seen = []
  const host = http.createServer((req, res) => { seen.push(req.headers); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ api: 'atelier/2', hostId: 'local', epoch: 'e7', apps: 2 })) })
  const hp = await listen(host)
  const link = createHostLinkLocal({ minter: createMinter(), dialMs: 400 })
  const ok = await link.probe({ hostId: 'local', ip: '127.0.0.1', port: hp, token: 'dev' })
  assert.deepEqual(ok, { ok: true, hostId: 'local', epoch: 'e7', apps: 2 })
  assert.equal(seen[0]['x-atelier-dev-token'], 'dev'); assert.equal(seen[0]['x-atelier-identity'], undefined)
  await new Promise((r) => host.close(r))
  const t0 = Date.now()
  const dead = await link.probe({ hostId: 'local', ip: '127.0.0.1', port: hp, token: 'dev' })
  assert.equal(dead.ok, false); assert.ok(Date.now() - t0 < 1000)
  link.close()
})
