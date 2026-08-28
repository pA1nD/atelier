import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildClient, readTemplate, SLOTS, clientSources, clientMtime, CLIENT_ENTRY } from '../build.mjs'

test('client.jsx bundles (the JSX parses; every import resolves)', async () => {
  const { js, mtime } = await buildClient()
  assert.ok(js.length > 10_000)
  assert.ok(mtime > 0)
  assert.ok(!js.includes('import '), 'one bundle: no bare imports left')       // chrome-resolve.js and the pure modules inlined
  const min = await buildClient({ minify: true })
  assert.ok(min.js.length < js.length)
})

test('the fork carries none of the removed 1.x surfaces', async () => {
  const src = fs.readFileSync(CLIENT_ENTRY, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')   // code, not comments
  for (const gone of ['?v=$', 'TopBarCenter', 'meta.eager', 'meta?.eager', 'Takeover', '/_atelier/client-errors', "subscribe('shell'", 'refreshChromeStyles', 'flattenUserModules', 'boot.backendErrors']) {
    assert.ok(!src.includes(gone), `still present: ${gone}`)
  }
  for (const kept of ['?rev=', '/_atelier/topics/', '/_atelier/rail', '/_atelier/report', 'company:${COMPANY}', 'pageshow', 'visibilitychange', 'WakingFallback', 'missingChrome(']) {
    assert.ok(src.includes(kept), `missing: ${kept}`)
  }
})

test('index.html: the five slots (shell/document.mjs SLOTS) in head order, React between styles and bootstrap', () => {
  const html = readTemplate()
  let last = -1
  for (const s of SLOTS) { const i = html.indexOf(s); assert.ok(i > last, `${s} out of order or missing`); last = i }
  const code = html.replace(/<!--(?!__)[\s\S]*?-->/g, '')                     // drop the comments, keep the slots
  const at = (needle) => { const i = code.indexOf(needle); assert.ok(i >= 0, `missing ${needle}`); return i }
  assert.ok(at('<!--__STYLES__-->') < at('/assets/react.js'))
  assert.ok(at('/assets/react.js') < at('/assets/react-dom.js'))
  assert.ok(at('/assets/react-dom.js') < at('<!--__BOOTSTRAP__-->'))
  assert.ok(at('<!--__IMPORTMAP__-->') < at('<!--__PRELOADS__-->'))
  assert.ok(at('<!--__PRELOADS__-->') < at('</head>'))
  assert.ok(at('<div id="root">') < at('<!--__CLIENT__-->'))
  assert.equal((code.match(/<script/g) || []).length, 2)                       // the two UMDs; bootstrap, importmap and the client come from the slots
  assert.ok(!html.includes('__ATELIER_CHROME_STYLES__') && !html.includes('__ATELIER_BOOTSTRAP__'))   // the 1.x slot names are gone
})

test('clientSources lists the entry, chrome-resolve and the pure modules', () => {
  const names = clientSources().map((p) => p.split('/').pop())
  for (const n of ['client.jsx', 'chrome-resolve.js', 'bridge.js', 'self.js', 'route.js', 'sheet.js', 'picker.js', 'reporter.js', 'waking.js']) assert.ok(names.includes(n), n)
  assert.ok(!names.includes('build.mjs'))
  assert.ok(clientMtime() > 0)
})

test('the bundle evaluates under a stub browser: the socket opens, the hooks are wired, the root renders', async () => {
  const { js } = await buildClient()
  const os = await import('node:os'); const path = await import('node:path')
  const file = path.join(os.tmpdir(), `atelier-client-smoke-${process.pid}.mjs`)
  fs.writeFileSync(file, js)
  const { FakeWebSocket } = await import('./fakes.js')
  FakeWebSocket.reset()
  const listeners = { window: {}, document: {} }
  const React = (await import('react')).default
  globalThis.React = React
  globalThis.ReactDOM = { createRoot: () => ({ render: (el) => { globalThis.__rendered = el } }) }
  globalThis.window = {
    __ATELIER__: { mode: 'host', chromeApi: 2, user: { id: 'local', name: 'local', workspaces: [{ id: 'global', name: 'global', modules: [{ id: 'weather', instance: 'i-1', rev: 4, hasFrontend: true, meta: { name: 'Weather' } }] }] },
      workspace: 'global', workspaces: [{ id: 'global', name: 'global' }], companies: [{ id: 'global', name: 'global', href: '/global/' }], portal: null,
      activeQid: 'global/weather', chromeQid: 'global/catalyst-chrome', defaultChromeQid: 'global/catalyst-chrome', chromes: ['global/catalyst-chrome'], chromeRev: 'abc', backendErrors: [] },
    location: { protocol: 'http:', host: 'localhost:18440', pathname: '/global/weather', search: '', href: 'http://localhost:18440/global/weather' },
    WebSocket: FakeWebSocket, fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval: (f, ms) => setInterval(f, ms).unref(), clearInterval,
    addEventListener: (ev, fn) => { listeners.window[ev] = fn }, removeEventListener: () => {}, dispatchEvent: () => true, history: { pushState() {}, replaceState() {} },
    React,
  }
  globalThis.document = { visibilityState: 'visible', addEventListener: (ev, fn) => { listeners.document[ev] = fn }, getElementById: () => ({}), createElement: () => ({ setAttribute() {}, appendChild() {} }), body: { appendChild() {} } }
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'smoke' }, configurable: true, writable: true })
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail } }
  try {
    await import(file)
    assert.equal(FakeWebSocket.instances.length, 1)
    assert.equal(FakeWebSocket.last().url, 'ws://localhost:18440/_atelier/ws?company=global')
    assert.ok(listeners.document.visibilitychange && listeners.window.online && listeners.window.pageshow, 'foreground hooks wired')
    assert.ok(listeners.window.error && listeners.window.unhandledrejection, 'reporter wired')
    assert.ok(globalThis.__rendered, 'root rendered')
    const at = globalThis.window.__atelier
    assert.equal(typeof at.subscribe, 'function'); assert.equal(typeof at.self, 'function'); assert.equal(typeof at.useRoute, 'function'); assert.equal(typeof at.navigate, 'function')
    const s = at.self('http://localhost:18440/modules/global/weather/frontend.js?rev=4')
    assert.equal(s.api, '/api/global/weather'); assert.equal(s.topic, 'global/weather')
    const seen = []
    s.subscribe((ev) => seen.push(ev))
    assert.equal(at.bridge.state().topics['i-1'].handlers, 1)        // qid → instance through the bootstrap row
    at.bridge.stop()
  } finally {
    fs.rmSync(file, { force: true })
    delete globalThis.window; delete globalThis.document; delete globalThis.React; delete globalThis.ReactDOM; delete globalThis.CustomEvent
  }
})
