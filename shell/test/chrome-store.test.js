// shell/chrome-store.mjs + routes.mjs lane 4a `/_chrome/<digest>/<path>` + the by-digest document (step 7 ship C,
// LANES-CHROME decisions 4–5): the store answers only what a manifest names; the lane is public, immutable, etag'd,
// gzipped ≥ 1 KiB, 404 without a store / for an unknown digest / for an unlisted path; an app document renders its
// computer's REPORTED digest, an app-less one the company default; a null digest is step 5's document.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { createChromeStore, CHROME_CACHE_CONTROL } from '../chrome-store.mjs'
import { createShell } from '../index.mjs'
import { createConfig } from '../config.mjs'
import { parseRoute, RESERVED_HEADS } from '../routes.mjs'
import { createMinter } from '../minter.mjs'
import { createIdentityFleet } from '../providers/identity-fleet.mjs'
import { createGateFleet } from '../providers/gate-fleet.mjs'
import { createHostLinkFleet } from '../providers/hostlink-fleet.mjs'
import { createIdentityLocal } from '../providers/identity-local.mjs'
import { createGateLocal } from '../providers/gate-local.mjs'
import { createHostLinkLocal } from '../providers/hostlink-local.mjs'
import { chromeDigestOf } from '../../protocol/index.js'
import { fakeHost, fakeRegistry, fakeBus, fleetStores, TODO, WIKI, CHROME_APP } from './fixtures.mjs'

const sha = (b) => createHash('sha256').update(b).digest('hex')
const digestOf = (files) => chromeDigestOf(Object.fromEntries(Object.entries(files).map(([p, b]) => [p, sha(b)])))
const CHROME_QID = 'portal/catalyst-chrome'

// writeBundle(root, files) → digest: the spine's layout — <root>/<digest>/<path> + manifest.json
function writeBundle(root, files, { digest: forced = null, manifest: patch = null } = {}) {
  const shas = Object.fromEntries(Object.entries(files).map(([p, b]) => [p, sha(b)]))
  const digest = forced ?? chromeDigestOf(shas)
  const dir = path.join(root, digest)
  for (const [p, b] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), b) }
  const manifest = patch ?? { digest, version: '0.2.2', files: Object.fromEntries(Object.entries(files).map(([p, b]) => [p, { sha256: shas[p], bytes: b.length }])) }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  return digest
}
const BUNDLE = {
  'frontend.js': Buffer.from(`export const meta = {}; export function chrome() { return null }\n// ${'x'.repeat(1500)}\n`),
  'kit.js': Buffer.from('export const Button = 1\n'),
  'styles.css': Buffer.from("@font-face { font-family: 'Inter'; src: url('fonts/Inter.woff2') }\n"),
  'chrome.css': Buffer.from(`.rail{display:flex}\n/* ${'c'.repeat(1200)} */\n`),
  'fonts/Inter.woff2': Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(2000, 7)]),
}

test('the store: a manifest names the bundle; open() only what it lists, bytes checked once against the sha; unknown digest, bad digest and unlisted path are null; a 404 is never cached', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-store-'))
  const D = writeBundle(root, BUNDLE)
  const store = createChromeStore({ root })
  assert.equal(store.has(D), true)
  assert.deepEqual(Object.keys(store.manifest(D).files).sort(), ['chrome.css', 'fonts/Inter.woff2', 'frontend.js', 'kit.js', 'styles.css'])
  assert.equal(store.manifest(D).version, '0.2.2')
  assert.equal(store.open(D, 'kit.js').toString(), 'export const Button = 1\n')
  assert.equal(store.open(D, 'fonts/Inter.woff2').length, 2004)
  assert.equal(store.open(D, 'manifest.json'), null, 'the manifest is the store\'s, never a served path')
  assert.equal(store.open(D, 'nope.js'), null)
  assert.equal(store.open(D, '../' + D + '/kit.js'), null)
  assert.equal(store.open('e'.repeat(64), 'kit.js'), null)
  assert.equal(store.open('not-a-digest', 'kit.js'), null)
  assert.equal(store.manifest(D.toUpperCase()), null)
  // a bundle landing later is seen (no negative cache); a file that does not match its sha is refused, the rest serves
  const LATE = { ...BUNDLE, 'kit.js': Buffer.from('export const Button = 3\n') }, late = digestOf(LATE)
  assert.equal(store.has(late), false)
  writeBundle(root, LATE)
  assert.equal(store.has(late), true)
  const bad = writeBundle(root, { ...BUNDLE, 'kit.js': Buffer.from('export const Button = 2\n') })
  fs.writeFileSync(path.join(root, bad, 'kit.js'), 'export const Button = 22\n')
  assert.equal(store.open(bad, 'kit.js'), null, 'a sha mismatch is refused')
  assert.equal(store.open(bad, 'styles.css').toString(), BUNDLE['styles.css'].toString(), 'the rest of that bundle serves')
  assert.equal(store.type('kit.js'), 'application/javascript; charset=utf-8'); assert.equal(store.type('fonts/Inter.woff2'), 'font/woff2'); assert.equal(store.type('chrome.css'), 'text/css; charset=utf-8')
  store.close()
  fs.rmSync(root, { recursive: true, force: true })
})

// the manifest is trusted only as far as the URL's digest vouches for it (review 2026-09-02, Codex 3 / Grok 3, N1, N2, N4)
test('the store trusts the digest, not the manifest: an entry without a 64-hex sha, shas that do not recompute to the digest → the whole bundle refused; a prototype key is no path (N1); a symlinked file or a symlinked dir on the way (N2) is refused even when the bytes match; the bound drops the least recently USED digest (N4)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-trust-'))
  const store = createChromeStore({ root })
  const good = writeBundle(root, BUNDLE)
  const okFiles = () => Object.fromEntries(Object.entries(BUNDLE).map(([p, b]) => [p, { sha256: sha(b), bytes: b.length }]))
  // no sha / a sha that is not 64 hex / shas that hash to another digest: refused whole, nothing served
  const noSha = writeBundle(root, { ...BUNDLE, 'kit.js': Buffer.from('a\n') }, { manifest: { files: { ...okFiles(), 'kit.js': { bytes: 2 } } } })
  const shortSha = writeBundle(root, { ...BUNDLE, 'kit.js': Buffer.from('b\n') }, { manifest: { files: { ...okFiles(), 'kit.js': { sha256: 'abc', bytes: 2 } } } })
  const wrongSha = writeBundle(root, { ...BUNDLE, 'kit.js': Buffer.from('c\n') }, { manifest: { files: { ...okFiles(), 'kit.js': { sha256: sha('not c\n'), bytes: 2 } } } })
  for (const [d, why] of [[noSha, 'no sha'], [shortSha, 'a short sha'], [wrongSha, 'shas that do not hash to the digest']]) {
    assert.equal(store.has(d), false, why); assert.equal(store.open(d, 'styles.css'), null, `${why}: not even a path whose own sha is right`)
  }
  assert.equal(store.has(good), true)
  // a manifest that names only what it names: `constructor`/`toString` are not paths of this bundle
  for (const p of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) assert.equal(store.open(good, p), null, p)
  // a symlink is never served, even to the right bytes: the file itself, or a directory on the way
  const outside = path.join(root, 'outside'); fs.mkdirSync(path.join(outside, 'fonts'), { recursive: true })
  fs.writeFileSync(path.join(outside, 'kit.js'), BUNDLE['kit.js']); fs.writeFileSync(path.join(outside, 'fonts', 'Inter.woff2'), BUNDLE['fonts/Inter.woff2'])
  const linked = writeBundle(root, { ...BUNDLE, 'chrome.css': Buffer.from('.linked{}\n') })
  fs.rmSync(path.join(root, linked, 'kit.js')); fs.symlinkSync(path.join(outside, 'kit.js'), path.join(root, linked, 'kit.js'))
  fs.rmSync(path.join(root, linked, 'fonts'), { recursive: true }); fs.symlinkSync(path.join(outside, 'fonts'), path.join(root, linked, 'fonts'))
  assert.equal(store.has(linked), true)
  assert.equal(store.open(linked, 'kit.js'), null, 'a symlinked file')
  assert.equal(store.open(linked, 'fonts/Inter.woff2'), null, 'a regular file behind a symlinked dir')
  assert.equal(store.open(linked, 'chrome.css').toString(), '.linked{}\n', 'the bundle\'s own regular files serve')
  // least recently USED: with max 2, touching A keeps A when C arrives; B is re-read from disk
  const reads = [], fsx = { readFileSync: (p, ...a) => { reads.push(String(p)); return fs.readFileSync(p, ...a) }, lstatSync: fs.lstatSync.bind(fs), realpathSync: fs.realpathSync.bind(fs) }
  const lru = createChromeStore({ root, fs: fsx, max: 2 })
  const A = good, B = linked, C = writeBundle(root, { ...BUNDLE, 'chrome.css': Buffer.from('.c{}\n') })
  lru.manifest(A); lru.manifest(B); lru.manifest(A); lru.manifest(C)
  const manifestReads = () => reads.filter((p) => p.endsWith('manifest.json')).map((p) => path.basename(path.dirname(p)))
  reads.length = 0
  lru.manifest(A); assert.deepEqual(manifestReads(), [], 'A was touched: still cached')
  lru.manifest(B); assert.deepEqual(manifestReads(), [B], 'B was the least recently used: dropped, read again')
  store.close(); lru.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('the route: /_chrome/<digest>/<path> parses only a 64-hex digest with a path; `_chrome` is a reserved head', () => {
  const D = 'd'.repeat(64)
  assert.deepEqual(parseRoute(`/_chrome/${D}/frontend.js`), { kind: 'chrome', digest: D, rest: 'frontend.js' })
  assert.deepEqual(parseRoute(`/_chrome/${D}/fonts/Inter.woff2`), { kind: 'chrome', digest: D, rest: 'fonts/Inter.woff2' })
  assert.equal(parseRoute(`/_chrome/${D}`).kind, 'none')
  assert.equal(parseRoute(`/_chrome/${D}/`).kind, 'none')
  assert.equal(parseRoute('/_chrome/abc/frontend.js').kind, 'none')
  assert.equal(parseRoute(`/_chrome/${D.toUpperCase()}/frontend.js`).kind, 'none')
  assert.equal(parseRoute('/_chrome').kind, 'none')
  assert.ok(RESERVED_HEADS.has('_chrome'))
})

// a shell rig: fleet (acme's document, a store under a temp root) or local (no store)
async function rig(t, { mode = 'fleet', store = true, chrome, rows = null } = {}) {
  const host = fakeHost({ company: mode === 'local' ? 'global' : 'acme' })
  const hp = await host.start()
  const root = store ? fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-lane-')) : null
  const apps = (company) => rows ?? [
    { instance: TODO, slug: 'todo', company, rev: 3, state: 'live', meta: { name: 'Todo' }, primary: true },
    { instance: WIKI, slug: 'wiki', company, rev: 1, state: 'stopped', meta: { name: 'Wiki' } },
  ]
  const chromeRow = (company) => ({ instance: CHROME_APP, slug: 'catalyst-chrome', company, rev: 2, state: 'live', meta: {}, isChrome: true })
  const companies = mode === 'local'
    ? { global: { apps: [...apps('global'), chromeRow('global')], host: { port: hp, token: 'dev' } } }
    : { portal: { apps: [chromeRow('portal')], host: { port: hp, token: 'tok', epoch: 'e1' } }, acme: { apps: apps('acme'), host: { port: hp, token: 'tok', epoch: 'e1', chat: 'chat-acme' } } }
  const registry = fakeRegistry({ mode, companies, chrome: chrome ?? (mode === 'fleet' ? { qid: CHROME_QID, digest: null } : undefined) })
  const bus = fakeBus({ registry })
  const stores = fleetStores()
  const { cfg: base } = createConfig({ mode, config: {}, env: { PORT: '0' } })
  const cfg = { ...base, ...(root ? { chromeStore: root } : {}) }
  const minter = createMinter()
  const providers = mode === 'local'
    ? { identity: createIdentityLocal(), gate: createGateLocal(), registry, bus, hostLink: createHostLinkLocal({ minter, dialMs: 400 }) }
    : { identity: createIdentityFleet({ sessions: stores.sessions, epochOf: stores.epochOf, company: (req) => registry.company(req.headers.host) }), gate: createGateFleet({ companies: (c) => !!companies[c], tickets: stores.tickets, sessions: stores.sessions }), registry, bus, hostLink: createHostLinkFleet({ minter, dialMs: 400 }) }
  const logs = [], traces = []
  const shell = createShell({ cfg, providers, log: (l) => logs.push(l), trace: (r) => traces.push(r) })
  shell.start()
  const { port } = await shell.listen({ port: 0, host: '127.0.0.1' })
  const sid = mode === 'fleet' ? await stores.sessions.create({ person: { id: 'p1', name: 'Bayard' }, company: 'acme' }) : null
  t.after(async () => { await shell.close(100); await host.stop(); if (root) fs.rmSync(root, { recursive: true, force: true }) })
  const go = (p, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const h = { ...(mode === 'fleet' ? { host: 'acme.portal.pa1nd.de', cookie: `__Host-session=${sid}` } : {}), ...headers }
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8'), lane: traces.at(-1)?.lane }))
    })
    req.on('error', reject); req.end()
  })
  return { shell, registry, bus, root, go, logs, traces, companies }
}

test('lane 4a: the bytes public (no session), immutable + etag = digest:path (one validator per resource, N3), 304 on the etag, gzip ≥ 1 KiB for text only, HEAD; 404 for an unknown digest, an unlisted path, the manifest, a POST; 404 without a store (local mode)', async (t) => {
  const r = await rig(t)
  const D = writeBundle(r.root, BUNDLE)
  const js = await r.go(`/_chrome/${D}/frontend.js`, { headers: { cookie: '' } })
  assert.equal(js.status, 200); assert.equal(js.lane, 'chrome')
  assert.equal(js.headers['cache-control'], CHROME_CACHE_CONTROL); assert.equal(js.headers.etag, `"${D}:frontend.js"`)
  assert.equal(js.headers['content-type'], 'application/javascript; charset=utf-8'); assert.equal(js.headers['x-content-type-options'], 'nosniff')
  assert.equal(js.headers['content-encoding'], undefined); assert.equal(js.text, BUNDLE['frontend.js'].toString())
  const gz = await r.go(`/_chrome/${D}/frontend.js`, { headers: { 'accept-encoding': 'gzip, br' } })
  assert.equal(gz.headers['content-encoding'], 'gzip'); assert.equal(zlib.gunzipSync(gz.body).toString(), BUNDLE['frontend.js'].toString())
  const small = await r.go(`/_chrome/${D}/kit.js`, { headers: { 'accept-encoding': 'gzip' } })
  assert.equal(small.headers['content-encoding'], undefined, 'below 1 KiB: not gzipped')
  const font = await r.go(`/_chrome/${D}/fonts/Inter.woff2`, { headers: { 'accept-encoding': 'gzip' } })
  assert.equal(font.status, 200); assert.equal(font.headers['content-type'], 'font/woff2'); assert.equal(font.headers['content-encoding'], undefined, 'a font is not text: never gzipped'); assert.equal(font.body.length, 2004)
  const css = await r.go(`/_chrome/${D}/chrome.css`)
  assert.equal(css.headers['content-type'], 'text/css; charset=utf-8'); assert.equal(css.headers['cache-control'], CHROME_CACHE_CONTROL)
  const notModified = await r.go(`/_chrome/${D}/chrome.css`, { headers: { 'if-none-match': `"${D}:chrome.css"` } })
  assert.equal(notModified.status, 304); assert.equal(notModified.headers['cache-control'], CHROME_CACHE_CONTROL); assert.equal(notModified.body.length, 0)
  const head = await r.go(`/_chrome/${D}/chrome.css`, { method: 'HEAD' })
  assert.equal(head.status, 200); assert.equal(head.body.length, 0); assert.equal(Number(head.headers['content-length']), BUNDLE['chrome.css'].length)
  for (const [p, why] of [[`/_chrome/${'e'.repeat(64)}/frontend.js`, 'unknown digest'], [`/_chrome/${D}/nope.js`, 'unlisted path'], [`/_chrome/${D}/manifest.json`, 'the manifest'], [`/_chrome/${D}`, 'no path'], ['/_chrome/xyz/frontend.js', 'not a digest']]) {
    const x = await r.go(p); assert.equal(x.status, 404, why); assert.equal(x.headers['cache-control'], 'no-store', why)
  }
  assert.equal((await r.go(`/_chrome/${D}/frontend.js`, { method: 'POST' })).status, 404)
  assert.equal((await r.go(`/_chrome/${D}/../${D}/frontend.js`)).status, 200, 'dot segments are removed by lane 0 before the digest is read')
  // local mode: no store, the lane is 404, the local composition unchanged
  const local = await rig(t, { mode: 'local', store: false })
  assert.equal((await local.go(`/_chrome/${D}/frontend.js`)).status, 404)
  const doc = await local.go('/global/')
  assert.equal(doc.status, 200); assert.ok(doc.text.includes('/modules/global/catalyst-chrome/frontend.js?rev='), doc.text.slice(0, 400)); assert.ok(!doc.text.includes('/_chrome/'))
})

test('the document by digest (decision 5): the registry names D and the row reports D → /acme/ and /acme/todo render /_chrome/D/… (chromeRev = D, chromeBase, the kit import map, the app-less sheet = chrome.css, preloads after the import map), every chrome URL immutable and 200; a computer still on PREV renders PREV on its app document while the app-less one follows the default; a row reporting no digest follows the default; a digest that is not 64 hex is no digest', async (t) => {
  const PREV_BUNDLE = { ...BUNDLE, 'kit.js': Buffer.from('export const Button = 0 // prev\n') }
  const D = digestOf(BUNDLE), PREV = digestOf(PREV_BUNDLE)
  const rows = [
    { instance: TODO, slug: 'todo', company: 'acme', rev: 3, state: 'live', meta: { name: 'Todo' }, primary: true, chromeDigest: D },
    { instance: WIKI, slug: 'wiki', company: 'acme', rev: 1, state: 'live', meta: { name: 'Wiki' }, chromeDigest: PREV },
    { instance: 'i-2222222222222222', slug: 'notes', company: 'acme', rev: 5, state: 'live', meta: { name: 'Notes' }, chromeDigest: null },
    { instance: 'i-3333333333333333', slug: 'odd', company: 'acme', rev: 5, state: 'live', meta: { name: 'Odd' }, chromeDigest: 'sha256:nope' },
  ]
  const r = await rig(t, { chrome: { qid: CHROME_QID, digest: D }, rows })
  writeBundle(r.root, BUNDLE); writeBundle(r.root, PREV_BUNDLE)
  const ROW_ASSET = /\/modules\/portal\/catalyst-chrome\/(frontend\.js|kit\.js|styles\.css)/
  for (const [p, want] of [['/acme/', D], ['/acme/todo', D], ['/acme/wiki', PREV], ['/acme/notes', D], ['/acme/odd', D], ['/acme/unknown-slug', D]]) {
    const x = await r.go(p)
    assert.equal(x.status, 200, p)
    assert.match(x.text, new RegExp(`"chromeRev":"${want}"`), p)
    assert.match(x.text, new RegExp(`"chromeBase":"/_chrome/${want}"`), p)
    assert.ok(x.text.includes(`<link rel="modulepreload" href="/_chrome/${want}/frontend.js">`), `${p}: the chrome bundle by digest`)
    assert.ok(x.text.includes(`<link rel="modulepreload" href="/_chrome/${want}/kit.js">`), `${p}: kit by digest`)
    assert.match(x.text, new RegExp(`"@atelier/kit":"/_chrome/${want}/kit\\.js"`), `${p}: the import map by digest`)
    assert.ok(!ROW_ASSET.test(x.text), `${p}: no asset from the row`)
    assert.ok(!/\/_chrome\/[0-9a-f]{64}\/[^"?\s]*\?rev=/.test(x.text), `${p}: no cache-buster on an immutable URL`)
    const im = x.text.indexOf('type="importmap"'), pre = x.text.indexOf('rel="modulepreload"')
    assert.ok(im > 0 && pre > im, `${p}: preloads after the import map`)
    assert.equal((x.text.match(/<link id="atelier-chrome-styles"/g) ?? []).length, 1, `${p}: one sheet`)
  }
  const bare = await r.go('/acme/')
  assert.ok(bare.text.includes(`<link id="atelier-chrome-styles" rel="stylesheet" href="/_chrome/${D}/chrome.css">`), 'the app-less sheet is the bundle\'s chrome.css')
  const app = await r.go('/acme/todo')
  assert.match(app.text, /<link id="atelier-chrome-styles" rel="stylesheet" href="\/modules\/acme\/todo\/styles\.css\?rev=3\.[0-9a-f]{12}">/, 'the app sheet is the app\'s — named by the app and the chrome digest it was compiled against')
  assert.ok(app.text.includes(`"chromeDigest":"${D}"`), 'the bootstrap row carries its digest')
  const oddDoc = await r.go('/acme/odd')
  assert.ok(!/"id":"odd"[^}]*"chromeDigest"/.test(oddDoc.text) && !oddDoc.text.includes('sha256:nope'), 'a row digest that is not 64 hex rides on no bootstrap row: the client compares that document against the default it was composed with (S1)')
  // every chrome URL the document names answers 200 + immutable
  for (const u of [...app.text.matchAll(/href="(\/_chrome\/[^"]+)"/g)].map((m) => m[1])) { const x = await r.go(u); assert.equal(x.status, 200, u); assert.equal(x.headers['cache-control'], CHROME_CACHE_CONTROL, u) }
  // the rail frame: the default AND every row's digest (the client compares an app document against its row)
  const rail = (await r.go('/_atelier/rail')).text
  const snap = JSON.parse(rail)
  assert.equal(snap.chromeRev, D); assert.equal(snap.chrome.digest, D)
})

test('a null digest is step 5\'s document: no chromeBase, no chromeDigest on a row, every chrome asset from the row at /modules/portal/catalyst-chrome/…?rev=; and locally the mtime stamp stays an mtime (never a /_chrome/ URL)', async (t) => {
  const r = await rig(t, { chrome: { qid: CHROME_QID, digest: null } })
  for (const p of ['/acme/', '/acme/todo']) {
    const x = await r.go(p)
    assert.equal(x.status, 200, p)
    assert.match(x.text, /"chromeRev":null/, p); assert.ok(!x.text.includes('chromeBase'), p); assert.ok(!x.text.includes('chromeDigest'), p)
    assert.ok(!x.text.includes('/_chrome/'), p)
    assert.ok(x.text.includes('<link rel="modulepreload" href="/modules/portal/catalyst-chrome/frontend.js">'), p)
    assert.ok(x.text.includes('<link rel="modulepreload" href="/modules/portal/catalyst-chrome/kit.js">'), p)
  }
  assert.ok((await r.go('/acme/')).text.includes('<link id="atelier-chrome-styles" rel="stylesheet" href="/modules/portal/catalyst-chrome/styles.css">'))
  const local = await rig(t, { mode: 'local', store: false, chrome: { qid: 'global/catalyst-chrome', digest: 1700 } })
  const x = await local.go('/global/todo')
  assert.match(x.text, /"chromeRev":1700/); assert.ok(!x.text.includes('chromeBase')); assert.ok(x.text.includes('/modules/global/catalyst-chrome/frontend.js?rev=1700'))
})
