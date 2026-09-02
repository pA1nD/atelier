// supervisor/index.mjs keep-alive + resume (R14, DESIGN §6.1, §8.1, §10.3 D18): the PROD slot idle-stops only on
// empty resources or ctx.suspendable(); the DEV slot after devIdleMs whatever it holds; resume from the slot's
// pointer with requests held, never 502; a broken folder while stopped → served from the snapshot; boot()
// resumes rows from markers without reading the folder (OR8); kill() → restart with backoff (prod); a worker
// death → report + restart.
import test from 'node:test'
import assert from 'node:assert/strict'
import { world, api, deploy, waitFor, sleep, APP_JSON, BACKEND, fs, path } from './supervisor-harness.test.js'

const prod = { slot: 'prod' }
const live = (sup, slug, slot = 'dev') => waitFor(() => { const r = sup.resolve('acme', slug); return r?.[`${slot}_state`] === 'live' ? r : null })
const QUIET = BACKEND(1)
const TIMER = `export default { mountRoutes(router) { const t = setInterval(() => {}, 1000); router.get('/rev', (req, res) => res.json({ rev: 1 })); return () => clearInterval(t) } }\n`
const SUSPENDABLE = `export default { mountRoutes(router, ctx) { const t = setInterval(() => {}, 1000); router.get('/rev', (req, res) => res.json({ rev: 1 })); ctx.suspendable(); return () => clearInterval(t) } }\n`

test('PROD idle-stops only when the READY resources are empty or the worker said suspendable; resume is held, never 502; DEV idle-stops after devIdleMs whatever it holds (D18)', async () => {
  const w = world({ gitCommit: true })
  w.app('quiet', { 'module.json': APP_JSON('Q'), 'backend.js': QUIET })
  w.app('busy', { 'module.json': APP_JSON('B'), 'backend.js': TIMER })
  w.app('susp', { 'module.json': APP_JSON('S'), 'backend.js': SUSPENDABLE })
  const resumes = []
  const sup = w.make({ timing: { idleMs: 250, devIdleMs: 400 }, onResume: (instance, rev) => resumes.push([instance, rev]) })
  try {
    await sup.scan()
    const [q, b, s] = await Promise.all(['quiet', 'busy', 'susp'].map((slug) => live(sup, slug)))
    assert.equal(sup.workers().length, 3)
    // the dev workers stop after devIdleMs — the busy one too (D18: never resident)
    await waitFor(() => ['quiet', 'busy', 'susp'].every((x) => sup.resolve('acme', x).dev_state === 'stopped'))
    assert.ok(w.lines.some((l) => l === '[busy] rev 1 STOPPED (dev)'))
    assert.equal(sup.workers().length, 0)
    // released → the prod rules
    for (const slug of ['quiet', 'busy', 'susp']) { assert.equal((await deploy(sup, sup.resolve('acme', slug), { message: `release ${slug}` })).outcome, 'green'); assert.equal(sup.resolve('acme', slug).prod_state, 'live') }
    await waitFor(() => sup.resolve('acme', 'quiet').prod_state === 'stopped')
    await waitFor(() => sup.resolve('acme', 'susp').prod_state === 'stopped')
    await sleep(600)
    assert.equal(sup.resolve('acme', 'busy').prod_state, 'live', 'a prod worker holding a timer is never idle-stopped')
    assert.deepEqual(sup.workers().map((x) => [x.instance, x.slot]), [[b.instance, 'prod']])
    assert.ok(w.lines.some((l) => l === '[quiet] rev 2 STOPPED'), 'the prod rev is the release (the per-instance counter: dev 1, release 2)')
    assert.ok(w.lines.some((l) => l === '[susp] rev 2 STOPPED'))
    assert.equal(sup.rows.get(q.instance).prod.resources && Object.values(sup.rows.get(q.instance).prod.resources).every((n) => !n), true)
    assert.equal(sup.rows.get(b.instance).prod.resources.Timeout, 1)
    // resume on the next request: held, 200, one worker again; concurrent requests share one resume
    const t0 = Date.now()
    const rs = await Promise.all([api(sup, q, '/rev', prod), api(sup, q, '/rev', prod), api(sup, q, '/rev', prod)])
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200])
    assert.ok(Date.now() - t0 < 2000)
    assert.match(w.lines.find((l) => /RESUMED/.test(l)), /^\[quiet\] rev 2 RESUMED \d+ ms$/)
    assert.equal(sup.workers().filter((x) => x.instance === q.instance).length, 1)
    assert.equal(sup.resolve('acme', 'quiet').prod_state, 'live')
    assert.deepEqual(resumes, [[q.instance, 2]], 'onResume registers the running prod rev (the collector answers frontend reports against it)')
    // requests keep it alive; silence stops it again
    for (let i = 0; i < 4; i++) { await sleep(120); assert.equal((await api(sup, q, '/rev', prod)).status, 200) }
    assert.equal(sup.resolve('acme', 'quiet').prod_state, 'live')
    await waitFor(() => sup.resolve('acme', 'quiet').prod_state === 'stopped')
    // a dev request resumes the dev worker on demand (D18), the prod slot untouched
    assert.equal((await api(sup, q, '/rev')).status, 200)
    assert.equal(sup.resolve('acme', 'quiet').dev_state, 'live'); assert.equal(sup.resolve('acme', 'quiet').prod_state, 'stopped')
    assert.equal(w.reports.length, 0)
  } finally { await w.done(sup) }
})

test('a two-phase install holds requests that would resume a stopped worker (the freeze SIGKILLs the worker uid); the rebuild follows', async () => {
  const w = world()
  const dir = w.app('inst', { 'module.json': APP_JSON('I'), 'backend.js': QUIET })
  const sup = w.make({ timing: { idleMs: 150, devIdleMs: 150 }, install: async () => { await sleep(400); return { ok: true, ms: 400 } } })
  try {
    await sup.scan()
    const row = await live(sup, 'inst')
    await waitFor(() => sup.resolve('acme', 'inst').dev_state === 'stopped')
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
    const row = await live(sup, 'snapw')
    inst = row.instance
    fs.chmodSync(lg(inst), 0o500)
    fs.writeFileSync(path.join(dir, 'backend.js'), BACKEND(2))
    await waitFor(() => w.reports.length === 1)
    assert.equal(w.reports[0].kind, 'build'); assert.equal(w.reports[0].rev, 0)
    assert.match(w.reports[0].message, /^dev: snapshot write failed: EACCES$/)
    assert.match(w.reports[0].hint, /cannot write the snapshot \(EACCES\)/)
    assert.equal(w.reports[0].file, 'backend.js')
    assert.match(w.lines.find((l) => /FAILED/.test(l)), /^\[snapw\] rev 2 FAILED \(dev\) snapshot write failed: EACCES$/)
    assert.equal(sup.resolve('acme', 'snapw').dev_rev, 1)
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
    assert.equal(w.reports[0].kind, 'worker'); assert.equal(w.reports[0].message, 'dev: jail: mkdir /x/data: ENOSPC')
    assert.match(w.reports[0].hint, /could not prepare the worker's directories/)
    assert.equal(sup.resolve('acme', 'jailed').dev_state, 'failed')
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
    inst = (await live(sup, 'recon')).instance
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
    assert.ok(w.lines.some((l) => /^\[recon\] folder removed — unlinked \(snapshot kept at dev rev 1\)$/.test(l)))
    // the apps root unreadable → reconcile(null), nothing tombstoned
    fs.rmSync(path.join(w.work, 'apps'), { recursive: true, force: true })
    const d = await sup.scan()
    assert.equal(d.unreadable, true)
    assert.equal(w.registrar.reconcileCalls.at(-1), null)
    fs.mkdirSync(path.join(w.work, 'apps'))
  } finally { await w.done(sup) }
})

test('a broken folder while stopped: the save fails (reported), the resume serves the snapshot; boot() resumes PROD from markers without the folder', async () => {
  const w = world({ gitCommit: true })
  const dir = w.app('snap', { 'module.json': APP_JSON('Snap'), 'backend.js': QUIET, 'frontend.jsx': 'export default () => <i className="p-1"/>' })
  let sup = w.make({ timing: { idleMs: 150 } })
  const inst = (await (async () => { await sup.scan(); return live(sup, 'snap') })()).instance
  try {
    assert.equal((await deploy(sup, sup.resolve('acme', 'snap'), { message: 'first' })).outcome, 'green')   // rev 2 = the prod release
    await waitFor(() => sup.resolve('acme', 'snap').prod_state === 'stopped')
    fs.writeFileSync(path.join(dir, 'backend.js'), 'export default { mountRoutes( {')   // broken while stopped
    await waitFor(() => w.reports.length === 1)
    assert.equal(w.reports[0].kind, 'build'); assert.equal(w.reports[0].rev, 2, 'the report carries the PROD rev')
    assert.equal(sup.resolve('acme', 'snap').prod_state, 'stopped')
    const r = await api(sup, sup.resolve('acme', 'snap'), '/rev', prod)
    assert.equal(r.status, 200); assert.equal(JSON.parse(r.body).ctxRev, 2)
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
    assert.equal(row.instance, inst); assert.equal(row.state, 'stopped'); assert.equal(row.rev, 2); assert.equal(row.uid, 20001); assert.match(row.deployed_rev, /^[0-9a-f]{40}$/)
    const r2 = await api(sup, row, '/rev', prod)
    assert.equal(r2.status, 200); assert.equal(JSON.parse(r2.body).ctxRev, 2)
    assert.equal((await sup.asset(row, 'frontend.js')).rev, 2)
    assert.equal(sup.workers().length, 1)
    assert.equal(guard.hits, 0, 'the folder was never read')
    assert.equal(await sup.asset(row, 'logo.svg'), null, 'a static file read of the EXPORT (not the folder) is a 404, not a crash')
    assert.equal(guard.hits, 0, 'prod static files come from the export, never the agent\'s folder')
  } finally { await w.done(sup) }
})

test('kill() → SIGKILL + report(worker) + restart with backoff (prod); an unexpected worker death → report + restart; a dead dev worker is resumed on demand', async () => {
  const w = world({ gitCommit: true })
  w.app('k', { 'module.json': APP_JSON('K'), 'backend.js': TIMER })
  const sup = w.make({ timing: { backoffMs: [50, 100], devIdleMs: 60_000 } })
  try {
    await sup.scan()
    await live(sup, 'k')
    assert.equal((await deploy(sup, sup.resolve('acme', 'k'), { message: 'first' })).outcome, 'green')
    const row = await live(sup, 'k', 'prod')
    const pid1 = row.pid
    sup.kill(row.instance, 'rss 412 MB > 384 MB', 'prod')
    assert.equal(sup.resolve('acme', 'k').state, 'failed')
    assert.deepEqual(w.reports.map((r) => [r.kind, r.rev, r.message]), [['worker', 2, 'rss 412 MB > 384 MB']])
    assert.ok(w.lines.includes('[k] rev 2 KILLED rss 412 MB > 384 MB'))
    const back = await waitFor(() => { const r = sup.resolve('acme', 'k'); return r.state === 'live' ? r : null })
    assert.notEqual(back.pid, pid1)
    assert.equal((await api(sup, back, '/rev', prod)).status, 200)
    assert.equal(sup.rows.get(row.instance).prod.restarts, 1, 'a resume does not reset the ladder')
    // the worker dies on its own
    process.kill(back.pid, 'SIGKILL')
    await waitFor(() => w.reports.length === 2)
    assert.equal(w.reports[1].kind, 'worker'); assert.match(w.reports[1].message, /^worker died: signal SIGKILL/)
    const again = await waitFor(() => { const r = sup.resolve('acme', 'k'); return r.state === 'live' && r.pid !== back.pid ? r : null })
    assert.equal((await api(sup, again, '/rev', prod)).status, 200)
    assert.equal(sup.workers().filter((x) => x.slot === 'prod').length, 1)
    assert.equal(sup.rows.get(row.instance).prod.restarts, 2, 'the second death climbs the ladder (0.5 → 30 s), it does not restart at rung 0')
    // the dev worker: a kill is reported with the dev head at the prod rev, no ladder — the next dev request resumes it
    const devPid = sup.rows.get(row.instance).dev.live.pid
    sup.kill(row.instance, 'rss 500 MB > 384 MB', 'dev')
    assert.equal(sup.resolve('acme', 'k').dev_state, 'failed')
    assert.deepEqual(w.reports.at(-1) && [w.reports.at(-1).kind, w.reports.at(-1).rev, w.reports.at(-1).message], ['worker', 2, 'dev: rss 500 MB > 384 MB'])
    await sleep(250)
    assert.equal(sup.resolve('acme', 'k').dev_state, 'failed', 'no ladder for dev')
    assert.equal((await api(sup, row, '/rev')).status, 200)
    assert.notEqual(sup.rows.get(row.instance).dev.live.pid, devPid)
    // stableMs of uptime resets it; a LIVE build resets it at once
    await sup.teardown()
    const sup2 = w.make({ timing: { backoffMs: [50, 100], stableMs: 120 } })
    await sup2.boot(); await sup2.scan()
    const r2 = sup2.resolve('acme', 'k')
    assert.equal((await api(sup2, r2, '/rev', prod)).status, 200)   // resumed from the snapshot (the fingerprint matched: no rebuild)
    sup2.kill(r2.instance, 'test', 'prod')
    await waitFor(() => { const r = sup2.resolve('acme', 'k'); return r.state === 'live' })
    assert.equal(sup2.rows.get(r2.instance).prod.restarts, 1)
    await waitFor(() => sup2.rows.get(r2.instance).prod.restarts === 0, { ms: 3000 })
    await sup2.teardown()
  } finally { await w.done(sup) }
})
