import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { canonical } from '../canonical.js'
import { keyFromSeed, publicKeyHex, publicKeyFromHex, mint, verify, decode, HEADER, MINT_TTL_S, MAX_EXP_S, SKEW_S, PERSON_KEYS } from '../identity.js'
import vectors from '../vectors/identity.json' with { type: 'json' }

// The conformance loop: a second implementation runs the same file and must yield the same
// verdict/reason per case. Keep this loop dumb — the vectors carry the meaning.
const pub = publicKeyFromHex(vectors.publicKey)
for (const c of vectors.cases) {
  test(`vector: ${c.name}`, () => {
    const nonces = new Map()
    for (const h of c.before ?? []) verify(pub, h, { ...c.verify, nonces })
    const got = verify(pub, c.header, { ...c.verify, nonces })
    assert.equal(got.ok, c.expect.ok, `verdict (${got.reason ?? 'ok'})`)
    if (!c.expect.ok) assert.equal(got.reason, c.expect.reason)
    if (c.mintedWith) {
      const { privateKey } = keyFromSeed(c.mintedWith.seed)
      assert.equal(mint(privateKey, c.claims, c.mintedWith), c.header, 'byte-stable re-mint')
    }
  })
}

test('vector file: seed → public key, canonical sample, constants', () => {
  assert.equal(publicKeyHex(keyFromSeed(vectors.seed).publicKey), vectors.publicKey)
  assert.equal(canonical(vectors.canonicalSample.input), vectors.canonicalSample.output)
  assert.deepEqual(vectors.constants, { MINT_TTL_S, MAX_EXP_S, SKEW_S, MAX_HEADER_BYTES: 4096 })
  assert.equal(vectors.header, HEADER)
  assert.deepEqual(PERSON_KEYS, ['id', 'name', 'claims'])
})

test('live round trip with a fresh keypair; aging is simulated by `now`, never by sleeping', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const now = 1_800_000_000
  const opts = { hostId: 'h1', instanceId: 'i1', method: 'POST', path: '/api/acme/todo', now, hostStartedAt: now - 10, nonces: new Map() }
  const h = mint(privateKey, { aud: 'h1', app: 'i1', method: 'POST', path: '/api/acme/todo', person: { id: 'p1', name: 'Ada' } }, { now })
  const p = decode(h)
  assert.equal(p.exp - p.iat, MINT_TTL_S)
  assert.equal(p.nonce.length, 22)                                   // 16 random bytes, base64url
  const first = verify(publicKey, h, opts)
  assert.equal(first.ok, true)
  assert.equal(first.payload.person.id, 'p1')
  assert.deepEqual(verify(publicKey, h, opts), { ok: false, reason: 'replay' })
  assert.deepEqual(verify(publicKey, h, { ...opts, nonces: new Map(), now: now + 61 }), { ok: false, reason: 'expired' })
  assert.deepEqual(verify(publicKey, h, { ...opts, nonces: new Map(), now: now + 30 + SKEW_S - 1 }), { ok: true, payload: p })   // exp − now = −4: inside skew
})

test('hostStartedAt is mandatory: a host that omits the restart-replay fence gets a throw, not a silent pass', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const now = 1_800_000_000
  const h = mint(privateKey, { aud: 'h1', app: 'i1', method: 'GET', path: '/', person: { id: 'p1', name: 'Ada' } }, { now })
  assert.throws(() => verify(publicKey, h, { hostId: 'h1', instanceId: 'i1', method: 'GET', path: '/', now }), /hostStartedAt/)
  assert.throws(() => verify(publicKey, h, { hostId: 'h1', instanceId: 'i1', method: 'GET', path: '/', now, hostStartedAt: '1' }), /hostStartedAt/)
})

test('nonce cache prunes expired entries once it passes 10 000', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const nonces = new Map()
  for (let i = 0; i < 10001; i++) nonces.set('old' + i, 100)          // exp long gone
  const now = 1_800_000_000
  const h = mint(privateKey, { aud: 'h1', app: 'i1', method: 'GET', path: '/', person: { id: 'p1', name: 'Ada' } }, { now })
  assert.equal(verify(publicKey, h, { hostId: 'h1', instanceId: 'i1', method: 'GET', path: '/', now, hostStartedAt: now - 10, nonces }).ok, true)
  assert.equal(nonces.size, 1)
})
