import test from 'node:test'
import assert from 'node:assert/strict'
import { swapSheet, sheetHref, SHEET_ID } from '../sheet.js'
import { fakeDocument } from './fakes.js'

function docWithSheet(href) {
  const doc = fakeDocument()
  const link = doc.createElement('link')
  link.setAttribute('id', SHEET_ID); link.setAttribute('rel', 'stylesheet'); link.setAttribute('href', href)
  doc.head.appendChild(doc.createElement('meta'))
  doc.head.appendChild(link)
  doc.head.appendChild(doc.createElement('script'))
  return doc
}

test('sheetHref: app sheet at its rev, chrome sheet without an app, ?rev= never ?v=', () => {
  assert.equal(sheetHref({ company: 'global', slug: 'toybox', rev: 13 }, null), '/modules/global/toybox/styles.css?rev=13')
  assert.equal(sheetHref(null, { qid: 'global/catalyst-chrome', rev: 'abc' }), '/modules/global/catalyst-chrome/styles.css?rev=abc')
  assert.equal(sheetHref({ company: 'global', slug: 'toybox', rev: null }, null), '/modules/global/toybox/styles.css')
  assert.equal(sheetHref(null, null), null)
  // by digest (step 7 ship C): the bundle's compiled chrome-only sheet, immutable, no cache-buster
  assert.equal(sheetHref(null, { qid: 'portal/catalyst-chrome', rev: 'd'.repeat(64), base: `/_chrome/${'d'.repeat(64)}` }), `/_chrome/${'d'.repeat(64)}/chrome.css`)
  assert.equal(sheetHref({ company: 'acme', slug: 'todo', rev: 3 }, { qid: 'portal/catalyst-chrome', base: '/_chrome/x' }), '/modules/acme/todo/styles.css?rev=3', 'an app keeps its own sheet')
  assert.equal(sheetHref({ company: 'a b', slug: 'x', rev: 1 }, null), '/modules/a%20b/x/styles.css?rev=1')
})

test('swap: new link after the old, id transferred at once, old dropped on load', async () => {
  const doc = docWithSheet('/modules/global/weather/styles.css?rev=3')
  let t = 100
  const r = swapSheet(doc, '/modules/global/toybox/styles.css?rev=13', { now: () => t })
  assert.equal(r.swapped, true)
  const links = doc.links()
  assert.equal(links.length, 2)
  assert.equal(links[0].getAttribute('href'), '/modules/global/weather/styles.css?rev=3')
  assert.equal(links[0].id, '')                                       // the old one gave the id up
  assert.equal(links[1].getAttribute('href'), '/modules/global/toybox/styles.css?rev=13')
  assert.equal(links[1].id, SHEET_ID)
  assert.equal(links[1].getAttribute('rel'), 'stylesheet')
  assert.equal(doc.head.children[2], links[1])                        // inserted right after the old, before the script
  t = 140
  links[1].fire('load')
  assert.deepEqual(await r.done, { ok: true, ms: 40 })
  assert.equal(doc.links().length, 1)
  assert.equal(doc.getElementById(SHEET_ID).getAttribute('href'), '/modules/global/toybox/styles.css?rev=13')
})

test('swap: error also drops the old link (never two at rest)', async () => {
  const doc = docWithSheet('/a.css?rev=1')
  const r = swapSheet(doc, '/b.css?rev=2')
  doc.links()[1].fire('error')
  assert.equal((await r.done).ok, false)
  assert.equal(doc.links().length, 1)
})

test('swap: equal href is a no-op; no link is a no-op', () => {
  const doc = docWithSheet('/a.css?rev=1')
  assert.deepEqual(swapSheet(doc, '/a.css?rev=1'), { swapped: false, done: null })
  assert.equal(doc.links().length, 1)
  assert.deepEqual(swapSheet(fakeDocument(), '/a.css?rev=1'), { swapped: false, done: null })
  assert.deepEqual(swapSheet(doc, null), { swapped: false, done: null })
})

test('swap: two swaps in flight chain to exactly one link at rest', async () => {
  const doc = docWithSheet('/a.css?rev=1')
  const r1 = swapSheet(doc, '/b.css?rev=2')
  const r2 = swapSheet(doc, '/c.css?rev=3')
  assert.equal(doc.links().length, 3)
  assert.equal(doc.getElementById(SHEET_ID).getAttribute('href'), '/c.css?rev=3')
  doc.links()[1].fire('load'); await r1.done
  doc.links()[1].fire('load'); await r2.done
  assert.equal(doc.links().length, 1)
  assert.equal(doc.links()[0].getAttribute('href'), '/c.css?rev=3')
  assert.equal(doc.links()[0].id, SHEET_ID)
})
