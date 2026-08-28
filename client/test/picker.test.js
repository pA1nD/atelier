import test from 'node:test'
import assert from 'node:assert/strict'
import { pickTarget, performPick } from '../picker.js'
import { fakeDocument } from './fakes.js'

const local = { portal: null, companies: [{ id: 'global', name: 'global', href: '/global/' }, { id: 'acme', name: 'acme', href: '/acme/' }] }
const fleet = { portal: 'https://portal.pa1nd.de/', companies: [{ id: 'acme', name: 'Acme', href: 'https://acme.portal.pa1nd.de/' }] }

test('local: assign the row href (full page load)', () => {
  assert.deepEqual(pickTarget(local, 'acme'), { kind: 'assign', href: '/acme/' })
  assert.deepEqual(pickTarget(local, 'unknown'), { kind: 'assign', href: '/unknown/' })
  assert.equal(pickTarget(local, ''), null)
})

test('fleet: a POST to <portal>/picker with the company', () => {
  assert.deepEqual(pickTarget(fleet, 'acme'), { kind: 'post', action: 'https://portal.pa1nd.de/picker', fields: { company: 'acme' } })
})

test('performPick submits a form / assigns', () => {
  const doc = fakeDocument()
  assert.equal(performPick(doc, pickTarget(fleet, 'acme')), true)
  assert.equal(doc.submitted.length, 1)
  const form = doc.submitted[0]
  assert.equal(form.getAttribute('method'), 'post')
  assert.equal(form.getAttribute('action'), 'https://portal.pa1nd.de/picker')
  assert.deepEqual(form.children.map((i) => [i.getAttribute('name'), i.getAttribute('value')]), [['company', 'acme']])
  assert.equal(performPick(doc, pickTarget(local, 'acme')), true)
  assert.deepEqual(doc.assigned, ['/acme/'])
  assert.equal(performPick(doc, null), false)
})
