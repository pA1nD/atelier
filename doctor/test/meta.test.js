// doctor/test/meta.test.js — literal meta → module.json byte-exact; computed → {error} + degrades;
// dropped keys with their rule; an existing module.json with `visibility` → N11 (DESIGN §8).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { extractMetaStatically, metaOf, moduleJsonOf, serializeModuleJson, checkExistingModuleJson, readMeta } from '../rules/meta.mjs'
import { META_KEYS } from '../rules/catalogue.mjs'

const SEED = '/Users/pa1nd/pro/001-atelier/design/atelier2/r2/spike-migration-local-1/out/module.json'

test('extractMetaStatically: the 1.x reader — inline, multi-line, strings with braces, no meta', () => {
  assert.deepEqual(extractMetaStatically("export const meta = { name: 'A', icon: '}' }\n").meta, { name: 'A', icon: '}' })
  assert.deepEqual(extractMetaStatically("export const meta = {\n  name: \"B\",\n  group: 'dev', // trailing\n  primary: true,\n}\n").meta, { name: 'B', group: 'dev', primary: true })
  assert.deepEqual(extractMetaStatically("export default () => null").meta, {})
  assert.deepEqual(extractMetaStatically("export const meta = { name: `x`, color: '#fff', nested: { a: 1 } }").meta, { name: 'x', color: '#fff', nested: { a: 1 } })
})

test('metaOf: declared / literal / computed with the symbol in the error', () => {
  const lit = metaOf("import x from 'y'\nexport const meta = { name: 'A' }\n")
  assert.deepEqual([lit.declared, lit.literal, lit.computed, lit.line], [true, true, false, 2])
  const comp = metaOf("const N = 'A'\nexport const meta = { name: N }\n")
  assert.deepEqual([comp.declared, comp.literal, comp.computed], [true, false, true])
  assert.match(comp.error, /N is not defined/)
  const none = metaOf("export default () => null\n")
  assert.deepEqual([none.declared, none.literal, none.computed], [false, false, false])
})

test('moduleJsonOf: the five keys in order, every other key dropped with its rule', () => {
  const { json, dropped } = moduleJsonOf({ chrome: 'catalyst-chrome', color: '#123456', hidden: true, name: 'Jobs', eager: true, visibility: 'chat', isChrome: false, icon: 'timer', primary: true, group: 'dev' })
  assert.deepEqual(Object.keys(json), META_KEYS)
  assert.deepEqual(json, { name: 'Jobs', icon: 'timer', group: 'dev', primary: true, color: '#123456' })
  assert.deepEqual(dropped.map((d) => [d.key, d.rule]), [['chrome', 'D5'], ['hidden', 'N10'], ['eager', 'I3'], ['visibility', 'N11'], ['isChrome', 'N10']])
  assert.ok(dropped.every((d) => typeof d.reason === 'string' && d.reason.length > 10))
  assert.deepEqual(moduleJsonOf({ name: 'x' }), { json: { name: 'x' }, dropped: [] })
})

test('serializeModuleJson: 2-space JSON + newline, byte-exact', () => {
  assert.equal(serializeModuleJson({ name: 'Jobs', icon: 'timer' }), '{\n  "name": "Jobs",\n  "icon": "timer"\n}\n')
})

test('module.json from the literal meta equals the seed\'s output minus its "visibility" line', { skip: !fs.existsSync(SEED) && 'seed output not on this machine' }, () => {
  const corpus = '/Users/pa1nd/pro/003-atelier-modules'
  let checked = 0
  for (const id of fs.readdirSync(SEED)) {
    const src = path.join(corpus, id, 'frontend.jsx')
    if (!fs.existsSync(src)) continue
    const seed = fs.readFileSync(path.join(SEED, id, 'module.json'), 'utf8').replace(/,\n  "visibility": "chat"\n\}/, '\n}').replace(/^\{\n  "visibility": "chat"\n\}/, '{}')
    const m = metaOf(fs.readFileSync(src, 'utf8'))
    assert.ok(m.literal, `${id}: not literal`)
    assert.equal(serializeModuleJson(moduleJsonOf(m.meta).json), seed, id)
    checked++
  }
  assert.ok(checked >= 50, `checked ${checked}`)
})

// a fake fs for the host's validator (discovery.mjs takes any {readFileSync, existsSync, readdirSync})
const fakeFs = (files) => ({
  existsSync: (p) => p in files,
  readFileSync: (p) => { if (!(p in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e } return files[p] },
  readdirSync: () => [],
})

test('checkExistingModuleJson: absent / visibility dropped / invalid JSON with line:col / missing name', () => {
  assert.deepEqual(checkExistingModuleJson('/app', fakeFs({})), { present: false })
  const vis = checkExistingModuleJson('/app', fakeFs({ '/app/module.json': '{"name": "x", "icon": "y", "visibility": "chat"}' }))
  assert.equal(vis.ok, true); assert.deepEqual(vis.dropped, ['visibility']); assert.deepEqual(vis.meta, { name: 'x', icon: 'y' })
  const bad = checkExistingModuleJson('/app', fakeFs({ '/app/module.json': '{\n  "name": "x",\n}' }))
  assert.equal(bad.ok, false); assert.equal(bad.error.file, 'module.json'); assert.ok(bad.error.line >= 1)
  const noName = checkExistingModuleJson('/app', fakeFs({ '/app/module.json': '{"icon": "y"}' }))
  assert.equal(noName.ok, false); assert.match(noName.error.message, /name/)
})

test('readMeta({dir}): lane C\'s entry — frontend.jsx + the existing module.json', async () => {
  const files = { '/app/frontend.jsx': "export const meta = { name: 'A', chrome: 'catalyst-chrome' }\n", '/app/module.json': '{"name": "A", "visibility": "chat"}' }
  const r = await readMeta({ dir: '/app', fs: fakeFs(files) })
  assert.equal(r.literal, true); assert.deepEqual(r.moduleJson, { name: 'A' }); assert.deepEqual(r.dropped.map((d) => d.rule), ['D5'])
  assert.deepEqual(r.existing.dropped, ['visibility'])
  const none = await readMeta({ dir: '/nope', fs: fakeFs({}) })
  assert.equal(none.declared, false); assert.equal(none.moduleJson, null); assert.equal(none.existing.present, false)
})
