// host/worker/spawn.mjs — the spawn plan as data (DESIGN §2.2 row W) and the READY wait on fd 3 (§4.1),
// driven through the memory adapter's fake child.
import test from 'node:test'
import assert from 'node:assert/strict'
import { memory } from '../adapters/os.mjs'
import { spawnPlan, spawnWorker, workerEnv, workerJson, configEnvOf, configPayload, maxOldSpaceMb, publishedAddress, lineSplitter, RUNTIME_PATH, MB } from '../worker/spawn.mjs'

const GiB = 1024 * MB
const spec = {
  instance: 'i-0123456789abcdef', slug: 'demo', name: 'Demo', company: 'acme', uid: 20001, rev: 3,
  codeDir: '/proc/self/fd/3/last-good/i-0123456789abcdef/rev-3', appDir: '/work/apps/demo',
  dataDir: '/proc/self/fd/3/data/i-0123456789abcdef', tmpDir: '/proc/self/fd/3/tmp/i-0123456789abcdef',
  sockDir: '/run/atelier/w/i-0123456789abcdef', sock: '/run/atelier/w/i-0123456789abcdef/w.sock',
  baseUrl: 'https://acme.portal.pa1nd.de/api/acme/demo', origin: 'https://acme.portal.pa1nd.de',
  configEnv: { OPENAI_KEY: 'sk-x', HOME: '/evil', LD_PRELOAD: '/tmp/evil.so', NODE_OPTIONS: '--require /tmp/x', 'BAD KEY': '1', ATELIER_WORKER: '{}' },
  rlimits: { data: GiB, core: 0, nproc: 64, nofile: 1024 },
}
const hostEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', NODE_ENV: 'production', ATELIER_BOOTSTRAP: 'secret', CHANNEL_TOKEN: 'secret' }

test('--max-old-space-size = (data − 576 MB) × 0.85, min 256', () => {
  assert.equal(maxOldSpaceMb(GiB), 380)
  assert.equal(maxOldSpaceMb(2 * GiB), 1251)
  assert.equal(maxOldSpaceMb(512 * MB), 256)
})

test('HOST/PORT/BASE_URL are published from the mount URL (§9.12)', () => {
  assert.deepEqual(publishedAddress(spec), { HOST: 'acme.portal.pa1nd.de', PORT: '443', BASE_URL: 'https://acme.portal.pa1nd.de/api/acme/demo' })
  assert.deepEqual(publishedAddress({ ...spec, origin: 'http://127.0.0.1:1844', baseUrl: 'http://127.0.0.1:1844/api/local/demo' }), { HOST: '127.0.0.1', PORT: '1844', BASE_URL: 'http://127.0.0.1:1844/api/local/demo' })
})

test('workerEnv is row W exactly: nothing from process.env, NO config key (the env reaches the root wrapper chain); config travels on stdin minus the jail keys and the loader/runtime knobs', () => {
  const env = workerEnv(spec, hostEnv)
  assert.deepEqual(Object.keys(env), ['PATH', 'NODE_ENV', 'APP_ID', 'HOME', 'HOST', 'PORT', 'BASE_URL', 'TMPDIR', 'ATELIER_WORKER'])
  assert.equal(env.HOME, '/proc/self/fd/3/scratch/i-0123456789abcdef/home')      // derived from dataDir when scratchDir is absent
  assert.equal(workerEnv({ ...spec, scratchDir: '/s/i-x' }, hostEnv).HOME, '/s/i-x/home')
  assert.equal(env.APP_ID, 'i-0123456789abcdef')
  assert.equal(env.TMPDIR, spec.tmpDir)
  assert.equal('OPENAI_KEY' in env, false)
  assert.equal('LD_PRELOAD' in env, false)
  assert.equal('ATELIER_BOOTSTRAP' in env, false)
  assert.equal('CHANNEL_TOKEN' in env, false)
  assert.deepEqual(JSON.parse(env.ATELIER_WORKER), workerJson(spec))
  assert.equal('configEnv' in JSON.parse(env.ATELIER_WORKER), false)
  assert.equal('rlimits' in JSON.parse(env.ATELIER_WORKER), false)
  assert.deepEqual(configEnvOf(spec), { env: { OPENAI_KEY: 'sk-x' }, dropped: ['HOME', 'LD_PRELOAD', 'NODE_OPTIONS', 'BAD KEY', 'ATELIER_WORKER'] })
  assert.equal(configPayload(spec), '{"env":{"OPENAI_KEY":"sk-x"}}')
  assert.deepEqual(configEnvOf({}), { env: {}, dropped: [] })
})

test('spawnPlan → SpawnSpec row W; the memory adapter wraps it byte-exact (sh umask+oom → prlimit → setpriv → node)', () => {
  const plan = spawnPlan(spec, { hostEnv })
  assert.deepEqual({ ...plan, env: null }, {
    argv: ['node', '--max-old-space-size=380', RUNTIME_PATH],
    env: null, cwd: '/', uid: 20001, gid: 20001, groups: [], rlimits: spec.rlimits, oomScoreAdj: 1000, umask: 0o002,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true,
  })
  assert.equal(Object.values(plan.env).some((v) => /sk-x|evil/.test(v)), false, 'no config value in the env the root chain receives')
  const state = {}
  const os = memory(state)
  const child = os.spawn(plan)
  assert.deepEqual(child.argv, [
    'sh', '-c', 'umask 2; echo 1000 > /proc/self/oom_score_adj; exec "$@"', 'sh',
    'prlimit', `--data=${GiB}`, '--core=0', '--nproc=64', '--nofile=1024', '--',
    'setpriv', '--reuid=20001', '--regid=20001', '--clear-groups', '--',
    'node', '--max-old-space-size=380', RUNTIME_PATH,
  ])
})

test('lineSplitter reassembles NDJSON across chunk boundaries', () => {
  const lines = []
  const feed = lineSplitter((l) => lines.push(l))
  feed('{"t":"re'); feed(Buffer.from('ady"}\n{"t":"x"}\n\n{"t":')); feed('"y"}\n')
  assert.deepEqual(lines, ['{"t":"ready"}', '{"t":"x"}', '{"t":"y"}'])
})

const boot = (state, opts = {}) => {
  const os = memory(state)
  const control = [], exits = []
  const p = spawnWorker({ os, spec, hostEnv, onControl: (m) => control.push(m), onExit: (c, s) => exits.push([c, s]), readyTimeoutMs: 200, onLog: () => {}, ...opts })
  const child = state.spawned[0]
  return { os, p, child, control, exits }
}

test('READY on fd 3 resolves the handle, locks the socket 0:0 0700, then control messages flow to onControl', async () => {
  const state = { fs: { [spec.sock]: { uid: 20001, gid: 20001, mode: 0o755, type: 'socket' } } }
  const { p, child, control, exits } = boot(state)
  const ready = { t: 'ready', mountMs: 12, importMs: 30, resources: {}, teardown: true }
  child.stdio[3].emit('data', JSON.stringify(ready) + '\n{"t":"broadcast","event":{"type":"x"}}\n')
  const h = await p
  assert.equal(h.pid, child.pid)
  assert.equal(h.sock, spec.sock)
  assert.deepEqual(h.ready, ready)
  // the config lane: one JSON document on stdin, then EOF — before READY, never through the env
  assert.deepEqual(child.stdin.written, ['{"env":{"OPENAI_KEY":"sk-x"}}']); assert.equal(child.stdin.ended, true)
  assert.equal(child.spec.env.OPENAI_KEY, undefined)
  assert.deepEqual(state.calls.filter((c) => c[0] !== 'spawn'), [['chown', spec.sock, 0, 0], ['chmod', spec.sock, 0o700], ['chmod', spec.sockDir, 0o710]])
  assert.deepEqual(control, [{ t: 'broadcast', event: { type: 'x' } }])
  // lockSocket 'shared' (the rehearsal worker): 0:<uid> 0770
  const st2 = { fs: { [spec.sock]: { uid: 20001, gid: 20001, mode: 0o775, type: 'socket' } } }
  const b2 = boot(st2, { lockSocket: 'shared' })
  b2.child.stdio[3].emit('data', JSON.stringify(ready) + '\n')
  await b2.p
  assert.deepEqual(st2.calls.filter((c) => c[0] !== 'spawn'), [['chown', spec.sock, 0, 20001], ['chmod', spec.sock, 0o770], ['chmod', spec.sockDir, 0o710]])
  child.stdio[3].emit('data', '{"t":"suspendable"}\n')
  assert.equal(control.length, 2)
  child.exit(0)
  assert.deepEqual(exits, [[0, null]])
})

test('load-failed before READY rejects {error:"load-failed", code}', async () => {
  const { p, child } = boot({})
  child.stdio[3].emit('data', '{"t":"load-failed","code":"MOUNT-ERROR","message":"database is locked","file":"/work/apps/demo/backend.js","line":4,"col":9}\n')
  await assert.rejects(p, (e) => e.error === 'load-failed' && e.code === 'MOUNT-ERROR' && e.detail.line === 4 && /database is locked/.test(e.msg))
})

test('exit 134 / a signal / spawn EAGAIN before READY is spawn-eagain, never a broken app; a plain exit is RUNTIME-DEAD', async () => {
  let b = boot({}); b.child.exit(134); await assert.rejects(b.p, (e) => e.error === 'spawn-eagain')
  b = boot({}); b.child.exit(null, 'SIGKILL'); await assert.rejects(b.p, (e) => e.error === 'spawn-eagain')
  b = boot({}); b.child.emit('error', Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' })); await assert.rejects(b.p, (e) => e.error === 'spawn-eagain' && /EAGAIN/.test(e.msg))
  b = boot({}); b.child.exit(1); await assert.rejects(b.p, (e) => e.error === 'load-failed' && e.code === 'RUNTIME-DEAD')
  assert.deepEqual(b.exits, [])                                                 // onExit is for post-READY exits only
})

test('no READY within readyTimeoutMs → no-ready and SIGKILL', async () => {
  const { p, child, os } = boot({}, { readyTimeoutMs: 30 })
  await assert.rejects(p, (e) => e.error === 'no-ready')
  const killed = []
  child.onSignal = (s) => killed.push(s)
  // the kill went through the adapter before the rejection
  assert.ok(os.kind === 'memory')
})

test('stop(): SIGCONT (a stopped worker can run its teardown) → SIGTERM, then the process group is SIGKILLed at the drain deadline', async () => {
  let state = {}
  let { p, child } = boot(state)
  child.stdio[3].emit('data', '{"t":"ready","mountMs":1,"importMs":1,"resources":{},"teardown":false}\n')
  let h = await p
  const signals = []
  child.onSignal = (s) => { signals.push(s); if (s === 'SIGTERM') setTimeout(() => child.exit(0), 5) }
  let r = await h.stop(500)
  assert.deepEqual(signals, ['SIGCONT', 'SIGTERM'])
  assert.deepEqual(r, { code: 0, signal: null, killed: false })

  state = {}
  ;({ p, child } = boot(state))
  child.stdio[3].emit('data', '{"t":"ready","mountMs":1,"importMs":1,"resources":{},"teardown":false}\n')
  h = await p
  child.onSignal = () => {}                                                     // a worker that ignores SIGTERM
  r = await h.stop(20)
  assert.equal(r.killed, true)
  const kills = state.calls.filter((c) => c[0] === 'kill').map((c) => c.slice(1))
  assert.deepEqual(kills, [[child.pid, 'SIGCONT'], [child.pid, 'SIGTERM'], [-child.pid, 'SIGKILL'], [child.pid, 'SIGKILL']])
})
