// doctor/report/verdict.mjs — the per-module verdict (BREAKS | DEGRADES | CLEAN, DESIGN §5) with the
// first-class answers named, the per-module stdout line, and the corpus VERDICT line. Pure.

export const SEVERITIES = Object.freeze(['breaks-in-fleet', 'degrades', 'note'])
const RANK = { 'breaks-in-fleet': 0, degrades: 1, note: 2 }

/** Probe states that are not a broken worker. `undefined` = no probe result at all (lane B absent). */
export const OK_STATES = new Set(['mounted', 'no-backend', 'skipped'])
export const isBrokenState = (state) => state != null && !OK_STATES.has(state)

/** Findings per rule id, ordered by the rule's worst severity, then count desc, then id. */
export function findingsByRule(findings) {
  const by = new Map()
  for (const f of findings) {
    const e = by.get(f.rule) ?? { rule: f.rule, count: 0, severity: 'note', answer: f.answer }
    e.count++
    if (RANK[f.severity] < RANK[e.severity]) { e.severity = f.severity; e.answer = f.answer }
    by.set(f.rule, e)
  }
  return [...by.values()].sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.count - a.count || a.rule.localeCompare(b.rule))
}

/**
 * @param {{module:string, findings:Array<{rule:string, severity:string, answer?:string}>, runtime?:{state?:string}, rewrites?:Array}} r
 * @returns {{level:'BREAKS'|'DEGRADES'|'CLEAN', line:string, counts:{breaks:number, degrades:number, notes:number, rewrites:number}, answers:Array<{rule:string, severity:string, count:number, answer:string}>}}
 */
export function moduleVerdict({ module, findings = [], runtime, rewrites = [] }) {
  const counts = { breaks: 0, degrades: 0, notes: 0, rewrites: rewrites.length }
  for (const f of findings) {
    if (f.severity === 'breaks-in-fleet') counts.breaks++
    else if (f.severity === 'degrades') counts.degrades++
    else counts.notes++
  }
  const state = runtime?.state ?? 'skipped'
  const level = counts.breaks || isBrokenState(runtime?.state) ? 'BREAKS' : counts.degrades ? 'DEGRADES' : 'CLEAN'
  const byRule = findingsByRule(findings)
  const answers = byRule.filter((e) => e.severity !== 'note').map((e) => ({ rule: e.rule, severity: e.severity, count: e.count, answer: e.answer ?? '' }))
  const ids = byRule.length ? byRule.map((e) => `${e.rule}:${e.count}`).join(' ') : 'clean'
  const line = `DOCTOR ${module} ${state} ${level} breaks=${counts.breaks} degrades=${counts.degrades} notes=${counts.notes} rewrites=${counts.rewrites} — ${ids}`
  return { level, line, counts, answers }
}

/**
 * The last line of every completed run (DESIGN §5). `rows` are the table rows (table.mjs), `summary` the
 * summary.json object; both come from the same reports so the numbers agree.
 */
export function finalVerdict(rows, summary) {
  const n = rows.length
  const clean = rows.filter((r) => r.verdict === 'CLEAN').length
  const degrades = rows.filter((r) => r.verdict === 'DEGRADES').length
  const breaks = rows.filter((r) => r.verdict === 'BREAKS').length
  const dailyBreaks = rows.filter((r) => r.daily && r.verdict === 'BREAKS').length
  const withBackend = rows.filter((r) => r.dynamic_state !== 'no-backend').length
  const mounted = rows.filter((r) => r.dynamic_state === 'mounted').length
  const broken = summary.brokenAtMount ?? []
  const tw = summary.twMax != null && summary.twWorst ? `${summary.twMax} ms (${summary.twWorst})` : 'n/a'
  return `VERDICT: DOCTOR ${clean}/${n} clean, ${degrades} degrade, ${breaks} break in the fleet (${dailyBreaks}/${summary.daily} daily); module.json ${summary.metaLiteral}/${n}; rewrites ${summary.rewrites.edits} edits in ${summary.rewrites.modules} modules; probe ${mounted}/${withBackend} mounted, ${broken.length} broken at mount [${broken.join(', ')}]; tailwind max ${tw}`
}

export const failVerdict = (reason) => `VERDICT: FAIL — ${reason}`
