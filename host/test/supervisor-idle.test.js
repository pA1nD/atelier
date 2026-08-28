// supervisor/index.mjs keep-alive + resume (R14, DESIGN §6.1, §8.1): idle-stop only on empty
// resources or ctx.suspendable(); resume from `current` with requests held, never 502; a broken
// folder while stopped → served from the snapshot; boot() resumes rows from markers without
// reading the folder (OR8); kill() → restart with backoff; a worker death → report + restart.
import test from 'node:test'
import assert from 'node:assert/strict'
import { world, fakeExchange, waitFor, sleep, APP_JSON, BACKEND, fs, path } from './supervisor-harness.test.js'

async function api(sup, row, url) {
  const x = fakeExchange('GET', url)
  await sup.handle(row, x.req, x.res, { id: 'p1' })
  return x.finished
}
const QUIET = BACKEND(1)
const TIMER = `export default { mountRoutes(router) { const t = setInterval(() => {}, 1000); router.get('/rev', (req, res) => res.json({ rev: 1 })); return () => clearInterval(t) } }\n`
const SUSPENDABLE = `export default { mountRoutes(router, ctx) { const t = setInterval(() => {}, 1000); router.get('/rev', (req, res) => res.json({ rev: 1 })); ctx.suspendable(); return () => clearInterval(t) } }\n`

test('idle-stop only when the READY resources are empty or the worker said suspendable; resume is held, never 502', async () => {
  const w = world()
  w.app('quiet', { 'module.json': APP_JSON('Q'), 'backend.js': QUIET })
  w.app('busy', { 'module.json': APP_JSON('B'), 'backend.js': TIMER })
  w.app('susp', { 'module.json': APP_JSON('S'), 'backend.js': SUSPENDABLE })
  const sup = w.make({ timing: { idleMs: 250 } })
  try {
    await sup.scan()
    const [q, b, s] = await Promise.all(['quiet', 'busy', 'susp'].map((slug) => waitFor(() => { const r = sup.resolve('acme', slug); return r?.state === 'live' ? r : null })))
    assert.equal(sup.workers().length, 3)
    await waitFor(() => sup.resolve('acme', 'quiet').state === 'stopped')
    await waitFor(() => sup.resolve('acme', 'susp').state === 'stopped')
    await sleep(600)
    assert.equal(sup.resolve('acme', 'busy').state, 'live', 'a worker holding a timer is never idle-stopped')
    assert.deepEqual(sup.workers().map((x) => x.instance), [b.instance])
    assert.ok(w.lines.some((l) => l === '[quiet] rev 1 STOPPED'))
    assert.ok(w.lines.some((l) => l === '[susp] rev 1 STOPPED'))
    assert.equal(sup.rows.get(q.instance).resources && Object.values(sup.rows.get(q.instance).resources).every((n) => !n), true)
    assert.equal(sup.rows.get(b.instance).resources.Timeout, 1)
    // resume on the next request: held, 200, one worker again; concurrent requests share one resume
    const t0 = Date.now()
    const rs = await Promise.all([api(sup, q, '/rev'), api(sup, q, '/rev'), api(sup, q, '/rev')])
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200])
    assert.ok(Date.now() - t0 < 2000)
    assert.match(w.lines.find((l) => /RESUMED/.test(l)), /^\[quiet\] rev 1 RESUMED \d+ ms$/)
    assert.equal(sup.workers().filter((x) => x.instance === q.instance).length, 1)
    assert.equal(sup.resolve('acme', 'quiet').state, 'live')
    // requests keep it alive; silence stops it again
    for (let i = 0; i < 4; i++) { await sleep(120); assert.equal((await api(sup, q, '/rev')).status, 200) }
    assert.equal(sup.resolve('acme', 'quiet').state, 'live')
    await waitFor(() => sup.resolve('acme', 'quiet').state === 'stopped')
    assert.equal(w.reports.length, 0)
  } finally { await w.done(sup) }
})

test('a two-phase install holds requests that would resume a stopped worker (the freeze SIGKILLs the worker uid); the rebuild follows', async () => {
  const w = world()
  const dir = w.app('inst', { 'module.json': APP_JSON('I'), 'backend.js': QUIET })
  const sup = w.make({ timing: { idleMs: 150 }, install: async () => { await sleep(400); return { ok: true, ms: 400 } } })
  try {
    await sup.scan()
    const row = await waitFor(() => { const r = sup.resolve('acme', 'inst'); return r?.state === 'live' ? r : null })
    await waitFor(() => sup.resolve('acme', 'inst').state === 'stopped')
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"inst","dependencies":{}}')
    await waitFor(() => !!sup.rows.get(row.instance).installing)
    const t0 = Date.now()
    const r = await api(sup, row, '/rev')
    assert.equal(r.status, 200)
    assert.ok(Date.now() - t0 >= 250, `held for the install (${Date.now() - t0} ms)`)
    assert.ok(w.lines.some((l) => l === '[inst] install ok 400 ms'))
    assert.equal(sup.rows.get(row.instance).installing, null)
    assert.equal(w.reports.length, 0)
  } finally { await w.done(sup) }
})

test('a snapshot write failure (the store unwritable) is a build report with a hint, last-good keeps serving, no tmp dir is left; boot sweeps a dead life\'s tmp', async () => {
  const w = world()
  const dir = w.app('snapw', { 'module.json': APP_JSON('W'), 'backend.js': QUIET })
  const sup = w.make()
  const lg = (inst) => path.join(w.work, '.atelier', 'last-good', inst)
  let inst
  try {
    await sup.scan()
    const row = await waitFor(() => { const r = sup.resolve('acme', 'snapw'); return r?.state === 'live' ? r : null })
    inst = row.instance
    fs.chmodSync(lg(inst), 0o500)
    fs.writeFileSync(path.join(dir, 'backend.js'), BACKEND(2))
    await waitFor(() => w.reports.length === 1)
    assert.equal(w.reports[0].kind, 'build'); assert.equal(w.reports[0].rev, 2)
    assert.match(w.reports[0].message, /^snapshot write failed: EACCES$/)
    assert.match(w.reports[0].hint, /cannot write the snapshot \(EACCES\)/)
    assert.equal(w.reports[0].file, 'backend.js')
    assert.match(w.lines.find((l) => /FAILED/.test(l)), /^\[snapw\] rev 2 FAILED \(users still on rev 1\) snapshot write failed: EACCES$/)
    assert.equal(sup.resolve('acme', 'snapw').rev, 1)
    assert.equal(JSON.parse((await api(sup, row, '/rev')).body).ctxRev, 1)
    fs.chmodSync(lg(inst), 0o750)
    assert.deepEqual(fs.readdirSync(lg(inst)).filter((n) => n.includes('tmp')), [])
    await sup.teardown()
    // a dead host life's tmp dir under last-good is swept at boot
    fs.mkdirSync(path.join(lg(inst), 'rev-7.tmp-424242')); fs.writeFileSync(path.join(lg(inst), 'rev-7.tmp-424242', 'x'), '1')
    const sup2 = w.make()
    await sup2.boot()
    assert.ok(!fs.existsSync(path.join(lg(inst), 'rev-7.tmp-424242')))
    assert.ok(w.lines.some((l) => l === 'boot: snapw swept rev-7.tmp-424242 (a previous host life died mid-write)'))
    await sup2.teardown()
  } finally { try { fs.chmodSync(lg(inst), 0o750) } catch {} await w.done(sup) }
})

test('a jail failure (mkdir/chown/chmod of the per-instance dirs) is a worker report with a host-side hint, never a spawn', async () => {
  const w = world()
  w.app('jailed', { 'module.json': APP_JSON('J'), 'backend.js': QUIET })
  const jail = { jailPlan: () => [{ op: 'mkdir', path: '/x/data' }], applyJail: () => ({ ok: false, results: [{ step: { op: 'mkdir', path: '/x/data' }, ok: false, code: 'ENOSPC' }] }), claimRoundTrip: () => ({ ok: true, results: [] }) }
  const sup = w.make({ jail })
  try {
    await sup.scan()
    await waitFor(() => w.reports.length === 1)
    assert.equal(w.reports[0].kind, 'worker'); assert.equal(w.reports[0].message, 'jail: mkdir /x/data: ENOSPC')
    assert.match(w.reports[0].hint, /could not prepare the worker's directories/)
    assert.equal(sup.resolve('acme', 'jailed').state, 'failed')
    assert.equal(sup.workers().length, 0)
  } finally { await w.done(sup) }
})

test('boot reconcile: the registrar gets the DISCOVERED folders (never the boot rows); a row it tombstones leaves resolve(); an unreadable apps root → reconcile(null)', async () => {
  const w = world()
  const dir = w.app('recon', { 'module.json': APP_JSON('R'), 'backend.js': QUIET })
  let sup = w.make({ timing: { idleMs: 150 } })
  let inst
  try {
    await sup.scan()
    inst = (await waitFor(() => { const r = sup.resolve('acme', 'recon'); return r?.state === 'live' ? r : null })).instance
    assert.equal(w.registrar.reconcileCalls.length, 1)
    assert.deepEqual(w.registrar.reconcileCalls[0].map((r) => r.slug), ['recon'])
    await sup.teardown()
    // the folder vanished while the host was down: the boot row must NOT count as present
    fs.rmSync(dir, { recursive: true, force: true })
    w.registrar.reconcileImpl = (rows) => ({ unlinked: rows.some((r) => r.slug === 'recon') ? [] : [inst] })
    sup = w.make({ timing: { idleMs: 150 } })
    await sup.boot()
    assert.equal(sup.resolve('acme', 'recon').instance, inst)
    await sup.scan()
    assert.deepEqual(w.registrar.reconcileCalls[1], [], 'the discovered folders, not sup.apps()')
    assert.equal(sup.resolve('acme', 'recon'), null, 'the tombstoned boot row is served no more')
    assert.deepEqual(w.registrar.unlinked, [], 'reconcile tombstoned it; the supervisor does not unlink twice')
    assert.ok(w.lines.some((l) => /^\[recon\] folder removed — unlinked \(snapshot kept at rev 1\)$/.test(l)))
    // the apps root unreadable → reconcile(null), nothing tombstoned
    fs.rmSync(path.join(w.work, 'apps'), { recursive: true, force: true })
    const d = await sup.scan()
    assert.equal(d.unreadable, true)
    assert.equal(w.registrar.reconcileCalls.at(-1), null)
    fs.mkdirSync(path.join(w.work, 'apps'))
  } finally { await w.done(sup) }
})

test('a broken folder while stopped: the save fails (reported), the resume serves the snapshot; boot() resumes from markers without the folder', async () => {
  const w = world()
  const dir = w.app('snap', { 'module.json': APP_JSON('Snap'), 'backend.js': QUIET, 'frontend.jsx': 'export default () => <i className="p-1"/>' })
  let sup = w.make({ timing: { idleMs: 150 } })
  const inst = (await (async () => { await sup.scan(); return waitFor(() => { const r = sup.resolve('acme', 'snap'); return r?.state === 'live' ? r : null }) })()).instance
  try {
    await waitFor(() => sup.resolve('acme', 'snap').state === 'stopped')
    fs.writeFileSync(path.join(dir, 'backend.js'), 'export default { mountRoutes( {')   // broken while stopped
    await waitFor(() => w.reports.length === 1)
    assert.equal(w.reports[0].kind, 'build'); assert.equal(w.reports[0].rev, 2)
    assert.equal(sup.resolve('acme', 'snap').state, 'stopped')
    const r = await api(sup, sup.resolve('acme', 'snap'), '/rev')
    assert.equal(r.status, 200); assert.equal(JSON.parse(r.body).ctxRev, 1)
    assert.ok((await sup.asset(sup.resolve('acme', 'snap'), 'frontend.js')).body.toString().includes('"p-1"'))
    await sup.teardown()
    // a new host over the same .atelier: the row comes back from markers + last-good; the folder is broken
    // AND unreadable to the host (a guarded fs: every read under /work/apps throws) — boot + resume + assets
    // never touch it (OR8: snapshots first)
    fs.rmSync(path.join(dir, 'frontend.jsx')); fs.rmSync(path.join(dir, 'module.json'))
    const appsDir = path.join(w.work, 'apps')
    const guard = { on: true, hits: 0 }
    const guarded = new Proxy(fs, { get: (t, k) => (typeof t[k] === 'function' && ['readdirSync', 'readFileSync', 'statSync', 'lstatSync', 'existsSync', 'realpathSync', 'openSync', 'watch'].includes(k))
      ? (p, ...a) => { if (guard.on && String(p).startsWith(appsDir)) { guard.hits++; throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) } return t[k](p, ...a) } : t[k] })
    sup = w.make({ timing: { idleMs: 150 }, fs: guarded })
    await sup.boot()
    const row = sup.resolve('acme', 'snap')
    assert.equal(row.instance, inst); assert.equal(row.state, 'stopped'); assert.equal(row.rev, 1); assert.equal(row.uid, 20001)
    const r2 = await api(sup, row, '/rev')
    assert.equal(r2.status, 200); assert.equal(JSON.parse(r2.body).ctxRev, 1)
    assert.equal((await sup.asset(row, 'frontend.js')).rev, 1)
    assert.equal(sup.workers().length, 1)
    assert.equal(guard.hits, 0, 'the folder was never read')
    assert.equal(await sup.asset(row, 'logo.svg'), null, 'a static file read of an unreadable folder is a 404, not a crash')
    assert.equal(guard.hits, 1)
  } finally { await w.done(sup) }
})

test('kill() → SIGKILL + report(worker) + restart with backoff; an unexpected worker death → report + restart', async () => {
  const w = world()
  w.app('k', { 'module.json': APP_JSON('K'), 'backend.js': TIMER })
  const sup = w.make({ timing: { backoffMs: [50, 100] } })
  try {
    await sup.scan()
    const row = await waitFor(() => { const r = sup.resolve('acme', 'k'); return r?.state === 'live' ? r : null })
    const pid1 = row.pid
    sup.kill(row.instance, 'rss 412 MB > 384 MB')
    assert.equal(sup.resolve('acme', 'k').state, 'failed')
    assert.deepEqual(w.reports.map((r) => [r.kind, r.rev, r.message]), [['worker', 1, 'rss 412 MB > 384 MB']])
    assert.ok(w.lines.includes('[k] rev 1 KILLED rss 412 MB > 384 MB'))
    const back = await waitFor(() => { const r = sup.resolve('acme', 'k'); return r.state === 'live' ? r : null })
    assert.notEqual(back.pid, pid1)
    assert.equal((await api(sup, back, '/rev')).status, 200)
    assert.equal(sup.rows.get(row.instance).restarts, 1, 'a resume does not reset the ladder')
    // the worker dies on its own
    process.kill(back.pid, 'SIGKILL')
    await waitFor(() => w.reports.length === 2)
    assert.equal(w.reports[1].kind, 'worker'); assert.match(w.reports[1].message, /worker died: signal SIGKILL/)
    const again = await waitFor(() => { const r = sup.resolve('acme', 'k'); return r.state === 'live' && r.pid !== back.pid ? r : null })
    assert.equal((await api(sup, again, '/rev')).status, 200)
    assert.equal(sup.workers().length, 1)
    assert.equal(sup.rows.get(row.instance).restarts, 2, 'the second death climbs the ladder (0.5 → 30 s), it does not restart at rung 0')
    // stableMs of uptime resets it; a LIVE build resets it at once
    await sup.teardown()
    const sup2 = w.make({ timing: { backoffMs: [50, 100], stableMs: 120 } })
    await sup2.boot(); await sup2.scan()
    const r2 = sup2.resolve('acme', 'k')
    assert.equal((await api(sup2, r2, '/rev')).status, 200)   // resumed from the snapshot (the fingerprint matched: no rebuild)
    sup2.kill(r2.instance, 'test')
    await waitFor(() => { const r = sup2.resolve('acme', 'k'); return r.state === 'live' })
    assert.equal(sup2.rows.get(r2.instance).restarts, 1)
    await waitFor(() => sup2.rows.get(r2.instance).restarts === 0, { ms: 3000 })
    await sup2.teardown()
  } finally { await w.done(sup) }
})
