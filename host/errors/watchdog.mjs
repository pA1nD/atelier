// host/errors/watchdog.mjs — the per-worker RSS / CPU / disk watchdogs (PLAN §4.3 Workers, R2,
// P13; DESIGN §6.3). Everything reads /proc and signals through the adapter (`os.rssKb`,
// `os.cpuJiffies`, `os.statfs`, `os.spawnSync` for du/find, `os.kill`), so the decisions run on
// the laptop against `memory()` and the Linux drill proves the real thing (§8.2 row 7).
//
//   RSS   every TICK_MS: VmRSS > rssCapKb(data) (= data − 640 MB, min 256 MB) → kill(instance,
//         'rss 412 MB > 384 MB') (the supervisor SIGKILLs, marks failed, restarts with backoff) +
//         one `worker` report. The rlimit is the wall (an in-worker RangeError); this is the
//         earlier, softer line [S:g6: 2 GB alloc SIGKILLed at 355–392 MB].
//   CPU   every TICK_MS: jiffies delta over the real elapsed time > CPU_BUDGET of one core →
//         SIGSTOP for min(STOP_MAX_MS, elapsed·(1 − budget/pct)) ms, then SIGCONT. A throttle,
//         never a kill; peers stay < 200 ms [S:g6: 80 cycles, peer max 3 ms]. A worker throttled
//         ≥ CPU_REPORT_CYCLES times inside CPU_REPORT_WINDOW_MS gets one `worker` report per
//         window (stable message → one fingerprint; the numbers ride in the hint).
//   disk  every DISK_MS: statfs of dataRoot (= the /work volume; 1 ms [S:data-storage-4]);
//         ≥ DISK_STOP_PCT used → SIGSTOP the running worker whose dataDir grew most since the last
//         du pass (one per disk tick) + report; every disk-stopped worker gets SIGCONT below
//         DISK_RESUME_PCT. Attribution = `du -s -k <dataDir>` every DU_MS, run AS THE WORKER UID
//         (the dir is `<uid>:19999 2770`; root without DAC_READ_SEARCH cannot enter it) —
//         31 ms per 26 k files warm [S:data-storage-4]. What the host cannot tell: a torn save at
//         ENOSPC, the agent's own transcript writes failing, and which non-worker filled the
//         volume (the agent's tree is not sampled) — README.
//   shm   in the du pass: `find /dev/shm -uid <uid> -type f -printf %k` (as the worker) ≥
//         SHM_STOP_KB → SIGSTOP + report; SIGCONT below SHM_RESUME_KB. /dev/shm is one shared
//         1 GiB tmpfs the host can neither chmod nor split (R6); the numbers are defaults, not
//         measured.
// A worker stopped for several reasons resumes when the last one clears; stop() (teardown)
// resumes everything so SIGTERM can reach the module's teardown.
import { rssCapKb, RLIMIT_DATA_DEFAULT, fmtMb } from './limits.mjs'
import { say } from './collector.mjs'
import { createMetrics } from '../metrics.mjs'

export const TICK_MS = 120
export const HZ = 100                       // USER_HZ: /proc/<pid>/stat utime+stime are in 1/100 s
export const CPU_BUDGET = 0.35
export const STOP_MAX_MS = 400
export const CPU_REPORT_CYCLES = 25
export const CPU_REPORT_WINDOW_MS = 60_000
export const DISK_MS = 5000
export const DU_MS = 60_000
export const DISK_STOP_PCT = 95
export const DISK_RESUME_PCT = 90
export const SHM_STOP_KB = 256 * 1024
export const SHM_RESUME_KB = 128 * 1024
export const AGENT_DATA_GID = 19999          // hygiene.mjs AGENT_DATA_GID (launcher lane); the dataDir group

export const cpuPct = (dJiffies, dtMs, hz = HZ) => (dtMs > 0 ? (dJiffies * (1000 / hz)) / dtMs : 0)
export const stopMsFor = (pct, elapsedMs, budget = CPU_BUDGET) => Math.min(STOP_MAX_MS, Math.max(1, Math.round(elapsedMs * (1 - budget / pct))))
export const usedPct = (st) => (st && st.bytes > 0 ? Math.round(100 * (1 - st.free / st.bytes)) : null)
export const parseKb = (stdout) => { const m = String(stdout ?? '').match(/^\s*(\d+)/); return m ? Number(m[1]) : null }
export const sumKb = (stdout) => String(stdout ?? '').split('\n').reduce((n, l) => n + (Number(l.trim()) || 0), 0)

/**
 * createWatchdog({ os, workers, report, kill, dataRoot, now, timers, log, tickMs, diskMs, duMs, path })
 *   workers() → [{instance, slug, pid, uid, dataDir, sock, rev, rlimits?}]   (the supervisor's table; slug labels the metrics row, rev + rlimits.data read when present)
 *   .start() / .stop()        schedule / cancel the three loops (stop resumes every stopped worker)
 *   .tick()                   one RSS + CPU sample over every worker
 *   .diskTick()               one statfs sample + the stop/resume decision
 *   .duTick()                 one du + shm pass (as each worker's uid)
 *   .state()                  per-instance {rssKb, cpuPct, cycles, stopped:[reasons], duKb, grewKb, shmKb} + {disk:{usedPct, stopped:[instances]}}
 */
export function createWatchdog({ os, workers, report, kill, dataRoot, now, timers = { setTimeout, clearTimeout }, log, tickMs = TICK_MS, diskMs = DISK_MS, duMs = DU_MS, path = '/usr/bin:/bin', metrics = createMetrics() } = {}) {
  const clock = now ?? os.now
  const st = new Map()        // instance → per-worker state
  let handles = []
  let running = false
  let diskUsed = null

  const rows = () => { try { return workers() ?? [] } catch (e) { say(log, `watchdog: workers() threw ${e?.message ?? e}`); return [] } }
  const signal = (w, sig) => { try { os.kill(w.pid, sig); return true } catch (e) { say(log, `watchdog: ${sig} ${w.instance} pid ${w.pid}: ${e?.code ?? e?.message ?? e}`); return false } }
  const tell = (w, detail) => { try { report?.('worker', w.instance, Number.isInteger(w.rev) ? w.rev : 0, detail) } catch (e) { say(log, `watchdog: report threw ${e?.message ?? e}`) } }
  // §4.5 counters: one trip per RSS kill, per CPU throttle cycle, per disk stop, per shm stop
  const trip = (w, kind) => { try { metrics.watchdogTrip(w.slug ?? w.instance, kind) } catch {} }

  function stateOf(w) {
    let s = st.get(w.instance)
    if (!s || s.pid !== w.pid) { s = { pid: w.pid, j: null, at: null, rssKb: null, cpuPct: 0, cycles: 0, cycleTimes: [], lastCpuReport: null, stopped: new Set(), contTimer: null, duKb: null, grewKb: 0, shmKb: 0 }; st.set(w.instance, s) }
    return s
  }
  function prune(live) {
    for (const [inst, s] of st) if (!live.has(inst)) { if (s.contTimer !== null) timers.clearTimeout(s.contTimer); st.delete(inst) }
  }
  function stop(w, s, reason) {
    const first = s.stopped.size === 0
    s.stopped.add(reason)
    if (first) signal(w, 'SIGSTOP')
  }
  function resume(w, s, reason) {
    if (!s.stopped.delete(reason)) return
    if (s.stopped.size === 0) signal(w, 'SIGCONT')      // the pre-stop sample stays the baseline: the stopped time counts against the worker
  }

  function tick() {
    const live = new Set()
    const t = clock()
    for (const w of rows()) {
      live.add(w.instance)
      const s = stateOf(w)
      // --- RSS ---
      const rss = os.rssKb(w.pid)
      if (rss !== null && rss !== undefined) {
        s.rssKb = rss
        const cap = rssCapKb(w.rlimits?.data ?? RLIMIT_DATA_DEFAULT)
        if (rss > cap) {
          const why = `rss ${fmtMb(rss * 1024)} > ${fmtMb(cap * 1024)}`
          if (s.contTimer !== null) { timers.clearTimeout(s.contTimer); s.contTimer = null }
          st.delete(w.instance)
          trip(w, 'rss')
          try { kill?.(w.instance, why) } catch (e) { say(log, `watchdog: kill threw ${e?.message ?? e}`) }
          tell(w, { message: why, hint: `the worker's resident memory passed the cap (RLIMIT_DATA ${fmtMb(w.rlimits?.data ?? RLIMIT_DATA_DEFAULT)} − 640 MB); look for an unbounded cache or a leak, then save — the host restarts the worker with backoff` })
          continue
        }
      }
      // --- CPU ---
      if (s.stopped.size) continue
      const j = os.cpuJiffies(w.pid)
      if (j === null || j === undefined) continue
      if (s.j !== null && s.at !== null && t > s.at) {
        const pct = cpuPct(j - s.j, t - s.at)
        s.cpuPct = pct
        if (pct > CPU_BUDGET) {
          const ms = stopMsFor(pct, t - s.at)
          s.cycles++; s.cycleTimes.push(t)
          trip(w, 'cpu')
          stop(w, s, 'cpu')
          s.contTimer = timers.setTimeout(() => { s.contTimer = null; resume(w, s, 'cpu') }, ms)
          s.cycleTimes = s.cycleTimes.filter((x) => x > t - CPU_REPORT_WINDOW_MS)
          if (s.cycleTimes.length >= CPU_REPORT_CYCLES && (s.lastCpuReport === null || t - s.lastCpuReport >= CPU_REPORT_WINDOW_MS)) {
            s.lastCpuReport = t
            tell(w, { message: `cpu throttled ${CPU_REPORT_CYCLES}+ cycles/min (> ${Math.round(CPU_BUDGET * 100)} % of one core)`, hint: `${s.cycleTimes.length} SIGSTOP cycles in the last minute at ${Math.round(pct * 100)} % of a core; the worker keeps running throttled — look for a busy loop or a hot setInterval, then save` })
          }
        }
      }
      s.j = j; s.at = t
    }
    prune(live)
  }

  function duTick() {
    const live = new Set()
    for (const w of rows()) {
      live.add(w.instance)
      const s = stateOf(w)
      if (typeof w.dataDir === 'string') {
        const r = os.spawnSync({ argv: ['du', '-s', '-k', w.dataDir], env: { PATH: path }, cwd: '/', uid: w.uid, gid: w.uid, groups: [], stdio: ['ignore', 'pipe', 'ignore'] })
        const kb = parseKb(r?.stdout)
        if (kb !== null) { s.grewKb = s.duKb === null ? kb : Math.max(0, kb - s.duKb); s.duKb = kb }
      }
      if (Number.isInteger(w.uid)) {
        const r = os.spawnSync({ argv: ['find', '/dev/shm', '-uid', String(w.uid), '-type', 'f', '-printf', '%k\n'], env: { PATH: path }, cwd: '/', uid: w.uid, gid: w.uid, groups: [], stdio: ['ignore', 'pipe', 'ignore'] })
        s.shmKb = r?.status === 0 ? sumKb(r.stdout) : 0
        if (s.shmKb >= SHM_STOP_KB && !s.stopped.has('shm')) {
          trip(w, 'shm')
          stop(w, s, 'shm')
          tell(w, { message: `shm ${fmtMb(SHM_STOP_KB * 1024)} — worker stopped until < ${fmtMb(SHM_RESUME_KB * 1024)}`, hint: `/dev/shm holds ${fmtMb(s.shmKb * 1024)} of this worker's files; /dev/shm is shared by the whole computer — delete them (or use TMPDIR on the volume) and the worker resumes on its own` })
        } else if (s.shmKb < SHM_RESUME_KB && s.stopped.has('shm')) {
          resume(w, s, 'shm')
          say(log, `watchdog: ${w.instance} resumed — shm ${fmtMb(s.shmKb * 1024)}`)
        }
      }
    }
    prune(live)
  }

  function diskTick() {
    const fs = os.statfs(dataRoot)
    const pct = usedPct(fs)
    if (pct === null) return
    diskUsed = pct
    const list = rows()
    if (pct >= DISK_STOP_PCT) {
      const candidates = list.filter((w) => !stateOf(w).stopped.has('disk'))
      if (!candidates.length) return
      if (candidates.every((w) => stateOf(w).duKb === null)) duTick()
      const w = candidates.map((w) => ({ w, s: stateOf(w) })).sort((a, b) => (b.s.grewKb - a.s.grewKb) || ((b.s.duKb ?? 0) - (a.s.duKb ?? 0)))[0]
      trip(w.w, 'disk')
      stop(w.w, w.s, 'disk')
      tell(w.w, { message: `disk ${DISK_STOP_PCT} % — worker stopped until < ${DISK_RESUME_PCT} %`, hint: `/work is ${pct} % used; this dataDir grew ${fmtMb(w.s.grewKb * 1024)} in the last du pass (${fmtMb((w.s.duKb ?? 0) * 1024)} total) — free space (delete data, or the operator grows the volume) and the worker resumes on its own below ${DISK_RESUME_PCT} %` })
    } else if (pct < DISK_RESUME_PCT) {
      for (const w of list) { const s = st.get(w.instance); if (s?.stopped.has('disk')) { resume(w, s, 'disk'); say(log, `watchdog: ${w.instance} resumed — disk ${pct} %`) } }
    }
  }

  function loop(fn, ms) {
    const h = { id: null }
    const run = () => { h.id = null; if (!running) return; try { fn() } catch (e) { say(log, `watchdog: ${fn.name} threw ${e?.message ?? e}`) } if (running) h.id = timers.setTimeout(run, ms) }
    h.id = timers.setTimeout(run, ms)
    handles.push(h)
  }

  return {
    start() { if (running) return; running = true; loop(tick, tickMs); loop(diskTick, diskMs); loop(duTick, duMs) },
    stop() {
      running = false
      for (const h of handles) if (h.id !== null) timers.clearTimeout(h.id)
      handles = []
      const byInst = new Map(rows().map((w) => [w.instance, w]))
      for (const [inst, s] of st) {
        if (s.contTimer !== null) { timers.clearTimeout(s.contTimer); s.contTimer = null }
        if (s.stopped.size && byInst.get(inst)) { s.stopped.clear(); signal(byInst.get(inst), 'SIGCONT') }
      }
    },
    tick, diskTick, duTick,
    state() {
      const out = { disk: { usedPct: diskUsed, stopped: [...st].filter(([, s]) => s.stopped.has('disk')).map(([i]) => i) } }
      for (const [inst, s] of st) out[inst] = { pid: s.pid, rssKb: s.rssKb, cpuPct: s.cpuPct, cycles: s.cycles, stopped: [...s.stopped], duKb: s.duKb, grewKb: s.grewKb, shmKb: s.shmKb }
      return out
    },
  }
}
