// shell/providers/identity-local.mjs — who is the person, local column (DESIGN §1.1).
// A constant: the host's dev-shell principal (`registrar.principal` in local mode is the same
// `{id:'local', name:'local'}`). `credential: 'none'` is what makes the Origin lane a no-op BY THE
// SAME RULE the fleet runs ("Origin iff the credential is a cookie", OR12) — nothing is skipped
// here. SKIPPED (not faked): the session store, the person epoch, the `aud` check — there is no
// session at all; identity is the process's.
export const LOCAL_PERSON = Object.freeze({ id: 'local', name: 'local', claims: {} })

export function createIdentityLocal({ person = LOCAL_PERSON } = {}) {
  const resolved = Object.freeze({ ok: true, person: { id: person.id, name: person.name, claims: person.claims ?? {} }, credential: 'none', epoch: null })
  return {
    kind: 'local',
    async resolve() { return resolved },
    session() { return null },
  }
}
