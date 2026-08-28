// errors/watchdog.mjs with a fake /proc (memory adapter): RSS kill at cap, CPU throttle bounded, no kill on CPU,
// disk 95 % → SIGSTOP the largest grower, SIGCONT at 90 %, du/find as the worker uid, shm.
import test from 'node:test'
import assert from 'node:assert/strict'
import { memory } from '../adapters/os.mjs'
import { createWatchdog, cpuPct, stopMsFor, usedPct, parseKb, sumKb, STOP_MAX_MS, CPU_REPORT_CYCLES, SHM_STOP_KB, DISK_STOP_PCT, DISK_RESUME_PCT } from '../errors/watchdog.mjs'
import { rssCapKb } from '../errors/limits.mjs'
import { fakeClock, lines } from './errors.helpers.js'

const A = { instance: 'i-a', pid: 4001, uid: 20001, dataDir: '/work/.atelier/data/i-a', sock: '/run/atelier/w/i-a/w.sock', rev: 3 }
const B = { instance: 'i-b', pid: 4002, uid: 20002, dataDir: '/work/.atelier/data/i-b', sock: '/run/atelier/w/i-b/w.sock', rev: 7 }
function mk({ workers = [A, B], procs = {}, statfs = {}, du = {}, shm = {} } = {}) {
  const clock = fakeClock(); const log = lines()
  const state = { procs, statfs: { '/work/.atelier/data': statfs }, answers: {} }
  state.answers.spawnSync = (argv, spec) => {
    const a = spec.argv
    if (a[0] === 'du') { const kb = du[a[3]]; return kb === undefined ? { status: 1, stdout: '', stderr: 'EACCES' } : { status: 0, stdout: `${kb}\t${a[3]}\n`, stderr: '' } }   // `du` holds the CURRENT size per dir; tests mutate it between passes
    if (a[0] === 'find') { const v = shm[a[3]]; return v === undefined ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: v.map((k) => `${k}\n`).join(''), stderr: '' } }
    return { status: 127, stdout: '', stderr: '' }
  }
  const os = memory(state)
  const reports = []; const kills = []
  const wd = createWatchdog({ os, workers: () => workers, report: (k, i, r, d) => reports.push({ kind: k, instance: i, rev: r, ...d }), kill: (i, why) => kills.push({ instance: i, why }), dataRoot: '/work/.atelier/data', now: clock.now, timers: clock.timers, log })
  const signals = () => state.calls.filter((c) => c[0] === 'kill').map((c) => c.slice(1))
  return { clock, log, state, os, wd, reports, kills, signals, workers }
}

test('pure helpers: cpuPct, stopMsFor (≤ 400 ms), usedPct, parseKb/sumKb', () => {
  assert.equal(cpuPct(12, 120), 1)
  assert.equal(cpuPct(6, 120), 0.5)
  assert.equal(cpuPct(0, 0), 0)
  assert.equal(stopMsFor(1, 120), 78)
  assert.equal(stopMsFor(0.5, 120), 36)
  assert.equal(stopMsFor(1, 1000), STOP_MAX_MS)
  assert.equal(stopMsFor(10, 5000), STOP_MAX_MS)
  assert.equal(usedPct({ bytes: 100, free: 4 }), 96)
  assert.equal(usedPct(null), null)
  assert.equal(parseKb('12345\t/work/x\n'), 12345)
  assert.equal(parseKb(''), null)
  assert.equal(sumKb('4\n8\n\n12\n'), 24)
})

test('RSS above the cap → kill(instance, "rss X > Y") + one worker report, never a raw signal', () => {
  const cap = rssCapKb()                      // 384 MB for the 1 GiB default
  const { wd, kills, reports, signals, state } = mk({ procs: { 4001: { rssKb: 412 * 1024, jiffies: 0 }, 4002: { rssKb: cap, jiffies: 0 } } })
  wd.tick()
  assert.deepEqual(kills, [{ instance: 'i-a', why: 'rss 412M > 384M' }])
  assert.equal(reports.length, 1)
  assert.equal(reports[0].kind, 'worker'); assert.equal(reports[0].instance, 'i-a'); assert.equal(reports[0].rev, 3)
  assert.equal(reports[0].message, 'rss 412M > 384M')
  assert.match(reports[0].hint, /RLIMIT_DATA 1024M − 640 MB/)
  assert.deepEqual(signals(), [], 'the supervisor does the SIGKILL')
  assert.equal(wd.state()['i-b'].rssKb, cap, 'at the cap is not over it')
  // a smaller RLIMIT_DATA moves the cap with it (min 256 MB)
  const { wd: wd2, kills: k2 } = mk({ workers: [{ ...A, rlimits: { data: 1536 * 1024 * 1024 } }], procs: { 4001: { rssKb: 412 * 1024, jiffies: 0 } } })
  wd2.tick(); assert.deepEqual(k2, [])
  void state
})

test('CPU above 35 % of one core → SIGSTOP for elapsed·(1 − 0.35/pct), SIGCONT after; no kill; not re-sampled while stopped', () => {
  const procs = { 4001: { rssKb: 1000, jiffies: 0 }, 4002: { rssKb: 1000, jiffies: 0 } }
  const { wd, clock, kills, signals } = mk({ procs })
  wd.tick()                                       // baseline
  clock.advance(120); procs[4001].jiffies = 12; procs[4002].jiffies = 3     // A 100 %, B 25 %
  wd.tick()
  assert.deepEqual(signals(), [[4001, 'SIGSTOP']])
  assert.deepEqual(kills, [])
  clock.advance(60); wd.tick()
  assert.deepEqual(signals(), [[4001, 'SIGSTOP']], 'still stopped: no second SIGSTOP, no sample')
  clock.advance(18)                               // 78 ms after the stop
  assert.deepEqual(signals(), [[4001, 'SIGSTOP'], [4001, 'SIGCONT']])
  assert.deepEqual(wd.state()['i-a'].stopped, [])
  assert.equal(wd.state()['i-a'].cycles, 1)
  assert.equal(wd.state()['i-b'].cycles, 0)
  // the pre-stop sample stays the baseline: 1 jiffy over the 198 ms since it → 5 %, no stop
  clock.advance(120); procs[4001].jiffies = 13; wd.tick()
  assert.equal(wd.state()['i-a'].cpuPct.toFixed(3), (10 / 198).toFixed(3))
  clock.advance(120); procs[4001].jiffies = 14; wd.tick()
  assert.equal(signals().length, 2)
})

test('the duty cycle is bounded: a delayed tick still stops for at most 400 ms', () => {
  const procs = { 4001: { rssKb: 1000, jiffies: 0 } }
  const { wd, clock, signals } = mk({ workers: [A], procs })
  wd.tick()
  clock.advance(2000); procs[4001].jiffies = 200   // 100 % over a 2 s stall
  wd.tick()
  assert.deepEqual(signals(), [[4001, 'SIGSTOP']])
  clock.advance(STOP_MAX_MS - 1)
  assert.equal(signals().length, 1)
  clock.advance(1)
  assert.deepEqual(signals()[1], [4001, 'SIGCONT'])
})

test('a worker throttled 25+ times inside a minute gets ONE stable worker report per minute', () => {
  const procs = { 4001: { rssKb: 1000, jiffies: 0 } }
  const { wd, clock, reports } = mk({ workers: [A], procs })
  wd.tick()
  const burn = () => { clock.advance(120); procs[4001].jiffies += 12; wd.tick() }   // stop 78 ms, resumes inside the 120
  for (let i = 0; i < CPU_REPORT_CYCLES - 1; i++) burn()
  assert.equal(reports.length, 0)
  burn()
  assert.equal(reports.length, 1)
  assert.equal(reports[0].message, 'cpu throttled 25+ cycles/min (> 35 % of one core)')
  assert.match(reports[0].hint, /25 SIGSTOP cycles in the last minute at 100 %/)
  for (let i = 0; i < 100; i++) burn()
  assert.equal(reports.length, 1, 'the same minute reports once')
  assert.equal(wd.state()['i-a'].cycles, CPU_REPORT_CYCLES + 100)
})

test('disk ≥ 95 % → SIGSTOP the worker whose dataDir grew most (du as the worker uid), one per tick; SIGCONT below 90 %', () => {
  const statfs = { bytes: 100, free: 4 }
  const du = { '/work/.atelier/data/i-a': 1000, '/work/.atelier/data/i-b': 40000 }
  const { wd, reports, signals, state } = mk({ statfs, du })
  wd.duTick()
  du['/work/.atelier/data/i-a'] = 5000; du['/work/.atelier/data/i-b'] = 40100
  wd.duTick()
  assert.equal(wd.state()['i-a'].grewKb, 4000); assert.equal(wd.state()['i-b'].grewKb, 100)
  assert.equal(wd.state()['i-b'].duKb, 40100, 'B is bigger but A grew more')
  const duCalls = state.calls.filter((c) => c[0] === 'spawnSync' && c[2].argv[0] === 'du')
  assert.equal(duCalls.length, 4)
  assert.equal(duCalls[0][2].uid, 20001); assert.deepEqual(duCalls[0][2].groups, []); assert.equal(duCalls[0][2].cwd, '/')
  assert.deepEqual(duCalls[0][1].slice(0, 5), ['setpriv', '--reuid=20001', '--regid=20001', '--clear-groups', '--'])
  assert.deepEqual(duCalls[0][2].env, { PATH: '/usr/bin:/bin' })
  wd.diskTick()
  assert.deepEqual(signals(), [[4001, 'SIGSTOP']])
  assert.deepEqual(wd.state().disk, { usedPct: 96, stopped: ['i-a'] })
  assert.equal(reports.length, 1)
  assert.equal(reports[0].instance, 'i-a'); assert.equal(reports[0].rev, 3)
  assert.equal(reports[0].message, `disk ${DISK_STOP_PCT} % — worker stopped until < ${DISK_RESUME_PCT} %`)
  assert.match(reports[0].hint, /\/work is 96 % used; this dataDir grew 4M in the last du pass \(5M total\)/)
  wd.diskTick()
  assert.deepEqual(signals(), [[4001, 'SIGSTOP'], [4002, 'SIGSTOP']], 'still full: the next grower on the next tick')
  wd.diskTick()
  assert.equal(signals().length, 2, 'nothing left to stop')
  statfs.free = 8; wd.diskTick()                    // 92 %: neither stop nor resume
  assert.equal(signals().length, 2)
  statfs.free = 15; wd.diskTick()                   // 85 %
  assert.deepEqual(signals().slice(2), [[4001, 'SIGCONT'], [4002, 'SIGCONT']])
  assert.deepEqual(wd.state().disk.stopped, [])
})

test('disk trigger with no du sample yet runs one du pass inline; statfs null = no sample', () => {
  const { wd, signals } = mk({ statfs: { bytes: 100, free: 2 }, du: { '/work/.atelier/data/i-a': 10, '/work/.atelier/data/i-b': 500 } })
  wd.diskTick()
  assert.deepEqual(signals(), [[4002, 'SIGSTOP']], 'no growth known: the largest dataDir')
  const { wd: w2, signals: s2 } = mk({ statfs: undefined })
  w2.diskTick(); assert.deepEqual(s2(), [])
  assert.equal(w2.state().disk.usedPct, null)
})

test('/dev/shm per uid (find as the worker) ≥ 256 MB → SIGSTOP + report; SIGCONT below 128 MB; stops compose', () => {
  const shm = { 20001: [200_000, 70_000] }
  const { wd, reports, signals, state, clock } = mk({ workers: [A], shm, procs: { 4001: { rssKb: 1, jiffies: 0 } } })
  wd.duTick()
  assert.equal(wd.state()['i-a'].shmKb, 270_000)
  assert.ok(270_000 >= SHM_STOP_KB)
  assert.deepEqual(signals(), [[4001, 'SIGSTOP']])
  assert.equal(reports[0].message, 'shm 256M — worker stopped until < 128M')
  const find = state.calls.find((c) => c[0] === 'spawnSync' && c[2].argv[0] === 'find')
  assert.deepEqual(find[2].argv, ['find', '/dev/shm', '-uid', '20001', '-type', 'f', '-printf', '%k\n'])
  assert.equal(find[2].uid, 20001)
  // a CPU tick while shm-stopped does not touch it
  wd.tick(); clock.advance(120); wd.tick()
  assert.equal(signals().length, 1)
  shm[20001] = [1000]
  wd.duTick()
  assert.deepEqual(signals()[1], [4001, 'SIGCONT'])
  // compose: stopped for disk AND shm resumes only when both clear
  shm[20001] = [300_000]
  const statfs = { bytes: 100, free: 1 }
  const w = mk({ workers: [A], shm, statfs, du: { '/work/.atelier/data/i-a': 1 } })
  w.wd.duTick(); w.wd.diskTick()
  assert.deepEqual(w.signals(), [[4001, 'SIGSTOP']], 'one SIGSTOP for two reasons')
  assert.deepEqual(w.wd.state()['i-a'].stopped, ['shm', 'disk'])
  statfs.free = 50; w.wd.diskTick()
  assert.equal(w.signals().length, 1, 'still held by shm')
  shm[20001] = [10]; w.wd.duTick()
  assert.deepEqual(w.signals()[1], [4001, 'SIGCONT'])
})

test('start() schedules the three loops on the injected timers; stop() cancels them and resumes every stopped worker', () => {
  const procs = { 4001: { rssKb: 777, jiffies: 0 } }
  const { wd, clock, signals, state } = mk({ workers: [A], procs, statfs: { bytes: 100, free: 50 }, du: { '/work/.atelier/data/i-a': 5 } })
  wd.start(); wd.start()
  assert.equal(clock.pending(), 3)
  clock.advance(120)
  assert.equal(wd.state()['i-a'].rssKb, 777)
  clock.advance(5000)
  assert.equal(wd.state().disk.usedPct, 50)
  clock.advance(60_000)
  assert.equal(wd.state()['i-a'].duKb, 5)
  assert.equal(state.calls.filter((c) => c[0] === 'spawnSync' && c[2].argv[0] === 'du').length, 1)
  procs[4001].jiffies = 100_000; clock.advance(120)
  assert.deepEqual(signals().at(-1), [4001, 'SIGSTOP'])
  wd.stop()
  assert.deepEqual(signals().at(-1), [4001, 'SIGCONT'])
  assert.equal(clock.pending(), 0)
  clock.advance(120_000)
  assert.equal(clock.pending(), 0)
})

test('a worker that vanished or restarted (new pid) loses its state; workers() throwing is logged', () => {
  const procs = { 4001: { rssKb: 1, jiffies: 0 }, 4009: { rssKb: 2, jiffies: 0 } }
  const workers = [A]
  const { wd, clock, log } = mk({ workers, procs })
  wd.tick(); clock.advance(120); wd.tick()
  assert.equal(wd.state()['i-a'].pid, 4001)
  workers[0] = { ...A, pid: 4009 }
  wd.tick()
  assert.equal(wd.state()['i-a'].pid, 4009); assert.equal(wd.state()['i-a'].rssKb, 2)
  workers.length = 0
  wd.tick()
  assert.equal(wd.state()['i-a'], undefined)
  const w2 = createWatchdog({ os: memory({}), workers: () => { throw new Error('table locked') }, log, now: clock.now, timers: clock.timers })
  w2.tick()
  assert.ok(log.out.some((l) => l.includes('workers() threw table locked')))
})
