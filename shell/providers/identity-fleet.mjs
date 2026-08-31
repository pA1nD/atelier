// shell/providers/identity-fleet.mjs — who is the person, fleet column (DESIGN §1.1; PLAN §4.1
// "Cookie", §4.5): the `__Host-session` cookie names an opaque server-side session in the spine
// store `{person, epoch, aud}`; `aud` must equal the request's company (the cookie is per company
// origin); protocol/membership `checkSession` refuses a session minted under an older person epoch
// (`revoked`). The store is a seam (`sessions.get(id)`, `epochOf(personId)`) — step 5 wires the
// spine's; the shell tests pass a Map. `credential: 'cookie'` turns the Origin lane on.
import { checkSession } from '../../protocol/index.js'

export const SESSION_COOKIE = '__Host-session'

export function cookieValue(req, name) {
  const raw = req.headers?.cookie
  if (!raw) return null
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()) } catch { return part.slice(i + 1).trim() } }
  }
  return null
}

/**
 * createIdentityFleet({ sessions, epochOf, company })
 *   sessions.get(id) → Promise<{person:{id,name,claims?}, epoch, aud, op?} | null>
 *   epochOf(personId) → integer | undefined         (the spine's person epoch)
 *   company(req) → the request's company (the registry's Host parse)
 */
export function createIdentityFleet({ sessions, epochOf, company }) {
  return {
    kind: 'fleet',
    session(req) { return cookieValue(req, SESSION_COOKIE) },
    async resolve(req) {
      const id = cookieValue(req, SESSION_COOKIE)
      if (!id) return { ok: false, reason: 'no-session' }
      const s = await sessions.get(id)
      if (!s || !s.person) return { ok: false, reason: 'no-session' }
      const c = company(req)
      if (!c || s.aud !== c) return { ok: false, reason: 'no-session' }     // a session for another company is no session here
      const chk = checkSession({ personId: s.person.id, epoch: s.epoch }, epochOf)
      if (!chk.ok) return { ok: false, reason: 'revoked' }
      return { ok: true, person: { id: s.person.id, name: s.person.name, claims: s.person.claims ?? {} }, credential: 'cookie', epoch: s.epoch, op: s.op === true || s.person.claims?.op === true }
    },
  }
}
