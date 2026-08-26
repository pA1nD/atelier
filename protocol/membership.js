// Membership-epoch revocation + the derived membership model (PLAN §4.4 — "a host restart
// empties the nonce cache, so the previous epoch is revoked atomically at registration";
// §0.1 R5; §10 Q2 confirmed by spike C3: a chat member is a company member by derivation, a
// company member outside the app's chat gets the same 404 as a stranger). Seed spike-c3/common.mjs:63-90.
//
// Three epochs, three checks, all store-agnostic (where each epoch lives is the spine's step-1
// follow-up: sessions table, computers table):
//   personEpoch  — an integer the spine bumps whenever a person's memberships change (added to /
//                  removed from a chat, company left, deactivated). A session or assertion minted
//                  under an older epoch is refused: the presence cache it fed is stale.
//   host epoch   — the registrar's random epoch per host start; a host bearer token from an
//                  older epoch is refused after re-registration.
// `currentEpochOf` is either an integer or a function(personId) → integer | undefined
// (undefined = unknown person → refused).

const resolve = (currentEpochOf, personId) => typeof currentEpochOf === 'function' ? currentEpochOf(personId) : currentEpochOf

// checkSession({personId, epoch}, currentEpochOf) → {ok:true} | {ok:false, reason}
export function checkSession(session, currentEpochOf) {
  if (!session || typeof session.personId !== 'string' || !Number.isInteger(session.epoch)) return { ok: false, reason: 'no-session' }
  const current = resolve(currentEpochOf, session.personId)
  if (!Number.isInteger(current)) return { ok: false, reason: 'unknown-person' }
  if (session.epoch !== current) return { ok: false, reason: 'epoch-moved' }
  return { ok: true }
}

// assertionEpochCheck(payload, currentEpochOf): an optional person.epoch in the identity
// assertion (identity.js lets extra keys through under person). Absent = accepted — the shell
// mints from a session that already passed checkSession. Present and stale = refused.
export function assertionEpochCheck(payload, currentEpochOf) {
  const person = payload?.person
  if (!person || typeof person.id !== 'string') return { ok: false, reason: 'schema' }
  if (person.epoch === undefined) return { ok: true }
  if (!Number.isInteger(person.epoch)) return { ok: false, reason: 'schema' }
  const current = resolve(currentEpochOf, person.id)
  if (!Number.isInteger(current)) return { ok: false, reason: 'unknown-person' }
  return person.epoch === current ? { ok: true } : { ok: false, reason: 'epoch-moved' }
}

// hostEpochCheck(tokenEpoch, registeredEpoch): host bearer tokens are bound to (computer, epoch).
export function hostEpochCheck(tokenEpoch, registeredEpoch) {
  if (typeof tokenEpoch !== 'string' || !tokenEpoch) return { ok: false, reason: 'no-epoch' }
  if (typeof registeredEpoch !== 'string' || !registeredEpoch) return { ok: false, reason: 'not-registered' }
  return tokenEpoch === registeredEpoch ? { ok: true } : { ok: false, reason: 'host-epoch-moved' }
}

// The in-memory model (the registry + spine view the shell caches). Company membership is
// DERIVED: in any chat of the company. Presence on an app instance: chat-visible → in that
// chat; company-visible → any chat of the company (reserved for the dyno target, OR20).
// join/leave bump the person's epoch — the Q2 rule and the revocation rule in one object.
export class MembershipModel {
  constructor({ persons = {}, companies = {}, apps = {} } = {}) {
    this.persons = structuredClone(persons)
    this.companies = structuredClone(companies)
    this.apps = structuredClone(apps)
    this.epochs = new Map()
  }
  epochOf(personId) { return this.persons[personId] ? (this.epochs.get(personId) ?? 1) : undefined }
  bump(personId) { const e = this.epochOf(personId); if (e !== undefined) this.epochs.set(personId, e + 1); return this.epochOf(personId) }
  chatsOf(company, personId) {
    const c = this.companies[company]
    if (!c) return []
    return Object.entries(c.chats).filter(([, ppl]) => ppl.includes(personId)).map(([id]) => id)
  }
  isCompanyMember(company, personId) { return this.chatsOf(company, personId).length > 0 }
  present(personId, app) {
    if (!app) return false
    if (app.visibility === 'chat') return (this.companies[app.company]?.chats[app.chat] ?? []).includes(personId)
    if (app.visibility === 'company') return this.isCompanyMember(app.company, personId)
    return false
  }
  resolveApp(company, slug) { const app = this.apps[slug]; return app && app.company === company ? app : null }
  join(company, chat, personId) {
    const c = this.companies[company]
    if (!c || !this.persons[personId]) return { ok: false, reason: 'unknown' }
    const ppl = (c.chats[chat] ??= [])
    if (ppl.includes(personId)) return { ok: true, epoch: this.epochOf(personId), changed: false }
    ppl.push(personId)
    return { ok: true, epoch: this.bump(personId), changed: true }
  }
  leave(company, chat, personId) {
    const ppl = this.companies[company]?.chats[chat]
    if (!ppl || !ppl.includes(personId)) return { ok: true, epoch: this.epochOf(personId), changed: false }
    ppl.splice(ppl.indexOf(personId), 1)
    return { ok: true, epoch: this.bump(personId), changed: true }
  }
}
