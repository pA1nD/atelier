// host/worker/install.mjs — the two-phase install orchestration with the memory adapter (scratch layout,
// thaw → copy → npm → freeze argv/env/cwd/stdio byte-exact, cleanup on abort, the unprivileged branch) and
// freeze.py's argument/verdict surface (python3 on this machine; the ownership walk is the Linux drill's).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { memory } from '../adapters/os.mjs'
import { installDeps, npmSpec, freezeSpec, copyManifestSpec, parseFreeze, FREEZE_PATH, NPM_ARGV } from '../worker/install.mjs'

const spec = { instance: 'i-0123456789abcdef', slug: 'demo', company: 'acme', uid: 20001, appDir: '/work/apps/demo', dataDir: '/proc/self/fd/3/data/i-0123456789abcdef' }
const hostEnv = { PATH: '/usr/bin:/bin', NODE_ENV: 'production', HOME: '/root', CHANNEL_TOKEN: 'secret' }
const SCRATCH = '/work/.atelier/scratch/i-0123456789abcdef'

// drives every fake child to completion: `script(argv)` → {code, stdout} decides per spawn
function driven(state, script) {
  state.answers = { spawn: (argv) => { const child = state.spawned.at(-1); const r = script(argv) ?? { code: 0 }; setImmediate(() => { if (r.stdout) child.stdout.emit('data', r.stdout + '\n'); if (r.stderr) child.stderr.emit('data', r.stderr + '\n'); child.exit(r.code) }) } }
  return memory(state)
}
const kind = (argv) => argv.includes('python3') ? `freeze:${argv[argv.indexOf('python3') + 2]}` : argv.includes('npm') ? 'npm' : argv.includes('cp') || argv.join(' ').includes('cp --') ? 'cp' : 'other'

test('happy path: scratch plan → thaw → manifest copy as the worker → npm (row I) → freeze (row F) → {ok, files}', async () => {
  const state = { fs: {}, fds: new Map([[3, '/work/.atelier']]) }
  const order = []
  const os = driven(state, (argv) => { const k = kind(argv); order.push(k); if (k === 'freeze:thaw') return { code: 0, stdout: 'FREEZE-OK thaw demo files=0 noop=1 total_ms=0.3' }; if (k === 'freeze:freeze') return { code: 0, stdout: 'FREEZE-OK freeze demo killed=1 files=4378 fixed_mode=3 chown_ms=23.3 rename_ms=1.0 total_ms=47.1' } })
  const dirfd = 3
  const lines = []
  let hooked = false
  const r = await installDeps({ os, dirfd, spec, hostEnv, log: (l) => lines.push(l), beforeFreeze: async () => { hooked = order.join(',') } })
  assert.deepEqual(r, { ok: true, ms: 0, files: 4378 })
  assert.deepEqual(order, ['freeze:thaw', 'cp', 'npm', 'freeze:freeze'])
  assert.equal(hooked, 'freeze:thaw,cp,npm')                                 // the supervisor's stop hook runs after npm, before the freeze

  // scratch layout through the adapter, dirfd-relative, mkdir → chmod → chown
  const fsCalls = state.calls.filter((c) => c[0] !== 'spawn')
  assert.deepEqual(fsCalls, [
    ['mkdir', SCRATCH, 0o750], ['chmod', SCRATCH, 0o750], ['chown', SCRATCH, 0, 20001],
    ['mkdir', `${SCRATCH}/home`, 0o700], ['chmod', `${SCRATCH}/home`, 0o700], ['chown', `${SCRATCH}/home`, 20001, 20001],
    ['mkdir', `${SCRATCH}/build`, 0o755], ['chmod', `${SCRATCH}/build`, 0o755], ['chown', `${SCRATCH}/build`, 20001, 20001],
  ])

  const spawns = state.calls.filter((c) => c[0] === 'spawn').map((c) => ({ argv: c[1], spec: c[2] }))
  // row I, wrapped: sh umask 022 → setpriv (no prlimit: the install has no rlimits) → npm
  const npm = spawns[2]
  assert.deepEqual(npm.argv, ['sh', '-c', 'umask 22; exec "$@"', 'sh', 'setpriv', '--reuid=20001', '--regid=20001', '--clear-groups', '--', ...NPM_ARGV])
  assert.deepEqual(npm.spec.env, { PATH: '/usr/bin:/bin', NODE_ENV: 'production', APP_ID: 'i-0123456789abcdef', HOME: `${SCRATCH}/home`, npm_config_cache: `${SCRATCH}/home/.npm-cache` })
  assert.equal(npm.spec.cwd, `${SCRATCH}/build`)
  assert.deepEqual(npm.spec.stdio, ['ignore', 'pipe', 'pipe'])
  // the manifest copy runs as the worker (it reads the 2750 folder through appgid)
  const cp = spawns[1]
  assert.equal(cp.spec.uid, 20001)
  assert.deepEqual(cp.spec.env, { PATH: '/usr/bin:/bin' })
  assert.deepEqual(cp.spec.argv.slice(-2), ['/work/apps/demo', `${SCRATCH}/build`])
  // row F: root, groups cleared, env {PATH}, fd 3 = the dirfd
  const fr = spawns[3]
  assert.deepEqual(fr.argv, ['sh', '-c', 'umask 22; exec "$@"', 'sh', 'setpriv', '--reuid=0', '--regid=0', '--clear-groups', '--', 'python3', FREEZE_PATH, 'freeze', 'i-0123456789abcdef', 'demo', '20001', '20001', '--dirfd', '3'])
  assert.deepEqual(fr.spec.env, { PATH: '/usr/bin:/bin' })
  assert.equal(fr.spec.cwd, '/')
  assert.deepEqual(fr.spec.stdio, ['ignore', 'pipe', 'pipe', 3])
  assert.ok(lines.some((l) => /freeze .*"files":4378/.test(l)))
})

test('a freeze abort runs cleanup and classifies: setuid plant → setuid-refused, anything else → freeze-abort; nothing lands', async () => {
  let state = { fds: new Map([[3, '/work/.atelier']]) }
  let os = driven(state, (argv) => { const k = kind(argv); if (k === 'freeze:thaw') return { code: 0, stdout: 'FREEZE-OK thaw demo files=0' }; if (k === 'freeze:freeze') return { code: 2, stdout: 'FREEZE-ABORT freeze demo: setuid/setgid file suid-true mode=4755 refused' }; if (k === 'freeze:cleanup') return { code: 0, stdout: 'FREEZE-OK cleanup demo killed=0 dirs_taken=264' } })
  let r = await installDeps({ os, dirfd: 3, spec, hostEnv })
  assert.deepEqual(r, { ok: false, class: 'setuid-refused', message: 'setuid/setgid file suid-true mode=4755 refused' })
  let modes = state.calls.filter((c) => c[0] === 'spawn').map((c) => kind(c[1]))
  assert.deepEqual(modes, ['freeze:thaw', 'cp', 'npm', 'freeze:freeze', 'freeze:cleanup'])

  state = { fds: new Map([[3, '/work/.atelier']]) }
  os = driven(state, (argv) => { const k = kind(argv); if (k === 'freeze:thaw') return { code: 0, stdout: 'FREEZE-OK thaw demo files=0' }; if (k === 'freeze:freeze') return { code: 2, stdout: 'FREEZE-ABORT freeze demo: node_modules is a symlink (uid 20001)' }; if (k === 'freeze:cleanup') return { code: 0, stdout: 'FREEZE-OK cleanup demo' } })
  r = await installDeps({ os, dirfd: 3, spec, hostEnv })
  assert.equal(r.ok, false)
  assert.equal(r.class, 'freeze-abort')
  assert.match(r.message, /symlink/)
})

test('npm failure → class install with the stderr tail; no freeze is attempted', async () => {
  const state = { fds: new Map([[3, '/work/.atelier']]) }
  const os = driven(state, (argv) => { const k = kind(argv); if (k === 'freeze:thaw') return { code: 0, stdout: 'FREEZE-OK thaw demo files=0' }; if (k === 'npm') return { code: 1, stderr: 'npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/nope-pkg' } })
  const r = await installDeps({ os, dirfd: 3, spec, hostEnv })
  assert.equal(r.ok, false)
  assert.equal(r.class, 'install')
  assert.match(r.message, /^npm exit 1: .*E404.*nope-pkg/)
  assert.deepEqual(state.calls.filter((c) => c[0] === 'spawn').map((c) => kind(c[1])), ['freeze:thaw', 'cp', 'npm'])
})

test('thaw refusal (app folder not 1000-owned / symlinked) → freeze-abort before anything runs', async () => {
  const state = { fds: new Map([[3, '/work/.atelier']]) }
  const os = driven(state, (argv) => { if (kind(argv) === 'freeze:thaw') return { code: 2, stdout: 'FREEZE-ABORT thaw demo: agent-step OSError: [Errno 62] Too many levels of symbolic links' } })
  const r = await installDeps({ os, dirfd: 3, spec, hostEnv })
  assert.equal(r.class, 'freeze-abort')
  assert.match(r.message, /^thaw: agent-step/)
  assert.equal(state.calls.filter((c) => c[0] === 'spawn').length, 1)
})

test('unprivileged(): npm runs in the app folder as the current user, no scratch, no freeze (logged)', async () => {
  const state = {}
  const os = { ...driven(state, () => ({ code: 0 })), privileged: false, kind: 'unprivileged' }
  const lines = []
  const r = await installDeps({ os, dirfd: 3, spec, hostEnv, log: (l) => lines.push(l) })
  assert.deepEqual(r, { ok: true, ms: 0, files: null })
  const spawns = state.calls.filter((c) => c[0] === 'spawn')
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0][2].cwd, '/work/apps/demo')
  assert.deepEqual(spawns[0][2].env, { PATH: '/usr/bin:/bin', NODE_ENV: 'production', APP_ID: 'i-0123456789abcdef', HOME: '/root' })
  assert.equal(spawns[0][2].uid, undefined)
  assert.equal(state.calls.filter((c) => c[0] === 'mkdir').length, 0)
  assert.match(lines[0], /unprivileged .* freeze skipped/)
})

test('parseFreeze / npmSpec / copyManifestSpec / freezeSpec (pure)', () => {
  assert.deepEqual(parseFreeze('noise\nFREEZE-OK freeze demo killed=1 files=10 chown_ms=2.5\n'), { ok: true, mode: 'freeze', stats: { killed: 1, files: 10, chown_ms: 2.5 } })
  assert.deepEqual(parseFreeze('FREEZE-ABORT thaw demo: open build: Permission denied errno=13'), { ok: false, mode: 'thaw', reason: 'open build: Permission denied errno=13' })
  assert.deepEqual(parseFreeze(''), { ok: false, reason: 'no verdict line' })
  assert.deepEqual(npmSpec(spec, { scratchDir: '/s', hostEnv }).argv, NPM_ARGV)
  assert.equal(npmSpec(spec, { scratchDir: '/s', hostEnv }).umask, 0o022)
  assert.equal(copyManifestSpec(spec, { scratchDir: '/s', hostEnv }).uid, 20001)
  assert.deepEqual(freezeSpec('cleanup', spec, { dirfd: 7, hostEnv }).argv.slice(2), ['cleanup', 'i-0123456789abcdef', 'demo', '20001', '20001', '--dirfd', '3'])
  assert.deepEqual(freezeSpec('cleanup', spec, { dirfd: 7, hostEnv }).stdio, ['ignore', 'pipe', 'pipe', 7])
})

test('freeze.py: compiles, refuses an unknown mode, refuses a missing scratch under the dirfd — always with a FREEZE- verdict line', (t) => {
  const py = spawnSync('python3', ['-m', 'py_compile', FREEZE_PATH], { encoding: 'utf8' })
  if (py.error) return t.skip('python3 not on this machine')
  assert.equal(py.status, 0, py.stderr)
  const bad = spawnSync('python3', [FREEZE_PATH, 'bogus', 'i-x', 'demo', '20001', '20001'], { encoding: 'utf8' })
  assert.equal(bad.status, 2)
  assert.equal(bad.stdout.trim(), 'FREEZE-ABORT bogus demo: mode?')
  const root = fs.mkdtempSync(path.join('/tmp', 'atf-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const fd = fs.openSync(root, 'r')
  const nos = spawnSync('python3', [FREEZE_PATH, 'freeze', 'i-x', 'demo', '20001', '20001', '--dirfd', '3'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', fd] })
  fs.closeSync(fd)
  assert.equal(nos.status, 2, nos.stderr)
  assert.match(nos.stdout.trim(), /^FREEZE-ABORT freeze demo: open scratch: .*errno=2$/)
  assert.deepEqual(parseFreeze(nos.stdout), { ok: false, mode: 'freeze', reason: nos.stdout.trim().replace(/^FREEZE-ABORT freeze demo: /, '') })
})
