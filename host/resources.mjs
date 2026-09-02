// host/resources.mjs — the computer's own resource row for the heartbeat (API 50 `machine.resources`;
// DESIGN §4.4, §6.5, §7). The registrar sends it as `resources` in every beat body when it exists:
//
//   resources: { cpu: 0..1, ram: { used, total }, disk: { used, total } }     bytes; cpu = a fraction
//
// cpu = THIS container's usage over the interval between two samples, as a fraction of its quota.
// Everything is read from the container's cgroup v2 root and the /work volume — pure readers over an
// injectable `io` (`readFile(path) → text | null`, `statfs(path) → {total, free} | null`, `cpus() → n`):
//
//   /sys/fs/cgroup/cpu.stat        `usage_usec` — the delta between two samples over the wall ms between them
//   /sys/fs/cgroup/cpu.max         `<quota> <period>` → quota/period cores; `max <period>` → the node's core count
//   /sys/fs/cgroup/memory.current  bytes in use (what the kernel judges against memory.max)
//   /sys/fs/cgroup/memory.max      bytes; `max` → the node's MemTotal from /proc/meminfo
//   statfs(/work)                  total = blocks × bsize, used = total − bfree × bsize (df's "Used")
//
// A file missing or unreadable (macOS, a local run, a cgroup v1 node) → NO row (null), never zeros: the
// beat goes out without the field and the spine shows a dash. The FIRST sample only primes the cpu
// clock and is null too; every later one carries the delta since the previous sample — the beat interval
// (10 s), or the shorter gap when something (a chrome rebuild) beats early.
import fs from 'node:fs'
import os from 'node:os'

export const CGROUP = '/sys/fs/cgroup'
export const MEMINFO = '/proc/meminfo'

// The default io: plain reads, null on any failure — a caller never sees an exception from a missing file.
export const nodeIo = {
  readFile: (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } },
  statfs: (p) => { try { const s = fs.statfsSync(p); return { total: s.blocks * s.bsize, free: s.bfree * s.bsize } } catch { return null } },
  cpus: () => os.availableParallelism(),
}

const int = (s) => (typeof s === 'string' && /^\d+$/.test(s.trim()) ? Number(s.trim()) : null)

/** `usage_usec N` out of cpu.stat → N; null when the line is missing. */
export function parseCpuStat(text) {
  const m = typeof text === 'string' ? /^usage_usec (\d+)$/m.exec(text) : null
  return m ? Number(m[1]) : null
}
/** cpu.max `<quota> <period>` → quota/period cores; `max <period>` → cpus(); null when unreadable or zero. */
export function parseCpuMax(text, cpus) {
  const p = typeof text === 'string' ? text.trim().split(/\s+/) : []
  if (p[0] === 'max') { const n = Number(cpus?.()); return Number.isFinite(n) && n > 0 ? n : null }
  const quota = int(p[0] ?? ''), period = int(p[1] ?? '')
  return quota !== null && period !== null && quota > 0 && period > 0 ? quota / period : null
}
/** memory.current (and any one-number file) → bytes; null otherwise. */
export function parseBytes(text) { return int(text ?? '') }
/** `MemTotal: N kB` out of /proc/meminfo → bytes; null when the line is missing. */
export function parseMemTotal(text) {
  const m = typeof text === 'string' ? /^MemTotal:\s+(\d+) kB$/m.exec(text) : null
  return m ? Number(m[1]) * 1024 : null
}
/** memory.max → bytes; `max` → memTotal() (the node's MemTotal); null when unreadable. */
export function parseMemoryMax(text, memTotal) {
  if (typeof text === 'string' && text.trim() === 'max') { const n = memTotal?.(); return Number.isFinite(n) && n > 0 ? n : null }
  return parseBytes(text)
}

/**
 * createResourceMeter({ io, cgroup, meminfo, work, now }) → { sample }
 *   sample() → { cpu, ram: {used, total}, disk: {used, total} } | null — null until two cpu samples exist, and
 *   whenever any reader answers null (the field is then absent from the beat; nothing is invented).
 */
export function createResourceMeter({ io = nodeIo, cgroup = CGROUP, meminfo = MEMINFO, work = '/work', now = Date.now } = {}) {
  let prev = null   // { usage: usec, at: ms } of the previous sample; null until cpu.stat was read once
  function sample() {
    const usage = parseCpuStat(io.readFile(`${cgroup}/cpu.stat`))
    const at = now()
    const last = prev
    prev = usage === null ? null : { usage, at }
    if (usage === null || last === null) return null
    const cores = parseCpuMax(io.readFile(`${cgroup}/cpu.max`), io.cpus)
    const used = parseBytes(io.readFile(`${cgroup}/memory.current`))
    const total = parseMemoryMax(io.readFile(`${cgroup}/memory.max`), () => parseMemTotal(io.readFile(meminfo)))
    const disk = io.statfs(work)
    const dt = at - last.at
    if (cores === null || used === null || total === null || !disk || !(dt > 0)) return null
    const cpu = Math.min(1, Math.max(0, (usage - last.usage) / 1000 / dt / cores))   // usec → ms, over the quota's cores
    return { cpu: Math.round(cpu * 1000) / 1000, ram: { used, total }, disk: { used: disk.total - disk.free, total: disk.total } }
  }
  return { sample }
}
