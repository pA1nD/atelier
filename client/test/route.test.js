import test from 'node:test'
import assert from 'node:assert/strict'
import { parseUrl, buildUrl, SLUG_RE } from '../route.js'
import { SLUG_RE as PROTOCOL_SLUG_RE } from '../../protocol/registry.js'

test('SLUG_RE is protocol/registry\'s rule', () => {
  assert.equal(SLUG_RE.source, PROTOCOL_SLUG_RE.source)
})

const rows = [
  ['/', { ws: null, id: null, rest: '' }],
  ['/acme/', { ws: 'acme', id: null, rest: '' }],
  ['/acme', { ws: 'acme', id: null, rest: '' }],
  ['/acme/todo', { ws: 'acme', id: 'todo', rest: '' }],
  ['/acme/todo/', { ws: 'acme', id: 'todo', rest: '' }],
  ['/acme/todo/items/7/', { ws: 'acme', id: 'todo', rest: 'items/7' }],
  ['/acme/todo/a%20b', { ws: 'acme', id: 'todo', rest: 'a b' }],              // decoded once
  ['/acme/todo/a%2520b', { ws: 'acme', id: 'todo', rest: 'a%20b' }],          // never twice
  ['/global/weather', { ws: 'global', id: 'weather', rest: '' }],
  ['/modules/acme/todo', { ws: null, id: null, rest: '' }],                    // a mount prefix is never a company
  ['/api/acme/todo', { ws: null, id: null, rest: '' }],
  ['/assets/client.js', { ws: null, id: null, rest: '' }],
  ['/My_App/x', { ws: null, id: null, rest: '' }],                             // not one DNS label
  ['/acme/My_App', { ws: 'acme', id: null, rest: '' }],                        // the app segment alone is refused
  ['/acme/-todo', { ws: 'acme', id: null, rest: '' }],
  ['/acme/todo-', { ws: 'acme', id: null, rest: '' }],
  ['/acme/%zz', { ws: 'acme', id: null, rest: '' }],                           // undecodable → null, never a throw
]
for (const [input, want] of rows) test(`parseUrl(${input})`, () => assert.deepEqual(parseUrl(input), want))

test('buildUrl', () => {
  assert.equal(buildUrl(null), '/')
  assert.equal(buildUrl('acme', null), '/acme/')
  assert.equal(buildUrl('acme', 'todo'), '/acme/todo')
  assert.equal(buildUrl('acme', 'todo', '/items/7/'), '/acme/todo/items/7')
  assert.equal(buildUrl('acme', 'todo', ''), '/acme/todo')
})

test('parse ∘ build round-trips', () => {
  for (const [ws, id, rest] of [['acme', 'todo', 'items/7'], ['acme', null, ''], ['acme', 'todo', '']]) {
    assert.deepEqual(parseUrl(buildUrl(ws, id, rest)), { ws, id, rest })
  }
})
