// Identity assertions (PLAN §4.4 "Identity assertions", seed spike-c3/common.mjs + host.mjs).
// The shell signs {typ, aud, app, method, path, nonce, iat, exp, person} with Ed25519 over
// canonical JSON; the host verifies. One header, one base64url pair: b64u(payload).b64u(sig).
//
// Rules the C3 spike settled (RESULT.md surprises 1-2):
//   - asymmetry: the shell mints 30 s, the host accepts exp − now ≤ 60 s, both with ±5 s skew.
//     "mint 60 / cap 60" rejects EVERY assertion on a host clock 1 s behind.
//   - iat: a host restart empties the nonce cache; an assertion captured in its last ≤60 s
//     would replay once. The host refuses iat < its own start (registration) time — with the
//     same ±5 s skew as every other clock comparison (review 2026-08-26: iat is the shell's
//     clock, hostStartedAt the host's; a shell 2 s behind made every assertion minted in the
//     first seconds after a fleet ship — 14 hosts restarting together — `iat-before-host`).
//     The skew reopens a ≤5 s replay window for a nonce captured just before the restart;
//     accepted, and recorded here. `hostStartedAt` is MANDATORY: a host that omits it silently
//     loses the fence, so verify() throws instead.
//   - person is exactly {id, name, claims?} (§4.4: workers see `req.user = {id, name, claims}`
//     only); any other key under person is `schema`. The assertion carries no epoch field —
//     revocation reaches it through the shell's session (membership.checkSession).
// Ed25519 signatures are deterministic in node (RFC 8032, no per-signature randomness), so the
// vectors in vectors/identity.json are byte-stable across runs and implementations.
import { createPrivateKey, createPublicKey, sign, verify as cryptoVerify, randomBytes } from 'node:crypto'
import { canonical, b64u, unb64u } from './canonical.js'

export const HEADER = 'x-atelier-identity'
export const MAX_HEADER_BYTES = 4096
export const MINT_TTL_S = 30          // what the shell mints
export const MAX_EXP_S = 60           // what the host accepts (exp − now), before skew
export const SKEW_S = 5               // ± tolerance on every clock comparison (exp, iat-future, iat-before-host)
export const NONCE_CACHE_MAX = 10000  // prune trigger for the per-host nonce map
// PKCS8 DER prefix for a raw 32-byte Ed25519 seed (RFC 8410) — lets a vector carry the seed as hex.
export const PKCS8_ED25519_PREFIX = '302e020100300506032b657004220420'
export const SPKI_ED25519_PREFIX = '302a300506032b6570032100'

const TOP_KEYS = ['typ', 'aud', 'app', 'method', 'path', 'nonce', 'iat', 'exp', 'person']
export const PERSON_KEYS = ['id', 'name', 'claims']

export function keyFromSeed(seedHex) {
  if (!/^[0-9a-f]{64}$/.test(seedHex)) throw new Error('seed must be 32 bytes hex')
  const privateKey = createPrivateKey({ key: Buffer.from(PKCS8_ED25519_PREFIX + seedHex, 'hex'), format: 'der', type: 'pkcs8' })
  return { privateKey, publicKey: createPublicKey(privateKey) }
}
export const publicKeyHex = (pub) => pub.export({ format: 'der', type: 'spki' }).toString('hex')
export const publicKeyFromHex = (hex) => createPublicKey({ key: Buffer.from(hex, 'hex'), format: 'der', type: 'spki' })
export const newNonce = () => b64u(randomBytes(16))

// mint(priv, {aud, app, method, path, person}, {now, ttl, nonce}) → header value.
// `nonce` is an override for vectors only; production never passes it.
export function mint(priv, { aud, app, method, path, person }, { now, ttl = MINT_TTL_S, nonce = newNonce() } = {}) {
  if (!Number.isInteger(now)) throw new Error('mint: now (unix seconds) is required')
  const payload = { typ: 'id', aud, app, method, path, nonce, iat: now, exp: now + ttl, person }
  return encode(payload, priv)
}
// encode() signs an arbitrary payload — vectors use it for the hand-crafted cases.
export function encode(payload, priv, bytes = Buffer.from(canonical(payload), 'utf8')) {
  return b64u(bytes) + '.' + b64u(sign(null, bytes, priv))
}
// decode() without verification — forensics and tests only.
export function decode(value) {
  const [p] = String(value).split('.')
  return JSON.parse(unb64u(p).toString('utf8'))
}

// verify(pub, headerValue, opts) → {ok:true, payload} | {ok:false, reason}.
// Check order (C3, locked): signature → schema → non-canonical → aud → app → method/path →
// exp → iat → nonce. Every failure is a 401 to the caller; the reason is logged host-side only.
export function verify(pub, value, { hostId, instanceId, method, path, now, hostStartedAt, nonces, maxExp = MAX_EXP_S, skew = SKEW_S }) {
  if (!Number.isInteger(hostStartedAt)) throw new Error('verify: hostStartedAt (unix seconds, the host\'s registration time) is required — it is the restart-replay fence')
  const bad = (reason) => ({ ok: false, reason })
  if (typeof value !== 'string' || value.length === 0) return bad('missing')
  if (value.length > MAX_HEADER_BYTES) return bad('too-long')
  const parts = value.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return bad('malformed')
  let bytes, sig
  try { bytes = unb64u(parts[0]); sig = unb64u(parts[1]) } catch { return bad('malformed') }
  if (sig.length !== 64) return bad('malformed')
  let sigOk = false
  try { sigOk = cryptoVerify(null, bytes, pub, sig) } catch { sigOk = false }
  if (!sigOk) return bad('bad-signature')
  let p
  try { p = JSON.parse(bytes.toString('utf8')) } catch { return bad('schema') }
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.typ !== 'id') return bad('schema')
  for (const k of Object.keys(p)) if (!TOP_KEYS.includes(k)) return bad('schema')   // unknown top-level key
  for (const k of ['aud', 'app', 'method', 'path', 'nonce']) if (typeof p[k] !== 'string' || !p[k]) return bad('schema')
  if (!Number.isInteger(p.iat) || !Number.isInteger(p.exp)) return bad('schema')
  if (!p.person || typeof p.person !== 'object' || Array.isArray(p.person)) return bad('schema')
  for (const k of Object.keys(p.person)) if (!PERSON_KEYS.includes(k)) return bad('schema')   // closed set: {id, name, claims?}
  if (typeof p.person.id !== 'string' || !p.person.id || typeof p.person.name !== 'string') return bad('schema')
  if (p.person.claims !== undefined && (!p.person.claims || typeof p.person.claims !== 'object' || Array.isArray(p.person.claims))) return bad('schema')
  if (!Buffer.from(canonical(p), 'utf8').equals(bytes)) return bad('non-canonical')
  if (p.aud !== hostId) return bad('wrong-aud')
  if (p.app !== instanceId) return bad('wrong-app')
  if (p.method !== method || p.path !== path) return bad('method-path-mismatch')
  if (p.exp <= now - skew) return bad('expired')
  if (p.exp - now > maxExp + skew) return bad('exp-too-far')
  if (p.iat < hostStartedAt - skew) return bad('iat-before-host')
  if (p.iat > now + skew) return bad('iat-future')
  if (nonces) {
    if (nonces.has(p.nonce)) return bad('replay')
    nonces.set(p.nonce, p.exp)
    if (nonces.size > NONCE_CACHE_MAX) for (const [n, e] of nonces) if (e <= now - skew) nonces.delete(n)
  }
  return { ok: true, payload: p }
}
