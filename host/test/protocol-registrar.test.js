// host/protocol/registrar.mjs — against a fake spine (the §7 routes on 127.0.0.1) and the local twin.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { memory } from '../adapters/os.mjs'
import { authorizeWrite, reclaimRule, publicKeyHex, SLUG_RE } from '../../protocol/index.js'
import { createRegistrar, spineTransport, localTransport, TransportError, EPOCH_MOVED, RECONCILE_SETTLE_MS, WORKER_UID_BASE, writeClaimRefused } from '../protocol/registrar.mjs'
import { keys, memoryFsx } from './protocol-fixtures.mjs'

// A minimal spine: computers {id, company, token, epoch}, apps rows keyed by instance; the write
// rules are protocol/registry's (authorizeWrite + reclaimRule), so the registrar meets the real gate.
function fakeSpine({ computer = 'computer-1', company = 'acme', bootstrap = 'boot-secret', shellKeys = keys() } = {}) {
  const s = { calls: [], apps: new Map(), token: null, epoch: null, failRegister: 0, rows: [] }
  const others = new Map()   // slug → computer (rows other computers hold, for 409s)
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const read = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : {})) })
  s.server = http.createServer(async (req, res) => {
    const body = await read(req)
    const url = new URL(req.url, 'http://x')
    s.calls.push({ method: req.method, path: url.pathname, body })
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (url.pathname === '/v1/host/register') {
      if (auth !== bootstrap) return json(res, 401, { error: 'bad-bootstrap' })
      if (s.failRegister > 0) { s.failRegister--; return json(res, 503, { error: 'busy' }) }
      s.token = randomBytes(8).toString('hex'); s.epoch = randomBytes(8).toString('hex')
      return json(res, 200, { host_id: computer, epoch: s.epoch, token: s.token, company, origin: `https://${company}.portal.pa1nd.de`, chat: 'chat-1', principal: { id: 'p-agent', name: 'Bayard' },
        apps: [...s.apps.entries()].map(([instance, a]) => ({ instance, slug: a.slug, uid: a.uid, rev: a.rev, tombstone_at: a.tombstone_at })), shell_public_key_hex: publicKeyHex(shellKeys.publicKey) })
    }
    if (auth !== s.token) return json(res, 401, { error: EPOCH_MOVED })
    let m
    if (url.pathname === '/v1/host/heartbeat') return json(res, 200, { ok: true })
    if (url.pathname === '/v1/host/modules-changed') { for (const a of body.apps) { const row = s.apps.get(a.instance); if (row) { row.rev = a.rev; row.uid = a.uid } } return json(res, 200, { ok: true }) }
    if (url.pathname === '/v1/host/events') return json(res, 200, { accepted: body.length, rejected: [] })
    if (url.pathname === '/v1/host/event') return json(res, 200, { ok: true })
    if (url.pathname === '/v1/host/draining') return json(res, 200, { ok: true })
    if ((m = /^\/v1\/apps\/([^/]+)\/config$/.exec(url.pathname))) return json(res, 200, { env: { K: 'V' } })
    if ((m = /^\/v1\/apps\/([^/]+)\/unlink$/.exec(url.pathname))) { const a = s.apps.get(m[1]); if (!a) return json(res, 404, { error: 'unknown-instance' }); a.tombstone_at ??= Date.now(); return json(res, 200, { tombstone_at: a.tombstone_at }) }
    if ((m = /^\/v1\/apps\/([^/]+)$/.exec(url.pathname)) && req.method === 'PUT') {
      const instance = m[1]
      const existing = s.apps.get(instance)
      const w = authorizeWrite({ callerComputer: computer, computerRow: { id: computer, company }, existingRow: existing ? { ...existing, computer, company } : null, body })
      if (!w.ok) return json(res, w.code, { error: w.error })
      if (existing) { existing.slug = body.slug; existing.meta = w.row.meta; existing.tombstone_at = null; return json(res, 200, { instance_id: instance, updated: true }) }
      const other = others.get(body.slug)
      if (other) return json(res, 409, { error: 'slug-claimed', by: other })
      const held = [...s.apps.entries()].find(([, a]) => a.slug === body.slug)
      if (held) {
        const rule = reclaimRule({ existing: { computer, tombstone_at: held[1].tombstone_at }, callerComputer: computer, now: Date.now() })
        held[1].tombstone_at = null; held[1].meta = w.row.meta
        return json(res, 200, { instance_id: held[0], adopted: true, revived: rule === 'revive' })
      }
      s.apps.set(instance, { slug: body.slug, uid: null, rev: null, meta: w.row.meta, requested_primary: w.row.requested_primary, tombstone_at: null })
      return json(res, 201, { instance_id: instance, claimed: true })
    }
    json(res, 404, { error: 'no-route' })
  })
  s.listen = () => new Promise((r) => s.server.listen(0, '127.0.0.1', () => r((s.url = `http://127.0.0.1:${s.server.address().port}`))))
  s.close = () => new Promise((r) => s.server.close(() => r()))
  s.holdElsewhere = (slug, by) => others.set(slug, by)
  s.revoke = () => { s.token = 'revoked-' + randomBytes(4).toString('hex') }   // the next registration hands out a new pair
  s.shellKeys = shellKeys
  return s
}

function rig(spine, { fsx = memoryFsx(), state = {}, now, backoffMs = [5, 5], liveWorkers } = {}) {
  const os = memory(state)
  const dirfd = os.openDir('/work/.atelier')
  const transport = spineTransport({ spineUrl: spine.url, run: '/run/atelier' }, { bootstrapToken: 'boot-secret' })
  const logs = []
  const registrar = createRegistrar({ os, dirfd, transport, cfg: { podIp: '10.0.0.7' }, log: (l) => logs.push(l), fsx, backoffMs, now, liveWorkers })
  return { os, dirfd, transport, registrar, fsx, state, logs }
}

test('register: bootstrap → hostId/epoch/token/company/origin/principal/apps/shell key; startedAt stamped; a failure retries with backoff', async () => {
  const spine = fakeSpine(); await spine.listen()
  try {
    spine.failRegister = 1
    const r = rig(spine)
    const t0 = Date.now()
    const out = await r.registrar.register()
    assert.equal(r.registrar.hostId, 'computer-1'); assert.equal(r.registrar.epoch, spine.epoch); assert.equal(r.registrar.token, spine.token)
    assert.equal(r.registrar.company, 'acme'); assert.equal(r.registrar.origin, 'https://acme.portal.pa1nd.de'); assert.deepEqual(r.registrar.principal, { id: 'p-agent', name: 'Bayard' })
    assert.ok(r.registrar.startedAt >= t0)
    assert.equal(publicKeyHex(r.registrar.publicKey()), publicKeyHex(spine.shellKeys.publicKey))
    assert.deepEqual(out.apps, [])
    assert.equal(spine.calls.filter((c) => c.path === '/v1/host/register').length, 2)
    assert.ok(r.logs.some((l) => /register failed.*retry in 5 ms/.test(l)))
    assert.deepEqual(spine.calls[0].body, { pod_ip: '10.0.0.7', host_started_at: spine.calls[0].body.host_started_at })
  } finally { await spine.close() }
})

test('claim: 201 → claimed with uid 20001, markers under the dirfd; a second app 20002; re-claim adopts the same instance and uid; meta split', async () => {
  const spine = fakeSpine(); await spine.listen()
  try {
    const r = rig(spine)
    await r.registrar.register()
    const a = await r.registrar.claim({ slug: 'todo', meta: { name: 'Todo', icon: '✅', primary: true, trusted: true, visibility: 'company' }, dir: '/work/apps/todo' })
    assert.equal(a.verdict, 'claimed'); assert.equal(a.claimed, true); assert.equal(a.uid, WORKER_UID_BASE + 1); assert.match(a.instance, /^i-[0-9a-f]{16}$/)
    const put = spine.calls.find((c) => c.method === 'PUT')
    assert.deepEqual(put.body, { slug: 'todo', meta: { name: 'Todo', icon: '✅', primary: true } })   // dropped keys never leave; primary travels as the request
    assert.equal(spine.apps.get(a.instance).requested_primary, true)
    assert.deepEqual(spine.apps.get(a.instance).meta, { name: 'Todo', icon: '✅' })
    assert.deepEqual(r.registrar.apps().get(a.instance), { slug: 'todo', uid: 20001, rev: null, meta: { name: 'Todo', icon: '✅' }, tombstone_at: null })
    // markers: mkdir 0711 on the dirfd path, files with their modes, never in the app folder
    assert.ok(r.state.calls.some((c) => c[0] === 'mkdir' && c[1] === `/work/.atelier/${a.instance}` && c[2] === 0o711))
    assert.deepEqual(r.fsx.files.get(`/work/.atelier/${a.instance}/slug`), { data: 'todo\n', mode: 0o600 })
    assert.deepEqual(r.fsx.files.get(`/work/.atelier/${a.instance}/uid`), { data: '20001\n', mode: 0o600 })
    assert.deepEqual(JSON.parse(r.fsx.files.get(`/work/.atelier/${a.instance}/registered.json`).data), { instance: a.instance, slug: 'todo', uid: 20001, company: 'acme' })
    assert.equal(r.fsx.files.get(`/work/.atelier/${a.instance}/registered.json`).mode, 0o600)
    assert.ok(![...r.fsx.files.keys()].some((p) => p.startsWith('/work/apps/')))
    const b = await r.registrar.claim({ slug: 'wiki', meta: { name: 'Wiki' }, dir: '/work/apps/wiki' })
    assert.equal(b.uid, 20002); assert.notEqual(b.instance, a.instance)
    const again = await r.registrar.claim({ slug: 'todo', meta: { name: 'Todo 2' }, dir: '/work/apps/todo' })
    assert.equal(again.verdict, 'adopted'); assert.equal(again.instance, a.instance); assert.equal(again.uid, 20001)
    assert.equal(r.state.calls.filter((c) => c[0] === 'spawnSync').length, 0)   // no refusal written
  } finally { await spine.close() }
})

test('refusals: a bad slug and a 409 from the registry write CLAIM-REFUSED.txt as uid 1000 (row G shape), never as root', async () => {
  const spine = fakeSpine(); await spine.listen()
  try {
    const r = rig(spine)
    await r.registrar.register()
    const bad = await r.registrar.claim({ slug: 'Bad_Slug', meta: {}, dir: '/work/apps/Bad_Slug' })
    assert.deepEqual(bad, { refused: { code: 400, error: "bad slug 'Bad_Slug'" } })
    spine.holdElsewhere('taken', 'computer-2')
    const taken = await r.registrar.claim({ slug: 'taken', meta: {}, dir: '/work/apps/taken' })
    assert.deepEqual(taken, { refused: { code: 409, error: 'slug-claimed' } })
    const spawns = r.state.calls.filter((c) => c[0] === 'spawnSync')
    assert.equal(spawns.length, 2)
    const [, argv, spec] = spawns[1]
    assert.equal(spec.uid, 1000); assert.equal(spec.gid, 1000); assert.deepEqual(spec.groups, []); assert.deepEqual(Object.keys(spec.env), ['PATH']); assert.equal(spec.umask, 0o022); assert.equal(spec.cwd, '/')
    assert.deepEqual(argv.slice(0, 9), ['sh', '-c', 'umask 22; exec "$@"', 'sh', 'setpriv', '--reuid=1000', '--regid=1000', '--clear-groups', '--'])
    assert.equal(argv[9], 'node'); assert.equal(argv[10], '-e'); assert.match(argv[11], /flag:"wx"/); assert.equal(argv[13], '/work/apps/taken/CLAIM-REFUSED.txt'); assert.match(argv[14], /409 slug-claimed\nDelete this file to retry/)
    assert.equal(r.registrar.apps().size, 0)
  } finally { await spine.close() }
})

test('unlink → tombstone; the owner re-creating the folder revives the same instance and uid; the uid survives a host restart', async () => {
  const spine = fakeSpine(); await spine.listen()
  try {
    const r = rig(spine)
    await r.registrar.register()
    const a = await r.registrar.claim({ slug: 'todo', meta: { name: 'Todo' }, dir: '/work/apps/todo' })
    await r.registrar.modulesChanged(a.instance, 1)     // the uid reaches the spine with the first modules-changed
    assert.deepEqual(spine.calls.at(-1).body, { apps: [{ instance: a.instance, slug: 'todo', uid: 20001, rev: 1 }] })
    const u = await r.registrar.unlink(a.instance)
    assert.equal(u.instance, a.instance); assert.ok(u.tombstone_at > 0)
    assert.equal(r.registrar.apps().get(a.instance).tombstone_at, u.tombstone_at)
    const back = await r.registrar.claim({ slug: 'todo', meta: { name: 'Todo' }, dir: '/work/apps/todo' })
    assert.equal(back.verdict, 'revived'); assert.equal(back.instance, a.instance); assert.equal(back.uid, 20001)
    // a fresh host (same spine): register() carries the uid → the claim adopts it; the next new app gets 20002
    const r2 = rig(spine, { fsx: r.fsx })
    const reg = await r2.registrar.register()
    assert.deepEqual(reg.apps, [a.instance])
    assert.equal(r2.registrar.apps().get(a.instance).uid, 20001)
    const c = await r2.registrar.claim({ slug: 'wiki', meta: {}, dir: '/work/apps/wiki' })
    assert.equal(c.uid, 20002)
    // the spine lost the uid (never persisted) but the marker holds it: never re-allocated
    spine.apps.get(a.instance).uid = null
    const r3 = rig(spine, { fsx: r.fsx })
    await r3.registrar.register()
    assert.equal(r3.registrar.apps().get(a.instance).uid, null)
    const d = await r3.registrar.claim({ slug: 'todo', meta: {}, dir: '/work/apps/todo' })
    assert.equal(d.uid, 20001)
  } finally { await spine.close() }
})

test('401 host-epoch-moved on any call → register again with a new epoch, then the call is retried once', async () => {
  const spine = fakeSpine(); await spine.listen()
  try {
    const r = rig(spine)
    await r.registrar.register()
    const e1 = r.registrar.epoch
    spine.revoke()
    const hb = await r.registrar.beat()
    assert.deepEqual(hb, { ok: true })
    assert.notEqual(r.registrar.epoch, e1); assert.equal(r.registrar.epoch, spine.epoch)
    assert.deepEqual(spine.calls.slice(-3).map((c) => c.path), ['/v1/host/heartbeat', '/v1/host/register', '/v1/host/heartbeat'])
    assert.ok(r.logs.some((l) => l.includes(EPOCH_MOVED)))
    assert.deepEqual(await r.registrar.draining(), { ok: true })
    assert.deepEqual(await r.registrar.appConfig('i-x'), { env: { K: 'V' } })
    // the two push lanes go through the same call(): a moved epoch re-registers and retries once
    spine.revoke()
    const e2 = r.registrar.epoch
    assert.deepEqual(await r.registrar.lane.appError({ kind: 'app-error', error: {} }), { ok: true })
    assert.notEqual(r.registrar.epoch, e2)
    assert.deepEqual(spine.calls.slice(-3).map((c) => c.path), ['/v1/host/event', '/v1/host/register', '/v1/host/event'])
    spine.revoke()
    assert.deepEqual(await r.registrar.lane.events([]), { accepted: 0, rejected: [] })
    assert.deepEqual(spine.calls.slice(-3).map((c) => c.path), ['/v1/host/events', '/v1/host/register', '/v1/host/events'])
    // a non-epoch error is thrown, not retried
    const bad = spineTransport({ spineUrl: spine.url }, { bootstrapToken: 'wrong' })
    await assert.rejects(bad.register({}), (e) => e instanceof TransportError && e.status === 401 && e.body.error === 'bad-bootstrap')
  } finally { await spine.close() }
})

test('heartbeat body: visible_apps = live workers ∪ served in the last 10 min; last_served_at; pod_ip', async () => {
  const spine = fakeSpine(); await spine.listen()
  try {
    let t = 1_000_000
    const r = rig(spine, { now: () => t, liveWorkers: () => ['i-live'] })
    await r.registrar.register()
    r.registrar.served('i-a'); t += 1000; r.registrar.served('i-b')
    t += 10 * 60 * 1000 - 500                      // i-a is 10 min + 0.5 s old → out; i-b (9 min 59.5 s) inside
    await r.registrar.beat()
    assert.deepEqual(spine.calls.at(-1).body, { visible_apps: 2, last_served_at: 1_001_000, pod_ip: '10.0.0.7' })
    const timer = r.registrar.heartbeat(50)
    await new Promise((res) => setTimeout(res, 120))
    r.registrar.stop()
    assert.ok(spine.calls.filter((c) => c.path === '/v1/host/heartbeat').length >= 2)
    assert.ok(timer)
  } finally { await spine.close() }
})

test('reconcile: unreadable resets, a 5 s settle after /work/apps is readable, ≤ 5 unlinks per pass with one loud log', async () => {
  const spine = fakeSpine(); await spine.listen()
  try {
    let t = 5_000_000
    const r = rig(spine, { now: () => t })
    await r.registrar.register()
    const made = []
    for (const s of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'keep']) made.push(await r.registrar.claim({ slug: s, meta: {}, dir: '/work/apps/' + s }))
    assert.deepEqual(await r.registrar.reconcile(null), { skipped: 'unreadable' })
    assert.deepEqual(await r.registrar.reconcile([{ slug: 'keep' }]), { skipped: 'settle' })
    t += RECONCILE_SETTLE_MS - 1
    assert.deepEqual(await r.registrar.reconcile([{ slug: 'keep' }]), { skipped: 'settle' })
    t += 1
    const p1 = await r.registrar.reconcile([{ slug: 'keep' }])
    assert.equal(p1.unlinked.length, 5); assert.equal(p1.remaining, 2)
    assert.ok(r.logs.some((l) => /reconcile: 7 registered apps have no folder — unlinking 5/.test(l)))
    const p2 = await r.registrar.reconcile([{ slug: 'keep' }])
    assert.equal(p2.unlinked.length, 2); assert.equal(p2.remaining, 0)
    assert.equal(r.registrar.apps().get(made[7].instance).tombstone_at, null)
    assert.ok([...r.registrar.apps().values()].filter((a) => a.slug !== 'keep').every((a) => a.tombstone_at !== null))
    // unreadable again → the settle clock restarts
    await r.registrar.reconcile(null)
    assert.deepEqual(await r.registrar.reconcile([]), { skipped: 'settle' })
  } finally { await spine.close() }
})

test('writeClaimRefused runs the wx write as uid 1000 through the adapter (memory-recorded)', () => {
  const state = {}
  const os = memory(state)
  writeClaimRefused(os, '/work/apps/x', '409 slug-claimed', () => 0)
  const [, argv, spec] = state.calls[0]
  assert.equal(state.calls[0][0], 'spawnSync')
  assert.equal(spec.uid, 1000); assert.deepEqual(spec.groups, [])
  assert.equal(argv.at(-1), '1970-01-01T00:00:00.000Z 409 slug-claimed\nDelete this file to retry.\n')
})

test('local transport twin: register/claim/adopt/unlink/revive over registry.json (0600), events into a ring, app errors kept', async () => {
  const state = {}
  const os = memory(state)
  const dirfd = os.openDir('/work/.atelier')
  const fsx = memoryFsx()
  let t = 100
  const transport = localTransport({ company: 'local', origin: 'http://127.0.0.1:1844' }, dirfd, { os, fsx, now: () => t })
  const registrar = createRegistrar({ os, dirfd, transport, cfg: {}, fsx, now: () => t })
  await registrar.register()
  assert.equal(registrar.hostId, 'local'); assert.match(registrar.epoch, /^[0-9a-f]{16}$/); assert.equal(registrar.company, 'local'); assert.deepEqual(registrar.principal, { id: 'local', name: 'local' })
  assert.equal(publicKeyHex(registrar.publicKey()), publicKeyHex(transport.keys.publicKey))
  const a = await registrar.claim({ slug: 'todo', meta: { name: 'Todo', primary: true, junk: 1 }, dir: '/tmp/apps/todo' })
  assert.equal(a.verdict, 'claimed'); assert.equal(a.uid, 20001)
  assert.equal(fsx.files.get('/work/.atelier/registry.json').mode, 0o600)
  const saved = JSON.parse(fsx.files.get('/work/.atelier/registry.json').data)
  assert.deepEqual(saved.apps[0], { instance: a.instance, slug: 'todo', uid: null, rev: null, meta: { name: 'Todo' }, requested_primary: true, tombstone_at: null })
  assert.equal((await registrar.claim({ slug: 'todo', meta: { name: 'Todo' }, dir: '/tmp/apps/todo' })).verdict, 'adopted')
  await registrar.modulesChanged(a.instance, 2)
  assert.equal(JSON.parse(fsx.files.get('/work/.atelier/registry.json').data).apps[0].uid, 20001)
  await registrar.unlink(a.instance)
  assert.equal(JSON.parse(fsx.files.get('/work/.atelier/registry.json').data).apps[0].tombstone_at, 100)
  const back = await registrar.claim({ slug: 'todo', meta: {}, dir: '/tmp/apps/todo' })
  assert.equal(back.verdict, 'revived'); assert.equal(back.instance, a.instance)
  assert.deepEqual(await transport.putApp('i-0000000000000000', { slug: 'todo', meta: {} }), { status: 200, instance_id: a.instance, adopted: true, revived: false })   // same computer, no marker: adopt (D1 item 5)
  await assert.rejects(transport.putApp('i-0000000000000000', { slug: 'Bad', meta: {} }), (e) => e.status === 400)
  // a fresh registrar on the same file sees the row (uid persisted through modules-changed)
  const again = createRegistrar({ os, dirfd, transport: localTransport({}, dirfd, { os, fsx, now: () => t }), cfg: {}, fsx, now: () => t })
  const reg = await again.register()
  assert.deepEqual(reg.apps, [a.instance]); assert.equal(again.apps().get(a.instance).uid, 20001)
  const ev = await transport.events([{ stream: 'local:' + registrar.epoch, topic: a.instance, seq: 1, type: 'invalidate' }])
  assert.deepEqual(ev, { accepted: 1, rejected: [] })
  assert.deepEqual(transport.ring.head(a.instance), { stream: 'local:' + registrar.epoch, seq: 1 })
  await transport.appError({ kind: 'app-error', error: { instance: a.instance } })
  assert.equal(transport.appErrors.length, 1)
  assert.deepEqual(await transport.appConfig(a.instance), { env: {} })
  assert.ok(SLUG_RE.test('todo'))
})
