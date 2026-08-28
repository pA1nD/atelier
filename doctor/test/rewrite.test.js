// doctor/test/rewrite.test.js — N1 and N4 byte-exact on fixtures (DESIGN §8).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rewriteN1, rewriteN4, rewriteBackend } from '../rules/rewrite.mjs'

const wrap = (body, head = "import path from 'node:path'\nconst HERE = path.dirname(fileURLToPath(import.meta.url))\n") =>
  `${head}export default {\n  mountRoutes(router, ctx) {\n${body}\n  }\n}\n`

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
  assert.deepEqual(r.edits.map((e) => [e.line, e.from, e.to]), [
    [5, "path.join(__dirname, 'data')", 'ctx.dataDir'],
    [6, "path.join(HERE, 'data', 'agents.json')", "path.join(ctx.dataDir, 'agents.json')"],
    [7, 'path.join(MODULE_DIR, "data", `signal-${acc.id}`, \'store\')', "path.join(ctx.dataDir, `signal-${acc.id}`, 'store')"],
    [8, "path.resolve(ROOT, 'data')", 'ctx.dataDir'],
    [9, "path.join(DIR, 'data/outgoing')", "path.join(ctx.dataDir, 'outgoing')"],
    [10, "path.join(dirname(fileURLToPath(import.meta.url)), 'data', x)", 'path.join(ctx.dataDir, x)'],
    [11, "path.join(fileURLToPath(new URL('.', import.meta.url)), 'data')", 'ctx.dataDir'],
  ])
  assert.deepEqual(r.skipped, [])
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
  const src = "const D = path.join(HERE, 'data')\nexport default {\n  async mountRoutes(r, c) {\n    const x = path.join(HERE, 'data', 'x')\n  }\n}\nfunction later() { return path.join(HERE, 'data') }\n"
  const r = rewriteN1(src)
  assert.equal(r.text, "const D = path.join(HERE, 'data')\nexport default {\n  async mountRoutes(r, c) {\n    const x = path.join(c.dataDir, 'x')\n  }\n}\nfunction later() { return path.join(HERE, 'data') }\n")
  assert.deepEqual(r.edits.map((e) => e.line), [4])
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

test('N4: the renamed ctx parameter; a string with two occurrences becomes one template', () => {
  const r = rewriteN4("export default { mountRoutes(r, app) { const s = '/api/global/a/api/global/b' } }")
  assert.equal(r.text, "export default { mountRoutes(r, app) { const s = `/api/${app.workspace}/a/api/${app.workspace}/b` } }")
})

test('rewriteBackend: N1 then N4 on one file, edits in source order, skipped merged', () => {
  const src = wrap("    const d = path.join(HERE, 'data')\n    fetch('/api/global/jobs/beacon')")
  const r = rewriteBackend(src)
  assert.equal(r.text, wrap("    const d = ctx.dataDir\n    fetch(`/api/${ctx.workspace}/jobs/beacon`)"))
  assert.deepEqual(r.edits.map((e) => [e.rule, e.line]), [['N1', 5], ['N4', 6]])
  assert.deepEqual(r.skipped, [])
})

test('rewrite: a file without hits is returned byte-equal', () => {
  const src = wrap("    router.get('/', (req, res) => res.end('ok'))")
  assert.equal(rewriteBackend(src).text, src)
})
