// supervisor/deploy.mjs `seeded` + supervisor/index.mjs scan (DESIGN §10.3 "seeded rows"; the 2026-09-02 incident): a folder
// carrying `.atelier-seeded` — the system host's `home` and `catalyst-chrome`, put there by the image at boot — is the release:
// PROD built from the folder on the first scan, the worker started at once, the content id as the commit, ONE adopt row +
// ONE modulesChanged, no dev slot, no `(dev)` line, no watcher; the dev idle window (D18) passes and prod still serves; a
// second host life announces and never rebuilds; a re-seed (new bytes) is a new rev; a broken seeded folder is one rev and one
// report, not one per sweep; a normal folder beside it boots dev-only exactly as before. Plus `treeId` itself.
import test from 'node:test'
import assert from 'node:assert/strict'
import { world, api, waitFor, sleep, makeSpawn, APP_JSON, BACKEND, fs, path, os } from './supervisor-harness.test.js'
import { treeId } from '../supervisor/watcher.mjs'
import { SEEDED_MARKER } from '../supervisor/discovery.mjs'

const prod = { slot: 'prod' }
const HEX40 = /^[0-9a-f]{40}$/
const dot = (w, ...p) => path.join(w.work, '.atelier', ...p)
const revJson = (w, inst) => JSON.parse(fs.readFileSync(dot(w, inst, 'revision.json'), 'utf8'))

test('treeId: 40 hex over the CONTENT of the fingerprint\'s set plus the manifests — the same bytes give the same id whatever the mtimes; a changed byte, a new file, a renamed file and (S3) a changed package.json or lockfile move it; dotfiles, data/, node_modules/, _* and CLAIM-REFUSED.txt do not; null for a missing folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-id-'))
  const a = path.join(root, 'a'), b = path.join(root, 'b')
  const write = (d, files) => { for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c) } }
  try {
    write(a, { 'module.json': '{"name":"A"}', 'backend.js': 'export default {}', 'frontend/app.jsx': '<div/>', 'fonts/x.woff2': 'BIN' })
    const id = treeId(a)
    assert.match(id, HEX40)
    // a copy with other mtimes: the same id (every `cp` rewrites mtimes; the fingerprint would differ)
    write(b, { 'module.json': '{"name":"A"}', 'backend.js': 'export default {}', 'frontend/app.jsx': '<div/>', 'fonts/x.woff2': 'BIN' })
    const past = new Date(Date.now() - 86_400_000)
    for (const f of ['module.json', 'backend.js', 'frontend/app.jsx']) fs.utimesSync(path.join(b, f), past, past)
    assert.equal(treeId(b), id)
    // excluded rows never move it
    write(b, { '.atelier-seeded': 'x', '.image-stamp': 'abc', 'data/db.sqlite': 'rows', 'node_modules/dep/index.js': 'x', 'CLAIM-REFUSED.txt': 'no', '_scratch/x.txt': 'y' })
    assert.equal(treeId(b), id)
    // the manifests do (S3): a re-seed that bumps only a dependency is a new rev — the watcher's fingerprint leaves them out
    // (their change is its install trigger), the content id does not
    write(b, { 'package.json': '{"dependencies":{"left-pad":"1"}}' })
    const idm = treeId(b); assert.match(idm, HEX40); assert.notEqual(idm, id)
    write(b, { 'package-lock.json': '{"lockfileVersion":3}' })
    assert.notEqual(treeId(b), idm)
    fs.unlinkSync(path.join(b, 'package.json')); fs.unlinkSync(path.join(b, 'package-lock.json'))
    assert.equal(treeId(b), id)
    // content does
    fs.writeFileSync(path.join(b, 'backend.js'), 'export default {}\n')
    const id2 = treeId(b); assert.match(id2, HEX40); assert.notEqual(id2, id)
    fs.writeFileSync(path.join(b, 'backend.js'), 'export default {}')
    assert.equal(treeId(b), id)
    fs.writeFileSync(path.join(b, 'extra.js'), '')
    assert.notEqual(treeId(b), id)
    fs.renameSync(path.join(b, 'extra.js'), path.join(b, 'extra2.js'))
    assert.notEqual(treeId(b), id)
    assert.equal(treeId(path.join(root, 'missing')), null)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a seeded folder boots as PROD from the folder: no dev slot, no `(dev)` line, no watcher, the content id is the commit, ONE adopt row (ms `at`) + ONE modulesChanged; the dev idle window passes and prod still serves; a re-seed is a new rev; a second host life announces and never rebuilds; a normal folder beside it boots dev-only as before', async () => {
  const w = world({ seededApps: true })   // gitCommit false — the system host has no git; seededApps — its ATELIER_SEEDED_APPS=1
  const dir = w.app('home', { 'module.json': APP_JSON('Home'), 'backend.js': BACKEND(1), 'logo.svg': '<svg/>', [SEEDED_MARKER]: '', '.image-stamp': 'deadbeef' })
  w.app('plain', { 'module.json': APP_JSON('Plain'), 'backend.js': BACKEND(1) })
  let sup = w.make({ timing: { devIdleMs: 300, idleMs: 60_000 } })
  const id = treeId(dir)
  try {
    await sup.scan()
    // prod, live, from the folder — the seeded row never waits for a request
    let r = sup.resolve('acme', 'home')
    const inst = r.instance
    assert.equal(r.prod_state, 'live'); assert.equal(r.state, 'live'); assert.equal(r.prod_rev, 1); assert.equal(r.rev, 1)
    assert.equal(r.deployed_rev, id, 'the commit is the content id'); assert.match(id, HEX40)
    assert.equal(r.dev_rev, null); assert.equal(sup.rows.get(inst).watcher, null, 'no watcher on a seeded folder')
    assert.equal(sup.rows.get(inst).gitInit, null, 'no git init on a seeded folder')
    assert.ok(w.lines.some((l) => new RegExp(`^\\[home\\] rev 1 LIVE \\(prod\\) commit ${id.slice(0, 12)} in \\d+ ms$`).test(l)), w.lines.filter((l) => l.startsWith('[home]')).join('\n'))
    assert.ok(w.lines.some((l) => l === `[home] seeded: rev 1 (${id.slice(0, 12)}) is the release — prod from the folder, no dev slot`))
    assert.ok(!w.lines.some((l) => /^\[home\] .*\(dev\)/.test(l)), 'no dev line for the seeded row')
    assert.deepEqual(w.modules, [[inst, 1]], 'ONE modulesChanged: the registry learns the prod rev')
    assert.equal(w.releases.length, 1)
    const rel = w.releases[0]
    assert.equal(rel.id, `adopt-${id.slice(0, 12)}`); assert.equal(rel.kind, 'adopt'); assert.equal(rel.verdict, 'green'); assert.equal(rel.rev, 1); assert.equal(rel.commit, id); assert.equal(rel.by, 'host')
    assert.ok(Number.isInteger(rel.at) && Math.abs(Date.now() - rel.at) < 60_000, 'a ms epoch')
    assert.equal(sup.releases(inst).length, 1, 'the host\'s own ledger row')
    const pb = revJson(w, inst).prod
    assert.equal(pb.legacy, true); assert.equal(pb.rev, 1); assert.equal(pb.commit, id); assert.equal(pb.message, 'seeded: the image\'s tree serving rev 1')
    assert.equal(fs.readlinkSync(dot(w, inst, 'current')), `../last-good/${inst}/rev-1`)
    assert.ok(!fs.existsSync(dot(w, inst, 'current-dev')), 'no dev pointer')
    assert.ok(!fs.existsSync(dot(w, 'prod', inst)), 'no export: the folder is prod')
    assert.equal(sup.rows.get(inst).prod.appDir, dir)
    assert.equal(JSON.parse((await api(sup, r, '/rev', prod)).body).rev, 1)
    assert.equal((await sup.asset(r, 'logo.svg')).body.toString(), '<svg/>', 'static files from the folder')
    assert.equal((await api(sup, r, '/rev')).status, 503, 'the dev slot has nothing: 503, never a dev worker')
    assert.equal(w.reports.length, 0)
    // the normal folder beside it: dev-only, exactly as before
    await waitFor(() => sup.resolve('acme', 'plain').dev_state === 'live')
    const p = sup.resolve('acme', 'plain')
    assert.equal(p.state, 'undeployed'); assert.equal(p.prod_state, null); assert.equal(p.deployed_rev, null)
    assert.ok(w.lines.some((l) => /^\[plain\] rev 1 LIVE \(dev\) in \d+ ms$/.test(l)))
    assert.ok(sup.rows.get(p.instance).watcher, 'the normal folder is watched')
    assert.equal((await api(sup, p, '/rev', prod)).status, 404)
    // the dev idle window (D18) passes: plain's dev worker stops, home's prod worker does not (its resources are empty, but idleMs is far away)
    await waitFor(() => sup.resolve('acme', 'plain').dev_state === 'stopped')
    assert.ok(w.lines.some((l) => /^\[plain\] rev 1 STOPPED \(dev\)$/.test(l)))
    await sleep(450)
    assert.equal(sup.resolve('acme', 'home').prod_state, 'live', 'the seeded prod worker survives the dev idle window')
    assert.ok(!w.lines.some((l) => /^\[home\] rev \d+ STOPPED/.test(l)))
    assert.equal(JSON.parse((await api(sup, r, '/rev', prod)).body).rev, 1)
    assert.deepEqual(sup.workers().map((x) => [x.slug, x.slot]), [['home', 'prod']])
    // a second scan: the same id → nothing rebuilt, the announce (idempotent by id: the fake registrar has no `apps()` snapshot, so it posts a replay)
    await sup.scan()
    assert.equal(sup.resolve('acme', 'home').prod_rev, 1); assert.equal(revJson(w, inst).rev, 1)
    assert.equal(w.releases.length, 2); assert.equal(w.releases[1].id, rel.id); assert.equal(sup.releases(inst).length, 1, 'an announce is no ledger row')
    await sup.scan()
    assert.equal(w.releases.length, 2, 'one announce per host life')
    // a re-seed over a kept /work (new bytes in the folder — nothing is watched, the scan sees the new id): a new rev, the old worker retired, a new adopt row
    fs.writeFileSync(path.join(dir, 'backend.js'), BACKEND(2))
    await sleep(150)
    assert.equal(JSON.parse((await api(sup, r, '/rev', prod)).body).rev, 1, 'no watcher: a save alone changes nothing')
    await sup.scan()
    const id2 = treeId(dir); assert.notEqual(id2, id)
    r = sup.resolve('acme', 'home')
    assert.equal(r.prod_rev, 2); assert.equal(r.deployed_rev, id2); assert.equal(r.prod_state, 'live')
    assert.equal(JSON.parse((await api(sup, r, '/rev', prod)).body).rev, 2)
    assert.equal(w.releases.length, 3); assert.equal(w.releases[2].id, `adopt-${id2.slice(0, 12)}`); assert.equal(w.releases[2].rev, 2)
    assert.deepEqual(w.modules, [[inst, 1], [inst, 2]])
    await waitFor(() => sup.rows.get(inst).prod.retiring.size === 0, { ms: 3000 })   // the old worker retired after swapStopMs
    assert.deepEqual(sup.workers().map((x) => [x.slug, x.slot, x.rev]), [['home', 'prod', 2]])
    // a second host life over the same /work: boot from the markers (prod stopped, resumed on the first request), the scan announces — no build, no dev line
    await sup.teardown()
    const before = w.lines.length
    sup = w.make({ timing: { devIdleMs: 300, idleMs: 60_000 } })
    await sup.boot()
    r = sup.resolve('acme', 'home')
    assert.equal(r.prod_state, 'stopped'); assert.equal(r.prod_rev, 2); assert.equal(r.deployed_rev, id2)
    await sup.scan()
    assert.equal(sup.rows.get(inst).watcher, null); assert.equal(revJson(w, inst).rev, 2, 'no new rev')
    assert.equal(w.releases.length, 4); assert.equal(w.releases[3].id, `adopt-${id2.slice(0, 12)}`)
    assert.ok(!w.lines.slice(before).some((l) => /^\[home\] .*(LIVE|\(dev\))/.test(l)), 'nothing built, no dev line')
    assert.equal(JSON.parse((await api(sup, r, '/rev', prod)).body).rev, 2)
    assert.ok(w.lines.slice(before).some((l) => /^\[home\] rev 2 RESUMED \d+ ms$/.test(l)))
    // the spine already holds the commit → nothing to announce
    await sup.teardown()
    w.registrar.apps = () => new Map([[inst, { slug: 'home', deployed_rev: id2 }]])
    sup = w.make(); await sup.boot(); await sup.scan()
    assert.equal(w.releases.length, 4)
    delete w.registrar.apps
    assert.equal(w.reports.length, 0)
  } finally { await w.done(sup) }
})

test('a broken seeded folder: ONE build report and ONE rev across sweeps (the folder\'s answer until its bytes change), no prod slot (404 not deployed), no worker; fixed bytes → built on the next scan', async () => {
  const w = world({ seededApps: true })
  const dir = w.app('broken', { 'module.json': APP_JSON('B'), 'backend.js': 'export default {', [SEEDED_MARKER]: '' })
  const sup = w.make()   // world({ seededApps: true }) below
  try {
    await sup.scan()
    const r = sup.resolve('acme', 'broken')
    assert.equal(r.state, 'undeployed'); assert.equal(r.prod_state, null); assert.equal(r.deployed_rev, null)
    assert.equal((await api(sup, r, '/rev', prod)).status, 404)
    assert.equal(w.reports.length, 1); assert.equal(w.reports[0].kind, 'build'); assert.equal(w.reports[0].rev, 0); assert.equal(w.reports[0].file, 'backend.js')
    assert.ok(w.lines.some((l) => /^\[broken\] rev 1 FAILED \(seeded\) backend\.js:/.test(l)), w.lines.join('\n'))
    assert.equal(revJson(w, r.instance).rev, 1)
    await sup.scan(); await sup.scan()
    assert.equal(w.reports.length, 1); assert.equal(revJson(w, r.instance).rev, 1, 'one rev, not one per sweep')
    assert.equal(w.releases.length, 0); assert.deepEqual(w.modules, [])
    assert.equal(sup.workers().length, 0)
    fs.writeFileSync(path.join(dir, 'backend.js'), BACKEND(7))
    await sup.scan()
    assert.equal(sup.resolve('acme', 'broken').prod_state, 'live'); assert.equal(sup.resolve('acme', 'broken').prod_rev, 2)
    assert.equal(JSON.parse((await api(sup, r, '/rev', prod)).body).rev, 7)
    assert.equal(w.releases.length, 1); assert.equal(w.reports.length, 1)
  } finally { await w.done(sup) }
})

// The real pod's permission model, simulated (review 2026-09-02, B1): after the claim the folder is `1000:<uid> 2750` and the
// host is userns root WITHOUT DAC_OVERRIDE — a read made without the app's gid held is EACCES. macOS cannot show this
// (`setgroups` is a no-op unprivileged, the folders are 0755), so the fs the supervisor reads through refuses every read of a
// CLAIMED folder while the harness's last setgroups() call does not hold that folder's uid. Before the fix `checkModuleJson`
// ran ungrouped: EACCES read as "module.json missing", the seeded row never got a prod slot — the outage, on the first scan.
const gidStrictFs = (w, dir, slug) => new Proxy(fs, {
  get: (t, k) => {
    const v = t[k]
    if (typeof v !== 'function') return v
    return (...a) => {
      const p = a[0], uid = w.claims.get(slug)?.uid ?? null, held = w.groups.at(-1) ?? []
      if (uid && typeof p === 'string' && (p === dir || p.startsWith(dir + '/')) && !held.includes(uid)) { const e = new Error(`EACCES: permission denied, ${k} '${p}'`); e.code = 'EACCES'; throw e }
      return v.apply(t, a)
    }
  },
})

test('every read on the seeded road holds the app\'s gid: through an fs that answers EACCES to any read of the claimed folder made without its uid held (the pod: `1000:<uid> 2750`, root without DAC_OVERRIDE), the seeded row still comes up `rev 1 LIVE (prod)` — never "module.json missing"; the second scan (the id recomputed, the announce) and a static read while it serves hold it too', async () => {
  const w = world({ seededApps: true })
  const dir = w.app('home', { 'module.json': APP_JSON('Home'), 'backend.js': BACKEND(1), 'logo.svg': '<svg/>', [SEEDED_MARKER]: '' })
  const sup = w.make({ fs: gidStrictFs(w, dir, 'home') })
  try {
    await sup.scan()
    const r = sup.resolve('acme', 'home')
    assert.equal(r.prod_state, 'live', w.lines.filter((l) => l.startsWith('[home]')).join('\n')); assert.equal(r.prod_rev, 1); assert.match(r.deployed_rev ?? '', HEX40)
    assert.ok(w.lines.some((l) => /^\[home\] rev 1 LIVE \(prod\) commit [0-9a-f]{12} in \d+ ms$/.test(l)))
    assert.ok(!w.reports.some((x) => /module\.json missing/.test(x.message)), JSON.stringify(w.reports))
    assert.equal(w.reports.length, 0)
    assert.ok(w.groups.some((g) => g.includes(w.claims.get('home').uid)), 'the gid was held at least once')
    assert.equal((await sup.asset(r, 'logo.svg')).body.toString(), '<svg/>')
    await sup.scan()
    assert.equal(sup.resolve('acme', 'home').prod_rev, 1); assert.equal(w.releases.length, 2, 'the second scan announced (no EACCES on the id)')
    assert.equal(w.reports.length, 0)
  } finally { await w.done(sup) }
})

test('a HOST-SIDE failure on the seeded road (the spawn refused: EAGAIN) is retried at the next scan and reported ONCE — never left as a row nothing will build again; the rev it minted is dropped, the retry mints the next; the folder\'s own failure (a backend that fails to load) stays one rev and one report until its bytes change', async () => {
  const w = world({ seededApps: true })
  w.app('home', { 'module.json': APP_JSON('Home'), 'backend.js': BACKEND(1), [SEEDED_MARKER]: '' })
  const real = makeSpawn(w.root + '/runtime.mjs')
  let refuse = 2   // what worker/spawn.mjs rejects with when os.spawn throws (EAGAIN: the process cap or memory)
  const sup = w.make({ spawn: (args) => (refuse > 0 ? (refuse--, Promise.reject({ error: 'spawn-eagain', msg: 'spawn: EAGAIN' })) : real(args)) })
  try {
    await sup.scan()
    let r = sup.resolve('acme', 'home')
    assert.equal(r.prod_state, null); assert.equal(r.deployed_rev, null)
    assert.equal(w.reports.length, 1); assert.equal(w.reports[0].kind, 'worker'); assert.match(w.reports[0].message, /spawn-eagain/)
    assert.ok(w.lines.some((l) => /^\[home\] rev 1 FAILED \(seeded\) spawn-eagain: .* — a host-side failure, retried at the next scan$/.test(l)), w.lines.filter((l) => l.startsWith('[home]')).join('\n'))
    assert.ok(!fs.existsSync(dot(w, r.instance, 'current')), 'nothing to serve yet')
    await sup.scan()   // refused once more: the same reason → no second report
    assert.equal(sup.resolve('acme', 'home').prod_state, null)
    assert.equal(w.reports.length, 1, 'one report per (bytes, reason)')
    assert.equal(w.lines.filter((l) => /FAILED \(seeded\)/.test(l)).length, 2, 'the log line repeats; the chat hears it once')
    await sup.scan()   // the host recovered
    r = sup.resolve('acme', 'home')
    assert.equal(r.prod_state, 'live'); assert.equal(r.prod_rev, 3, 'rev 1 and 2 dropped, the retry minted 3'); assert.match(r.deployed_rev, HEX40)
    assert.equal(JSON.parse((await api(sup, r, '/rev', prod)).body).rev, 1)
    assert.deepEqual(fs.readdirSync(dot(w, 'last-good', r.instance)).filter((n) => /^rev-\d+$/.test(n)), ['rev-3'])
    assert.equal(w.releases.length, 1); assert.equal(w.reports.length, 1)
  } finally { await w.done(sup) }
})

test('the marker alone is not authority (B2): on a host NOT configured with ATELIER_SEEDED_APPS=1 a folder carrying `.atelier-seeded` takes the new-folder road exactly as before — dev-only, watched, `(dev)` line, no prod slot, no adopt row, no seeded line', async () => {
  const w = world()   // seededApps false: every agent host
  w.app('sneaky', { 'module.json': APP_JSON('Sneaky'), 'backend.js': BACKEND(1), [SEEDED_MARKER]: '' })
  const sup = w.make()
  try {
    await sup.scan()
    await waitFor(() => sup.resolve('acme', 'sneaky').dev_state === 'live')
    const r = sup.resolve('acme', 'sneaky')
    assert.equal(sup.rows.get(r.instance).seeded, false)
    assert.equal(r.state, 'undeployed'); assert.equal(r.prod_state, null); assert.equal(r.deployed_rev, null); assert.equal(r.dev_rev, 1)
    assert.ok(sup.rows.get(r.instance).watcher, 'watched like any folder')
    assert.ok(w.lines.some((l) => /^\[sneaky\] rev 1 LIVE \(dev\) in \d+ ms$/.test(l)))
    assert.ok(!w.lines.some((l) => /seeded/.test(l)), w.lines.join('\n'))
    assert.equal((await api(sup, r, '/rev', prod)).status, 404, 'not deployed: the gate, the rehearsal, the backup and git still stand between the folder and prod')
    assert.deepEqual(w.releases, []); assert.deepEqual(w.modules, [])
    await sup.scan()
    assert.deepEqual(w.releases, [])
  } finally { await w.done(sup) }
})

test('two seeded folders build side by side inside ONE scan and the scan settles only when both are LIVE (what host-ready waits for on a seeded host, S1): after `await sup.scan()` both prod slots serve, two adopt rows, no dev line', async () => {
  const w = world({ seededApps: true })
  w.app('home', { 'module.json': APP_JSON('Home'), 'backend.js': BACKEND(1), [SEEDED_MARKER]: '' })
  w.app('catalyst-chrome', { 'module.json': APP_JSON('Chrome'), 'backend.js': BACKEND(2), 'frontend.js': 'export {}', [SEEDED_MARKER]: '' })
  const sup = w.make()
  try {
    await sup.scan()
    for (const [slug, rev] of [['home', 1], ['catalyst-chrome', 2]]) {
      const r = sup.resolve('acme', slug)
      assert.equal(r.prod_state, 'live', `${slug}: ${w.lines.filter((l) => l.startsWith(`[${slug}]`)).join('\n')}`); assert.equal(r.prod_rev, 1); assert.match(r.deployed_rev, HEX40)
      assert.equal(JSON.parse((await api(sup, r, '/rev', prod)).body).rev, rev)
    }
    assert.equal(w.releases.length, 2); assert.deepEqual(w.releases.map((x) => x.kind), ['adopt', 'adopt'])
    assert.ok(!w.lines.some((l) => /\(dev\)/.test(l)))
    assert.deepEqual(sup.workers().map((x) => [x.slug, x.slot]).sort(), [['catalyst-chrome', 'prod'], ['home', 'prod']])
  } finally { await w.done(sup) }
})
