// Unit tests for the shared chrome-resolution logic — the SAME module the
// server uses to pick a document's chrome AND the client uses to decide
// SPA-push vs full-reload (and to render the "chrome not installed" error).
// Testing it here is what makes those browser-side decisions trustworthy
// without a browser: there's one implementation, exercised directly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chromeQidFor,
  resolveModuleChrome,
  missingChrome,
} from '../chrome-resolve.js'

// Two installed chromes; the first is the instance default.
const AVAIL = ['global/base-chrome', 'global/alt-chrome']
const DEF = 'global/base-chrome'

test('chromeQidFor normalizes an id or a qid to global/<id>', () => {
  assert.equal(chromeQidFor('alt-chrome'), 'global/alt-chrome')
  assert.equal(chromeQidFor('global/alt-chrome'), 'global/alt-chrome')
})

test('resolveModuleChrome: no meta.chrome → the default chrome', () => {
  for (const c of [undefined, null, '']) {
    assert.equal(resolveModuleChrome(c, AVAIL, DEF), DEF)
  }
})

test('resolveModuleChrome: meta.chrome names an available chrome → that chrome', () => {
  assert.equal(resolveModuleChrome('alt-chrome', AVAIL, DEF), 'global/alt-chrome')
  assert.equal(resolveModuleChrome('global/alt-chrome', AVAIL, DEF), 'global/alt-chrome')
})

test('resolveModuleChrome: meta.chrome not available → default (host frame; the error is handled separately)', () => {
  assert.equal(resolveModuleChrome('ghost-chrome', AVAIL, DEF), DEF)
})

test('missingChrome: pinned-but-absent → the pinned name; otherwise null', () => {
  assert.equal(missingChrome('ghost-chrome', AVAIL), 'ghost-chrome')   // → show error
  assert.equal(missingChrome('alt-chrome', AVAIL), null)               // present
  assert.equal(missingChrome('global/base-chrome', AVAIL), null)       // present (qid form)
  assert.equal(missingChrome(undefined, AVAIL), null)                  // no meta.chrome → no error
  assert.equal(missingChrome('', AVAIL), null)
})

test('additive: with NO chromes available, a pinned meta.chrome is "missing" but a module without one still resolves to the (null) default', () => {
  assert.equal(missingChrome('alt-chrome', []), 'alt-chrome')
  assert.equal(resolveModuleChrome(undefined, [], null), null)
})

test('server/client agreement: resolve + missing are consistent for every input', () => {
  // A module is EITHER missing (error) XOR resolves to a real chrome — never
  // both. This invariant is what keeps the document chrome and the client
  // reload decision in lockstep.
  for (const chrome of [undefined, 'alt-chrome', 'ghost-chrome', 'global/base-chrome']) {
    const missing = missingChrome(chrome, AVAIL)
    const resolved = resolveModuleChrome(chrome, AVAIL, DEF)
    if (missing) assert.equal(resolved, DEF, 'missing → hosts in default')
    else assert.ok(AVAIL.includes(resolved) || resolved === DEF, 'resolves to a real chrome')
  }
})
