// doctor/test/rules.test.js — every catalogue id: one positive and one negative snippet, the cell count,
// the scope variants for N1/N4 (DESIGN §8). Lane A only: no process, no network, no fs beyond fixtures.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RULES, RULE_BY_ID, SEED_IDS, NEW_IDS, IMAGE_BINS } from '../rules/catalogue.mjs'
import { detectInText, analyzeFiles, cellsOf } from '../rules/static.mjs'
import { scan, findMountRoutes, CODE, STRING, COMMENT, REGEX, TEMPLATE } from '../rules/scope.mjs'

const be = (body, extra = '') => `import path from 'node:path'\n${extra}\nexport default {\n  mountRoutes(router, ctx) {\n${body}\n  }\n}\n`
const rules = (text, rule, opts = {}) => detectInText(text, { rule, ...opts })
const ids = (fs) => fs.map((f) => f.rule)

test('catalogue: every rule has the DESIGN shape and a unique id', () => {
  const seen = new Set()
  for (const r of RULES) {
    assert.ok(!seen.has(r.id), `duplicate ${r.id}`); seen.add(r.id)
    assert.ok(['§4.8', 'NEW', 'info', 'mobile', 'runtime'].includes(r.family), r.id)
    assert.ok(['breaks-in-fleet', 'degrades', 'note'].includes(r.severity), r.id)
    assert.equal(typeof r.count, 'function', r.id)
    assert.equal(typeof r.answer, 'string', r.id)
    assert.ok('rewrite' in r && 'evidence' in r && 'plan' in r && 'title' in r, r.id)
  }
  for (const id of [...SEED_IDS, ...NEW_IDS]) assert.ok(RULE_BY_ID[id], `missing ${id}`)
})

// ---- regex rules: positive + negative per id ----------------------------------------------------
const CASES = [
  ['D1', 'backend', "export default { authenticate(req) { return null }, mountRoutes(r, ctx) {} }", "const ok = auth(req)"],
  ['D2', 'backend', be("const s = http.createServer(h); s.listen(7475, '0.0.0.0')"), be("router.get('/', h)")],
  ['D2w', 'backend', "import { WebSocketServer } from 'ws'", "import http from 'node:http'"],
  ['D3', 'backend', "const other = ctx.module('jobs')", "const me = ctx.module('app'); const me2 = ctx.module(ctx.id)"],
  ['D4', 'backend', "if (req.user.workspaces.includes('x')) {}", "const id = req.user.id"],
  ['D6', 'backend', "const u = `http://${ctx.host}:${ctx.port}/x`", "const u = ctx.baseUrl"],
  ['D7', 'backend', "ctx.broadcast({ type: 'changed' })", "broadcast({ type: 'changed' })"],
  ['D8', 'backend', "// run `atelier publish demo` first", "// run npm publish"],
  ['D9', 'backend', "const t = req.headers.authorization", "const u = req.user"],
  ['D10', 'backend', "res.writeHead(302, { Location: '/login' })", "res.writeHead(302, { Location: '/api/x' })"],
  ['D11', 'backend', "req.on('close', () => abort())", "res.on('close', () => abort())"],
  ['D12', 'backend', "execFile('ffmpeg', ['-i', f])", "db.exec('PRAGMA journal_mode = WAL')"],
  ['D13', 'backend', "const p = '/Users/pa1nd/x'", "const p = '/tmp/x'"],
  ['N1', 'backend', be("const d = path.join(__dirname, 'data')"), be("const d = ctx.dataDir")],
  ['N2', 'backend', "const p = process.env.SPACES_PORT || 7402", "const e = process.env.NODE_ENV; const port = process.env.PORT"],
  ['N3', 'backend', "const b = process.env.BASE_URL", "const p = process.env.SPACES_PORT"],
  ['N4', 'backend', be("fetch(`${base}/api/global/jobs/beacon`)"), be("fetch(`/api/${ctx.workspace}/jobs`)")],
  ['N5', 'backend', "fetch('http://localhost:7402/x')", "fetch('https://example.com/x')"],
  ['N6', 'backend', "fetch('/_atelier/inflight'); const r = process.env.ATELIER_ROOT", "fetch('/_atelier/health'); fetch('/_atelier/report')"],
  ['N8', 'backend', "process.on('SIGTERM', stop); process.exit(0)", "process.on('exit', stop)"],
  ['N9', 'backend', "const db = new DatabaseSync(p)", "const db = new DatabaseSync(p, { timeout: 5000 })"],
  ['I1', 'backend', "import { x } from './lib/x.js'", "import fs from 'node:fs'"],
  ['I3', 'frontend', "export const meta = { name: 'x', eager: true }", "export const meta = { name: 'x' }"],
  ['I4', 'frontend', "import { self } from '@atelier/kit'", "import React from 'react'"],
  ['I5', 'frontend', "const r = useRoute()", "const r = useRouter()"],
  ['M1', 'frontend', "<div style={{ height: '100vh' }} />", "<div style={{ height: '100dvh' }} />"],
  ['M2', 'frontend', "<div className=\"h-screen\" />", "<div className=\"h-dvh\" />"],
  ['M3', 'frontend', "<div className=\"fixed bottom-0 inset-x-0\" />", "<div className=\"sticky bottom-0\" />"],
  ['M4', 'frontend', "<input className=\"text-sm\" />", "<input className=\"text-base\" />"],
]
for (const [id, kind, pos, neg] of CASES) {
  test(`${id}: positive and negative snippet`, () => {
    const p = rules(pos, id, { kind })
    assert.ok(p.length >= 1, `${id} positive: no finding`)
    assert.equal(p[0].rule, id)
    assert.ok(p[0].line >= 1 && p[0].col >= 1 && typeof p[0].evidence === 'string' && p[0].answer.length > 10)
    assert.equal(rules(neg, id, { kind }).length, 0, `${id} negative: ${JSON.stringify(rules(neg, id, { kind }))}`)
  })
}

test('N2op: only with the operator key names; N2 does not claim them', () => {
  const src = "const t = process.env.CF_API_TOKEN; const p = process.env.SPACES_PORT"
  const op = new Set(['CF_API_TOKEN'])
  assert.deepEqual(rules(src, 'N2op', { operatorKeys: op }).map((f) => f.key), ['CF_API_TOKEN'])
  assert.deepEqual(rules(src, 'N2', { operatorKeys: op }).map((f) => f.key), ['SPACES_PORT'])
  assert.equal(rules(src, 'N2op').length, 0)
  assert.deepEqual(rules(src, 'N2').map((f) => f.key).sort(), ['CF_API_TOKEN', 'SPACES_PORT'])
})

test('D6: a bind of ctx.host/ctx.port is breaks-in-fleet, a URL composition degrades', () => {
  const bind = rules("server.listen(ctx.port, ctx.host)", 'D6')
  assert.equal(bind.length, 2)
  assert.ok(bind.every((f) => f.severity === 'breaks-in-fleet'))
  assert.equal(rules("const u = `${ctx.host}:${ctx.port}`", 'D6')[0].severity, 'degrades')
})

test('D7: a passed topic degrades, a plain event is a note', () => {
  assert.equal(rules("ctx.broadcast({ type: 'x' })", 'D7')[0].severity, 'note')
  const f = rules("ctx.broadcast({\n  topic: 'a/b',\n  type: 'x' })", 'D7')[0]
  assert.equal(f.severity, 'degrades')
  assert.match(f.answer, /topic/)
})

test('D12: image binaries are notes, SQL verbs are skipped, laptop binaries break', () => {
  assert.equal(rules("spawn('node', ['x.js'])", 'D12')[0].severity, 'note')
  assert.equal(rules("exec('SELECT 1')", 'D12').length, 0)
  const f = rules("spawn('signal-cli', ['daemon'])", 'D12')[0]
  assert.equal(f.severity, 'breaks-in-fleet'); assert.match(f.answer, /signal-cli/)
  assert.ok(IMAGE_BINS.has('git') && !IMAGE_BINS.has('ffmpeg'))
})

test('D13: HOME reads and os.homedir() degrade, /Users breaks', () => {
  assert.equal(rules("process.env.HOME", 'D13')[0].severity, 'degrades')
  assert.equal(rules("os.homedir()", 'D13')[0].severity, 'degrades')
  assert.equal(rules("'/Volumes/x'", 'D13')[0].severity, 'breaks-in-fleet')
  assert.equal(rules("process.env.PATH", 'D13').length, 0)
})

test('D2: the answer carries the plan sentence and the equivalent chosen by what the module does', () => {
  const f = rules(be("s.listen(7475, '0.0.0.0')"), 'D2')[0]
  assert.match(f.answer, /expects an operator reverse proxy that the fleet does not have — here is the first-class equivalent/)
  assert.match(f.answer, /7475/)
  const ws = rules("import { WebSocketServer } from 'ws'\nexport default { mountRoutes(r, ctx) { wss.listen(9000) } }", 'D2')[0]
  assert.match(ws.answer, /WebSocket is the 2.1 upgrade lane/)
  const sse = rules("export default { mountRoutes(r, ctx) { res.setHeader('content-type', 'text/event-stream'); s.listen(9001) } }", 'D2')[0]
  assert.match(sse.answer, /streamed HTTP/)
})

test('N6: the host\'s own /_atelier/health and /_atelier/report are not shell internals', () => {
  assert.equal(rules("fetch('/_atelier/health')", 'N6').length, 0)
  assert.equal(rules("fetch('/_atelier/inflight')", 'N6').length, 1)
  assert.match(rules("readFileSync('atelier.config.json')", 'N6')[0].answer, /atelier\.config\.json/)
})

test('N9: a file that sets a busy timeout anywhere is not flagged', () => {
  assert.equal(rules("const db = new DatabaseSync(p)\ndb.exec('PRAGMA busy_timeout = 5000')", 'N9').length, 0)
  assert.equal(rules("const db = require('better-sqlite3')(p)", 'N9').length, 1)
})

// ---- scope: inside vs outside mountRoutes, renamed ctx -------------------------------------------
test('N1: inside the span → mechanical (rewrite.to); outside → hoist; frontend → degrades', () => {
  const inside = rules(be("const d = path.join(HERE, 'data', 'x.json')"), 'N1')
  assert.equal(inside.length, 1)
  assert.equal(inside[0].scope, 'mountRoutes')
  assert.match(inside[0].answer, /mechanical rewrite/)
  const outside = rules("const HERE = 'x'\nconst D = path.join(HERE, 'data')\nexport default { mountRoutes(router, ctx) {} }", 'N1')
  assert.equal(outside.length, 1)
  assert.equal(outside[0].scope, 'outside-mountRoutes')
  assert.match(outside[0].answer, /hoist into `mountRoutes`/)
  const noSpan = rules("const D = path.join(HERE, 'data')", 'N1')
  assert.equal(noSpan[0].scope, 'outside-mountRoutes')
  const fe = rules("fetch('./data/x.json')", 'N1', { kind: 'frontend' })
  assert.equal(fe[0].severity, 'degrades')
})

test('N1/N4: a renamed ctx parameter is honoured by the span', () => {
  const src = "export default {\n  async mountRoutes(r, c) {\n    const d = path.join(__dirname, 'data')\n    fetch('/api/global/jobs/beacon')\n  }\n}\n"
  const span = findMountRoutes(src)
  assert.equal(span.ctxName, 'c'); assert.equal(span.routerName, 'r')
  assert.equal(rules(src, 'N1')[0].scope, 'mountRoutes')
  assert.equal(rules(src, 'N4')[0].scope, 'mountRoutes')
})

test('N4: outside the span and in the frontend are named, not rewritten', () => {
  const out = rules("const U = '/api/global/x'\nexport default { mountRoutes(router, ctx) {} }", 'N4')[0]
  assert.equal(out.scope, 'outside-mountRoutes'); assert.match(out.answer, /move the URL there/)
  const fe = rules("fetch('/api/global/x')", 'N4', { kind: 'frontend' })[0]
  assert.equal(fe.scope, undefined); assert.match(fe.answer, /self\(\)/)
})

// ---- scope.mjs: the balancer --------------------------------------------------------------------
test('scope: comments with apostrophes, regex literals and template holes do not break the span', () => {
  const src = [
    "export default {",
    "  mountRoutes(router, ctx) {",
    "    // don't stop here { ",
    "    /* nor here } */",
    "    const re = /['\"{]/g",
    "    const t = `a ${ {b: 1}.b } c`",
    "    const s = 'it\\'s'",
    "    router.get('/', (req, res) => { res.end('}') })",
    "  },",
    "  other() { return path.join(HERE, 'data') }",
    "}",
  ].join('\n')
  const span = findMountRoutes(src)
  assert.ok(span)
  assert.equal(src[span.end], '}')
  assert.ok(src.slice(span.bodyStart, span.bodyEnd).includes("res.end('}')"))
  assert.ok(!src.slice(span.bodyStart, span.bodyEnd).includes('other()'))
  const { mask } = scan(src)
  const at = (s) => mask[src.indexOf(s)]
  assert.equal(at("don't"), COMMENT)
  assert.equal(at("nor here"), COMMENT)
  assert.equal(at("['\"{]"), REGEX)
  assert.equal(at("{b: 1}"), CODE)
  assert.equal(at("a ${"), TEMPLATE)
  assert.equal(at("it\\'s"), STRING)
})

test('scope: every mountRoutes form; no ctx parameter → ctxName null; no brace body → null', () => {
  assert.equal(findMountRoutes("export default { mountRoutes: (router, ctx) => { } }").ctxName, 'ctx')
  assert.equal(findMountRoutes("export default { mountRoutes: async function (router, context) { } }").ctxName, 'context')
  assert.equal(findMountRoutes("export default { async mountRoutes(router, ctx = {}) { } }").ctxName, 'ctx')
  assert.equal(findMountRoutes("export default { mountRoutes(router) { } }").ctxName, null)
  assert.equal(findMountRoutes("export default { mountRoutes(router, { dataDir }) { } }").ctxName, null)
  assert.equal(findMountRoutes("// mountRoutes(router, ctx) {\nconst x = 'mountRoutes(a, b) {'"), null)
  assert.equal(findMountRoutes("export default { mountRoutes: (r, c) => c.log('x') }"), null)
})

// ---- the non-regex rules through analyzeFiles ----------------------------------------------------
const FE_META = "export const meta = { name: 'Demo', icon: 'x', group: 'dev', chrome: 'catalyst-chrome', eager: true }\nexport default function App() { return null }\n"

test('D5/I3/N10: the literal meta yields module.json, drops chrome (D5) and eager (I3)', () => {
  const r = analyzeFiles('demo', [{ rel: 'frontend.jsx', kind: 'frontend', text: FE_META }])
  assert.deepEqual(r.moduleJson, { name: 'Demo', icon: 'x', group: 'dev' })
  assert.deepEqual(r.metaDropped.map((d) => [d.key, d.rule]), [['chrome', 'D5'], ['eager', 'I3']])
  assert.deepEqual(ids(r.findings.filter((f) => ['D5', 'I3', 'N10'].includes(f.rule))).sort(), ['D5', 'I3', 'I3', 'N10'])
  const c = cellsOf(r)
  assert.equal(c.D5, 1); assert.equal(c.I3, 2); assert.equal(c.N10, 0)
})

test('N10: a computed meta degrades; no meta → no N10 finding', () => {
  const r = analyzeFiles('demo', [{ rel: 'frontend.jsx', kind: 'frontend', text: "const N = 'x'\nexport const meta = { name: `${N}` }\n" }])
  const f = r.findings.find((x) => x.rule === 'N10')
  assert.equal(f.severity, 'degrades'); assert.match(f.answer, /by hand/)
  assert.equal(r.moduleJson, null); assert.equal(cellsOf(r).N10, 1)
  const none = analyzeFiles('demo', [{ rel: 'frontend.jsx', kind: 'frontend', text: 'export default () => null\n' }])
  assert.equal(none.findings.filter((x) => x.rule === 'N10').length, 0)
})

test('N11: an existing module.json with visibility → the dropped key is named; the meta beside it is ignored', () => {
  const mj = { present: true, ok: true, json: { name: 'x', visibility: 'chat' }, dropped: ['visibility'], invalid: [] }
  const r = analyzeFiles('demo', [{ rel: 'frontend.jsx', kind: 'frontend', text: FE_META }], { moduleJson: mj })
  const n11 = r.findings.filter((f) => f.rule === 'N11')
  assert.equal(n11.length, 1); assert.equal(n11[0].key, 'visibility'); assert.equal(n11[0].file, 'module.json')
  assert.equal(cellsOf(r).N11, 1)
  assert.match(r.findings.find((f) => f.rule === 'N10').answer, /module\.json is the truth/)
  const clean = analyzeFiles('demo', [], { moduleJson: { present: true, ok: true, json: { name: 'x' }, dropped: [], invalid: [] } })
  assert.equal(cellsOf(clean).N11, 0)
})

test('N7: client files outside the top level are named per file', () => {
  const r = analyzeFiles('demo', [
    { rel: 'frontend.jsx', kind: 'frontend', text: 'export default () => null' },
    { rel: 'lib/store.js', kind: 'frontend', text: 'export const s = 1' },
    { rel: 'backend.js', kind: 'backend', text: 'export default { mountRoutes() {} }' },
  ])
  assert.deepEqual(r.files.subfolderClient, ['lib/store.js'])
  assert.equal(cellsOf(r).N7, 1)
  assert.equal(r.findings.filter((f) => f.rule === 'N7')[0].file, 'lib/store.js')
})

test('N1mix: both ctx.dataDir and a folder-relative data path in one module', () => {
  const mix = analyzeFiles('demo', [{ rel: 'backend.js', kind: 'backend', text: be("const a = ctx.dataDir; const b = path.join(HERE, 'data')") }])
  assert.equal(cellsOf(mix).N1mix, 1)
  const one = analyzeFiles('demo', [{ rel: 'backend.js', kind: 'backend', text: be("const b = path.join(HERE, 'data')") }])
  assert.equal(cellsOf(one).N1mix, 0)
})

test('D3: the cross-module list excludes the module\'s own id and ctx.id', () => {
  const r = analyzeFiles('app', [{ rel: 'backend.js', kind: 'backend', text: "ctx.module('app'); ctx.module(ctx.id); ctx.module('jobs')" }])
  assert.deepEqual(r.crossModule, ['jobs']); assert.equal(cellsOf(r).D3, 1)
})

// ---- cells: seed count semantics joined with the probe (lane B, stub contract) ------------------
test('count(): the probe observations join the static hits with the seed semantics', () => {
  const s = analyzeFiles('demo', [{ rel: 'backend.js', kind: 'backend', text: be("spawn('ffmpeg', []); const p = process.env.SPACES_PORT") }])
  const probe = {
    state: 'mount-throw', listens: ['0.0.0.0:7475'], spawns: ['ffmpeg', 'signal-cli'], envReads: ['SPACES_PORT', 'BASE_URL', 'WATCH_REPORT_DEPENDENCIES'],
    writesOutside: ['mkdirSync <app>/data', '~/pro/hf/y'], selfData: ['mkdirSync <app>/data', 'readFileSync <app>/data/x'], egress: ['http://127.0.0.1:443/api/doctor/jobs/beacon', 'https://api.example.com/v1'],
    signalHandlers: ['SIGTERM'], processExit: true, resources: { timers: 1 }, teardown: false, stop: { killed: true },
  }
  const c = cellsOf(s, probe)
  assert.equal(c.D2, 1); assert.equal(c.D12, 2); assert.equal(c.D13, 1)
  assert.equal(c.N1, 2, 'a refused write under <app>/data is in selfData AND writesOutside — counted once'); assert.equal(c.N2, 1); assert.equal(c.N3, 1); assert.equal(c.N5, 1); assert.equal(c.N8, 2)
  assert.equal(c.I2, 1); assert.equal(c.R1, 1); assert.equal(c.R2, 1); assert.equal(c.R3, 1)
  const none = cellsOf(s, null)
  assert.equal(none.D2, 0); assert.equal(none.D12, 1); assert.equal(none.R1, 0); assert.equal(none.R2, 0); assert.equal(none.R3, 0)
  const empty = cellsOf(s, {})
  assert.equal(empty.R1, 0)
  assert.equal(cellsOf(s, { state: 'mounted', resources: {}, teardown: true, stop: { killed: false } }).R3, 0)
})

test('cells: every catalogue id is a number', () => {
  const s = analyzeFiles('demo', [{ rel: 'backend.js', kind: 'backend', text: be("router.get('/', h)") }])
  const c = cellsOf(s)
  for (const r of RULES) assert.equal(typeof c[r.id], 'number', r.id)
})

// ---- the corpus baseline (static only; skipped unless ATELIER_CORPUS names the 58-module corpus) -----
import fs from 'node:fs'
import { listModules } from '../rules/walk.mjs'
import { analyzeModule } from '../rules/static.mjs'
import { readEnvKeyNames } from '../rules/env.mjs'

const CORPUS = process.env.ATELIER_CORPUS
test('corpus: the seed\'s static module counts reproduce (RESULT.md row counts)', { skip: !CORPUS && 'set ATELIER_CORPUS=/path/to/003-atelier-modules' }, () => {
  const envFile = process.env.ATELIER_ENV_KEYS
  const operatorKeys = envFile && fs.existsSync(envFile) ? readEnvKeyNames(fs.readFileSync(envFile, 'utf8')) : new Set()
  const mods = listModules(CORPUS)
  assert.equal(mods.length, 58)
  const n = {}
  let literal = 0
  for (const m of mods) {
    const r = analyzeModule(m, { operatorKeys })
    if (r.meta.literal) literal++
    const c = cellsOf(r)
    for (const [id, v] of Object.entries(c)) if (v > 0) n[id] = (n[id] || 0) + 1
  }
  assert.equal(literal, 58)
  const want = { N1: 19, N1mix: 13, N2: 27, N3: 10, N4: 11, N5: 17, N6: 8, N7: 12, N8: 8, D1: 1, D2: 8, D2w: 4, D4: 2, D5: 52, D6: 13, D7: 45, D8: 4, D9: 6, D10: 1, D11: 3, D12: 27, D13: 28, I1: 19, I3: 1 }
  for (const [id, v] of Object.entries(want)) assert.equal(n[id] || 0, v, `${id}: ${n[id] || 0} ≠ ${v}`)
  if (operatorKeys.size) assert.equal(n.N2op, 7)
  assert.equal(n.D3 || 0, 0)
})
