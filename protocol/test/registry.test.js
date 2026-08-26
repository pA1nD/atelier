import test from 'node:test'
import assert from 'node:assert/strict'
import { allowMeta, authorizeWrite, reclaimRule, SLUG_RE, META_KEEP, META_REQUEST, META_ALLOW, RESERVED_COMPANY_IDS, isReservedCompany, TOMBSTONE_MS } from '../registry.js'
import vectors from '../vectors/registry.json' with { type: 'json' }

const fns = { allowMeta, authorizeWrite, reclaimRule }
for (const c of vectors.cases) {
  test(`vector: ${c.name}`, () => { assert.deepEqual(fns[c.fn](c.input), c.expect) })
}

test('the split: META_KEEP ∪ META_REQUEST = META_ALLOW = OR12\'s module.json keys', () => {
  assert.deepEqual([...META_KEEP, ...META_REQUEST].sort(), [...META_ALLOW].sort())
  assert.deepEqual([...META_ALLOW].sort(), ['color', 'group', 'icon', 'name', 'primary', 'visibility'])
  assert.equal(TOMBSTONE_MS, 24 * 3600 * 1000)
})

test('slug and reserved ids', () => {
  for (const ok of ['a', 'todo', 'todo-2', 'a'.repeat(32)]) assert.ok(SLUG_RE.test(ok), ok)
  for (const bad of ['', 'Todo', '-todo', '1todo', 'a'.repeat(33), 'to do', 'todo_2']) assert.ok(!SLUG_RE.test(bad), bad)
  for (const id of RESERVED_COMPANY_IDS) assert.ok(isReservedCompany(id), id)
  assert.ok(isReservedCompany('p-anything') && !isReservedCompany('acme'))
})
