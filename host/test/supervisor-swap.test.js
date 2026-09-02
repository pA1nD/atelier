// supervisor/index.mjs + serve.mjs with REAL workers (unprivileged()): scan → claim → build → LIVE on the DEV
// slot (DESIGN §10.3 D3: a save is a dev revision; prod is a release's); 200 four-fetch observations across 3
// saves → 0 mixed revs, 0 non-2xx; a syntax error / a throwing mount / a half-written save → the dev slot on
// the old rev, ONE `dev:`-headed report each at the PROD rev (0 here: never deployed); MOUNT-ERROR retried
// once after the old dev worker exited (the overlap rule is dev-only, D13); the `?rev=` window; static assets
// (DESIGN §6.1, §8.1; B1/B2). A dev LIVE never calls modulesChanged (D3).
import test from 'node:test'
import assert from 'node:assert/strict'
import { world, api, waitFor, sleep, APP_JSON, BACKEND, FRONTEND, CARD, fs, path } from './supervisor-harness.test.js'

const dev = { slot: 'dev' }

test('scan → claim → build → LIVE: API through the worker, assets from the rev dir, markers, onSwap, agent.log line', async () => {
  const w = world()
  w.app('alpha', { 'module.json': APP_JSON('Alpha'), 'backend.js': BACKEND(1), 'frontend.jsx': FRONTEND(1), 'card.jsx': CARD, 'styles.css': '.mine{}', 'logo.svg': '<svg/>' })
  const sup = w.make()
  try {
    await sup.boot()
    assert.deepEqual(sup.apps(), [])
    await sup.scan()
    const row = await waitFor(() => { const r = sup.resolve('acme', 'alpha'); return r?.dev_state === 'live' ? r : null })
    assert.equal(row.dev_rev, 1); assert.equal(row.uid, 20001); assert.match(row.instance, /^i-[0-9a-f]{16}$/)
    // a NEW folder is dev-only until its first deploy (D14/D17): no prod slot, no deployed_rev, prod answers 404
    assert.equal(row.rev, null); assert.equal(row.state, 'undeployed'); assert.equal(row.prod_rev, null); assert.equal(row.deployed_rev, null); assert.equal(row.prod_state, null)
    assert.deepEqual(w.devSwaps, [[row.instance, 1]])
    assert.deepEqual(w.swaps, [], 'a dev LIVE never fires onSwap'); assert.deepEqual(w.modules, [], 'a dev LIVE never calls modulesChanged (D3)')
    assert.match(w.lines.find((l) => l.includes('LIVE')), /^\[alpha\] rev 1 LIVE \(dev\) in \d+ ms$/)
    const r = await api(sup, row, '/rev')
    assert.equal(r.status, 200)
    assert.deepEqual(JSON.parse(r.body), { rev: 1, ctxRev: 1, user: 'p1' })
    const prod = await api(sup, row, '/rev', { slot: 'prod' })
    assert.equal(prod.status, 404); assert.deepEqual(JSON.parse(prod.body), { error: 'not deployed' })
    assert.equal(await sup.asset(row, 'frontend.js'), null, 'prod has no assets before the first deploy')
    const fe = await sup.asset(row, 'frontend.js', dev)
    assert.equal(fe.rev, 1); assert.equal(fe.type, 'application/javascript; charset=utf-8')
    assert.ok(fe.body.toString().includes('"p-1"') && fe.body.toString().includes('./card.js?rev=1'))
    assert.ok((await sup.asset(row, 'card.js', dev)).body.toString().includes('React.createElement("span"'))
    assert.equal((await sup.asset(row, 'styles.css', dev)).body.toString(), '.mine{}')
    const svg = await sup.asset(row, 'logo.svg', dev)
    assert.equal(svg.body.toString(), '<svg/>'); assert.equal(svg.type, 'image/svg+xml')
    for (const bad of ['backend.js', '../alpha/logo.svg', 'data/x', 'node_modules/x.js', '.env', '_p/x.js', 'nope.js', '/etc/passwd']) assert.equal(await sup.asset(row, bad, dev), null, bad)
    // markers + revision.json + the two pointers (D4): current-dev moves on a save, current is the prod release's
    const dot = path.join(w.work, '.atelier')
    assert.equal(fs.readFileSync(path.join(dot, row.instance, 'slug'), 'utf8'), 'alpha')
    const rev = JSON.parse(fs.readFileSync(path.join(dot, row.instance, 'revision.json'), 'utf8'))
    assert.equal(rev.live, 1); assert.equal(rev.rev, 1); assert.equal(rev.slug, 'alpha'); assert.equal(rev.protocol, 'atelier/2'); assert.ok(rev.fingerprint); assert.equal(rev.prod, undefined)
    assert.equal(fs.readlinkSync(path.join(dot, row.instance, 'current-dev')), `../last-good/${row.instance}/rev-1`)
    assert.ok(!fs.existsSync(path.join(dot, row.instance, 'current')), 'no prod pointer before the first deploy')
    assert.deepEqual(sup.workers().map((x) => [x.instance, x.slot]), [[row.instance, 'dev']])
    assert.equal(sup.workers()[0].dataDir, path.join(dot, 'data-dev', row.instance), 'dev data ≠ prod data (D1)')
    assert.equal(w.reports.length, 0)
    // the app-group rule (§6.2): every folder read ran with [20001] held, and the set is empty again after
    assert.ok(w.groups.some((g) => g.length === 1 && g[0] === 20001))
    assert.deepEqual(w.groups[w.groups.length - 1], [])
    assert.ok(w.groups.every((g) => g.every((u) => u === 20001)))
    // an unknown app → null; the fake registrar refuses `taken` → no row, a log line
    assert.equal(sup.resolve('acme', 'nope'), null)
    w.app('taken', { 'module.json': APP_JSON('T'), 'backend.js': BACKEND(1) })
    w.app('Bad_Name', { 'module.json': APP_JSON('B') })
    await sup.scan()
    assert.equal(sup.resolve('acme', 'taken'), null)
    assert.ok(w.lines.some((l) => /^\[taken\] claim refused: 409/.test(l)))
    assert.ok(w.lines.some((l) => /^\[Bad_Name\] refused: folder name/.test(l)))
  } finally { await w.done(sup) }
})

test('200 four-fetch observations across 3 saves → 0 mixed revisions, 0 non-2xx; the old worker stops after the swap', async () => {
  const w = world()
  w.app('beta', { 'module.json': APP_JSON('Beta'), 'backend.js': BACKEND(1), 'frontend.jsx': FRONTEND(1), 'card.jsx': CARD })
  const sup = w.make({ timing: { quiesceMs: 40, swapStopMs: 100, keepMs: 60_000 } })
  try {
    await sup.scan()
    const row = await waitFor(() => { const r = sup.resolve('acme', 'beta'); return r?.dev_state === 'live' ? r : null })
    let mixed = 0, bad = 0, n = 0, maxRev = 0
    const dir = path.join(w.work, 'apps', 'beta')
    const observe = async () => {
      const fe = await sup.asset(row, 'frontend.js', dev)
      if (!fe) { bad++; return }
      const N = fe.rev
      const [card, css, r] = await Promise.all([sup.asset(row, 'card.js', { rev: N, slot: 'dev' }), sup.asset(row, 'styles.css', { rev: N, slot: 'dev' }), api(sup, row, '/rev')])
      n++
      if (!card || !css || card.rev !== N || css.rev !== N) mixed++
      if (!fe.body.toString().includes(`"p-${N}"`) || !fe.body.toString().includes(`./card.js?rev=${N}`)) mixed++
      if (r.status !== 200) bad++
      else { const apiRev = JSON.parse(r.body).rev; if (apiRev < N) mixed++; maxRev = Math.max(maxRev, apiRev) }
    }
    const saves = (async () => {
      for (const rev of [2, 3, 4]) {
        await sleep(120)
        fs.writeFileSync(path.join(dir, 'backend.js'), BACKEND(rev))
        fs.writeFileSync(path.join(dir, 'frontend.jsx'), FRONTEND(rev))
        await waitFor(() => sup.resolve('acme', 'beta').dev_rev === rev)
      }
    })()
    const loop = (async () => { while (n < 200) { await observe(); await sleep(2) } })()
    await Promise.all([saves, loop])
    await observe()
    assert.equal(mixed, 0, 'mixed revisions')
    assert.equal(bad, 0, 'non-2xx')
    assert.ok(n >= 200)
    assert.equal(maxRev, 4)
    assert.deepEqual(w.devSwaps.map((s) => s[1]), [1, 2, 3, 4]); assert.deepEqual(w.swaps, [])
    await waitFor(() => sup.workers().length === 1)
    assert.equal(sup.workers()[0].pid, sup.rows.get(row.instance).dev.live.pid)
    assert.equal(w.reports.length, 0)
    // the previous rev stays addressable inside the window; older ones are pruned
    assert.equal((await sup.asset(row, 'frontend.js', { rev: 3, slot: 'dev' })).rev, 3)
    assert.equal(await sup.asset(row, 'frontend.js', { rev: 9, slot: 'dev' }), null)
    assert.ok(w.lines.filter((l) => /LIVE \(dev\)/.test(l)).length === 4)
  } finally { await w.done(sup) }
})

test('a syntax error, a throwing mount, a half-written save: users stay on the old rev, report() once each with file:line:col + hint', async () => {
  const w = world()
  const dir = w.app('gamma', { 'module.json': APP_JSON('Gamma'), 'backend.js': BACKEND(1), 'frontend.jsx': FRONTEND(1), 'card.jsx': CARD })
  const sup = w.make()
  try {
    await sup.scan()
    const row = await waitFor(() => { const r = sup.resolve('acme', 'gamma'); return r?.dev_state === 'live' ? r : null })
    const untouched = async (rev = 1, marker = '"p-1"') => {
      assert.equal(sup.resolve('acme', 'gamma').dev_rev, rev)
      assert.equal(JSON.parse((await api(sup, row, '/rev')).body).ctxRev, rev)   // served (resumed from the snapshot when the mount retry stopped the old worker)
      assert.ok((await sup.asset(row, 'frontend.js', dev)).body.toString().includes(marker))
    }
    // 1. JSX syntax error — the report's rev is the PROD rev (0: never deployed), its message wears the `dev:` head (D15)
    fs.writeFileSync(path.join(dir, 'frontend.jsx'), 'export default function App() {\n  return <div>\n}\n')
    await waitFor(() => w.reports.length === 1)
    await sleep(150); await untouched()
    assert.equal(w.reports[0].kind, 'build'); assert.equal(w.reports[0].rev, 0); assert.equal(w.reports[0].file, 'frontend.jsx'); assert.match(w.reports[0].message, /^dev: /)
    assert.match(w.reports[0].hint, /^frontend\.jsx:\d+:\d+ .* — (close the open JSX element|fix the syntax at that position)/)
    assert.match(w.lines.find((l) => /FAILED/.test(l)), /^\[gamma\] rev 2 FAILED \(dev\) frontend\.jsx:\d+:\d+ /)
    // 2. mountRoutes throws
    fs.writeFileSync(path.join(dir, 'frontend.jsx'), FRONTEND(1))
    fs.writeFileSync(path.join(dir, 'backend.js'), `export default { mountRoutes() {\n  throw new Error('db not reachable')\n} }\n`)
    await waitFor(() => w.reports.length === 2)
    await sleep(150); await untouched()
    assert.equal(w.reports[1].rev, 0)
    assert.match(w.reports[1].hint, /^backend\.js:\d+:\d+ mountRoutes threw: db not reachable — mountRoutes must only register routes/)
    // 3. half-written multi-file save (frontend imports a file that is not there yet)
    fs.writeFileSync(path.join(dir, 'backend.js'), BACKEND(1))
    fs.writeFileSync(path.join(dir, 'frontend.jsx'), `import { helper } from './helpers.js'\nexport default () => helper()\n`)
    await waitFor(() => w.reports.length === 3)
    await sleep(150); await untouched()
    assert.equal(w.reports[2].hint, 'frontend.jsx:1:24 Could not resolve "./helpers.js" — create ./helpers.js next to frontend.jsx (a multi-file save: write the imported file, then re-save) or fix the import path')
    // the second half of the save lands → LIVE
    fs.writeFileSync(path.join(dir, 'helpers.jsx'), 'export const helper = () => <b/>')
    await waitFor(() => sup.resolve('acme', 'gamma').dev_rev === 5)
    assert.equal(w.reports.length, 3)
    assert.ok((await sup.asset(row, 'helpers.js', dev)).body.toString().includes('React.createElement("b"'))
    // 4. a missing package: the ERR_MODULE_NOT_FOUND class, located at the import line
    fs.writeFileSync(path.join(dir, 'backend.js'), `import { createRequire } from 'node:module'\nimport lp from 'leftpad-nope'\nexport default { mountRoutes() {} }\n`)
    await waitFor(() => w.reports.length === 4)
    assert.equal(w.reports[3].hint, `backend.js:2:16 Cannot find package 'leftpad-nope' — run npm install leftpad-nope in ${dir} and re-save backend.js, or remove the import`)
    await untouched(5, './helpers.js?rev=5')
    // 5. module.json invalid → the module.json class; users untouched; then fixed → LIVE
    fs.writeFileSync(path.join(dir, 'backend.js'), BACKEND(1))
    fs.writeFileSync(path.join(dir, 'module.json'), '{"name": }')
    await waitFor(() => w.reports.length >= 5)
    const mj = w.reports.find((r) => r.file === 'module.json')
    assert.match(mj.hint, /^module\.json:1:\d+ invalid JSON: .* — fix the JSON/)
    fs.writeFileSync(path.join(dir, 'module.json'), APP_JSON('Gamma'))
    await waitFor(() => sup.resolve('acme', 'gamma').dev_state === 'live' && sup.resolve('acme', 'gamma').dev_rev > 5)
  } finally { await w.done(sup) }
})

test('MOUNT-ERROR beside a live DEV worker is retried once after the old worker exited (the sqlite overlap rule, dev-only — D13)', async () => {
  const w = world()
  const v1 = `import fs from 'node:fs'\nexport default { mountRoutes(router, ctx) { fs.writeFileSync(ctx.dataDir + '/lock', '1'); router.get('/rev', (req, res) => res.json({ rev: 1 })); return () => fs.rmSync(ctx.dataDir + '/lock', { force: true }) } }\n`
  const v2 = `import fs from 'node:fs'\nexport default { mountRoutes(router, ctx) { if (fs.existsSync(ctx.dataDir + '/lock')) throw new Error('database is locked'); router.get('/rev', (req, res) => res.json({ rev: 2 })) } }\n`
  const dir = w.app('delta', { 'module.json': APP_JSON('Delta'), 'backend.js': v1 })
  const sup = w.make()
  try {
    await sup.scan()
    const row = await waitFor(() => { const r = sup.resolve('acme', 'delta'); return r?.dev_state === 'live' ? r : null })
    fs.writeFileSync(path.join(dir, 'backend.js'), v2)
    await waitFor(() => sup.resolve('acme', 'delta').dev_rev === 2)
    assert.ok(w.lines.some((l) => /^\[delta\] rev 2 mount failed beside rev 1 — retrying once after the old worker exits$/.test(l)))
    assert.equal(w.reports.length, 0, 'the retry succeeded: nothing reported')
    assert.equal(JSON.parse((await api(sup, row, '/rev')).body).rev, 2)
    assert.equal(sup.workers().length, 1)
  } finally { await w.done(sup) }
})

test('the ?rev= window: the previous rev is served for keepMs, then pruned; `current` always names the live one', async () => {
  const w = world()
  const dir = w.app('eps', { 'module.json': APP_JSON('Eps'), 'backend.js': BACKEND(1), 'frontend.jsx': 'export default () => <i className="p-1"/>' })
  const sup = w.make({ timing: { keepMs: 300 } })
  try {
    await sup.scan()
    const row = await waitFor(() => { const r = sup.resolve('acme', 'eps'); return r?.dev_state === 'live' ? r : null })
    fs.writeFileSync(path.join(dir, 'frontend.jsx'), 'export default () => <i className="p-2"/>')
    await waitFor(() => sup.resolve('acme', 'eps').dev_rev === 2)
    assert.equal((await sup.asset(row, 'frontend.js', { rev: 1, slot: 'dev' })).rev, 1)
    assert.deepEqual(sup.store.list(row.instance), [1, 2])
    await waitFor(() => sup.store.list(row.instance).length === 1, { ms: 3000 })
    assert.deepEqual(sup.store.list(row.instance), [2])
    assert.equal(await sup.asset(row, 'frontend.js', { rev: 1, slot: 'dev' }), null)
    assert.equal((await sup.asset(row, 'frontend.js', dev)).rev, 2)
    assert.equal(sup.store.currentDev(row.instance).rev, 2); assert.equal(sup.store.current(row.instance), null)
  } finally { await w.done(sup) }
})

test('the 30 s sweep does not rebuild an unchanged broken folder: one rev, one report, and a real change is still caught', async () => {
  const w = world()
  const dir = w.app('zeta', { 'module.json': APP_JSON('Zeta'), 'backend.js': BACKEND(1), 'frontend.jsx': FRONTEND(1), 'card.jsx': CARD })
  const sup = w.make()
  try {
    await sup.scan()
    const row = await waitFor(() => { const r = sup.resolve('acme', 'zeta'); return r?.dev_state === 'live' ? r : null })
    const revJson = () => JSON.parse(fs.readFileSync(path.join(w.work, '.atelier', row.instance, 'revision.json'), 'utf8'))
    // ONE broken save — the stray `}` of the 2026-08-31 drill
    fs.appendFileSync(path.join(dir, 'backend.js'), '}\n')
    await waitFor(() => w.reports.length === 1)
    assert.equal(w.reports[0].kind, 'build'); assert.equal(w.reports[0].rev, 0)
    assert.equal(revJson().rev, 2)
    // three sweeps over the unchanged folder: no rebuild, no rev minted, nothing re-reported
    for (let i = 0; i < 3; i++) await sup.scan()
    await sleep(150)
    assert.equal(w.reports.length, 1, 'a failed build is the folder\'s answer — the sweep does not ask again')
    assert.equal(revJson().rev, 2, 'no rev for a retry of an unchanged folder')
    assert.equal(sup.resolve('acme', 'zeta').dev_rev, 1)
    assert.equal(w.lines.filter((l) => /^\[zeta\] rev \d+ FAILED/.test(l)).length, 1)
    // the sweep is still the net under the watcher: with the watcher dead, a real change is built
    sup.rows.get(row.instance).watcher.stop()
    fs.writeFileSync(path.join(dir, 'backend.js'), BACKEND(2))
    await sup.scan()
    await waitFor(() => sup.resolve('acme', 'zeta').dev_rev === 3)
    assert.equal(w.reports.length, 1)
    assert.equal(revJson().rev, 3)
    assert.equal(JSON.parse((await api(sup, row, '/rev')).body).rev, 2)
  } finally { await w.done(sup) }
})

test('a module.json that does not parse is reported once, not once per sweep', async () => {
  const w = world()
  const dir = w.app('eta', { 'module.json': APP_JSON('Eta'), 'backend.js': BACKEND(1), 'frontend.jsx': FRONTEND(1), 'card.jsx': CARD })
  const sup = w.make()
  try {
    await sup.scan()
    await waitFor(() => sup.resolve('acme', 'eta')?.dev_state === 'live')
    fs.writeFileSync(path.join(dir, 'module.json'), '{"name": }')
    await waitFor(() => w.reports.length === 1)
    assert.equal(w.reports[0].file, 'module.json'); assert.equal(w.reports[0].rev, 0)
    // discovery calls the folder a `problem` on every sweep; the folder has not changed since rev 2
    for (let i = 0; i < 3; i++) await sup.scan()
    await sleep(150)
    assert.equal(w.reports.length, 1)
    fs.writeFileSync(path.join(dir, 'module.json'), APP_JSON('Eta'))
    await waitFor(() => sup.resolve('acme', 'eta').dev_rev === 3)
    assert.equal(w.reports.length, 1)
  } finally { await w.done(sup) }
})
