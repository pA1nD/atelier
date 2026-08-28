// shell/minter.mjs — the identity-assertion minter (DESIGN §3.1; PLAN §4.4 "Identity assertions").
//
// One Ed25519 key pair per shell process, generated at start; the private key never leaves the
// process (no file, no env — C3's rewrite, §4.9 step 0). `publicKeyHex` is what the shell hands
// the spine at its own registration (step 5) and what `register()` gives every host as
// `shell_public_key_hex`. Every header carries a fresh nonce; nothing is cached.
//
// `path` is the request path EXACTLY as the proxy forwards it (query included, after lane 0's
// normalisation): the host verifies `path` against the `req.url` it receives, so what is signed
// is what is sent. `person` is `{id, name, claims}` and nothing else — protocol/identity's closed
// key set; a provider that hands more (an epoch, a role) is cut here, never signed.
import { generateKeyPairSync } from 'node:crypto'
import { mint, publicKeyHex, MINT_TTL_S, HEADER } from '../protocol/index.js'

export { HEADER as IDENTITY_HEADER, MINT_TTL_S }

export const personForAssertion = (person) => {
  const p = { id: String(person.id), name: String(person.name ?? '') }
  if (person.claims && typeof person.claims === 'object' && !Array.isArray(person.claims)) p.claims = person.claims
  return p
}

/**
 * createMinter({ keys, now }) → { publicKeyHex, publicKey, header({hostId, instance, method, path, person}) }
 *   keys: {privateKey, publicKey} (default: a fresh Ed25519 pair)
 *   now:  unix seconds (default: the wall clock)
 */
export function createMinter({ keys = generateKeyPairSync('ed25519'), now = () => Math.floor(Date.now() / 1000) } = {}) {
  return {
    publicKey: keys.publicKey,
    publicKeyHex: publicKeyHex(keys.publicKey),
    header({ hostId, instance, method, path, person }) {
      if (typeof hostId !== 'string' || !hostId) throw new Error('minter: hostId is required')
      if (typeof instance !== 'string' || !instance) throw new Error('minter: instance is required')
      if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('minter: path must be the forwarded request path')
      return mint(keys.privateKey, { aud: hostId, app: instance, method, path, person: personForAssertion(person) }, { now: now(), ttl: MINT_TTL_S })
    },
  }
}
