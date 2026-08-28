// host/protocol/headers.mjs — the three lists both ways at runtime, the identity stamp, framing, the body budget.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable, pipeline } from 'node:stream'
import { inbound, outbound, countedBody, stampUser, VERIFIED_IN_BYTES, VERIFIED_OUT_BYTES, BODY_CAP_DEFAULT } from '../protocol/headers.mjs'

const user = { id: 'p1', name: 'Ada', claims: { role: 'x' } }

test('inbound: forged x-atelier-*, cookie, authorization, x-forwarded-* stripped; the stamp replaces; pass list passes', () => {
  const r = inbound({ headers: {
    'x-atelier-user': 'evil', 'x-atelier-identity': 'forged', 'x-atelier-foo': '1', cookie: 'sess=1', authorization: 'Bearer leak',
    'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8', connection: 'keep-alive, x-custom', 'x-custom': 'hop',
    accept: 'text/html', range: 'bytes=0-1', 'if-range': '"e"', 'last-event-id': '7', origin: 'http://acme.portal.test', 'access-control-request-method': 'PUT', 'user-agent': 'ua', 'content-type': 'text/plain', 'content-length': '5',
  } }, { user })
  assert.equal(r.ok, true)
  assert.deepEqual(r.headers, {
    accept: 'text/html', range: 'bytes=0-1', 'if-range': '"e"', 'last-event-id': '7', origin: 'http://acme.portal.test', 'access-control-request-method': 'PUT', 'user-agent': 'ua', 'content-type': 'text/plain', 'content-length': '5',
    'x-atelier-user': 'p1', 'x-atelier-name': 'Ada', 'x-atelier-claims': '{"role":"x"}',
  })
  assert.ok(['x-atelier-user', 'x-atelier-identity', 'x-atelier-foo', 'cookie', 'authorization', 'x-forwarded-for', 'connection', 'x-custom'].every((h) => r.stripped.includes(h)))
  assert.deepEqual(r.dropped, ['x-real-ip'])
  assert.equal(r.contentLength, 5)
})

test('inbound: framing conflicts are 400 on the RAW headers; a content-length over the cap is 413 before a byte is read', () => {
  assert.deepEqual(inbound({ headers: { 'content-length': '5', 'transfer-encoding': 'chunked' } }), { ok: false, status: 400, reason: 'framing' })
  assert.deepEqual(inbound({ headers: { 'content-length': '5, 5' } }), { ok: false, status: 400, reason: 'framing' })
  assert.deepEqual(inbound({ headers: { 'content-length': String(BODY_CAP_DEFAULT + 1) } }), { ok: false, status: 413, reason: 'body-cap' })
  assert.equal(inbound({ headers: { 'content-length': '10' } }, { cap: 9 }).status, 413)
  assert.equal(inbound({ headers: {} }).ok, true)
})

test('stampUser: the three internal headers, claims as JSON', () => {
  assert.deepEqual(stampUser({ accept: '*/*' }, { id: 'p1', name: 'Ada' }), { accept: '*/*', 'x-atelier-user': 'p1', 'x-atelier-name': 'Ada', 'x-atelier-claims': '{}' })
})

test('outbound: set-cookie and www-authenticate never leave; Location rewritten only when root-absolute; unknown headers dropped', () => {
  const mount = '/api/acme/todo'
  const r = outbound({ 'content-type': 'text/html', 'set-cookie': 'a=1', 'www-authenticate': 'Basic', etag: '"x"', 'x-powered-by': 'php', location: '/items/1', 'transfer-encoding': 'chunked', 'access-control-allow-origin': 'https://evil' }, { mount })
  assert.equal(r.ok, true)
  assert.deepEqual(r.headers, { 'content-type': 'text/html', etag: '"x"', location: '/api/acme/todo/items/1', 'access-control-allow-origin': 'https://evil' })   // host side: cookieCredentialed:false, the shell applies the cookie cut
  assert.ok(['set-cookie', 'www-authenticate', 'x-powered-by', 'transfer-encoding'].every((h) => r.stripped.includes(h)))
  assert.equal(outbound({ location: 'items/2' }, { mount }).headers.location, 'items/2')
  assert.equal(outbound({ location: 'https://accounts.example/oauth' }, { mount }).headers.location, 'https://accounts.example/oauth')
  assert.equal(outbound({ location: '//evil/x' }, { mount }).headers.location, undefined)
  assert.equal(outbound({ location: '/x' }).headers.location, '/x')     // no mount known: unchanged
  assert.deepEqual(outbound({ 'content-length': '1', 'transfer-encoding': 'chunked' }), { ok: false, reason: 'framing' })
})

const pump = (src, t) => new Promise((resolve, reject) => { let n = 0; t.on('data', (c) => { n += c.length }); pipeline(src, t, (e) => (e ? reject(e) : resolve(n))) })
const bytes = (total, chunk = 65536) => Readable.from((function* () { let n = total; while (n > 0) { const c = Math.min(chunk, n); n -= c; yield Buffer.alloc(c, 0x78) } })())

test('countedBody: 1 MiB in and 4 MiB out pass with exact byte counts (C3); the cap+1 byte destroys the stream with BODY_CAP', async () => {
  const tin = countedBody()
  assert.equal(await pump(bytes(VERIFIED_IN_BYTES), tin), 1048576)
  assert.equal(tin.bytes, 1048576)
  const tout = countedBody()
  assert.equal(await pump(bytes(VERIFIED_OUT_BYTES), tout), 4194304)
  assert.equal(tout.bytes, 4194304)
  const capped = countedBody({ cap: 1000 })
  await assert.rejects(pump(bytes(1001, 100), capped), (e) => e.code === 'BODY_CAP')
  const exact = countedBody({ cap: 1000 })
  assert.equal(await pump(bytes(1000, 100), exact), 1000)
})
