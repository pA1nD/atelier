// host/launcher.mjs — the restart policy of BOTH children (the storm rule), the crash line through the
// uid-1000 helper, a parked host ending the container, a session supervisor boot storm ending it too,
// SIGTERM order, exit-code mirroring (DESIGN §2.1 steps 4–6) with the memory adapter and a fake clock.
import test from 'node:test'
import assert from 'node:assert/strict'
import { memory } from '../adapters/os.mjs'
import { helperEnv } from '../hygiene.mjs'
import { createLauncher, backoffMs, storm, exitCode, orphanedWorkers, RESTART, HOST_PARKED_EXIT, SUP_BOOT_STORM_EXIT } from '../launcher.mjs'

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
    hostArgv: ['node', '/app/host/index.mjs'], sessionArgv: ['node', '/app/session-supervisor.mjs'], devToken: 'D', orphans: () => [], ...extra })
  l.boot()
  const [host, sup] = state.spawned
  return { state, os, clock, logs, handlers, l, host, sup, exited: () => exited, spawned: () => state.spawned }
}
const helpers = (state) => state.spawned.filter((c) => c.spec.argv[0] === 'sh')
const hosts = (state) => state.spawned.filter((c) => c.spec.argv[1] === '/app/host/index.mjs')
const sups = (state) => state.spawned.filter((c) => c.spec.argv[1] === '/app/session-supervisor.mjs')
// exits until the storm parks it: every exit of the current child, the clock advanced through each restart delay
// (`n` exits, `delays` measured; the last exit is the parking one and starts no restart). `liveMs` = how long each
// life runs before it exits (0 = dead at the spawn — a boot death for the supervisor).
function stormOf(state, clock, list, n = RESTART.parkExits, code = 134, liveMs = 0) {
  const delays = []
  for (let i = 1; i <= n; i++) {
    if (liveMs) clock.advance(liveMs)
    const before = list(state).length, t0 = clock.now()
    list(state).at(-1).exit(code)
    if (i === n) break
    clock.advance(0)
    while (list(state).length === before) clock.advance(100)
    delays.push(clock.now() - t0)
  }
  return delays
}

test('host exit: host-ready unlinked, one crash line via the uid-1000 helper (row X), restart at once, supervisor untouched', () => {
  const { state, clock, host, sup, logs, exited } = boot()
  state.fs['/run/atelier/host-ready'] = { uid: 0, gid: 0, mode: 0o644, type: 'file' }
  const supKills = []; sup.onSignal = (s) => supKills.push(s)
  host.exit(1)
  assert.equal(state.fs['/run/atelier/host-ready'], undefined, 'sentinel unlinked')
  const [h] = helpers(state)
  assert.deepEqual(h.spec, { argv: ['sh', '-c', 'cat >> /control/.host-crash'], env: helperEnv(ENV), cwd: '/', uid: 1000, gid: 1000, groups: [], umask: 0o077, stdio: ['pipe', 'ignore', 'inherit'] })
  assert.deepEqual(h.argv, ['sh', '-c', 'umask 77; exec "$@"', 'sh', 'setpriv', '--reuid=1000', '--regid=1000', '--clear-groups', '--', 'sh', '-c', 'cat >> /control/.host-crash'])
  assert.deepEqual(h.spec.env, { PATH: '/usr/bin:/bin' })
  assert.equal(hosts(state).length, 1, 'the restart is a timer, not synchronous')
  clock.advance(0); assert.equal(hosts(state).length, 2, 'restarted at once (the first exit in the window)')
  assert.equal(hosts(state)[1].spec.stdio[3], 3, 'the same dirfd is inherited by the new host')
  assert.deepEqual(supKills, []); assert.equal(exited(), null)
  assert.ok(logs.some((l) => /host: exited code=1 signal=null/.test(l)))
  assert.ok(logs.some((l) => /host: restart in 0 ms \(exit 1 in window\)/.test(l)))
})

test('backoff: at once, then 0.5 → 30 s doubling; the 10th exit in 10 min PARKS the host — and a parked host ends the container: the supervisor SIGTERMed, exit 3 once it is gone (never a Running pod with no host)', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(backoffMs), [0, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000])
  assert.deepEqual(storm([], 5000), { times: [5000], delay: 0 }); assert.deepEqual(storm([1000, 4000], 5000), { times: [1000, 4000, 5000], delay: 1000 })
  assert.deepEqual(storm([0], RESTART.windowMs), { times: [RESTART.windowMs], delay: 0 }, 'an exit a full window ago has fallen out')
  assert.equal(storm(Array.from({ length: 9 }, (_, i) => i), 9).delay, null, 'the 10th in the window parks')
  const { state, clock, logs, exited, sup } = boot()
  const supSignals = []; sup.onSignal = (s) => supSignals.push(s)
  const delays = stormOf(state, clock, hosts)
  assert.deepEqual(delays, [0, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000])
  assert.ok(logs.some((l) => /host: parked after 10 exits\/10 min — ending the container \(exit 3\)/.test(l)), logs.join('\n'))
  assert.equal(hosts(state).length, 10, 'no 11th spawn')
  assert.equal(helpers(state).length, 10, 'one crash line per exit')
  // the container ends: the supervisor gets SIGTERM (its own drain), the exit waits for it, then HOST_PARKED_EXIT
  assert.deepEqual(supSignals, ['SIGTERM'])
  assert.equal(exited(), null, 'waits for the supervisor')
  sup.exit(0)
  assert.equal(exited(), HOST_PARKED_EXIT, 'exit 3 whatever the supervisor exited with — the pod restarts with the kubelet backoff')
  assert.equal(clock.pending(), 0, 'no restart, no deadline left')
  clock.advance(120_000)
  assert.equal(hosts(state).length, 10)
})

test('a parked host: a supervisor that ignores SIGTERM is SIGKILLed after 10 s; exit 3 for it too', () => {
  const { state, clock, exited, sup } = boot()
  const supSignals = []; sup.onSignal = (s) => { supSignals.push(s); if (s === 'SIGKILL') sup.exit(null, 'SIGKILL') }
  stormOf(state, clock, hosts)
  clock.advance(9_999); assert.deepEqual(supSignals, ['SIGTERM']); assert.equal(exited(), null)
  clock.advance(1); assert.deepEqual(supSignals, ['SIGTERM', 'SIGKILL'])
  assert.equal(exited(), HOST_PARKED_EXIT)
})

test('the host parks while the supervisor is between restarts: the pending supervisor restart is cancelled, exit 3 at once', () => {
  const { state, clock, exited } = boot()
  for (let i = 1; i <= 9; i++) { hosts(state).at(-1).exit(1); clock.advance(30_000) }   // nine host exits inside the window, each restart awaited (delays ≤ 30 s)
  assert.equal(hosts(state).length, 10)
  sups(state).at(-1).exit(1); clock.advance(0)          // the supervisor's first exit: back at once
  sups(state).at(-1).exit(1)                            // its second: a 500 ms restart pending
  assert.equal(sups(state).length, 2); assert.equal(clock.pending(), 1)
  hosts(state).at(-1).exit(1)                           // the host's 10th exit in the window → parked
  assert.equal(exited(), HOST_PARKED_EXIT, 'no supervisor to wait for')
  assert.equal(clock.pending(), 0, 'the supervisor restart is cancelled')
  assert.equal(sups(state).length, 2)
})

test('exits older than 10 min fall out of the window: the backoff and the park count reset', () => {
  const { state, clock } = boot()
  for (let i = 0; i < 5; i++) { hosts(state).at(-1).exit(1); clock.advance(31_000) }
  assert.equal(hosts(state).length, 6)
  clock.advance(RESTART.windowMs)
  const before = hosts(state).length, t0 = clock.now()
  hosts(state).at(-1).exit(1)
  clock.advance(0)
  while (hosts(state).length === before) clock.advance(100)
  assert.equal(clock.now() - t0, 0, 'back to an immediate restart after a quiet window')
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

test('supervisor exit: respawned in place at once — the host untouched, no crash line, no launcher exit (an agent death never touches the host)', () => {
  const { state, host, sup, clock, exited, logs } = boot()
  const hostSignals = []; host.onSignal = (s) => hostSignals.push(s)
  sup.exit(3)
  assert.deepEqual(hostSignals, [], 'the host is not signalled')
  assert.equal(exited(), null, 'the container does not end')
  assert.equal(sups(state).length, 1, 'the restart is a timer, not synchronous')
  clock.advance(0)
  assert.equal(sups(state).length, 2, 'restarted at once (the first exit in the window)')
  assert.deepEqual(sups(state)[1].spec, sups(state)[0].spec, 'the same spawn spec: uid 1000, groups [19999], row S env, cwd /work')
  assert.equal(helpers(state).length, 0, 'no .host-crash line for a supervisor exit')
  assert.ok(logs.some((l) => /session supervisor: exited code=3 signal=null/.test(l)))
  assert.ok(logs.some((l) => /session supervisor: restart in 0 ms \(exit 1 in window\) after a 0\.0 s life — boot death 1\/10/.test(l)), logs.join('\n'))
  assert.equal(clock.pending(), 0)
  // a death by signal is the same restart (the code was never mirrored into the container)
  sups(state).at(-1).exit(null, 'SIGSEGV'); clock.advance(500)
  assert.equal(sups(state).length, 3); assert.equal(exited(), null)
  // a life that outlives the boot window (30 s) is not a boot death: the row resets
  clock.advance(RESTART.supBootMs); sups(state).at(-1).exit(1)
  assert.ok(logs.some((l) => /session supervisor: restart in 1000 ms \(exit 3 in window\) after a 30\.0 s life$/.test(l)), logs.join('\n'))
  assert.equal(exitCode({ code: null, signal: 'SIGTERM' }), 143); assert.equal(exitCode({ code: 7, signal: null }), 7); assert.equal(exitCode(null), 1)
})

test('supervisor RUNTIME storm (lives that ran ≥ 30 s): 0.5 → 30 s doubling, parked after 10 exits in 10 min — the host keeps serving, the launcher never exits; SIGTERM then mirrors the last supervisor exit', () => {
  const { state, host, clock, logs, exited, handlers } = boot()
  const hostSignals = []; host.onSignal = (s) => hostSignals.push(s)
  const delays = stormOf(state, clock, sups, RESTART.parkExits, 2, RESTART.supBootMs)   // 10 × 30 s + 91.5 s of backoff < the 10 min window
  assert.deepEqual(delays, [0, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000])
  assert.ok(logs.some((l) => /session supervisor: parked after 10 exits\/10 min — the host keeps serving/.test(l)), logs.join('\n'))
  clock.advance(120_000)
  assert.equal(sups(state).length, 10, 'no 11th spawn')
  assert.deepEqual(hostSignals, []); assert.equal(exited(), null, 'the launcher never exits for a supervisor fault')
  assert.equal(hosts(state).length, 1, 'the host was never restarted')
  assert.equal(clock.pending(), 0)
  // the pod's fate is the spine's now; a SIGTERM (its condemn) tears the host down and mirrors the last exit
  handlers.SIGTERM()
  assert.deepEqual(hostSignals, ['SIGTERM'])
  host.exit(0)
  assert.equal(exited(), 2, 'the last supervisor exit code')
})

test('supervisor BOOT storm: 10 lives in a row each dead within 30 s of its spawn → the container ends (exit 4): the backoff stands (never a tight loop), the host SIGTERMed first (its drain), no 11th spawn, exit once the host is gone', () => {
  const { state, host, clock, logs, exited } = boot()
  const hostSignals = []; host.onSignal = (s) => hostSignals.push(s)
  const delays = stormOf(state, clock, sups, RESTART.parkExits, 1, RESTART.supBootMs - 1)   // every life one ms short of the boot window
  assert.deepEqual(delays, [0, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000], 'the storm rule\'s backoff before the verdict: ten boot deaths take ≥ 90 s')
  assert.ok(logs.some((l) => /session supervisor: restart in 30000 ms \(exit 9 in window\) after a 30\.0 s life — boot death 9\/10/.test(l)), logs.join('\n'))
  assert.ok(logs.some((l) => /session supervisor: 10 lives in a row died within 30 s of the spawn — a boot storm; ending the container \(exit 4\)/.test(l)), logs.join('\n'))
  assert.ok(logs.some((l) => /boot storm: host first, session supervisor next, 35000 ms for the teardown/.test(l)))
  assert.equal(sups(state).length, 10, 'no 11th spawn')
  assert.deepEqual(hostSignals, ['SIGTERM'], 'the host drains')
  assert.equal(exited(), null, 'waits for the host')
  assert.equal(hosts(state).length, 1)
  host.exit(0)
  assert.equal(exited(), SUP_BOOT_STORM_EXIT, 'exit 4 — the pod restarts with the kubelet backoff, the container\'s state (the old tmux server, /tmp) gone with it')
  assert.equal(clock.pending(), 0, 'no restart, no deadline left')
  clock.advance(120_000)
  assert.equal(sups(state).length, 10); assert.equal(hosts(state).length, 1)
  assert.ok(logs.some((l) => /exit 4 \(session supervisor boot storm; session supervisor code=1 signal=null\)/.test(l)), logs.join('\n'))
})

test('a boot storm while the host is between restarts: the pending host restart is cancelled, exit 4 at once (no host to wait for)', () => {
  const { state, clock, exited } = boot()
  stormOf(state, clock, sups, RESTART.parkExits - 1, 1)     // nine boot deaths, the 9th respawn awaited
  clock.advance(0); while (sups(state).length === RESTART.parkExits - 1) clock.advance(100)
  assert.equal(sups(state).length, RESTART.parkExits)
  hosts(state).at(-1).exit(1); clock.advance(0)              // the host's first exit: back at once
  hosts(state).at(-1).exit(1)                                // its second: a 500 ms restart pending
  assert.equal(hosts(state).length, 2); assert.equal(clock.pending(), 1)
  sups(state).at(-1).exit(1)                                 // the 10th boot death in a row
  assert.equal(exited(), SUP_BOOT_STORM_EXIT, 'no host to wait for')
  assert.equal(clock.pending(), 0, 'the host restart is cancelled')
  clock.advance(120_000)
  assert.equal(hosts(state).length, 2); assert.equal(sups(state).length, RESTART.parkExits)
})

test('a boot storm: the host is SIGKILLed at the deadline when it ignores SIGTERM', () => {
  const { state, clock, exited, host } = boot()
  const hostSignals = []; host.onSignal = (s) => { hostSignals.push(s); if (s === 'SIGKILL') host.exit(null, 'SIGKILL') }
  stormOf(state, clock, sups, RESTART.parkExits, 1, 5_000)
  assert.deepEqual(hostSignals, ['SIGTERM']); assert.equal(exited(), null)
  clock.advance(34_999); assert.deepEqual(hostSignals, ['SIGTERM'])
  clock.advance(1); assert.deepEqual(hostSignals, ['SIGTERM', 'SIGKILL'])
  assert.equal(exited(), SUP_BOOT_STORM_EXIT)
})

test('the boot row resets on a life that outlived the boot window: 9 boot deaths, one long life, 9 more — never a boot storm; the window rule parks in place at its 10th', () => {
  const { state, clock, exited, logs } = boot()
  stormOf(state, clock, sups, 9, 1)                          // nine boot deaths, the 9th respawn awaited
  clock.advance(0); while (sups(state).length === 9) clock.advance(100)
  assert.equal(sups(state).length, 10)
  clock.advance(RESTART.windowMs)                            // a life of 10 min: the boot row AND the window reset
  sups(state).at(-1).exit(1); clock.advance(0)
  assert.equal(sups(state).length, 11, 'restarted at once (the first exit in a fresh window)')
  assert.ok(logs.some((l) => /restart in 0 ms \(exit 1 in window\) after a 600\.0 s life$/.test(l)), logs.join('\n'))
  stormOf(state, clock, sups, 9, 1)                          // nine more boot deaths = the window's 10th exit
  assert.equal(exited(), null, 'not a boot storm (9 in a row)')
  assert.ok(logs.some((l) => /session supervisor: parked after 10 exits\/10 min — the host keeps serving/.test(l)), logs.join('\n'))
  assert.equal(sups(state).length, 19); assert.equal(clock.pending(), 0)
})

test('exits older than 10 min fall out of the supervisor\'s window too: back to an immediate restart after a quiet window', () => {
  const { state, clock } = boot()
  for (let i = 0; i < 5; i++) { sups(state).at(-1).exit(1); clock.advance(31_000) }
  assert.equal(sups(state).length, 6)
  clock.advance(RESTART.windowMs)
  const before = sups(state).length, t0 = clock.now()
  sups(state).at(-1).exit(1)
  clock.advance(0)
  while (sups(state).length === before) clock.advance(100)
  assert.equal(clock.now() - t0, 0)
})

test('SIGTERM while a supervisor restart is pending: the restart is cancelled, the host torn down, the exit mirrors the last supervisor exit', () => {
  const { state, handlers, host, clock, exited } = boot()
  sups(state).at(-1).exit(2); clock.advance(0); sups(state).at(-1).exit(4)     // second exit → a 500 ms timer
  assert.equal(clock.pending(), 1)
  handlers.SIGTERM()
  assert.equal(clock.pending(), 1, 'the restart timer is gone; the SIGTERM deadline stands')
  host.exit(0)
  assert.equal(exited(), 4)
  assert.equal(sups(state).length, 2)
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

test('a dead host\'s workers are SIGKILLed before the restart (every /proc uid in the worker range); the supervisor is not', () => {
  const procs = { '/proc': ['1', '8', '17', '102', '4365', 'self', 'meminfo'], '/proc/1/status': 'Name:\tbash\nUid:\t0\t0\t0\t0\n', '/proc/8/status': 'Uid:\t0\t0\t0\t0\n', '/proc/17/status': 'Uid:\t1000\t1000\t1000\t1000\n', '/proc/102/status': 'Uid:\t20001\t20001\t20001\t20001\n', '/proc/4365/status': 'Uid:\t20004\t20004\t20004\t20004\n' }
  const found = orphanedWorkers({ readdir: (d) => procs[d], read: (p) => { if (!(p in procs)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return procs[p] } })
  assert.deepEqual(found, [{ pid: 102, uid: 20001 }, { pid: 4365, uid: 20004 }])
  assert.deepEqual(orphanedWorkers({ readdir: () => { throw new Error('EACCES') } }), [])
  const { state, host, logs } = boot({ orphans: () => found })
  host.exit(null, 'SIGKILL')
  const kills = state.calls.filter((c) => c[0] === 'kill').map((c) => c.slice(1))
  assert.deepEqual(kills, [[102, 'SIGKILL'], [4365, 'SIGKILL']])
  assert.ok(logs.some((l) => /host: SIGKILLed 2 orphaned worker process\(es\): 102\/20001 4365\/20004/.test(l)))
})
