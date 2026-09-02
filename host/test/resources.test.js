// host/resources.mjs — the heartbeat's `resources` row (API 50 `machine.resources`) from cgroup v2 fixtures,
// and the registrar's beat body carrying it only when it exists.
import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { memory } from '../adapters/os.mjs'
import { createRegistrar } from '../protocol/registrar.mjs'
import { memoryFsx } from './protocol-fixtures.mjs'
import { createResourceMeter, nodeIo, parseCpuStat, parseCpuMax, parseBytes, parseMemTotal, parseMemoryMax, CGROUP, MEMINFO } from '../resources.mjs'

// the fsn-01 system-host pod's files as read 2026-09-02 (cgroup2 nsdelegate; no cpu quota, a 2 GiB memory limit;
// /work = an emptyDir on a 1 TB md2 with 91517091840 bytes used per df)
const CPU_STAT = 'usage_usec 329478042\nuser_usec 230455968\nsystem_usec 99022073\nnice_usec 0\nnr_periods 0\nnr_throttled 0\nthrottled_usec 0\nnr_bursts 0\nburst_usec 0\n'
const MEMINFO_TEXT = 'MemTotal:       131818728 kB\nMemFree:        12345678 kB\nMemAvailable:   98765432 kB\n'
const MEM_TOTAL = 131818728 * 1024
const DISK = { total: 1005260181504, free: 913743089664 }
const cpuStat = (usec) => CPU_STAT.replace(/^usage_usec \d+/m, `usage_usec ${usec}`)

function fakeIo({ files = {}, statfs = DISK, cpus = 16 } = {}) {
  const io = {
    files: { [`${CGROUP}/cpu.stat`]: CPU_STAT, [`${CGROUP}/cpu.max`]: 'max 100000\n', [`${CGROUP}/memory.current`]: '205410304\n', [`${CGROUP}/memory.max`]: '2147483648\n', [MEMINFO]: MEMINFO_TEXT, ...files },
    readFile: (p) => io.files[p] ?? null,
    statfs: () => statfs,
    cpus: () => cpus,
  }
  return io
}

test('the readers: usage_usec, the cpu quota (a `max` line = the node\'s cores), bytes, MemTotal, memory.max (`max` = MemTotal); anything else is null', () => {
  assert.equal(parseCpuStat(CPU_STAT), 329478042)
  assert.equal(parseCpuStat('user_usec 1\n'), null); assert.equal(parseCpuStat('usage_usec x\n'), null); assert.equal(parseCpuStat(''), null); assert.equal(parseCpuStat(null), null)
  assert.equal(parseCpuMax('max 100000\n', () => 16), 16)
  assert.equal(parseCpuMax('200000 100000\n'), 2); assert.equal(parseCpuMax('50000 100000'), 0.5)
  assert.equal(parseCpuMax('max 100000', () => 0), null); assert.equal(parseCpuMax('max 100000', undefined), null)
  assert.equal(parseCpuMax('0 100000'), null); assert.equal(parseCpuMax('100000 0'), null); assert.equal(parseCpuMax('junk'), null); assert.equal(parseCpuMax(null), null)
  assert.equal(parseBytes('205410304\n'), 205410304); assert.equal(parseBytes('max'), null); assert.equal(parseBytes(''), null); assert.equal(parseBytes(null), null)
  assert.equal(parseMemTotal(MEMINFO_TEXT), MEM_TOTAL); assert.equal(parseMemTotal('MemFree: 1 kB\n'), null); assert.equal(parseMemTotal(null), null)
  assert.equal(parseMemoryMax('2147483648\n'), 2147483648)
  assert.equal(parseMemoryMax('max\n', () => MEM_TOTAL), MEM_TOTAL)
  assert.equal(parseMemoryMax('max', () => null), null); assert.equal(parseMemoryMax('max', undefined), null); assert.equal(parseMemoryMax(null, () => MEM_TOTAL), null)
})

test('the delta over two beats: the first sample primes the cpu clock (null); the second carries usage_usec delta / interval / cores, clamped to 0..1; ram and disk in bytes', () => {
  let t = 1_000_000
  const io = fakeIo({ files: { [`${CGROUP}/cpu.max`]: '200000 100000\n' } })   // 2 cores
  const m = createResourceMeter({ io, now: () => t })
  assert.equal(m.sample(), null, 'the first sample has no interval')
  t += 10_000; io.files[`${CGROUP}/cpu.stat`] = cpuStat(329478042 + 4_000_000)   // 4 s of cpu over 10 s on 2 cores
  assert.deepEqual(m.sample(), { cpu: 0.2, ram: { used: 205410304, total: 2147483648 }, disk: { used: 91517091840, total: 1005260181504 } })
  t += 10_000; io.files[`${CGROUP}/cpu.stat`] = cpuStat(329478042 + 4_000_000 + 30_000_000)   // 30 s of cpu over 10 s: over the quota → 1
  assert.equal(m.sample().cpu, 1)
  t += 10_000                                                                    // no usage at all → 0
  assert.equal(m.sample().cpu, 0)
  t += 7   // the odd early beat (a chrome rebuild): the delta is over THAT gap
  io.files[`${CGROUP}/cpu.stat`] = cpuStat(329478042 + 4_000_000 + 30_000_000 + 7_000)   // 7 ms of cpu over 7 ms on 2 cores → 0.5
  assert.equal(m.sample().cpu, 0.5)
  io.files[`${CGROUP}/memory.current`] = '1073741824\n'
  t += 10_000
  assert.deepEqual(m.sample().ram, { used: 1073741824, total: 2147483648 }, 'ram follows memory.current')
})

test('`max` on both files: cpu over the node\'s core count, ram total = /proc/meminfo MemTotal', () => {
  let t = 1_000_000
  const io = fakeIo({ files: { [`${CGROUP}/memory.max`]: 'max\n' }, cpus: 16 })   // cpu.max is `max 100000` by default
  const m = createResourceMeter({ io, now: () => t })
  m.sample()
  t += 10_000; io.files[`${CGROUP}/cpu.stat`] = cpuStat(329478042 + 4_000_000)   // 4 s over 10 s on 16 cores
  assert.deepEqual(m.sample(), { cpu: 0.025, ram: { used: 205410304, total: MEM_TOTAL }, disk: { used: 91517091840, total: 1005260181504 } })
})

test('a missing or unreadable file sends nothing: null, never a row of zeros — and cpu.stat gone re-primes the clock', () => {
  let t = 1_000_000
  const two = (io) => { const m = createResourceMeter({ io, now: () => { t += 10_000; return t } }); return [m.sample(), m.sample(), m.sample()] }
  const none = Object.fromEntries([`${CGROUP}/cpu.stat`, `${CGROUP}/cpu.max`, `${CGROUP}/memory.current`, `${CGROUP}/memory.max`, MEMINFO].map((p) => [p, null]))
  assert.deepEqual(two(fakeIo({ files: none, statfs: null })), [null, null, null], 'a laptop: no cgroup, no /work')
  assert.deepEqual(two(fakeIo({ files: { [`${CGROUP}/cpu.stat`]: null } })), [null, null, null], 'no cpu.stat')
  assert.deepEqual(two(fakeIo({ files: { [`${CGROUP}/cpu.max`]: null } })), [null, null, null], 'no cpu.max')
  assert.deepEqual(two(fakeIo({ files: { [`${CGROUP}/memory.current`]: null } })), [null, null, null], 'no memory.current')
  assert.deepEqual(two(fakeIo({ files: { [`${CGROUP}/memory.max`]: null } })), [null, null, null], 'no memory.max')
  assert.deepEqual(two(fakeIo({ files: { [`${CGROUP}/memory.max`]: 'max\n', [MEMINFO]: null } })), [null, null, null], 'memory.max = max and no /proc/meminfo')
  assert.deepEqual(two(fakeIo({ files: { [`${CGROUP}/cpu.max`]: 'max 100000\n' }, cpus: 0 })), [null, null, null], 'cpu.max = max and no core count')
  assert.deepEqual(two(fakeIo({ statfs: null })), [null, null, null], 'no /work')
  // cpu.stat vanishes for one sample: the clock is re-primed, the delta never spans the gap
  const io = fakeIo()
  const m = createResourceMeter({ io, now: () => t })
  m.sample(); t += 10_000
  assert.ok(m.sample(), 'a row')
  io.files[`${CGROUP}/cpu.stat`] = null; t += 10_000
  assert.equal(m.sample(), null, 'gone')
  io.files[`${CGROUP}/cpu.stat`] = cpuStat(329478042 + 160_000_000); t += 10_000
  assert.equal(m.sample(), null, 'back: primes again')
  t += 10_000; io.files[`${CGROUP}/cpu.stat`] = cpuStat(329478042 + 160_000_000 + 16_000_000)
  assert.equal(m.sample().cpu, 0.1, 'the delta is over the last interval only')
  // two samples in the same millisecond: no interval, no row
  const same = createResourceMeter({ io: fakeIo(), now: () => 5 })
  assert.equal(same.sample(), null); assert.equal(same.sample(), null)
})

test('the default io: a missing file is null (no throw), statfs answers {total, free} in bytes, cpus ≥ 1; without cgroup files the meter is silent', () => {
  assert.equal(nodeIo.readFile('/nonexistent/atelier/cpu.stat'), null)
  assert.equal(nodeIo.statfs('/nonexistent/atelier'), null)
  const s = nodeIo.statfs(tmpdir())
  assert.ok(Number.isInteger(s.total) && s.total > 0 && Number.isInteger(s.free) && s.free <= s.total, `statfs ${JSON.stringify(s)}`)
  assert.ok(nodeIo.cpus() >= 1)
  const m = createResourceMeter({ work: tmpdir() })
  assert.equal(m.sample(), null, 'the first sample never has a row')
  const second = m.sample()
  if (nodeIo.readFile(`${CGROUP}/cpu.stat`) === null) assert.equal(second, null, 'no cgroup v2 here (macOS): nothing')
  else if (second !== null) assert.deepEqual(Object.keys(second), ['cpu', 'ram', 'disk'])
})

test('the beat body carries `resources` only when the reader answers a row: null and a throw send the beat without the field; through the meter the first beat has none and the second has it', async () => {
  const os = memory({}); const dirfd = os.openDir('/work/.atelier')
  const calls = []
  const transport = { setToken() {}, async register() { return { host_id: 'c1', epoch: 'e1', token: 't', company: 'acme', apps: [] } }, async heartbeat(b) { calls.push(b); return { ok: true, config: [] } } }
  const base = { visible_apps: 0, last_served_at: null, pod_ip: '10.0.0.7', chrome_digest: null }
  const row = { cpu: 0.2, ram: { used: 205410304, total: 2147483648 }, disk: { used: 91517091840, total: 1005260181504 } }
  let answer = row
  const registrar = createRegistrar({ os, dirfd, transport, cfg: { podIp: '10.0.0.7' }, log: () => {}, fsx: memoryFsx(), backoffMs: [5, 5], resources: () => answer })
  await registrar.register()
  assert.deepEqual(await registrar.beat(), { ok: true, config: [] })
  assert.deepEqual(calls.at(-1), { ...base, resources: row })
  answer = null
  await registrar.beat()
  assert.deepEqual(calls.at(-1), base, 'null → no field')
  assert.equal('resources' in calls.at(-1), false)
  answer = undefined
  await registrar.beat()
  assert.deepEqual(calls.at(-1), base, 'undefined → no field')
  const throwing = createRegistrar({ os, dirfd, transport, cfg: { podIp: '10.0.0.7' }, log: () => {}, fsx: memoryFsx(), backoffMs: [5, 5], resources: () => { throw new Error('boom') } })
  await throwing.register()
  assert.deepEqual(await throwing.beat(), { ok: true, config: [] }, 'the beat still goes out')
  assert.deepEqual(calls.at(-1), base)
  const plain = createRegistrar({ os, dirfd, transport, cfg: { podIp: '10.0.0.7' }, log: () => {}, fsx: memoryFsx(), backoffMs: [5, 5] })
  await plain.register(); await plain.beat()
  assert.deepEqual(calls.at(-1), base, 'no reader wired: the body as before')
  // the meter as index.mjs wires it (`resources: meter.sample`)
  let t = 1_000_000
  const io = fakeIo({ files: { [`${CGROUP}/cpu.max`]: '200000 100000\n' } })
  const meter = createResourceMeter({ io, now: () => t })
  const wired = createRegistrar({ os, dirfd, transport, cfg: { podIp: '10.0.0.7' }, log: () => {}, fsx: memoryFsx(), backoffMs: [5, 5], resources: meter.sample })
  await wired.register()
  await wired.beat()
  assert.equal('resources' in calls.at(-1), false, 'the first beat primes')
  t += 10_000; io.files[`${CGROUP}/cpu.stat`] = cpuStat(329478042 + 4_000_000)
  await wired.beat()
  assert.deepEqual(calls.at(-1).resources, row, 'the second beat carries the row')
})
