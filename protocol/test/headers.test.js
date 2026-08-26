import test from 'node:test'
import assert from 'node:assert/strict'
import { filterRequestHeaders, filterResponseHeaders, rejectFraming, INBOUND_STRIP, INBOUND_PASS, RESPONSE_ALLOW, RESPONSE_STRIP_ALWAYS } from '../headers.js'
import vectors from '../vectors/headers.json' with { type: 'json' }

const fns = {
  request: (c) => filterRequestHeaders(c.input),
  response: (c) => filterResponseHeaders(c.input, c.opts),
  framing: (c) => rejectFraming(c.input),
}
for (const c of vectors.cases) {
  test(`vector: ${c.name}`, () => { assert.deepEqual(fns[c.fn](c), c.expect) })
}

test('the lists match PLAN §4.4 (strip wins over pass; nothing is on both)', () => {
  for (const name of INBOUND_PASS.exact) assert.equal(INBOUND_STRIP.exact.includes(name), false, name)
  assert.ok(!INBOUND_PASS.exact.includes('cookie') && !INBOUND_PASS.exact.includes('authorization') && !INBOUND_PASS.exact.includes('host'))
  assert.ok(RESPONSE_STRIP_ALWAYS.includes('set-cookie') && RESPONSE_STRIP_ALWAYS.includes('www-authenticate'))
  for (const name of RESPONSE_ALLOW) assert.equal(RESPONSE_STRIP_ALWAYS.includes(name), false, name)
  assert.equal(RESPONSE_ALLOW.includes('set-cookie'), false)
})
