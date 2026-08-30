// shell/routes.mjs + index.mjs — the lane table for both providers: each row {mode, req} → {status, location?, lane}.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { WebSocket } from 'ws'
import { createShell } from '../index.mjs'
import { createConfig } from '../config.mjs'
import { normalise, parseRoute } from '../routes.mjs'
import { createMinter } from '../minter.mjs'
import { createIdentityLocal } from '../providers/identity-local.mjs'
import { createIdentityFleet } from '../providers/identity-fleet.mjs'
import { createGateLocal } from '../providers/gate-local.mjs'
import { createGateFleet } from '../providers/gate-fleet.mjs'
import { createHostLinkLocal } from '../providers/hostlink-local.mjs'
import { createHostLinkFleet } from '../providers/hostlink-fleet.mjs'
import { ASLEEP_COPY, WAKE_GIVE_UP_MS } from '../waking.mjs'
import { fakeHost, fakeRegistry, fakeBus, fleetStores, TODO, WIKI, CHROME_APP, NOTES, listen } from './fixtures.mjs'

const chromeRow = (company) => ({ instance: CHROME_APP, slug: 'catalyst-chrome', company, rev: 2, state: 'live', meta: {}, isChrome: true })
const apps = (company) => [
  { instance: TODO, slug: 'todo', company, rev: 3, state: 'live', meta: { name: 'Todo', icon: '✅' }, primary: true },
  { instance: WIKI, slug: 'wiki', company, rev: 1, state: 'stopped', meta: { name: 'Wiki' } },
]
// THE FLEET'S CHROME (step 5): one row, `portal/catalyst-chrome` on the system host's company `portal`, named by every
// company's registry and served on every company origin — a chat's pod (acme's host) carries no chrome row of its own
export const FLEET_CHROME = { qid: 'portal/catalyst-chrome', digest: 1700 }

async function rig(t, { mode = 'local', present, hostUp = true, chrome, secondHost = false } = {}) {
  const host = fakeHost({ company: mode === 'local' ? 'global' : 'acme' })
  const hp = await host.start()
  if (!hostUp) await host.stop()
  // a SECOND computer of acme (the fleet: a company owns one host per chat it owns) carrying `notes` alone
  const host2 = secondHost ? fakeHost({ company: 'acme', epoch: 'e2', rows: [{ instance: NOTES, slug: 'notes', company: 'acme', rev: 5, state: 'live' }] }) : null
  const hp2 = host2 ? await host2.start() : null
  const notes = host2 ? [{ instance: NOTES, slug: 'notes', company: 'acme', rev: 5, state: 'live', meta: { name: 'Notes' }, host: { port: hp2, token: 'tok2', epoch: 'e2' } }] : []
  const traces = [], logs = []
  const minter = createMinter()
  const stores = fleetStores()
  const companies = mode === 'local'
    ? { global: { apps: [...apps('global'), chromeRow('global')], host: { port: hp, token: 'dev' } }, lab: { apps: [], host: { port: hp, token: 'dev' } } }
    : { portal: { apps: [chromeRow('portal')], host: { port: hp, token: 'tok', epoch: 'e1' } }, acme: { apps: [...apps('acme'), ...notes], host: { port: hp, token: 'tok', epoch: 'e1' } }, beta: { apps: [], host: { port: hp, token: 'tok', epoch: 'e1' } } }
  const registry = fakeRegistry({ mode, companies, present, chrome: chrome ?? (mode === 'fleet' ? FLEET_CHROME : undefined) })
  const bus = fakeBus({ registry })
  const { cfg } = createConfig({ mode, config: {}, env: { PORT: '0' } })
  const providers = mode === 'local'
    ? { identity: createIdentityLocal(), gate: createGateLocal(), registry, bus, hostLink: createHostLinkLocal({ minter, dialMs: 400 }) }
    : { identity: createIdentityFleet({ sessions: stores.sessions, epochOf: stores.epochOf, company: (req) => registry.company(req.headers.host) }), gate: createGateFleet({ companies: (c) => !!companies[c], tickets: stores.tickets, sessions: stores.sessions }), registry, bus, hostLink: createHostLinkFleet({ minter, dialMs: 400 }) }
  const shell = createShell({ cfg, providers, log: (l) => logs.push(l), trace: (r) => traces.push(r) })
  shell.start()
  const { port } = await shell.listen({ port: 0, host: '127.0.0.1' })
  t.after(async () => { await shell.close(100); if (hostUp) await host.stop(); if (host2) await host2.stop().catch(() => {}) })
  const sid = mode === 'fleet' ? await stores.sessions.create({ person: { id: 'p1', name: 'Bayard' }, company: 'acme' }) : null
  const hostHeader = mode === 'fleet' ? { host: 'acme.portal.pa1nd.de' } : {}
  // node's fetch refuses a custom Host header — the fleet rows need one, so the client is http.request
  const go = (path, { method = 'GET', headers = {}, body, cookie = true, hostname } = {}) => new Promise((resolve, reject) => {
    const h = { ...hostHeader, ...(hostname ? { host: hostname } : {}), ...headers }
    if (mode === 'fleet' && cookie && sid) h.cookie = `__Host-session=${sid}${h.cookie ? '; ' + h.cookie : ''}`
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body)
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c))
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); const tr = traces[traces.length - 1]; resolve({ status: res.statusCode, headers: { get: (n) => { const v = res.headers[n.toLowerCase()]; return v === undefined ? null : Array.isArray(v) ? v.join(', ') : v } }, text, json: () => JSON.parse(text), lane: tr?.lane, trace: tr }) })
    })
    req.on('error', reject)
    req.end(body)
  })
  return { shell, host, host2, registry, bus, stores, traces, logs, port, go, sid, minter, hostPort: hp, hostPort2: hp2 }
}

test('lane 0: normalisation rows (B6) and the route parser', () => {
  assert.deepEqual(normalise('/global//weather/?a=1&b=%20'), { ok: true, path: '/global/weather/', forward: '/global/weather/?a=1&b=%20', search: '?a=1&b=%20' })
  assert.deepEqual(normalise('/global/%2e%2e/etc/passwd').path, '/etc/passwd')
  assert.equal(normalise('/..').status, 404)
  assert.equal(normalise('/global/../../x').status, 404)
  assert.equal(normalise('/global/%00').status, 400)
  assert.equal(normalise('/global/%252e%252e/x').status, 400)
  assert.equal(normalise('/global/%zz').status, 400)
  assert.equal(normalise('/api/global/todo/a b').forward, '/api/global/todo/a%20b')
  assert.deepEqual(parseRoute('/'), { kind: 'document', company: null, slug: null, rest: '' })
  assert.deepEqual(parseRoute('/global/'), { kind: 'document', company: 'global', slug: null, rest: '' })
  assert.deepEqual(parseRoute('/global/todo/deep/link'), { kind: 'document', company: 'global', slug: 'todo', rest: 'deep/link' })
  assert.equal(parseRoute('/modules/modules/x').kind, 'none')
  assert.equal(parseRoute('/modules/api/x').kind, 'none')
  assert.equal(parseRoute('/api/global/My_App/x').kind, 'none')
  assert.deepEqual(parseRoute('/modules/global/todo/frontend.js'), { kind: 'modules', company: 'global', slug: 'todo', rest: 'frontend.js' })
  assert.deepEqual(parseRoute('/_atelier/topics/i-1'), { kind: 'atelier', name: 'topics', rest: 'i-1' })
  assert.equal(parseRoute('/_t/abc').kind, 'ticket')
  assert.equal(parseRoute('/favicon.ico').kind, 'none')
})

test('local: the document — /, /<c>/, /<c>/<s>; no https redirect, no HSTS; /_t 404; 405 on POST; HEAD', async (t) => {
  const r = await rig(t)
  const doc = await r.go('/global/todo', { headers: { 'x-forwarded-proto': 'http' } })
  assert.equal(doc.status, 200); assert.equal(doc.lane, 'document')
  assert.equal(doc.headers.get('strict-transport-security'), null)
  assert.equal(doc.headers.get('cache-control'), 'no-store')
  assert.match(doc.text, /"chromeApi":2/)
  assert.match(doc.text, /"activeQid":"global\/todo"/)
  assert.match(doc.text, /"companies":\[\{"id":"global","name":"global","href":"\/global\/"\},\{"id":"lab","name":"lab","href":"\/lab\/"\}\]/)
  assert.match(doc.text, /"portal":null/)
  assert.equal((doc.text.match(/rel="stylesheet"/g) ?? []).length, 1)
  assert.match(doc.text, /href="\/modules\/global\/todo\/styles\.css\?rev=3"/)
  assert.match(doc.text, /modulepreload" href="\/modules\/global\/todo\/x\.js\?rev=3"/)      // the entry's relative import, fetched from the host
  assert.ok(!doc.text.includes('catalyst-chrome","instance":"' + CHROME_APP), 'the chrome row is not a module')
  assert.ok(doc.text.indexOf('type="importmap"') < doc.text.indexOf('rel="modulepreload"'))
  const csp = doc.headers.get('content-security-policy'); assert.match(csp, /script-src 'self' 'nonce-/); assert.match(csp, /https:\/\/rsms\.me/)
  const bare = await r.go('/global/')
  assert.match(bare.text, /href="\/modules\/global\/catalyst-chrome\/styles\.css\?rev=1700"/); assert.match(bare.text, /"activeQid":null/)
  const root = await r.go('/')
  assert.equal(root.status, 200); assert.match(root.text, /"workspace":"global"/)
  const unknown = await r.go('/global/nope')
  assert.equal(unknown.status, 200); assert.match(unknown.text, /"activeQid":null/)   // the client tidies the URL (1.x)
  assert.equal((await r.go('/nope/')).status, 404)
  assert.equal((await r.go('/_t/abcdefghijklmnopqrstuvwxyz')).status, 404)
  const post = await r.go('/global/todo', { method: 'POST' }); assert.equal(post.status, 405)
  const head = await r.go('/global/todo', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.text, '')
  assert.equal((await r.go('/global/%00')).status, 400)
  assert.equal((await r.go('/..')).status, 404)
  assert.equal((await r.go('/global//todo')).status, 200)
  assert.deepEqual(r.bus.reprobes[0], ['global', 'e1'])
})

test('local: fetch routes through the proxy — identity minted, cookie/authorization/forged headers never arrive, POST without Origin works, set-cookie cut', async (t) => {
  const r = await rig(t)
  const a = await r.go('/api/global/todo/items?x=1', { method: 'POST', body: 'abc', headers: { cookie: 'sess=1', authorization: 'Bearer x', 'x-atelier-user': 'admin', 'content-type': 'text/plain' } })
  assert.equal(a.status, 200); assert.equal(a.lane, 'proxy')
  const j = a.json()
  assert.deepEqual(j, { method: 'POST', url: '/api/global/todo/items?x=1', person: { id: 'local', name: 'local', claims: {} }, app: TODO, bytes: 3, cookie: null, authorization: null, forged: null })
  assert.equal(a.headers.get('set-cookie'), null); assert.equal(a.headers.get('x-worker'), null)
  assert.equal(r.host.seen.at(-1).headers['x-atelier-dev-token'], 'dev')
  const m = await r.go('/modules/global/todo/frontend.js?rev=3'); assert.equal(m.status, 200); assert.equal(m.headers.get('etag'), '"rev-3"')
  assert.equal((await r.go('/api/global/nope/x')).status, 404)
  assert.equal((await r.go('/modules/modules/x/y')).status, 404)
  assert.equal((await r.go('/api/global/todo/x', { method: 'PUT' })).status, 200)
  // the chrome's assets: session-gated only, routed to the host that carries the chrome; the assertion names the staged row's instance (the host verifies `app` against it)
  const c = await r.go('/modules/global/catalyst-chrome/kit.js'); assert.equal(c.status, 200); assert.equal(c.text, 'export const kit = 1')
  assert.equal(r.host.seen.at(-1).identity.app, CHROME_APP)
  // the chrome's backend: the same chrome lane (session-gated, no presence), signed with the same instance
  assert.equal((await r.go('/api/global/catalyst-chrome/docs')).json().app, CHROME_APP)
})

test('local: /_atelier/* — whoami, rail, topics, report (signed with app = body.instance), wake; 426 on a stray upgrade path', async (t) => {
  const r = await rig(t)
  assert.deepEqual((await r.go('/_atelier/whoami')).json(), { id: 'local', name: 'local', anonymous: false })
  const rail = await r.go('/_atelier/rail?company=global')
  assert.equal(rail.status, 200); assert.deepEqual(rail.json().modules.map((m) => m.id), ['todo', 'wiki', 'catalyst-chrome'].slice(0, 3))
  assert.equal(rail.json().chromeRev, 1700)
  assert.equal((await r.go('/_atelier/rail')).status, 404)
  const topic = await r.go(`/_atelier/topics/${TODO}`)
  assert.deepEqual(topic.json(), { stream: null, seq: 0, rev: 3, error: null })
  assert.equal((await r.go('/_atelier/topics/shell')).status, 404)
  assert.equal((await r.go('/_atelier/topics/i-0000000000000000')).status, 404)
  assert.equal((await r.go('/_atelier/topics/company:global?company=global')).status, 200)
  assert.equal((await r.go('/_atelier/topics/company:lab?company=global')).status, 404)
  const rep = await r.go('/_atelier/report', { method: 'POST', body: JSON.stringify({ instance: TODO, message: 'boom' }), headers: { 'content-type': 'application/json' } })
  assert.deepEqual(rep.json(), { ok: true, app: TODO })
  assert.equal(r.host.seen.at(-1).identity.path, '/_atelier/report')
  assert.equal((await r.go('/_atelier/report', { method: 'POST', body: JSON.stringify({ instance: 'i-0000000000000000' }) })).status, 404)
  assert.equal((await r.go('/_atelier/report', { method: 'POST', body: 'x'.repeat(70 * 1024), headers: { 'content-type': 'application/json' } })).status, 413)
  assert.deepEqual((await r.go('/_atelier/wake?company=global')).json(), { ok: true })
  assert.deepEqual((await r.go('/_atelier/wake')).json(), { ok: false })
  assert.equal((await r.go('/_atelier/inflight')).status, 404)
  assert.equal((await r.go('/_atelier/ws')).status, 426)
})

test('local: the events socket on /_atelier/ws?company=…; an Upgrade elsewhere is 426', async (t) => {
  const r = await rig(t)
  const ws = new WebSocket(`ws://127.0.0.1:${r.port}/_atelier/ws?company=global`)
  const frames = []
  ws.on('message', (d) => frames.push(JSON.parse(d)))
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  ws.send(JSON.stringify({ op: 'sub', topics: [TODO, 'company:global', 'shell', 'company:lab'] }))
  await new Promise((res) => setTimeout(res, 60))
  assert.deepEqual(frames.map((f) => [f.type, f.topic]).sort(), [['denied', 'company:lab'], ['denied', 'shell'], ['subscribed', 'company:global'], ['subscribed', TODO]].sort())
  r.bus.emit(TODO, 2)
  r.registry.fire('global')                              // the registry changed → the shell publishes company:global
  await new Promise((res) => setTimeout(res, 60))
  assert.deepEqual(frames.filter((f) => f.type === 'invalidate').map((f) => [f.topic, f.seq]), [[TODO, 1], [TODO, 2], ['company:global', 1]])
  ws.terminate()
  const bad = new WebSocket(`ws://127.0.0.1:${r.port}/api/global/todo/ws`)
  const code = await new Promise((res) => { bad.on('error', (e) => res(e.message)); bad.on('open', () => res('open')) })
  assert.match(code, /426/)
})

test('local: the host is down → the waking page on documents (503, ≤ 1.2 s), 503 {waking:true} on fetches, wake says no', async (t) => {
  const r = await rig(t, { hostUp: false })
  const t0 = Date.now()
  const doc = await r.go('/global/todo')
  assert.equal(doc.status, 503); assert.ok(Date.now() - t0 < 1200)
  assert.equal(doc.headers.get('retry-after'), '3'); assert.equal(doc.headers.get('cache-control'), 'no-store')
  assert.match(doc.text, /Waking up global/); assert.match(doc.text, /\/_atelier\/wake\?company=global/)
  // BOUNDED (C13): no <meta refresh> re-arming the poll forever; after WAKE_GIVE_UP_MS the script stops polling and says the computer is asleep
  assert.ok(!/http-equiv="refresh"/.test(doc.text), 'no meta refresh')
  assert.ok(doc.text.includes(`until=Date.now()+${WAKE_GIVE_UP_MS}`), 'the deadline is in the page')
  assert.ok(doc.text.includes('if(Date.now()>until){asleep();return}'), 'past the deadline the poll stops')
  assert.ok(doc.text.includes(JSON.stringify(ASLEEP_COPY)), 'the honest copy')
  const api = await r.go('/api/global/todo/x')
  assert.equal(api.status, 503); assert.deepEqual(api.json(), { waking: true }); assert.equal(api.headers.get('x-atelier-waking'), '1')
  assert.deepEqual((await r.go('/_atelier/wake?company=global')).json(), { ok: false, reason: 'DIAL' })
})

test('local: a failed probe marks the host waking for 2 s — fetches answer 503 without a dial, then dial again', async (t) => {
  const r = await rig(t)
  assert.equal((await r.go('/api/global/todo/x')).status, 200)
  const seen = r.host.seen.length
  await r.host.stop()
  assert.equal((await r.go('/global/todo')).status, 503)               // the probe fails (1 s cap) → marked
  const t0 = Date.now()
  const a = await r.go('/api/global/todo/x'); const b = await r.go('/modules/global/todo/frontend.js')
  assert.equal(a.status, 503); assert.equal(b.status, 503); assert.ok(Date.now() - t0 < 200, 'no dial while marked')
  assert.deepEqual(a.json(), { waking: true })
  await r.host.start(r.hostPort)                                         // the fixture host is back on the same port
  await new Promise((res) => setTimeout(res, 2100))
  assert.equal((await r.go('/api/global/todo/x')).status, 200)
  assert.ok(r.host.seen.length > seen)
})

test('local: /assets/* — the UMDs, client.js, chrome-resolve.js, 304 on ETag, gzip, 404 for the rest', async (t) => {
  const r = await rig(t)
  const react = await r.go('/assets/react.js', { headers: { 'accept-encoding': 'gzip' } })
  assert.equal(react.status, 200); assert.equal(react.lane, 'assets'); assert.match(react.headers.get('content-type'), /javascript/)
  assert.ok(react.text.length > 1000)
  const client = await r.go('/assets/client.js')
  assert.equal(client.status, 200); assert.ok(client.headers.get('etag'))
  assert.ok(!client.text.includes('from "./chrome-resolve.js"'), 'bundled')
  const again = await r.go('/assets/client.js', { headers: { 'if-none-match': client.headers.get('etag') } })
  assert.equal(again.status, 304)
  assert.equal((await r.go('/assets/chrome-resolve.js')).status, 200)
  assert.equal((await r.go('/assets/nope.js')).status, 404)
  assert.equal((await r.go('/assets/../client.jsx')).status, 404)
})

test('fleet: https 301 + HSTS; Host allowlist 404 (never a redirect); Host = path company on documents', async (t) => {
  const r = await rig(t, { mode: 'fleet' })
  const http = await r.go('/acme/todo?q=1', { headers: { 'x-forwarded-proto': 'http' } })
  assert.equal(http.status, 301); assert.equal(http.lane, 'https'); assert.equal(http.headers.get('location'), 'https://acme.portal.pa1nd.de/acme/todo?q=1')
  const doc = await r.go('/acme/todo')
  assert.equal(doc.status, 200); assert.equal(doc.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains')
  assert.match(doc.text, /"portal":"https:\/\/portal\.pa1nd\.de"/); assert.match(doc.text, /"companies":\[\]/)
  assert.match(doc.headers.get('content-security-policy'), /form-action 'self' https:\/\/portal\.pa1nd\.de/)
  // the company document wears the fleet's chrome — the system host's row on `portal`, not one of acme's — so the preloads, the
  // kit import map and the sheet of an app-less document name `/modules/portal/catalyst-chrome/*`; acme's rail holds its own apps only
  assert.match(doc.text, /"chromeQid":"portal\/catalyst-chrome"/); assert.match(doc.text, /"chromes":\["portal\/catalyst-chrome"\]/)
  assert.match(doc.text, /modulepreload" href="\/modules\/portal\/catalyst-chrome\/frontend\.js\?rev=1700"/); assert.match(doc.text, /"@atelier\/kit":"\/modules\/portal\/catalyst-chrome\/kit\.js\?rev=1700"/)
  assert.match(doc.text, /"modules":\[\{"id":"todo"[^\]]*\{"id":"wiki"/); assert.ok(!doc.text.includes('"id":"catalyst-chrome"'))
  const bare = await r.go('/acme/'); assert.match(bare.text, /href="\/modules\/portal\/catalyst-chrome\/styles\.css\?rev=1700"/)
  const rail = await r.go('/_atelier/rail'); assert.deepEqual(rail.json().modules.map((m) => m.id), ['todo', 'wiki']); assert.deepEqual(rail.json().chrome, { qid: 'portal/catalyst-chrome', dir: null, digest: 1700 })
  const evil = await r.go('/acme/todo', { hostname: 'evil.example' }); assert.equal(evil.status, 404); assert.equal(evil.lane, 'host')
  const unknownCo = await r.go('/acme/todo', { hostname: 'nope.portal.pa1nd.de' }); assert.equal(unknownCo.status, 404); assert.equal(unknownCo.lane, 'host')
  const portal = await r.go('/acme/todo', { hostname: 'portal.pa1nd.de' }); assert.equal(portal.status, 404); assert.equal(portal.lane, 'host')
  const mismatch = await r.go('/acme/todo', { hostname: 'beta.portal.pa1nd.de' }); assert.equal(mismatch.status, 404); assert.equal(mismatch.lane, 'document')
  const root = await r.go('/'); assert.equal(root.status, 200); assert.match(root.text, /"workspace":"acme"/)
  // fetch routes are session-first: the acme session on the beta origin is no session (401); a beta session with an acme path is a Host mismatch (404)
  const fetchNoSession = await r.go('/api/acme/todo/x', { hostname: 'beta.portal.pa1nd.de' }); assert.equal(fetchNoSession.status, 401)
  const beta = await r.stores.sessions.create({ person: { id: 'p1', name: 'Bayard' }, company: 'beta' })
  const fetchMismatch = await r.go('/api/acme/todo/x', { cookie: false, hostname: 'beta.portal.pa1nd.de', headers: { cookie: `__Host-session=${beta}` } }); assert.equal(fetchMismatch.status, 404); assert.equal(fetchMismatch.lane, 'fetch')
})

test('fleet: unauth document → 302 to /go with the path only + the loop breaker; fetch → 401 without Location; revoked session', async (t) => {
  const r = await rig(t, { mode: 'fleet' })
  const d = await r.go('/acme/todo/deep?q=1', { cookie: false })
  assert.equal(d.status, 302); assert.equal(d.headers.get('location'), 'https://portal.pa1nd.de/go/acme/todo/deep')
  assert.equal(d.headers.get('cache-control'), 'no-store'); assert.match(d.headers.get('set-cookie'), /^__Host-tried=1; Path=\/; Secure; HttpOnly/)
  const loop = await r.go('/acme/todo', { cookie: false, headers: { cookie: '__Host-tried=1' } }); assert.equal(loop.status, 403)
  // a non-GET/HEAD on a document route: 401 without Location and without a ticket mint when unauthenticated, 405 with a session
  const post = await r.go('/acme/todo', { method: 'POST', cookie: false }); assert.equal(post.status, 401); assert.equal(post.headers.get('location'), null); assert.equal(post.headers.get('set-cookie'), null)
  assert.equal((await r.go('/acme/todo', { method: 'POST' })).status, 405)
  const f = await r.go('/api/acme/todo/x', { cookie: false }); assert.equal(f.status, 401); assert.equal(f.headers.get('location'), null); assert.equal(f.text, '{}')
  assert.equal((await r.go('/modules/acme/todo/frontend.js', { cookie: false })).status, 401)
  assert.equal((await r.go('/_atelier/whoami', { cookie: false })).status, 401)
  // a session for another company is no session here
  const other = await r.stores.sessions.create({ person: { id: 'p1', name: 'B' }, company: 'beta' })
  assert.equal((await r.go('/api/acme/todo/x', { cookie: false, headers: { cookie: `__Host-session=${other}` } })).status, 401)
  // the person's epoch moves (removed from a chat) → the session is revoked everywhere
  r.stores.bump('p1')
  assert.equal((await r.go('/api/acme/todo/x')).status, 401)
  assert.equal((await r.go('/acme/todo')).status, 302)
})

test('fleet: presence 404 identical to a stranger; Origin 403 on cookie writes and Origin: null; GET with a foreign Origin 200; preflight answered by the shell', async (t) => {
  const r = await rig(t, { mode: 'fleet', present: async (personId, instance) => instance === TODO })
  assert.equal((await r.go('/api/acme/wiki/x')).status, 404); assert.equal(r.traces.at(-1).lane, 'presence')
  assert.equal((await r.go('/modules/acme/wiki/frontend.js')).status, 404)
  assert.equal((await r.go(`/_atelier/topics/${WIKI}`)).status, 404)
  // NO TRACE EITHER (review 2026-08-30): the document's module list, the rail and the company snapshot are the person's rows —
  // a member outside wiki's chat sees todo alone (PLAN §4.1: the same 404 as a stranger, so no name, icon or rev of it)
  const doc = await r.go('/acme/todo'); assert.equal(doc.status, 200)
  assert.match(doc.text, /"modules":\[\{"id":"todo"[^\]]*\]/); assert.ok(!doc.text.includes('"id":"wiki"'), 'wiki is not in the bootstrap'); assert.ok(!doc.text.includes(WIKI))
  assert.deepEqual((await r.go('/_atelier/rail')).json().modules.map((m) => m.id), ['todo'])
  assert.deepEqual((await r.go('/_atelier/topics/company:acme')).json().modules.map((m) => m.id), ['todo'])
  const wikiDoc = await r.go('/acme/wiki'); assert.equal(wikiDoc.status, 200); assert.match(wikiDoc.text, /"activeQid":null/)   // the document renders app-less; the fetches are the 404s above
  const ok = await r.go('/api/acme/todo/items', { method: 'POST', body: '{}', headers: { origin: 'https://acme.portal.pa1nd.de', 'content-type': 'application/json' } })
  assert.equal(ok.status, 200); assert.deepEqual(ok.json().person, { id: 'p1', name: 'Bayard', claims: {} })
  assert.equal(r.host.seen.at(-1).headers.authorization, 'Bearer e1.tok')
  assert.equal(r.host.seen.at(-1).headers.cookie, undefined)
  for (const origin of ['https://evil.example', 'null', undefined]) {
    const bad = await r.go('/api/acme/todo/items', { method: 'POST', body: '{}', headers: origin ? { origin } : {} })
    assert.equal(bad.status, 403, `origin ${origin}`); assert.equal(bad.lane, 'origin')
  }
  const get = await r.go('/api/acme/todo/items', { headers: { origin: 'https://evil.example' } }); assert.equal(get.status, 200)
  const pre = await r.go('/api/acme/todo/items', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } })
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), null)
  // THE CHROME ON EVERY COMPANY ORIGIN (step 5): acme's registry names `portal/catalyst-chrome` — the system host's row on
  // company `portal` — so its assets and its backend are exempt from presence (`present` above admits todo alone) and from
  // the Host = path company check; the proxy dials the QID's company's host with that row's instance in the assertion
  const kit = await r.go('/modules/portal/catalyst-chrome/kit.js'); assert.equal(kit.status, 200); assert.equal(kit.text, 'export const kit = 1')
  assert.equal(r.host.seen.at(-1).identity.app, CHROME_APP); assert.equal(r.host.seen.at(-1).url, '/modules/portal/catalyst-chrome/kit.js')
  const docs = await r.go('/api/portal/catalyst-chrome/docs'); assert.equal(docs.status, 200); assert.equal(docs.json().app, CHROME_APP)
  assert.equal((await r.go('/modules/portal/catalyst-chrome/kit.js', { cookie: false })).status, 401, 'session-gated (R3-11)')
  // every other cross-company path stays a Host mismatch (portal's other rows are not on acme); the old `global/…` name is nothing here
  assert.equal((await r.go('/modules/portal/other/x.js')).status, 404); assert.equal(r.traces.at(-1).lane, 'fetch')
  assert.equal((await r.go('/modules/global/catalyst-chrome/kit.js')).status, 404); assert.equal(r.traces.at(-1).lane, 'fetch')
  // a chrome qid whose company holds no such row → 404 at presence (chrome delivery by digest per computer is step 7)
  r.registry.chrome = () => ({ qid: 'portal/other-chrome', dir: null, digest: 1 })
  assert.equal((await r.go('/modules/portal/other-chrome/kit.js')).status, 404); assert.equal(r.traces.at(-1).lane, 'presence')
})

test('fleet: the ticket lane — Continue page without a user gesture, 302 + session on one, wrong aud 403 (not burnt), used 410, unknown 404, query 404', async (t) => {
  const r = await rig(t, { mode: 'fleet' })
  const id = 'tkt-0123456789abcdef'
  r.stores.tickets.map.set(id, { aud: 'acme', person: { id: 'p9', name: 'Nine' }, next: '/acme/todo/x' })
  const preview = await r.go(`/_t/${id}`, { cookie: false })
  assert.equal(preview.status, 200); assert.equal(preview.lane, 'ticket'); assert.match(preview.text, /<form method="post" action="\/_t\/tkt-0123456789abcdef">/)
  assert.equal((await r.go(`/_t/${id}?x=1`, { cookie: false })).status, 404)
  assert.equal((await r.go(`/_t/${id}`, { cookie: false, hostname: 'beta.portal.pa1nd.de', headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-user': '?1' } })).status, 403)
  const nav = await r.go(`/_t/${id}`, { cookie: false, headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-user': '?1' } })
  assert.equal(nav.status, 302); assert.equal(nav.headers.get('location'), '/acme/todo/x')
  const sc = nav.headers.get('set-cookie'); assert.match(sc, /__Host-session=s-[0-9a-f]+; Path=\/; Secure; HttpOnly; SameSite=Lax/)
  assert.equal((await r.go(`/_t/${id}`, { cookie: false, method: 'POST' })).status, 410)
  assert.equal((await r.go('/_t/tkt-unknownunknownunkn', { cookie: false })).status, 404)
  // the minted session opens the document
  const sid = /__Host-session=([^;]+)/.exec(sc)[1]
  const doc = await r.go('/acme/todo/x', { cookie: false, headers: { cookie: `__Host-session=${sid}` } })
  assert.equal(doc.status, 200); assert.match(doc.text, /"id":"p9"/)
})

test('fleet: the ticket lands only on a normalised app path of this company; the loop breaker refuses a second ticket for the same person + next from a client that stores no cookie', async (t) => {
  const r = await rig(t, { mode: 'fleet' })
  const nav = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-user': '?1' }
  let n = 0
  const redeem = async (next, person = { id: 'p9', name: 'Nine' }, headers = {}) => {
    const id = `tkt-${String(++n).padStart(16, '0')}`
    r.stores.tickets.map.set(id, { aud: 'acme', person, next })
    return r.go(`/_t/${id}`, { cookie: false, headers: { ...nav, ...headers } })
  }
  const land = async (next, person) => { const x = await redeem(next, person); assert.equal(x.status, 302, next); return x.headers.get('location') }
  // one assertion per rejected shape — each lands on the company home
  assert.equal(await land('//evil.example/x', { id: 'a1' }), '/acme/')
  assert.equal(await land('https://evil.example/x', { id: 'a2' }), '/acme/')
  assert.equal(await land('/beta/todo', { id: 'a3' }), '/acme/')                    // another company
  assert.equal(await land('/api/acme/todo/items', { id: 'a4' }), '/acme/')          // an API path
  assert.equal(await land('/_t/tkt-0123456789abcdef', { id: 'a5' }), '/acme/')      // a ticket path
  assert.equal(await land('/acme/../beta/todo', { id: 'a6' }), '/acme/')            // dot segments out of the company
  assert.equal(await land('/acme/_atelier/ws', { id: 'a7' }), '/acme/')             // a reserved head as the slug
  assert.equal(await land('/acme//todo/../wiki/deep?tab=2', { id: 'a8' }), '/acme/wiki/deep?tab=2')   // normalised, query kept
  assert.equal(await land(42, { id: 'a9' }), '/acme/')
  // the loop: ticket 1 → 302 + cookie; the client drops every Set-Cookie and comes back through /go with ticket 2 → refused, not another 302
  const first = await redeem('/acme/todo/x'); assert.equal(first.status, 302); assert.match(first.headers.get('set-cookie'), /__Host-session=/)
  const second = await redeem('/acme/todo/x'); assert.equal(second.status, 403); assert.match(second.text, /did not stick/); assert.equal(second.headers.get('set-cookie'), null)
  assert.equal(r.stores.tickets.map.get(`tkt-${String(n).padStart(16, '0')}`).used, true)   // single use holds: the refused ticket is burnt
  // a re-tap WITH the session cookie is not a loop; a different next is not one either
  const sid = /__Host-session=([^;]+)/.exec(first.headers.get('set-cookie'))[1]
  assert.equal((await redeem('/acme/todo/x', undefined, { cookie: `__Host-session=${sid}` })).status, 302)
  assert.equal((await redeem('/acme/wiki')).status, 302)
})

test('fleet: a stale heartbeat or a draining host is the waking page without a dial — the APP\'s host row for an app document, the company\'s freshest for an app-less one', async (t) => {
  const r = await rig(t, { mode: 'fleet' })
  r.registry.companies = undefined
  const before = r.host.seen.length
  const reg = r.registry
  const origOf = reg.hostOf.bind(reg), orig = reg.host.bind(reg)
  reg.hostOf = async (row) => ({ ...(await origOf(row)), heartbeatAt: Date.now() - 31_000 })
  const stale = await r.go('/acme/todo'); assert.equal(stale.status, 503); assert.match(stale.text, /Waking up acme/); assert.match(stale.text, /\/_atelier\/wake\?company=acme&app=todo/)
  reg.hostOf = async (row) => ({ ...(await origOf(row)), drainingAt: Date.now() })
  assert.equal((await r.go('/acme/todo')).status, 503)
  assert.equal((await r.go('/acme/')).status, 200, 'the app-less document asks the company\'s freshest host, which is fine')
  reg.hostOf = origOf
  reg.host = async (c) => ({ ...(await orig(c)), drainingAt: Date.now() })
  assert.equal((await r.go('/acme/todo')).status, 200, 'the app document never asks host(company)')
  const bare = await r.go('/acme/'); assert.equal(bare.status, 503); assert.match(bare.text, /wake\?company=acme"/)
  assert.equal(r.host.seen.filter((s) => s.url === '/_host/healthz').length, r.host.seen.slice(0, before).filter((s) => s.url === '/_host/healthz').length + 2, 'a probe only for the two documents that rendered')
  reg.host = orig
  assert.equal((await r.go('/acme/')).status, 200)
})

test('fleet: one company, two hosts — every app is proxied to ITS computer; a stopped pod wakes its own apps alone (marks per host); wake?app= asks that host', async (t) => {
  const r = await rig(t, { mode: 'fleet', secondHost: true })
  // todo lives on host A (acme's default row), notes on host B — each request lands on its own computer with its own bearer
  const a0 = r.host.seen.length, b0 = r.host2.seen.length
  assert.equal((await r.go('/api/acme/notes/x')).status, 200)
  assert.equal(r.host2.seen.length, b0 + 1); assert.equal(r.host.seen.length, a0); assert.equal(r.host2.seen.at(-1).headers.authorization, 'Bearer e2.tok2'); assert.equal(r.host2.seen.at(-1).identity.app, NOTES)
  assert.equal((await r.go('/api/acme/todo/x')).status, 200)
  assert.equal(r.host.seen.length, a0 + 1); assert.equal(r.host2.seen.length, b0 + 1); assert.equal(r.host.seen.at(-1).headers.authorization, 'Bearer e1.tok')
  const m = await r.go('/modules/acme/notes/frontend.js?rev=5'); assert.equal(m.status, 200); assert.equal(r.host2.seen.at(-1).url, '/modules/acme/notes/frontend.js?rev=5')
  // the documents: notes' entry imports come from host B; the rail lists both
  const doc = await r.go('/acme/notes'); assert.equal(doc.status, 200); assert.match(doc.text, /modulepreload" href="\/modules\/acme\/notes\/x\.js\?rev=5"/)
  assert.deepEqual((await r.go('/_atelier/rail')).json().modules.map((x) => x.id), ['todo', 'wiki', 'notes'])
  const rep = await r.go('/_atelier/report', { method: 'POST', body: JSON.stringify({ instance: NOTES, message: 'boom' }), headers: { 'content-type': 'application/json', origin: 'https://acme.portal.pa1nd.de' } })
  assert.deepEqual([rep.status, rep.lane, rep.json()], [200, 'proxy', { ok: true, app: NOTES }]); assert.equal(r.host2.seen.at(-1).identity.path, '/_atelier/report')
  // host B stops: notes is waking, todo is not — the document, the fetch, the wake poll and the mark all name the HOST, not the company
  await r.host2.stop()
  const w = await r.go('/acme/notes'); assert.equal(w.status, 503); assert.match(w.text, /Waking up acme/); assert.match(w.text, /\/_atelier\/wake\?company=acme&app=notes/)
  assert.equal((await r.go('/acme/todo')).status, 200)
  assert.equal((await r.go('/acme/')).status, 200, 'the app-less document: the company has a live host')
  const t0 = Date.now()
  const n = await r.go('/api/acme/notes/x'); assert.equal(n.status, 503); assert.deepEqual(n.json(), { waking: true }); assert.ok(Date.now() - t0 < 200, 'marked by the probe — no dial')
  assert.equal((await r.go('/api/acme/todo/x')).status, 200, 'host A is not marked by host B\'s failure')
  assert.deepEqual((await r.go('/_atelier/wake?company=acme&app=notes')).json(), { ok: false, reason: 'DIAL' })
  assert.deepEqual((await r.go('/_atelier/wake?company=acme&app=todo')).json(), { ok: true })
  assert.deepEqual((await r.go('/_atelier/wake?company=acme')).json(), { ok: true })
  // host B is back on its port: notes renders again
  await r.host2.start(r.hostPort2)
  await new Promise((res) => setTimeout(res, 2100))
  assert.equal((await r.go('/acme/notes')).status, 200)
  assert.equal((await r.go('/api/acme/notes/x')).status, 200)
})

test('fleet: a row whose computer the spine does not know (host: null) on a company that HAS a live host → that app is waking no-host (document 503, wake {ok:false, reason:no-host}, one loud log); the app-less document and the other apps are fine — no fallback to the company\'s host (C14)', async (t) => {
  const r = await rig(t, { mode: 'fleet' })
  r.registry.data.acme.apps.push({ instance: 'i-3333333333333333', slug: 'ghost', rev: 1, state: 'live', meta: { name: 'Ghost' }, host: null })
  const doc = await r.go('/acme/ghost'); assert.equal(doc.status, 503); assert.match(doc.text, /Waking up acme/); assert.match(doc.text, /\/_atelier\/wake\?company=acme&app=ghost/)
  assert.deepEqual((await r.go('/_atelier/wake?company=acme&app=ghost')).json(), { ok: false, reason: 'no-host' })
  assert.ok(r.logs.some((l) => /acme\/ghost waking \(no-host\)/.test(l)), r.logs.join('\n'))
  assert.equal((await r.go('/acme/')).status, 200)
  assert.equal((await r.go('/acme/todo')).status, 200)
  assert.deepEqual((await r.go('/_atelier/wake?company=acme')).json(), { ok: true })
  const api = await r.go('/api/acme/ghost/x'); assert.equal(api.status, 503); assert.deepEqual(api.json(), { waking: true })
})

test('fleet: presence before liveness (C06) — a stopped pod of an app the person is NOT present on is invisible: the document and wake?app= answer exactly as for a nonexistent slug, and the pod is never probed', async (t) => {
  const r = await rig(t, { mode: 'fleet', secondHost: true, present: async (_p, i) => i === TODO })
  // host B up: the document and the wake poll for notes never dial it (the app-less rule asks host A, the company's freshest)
  const b0 = r.host2.seen.length
  const up = await r.go('/acme/notes'); assert.equal(up.status, 200); assert.match(up.text, /"activeQid":null/); assert.ok(!up.text.includes(NOTES))
  assert.deepEqual((await r.go('/_atelier/wake?company=acme&app=notes')).json(), { ok: true })
  assert.equal(r.host2.seen.length, b0, 'the other room\'s pod is not probed')
  // host B stopped: the answers are byte-for-byte the nonexistent slug's — no waking page naming it, no 503, no mark
  await r.host2.stop()
  const notes = await r.go('/acme/notes'), none = await r.go('/acme/nonexistent')
  assert.equal(notes.status, 200); assert.equal(none.status, notes.status)
  assert.ok(!/app=notes/.test(notes.text), 'no waking page naming the slug'); assert.ok(!notes.text.includes(NOTES))
  assert.deepEqual((await r.go('/_atelier/wake?company=acme&app=notes')).json(), (await r.go('/_atelier/wake?company=acme&app=nonexistent')).json())
  assert.deepEqual((await r.go('/_atelier/wake?company=acme&app=notes')).json(), { ok: true })
  // the person's own app is untouched
  assert.equal((await r.go('/acme/todo')).status, 200)
  assert.deepEqual((await r.go('/_atelier/wake?company=acme&app=todo')).json(), { ok: true })
})
