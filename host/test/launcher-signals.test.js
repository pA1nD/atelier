// host/launcher.mjs — restart policy, the crash line through the uid-1000 helper, SIGTERM order,
// exit-code mirroring (DESIGN §2.1 steps 4–6) with the memory adapter and a fake clock.
import test from 'node:test'
import assert from 'node:assert/strict'
import { memory } from '../adapters/os.mjs'
import { helperEnv } from '../hygiene.mjs'
import { createLauncher, backoffMs, exitCode, RESTART } from '../launcher.mjs'

function fakeClock() {
  let t = 1_000_000, id = 0
  const timers = new Map()
  return {
    now: () => t,
    setTimeout: (fn, ms) => { timers.set(++id, { at: t + ms, fn }); return id },
    clearTimeout: (h) => timers.delete(h),
    advance(ms) {
      const until = t + ms
      for (;;) {
        const next = [...timers.entries()].filter(([, v]) => v.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        t = next[1].at; timers.delete(next[0]); next[1].fn()
      }
      t = until
    },
    pending: () => timers.size,
  }
}
function fakeIo(state) {
  return {
    umask: (m) => state.calls.push(['umask', m]),
    write: (p, data, mode) => { state.fs[p] = { uid: 0, gid: 0, mode, type: 'file', data }; state.calls.push(['write', p, mode]) },
    unlink: (p) => { delete state.fs[p]; state.calls.push(['unlink', p]) },
  }
}
const ENV = { PATH: '/usr/bin:/bin', CHANNEL_TOKEN: 'secret', ATELIER_BOOTSTRAP: 'b' }

function boot(extra = {}) {
  const state = { fs: { '/work': { uid: 0, gid: 0, mode: 0o755, type: 'dir' } } }
  const os = memory(state), clock = fakeClock(), logs = []
  const handlers = {}
  let exited = null
  const l = createLauncher({ os, io: fakeIo(state), env: ENV, log: (m) => logs.push(m), clock, exit: (c) => { exited = c }, signals: { on: (s, fn) => { handlers[s] = fn } },
    hostArgv: ['node', '/app/host/index.mjs'], sessionArgv: ['node', '/app/session-supervisor.mjs'], devToken: 'D', ...extra })
  l.boot()
  const [host, sup] = state.spawned
  return { state, os, clock, logs, handlers, l, host, sup, exited: () => exited, spawned: () => state.spawned }
}
const helpers = (state) => state.spawned.filter((c) => c.spec.argv[0] === 'sh')
const hosts = (state) => state.spawned.filter((c) => c.spec.argv[1] === '/app/host/index.mjs')

test('host exit: host-ready unlinked, one crash line via the uid-1000 helper (row X), restart after 0.5 s, supervisor untouched', () => {
  const { state, clock, host, sup, logs, exited } = boot()
  state.fs['/run/atelier/host-ready'] = { uid: 0, gid: 0, mode: 0o644, type: 'file' }
  const supKills = []; sup.onSignal = (s) => supKills.push(s)
  host.exit(1)
  assert.equal(state.fs['/run/atelier/host-ready'], undefined, 'sentinel unlinked')
  const [h] = helpers(state)
  assert.deepEqual(h.spec, { argv: ['sh', '-c', 'cat >> /control/.host-crash'], env: helperEnv(ENV), cwd: '/', uid: 1000, gid: 1000, groups: [], umask: 0o077, stdio: ['pipe', 'ignore', 'inherit'] })
  assert.deepEqual(h.argv, ['sh', '-c', 'umask 77; exec "$@"', 'sh', 'setpriv', '--reuid=1000', '--regid=1000', '--clear-groups', '--', 'sh', '-c', 'cat >> /control/.host-crash'])
  assert.deepEqual(h.spec.env, { PATH: '/usr/bin:/bin' })
  assert.equal(hosts(state).length, 1, 'not yet restarted')
  clock.advance(499); assert.equal(hosts(state).length, 1)
  clock.advance(1); assert.equal(hosts(state).length, 2, 'restarted after 500 ms')
  assert.equal(hosts(state)[1].spec.stdio[3], 3, 'the same dirfd is inherited by the new host')
  assert.deepEqual(supKills, []); assert.equal(exited(), null)
  assert.ok(logs.some((l) => /host: exited code=1 signal=null/.test(l)))
  assert.ok(logs.some((l) => /host: restart in 500 ms/.test(l)))
})

test('backoff doubles 0.5 → 30 s and parks after 10 exits in 10 min; the pod stays up', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(backoffMs), [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
  const { state, clock, logs, exited } = boot()
  const delays = []
  for (let i = 1; i <= 10; i++) {
    const cur = hosts(state).at(-1)
    const before = hosts(state).length, t0 = clock.now()
    cur.exit(134)
    if (i === 10) break
    while (hosts(state).length === before) clock.advance(100)
    delays.push(clock.now() - t0)
  }
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
  assert.ok(logs.some((l) => /host: parked after 10 exits\/10 min/.test(l)))
  clock.advance(120_000)
  assert.equal(hosts(state).length, 10, 'no 11th spawn')
  assert.equal(helpers(state).length, 10, 'one crash line per exit')
  assert.equal(exited(), null, 'the launcher never exits for a host fault')
  assert.equal(clock.pending(), 0)
})

test('exits older than 10 min fall out of the window: the backoff and the park count reset', () => {
  const { state, clock } = boot()
  for (let i = 0; i < 5; i++) { hosts(state).at(-1).exit(1); clock.advance(31_000) }
  assert.equal(hosts(state).length, 6)
  clock.advance(RESTART.windowMs)
  const before = hosts(state).length, t0 = clock.now()
  hosts(state).at(-1).exit(1)
  while (hosts(state).length === before) clock.advance(100)
  assert.equal(clock.now() - t0, 500, 'back to the base delay after a quiet window')
})

test('SIGTERM: host signalled first, supervisor forwarded, exit with the supervisor code once both are gone', () => {
  const { handlers, host, sup, clock, exited, logs } = boot()
  const order = []
  host.onSignal = (s) => order.push(['host', s]); sup.onSignal = (s) => order.push(['sup', s])
  handlers.SIGTERM()
  assert.deepEqual(order, [['host', 'SIGTERM'], ['sup', 'SIGTERM']])
  assert.equal(exited(), null, 'waits for the children')
  host.exit(0)
  assert.equal(exited(), null, 'still waits for the supervisor')
  sup.exit(1)
  assert.equal(exited(), 1, 'mirrors the supervisor code')
  assert.equal(clock.pending(), 0, 'the deadline timer is cleared')
  assert.ok(logs.some((l) => /SIGTERM: host first, session supervisor next, 35000 ms/.test(l)))
})

test('SIGTERM budget = grace − 5 s: SIGKILL both at the deadline, exit 128+9 for a supervisor killed by signal', () => {
  const { handlers, host, sup, clock, exited } = boot({ cfg: { work: '/work', run: '/run/atelier', control: '/control', tmp: '/tmp', graceS: 40 } })
  const order = []
  host.onSignal = (s) => order.push(['host', s]); sup.onSignal = (s) => { order.push(['sup', s]); if (s === 'SIGKILL') sup.exit(null, 'SIGKILL') }
  handlers.SIGTERM()
  clock.advance(34_999)
  assert.deepEqual(order, [['host', 'SIGTERM'], ['sup', 'SIGTERM']])
  clock.advance(1)
  assert.deepEqual(order.slice(2), [['host', 'SIGKILL'], ['sup', 'SIGKILL']])
  assert.equal(exited(), null, 'the host has not reported its exit yet')
  host.exit(null, 'SIGKILL')
  assert.equal(exited(), 137)
})

test('a second SIGTERM is idempotent; a host exit during teardown is not a crash (no helper, no restart)', () => {
  const { state, handlers, host, sup, exited } = boot()
  handlers.SIGTERM(); handlers.SIGTERM()
  host.exit(0)
  assert.equal(helpers(state).length, 0); assert.equal(hosts(state).length, 1)
  sup.exit(0)
  assert.equal(exited(), 0)
})

test('supervisor exit: SIGTERM the host, exit with the supervisor code when the host is gone', () => {
  const { state, host, sup, clock, exited } = boot()
  const hostSignals = []; host.onSignal = (s) => hostSignals.push(s)
  sup.exit(3)
  assert.deepEqual(hostSignals, ['SIGTERM'])
  assert.equal(exited(), null)
  host.exit(0)
  assert.equal(exited(), 3)
  assert.equal(helpers(state).length, 0, 'a host stopping for the exit is not a crash')
  assert.equal(clock.pending(), 0)
})

test('supervisor exit: a host that ignores SIGTERM is SIGKILLed after 10 s; 128+signal mirroring', () => {
  const { host, sup, clock, exited } = boot()
  const hostSignals = []; host.onSignal = (s) => { hostSignals.push(s); if (s === 'SIGKILL') host.exit(null, 'SIGKILL') }
  sup.exit(null, 'SIGSEGV')
  clock.advance(9_999); assert.deepEqual(hostSignals, ['SIGTERM']); assert.equal(exited(), null)
  clock.advance(1); assert.deepEqual(hostSignals, ['SIGTERM', 'SIGKILL'])
  assert.equal(exited(), 128 + 11)
  assert.equal(exitCode({ code: null, signal: 'SIGTERM' }), 143); assert.equal(exitCode({ code: 7, signal: null }), 7); assert.equal(exitCode(null), 1)
})

test('supervisor exit while the host is parked or between restarts: exit at once', () => {
  const { state, host, sup, clock, exited } = boot()
  host.exit(1)                       // host down, restart timer armed
  assert.equal(clock.pending(), 1)
  sup.exit(2)
  assert.equal(exited(), 2)
  assert.equal(clock.pending(), 0, 'the pending restart is cancelled')
  assert.equal(hosts(state).length, 1)
})

test('sup.kill EPERM arrives as an error event: logged, treated as exited (exit 1)', () => {
  const { handlers, host, sup, logs, exited } = boot()
  sup.onSignal = () => { const e = new Error('kill EPERM'); e.code = 'EPERM'; e.syscall = 'kill'; sup.emit('error', e) }
  handlers.SIGTERM()
  assert.ok(logs.some((l) => /session supervisor: error EPERM kill .* treated as exited/.test(l)))
  host.exit(0)
  assert.equal(exited(), 1)
})

test('a host that cannot be spawned (error event) follows the restart policy, never a launcher exit', () => {
  const { state, host, clock, exited, logs } = boot()
  const e = new Error('spawn node ENOENT'); e.code = 'ENOENT'; e.syscall = 'spawn node'
  host.emit('error', e); host.emit('exit', null, null)   // node may fire both; handled once
  assert.equal(helpers(state).length, 1)
  clock.advance(500)
  assert.equal(hosts(state).length, 2)
  assert.equal(exited(), null)
  assert.equal(logs.filter((l) => /host: exited/.test(l)).length, 1)
})
