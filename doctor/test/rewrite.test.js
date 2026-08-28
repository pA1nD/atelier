// doctor/test/rewrite.test.js — N1 and N4 byte-exact on fixtures (DESIGN §8).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { rewriteN1, rewriteN4, rewriteBackend, rewriteModule } from '../rules/rewrite.mjs'

// four module-dir identifiers, each defined in a different DIR_DEF form (ROOT/DIR/MODULE_DIR are names the
// corpus uses; only a module-scope definition as the module dir makes them rewritable)
const HEAD = [
  "import path from 'node:path'",
  'const HERE = path.dirname(fileURLToPath(import.meta.url)) // fileURLToPath, not .pathname',
  'const ROOT = __dirname;',
  "const DIR = fileURLToPath(new URL('.', import.meta.url))",
  'const MODULE_DIR = dirname(new URL(import.meta.url).pathname)',
  '',
].join('\n')
const wrap = (body, head = HEAD) => `${head}export default {\n  mountRoutes(router, ctx) {\n${body}\n  }\n}\n`
const L = HEAD.split('\n').length - 1     // lines before `export default`

test('N1: path.join(<X>, \'data\') → ctx.dataDir; with rest args → path.join(ctx.dataDir, rest)', () => {
  const body = [
    "    const A = path.join(__dirname, 'data')",
    "    const B = path.join(HERE, 'data', 'agents.json')",
    "    const C = path.join(MODULE_DIR, \"data\", `signal-${acc.id}`, 'store')",
    "    const D = path.resolve(ROOT, 'data')",
    "    const E = path.join(DIR, 'data/outgoing')",
    "    const F = path.join(dirname(fileURLToPath(import.meta.url)), 'data', x)",
    "    const G = path.join(fileURLToPath(new URL('.', import.meta.url)), 'data')",
    "    const H = path.join(ctx.dataDir, 'x')",
    "    const I = path.join(HERE, 'dataset', 'data')",
    "    const J = path.join(other, 'data')",
  ].join('\n')
  const r = rewriteN1(wrap(body))
  const want = [
    "    const A = ctx.dataDir",
    "    const B = path.join(ctx.dataDir, 'agents.json')",
    "    const C = path.join(ctx.dataDir, `signal-${acc.id}`, 'store')",
    "    const D = ctx.dataDir",
    "    const E = path.join(ctx.dataDir, 'outgoing')",
    "    const F = path.join(ctx.dataDir, x)",
    "    const G = ctx.dataDir",
    "    const H = path.join(ctx.dataDir, 'x')",
    "    const I = path.join(HERE, 'dataset', 'data')",
    "    const J = path.join(other, 'data')",
  ].join('\n')
  assert.equal(r.text, wrap(want))
  assert.deepEqual(r.edits.map((e) => [e.line - L, e.from, e.to]), [
    [3, "path.join(__dirname, 'data')", 'ctx.dataDir'],
    [4, "path.join(HERE, 'data', 'agents.json')", "path.join(ctx.dataDir, 'agents.json')"],
    [5, 'path.join(MODULE_DIR, "data", `signal-${acc.id}`, \'store\')', "path.join(ctx.dataDir, `signal-${acc.id}`, 'store')"],
    [6, "path.resolve(ROOT, 'data')", 'ctx.dataDir'],
    [7, "path.join(DIR, 'data/outgoing')", "path.join(ctx.dataDir, 'outgoing')"],
    [8, "path.join(dirname(fileURLToPath(import.meta.url)), 'data', x)", 'path.join(ctx.dataDir, x)'],
    [9, "path.join(fileURLToPath(new URL('.', import.meta.url)), 'data')", 'ctx.dataDir'],
  ])
  assert.deepEqual(r.skipped, [])
})

test('N1: a dir-looking identifier the file does not define as the module dir is skipped and named (drive\'s ROOT); a dirname() of something else is not a dir', () => {
  const head = "import path from 'node:path'\nimport os from 'node:os'\nconst ROOT = path.join(os.homedir(), 'vault', 'raw', 'docs')\n"
  const src = wrap("    const a = path.join(ROOT, 'data', 'x')\n    const b = `${ROOT}/data/y`\n    const c = path.join(path.dirname(file), 'data')\n    const d = path.join(HERE, 'data')", head)
  const r = rewriteN1(src)
  assert.equal(r.text, src)
  assert.deepEqual(r.skipped.map((s) => [s.line, s.reason]), [
    [6, '`ROOT` is not the module dir here (no module-scope `const ROOT = dirname(fileURLToPath(import.meta.url))`) — rewrite by hand'],
    [9, '`HERE` is not the module dir here (no module-scope `const HERE = dirname(fileURLToPath(import.meta.url))`) — rewrite by hand'],
    [7, '`ROOT` is not the module dir here (no module-scope `const ROOT = dirname(fileURLToPath(import.meta.url))`) — rewrite by hand'],
  ])
  // an identifier the file defines as the module dir under any name is rewritten
  const own = rewriteN1(wrap("    const a = path.join(BASE, 'data')", "const BASE = path.dirname(fileURLToPath(import.meta.url))\n"))
  assert.ok(own.text.includes('const a = ctx.dataDir'))
})

test('N1: a `..` in the tail or the rest resolves back out of data/ — skipped and named, never rewritten', () => {
  const src = wrap([
    '    const a = path.join(__dirname, "data", "..", "secrets.json")',
    '    const b = path.join(HERE, "data/../config")',
    '    const c = path.join(HERE, "data/x/../y")',
    '    const d = `${HERE}/data/../secrets.json`',
    '    const e = path.join(HERE, "data", "..x", "y")',
  ].join('\n'))
  const r = rewriteN1(src)
  assert.deepEqual(r.skipped.map((s) => s.line - L), [3, 4, 5, 6])
  assert.ok(r.skipped.every((s) => /resolves outside data\//.test(s.reason)))
  assert.deepEqual(r.edits.map((e) => [e.line - L, e.to]), [[7, 'path.join(ctx.dataDir, "..x", "y")']])
})

test('N1: template literals `${<X>}/data` and `${<X>}/data/<tail>`', () => {
  const body = [
    '    const A = `${HERE}/data`',
    '    const B = `${__dirname}/data/${name}.json`',
    '    const C = `${HERE}/dataset`',
    '    const D = `file://${HERE}/data`',
  ].join('\n')
  const r = rewriteN1(wrap(body))
  assert.equal(r.text, wrap([
    '    const A = ctx.dataDir',
    '    const B = `${ctx.dataDir}/${name}.json`',
    '    const C = `${HERE}/dataset`',
    '    const D = `file://${HERE}/data`',
  ].join('\n')))
  assert.equal(r.edits.length, 2)
})

test('N1: the renamed ctx parameter is used; outside the span nothing moves', () => {
  const src = "const HERE = __dirname\nconst D = path.join(HERE, 'data')\nexport default {\n  async mountRoutes(r, c) {\n    const x = path.join(HERE, 'data', 'x')\n  }\n}\nfunction later() { return path.join(HERE, 'data') }\n"
  const r = rewriteN1(src)
  assert.equal(r.text, "const HERE = __dirname\nconst D = path.join(HERE, 'data')\nexport default {\n  async mountRoutes(r, c) {\n    const x = path.join(c.dataDir, 'x')\n  }\n}\nfunction later() { return path.join(HERE, 'data') }\n")
  assert.deepEqual(r.edits.map((e) => e.line), [5])
})

test('N1: no ctx parameter → nothing rewritten, skipped names the line; no span → untouched', () => {
  const src = "export default {\n  mountRoutes(router) {\n    const d = path.join(HERE, 'data')\n  }\n}\n"
  const r = rewriteN1(src)
  assert.equal(r.text, src); assert.equal(r.edits.length, 0)
  assert.deepEqual(r.skipped, [{ rule: 'N1', line: 2, reason: 'mountRoutes has no ctx parameter — add `(router, ctx)`' }])
  const none = rewriteN1("const d = path.join(HERE, 'data')\n")
  assert.equal(none.text, "const d = path.join(HERE, 'data')\n"); assert.equal(none.edits.length, 0)
})

test('N1: a match inside a comment or a string is not rewritten', () => {
  const src = wrap("    // was path.join(HERE, 'data')\n    const s = \"path.join(HERE, 'data')\"\n    const d = path.join(HERE, 'data')")
  const r = rewriteN1(src)
  assert.equal(r.edits.length, 1)
  assert.ok(r.text.includes("// was path.join(HERE, 'data')"))
  assert.ok(r.text.includes("const d = ctx.dataDir"))
})

test('N4: template literal substitution, string → template, backtick/${ left alone, outside untouched', () => {
  const src = [
    "const U = '/api/global/x'",
    "export default {",
    "  mountRoutes(router, ctx) {",
    "    fetch(`http://127.0.0.1:${process.env.PORT || 1844}/api/global/jobs/beacon`)",
    "    const a = '/api/global/sites'",
    "    const b = \"/api/global/a\" + \"/api/global/b\"",
    "    const c = 'x`/api/global/y'",
    "    const d = '${/api/global/'",
    "    // see /api/global/docs",
    "  }",
    "}",
  ].join('\n')
  const r = rewriteN4(src)
  assert.equal(r.text, [
    "const U = '/api/global/x'",
    "export default {",
    "  mountRoutes(router, ctx) {",
    "    fetch(`http://127.0.0.1:${process.env.PORT || 1844}/api/${ctx.workspace}/jobs/beacon`)",
    "    const a = `/api/${ctx.workspace}/sites`",
    "    const b = `/api/${ctx.workspace}/a` + `/api/${ctx.workspace}/b`",
    "    const c = 'x`/api/global/y'",
    "    const d = '${/api/global/'",
    "    // see /api/global/docs",
    "  }",
    "}",
  ].join('\n'))
  assert.deepEqual(r.edits.map((e) => [e.line, e.from, e.to]), [
    [4, '/api/global/', '/api/${ctx.workspace}/'],
    [5, "'/api/global/sites'", '`/api/${ctx.workspace}/sites`'],
    [6, '"/api/global/a"', '`/api/${ctx.workspace}/a`'],
    [6, '"/api/global/b"', '`/api/${ctx.workspace}/b`'],
  ])
  assert.deepEqual(r.skipped.map((s) => s.line), [7, 8])
})

test('N4: an object-literal key becomes a computed key (a bare template there is a SyntaxError)', () => {
  const r = rewriteN4("export default { mountRoutes(r, ctx) {\n  const T = { \"/api/global/jobs\": 1, a: 2,\n    '/api/global/x': 3 }\n  const u = cond ? '/api/global/y' : z\n  switch (p) { case '/api/global/c': break }\n} }")
  assert.equal(r.text, "export default { mountRoutes(r, ctx) {\n  const T = { [`/api/${ctx.workspace}/jobs`]: 1, a: 2,\n    [`/api/${ctx.workspace}/x`]: 3 }\n  const u = cond ? `/api/${ctx.workspace}/y` : z\n  switch (p) { case `/api/${ctx.workspace}/c`: break }\n} }")
  assert.doesNotThrow(() => new Function(r.text.replace('export default ', 'const m = ')))
})

test('N4: a template that holds escaped code (a served snippet — user-facing text) is skipped and named, not rewritten', () => {
  const src = [
    'export default {',
    '  mountRoutes(router, ctx) {',
    "    router.get('/snippet', (req, res) => {",
    '      res.json({',
    '        js: `// --- jobs beacon ---',
    'const JOBS = \\`http://127.0.0.1:\\${process.env.PORT || 1844}/api/global/jobs/beacon\\`',
    "beacon({ url: '/api/global/x' })`,",
    '      })',
    '    })',
    "    fetch(`${base}/api/global/jobs/beacon`)",
    '  }',
    '}',
  ].join('\n')
  const r = rewriteN4(src)
  assert.deepEqual(r.skipped, [{ rule: 'N4', line: 6, reason: 'inside a template that holds escaped code — a served snippet, user-facing text; rewrite by hand' }])
  assert.deepEqual(r.edits.map((e) => e.line), [10])
  assert.ok(r.text.includes('const JOBS = \\`http://127.0.0.1:\\${process.env.PORT || 1844}/api/global/jobs/beacon\\`'))
  assert.ok(r.text.includes('fetch(`${base}/api/${ctx.workspace}/jobs/beacon`)'))
})

test('N4: the renamed ctx parameter; a string with two occurrences becomes one template', () => {
  const r = rewriteN4("export default { mountRoutes(r, app) { const s = '/api/global/a/api/global/b' } }")
  assert.equal(r.text, "export default { mountRoutes(r, app) { const s = `/api/${app.workspace}/a/api/${app.workspace}/b` } }")
})

test('rewriteBackend: N1 then N4 on one file, edits in source order, skipped merged', () => {
  const src = wrap("    const d = path.join(HERE, 'data')\n    fetch('/api/global/jobs/beacon')")
  const r = rewriteBackend(src)
  assert.equal(r.text, wrap("    const d = ctx.dataDir\n    fetch(`/api/${ctx.workspace}/jobs/beacon`)"))
  assert.deepEqual(r.edits.map((e) => [e.rule, e.line]), [['N1', L + 3], ['N4', L + 4]])
  assert.deepEqual(r.skipped, [])
})

test('rewriteBackend: a multi-line N1 call that collapses does not shift the N4 line numbers (both read the original)', () => {
  const src = wrap("    const d = path.join(\n      __dirname,\n      'data'\n    )\n    const u = '/api/global/x'")
  const r = rewriteBackend(src)
  assert.equal(r.text, wrap("    const d = ctx.dataDir\n    const u = `/api/${ctx.workspace}/x`"))
  assert.deepEqual(r.edits.map((e) => [e.rule, e.line - L]), [['N1', 3], ['N4', 7]])
  // an N4 hit inside an N1 call's range is named, not edited
  const clash = rewriteBackend(wrap("    const p = path.join(HERE, 'data', '/api/global/x')"))
  assert.equal(clash.text, wrap("    const p = path.join(ctx.dataDir, '/api/global/x')"))
  assert.deepEqual(clash.skipped.map((s) => [s.rule, s.line - L]), [['N4', 3]])
})

test('rewriteModule: a folder whose other files keep a self-pathed data/ marks the rewrite partial with the leftover file:lines', async (t) => {
  const dir = fs.mkdtempSync('/tmp/doctor-rw-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'backend.js'), wrap("    const a = path.join(HERE, 'data', 'x')\n    const b = fs.readFileSync(path.join(HERE, 'data', 'y'))") + "const late = path.join(HERE, 'data')\n")
  fs.writeFileSync(path.join(dir, 'signal-bridge.js'), "const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))\nconst DATA_DIR = path.join(MODULE_DIR, 'data')\n")
  fs.writeFileSync(path.join(dir, 'frontend.jsx'), "export const meta = { name: 'x' }\n")
  const out = await rewriteModule({ dir })
  assert.deepEqual(out.map((r) => r.file), ['backend.js'])
  assert.equal(out[0].edits.length, 2)
  assert.equal(out[0].partial, true)
  assert.deepEqual(out[0].leftover, [`backend.js:${L + 7}`, 'signal-bridge.js:2'])
  fs.writeFileSync(path.join(dir, 'signal-bridge.js'), "export const x = 1\n")
  fs.writeFileSync(path.join(dir, 'backend.js'), wrap("    const a = path.join(HERE, 'data', 'x')"))
  const whole = await rewriteModule({ dir })
  assert.equal(whole[0].partial, false); assert.deepEqual(whole[0].leftover, [])
})

test('rewrite: a file without hits is returned byte-equal', () => {
  const src = wrap("    router.get('/', (req, res) => res.end('ok'))")
  assert.equal(rewriteBackend(src).text, src)
})
