import test from 'node:test'
import assert from 'node:assert/strict'
import * as protocol from '../index.js'

test('protocol/ names the wire format', () => {
  assert.equal(protocol.PROTOCOL, 'atelier/2')
})
