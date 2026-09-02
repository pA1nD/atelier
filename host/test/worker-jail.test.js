// host/worker/jail.mjs — the plan is data (DESIGN §3 rows, §6.2 round trips), asserted byte-exact.
import test from 'node:test'
import assert from 'node:assert/strict'
import { memory } from '../adapters/os.mjs'
import { jailPlan, installPlan, backupPlan, rehearsalPlan, prodPlan, applyJail, afterReady, claimRoundTrip, dataFileRoundTrip, AGENT, AGENT_DATA_GID, WORKER_UID_BASE, INSTANCE_RE } from '../worker/jail.mjs'

const spec = { instance: 'i-0123456789abcdef', uid: 20001, dataDir: '/work/.atelier/data/i-0123456789abcdef', tmpDir: '/work/.atelier/tmp/i-0123456789abcdef', sockDir: '/run/atelier/w/i-0123456789abcdef', sock: '/run/atelier/w/i-0123456789abcdef/w.sock' }

test('constants match DESIGN §2', () => {
  assert.deepEqual(AGENT, { uid: 1000, gid: 1000 })
  assert.equal(AGENT_DATA_GID, 19999)
  assert.equal(WORKER_UID_BASE, 20000)
  assert.ok(INSTANCE_RE.test('i-0123456789abcdef'))
  assert.ok(!INSTANCE_RE.test('i-0123456789ABCDEF'))
  assert.ok(!INSTANCE_RE.test('demo'))
})

test('jailPlan: data/<inst> <uid>:19999 2770, tmp/<inst> <uid>:<uid> 0700, w/<inst> 0:<uid> 0730 — mkdir → chmod (root-owned) → chown', () => {
  assert.deepEqual(jailPlan(spec), [
    { op: 'mkdir', path: spec.dataDir, mode: 0o2770 },
    { op: 'chmod', path: spec.dataDir, mode: 0o2770 },
    { op: 'chown', path: spec.dataDir, uid: 20001, gid: 19999 },
    { op: 'mkdir', path: spec.tmpDir, mode: 0o700 },
    { op: 'chmod', path: spec.tmpDir, mode: 0o700 },
    { op: 'chown', path: spec.tmpDir, uid: 20001, gid: 20001 },
    { op: 'mkdir', path: spec.sockDir, mode: 0o730 },
    { op: 'chmod', path: spec.sockDir, mode: 0o730 },
    { op: 'chown', path: spec.sockDir, uid: 0, gid: 20001 },
  ])
})

test('the release rows (DESIGN §10.3 D1): data-dev/<inst> = the jail plan on another dataDir; backup/<inst>/<id> 0:19999 0750; rehearsal/<inst> 0:<uid> 0750 + data <uid>:19999 2770; prod/<inst>/<c12> 0:<uid> 0750 — mkdir → chmod → chown', () => {
  const devSpec = { ...spec, dataDir: '/work/.atelier/data-dev/i-0123456789abcdef' }
  assert.deepEqual(jailPlan(devSpec).slice(0, 3), [
    { op: 'mkdir', path: '/work/.atelier/data-dev/i-0123456789abcdef', mode: 0o2770 },
    { op: 'chmod', path: '/work/.atelier/data-dev/i-0123456789abcdef', mode: 0o2770 },
    { op: 'chown', path: '/work/.atelier/data-dev/i-0123456789abcdef', uid: 20001, gid: 19999 },
  ])
  assert.deepEqual(backupPlan('/work/.atelier/backup/i-0123456789abcdef/20260902T104702Z-rev3-0f3c9a1b2d4e'), [
    { op: 'mkdir', path: '/work/.atelier/backup/i-0123456789abcdef/20260902T104702Z-rev3-0f3c9a1b2d4e', mode: 0o750 },
    { op: 'chmod', path: '/work/.atelier/backup/i-0123456789abcdef/20260902T104702Z-rev3-0f3c9a1b2d4e', mode: 0o750 },
    { op: 'chown', path: '/work/.atelier/backup/i-0123456789abcdef/20260902T104702Z-rev3-0f3c9a1b2d4e', uid: 0, gid: 19999 },
  ])
  assert.deepEqual(rehearsalPlan(spec, '/work/.atelier/rehearsal/i-0123456789abcdef'), [
    { op: 'mkdir', path: '/work/.atelier/rehearsal/i-0123456789abcdef', mode: 0o750 },
    { op: 'chmod', path: '/work/.atelier/rehearsal/i-0123456789abcdef', mode: 0o750 },
    { op: 'chown', path: '/work/.atelier/rehearsal/i-0123456789abcdef', uid: 0, gid: 20001 },
    { op: 'mkdir', path: '/work/.atelier/rehearsal/i-0123456789abcdef/data', mode: 0o2770 },
    { op: 'chmod', path: '/work/.atelier/rehearsal/i-0123456789abcdef/data', mode: 0o2770 },
    { op: 'chown', path: '/work/.atelier/rehearsal/i-0123456789abcdef/data', uid: 20001, gid: 19999 },
  ])
  assert.deepEqual(prodPlan(spec, '/work/.atelier/prod/i-0123456789abcdef/0f3c9a1b2d4e'), [
    { op: 'mkdir', path: '/work/.atelier/prod/i-0123456789abcdef/0f3c9a1b2d4e', mode: 0o750 },
    { op: 'chmod', path: '/work/.atelier/prod/i-0123456789abcdef/0f3c9a1b2d4e', mode: 0o750 },
    { op: 'chown', path: '/work/.atelier/prod/i-0123456789abcdef/0f3c9a1b2d4e', uid: 0, gid: 20001 },
  ])
  // every plan is chmod-then-chown on the inode root just created — no chmod after a chown anywhere
  for (const plan of [backupPlan('/b'), rehearsalPlan(spec, '/r'), prodPlan(spec, '/p')]) {
    for (let k = 0; k < plan.length; k += 3) assert.deepEqual(plan.slice(k, k + 3).map((s) => s.op), ['mkdir', 'chmod', 'chown'])
  }
})

test('installPlan: scratch/<inst> 0:<uid> 0750, home/ <uid>:<uid> 0700, build/ <uid>:<uid> 0755', () => {
  assert.deepEqual(installPlan(spec, '/proc/self/fd/3/scratch/i-0123456789abcdef'), [
    { op: 'mkdir', path: '/proc/self/fd/3/scratch/i-0123456789abcdef', mode: 0o750 },
    { op: 'chmod', path: '/proc/self/fd/3/scratch/i-0123456789abcdef', mode: 0o750 },
    { op: 'chown', path: '/proc/self/fd/3/scratch/i-0123456789abcdef', uid: 0, gid: 20001 },
    { op: 'mkdir', path: '/proc/self/fd/3/scratch/i-0123456789abcdef/home', mode: 0o700 },
    { op: 'chmod', path: '/proc/self/fd/3/scratch/i-0123456789abcdef/home', mode: 0o700 },
    { op: 'chown', path: '/proc/self/fd/3/scratch/i-0123456789abcdef/home', uid: 20001, gid: 20001 },
    { op: 'mkdir', path: '/proc/self/fd/3/scratch/i-0123456789abcdef/build', mode: 0o755 },
    { op: 'chmod', path: '/proc/self/fd/3/scratch/i-0123456789abcdef/build', mode: 0o755 },
    { op: 'chown', path: '/proc/self/fd/3/scratch/i-0123456789abcdef/build', uid: 20001, gid: 20001 },
  ])
})

test('applyJail: runs through the adapter in order, tolerates EEXIST, stops on the first other errno, logs [priv] lines', () => {
  const state = { fs: { [spec.dataDir]: { uid: 0, gid: 0, mode: 0o700, type: 'dir' } } }
  const os = memory(state)
  const lines = []
  const r = applyJail(os, jailPlan(spec), (l) => lines.push(l))
  assert.equal(r.ok, true)
  assert.equal(r.results.length, 9)
  assert.equal(r.results[0].code, 'EEXIST')                                   // pre-existing data dir: fine
  // the fake's mkdir throws EEXIST before recording: 8 recorded calls, in plan order
  assert.deepEqual(state.calls.map((c) => c[0]), ['chmod', 'chown', 'mkdir', 'chmod', 'chown', 'mkdir', 'chmod', 'chown'])
  assert.equal(state.fs[spec.dataDir].uid, 20001)
  assert.equal(state.fs[spec.dataDir].gid, 19999)
  assert.equal(state.fs[spec.dataDir].mode, 0o2770)
  assert.equal(state.fs[spec.sockDir].gid, 20001)
  assert.equal(lines[0], `[priv] mkdir ${spec.dataDir}: ok (EEXIST)`)
  assert.equal(lines[1], `[priv] chmod ${spec.dataDir}: ok`)

  // a re-spawn / resume: data and tmp already handed to the worker uid (root cannot chmod them under the
  // plan caps) → their chmod/chown are skipped; the root-owned socket dir (0710 after READY) is re-set 0730
  const again = { fs: {
    [spec.dataDir]: { uid: 20001, gid: 19999, mode: 0o2770, type: 'dir' }, [spec.tmpDir]: { uid: 20001, gid: 20001, mode: 0o700, type: 'dir' },
    [spec.sockDir]: { uid: 0, gid: 20001, mode: 0o710, type: 'dir' },
  } }
  const r2 = applyJail(memory(again), jailPlan(spec), (l) => lines.push(l))
  assert.equal(r2.ok, true)
  assert.deepEqual(again.calls.map((c) => [c[0], c[1]]), [['chmod', spec.sockDir], ['chown', spec.sockDir]])
  assert.equal(again.fs[spec.sockDir].mode, 0o730)
  assert.ok(lines.includes(`[priv] chmod ${spec.dataDir}: skipped (owned)`))
  // an existing dir with a foreign owner, or not a dir, stops the plan before any chmod
  for (const [entry, code] of [[{ uid: 20009, gid: 19999, mode: 0o2770, type: 'dir' }, 'EOWNER'], [{ uid: 1000, gid: 1000, mode: 0o777, type: 'link' }, 'ENOTDIR']]) {
    const st = { fs: { [spec.dataDir]: entry } }
    const f0 = applyJail(memory(st), jailPlan(spec))
    assert.equal(f0.ok, false); assert.equal(f0.results.at(-1).code, code); assert.equal(st.calls.length, 0)
  }

  const failing = memory({ answers: { chown: (p) => { if (p === spec.tmpDir) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) } } })
  const out = []
  const f = applyJail(failing, jailPlan(spec), (l) => out.push(l))
  assert.equal(f.ok, false)
  assert.equal(f.results.length, 6)
  assert.deepEqual(f.results.at(-1), { step: { op: 'chown', path: spec.tmpDir, uid: 20001, gid: 20001 }, ok: false, code: 'EPERM' })
  assert.equal(out.at(-1), `[priv] chown ${spec.tmpDir}: EPERM`)
})

test('afterReady: the socket becomes 0:0 0700 (chown first, chmod while root owns it); the socket dir drops the worker write bit (0710)', () => {
  const state = { fs: { [spec.sock]: { uid: 20001, gid: 20001, mode: 0o755, type: 'socket' }, [spec.sockDir]: { uid: 0, gid: 20001, mode: 0o730, type: 'dir' } } }
  const os = memory(state)
  assert.equal(afterReady(os, spec).ok, true)
  assert.deepEqual(state.calls, [['chown', spec.sock, 0, 0], ['chmod', spec.sock, 0o700], ['chmod', spec.sockDir, 0o710]])
  assert.deepEqual(state.fs[spec.sock], { uid: 0, gid: 0, mode: 0o700, type: 'socket' })
  assert.equal(state.fs[spec.sockDir].mode, 0o710)
  // jailPlan re-opens it for the next spawn
  applyJail(os, jailPlan(spec))
  assert.equal(state.fs[spec.sockDir].mode, 0o730)
})

test('claimRoundTrip §6.2(a) on an fd: setgroups([uid]) → openDir O_NOFOLLOW → fstat guard → fchown 0:<uid> → fchmod 2750 → fchown 1000:<uid> → close → groups restored', () => {
  const state = { groups: [7], fs: { '/work/apps/demo': { uid: 1000, gid: 1000, mode: 0o755, type: 'dir' } } }
  const os = memory(state)
  const r = claimRoundTrip(os, '/work/apps/demo', 20001)
  assert.equal(r.ok, true)
  assert.deepEqual(state.calls, [
    ['setgroups', [20001]],
    ['openDir', '/work/apps/demo', 3],
    ['fchown', 3, 0, 20001],
    ['fchmod', 3, 0o2750],
    ['fchown', 3, 1000, 20001],
    ['closeFd', 3],
    ['setgroups', [7]],
  ])
  assert.deepEqual(state.fs['/work/apps/demo'], { uid: 1000, gid: 20001, mode: 0o2750, type: 'dir' })
  assert.deepEqual(os.getgroups(), [7])
  // a re-claim of an already-claimed folder (1000:<uid>) passes the guard the same way
  assert.equal(claimRoundTrip(memory({ fs: { '/work/apps/demo': { uid: 1000, gid: 20001, mode: 0o2750, type: 'dir' } } }), '/work/apps/demo', 20001).ok, true)
})

test('claimRoundTrip refuses what is not the agent\'s directory: a planted symlink (ELOOP), a root-owned inode swapped in (EOWNER), a file (ENOTDIR) — nothing is chowned, groups restored', () => {
  for (const [entry, code] of [
    [{ uid: 1000, gid: 1000, mode: 0o777, type: 'link' }, 'ELOOP'],
    [{ uid: 0, gid: 0, mode: 0o400, type: 'dir' }, 'EOWNER'],
    [{ uid: 1000, gid: 1000, mode: 0o644, type: 'file' }, 'ENOTDIR'],
    [{ uid: 1000, gid: 20009, mode: 0o2750, type: 'dir' }, 'EOWNER'],     // another app's gid
  ]) {
    const state = { groups: [], fs: { '/work/apps/demo': { ...entry } } }
    const os = memory(state)
    const lines = []
    const r = claimRoundTrip(os, '/work/apps/demo', 20001, (l) => lines.push(l))
    assert.equal(r.ok, false, code)
    assert.equal(r.results.at(-1).code, code)
    assert.equal(state.calls.some((c) => c[0] === 'fchown' || c[0] === 'fchmod' || c[0] === 'chown' || c[0] === 'chmod'), false, `${code}: no ownership call`)
    assert.deepEqual(state.fs['/work/apps/demo'], entry, `${code}: untouched`)
    assert.deepEqual(os.getgroups(), [], `${code}: groups restored`)
    assert.match(lines.at(-1), new RegExp(`/work/apps/demo: ${code}$`))
  }
})

test('dataFileRoundTrip §6.2(b) on an fd: an agent-created 0644 -wal becomes <uid>:19999 0660; a symlink, a hard link or a foreign owner is refused', () => {
  const state = { fs: { '/d/app.db-wal': { uid: 1000, gid: 19999, mode: 0o644, type: 'file' } } }
  const os = memory(state)
  assert.equal(dataFileRoundTrip(os, '/d/app.db-wal', 20001).ok, true)
  assert.deepEqual(state.calls, [
    ['openFile', '/d/app.db-wal', 3],
    ['fchown', 3, 0, 19999],
    ['fchmod', 3, 0o660],
    ['fchown', 3, 20001, 19999],
    ['closeFd', 3],
  ])
  assert.deepEqual(state.fs['/d/app.db-wal'], { uid: 20001, gid: 19999, mode: 0o660, type: 'file' })
  assert.equal(dataFileRoundTrip(memory({ fs: { '/d/x': { uid: 1000, gid: 19999, mode: 0o644, type: 'link' } } }), '/d/x', 20001).results.at(-1).code, 'ELOOP')
  assert.equal(dataFileRoundTrip(memory({ fs: { '/d/x': { uid: 1000, gid: 19999, mode: 0o644, type: 'file', nlink: 2 } } }), '/d/x', 20001).results.at(-1).code, 'EMLINK')
  assert.equal(dataFileRoundTrip(memory({ fs: { '/d/x': { uid: 0, gid: 0, mode: 0o644, type: 'file' } } }), '/d/x', 20001).results.at(-1).code, 'EOWNER')
  assert.equal(dataFileRoundTrip(memory({}), '/d/none', 20001).results.at(-1).code, 'ENOENT')
})
