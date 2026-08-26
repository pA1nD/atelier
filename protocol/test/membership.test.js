import test from 'node:test'
import assert from 'node:assert/strict'
import { checkSession, hostEpochCheck, MembershipModel } from '../membership.js'
import vectors from '../vectors/membership.json' with { type: 'json' }

const epochTable = (epochs) => (personId) => epochs[personId]
for (const c of vectors.cases) {
  test(`vector: ${c.name}`, () => {
    switch (c.fn) {
      case 'checkSession': return assert.deepEqual(checkSession(c.input, epochTable(c.epochs)), c.expect)
      case 'hostEpochCheck': return assert.deepEqual(hostEpochCheck(...c.input), c.expect)
      case 'present': {
        const m = new MembershipModel(vectors.model)
        return assert.equal(m.present(c.input.personId, m.resolveApp(c.input.company, c.input.slug)), c.expect)
      }
      case 'scenario': {
        const m = new MembershipModel(vectors.model)
        return c.steps.forEach((s, i) => {
          const at = `step ${i} (${s.op})`
          if (s.op === 'epochOf') assert.equal(m.epochOf(s.personId), s.expect, at)
          else if (s.op === 'checkSession') assert.deepEqual(checkSession(s.session, (p) => m.epochOf(p)), s.expect, at)
          else if (s.op === 'present') assert.equal(m.present(s.personId, m.resolveApp(s.company, s.slug)), s.expect, at)
          else if (s.op === 'join') assert.deepEqual(m.join(s.company, s.chat, s.personId), s.expect, at)
          else if (s.op === 'leave') assert.deepEqual(m.leave(s.company, s.chat, s.personId), s.expect, at)
          else throw new Error('unknown op ' + s.op)
        })
      }
      default: throw new Error('unknown fn ' + c.fn)
    }
  })
}

test('currentEpochOf may be a plain integer; an integer epoch of 0 is a valid epoch', () => {
  assert.deepEqual(checkSession({ personId: 'p1', epoch: 0 }, 0), { ok: true })
  assert.deepEqual(checkSession({ personId: 'p1', epoch: 0 }, 1), { ok: false, reason: 'epoch-moved' })
})

test('OR20: the model has no visibility — an app object carrying one changes nothing (presence is chat membership only)', () => {
  const m = new MembershipModel(vectors.model)
  assert.equal(m.present('p3', { ...m.resolveApp('acme', 'todo'), visibility: 'company' }), false)
  assert.equal(m.present('p1', { ...m.resolveApp('acme', 'todo'), visibility: 'company' }), true)
})

test('the model does not mutate the vector file\'s model object', () => {
  const m = new MembershipModel(vectors.model)
  m.join('acme', 'c1', 'p3')
  assert.deepEqual(vectors.model.companies.acme.chats.c1, ['p1', 'p2'])
})
