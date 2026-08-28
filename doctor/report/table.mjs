// doctor/report/table.mjs — the corpus table (DESIGN §5): rows from the per-module reports, the CSV
// (seed header verbatim + the new columns after M4), rows.md, modules.md, summary.json. Pure.
import { COLUMNS, HEADER, RULE_COLUMN_IDS, SEED_RULE_IDS } from './columns.mjs'
import { dailySort } from './daily.mjs'
import { SEED_RULE_BY_ID } from './seed-rules.mjs'
import { residentCount } from './merge.mjs'

/** report.json → one table row (every column of COLUMNS, raw values; `toCsv` renders them). */
export function rowOf(report) {
  const rt = report.runtime ?? {}
  const cells = report.cells ?? {}
  const row = {
    module: report.module,
    daily: !!report.daily,
    dynamic_state: rt.state ?? 'skipped',
    meta_literal: !!(report.meta?.literal || !report.meta?.declared),   // the seed: nothing to convert counts as literal
    tw_cold_max_ms: report.tailwind?.coldMs ?? null,
  }
  for (const id of RULE_COLUMN_IDS) row[id] = Number(cells[id]) || 0
  row.long_lines = report.tailwind?.longLines ?? 0
  row.resident = residentCount(rt.resources)
  row.teardown = rt.state === 'mounted' ? (rt.teardown ? 'yes' : 'no') : ''
  row.killed = rt.stop?.killed ? 'yes' : ''
  row.config_keys = (report.configKeys?.config?.length ?? 0) + (report.configKeys?.operator?.length ?? 0)
  row.operator_keys = report.configKeys?.operator?.length ?? 0
  row.verdict = report.verdict?.level ?? 'CLEAN'
  const err = rt.error ?? rt.died?.error ?? null
  row.dynErr = err ? String(typeof err === 'string' ? err : err.message ?? '').split('|')[0].slice(0, 90) : ''
  return row
}

export function buildRows(reports) {
  return reports.map(rowOf).sort((a, b) => dailySort(a.module, b.module))
}

const csvCell = (col, v) => {
  if (col === 'daily') return v ? 'daily' : ''
  if (col === 'meta_literal') return v ? 'yes' : 'NO'
  if (v == null) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows) {
  return [HEADER, ...rows.map((r) => COLUMNS.map((c) => csvCell(c, r[c])).join(','))].join('\n') + '\n'
}

/** Rule ids for rows.md: the CSV's rule columns first (seed order), then any catalogue id without a column. */
export function ruleIdsFor(rules = []) {
  const ids = [...RULE_COLUMN_IDS]
  for (const r of rules) if (!ids.includes(r.id)) ids.push(r.id)
  return ids
}

const ruleMeta = (rules, id) => rules.find((r) => r.id === id) ?? SEED_RULE_BY_ID[id] ?? { id, family: 'NEW', title: id }

export function countRows(rows, id) {
  const hit = (r) => (r[id] ?? 0) > 0
  return { all: rows.filter(hit).length, daily: rows.filter((r) => r.daily && hit(r)).length }
}

export function rowsMd(rows, rules = []) {
  const n = rows.length, d = rows.filter((r) => r.daily).length
  const lines = [`| row | family | break | modules /${n} | daily /${d} |`, '|---|---|---|---|---|']
  for (const id of ruleIdsFor(rules)) {
    const m = ruleMeta(rules, id)
    const c = countRows(rows, id)
    lines.push(`| ${id} | ${m.family} | ${m.title} | ${c.all} | ${c.daily} |`)
  }
  return lines.join('\n') + '\n'
}

/** The break columns of modules.md: the seed's §4.8 + NEW families (N2op included, as the seed). */
const breakIds = (rules) => ruleIdsFor(rules).filter((id) => ['§4.8', 'NEW'].includes(ruleMeta(rules, id).family))

export function modulesMd(rows, rules = []) {
  const ids = breakIds(rules)
  const lines = ['| module | daily | 2.0 worker | breaks (row: count) | verdict |', '|---|---|---|---|---|']
  for (const r of rows) {
    lines.push(`| ${r.module} | ${r.daily ? 'Y' : ''} | ${r.dynamic_state}${r.dynErr ? ' — ' + r.dynErr : ''} | ${ids.filter((id) => r[id]).map((id) => `${id}:${r[id]}`).join(' ')} | ${r.verdict} |`)
  }
  return lines.join('\n') + '\n'
}

/** summary.json — the seed's keys minus `rss`, plus verdicts / rewrites / configKeys. */
export function summaryOf(rows, reports, rules = []) {
  const byId = Object.fromEntries(reports.map((r) => [r.module, r]))
  const newIds = ruleIdsFor(rules).filter((id) => ruleMeta(rules, id).family === 'NEW' && id !== 'N2op')
  const outside = rows.filter((r) => newIds.some((id) => r[id] > 0))
  const dynStates = {}
  for (const r of rows) dynStates[r.dynamic_state] = (dynStates[r.dynamic_state] || 0) + 1
  const broken = rows.filter((r) => !['mounted', 'no-backend', 'skipped'].includes(r.dynamic_state))
  const tw = rows.filter((r) => r.tw_cold_max_ms != null)
  const twMax = tw.length ? Math.max(...tw.map((r) => r.tw_cold_max_ms)) : null
  const twWorst = tw.find((r) => r.tw_cold_max_ms === twMax)
  const mobile = rows.filter((r) => ['M1', 'M2', 'M3', 'M4'].some((id) => r[id] > 0))
  const sub = rows.filter((r) => r.N7 > 0)
  const verdicts = { BREAKS: 0, DEGRADES: 0, CLEAN: 0 }
  for (const r of rows) verdicts[r.verdict] = (verdicts[r.verdict] || 0) + 1
  const rw = reports.filter((r) => (r.rewrites?.length ?? 0) > 0)
  const ck = reports.filter((r) => (r.configKeys?.config?.length ?? 0) + (r.configKeys?.operator?.length ?? 0) > 0)
  return {
    modules: rows.length,
    daily: rows.filter((r) => r.daily).length,
    dynStates,
    brokenAtMount: broken.map((r) => `${r.module}(${r.dynamic_state})`),
    outsideRows: { all: outside.length, daily: outside.filter((r) => r.daily).length, ids: outside.map((r) => r.module) },
    metaLiteral: rows.filter((r) => r.meta_literal).length,
    metaDeclared: rows.filter((r) => byId[r.module]?.meta?.declared).length,
    twMax, twWorst: twWorst?.module ?? null,
    twOver: tw.filter((r) => r.tw_cold_max_ms > 50).map((r) => `${r.module} ${r.tw_cold_max_ms}ms`),
    mobile: { modules: mobile.length, daily: mobile.filter((r) => r.daily).length, hazards: ['M1', 'M2', 'M3', 'M4'].map((id) => `${id}=${rows.reduce((n, r) => n + r[id], 0)}`).join(' ') },
    subfolder: { modules: sub.length, daily: sub.filter((r) => r.daily).length },
    verdicts,
    rewrites: { modules: rw.length, edits: rw.reduce((n, r) => n + r.rewrites.length, 0) },
    configKeys: { modules: ck.length, operator: reports.filter((r) => (r.configKeys?.operator?.length ?? 0) > 0).length },
  }
}

export { SEED_RULE_IDS }
