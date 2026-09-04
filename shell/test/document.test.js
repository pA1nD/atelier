// shell/document.mjs — head order, preloads, escaping, chromeApi 2, one sheet, CSP nonce, no-store.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { renderDocument, escapeBootstrap, relativeImports, composeDocument, FALLBACK_TEMPLATE, SLOTS, preloadsFor, sheetFor } from '../document.mjs'
import { createConfig } from '../config.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const person = { id: 'local', name: 'local', epoch: null }
const chrome = { qid: 'global/catalyst-chrome', rev: 1700, hasKit: true, hasStyles: true }
const modules = [
  { instance: 'i-aaaaaaaaaaaaaaaa', slug: 'weather', company: 'global', rev: 7, state: 'live', meta: { name: 'Weather', icon: '☀' }, primary: true },
  { instance: 'i-bbbbbbbbbbbbbbbb', slug: 'toybox', company: 'global', rev: 3, state: 'live', meta: { name: 'Toybox' } },
  { instance: null, slug: 'pending', company: 'global', rev: null, state: 'pending', meta: {} },
]
const pos = (html, re) => { const m = re.exec(html); assert.ok(m, `missing ${re}`); return m.index }

test('head order: styles < react < react-dom < bootstrap < importmap < preloads < client', () => {
  const { html } = renderDocument({ company: 'global', slug: 'weather', person, modules, chrome, entryImports: ['./uiverse-picks.js'] })
  const order = [
    /<link id="atelier-chrome-styles" rel="stylesheet"/, /<script src="\/assets\/react\.js">/, /<script src="\/assets\/react-dom\.js">/,
    /<script nonce="[^"]+">window\.__ATELIER__ =/, /<script type="importmap" nonce="[^"]+">/, /<link rel="modulepreload"/, /<script type="module" src="\/assets\/client\.js">/,
  ].map((re) => pos(html, re))
  for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], `slot ${i} out of order`)
})

test('the preload list: client, chrome-resolve, chrome bundle, kit, the entry and its relative import — after the import map', () => {
  const r = renderDocument({ company: 'global', slug: 'weather', person, modules, chrome, entryImports: ['./uiverse-picks.js', '../escape.js'] })
  assert.deepEqual(r.preloads, [
    '/assets/client.js', '/assets/chrome-resolve.js',
    '/modules/global/catalyst-chrome/frontend.js?rev=1700', '/modules/global/catalyst-chrome/kit.js?rev=1700',
    '/modules/global/weather/frontend.js?rev=7', '/modules/global/weather/uiverse-picks.js?rev=7',
  ])
  const im = r.html.indexOf('type="importmap"'), pre = r.html.indexOf('rel="modulepreload"')
  assert.ok(im > 0 && pre > im)
  assert.match(r.html, /"@atelier\/kit":"\/modules\/global\/catalyst-chrome\/kit\.js\?rev=1700"/)
})

test('one <link>: the app sheet on /c/s, the chrome sheet on /c/ and on an unknown slug', () => {
  const app = renderDocument({ company: 'global', slug: 'toybox', person, modules, chrome })
  assert.equal(app.sheet, '/modules/global/toybox/styles.css?rev=3')
  assert.equal((app.html.match(/<link id="atelier-chrome-styles"/g) ?? []).length, 1)
  const bare = renderDocument({ company: 'global', person, modules, chrome })
  assert.equal(bare.sheet, '/modules/global/catalyst-chrome/styles.css?rev=1700')
  const unknown = renderDocument({ company: 'global', slug: 'nope', person, modules, chrome })
  assert.equal(unknown.sheet, '/modules/global/catalyst-chrome/styles.css?rev=1700')
  assert.equal(unknown.bootstrap.activeQid, null)
  const none = renderDocument({ company: 'global', person, modules, chrome: null })
  assert.equal(none.sheet, null)
  assert.ok(!none.html.includes('rel="stylesheet"'))
  assert.ok(!none.html.includes('importmap'))
})

test('the bootstrap: chromeApi 2, chromes = exactly the document chrome, module rows with instance + rev, primary from the row, pending rows dropped', () => {
  const { bootstrap: b } = renderDocument({ cfg: { label: 'Lab' }, company: 'global', slug: 'weather', person, modules, chrome, companies: [{ id: 'global', name: 'global', href: '/global/' }] })
  assert.equal(b.chromeApi, 2)
  assert.deepEqual(b.chromes, ['global/catalyst-chrome'])
  assert.equal(b.chromeRev, 1700)
  assert.equal(b.activeQid, 'global/weather')
  assert.equal(b.label, 'Lab')
  assert.equal(b.portal, null)
  assert.deepEqual(b.workspaces, [{ id: 'global', name: 'global' }])
  assert.deepEqual(b.user.workspaces[0].modules.map((m) => m.id), ['weather', 'toybox'])
  assert.deepEqual(b.user.workspaces[0].modules[0], { id: 'weather', instance: 'i-aaaaaaaaaaaaaaaa', rev: 7, hasFrontend: true, meta: { name: 'Weather', icon: '☀', primary: true } })
  assert.deepEqual(b.backendErrors, [])
  assert.deepEqual(b.companies, [{ id: 'global', name: 'global', href: '/global/' }])
})

test('bootstrap escaping: </script>, U+2028/9, a function value', () => {
  const s = escapeBootstrap({ a: '</script><script>alert(1)</script>', b: 'x y z', f() {}, n: 1 })
  assert.ok(!s.includes('</script>'))
  assert.ok(!s.includes(' ') && !s.includes(' '))
  assert.ok(!s.includes('"f"'))
  assert.deepEqual(JSON.parse(s), { a: '</script><script>alert(1)</script>', b: 'x y z', n: 1 })
  // it is valid JS source too
  assert.deepEqual(new Function('return ' + s)(), { a: '</script><script>alert(1)</script>', b: 'x y z', n: 1 })
})

test('CSP: one nonce on both inline scripts, no-store, nosniff, font hosts, form-action with the portal', () => {
  const r = renderDocument({ cfg: { csp: { fontHosts: ['https://rsms.me'] } }, company: 'acme', person, modules: [], chrome, portal: 'https://portal.pa1nd.de' })
  const nonces = [...r.html.matchAll(/nonce="([^"]+)"/g)].map((m) => m[1])
  assert.equal(nonces.length, 2)
  assert.ok(nonces.every((n) => n === r.nonce))
  const cspv = r.headers['content-security-policy']
  assert.ok(cspv.includes(`script-src 'self' 'nonce-${r.nonce}'`))
  assert.ok(cspv.includes("font-src 'self' data: https://rsms.me"))
  assert.ok(cspv.includes("style-src 'self' 'unsafe-inline' https://rsms.me"))
  assert.ok(cspv.includes("form-action 'self' https://portal.pa1nd.de"))
  // the defaults (review 2026-09-02, S3): the fleet self-hosts the chrome's fonts (`/_chrome/<digest>/fonts/`) → no font host;
  // local runs the chrome folder, whose frontend.jsx loads Inter from rsms.me → that host; a config's own list wins in both
  assert.deepEqual(createConfig({ mode: 'fleet', config: {}, env: {} }).cfg.csp.fontHosts, [])
  assert.deepEqual(createConfig({ mode: 'local', config: {}, env: {} }).cfg.csp.fontHosts, ['https://rsms.me'])
  assert.deepEqual(createConfig({ mode: 'fleet', config: { csp: { fontHosts: ['https://fonts.example'] } }, env: {} }).cfg.csp.fontHosts, ['https://fonts.example'])
  const fleet = renderDocument({ cfg: createConfig({ mode: 'fleet', config: {}, env: {} }).cfg, company: 'acme', person, modules: [], chrome, portal: 'https://portal.pa1nd.de' }).headers['content-security-policy']
  assert.ok(fleet.includes("font-src 'self' data:;") && fleet.includes("style-src 'self' 'unsafe-inline';"), fleet)
  assert.ok(cspv.includes("frame-ancestors 'none'"))
  assert.equal(r.headers['cache-control'], 'no-store')
  assert.equal(r.headers['x-content-type-options'], 'nosniff')
  assert.equal(r.headers['referrer-policy'], 'same-origin')
  assert.equal(r.bootstrap.portal, 'https://portal.pa1nd.de')
})

test('relativeImports lists ./ specifiers once, .jsx as .js; a template without the slots is refused', () => {
  assert.deepEqual(relativeImports(`import React from 'react'\nimport { a } from './a.jsx'\nimport './b.js'\nimport x from "./a.jsx"\nimport('./lazy.js')`), ['./a.js', './b.js'])
  assert.deepEqual(relativeImports(`import { h } from './helper.js?rev=4'\nimport '../up.js#x'`), ['./helper.js', '../up.js'])
  assert.throws(() => composeDocument({ template: '<html></html>', nonce: 'n', bootstrap: {}, sheet: null, importMap: null }), /slot/)
  for (const s of Object.values(SLOTS)) assert.ok(FALLBACK_TEMPLATE.includes(s))
})

test('the chrome by digest (step 7 ship C, decision 5): `base` puts every chrome asset under /_chrome/<digest>/ with no ?rev=, the app-less sheet is chrome.css, the bootstrap carries chromeBase + chromeRev = the digest and a row\'s chromeDigest; without `base` nothing of it appears', () => {
  const D = 'd'.repeat(64)
  const byDigest = { qid: 'portal/catalyst-chrome', rev: D, hasKit: true, hasStyles: true, base: `/_chrome/${D}` }
  const rows = [{ ...modules[0], company: 'acme', chromeDigest: D }, { ...modules[1], company: 'acme', chromeDigest: null }]
  const bare = renderDocument({ company: 'acme', person, modules: rows, chrome: byDigest })
  assert.equal(bare.sheet, `/_chrome/${D}/chrome.css`)
  assert.deepEqual(bare.preloads, ['/assets/client.js', '/assets/chrome-resolve.js', `/_chrome/${D}/frontend.js`, `/_chrome/${D}/kit.js`])
  assert.match(bare.html, new RegExp(`"@atelier/kit":"/_chrome/${D}/kit\\.js"`))
  assert.equal(bare.bootstrap.chromeRev, D); assert.equal(bare.bootstrap.chromeBase, `/_chrome/${D}`)
  assert.deepEqual(bare.bootstrap.user.workspaces[0].modules.map((m) => m.chromeDigest), [D, undefined])
  const app = renderDocument({ company: 'acme', slug: 'weather', person, modules: rows, chrome: byDigest, entryImports: ['./x.js'] })
  assert.equal(app.sheet, '/modules/acme/weather/styles.css?rev=7')
  assert.deepEqual(app.preloads, ['/assets/client.js', '/assets/chrome-resolve.js', `/_chrome/${D}/frontend.js`, `/_chrome/${D}/kit.js`, '/modules/acme/weather/frontend.js?rev=7', '/modules/acme/weather/x.js?rev=7'])
  assert.ok(!app.html.includes('?rev=' + D) && !app.html.includes(`/_chrome/${D}/frontend.js?`), 'immutable URLs carry no cache-buster')
  const rowShape = renderDocument({ company: 'acme', person, modules: rows.map((r) => ({ ...r, chromeDigest: null })), chrome: { qid: 'portal/catalyst-chrome', rev: null, hasKit: true, hasStyles: true } })
  assert.ok(!('chromeBase' in rowShape.bootstrap) && !rowShape.html.includes('chromeBase') && !rowShape.html.includes('chromeDigest') && !rowShape.html.includes('/_chrome/'))
  assert.equal(rowShape.sheet, '/modules/portal/catalyst-chrome/styles.css')
})

// STEP5_BASE: the step-5 document this proof compares against — the commit the fleet rendered with before the chrome
// store (the moving `step5` branch now CONTAINS the chrome lane, and its document.mjs imports ../protocol, which the temp
// copy cannot resolve). A shallow or ref-less checkout self-skips.
const STEP5_BASE = '17782ce0631d8dc071e020aa337c716411df2dfa'
// self-skips without the base commit: a shallow or ref-less checkout (CI on a clone without that branch) loses this proof
// silently — run it from a full checkout when the null-digest path is touched (review 2026-09-02, Opus lens 2)
test('a null digest is step 5\'s document byte for byte: the same inputs through the step5 document.mjs (git show step5:shell/document.mjs) and this one compose identical html', async (t) => {
  let src
  try { src = execFileSync('git', ['-C', REPO, 'show', `${STEP5_BASE}:shell/document.mjs`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { t.skip('no git / no step-5 base commit here'); return }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'step5-doc-'))
  fs.writeFileSync(path.join(dir, 'document.mjs'), src)
  const step5 = await import(pathToFileURL(path.join(dir, 'document.mjs')).href)
  const nonce = 'n0nce'
  const chromes = [{ qid: 'portal/catalyst-chrome', rev: null, hasKit: true, hasStyles: true }, chrome, null]
  const cfg = { label: 'Lab', csp: { fontHosts: [] } }
  for (const c of chromes) for (const slug of [null, 'weather', 'nope']) {
    const args = { cfg, template: FALLBACK_TEMPLATE, company: 'global', slug, person, modules, chrome: c, companies: [{ id: 'global', name: 'global', href: '/global/' }], portal: 'https://portal.pa1nd.de', entryImports: ['./x.js'], nonce }
    const now = renderDocument(args), then = step5.renderDocument(args)
    assert.equal(now.html, then.html, `chrome ${c?.rev} slug ${slug}`)
    assert.deepEqual(now.headers, then.headers)
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the URL names the bytes: a row with a content id (deployed_rev) rides under it, a bare row under its counter', () => {
  const modules = [{ slug: 'weather', instance: 'i-1', rev: 7, deployed_rev: 'a9b6d0e377f8' }, { slug: 'bare', instance: 'i-2', rev: 3 }]
  const chrome = { qid: 'global/portal-chrome', rev: 'c0ffee00c0de', hasKit: true, hasStyles: true }
  const pre = preloadsFor({ company: 'global', slug: 'weather', modules, chrome, entryImports: ['./x.js'] })
  assert.ok(pre.includes('/modules/global/weather/frontend.js?rev=a9b6d0e377f8'), pre.join(' '))
  assert.ok(pre.includes('/modules/global/weather/x.js?rev=a9b6d0e377f8'))
  assert.ok(pre.includes('/modules/global/portal-chrome/frontend.js?rev=c0ffee00c0de'))
  assert.equal(sheetFor({ company: 'global', slug: 'weather', modules, chrome }), '/modules/global/weather/styles.css?rev=a9b6d0e377f8')
  assert.equal(sheetFor({ company: 'global', slug: 'bare', modules, chrome }), '/modules/global/bare/styles.css?rev=3')
})
