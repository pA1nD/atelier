// supervisor/deploy.mjs with REAL workers, REAL git and the REAL hook runner (unprivileged()): the release protocol
// of DESIGN §10.3 — a green deploy (prod rev, dev untouched, the two pointers, one modulesChanged, one release row
// of the contract's shape); red at EVERY rehearsal step (prod bytes/rev/pointer unchanged, ONE `build` report with
// the D15 words, no backup, the rehearsal copy gone); the gate (a 50 ms request loop across a deploy sees 0 non-2xx,
// 0 mixed revs, latency < the hold; a 3 s hook holds requests; a hook past the hold answers the shell's waking
// bytes); a failure AFTER the gate (503 down, ONE `worker` report naming the backup, the backup holds the
// pre-migration bytes, `atelier restore` brings them back); rollback = no hook, no data; the config release (D16);
// adopt (D14: a legacy layout boots serving, one commit, `prod.legacy`, no export, idempotent); backup pruning 3
// and the refusal before the gate (D11); the spine's release door absent (404) never blocks.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { world, api, deploy, waitFor, sleep, makeSpawn, APP_JSON, BACKEND, FRONTEND, CARD, fs, path } from './supervisor-harness.test.js'
import { WAKING_BODY, WAKING_HEADERS } from '../../shell/proxy.mjs'
import { MESSAGES } from '../supervisor/deploy.mjs'
import { TransportError } from '../protocol/registrar.mjs'
import { installDeps } from '../worker/install.mjs'

const prod = { slot: 'prod' }
const HEX40 = /^[0-9a-f]{40}$/
// an app with data: /rev, /data (reads counter.txt in ctx.dataDir), /write?v= (writes it), /boom (throws → 500)
const DATA_BACKEND = (rev) => `import fs from 'node:fs'\nimport path from 'node:path'\nexport default { mountRoutes(router, ctx) {\n  const f = path.join(ctx.dataDir, 'counter.txt')\n  router.get('/rev', (req, res) => res.json({ rev: ${rev}, ctxRev: ctx.rev, user: req.user }))\n  router.get('/data', (req, res) => res.json({ v: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null, rev: ${rev} }))\n  router.get('/write', (req, res) => { fs.writeFileSync(f, req.query.v); res.json({ ok: true }) })\n  router.get('/boom', () => { throw new Error('boom ${rev}') })\n} }\n`
const MJ = (extra = {}) => JSON.stringify({ name: 'Todo', icon: 'cloud', ...extra })
const live = (sup, slug, slot = 'dev') => waitFor(() => { const r = sup.resolve('acme', slug); return r?.[`${slot}_state`] === 'live' ? r : null })
const dot = (w, ...p) => path.join(w.work, '.atelier', ...p)
const readlink = (p) => { try { return fs.readlinkSync(p) } catch { return null } }
const revJson = (w, inst) => JSON.parse(fs.readFileSync(dot(w, inst, 'revision.json'), 'utf8'))
const gitLog = (dir) => execFileSync('git', ['-C', dir, 'log', '--format=%H %s'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
const gitHead = (dir) => execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

async function setup(w, slug, files, opts = {}) {
  const dir = w.app(slug, files)
  const sup = w.make(opts)
  await sup.scan()
  const row = await live(sup, slug)
  return { dir, sup, row }
}

test('green: commit → rehearsal → gate → record: prod serves the released commit\'s export, dev is untouched, `current` moves and `current-dev` does not, ONE modulesChanged, ONE release row of the contract\'s shape, the verdict, the rows the CLI lists', async () => {
  const w = world({ gitCommit: true })
  const { dir, sup, row } = await setup(w, 'todo', { 'module.json': MJ({ healthz: '/rev' }), 'backend.js': DATA_BACKEND(1), 'frontend.jsx': FRONTEND(1), 'card.jsx': CARD, 'logo.svg': '<svg/>' })
  try {
    const inst = row.instance
    const v = await deploy(sup, row, { message: 'first release', by: 'agent:p-agent' })
    assert.equal(v.outcome, 'green', JSON.stringify(v))
    assert.deepEqual(v.steps.map((s) => s.name), ['commit', 'copy', 'export', 'install', 'build', 'hook', 'boot', 'probe', 'test', 'smoke', 'drain', 'stop', 'backup', 'migrate', 'start', 'probe', 'release', 'record'])
    assert.ok(v.steps.every((s) => s.ok), 'every step ok')
    assert.match(v.commit, HEX40); assert.equal(v.rev, 2); assert.equal(v.slug, 'todo'); assert.equal(v.kind, 'deploy')
    assert.equal(v.url, 'http://127.0.0.1:1844/acme/todo'); assert.equal(v.api, 'http://127.0.0.1:1844/api/acme/todo')
    assert.equal(v.commit, gitHead(dir), 'the release is the HEAD the deploy committed')
    assert.deepEqual(gitLog(dir).map((l) => l.split(' ').slice(1).join(' ')), ['first release'])
    assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), MESSAGES.git.gitignore)
    // the row: prod rev 2 from the export, dev rev 1 unchanged; deployed_rev = the commit
    const r = sup.resolve('acme', 'todo')
    assert.equal(r.rev, 2); assert.equal(r.prod_rev, 2); assert.equal(r.dev_rev, 1); assert.equal(r.state, 'live'); assert.equal(r.prod_state, 'live'); assert.equal(r.deployed_rev, v.commit)
    assert.deepEqual(JSON.parse((await api(sup, row, '/rev', prod)).body), { rev: 1, ctxRev: 2, user: 'p1' })
    assert.deepEqual(JSON.parse((await api(sup, row, '/rev')).body), { rev: 1, ctxRev: 1, user: 'p1' }, 'dev still serves rev 1')
    assert.equal((await sup.asset(row, 'frontend.js')).rev, 2); assert.equal((await sup.asset(row, 'frontend.js', { slot: 'dev' })).rev, 1)
    assert.equal((await sup.asset(row, 'logo.svg')).body.toString(), '<svg/>', 'prod static files come from the export')
    // the pointers and the prod block (D4)
    assert.equal(readlink(dot(w, inst, 'current')), `../last-good/${inst}/rev-2`); assert.equal(readlink(dot(w, inst, 'current-dev')), `../last-good/${inst}/rev-1`)
    const rj = revJson(w, inst)
    assert.equal(rj.rev, 2); assert.equal(rj.live, 1); assert.deepEqual(Object.keys(rj.prod).sort(), ['commit', 'deployedAt', 'message', 'rev']); assert.equal(rj.prod.commit, v.commit); assert.equal(rj.prod.message, 'first release')
    // the export (D1/D2): the committed tree, no .git, no data; the prod worker's cwd
    const exp = dot(w, 'prod', inst, v.commit.slice(0, 12))
    assert.deepEqual(fs.readdirSync(exp).sort(), ['.gitignore', 'backend.js', 'card.jsx', 'frontend.jsx', 'logo.svg', 'module.json'], 'the committed tree (the host\'s .gitignore included), no .git, no data')
    assert.equal(sup.rows.get(inst).prod.appDir, exp)
    assert.equal(sup.workers().find((x) => x.slot === 'prod').dataDir, dot(w, 'data', inst))
    assert.ok(!fs.existsSync(dot(w, 'rehearsal', inst, 'data')), 'the rehearsal copy is deleted')
    assert.ok(!fs.existsSync(dot(w, 'backup', inst)), 'a first deploy has no data to back up')
    // one modulesChanged (the prod rev), one onSwap, one release row (the contract's shape), the local ledger, no report
    assert.deepEqual(w.modules, [[inst, 2]]); assert.deepEqual(w.swaps, [[inst, 2]]); assert.deepEqual(w.devSwaps, [[inst, 1]])
    assert.equal(w.releases.length, 1)
    const rel = w.releases[0]
    assert.deepEqual(Object.keys(rel).sort(), ['at', 'backup', 'by', 'changelog', 'commit', 'error', 'id', 'instance', 'kind', 'message', 'rehearsal', 'rev', 'verdict'])
    assert.match(rel.id, /^r-[0-9a-f]{16}$/); assert.equal(rel.instance, inst); assert.equal(rel.kind, 'deploy'); assert.equal(rel.commit, v.commit); assert.equal(rel.message, 'first release'); assert.equal(rel.by, 'agent:p-agent'); assert.equal(rel.verdict, 'green'); assert.equal(rel.rev, 2); assert.equal(rel.backup, null); assert.equal(rel.error, null); assert.equal(rel.changelog, null)
    assert.match(rel.at, /^\d{4}-\d{2}-\d{2}T/); assert.equal(rel.rehearsal.partial, false); assert.ok(rel.rehearsal.ms > 0); assert.deepEqual(rel.rehearsal.steps.map((s) => s.name).slice(0, 4), ['commit', 'copy', 'export', 'install']); assert.ok(rel.rehearsal.steps.every((s) => Number.isInteger(s.ms) && s.ok === true))
    assert.deepEqual(sup.releases(inst), [rel]); assert.deepEqual(sup.backups(inst), [])
    assert.equal(JSON.parse(fs.readFileSync(dot(w, inst, 'releases.jsonl'), 'utf8').trim()).id, rel.id)
    assert.equal(w.reports.length, 0, 'green sends no report')
    assert.ok(w.lines.some((l) => new RegExp(`^\\[todo\\] rev 2 LIVE \\(prod\\) commit ${v.commit.slice(0, 12)} in \\d+ ms$`).test(l)))
    assert.ok(w.lines.some((l) => /^\[todo\] deploy [0-9a-f]{12} "first release": commit ok \d+ ms — [0-9a-f]{12} "first release"$/.test(l)), 'the agent.log step line')
    // a second deploy: the new prod rev, the old one addressable through ?rev= for the window, the previous export pruned only when a third commit lands
    fs.writeFileSync(path.join(dir, 'backend.js'), DATA_BACKEND(2))
    await waitFor(() => sup.resolve('acme', 'todo').dev_rev === 3)
    const v2 = await deploy(sup, row, { message: 'second' })
    assert.equal(v2.outcome, 'green'); assert.equal(v2.rev, 4); assert.notEqual(v2.commit, v.commit)
    assert.equal(JSON.parse((await api(sup, row, '/rev', prod)).body).rev, 2)
    assert.equal((await sup.asset(row, 'frontend.js', { rev: 2 })).rev, 2, 'the previous prod rev stays addressable inside the window')
    assert.deepEqual(w.modules, [[inst, 2], [inst, 4]])
    assert.equal(sup.releases(inst).length, 2); assert.equal(sup.releases(inst)[0].rev, 4, 'newest first')
    assert.ok(fs.existsSync(exp), 'the previous release\'s export is kept (the rollback target)')
    // the backup of the second deploy: none — prod had no data yet; write some, deploy again → one backup with the bytes before the migration
    assert.equal((await api(sup, row, '/write?v=v1', prod)).status, 200)
    fs.writeFileSync(path.join(dir, 'backend.js'), DATA_BACKEND(3))
    await waitFor(() => sup.resolve('acme', 'todo').dev_rev === 5)
    const v3 = await deploy(sup, row, { message: 'third' })
    assert.equal(v3.outcome, 'green'); assert.match(v3.backup, /^\d{8}T\d{6}Z-rev4-[0-9a-f]{12}$/)
    assert.equal(fs.readFileSync(dot(w, 'backup', inst, v3.backup, 'counter.txt'), 'utf8'), 'v1')
    assert.deepEqual(sup.backups(inst).map((b) => [b.id, b.rev]), [[v3.backup, 4]])
    assert.equal(w.releases.at(-1).backup, v3.backup)
    assert.ok(!fs.existsSync(exp), 'the export two releases back is pruned')
  } finally { await w.done(sup) }
})

test('red at EACH rehearsal step: build error, hook exit 1, hook timeout, boot MOUNT-ERROR, probe 5xx, test fail, smoke fail → prod bytes/rev/`current` unchanged, ONE build report with the D15 words at the PROD rev, no backup, the rehearsal copy gone; red at commit = no report', async () => {
  const w = world({ gitCommit: true })
  const { dir, sup, row } = await setup(w, 'todo', { 'module.json': MJ(), 'backend.js': DATA_BACKEND(1), 'frontend.jsx': FRONTEND(1), 'card.jsx': CARD }, { timing: { deploy: { hookMs: 400, testMs: 400, smokeMs: 400 } } })
  try {
    const inst = row.instance
    const first = await deploy(sup, row, { message: 'first' })
    assert.equal(first.outcome, 'green'); assert.equal(first.rev, 2)
    assert.equal((await api(sup, row, '/write?v=v1', prod)).status, 200)
    const c12 = first.commit.slice(0, 12)
    const untouched = async () => {
      const r = sup.resolve('acme', 'todo')
      assert.equal(r.prod_rev, 2); assert.equal(r.deployed_rev, first.commit); assert.equal(r.prod_state, 'live')
      assert.equal(readlink(dot(w, inst, 'current')), `../last-good/${inst}/rev-2`)
      assert.deepEqual(JSON.parse((await api(sup, row, '/data', prod)).body), { v: 'v1', rev: 1 })
      assert.equal((await sup.asset(row, 'frontend.js')).rev, 2)
      assert.ok(!fs.existsSync(dot(w, 'backup', inst)), 'no backup dir')
      assert.ok(!fs.existsSync(dot(w, 'rehearsal', inst, 'data')), 'the rehearsal copy is gone')
      assert.equal(sup.rows.get(inst).rehearsal, null); assert.equal(sup.workers().filter((x) => x.slot === 'rehearsal').length, 0)
    }
    const cases = [
      ['build', { 'backend.js': 'export default { mountRoutes( {{{\n' }, /^rehearsal red at build: backend\.js:\d+:\d+ /],
      ['hook', { 'backend.js': DATA_BACKEND(1), 'module.json': MJ({ deploy: 'echo migrating; echo "table users has no column email" >&2; exit 2' }) }, /^rehearsal red at hook: exit 2: table users has no column email$/],
      ['hook', { 'module.json': MJ({ deploy: 'sleep 5' }) }, /^rehearsal red at hook: timeout after 400 ms$/],
      ['boot', { 'module.json': MJ(), 'backend.js': `export default { mountRoutes() { throw new Error('db not reachable') } }\n` }, /^rehearsal red at boot: backend\.js:\d+:\d+ mountRoutes threw: db not reachable — mountRoutes must only register routes/],
      ['probe', { 'backend.js': DATA_BACKEND(1), 'module.json': MJ({ healthz: '/boom' }) }, /^rehearsal red at probe: GET \/boom → 500$/],
      ['test', { 'module.json': MJ({ test: 'node -e "process.exit(1)"' }) }, /^rehearsal red at test: exit 1$/],
      ['smoke', { 'module.json': MJ({ smoke: 'curl -s --fail --unix-socket "$ATELIER_SOCK" "$BASE_URL/boom" || { echo "smoke: /boom 500"; exit 1; }' }) }, /^rehearsal red at smoke: exit 1: smoke: \/boom 500$/],
    ]
    let n = 0
    for (const [step, files, messageRe] of cases) {
      for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c)
      await sleep(250)   // the dev watcher's own verdict (a broken dev build is its own report)
      const before = w.reports.length
      const v = await deploy(sup, row, { message: `broken ${step}` })
      assert.equal(v.outcome, 'red', `${step}: ${JSON.stringify(v)}`)
      assert.equal(v.step, step); assert.equal(v.rev, 2); assert.equal(v.commit, first.commit, 'the verdict names the release the app stays on')
      const rep = w.reports.slice(before).filter((r) => /^rehearsal red/.test(r.message))
      assert.equal(rep.length, 1, `${step}: ONE build report`)
      assert.equal(rep[0].kind, 'build'); assert.equal(rep[0].rev, 2, 'the PROD rev, never the rehearsal counter')
      assert.match(rep[0].message, messageRe)
      assert.equal(rep[0].hint, `nothing deployed — todo stays on rev 2 (${c12}); fix and run atelier deploy again`)
      assert.equal(rep[0].message, MESSAGES.rehearsalRed.message(step, rep[0].message.replace(/^rehearsal red at [a-z]+: /, '')))
      assert.ok(rep[0].message.length <= 200 && rep[0].hint.length <= 200, 'the wire caps')
      assert.ok(w.lines.some((l) => l.startsWith(`[todo] deploy ${v.attempted.commit.slice(0, 12)} RED at ${step}: `) && l.endsWith(' — prod stays on rev 2')), `${step}: the agent.log red line`)
      assert.equal(w.releases.at(-1).verdict, 'red'); assert.equal(w.releases.at(-1).error, rep[0].message); assert.equal(w.releases.at(-1).rev, 2); assert.equal(w.releases.at(-1).backup, null)
      await untouched()
      n++
    }
    assert.equal(n, 7)
    assert.ok(!sup.store.list(inst).includes(sup.rows.get(inst).counter) || sup.resolve('acme', 'todo').dev_rev === sup.rows.get(inst).counter, 'a red rev dir is removed')
    // red at commit (a commit git cannot resolve) → the verdict and the log line only, no app-error
    const before = w.reports.length
    const v = await deploy(sup, row, { commit: 'deadbeef0000' })
    assert.equal(v.outcome, 'red'); assert.equal(v.step, 'commit'); assert.equal(v.error, 'unknown commit deadbeef0000')
    assert.equal(w.reports.length, before, 'no report: nothing was rehearsed')
    assert.ok(w.lines.some((l) => l === '[todo] deploy deadbeef0000 RED at commit: unknown commit deadbeef0000 — prod stays on rev 2'))
    await untouched()
    // the fix → green again
    fs.writeFileSync(path.join(dir, 'module.json'), MJ()); fs.writeFileSync(path.join(dir, 'backend.js'), DATA_BACKEND(9))
    await waitFor(async () => JSON.parse((await api(sup, row, '/rev')).body).rev === 9)
    const ok = await deploy(sup, row, { message: 'fixed' })
    assert.equal(ok.outcome, 'green'); assert.equal(JSON.parse((await api(sup, row, '/data', prod)).body).v, 'v1', 'data survives a code release')
    assert.equal(sup.releases(inst).length, 10)
  } finally { await w.done(sup) }
})

test('the gate: a 50 ms request loop across a green deploy sees 0 non-2xx, 0 mixed revs, latency < the hold; a 3 s hook holds every request and fails none; a hook past the hold answers the shell\'s exact waking bytes', async () => {
  const w = world({ gitCommit: true })
  const { dir, sup, row } = await setup(w, 'todo', { 'module.json': MJ(), 'backend.js': DATA_BACKEND(1) }, { timing: { gateHoldMs: 700 } })
  try {
    assert.equal((await deploy(sup, row, { message: 'first' })).outcome, 'green')
    assert.equal((await api(sup, row, '/write?v=v1', prod)).status, 200)
    const loop = async (until) => {
      const samples = []
      while (!until.done) {
        const t = Date.now()
        const r = await api(sup, row, '/rev', prod)
        samples.push({ status: r.status, rev: r.status === 200 ? JSON.parse(r.body).rev : null, ms: Date.now() - t, body: r.body, headers: r.headers })
        await sleep(20)
      }
      return samples
    }
    // 1. a plain deploy
    fs.writeFileSync(path.join(dir, 'backend.js'), DATA_BACKEND(2))
    await waitFor(() => sup.resolve('acme', 'todo').dev_rev === 3)
    let flag = { done: false }
    let sampling = loop(flag)
    const v = await deploy(sup, row, { message: 'second' })
    await sleep(120); flag.done = true
    let samples = await sampling
    assert.equal(v.outcome, 'green')
    assert.ok(samples.length >= 8, `${samples.length} samples`)
    assert.equal(samples.filter((s) => s.status !== 200).length, 0, 'no non-2xx')
    let maxSeen = 0
    for (const s of samples) { assert.ok(s.rev >= maxSeen, 'never a lower rev after a higher one'); maxSeen = Math.max(maxSeen, s.rev) }
    assert.equal(maxSeen, 2); assert.equal(samples[0].rev, 1)
    assert.ok(Math.max(...samples.map((s) => s.ms)) < 700, `max latency ${Math.max(...samples.map((s) => s.ms))} ms < the hold`)
    assert.equal(JSON.parse((await api(sup, row, '/data', prod)).body).v, 'v1')
    // 2. a 3 s migration: requests wait behind the gate, none fails (the hold is 10 s in the fleet — 700 ms here with a 500 ms hook to keep the suite fast; the 3 s shape is the same wait)
    fs.writeFileSync(path.join(dir, 'module.json'), MJ({ deploy: 'sleep 0.5' })); fs.writeFileSync(path.join(dir, 'backend.js'), DATA_BACKEND(3))
    await waitFor(() => sup.resolve('acme', 'todo').dev_rev === 5)
    flag = { done: false }; sampling = loop(flag)
    const v2 = await deploy(sup, row, { message: 'slow hook' })
    await sleep(120); flag.done = true
    samples = await sampling
    assert.equal(v2.outcome, 'green')
    assert.equal(samples.filter((s) => s.status !== 200).length, 0, 'held, none failed')
    assert.ok(Math.max(...samples.map((s) => s.ms)) >= 400, 'requests waited for the migration')
    assert.equal(Math.max(...samples.map((s) => s.rev)), 3)
    // 3. a migration past the hold: the waiting requests get the shell's waking 503 — byte-equal to shell/proxy.mjs — then the release lands
    fs.writeFileSync(path.join(dir, 'module.json'), MJ({ deploy: 'sleep 1.5' })); fs.writeFileSync(path.join(dir, 'backend.js'), DATA_BACKEND(4))
    await waitFor(() => sup.resolve('acme', 'todo').dev_rev === 7)
    flag = { done: false }; sampling = loop(flag)
    const v3 = await deploy(sup, row, { message: 'very slow hook' })
    await sleep(120); flag.done = true
    samples = await sampling
    assert.equal(v3.outcome, 'green')
    const waking = samples.filter((s) => s.status === 503)
    assert.ok(waking.length >= 1, 'some requests hit the hold')
    for (const s of waking) {
      assert.equal(s.body, WAKING_BODY)
      assert.deepEqual(s.headers, { ...WAKING_HEADERS, 'content-length': Buffer.byteLength(WAKING_BODY) })
      assert.ok(s.ms >= 650 && s.ms < 1500, `held for the hold (${s.ms} ms), then the waking answer`)
    }
    assert.equal(samples.filter((s) => s.status !== 200 && s.status !== 503).length, 0)
    assert.equal(samples.at(-1).rev, 4); assert.equal(JSON.parse((await api(sup, row, '/data', prod)).body).v, 'v1')
  } finally { await w.done(sup) }
})

test('failed AFTER the gate: the migration fails on prod data → 503 down (no waking flag) + ONE worker report naming the backup at the prod rev, the backup holds the pre-migration bytes, `current` unchanged; `restore` brings the bytes back and prod serves again; a deploy while down is the fix-forward road', async () => {
  const w = world({ gitCommit: true })
  const { dir, sup, row } = await setup(w, 'todo', { 'module.json': MJ(), 'backend.js': DATA_BACKEND(1) })
  try {
    const inst = row.instance
    const first = await deploy(sup, row, { message: 'first' })
    assert.equal(first.outcome, 'green')
    assert.equal((await api(sup, row, '/write?v=v1', prod)).status, 200)
    // the hook passes on the rehearsal copy and fails on PROD data — after writing into it (what a half-run migration does)
    fs.writeFileSync(path.join(dir, 'module.json'), MJ({ deploy: 'case "$DATA_DIR" in *rehearsal*) exit 0;; esac; printf MIGRATED > "$DATA_DIR/counter.txt"; echo "table users has no column email" >&2; exit 2' }))
    fs.writeFileSync(path.join(dir, 'backend.js'), DATA_BACKEND(2))
    await waitFor(() => sup.resolve('acme', 'todo').dev_rev === 3)
    const v = await deploy(sup, row, { message: 'add the email column' })
    assert.equal(v.outcome, 'failed', JSON.stringify(v)); assert.equal(v.step, 'migrate'); assert.equal(v.error, 'exit 2: table users has no column email')
    assert.match(v.backup, /^\d{8}T\d{6}Z-rev2-[0-9a-f]{12}$/); assert.equal(v.rev, 2)
    assert.deepEqual(v.steps.filter((s) => !s.ok).map((s) => s.name), ['migrate'])
    // down: 503 with the backup, no waking flag; prod_state down; `current` still names rev 2; deployed_rev unchanged
    const r = await api(sup, row, '/rev', prod)
    assert.equal(r.status, 503); assert.deepEqual(JSON.parse(r.body), { error: 'app down after a failed deploy', backup: v.backup }); assert.equal(r.headers['x-atelier-waking'], undefined)
    const ar = sup.resolve('acme', 'todo')
    assert.equal(ar.state, 'down'); assert.equal(ar.prod_state, 'down'); assert.equal(ar.prod_rev, 2); assert.equal(ar.deployed_rev, first.commit)
    assert.equal(readlink(dot(w, inst, 'current')), `../last-good/${inst}/rev-2`)
    assert.equal(sup.workers().filter((x) => x.slot === 'prod').length, 0)
    // ONE worker report with the D15 words (message + hint ≤ 200), naming the backup; the backup holds v1, prod holds MIGRATED
    const reps = w.reports.filter((x) => x.kind === 'worker')
    assert.equal(reps.length, 1)
    assert.equal(reps[0].rev, 2)
    assert.equal(reps[0].message, `deploy of ${v.attempted.commit.slice(0, 12)} failed at migrate: exit 2: table users has no column email — todo is DOWN`)
    assert.equal(reps[0].hint, `rev 2 data (0 MB) backed up, never auto-restored: atelier restore todo ${v.backup}, or fix forward and deploy`)
    assert.ok(reps[0].message.length <= 200 && reps[0].hint.length <= 200)
    assert.equal(fs.readFileSync(dot(w, 'backup', inst, v.backup, 'counter.txt'), 'utf8'), 'v1')
    assert.equal(fs.readFileSync(dot(w, 'data', inst, 'counter.txt'), 'utf8'), 'MIGRATED')
    assert.equal(w.releases.at(-1).verdict, 'failed'); assert.equal(w.releases.at(-1).backup, v.backup); assert.equal(w.releases.at(-1).error, reps[0].message)
    assert.ok(w.lines.some((l) => l === `[todo] deploy ${v.attempted.commit.slice(0, 12)} FAILED at migrate: exit 2: table users has no column email — DOWN, backup ${v.backup}`))
    assert.deepEqual(w.modules, [[inst, 2]], 'no modulesChanged for a failed release')
    // dev is untouched by all of it
    assert.equal(JSON.parse((await api(sup, row, '/rev')).body).rev, 2)
    // restore: the bytes come back, the old prod worker serves, a release row {kind:'restore'}
    const rs = []
    const rv = await sup.restore(inst, v.backup, { by: 'agent:p-agent', onStep: (l) => rs.push(l) })
    assert.equal(rv.outcome, 'green', JSON.stringify(rv)); assert.equal(rv.kind, 'restore'); assert.equal(rv.rev, 2); assert.equal(rv.backup, v.backup)
    assert.deepEqual(rs.filter((l) => l.t === 'step').map((s) => s.name), ['drain', 'stop', 'snapshot', 'restore', 'start', 'probe', 'release'], 'a DOWN app needs no --yes; today\'s data is snapshot first (B2)')
    assert.match(rv.snapshot, /^\d{8}T\d{6}Z-rev2-[0-9a-f]{12}$/); assert.notEqual(rv.snapshot, v.backup)
    assert.equal(fs.readFileSync(dot(w, 'backup', inst, rv.snapshot, 'counter.txt'), 'utf8'), 'MIGRATED', 'the snapshot holds the bytes the restore replaced')
    assert.deepEqual(JSON.parse((await api(sup, row, '/data', prod)).body), { v: 'v1', rev: 1 })
    assert.equal(sup.resolve('acme', 'todo').prod_state, 'live')
    assert.equal(w.releases.at(-1).kind, 'restore'); assert.equal(w.releases.at(-1).verdict, 'green'); assert.equal(w.releases.at(-1).backup, v.backup); assert.equal(w.releases.at(-1).commit, first.commit)
    assert.ok(fs.existsSync(dot(w, 'backup', inst, v.backup)), 'the backup stays after a restore')
    assert.ok(w.lines.some((l) => new RegExp(`^\\[todo\\] restore ${v.backup} done in \\d+ ms$`).test(l)))
    // an unknown backup id is refused before anything moves
    await assert.rejects(Promise.resolve().then(() => sup.restore(inst, '20260902T104702Z-rev2-000000000000')), (e) => e.status === 404 && e.message === 'unknown backup')
    await assert.rejects(Promise.resolve().then(() => sup.restore(inst, '../x')), (e) => e.status === 404)
    // fix forward: the hook fixed → the deploy goes green from the restored state
    fs.writeFileSync(path.join(dir, 'module.json'), MJ({ deploy: 'printf "$(cat "$DATA_DIR/counter.txt")+email" > "$DATA_DIR/counter.txt"' }))
    await sleep(250)
    const v2 = await deploy(sup, row, { message: 'add the email column, fixed' })
    assert.equal(v2.outcome, 'green'); assert.equal(v2.rev, 6, 'rev 4 = the failed release (its dir pruned), 5 = the dev save of module.json, 6 = this release')
    assert.ok(!sup.store.list(inst).includes(4), 'the failed release\'s rev dir is pruned')
    assert.deepEqual(JSON.parse((await api(sup, row, '/data', prod)).body), { v: 'v1+email', rev: 2 })
    assert.equal(sup.backups(inst).length, 3, 'the failed deploy\'s backup, the restore\'s snapshot, this deploy\'s backup')
    assert.equal(fs.readFileSync(dot(w, 'backup', inst, v2.backup, 'counter.txt'), 'utf8'), 'v1', 'the third backup = the restored prod data before this migration')
  } finally { await w.done(sup) }
})

test('rollback = the same verb with an older commit: no commit, NO hook, data untouched, code back; then the spine\'s release door absent (404) never blocks a green deploy', async () => {
  const w = world({ gitCommit: true })
  const { dir, sup, row } = await setup(w, 'todo', { 'module.json': MJ(), 'backend.js': DATA_BACKEND(1) })
  try {
    const inst = row.instance
    const a = await deploy(sup, row, { message: 'A' })
    assert.equal(a.outcome, 'green')
    assert.equal((await api(sup, row, '/write?v=v1', prod)).status, 200)
    fs.writeFileSync(path.join(dir, 'module.json'), MJ({ deploy: 'printf B-migrated > "$DATA_DIR/counter.txt"' })); fs.writeFileSync(path.join(dir, 'backend.js'), DATA_BACKEND(2))
    await waitFor(() => sup.resolve('acme', 'todo').dev_rev === 3)
    const b = await deploy(sup, row, { message: 'B' })
    assert.equal(b.outcome, 'green'); assert.deepEqual(JSON.parse((await api(sup, row, '/data', prod)).body), { v: 'B-migrated', rev: 2 })
    const head = gitHead(dir)
    const rb = await deploy(sup, row, { commit: a.commit.slice(0, 12) })
    assert.equal(rb.outcome, 'green', JSON.stringify(rb)); assert.equal(rb.kind, 'rollback'); assert.equal(rb.commit, a.commit); assert.equal(rb.rev, 5)
    assert.equal(rb.steps.find((s) => s.name === 'commit').note, `${a.commit.slice(0, 12)} (rollback: no commit, no hook)`)
    assert.equal(rb.steps.find((s) => s.name === 'migrate').note, 'rollback: no hook, data untouched')
    assert.equal(rb.steps.find((s) => s.name === 'hook').note, 'no "deploy" hook in module.json', 'A had no hook; B\'s hook is not the rollback\'s')
    assert.equal(gitHead(dir), head, 'a rollback commits nothing')
    assert.deepEqual(JSON.parse((await api(sup, row, '/data', prod)).body), { v: 'B-migrated', rev: 1 }, 'code back to A, the data as B left it')
    assert.equal(sup.resolve('acme', 'todo').deployed_rev, a.commit)
    assert.equal(w.releases.at(-1).kind, 'rollback'); assert.equal(w.releases.at(-1).message, `rollback to ${a.commit.slice(0, 12)}`)
    assert.equal(sup.releases(inst).map((r) => r.kind).join(','), 'rollback,deploy,deploy')
    assert.equal(fs.readdirSync(dot(w, 'prod', inst)).length, 2, 'the two exports of the last two releases')
    // the spine without the release door (a spine before v43), then a 5xx: the deploy is green, the local ledger has the row
    w.registrar.releaseImpl = () => { throw new TransportError(404, { error: 'no-route' }) }
    fs.writeFileSync(path.join(dir, 'backend.js'), DATA_BACKEND(5))
    await waitFor(() => sup.resolve('acme', 'todo').dev_rev === 6)
    const c = await deploy(sup, row, { message: 'C' })
    assert.equal(c.outcome, 'green'); assert.equal(sup.releases(inst)[0].message, 'C')
    w.registrar.releaseImpl = () => new Promise(() => {})   // a spine that never answers: the record step is bounded
    const sup2 = sup   // (the same supervisor; the budget is the deployer's recordMs)
    sup2.timing.deploy.recordMs = 300
    fs.writeFileSync(path.join(dir, 'backend.js'), DATA_BACKEND(6))
    await waitFor(() => sup.resolve('acme', 'todo').dev_rev === 8)
    const t0 = Date.now()
    const d = await deploy(sup, row, { message: 'D' })
    assert.equal(d.outcome, 'green'); assert.ok(Date.now() - t0 < 5000)
    assert.ok(w.lines.some((l) => /release row r-[0-9a-f]+: timeout after 300 ms/.test(l)))
  } finally { await w.done(sup) }
})

test('D16 config release: a heartbeat stamp newer than the prod worker\'s spawn restarts it under the gate (a release row {kind:\'config\'}, the same commit, no rehearsal, no commit); the same stamp again does nothing; a stopped worker just notes it', async () => {
  const w = world({ gitCommit: true })
  const { sup, row } = await setup(w, 'todo', { 'module.json': MJ(), 'backend.js': DATA_BACKEND(1) }, { timing: { idleMs: 60_000 } })
  try {
    const inst = row.instance
    const v = await deploy(sup, row, { message: 'first' })
    assert.equal(v.outcome, 'green')
    const pid1 = sup.resolve('acme', 'todo').pid
    const commitsBefore = gitHead(row.dir)
    sup.onConfigStamp(inst, '2026-09-02T10:00:00.000Z')
    await waitFor(() => sup.rows.get(inst).deploying !== null)
    await waitFor(() => sup.rows.get(inst).deploying === null)
    const r = sup.resolve('acme', 'todo')
    assert.equal(r.prod_state, 'live'); assert.notEqual(r.pid, pid1); assert.equal(r.prod_rev, 2); assert.equal(r.deployed_rev, v.commit)
    assert.equal(w.releases.at(-1).kind, 'config'); assert.equal(w.releases.at(-1).verdict, 'green'); assert.equal(w.releases.at(-1).commit, v.commit); assert.equal(w.releases.at(-1).rev, 2); assert.equal(w.releases.at(-1).by, 'spine:config')
    assert.deepEqual(w.releases.at(-1).rehearsal.steps.map((s) => s.name), ['drain', 'stop', 'start', 'probe', 'release'])
    assert.equal(gitHead(row.dir), commitsBefore, 'no commit')
    assert.ok(w.lines.some((l) => l === '[todo] config release: rev 2 restarted under the gate (config updated 2026-09-02T10:00:00.000Z)'))
    assert.equal((await api(sup, row, '/rev', prod)).status, 200)
    const pid2 = sup.resolve('acme', 'todo').pid
    // the same stamp again: nothing; a newer one: another release
    sup.onConfigStamp(inst, '2026-09-02T10:00:00.000Z')
    await sleep(200)
    assert.equal(sup.resolve('acme', 'todo').pid, pid2); assert.equal(w.releases.filter((x) => x.kind === 'config').length, 1)
    sup.onConfigStamp(inst, '2026-09-02T10:05:00.000Z')
    await waitFor(() => w.releases.filter((x) => x.kind === 'config').length === 2)
    await waitFor(() => sup.rows.get(inst).deploying === null)
    assert.notEqual(sup.resolve('acme', 'todo').pid, pid2)
    // an undeployed app: no prod slot → nothing to release
    const w2row = w.app('other', { 'module.json': MJ(), 'backend.js': DATA_BACKEND(1) })
    await sup.scan(); await live(sup, 'other')
    sup.onConfigStamp(sup.resolve('acme', 'other').instance, 'x')
    await sleep(100)
    assert.equal(w.releases.filter((x) => x.kind === 'config').length, 2)
    assert.ok(w2row)
  } finally { await w.done(sup) }
})

test('D14 adopt: a pre-release layout (revision.json without `prod`, `current` → the serving rev) boots serving from the folder, the first scan commits the tree once, `prod.legacy`, no export, one adopt release row; idempotent across restarts; its first deploy moves it onto an export', async () => {
  const w = world({ gitCommit: true })
  let { dir, sup, row } = await setup(w, 'legacy', { 'module.json': MJ(), 'backend.js': DATA_BACKEND(1), 'logo.svg': '<svg/>' })
  const inst = row.instance
  try {
    await sup.teardown()
    // rewrite the markers into the step-5 shape: `current` → rev-1, no `current-dev`, no `prod` block
    fs.unlinkSync(dot(w, inst, 'current-dev'))
    fs.symlinkSync(`../last-good/${inst}/rev-1`, dot(w, inst, 'current'))
    const rj = revJson(w, inst); delete rj.prod; fs.writeFileSync(dot(w, inst, 'revision.json'), JSON.stringify(rj))
    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true }); fs.rmSync(path.join(dir, '.gitignore'), { force: true })
    // a new host: boot serves prod from the snapshot (the folder's static files) before any scan
    sup = w.make()
    await sup.boot()
    let r = sup.resolve('acme', 'legacy')
    assert.equal(r.state, 'stopped'); assert.equal(r.prod_rev, 1); assert.equal(r.dev_rev, 1); assert.equal(r.deployed_rev, null, 'adopted on the first scan, not at boot')
    assert.equal((await api(sup, row, '/rev', prod)).status, 200)
    assert.equal((await sup.asset(row, 'logo.svg')).body.toString(), '<svg/>', 'a legacy row serves static files from the folder')
    assert.equal(w.releases.length, 0)
    await sup.scan()
    r = sup.resolve('acme', 'legacy')
    assert.match(r.deployed_rev, HEX40); assert.equal(r.deployed_rev, gitHead(dir))
    assert.deepEqual(gitLog(dir).map((l) => l.split(' ').slice(1).join(' ')), ['adopt: the tree serving rev 1'])
    assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), MESSAGES.git.gitignore)
    const prodBlock = revJson(w, inst).prod
    assert.equal(prodBlock.legacy, true); assert.equal(prodBlock.rev, 1); assert.equal(prodBlock.commit, r.deployed_rev)
    assert.equal(readlink(dot(w, inst, 'current-dev')), `../last-good/${inst}/rev-1`, 'the dev pointer is minted for the dev slot')
    assert.ok(!fs.existsSync(dot(w, 'prod', inst)), 'no export: it serves from the folder until its first deploy')
    assert.equal(sup.rows.get(inst).prod.appDir, dir)
    assert.equal(w.releases.length, 1); assert.equal(w.releases[0].kind, 'adopt'); assert.equal(w.releases[0].verdict, 'green'); assert.equal(w.releases[0].rev, 1); assert.equal(w.releases[0].commit, r.deployed_rev); assert.equal(w.releases[0].by, 'host')
    assert.ok(w.lines.some((l) => l === `[legacy] adopt: rev 1 (${r.deployed_rev.slice(0, 12)}) committed — prod = the legacy tree until its first deploy`))
    assert.deepEqual(w.modules, [], 'adopt never calls modulesChanged: the registry already holds the prod rev')
    assert.equal((await api(sup, row, '/rev', prod)).status, 200, 'nothing went dark')
    // idempotent: a second host life over the same tree does not adopt again (one commit, the prod block kept) — it ANNOUNCES
    // the prod commit it holds to the spine as `adopt-<c12>` (the same id as the adopt: the spine replays it), no ledger row
    await sup.teardown()
    sup = w.make(); await sup.boot(); await sup.scan()
    assert.equal(gitLog(dir).length, 1); assert.equal(revJson(w, inst).prod.legacy, true)
    assert.equal(sup.resolve('acme', 'legacy').deployed_rev, r.deployed_rev)
    assert.equal(w.releases.length, 2); assert.equal(w.releases[1].id, `adopt-${r.deployed_rev.slice(0, 12)}`); assert.equal(w.releases[0].id, w.releases[1].id); assert.equal(w.releases[1].kind, 'adopt'); assert.equal(w.releases[1].commit, r.deployed_rev); assert.equal(w.releases[1].verdict, 'green')
    assert.equal(sup.releases(inst).length, 1, 'the announce is not a new release — no ledger row')
    await sup.scan()
    assert.equal(w.releases.length, 2, 'one announce per host life')
    // a migrated registry answers deployed_rev = "legacy" at registration → announced; the commit itself → nothing to announce
    await sup.teardown()
    w.registrar.apps = () => new Map([[inst, { slug: 'legacy', deployed_rev: 'legacy' }]])
    sup = w.make(); await sup.boot(); await sup.scan()
    assert.equal(w.releases.length, 3); assert.equal(w.releases[2].id, `adopt-${r.deployed_rev.slice(0, 12)}`)
    assert.ok(w.lines.some((l) => /^\[legacy\] announced prod commit [0-9a-f]{12} \(rev 1\) to the spine \(spine had legacy\)$/.test(l)))
    await sup.teardown()
    w.registrar.apps = () => new Map([[inst, { slug: 'legacy', deployed_rev: r.deployed_rev }]])
    sup = w.make(); await sup.boot(); await sup.scan()
    assert.equal(w.releases.length, 3, 'the spine already holds the commit: nothing to announce')
    delete w.registrar.apps
    // a dev save after the adopt: dev moves, prod stays on the legacy rev
    fs.writeFileSync(path.join(dir, 'backend.js'), DATA_BACKEND(2))
    await waitFor(() => sup.resolve('acme', 'legacy').dev_rev === 2)
    assert.equal(sup.resolve('acme', 'legacy').prod_rev, 1); assert.equal(JSON.parse((await api(sup, row, '/rev', prod)).body).rev, 1)
    // the first deploy moves it onto an export: legacy false, the export dir, the folder no longer prod's cwd
    const v = await deploy(sup, row, { message: 'first real release' })
    assert.equal(v.outcome, 'green'); assert.equal(v.rev, 3)
    assert.equal(revJson(w, inst).prod.legacy, undefined); assert.equal(sup.rows.get(inst).prod.legacy, false)
    assert.equal(sup.rows.get(inst).prod.appDir, dot(w, 'prod', inst, v.commit.slice(0, 12)))
    assert.equal(JSON.parse((await api(sup, row, '/rev', prod)).body).rev, 2)
    assert.equal(gitLog(dir).length, 2)
  } finally { await w.done(sup) }
})

test('D11 backups: the last 3 per app are kept (oldest pruned, the marker follows); the refusal BEFORE the gate when the backup cannot land (free space < 2× the data): red at `backup`, prod untouched, no backup dir; --no-backup skips it', async () => {
  const w = world({ gitCommit: true })
  const { dir, sup, row } = await setup(w, 'todo', { 'module.json': MJ(), 'backend.js': DATA_BACKEND(1) })
  try {
    const inst = row.instance
    assert.equal((await deploy(sup, row, { message: 'first' })).outcome, 'green')
    assert.equal((await api(sup, row, '/write?v=v1', prod)).status, 200)
    const ids = []
    for (let n = 2; n <= 5; n++) {
      fs.writeFileSync(path.join(dir, 'backend.js'), DATA_BACKEND(n))
      await waitFor(async () => JSON.parse((await api(sup, row, '/rev')).body).rev === n)
      await sleep(1100)   // the backup id has second granularity
      const v = await deploy(sup, row, { message: `release ${n}` })
      assert.equal(v.outcome, 'green', JSON.stringify(v)); ids.push(v.backup)
    }
    assert.equal(ids.length, 4)
    assert.deepEqual(sup.backups(inst).map((b) => b.id), [ids[3], ids[2], ids[1]], 'the newest 3, newest first')
    assert.deepEqual(fs.readdirSync(dot(w, 'backup', inst)).sort(), [ids[1], ids[2], ids[3]].sort())
    assert.ok(w.lines.some((l) => l === `[todo] backup ${ids[0]} pruned`))
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(dot(w, inst, 'backups.json'), 'utf8'))).sort(), [ids[1], ids[2], ids[3]].sort())
    assert.ok(sup.backups(inst).every((b) => b.bytes > 0 && b.rev > 0 && /^\d{4}-/.test(b.at)))
    // the refusal: a full disk (statfs says almost nothing free) → red at backup before the gate; --no-backup goes through
    const realStatfs = w.osx.statfs
    w.osx.statfs = () => ({ bytes: 1000, free: 1 })
    fs.writeFileSync(path.join(dir, 'backend.js'), DATA_BACKEND(6))
    await waitFor(async () => JSON.parse((await api(sup, row, '/rev')).body).rev === 6)
    const before = { reports: w.reports.length, backups: fs.readdirSync(dot(w, 'backup', inst)).length, pid: sup.resolve('acme', 'todo').pid }
    const v = await deploy(sup, row, { message: 'no room' })
    assert.equal(v.outcome, 'red'); assert.equal(v.step, 'backup'); assert.match(v.error, /^backup impossible: free space 0 MB < 2× the data \(0 MB\)$/)
    assert.equal(sup.resolve('acme', 'todo').pid, before.pid, 'prod never stopped'); assert.equal(JSON.parse((await api(sup, row, '/rev', prod)).body).rev, 5)
    assert.equal(fs.readdirSync(dot(w, 'backup', inst)).length, before.backups); assert.equal(w.reports.length, before.reports, 'a refusal before the gate is the verdict line, not an app-error')
    assert.equal(w.releases.at(-1).verdict, 'red')
    const nb = await deploy(sup, row, { message: 'no room, no backup', noBackup: true })
    assert.equal(nb.outcome, 'green'); assert.equal(nb.backup, undefined); assert.equal(nb.steps.find((s) => s.name === 'backup').note, 'skipped (--no-backup)')
    assert.equal(JSON.parse((await api(sup, row, '/rev', prod)).body).rev, 6)
    w.osx.statfs = realStatfs
  } finally { await w.done(sup) }
})

// ---- the 2026-09-02 review round (Opus B1–B3 / S1–S3 / S5 / S10, Codex 1–4, Grok 2–4): an unknown answer is never the permissive one
test('B1/S3: the data question fails CLOSED — an unreadable data dir (EACCES), a killed `find`, a failed or a silent `du` → red at `backup` BEFORE the rehearsal (`backup impossible: could not read/measure the data dir (…)`), nothing exported, prod never stopped, no app-error, the hook never ran; --no-backup does not lift it', async () => {
  const w = world({ gitCommit: true })
  const { dir, sup, row } = await setup(w, 'todo', { 'module.json': MJ({ deploy: 'printf MIGRATED > "$DATA_DIR/counter.txt"' }), 'backend.js': DATA_BACKEND(1) })
  const dataDir = dot(w, 'data', row.instance)
  try {
    const inst = row.instance
    assert.equal((await deploy(sup, row, { message: 'first' })).outcome, 'green')
    assert.equal((await api(sup, row, '/write?v=v1', prod)).status, 200)
    const pid = sup.resolve('acme', 'todo').pid
    fs.writeFileSync(path.join(dir, 'backend.js'), DATA_BACKEND(2))
    await waitFor(() => sup.resolve('acme', 'todo').dev_rev === 3)
    const realSpawn = w.osx.spawn
    const fake = (name, argv) => { w.osx.spawn = (spec) => realSpawn(spec.argv[0] === name ? { ...spec, argv } : spec) }
    const cases = [
      ['EACCES', () => fs.chmodSync(dataDir, 0o000), /^backup impossible: could not read the data dir \(find: .*[Pp]ermission denied.*\)$/],
      ['a killed find', () => fake('find', ['sh', '-c', 'kill -9 $$']), /^backup impossible: could not read the data dir \(find: killed by SIGKILL\)$/],
      ['du rc=3', () => fake('du', ['sh', '-c', 'echo "du: boom" >&2; exit 3']), /^backup impossible: could not measure the data dir \(du: du: boom\)$/],
      ['du silent', () => fake('du', ['sh', '-c', 'true']), /^backup impossible: could not measure the data dir \(du: rc=0 \(no size printed\)\)$/],
    ]
    for (const [name, arm, re] of cases) {
      for (const noBackup of [false, true]) {
        arm()
        const before = { reports: w.reports.length, releases: w.releases.length }
        const v = await deploy(sup, row, { message: `unknown: ${name}`, noBackup })
        fs.chmodSync(dataDir, 0o770); w.osx.spawn = realSpawn
        assert.equal(v.outcome, 'red', `${name}: ${JSON.stringify(v)}`); assert.equal(v.step, 'backup'); assert.match(v.error, re, name)
        assert.deepEqual(v.steps.map((s) => s.name), ['commit', 'backup'], `${name}: refused before the rehearsal — nothing was copied, exported or installed`)
        assert.equal(sup.resolve('acme', 'todo').pid, pid, 'prod never stopped'); assert.equal(sup.resolve('acme', 'todo').prod_state, 'live')
        assert.equal(w.reports.length, before.reports, 'a refusal before the gate is the verdict line, not an app-error')
        assert.equal(w.releases.length, before.releases + 1); assert.equal(w.releases.at(-1).verdict, 'red'); assert.equal(w.releases.at(-1).error, v.error)
        assert.ok(!fs.existsSync(dot(w, 'rehearsal', inst, 'data')))
        assert.equal(fs.readFileSync(path.join(dataDir, 'counter.txt'), 'utf8'), 'v1', 'the hook never ran on prod data')
        assert.ok(w.lines.some((l) => l.endsWith(`RED at backup: ${v.error} — prod stays on rev 2`)), 'the agent.log red line')
        assert.ok(!fs.existsSync(dot(w, 'backup', inst)), 'no backup dir')
      }
    }
    // the answer known again → green: the migration runs behind its backup
    const ok = await deploy(sup, row, { message: 'readable again' })
    assert.equal(ok.outcome, 'green', JSON.stringify(ok)); assert.match(ok.backup, /^\d{8}T\d{6}Z-rev2-/)
    assert.equal(fs.readFileSync(dot(w, 'backup', inst, ok.backup, 'counter.txt'), 'utf8'), 'v1'); assert.equal(fs.readFileSync(path.join(dataDir, 'counter.txt'), 'utf8'), 'MIGRATED')
  } finally { try { fs.chmodSync(dataDir, 0o770) } catch {} await w.done(sup) }
})

test('B2: restore on a LIVE app is refused without --yes (409, the refusal names the command, nothing moves); with --yes today\'s data is SNAPSHOT first (a backup row holding the pre-restore bytes) and the backup lands through a staging tree + two renames; the snapshot impossible → RED at `snapshot`, nothing moved; a copy that dies → FAILED, prod\'s data intact on disk, the backups untouched, restore again (DOWN: no --yes)', async () => {
  const w = world({ gitCommit: true })
  const { dir, sup, row } = await setup(w, 'todo', { 'module.json': MJ(), 'backend.js': DATA_BACKEND(1) })
  try {
    const inst = row.instance
    assert.equal((await deploy(sup, row, { message: 'first' })).outcome, 'green')
    assert.equal((await api(sup, row, '/write?v=v1', prod)).status, 200)
    fs.writeFileSync(path.join(dir, 'backend.js'), DATA_BACKEND(2))
    await waitFor(() => sup.resolve('acme', 'todo').dev_rev === 3)
    const v2 = await deploy(sup, row, { message: 'second' })
    assert.equal(v2.outcome, 'green'); const b1 = v2.backup; assert.match(b1, /^\d{8}T\d{6}Z-rev2-/)
    assert.equal((await api(sup, row, '/write?v=v2', prod)).status, 200)
    // live, no --yes: refused before anything moves — no release row, the worker untouched, the data as it was
    const pid = sup.resolve('acme', 'todo').pid, nReleases = w.releases.length
    assert.equal(MESSAGES.refuse.restoreLive('todo', b1), `todo is live: restore replaces its prod data with backup ${b1} (everything written since is lost) — run atelier restore todo ${b1} --yes to confirm`)
    await assert.rejects(Promise.resolve().then(() => sup.restore(inst, b1)), (e) => e.status === 409 && e.message === MESSAGES.refuse.restoreLive('todo', b1))
    await assert.rejects(Promise.resolve().then(() => sup.restore(inst, b1, { yes: false })), (e) => e.status === 409)
    assert.equal(sup.resolve('acme', 'todo').pid, pid); assert.equal(w.releases.length, nReleases); assert.equal(JSON.parse((await api(sup, row, '/data', prod)).body).v, 'v2')
    // --yes: the snapshot (v2) lands as a backup row like the deploy's, then the backup (v1) is prod's data
    await sleep(1100)   // the backup id has second granularity
    const rs = []
    const rv = await sup.restore(inst, b1, { by: 'agent:p-agent', yes: true, onStep: (l) => rs.push(l) })
    assert.equal(rv.outcome, 'green', JSON.stringify(rv))
    assert.deepEqual(rs.filter((l) => l.t === 'step').map((s) => s.name), ['drain', 'stop', 'snapshot', 'restore', 'start', 'probe', 'release'])
    assert.match(rv.snapshot, /^\d{8}T\d{6}Z-rev4-[0-9a-f]{12}$/); assert.notEqual(rv.snapshot, b1)
    assert.equal(rs.find((l) => l.t === 'step' && l.name === 'snapshot').note, MESSAGES.step.notes.backup(rv.snapshot, 0))
    assert.equal(fs.readFileSync(dot(w, 'backup', inst, rv.snapshot, 'counter.txt'), 'utf8'), 'v2', 'the snapshot holds what the restore replaced')
    assert.deepEqual(JSON.parse((await api(sup, row, '/data', prod)).body), { v: 'v1', rev: 2 })
    assert.deepEqual(sup.backups(inst).map((b) => b.id), [rv.snapshot, b1], 'newest first: the snapshot is a backup row like any other')
    assert.deepEqual(fs.readdirSync(dot(w, 'data')).sort(), [inst], 'no .restore / .old left beside data/<inst>')
    assert.equal(w.releases.at(-1).kind, 'restore'); assert.equal(w.releases.at(-1).verdict, 'green'); assert.equal(w.releases.at(-1).backup, b1); assert.equal(w.releases.at(-1).by, 'agent:p-agent')
    // the snapshot impossible (no free space) → RED at snapshot before the gate: nothing moved, prod never stopped, no backup taken
    const realStatfs = w.osx.statfs
    w.osx.statfs = () => ({ bytes: 1000, free: 1 })
    const pid2 = sup.resolve('acme', 'todo').pid
    const red = await sup.restore(inst, rv.snapshot, { yes: true })
    w.osx.statfs = realStatfs
    assert.equal(red.outcome, 'red', JSON.stringify(red)); assert.equal(red.step, 'snapshot'); assert.equal(red.error, 'backup impossible: free space 0 MB < 2× the data (0 MB)'); assert.equal(red.snapshot, undefined)
    assert.equal(sup.resolve('acme', 'todo').pid, pid2, 'prod never stopped'); assert.equal(JSON.parse((await api(sup, row, '/data', prod)).body).v, 'v1')
    assert.equal(sup.backups(inst).length, 2, 'no backup taken'); assert.equal(w.releases.at(-1).verdict, 'red'); assert.equal(w.releases.at(-1).kind, 'restore'); assert.equal(w.releases.at(-1).error, red.error)
    assert.ok(w.lines.some((l) => l === `[todo] restore ${rv.snapshot} RED at snapshot: ${red.error} — nothing restored`))
    // a copy that dies inside the gate: FAILED at restore, the app DOWN, prod's data dir intact on disk (the swap never happened), the backups untouched, ONE worker report
    const realSpawn = w.osx.spawn
    w.osx.spawn = (spec) => realSpawn(spec.argv[0] === 'cp' && String(spec.argv.at(-1)).endsWith('.restore') ? { ...spec, argv: ['sh', '-c', 'echo "cp: disk full" >&2; exit 1'] } : spec)
    await sleep(1100)
    const before = w.reports.length
    const failed = await sup.restore(inst, rv.snapshot, { yes: true })
    w.osx.spawn = realSpawn
    assert.equal(failed.outcome, 'failed', JSON.stringify(failed)); assert.equal(failed.step, 'restore'); assert.equal(failed.error, 'cp: cp: disk full')
    assert.equal(sup.resolve('acme', 'todo').prod_state, 'down')
    assert.equal(fs.readFileSync(dot(w, 'data', inst, 'counter.txt'), 'utf8'), 'v1', 'prod data intact: the swap never happened')
    assert.ok(fs.existsSync(dot(w, 'backup', inst, rv.snapshot)) && fs.existsSync(dot(w, 'backup', inst, b1)), 'the backups untouched')
    const rep = w.reports.slice(before); assert.equal(rep.length, 1); assert.equal(rep[0].kind, 'worker'); assert.equal(rep[0].rev, 4)
    assert.equal(rep[0].message, MESSAGES.restoreFailed.message('todo', rv.snapshot, 'restore', 'cp: cp: disk full')); assert.equal(rep[0].hint, MESSAGES.restoreFailed.hint('todo', rv.snapshot))
    assert.ok(rep[0].message.length <= 200 && rep[0].hint.length <= 200)
    const r503 = await api(sup, row, '/rev', prod); assert.equal(r503.status, 503); assert.deepEqual(JSON.parse(r503.body), { error: 'app down after a failed deploy', backup: rv.snapshot })
    // DOWN: no --yes needed; the staging leftover goes; green; the oldest backup pruned past 3
    await sleep(1100)
    const again = await sup.restore(inst, rv.snapshot)
    assert.equal(again.outcome, 'green', JSON.stringify(again))
    assert.equal(JSON.parse((await api(sup, row, '/data', prod)).body).v, 'v2'); assert.equal(sup.resolve('acme', 'todo').prod_state, 'live')
    assert.deepEqual(fs.readdirSync(dot(w, 'data')).sort(), [inst])
    assert.equal(sup.backups(inst).length, 3); assert.ok(!sup.backups(inst).some((b) => b.id === b1), 'four snapshots → the oldest pruned (D11)')
  } finally { await w.done(sup) }
})

test('B3: the new rev dir is pinned for the whole verb — the rev-dir prune the keepMs timers run, fired during the rehearsal and again inside the gate (after `row.rehearsal` is cleared), never deletes it and the deploy is green; prune() keeps `row.releasing` and nothing else unreferenced', async () => {
  const w = world({ gitCommit: true })
  const { dir, sup, row } = await setup(w, 'todo', { 'module.json': MJ({ deploy: 'sleep 0.2' }), 'backend.js': DATA_BACKEND(1) })
  try {
    const inst = row.instance
    assert.equal((await deploy(sup, row, { message: 'first' })).outcome, 'green')
    assert.equal((await api(sup, row, '/write?v=v1', prod)).status, 200)
    fs.writeFileSync(path.join(dir, 'backend.js'), DATA_BACKEND(2))
    await waitFor(() => sup.resolve('acme', 'todo').dev_rev === 3)
    const rowRef = sup.rows.get(inst)
    const fired = []   // [step, releasing, the rehearsal slot still set?, the rev dir still on disk?]
    const v = await sup.deploy(inst, { message: 'second', onStep: (l) => {
      if (l.t === 'step' && l.ok && ['hook', 'backup', 'migrate'].includes(l.name)) {
        sup.prune(inst)   // the sweep a keepMs timer from an old save runs, mid-verb
        fired.push([l.name, rowRef.releasing, rowRef.rehearsal != null, sup.store.list(inst).includes(rowRef.releasing)])
      }
    } })
    assert.equal(v.outcome, 'green', JSON.stringify(v)); assert.equal(v.rev, 4)
    assert.deepEqual(fired, [['hook', 4, true, true], ['backup', 4, false, true], ['migrate', 4, false, true]], 'inside the gate only the pin keeps rev 4')
    assert.equal(rowRef.releasing, null, 'the pin is released with the verb')
    assert.ok(sup.store.list(inst).includes(4)); assert.equal(JSON.parse((await api(sup, row, '/rev', prod)).body).rev, 2)
    // prune() directly: an unreferenced rev dir survives exactly while it is the releasing one
    sup.store.write(inst, 42, row.uid, {})
    rowRef.releasing = 42; sup.prune(inst); assert.ok(sup.store.list(inst).includes(42))
    rowRef.releasing = null; sup.prune(inst); assert.ok(!sup.store.list(inst).includes(42))
  } finally { await w.done(sup) }
})

test('S1/S2/S10: DOWN is on disk — a host restart boots a failed app DOWN (the same 503 + backup, the boot line, nothing resumed), a config stamp never resurrects it, the restore clears the marker; the in-flight `releasing` marker of a host that died mid-migration boots DOWN too; a green deploy writes a fresh prod block; a torn commitProd (revision.json ahead of `current`) re-links to the recorded release, never an adopt', async () => {
  const w = world({ gitCommit: true })
  let { dir, sup, row } = await setup(w, 'todo', { 'module.json': MJ(), 'backend.js': DATA_BACKEND(1) }, { timing: { idleMs: 60_000 } })
  const inst = row.instance
  try {
    const first = await deploy(sup, row, { message: 'first' })
    assert.equal(first.outcome, 'green')
    assert.equal((await api(sup, row, '/write?v=v1', prod)).status, 200)
    fs.writeFileSync(path.join(dir, 'module.json'), MJ({ deploy: 'case "$DATA_DIR" in *rehearsal*) exit 0;; esac; printf MIGRATED > "$DATA_DIR/counter.txt"; exit 2' }))
    await sleep(250)
    const v = await deploy(sup, row, { message: 'bad migration' })
    assert.equal(v.outcome, 'failed', JSON.stringify(v)); assert.equal(v.step, 'migrate')
    const c12 = v.attempted.commit.slice(0, 12)
    let pb = revJson(w, inst).prod
    assert.equal(pb.rev, 2); assert.equal(pb.commit, first.commit, 'the prod block still names the release the app is on')
    assert.deepEqual(Object.keys(pb.down).sort(), ['at', 'backup', 'commit', 'error', 'rev', 'step']); assert.equal(pb.down.step, 'migrate'); assert.equal(pb.down.backup, v.backup); assert.equal(pb.down.commit, v.attempted.commit); assert.equal(pb.down.rev, 4)
    assert.equal(pb.releasing, undefined, 'the in-flight marker is replaced by the DOWN marker')
    // a new host life: still DOWN, the same 503 body, the boot line; no worker started, the scan neither adopts nor resumes
    await sup.teardown()
    sup = w.make({ timing: { idleMs: 60_000 } }); await sup.boot()
    let r = sup.resolve('acme', 'todo')
    assert.equal(r.prod_state, 'down'); assert.equal(r.state, 'down'); assert.equal(r.prod_rev, 2); assert.equal(r.deployed_rev, first.commit); assert.equal(r.pid, undefined)
    let x = await api(sup, row, '/rev', prod)
    assert.equal(x.status, 503); assert.deepEqual(JSON.parse(x.body), { error: 'app down after a failed deploy', backup: v.backup }); assert.equal(x.headers['x-atelier-waking'], undefined)
    assert.equal(sup.workers().length, 0, 'nothing resumed')
    const bootLine = `[todo] boot: rev 2 stays DOWN (deploy of ${c12} failed at migrate; backup ${v.backup} kept) — atelier restore todo ${v.backup}, or fix forward and deploy`
    assert.equal(bootLine, MESSAGES.log.bootDown('todo', 2, c12, 'migrate', v.backup)); assert.ok(w.lines.includes(bootLine))
    await sup.scan()
    assert.equal(sup.resolve('acme', 'todo').prod_state, 'down'); assert.equal(sup.workers().filter((k) => k.slot === 'prod').length, 0); assert.equal(sup.rows.get(inst).prod.adoptPending, undefined)
    // S2: a config stamp on a DOWN app is noted, never released
    const nReleases = w.releases.length
    sup.onConfigStamp(inst, '2026-09-02T12:00:00.000Z')
    await sleep(200)
    assert.equal(sup.resolve('acme', 'todo').prod_state, 'down'); assert.equal(w.releases.length, nReleases); assert.equal(sup.rows.get(inst).deploying, null); assert.equal(sup.rows.get(inst).configStamp, '2026-09-02T12:00:00.000Z')
    assert.ok(w.lines.includes('[todo] config stamp 2026-09-02T12:00:00.000Z noted — the app is DOWN after a failed release; no restart (restore or deploy first)'))
    // the restore (DOWN: no --yes) clears the marker on disk and serves again
    const rv = await sup.restore(inst, v.backup)
    assert.equal(rv.outcome, 'green', JSON.stringify(rv))
    assert.equal(revJson(w, inst).prod.down, undefined); assert.equal(sup.resolve('acme', 'todo').prod_state, 'live')
    assert.equal(JSON.parse((await api(sup, row, '/data', prod)).body).v, 'v1')
    // a host that died INSIDE the gate (after the backup, before the record): the `releasing` marker alone boots the app DOWN
    await sup.teardown()
    sup.store.prodPatch(inst, { releasing: { id: 'r-dead', commit: v.attempted.commit, rev: 9, backup: v.backup, at: '2026-09-02T12:00:00.000Z' } })
    sup = w.make({ timing: { idleMs: 60_000 } }); await sup.boot()
    assert.equal(sup.resolve('acme', 'todo').prod_state, 'down')
    pb = revJson(w, inst).prod
    assert.equal(pb.down.step, 'migrate'); assert.equal(pb.down.backup, v.backup); assert.equal(pb.down.commit, v.attempted.commit); assert.equal(pb.down.rev, 9); assert.match(pb.down.error, /^the host died during the release/); assert.equal(pb.releasing, undefined)
    x = await api(sup, row, '/rev', prod); assert.equal(x.status, 503); assert.deepEqual(JSON.parse(x.body), { error: 'app down after a failed deploy', backup: v.backup })
    assert.ok(w.lines.includes(MESSAGES.log.bootDown('todo', 2, c12, 'migrate', v.backup)))
    // fix forward: a green deploy writes a fresh prod block (no down, no releasing) and serves
    fs.writeFileSync(path.join(dir, 'module.json'), MJ())
    await sup.scan(); await live(sup, 'todo')
    const ok = await deploy(sup, row, { message: 'fixed' })
    assert.equal(ok.outcome, 'green', JSON.stringify(ok))
    pb = revJson(w, inst).prod
    assert.deepEqual(Object.keys(pb).sort(), ['commit', 'deployedAt', 'message', 'rev']); assert.equal(pb.rev, ok.rev); assert.equal(pb.commit, ok.commit)
    assert.equal((await api(sup, row, '/rev', prod)).status, 200); assert.equal(JSON.parse((await api(sup, row, '/data', prod)).body).v, 'v1')
    // S10: revision.json names the release but `current` still points at the previous rev (the host died between the two
    // writes): boot follows the recorded release — never the agent's working tree through an adopt
    await sup.teardown()
    sup.store.link(inst, 'current', 2)
    const commits = gitLog(dir).length
    sup = w.make({ timing: { idleMs: 60_000 } }); await sup.boot()
    assert.equal(readlink(dot(w, inst, 'current')), `../last-good/${inst}/rev-${ok.rev}`)
    r = sup.resolve('acme', 'todo')
    assert.equal(r.prod_rev, ok.rev); assert.equal(r.deployed_rev, ok.commit); assert.equal(r.prod_state, 'stopped'); assert.equal(sup.rows.get(inst).prod.adoptPending, undefined); assert.equal(sup.rows.get(inst).prod.legacy, false)
    assert.ok(w.lines.some((l) => l === `boot: todo current re-linked to rev ${ok.rev} (revision.json.prod named it; the previous host life died between the two writes)`))
    await sup.scan()
    assert.equal(gitLog(dir).length, commits, 'no adopt commit'); assert.equal(revJson(w, inst).prod.legacy, undefined)
    assert.equal(JSON.parse((await api(sup, row, '/rev', prod)).body).ctxRev, ok.rev, 'prod serves the recorded release')
  } finally { await w.done(sup) }
})

test('S5: the install step with a dependency — a package.json + one dependency from a local tarball (no network), the real installDeps (unprivileged: npm in the export, the freeze skipped by design), the export holds node_modules/<dep> + the lock, the prod worker createRequire\'s it from its cwd; the dev tree keeps its own install; the same commit again reuses the complete export', async () => {
  const w = world({ gitCommit: true })
  // the dependency: a tarball npm installs offline (`package/` root, as `npm pack` lays it out)
  const dep = path.join(w.root, 'dep'); fs.mkdirSync(path.join(dep, 'package'), { recursive: true })
  fs.writeFileSync(path.join(dep, 'package', 'package.json'), JSON.stringify({ name: 'tiny-dep', version: '1.0.0', main: 'index.js' }))
  fs.writeFileSync(path.join(dep, 'package', 'index.js'), 'module.exports = { answer: 42 }\n')
  const tgz = path.join(dep, 'tiny-dep-1.0.0.tgz')
  execFileSync('tar', ['-czf', tgz, '-C', dep, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const DEP_BACKEND = `import { createRequire } from 'node:module'\nexport default { mountRoutes(router) { router.get('/dep', (req, res) => { const need = createRequire(process.cwd() + '/package.json'); res.json({ answer: need('tiny-dep').answer, cwd: process.cwd() }) }) } }\n`
  const manifest = (extra = {}) => JSON.stringify({ name: 'todo', version: '1.0.0', private: true, dependencies: { 'tiny-dep': `file:${tgz}` }, ...extra })
  const { dir, sup, row } = await setup(w, 'todo', { 'module.json': MJ({ healthz: '/dep' }), 'backend.js': DEP_BACKEND, 'package.json': manifest() }, { install: (a) => installDeps({ ...a, hostEnv: process.env }) })
  try {
    const inst = row.instance
    // the dev tree's own install (a manifest change → onInstall → npm in the app folder): the dev worker resolves the dep from the folder
    fs.writeFileSync(path.join(dir, 'package.json'), manifest({ description: 'dev' }))
    await waitFor(() => fs.existsSync(path.join(dir, 'node_modules', 'tiny-dep', 'index.js')), { ms: 20_000 })
    await waitFor(() => sup.rows.get(inst).installing == null && sup.resolve('acme', 'todo').dev_state === 'live', { ms: 20_000 })
    assert.deepEqual(JSON.parse((await api(sup, row, '/dep')).body), { answer: 42, cwd: dir })
    const v = await deploy(sup, row, { message: 'with a dependency' })
    assert.equal(v.outcome, 'green', JSON.stringify(v))
    assert.match(v.steps.find((s) => s.name === 'install').note, /^\? files in \d+ ms$/, 'the real installer ran (unprivileged: no freeze, no file count)')
    const exp = dot(w, 'prod', inst, v.commit.slice(0, 12))
    assert.ok(fs.existsSync(path.join(exp, 'node_modules', 'tiny-dep', 'index.js')), 'the export holds the installed dependency')
    assert.ok(fs.existsSync(path.join(exp, 'package-lock.json')), 'the lock lands in the export')
    assert.ok(!fs.existsSync(dot(w, 'prod', inst, `${v.commit.slice(0, 12)}.tmp`)), 'the .tmp was renamed into place')
    assert.deepEqual(JSON.parse((await api(sup, row, '/dep', prod)).body), { answer: 42, cwd: exp })
    assert.ok(w.lines.includes('install todo: unprivileged — npm in the export as the current user, freeze skipped'))
    assert.ok(fs.existsSync(path.join(dir, 'node_modules', 'tiny-dep', 'index.js')), 'the dev tree keeps its node_modules')
    assert.deepEqual(JSON.parse((await api(sup, row, '/dep')).body), { answer: 42, cwd: dir })
    // a rollback to the same commit: the complete export is reused, no second install
    const rb = await deploy(sup, row, { commit: v.commit.slice(0, 12) })
    assert.equal(rb.outcome, 'green', JSON.stringify(rb)); assert.equal(rb.steps.find((s) => s.name === 'export').note, 'kept from the previous attempt of this commit'); assert.equal(rb.steps.find((s) => s.name === 'install').note, 'kept')
    assert.deepEqual(JSON.parse((await api(sup, row, '/dep', prod)).body), { answer: 42, cwd: exp })
  } finally { await w.done(sup) }
})

test('the socket dir\'s write bit (0730 at spawn → 0710 after READY) is dropped only by the LAST spawn of the instance in flight — a prod resume landing READY while the rehearsal worker is still binding (drill row 9e run 2: `listen EACCES … w-rehearsal-6.sock`) leaves the dir writable until the rehearsal is READY too; the deploy is green', async () => {
  const w = world({ gitCommit: true })
  const base = makeSpawn(path.join(w.root, 'runtime.mjs'))
  let sup = null, inst = null, armed = false, onProdReady = null, prodReadyAt = null
  const chmods = []   // every chmod of the instance's socket dir once armed: [mode, spawns in flight at that moment]
  const realChmod = w.osx.chmod
  w.osx.chmod = (p, m) => { const r = inst ? sup?.rows.get(inst) : null; if (armed && r && p === r.sockDir) chmods.push([m, r.spawning]); return realChmod(p, m) }
  const spawnWrapped = async (a) => {
    const h = await base(a)   // resolves at READY: the worker is bound; the supervisor has not yet settled this spawn
    if (armed && a.spec.sock.includes('w-rehearsal-')) {
      // the drill's window: prod dies now and its restart lands READY while this rehearsal spawn is still in flight
      const prodBack = new Promise((r) => { onProdReady = r })
      sup.kill(inst, 'test: the resume-during-boot race', 'prod')
      await prodBack
    }
    if (armed && a.spec.sock.includes('w-prod-') && onProdReady) { prodReadyAt = sup.rows.get(inst).spawning; const r = onProdReady; onProdReady = null; r() }   // the RESUMED worker only (the gate's `start` spawns prod again later, alone)
    return h
  }
  const { dir, sup: s, row } = await setup(w, 'todo', { 'module.json': MJ(), 'backend.js': DATA_BACKEND(1) }, { spawn: spawnWrapped, timing: { quiesceMs: 40, swapStopMs: 100, drainMs: 1000, backoffMs: [10] } })
  sup = s; inst = row.instance
  try {
    assert.equal((await deploy(sup, row, { message: 'first' })).outcome, 'green')
    assert.equal(sup.rows.get(inst).spawning, 0)
    fs.writeFileSync(path.join(dir, 'backend.js'), DATA_BACKEND(2))
    await waitFor(() => sup.resolve('acme', 'todo').dev_rev === 3)
    armed = true
    const v = await deploy(sup, row, { message: 'second' })
    armed = false
    assert.equal(v.outcome, 'green', JSON.stringify(v))
    assert.equal(prodReadyAt, 2, 'the resumed prod worker went READY while the rehearsal spawn was in flight (the overlap happened)')
    const locks = chmods.filter(([m]) => m === 0o710)
    assert.ok(locks.length >= 2, `the rehearsal's and the gate's spawns each locked the dir once they were the last in flight (${JSON.stringify(chmods)})`)
    assert.ok(locks.every(([, n]) => n === 0), `never locked with a spawn in flight: ${JSON.stringify(chmods)}`)
    assert.equal(sup.rows.get(inst).spawning, 0)
    assert.equal(JSON.parse((await api(sup, row, '/rev', prod)).body).rev, 2)
  } finally { w.osx.chmod = realChmod; await w.done(sup) }
})

test("the claim's `git init` and an immediate deploy on the same row share ONE init — the deploy's commit step awaits the claim's in-flight init instead of running a second `git init` on the dir (two overlapped under load: `could not lock config file`, 2026-09-02)", async () => {
  const w = world({ gitCommit: true })
  const inits = []
  const spawn0 = w.osx.spawn
  w.osx.spawn = (spec) => { if (spec?.argv?.[0] === 'git' && spec.argv.includes('init')) inits.push(spec.argv); return spawn0.call(w.osx, spec) }
  const dir = w.app('todo', { 'module.json': MJ({ healthz: '/rev' }), 'backend.js': DATA_BACKEND(1), 'frontend.jsx': FRONTEND(1), 'card.jsx': CARD })
  const sup = w.make()
  try {
    await sup.scan()   // the claim starts `git init` and does not wait for it
    const row = sup.resolve('acme', 'todo')
    assert.ok(row, 'the row is linked at claim')
    const v = await deploy(sup, row, { message: 'first release' })   // fired while that init is still running
    assert.equal(v.outcome, 'green', JSON.stringify(v))
    assert.equal(inits.length, 1, `git init spawned ${inits.length}×: ${JSON.stringify(inits)}`)
    assert.deepEqual(w.lines.filter((l) => /could not lock/.test(l)), [])
    assert.deepEqual(gitLog(dir).map((l) => l.slice(41)), ['first release'])
    const again = await deploy(sup, row, { message: 'second release' })   // the row is ready: no init at all
    assert.equal(again.outcome, 'green', JSON.stringify(again))
    assert.equal(inits.length, 1)
  } finally { await w.done(sup) }
})
