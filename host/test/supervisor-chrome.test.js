// supervisor.rebuildAll (step 7 ship C, decision 8) with REAL workers and REAL git: after a chrome swap every prod slot gets
// a NEW rev = the same code + a sheet compiled against the new chrome (`/_chrome/<digest>/fonts/…` rebased), `current`
// moves, the previous rev stays addressable through ?rev= for the window, ONE onSwap/modulesChanged per app, the prod
// worker keeps running (no gate, no restart), revision.json names the digest, the dev slot is rebuilt too; an undeployed
// row gets a dev rebuild alone; a row mid-deploy is skipped; a broken chrome sheet keeps the old rev.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { world, api, deploy, waitFor, FRONTEND, CARD, fs, path } from './supervisor-harness.test.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const BACKEND = `export default { mountRoutes(router, ctx) { router.get('/rev', (req, res) => res.json({ ctxRev: ctx.rev, pid: process.pid })) } }\n`
const MJ = JSON.stringify({ name: 'Todo', icon: 'cloud', healthz: '/rev' })
const live = (sup, slug, slot = 'dev') => waitFor(() => { const r = sup.resolve('acme', slug); return r?.[`${slot}_state`] === 'live' ? r : null })
const dot = (w, ...p) => path.join(w.work, '.atelier', ...p)
const readlink = (p) => { try { return fs.readlinkSync(p) } catch { return null } }
const revJson = (w, inst) => JSON.parse(fs.readFileSync(dot(w, inst, 'revision.json'), 'utf8'))

// two chrome folders under the world root, a fake cache seam that names one of them (dir/base/digest, as host/chrome/fetch.mjs does)
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
  const BROKEN = { digest: 'c'.repeat(64), dir: mk('chrome-c', '#778899', '.broken { color: red\n') }
  const cur = { now: A }
  const seam = { dir: () => cur.now.dir, base: () => `/_chrome/${cur.now.digest}`, digest: () => cur.now.digest, swap: (to) => { cur.now = to } }
  return { A, B, BROKEN, seam }
}

test('rebuildAll: the prod sheet rebuilt against the new chrome as a new rev of the same code — current moves, the old rev stays addressable, one modulesChanged, the worker keeps its pid, revision.json.chrome = the digest; the dev slot rebuilt too; an undeployed row: dev alone; a broken chrome keeps the old rev', async () => {
  const w = world({ gitCommit: true })
  const { A, B, BROKEN, seam } = chromes(w)
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
    assert.equal(revJson(w, inst).chrome, A.digest, 'revision.json.chrome = the digest the sheet was built with')
    const modulesBefore = w.modules.length, swapsBefore = w.swaps.length, devSwapsBefore = w.devSwaps.length
    // the swap: chrome B
    seam.swap(B)
    const r = await sup.rebuildAll(B.digest.slice(0, 12))
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
    assert.equal(rj.chrome, B.digest); assert.equal(rj.prod.rev, 3); assert.equal(rj.prod.commit, v.commit); assert.equal(rj.prod.message, `chrome ${B.digest.slice(0, 12)}`)
    assert.equal(JSON.parse((await api(sup, row, '/rev', { slot: 'prod' })).body).pid, pid0, 'the API is served by the same worker')
    assert.ok(w.lines.some((l) => l === `[todo] rev 3 chrome ${B.digest.slice(0, 12)} (prod sheet rebuilt from rev 2)`), w.lines.filter((l) => l.includes('chrome')).join('\n'))
    // the dev rebuild landed too (a later rev), its sheet against B
    await waitFor(() => (sup.resolve('acme', 'todo').dev_rev ?? 0) >= 4)
    assert.ok(w.devSwaps.length > devSwapsBefore)
    const devSheet = await sup.asset(row, 'styles.css', { slot: 'dev' })
    assert.ok(devSheet.body.toString().includes('#445566'))
    assert.equal(w.releases.length, 1, 'a chrome rebuild is not a release row')
    // a broken chrome: the old rev keeps its sheet, one log line, nothing moves
    seam.swap(BROKEN)
    const r2 = await sup.rebuildAll('broken')
    assert.deepEqual(r2.prod, []); assert.equal(sup.resolve('acme', 'todo').prod_rev, 3); assert.equal(readlink(dot(w, inst, 'current')), `../last-good/${inst}/rev-3`)
    assert.ok(w.lines.some((l) => /^\[todo\] chrome broken: prod sheet NOT rebuilt \(/.test(l)), w.lines.filter((l) => l.includes('chrome')).join('\n'))
    // a row mid-deploy is skipped (its own release builds against the chrome the host holds)
    seam.swap(B)
    sup.rows.get(inst).deploying = Promise.resolve()
    assert.deepEqual((await sup.rebuildAll('busy')).prod, [])
    sup.rows.get(inst).deploying = null
    const r3 = await sup.rebuildAll('again')
    assert.equal(r3.prod.length, 1); assert.equal(r3.prod[0][0], inst); assert.ok(r3.prod[0][1] > 3, 'and rebuilds once the deploy is over (the dev rebuilds in between took revs of their own)')
    assert.equal(sup.resolve('acme', 'todo').prod_rev, r3.prod[0][1])
  } finally { await w.done(sup) }
})
