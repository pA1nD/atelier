// client/chrome.js — the chrome's URLs by digest and the reload rule (step 7 ship C; LANES-CHROME addendum): an app
// document is compared against ITS row's digest, an app-less one against the rail's default, never an app document
// against the default — a pinned (lagging) computer's document loads exactly once.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chromeUrl, railDefault, documentDigest, chromeMoved, targetDigest } from '../chrome.js'

const D = 'd'.repeat(64), PREV = 'e'.repeat(64)
const rail = (def, rows) => ({ stream: 's', seq: 1, modules: rows, chrome: { qid: 'portal/catalyst-chrome', digest: def }, chromeRev: def })

test('chromeUrl: by digest the immutable /_chrome/<digest>/<file> with no cache-buster; by row /modules/<qid>/<file>?rev=; no chrome → null', () => {
  assert.equal(chromeUrl({ chromeQid: 'portal/catalyst-chrome', chromeRev: D, chromeBase: `/_chrome/${D}` }, 'frontend.js'), `/_chrome/${D}/frontend.js`)
  assert.equal(chromeUrl({ chromeQid: 'global/catalyst-chrome', chromeRev: 1700, chromeBase: null }, 'frontend.js'), '/modules/global/catalyst-chrome/frontend.js?rev=1700')
  assert.equal(chromeUrl({ chromeQid: 'portal/catalyst-chrome', chromeRev: null }, 'kit.js'), '/modules/portal/catalyst-chrome/kit.js')
  assert.equal(chromeUrl({ chromeQid: null, chromeRev: null }, 'kit.js'), null)
})

test('railDefault / documentDigest: the frame\'s default (chromeRev, else chrome.digest / chrome.rev); an active row with a digest wins, one without follows the default', () => {
  assert.equal(railDefault(rail(D, [])), D)
  assert.equal(railDefault({ chrome: { digest: PREV } }), PREV)
  assert.equal(railDefault({ chrome: { rev: 1700 } }), 1700)
  assert.equal(railDefault(null), null); assert.equal(railDefault({}), null)
  const r = rail(D, [{ id: 'todo', chromeDigest: PREV }, { id: 'wiki', chromeDigest: null }, { id: 'notes' }])
  assert.equal(documentDigest(r, null), D)
  assert.equal(documentDigest(r, 'todo'), PREV)
  assert.equal(documentDigest(r, 'wiki'), D)
  assert.equal(documentDigest(r, 'notes'), D)
  assert.equal(documentDigest(r, 'unknown'), D)
})

test('the reload rule: a pinned computer\'s app document never reloads while the default moves on (one load); it reloads once its OWN row moves; an app-less document follows the default; a null side compares nothing', () => {
  // the document /acme/todo composed with PREV (todo's computer reports PREV); the fleet default is D
  const pinned = rail(D, [{ id: 'todo', chromeDigest: PREV }, { id: 'wiki', chromeDigest: D }])
  assert.equal(chromeMoved(PREV, pinned, 'todo'), false, 'the row still says PREV: no reload, however many frames arrive')
  assert.equal(chromeMoved(PREV, pinned, 'todo'), false)
  assert.equal(chromeMoved(PREV, rail(D, [{ id: 'todo', chromeDigest: D }]), 'todo'), true, 'the computer converged on D: one reload')
  assert.equal(chromeMoved(D, rail(D, [{ id: 'todo', chromeDigest: D }]), 'todo'), false, 'and the new document is at rest')
  assert.equal(chromeMoved(D, rail(D, [{ id: 'todo', chromeDigest: PREV }]), 'todo'), true, 'a rollback of the computer reloads too')
  // app-less: the default
  assert.equal(chromeMoved(PREV, pinned, null), true)
  assert.equal(chromeMoved(D, pinned, null), false)
  // a row without a digest follows the default
  assert.equal(chromeMoved(D, rail(D, [{ id: 'todo', chromeDigest: null }]), 'todo'), false)
  assert.equal(chromeMoved(PREV, rail(D, [{ id: 'todo' }]), 'todo'), true)
  // locally: mtime stamps compare as strings, as before
  assert.equal(chromeMoved(1700, { chrome: { qid: 'global/c', digest: 1701 }, chromeRev: 1701, modules: [] }, null), true)
  assert.equal(chromeMoved(1700, { chrome: { qid: 'global/c', digest: 1700 }, chromeRev: 1700, modules: [] }, 'todo'), false)
  // nothing to compare
  assert.equal(chromeMoved(null, pinned, 'todo'), false)
  assert.equal(chromeMoved(D, rail(null, []), null), false)
  assert.equal(chromeMoved(D, null, null), false)
})

test('targetDigest: a navigation target renders its row\'s digest, else the rail\'s default, else the document\'s own', () => {
  assert.equal(targetDigest({ row: { chromeDigest: PREV }, railDefault: D, bootRev: D }), PREV)
  assert.equal(targetDigest({ row: { chromeDigest: null }, railDefault: D, bootRev: PREV }), D)
  assert.equal(targetDigest({ row: null, railDefault: null, bootRev: PREV }), PREV)
  assert.equal(targetDigest({}), null)
})
