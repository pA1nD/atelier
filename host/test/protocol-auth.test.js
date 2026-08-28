// host/protocol/auth.mjs — bearer + epoch, the identity vectors end to end, the dev token paths.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { publicKeyFromHex, decode } from '../../protocol/index.js'
import vectors from '../../protocol/vectors/identity.json' with { type: 'json' }
import { createAuth, readDevToken, BEARER_RE } from '../protocol/auth.mjs'
import { fakeRegistrar, keys, assertionFor, tmp } from './protocol-fixtures.mjs'

const req = (method, url, headers = {}) => ({ method, url, headers })
const ok = (r) => ({ authorization: `Bearer ${r.epoch}.${r.token}` })

test('bearer: <epoch>.<token>; missing, malformed, moved epoch and wrong token are 401 with a logged reason', () => {
  const logs = []
  const r = fakeRegistrar({ epoch: 'e1', token: 'tok1' })
  const auth = createAuth({ registrar: r, devToken: null, log: (l) => logs.push(l) })
  assert.deepEqual(auth.bearer(req('GET', '/x')), { ok: false, status: 401, reason: 'no-bearer' })
  assert.equal(auth.bearer(req('GET', '/x', { authorization: 'Bearer tok1' })).reason, 'bad-bearer')
  assert.equal(auth.bearer(req('GET', '/x', { authorization: 'Bearer e0.tok1' })).reason, 'epoch-moved')
  assert.equal(auth.bearer(req('GET', '/x', { authorization: 'Bearer e1.tok2' })).reason, 'bad-token')
  assert.deepEqual(auth.bearer(req('GET', '/x', ok(r))), { ok: true })
  assert.ok(BEARER_RE.test('Bearer 0123456789abcdef.abc_-DEF'))
  assert.ok(logs.some((l) => l.includes('401 epoch-moved GET /x')))
  // a re-registration moves the epoch: the previous pair is refused from that moment
  const old = ok(r); r.epoch = 'e2'; r.token = 'tok9'
  assert.equal(auth.bearer(req('GET', '/x', old)).reason, 'epoch-moved')
  assert.equal(auth.bearer(req('GET', '/x', ok(r))).ok, true)
})

test('unregistered host: every bearer is 401 until register() gave a token', () => {
  const auth = createAuth({ registrar: fakeRegistrar({ epoch: null, token: null }), devToken: null })
  assert.equal(auth.bearer(req('GET', '/x', { authorization: 'Bearer e1.t1' })).reason, 'unregistered')
})

// The conformance vectors, driven through verifyRequest: same verdict and reason per case.
const pub = publicKeyFromHex(vectors.publicKey)
for (const c of vectors.cases) {
  test(`identity vector via verifyRequest: ${c.name}`, () => {
    const r = fakeRegistrar({ hostId: c.verify.hostId, startedAt: c.verify.hostStartedAt * 1000, publicKey: pub })
    const auth = createAuth({ registrar: r, devToken: null, now: () => c.verify.now })
    const mk = (h) => req(c.verify.method, c.verify.path, { ...ok(r), 'x-atelier-identity': h })
    for (const h of c.before ?? []) auth.verifyRequest(mk(h), { instance: c.verify.instanceId })
    const got = auth.verifyRequest(mk(c.header), { instance: c.verify.instanceId })
    assert.equal(got.ok, c.expect.ok, `verdict (${got.reason ?? 'ok'})`)
    if (c.expect.ok) { const p = decode(c.header).person; assert.deepEqual(got.user, { id: p.id, name: p.name, claims: p.claims ?? {} }) }
    else assert.equal(got.reason, c.expect.reason)
  })
}

test('live: a minted assertion passes once, replays 401, an iat before registration is 401', () => {
  const { privateKey, publicKey } = keys()
  const now = Math.floor(Date.now() / 1000)
  const r = fakeRegistrar({ hostId: 'h1', startedAt: (now - 100) * 1000, publicKey })
  const auth = createAuth({ registrar: r, devToken: null, now: () => now })
  const h = assertionFor(privateKey, { hostId: 'h1', instance: 'i-1', method: 'GET', path: '/api/acme/todo/items?x=1', now })
  const rq = req('GET', '/api/acme/todo/items?x=1', { ...ok(r), 'x-atelier-identity': h })
  assert.equal(auth.verifyRequest(rq, { instance: 'i-1' }).ok, true)
  assert.equal(auth.verifyRequest(rq, { instance: 'i-1' }).reason, 'replay')
  assert.equal(auth.nonces.size, 1)
  // wrong app for the same header on a fresh cache
  const auth2 = createAuth({ registrar: r, devToken: null, now: () => now })
  assert.equal(auth2.verifyRequest(rq, { instance: 'i-2' }).reason, 'wrong-app')
  // a restart: registration 10 s after the mint → iat-before-host (outside the ±5 s skew)
  const r2 = fakeRegistrar({ hostId: 'h1', startedAt: (now + 10) * 1000, publicKey })
  const auth3 = createAuth({ registrar: r2, devToken: null, now: () => now + 12 })
  assert.equal(auth3.verifyRequest(req('GET', '/api/acme/todo/items?x=1', { ...ok(r2), 'x-atelier-identity': h }), { instance: 'i-1' }).reason, 'iat-before-host')
  // no bearer at all → the assertion is never even looked at
  assert.equal(auth.verifyRequest(req('GET', '/x', { 'x-atelier-identity': h }), { instance: 'i-1' }).reason, 'no-bearer')
  // no shell key yet (registration without one)
  const auth4 = createAuth({ registrar: fakeRegistrar({ hostId: 'h1', startedAt: 1, publicKey: null }), devToken: null })
  assert.equal(auth4.verifyRequest(req('GET', '/x', { authorization: 'Bearer e1.tok1', 'x-atelier-identity': h }), { instance: 'i-1' }).reason, 'no-public-key')
})

test('nonce cache: hard ceiling `nonceMax` drops the oldest entries', () => {
  const { privateKey, publicKey } = keys()
  const now = Math.floor(Date.now() / 1000)
  const r = fakeRegistrar({ hostId: 'h1', startedAt: (now - 100) * 1000, publicKey })
  const auth = createAuth({ registrar: r, devToken: null, now: () => now, nonceMax: 3 })
  for (let i = 0; i < 6; i++) {
    const h = assertionFor(privateKey, { hostId: 'h1', instance: 'i-1', method: 'GET', path: '/p', now })
    assert.equal(auth.verifyRequest(req('GET', '/p', { ...ok(r), 'x-atelier-identity': h }), { instance: 'i-1' }).ok, true)
  }
  assert.ok(auth.nonces.size <= 3)
})

test('dev token: header, ?token=, same-origin referer; act-as only beside the token; no file → refuse everything (OR12)', () => {
  const r = fakeRegistrar({ principal: { id: 'p-agent', name: 'Bayard' } })
  const auth = createAuth({ registrar: r, devToken: 'secret-dev' })
  assert.equal(auth.hasDevToken, true)
  assert.deepEqual(auth.devRequest(req('GET', '/', { 'x-atelier-dev-token': 'secret-dev' })), { ok: true, user: { id: 'p-agent', name: 'Bayard', claims: {} } })
  assert.equal(auth.devRequest(req('GET', '/?token=secret-dev')).ok, true)
  assert.equal(auth.devRequest(req('GET', '/assets/client.js', { referer: 'http://127.0.0.1:1844/?token=secret-dev' })).ok, true)
  assert.deepEqual(auth.devRequest(req('GET', '/')), { ok: false, reason: 'no-token' })
  assert.deepEqual(auth.devRequest(req('GET', '/?token=nope')), { ok: false, reason: 'bad-token' })
  assert.equal(auth.devRequest(req('GET', '/', { 'x-atelier-dev-token': 'secret-de' })).ok, false)
  // act-as
  const as = auth.devRequest(req('GET', '/?token=secret-dev', { 'x-atelier-user': 'p9', 'x-atelier-name': 'Nine' }))
  assert.deepEqual(as.user, { id: 'p9', name: 'Nine', claims: {} })
  assert.equal(auth.devRequest(req('GET', '/?token=secret-dev', { 'x-atelier-user': 'p9' })).user.name, 'p9')
  assert.equal(auth.devRequest(req('GET', '/', { 'x-atelier-user': 'p9', 'x-atelier-name': 'Nine' })).ok, false)   // act-as without the token: nothing
  // no dev token at all
  const logs = []
  const none = createAuth({ registrar: r, devToken: null, log: (l) => logs.push(l) })
  assert.equal(none.hasDevToken, false)
  assert.deepEqual(none.devRequest(req('GET', '/?token=anything')), { ok: false, reason: 'no-dev-token' })
  assert.ok(logs.some((l) => l.includes('dev-token-missing')))
})

test('readDevToken reads $ATELIER_RUN/dev.token once; a missing file is null, never a fallback', () => {
  const run = tmp()
  assert.equal(readDevToken({ run }), null)
  fs.writeFileSync(path.join(run, 'dev.token'), 'abc123\n', { mode: 0o400 })
  assert.equal(readDevToken({ run }), 'abc123')
  const auth = createAuth({ registrar: fakeRegistrar(), cfg: { run } })
  assert.equal(auth.devRequest(req('GET', '/?token=abc123')).ok, true)
})
