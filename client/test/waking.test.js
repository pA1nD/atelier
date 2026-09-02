import test from 'node:test'
import assert from 'node:assert/strict'
import { nextWakeDelay, isWakingResponse, wakeUrl, startWakePoll, WAKE_MIN_MS, WAKE_MAX_MS, WAKE_GIVE_UP_MS, WAKE_GIVE_UP_FLEET_MS } from '../waking.js'
import { fakeClock, fakeFetch } from './fakes.js'

test('backoff 2 s → 10 s', () => {
  const seq = []
  let d = null
  for (let i = 0; i < 6; i++) { d = nextWakeDelay(d); seq.push(d) }
  assert.deepEqual(seq, [2000, 4000, 8000, 10000, 10000, 10000])
  assert.equal(WAKE_MIN_MS, 2000); assert.equal(WAKE_MAX_MS, 10000)
})

test('isWakingResponse: 503 (+ x-atelier-waking) only', () => {
  const h = (v) => ({ get: (k) => (k === 'x-atelier-waking' ? v : null) })
  assert.equal(isWakingResponse({ status: 503, headers: h('1') }), true)
  assert.equal(isWakingResponse({ status: 503, headers: h(null) }), true)
  assert.equal(isWakingResponse({ status: 503, headers: h('0') }), false)
  assert.equal(isWakingResponse({ status: 502, headers: h('1') }), false)
  assert.equal(isWakingResponse(null), false)
  assert.equal(wakeUrl('acme'), '/_atelier/wake?company=acme')
  assert.equal(wakeUrl('acme', 'todo'), '/_atelier/wake?company=acme&app=todo'); assert.equal(wakeUrl('acme', null), '/_atelier/wake?company=acme')
})

test('the poll backs off, reloads on {ok:true}, stops cleanly', async () => {
  const clock = fakeClock()
  let answers = [{ status: 503, body: { ok: false } }, { status: 503, body: { ok: false } }, { status: 200, body: { ok: true } }]
  const fetch = fakeFetch([{ match: (u) => u.startsWith('/_atelier/wake'), respond: () => answers.shift() }])
  const ticks = []
  let reloaded = 0
  startWakePoll({ fetch, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, company: 'acme', reload: () => reloaded++, onTick: (t) => ticks.push(t) })
  await clock.advance(1999); assert.equal(fetch.calls.length, 0)
  await clock.advance(1);    assert.equal(fetch.calls.length, 1)
  await clock.advance(4000); assert.equal(fetch.calls.length, 2)
  await clock.advance(8000); assert.equal(fetch.calls.length, 3)
  assert.equal(reloaded, 1)
  assert.deepEqual(ticks.map((t) => t.ok), [false, false, true])
  await clock.advance(30000); assert.equal(fetch.calls.length, 3)          // reload ends the poll

  const stop = startWakePoll({ fetch, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, company: 'acme', reload: () => reloaded++ })
  stop()
  await clock.advance(30000); assert.equal(fetch.calls.length, 3)
})

test('the poll gives up after WAKE_GIVE_UP_MS (the shell page\'s 60 s; 180 s in the fleet): the tick that lands on the deadline is the give-up, no more fetches; the app slug rides the URL', async () => {
  assert.equal(WAKE_GIVE_UP_MS, 60000); assert.equal(WAKE_GIVE_UP_FLEET_MS, 180000)
  const clock = fakeClock()
  const fetch = fakeFetch([{ match: (u) => u.startsWith('/_atelier/wake'), respond: () => ({ status: 200, body: { ok: false } }) }])
  let gaveUp = 0, reloaded = 0
  const ticks = []
  startWakePoll({ fetch, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, company: 'acme', app: 'todo', reload: () => reloaded++, onTick: (t) => ticks.push(t.delay), onGiveUp: () => gaveUp++ })
  assert.equal(fetch.calls.length, 0)
  await clock.advance(59_999)
  assert.equal(gaveUp, 0); assert.equal(fetch.calls.length, 7)                 // 2, 6, 14, 24, 34, 44, 54 s
  await clock.advance(1)
  assert.equal(fetch.calls.length, 7); assert.equal(gaveUp, 1)                 // the 60 s tick is the give-up: no probe with no budget left
  assert.deepEqual(ticks, [2000, 4000, 8000, 10000, 10000, 10000, 10000])
  assert.equal(fetch.calls[0].url, '/_atelier/wake?company=acme&app=todo')
  await clock.advance(120_000)
  assert.equal(fetch.calls.length, 7); assert.equal(gaveUp, 1); assert.equal(reloaded, 0); assert.equal(clock.pending(), 0)
  // a shorter deadline; stop() before it → no give-up callback either
  const f2 = fakeFetch([{ match: () => true, respond: () => ({ status: 200, body: { ok: false } }) }])
  let g2 = 0
  const stop = startWakePoll({ fetch: f2, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, company: 'acme', reload: () => {}, onGiveUp: () => g2++, giveUpMs: 5000 })
  await clock.advance(5000); assert.equal(f2.calls.length, 1); assert.equal(g2, 1)      // 2 s, then 4 s clipped to 3 s = the deadline
  const f3 = fakeFetch([{ match: () => true, respond: () => ({ status: 200, body: { ok: false } }) }])
  let g3 = 0
  const stop3 = startWakePoll({ fetch: f3, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, company: 'acme', reload: () => {}, onGiveUp: () => g3++, giveUpMs: 5000 })
  await clock.advance(2000); stop3(); stop()
  await clock.advance(10_000); assert.equal(f3.calls.length, 1); assert.equal(g3, 0)
})

test('the deadline is wall-clock, like the shell page\'s: a probe that takes 30 s counts against the 60 s, so a slow shell gives up after ~66 s and two probes, not minutes and eight', async () => {
  const clock = fakeClock()
  const slow = (body) => new Promise((r) => clock.setTimeout(() => r(body), 30_000))
  const fetch = fakeFetch([{ match: (u) => u.startsWith('/_atelier/wake'), respond: () => slow({ status: 200, body: { ok: false } }) }])
  let gaveUp = 0
  startWakePoll({ fetch, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, company: 'acme', reload: () => {}, onGiveUp: () => gaveUp++ })
  await clock.advance(2000);  assert.equal(fetch.calls.length, 1)            // the first probe leaves at 2 s …
  await clock.advance(30_000); assert.equal(fetch.calls.length, 1); assert.equal(gaveUp, 0)   // … answers at 32 s; the next is due at 36 s
  await clock.advance(4000);  assert.equal(fetch.calls.length, 2)
  await clock.advance(30_000); assert.equal(gaveUp, 1); assert.equal(fetch.calls.length, 2)   // 66 s: past the deadline when it answers → give up, no third
  await clock.advance(120_000); assert.equal(fetch.calls.length, 2); assert.equal(gaveUp, 1); assert.equal(clock.pending(), 0)
})

// a fetch that never settles unless aborted: the AbortController's signal is the only way out
function hangingFetch() {
  const calls = []
  const f = (url, opts = {}) => new Promise((_, reject) => {
    calls.push({ url, opts })
    opts.signal?.addEventListener?.('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })
  f.calls = calls
  return f
}
// a minimal AbortController for the fake clock (the real one works too; this keeps the test's timers on the fake clock)
class FakeAbort {
  constructor() { const ls = []; this.signal = { aborted: false, addEventListener: (_, fn) => ls.push(fn) }; this._ls = ls }
  abort() { if (this.signal.aborted) return; this.signal.aborted = true; for (const fn of this._ls) fn() }
}

test('a probe that never settles is ABORTED at the remaining deadline: the give-up lands at exactly giveUpMs, not never; stop() aborts the in-flight probe', async () => {
  const clock = fakeClock()
  const fetch = hangingFetch()
  let gaveUp = 0
  startWakePoll({ fetch, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, company: 'acme', reload: () => {}, onGiveUp: () => gaveUp++, AbortController: FakeAbort })
  await clock.advance(2000); assert.equal(fetch.calls.length, 1); assert.ok(fetch.calls[0].opts.signal, 'the probe carries a signal')
  await clock.advance(57_999); assert.equal(gaveUp, 0); assert.equal(fetch.calls[0].opts.signal.aborted, false)
  await clock.advance(1); assert.equal(fetch.calls[0].opts.signal.aborted, true, 'aborted at the deadline'); assert.equal(gaveUp, 1); assert.equal(fetch.calls.length, 1)
  await clock.advance(120_000); assert.equal(fetch.calls.length, 1); assert.equal(gaveUp, 1); assert.equal(clock.pending(), 0)
  const f2 = hangingFetch()
  const stop = startWakePoll({ fetch: f2, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, company: 'acme', reload: () => {}, AbortController: FakeAbort })
  await clock.advance(2000); assert.equal(f2.calls.length, 1)
  stop(); assert.equal(f2.calls[0].opts.signal.aborted, true, 'stop() aborts the probe in flight'); assert.equal(clock.pending(), 0)
})

test('a tab coming back to the front (visibilitychange → visible) probes at once and starts its deadline over — after a give-up too; the in-flight probe is dropped; hidden does nothing', async () => {
  const clock = fakeClock()
  const listeners = []
  const document = { visibilityState: 'visible', addEventListener: (ev, fn) => listeners.push([ev, fn]), removeEventListener: (ev, fn) => { const i = listeners.findIndex((l) => l[1] === fn); if (i >= 0) listeners.splice(i, 1) } }
  const fire = (state) => { document.visibilityState = state; for (const [ev, fn] of listeners) if (ev === 'visibilitychange') fn() }
  const fetch = fakeFetch([{ match: (u) => u.startsWith('/_atelier/wake'), respond: () => ({ status: 200, body: { ok: false } }) }])
  let gaveUp = 0
  const ticks = []
  const stop = startWakePoll({ fetch, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, company: 'acme', reload: () => {}, onTick: (t) => ticks.push(t.delay), onGiveUp: () => gaveUp++, giveUpMs: 10_000, document, AbortController: FakeAbort })
  assert.equal(listeners.length, 1)
  await clock.advance(10_000); assert.equal(gaveUp, 1); assert.equal(fetch.calls.length, 2); assert.equal(clock.pending(), 0)   // 2, 6 s; 10 s is the give-up
  // locked phone, back at 90 s: one probe at once, the deadline re-armed, the backoff back at 2 s
  await clock.advance(80_000); assert.equal(fetch.calls.length, 2)
  fire('hidden'); await clock.flush(); assert.equal(fetch.calls.length, 2, 'hidden probes nothing')
  fire('visible'); await clock.flush(); assert.equal(fetch.calls.length, 3, 'visible: a probe at once')
  await clock.advance(2000); assert.equal(fetch.calls.length, 4, 'the backoff starts over')
  await clock.advance(8000); assert.equal(fetch.calls.length, 5); assert.equal(gaveUp, 2, 'a fresh 10 s budget (probes at +2, +6 s), then the give-up again'); assert.equal(clock.pending(), 0)
  // a probe in flight when the tab comes back is dropped (its answer ignored), a new one sent
  const hang = hangingFetch()
  let dropped = 0
  const stop2 = startWakePoll({ fetch: hang, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, company: 'acme', reload: () => {}, onTick: () => dropped++, giveUpMs: 10_000, document, AbortController: FakeAbort })
  await clock.advance(2000); assert.equal(hang.calls.length, 1)
  fire('visible'); await clock.flush()
  assert.equal(hang.calls[0].opts.signal.aborted, true, 'the stale probe is aborted'); assert.equal(hang.calls.length, 2, 'and a fresh one sent'); assert.equal(dropped, 0, 'the aborted probe is no tick')
  stop(); stop2(); assert.equal(listeners.length, 0, 'stop() removes the listener'); assert.equal(clock.pending(), 0)
})
