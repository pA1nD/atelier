// shell/metrics.mjs — the ring math, the Prometheus exposition, the operator gate on
// `/_atelier/metrics`, and the rows the live shell actually records (PLAN §4.5).
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { WebSocket } from 'ws'
import { createMetrics, quantile, perSecond, CONTENT_TYPE } from '../metrics.mjs'
import { createShell } from '../index.mjs'
import { createConfig } from '../config.mjs'
import { createMinter } from '../minter.mjs'
import { createIdentityLocal } from '../providers/identity-local.mjs'
import { createIdentityFleet } from '../providers/identity-fleet.mjs'
import { createGateLocal } from '../providers/gate-local.mjs'
import { createGateFleet } from '../providers/gate-fleet.mjs'
import { createHostLinkLocal } from '../providers/hostlink-local.mjs'
import { createHostLinkFleet } from '../providers/hostlink-fleet.mjs'
import { createRegistryFleet } from '../providers/registry-fleet.mjs'
import { fakeHost, fakeRegistry, fakeBus, fleetStores, TODO, WIKI } from './fixtures.mjs'

const SEC = 1_000_000_000_000                      // a round clock: Math.floor(SEC / 1000) is the bucket second
const apps = (company) => [
  { instance: TODO, slug: 'todo', company, rev: 3, state: 'live', meta: { name: 'Todo' }, primary: true },
  { instance: WIKI, slug: 'wiki', company, rev: 1, state: 'stopped', meta: { name: 'Wiki' } },
]
// every exposition line is either a comment or `name[{labels}] <number>`
const EXPO_LINE = /^(#\s(HELP|TYPE)\s\S+\s.+|[a-zA-Z_][a-zA-Z0-9_]*(\{[^}]*\})?\s(NaN|-?(\d+(\.\d+)?|\d+e[+-]\d+)))$/
const lines = (text) => text.split('\n').filter(Boolean)
const value = (text, name) => { const l = lines(text).find((x) => x.startsWith(name + ' ')); return l === undefined ? null : Number(l.slice(name.length + 1)) }

test('the rings: p50/p99 over the last samples, the rate window, bounded keys', () => {
  let clock = SEC
  const m = createMetrics({ now: () => clock, ring: 4, keys: 2, window: 3 })

  for (const ms of [10, 20, 30, 40]) m.proxyHeaders('h1', ms)
  let text = m.render()
  assert.equal(value(text, 'atelier_shell_proxy_headers_ms{host="h1",quantile="0.5"}'), 20)
  assert.equal(value(text, 'atelier_shell_proxy_headers_ms{host="h1",quantile="0.99"}'), 40)
  // the ring holds 4: the two oldest samples fall out of the quantiles, `_sum`/`_count` stay lifetime
  m.proxyHeaders('h1', 50); m.proxyHeaders('h1', 60)
  text = m.render()
  assert.equal(value(text, 'atelier_shell_proxy_headers_ms{host="h1",quantile="0.5"}'), 40)
  assert.equal(value(text, 'atelier_shell_proxy_headers_ms{host="h1",quantile="0.99"}'), 60)
  assert.equal(value(text, 'atelier_shell_proxy_headers_ms_sum{host="h1"}'), 210)
  assert.equal(value(text, 'atelier_shell_proxy_headers_ms_count{host="h1"}'), 6)

  // the rate ring: the window's average, and a bucket that aged out of it is gone
  for (let i = 0; i < 5; i++) m.frame('t1')
  assert.equal(value(m.render(), 'atelier_shell_events_frames_per_second{topic="t1"}'), Math.round((5 / 3) * 1000) / 1000)
  clock += 3000
  assert.equal(value(m.render(), 'atelier_shell_events_frames_per_second{topic="t1"}'), 0)
  assert.equal(value(m.render(), 'atelier_shell_events_frames_total{topic="t1"}'), 5)   // the counter is lifetime

  // keys = 2: a third host drops the oldest, so a churn of addresses cannot grow the shell
  m.proxyHeaders('h2', 1); m.proxyHeaders('h3', 1)
  text = m.render()
  assert.ok(!text.includes('host="h1",quantile'))
  assert.ok(text.includes('host="h2",quantile') && text.includes('host="h3",quantile'))

  // a non-finite is not a sample: it never enters the ring, so one NaN cannot poison `_sum` for the
  // life of the process — and what the exposition has no number for reads NaN, never a hard zero
  m.proxyHeaders('h4', NaN); m.proxyHeaders('h4', undefined); m.proxyHeaders('h4', 10)
  text = m.render({ registry: { cacheAgeMs: () => NaN } })
  assert.equal(value(text, 'atelier_shell_proxy_headers_ms_sum{host="h4"}'), 10)
  assert.equal(value(text, 'atelier_shell_proxy_headers_ms_count{host="h4"}'), 1)
  assert.ok(lines(text).includes('atelier_shell_registry_cache_age_seconds NaN'), 'unknown is NaN, not 0')
  for (const l of lines(text)) assert.match(l, EXPO_LINE, l)

  // the pure helpers on an empty series
  assert.equal(quantile({ v: new Float64Array(4), n: 0 }, 0.5), 0)
  assert.equal(perSecond({ b: new Int32Array(3), t: new Float64Array(3).fill(-1) }, 7), 0)
})

test('the exposition: every row well formed, labels escaped, the gauges read from events/bus/registry', () => {
  const m = createMetrics({ now: () => SEC })
  m.proxyHeaders('10.0.0.1:1845', 5)
  m.proxyDone('10.0.0.1:1845', 9, 'ok')
  m.proxyOutcome('10.0.0.1:1845', 'waking')
  m.proxyOutcome('10.0.0.1:1845', 'timeout')
  m.frame('i-aaaaaaaaaaaaaaaa'); m.gap('i-aaaaaaaaaaaaaaaa')
  m.resumed(4); m.resumed(6)
  m.bootstrap('ac"me', 1234)
  const text = m.render({
    events: { conns: new Set([1, 2, 3]), stats: { opened: 5, denied: 1, evicted: 2, reaped: 0, stalls: 4 } },
    bus: { stats: { appended: 7, rejected: 1 } },
    registry: { cacheAgeMs: () => 2500 },
  })
  for (const l of lines(text)) assert.match(l, EXPO_LINE, l)
  assert.equal(value(text, 'atelier_shell_proxy_body_ms{host="10.0.0.1:1845",quantile="0.5"}'), 9)
  assert.equal(value(text, 'atelier_shell_proxy_requests_total{host="10.0.0.1:1845",outcome="ok"}'), 1)
  assert.equal(value(text, 'atelier_shell_proxy_requests_total{host="10.0.0.1:1845",outcome="waking"}'), 1)
  assert.equal(value(text, 'atelier_shell_proxy_requests_total{host="10.0.0.1:1845",outcome="timeout"}'), 1)
  assert.equal(value(text, 'atelier_shell_proxy_requests_total{host="10.0.0.1:1845",outcome="error"}'), 0)
  assert.equal(value(text, 'atelier_shell_events_gaps_total{topic="i-aaaaaaaaaaaaaaaa"}'), 1)
  assert.equal(value(text, 'atelier_shell_events_resume_ms{quantile="0.5"}'), 4)
  assert.equal(value(text, 'atelier_shell_events_resume_ms_count'), 2)
  assert.equal(value(text, 'atelier_shell_events_sockets'), 3)
  assert.equal(value(text, 'atelier_shell_events_sockets_total{event="stalled"}'), 4)
  assert.equal(value(text, 'atelier_shell_bus_events_total{outcome="rejected"}'), 1)
  assert.equal(value(text, 'atelier_shell_registry_cache_age_seconds'), 2.5)
  assert.ok(text.includes('atelier_shell_document_bootstrap_bytes{company="ac\\"me",quantile="0.5"} 1234'), 'the label quote is escaped')
  // a fresh shell renders nothing rather than a page of zeroes, and nothing not asked for
  assert.equal(createMetrics().render(), '')
  assert.equal(createMetrics().render({ bus: {}, registry: {} }), '')
})

test('registry-fleet cacheAgeMs: the OLDEST live entry, null once every entry has expired', async () => {
  let clock = SEC
  const spine = { apps: async () => [], host: async () => null, chrome: () => ({ qid: null, digest: null }) }
  const reg = createRegistryFleet({ spine, membership: { present: async () => true }, ttlMs: 5000, now: () => clock })
  assert.equal(reg.cacheAgeMs(), null)
  await reg.apps('acme'); clock += 2000
  await reg.apps('beta')
  assert.equal(reg.cacheAgeMs(), 2000)             // acme's, the oldest of the two
  clock += 3500                                     // acme expired, beta is 3.5 s old
  assert.equal(reg.cacheAgeMs(), 3500)
  clock += 5000
  assert.equal(reg.cacheAgeMs(), null)
})

// ---- the live shell
async function rig(t, { mode = 'local' } = {}) {
  const company = mode === 'local' ? 'global' : 'acme'
  const host = fakeHost({ company })
  const hp = await host.start()
  const minter = createMinter()
  const stores = fleetStores()
  const companies = { [company]: { apps: apps(company), host: { port: hp, token: mode === 'local' ? 'dev' : 'tok', epoch: 'e1' } } }
  const registry = fakeRegistry({ mode, companies, chrome: mode === 'fleet' ? { qid: 'portal/catalyst-chrome', digest: 1700 } : undefined })
  const bus = fakeBus({ registry })
  const { cfg } = createConfig({ mode, config: {}, env: { PORT: '0' } })
  const providers = mode === 'local'
    ? { identity: createIdentityLocal(), gate: createGateLocal(), registry, bus, hostLink: createHostLinkLocal({ minter, dialMs: 400 }) }
    : { identity: createIdentityFleet({ sessions: stores.sessions, epochOf: stores.epochOf, company: (req) => registry.company(req.headers.host) }), gate: createGateFleet({ companies: (c) => !!companies[c], tickets: stores.tickets, sessions: stores.sessions }), registry, bus, hostLink: createHostLinkFleet({ minter, dialMs: 400 }) }
  const shell = createShell({ cfg, providers, log: () => {} })
  shell.start()
  const { port } = await shell.listen({ port: 0, host: '127.0.0.1' })
  t.after(async () => { await shell.close(100); await host.stop().catch(() => {}) })
  const plain = mode === 'fleet' ? await stores.sessions.create({ person: { id: 'p1', name: 'Bayard' }, company: 'acme' }) : null
  // the operator's session: what the spine's operator door mints (`op: true` on the row; the portal
  // copies it into the person's claims too — both are read)
  if (mode === 'fleet') stores.sessions.map.set('op-session', { person: { id: 'p9', name: 'Operator', claims: { op: true } }, epoch: 1, aud: 'acme', op: true })
  const go = (path, { method = 'GET', cookie = plain, headers = {} } = {}) => new Promise((resolve, reject) => {
    const h = { ...(mode === 'fleet' ? { host: 'acme.portal.pa1nd.de' } : {}), ...headers }
    if (cookie) h.cookie = `__Host-session=${cookie}`
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject); req.end()
  })
  return { shell, host, registry, bus, port, go, company, hostPort: hp }
}

test('the gate: local mode is the operator; in the fleet only an op session, and a refusal is the same 404 as any unknown name', async (t) => {
  const local = await rig(t)
  const open = await local.go('/_atelier/metrics')
  assert.equal(open.status, 200)
  assert.equal(open.type, CONTENT_TYPE)

  const fleet = await rig(t, { mode: 'fleet' })
  assert.equal((await fleet.go('/_atelier/metrics')).status, 404)                              // a signed-in member
  assert.equal((await fleet.go('/_atelier/metrics', { cookie: null })).status, 401)            // no session at all
  assert.equal((await fleet.go('/_atelier/nope', { cookie: 'op-session' })).status, 404)       // the shape a refusal borrows
  assert.equal((await fleet.go('/_atelier/metrics', { method: 'HEAD', cookie: 'op-session' })).status, 404)   // GET only
  assert.equal((await fleet.go('/_atelier/metrics', { method: 'POST', cookie: 'op-session' })).status, 403)   // the Origin lane refuses the write first
  const op = await fleet.go('/_atelier/metrics', { cookie: 'op-session' })
  assert.equal(op.status, 200)
  assert.equal(op.type, CONTENT_TYPE)
  for (const l of lines(op.text)) assert.match(l, EXPO_LINE, l)
})

test('the live rows: a proxied request per host, a waking host, the bootstrap bytes, socket frames, a gap and a resume', async (t) => {
  const r = await rig(t)
  const hostLabel = `127.0.0.1:${r.hostPort}`

  // a document → the bootstrap bytes of the company it composed
  const doc = await r.go('/global/todo')
  assert.equal(doc.status, 200)
  // a proxied API call → both timings and one `ok` under the app's host address
  assert.equal((await r.go('/api/global/todo/items')).status, 200)

  // the socket: sub (a `subscribed` frame names the topic), one event, then a resume on a stale
  // stream — the answer is a `gap`, and the resume is still timed
  const ws = new WebSocket(`ws://127.0.0.1:${r.port}/_atelier/ws?company=global`)
  const frames = []
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  ws.on('message', (d) => frames.push(JSON.parse(d)))
  const until = (pred) => new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { const f = frames.find(pred); if (f) return res(f); if (Date.now() - t0 > 2000) return rej(new Error('timeout')); setTimeout(tick, 5) }; tick() })
  ws.send(JSON.stringify({ op: 'sub', topics: [TODO] }))
  await until((f) => f.type === 'subscribed')
  r.bus.emit(TODO, 1)
  await until((f) => f.type === 'invalidate')
  ws.send(JSON.stringify({ op: 'resume', topic: TODO, stream: 'local:gone', seq: 1 }))
  await until((f) => f.type === 'gap')
  // a topic the registry does not know is DENIED — and a refusal is the client's own string coming back,
  // so it must not become a series: the topic map's cap drops the OLDEST key, and counting refusals would
  // let any member evict every real row and read their own strings out of the operator's scrape
  ws.send(JSON.stringify({ op: 'sub', topics: ['i-ffffffffffffffff'] }))
  await until((f) => f.type === 'denied')
  ws.terminate()

  const text = (await r.go('/_atelier/metrics')).text
  for (const l of lines(text)) assert.match(l, EXPO_LINE, l)
  assert.equal(value(text, `atelier_shell_proxy_requests_total{host="${hostLabel}",outcome="ok"}`), 1)
  assert.equal(value(text, `atelier_shell_proxy_headers_ms_count{host="${hostLabel}"}`), 1)
  assert.equal(value(text, `atelier_shell_proxy_body_ms_count{host="${hostLabel}"}`), 1)
  assert.ok(value(text, 'atelier_shell_document_bootstrap_bytes{company="global",quantile="0.5"}') > 100)
  assert.equal(value(text, 'atelier_shell_document_bootstrap_bytes_count{company="global"}'), 1)
  assert.ok(value(text, `atelier_shell_events_frames_total{topic="${TODO}"}`) >= 3)      // subscribed + invalidate + gap
  assert.equal(value(text, `atelier_shell_events_gaps_total{topic="${TODO}"}`), 1)
  assert.ok(!text.includes('i-ffffffffffffffff'), 'the denied topic left no series behind')
  assert.equal(value(text, 'atelier_shell_events_resume_ms_count'), 1)
  assert.ok(text.includes('atelier_shell_events_sockets '))
  // no registry cache age locally: the local registry's 1 s host view is not a revocation cache
  assert.ok(!text.includes('atelier_shell_registry_cache_age_seconds'))

  // the host stops → the dial is refused: `waking` on that host, and the mark's next refusal too
  await r.host.stop()
  assert.equal((await r.go('/api/global/todo/items')).status, 503)
  assert.equal((await r.go('/api/global/todo/items')).status, 503)
  const after = (await r.go('/_atelier/metrics')).text
  assert.equal(value(after, `atelier_shell_proxy_requests_total{host="${hostLabel}",outcome="waking"}`), 2)
  assert.equal(value(after, `atelier_shell_proxy_requests_total{host="${hostLabel}",outcome="ok"}`), 1)
})
