// host/worker/jail.mjs — the plan is data (DESIGN §3 rows, §6.2 round trips), asserted byte-exact.
import test from 'node:test'
import assert from 'node:assert/strict'
import { memory } from '../adapters/os.mjs'
import { jailPlan, installPlan, applyJail, afterReady, claimRoundTrip, dataFileRoundTrip, AGENT, AGENT_DATA_GID, WORKER_UID_BASE, INSTANCE_RE } from '../worker/jail.mjs'

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

  const failing = memory({ answers: { chown: (p) => { if (p === spec.tmpDir) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) } } })
  const out = []
  const f = applyJail(failing, jailPlan(spec), (l) => out.push(l))
  assert.equal(f.ok, false)
  assert.equal(f.results.length, 6)
  assert.deepEqual(f.results.at(-1), { step: { op: 'chown', path: spec.tmpDir, uid: 20001, gid: 20001 }, ok: false, code: 'EPERM' })
  assert.equal(out.at(-1), `[priv] chown ${spec.tmpDir}: EPERM`)
})

test('afterReady: the socket becomes 0:0 0700 (chown first, chmod while root owns it)', () => {
  const state = { fs: { [spec.sock]: { uid: 20001, gid: 20001, mode: 0o755, type: 'socket' } } }
  const os = memory(state)
  assert.equal(afterReady(os, spec).ok, true)
  assert.deepEqual(state.calls, [['chown', spec.sock, 0, 0], ['chmod', spec.sock, 0o700]])
  assert.deepEqual(state.fs[spec.sock], { uid: 0, gid: 0, mode: 0o700, type: 'socket' })
})

test('claimRoundTrip §6.2(a): chown 0:<uid> → setgroups([uid]) → chmod 2750 → chown 1000:<uid> → groups restored', () => {
  const state = { groups: [7], fs: { '/work/apps/demo': { uid: 1000, gid: 1000, mode: 0o755, type: 'dir' } } }
  const os = memory(state)
  const r = claimRoundTrip(os, '/work/apps/demo', 20001)
  assert.equal(r.ok, true)
  assert.deepEqual(state.calls, [
    ['chown', '/work/apps/demo', 0, 20001],
    ['setgroups', [20001]],
    ['chmod', '/work/apps/demo', 0o2750],
    ['chown', '/work/apps/demo', 1000, 20001],
    ['setgroups', [7]],
  ])
  assert.deepEqual(state.fs['/work/apps/demo'], { uid: 1000, gid: 20001, mode: 0o2750, type: 'dir' })
  assert.deepEqual(os.getgroups(), [7])
})

test('dataFileRoundTrip §6.2(b): an agent-created 0644 -wal becomes <uid>:19999 0660 via root', () => {
  const state = { fs: { '/d/app.db-wal': { uid: 1000, gid: 19999, mode: 0o644, type: 'file' } } }
  const os = memory(state)
  assert.equal(dataFileRoundTrip(os, '/d/app.db-wal', 20001).ok, true)
  assert.deepEqual(state.calls, [
    ['chown', '/d/app.db-wal', 0, 19999],
    ['chmod', '/d/app.db-wal', 0o660],
    ['chown', '/d/app.db-wal', 20001, 19999],
  ])
})
