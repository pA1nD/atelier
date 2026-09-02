// supervisor/lastgood.mjs — rev dirs written tmp → fsync → rename, `current` swap, checksum,
// previous kept, prune, ownership calls (chmod before chown, through the adapter), the rev
// counter persisted before the build, boot listing, row G git spec (DESIGN §3, §6.1, §8.1).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unprivileged, memory } from '../adapters/os.mjs'
import { createStore, gitInit, commitAll, resolveCommit, gitSpec, gitignoreSpec, archiveSpec, GITIGNORE, INSTANCE_RE } from '../supervisor/lastgood.mjs'

const INST = 'i-0123456789abcdef'
function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sup-lg-')))
  const dot = path.join(root, '.atelier')
  fs.mkdirSync(path.join(dot, 'last-good'), { recursive: true })
  const calls = []
  const base = unprivileged()
  const osx = { ...base, chown: (p, u, g) => { calls.push(['chown', path.relative(dot, p), u, g]); return base.chown(p, u, g) }, chmod: (p, m) => { calls.push(['chmod', path.relative(dot, p), m]); return base.chmod(p, m) }, now: () => 1_700_000_000_000 }
  const dirfd = osx.openDir(dot)
  const store = createStore({ os: osx, dirfd, hostVersion: 'test' })
  return { root, dot, osx, dirfd, store, calls, done: () => { osx.closeFd(dirfd); fs.rmSync(root, { recursive: true, force: true }) } }
}

test('write → commit: rev dir renamed into place, files in place, checksum, revision.json + current; previous kept; prune', () => {
  const s = setup()
  s.store.ensure(INST, 20001)
  assert.equal(s.store.revision(INST), null)
  assert.equal(s.store.current(INST), null)
  const r1 = s.store.nextRev(INST)
  assert.equal(r1, 1)
  assert.equal(s.store.revision(INST).rev, 1, 'the counter is persisted before anything is built')
  assert.equal((fs.statSync(path.join(s.dot, INST, 'revision.json')).mode & 0o777), 0o600, 'markers are the host\'s alone')
  const fe = new Map([['frontend.js', 'export default 1'], ['views/deep.js', 'export const d = 1']])
  const w1 = s.store.write(INST, 1, 20001, { backend: 'export default {}', map: '{"version":3}', frontend: fe, css: '.a{}' })
  assert.equal(w1.dir, path.join(s.dot, 'last-good', INST, 'rev-1'))
  assert.deepEqual(fs.readdirSync(w1.dir).sort(), ['backend.js', 'backend.js.map', 'frontend', 'styles.css'])
  assert.equal(fs.readFileSync(path.join(w1.dir, 'frontend', 'views', 'deep.js'), 'utf8'), 'export const d = 1')
  assert.equal(fs.readdirSync(path.join(s.dot, 'last-good', INST)).filter((n) => n.includes('tmp')).length, 0, 'no tmp dir left behind')
  assert.match(w1.sha256, /^[0-9a-f]{64}$/)
  assert.equal(w1.bytes, 'export default {}'.length + '{"version":3}'.length + 'export default 1'.length + 'export const d = 1'.length + 4)
  // the DEV commit moves `current-dev` and `live`; `current` (prod) stays unset until commitProd (D4)
  s.store.commit(INST, 1, { slug: 'alpha', sha256: w1.sha256, bytes: w1.bytes, fingerprint: 'fp1', chrome: 'chrome' })
  const rev = s.store.revision(INST)
  assert.equal(rev.rev, 1); assert.equal(rev.live, 1); assert.equal(rev.sha256, w1.sha256); assert.equal(rev.fingerprint, 'fp1'); assert.equal(rev.host, 'test'); assert.equal(rev.protocol, 'atelier/2'); assert.equal(rev.builtAt, '2023-11-14T22:13:20.000Z'); assert.equal(rev.prod, undefined)
  assert.deepEqual(s.store.currentDev(INST), { rev: 1, dir: w1.dir })
  assert.equal(s.store.current(INST), null)
  assert.equal(fs.readlinkSync(path.join(s.dot, INST, 'current-dev')), `../last-good/${INST}/rev-1`)
  assert.equal(fs.readFileSync(path.join(s.dot, INST, 'current-dev', 'styles.css'), 'utf8'), '.a{}', 'the symlink resolves relative to the marker dir')
  // a FAILED build bumps the counter, the pointers/live stay
  assert.equal(s.store.nextRev(INST), 2)
  assert.equal(s.store.revision(INST).live, 1)
  assert.equal(s.store.currentDev(INST).rev, 1)
  // the PROD release: revision.json.prod + `current`; the dev pointer untouched; the counter bumped to the release's rev
  s.store.commitProd(INST, 2, { commit: 'a'.repeat(40), message: 'first release' })
  assert.deepEqual(s.store.revision(INST).prod, { rev: 2, commit: 'a'.repeat(40), deployedAt: '2023-11-14T22:13:20.000Z', message: 'first release' })
  assert.equal(s.store.revision(INST).live, 1); assert.equal(s.store.revision(INST).rev, 2)
  assert.equal(fs.readlinkSync(path.join(s.dot, INST, 'current')), `../last-good/${INST}/rev-2`)
  assert.equal(s.store.current(INST), null, 'a pointer to a rev dir that does not exist answers null')
  s.store.commitProd(INST, 1, { commit: 'b'.repeat(40), legacy: true })
  assert.deepEqual(s.store.current(INST), { rev: 1, dir: w1.dir }); assert.equal(s.store.revision(INST).prod.legacy, true)
  // the next dev LIVE rev: previous kept, current-dev swapped, `current` stays on the release, same checksum for the same bytes
  assert.equal(s.store.nextRev(INST), 3)
  const w3 = s.store.write(INST, 3, 20001, { backend: 'export default {}', map: '{"version":3}', frontend: fe, css: '.a{}' })
  assert.equal(w3.sha256, w1.sha256)
  s.store.commit(INST, 3, { slug: 'alpha', sha256: w3.sha256, bytes: w3.bytes })
  assert.equal(s.store.currentDev(INST).rev, 3); assert.equal(s.store.current(INST).rev, 1)
  assert.equal(s.store.revision(INST).prod.rev, 1, 'a dev commit never touches the prod block')
  s.store.link(INST, 'current', 3)
  assert.equal(s.store.current(INST).rev, 3)
  assert.deepEqual(s.store.list(INST), [1, 3])
  assert.equal(s.store.read(INST, 1, 'styles.css').toString(), '.a{}')
  assert.equal(s.store.read(INST, 3, 'frontend/frontend.js').toString(), 'export default 1')
  assert.equal(s.store.read(INST, 3, '../rev-1/styles.css'), null, 'no escape from the rev dir')
  assert.equal(s.store.read(INST, 9, 'styles.css'), null)
  s.store.remove(INST, 1)
  assert.deepEqual(s.store.list(INST), [3])
  fs.mkdirSync(path.join(s.dot, 'last-good', INST, 'rev-9.tmp-4242')); fs.mkdirSync(path.join(s.dot, 'last-good', INST, 'rev-x'))
  assert.deepEqual(s.store.sweepTmp(INST), ['rev-9.tmp-4242'])
  assert.deepEqual(fs.readdirSync(path.join(s.dot, 'last-good', INST)).sort(), ['rev-3', 'rev-x'])
  assert.deepEqual(s.store.instances(), [INST])
  s.store.writeMarker(INST, 'slug', 'alpha')
  assert.equal(s.store.readMarker(INST, 'slug'), 'alpha')
  assert.equal(s.store.readMarker(INST, 'nope'), null)
  s.done()
})

test('ownership: every rev inode is chmod-then-chown 0:<uid> through the adapter (0750 dirs, 0640 files); markers 0711/0600', () => {
  const s = setup()
  s.store.ensure(INST, 20001)
  assert.deepEqual(s.calls, [['chmod', INST, 0o711], ['chmod', `last-good/${INST}`, 0o750], ['chown', `last-good/${INST}`, 0, 20001]])
  s.calls.length = 0
  s.store.ensure(INST, 20001)
  assert.deepEqual(s.calls, [], 'EEXIST: nothing re-owned')
  s.store.write(INST, 1, 20001, { backend: 'b', frontend: new Map([['x/y.js', 'y']]), css: 'c' })
  const tmp = `last-good/${INST}/rev-1.tmp-${process.pid}`
  const chmodBeforeChown = (p) => { const i = s.calls.findIndex((c) => c[0] === 'chmod' && c[1] === p), j = s.calls.findIndex((c) => c[0] === 'chown' && c[1] === p); assert.ok(i >= 0 && j > i, p) }
  for (const p of [tmp, `${tmp}/backend.js`, `${tmp}/frontend/x/y.js`, `${tmp}/styles.css`, `${tmp}/frontend`, `${tmp}/frontend/x`]) chmodBeforeChown(p)
  assert.deepEqual(s.calls.filter((c) => c[0] === 'chmod').map((c) => c[2]).sort(), [0o640, 0o640, 0o640, 0o750, 0o750, 0o750].sort())
  assert.ok(s.calls.filter((c) => c[0] === 'chown').every((c) => c[2] === 0 && c[3] === 20001))
  assert.ok(!s.calls.some((c) => c[1].endsWith('rev-1') && !c[1].includes('tmp')), 'ownership is set on the tmp tree, the rename carries it')
  s.calls.length = 0
  s.store.writeMarker(INST, 'slug', 'alpha')
  assert.deepEqual(s.calls, [['chmod', `${INST}/slug`, 0o600]])
  s.done()
})

test('fsync + rename: the final rev dir never exists half-written; a leftover tmp from a crash is replaced', () => {
  const s = setup()
  s.store.ensure(INST, 20001)
  const tmp = path.join(s.dot, 'last-good', INST, `rev-1.tmp-${process.pid}`)
  fs.mkdirSync(tmp, { recursive: true }); fs.writeFileSync(path.join(tmp, 'garbage'), 'x')
  const seen = []
  const realFsync = fs.fsyncSync
  fs.fsyncSync = (fd) => { seen.push(fd); return realFsync(fd) }
  try { s.store.write(INST, 1, 20001, { backend: 'b', frontend: new Map(), css: 'c' }) } finally { fs.fsyncSync = realFsync }
  assert.ok(seen.length >= 4, `fsync per file + the dir + the parent (${seen.length})`)
  assert.deepEqual(fs.readdirSync(path.join(s.dot, 'last-good', INST, 'rev-1')).sort(), ['backend.js', 'styles.css'])
  assert.ok(!fs.existsSync(tmp))
  s.done()
})

test('git as uid 1000 (row G): gitInit = init -q + .gitignore (noclobber, D7); commitAll = add -A + commit -m + HEAD; resolveCommit; archiveSpec (row A) — exact specs, never fatal', async () => {
  const state = {}
  const mem = memory(state)
  const tick = () => new Promise((r) => setImmediate(r))
  const p = gitInit({ os: mem, appDir: '/work/apps/alpha', home: '/work' })
  await tick()
  const spawned = state.spawned
  assert.deepEqual(spawned[0].spec, { argv: ['git', '-C', '/work/apps/alpha', 'init', '-q'], uid: 1000, gid: 1000, groups: [], env: { PATH: process.env.PATH, HOME: '/work', GIT_AUTHOR_NAME: 'atelier', GIT_AUTHOR_EMAIL: 'atelier@local', GIT_COMMITTER_NAME: 'atelier', GIT_COMMITTER_EMAIL: 'atelier@local' }, umask: 0o022, cwd: '/work/apps/alpha', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.deepEqual(spawned[0].argv.slice(0, 9), ['sh', '-c', 'umask 22; exec "$@"', 'sh', 'setpriv', '--reuid=1000', '--regid=1000', '--clear-groups', '--'])
  spawned[0].exit(0); await tick()
  // .gitignore as uid 1000 with `set -C` (O_EXCL): data/, .env, .env.*, node_modules/, CLAIM-REFUSED.txt, .atelier — the agent's own file is never overwritten
  assert.deepEqual(spawned[1].spec.argv, ['sh', '-c', 'set -C; printf %s "$2" > "$1/.gitignore" 2>/dev/null || true', 'sh', '/work/apps/alpha', 'data/\n.env\n.env.*\nnode_modules/\nCLAIM-REFUSED.txt\n.atelier\n'])
  assert.equal(GITIGNORE, 'data/\n.env\n.env.*\nnode_modules/\nCLAIM-REFUSED.txt\n.atelier\n')
  assert.equal(spawned[1].spec.uid, 1000); assert.deepEqual(spawned[1].spec.groups, [])
  spawned[1].exit(0)
  assert.deepEqual(await p, { ok: true })
  // commitAll: add → commit -q -m → rev-parse HEAD; `nothing to commit` = ok with the HEAD (noop)
  const c = commitAll({ os: mem, appDir: '/work/apps/alpha', message: 'first release', home: '/work' })
  await tick()
  assert.deepEqual(spawned[2].spec.argv, ['git', '-C', '/work/apps/alpha', 'add', '-A', '.'])
  spawned[2].exit(0); await tick()
  assert.deepEqual(spawned[3].spec.argv, ['git', '-C', '/work/apps/alpha', 'commit', '-q', '-m', 'first release'])
  spawned[3].stdout.emit('data', 'nothing to commit, working tree clean'); spawned[3].exit(1); await tick()
  assert.deepEqual(spawned[4].spec.argv, ['git', '-C', '/work/apps/alpha', 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  spawned[4].stdout.emit('data', 'a'.repeat(40) + '\n'); spawned[4].exit(0)
  assert.deepEqual(await c, { ok: true, commit: 'a'.repeat(40), noop: true })
  // a failing add is a step, not a throw
  const lines = []
  const c2 = commitAll({ os: mem, appDir: '/work/apps/alpha', message: 'x', log: (l) => lines.push(l) })
  await tick()
  spawned[5].stderr.emit('data', 'fatal: not a git repository'); spawned[5].exit(128)
  assert.deepEqual(await c2, { ok: false, step: 'add', error: 'fatal: not a git repository' })
  assert.match(lines[0], /^git add in \/work\/apps\/alpha: rc=128 fatal/)
  // resolveCommit: a ref is a plain hex/name, never an option; an unresolvable one is a refusal
  assert.deepEqual(await resolveCommit({ os: mem, appDir: '/a', ref: '--output=/x' }), { ok: false, step: 'rev-parse', error: "bad commit '--output=/x'" })
  const r = resolveCommit({ os: mem, appDir: '/a', ref: '0f3c9a1' })
  await tick()
  assert.deepEqual(spawned[6].spec.argv, ['git', '-C', '/a', 'rev-parse', '--verify', '--quiet', '0f3c9a1^{commit}'])
  spawned[6].exit(1)
  assert.deepEqual(await r, { ok: false, step: 'rev-parse', error: "unknown commit '0f3c9a1'" })
  // row A: git archive as uid 1000, stdout piped (the tar side is slots.mjs extractSpec, root)
  const a = archiveSpec({ appDir: '/work/apps/alpha', commit: 'a'.repeat(40), home: '/work' })
  assert.deepEqual(a.argv, ['git', '-C', '/work/apps/alpha', 'archive', '--format=tar', 'a'.repeat(40)])
  assert.equal(a.uid, 1000); assert.deepEqual(a.groups, []); assert.deepEqual(a.stdio, ['ignore', 'pipe', 'pipe']); assert.equal(a.env.HOME, '/work')
  assert.equal(gitSpec({ appDir: '/a', args: ['x'] }).groups.length, 0)
  assert.equal(gitignoreSpec({ appDir: '/a' }).uid, 1000)
  assert.ok(INSTANCE_RE.test('i-0123456789abcdef') && !INSTANCE_RE.test('i-xyz'))
})
