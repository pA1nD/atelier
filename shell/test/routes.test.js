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
import { fakeHost, fakeRegistry, fakeBus, fleetStores, TODO, WIKI, CHROME_APP, listen } from './fixtures.mjs'

const apps = (company) => [
  { instance: TODO, slug: 'todo', company, rev: 3, state: 'live', meta: { name: 'Todo', icon: '✅' }, primary: true },
  { instance: WIKI, slug: 'wiki', company, rev: 1, state: 'stopped', meta: { name: 'Wiki' } },
  { instance: CHROME_APP, slug: 'catalyst-chrome', company, rev: 2, state: 'live', meta: {}, isChrome: true },
]

async function rig(t, { mode = 'local', present, hostUp = true, chrome } = {}) {
  const host = fakeHost({ company: mode === 'local' ? 'global' : 'acme' })
  const hp = await host.start()
  if (!hostUp) await host.stop()
  const traces = [], logs = []
  const minter = createMinter()
  const stores = fleetStores()
  const companies = mode === 'local'
    ? { global: { apps: apps('global'), host: { port: hp, token: 'dev' } }, lab: { apps: [], host: { port: hp, token: 'dev' } } }
    : { acme: { apps: apps('acme'), host: { port: hp, token: 'tok', epoch: 'e1' } }, beta: { apps: [], host: { port: hp, token: 'tok', epoch: 'e1' } } }
  const registry = fakeRegistry({ mode, companies, present, chrome })
  const bus = fakeBus({ registry })
  const { cfg } = createConfig({ mode, config: {}, env: { PORT: '0' } })
  const providers = mode === 'local'
    ? { identity: createIdentityLocal(), gate: createGateLocal(), registry, bus, hostLink: createHostLinkLocal({ minter, dialMs: 400 }) }
    : { identity: createIdentityFleet({ sessions: stores.sessions, epochOf: stores.epochOf, company: (req) => registry.company(req.headers.host) }), gate: createGateFleet({ companies: (c) => !!companies[c], tickets: stores.tickets, sessions: stores.sessions }), registry, bus, hostLink: createHostLinkFleet({ minter, dialMs: 400 }) }
  const shell = createShell({ cfg, providers, log: (l) => logs.push(l), trace: (r) => traces.push(r) })
  shell.start()
  const { port } = await shell.listen({ port: 0, host: '127.0.0.1' })
  t.after(async () => { await shell.close(100); if (hostUp) await host.stop() })
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
  return { shell, host, registry, bus, stores, traces, logs, port, go, sid, minter, hostPort: hp }
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
  assert.match(doc.text, /Waking up global/); assert.match(doc.text, /\/_atelier\/wake\?company=global/); assert.match(doc.text, /http-equiv="refresh" content="3"/)
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
  // the chrome (assets and its backend) is exempt from presence and from the Host = path company check, served by the Host company's host under its row
  assert.equal((await r.go('/modules/global/catalyst-chrome/kit.js')).status, 200)
  assert.equal(r.host.seen.at(-1).identity.app, CHROME_APP)
  const docs = await r.go('/api/global/catalyst-chrome/docs'); assert.equal(docs.status, 200); assert.equal(docs.json().app, CHROME_APP)
  // no row for the chrome on this Host company → 404 (the fleet's shell-served chrome is PLAN §10 item 6, not built)
  r.registry.chrome = () => ({ qid: 'global/other-chrome', dir: null, digest: 1 })
  assert.equal((await r.go('/modules/global/other-chrome/kit.js')).status, 404); assert.equal(r.traces.at(-1).lane, 'presence')
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

test('fleet: a stale heartbeat or a draining host is the waking page without a dial', async (t) => {
  const r = await rig(t, { mode: 'fleet' })
  r.registry.companies = undefined
  const before = r.host.seen.length
  const reg = r.registry
  const orig = reg.host.bind(reg)
  reg.host = async (c) => ({ ...(await orig(c)), heartbeatAt: Date.now() - 31_000 })
  const stale = await r.go('/acme/todo'); assert.equal(stale.status, 503); assert.match(stale.text, /Waking up acme/)
  reg.host = async (c) => ({ ...(await orig(c)), drainingAt: Date.now() })
  assert.equal((await r.go('/acme/todo')).status, 503)
  assert.equal(r.host.seen.length, before, 'no dial happened')
  reg.host = orig
  assert.equal((await r.go('/acme/todo')).status, 200)
})
