// host/protocol/server.mjs — the protocol port over a Unix socket: auth order, routes, streaming.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createAuth } from '../protocol/auth.mjs'
import { createServer, parseMount, safeRel } from '../protocol/server.mjs'
import { fakeRegistrar, fakeSupervisor, fakeCollector, keys, assertionFor, request, tmp } from './protocol-fixtures.mjs'

function rig() {
  const { privateKey, publicKey } = keys()
  const registrar = fakeRegistrar({ hostId: 'computer-1', epoch: 'e1', token: 'tok1', publicKey })
  const rows = [
    { instance: 'i-0123456789abcdef', slug: 'todo', company: 'acme', uid: 20001, rev: 3, state: 'live' },
    { instance: 'i-fedcba9876543210', slug: 'wiki', company: 'acme', uid: 20002, rev: 1, state: 'stopped' },
  ]
  const assets = { 'i-0123456789abcdef': {
    'frontend.js': [{ rev: 2, body: '// rev2', type: 'application/javascript; charset=utf-8' }, { rev: 3, body: '// rev3\nexport default 1', type: 'application/javascript; charset=utf-8' }],
    'styles.css': [{ rev: 3, body: '.a{color:red}', type: 'text/css; charset=utf-8' }],
  } }
  const supervisor = fakeSupervisor({ rows, assets })
  const collector = fakeCollector()
  collector.setRunning('i-0123456789abcdef', 3)
  const logs = []
  const auth = createAuth({ registrar, devToken: null, log: (l) => logs.push(l) })
  const dir = tmp()
  const server = createServer({ cfg: {}, auth, supervisor, collector, registrar, log: (l) => logs.push(l), listen: { path: path.join(dir, 'h.sock') } })
  const bearer = () => ({ authorization: `Bearer ${registrar.epoch}.${registrar.token}` })
  const withId = (method, p, instance, extra = {}) => ({ ...bearer(), 'x-atelier-identity': assertionFor(privateKey, { hostId: 'computer-1', instance, method, path: p }), ...extra })
  return { privateKey, registrar, supervisor, collector, auth, server, target: { socketPath: path.join(dir, 'h.sock') }, bearer, withId, logs, rows }
}

test('parseMount / safeRel: one DNS label each, reserved shapes refused, `..` never routes', () => {
  assert.deepEqual(parseMount('/api/acme/todo/items/1'), { kind: 'api', company: 'acme', slug: 'todo', rest: '/items/1', rel: 'items/1' })
  assert.deepEqual(parseMount('/api/acme/todo'), { kind: 'api', company: 'acme', slug: 'todo', rest: '/', rel: '' })
  assert.deepEqual(parseMount('/modules/acme/todo/frontend.js'), { kind: 'modules', company: 'acme', slug: 'todo', rest: '/frontend.js', rel: 'frontend.js' })
  assert.equal(parseMount('/modules/acme'), null)
  assert.equal(parseMount('/api/Acme/todo/x'), null)
  assert.equal(parseMount('/api/acme/-bad/x'), null)
  assert.equal(parseMount('/other/acme/todo'), null)
  assert.equal(safeRel('a/b.js'), 'a/b.js')
  assert.equal(safeRel('../x'), null); assert.equal(safeRel('a/../x'), null); assert.equal(safeRel('%2e%2e/x'), null); assert.equal(safeRel('/x'), null); assert.equal(safeRel(''), null); assert.equal(safeRel('a//b'), null)
})

test('auth order: no bearer → 401 {}; wrong epoch → 401; unknown app → 404 with a bearer; bad assertion → 401; routes after auth', async () => {
  const r = rig()
  await r.server.listen()
  try {
    let res = await request(r.target, { path: '/api/acme/todo/items' })
    assert.equal(res.status, 401); assert.equal(res.body.toString(), '{}')
    res = await request(r.target, { path: '/api/acme/todo/items', headers: { authorization: 'Bearer e0.tok1' } })
    assert.equal(res.status, 401)
    res = await request(r.target, { path: '/api/acme/nope/items', headers: r.bearer() })
    assert.equal(res.status, 404)
    res = await request(r.target, { path: '/api/acme/todo/items', headers: { ...r.bearer(), 'x-atelier-identity': 'garbage' } })
    assert.equal(res.status, 401)
    assert.ok(r.logs.some((l) => /401 malformed/.test(l)))
    // wrong app: a wiki assertion on the todo path
    res = await request(r.target, { path: '/api/acme/todo/items', headers: r.withId('GET', '/api/acme/todo/items', 'i-fedcba9876543210') })
    assert.equal(res.status, 401)
    // good
    res = await request(r.target, { path: '/api/acme/todo/items?x=1', headers: r.withId('GET', '/api/acme/todo/items?x=1', 'i-0123456789abcdef') })
    assert.equal(res.status, 200)
    const j = JSON.parse(res.body.toString())
    assert.deepEqual(j.user, { id: 'p1', name: 'Ada', claims: {} })
    assert.equal(j.url, '/api/acme/todo/items?x=1')     // req.url reaches the supervisor untouched
    assert.deepEqual(r.registrar.servedList, ['i-0123456789abcdef'])
    // the same assertion again is a replay
    res = await request(r.target, { path: '/api/acme/todo/items?x=1', headers: r.withId('GET', '/api/acme/todo/items?x=1', 'i-0123456789abcdef') })
    assert.equal(res.status, 200)
    assert.equal(r.supervisor.handled.length, 2)
    res = await request(r.target, { path: '/nope', headers: r.bearer() })
    assert.equal(res.status, 404)
  } finally { await r.server.close() }
})

test('/modules: bytes of the current rev, ETag + 304, ?rev= addresses a kept rev, past the window 404, `..` 404', async () => {
  const r = rig()
  await r.server.listen()
  try {
    const inst = 'i-0123456789abcdef'
    let res = await request(r.target, { path: '/modules/acme/todo/frontend.js', headers: r.withId('GET', '/modules/acme/todo/frontend.js', inst) })
    assert.equal(res.status, 200)
    assert.equal(res.body.toString(), '// rev3\nexport default 1')
    assert.equal(res.headers.etag, '"rev-3"'); assert.equal(res.headers['cache-control'], 'no-cache'); assert.equal(res.headers['content-type'], 'application/javascript; charset=utf-8')
    res = await request(r.target, { path: '/modules/acme/todo/frontend.js', headers: r.withId('GET', '/modules/acme/todo/frontend.js', inst, { 'if-none-match': '"rev-3"' }) })
    assert.equal(res.status, 304)
    res = await request(r.target, { path: '/modules/acme/todo/frontend.js?rev=2', headers: r.withId('GET', '/modules/acme/todo/frontend.js?rev=2', inst) })
    assert.equal(res.status, 200); assert.equal(res.body.toString(), '// rev2'); assert.equal(res.headers.etag, '"rev-2"')
    res = await request(r.target, { path: '/modules/acme/todo/frontend.js?rev=1', headers: r.withId('GET', '/modules/acme/todo/frontend.js?rev=1', inst) })
    assert.equal(res.status, 404)
    // `..` is normalised BEFORE the gate (B6 surprise 5): the request routes to the normalised app, never escapes it
    res = await request(r.target, { path: '/modules/acme/todo/../todo/frontend.js', headers: r.withId('GET', '/modules/acme/todo/../todo/frontend.js', inst) })
    assert.equal(res.status, 200); assert.equal(res.body.toString(), '// rev3\nexport default 1')
    res = await request(r.target, { path: '/modules/acme/todo/%2e%2e/wiki/frontend.js', headers: r.withId('GET', '/modules/acme/todo/%2e%2e/wiki/frontend.js', inst) })
    assert.equal(res.status, 401)      // normalises to wiki; the todo assertion is wrong-app there
    res = await request(r.target, { path: '/modules/acme/todo/missing.js', headers: r.withId('GET', '/modules/acme/todo/missing.js', inst) })
    assert.equal(res.status, 404)
    res = await request(r.target, { method: 'POST', path: '/modules/acme/todo/frontend.js', headers: r.withId('POST', '/modules/acme/todo/frontend.js', inst) })
    assert.equal(res.status, 405)
  } finally { await r.server.close() }
})

test('/_atelier/report → collector via protocol fromFrontendReport; rev-mismatch 400; unknown instance 404; bearer + assertion required', async () => {
  const r = rig()
  await r.server.listen()
  try {
    const inst = 'i-0123456789abcdef'
    const body = JSON.stringify({ instance: inst, rev: 3, url: 'http://acme.portal.test/acme/todo', ua: 'ua', message: 'boom at x', stack: 'Error: boom\n at x' })
    let res = await request(r.target, { method: 'POST', path: '/_atelier/report', headers: { 'content-type': 'application/json' }, body })
    assert.equal(res.status, 401)
    res = await request(r.target, { method: 'POST', path: '/_atelier/report', headers: { ...r.bearer(), 'content-type': 'application/json' }, body })
    assert.equal(res.status, 401)      // bearer alone is not enough for an app-scoped write
    res = await request(r.target, { method: 'POST', path: '/_atelier/report', headers: r.withId('POST', '/_atelier/report', inst, { 'content-type': 'application/json' }), body })
    assert.equal(res.status, 200); assert.deepEqual(JSON.parse(res.body.toString()), { ok: true })
    assert.equal(r.collector.reports.length, 1)
    const rep = r.collector.reports[0]
    assert.equal(rep.kind, 'frontend'); assert.equal(rep.instance, inst); assert.equal(rep.rev, 3); assert.equal(rep.detail.message, 'boom at x'); assert.equal(rep.detail.sample.url, 'http://acme.portal.test/acme/todo')
    res = await request(r.target, { method: 'POST', path: '/_atelier/report', headers: r.withId('POST', '/_atelier/report', inst, { 'content-type': 'application/json' }), body: JSON.stringify({ instance: inst, rev: 2, message: 'stale' }) })
    assert.equal(res.status, 400); assert.deepEqual(JSON.parse(res.body.toString()), { ok: false, reason: 'rev-mismatch' })
    res = await request(r.target, { method: 'POST', path: '/_atelier/report', headers: { ...r.bearer(), 'content-type': 'application/json' }, body: JSON.stringify({ instance: 'i-0000000000000000', rev: 1, message: 'x' }) })
    assert.equal(res.status, 404)
    res = await request(r.target, { method: 'POST', path: '/_atelier/report', headers: { ...r.bearer(), 'content-type': 'application/json' }, body: '{not json' })
    assert.equal(res.status, 400)
    res = await request(r.target, { method: 'POST', path: '/_atelier/report', headers: { ...r.bearer(), 'content-type': 'application/json', 'content-length': String(100 * 1024) }, body: Buffer.alloc(100 * 1024, 0x20) })
    assert.equal(res.status, 413)
    assert.equal(r.collector.reports.length, 1)
  } finally { await r.server.close() }
})

test('/_atelier/apps and /_host/healthz are bearer-only; Upgrade → 426', async () => {
  const r = rig()
  await r.server.listen()
  try {
    let res = await request(r.target, { path: '/_atelier/apps' })
    assert.equal(res.status, 401)
    res = await request(r.target, { path: '/_atelier/apps', headers: r.bearer() })
    assert.deepEqual(JSON.parse(res.body.toString()), [
      { instance: 'i-0123456789abcdef', slug: 'todo', company: 'acme', rev: 3, state: 'live' },
      { instance: 'i-fedcba9876543210', slug: 'wiki', company: 'acme', rev: 1, state: 'stopped' },
    ])
    res = await request(r.target, { path: '/_host/healthz', headers: r.bearer() })
    const h = JSON.parse(res.body.toString())
    assert.equal(h.api, 'atelier/2'); assert.equal(h.hostId, 'computer-1'); assert.equal(h.epoch, 'e1'); assert.equal(h.apps, 2); assert.equal(typeof h.uptime, 'number')
    res = await request(r.target, { path: '/api/acme/todo/stream', headers: { ...r.bearer(), connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'x', 'sec-websocket-version': '13' } })
    assert.equal(res.status, 426)
  } finally { await r.server.close() }
})

test('streaming: a 1 MiB body reaches the supervisor counted; a 4 MiB response streams back counted (C3 rows)', async () => {
  const r = rig()
  await r.server.listen()
  try {
    const inst = 'i-0123456789abcdef'
    const up = Readable.from((function* () { for (let i = 0; i < 16; i++) yield Buffer.alloc(65536, 0x41) })())
    let res = await request(r.target, { method: 'POST', path: '/api/acme/todo/upload', headers: r.withId('POST', '/api/acme/todo/upload', inst, { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' }), body: up })
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body.toString()).bytes, 1048576)
    let out = 0
    res = await request(r.target, { path: '/api/acme/todo/big?big=4194304', headers: r.withId('GET', '/api/acme/todo/big?big=4194304', inst), onData: (c) => { out += c.length } })
    assert.equal(res.status, 200); assert.equal(out, 4194304)
  } finally { await r.server.close() }
})
