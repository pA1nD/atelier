// errors/collector.mjs — fingerprint = protocol's, the 1 s tally, stale-rev before sinks, setRunning, caps.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCollector, exitDetail, TALLY_MS, RECENT_MAX } from '../errors/collector.mjs'
import { fingerprint, validateAppError, MAX_MESSAGE_CHARS, MAX_STACK_CHARS, MAX_HINT_CHARS } from '../../protocol/index.js'
import { fakeClock, lines } from './errors.helpers.js'

const mk = () => {
  const clock = fakeClock(); const log = lines()
  const c = createCollector({ log, now: clock.now, timers: clock.timers })
  const got = []; c.sink((ev, ctx) => got.push({ ev, ctx }))
  return { clock, log, c, got }
}
const build = { message: 'Unexpected end of file\nsecond line', file: 'frontend.jsx', line: 4, col: 1, hint: 'frontend.jsx:4:1 Unexpected end of file — close the open JSX element' }

test('fingerprint is protocol fingerprint(); the event validates; detail keys land verbatim', () => {
  const { c, got, clock } = mk()
  const r = c.report('build', 'i-a', 3, build)
  assert.deepEqual(r, { ok: true, fingerprint: fingerprint({ kind: 'build', file: 'frontend.jsx', line: 4, message: build.message }), emitted: true })
  assert.equal(got.length, 1)
  const ev = got[0].ev
  assert.deepEqual(validateAppError(ev), { ok: true })
  assert.deepEqual(ev, { instance: 'i-a', rev: 3, kind: 'build', fingerprint: r.fingerprint, count: 1, firstAt: clock.now(), lastAt: clock.now(), message: build.message, file: 'frontend.jsx', line: 4, col: 1, hint: build.hint })
  assert.deepEqual(got[0].ctx, { running: undefined })
})

test('1 s tally: the first report goes out at once, the rest fold into ONE trailing event', () => {
  const { c, got, clock } = mk()
  const t0 = clock.now()
  assert.equal(c.report('backend', 'i-a', 1, { message: 'boom', file: 'backend.js', line: 3 }).emitted, true)
  for (let i = 0; i < 5; i++) { clock.advance(100); assert.equal(c.report('backend', 'i-a', 1, { message: 'boom', file: 'backend.js', line: 3, stack: `s${i}` }).emitted, false) }
  assert.equal(got.length, 1)
  clock.advance(TALLY_MS - 500)                       // t0 + 1000: the window closes
  assert.equal(got.length, 2)
  assert.equal(got[1].ev.count, 5)
  assert.equal(got[1].ev.firstAt, t0 + 100)
  assert.equal(got[1].ev.lastAt, t0 + 500)
  assert.equal(got[1].ev.stack, 's4', 'latest stack wins')
  assert.equal(c.report('backend', 'i-a', 1, { message: 'boom', file: 'backend.js', line: 3 }).emitted, true, 'a new window opens')
  assert.equal(got.length, 3)
  // a different fingerprint is its own tally
  assert.equal(c.report('backend', 'i-a', 1, { message: 'other', file: 'backend.js', line: 9 }).emitted, true)
  clock.advance(TALLY_MS)
  assert.equal(got.length, 4, 'tallies with nothing pending emit nothing at close')
})

test('stale-rev: below running is dropped before any sink; equal and newer pass', () => {
  const { c, got } = mk()
  c.setRunning('i-a', 5)
  assert.deepEqual(c.report('backend', 'i-a', 4, { message: 'x' }), { ok: false, reason: 'stale-rev' })
  assert.equal(got.length, 0)
  assert.deepEqual(c.recent('i-a'), [])
  assert.equal(c.report('backend', 'i-a', 5, { message: 'x' }).ok, true)
  assert.equal(c.report('build', 'i-a', 6, { message: 'y' }).ok, true, 'a save\'s build error is newer than running')
  assert.equal(got.length, 2)
  assert.equal(got[0].ctx.running, 5)
  assert.equal(c.running('i-a'), 5)
  assert.equal(c.running('i-none'), undefined)
})

test('setRunning to a new rev closes open tallies: pending of an older rev dropped, of the new rev emitted', () => {
  const { c, got, clock } = mk()
  c.setRunning('i-a', 5)
  c.report('backend', 'i-a', 5, { message: 'x' }); c.report('backend', 'i-a', 5, { message: 'x' })
  assert.equal(got.length, 1)
  c.setRunning('i-a', 6)
  assert.equal(got.length, 1, 'the rev-5 pending is stale')
  assert.equal(clock.pending(), 0, 'its timer is cleared')
  assert.equal(c.report('backend', 'i-a', 6, { message: 'x' }).emitted, true, 'the new rev is not folded into the old tally')
  // pending of the rev that becomes running is emitted, not lost
  c.report('build', 'i-a', 7, { message: 'y' }); c.report('build', 'i-a', 7, { message: 'y' })
  assert.equal(got.length, 3)
  c.setRunning('i-a', 7)
  assert.equal(got.length, 4)
  assert.equal(got[3].ev.count, 1)
  c.setRunning('i-a', 7)                                // same rev: no-op
  assert.equal(got.length, 4)
})

test('a report from a newer rev never folds into the previous rev tally (fold is per instance+rev)', () => {
  const { c, got, clock } = mk()
  c.report('build', 'i-a', 5, build)
  clock.advance(10)
  assert.equal(c.report('build', 'i-a', 5, build).emitted, false)
  clock.advance(10)
  assert.equal(c.report('build', 'i-a', 6, build).emitted, true, 'the next save\'s error lands at once')
  assert.equal(got.length, 3, 'the rev-5 pending went out when the tally closed')
  assert.equal(got[1].ev.rev, 5); assert.equal(got[1].ev.count, 1)
  assert.equal(got[2].ev.rev, 6)
})

test('sinks: a throwing sink is logged and never stops the others; unsubscribe works; recent ring is bounded', () => {
  const { c, got, log } = mk()
  const off = c.sink(() => { throw new Error('sink boom') })
  c.report('http', 'i-a', 1, { message: 'a' })
  assert.equal(got.length, 1)
  assert.ok(log.out.some((l) => l.includes('sink threw sink boom')))
  off()
  c.report('http', 'i-a', 1, { message: 'b' })
  assert.equal(log.out.filter((l) => l.includes('sink threw')).length, 1)
  for (let i = 0; i < RECENT_MAX + 20; i++) c.report('http', 'i-b', 1, { message: `m${i}` })
  assert.equal(c.recent('i-b', 1000).length, RECENT_MAX)
  assert.equal(c.recent('i-b').length, 50)
  assert.equal(c.recent('i-b', 2)[1].message, `m${RECENT_MAX + 19}`)
})

test('caps and the sample allowlist: nothing about the person is copied', () => {
  const { c, got } = mk()
  c.report('http', 'i-a', 1, {
    message: 'x'.repeat(MAX_MESSAGE_CHARS + 50), stack: 'y'.repeat(MAX_STACK_CHARS + 1), hint: 'h'.repeat(MAX_HINT_CHARS + 1),
    sample: { url: 'https://acme.portal/x', ua: 'Mozilla', request: { method: 'GET', path: '/api/boom', status: 500 }, person: { id: 'p1' }, cookie: 'a=b', email: 'a@b' },
  })
  const ev = got[0].ev
  assert.equal(ev.message.length, MAX_MESSAGE_CHARS)
  assert.equal(ev.stack.length, MAX_STACK_CHARS)
  assert.equal(ev.hint.length, MAX_HINT_CHARS)
  assert.deepEqual(ev.sample, { url: 'https://acme.portal/x', ua: 'Mozilla', request: { method: 'GET', path: '/api/boom', status: 500 } })
  assert.deepEqual(validateAppError(ev), { ok: true })
  assert.deepEqual(Object.keys(ev).sort(), ['count', 'fingerprint', 'firstAt', 'hint', 'instance', 'kind', 'lastAt', 'message', 'rev', 'sample', 'stack'])
})

test('bad inputs are refused with a reason and a log line', () => {
  const { c, got, log } = mk()
  assert.deepEqual(c.report('nope', 'i-a', 1, { message: 'x' }), { ok: false, reason: 'bad-kind' })
  assert.deepEqual(c.report('build', '', 1, { message: 'x' }), { ok: false, reason: 'bad-instance' })
  assert.deepEqual(c.report('build', 'i-a', -1, { message: 'x' }), { ok: false, reason: 'bad-rev' })
  assert.deepEqual(c.report('build', 'i-a', 1.5, { message: 'x' }), { ok: false, reason: 'bad-rev' })
  assert.equal(got.length, 0)
  assert.equal(log.out.length, 4)
  assert.equal(c.report('build', 'i-a', 0, {}).ok, true, 'rev 0 and an empty detail are legal')
})

test('flush() emits every open tally at teardown; exitDetail() names the death', () => {
  const { c, got } = mk()
  c.report('worker', 'i-a', 2, exitDetail(134, null)); c.report('worker', 'i-a', 2, exitDetail(134, null))
  assert.equal(got.length, 1)
  c.flush()
  assert.equal(got.length, 2)
  assert.equal(got[0].ev.message, 'exit 134')
  assert.match(got[0].ev.hint, /aborted/)
  assert.equal(exitDetail(null, 'SIGSEGV').message, 'signal SIGSEGV')
  assert.equal(exitDetail(0, null).message, 'exit 0')
})
