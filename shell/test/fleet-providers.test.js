// providers/registry-fleet.mjs + bus-fleet.mjs against fakes: the spine read side cached with a TTL
// and invalidated by company frames, presence through the membership model, the computer row;
// the fleet ring never adopts a stream — unregistered until the registrar's hello, stale epochs refused.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRegistryFleet } from '../providers/registry-fleet.mjs'
import { createBusFleet } from '../providers/bus-fleet.mjs'
import { MembershipModel } from '../../protocol/index.js'

const TODO = 'i-0123456789abcdef', WIKI = 'i-fedcba9876543210'

function fakeSpine() {
  const calls = { apps: 0, host: 0 }
  const listeners = new Set()
  const rows = { acme: [{ instance: TODO, slug: 'todo', meta: { name: 'Todo' }, requested_primary: true, primary: false, rev: 3, state: 'live', computer: 'c-1', chat: 'chat-a' }, { instance: WIKI, slug: 'wiki', meta: {}, rev: 1, state: 'stopped', computer: 'c-1', chat: 'chat-b' }] }
  return {
    calls, rows,
    async apps(company) { calls.apps++; return rows[company] ?? [] },
    async instance(instance) { const c = Object.keys(rows).find((k) => rows[k].some((r) => r.instance === instance)); return c ? { company: c } : null },
    async host(company) { calls.host++; return company === 'acme' ? { host_id: 'c-1', epoch: 'e1', token: 'tok', pod_ip: '10.0.0.5', port: 1845, tls: null, heartbeat_at: 1000, draining_at: null } : null },
    chrome() { return { qid: 'global/catalyst-chrome', digest: 'sha256:abc' } },
    onCompany(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    fire(company) { for (const fn of listeners) fn(company) },
  }
}

test('registry-fleet: Host parse, TTL cache + company-frame invalidation, presence = the app chat, the computer row, stale rule', async () => {
  const spine = fakeSpine()
  const model = new MembershipModel({ persons: { p1: {}, p2: {} }, companies: { acme: { chats: { 'chat-a': ['p1'], 'chat-b': ['p1', 'p2'] } } } })
  let clock = 10_000
  const reg = createRegistryFleet({ spine, membership: { present: (personId, row) => model.present(personId, { company: row.company, chat: row.chat }) }, now: () => clock, ttlMs: 5000 })
  assert.equal(reg.company('acme.portal.pa1nd.de:443'), 'acme'); assert.equal(reg.company('portal.pa1nd.de'), null); assert.equal(reg.company('a.b.portal.pa1nd.de'), null); assert.equal(reg.company('evil.example'), null)
  assert.deepEqual(reg.companies(), [])
  const a = await reg.apps('acme')
  assert.equal(a.length, 2); assert.equal(a[0].requestedPrimary, true); assert.equal(a[0].primary, false); assert.equal(a[0].company, 'acme')
  await reg.apps('acme'); assert.equal(spine.calls.apps, 1, 'cached')
  clock += 6000; await reg.apps('acme'); assert.equal(spine.calls.apps, 2, 'TTL expired')
  const fired = []; reg.watch('acme', () => fired.push(1))
  spine.fire('acme'); assert.deepEqual(fired, [1])
  await reg.apps('acme'); assert.equal(spine.calls.apps, 3, 'invalidated by the company frame')
  assert.equal((await reg.byInstance(WIKI)).slug, 'wiki'); assert.equal(await reg.byInstance('i-0000000000000000'), null)
  assert.equal(await reg.present('p1', TODO), true); assert.equal(await reg.present('p2', TODO), false); assert.equal(await reg.present('p2', WIKI), true)
  assert.equal(await reg.present('stranger', TODO), false); assert.equal(await reg.present('p1', 'i-0000000000000000'), false)
  const h = await reg.host('acme')
  assert.deepEqual(h, { hostId: 'c-1', epoch: 'e1', token: 'tok', ip: '10.0.0.5', port: 1845, tls: null, heartbeatAt: 1000, drainingAt: null })
  assert.equal(await reg.host('beta'), null)
  assert.equal(reg.stale({ heartbeatAt: clock - 31_000, drainingAt: null }), true); assert.equal(reg.stale({ heartbeatAt: clock - 1000, drainingAt: null }), false); assert.equal(reg.stale({ heartbeatAt: clock, drainingAt: clock }), true)
  assert.deepEqual(reg.chrome('acme'), { qid: 'global/catalyst-chrome', dir: null, digest: 'sha256:abc' })
  reg.stop()
})

test('bus-fleet: no implicit adoption — unregistered before the hello, stale-epoch after a new one; company frames publish; snapshot error is always null', async () => {
  const spine = fakeSpine()
  const reg = createRegistryFleet({ spine, membership: { present: () => true } })
  let handlers = null
  const stream = { subscribe(h) { handlers = h; return () => { handlers = null } } }
  const bus = createBusFleet({ registry: reg, stream })
  const seen = []; bus.onAppend((ev) => seen.push(ev))
  bus.start()
  assert.deepEqual(handlers.onEvent({ stream: 'c-1:e1', topic: TODO, seq: 1, type: 'invalidate' }), { ok: false, reason: 'unregistered' })
  assert.equal(bus.ring.rings.has(TODO), false, 'no ring was created')
  handlers.onEpoch(TODO, 'e1')
  assert.equal(handlers.onEvent({ stream: 'c-1:e1', topic: TODO, seq: 1, type: 'invalidate' }).ok, true)
  assert.equal(handlers.onEvent({ stream: 'c-1:e1', topic: TODO, seq: 2, type: 'invalidate' }).ok, true)
  handlers.onEpoch(TODO, 'e2')
  assert.deepEqual(handlers.onEvent({ stream: 'c-1:e1', topic: TODO, seq: 3, type: 'invalidate' }), { ok: false, reason: 'stale-epoch' })
  assert.equal(handlers.onEvent({ stream: 'c-1:e2', topic: TODO, seq: 1, type: 'invalidate' }).ok, true)
  assert.deepEqual(handlers.onEvent({ stream: 'c-1:e2', topic: TODO, seq: 1, type: 'invalidate' }), { ok: false, reason: 'seq-not-monotonic' })
  assert.equal(handlers.onEvent({ bad: true }).ok, false)
  assert.deepEqual(seen.map((e) => [e.stream, e.seq]), [['c-1:e1', 1], ['c-1:e1', 2], ['c-1:e2', 1]])
  handlers.onCompany('acme')
  assert.equal(seen.at(-1).topic, 'company:acme'); assert.equal(seen.at(-1).stream, `shell:${bus.shellEpoch}`)
  assert.deepEqual(await bus.snapshot(TODO), { stream: 'c-1:e2', seq: 1, rev: 3, error: null })
  const rail = await bus.snapshot('company:acme')
  assert.deepEqual(rail.modules.map((m) => m.id), ['todo', 'wiki']); assert.equal(rail.chrome.digest, 'sha256:abc')
  assert.equal(bus.stats.rejected, 4)
  bus.stop(); reg.stop()
})
