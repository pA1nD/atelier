// report/merge.mjs + verdict.mjs — static findings + probe observations → one findings list with the
// first-class answers, severities per observation, R1–R3, cells (catalogue count → static cells → fallbacks),
// config keys (names only), the per-module verdict and line (DESIGN §5).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeModule, runtimeFindings, cellsOf, configKeysOf, seedShape } from '../report/merge.mjs'
import { moduleVerdict, findingsByRule } from '../report/verdict.mjs'
import { SEED_RULE_BY_ID } from '../report/seed-rules.mjs'

const byRule = (fs, id) => fs.filter((f) => f.rule === id)

test('probe observations become findings of the seed rows, each with its rule answer and file <runtime>', () => {
  const runtime = {
    state: 'mounted', teardown: true, resources: {},
    listens: ['0.0.0.0:7475'],
    spawns: ['ffmpeg', 'git'],
    envReads: ['SPACES_PORT', 'BASE_URL', 'HOME', 'WATCH_REPORT_DEPENDENCIES', 'CF_API_TOKEN'],
    egress: ['http://127.0.0.1:1844/api/global/jobs/beacon', 'https://api.example.com/v1', 'http://localhost:7402/x'],
    writesOutside: ['<app>/data/x', '~/pro/hf/model'],
    selfData: ['<app>/data'],
    signalHandlers: ['SIGTERM'],
    processExit: true,
  }
  const fs = runtimeFindings(runtime, [], { envKeys: new Set(['CF_API_TOKEN']) })
  for (const f of fs) { assert.equal(f.file, '<runtime>'); assert.equal(f.line, 0); assert.ok(f.answer.length > 0, f.rule) }
  assert.deepEqual(byRule(fs, 'D2').map((f) => [f.severity, f.excerpt]), [['breaks-in-fleet', 'listen 0.0.0.0:7475']])
  assert.equal(byRule(fs, 'D2')[0].answer, SEED_RULE_BY_ID.D2.answer)
  assert.deepEqual(byRule(fs, 'D12').map((f) => [f.excerpt, f.severity]), [['spawn ffmpeg', 'breaks-in-fleet'], ['spawn git', 'note']])
  assert.deepEqual(byRule(fs, 'N3').map((f) => f.excerpt), ['process.env.BASE_URL'])
  assert.deepEqual(byRule(fs, 'N2').map((f) => f.excerpt), ['process.env.SPACES_PORT', 'process.env.CF_API_TOKEN'])
  assert.deepEqual(byRule(fs, 'N2op').map((f) => [f.excerpt, f.severity]), [['process.env.CF_API_TOKEN (operator .env key)', 'breaks-in-fleet']])
  assert.deepEqual(byRule(fs, 'D13').map((f) => [f.excerpt, f.severity]), [['process.env.HOME', 'degrades'], ['write ~/pro/hf/model (refused EACCES)', 'breaks-in-fleet']])
  assert.equal(fs.some((f) => /WATCH_REPORT/.test(f.excerpt)), false)
  assert.deepEqual(byRule(fs, 'N4').map((f) => f.excerpt), ['egress http://127.0.0.1:1844/api/global/jobs/beacon'])
  assert.deepEqual(byRule(fs, 'N5').map((f) => f.excerpt), ['egress http://127.0.0.1:1844/api/global/jobs/beacon', 'egress http://localhost:7402/x'])
  assert.deepEqual(byRule(fs, 'I2').map((f) => [f.excerpt, f.severity]), [['egress https://api.example.com/v1', 'note']])
  assert.deepEqual(byRule(fs, 'N1').map((f) => f.excerpt), ['write <app>/data/x (refused EACCES)', 'touches <app>/data'])
  assert.deepEqual(byRule(fs, 'N8').map((f) => f.excerpt), ["process.on('SIGTERM')", 'process.exit()'])
  assert.equal(byRule(fs, 'R1').length, 0)
  assert.equal(byRule(fs, 'R2').length, 0)
  assert.equal(byRule(fs, 'R3').length, 0)
})

test('R1 on a broken state, R2 on resources, R3 on no teardown / killed; "mounted" alone is no finding', () => {
  assert.deepEqual(runtimeFindings({ state: 'mounted', teardown: true, resources: {} }), [])
  const r1 = runtimeFindings({ state: 'load-error', error: { message: 'EACCES mkdirSync <app>/data', file: 'backend.js', line: 3 } })
  assert.deepEqual(r1.map((f) => [f.rule, f.severity, f.excerpt]), [['R1', 'breaks-in-fleet', 'load-error — EACCES mkdirSync <app>/data (backend.js:3)']])
  const r2 = runtimeFindings({ state: 'mounted', teardown: true, resources: { Timeout: 1, ChildProcess: 1 } })
  assert.deepEqual(r2.map((f) => [f.rule, f.severity, f.excerpt]), [['R2', 'note', 'resident: Timeout=1 ChildProcess=1']])
  assert.deepEqual(runtimeFindings({ state: 'mounted', teardown: false }).map((f) => [f.rule, f.severity]), [['R3', 'degrades']])
  assert.deepEqual(runtimeFindings({ state: 'mounted', teardown: true, stop: { killed: true } }).map((f) => f.excerpt), ['killed at the drain deadline (SIGKILL after 2 s)'])
  assert.deepEqual(runtimeFindings({ state: 'no-backend' }), [])
  assert.deepEqual(runtimeFindings(undefined), [])
})

test('a catalogue rule overrides the answer, the severity and (via match.runtime) the classification', () => {
  const rules = [
    { id: 'D2', severity: 'breaks-in-fleet', answer: 'CATALOGUE D2 ANSWER' },
    { id: 'N5', severity: 'breaks-in-fleet', answer: 'peer', match: { runtime: (o) => /:9999/.test(String(o)) } },
    { id: 'I2', severity: 'note', answer: 'egress', match: { runtime: () => false } },
  ]
  const fs = runtimeFindings({ state: 'mounted', teardown: true, listens: ['unix:/tmp/x.sock'], egress: ['http://127.0.0.1:1844/x', 'http://127.0.0.1:9999/y', 'https://a.b/'] }, rules)
  assert.equal(byRule(fs, 'D2')[0].answer, 'CATALOGUE D2 ANSWER')
  assert.deepEqual(byRule(fs, 'N5').map((f) => f.excerpt), ['egress http://127.0.0.1:9999/y'])
  assert.equal(byRule(fs, 'I2').length, 0)
})

test('cells: catalogue count wins, then static.cells, then the R1–R3 fallbacks; every column id is a number', () => {
  const rules = [{ id: 'N1', count: (s, p) => (s.hits?.self_data ?? 0) + (p.selfData?.length ?? 0) }]
  const cells = cellsOf({ rules, static: { hits: { self_data: 2 }, cells: { N4: 3, N1: 99 } }, runtime: { state: 'mount-throw', resources: { Timeout: 1 }, selfData: ['<app>/data'] } })
  assert.equal(cells.N1, 3)
  assert.equal(cells.N4, 3)
  assert.equal(cells.R1, 1)
  assert.equal(cells.R2, 1)
  assert.equal(cells.R3, 0)
  assert.equal(cells.M4, 0)
  assert.equal(Object.keys(cells).length, 40)
  for (const v of Object.values(cells)) assert.equal(typeof v, 'number')
})

test('config keys: names only, classes from static.env + probe reads, operator keys promoted, node noise dropped', () => {
  const ck = configKeysOf({ static: { env: { SITES_TOKEN: 'config', CF_API_TOKEN: 'operator-env', BASE_URL: 'shell-published', HOME: 'laptop', NODE_ENV: 'node' } }, runtime: { envReads: ['SPACES_PORT', 'WATCH_REPORT_DEPENDENCIES', 'PORT', 'SEATS_AERO'] }, envKeys: new Set(['SEATS_AERO', 'SITES_TOKEN']) })
  assert.deepEqual(ck, { operator: ['CF_API_TOKEN', 'SEATS_AERO', 'SITES_TOKEN'], config: ['SPACES_PORT'], shell: ['BASE_URL', 'PORT'], laptop: ['HOME'] })
  assert.equal(JSON.stringify(ck).includes('dev'), false)
})

test('moduleVerdict: BREAKS on a breaks finding or a broken state, DEGRADES, CLEAN; the line and the answers', () => {
  const f = (rule, severity) => ({ rule, severity, answer: SEED_RULE_BY_ID[rule].answer })
  const v = moduleVerdict({ module: 'sites', findings: [f('N1', 'breaks-in-fleet'), f('N1', 'breaks-in-fleet'), f('N2', 'degrades'), f('D7', 'note'), f('D2', 'breaks-in-fleet')], runtime: { state: 'mounted' }, rewrites: [{}, {}, {}, {}] })
  assert.equal(v.level, 'BREAKS')
  assert.equal(v.line, 'DOCTOR sites mounted BREAKS breaks=3 degrades=1 notes=1 rewrites=4 — N1:2 D2:1 N2:1 D7:1')
  assert.deepEqual(v.answers.map((a) => [a.rule, a.severity, a.count]), [['N1', 'breaks-in-fleet', 2], ['D2', 'breaks-in-fleet', 1], ['N2', 'degrades', 1]])
  assert.equal(v.answers[0].answer, SEED_RULE_BY_ID.N1.answer)
  assert.equal(moduleVerdict({ module: 'x', findings: [], runtime: { state: 'mount-throw' } }).level, 'BREAKS')
  assert.equal(moduleVerdict({ module: 'x', findings: [f('N2', 'degrades')], runtime: { state: 'mounted' } }).level, 'DEGRADES')
  const c = moduleVerdict({ module: 'x', findings: [f('D7', 'note')] })
  assert.equal(c.level, 'CLEAN')
  assert.equal(c.line, 'DOCTOR x skipped CLEAN breaks=0 degrades=0 notes=1 rewrites=0 — D7:1')
  assert.equal(moduleVerdict({ module: 'y', findings: [] }).line, 'DOCTOR y skipped CLEAN breaks=0 degrades=0 notes=0 rewrites=0 — clean')
  assert.deepEqual(findingsByRule([f('D7', 'note'), f('N1', 'breaks-in-fleet')]).map((e) => e.rule), ['N1', 'D7'])
})

test('mergeModule: the report.json shape; static findings keep their file:line and get the rule answer; rewrites flatten', () => {
  const st = { findings: [{ rule: 'N1', severity: 'breaks-in-fleet', file: 'backend.js', line: 6, excerpt: "path.join(HERE, 'data')", rewrite: { to: 'ctx.dataDir' } }, { rule: 'N4', file: 'frontend.jsx', line: 4, excerpt: '/api/global/' }], cells: { N1: 1, N4: 1 }, files: { source: 2, client: 1, subfolderClient: 0 }, env: { LEGACY_TOKEN: 'config' } }
  const meta = { declared: true, literal: true, error: null, keys: ['name', 'icon', 'chrome'], moduleJson: { name: 'Legacy', icon: 'archive' }, dropped: [{ key: 'chrome', rule: 'D5', reason: 'dropped' }] }
  const r = mergeModule({ id: 'legacy-data', dir: '/c/legacy-data', daily: false, static: st, meta, rewrites: [{ file: 'backend.js', text: '…', edits: [{ line: 6, from: "path.join(HERE, 'data')", to: 'ctx.dataDir' }] }], runtime: { state: 'mounted', teardown: true, resources: {}, envReads: ['LEGACY_TOKEN'] }, tailwind: { coldMs: 2.1, longLines: 0 } })
  assert.deepEqual(Object.keys(r), ['module', 'dir', 'daily', 'files', 'meta', 'moduleJson', 'configKeys', 'findings', 'rewrites', 'rewriteLeftover', 'runtime', 'tailwind', 'cells', 'verdict'])
  assert.deepEqual(r.rewriteLeftover, [])
  assert.equal(r.findings[0].answer, SEED_RULE_BY_ID.N1.answer)
  assert.deepEqual(r.findings[0].rewrite, { to: 'ctx.dataDir' })
  assert.equal(r.findings[1].severity, 'breaks-in-fleet')      // N4's catalogue default when the static finding carries none
  assert.deepEqual(r.findings.at(-1), { rule: 'N2', severity: 'degrades', file: '<runtime>', line: 0, excerpt: 'process.env.LEGACY_TOKEN', answer: SEED_RULE_BY_ID.N2.answer })
  assert.deepEqual(r.rewrites, [{ file: 'backend.js', line: 6, from: "path.join(HERE, 'data')", to: 'ctx.dataDir' }])
  assert.deepEqual(r.meta, { declared: true, literal: true, error: null, keys: ['name', 'icon', 'chrome'], dropped: [{ key: 'chrome', rule: 'D5', reason: 'dropped' }] })
  assert.deepEqual(r.moduleJson, { name: 'Legacy', icon: 'archive' })
  assert.deepEqual(r.configKeys, { operator: [], config: ['LEGACY_TOKEN'], shell: [], laptop: [] })
  assert.equal(r.cells.N1, 1)
  assert.equal(r.verdict.level, 'BREAKS')
  assert.equal(r.verdict.line, 'DOCTOR legacy-data mounted BREAKS breaks=2 degrades=1 notes=0 rewrites=1 — N1:1 N4:1 N2:1')
  assert.deepEqual(r.tailwind, { coldMs: 2.1, longLines: 0 })
  const empty = mergeModule({ id: 'e', dir: '/e' })
  assert.deepEqual(empty.runtime, { state: 'skipped' })
  assert.equal(empty.verdict.level, 'CLEAN')
})

test('a unix-socket connect into the home is D13 (a laptop socket), never N5; a row-W key read (TMPDIR) is no finding; an IMAGE_BINS spawn names its script', () => {
  const fs = runtimeFindings({ state: 'mounted', teardown: true, egress: ['unix:~/Library/Application Support/hb-broker/broker.sock', 'unix:/tmp/atelier/peer.sock'], envReads: ['TMPDIR', 'APP_ID', 'HOME'], spawns: [{ bin: '/opt/homebrew/bin/node', fn: 'spawn', script: '<app>/mcp-server.js' }, 'ffmpeg'] })
  assert.deepEqual(byRule(fs, 'N5'), [])
  assert.deepEqual(byRule(fs, 'D13').map((f) => [f.severity, f.excerpt]), [['degrades', 'process.env.HOME'], ['breaks-in-fleet', 'egress unix:~/Library/Application Support/hb-broker/broker.sock (a laptop socket)']])
  assert.deepEqual(byRule(fs, 'N2'), [])
  assert.deepEqual(byRule(fs, 'D12').map((f) => [f.severity, f.excerpt, f.answer]), [
    ['note', 'spawn /opt/homebrew/bin/node <app>/mcp-server.js', '`node` is in the image (IMAGE_BINS); the spawned script is a walked file — its own habits (a listen() is D2) are judged by the static rules'],
    ['breaks-in-fleet', 'spawn ffmpeg', SEED_RULE_BY_ID.D12.answer],
  ])
  const ck = configKeysOf({ static: {}, runtime: { envReads: ['TMPDIR', 'PORT'] } })
  assert.deepEqual(ck, { operator: [], config: [], shell: ['PORT'], laptop: [] })
  // a partial N1 rewrite is named on the report
  const r = mergeModule({ id: 'agent', dir: '/c/agent', rewrites: [{ file: 'backend.js', text: '…', edits: [{ rule: 'N1', line: 6, from: 'a', to: 'b' }], partial: true, leftover: ['signal-bridge.js:32', 'wab-bridge.js:31'] }] })
  assert.deepEqual(r.rewriteLeftover, ['signal-bridge.js:32', 'wab-bridge.js:31'])
})

test("lane B's record objects ({key, n}, {target}, {bin}, {path}, {signal}, {code}) normalise to the seed shape for counts and findings", () => {
  const runtime = {
    state: 'mounted', teardown: true, resources: { Timeout: 1 }, stop: { code: 0, signal: null, killed: false },
    envReads: [{ key: 'SPACES_PORT', n: 2, frame: 'backend.js:3:1' }, { key: 'BASE_URL', n: 1, frame: null }],
    listens: [{ target: '0.0.0.0:7475', frame: 'backend.js:9:5' }],
    spawns: [{ bin: 'ffmpeg', fn: 'spawn', frame: 'backend.js:12:3' }],
    writesOutside: [{ op: 'mkdirSync', path: '~/pro/hf', inApp: false, frame: 'x' }],
    selfData: [{ op: 'readdirSync', path: '<app>/data', write: false, frame: 'x' }],
    egress: [{ via: 'fetch', target: 'http://127.0.0.1:1844/api/global/jobs/beacon', loopback: true, frame: 'x' }],
    signalHandlers: [{ signal: 'SIGTERM', frame: 'x' }],
    processExit: [],
    ctxModule: [{ id: 'other', cross: true }],
  }
  const s = seedShape(runtime)
  assert.deepEqual(s.envReads, ['SPACES_PORT', 'BASE_URL'])
  assert.deepEqual(s.listens, ['0.0.0.0:7475'])
  assert.deepEqual(s.spawns, ['ffmpeg'])
  assert.deepEqual(s.writesOutside, ['~/pro/hf'])
  assert.deepEqual(s.selfData, ['<app>/data'])
  assert.deepEqual(s.egress, ['http://127.0.0.1:1844/api/global/jobs/beacon'])
  assert.deepEqual(s.signalHandlers, ['SIGTERM'])
  assert.equal(s.processExit, false)            // an empty list is not an exit
  assert.deepEqual(s.ctxModule, ['other'])
  assert.equal(s.error, null)
  const fs = runtimeFindings(runtime)
  assert.deepEqual(fs.map((f) => f.rule), ['D2', 'D12', 'N2', 'N3', 'N4', 'N5', 'D13', 'N1', 'N8', 'R2'])
  assert.deepEqual(byRule(fs, 'N8').map((f) => f.excerpt), ["process.on('SIGTERM')"])
  // a catalogue-style count sees the seed shape, not the records
  const rules = [{ id: 'N8', count: (st, p) => (p.signalHandlers?.length ?? 0) + (p.processExit ? 1 : 0) }, { id: 'D2', count: (st, p) => p.listens.length }]
  const cells = cellsOf({ rules, runtime })
  assert.equal(cells.N8, 1)
  assert.equal(cells.D2, 1)
  // a broken worker: the error text comes from `died`
  const dead = seedShape({ state: 'load-error', died: { where: 'import', code: 'LOAD-ERROR', error: { message: 'EACCES mkdirSync', file: 'backend.js', line: 3, col: 7 } } })
  assert.equal(dead.error, 'EACCES mkdirSync (backend.js:3:7)')
  assert.deepEqual(runtimeFindings({ state: 'load-error', died: { error: { message: 'EACCES mkdirSync', file: 'backend.js', line: 3 } } }).map((f) => f.excerpt), ['load-error — EACCES mkdirSync (backend.js:3)'])
  assert.deepEqual(runtimeFindings({ state: 'mounted', teardown: true, processExit: [{ code: 0 }] }).map((f) => f.excerpt), ['process.exit(0)'])
})
