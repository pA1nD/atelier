// host/supervisor/slots.mjs — the pure rows of the release layout: the backup id (ISO basic, parsed back), the pruning
// rule (3 kept / ≤ 1 GiB, the newest always), the feasibility refusal, the root+19999 specs, the export walk.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { memory } from '../adapters/os.mjs'
import { backupId, parseBackupId, BACKUP_ID_RE, pruneBackups, backupFeasible, copySpecs, rmSpec, duSpec, lsSpec, extractSpec, ownTree, sockName, commit12, REL, mkSlot, mb } from '../supervisor/slots.mjs'

test('backupId = <YYYYMMDDTHHMMSSZ>-rev<N>-<c12> (34 chars), parsed back to {at, rev, commit}; a slash or a stray form never parses', () => {
  const id = backupId(Date.UTC(2026, 8, 2, 10, 47, 2, 345), 3, '0f3c9a1b2d4e0000000000000000000000000000')
  assert.equal(id, '20260902T104702Z-rev3-0f3c9a1b2d4e'); assert.equal(id.length, 34); assert.ok(BACKUP_ID_RE.test(id))
  assert.deepEqual(parseBackupId(id), { at: Date.UTC(2026, 8, 2, 10, 47, 2), rev: 3, commit: '0f3c9a1b2d4e' })
  assert.equal(backupId(0, 0, null), '19700101T000000Z-rev0-none'); assert.deepEqual(parseBackupId('19700101T000000Z-rev0-none'), { at: 0, rev: 0, commit: null })
  for (const bad of ['../x', '20260902T104702Z-rev3-0f3c9a1b2d4e/..', '2026-09-02T10:47:02Z-rev3-0f3c', 'x', '']) assert.equal(parseBackupId(bad), null, bad)
  assert.equal(sockName('prod', 4), 'w-prod-4.sock'); assert.equal(sockName('dev', 4), 'w-dev-4.sock'); assert.equal(sockName('rehearsal', 4), 'w-rehearsal-4.sock')
  assert.equal(commit12('0f3c9a1b2d4e0000000000000000000000000000'), '0f3c9a1b2d4e')
  assert.equal(REL.prodExport('i-0123456789abcdef', '0f3c9a1b2d4e0000000000000000000000000000'), 'prod/i-0123456789abcdef/0f3c9a1b2d4e')
  assert.equal(REL.devData('i-x'), 'data-dev/i-x'); assert.equal(REL.backup('i-x', 'b'), 'backup/i-x/b'); assert.equal(REL.rehearsalData('i-x'), 'rehearsal/i-x/data')
  const s = mkSlot('prod', { appDir: '/e', dataDir: '/d', rev: 2, commit: 'c' })
  assert.equal(s.state, 'stopped'); assert.equal(mkSlot('dev', { appDir: '/a', dataDir: '/d' }).state, 'loading'); assert.equal(s.gate, null); assert.equal(s.inflight, 0)
})

test('pruneBackups (D11): the newest 3 stay; past 1 GiB the oldest go first; the newest is always kept; backupFeasible refuses > 1 GiB or free < 2×', () => {
  const G = 1024 * 1024 * 1024
  const rows = [1, 2, 3, 4, 5].map((n) => ({ id: `b${n}`, at: n * 1000, bytes: 100 }))
  assert.deepEqual(pruneBackups(rows).sort(), ['b1', 'b2'])
  assert.deepEqual(pruneBackups(rows.slice(0, 3)), [])
  assert.deepEqual(pruneBackups([{ id: 'a', at: 1, bytes: 0.6 * G }, { id: 'b', at: 2, bytes: 0.6 * G }, { id: 'c', at: 3, bytes: 0.6 * G }]).sort(), ['a', 'b'])
  assert.deepEqual(pruneBackups([{ id: 'a', at: 1, bytes: 2 * G }]), [], 'the newest one is always kept, however big')
  assert.deepEqual(pruneBackups([{ id: 'old', at: 1, bytes: 0.9 * G }, { id: 'new', at: 2, bytes: 0.9 * G }]), ['old'])
  assert.deepEqual(pruneBackups([]), [])
  assert.equal(backupFeasible({ dataBytes: 10 * 1024 * 1024, freeBytes: 100 * 1024 * 1024 }), null)
  assert.equal(backupFeasible({ dataBytes: 1.4 * G, freeBytes: 100 * G }), 'prod data is 1433.6 MB (> 1024 MB cap)')
  assert.equal(backupFeasible({ dataBytes: 100 * 1024 * 1024, freeBytes: 150 * 1024 * 1024 }), 'free space 150 MB < 2× the data (100 MB)')
  assert.equal(backupFeasible({ dataBytes: 100, freeBytes: null }), null, 'no statfs → no free-space verdict')
  assert.equal(mb(12582912), 12)
})

test('the root+19999 specs (cp -a / rm -rf / du -sk) and row T (tar -x as root, stdin = the archive); ownTree = chmod-then-chown 0:<uid> over what tar left (dirs 0750, files 0640, symlinks lchown only)', () => {
  for (const s of [...copySpecs('/a', '/b', { uid: 20001, hostEnv: { PATH: '/p' }, gnu: false }), ...copySpecs('/a', '/b', { uid: 20001, hostEnv: { PATH: '/p' }, gnu: true }), rmSpec('/a', { PATH: '/p' }), duSpec('/a', { PATH: '/p' }), lsSpec('/a', { PATH: '/p' })]) {
    assert.equal(s.uid, 0); assert.equal(s.gid, 0); assert.deepEqual(s.groups, [19999]); assert.deepEqual(s.env, { PATH: '/p' }); assert.equal(s.cwd, '/'); assert.deepEqual(s.stdio, ['ignore', 'pipe', 'pipe'])
  }
  assert.deepEqual(copySpecs('/a', '/b', { uid: 20001, hostEnv: { PATH: '/p' }, gnu: false }).map((x) => x.argv), [['cp', '-a', '--', '/a/.', '/b']])
  // the fleet (GNU cp): never --preserve=ownership (cp creates each inode without its g/o bits and chmods them back AFTER the
  // chown — EPERM without CAP_FOWNER); umask 007 → 0660/0770 at creation, then ONE chown pass over the contents (CAP_CHOWN)
  const g = copySpecs('/a', '/b', { uid: 20001, hostEnv: { PATH: '/p' }, gnu: true })
  assert.deepEqual(g.map((x) => x.argv), [['cp', '-dR', '--', '/a/.', '/b'], ['find', '/b', '-mindepth', '1', '-exec', 'chown', '-h', '20001:19999', '{}', '+']], 'no --preserve=timestamps either: cp would utimensat the destination dir itself (a <uid> inode) — EPERM without FOWNER')
  assert.equal(g[0].umask, 0o007); assert.deepEqual(g[0].groups, [19999]); assert.deepEqual(g[1].groups, [19999])
  assert.deepEqual(copySpecs('/a', '/b', { uid: 20001, gnu: true, privileged: false }).map((x) => x.argv[0]), ['cp'], 'unprivileged (the same user copies): no chown pass')
  assert.equal(copySpecs('/a', '/b', { uid: 1 })[0].argv.includes('-a'), process.platform !== 'linux')
  assert.deepEqual(rmSpec('/a', { PATH: '/p' }).argv, ['rm', '-rf', '--', '/a'])
  assert.deepEqual(duSpec('/a', { PATH: '/p' }).argv, ['du', '-s', '-k', '--', '/a'])
  assert.deepEqual(lsSpec('/a', { PATH: '/p' }).argv, ['find', '/a', '-mindepth', '1', '-maxdepth', '1', '-print', '-quit'], 'root cannot readdir a 2770 data dir: the has-entries question is a root+19999 child')
  const t = extractSpec('/work/.atelier/prod/i-x/0f3c9a1b2d4e.tmp', { PATH: '/p' })
  assert.deepEqual(t, { argv: ['tar', '-x', '-C', '/work/.atelier/prod/i-x/0f3c9a1b2d4e.tmp', '-f', '-'], env: { PATH: '/p' }, cwd: '/', uid: 0, gid: 0, groups: [], umask: 0o077, stdio: ['pipe', 'pipe', 'pipe'] })
  const state = {}
  const os = memory(state)
  assert.deepEqual(os.spawn(copySpecs('/a', '/b', { uid: 20001, hostEnv: { PATH: '/p' }, gnu: false })[0]).argv.slice(0, 9), ['sh', '-c', 'umask 22; exec "$@"', 'sh', 'setpriv', '--reuid=0', '--regid=0', '--groups=19999', '--'])
  assert.deepEqual(os.spawn(copySpecs('/a', '/b', { uid: 20001, hostEnv: { PATH: '/p' }, gnu: true })[0]).argv.slice(0, 9), ['sh', '-c', 'umask 7; exec "$@"', 'sh', 'setpriv', '--reuid=0', '--regid=0', '--groups=19999', '--'])
  // ownTree on a real tree with a recording adapter: every inode chmod BEFORE chown, dirs after their children
  const root = fs.mkdtempSync('/tmp/own-')
  fs.mkdirSync(path.join(root, 'sub')); fs.writeFileSync(path.join(root, 'a.js'), '1'); fs.writeFileSync(path.join(root, 'sub', 'b.js'), '2'); fs.symlinkSync('a.js', path.join(root, 'link'))
  const calls = []
  const rec = { chmod: (p, m) => calls.push(['chmod', path.relative(root, p) || '.', m]), chown: (p, u, g) => calls.push(['chown', path.relative(root, p) || '.', u, g]), lchown: (p, u, g) => calls.push(['lchown', path.relative(root, p) || '.', u, g]) }
  assert.equal(ownTree(rec, fs, root, 20001), 5)
  const idx = (op, p) => calls.findIndex((c) => c[0] === op && c[1] === p)
  for (const p of ['a.js', 'sub/b.js', 'sub', '.']) assert.ok(idx('chmod', p) >= 0 && idx('chown', p) > idx('chmod', p), p)
  assert.ok(idx('chown', 'sub/b.js') < idx('chown', 'sub'), 'children before the dir')
  assert.deepEqual(calls.find((c) => c[1] === 'link'), ['lchown', 'link', 0, 20001])
  assert.deepEqual(calls.filter((c) => c[0] === 'chmod').map((c) => [c[1], c[2]]).sort(), [['.', 0o750], ['a.js', 0o640], ['sub', 0o750], ['sub/b.js', 0o640]].sort())
  assert.ok(calls.filter((c) => c[0] === 'chown' || c[0] === 'lchown').every((c) => c[2] === 0 && c[3] === 20001))
  fs.rmSync(root, { recursive: true, force: true })
})
