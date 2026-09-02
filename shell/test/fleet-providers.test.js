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
  const calls = { apps: 0, host: 0, wake: [] }
  const listeners = new Set()
  const rows = { acme: [{ instance: TODO, slug: 'todo', meta: { name: 'Todo' }, requested_primary: true, primary: false, rev: 3, state: 'live', computer: 'c-1', chat: 'chat-a' }, { instance: WIKI, slug: 'wiki', meta: {}, rev: 1, state: 'stopped', computer: 'c-1', chat: 'chat-b' }] }
  return {
    calls, rows,
    async apps(company) { calls.apps++; return rows[company] ?? [] },
    async instance(instance) { const c = Object.keys(rows).find((k) => rows[k].some((r) => r.instance === instance)); return c ? { company: c } : null },
    async host(company) { calls.host++; return company === 'acme' ? { host_id: 'c-1', chat: 'chat-a', epoch: 'e1', token: 'tok', pod_ip: '10.0.0.5', port: 1845, tls: null, heartbeat_at: 1000, draining_at: null } : null },
    async wake(chat, opts) { calls.wake.push([chat, opts]); return { ok: true, state: 'waking', status: 202 } },
    chrome() { return { qid: 'global/catalyst-chrome', digest: 'sha256:abc' } },   // a pre-release shape (no version, no base): the provider fills base from the qid
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
  assert.deepEqual(h, { hostId: 'c-1', chat: 'chat-a', epoch: 'e1', token: 'tok', ip: '10.0.0.5', port: 1845, tls: null, heartbeatAt: 1000, drainingAt: null, chromeDigest: null })
  // the wake verb (step 7) is the spine's door, the actor riding along; the dial row on an app row carries the row's chat when the spine's `host` has none
  assert.deepEqual(await reg.wake('chat-b', { by: 'session:s-1' }), { ok: true, state: 'waking', status: 202 }); assert.deepEqual(spine.calls.wake, [['chat-b', { by: 'session:s-1' }]])
  // presence on a CHAT (the app-less wake target): the same membership rule the rows use
  assert.equal(await reg.presentOnChat('p1', 'acme', 'chat-a'), true); assert.equal(await reg.presentOnChat('p2', 'acme', 'chat-a'), false); assert.equal(await reg.presentOnChat('p2', 'acme', 'chat-b'), true); assert.equal(await reg.presentOnChat('p1', 'acme', null), false)
  spine.rows.acme[1].host = { host_id: 'c-2', epoch: 'e2', token: 'tok2', pod_ip: '10.0.0.6' }
  clock += 6000; assert.equal((await reg.hostOf((await reg.apps('acme'))[1])).chat, 'chat-b')
  assert.equal(createRegistryFleet({ spine: { ...spine, wake: undefined }, membership: { present: () => true } }).wake, undefined, 'no door on the spine → no verb (the poll only probes)')
  // host(company)'s `chat` comes from the spine row and nowhere else: a portal whose row shaping drops it leaves the
  // app-less poll with no wake target (the shell says so in its log; the contract is in the header of registry-fleet.mjs)
  const chatless = createRegistryFleet({ spine: { ...spine, async host() { return { host_id: 'c-1', epoch: 'e1', token: 'tok', pod_ip: '10.0.0.5', port: 1845 } } }, membership: { present: () => true } })
  assert.equal((await chatless.host('acme')).chat, null, 'no chat on the row → none on the host: the dependency is the row')
  assert.equal(await reg.host('beta'), null)
  assert.equal(reg.stale({ heartbeatAt: clock - 31_000, drainingAt: null }), true); assert.equal(reg.stale({ heartbeatAt: clock - 1000, drainingAt: null }), false); assert.equal(reg.stale({ heartbeatAt: clock, drainingAt: clock }), true)
  assert.deepEqual(reg.chrome('acme'), { qid: 'global/catalyst-chrome', dir: null, digest: 'sha256:abc', version: null, base: '/_chrome/sha256:abc' })
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

test('registry-fleet + bus-fleet, the chrome by digest (step 7 ship C): chrome(company) passes the spine\'s {qid, digest, version, base} through; every app row and dial row maps `chrome_digest` → `chromeDigest`; the rail frame carries the DEFAULT (`chromeRev`, `chrome.digest`, `chrome.version`) AND each row\'s `chromeDigest`', async () => {
  const D = 'd'.repeat(64), PREV = 'e'.repeat(64)
  const spine = fakeSpine()
  spine.rows.acme[0].chrome_digest = PREV; spine.rows.acme[1].chrome_digest = null
  spine.rows.acme[0].host = { host_id: 'c-1', chat: 'chat-a', epoch: 'e1', token: 'tok', pod_ip: '10.0.0.5', port: 1845, tls: null, heartbeat_at: 1000, draining_at: null, chrome_digest: PREV }
  spine.chrome = () => ({ qid: 'portal/catalyst-chrome', digest: D, version: '0.2.2', base: `/_chrome/${D}`, company: 'portal' })
  spine.host = async () => ({ host_id: 'c-1', chat: 'chat-a', epoch: 'e1', token: 'tok', pod_ip: '10.0.0.5', port: 1845, tls: null, heartbeat_at: 1000, draining_at: null, chrome_digest: PREV })
  const model = new MembershipModel({ persons: { p1: {} }, companies: { acme: { chats: { 'chat-a': ['p1'], 'chat-b': ['p1'] } } } })
  const reg = createRegistryFleet({ spine, membership: { present: async (p, row) => model.present(p, row) }, now: () => 5000 })
  assert.deepEqual(reg.chrome('acme'), { qid: 'portal/catalyst-chrome', dir: null, digest: D, version: '0.2.2', base: `/_chrome/${D}` })
  const rows = await reg.apps('acme')
  assert.equal(rows[0].chromeDigest, PREV); assert.equal(rows[1].chromeDigest, null)
  assert.equal(rows[0].host.chromeDigest, PREV); assert.equal((await reg.host('acme')).chromeDigest, PREV)
  const bus = createBusFleet({ registry: reg, stream: { subscribe: () => () => {} } })
  const rail = await bus.snapshot('company:acme', { person: { id: 'p1' } })
  assert.equal(rail.chromeRev, D); assert.deepEqual(rail.chrome, { qid: 'portal/catalyst-chrome', digest: D, version: '0.2.2' })
  assert.deepEqual(rail.modules.map((m) => [m.id, m.chromeDigest]), [['todo', PREV], ['wiki', null]])
  // no release: the v35 shape — digest null, base = the row's path, no version on the frame
  spine.chrome = () => ({ qid: 'portal/catalyst-chrome', digest: null })
  assert.deepEqual(reg.chrome('acme'), { qid: 'portal/catalyst-chrome', dir: null, digest: null, version: null, base: '/modules/portal/catalyst-chrome' })
  const bare = await bus.snapshot('company:acme')
  assert.equal(bare.chromeRev, null); assert.deepEqual(bare.chrome, { qid: 'portal/catalyst-chrome', digest: null })
})
