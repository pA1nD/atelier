import test from 'node:test'
import assert from 'node:assert/strict'
import { allowMeta, authorizeWrite, reclaimRule, SLUG_RE, META_KEEP, META_REQUEST, META_ALLOW, BODY_KEYS, RESERVED_COMPANY_IDS, isReservedCompany, TOMBSTONE_MS } from '../registry.js'
import vectors from '../vectors/registry.json' with { type: 'json' }

const fns = { allowMeta, authorizeWrite, reclaimRule }
for (const c of vectors.cases) {
  test(`vector: ${c.name}`, () => { assert.deepEqual(fns[c.fn](c.input), c.expect) })
}

test('the split: META_KEEP ∪ META_REQUEST = META_ALLOW = OR12\'s module.json keys minus visibility (OR20)', () => {
  assert.deepEqual([...META_KEEP, ...META_REQUEST].sort(), [...META_ALLOW].sort())
  assert.deepEqual([...META_ALLOW].sort(), ['color', 'group', 'icon', 'name', 'primary'])
  assert.ok(!META_ALLOW.includes('visibility') && !BODY_KEYS.includes('visibility'), 'OR20: no visibility anywhere in the v1 contract')
  assert.equal(TOMBSTONE_MS, 24 * 3600 * 1000)
})

test('slug and reserved ids (§2: one DNS label, no leading/trailing -, the reserved list verbatim)', () => {
  for (const ok of ['a', 'todo', 'todo-2', 'a'.repeat(32), 'a'.repeat(31) + 'z', 'a-' + 'b'.repeat(30)]) assert.ok(SLUG_RE.test(ok), ok)
  for (const bad of ['', 'Todo', '-todo', 'todo-', 'a-', '1todo', 'a'.repeat(33), 'to do', 'todo_2']) assert.ok(!SLUG_RE.test(bad), bad)
  assert.deepEqual(RESERVED_COMPANY_IDS, ['api', 'assets', 'modules', 'global', 'atelier', 'portal', 'apps', 'www', 'go'])
  for (const id of RESERVED_COMPANY_IDS) assert.ok(isReservedCompany(id), id)
  assert.ok(isReservedCompany('p-anything') && !isReservedCompany('acme') && !isReservedCompany('shell'))
})

test('chrome releases (step 7 ship C, decision 3): DIGEST_RE, the manifest lines, the digest over the sorted lines, the required files, the path rule', async () => {
  const { DIGEST_RE, CHROME_REQUIRED_FILES, CHROME_PATH_RE, validChromePath, chromeManifestLines, chromeDigestOf, sha256Hex } = await import('../registry.js')
  assert.ok(DIGEST_RE.test('a'.repeat(64))); assert.ok(!DIGEST_RE.test('A'.repeat(64))); assert.ok(!DIGEST_RE.test('a'.repeat(63))); assert.ok(!DIGEST_RE.test('sha256:' + 'a'.repeat(57)))
  assert.deepEqual(CHROME_REQUIRED_FILES, ['frontend.js', 'kit.js', 'styles.css', 'chrome.css'])
  assert.equal(chromeManifestLines({ 'kit.js': '2', 'chrome.css': '1', 'fonts/a.woff2': '3' }), 'chrome.css\n1\nfonts/a.woff2\n3\nkit.js\n2\n')
  assert.equal(chromeDigestOf({ b: '2', a: '1' }), sha256Hex('a\n1\nb\n2\n'))
  assert.equal(chromeDigestOf({ a: '1', b: '2' }), chromeDigestOf({ b: '2', a: '1' }), 'order-free')
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  for (const ok of ['frontend.js', 'fonts/Inter.woff2', 'a/b/c.png', 'X.JS']) assert.ok(validChromePath(ok) && CHROME_PATH_RE.test(ok), ok)
  for (const bad of ['manifest.json', '../x.js', 'a/../b.js', '/abs.js', 'a/b/c/d.js', '', 'a//b.js', '.hidden', 'a b.js']) assert.ok(!validChromePath(bad), bad)
})
