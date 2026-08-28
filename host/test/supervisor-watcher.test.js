// supervisor/watcher.mjs — exclusion list, two-fingerprint quiescence, debounce, heal rule,
// install events, registration-time exclusion (DESIGN §6.1, §8.1).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWatcher, fingerprint, excluded } from '../supervisor/watcher.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mk = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-watch-'))
  fs.writeFileSync(path.join(dir, 'module.json'), '{"name":"A"}')
  fs.writeFileSync(path.join(dir, 'frontend.jsx'), 'export default () => null')
  fs.writeFileSync(path.join(dir, 'backend.js'), 'export default { mountRoutes() {} }')
  fs.mkdirSync(path.join(dir, 'data'))
  fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'lib'))
  fs.writeFileSync(path.join(dir, 'lib', 'helper.js'), 'export const x = 1')
  fs.mkdirSync(path.join(dir, '_private'))
  return dir
}
const Q = 40   // quiescence for tests (production 100 ms)
const settle = () => sleep(Q * 6)
// positive expectations poll (macOS FSEvents latency grows under load); negatives use the fixed settle()
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('until: timeout'); await sleep(10) } }

test('the exclusion list is exact', () => {
  for (const r of ['node_modules/x.js', 'data/db.sqlite', '.atelier', '.git/HEAD', '_private/x', 'package.json', 'package-lock.json', 'CLAIM-REFUSED.txt', 'lib/node_modules/y', 'lib/.env'])
    assert.equal(excluded(r), true, r)
  for (const r of ['frontend.jsx', 'backend.js', 'lib/helper.js', 'module.json', 'styles.css', 'lib/package.json-ish'])
    assert.equal(excluded(r), false, r)
})

test('fingerprint keys on the remaining files only; missing folder → null hash', () => {
  const dir = mk()
  const a = fingerprint(dir)
  fs.writeFileSync(path.join(dir, 'data', 'x.txt'), 'y')
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'z')
  fs.writeFileSync(path.join(dir, 'package.json'), '{}')
  assert.equal(fingerprint(dir).hash, a.hash)
  fs.writeFileSync(path.join(dir, 'lib', 'helper.js'), 'export const x = 22')
  assert.notEqual(fingerprint(dir).hash, a.hash)
  assert.equal(a.files, 4)
  assert.deepEqual(a.dirs.map((d) => path.relative(dir, d)).sort(), ['', 'lib'])
  assert.equal(fingerprint(path.join(dir, 'nope')).hash, null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('100 data/ writes → 0 rebuilds; a node_modules storm → 0 while healthy; one save → 1 after quiescence', async () => {
  const dir = mk()
  const changes = []
  const w = createWatcher({ dir, quiesceMs: Q, onChange: (fp) => changes.push(fp) })
  w.start()
  assert.equal(w.watchCount(), 2)            // the folder + lib/ — never data/, node_modules/, _private/
  for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(dir, 'data', `f${i}.txt`), String(i))
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(dir, 'node_modules', 'dep', `m${i}.js`), 'x')
  await settle()
  assert.equal(changes.length, 0)
  fs.writeFileSync(path.join(dir, 'frontend.jsx'), 'export default () => 1')
  await until(() => changes.length === 1)
  // three saves inside one window → one change
  fs.writeFileSync(path.join(dir, 'frontend.jsx'), 'export default () => 2')
  await sleep(5)
  fs.writeFileSync(path.join(dir, 'backend.js'), 'export default { mountRoutes() { return 2 } }')
  await sleep(5)
  fs.writeFileSync(path.join(dir, 'lib', 'helper.js'), 'export const x = 3')
  await until(() => changes.length === 2)
  await settle()
  assert.equal(changes.length, 2)
  // a content-identical rewrite (same size, new mtime) is a new fingerprint → a change (mtime is in the key)
  w.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('two-fingerprint quiescence: a write inside the window extends it; one change at the end', async () => {
  const dir = mk()
  const changes = []
  const w = createWatcher({ dir, quiesceMs: Q, onChange: (fp) => changes.push(fp) })
  w.start()
  for (let i = 0; i < 6; i++) { fs.writeFileSync(path.join(dir, 'frontend.jsx'), `export default () => ${i}`); await sleep(Q / 2) }
  assert.equal(changes.length, 0)
  await until(() => changes.length === 1)
  await settle()
  assert.equal(changes.length, 1)
  assert.equal(changes[0], fingerprint(dir).hash)
  w.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('heal rule: while broken, node_modules / lockfile events pass; package.json → onInstall', async () => {
  const dir = mk()
  const changes = [], installs = []
  let broken = false
  const w = createWatcher({ dir, quiesceMs: Q, onChange: (fp) => changes.push(fp), onInstall: () => installs.push(1), isBroken: () => broken })
  w.start()
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'a.js'), '1')
  await settle()
  assert.equal(changes.length, 0)
  broken = true
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'b.js'), '1')
  await settle()
  assert.equal(changes.length, 0, 'deep node_modules writes are not watched at all (registration-time exclusion)')
  fs.rmSync(path.join(dir, 'node_modules'), { recursive: true }); fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true })
  await until(() => changes.length === 1)   // the root node_modules entry passes while broken (same fingerprint, still a change)
  fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{}}')
  await until(() => installs.length === 1 && changes.length === 2)   // lockfile/package.json passes as a change while broken too
  broken = false
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}')
  await until(() => installs.length === 2)
  await settle()
  assert.equal(changes.length, 2, 'healthy: an install event is not a change')
  fs.rmSync(path.join(dir, 'node_modules'), { recursive: true })
  await settle()
  assert.equal(changes.length, 2, 'healthy: node_modules churn is not a change')
  w.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a new subdirectory is registered after it appears; a save inside it is a change', async () => {
  const dir = mk()
  const changes = []
  const w = createWatcher({ dir, quiesceMs: Q, onChange: (fp) => changes.push(fp) })
  w.start()
  fs.mkdirSync(path.join(dir, 'components'))
  fs.writeFileSync(path.join(dir, 'components', 'card.jsx'), 'export const Card = () => null')
  await until(() => changes.length === 1 && w.watchCount() === 3)
  fs.writeFileSync(path.join(dir, 'components', 'card.jsx'), 'export const Card = () => 1')
  await until(() => changes.length === 2)
  fs.rmSync(path.join(dir, 'components'), { recursive: true })
  await until(() => changes.length === 3 && w.watchCount() === 2)
  await settle()
  assert.equal(changes.length, 3)
  w.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the folder itself removed → onGone, no change', async () => {
  const dir = mk()
  const changes = [], gone = []
  const w = createWatcher({ dir, quiesceMs: Q, onChange: (fp) => changes.push(fp), onGone: () => gone.push(1) })
  w.start()
  fs.rmSync(dir, { recursive: true, force: true })
  w.touch()
  await until(() => gone.length === 1)
  assert.equal(changes.length, 0)
  assert.equal(w.watchCount(), 0)
  w.stop()
})
