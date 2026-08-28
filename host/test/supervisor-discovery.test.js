// supervisor/discovery.mjs — module.json rule, slug refusals, ignored names, CLAIM-REFUSED skip,
// meta allowlist, module.json classification (DESIGN §6.1, §6.3, §8.1).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discover, checkModuleJson, IGNORED_NAME_RE } from '../supervisor/discovery.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sup-disc-'))
const app = (root, name, files) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c); return d }

test('a folder is an app iff module.json parses; ignored names; CLAIM-REFUSED skip; bad slug refused', () => {
  const root = tmp()
  app(root, 'weather', { 'module.json': '{"name":"Weather","icon":"cloud","visibility":"everyone","primary":true,"trusted":1}', 'frontend.jsx': '' })
  app(root, 'nojson', { 'frontend.jsx': '' })
  app(root, '_private', { 'module.json': '{"name":"x"}' })
  app(root, '.hidden', { 'module.json': '{"name":"x"}' })
  app(root, '-dash', { 'module.json': '{"name":"x"}' })
  app(root, ' space', { 'module.json': '{"name":"x"}' })
  app(root, 'refused', { 'module.json': '{"name":"x"}', 'CLAIM-REFUSED.txt': 'taken' })
  app(root, 'Bad_Slug', { 'module.json': '{"name":"x"}' })
  app(root, 'trailing-', { 'module.json': '{"name":"x"}' })
  fs.writeFileSync(path.join(root, 'file.txt'), 'not a dir')
  const d = discover(root)
  assert.deepEqual(d.apps.map((a) => a.slug), ['weather'])
  const w = d.apps[0]
  assert.deepEqual(w.meta, { name: 'Weather', icon: 'cloud' })          // META_KEEP only
  assert.deepEqual(w.requested, { primary: true })                         // primary = a request
  assert.deepEqual(w.dropped.sort(), ['trusted', 'visibility'])            // dropped silently (OR20)
  assert.deepEqual(d.refused.map((r) => [r.slug, r.code]), [['Bad_Slug', 'bad-slug'], ['trailing-', 'bad-slug']])
  const skipped = Object.fromEntries(d.skipped.map((s) => [s.name, s.reason]))
  assert.deepEqual(skipped, { nojson: 'no-module-json', _private: 'ignored-name', '.hidden': 'ignored-name', '-dash': 'ignored-name', ' space': 'ignored-name', refused: 'claim-refused', 'file.txt': 'not-a-dir' })
  assert.equal(d.problems.length, 0)
  fs.rmSync(root, { recursive: true, force: true })
})

test('module.json classification: missing / invalid JSON / no name → file:line:col + hint', () => {
  const root = tmp()
  const a = app(root, 'alpha', {})
  let c = checkModuleJson(a)
  assert.equal(c.ok, false)
  assert.equal(c.error.file, 'module.json')
  assert.match(c.error.message, /module\.json missing/)
  assert.match(c.error.hint, /write .*module\.json with/)
  fs.writeFileSync(path.join(a, 'module.json'), '{\n  "name": "Alpha",\n  "icon": cloud\n}')
  c = checkModuleJson(a)
  assert.equal(c.ok, false)
  assert.match(c.error.message, /^invalid JSON:/)
  assert.equal(c.error.line, 3)
  assert.ok(c.error.col >= 1)
  assert.equal(c.error.hint, 'fix the JSON (quotes, commas, braces)')
  fs.writeFileSync(path.join(a, 'module.json'), '{\n  "icon": "cloud",\n  "name": ""\n}')
  c = checkModuleJson(a)
  assert.equal(c.ok, false)
  assert.deepEqual([c.error.line, c.error.col], [3, 3])
  assert.match(c.error.message, /missing or invalid "name"/)
  fs.writeFileSync(path.join(a, 'module.json'), '[1]')
  assert.match(checkModuleJson(a).error.message, /must be a JSON object/)
  fs.writeFileSync(path.join(a, 'module.json'), '{"name":"Alpha","color":"#12"}')
  c = checkModuleJson(a)
  assert.equal(c.ok, true)
  assert.deepEqual(c.meta, { name: 'Alpha' })
  assert.deepEqual(c.invalid, ['color'])
  // a problem (present but invalid) is reported by discover() separately from refusals
  fs.writeFileSync(path.join(a, 'module.json'), '{')
  const d = discover(root)
  assert.equal(d.apps.length, 0)
  assert.equal(d.problems[0].slug, 'alpha')
  assert.match(d.problems[0].error.message, /invalid JSON/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('discover() is pure over a node-fs-shaped fake', () => {
  const fake = {
    readdirSync: (p) => (p === '/apps' ? [{ name: 'a', isDirectory: () => true }, { name: 'b', isDirectory: () => true }] : []),
    existsSync: (p) => p === '/apps/a/module.json' || p === '/apps/b/module.json' || p === '/apps/b/CLAIM-REFUSED.txt',
    readFileSync: (p) => (p === '/apps/a/module.json' ? '{"name":"A"}' : (() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })()),
  }
  const d = discover('/apps', fake)
  assert.deepEqual(d.apps.map((a) => a.slug), ['a'])
  assert.deepEqual(d.skipped, [{ name: 'b', dir: '/apps/b', reason: 'claim-refused' }])
  assert.deepEqual(discover('/missing', fake), { apps: [], refused: [], skipped: [], problems: [] })
  assert.equal(IGNORED_NAME_RE.test('ok-name'), false)
})
