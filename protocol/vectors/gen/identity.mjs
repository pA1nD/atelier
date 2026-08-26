// Regenerates vectors/identity.json: `node protocol/vectors/gen/identity.mjs > protocol/vectors/identity.json`.
// Deterministic: fixed seeds, fixed nonces, fixed clock. Ed25519 in node is deterministic, so the
// header strings are byte-stable; a second implementation re-mints `mintedWith` and must match `header`.
import { keyFromSeed, publicKeyHex, mint, encode } from '../../identity.js'
import { canonical, b64u } from '../../canonical.js'

const SEED = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
const FOREIGN_SEED = 'f0e1d2c3b4a5968778695a4b3c2d1e0f0f1e2d3c4b5a69788796a5b4c3d2e1f0'
const shell = keyFromSeed(SEED)
const foreign = keyFromSeed(FOREIGN_SEED)
const NOW = 1_700_000_000
const HOST_STARTED_AT = NOW - 1000
const verify = { hostId: 'h-comp-1', instanceId: 'i-todo', method: 'GET', path: '/api/acme/todo/items?x=1', now: NOW, hostStartedAt: HOST_STARTED_AT }
const person = { id: 'p1', name: 'Ada' }
const base = { aud: 'h-comp-1', app: 'i-todo', method: 'GET', path: '/api/acme/todo/items?x=1', person }
const nonce = (i) => b64u(Buffer.alloc(16, i))

const cases = []
let n = 0
function add(name, expect, { claims = {}, now = NOW, ttl = 30, key = shell, header, before, note } = {}) {
  n++
  const mintedWith = header !== undefined ? undefined : { seed: key === shell ? SEED : FOREIGN_SEED, now, ttl, nonce: nonce(n) }
  const value = header !== undefined ? header : mint(key.privateKey, { ...base, ...claims }, { now, ttl, nonce: nonce(n) })
  const c = { name, header: value, verify: { ...verify }, expect }
  if (mintedWith) { c.mintedWith = mintedWith; c.claims = { ...base, ...claims } }
  if (before) c.before = before
  if (note) c.note = note
  cases.push(c)
  return value
}
const ok = { ok: true }
const bad = (reason) => ({ ok: false, reason })

const valid = add('valid', ok)
add('replay: same header verified twice on one nonce cache', bad('replay'), { header: valid, before: [valid] })
add('aged 61 s: minted 61 s ago with ttl 30', bad('expired'), { now: NOW - 61 })
add('exp +120: minted with ttl 120', bad('exp-too-far'), { ttl: 120 })
add('backdated: exp 100 s in the past', bad('expired'), { now: NOW - 130 })
add('wrong aud', bad('wrong-aud'), { claims: { aud: 'h-comp-2' } })
add('wrong app: an i-wiki assertion on the todo path', bad('wrong-app'), { claims: { app: 'i-wiki' } })
add('method mismatch: POST assertion on a GET', bad('method-path-mismatch'), { claims: { method: 'POST' } })
add('path mismatch: query differs', bad('method-path-mismatch'), { claims: { path: '/api/acme/todo/items?x=2' } })
{
  // tampered: flip the person id inside the signed bytes, keep the signature
  const [p, s] = valid.split('.')
  const bytes = Buffer.from(p, 'base64url').toString('utf8').replace('"id":"p1"', '"id":"p2"')
  add('tampered payload: person.id edited after signing', bad('bad-signature'), { header: b64u(Buffer.from(bytes)) + '.' + s })
}
add('foreign key: signed by a keypair the host does not trust', bad('bad-signature'), { key: foreign })
add('malformed: no dot', bad('malformed'), { header: 'not-an-assertion' })
add('malformed: signature not 64 bytes', bad('malformed'), { header: valid.split('.')[0] + '.' + b64u(Buffer.alloc(10, 1)) })
add('missing: empty header', bad('missing'), { header: '' })
add('too-long: header over 4096 bytes', bad('too-long'), { header: valid + 'A'.repeat(4096) })
{
  // non-canonical: same fields, unsorted keys, validly signed over the unsorted bytes
  n++
  const payload = { typ: 'id', person, exp: NOW + 30, iat: NOW, nonce: nonce(n), path: base.path, method: base.method, app: base.app, aud: base.aud }
  add('non-canonical: same fields, keys unsorted, valid signature', bad('non-canonical'), { header: encode(payload, shell.privateKey, Buffer.from(JSON.stringify(payload))) })
}
{
  n++
  const payload = { ...base, typ: 'id', nonce: nonce(n), iat: NOW, exp: NOW + 30, extra: 1 }
  add('schema: unknown top-level key rejected', bad('schema'), { header: encode(payload, shell.privateKey) })
}
{
  n++
  const payload = { ...base, typ: 'id', nonce: nonce(n), iat: NOW + 0.5, exp: NOW + 30 }
  add('schema: iat not an integer', bad('schema'), { header: encode(payload, shell.privateKey) })
}
{
  n++
  const payload = { ...base, typ: 'id', nonce: nonce(n), iat: NOW, exp: NOW + 30, person: { id: 'p1' } }
  add('schema: person.name missing', bad('schema'), { header: encode(payload, shell.privateKey) })
}
add('person.claims: the closed person set {id, name, claims} passes', ok, { claims: { person: { ...person, claims: { role: 'admin' } } } })
add('schema: unknown key under person (admin/role) rejected — workers see req.user = {id, name, claims} only', bad('schema'), { claims: { person: { ...person, admin: true, role: 'root' } } })
add('schema: person.epoch is not a field (§4.4: the assertion carries no epoch)', bad('schema'), { claims: { person: { ...person, epoch: 3 } } })
add('schema: person.claims must be an object', bad('schema'), { claims: { person: { ...person, claims: 'admin' } } })
{
  n++
  const payload = { ...base, typ: 'id', nonce: nonce(n), iat: HOST_STARTED_AT - 6, exp: NOW + 30 }
  add('iat 6 s before host start (C3 surprise 2: restart replay window, outside skew)', bad('iat-before-host'), { header: encode(payload, shell.privateKey) })
}
{
  n++
  const payload = { ...base, typ: 'id', nonce: nonce(n), iat: HOST_STARTED_AT - 5, exp: NOW + 30 }
  add('iat 5 s before host start: inside skew (a shell clock behind the host on a fleet ship is not a 401 burst)', ok, { header: encode(payload, shell.privateKey) })
}
add('iat 6 s in the future', bad('iat-future'), { now: NOW + 6 })
add('iat 5 s in the future: inside skew', ok, { now: NOW + 5 })
{
  n++
  const payload = { ...base, typ: 'id', nonce: nonce(n), iat: NOW, exp: NOW + 65 }
  add('skew boundary: exp = now + 60 + 5 accepted', ok, { header: encode(payload, shell.privateKey) })
}
{
  n++
  const payload = { ...base, typ: 'id', nonce: nonce(n), iat: NOW, exp: NOW + 66 }
  add('skew boundary: exp = now + 60 + 6 rejected', bad('exp-too-far'), { header: encode(payload, shell.privateKey) })
}
{
  n++
  const payload = { ...base, typ: 'id', nonce: nonce(n), iat: NOW - 34, exp: NOW - 4 }
  add('skew boundary: exp = now − 4 still accepted', ok, { header: encode(payload, shell.privateKey) })
}
{
  n++
  const payload = { ...base, typ: 'id', nonce: nonce(n), iat: NOW - 35, exp: NOW - 5 }
  add('skew boundary: exp = now − 5 expired', bad('expired'), { header: encode(payload, shell.privateKey) })
}
add('check order: replayed on another path reports method-path-mismatch, not replay', bad('method-path-mismatch'), {
  header: valid, before: [valid], note: 'the verify opts differ per case; this one overrides path' })
cases[cases.length - 1].verify.path = '/api/acme/todo/other'

const out = {
  module: 'protocol/identity.js',
  spike: 'C3',
  header: 'x-atelier-identity',
  seed: SEED,
  publicKey: publicKeyHex(shell.publicKey),
  foreignSeed: FOREIGN_SEED,
  foreignPublicKey: publicKeyHex(foreign.publicKey),
  constants: { MINT_TTL_S: 30, MAX_EXP_S: 60, SKEW_S: 5, MAX_HEADER_BYTES: 4096 },
  note: 'Each case: verify(publicKey, header, verify) → expect. `before` lists headers verified first on the same nonce cache. `mintedWith` + `claims` let a second implementation re-mint and compare `header` byte for byte. `verify.hostStartedAt` is mandatory (the restart-replay fence; verify() throws without it) and is compared with the same ±SKEW_S as every other clock check. person is exactly {id, name, claims?}.',
  canonicalSample: { input: { b: 1, a: { d: [1, { z: 0, y: 1 }], c: 'x' } }, output: canonical({ b: 1, a: { d: [1, { z: 0, y: 1 }], c: 'x' } }) },
  cases,
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n')
