// doctor/probe/run.mjs — lane B: the runtime probe through the REAL host worker (doctor/DESIGN.md §4).
//
// Per module: bundleBackend (host/supervisor/bundle.mjs) → <out>/doctor/<id>/probe/rev-1/backend.js;
// a WorkerSpec exactly as the host builds one (row W env, HOST/PORT/BASE_URL published from the spec,
// configEnv {} so every default surfaces); spawnWorker({os: unprivileged(), runtime: entry.mjs}) —
// the real spawn plan and the real runtime.mjs with hooks.mjs installed first; after READY wait
// `settleMs` (post-mount timers and beacons fire), then handle.stop(drainMs) → SIGTERM → the module's
// teardown → exit, or the pgroup SIGKILL at the deadline (killed:true). Every observation the hooks
// stream on fd 3 is collected into one report. Bounded per module: bundle + readyMs + settleMs + drainMs
// (+ ≤ 1 s for the control lane to close) — 7 + 0.5 + 2 = 9.5 s with the defaults.
//
// The probe never writes into the module folder: the bundle, dataDir, tmpDir, scratch and worker.log live
// under <out>/doctor/<id>/probe/; the socket under /tmp/atelier-doctor/<instance>/ (macOS caps a socket
// path at 104 bytes) and is removed afterwards. Not a security jail (no uid drop on a laptop — the EACCES
// for writes outside dataDir is hooks.mjs's emulation, `jail: 'hook-emulated'`), not a network test.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { unprivileged } from '../../host/adapters/os.mjs'
import { spawnWorker, MB } from '../../host/worker/spawn.mjs'
import { bundleBackend, sourceMapLookup } from '../../host/supervisor/bundle.mjs'
import { KINDS, LISTS } from './common.mjs'

export const ENTRY = fileURLToPath(new URL('./entry.mjs', import.meta.url))
export const SOCK_ROOT = '/tmp/atelier-doctor'
export const COMPANY = 'doctor'
export const ORIGIN = 'https://doctor.portal.pa1nd.de'
export const DEFAULTS = Object.freeze({ readyMs: 7000, settleMs: 500, drainMs: 2000, closeMs: 1000, jobs: 8 })
export const SAMPLE_CAP = 12
/** probe states (DESIGN §5 `dynamic_state`). */
export const STATES = ['mounted', 'no-backend', 'bundle-error', 'load-error', 'mount-throw', 'died', 'timeout', 'spawn-eagain']

export const instanceOf = (id) => 'i-' + createHash('sha256').update(String(id)).digest('hex').slice(0, 16)

/** The WorkerSpec the probe hands to spawnWorker — the host's shape, the probe's paths. */
export function probeSpec({ id, dir, out, name = id }) {
  const probeDir = path.join(out, 'doctor', id, 'probe')
  const instance = instanceOf(id)
  const sockDir = path.join(SOCK_ROOT, instance)
  return {
    instance, slug: id, name, company: COMPANY, uid: process.getuid(), rev: 1,
    codeDir: path.join(probeDir, 'rev-1'), appDir: dir,
    dataDir: path.join(probeDir, 'data'), tmpDir: path.join(probeDir, 'tmp'), scratchDir: path.join(probeDir, 'scratch'),
    sockDir, sock: path.join(sockDir, 'w.sock'),
    baseUrl: `${ORIGIN}/api/${COMPANY}/${id}`, origin: ORIGIN,
    configEnv: {}, rlimits: { data: 1024 * MB, core: 0, nproc: 64, nofile: 1024 },
  }
}

const stateOf = (e) => ({ 'no-ready': 'timeout', 'spawn-eagain': 'spawn-eagain' })[e.error]
  ?? ({ 'MOUNT-ERROR': 'mount-throw', 'RUNTIME-DEAD': 'died', 'LOAD-ERROR': 'load-error', 'ERR_MODULE_NOT_FOUND': 'load-error' })[e.code]
  ?? 'load-error'
const whereOf = (e) => ({ 'no-ready': 'ready-wait', 'spawn-eagain': 'spawn' })[e.error]
  ?? ({ 'MOUNT-ERROR': 'mount', 'RUNTIME-DEAD': 'process', 'ERR_MODULE_NOT_FOUND': 'import' })[e.code]
  ?? 'import'

/**
 * probeModule({id, dir, out, name, os, readyMs, settleMs, drainMs, closeMs, log}) → the `runtime` block of
 * report.json (DESIGN §4): {module, dir, state, mounted, died, importMs, mountMs, resources, teardown, stop,
 * exitedEarly, rss, jail, hooks:{counts, skipped}, envReads, listens, spawns, writesOutside, selfData,
 * egress, ctxModule, signalHandlers, processExit, control, asyncErrors, stderrTail, ms}.
 */
export async function probeModule({ id, dir, out, name = id, os = unprivileged(), readyMs = DEFAULTS.readyMs, settleMs = DEFAULTS.settleMs, drainMs = DEFAULTS.drainMs, closeMs = DEFAULTS.closeMs, log = () => {} }) {
  const t0 = Date.now()
  const spec = probeSpec({ id, dir, out, name })
  const probeDir = path.dirname(spec.dataDir)
  const report = {
    module: id, dir, state: null, mounted: false, died: null,
    importMs: null, mountMs: null, resources: null, teardown: null, stop: null, exitedEarly: null, rss: null,
    jail: 'hook-emulated', hooks: { counts: Object.fromEntries(KINDS.map((k) => [k, 0])), skipped: { runtime: 0, node: 0 } },
    envReads: [], envSpread: 0, listens: [], spawns: [], writesOutside: [], selfData: [], egress: [], ctxModule: [], signalHandlers: [], processExit: [],
    control: { error: 0, http5xx: 0, broadcast: 0, suspendable: 0 }, asyncErrors: [], stderrTail: [], ms: 0,
    budgetMs: readyMs + settleMs + drainMs + closeMs,
  }
  const finish = () => { report.ms = Date.now() - t0; return report }

  // 1. the bundle — the worker imports it, never the folder (as in production)
  for (const d of [spec.codeDir, spec.dataDir, spec.tmpDir, path.join(spec.scratchDir, 'home')]) fs.mkdirSync(d, { recursive: true })
  let bundle
  try { bundle = await bundleBackend({ appDir: dir }) } catch (e) {
    const p = e?.problems?.[0] ?? { file: 'backend.js', line: 1, col: 1, message: e?.message ?? String(e) }
    report.state = 'bundle-error'
    report.died = { where: 'bundle', code: 'BUNDLE-ERROR', error: { message: p.message, file: p.file, line: p.line, col: p.col, hint: p.hint } }
    return finish()
  }
  if (!bundle) { report.state = 'no-backend'; return finish() }
  const bundlePath = path.join(spec.codeDir, 'backend.js')
  fs.writeFileSync(bundlePath, bundle.code)
  fs.writeFileSync(bundlePath + '.map', bundle.map)
  const lookup = sourceMapLookup(JSON.parse(bundle.map))
  const bundleReal = (() => { try { return fs.realpathSync(bundlePath) } catch { return bundlePath } })()
  // a bundle position → the source file:line:col (the map's sources are app-relative)
  const mapLoc = (file, line, col) => {
    if (!file || !line) return { file, line, col }
    let f = file
    if (f.startsWith('file://')) { try { f = fileURLToPath(f) } catch {} }
    if (f !== bundlePath && f !== bundleReal) return { file: f, line, col }
    const m = lookup(line, col ?? 1)
    return m ? { file: m.file, line: m.line, col: m.col } : { file: 'backend.js', line, col }
  }
  const mapFrame = (frame) => {
    if (!frame) return frame
    const m = /^(.*):(\d+):(\d+)$/.exec(frame)
    if (!m) return frame
    const l = mapLoc(m[1], Number(m[2]), Number(m[3]))
    return `${l.file}:${l.line}:${l.col}`
  }

  // 2. the worker — the real spawn plan, the real runtime behind the hook entry
  fs.mkdirSync(spec.sockDir, { recursive: true })
  const logFile = fs.openSync(path.join(probeDir, 'worker.log'), 'w')
  let childClosed = null      // the child's stdio 'close' is where the last control lines (the exit summary) arrive
  const osw = { ...os, spawn: (plan) => { const c = os.spawn(plan); childClosed = new Promise((r) => c.once('close', r)); return c } }
  const closed = () => Promise.race([childClosed ?? Promise.resolve(), new Promise((r) => setTimeout(r, closeMs).unref())])
  let summary = null
  const onControl = (m) => {
    if (m.t !== 'doctor') {
      if (m.t in report.control) report.control[m.t]++
      if (m.t === 'error' && report.asyncErrors.length < 3) report.asyncErrors.push({ message: m.message, ...mapLoc(m.file, m.line, m.col) })
      return
    }
    if (m.kind === 'summary') { summary = m; return }
    if (m.kind === 'stats') { report.rss = m.rss; return }
    const { t, kind, by, frame, ...fields } = m
    const list = report[LISTS[kind]]
    if (list && list.length < SAMPLE_CAP) list.push({ ...fields, frame: mapFrame(frame) })
  }
  const onLog = (stream, line) => {
    try { fs.writeSync(logFile, `[${stream}] ${line}\n`) } catch {}
    if (stream === 'stderr') { report.stderrTail.push(line.slice(0, 300)); if (report.stderrTail.length > 10) report.stderrTail.shift() }
  }
  let stopping = false
  const onExit = (code, signal) => { if (!stopping) report.exitedEarly = { code, signal } }
  const hostEnv = { PATH: process.env.PATH, NODE_ENV: 'production' }
  try {
    let handle
    try {
      handle = await spawnWorker({ os: osw, spec, runtime: ENTRY, lockSocket: false, hostEnv, readyTimeoutMs: readyMs, onControl, onLog, onExit, log })
    } catch (e) {
      report.state = stateOf(e)
      const d = e.detail ?? {}
      report.died = { where: whereOf(e), code: e.code ?? e.error, error: { message: d.message ?? e.msg ?? e.message, ...mapLoc(d.file, d.line, d.col) } }
      await closed()
      return finish()
    }
    report.state = 'mounted'
    report.mounted = true
    report.importMs = handle.ready.importMs
    report.mountMs = handle.ready.mountMs
    report.resources = handle.ready.resources
    report.teardown = handle.ready.teardown
    await new Promise((r) => setTimeout(r, settleMs))
    stopping = true
    report.stop = await handle.stop(drainMs)
    await closed()
    return finish()
  } finally {
    if (summary) {
      report.hooks.counts = summary.counts
      report.hooks.skipped = summary.skipped
      report.envReads = Object.entries(summary.envReads).map(([key, n]) => ({ key, n, frame: report.envReads.find((r) => r.key === key)?.frame ?? null }))
      report.envSpread = summary.envSpread ?? 0
    } else {
      for (const k of KINDS) report.hooks.counts[k] = report[LISTS[k]].length
      report.envReads = report.envReads.map((r) => ({ key: r.key, n: 1, frame: r.frame }))
      report.hooks.summary = 'missing'      // the worker was SIGKILLed before its exit handler ran (timeout) — counts are the streamed samples
    }
    try { fs.closeSync(logFile) } catch {}
    try { fs.rmSync(spec.sockDir, { recursive: true, force: true }) } catch {}
  }
}

/**
 * probeCorpus(modules, opts) → {[id]: report}; `modules` = [{id, dir, name?}], `opts.jobs` workers at a
 * time (8), `opts.onModule(report)` as each finishes; the other keys go to probeModule.
 */
export async function probeCorpus(modules, { jobs = DEFAULTS.jobs, onModule = () => {}, ...opts } = {}) {
  const out = {}
  const queue = [...modules]
  const worker = async () => {
    while (queue.length) {
      const m = queue.shift()
      const r = await probeModule({ ...opts, id: m.id, dir: m.dir, name: m.name ?? m.id })
      out[m.id] = r
      onModule(r)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, modules.length)) }, worker))
  return out
}

/** One line per module for stdout: `PROBE <module> <state> …` (the DOCTOR line is lane C's). */
export function probeLine(r) {
  const c = r.hooks.counts
  const bits = [`env=${c.envRead}`, `listen=${c.listen}`, `spawn=${c.spawn}`, `writeOut=${c.writeOutside}`, `selfData=${c.selfData}`, `egress=${c.egress}`, `xmod=${r.ctxModule.filter((x) => x.cross).length}`]
  const died = r.died ? ` — ${r.died.where}: ${r.died.error.message}${r.died.error.file ? ` (${r.died.error.file}:${r.died.error.line})` : ''}` : ''
  return `PROBE ${r.module} ${r.state} ${r.ms}ms${r.rss ? ` rss=${Math.round(r.rss / MB)}MB` : ''} ${bits.join(' ')}${r.stop?.killed ? ' killed' : ''}${died}`
}
