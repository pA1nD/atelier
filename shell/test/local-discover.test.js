// shell/local/discover.mjs + meta.mjs — 1.x discovery rules over a fixture instance, the config
// filter and path entries, slug refusals, the chrome election, module.json generation (DESIGN §5.3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discover, electChrome, ensureModuleJson, moduleJsonFromMeta, notASlug } from '../local/discover.mjs'
import { extractMetaStatically } from '../local/meta.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shell-disc-'))
const mod = (root, rel, files) => { const d = path.join(root, rel); fs.mkdirSync(d, { recursive: true }); for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c); return d }
const front = (meta) => `export const meta = ${meta}\nexport default function M() { return null }\n`

test('extractMetaStatically: a literal reads without executing; a computed meta is {} with the symbol named', () => {
  assert.deepEqual(extractMetaStatically(front(`{ name: 'A', icon: "x}y", group: \`g{\` }`)).meta, { name: 'A', icon: 'x}y', group: 'g{' })
  assert.deepEqual(extractMetaStatically('export default 1').meta, {})
  const r = extractMetaStatically('const IQ = 1\nexport const meta = { name: `${IQ}` }')
  assert.deepEqual(r.meta, {})
  assert.match(r.error, /IQ/)
})

test('discover: global + $ws modules, _skip, reserved, the config deny + path entry, slug refusals, chrome election', () => {
  const root = tmp()
  mod(root, 'alpha', { 'frontend.jsx': front(`{ name: 'Alpha', icon: 'sparkles', group: 'g', primary: true, chrome: 'zchrome', hidden: false }`), 'backend.js': 'export default {}' })
  mod(root, 'onlyback', { 'backend.js': 'export default {}' })
  mod(root, 'scratch', { 'frontend.jsx': front('{}') })
  mod(root, '_archive', { 'frontend.jsx': front('{}') })
  mod(root, 'assets', { 'frontend.jsx': front('{}') })                    // reserved name
  mod(root, 'My_App', { 'frontend.jsx': front('{}') })                    // not a slug
  mod(root, 'notamodule', { 'readme.md': '' })
  mod(root, '$team/beta', { 'frontend.jsx': front(`{ name: 'Beta' }`) })
  mod(root, '$BigCorp/gamma', { 'frontend.jsx': front('{}') })          // workspace not a slug
  mod(root, 'zchrome', { 'frontend.jsx': front(`{ isChrome: true, hidden: true, name: 'zchrome' }`), 'styles.css': '' })
  mod(root, 'achrome', { 'frontend.jsx': front(`{ isChrome: true, name: 'achrome' }`) })
  const ext = mod(fs.mkdtempSync(path.join(os.tmpdir(), 'shell-ext-')), 'external', { 'frontend.jsx': front(`{ name: 'Ext' }`) })
  fs.writeFileSync(path.join(root, 'atelier.config.json'), JSON.stringify({ modules: ['!scratch', { path: ext, id: 'ext' }] }))
  const log = []
  const d = discover(root, { log: (l) => log.push(l) })
  assert.deepEqual(d.modules.map((m) => m.qid), ['global/achrome', 'global/alpha', 'global/onlyback', 'global/zchrome', 'team/beta', 'global/ext'])
  assert.deepEqual(d.refused.map((r) => [r.qid, r.reason]), [['BigCorp/gamma', notASlug('$BigCorp')], ['global/My_App', notASlug('My_App')]])
  const alpha = d.modules.find((m) => m.qid === 'global/alpha')
  assert.deepEqual(alpha.meta, { name: 'Alpha', icon: 'sparkles', group: 'g', primary: true, chrome: 'zchrome', hidden: false })
  assert.equal(alpha.hasBackend, true); assert.equal(alpha.isChrome, false)
  assert.deepEqual(d.modules.find((m) => m.qid === 'global/onlyback').meta, {})
  assert.equal(d.chrome.qid, 'global/achrome')                            // alphabetical among isChrome globals
  assert.equal(electChrome(d.modules, 'zchrome').qid, 'global/zchrome')   // the setting by basename
  assert.equal(electChrome(d.modules, './chromes/zchrome').qid, 'global/zchrome')
  assert.equal(electChrome(d.modules, 'nope', (l) => log.push(l)).qid, 'global/achrome')
  assert.ok(log.some((l) => /defaultChrome 'nope' is not a mounted chrome/.test(l)))
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(path.dirname(ext), { recursive: true, force: true })
})

test('module.json: generated once from the literal meta (META_ALLOW keys, name defaults to the folder), never rewritten when present', () => {
  const root = tmp()
  const a = mod(root, 'alpha', { 'frontend.jsx': front(`{ icon: 'sparkles', group: 'g', primary: true, color: '#abc', chrome: 'x', isChrome: false, hidden: true }`) })
  const b = mod(root, 'beta', { 'frontend.jsx': front(`{ name: 'Beta' }`), 'module.json': '{"name":"Kept","icon":"k"}' })
  const c = mod(root, 'onlyback', { 'backend.js': '' })
  const { modules } = discover(root)
  const log = []
  const ra = ensureModuleJson(modules.find((m) => m.id === 'alpha'), { log: (l) => log.push(l) })
  assert.equal(ra.wrote, true)
  assert.deepEqual(ra.json, { icon: 'sparkles', group: 'g', primary: true, color: '#abc', name: 'alpha' })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a, 'module.json'), 'utf8')), ra.json)
  assert.equal(fs.statSync(path.join(a, 'module.json')).mode & 0o777, 0o644)
  assert.deepEqual(log, [`wrote ${path.join(a, 'module.json')} from the literal meta`])
  const rb = ensureModuleJson(modules.find((m) => m.id === 'beta'), { log: (l) => log.push(l) })
  assert.equal(rb.wrote, false)
  assert.deepEqual(rb.json, { name: 'Kept', icon: 'k' })
  assert.equal(fs.readFileSync(path.join(b, 'module.json'), 'utf8'), '{"name":"Kept","icon":"k"}')
  assert.deepEqual(ensureModuleJson(modules.find((m) => m.id === 'onlyback')).json, { name: 'onlyback' })
  assert.ok(fs.existsSync(path.join(c, 'module.json')))
  assert.deepEqual(moduleJsonFromMeta({ id: 'x', meta: { name: '  ' } }), { name: 'x' })
  fs.rmSync(root, { recursive: true, force: true })
})
