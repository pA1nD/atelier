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
    // the worker dies on its own
    process.kill(back.pid, 'SIGKILL')
    await waitFor(() => w.reports.length === 2)
    assert.equal(w.reports[1].kind, 'worker'); assert.match(w.reports[1].message, /worker died: signal SIGKILL/)
    const again = await waitFor(() => { const r = sup.resolve('acme', 'k'); return r.state === 'live' && r.pid !== back.pid ? r : null })
    assert.equal((await api(sup, again, '/rev')).status, 200)
    assert.equal(sup.workers().length, 1)
  } finally { await w.done(sup) }
})
