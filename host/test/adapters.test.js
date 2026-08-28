// host/adapters/os.mjs — the seam every lane fakes. Asserts the argv builders and the recording fake.
import test from 'node:test'
import assert from 'node:assert/strict'
import { memory, unprivileged, setprivArgv, prlimitArgv } from '../adapters/os.mjs'

test('setpriv/prlimit argv builders are exact (DESIGN §2.2)', () => {
  assert.deepEqual(setprivArgv({ uid: 20001, gid: 20001, groups: [] }), ['setpriv', '--reuid=20001', '--regid=20001', '--clear-groups', '--'])
  assert.deepEqual(setprivArgv({ uid: 1000, gid: 1000, groups: [19999] }), ['setpriv', '--reuid=1000', '--regid=1000', '--groups=19999', '--'])
  assert.deepEqual(prlimitArgv({ data: 1073741824, core: 0, nproc: 64, nofile: 1024 }), ['prlimit', '--data=1073741824', '--core=0', '--nproc=64', '--nofile=1024', '--'])
})

test('memory(): row W wrapper argv is byte-exact and the spawn is recorded', () => {
  const state = {}
  const os = memory(state)
  const child = os.spawn({
    argv: ['node', '--max-old-space-size=384', 'host/worker/runtime.mjs'],
    env: { PATH: '/usr/bin', NODE_ENV: 'production', APP_ID: 'i-0123456789abcdef' },
    cwd: '/', uid: 20001, gid: 20001, groups: [],
    rlimits: { data: 1073741824, core: 0, nproc: 64, nofile: 1024 }, oomScoreAdj: 1000, umask: 0o002,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  })
  assert.deepEqual(child.argv, [
    'sh', '-c', 'umask 2; echo 1000 > /proc/self/oom_score_adj; exec "$@"', 'sh',
    'prlimit', '--data=1073741824', '--core=0', '--nproc=64', '--nofile=1024', '--',
    'setpriv', '--reuid=20001', '--regid=20001', '--clear-groups', '--',
    'node', '--max-old-space-size=384', 'host/worker/runtime.mjs',
  ])
  assert.equal(state.calls[0][0], 'spawn')
  assert.equal(state.spawned.length, 1)
  let got = null
  child.on('exit', (code) => { got = code })
  child.exit(0)
  assert.equal(got, 0)
})

test('memory(): filesystem calls are recorded and answered', () => {
  const state = {}
  const os = memory(state)
  os.mkdir('/work/.atelier', 0o755)
  os.chown('/work/.atelier', 0, 0)
  assert.throws(() => os.mkdir('/work/.atelier', 0o755), /EEXIST/)
  assert.equal(os.lstat('/work/.atelier').mode, 0o755)
  const fd = os.openDir('/work/.atelier')
  assert.equal(os.at(fd, 'last-good/i-x/rev-1'), '/work/.atelier/last-good/i-x/rev-1')
  assert.equal(os.readlinkFd(fd), '/work/.atelier')
  assert.deepEqual(state.calls.map((c) => c[0]), ['mkdir', 'chown', 'openDir'])
})

test('unprivileged(): privileged operations are skipped, never thrown', () => {
  const os = unprivileged()
  assert.equal(os.privileged, false)
  assert.deepEqual(os.chown('/nonexistent', 1, 1), { skipped: true })
  assert.deepEqual(os.chmod('/nonexistent', 0o700), { skipped: true })
  assert.deepEqual(os.setgroups([1]), { skipped: true })
})
