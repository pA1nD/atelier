// doctor/probe — the runtime probe through the REAL host worker (doctor/DESIGN.md §4, §8 probe.test.js):
// spawnWorker + entry.mjs on the two fixture apps and on throwaway apps written under /tmp. macOS, no
// root, no network; every worker is a real process on a real Unix socket.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { probeModule, probeCorpus, probeSpec, probeLine, instanceOf, DEFAULTS, SOCK_ROOT } from '../probe/run.mjs'
import { attributeStack, KINDS, LISTS, HOOK_FILES } from '../probe/common.mjs'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const CLEAN = path.join(FIXTURES, 'probe-clean')
const DIRTY = path.join(FIXTURES, 'probe-dirty')
const FAST = { readyMs: 4000, settleMs: 200, drainMs: 1500 }

/** names + sizes + mtimes of every entry under dir — the proof a folder was not touched. */
function treeHash(dir) {
  const rows = []
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name
      const st = fs.lstatSync(abs)
      rows.push(`${r} ${e.isDirectory() ? 'd' : 'f'} ${st.size} ${st.mtimeMs}`)
      if (e.isDirectory()) walk(abs, r)
    }
  }
  walk(dir, '')
  return rows.join('\n')
}
const tmpOut = (t) => { const d = fs.mkdtempSync('/tmp/doctor-probe-'); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d }
const tmpApp = (t, backend) => { const d = fs.mkdtempSync('/tmp/doctor-app-'); fs.writeFileSync(path.join(d, 'backend.js'), backend); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d }
const appCount = (r) => Object.values(r.hooks.counts).reduce((a, b) => a + b, 0)

test('probeSpec is the host\'s WorkerSpec shape with the probe\'s paths; nothing points into the app folder', () => {
  const s = probeSpec({ id: 'demo', dir: '/apps/demo', out: '/o', name: 'Demo' })
  assert.equal(s.instance, instanceOf('demo'))
  assert.match(s.instance, /^i-[0-9a-f]{16}$/)
  assert.equal(s.slug, 'demo'); assert.equal(s.name, 'Demo'); assert.equal(s.company, 'doctor'); assert.equal(s.rev, 1)
  assert.equal(s.uid, process.getuid())
  assert.equal(s.appDir, '/apps/demo')
  assert.equal(s.codeDir, '/o/doctor/demo/probe/rev-1')
  assert.equal(s.dataDir, '/o/doctor/demo/probe/data')
  assert.equal(s.tmpDir, '/o/doctor/demo/probe/tmp')
  assert.equal(s.scratchDir, '/o/doctor/demo/probe/scratch')
  assert.equal(s.sock, `${SOCK_ROOT}/${s.instance}/w.sock`)
  assert.ok(s.sock.length < 104, 'macOS socket path cap')
  assert.equal(s.baseUrl, 'https://doctor.portal.pa1nd.de/api/doctor/demo')
  assert.equal(s.origin, 'https://doctor.portal.pa1nd.de')
  assert.deepEqual(s.configEnv, {})
  assert.deepEqual(s.rlimits, { data: 1024 * 1024 * 1024, core: 0, nproc: 64, nofile: 1024 })
  for (const v of [s.codeDir, s.dataDir, s.tmpDir, s.scratchDir, s.sock]) assert.ok(!v.startsWith('/apps/demo'), v)
  assert.ok(DEFAULTS.readyMs + DEFAULTS.settleMs + DEFAULTS.drainMs <= 10_000, 'the per-module budget is ≤ 10 s')
})

test('attributeStack (pure): app / runtime / node frames, hook frames skipped, skipRuntime', () => {
  const hooks = HOOK_FILES[0]
  const app = '/o/doctor/x/probe/rev-1/backend.js'
  const rt = '/repo/host/worker/runtime.mjs'
  const st = (...frames) => ['Error', ...frames.map((f) => `    at ${f}`)].join('\n')
  assert.deepEqual(attributeStack(st(`w (${hooks}:10:5)`, `mountRoutes (file://${app}:4:9)`, `async main (file://${rt}:220:5)`)), { by: 'app', frame: `${app}:4:9` })
  assert.deepEqual(attributeStack(st(`w (${hooks}:10:5)`, `main (file://${rt}:220:5)`, `${app}:4:9`)), { by: 'runtime', frame: `${rt}:220:5` })
  assert.deepEqual(attributeStack(st(`w (${hooks}:10:5)`, `main (file://${rt}:220:5)`, `${app}:4:9`), { skipRuntime: true }), { by: 'app', frame: `${app}:4:9` })
  assert.deepEqual(attributeStack(st(`w (${hooks}:10:5)`, 'FSWatcher.start (node:internal/fs/watchers:100:1)', 'new Promise (<anonymous>)')), { by: 'node', frame: null })
  assert.deepEqual(attributeStack(st(`w (${hooks}:10:5)`, `/apps/x/node_modules/ws/lib/x.js:3:3`)), { by: 'app', frame: '/apps/x/node_modules/ws/lib/x.js:3:3' })
  assert.deepEqual(Object.keys(LISTS), [...KINDS])
})

test('(a) a clean app: mounted through the real runtime, teardown true, zero app-attributed observations, the folder untouched', async (t) => {
  const out = tmpOut(t)
  const before = treeHash(CLEAN)
  const r = await probeModule({ id: 'probe-clean', dir: CLEAN, out, ...FAST })
  assert.equal(r.state, 'mounted'); assert.equal(r.mounted, true); assert.equal(r.died, null)
  assert.equal(r.teardown, true)
  assert.deepEqual(r.resources, {})
  assert.deepEqual(r.stop, { code: 0, signal: null, killed: false })
  assert.equal(r.exitedEarly, null)
  assert.ok(r.rss > 10 * 1024 * 1024, `rss ${r.rss}`)
  assert.equal(typeof r.importMs, 'number'); assert.equal(typeof r.mountMs, 'number')
  assert.equal(r.jail, 'hook-emulated')
  assert.equal(appCount(r), 0, JSON.stringify(r.hooks))
  for (const k of KINDS) assert.deepEqual(r[LISTS[k]], [])
  assert.ok(r.hooks.skipped.runtime > 0, 'the runtime\'s own env reads / listen / unlink were seen and skipped')
  assert.equal(r.hooks.summary, undefined, 'the exit summary arrived')
  assert.equal(treeHash(CLEAN), before)
  // everything the worker made lives under --out
  const probeDir = path.join(out, 'doctor', 'probe-clean', 'probe')
  for (const d of ['rev-1/backend.js', 'rev-1/backend.js.map', 'data', 'tmp', 'scratch/home', 'worker.log']) assert.ok(fs.existsSync(path.join(probeDir, d)), d)
  assert.equal(fs.existsSync(path.join(SOCK_ROOT, instanceOf('probe-clean'))), false, 'the socket dir is removed')
  assert.ok(r.ms < 10_000)
  assert.match(probeLine(r), /^PROBE probe-clean mounted \d+ms rss=\d+MB env=0 listen=0 spawn=0 writeOut=0 selfData=0 egress=0 xmod=0$/)
})

test('(b) a dirty app: every habit observed and attributed to the app, the write refused EACCES, still mounted, the folder untouched', async (t) => {
  const out = tmpOut(t)
  const before = treeHash(DIRTY)
  const r = await probeModule({ id: 'probe-dirty', dir: DIRTY, out, ...FAST })
  assert.equal(r.state, 'mounted')
  assert.deepEqual(r.stop, { code: 0, signal: null, killed: false })
  // N2: the env read — and ONLY the app's; the runtime's PORT/HOST/ATELIER_WORKER reads are attributed to it
  assert.deepEqual(r.envReads.map((e) => e.key), ['SPACES_PORT'])
  assert.equal(r.envReads[0].n, 1)
  assert.match(r.envReads[0].frame, /^backend\.js:14:\d+$/, 'frames are mapped through the source map to the source file')
  // D2: the sidecar listen — recorded, never bound
  assert.deepEqual(r.listens.map((l) => l.target), ['0.0.0.0:7475'])
  // D12: the laptop binary — recorded, never run
  assert.deepEqual(r.spawns.map((s) => [s.bin, s.fn]), [['ffmpeg', 'spawn']])
  // N1: the writes into <app>/data — refused and recorded, and the reads under <app>/data recorded
  assert.deepEqual(r.writesOutside.map((w) => [w.op, w.path, w.inApp]), [['mkdirSync', '<app>/data', true], ['writeFileSync', '<app>/data/x', true]])
  assert.deepEqual(r.selfData.map((w) => [w.op, w.path, w.write]), [['mkdirSync', '<app>/data', true], ['writeFileSync', '<app>/data/x', true], ['existsSync', '<app>/data/y', false]])
  assert.equal(fs.existsSync(path.join(DIRTY, 'data')), false)
  // N4/N5: the jobs beacon over the loopback and /api/global/
  assert.deepEqual(r.egress.map((e) => [e.via, e.target, e.loopback]), [['fetch', 'http://127.0.0.1:1844/api/global/jobs/beacon', true]])
  // D3: ctx.module of another app
  assert.deepEqual(r.ctxModule.map((m) => [m.id, m.cross]), [['jobs', true]])
  // N8: the signal handler
  assert.deepEqual(r.signalHandlers.map((s) => s.signal), ['SIGINT'])
  assert.deepEqual(r.processExit, [])
  assert.deepEqual(r.hooks.counts, { envRead: 1, listen: 1, spawn: 1, writeOutside: 2, selfData: 3, egress: 1, ctxModule: 1, signal: 1, exit: 0 })
  for (const k of KINDS) for (const o of r[LISTS[k]]) assert.match(o.frame, /^backend\.js:\d+:\d+$/, `${k} ${o.frame}`)
  assert.ok(r.stderrTail.some((l) => /sidecar on 7475/.test(l)), 'ctx.log reached stderr → worker.log')
  assert.equal(treeHash(DIRTY), before)
  assert.match(probeLine(r), /env=1 listen=1 spawn=1 writeOut=2 selfData=3 egress=1 xmod=1$/)
})

test('(c) mkdirSync(<app>/data) at import → load-error with the source file:line; nothing created', async (t) => {
  const out = tmpOut(t)
  const dir = tmpApp(t, [
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    "import { fileURLToPath } from 'node:url'",
    'const HERE = path.dirname(fileURLToPath(import.meta.url))',
    "fs.mkdirSync(path.join(HERE, 'data'), { recursive: true })",
    'export default { mountRoutes(r) { r.get("/", (q, s) => s.json({})) } }',
    '',
  ].join('\n'))
  const r = await probeModule({ id: 'dies-at-import', dir, out, ...FAST })
  assert.equal(r.state, 'load-error'); assert.equal(r.mounted, false)
  assert.equal(r.died.where, 'import'); assert.equal(r.died.code, 'LOAD-ERROR')
  assert.match(r.died.error.message, /EACCES/)
  assert.equal(r.died.error.file, 'backend.js'); assert.equal(r.died.error.line, 5)
  assert.deepEqual(r.writesOutside.map((w) => [w.op, w.path, w.inApp]), [['mkdirSync', '<app>/data', true]])
  assert.equal(fs.existsSync(path.join(dir, 'data')), false)
  assert.equal(r.hooks.summary, undefined, 'the exit summary arrived after load-failed')
  assert.match(probeLine(r), /load-error .* — import: EACCES.*\(backend\.js:5\)$/)
})

test('(d) process.exit(0) in mountRoutes → recorded, state died', async (t) => {
  const out = tmpOut(t)
  const dir = tmpApp(t, 'export default { mountRoutes(r) { r.get("/", (q, s) => s.json({})); process.exit(0) } }\n')
  const r = await probeModule({ id: 'exits', dir, out, ...FAST })
  assert.equal(r.state, 'died'); assert.equal(r.died.where, 'process'); assert.equal(r.died.code, 'RUNTIME-DEAD')
  assert.deepEqual(r.processExit.map((e) => e.code), [0])
  assert.match(r.processExit[0].frame, /^backend\.js:1:\d+$/)
  assert.equal(r.hooks.counts.exit, 1)
})

test('(e) a syntax error → bundle-error with file:line, no worker spawned', async (t) => {
  const out = tmpOut(t)
  const dir = tmpApp(t, 'export default { mountRoutes(r) { r.get(\n')
  const r = await probeModule({ id: 'syntax', dir, out, ...FAST })
  assert.equal(r.state, 'bundle-error'); assert.equal(r.died.where, 'bundle')
  assert.equal(r.died.error.file, 'backend.js'); assert.equal(typeof r.died.error.line, 'number')
  assert.ok(r.died.error.hint)
  assert.equal(fs.existsSync(path.join(out, 'doctor', 'syntax', 'probe', 'worker.log')), false)
  assert.equal(r.rss, null)
})

test('(f) a mountRoutes that never returns → timeout at readyMs, the worker killed, the streamed observations kept', async (t) => {
  const out = tmpOut(t)
  const dir = tmpApp(t, 'export default { async mountRoutes(r) { process.env.SLOW_KEY; await new Promise((ok) => setTimeout(ok, 60_000)) } }\n')
  const t0 = Date.now()
  const r = await probeModule({ id: 'hangs', dir, out, readyMs: 800, settleMs: 100, drainMs: 500 })
  assert.equal(r.state, 'timeout'); assert.equal(r.died.where, 'ready-wait'); assert.equal(r.died.code, 'no-ready')
  assert.ok(Date.now() - t0 < 4000, `bounded: ${Date.now() - t0} ms`)
  assert.deepEqual(r.envReads.map((e) => e.key), ['SLOW_KEY'])
  assert.equal(r.hooks.summary, 'missing', 'SIGKILLed: no exit summary; the counts are the streamed samples')
  assert.equal(r.hooks.counts.envRead, 1)
})

test('(g) mountRoutes throws → mount-throw with the source line; a throwing teardown / a resident timer → resources + killed:false', async (t) => {
  const out = tmpOut(t)
  const dir = tmpApp(t, 'export default {\n  mountRoutes() { throw new Error("database is locked") },\n}\n')
  const r = await probeModule({ id: 'mount-throw', dir, out, ...FAST })
  assert.equal(r.state, 'mount-throw'); assert.equal(r.died.where, 'mount'); assert.equal(r.died.code, 'MOUNT-ERROR')
  assert.match(r.died.error.message, /database is locked/)
  assert.equal(r.died.error.file, 'backend.js'); assert.equal(r.died.error.line, 2)
  const dir2 = tmpApp(t, 'const t = setInterval(() => {}, 1000)\nexport default { mountRoutes(r) { r.get("/", (q, s) => s.json({})); return () => clearInterval(t) } }\n')
  const r2 = await probeModule({ id: 'resident', dir: dir2, out, ...FAST })
  assert.equal(r2.state, 'mounted')
  assert.equal(r2.resources.Timeout, 1, 'R2: the module holds a timer after mount')
  assert.equal(r2.teardown, true)
  assert.deepEqual(r2.stop, { code: 0, signal: null, killed: false })
})

test('probeCorpus runs the modules with a concurrency cap and reports each once', async (t) => {
  const out = tmpOut(t)
  const seen = []
  const mods = [{ id: 'probe-clean', dir: CLEAN }, { id: 'probe-dirty', dir: DIRTY, name: 'Dirty' }, { id: 'nobackend', dir: tmpOut(t) }]
  const rs = await probeCorpus(mods, { out, jobs: 2, onModule: (r) => seen.push(r.module), ...FAST })
  assert.deepEqual(Object.keys(rs).sort(), ['nobackend', 'probe-clean', 'probe-dirty'])
  assert.deepEqual([...seen].sort(), ['nobackend', 'probe-clean', 'probe-dirty'])
  assert.equal(rs['probe-clean'].state, 'mounted')
  assert.equal(rs['probe-dirty'].state, 'mounted')
  assert.equal(rs.nobackend.state, 'no-backend')
  assert.equal(rs.nobackend.died, null)
})
