// shell/minter.mjs — every header verifies with protocol/identity against the minted public key.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMinter, MINT_TTL_S } from '../minter.mjs'
import { verify, decode, publicKeyFromHex } from '../../protocol/index.js'

const person = { id: 'p-1', name: 'Bayard', claims: { role: 'x' } }

test('mint → verify round trip with protocol/identity, hostStartedAt mandatory', () => {
  const now = 1_700_000_000
  const m = createMinter({ now: () => now })
  const path = '/api/acme/todo/items?limit=5&x=%20y'
  const h = m.header({ hostId: 'c-1', instance: 'i-0123456789abcdef', method: 'POST', path, person })
  const pub = publicKeyFromHex(m.publicKeyHex)
  const nonces = new Map()
  const r = verify(pub, h, { hostId: 'c-1', instanceId: 'i-0123456789abcdef', method: 'POST', path, now: now + 3, hostStartedAt: now - 100, nonces })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.payload.person, person)
  assert.equal(r.payload.path, path)
  assert.equal(r.payload.exp - r.payload.iat, MINT_TTL_S)
  // the same header a second time is a replay
  assert.equal(verify(pub, h, { hostId: 'c-1', instanceId: 'i-0123456789abcdef', method: 'POST', path, now: now + 3, hostStartedAt: now - 100, nonces }).reason, 'replay')
  assert.throws(() => verify(pub, h, { hostId: 'c-1', instanceId: 'i-0123456789abcdef', method: 'POST', path, now }), /hostStartedAt/)
})

test('a fresh nonce per header; query is part of the signed path; wrong path is 401', () => {
  const m = createMinter({ now: () => 1_700_000_000 })
  const a = m.header({ hostId: 'h', instance: 'i-1', method: 'GET', path: '/api/c/s/x?q=1', person })
  const b = m.header({ hostId: 'h', instance: 'i-1', method: 'GET', path: '/api/c/s/x?q=1', person })
  assert.notEqual(a, b)
  assert.notEqual(decode(a).nonce, decode(b).nonce)
  const pub = publicKeyFromHex(m.publicKeyHex)
  const r = verify(pub, a, { hostId: 'h', instanceId: 'i-1', method: 'GET', path: '/api/c/s/x', now: 1_700_000_001, hostStartedAt: 1_700_000_000 })
  assert.equal(r.reason, 'method-path-mismatch')
})

test('person is cut to the closed key set {id, name, claims}', () => {
  const m = createMinter({ now: () => 1_700_000_000 })
  const h = m.header({ hostId: 'h', instance: 'i-1', method: 'GET', path: '/x', person: { id: 'p', name: 'n', epoch: 4, role: 'admin' } })
  assert.deepEqual(decode(h).person, { id: 'p', name: 'n' })
  const pub = publicKeyFromHex(m.publicKeyHex)
  assert.equal(verify(pub, h, { hostId: 'h', instanceId: 'i-1', method: 'GET', path: '/x', now: 1_700_000_001, hostStartedAt: 1_700_000_000 }).ok, true)
})

test('two minters never share a key; a header from one fails on the other', () => {
  const a = createMinter(), b = createMinter()
  assert.notEqual(a.publicKeyHex, b.publicKeyHex)
  const h = a.header({ hostId: 'h', instance: 'i-1', method: 'GET', path: '/x', person })
  const now = Math.floor(Date.now() / 1000)
  assert.equal(verify(publicKeyFromHex(b.publicKeyHex), h, { hostId: 'h', instanceId: 'i-1', method: 'GET', path: '/x', now, hostStartedAt: now - 10 }).reason, 'bad-signature')
})
