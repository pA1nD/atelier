import test from 'node:test'
import assert from 'node:assert/strict'
import { nextWakeDelay, isWakingResponse, wakeUrl, startWakePoll, WAKE_MIN_MS, WAKE_MAX_MS } from '../waking.js'
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
})

test('the poll backs off, reloads on {ok:true}, stops cleanly', async () => {
  const clock = fakeClock()
  let answers = [{ status: 503, body: { ok: false } }, { status: 503, body: { ok: false } }, { status: 200, body: { ok: true } }]
  const fetch = fakeFetch([{ match: (u) => u.startsWith('/_atelier/wake'), respond: () => answers.shift() }])
  const ticks = []
  let reloaded = 0
  startWakePoll({ fetch, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, company: 'acme', reload: () => reloaded++, onTick: (t) => ticks.push(t) })
  await clock.advance(1999); assert.equal(fetch.calls.length, 0)
  await clock.advance(1);    assert.equal(fetch.calls.length, 1)
  await clock.advance(4000); assert.equal(fetch.calls.length, 2)
  await clock.advance(8000); assert.equal(fetch.calls.length, 3)
  assert.equal(reloaded, 1)
  assert.deepEqual(ticks.map((t) => t.ok), [false, false, true])
  await clock.advance(30000); assert.equal(fetch.calls.length, 3)          // reload ends the poll

  const stop = startWakePoll({ fetch, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, company: 'acme', reload: () => reloaded++ })
  stop()
  await clock.advance(30000); assert.equal(fetch.calls.length, 3)
})
