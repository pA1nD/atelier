// supervisor.rebuildAll (step 7 ship C, decision 8; review 2026-09-02 S2) with REAL workers and REAL git: after a chrome swap
// every deployed prod slot whose sheet is not built against the held chrome gets a NEW rev = the same code + a sheet
// compiled against it (`/_chrome/<digest>/fonts/…` rebased), `current` moves, the previous rev stays addressable through
// ?rev= for the window, ONE onSwap/modulesChanged per app, the prod worker keeps running (no gate, no restart) and its
// reports carry the NEW rev, revision.json.prod.chrome names the digest, the dev slot is rebuilt too; the rebuild is
// idempotent (nothing behind = nothing moves) and ALL OR NOTHING: a broken chrome sheet or a row mid-deploy commits no
// row at all (`complete: false`, the reason named once) and the next call tries again.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { world, api, deploy, waitFor, FRONTEND, CARD, fs, path } from './supervisor-harness.test.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const BACKEND = `export default { mountRoutes(router, ctx) { router.get('/rev', (req, res) => res.json({ ctxRev: ctx.rev, pid: process.pid })); router.get('/boom', () => { throw new Error('boom') }) } }\n`
const MJ = JSON.stringify({ name: 'Todo', icon: 'cloud', healthz: '/rev' })
const live = (sup, slug, slot = 'dev') => waitFor(() => { const r = sup.resolve('acme', slug); return r?.[`${slot}_state`] === 'live' ? r : null })
const dot = (w, ...p) => path.join(w.work, '.atelier', ...p)
const readlink = (p) => { try { return fs.readlinkSync(p) } catch { return null } }
const revJson = (w, inst) => JSON.parse(fs.readFileSync(dot(w, inst, 'revision.json'), 'utf8'))

// chrome folders under the world root, a fake cache seam that names one of them (dir/base/digest, as host/chrome/fetch.mjs does)
function chromes(w) {
  const mk = (name, color, extra = '') => {
    const d = path.join(w.root, name)
    fs.mkdirSync(d, { recursive: true })
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(d, 'node_modules'))
    fs.writeFileSync(path.join(d, 'styles.css'), `@font-face { font-family: 'Inter'; src: url('fonts/Inter.woff2'); }\n@import 'tailwindcss';\n@theme { --color-brand: ${color}; }\n.atelier-rail { display: flex }\n${extra}`)
    fs.writeFileSync(path.join(d, 'frontend.jsx'), `export function chrome() { return <nav className="w-64 text-brand">r</nav> }\n`)   // text-brand: the theme variable is emitted only when used
    return d
  }
  const A = { digest: 'a'.repeat(64), dir: mk('chrome-a', '#112233') }, B = { digest: 'b'.repeat(64), dir: mk('chrome-b', '#445566') }
  const C = { digest: 'c'.repeat(64), dir: mk('chrome-c', '#aabbcc') }
  const BROKEN = { digest: 'd'.repeat(64), dir: mk('chrome-d', '#778899', '.broken { color: red\n') }
  const cur = { now: A }
  const seam = { dir: () => cur.now.dir, base: () => `/_chrome/${cur.now.digest}`, digest: () => cur.now.digest, swap: (to) => { cur.now = to } }
  return { A, B, C, BROKEN, seam }
}

test('rebuildAll: the prod sheet rebuilt against the new chrome as a new rev of the same code — current moves, the old rev stays addressable, one modulesChanged, the worker keeps its pid and reports the NEW rev, revision.json.prod.chrome = the digest; the dev slot rebuilt too; an undeployed row: dev alone; idempotent; a broken chrome or a row mid-deploy commits NOTHING (complete: false) and the next call retries', async () => {
  const w = world({ gitCommit: true })
  const { A, B, C, BROKEN, seam } = chromes(w)
  w.app('todo', { 'module.json': MJ, 'backend.js': BACKEND, 'frontend.jsx': FRONTEND(1), 'card.jsx': CARD })
  w.app('draft', { 'module.json': JSON.stringify({ name: 'Draft' }), 'backend.js': BACKEND, 'frontend.jsx': FRONTEND(1), 'card.jsx': CARD })
  const sup = w.make({ chrome: seam })
  try {
    await sup.scan()
    const row = await live(sup, 'todo'); await live(sup, 'draft')
    const inst = row.instance
    const v = await deploy(sup, row, { message: 'first' })
    assert.equal(v.outcome, 'green', JSON.stringify(v)); assert.equal(v.rev, 2)
    const before = (await sup.asset(row, 'styles.css')).body.toString()
    assert.ok(before.includes('#112233') && before.includes(`/_chrome/${A.digest}/fonts/Inter.woff2`), 'the deploy built the prod sheet against chrome A, fonts rebased')
    const pid0 = sup.workers().find((x) => x.slot === 'prod').pid
    assert.equal(revJson(w, inst).chrome, A.digest, 'revision.json.chrome = the chrome the DEV sheet was built with')
    assert.equal(revJson(w, inst).prod.chrome, A.digest, 'revision.json.prod.chrome = the chrome the deploy built the PROD sheet with')
    // nothing behind: nothing moves (the beat-time call)
    assert.deepEqual(await sup.rebuildAll('idle'), { prod: [], dev: [], skipped: [], complete: true })
    assert.equal(sup.resolve('acme', 'todo').prod_rev, 2)
    const modulesBefore = w.modules.length, swapsBefore = w.swaps.length, devSwapsBefore = w.devSwaps.length
    // the swap: chrome B
    seam.swap(B)
    const r = await sup.rebuildAll(B.digest.slice(0, 12))
    assert.equal(r.complete, true); assert.deepEqual(r.skipped, [])
    assert.deepEqual(r.prod, [[inst, 3]], 'one prod rebuild: the deployed app'); assert.deepEqual(r.dev.sort(), [inst, sup.resolve('acme', 'draft').instance].sort(), 'every linked row rebuilds dev')
    const after = sup.resolve('acme', 'todo')
    assert.equal(after.prod_rev, 3); assert.equal(after.rev, 3); assert.equal(after.prod_state, 'live'); assert.equal(after.deployed_rev, v.commit, 'the commit did not move')
    assert.equal(readlink(dot(w, inst, 'current')), `../last-good/${inst}/rev-3`)
    const sheet = await sup.asset(row, 'styles.css')
    assert.equal(sheet.rev, 3)
    assert.ok(sheet.body.toString().includes('#445566') && sheet.body.toString().includes(`/_chrome/${B.digest}/fonts/Inter.woff2`), 'the new sheet carries chrome B and its font url')
    assert.ok(!sheet.body.toString().includes('#112233'))
    assert.equal((await sup.asset(row, 'styles.css', { rev: 2 })).body.toString(), before, 'the previous rev stays addressable inside the window')
    assert.equal((await sup.asset(row, 'frontend.js')).body.toString(), (await sup.asset(row, 'frontend.js', { rev: 2 })).body.toString(), 'the same frontend bytes at the new rev')
    assert.equal(fs.readFileSync(dot(w, 'last-good', inst, 'rev-3', 'backend.js'), 'utf8'), fs.readFileSync(dot(w, 'last-good', inst, 'rev-2', 'backend.js'), 'utf8'), 'the same backend bytes')
    assert.deepEqual(w.modules.slice(modulesBefore), [[inst, 3]]); assert.deepEqual(w.swaps.slice(swapsBefore), [[inst, 3]])
    assert.equal(sup.workers().find((x) => x.slot === 'prod').pid, pid0, 'the prod worker keeps running — no gate, no restart')
    const rj = revJson(w, inst)
    assert.equal(rj.prod.chrome, B.digest, 'prod.chrome = the digest the prod sheet is built with'); assert.equal(rj.prod.rev, 3); assert.equal(rj.prod.commit, v.commit); assert.equal(rj.prod.message, `chrome ${B.digest.slice(0, 12)}`)
    assert.equal(JSON.parse((await api(sup, row, '/rev', { slot: 'prod' })).body).pid, pid0, 'the API is served by the same worker')
    assert.ok(w.lines.some((l) => l === `[todo] rev 3 chrome ${B.digest.slice(0, 12)} (prod sheet rebuilt from rev 2)`), w.lines.filter((l) => l.includes('chrome')).join('\n'))
    // the running worker was born at rev 2; its reports carry the slot's rev 3 (Grok 2: a report at rev 2 is stale-rev everywhere)
    const reportsBefore = w.reports.length
    assert.equal((await api(sup, row, '/boom', { slot: 'prod' })).status, 500)
    const http = await waitFor(() => w.reports.slice(reportsBefore).find((x) => x.kind === 'http'))
    assert.equal(http.rev, 3, 'the prod worker reports against the slot\'s rev, not its birth rev')
    // the dev rebuild landed too (a later rev), its sheet against B; revision.json.chrome (the dev build's) follows
    await waitFor(() => (sup.resolve('acme', 'todo').dev_rev ?? 0) >= 4)
    assert.ok(w.devSwaps.length > devSwapsBefore)
    const devSheet = await sup.asset(row, 'styles.css', { slot: 'dev' })
    assert.ok(devSheet.body.toString().includes('#445566'))
    await waitFor(() => revJson(w, inst).chrome === B.digest)
    assert.equal(w.releases.length, 1, 'a chrome rebuild is not a release row')
    // built already: the same digest again is a no-op — no rev, no modulesChanged, no dev rebuild
    const modulesAt = w.modules.length, devSwapsAt = w.devSwaps.length
    assert.deepEqual(await sup.rebuildAll('beat'), { prod: [], dev: [], skipped: [], complete: true })
    assert.equal(sup.resolve('acme', 'todo').prod_rev, 3); assert.equal(w.modules.length, modulesAt); assert.equal(w.devSwaps.length, devSwapsAt)
    // a broken chrome: nothing commits, the reason is named ONCE across calls, prod.chrome stays B (the computer keeps reporting B)
    seam.swap(BROKEN)
    const r2 = await sup.rebuildAll('broken')
    assert.equal(r2.complete, false); assert.deepEqual(r2.prod, []); assert.equal(r2.skipped.length, 1); assert.equal(r2.skipped[0][0], inst); assert.match(r2.skipped[0][1], /^css: /)
    assert.equal(sup.resolve('acme', 'todo').prod_rev, 3); assert.equal(readlink(dot(w, inst, 'current')), `../last-good/${inst}/rev-3`); assert.equal(revJson(w, inst).prod.chrome, B.digest)
    const r2b = await sup.rebuildAll('broken')
    assert.equal(r2b.complete, false); assert.deepEqual(r2b.prod, [])
    assert.equal(w.lines.filter((l) => /^\[todo\] chrome broken: prod sheet NOT rebuilt \(/.test(l)).length, 1, 'one line for the stuck row, not one per beat: ' + w.lines.filter((l) => l.includes('chrome')).join('\n'))
    // a row mid-deploy while chrome C lands: nothing commits (its own release builds against the held chrome); once the deploy
    // is over the next call rebuilds it — the digest is reported only then
    seam.swap(C)
    sup.rows.get(inst).deploying = Promise.resolve()
    const busy = await sup.rebuildAll('busy')
    assert.equal(busy.complete, false); assert.deepEqual(busy.prod, []); assert.deepEqual(busy.skipped, [[inst, 'deploying']])
    assert.equal(sup.resolve('acme', 'todo').prod_rev, 3); assert.equal(revJson(w, inst).prod.chrome, B.digest)
    sup.rows.get(inst).deploying = null
    const r3 = await sup.rebuildAll('again')
    assert.equal(r3.complete, true); assert.equal(r3.prod.length, 1); assert.equal(r3.prod[0][0], inst); assert.ok(r3.prod[0][1] > 3, 'and rebuilds once the deploy is over (the dev rebuilds in between took revs of their own)')
    assert.equal(sup.resolve('acme', 'todo').prod_rev, r3.prod[0][1]); assert.equal(revJson(w, inst).prod.chrome, C.digest)
    assert.ok((await sup.asset(row, 'styles.css')).body.toString().includes('#aabbcc'))
  } finally { await w.done(sup) }
})
