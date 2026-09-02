// host/worker/hook.mjs — row K (DESIGN §2.2, §10.3 D8): the app's deploy/test/smoke command as the worker uid, the
// env = row W + DATA_DIR (+ the step's keys), the config over stdin (never in the env the root chain receives), cwd
// = the export, the pgroup SIGKILL at the budget — the spec byte-exact through the memory adapter, then a real run.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { memory, unprivileged } from '../adapters/os.mjs'
import { hookSpec, runHook, HOOKRUN_PATH, HOOK_BUDGET_MS, HOOK_KEYS } from '../worker/hook.mjs'
import { RUNTIME_PATH, MB } from '../worker/spawn.mjs'

const GiB = 1024 * MB
const spec = {
  instance: 'i-0123456789abcdef', slug: 'demo', name: 'Demo', company: 'acme', uid: 20001, rev: 3,
  codeDir: '/work/.atelier/last-good/i-0123456789abcdef/rev-3', appDir: '/work/.atelier/prod/i-0123456789abcdef/0f3c9a1b2d4e',
  dataDir: '/work/.atelier/rehearsal/i-0123456789abcdef/data', tmpDir: '/work/.atelier/tmp/i-0123456789abcdef', scratchDir: '/work/.atelier/scratch/i-0123456789abcdef',
  sockDir: '/run/atelier/w/i-0123456789abcdef', sock: '/run/atelier/w/i-0123456789abcdef/w-rehearsal-3.sock',
  baseUrl: 'https://acme.portal.pa1nd.de/api/acme/demo', origin: 'https://acme.portal.pa1nd.de',
  configEnv: { DATABASE_URL: 'sqlite://x', LD_PRELOAD: '/evil.so', HOME: '/evil' },
  rlimits: { data: GiB, core: 0, nproc: 64, nofile: 1024 },
}
const hostEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', NODE_ENV: 'production', ATELIER_BOOTSTRAP: 'secret', CHANNEL_TOKEN: 'secret' }

test('hookSpec is row K exactly: node hookrun.mjs <cmd> as the worker uid, row W env + DATA_DIR (+ extra), cwd = the export, rlimits, oom, umask 002, stdin pipe, detached — and NO config key in the env', () => {
  const s = hookSpec(spec, { cmd: 'node migrate.js', cwd: spec.appDir, hostEnv })
  assert.deepEqual({ ...s, env: null }, { argv: ['node', HOOKRUN_PATH, 'node migrate.js'], env: null, cwd: spec.appDir, uid: 20001, gid: 20001, groups: [], rlimits: spec.rlimits, oomScoreAdj: 1000, umask: 0o002, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  assert.deepEqual(Object.keys(s.env), ['PATH', 'NODE_ENV', 'APP_ID', 'HOME', 'HOST', 'PORT', 'BASE_URL', 'TMPDIR', 'ATELIER_WORKER', 'DATA_DIR'])
  assert.equal(s.env.DATA_DIR, spec.dataDir); assert.equal(s.env.HOME, '/work/.atelier/scratch/i-0123456789abcdef/home'); assert.equal(s.env.BASE_URL, spec.baseUrl)
  assert.equal(Object.values(s.env).some((v) => /sqlite:\/\/x|evil/.test(v)), false, 'the OR14 config never enters the env the root wrapper chain receives')
  const smoke = hookSpec(spec, { cmd: 'curl --unix-socket "$ATELIER_SOCK" "$BASE_URL/health"', cwd: spec.appDir, hostEnv, extra: { ATELIER_SOCK: spec.sock, BASE_URL: 'http://localhost' } })
  assert.equal(smoke.env.ATELIER_SOCK, spec.sock); assert.equal(smoke.env.BASE_URL, 'http://localhost')
  // the memory adapter wraps it like a worker: sh umask+oom → prlimit → setpriv → node
  const state = {}
  const os = memory(state)
  const child = os.spawn(s)
  assert.deepEqual(child.argv.slice(0, 15), ['sh', '-c', 'umask 2; echo 1000 > /proc/self/oom_score_adj; exec "$@"', 'sh', 'prlimit', `--data=${GiB}`, '--core=0', '--nproc=64', '--nofile=1024', '--', 'setpriv', '--reuid=20001', '--regid=20001', '--clear-groups', '--'])
  assert.deepEqual(child.argv.slice(15), ['node', HOOKRUN_PATH, 'node migrate.js'])
  assert.deepEqual(HOOK_KEYS, ['deploy', 'test', 'smoke']); assert.deepEqual(HOOK_BUDGET_MS, { deploy: 60_000, test: 60_000, smoke: 30_000 })
  assert.notEqual(HOOKRUN_PATH, RUNTIME_PATH)
})

test('runHook through the memory adapter: the config document on stdin then EOF, exit 0 → ok, exit 1 → the last output line in the error, a timeout SIGKILLs the process group', async () => {
  let state = {}
  let os = memory(state)
  let p = runHook({ os, spec, cmd: 'true', cwd: '/x', hostEnv, timeoutMs: 1000 })
  let child = state.spawned[0]
  assert.deepEqual(child.stdin.written, ['{"env":{"DATABASE_URL":"sqlite://x"}}']); assert.equal(child.stdin.ended, true)
  child.stdout.emit('data', 'migrated 3 tables\n'); child.exit(0)
  let r = await p
  assert.equal(r.ok, true); assert.deepEqual(r.output, ['migrated 3 tables']); assert.equal(r.code, 0)
  state = {}; os = memory(state)
  p = runHook({ os, spec, cmd: 'false', cwd: '/x', hostEnv, timeoutMs: 1000 })
  child = state.spawned[0]
  child.stderr.emit('data', 'Error: table users has no column email\n'); child.exit(2)
  r = await p
  assert.equal(r.ok, false); assert.equal(r.error, 'exit 2: Error: table users has no column email')
  state = {}; os = memory(state)
  const lines = []
  p = runHook({ os, spec, cmd: 'sleep 9', cwd: '/x', hostEnv, timeoutMs: 30, log: (l) => lines.push(l) })
  child = state.spawned[0]
  r = await p
  assert.equal(r.ok, false); assert.equal(r.error, 'timeout after 30 ms'); assert.equal(r.signal, 'SIGKILL')
  assert.deepEqual(state.calls.filter((c) => c[0] === 'kill').map((c) => c.slice(1)), [[-child.pid, 'SIGKILL'], [child.pid, 'SIGKILL']])
  assert.match(lines[0], /timeout after 30 ms → SIGKILL pgroup/)
})

test('a real run (unprivileged): the command sees DATA_DIR, the config keys from stdin (not the denied ones), cwd = the export; a non-zero exit and a kill are reported', async () => {
  const dir = fs.mkdtempSync('/tmp/hook-')
  const os = unprivileged()
  const cwd = path.join(dir, 'export'); fs.mkdirSync(cwd)
  const s = { ...spec, appDir: cwd, dataDir: path.join(dir, 'data'), tmpDir: dir }
  let r = await runHook({ os, spec: s, cmd: 'echo "$DATA_DIR|$DATABASE_URL|${LD_PRELOAD:-none}|$(pwd)|$APP_ID" && printf %s "$DATABASE_URL" > out.txt', cwd, hostEnv: { ...hostEnv, PATH: process.env.PATH }, timeoutMs: 5000 })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.output, [`${s.dataDir}|sqlite://x|none|${fs.realpathSync(cwd)}|i-0123456789abcdef`])
  assert.equal(fs.readFileSync(path.join(cwd, 'out.txt'), 'utf8'), 'sqlite://x')
  r = await runHook({ os, spec: s, cmd: 'echo starting; echo "boom: no column email" >&2; exit 3', cwd, hostEnv: { ...hostEnv, PATH: process.env.PATH }, timeoutMs: 5000 })
  assert.equal(r.ok, false); assert.equal(r.code, 3); assert.equal(r.error, 'exit 3: boom: no column email')
  r = await runHook({ os, spec: s, cmd: 'sleep 5', cwd, hostEnv: { ...hostEnv, PATH: process.env.PATH }, timeoutMs: 150 })
  assert.equal(r.ok, false); assert.equal(r.error, 'timeout after 150 ms'); assert.ok(r.ms < 2000)
  fs.rmSync(dir, { recursive: true, force: true })
})
