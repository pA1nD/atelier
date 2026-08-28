// errors/report.mjs — POST /_atelier/report: the rev must agree with the host's running rev, nothing about the person.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCollector } from '../errors/collector.mjs'
import { frontendReport, RATE_PER_MIN } from '../errors/report.mjs'
import { fingerprint, validateAppError } from '../../protocol/index.js'
import { fakeClock, lines } from './errors.helpers.js'

const mk = () => {
  const clock = fakeClock()
  const c = createCollector({ log: lines(), now: clock.now, timers: clock.timers })
  const got = []; c.sink((ev) => got.push(ev))
  return { clock, c, got, report: frontendReport({ collector: c }) }
}
const body = { instance: 'i-other', rev: 3, url: 'https://acme.portal.pa1nd.de/apps/weather', ua: 'Mozilla/5.0', message: 'TypeError: x is undefined', stack: 'TypeError: x is undefined\n    at f (frontend.js:10:5)', email: 'a@b', person: { id: 'p1' }, cookie: 'sid=1', rev2: 9 }

test('no running rev → no-running-rev; a body rev that disagrees → rev-mismatch (older AND newer)', () => {
  const { c, report, got } = mk()
  assert.deepEqual(report({ rev: 1, message: 'x' }, { instance: 'i-a' }), { ok: false, reason: 'no-running-rev' })
  c.setRunning('i-a', 3)
  assert.deepEqual(report({ rev: 2, message: 'x' }, { instance: 'i-a' }), { ok: false, reason: 'rev-mismatch' })
  assert.deepEqual(report({ rev: 4, message: 'x' }, { instance: 'i-a' }), { ok: false, reason: 'rev-mismatch' })
  assert.deepEqual(report({ rev: '3', message: 'x' }, { instance: 'i-a' }), { ok: false, reason: 'rev-mismatch' })
  assert.equal(got.length, 0)
  assert.equal(c.running('i-a'), 3, 'a report never advances running')
})

test('an agreeing report becomes a frontend event: only url/ua/message/stack are read, the route\'s instance wins', () => {
  const { c, report, got, clock } = mk()
  c.setRunning('i-a', 3)
  const r = report(body, { instance: 'i-a' })
  assert.equal(r.ok, true)
  assert.equal(got.length, 1)
  const ev = got[0]
  assert.deepEqual(validateAppError(ev), { ok: true })
  assert.deepEqual(ev, {
    instance: 'i-a', rev: 3, kind: 'frontend', fingerprint: fingerprint({ kind: 'frontend', message: body.message }), count: 1, firstAt: clock.now(), lastAt: clock.now(),
    message: body.message, stack: body.stack, sample: { url: body.url, ua: body.ua },
  })
  assert.equal(r.fingerprint, ev.fingerprint)
  assert.equal(JSON.stringify(ev).includes('a@b'), false)
  assert.equal(JSON.stringify(ev).includes('p1'), false)
})

test('bad bodies: not an object, no message, no instance', () => {
  const { c, report } = mk()
  c.setRunning('i-a', 1)
  for (const b of [null, 'x', [], 7]) assert.deepEqual(report(b, { instance: 'i-a' }), { ok: false, reason: 'bad-body' })
  assert.deepEqual(report({ rev: 1 }, { instance: 'i-a' }), { ok: false, reason: 'no-message' })
  assert.deepEqual(report({ rev: 1, message: '   ' }, { instance: 'i-a' }), { ok: false, reason: 'no-message' })
  assert.deepEqual(report({ rev: 1, message: 7 }, { instance: 'i-a' }), { ok: false, reason: 'no-message' })
  assert.deepEqual(report({ rev: 1, message: 'x' }, {}), { ok: false, reason: 'bad-instance' })
})

test('a flooding tab is bounded at RATE_PER_MIN accepted reports per instance per minute', () => {
  const { c, report, got, clock } = mk()
  c.setRunning('i-a', 1); c.setRunning('i-b', 1)
  for (let i = 0; i < RATE_PER_MIN; i++) assert.equal(report({ rev: 1, message: `m${i}` }, { instance: 'i-a' }).ok, true)
  assert.deepEqual(report({ rev: 1, message: 'late' }, { instance: 'i-a' }), { ok: false, reason: 'rate-limited' })
  assert.equal(report({ rev: 1, message: 'other app' }, { instance: 'i-b' }).ok, true, 'per instance')
  clock.advance(60_000)
  assert.equal(report({ rev: 1, message: 'next minute' }, { instance: 'i-a' }).ok, true)
  assert.equal(got.length, RATE_PER_MIN + 2)
  // the same message inside the collector's 1 s window folds (not counted as separate events)
  assert.equal(report({ rev: 1, message: 'next minute' }, { instance: 'i-a' }).ok, true)
  assert.equal(got.length, RATE_PER_MIN + 2)
})
