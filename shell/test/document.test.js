// shell/document.mjs — head order, preloads, escaping, chromeApi 2, one sheet, CSP nonce, no-store.
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderDocument, escapeBootstrap, relativeImports, composeDocument, FALLBACK_TEMPLATE, SLOTS } from '../document.mjs'

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
