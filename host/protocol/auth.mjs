// host/protocol/auth.mjs — who is calling the host (DESIGN §4.3, §6.5; PLAN §4.4 "Transport",
// "Identity assertions", §4.3 "Dev shell", OR12).
//
// Two callers, two credentials, nothing else:
//   1. the shell on the protocol port: bearer host token WITH epoch, then the Ed25519 identity
//      assertion protocol/identity verifies (order signature → schema → aud → app → method/path →
//      exp → iat → nonce). The bearer is `Authorization: Bearer <epoch>.<token>` — the token and
//      the epoch registration returned; a host restart registers again, gets a new pair, and the
//      previous pair is refused here from that moment (`epoch-moved`). Every failure is a 401
//      with body `{}`; the reason is logged host-side only.
//   2. the agent on the dev shell: the launcher-minted dev token, in `x-atelier-dev-token`, in
//      `?token=` on the request URL, or in the `?token=` of a same-origin `referer` (what a
//      browser sub-request of a `/?token=…` document carries). No token file → the dev shell
//      refuses every request (OR12: no fallback; `atelier doctor` flags it). Identity = the
//      chat's principal; `x-atelier-user`/`x-atelier-name` (the agent's act-as switch) are
//      honoured ONLY beside a valid dev token.
//
// The nonce cache is one Map per process; protocol/identity prunes expired entries once it
// passes NONCE_CACHE_MAX (10 000); `nonceMax` here is a hard ceiling on top (oldest dropped).
import fs from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { verify as verifyAssertion, HEADER as IDENTITY_HEADER, NONCE_CACHE_MAX } from '../../protocol/index.js'

export { IDENTITY_HEADER }
export const DEV_TOKEN_HEADER = 'x-atelier-dev-token'
export const ACT_AS_USER = 'x-atelier-user'
export const ACT_AS_NAME = 'x-atelier-name'
export const BEARER_RE = /^Bearer\s+([^\s.]+)\.([^\s.]+)$/

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}
const tokenFromUrl = (u) => { try { return new URL(u, 'http://x').searchParams.get('token') } catch { return null } }

// readDevToken(cfg) → string | null. Read once at boot, held in memory, never env.
export function readDevToken(cfg) {
  if (!cfg?.run) return null
  try { return fs.readFileSync(cfg.run + '/dev.token', 'utf8').trim() || null } catch { return null }
}

/**
 * createAuth({ registrar, os, cfg, devToken, nonceMax, now, log })
 *   registrar: hostId, epoch, token, startedAt (ms), publicKey(), principal
 *   devToken:  the dev token string; when undefined it is read from `$cfg.run/dev.token` once
 *   now:       unix SECONDS (defaults to os.now()/1000)
 */
export function createAuth({ registrar, os, cfg, devToken, nonceMax = NONCE_CACHE_MAX, now, log = () => {} }) {
  const nonces = new Map()
  const clock = now ?? (() => Math.floor((os?.now?.() ?? Date.now()) / 1000))
  const dev = devToken === undefined ? readDevToken(cfg) : (devToken || null)
  if (!dev) log('auth: no dev token — the dev shell refuses every request (OR12, doctor: dev-token-missing)')
  const fail = (reason, req) => { log(`auth: 401 ${reason} ${req?.method ?? ''} ${req?.url ?? ''}`.trim()); return { ok: false, status: 401, reason } }

  function bearer(req) {
    const m = BEARER_RE.exec(req.headers?.authorization ?? '')
    if (!req.headers?.authorization) return fail('no-bearer', req)
    if (!m) return fail('bad-bearer', req)
    if (!registrar.token || !registrar.epoch) return fail('unregistered', req)
    if (!same(m[1], registrar.epoch)) return fail('epoch-moved', req)
    if (!same(m[2], registrar.token)) return fail('bad-token', req)
    return { ok: true }
  }

  function verifyRequest(req, { instance }) {
    const b = bearer(req)
    if (!b.ok) return b
    const pub = registrar.publicKey()
    if (!pub) return fail('no-public-key', req)
    if (!Number.isInteger(registrar.startedAt)) return fail('unregistered', req)
    const header = req.headers[IDENTITY_HEADER]
    const r = verifyAssertion(pub, Array.isArray(header) ? header[0] : header, {
      hostId: registrar.hostId, instanceId: instance, method: req.method, path: req.url,
      now: clock(), hostStartedAt: Math.floor(registrar.startedAt / 1000), nonces,
    })
    if (!r.ok) return fail(r.reason, req)
    if (nonces.size > nonceMax) for (const k of nonces.keys()) { nonces.delete(k); if (nonces.size <= nonceMax) break }
    const p = r.payload.person
    return { ok: true, user: { id: p.id, name: p.name, claims: p.claims ?? {} } }
  }

  function devRequest(req) {
    if (!dev) return { ok: false, reason: 'no-dev-token' }
    const h = req.headers?.[DEV_TOKEN_HEADER]
    const presented = (Array.isArray(h) ? h[0] : h) ?? tokenFromUrl(req.url) ?? (req.headers?.referer ? tokenFromUrl(req.headers.referer) : null)
    if (!presented) return { ok: false, reason: 'no-token' }
    if (!same(presented, dev)) return { ok: false, reason: 'bad-token' }
    const principal = registrar.principal ?? { id: 'local', name: 'local' }
    const user = { id: principal.id, name: principal.name, claims: {} }
    const asId = req.headers?.[ACT_AS_USER]
    if (typeof asId === 'string' && asId) {
      user.id = asId
      const asName = req.headers?.[ACT_AS_NAME]
      user.name = typeof asName === 'string' && asName ? asName : asId
    }
    return { ok: true, user }
  }

  return { bearer, verifyRequest, devRequest, nonces, hasDevToken: !!dev }
}
