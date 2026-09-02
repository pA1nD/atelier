// supervisor/index.mjs workerSpec + scan (DESIGN §6.1 "the config hold"; the 2026-09-02 incident: the system host's `home`
// spawned WITHOUT its env when the config GET failed, and the portal was dark for every signed-in user): the config door
// decides whether a spawn goes. No document known and the door fails (5xx, API 50's `503 no config key`, a network error,
// or a 200 with a non-empty `sealed_missing` — keys the spine could not unseal, masked out of `env`) → the spawn is HELD:
// no worker, the slot `loading`, one line per row per reason (the keys named, never a value), no report, retried at each
// scan once the door answers — never a rebuild against a closed door. A last-known document from a previous successful
// read → the spawn on it, and the next successful read that shows the document moved is a config release (D16). A 404
// (no config rows) is the empty document, known from then on. The seeded (system host) road and the resume of a boot row
// follow the same rule.
import test from 'node:test'
import assert from 'node:assert/strict'
import { world, api, waitFor, APP_JSON, fs, path } from './supervisor-harness.test.js'
import { TransportError } from '../protocol/registrar.mjs'
import { SEEDED_MARKER } from '../supervisor/discovery.mjs'

const prod = { slot: 'prod' }
const revJson = (w, inst) => JSON.parse(fs.readFileSync(path.join(w.work, '.atelier', inst, 'revision.json'), 'utf8'))
const revDir = (w, inst, n) => path.join(w.work, '.atelier', 'last-good', inst, `rev-${n}`)
// a backend that tells which document it runs on (the harness spawn puts spec.configEnv into the worker's env)
const ENV_BACKEND = (rev) => `export default { mountRoutes(router) { router.get('/env', (req, res) => res.json({ rev: ${rev}, K: process.env.K ?? null })) } }\n`
const configLines = (w, slug) => w.lines.filter((l) => l.startsWith(`[${slug}] app config:`))
const HELD = (why) => `${why} — no known document: spawn HELD (retried at each scan)`
const CACHED = (why) => `${why} — spawning with the last-known document (swapped at the next successful read)`
const BACK = 'the door answers again'
// the config door of the fake registrar: closed with a status (the transport's error) or open with a document
function door(w) {
  const d = { answer: null }
  d.closed = (status = 503, error = 'no config key') => { d.answer = () => { throw new TransportError(status, { error }) } }
  d.open = (env) => { d.answer = () => ({ env, sealed_missing: [] }) }
  d.masked = (env, keys) => { d.answer = () => ({ env, sealed_missing: keys }) }   // API 50: a 200 with values the spine could not unseal masked out
  w.registrar.appConfig = async () => d.answer()
  return d
}
const state = (sup, slug) => sup.resolve('acme', slug)

test('no document known + the door fails: the dev spawn is HELD — no worker, dev `loading`, 503, ONE line per reason, no report; scans do not rebuild (one rev, the held rev dropped); the door answers → the next scan spawns with the fresh document', async () => {
  const w = world()
  const d = door(w); d.closed()
  const dir = w.app('todo', { 'module.json': APP_JSON('Todo'), 'backend.js': ENV_BACKEND(1) })
  const sup = w.make()
  try {
    await sup.scan()
    const inst = state(sup, 'todo').instance, row = sup.rows.get(inst)
    await waitFor(() => row.dev.configHeld && row.building === null)
    let r = state(sup, 'todo')
    assert.equal(r.dev_state, 'loading'); assert.equal(r.state, 'undeployed'); assert.equal(sup.workers().length, 0)
    assert.equal((await api(sup, r, '/env')).status, 503)
    assert.deepEqual(configLines(w, 'todo'), [`[todo] app config: ${HELD('spine 503 no config key')}`])
    assert.equal(w.reports.length, 0, 'a closed door is no app error')
    assert.equal(revJson(w, inst).rev, 1); assert.ok(!fs.existsSync(revDir(w, inst, 1)), 'the held rev is dropped')
    await sup.scan(); await sup.scan()
    assert.equal(revJson(w, inst).rev, 1, 'no rebuild against a closed door'); assert.equal(configLines(w, 'todo').length, 1, 'one line, not one per scan')
    assert.equal(sup.workers().length, 0)
    // another reason: one more line, still held
    d.closed(503, 'config key mismatch')
    await sup.scan()
    assert.deepEqual(configLines(w, 'todo').slice(1), [`[todo] app config: ${HELD('spine 503 config key mismatch')}`])
    assert.equal(sup.workers().length, 0); assert.equal(revJson(w, inst).rev, 1)
    // the door answers: the scan spawns with the fresh document
    d.open({ K: 'v1' })
    await sup.scan()
    await waitFor(() => state(sup, 'todo').dev_state === 'live')
    r = state(sup, 'todo')
    assert.equal(r.dev_rev, 2)
    assert.deepEqual(JSON.parse((await api(sup, r, '/env')).body), { rev: 1, K: 'v1' })
    assert.deepEqual(configLines(w, 'todo').slice(2), [`[todo] app config: ${BACK}`])
    assert.equal(row.dev.configHeld, false); assert.equal(row.dev.configStale, false); assert.deepEqual(row.configDoc, { K: 'v1' })
    assert.equal(w.reports.length, 0)
    // a save while the door is open: fresh at every spawn, as ever
    d.open({ K: 'v2' })
    fs.writeFileSync(path.join(dir, 'backend.js'), ENV_BACKEND(2))
    await waitFor(() => state(sup, 'todo').dev_rev === 3)
    assert.deepEqual(JSON.parse((await api(sup, r, '/env')).body), { rev: 2, K: 'v2' })
    assert.equal(configLines(w, 'todo').length, 3)
  } finally { await w.done(sup) }
})

test('a 404 (no config rows) is the empty document: the spawn goes with no env and no line; it counts as known — the door failing later resumes the idle-stopped dev worker on it (`configStale`), one line', async () => {
  const w = world()
  const d = door(w); d.closed(404, 'no config')
  w.app('todo', { 'module.json': APP_JSON('Todo'), 'backend.js': ENV_BACKEND(1) })
  const sup = w.make({ timing: { devIdleMs: 200 } })
  try {
    await sup.scan()
    const r = await waitFor(() => { const x = state(sup, 'todo'); return x?.dev_state === 'live' ? x : null })
    const row = sup.rows.get(r.instance)
    assert.deepEqual(JSON.parse((await api(sup, r, '/env')).body), { rev: 1, K: null })
    assert.deepEqual(configLines(w, 'todo'), []); assert.deepEqual(row.configDoc, {}); assert.equal(row.dev.configStale, false)
    await waitFor(() => state(sup, 'todo').dev_state === 'stopped')
    d.closed(503, 'no config key')
    assert.deepEqual(JSON.parse((await api(sup, r, '/env')).body), { rev: 1, K: null }, 'resumed on the last-known (empty) document')
    assert.equal(row.dev.configStale, true); assert.equal(row.dev.configHeld, false)
    assert.deepEqual(configLines(w, 'todo'), [`[todo] app config: ${CACHED('spine 503 no config key')}`])
    assert.equal(w.reports.length, 0)
  } finally { await w.done(sup) }
})

test('the seeded (system host) road: the door failing at boot with no document HOLDS the prod spawn — prod `loading`, 503 app not ready (never a worker without its env, never 404 not deployed), one rev across scans, no release row; the door answers → live with the document, ONE adopt row; failing later → the idle-stopped worker resumes on the last-known document; the same document read again → nothing; a MOVED one → a config release', async () => {
  const w = world({ seededApps: true })   // the system host: ATELIER_SEEDED_APPS=1 opens the seeded road (B2)
  const d = door(w); d.closed()
  w.app('home', { 'module.json': APP_JSON('Home'), 'backend.js': ENV_BACKEND(1), [SEEDED_MARKER]: '' })
  const sup = w.make({ timing: { idleMs: 300 } })
  try {
    await sup.scan()
    let r = state(sup, 'home')
    const inst = r.instance, row = sup.rows.get(inst)
    assert.equal(r.state, 'loading'); assert.equal(r.prod_state, 'loading'); assert.equal(r.prod_rev, null); assert.equal(r.deployed_rev, null); assert.equal(r.dev_rev, null)
    const held = await api(sup, r, '/env', prod)
    assert.equal(held.status, 503); assert.equal(JSON.parse(held.body).error, 'app not ready')
    assert.equal(sup.workers().length, 0); assert.equal(w.releases.length, 0); assert.deepEqual(w.modules, []); assert.equal(w.reports.length, 0)
    assert.deepEqual(configLines(w, 'home'), [`[home] app config: ${HELD('spine 503 no config key')}`])
    assert.equal(revJson(w, inst).rev, 1); assert.ok(!fs.existsSync(revDir(w, inst, 1)))
    assert.ok(!w.lines.some((l) => /^\[home\] rev 1 FAILED/.test(l)), 'a hold is no failure line')
    await sup.scan(); await sup.scan()
    assert.equal(revJson(w, inst).rev, 1, 'no rebuild against a closed door'); assert.equal(configLines(w, 'home').length, 1); assert.equal(sup.workers().length, 0)
    // the door answers: built again from the same bytes, spawned with the document, the adopt row
    d.open({ K: 'admin-1' })
    await sup.scan()
    r = state(sup, 'home')
    assert.equal(r.prod_state, 'live'); assert.equal(r.state, 'live'); assert.equal(r.prod_rev, 2)
    assert.deepEqual(JSON.parse((await api(sup, r, '/env', prod)).body), { rev: 1, K: 'admin-1' })
    assert.equal(w.releases.length, 1); assert.equal(w.releases[0].kind, 'adopt'); assert.equal(w.releases[0].rev, 2); assert.deepEqual(w.modules, [[inst, 2]])
    assert.deepEqual(configLines(w, 'home').slice(1), [`[home] app config: ${BACK}`])
    assert.equal(row.prod.configHeld, false); assert.equal(row.prod.configStale, false)
    // idle-stopped (empty resources); the door fails: the resume goes on the last-known document
    await waitFor(() => state(sup, 'home').prod_state === 'stopped')
    d.closed(503, 'config key mismatch')
    assert.deepEqual(JSON.parse((await api(sup, r, '/env', prod)).body), { rev: 1, K: 'admin-1' })
    assert.equal(row.prod.configStale, true); assert.equal(state(sup, 'home').prod_state, 'live')
    assert.equal(configLines(w, 'home').at(-1), `[home] app config: ${CACHED('spine 503 config key mismatch')}`)
    await sup.scan()
    assert.equal(configLines(w, 'home').length, 3, 'still closed: no new line'); assert.equal(row.prod.configStale, true); assert.equal(w.releases.length, 2, 'the announce; no config row')
    // the door answers with the SAME document: nothing to swap
    d.open({ K: 'admin-1' })
    await sup.scan()
    assert.equal(row.prod.configStale, false); assert.equal(w.releases.filter((x) => x.kind === 'config').length, 0)
    assert.equal(configLines(w, 'home').at(-1), `[home] app config: ${BACK}`)
    // from the cache again, then a MOVED document: a config release under the gate (the same restart a stamp brings)
    await waitFor(() => state(sup, 'home').prod_state === 'stopped')
    d.closed()
    assert.deepEqual(JSON.parse((await api(sup, r, '/env', prod)).body), { rev: 1, K: 'admin-1' }); assert.equal(row.prod.configStale, true)
    d.open({ K: 'admin-2' })
    await sup.scan()
    assert.ok(configLines(w, 'home').includes('[home] app config: the document moved while rev 2 ran on the last-known one — config release'), configLines(w, 'home').join('\n'))
    await waitFor(() => row.deploying === null)
    r = state(sup, 'home')
    assert.equal(r.prod_state, 'live'); assert.equal(r.prod_rev, 2)
    assert.deepEqual(JSON.parse((await api(sup, r, '/env', prod)).body), { rev: 1, K: 'admin-2' })
    assert.equal(row.prod.configStale, false)
    const c = w.releases.filter((x) => x.kind === 'config')
    assert.equal(c.length, 1); assert.equal(c[0].verdict, 'green'); assert.equal(c[0].rev, 2)
    assert.equal(w.reports.length, 0)
  } finally { await w.done(sup) }
})

test('a second host life with the door closed (no document yet): the resume of a boot row is HELD — prod `loading`, 503, no report, the crash ladder does not spin; the scan resumes it once the door answers', async () => {
  const w = world({ seededApps: true })
  const d = door(w); d.open({ K: 'a' })
  w.app('home', { 'module.json': APP_JSON('Home'), 'backend.js': ENV_BACKEND(1), [SEEDED_MARKER]: '' })
  let sup = w.make({ timing: { idleMs: 60_000 } })
  try {
    await sup.scan()
    let r = state(sup, 'home')
    const inst = r.instance
    assert.equal(r.prod_state, 'live'); assert.deepEqual(JSON.parse((await api(sup, r, '/env', prod)).body), { rev: 1, K: 'a' })
    await sup.teardown()
    d.closed()
    const before = w.lines.length
    sup = w.make({ timing: { idleMs: 60_000 } })
    await sup.boot()
    r = state(sup, 'home'); assert.equal(r.prod_state, 'stopped'); assert.equal(r.prod_rev, 1)
    const row = sup.rows.get(inst)
    assert.equal(row.configDoc, null, 'the document is this host life\'s: never on disk')
    assert.equal((await api(sup, r, '/env', prod)).status, 503)
    assert.equal(state(sup, 'home').prod_state, 'loading'); assert.equal(row.prod.configHeld, true); assert.equal(sup.workers().length, 0)
    assert.deepEqual(w.lines.slice(before).filter((l) => l.startsWith('[home] app config:')), [`[home] app config: ${HELD('spine 503 no config key')}`])
    assert.ok(!w.lines.slice(before).some((l) => /RESUME FAILED/.test(l)), 'a hold is no resume failure')
    assert.equal(w.reports.length, 0)
    await sup.scan(); await sup.scan()
    assert.equal(sup.workers().length, 0); assert.equal(state(sup, 'home').prod_state, 'loading'); assert.equal(revJson(w, inst).rev, 1, 'a seeded boot row is never rebuilt for the door')
    assert.equal(w.lines.slice(before).filter((l) => l.startsWith('[home] app config:')).length, 1)
    d.open({ K: 'b' })
    await sup.scan()
    await waitFor(() => state(sup, 'home').prod_state === 'live')
    assert.deepEqual(JSON.parse((await api(sup, r, '/env', prod)).body), { rev: 1, K: 'b' })
    assert.equal(row.prod.configHeld, false); assert.equal(row.prod.configStale, false)
    assert.ok(w.lines.slice(before).some((l) => /^\[home\] rev 1 RESUMED \d+ ms$/.test(l)))
    assert.equal(w.reports.length, 0)
  } finally { await w.done(sup) }
})

test('a MASKED document (API 50: a 200 whose `sealed_missing` is non-empty) is a closed door: no document known → the dev spawn is HELD, ONE line naming the keys (never a value), one read per scan, no rebuild; the whole document → the spawn; masked again WITH a last-known document → the save spawns on the cache (stale), the partial env never served; an idle-stopped worker resumes fresh once the document is whole', async () => {
  const w = world()
  const d = door(w); d.masked({ K: 'hunter2' }, ['SECRET_A', 'SECRET_B'])
  const dir = w.app('todo', { 'module.json': APP_JSON('Todo'), 'backend.js': ENV_BACKEND(1) })
  const sup = w.make({ timing: { devIdleMs: 200 } })
  try {
    await sup.scan()
    const inst = state(sup, 'todo').instance, row = sup.rows.get(inst)
    await waitFor(() => row.dev.configHeld && row.building === null)
    let r = state(sup, 'todo')
    assert.equal(r.dev_state, 'loading'); assert.equal(sup.workers().length, 0)
    assert.equal((await api(sup, r, '/env')).status, 503)
    assert.deepEqual(configLines(w, 'todo'), [`[todo] app config: ${HELD('spine cannot unseal SECRET_A, SECRET_B (sealed_missing)')}`])
    assert.equal(row.configDoc, null, 'the partial env never becomes the last-known document')
    assert.equal(w.reports.length, 0, 'a masked document is no app error')
    await sup.scan(); await sup.scan()
    assert.equal(revJson(w, inst).rev, 1, 'no rebuild against a masked door'); assert.equal(configLines(w, 'todo').length, 1, 'one line, not one per scan')
    assert.equal(sup.workers().length, 0)
    // the whole document: the scan spawns with it
    d.open({ K: 'hunter2' })
    await sup.scan()
    await waitFor(() => state(sup, 'todo').dev_state === 'live')
    r = state(sup, 'todo')
    assert.deepEqual(JSON.parse((await api(sup, r, '/env')).body), { rev: 1, K: 'hunter2' })
    assert.deepEqual(configLines(w, 'todo').slice(1), [`[todo] app config: ${BACK}`])
    assert.equal(row.dev.configHeld, false); assert.deepEqual(row.configDoc, { K: 'hunter2' })
    // masked again, with a last-known document: the save's spawn goes on the cache (stale) — the masked env is never served
    d.masked({ K: 'partial' }, ['SECRET_A'])
    fs.writeFileSync(path.join(dir, 'backend.js'), ENV_BACKEND(2))
    await waitFor(() => state(sup, 'todo').dev_rev === 3)
    assert.deepEqual(JSON.parse((await api(sup, r, '/env')).body), { rev: 2, K: 'hunter2' }, 'the cache, never the partial document')
    assert.equal(row.dev.configStale, true)
    assert.equal(configLines(w, 'todo').at(-1), `[todo] app config: ${CACHED('spine cannot unseal SECRET_A (sealed_missing)')}`)
    assert.deepEqual(row.configDoc, { K: 'hunter2' }, 'the cache is untouched by the masked read')
    await sup.scan()
    assert.equal(configLines(w, 'todo').length, 3, 'still masked: no new line')
    // whole again, moved: the idle-stopped dev worker resumes on the fresh document
    await waitFor(() => state(sup, 'todo').dev_state === 'stopped')
    d.open({ K: 'moved' })
    assert.deepEqual(JSON.parse((await api(sup, r, '/env')).body), { rev: 2, K: 'moved' })
    assert.equal(row.dev.configStale, false); assert.equal(configLines(w, 'todo').at(-1), `[todo] app config: ${BACK}`)
    assert.ok(!w.lines.some((l) => /hunter2|partial|moved/.test(l)), 'no value ever reaches a log line')
    assert.equal(w.reports.length, 0)
  } finally { await w.done(sup) }
})

test('the seeded (system host) road: a MASKED document at boot HOLDS the prod build — prod `loading`, 503 app not ready, one rev, one line naming the keys, no adopt row; the whole document → live on it, ONE adopt row', async () => {
  const w = world({ seededApps: true })
  const d = door(w); d.masked({}, ['SPINE_ADMIN'])
  w.app('home', { 'module.json': APP_JSON('Home'), 'backend.js': ENV_BACKEND(1), [SEEDED_MARKER]: '' })
  const sup = w.make({ timing: { idleMs: 60_000 } })
  try {
    await sup.scan()
    let r = state(sup, 'home')
    const inst = r.instance, row = sup.rows.get(inst)
    assert.equal(r.prod_state, 'loading'); assert.equal(r.prod_rev, null); assert.equal(sup.workers().length, 0)
    assert.equal((await api(sup, r, '/env', prod)).status, 503)
    assert.deepEqual(configLines(w, 'home'), [`[home] app config: ${HELD('spine cannot unseal SPINE_ADMIN (sealed_missing)')}`])
    assert.equal(row.prod.configHeld, true); assert.equal(row.configDoc, null)
    assert.equal(w.releases.length, 0); assert.equal(w.reports.length, 0)
    await sup.scan(); await sup.scan()
    assert.equal(revJson(w, inst).rev, 1, 'one rev across scans'); assert.equal(configLines(w, 'home').length, 1); assert.equal(sup.workers().length, 0)
    d.open({ K: 'admin-1' })
    await sup.scan()
    await waitFor(() => state(sup, 'home').prod_state === 'live')
    r = state(sup, 'home')
    assert.deepEqual(JSON.parse((await api(sup, r, '/env', prod)).body), { rev: 1, K: 'admin-1' })
    assert.equal(w.releases.length, 1); assert.equal(w.releases[0].kind, 'adopt')
    assert.equal(configLines(w, 'home').at(-1), `[home] app config: ${BACK}`)
    assert.equal(row.prod.configHeld, false); assert.equal(row.prod.configStale, false)
    assert.equal(w.reports.length, 0)
  } finally { await w.done(sup) }
})
