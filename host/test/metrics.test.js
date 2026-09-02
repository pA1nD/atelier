// host/metrics.mjs — the PLAN §4.5 rows: the ring's math, the Prometheus exposition's shape, the
// route's bearer gate, and the four feeds (a save's verdict, the Tailwind sheet's cold/warm ms, a
// resume, a restart, a watchdog trip, an events batch) landing where the scrape can see them.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMetrics, createRing, observe, quantile, PROM_CONTENT_TYPE, RING } from '../metrics.mjs'
import { createAuth } from '../protocol/auth.mjs'
import { createServer } from '../protocol/server.mjs'
import { createEvents } from '../protocol/events.mjs'
import { createWatchdog } from '../errors/watchdog.mjs'
import { memory } from '../adapters/os.mjs'
import { fakeRegistrar, fakeSupervisor, fakeCollector, keys, request, tmp } from './protocol-fixtures.mjs'
import { world, fakeExchange, waitFor, APP_JSON, BACKEND, FRONTEND, CARD } from './supervisor-harness.test.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
// samples(text, name) → one family's sample lines (`_sum`/`_count` included, HELP/TYPE and other families out)
const samples = (text, name) => text.split('\n').filter((l) => new RegExp(`^${name}(_sum|_count)?[{ ]`).test(l))
const value = (text, line) => { const l = text.split('\n').find((x) => x.startsWith(line)); return l === undefined ? null : Number(l.slice(l.lastIndexOf(' ') + 1)) }

test('the ring: last/sum/count over the whole life, p50/p99 nearest-rank over the window, non-numbers ignored', () => {
  const r = createRing(4)
  assert.equal(quantile(r, 0.5), null, 'an empty ring has no quantile')
  for (const v of [10, 20, 30, 40]) observe(r, v)
  assert.deepEqual([r.count, r.sum, r.last], [4, 100, 40])
  assert.equal(quantile(r, 0.5), 20)      // nearest rank: ceil(0.5·4) = 2 → the 2nd smallest
  assert.equal(quantile(r, 0.99), 40)
  observe(r, 50); observe(r, 60)          // wraps: the window is now 30,40,50,60
  assert.deepEqual([...r.values].sort((a, b) => a - b), [30, 40, 50, 60])
  assert.deepEqual([r.count, r.sum, r.last], [6, 210, 60], 'sum and count are the whole life, the window is the last 4')
  assert.equal(quantile(r, 0.5), 40)
  observe(r, NaN); observe(r, undefined); observe(r, 'x')
  assert.equal(r.count, 6, 'a non-finite sample is not a sample')
  assert.equal(createRing().size, RING)
})

test('exposition: one HELP/TYPE per family, quantiles + _sum/_count + _last per series, labels escaped, an empty host exposes only the dropped counter', () => {
  const m = createMetrics()
  let text = m.exposition()
  assert.equal(text.split('\n').filter((l) => l && !l.startsWith('#')).length, 1)
  assert.match(text, /^atelier_host_metrics_series_dropped_total 0$/m)
  assert.ok(text.endsWith('\n'))

  m.save('notes', 100, 'live'); m.save('notes', 300, 'error'); m.save('flights', 900, 'live')
  m.tailwind('notes', 41.5, { cold: true }); m.tailwind('notes', 4.9, {})
  m.resume('notes', 40); m.restart('notes'); m.restart('notes')
  m.watchdogTrip('notes', 'rss'); m.watchdogTrip('notes', 'cpu')
  m.eventsBatch(3); m.eventsBatch(7)
  text = m.exposition()

  for (const name of ['atelier_host_save_verdict_ms', 'atelier_host_tailwind_build_ms', 'atelier_host_worker_resume_ms', 'atelier_host_events_batch', 'atelier_host_save_verdicts_total', 'atelier_host_worker_restarts_total', 'atelier_host_watchdog_trips_total']) {
    assert.equal(text.split('\n').filter((l) => l.startsWith(`# HELP ${name} `)).length, 1, `one HELP for ${name}`)
    assert.equal(text.split('\n').filter((l) => l.startsWith(`# TYPE ${name} `)).length, 1, `one TYPE for ${name}`)
  }
  assert.match(text, /^# TYPE atelier_host_save_verdict_ms summary$/m)
  assert.match(text, /^# TYPE atelier_host_save_verdict_last_ms gauge$/m)
  assert.match(text, /^# TYPE atelier_host_worker_restarts_total counter$/m)
  // the alarm line of every row rides in its HELP
  assert.match(text, /# HELP atelier_host_save_verdict_ms .*alarm 1 s/)
  assert.match(text, /# HELP atelier_host_tailwind_build_ms .*alarm 50 ms cold/)
  assert.match(text, /# HELP atelier_host_worker_resume_ms .*alarm 100 ms/)

  // the OUTCOME is on the latency too, not only on the counter: the 1 s alarm is about the error path,
  // and a live save and an error save in one ring make it unwritable (a slow build fires it, a slow
  // error is diluted by fast live saves)
  assert.deepEqual(samples(text, 'atelier_host_save_verdict_ms'), [
    'atelier_host_save_verdict_ms{app="notes",outcome="live",quantile="0.5"} 100',
    'atelier_host_save_verdict_ms{app="notes",outcome="live",quantile="0.99"} 100',
    'atelier_host_save_verdict_ms_sum{app="notes",outcome="live"} 100',
    'atelier_host_save_verdict_ms_count{app="notes",outcome="live"} 1',
    'atelier_host_save_verdict_ms{app="notes",outcome="error",quantile="0.5"} 300',
    'atelier_host_save_verdict_ms{app="notes",outcome="error",quantile="0.99"} 300',
    'atelier_host_save_verdict_ms_sum{app="notes",outcome="error"} 300',
    'atelier_host_save_verdict_ms_count{app="notes",outcome="error"} 1',
    'atelier_host_save_verdict_ms{app="flights",outcome="live",quantile="0.5"} 900',
    'atelier_host_save_verdict_ms{app="flights",outcome="live",quantile="0.99"} 900',
    'atelier_host_save_verdict_ms_sum{app="flights",outcome="live"} 900',
    'atelier_host_save_verdict_ms_count{app="flights",outcome="live"} 1',
  ])
  assert.equal(value(text, 'atelier_host_save_verdict_last_ms{app="notes",outcome="error"}'), 300)
  assert.deepEqual(samples(text, 'atelier_host_save_verdicts_total'), [
    'atelier_host_save_verdicts_total{app="notes",outcome="live"} 1',
    'atelier_host_save_verdicts_total{app="notes",outcome="error"} 1',
    'atelier_host_save_verdicts_total{app="flights",outcome="live"} 1',
  ])
  // cold and warm are two series of the same app
  assert.equal(value(text, 'atelier_host_tailwind_build_ms{app="notes",phase="cold",quantile="0.5"}'), 41.5)
  assert.equal(value(text, 'atelier_host_tailwind_build_ms{app="notes",phase="warm",quantile="0.5"}'), 4.9)
  assert.equal(value(text, 'atelier_host_worker_resume_last_ms{app="notes"}'), 40)
  assert.equal(value(text, 'atelier_host_worker_restarts_total{app="notes"}'), 2)
  assert.deepEqual(samples(text, 'atelier_host_watchdog_trips_total'), [
    'atelier_host_watchdog_trips_total{app="notes",kind="rss"} 1',
    'atelier_host_watchdog_trips_total{app="notes",kind="cpu"} 1',
  ])
  // the events family carries no app label: _count = pushes, _sum = frames
  assert.equal(value(text, 'atelier_host_events_batch_sum'), 10)
  assert.equal(value(text, 'atelier_host_events_batch_count'), 2)
  assert.equal(value(text, 'atelier_host_events_batch_last'), 7)

  // a label value is escaped, never able to close its own quote or break the line
  const q = createMetrics()
  q.restart('we"ird\\one\nx')
  assert.match(q.exposition(), /^atelier_host_worker_restarts_total\{app="we\\"ird\\\\one\\nx"\} 1$/m)
})

test('the series cap: past maxApps a new app is dropped and counted, the known ones keep recording', () => {
  const m = createMetrics({ maxApps: 2 })
  m.save('a', 1, 'live'); m.save('b', 2, 'live'); m.save('c', 3, 'live'); m.save('a', 4, 'live')
  const text = m.exposition()
  assert.equal(value(text, 'atelier_host_save_verdict_ms_count{app="a",outcome="live"}'), 2)
  assert.equal(value(text, 'atelier_host_save_verdict_ms_count{app="c",outcome="live"}'), null, 'the third app is not remembered')
  assert.equal(value(text, 'atelier_host_save_verdicts_total{app="c",outcome="live"}'), null)
  assert.equal(value(text, 'atelier_host_metrics_series_dropped_total'), 2, 'one dropped sample per family the save would have opened a series in')
})

test('forget(app): a deleted app frees its slots — the cap counts what is LIVE, not what ever existed', () => {
  const m = createMetrics({ maxApps: 2 })
  m.save('a', 1, 'live'); m.tailwind('a', 5, { cold: true }); m.restart('a')
  m.save('b', 2, 'live')
  m.forget('a')                                   // the folder went: gone() calls this
  let text = m.exposition()
  assert.equal(value(text, 'atelier_host_save_verdict_ms_count{app="a",outcome="live"}'), null, 'every family of that slug, not just one')
  assert.equal(value(text, 'atelier_host_tailwind_build_ms_count{app="a",phase="cold"}'), null)
  assert.equal(value(text, 'atelier_host_worker_restarts_total{app="a"}'), null)
  assert.equal(value(text, 'atelier_host_save_verdict_ms_count{app="b",outcome="live"}'), 1, 'the other app is untouched')

  m.save('c', 3, 'live'); m.save('d', 4, 'live')  // a's slot is free, d is one past the cap
  text = m.exposition()
  assert.equal(value(text, 'atelier_host_save_verdict_ms_count{app="c",outcome="live"}'), 1, 'the freed slot is usable — the cap no longer latches on a dead app')
  assert.equal(value(text, 'atelier_host_save_verdict_ms_count{app="d",outcome="live"}'), null)
  assert.equal(value(text, 'atelier_host_metrics_series_dropped_total'), 2, 'the cap still holds at maxApps LIVE series')
})

function serverRig({ metrics, refuse } = {}) {
  const { publicKey } = keys()
  const registrar = fakeRegistrar({ hostId: 'computer-1', epoch: 'e1', token: 'tok1', publicKey })
  const supervisor = fakeSupervisor({ rows: [] })
  const dir = tmp()
  const server = createServer({ cfg: {}, auth: createAuth({ registrar, devToken: null, log: () => {} }), supervisor, collector: fakeCollector(), registrar, log: () => {}, listen: { path: path.join(dir, 'h.sock') }, refuse, metrics })
  return { server, target: { socketPath: path.join(dir, 'h.sock') }, bearer: { authorization: 'Bearer e1.tok1' } }
}

test('/_host/metrics: bearer-only, Prometheus text, GET only, 503 under a host fault', async () => {
  const metrics = createMetrics()
  metrics.resume('notes', 40)
  const r = serverRig({ metrics })
  await r.server.listen()
  try {
    let res = await request(r.target, { path: '/_host/metrics' })
    assert.equal(res.status, 401); assert.equal(res.body.toString(), '{}')
    res = await request(r.target, { path: '/_host/metrics', headers: { authorization: 'Bearer e0.tok1' } })
    assert.equal(res.status, 401, 'the epoch fences the metrics door like every other one')
    res = await request(r.target, { path: '/_host/metrics', headers: r.bearer })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], PROM_CONTENT_TYPE)
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.equal(Number(res.headers['content-length']), res.body.length)
    assert.match(res.body.toString(), /^atelier_host_worker_resume_last_ms\{app="notes"\} 40$/m)
    res = await request(r.target, { method: 'POST', path: '/_host/metrics', headers: r.bearer })
    assert.equal(res.status, 404, 'only GET is a route')
  } finally { await r.server.close(0) }

  const f = serverRig({ metrics, refuse: () => '.atelier renamed' })
  await f.server.listen()
  try {
    const res = await request(f.target, { path: '/_host/metrics', headers: f.bearer })
    assert.equal(res.status, 503, 'the host fault answers before the route')
  } finally { await f.server.close(0) }
})

test('a server built without metrics still answers the route (the default recorder is a real, unscraped one)', async () => {
  const r = serverRig()
  await r.server.listen()
  try {
    const res = await request(r.target, { path: '/_host/metrics', headers: r.bearer })
    assert.equal(res.status, 200)
    assert.match(res.body.toString(), /^atelier_host_metrics_series_dropped_total 0$/m)
  } finally { await r.server.close(0) }
})

test('the events lane records the size of every push; the watchdog counts a trip per app', async () => {
  const metrics = createMetrics()
  const sent = []
  const ev = createEvents({ transport: { events: async (b) => { sent.push(b.length); return { accepted: b.length } } }, hostId: 'computer-1', epoch: 'e1', metrics })
  ev.invalidate('i-a'); ev.invalidate('i-b'); ev.invalidate('i-a')   // coalesced per instance per flush
  await ev.flush()
  ev.invalidate('i-c')
  await ev.flush()
  ev.stop()
  assert.deepEqual(sent, [2, 1])
  const text = metrics.exposition()
  assert.equal(value(text, 'atelier_host_events_batch_count'), 2, 'two pushes')
  assert.equal(value(text, 'atelier_host_events_batch_sum'), 3, 'three frames')
  assert.equal(value(text, 'atelier_host_events_batch_last'), 1)

  const m2 = createMetrics()
  const worker = { instance: 'i-a', slug: 'notes', pid: 4001, uid: 20001, dataDir: '/work/.atelier/data/i-a', rev: 3 }
  const wd = createWatchdog({ os: memory({ procs: { 4001: { rssKb: 900 * 1024, jiffies: 0 } } }), workers: () => [worker], report: () => {}, kill: () => {}, dataRoot: '/work/.atelier/data', log: () => {}, metrics: m2 })
  wd.tick()
  assert.equal(value(m2.exposition(), 'atelier_host_watchdog_trips_total{app="notes",kind="rss"} '), 1, 'the trip is labelled by slug, not by instance id')
})

test('save→verdict: the clock runs from the watcher quiescence to LIVE and to the app-error; a scan-driven build is no save', async () => {
  const metrics = createMetrics()
  const w = world({ gitCommit: true })
  const dir = w.app('alpha', { 'module.json': APP_JSON('Alpha'), 'backend.js': BACKEND(1), 'frontend.jsx': FRONTEND(1), 'card.jsx': CARD })
  const sup = w.make({ metrics })
  try {
    await sup.scan()
    const row = await waitFor(() => { const r = sup.resolve('acme', 'alpha'); return r?.dev_state === 'live' ? r : null })
    assert.equal(value(metrics.exposition(), 'atelier_host_save_verdict_ms_count{app="alpha",outcome="live"}'), null, 'the first build comes from the scan, not from a save')

    fs.writeFileSync(path.join(dir, 'backend.js'), BACKEND(2))
    await waitFor(() => sup.resolve('acme', 'alpha').dev_rev === 2)
    let text = metrics.exposition()
    assert.equal(value(text, 'atelier_host_save_verdicts_total{app="alpha",outcome="live"}'), 1)
    assert.equal(value(text, 'atelier_host_save_verdict_ms_count{app="alpha",outcome="live"}'), 1)
    assert.ok(value(text, 'atelier_host_save_verdict_last_ms{app="alpha",outcome="live"}') >= 0, 'a real duration')

    // the deploy row: one green release → one sample and one count under outcome="green"
    const v = await sup.deploy(row.instance, { message: 'metrics release' })
    assert.equal(v.outcome, 'green')
    text = metrics.exposition()
    assert.equal(value(text, 'atelier_host_deploy_total{app="alpha",outcome="green"}'), 1)
    assert.equal(value(text, 'atelier_host_deploy_ms_count{app="alpha",outcome="green"}'), 1)
    assert.ok(value(text, 'atelier_host_deploy_last_ms{app="alpha",outcome="green"}') >= 0)

    fs.writeFileSync(path.join(dir, 'backend.js'), 'export default { mountRoutes( {{{\n')
    await waitFor(() => value(metrics.exposition(), 'atelier_host_save_verdicts_total{app="alpha",outcome="error"}') === 1)
    text = metrics.exposition()
    assert.equal(value(text, 'atelier_host_save_verdict_ms_count{app="alpha",outcome="error"}'), 1, 'a failed save reaches a verdict too, and lands in its OWN series')
    assert.ok(w.reports.some((r) => r.kind === 'build'))
    assert.equal(sup.resolve('acme', 'alpha').dev_rev, 2, 'the dev slot stays on the last good rev')
    // a red deploy (the broken tree rehearsed) lands under outcome="red"; prod untouched
    assert.equal((await sup.deploy(row.instance, { message: 'broken' })).outcome, 'red')
    assert.equal(value(metrics.exposition(), 'atelier_host_deploy_total{app="alpha",outcome="red"}'), 1)
    // the respawn counter: kill() of the PROD worker climbs the crash ladder, and every rung is one restart
    sup.kill(row.instance, 'metrics drill', 'prod')
    assert.equal(value(metrics.exposition(), 'atelier_host_worker_restarts_total{app="alpha"}'), 1)
  } finally { await w.done(sup) }
})

test('the Tailwind row is cold once per app then warm; a resume from the snapshot is one sample', async () => {
  const metrics = createMetrics()
  const chrome = tmp()
  fs.writeFileSync(path.join(chrome, 'styles.css'), "@import 'tailwindcss';\n")
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(chrome, 'node_modules'))
  const w = world({ chromeDir: chrome })
  const dir = w.app('beta', { 'module.json': APP_JSON('Beta'), 'backend.js': BACKEND(1), 'frontend.jsx': FRONTEND(1), 'card.jsx': CARD })
  const sup = w.make({ metrics, timing: { idleMs: 200, devIdleMs: 200 } })
  try {
    await sup.scan()
    await waitFor(() => { const r = sup.resolve('acme', 'beta'); return r?.dev_state === 'live' ? r : null })
    assert.equal(value(metrics.exposition(), 'atelier_host_tailwind_build_ms_count{app="beta",phase="cold"}'), 1)
    assert.equal(value(metrics.exposition(), 'atelier_host_tailwind_build_ms_count{app="beta",phase="warm"}'), null)

    fs.writeFileSync(path.join(dir, 'frontend.jsx'), FRONTEND(2))
    await waitFor(() => sup.resolve('acme', 'beta').dev_rev === 2)
    const text = metrics.exposition()
    assert.equal(value(text, 'atelier_host_tailwind_build_ms_count{app="beta",phase="cold"}'), 1, 'cold is this app\'s first sheet of the host life, never again')
    assert.equal(value(text, 'atelier_host_tailwind_build_ms_count{app="beta",phase="warm"}'), 1)

    // the dev worker idle-stops after devIdleMs (D18), then is resumed by the next dev request
    await waitFor(() => sup.resolve('acme', 'beta').dev_state === 'stopped')
    const x = fakeExchange('GET', '/rev')
    await sup.handle(sup.resolve('acme', 'beta'), x.req, x.res, { id: 'p1' }, { slot: 'dev' })
    assert.equal((await x.finished).status, 200)
    const after = metrics.exposition()
    assert.equal(value(after, 'atelier_host_worker_resume_ms_count{app="beta"}'), 1)
    assert.ok(value(after, 'atelier_host_worker_resume_last_ms{app="beta"}') >= 0)
  } finally { await w.done(sup); fs.rmSync(chrome, { recursive: true, force: true }) }
})
