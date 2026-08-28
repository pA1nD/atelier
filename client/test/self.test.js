import test from 'node:test'
import assert from 'node:assert/strict'
import { self } from '../self.js'

// spike-b6 test-self.mjs vectors
const want = { company: 'acme', app: 'todo', qid: 'acme/todo', base: '/acme/todo/', modules: '/modules/acme/todo/', api: '/api/acme/todo' }
const cases = [
  ['/modules/acme/todo/some/deep/path', 'some/deep/path'],
  ['/modules/acme/todo/some/deep/path?x=1&y=/modules/evil/app/#frag', 'some/deep/path'],
  ['/modules/acme/todo', ''],
  ['/modules/acme/todo/', ''],
  ['/modules/acme/todo/frontend.jsx?v=abc', 'frontend.jsx'],
  ['https://acme.portal.pa1nd.de/modules/acme/todo/frontend.jsx', 'frontend.jsx'],
  ['http://localhost:18440/modules/acme/todo/frontend.js?rev=12', 'frontend.js'],
  ['/modules/acme/todo/modules/other/app/x', 'modules/other/app/x'],
  ['/api/acme/todo/items/7?q=1', 'items/7'],
  ['/acme/todo/some/deep/route?tab=2', 'some/deep/route'],
  ['/acme/todo', ''],
]
for (const [input, rest] of cases) {
  test(`self(${input})`, () => {
    const got = self(input)
    for (const k of Object.keys(want)) assert.equal(got[k], want[k], k)
    assert.equal(got.rest, rest)
  })
}

test('encoding, garbage, reserved first segments', () => {
  assert.equal(self('/modules/a%20b/c-d_e/x').qid, 'a b/c-d_e')
  assert.equal(self('/modules/a%20b/c-d_e/x').api, '/api/a%20b/c-d_e')
  assert.equal(self('/').api, '')
  assert.equal(self('/modules/acme').api, '')
  assert.equal(self('/modules/x/y').company, 'x')
  assert.equal(self('/api/x').api, '')
})

test('1.x compatibility fields', () => {
  const s = self('/modules/acme/todo/frontend.js')
  assert.equal(s.workspace, 'acme')
  assert.equal(s.id, 'todo')
  assert.equal(s.topic, 'acme/todo')
  assert.equal(typeof s.subscribe, 'function')
  assert.equal(typeof self('/').subscribe(() => {}), 'function')     // no qid → a no-op unsubscribe
})

test('subscribe maps the qid to the instance and delivers invalidations only', () => {
  const subs = []
  const subscribe = (topic, fn) => { subs.push({ topic, fn }); return () => subs.pop() }
  const instanceFor = (c, a) => (c === 'acme' && a === 'todo' ? 'inst-42' : null)
  const s = self('/modules/acme/todo/frontend.js', { instanceFor, subscribe })
  const got = []
  const unsub = s.subscribe((ev) => got.push(ev))
  assert.equal(subs[0].topic, 'inst-42')                                          // the module never sees the instance
  subs[0].fn({ type: 'snapshot', topic: 'inst-42', snapshot: { seq: 3 } })          // the mount snapshot is not a change
  assert.deepEqual(got, [])
  subs[0].fn({ type: 'invalidate', topic: 'inst-42', seq: 4, stream: 'h:e' })
  assert.deepEqual(got, [{ type: 'invalidate', topic: 'acme/todo', seq: 4 }])
  subs[0].fn({ type: 'snapshot', topic: 'inst-42', snapshot: { seq: 9 } })          // a gap snapshot is
  assert.deepEqual(got[1], { type: 'invalidate', topic: 'acme/todo', seq: 9 })
  subs[0].fn({ type: 'denied', topic: 'inst-42' })
  assert.equal(got.length, 2)
  unsub()
  assert.equal(subs.length, 0)
})

test('subscribe falls back to the qid when the row is unknown', () => {
  const subs = []
  const s = self('/modules/acme/todo/x.js', { instanceFor: () => null, subscribe: (t, fn) => { subs.push(t); return () => {} } })
  s.subscribe(() => {})
  assert.deepEqual(subs, ['acme/todo'])
})
