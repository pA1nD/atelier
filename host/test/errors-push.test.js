// errors/push.mjs — validates first, the exact step-1 body, one in flight, the retry ladder, 4xx drop, queue cap, stale drop.
import test from 'node:test'
import assert from 'node:assert/strict'
import { push, QUEUE_MAX, BACKOFF_MS } from '../errors/push.mjs'
import { fakeClock, drain, lines } from './errors.helpers.js'

const ev = (n = 1, extra = {}) => ({ instance: 'i-a', rev: 1, kind: 'backend', fingerprint: `backend|backend.js:3|boom ${n}`, count: 1, firstAt: 1_700_000_000_000, lastAt: 1_700_000_000_000, message: `boom ${n}`, ...extra })
// transport fake: `script` answers in order (ok | {status} | 'network'); 'hold' parks the call until release()
function fakeTransport(script = []) {
  const t = { calls: [], held: [] }
  t.appError = (body) => {
    t.calls.push(body)
    const a = script.length ? script.shift() : 'ok'
    if (a === 'ok') return Promise.resolve({ ok: true })
    if (a === 'hold') return new Promise((res, rej) => t.held.push({ res, rej }))
    if (a === 'network') { const e = new Error('ECONNREFUSED'); e.code = 'ECONNREFUSED'; return Promise.reject(e) }
    const e = new Error(a.message ?? `spine ${a.status}`); e.status = a.status; return Promise.reject(e)
  }
  t.release = (i = 0) => { const h = t.held.splice(i, 1)[0]; h.res({ ok: true }) }
  return t
}
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await drain() }

test('validates with protocol validateAppError first: a refused event is logged and never sent', async () => {
  const t = fakeTransport(); const log = lines()
  const sink = push({ transport: t, log })
  sink({ ...ev(), extra: 1 }); sink({ ...ev(), firstAt: 'yesterday' }); sink(null)
  await settle()
  assert.equal(t.calls.length, 0)
  assert.deepEqual(log.out.map((l) => l.split(' — ')[0]), ['push: schema schema:extra', 'push: schema schema:at', 'push: schema schema'])
  assert.equal(sink.dropped(), 3)
})

test('the body is exactly the step-1 contract: {kind:"app-error", error:<event>}', async () => {
  const t = fakeTransport()
  const sink = push({ transport: t })
  const e = ev(1, { file: 'backend.js', line: 3, col: 9, hint: 'fix it', sample: { request: { method: 'GET', path: '/api/x', status: 500 } } })
  sink(e)
  await sink.idle()
  assert.deepEqual(t.calls, [{ kind: 'app-error', error: e }])
})

test('one in flight: the next event waits for the previous answer; order is kept', async () => {
  const t = fakeTransport(['hold', 'hold', 'ok'])
  const sink = push({ transport: t })
  sink(ev(1)); sink(ev(2)); sink(ev(3))
  await settle()
  assert.equal(t.calls.length, 1); assert.equal(sink.inFlight(), true); assert.equal(sink.size(), 2)
  t.release(); await settle()
  assert.equal(t.calls.length, 2)
  t.release(); await settle()
  assert.equal(t.calls.length, 3)
  await sink.idle()
  assert.deepEqual(t.calls.map((c) => c.error.message), ['boom 1', 'boom 2', 'boom 3'])
  assert.equal(sink.dropped(), 0)
})

test('5xx and network answers retry the same event on the ladder 500/2000/8000/30000 then 30000; success resets it', async () => {
  const clock = fakeClock(); const log = lines()
  const t = fakeTransport([{ status: 503 }, 'network', { status: 500 }, { status: 502 }, 'network', 'ok', { status: 503 }, 'ok'])
  const sink = push({ transport: t, timers: clock.timers, log })
  sink(ev(1)); sink(ev(2))
  await settle()
  assert.equal(t.calls.length, 1)
  for (const [i, wait] of [...BACKOFF_MS, 30000].entries()) {
    const sent = () => t.calls.filter((c) => c.error.message === 'boom 1').length
    clock.advance(wait - 1); await settle()
    assert.equal(sent(), i + 1, `no retry before ${wait} ms`)
    clock.advance(1); await settle()
    assert.equal(sent(), i + 2, `retry #${i + 1} at ${wait} ms`)
  }
  // attempt 6 succeeded (ev 1 delivered); ev 2 fails once → the ladder restarted at 500
  assert.equal(t.calls.length, 7)
  assert.equal(t.calls[6].error.message, 'boom 2')
  clock.advance(500); await settle()
  assert.equal(t.calls.length, 8)
  await sink.idle()
  assert.equal(t.calls.filter((c) => c.error.message === 'boom 1').length, 6)
  assert.equal(sink.dropped(), 0)
  assert.match(log.out[0], /^push: 503 spine 503 — retry in 500 ms \(2 queued\)$/)
})

test('a 4xx (except 401/408/429) drops the event with a log line and moves on', async () => {
  const clock = fakeClock(); const log = lines()
  const t = fakeTransport([{ status: 400, message: 'app-error: schema:hint' }, 'ok', { status: 401, message: 'host-epoch-moved' }, 'ok'])
  const sink = push({ transport: t, timers: clock.timers, log })
  sink(ev(1)); sink(ev(2)); sink(ev(3))
  await settle()
  assert.equal(t.calls.length, 3, 'ev 1 dropped, ev 2 sent at once and delivered, ev 3 got the 401')
  assert.equal(sink.dropped(), 1)
  assert.equal(log.out[0], 'push: 400 app-error: schema:hint — dropped backend backend|backend.js:3|boom 1 for i-a')
  clock.advance(500); await settle()
  assert.equal(t.calls.length, 4, '401 is retried (the transport re-registers meanwhile)')
  assert.equal(t.calls[3].error.message, 'boom 3')
})

test('queue ≤ QUEUE_MAX: past it the OLDEST waiting event is dropped, never the one in flight; logged once per 100', async () => {
  const t = fakeTransport(['hold']); const log = lines()
  const sink = push({ transport: t, log })
  for (let i = 1; i <= QUEUE_MAX + 3; i++) sink(ev(i))
  await settle()
  assert.equal(sink.size(), QUEUE_MAX - 1)
  assert.equal(sink.dropped(), 3)
  assert.equal(log.out.filter((l) => l.startsWith('push: queue full')).length, 1)
  t.release(); await sink.idle()
  assert.equal(t.calls[0].error.message, 'boom 1', 'the in-flight one was kept')
  assert.equal(t.calls[1].error.message, 'boom 5', 'boom 2..4 were dropped')
  assert.equal(t.calls.length, QUEUE_MAX)
})

test('an event that went stale while it waited is dropped at dequeue', async () => {
  const t = fakeTransport(['hold'])
  let running = 1
  const sink = push({ transport: t, running: () => running })
  sink(ev(1)); sink(ev(2)); sink(ev(3, { rev: 2 }))
  await settle()
  running = 2
  t.release(); await sink.idle()
  assert.deepEqual(t.calls.map((c) => c.error.message), ['boom 1', 'boom 3'])
  assert.equal(sink.dropped(), 1)
})

test('stop() cancels the retry timer; nothing is sent afterwards', async () => {
  const clock = fakeClock()
  const t = fakeTransport([{ status: 503 }])
  const sink = push({ transport: t, timers: clock.timers })
  sink(ev(1)); await settle()
  assert.equal(clock.pending(), 1)
  sink.stop()
  assert.equal(clock.pending(), 0)
  sink(ev(2)); clock.advance(60_000); await settle()
  assert.equal(t.calls.length, 1)
})
