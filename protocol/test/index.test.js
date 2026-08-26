import test from 'node:test'
import assert from 'node:assert/strict'
import * as protocol from '../index.js'

test('protocol/ names the wire format', () => {
  assert.equal(protocol.PROTOCOL, 'atelier/2')
})

test('index.js re-exports every module (one name per module, no collisions)', () => {
  for (const name of ['canonical', 'mint', 'verify', 'filterRequestHeaders', 'filterResponseHeaders', 'EventRing', 'isFrame',
    'authorizeWrite', 'allowMeta', 'reclaimRule', 'checkSession', 'MembershipModel', 'coalesce', 'formatForAgent']) {
    assert.equal(typeof protocol[name], 'function', name)
  }
})
