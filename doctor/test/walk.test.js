// doctor/test/walk.test.js — the 1.x walkJsxFiles exclusions, the corpus listing, the 12 subfolder-JSX
// shapes of the seed corpus (DESIGN §8). The fixture tree is built in a tmp dir; nothing under data/ is
// ever opened — the data/ directory itself is made unreadable to plant the proof.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listModules, moduleEntry, isModuleDir, walkJsxFiles, walkSourceFiles, subfolderClientFiles } from '../rules/walk.mjs'
import { analyzeModule, cellsOf } from '../rules/static.mjs'

let root
const put = (rel, text = '// x\n') => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }

// the seed's 12 modules with client JS/JSX in subfolders (RESULT.md "subfolder scan"), one file each
const SUBFOLDER = {
  accounts: ['lib/store.js'], agent: ['features/browser.js'], auth: ['login/catalyst/button.jsx'], 'blitz-portal': ['app/app.js', 'app/assets/opentype.min.js'],
  flights: ['vendor/leaflet.js'], intercom: ['lib/claude.js'], 'latency-map': ['vendor/leaflet.js'], 'meet-vault': ['extension/background.js'],
  shipmate: ['extension/background.js', 'tmux/tdf.js'], sous: ['bench/voicemic/virtual-mic.js'], statusbar: ['sections/codes.jsx'], voicelab: ['assets/audio-tap.js'],
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-walk-'))
  // one module with every exclusion
  put('demo/frontend.jsx', "export const meta = { name: 'Demo' }\n")
  put('demo/backend.js', 'export default { mountRoutes(router, ctx) {} }\n')
  put('demo/lib/a.js'); put('demo/lib/b.jsx'); put('demo/util.mjs'); put('demo/legacy.cjs'); put('demo/README.md'); put('demo/style.css')
  put('demo/sub/backend.js')                    // excluded by name at any depth (1.x)
  put('demo/node_modules/dep/index.js')
  put('demo/_private/p.jsx'); put('demo/.hidden/h.js'); put('demo/-dash/d.js'); put('demo/.DS_Store.js')
  put('demo/data/big.js'); put('demo/data/sub/x.jsx')
  fs.chmodSync(path.join(root, 'demo/data'), 0o000)
  // the corpus listing
  put('_private/frontend.jsx'); put('.hidden/backend.js'); put('empty/README.md'); put('json-only/module.json', '{"name": "J"}')
  fs.writeFileSync(path.join(root, 'file.js'), '')
  for (const [id, files] of Object.entries(SUBFOLDER)) {
    put(`${id}/frontend.jsx`, `export const meta = { name: '${id}' }\n`)
    for (const f of files) put(`${id}/${f}`)
    put(`${id}/data/cache.js`); put(`${id}/node_modules/x/index.js`); put(`${id}/.claude/z.js`); put(`${id}/_old/w.jsx`)
  }
  put('top-only/frontend.jsx', "export const meta = { name: 'T' }\n"); put('top-only/helper.js'); put('top-only/data/x.js')
})
after(() => { try { fs.chmodSync(path.join(root, 'demo/data'), 0o755) } catch {} fs.rmSync(root, { recursive: true, force: true }) })

const rel = (dir, files) => files.map((f) => path.relative(dir, f)).sort()

test('walkJsxFiles: 1.x exclusions verbatim; data/ is never entered', () => {
  const dir = path.join(root, 'demo')
  assert.deepEqual(rel(dir, walkJsxFiles(dir)), ['frontend.jsx', 'lib/a.js', 'lib/b.jsx'])
  assert.throws(() => fs.readdirSync(path.join(dir, 'data')), /EACCES|EPERM/)   // the proof: it is unreadable, and the walk did not throw
})

test('walkSourceFiles: adds backend.js (at any depth) and .mjs/.cjs, same exclusions', () => {
  const dir = path.join(root, 'demo')
  assert.deepEqual(rel(dir, walkSourceFiles(dir)), ['backend.js', 'frontend.jsx', 'legacy.cjs', 'lib/a.js', 'lib/b.jsx', 'sub/backend.js', 'util.mjs'])
})

test('subfolderClientFiles: relative paths of the client files outside the top level', () => {
  const dir = path.join(root, 'demo')
  assert.deepEqual(subfolderClientFiles(dir).sort(), ['lib/a.js', 'lib/b.jsx'])
  assert.deepEqual(subfolderClientFiles(path.join(root, 'top-only')), [])
})

test('listModules: alphanumeric first character, has frontend.jsx / backend.js / module.json; sorted; daily stamped', () => {
  const mods = listModules(root, { daily: new Set(['agent', 'flights']) })
  const ids = mods.map((m) => m.id)
  assert.ok(!ids.includes('_private') && !ids.includes('.hidden') && !ids.includes('empty') && !ids.includes('file.js'))
  assert.ok(ids.includes('json-only') && ids.includes('demo') && ids.includes('top-only'))
  assert.deepEqual(ids, [...ids].sort())
  assert.equal(mods.find((m) => m.id === 'agent').daily, true)
  assert.equal(mods.find((m) => m.id === 'demo').daily, false)
  assert.deepEqual(moduleEntry(path.join(root, 'demo')), { id: 'demo', dir: path.join(root, 'demo'), hasFrontend: true, hasBackend: true, hasModuleJson: false, daily: false })
  assert.equal(isModuleDir(path.join(root, 'json-only')), true)
  assert.equal(isModuleDir(path.join(root, 'empty')), false)
})

test('N7: the 12 subfolder-JSX shapes count, the exclusions (data/, node_modules/, .claude/, _old/) do not', () => {
  const mods = listModules(root)
  const n7 = {}
  for (const m of mods) {
    const r = analyzeModule(m)
    const c = cellsOf(r)
    if (c.N7) n7[m.id] = r.files.subfolderClient.sort()
  }
  assert.deepEqual(Object.keys(n7).sort(), [...Object.keys(SUBFOLDER), 'demo'].sort())
  for (const [id, files] of Object.entries(SUBFOLDER)) assert.deepEqual(n7[id], [...files].sort(), id)
  assert.equal(Object.keys(n7).length - 1, 12)
})

test('analyzeModule never reads outside the walk (the unreadable data/ does not fail the module)', () => {
  const r = analyzeModule(moduleEntry(path.join(root, 'demo')))
  assert.equal(r.files.source, 7)
  assert.equal(r.files.client, 3)
  assert.deepEqual(r.moduleJson, { name: 'Demo' })
})
