// report/columns.mjs + table.mjs + verdict.mjs — the CSV header's first 37 fields equal the seed's string,
// column order, rows.md / modules.md shape, summary.json keys, the corpus VERDICT line (DESIGN §5, §8).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SEED_HEADER, SEED_COLUMNS, COLUMNS, HEADER, NEW_COLUMNS, RULE_COLUMN_IDS } from '../report/columns.mjs'
import { DAILY, dailySort } from '../report/daily.mjs'
import { buildRows, toCsv, rowsMd, modulesMd, summaryOf, countRows } from '../report/table.mjs'
import { finalVerdict, failVerdict } from '../report/verdict.mjs'
import { mergeModule } from '../report/merge.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SEED_CSV = '/Users/pa1nd/pro/001-atelier/design/atelier2/r2/spike-migration-local-1/out/portability.csv'

const report = (id, over = {}) => mergeModule({ id, dir: `/x/${id}`, daily: DAILY.includes(id), ...over })

test('the seed header is preserved verbatim: 37 fields, then the new columns after M4', () => {
  assert.equal(SEED_COLUMNS.length, 37)
  assert.equal(SEED_COLUMNS[36], 'M4')
  assert.equal(HEADER.slice(0, SEED_HEADER.length), SEED_HEADER)
  assert.equal(HEADER[SEED_HEADER.length], ',')
  assert.deepEqual(COLUMNS.slice(37), [...NEW_COLUMNS])
  assert.equal(COLUMNS.length, 37 + NEW_COLUMNS.length)
  assert.equal(COLUMNS.at(-1), 'verdict')
  assert.equal(new Set(COLUMNS).size, COLUMNS.length)
  if (fs.existsSync(SEED_CSV)) assert.equal(fs.readFileSync(SEED_CSV, 'utf8').split('\n')[0], SEED_HEADER)
})

test('rule column ids = the 32 seed rule columns + the 7 new rule cells, in order', () => {
  assert.equal(RULE_COLUMN_IDS.length, 39)
  assert.equal(RULE_COLUMN_IDS[0], 'D1')
  assert.equal(RULE_COLUMN_IDS[31], 'M4')
  assert.deepEqual(RULE_COLUMN_IDS.slice(32), ['N1mix', 'N9', 'N10', 'N11', 'R1', 'R2', 'R3'])
})

test('rows: daily first in DAILY order, then alphabetical; every column present; CSV cells render the seed way', () => {
  const reports = [report('zeta'), report('accounts'), report('dashboard'), report('alpha', { runtime: { state: 'mounted', teardown: true, resources: { Timeout: 2 } }, tailwind: { coldMs: 3.6, longLines: 1 } })]
  const rows = buildRows(reports)
  assert.deepEqual(rows.map((r) => r.module), ['dashboard', 'accounts', 'alpha', 'zeta'])
  for (const r of rows) for (const c of COLUMNS) assert.ok(c in r, `${c} missing`)
  const csv = toCsv(rows)
  const lines = csv.trimEnd().split('\n')
  assert.equal(lines[0], HEADER)
  assert.equal(lines.length, 5)
  for (const l of lines.slice(1)) assert.equal(l.split(',').length, COLUMNS.length, l)
  const alpha = Object.fromEntries(COLUMNS.map((c, i) => [c, lines[3].split(',')[i]]))
  assert.equal(alpha.module, 'alpha')
  assert.equal(alpha.daily, '')
  assert.equal(alpha.dynamic_state, 'mounted')
  assert.equal(alpha.meta_literal, 'yes')       // no declared meta = nothing to convert (the seed's rule)
  assert.equal(alpha.tw_cold_max_ms, '3.6')
  assert.equal(alpha.long_lines, '1')
  assert.equal(alpha.resident, '2')
  assert.equal(alpha.R2, '1')
  assert.equal(alpha.teardown, 'yes')
  assert.equal(alpha.killed, '')
  assert.equal(alpha.verdict, 'CLEAN')
  const dash = Object.fromEntries(COLUMNS.map((c, i) => [c, lines[1].split(',')[i]]))
  assert.equal(dash.daily, 'daily')
  assert.equal(dash.dynamic_state, 'skipped')
  assert.equal(dash.tw_cold_max_ms, '')
  assert.equal(dash.teardown, '')
  assert.equal([...'abc'].sort(dailySort).join(''), 'abc')
})

test('rows.md: one line per rule column (seed ids first), family + title from the catalogue, counts /N and /daily', () => {
  const rules = [{ id: 'D1', family: '§4.8', title: 'auth module (local-only)' }, { id: 'X9', family: 'NEW', title: 'an extra catalogue rule' }]
  const reports = [report('jobs', { static: { cells: { D1: 1, N1: 2 } } }), report('beta', { static: { cells: { N1: 1 } } })]
  const rows = buildRows(reports)
  const md = rowsMd(rows, rules).split('\n')
  assert.equal(md[0], '| row | family | break | modules /2 | daily /1 |')
  assert.equal(md[1], '|---|---|---|---|---|')
  assert.equal(md[2], '| D1 | §4.8 | auth module (local-only) | 1 | 1 |')
  assert.equal(md[2 + RULE_COLUMN_IDS.indexOf('N1')], '| N1 | NEW | self-pathed data dir / writes into the app folder | 2 | 1 |')
  assert.equal(md.at(-2), '| X9 | NEW | an extra catalogue rule | 0 | 0 |')
  assert.equal(md.length, 2 + RULE_COLUMN_IDS.length + 1 + 1)   // header, sep, 39 columns, X9, trailing ''
  assert.deepEqual(countRows(rows, 'N1'), { all: 2, daily: 1 })
})

test('modules.md: | module | daily | 2.0 worker | breaks (row: count) | verdict | with the probe error after the state', () => {
  const reports = [
    report('sites', { static: { cells: { N1: 6, D7: 4, I4: 1 } }, runtime: { state: 'load-error', error: 'EACCES: permission denied, mkdirSync <app>/data/projects | at x' } }),
    report('quiet', { runtime: { state: 'mounted', teardown: true } }),
  ]
  const md = modulesMd(buildRows(reports)).split('\n')
  assert.equal(md[0], '| module | daily | 2.0 worker | breaks (row: count) | verdict |')
  assert.equal(md[2], '| sites | Y | load-error — EACCES: permission denied, mkdirSync <app>/data/projects  | D7:4 N1:6 | BREAKS |')
  assert.equal(md[3], '| quiet |  | mounted |  | CLEAN |')
})

test('summary.json: the seed keys minus rss, plus verdicts / rewrites / configKeys; the VERDICT line', () => {
  const reports = [
    report('jobs', { static: { cells: { N4: 3, M1: 1, N7: 2 } }, meta: { declared: true, literal: true }, runtime: { state: 'mounted', teardown: true }, tailwind: { coldMs: 3.8 } }),
    report('sites', { static: { cells: { N1: 6 }, env: { SITES_TOKEN: 'operator' } }, meta: { declared: true, literal: true }, runtime: { state: 'load-error', error: 'boom' }, tailwind: { coldMs: 61 }, rewrites: [{ file: 'backend.js', edits: [{ line: 3, from: 'a', to: 'b' }] }] }),
    report('worldclock', { runtime: { state: 'no-backend' }, tailwind: { coldMs: 147.2 } }),
    report('plain', { runtime: { state: 'mounted', teardown: false } }),
  ]
  const rows = buildRows(reports)
  const s = summaryOf(rows, reports)
  assert.deepEqual(Object.keys(s), ['modules', 'daily', 'dynStates', 'brokenAtMount', 'outsideRows', 'metaLiteral', 'metaDeclared', 'twMax', 'twWorst', 'twOver', 'mobile', 'subfolder', 'verdicts', 'rewrites', 'configKeys'])
  assert.equal(s.modules, 4)
  assert.equal(s.daily, 2)
  assert.deepEqual(s.dynStates, { mounted: 2, 'load-error': 1, 'no-backend': 1 })
  assert.deepEqual(s.brokenAtMount, ['sites(load-error)'])
  assert.deepEqual(s.outsideRows, { all: 2, daily: 2, ids: ['jobs', 'sites'] })
  assert.equal(s.metaLiteral, 4)        // 2 literal + 2 with nothing declared
  assert.equal(s.metaDeclared, 2)
  assert.equal(s.twMax, 147.2)
  assert.equal(s.twWorst, 'worldclock')
  assert.deepEqual(s.twOver, ['sites 61ms', 'worldclock 147.2ms'])
  assert.deepEqual(s.mobile, { modules: 1, daily: 1, hazards: 'M1=1 M2=0 M3=0 M4=0' })
  assert.deepEqual(s.subfolder, { modules: 1, daily: 1 })
  assert.deepEqual(s.verdicts, { BREAKS: 1, DEGRADES: 1, CLEAN: 2 })
  assert.deepEqual(s.rewrites, { modules: 1, edits: 1 })
  assert.deepEqual(s.configKeys, { modules: 1, operator: 1 })
  assert.equal(finalVerdict(rows, s), 'VERDICT: DOCTOR 2/4 clean, 1 degrade, 1 break in the fleet (1/2 daily); module.json 4/4; rewrites 1 edits in 1 modules; probe 2/3 mounted, 1 broken at mount [sites(load-error)]; tailwind max 147.2 ms (worldclock)')
  assert.equal(failVerdict('rules lane threw'), 'VERDICT: FAIL — rules lane threw')
})

test('the fixtures used by cli.test.js are two modules and one excluded name', () => {
  const names = fs.readdirSync(path.join(HERE, 'fixtures', 'report-corpus')).sort()
  assert.deepEqual(names, ['_private', 'hello-clean', 'legacy-data'])
})
