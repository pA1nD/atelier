// doctor/rules/static.mjs — runs every catalogue rule's `detect.static` over a module's walked files
// (DESIGN §2). Pure over the file texts: no process, no network; reads only through walk.mjs.
//
//   analyzeModule(entry, {operatorKeys, fs})  → StaticResult (below); entry = walk.mjs moduleEntry
//   analyzeFiles(id, files, opts)             the same over in-memory files [{rel, kind, text}] — tests
//   detectInText(text, {rule, kind, file, module}) → findings for ONE rule over one text — tests per rule
//   runStatic({id, dir, envKeys})             lane C's entry: analyzeModule + static-only `cells`
//   cellsOf(s, probe, tw)                     {<rule id>: count} through every rule's count()
//
// StaticResult (what catalogue `count(s, …)` and lane C read):
//   { id, dir, hasFrontend, hasBackend, hasModuleJson, operatorKeys,
//     files: {source, client, subfolderClient:[rel]},
//     greps: {backend:{<RX key>:n}, frontend:{…}},         seed semantics: backend = backend.js + every
//                                                          non-client source file; frontend = walkJsxFiles
//     env: {KEY: class}, spawn:[bin], ctxModule:[id], crossModule:[id], relImportsBackend:n,
//     mobile: {vh100, h_screen, fixed_bottom, small_input},
//     meta: {declared, literal, computed, error, keys, chrome, isChrome, hidden, eager, line},
//     moduleJson: {…}|null, metaDropped:[{key, rule, reason}],
//     existingModuleJson: {present, ok, dropped, invalid, error?},
//     sqlite: {opens, unguarded}, scope: {found, line, ctxName, routerName}|null,
//     configKeys: {operator, config, shell, laptop},
//     findings: [{rule, severity, file, line, col, evidence, answer, scope?, key?, rewrite?:{to}}],
//     rewrites: [{file, rule, line, from, to}], rewriteSkipped: [{file, rule, line, reason}],
//     rewritten: {<rel>: text} }
import nodeFs from 'node:fs'
import path from 'node:path'
import { RULES, RULE_BY_ID, RX, SPAWN, CTXMOD, REL_IMPORT, MOBILE, ENVREAD, SQL_VERBS, SQLITE_GUARD } from './catalogue.mjs'
import { walkJsxFiles, walkSourceFiles, moduleEntry } from './walk.mjs'
import { scan, findMountRoutes, lineColOf } from './scope.mjs'
import { classifyEnv, configKeysOf } from './env.mjs'
import { metaOf, moduleJsonOf, checkExistingModuleJson } from './meta.mjs'
import { rewriteBackend } from './rewrite.mjs'

const count = (rx, s) => { const re = new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : rx.flags + 'g'); let n = 0; while (re.exec(s)) n++; return n }
const lineText = (text, index) => { const a = text.lastIndexOf('\n', index - 1) + 1; let b = text.indexOf('\n', index); if (b < 0) b = text.length; return text.slice(a, b).trim().slice(0, 160) }
const fileMatches = (want, kind) => want === 'all' || want === kind

// detectRule(rule, text, {kind, file, module, scanned, span, operatorKeys}) → findings for one rule over one text
function detectRule(rule, text, ctx) {
  const out = []
  for (const entry of rule.detect?.static || []) {
    if (!fileMatches(entry.files, ctx.kind)) continue
    if (entry.scope && ctx.kind !== 'backend') continue
    const re = new RegExp(entry.re.source, entry.re.flags.includes('g') ? entry.re.flags : entry.re.flags + 'g')
    let m
    while ((m = re.exec(text))) {
      if (m[0] === '') { re.lastIndex++; continue }
      const index = m.index
      let scope = 'module'
      if (ctx.kind === 'backend' && ctx.span) scope = index >= ctx.span.bodyStart && index < ctx.span.bodyEnd ? 'mountRoutes' : 'outside-mountRoutes'
      else if (ctx.kind === 'backend') scope = 'outside-mountRoutes'
      if (entry.scope && entry.scope !== scope) continue
      let key
      if (entry.env) {
        key = m[1] || m[2]
        if (!entry.env.includes(classifyEnv(key, ctx.operatorKeys))) continue
      }
      const { line, col } = lineColOf(text, index)
      const c = entry.classify ? entry.classify({ match: m, key, index, line, lineText: lineText(text, index), text, scanned: ctx.scanned, file: ctx.file, scope, module: ctx.module }) : {}
      if (c?.skip) continue
      const ev = lineText(text, index)
      const f = {
        rule: rule.id, severity: c?.severity ?? entry.severity ?? rule.severity,
        file: ctx.file, line, col, evidence: ev, excerpt: ev,
        answer: c?.answer ?? entry.answer ?? rule.answer,
      }
      if (entry.scope) f.scope = scope
      if (key) f.key = key
      out.push(f)
    }
  }
  return out
}

export function detectInText(text, { rule, kind = 'backend', file = kind === 'backend' ? 'backend.js' : 'frontend.jsx', module = 'app', operatorKeys = new Set() } = {}) {
  const r = typeof rule === 'string' ? RULE_BY_ID[rule] : rule
  if (!r) throw new Error(`unknown rule ${rule}`)
  const scanned = scan(text)
  const span = kind === 'backend' ? findMountRoutes(text, scanned) : null
  return detectRule(r, text, { kind, file, module, scanned, span, operatorKeys })
}

// analyzeFiles(id, files, opts) — files: [{rel, kind:'backend'|'frontend', text}]; opts.moduleJson: the
// folder's module.json check (meta.mjs checkExistingModuleJson) or undefined
export function analyzeFiles(id, files, { operatorKeys = new Set(), moduleJson = { present: false }, hasFrontend, hasBackend } = {}) {
  const r = {
    id, hasFrontend: hasFrontend ?? files.some((f) => f.rel === 'frontend.jsx'), hasBackend: hasBackend ?? files.some((f) => f.rel === 'backend.js'),
    operatorKeys,
    files: { source: files.length, client: files.filter((f) => f.kind === 'frontend').length, subfolderClient: files.filter((f) => f.kind === 'frontend' && f.rel.includes('/')).map((f) => f.rel) },
    greps: { backend: {}, frontend: {} }, env: {}, spawn: [], ctxModule: [], crossModule: [], relImportsBackend: 0,
    mobile: {}, meta: { declared: false, literal: false, computed: false, error: null, keys: [], chrome: null, isChrome: false, hidden: false, eager: false, line: 0 },
    moduleJson: null, metaDropped: [], existingModuleJson: moduleJson, sqlite: { opens: 0, unguarded: 0 }, scope: null,
    configKeys: null, findings: [], rewrites: [], rewriteSkipped: [], rewritten: {},
  }
  for (const f of files) {
    const text = f.text
    const bucket = r.greps[f.kind]
    for (const [k, rx] of Object.entries(RX)) { const n = count(rx, text); if (n) bucket[k] = (bucket[k] || 0) + n }
    let mm
    const env = new RegExp(ENVREAD.source, 'g')
    while ((mm = env.exec(text))) { const k = mm[1] || mm[2]; r.env[k] = classifyEnv(k, operatorKeys) }
    const sp = new RegExp(SPAWN.source, 'g')
    while ((mm = sp.exec(text))) { const bin = mm[3].split(/\s/)[0]; if (SQL_VERBS.test(bin)) continue; if (!r.spawn.includes(bin)) r.spawn.push(bin) }
    const cm = new RegExp(CTXMOD.source, 'g')
    while ((mm = cm.exec(text))) { const mid = mm[3] ? 'ctx.id' : mm[2]; if (!r.ctxModule.includes(mid)) r.ctxModule.push(mid) }
    if (f.kind === 'backend') {
      r.relImportsBackend += count(REL_IMPORT, text)
      const opens = count(RX.sqlite_open, text)
      r.sqlite.opens += opens
      if (opens && !SQLITE_GUARD.test(text)) r.sqlite.unguarded += opens
    } else {
      for (const [k, rx] of Object.entries(MOBILE)) { const n = count(rx, text); if (n) r.mobile[k] = (r.mobile[k] || 0) + n }
    }
    // the rules
    const scanned = scan(text)
    const span = f.kind === 'backend' ? findMountRoutes(text, scanned) : null
    if (f.rel === 'backend.js') r.scope = span ? { found: true, line: span.line, ctxName: span.ctxName, routerName: span.routerName } : { found: false }
    const ctx = { kind: f.kind, file: f.rel, module: id, scanned, span, operatorKeys }
    for (const rule of RULES) r.findings.push(...detectRule(rule, text, ctx))
    // the rewrites (backend files only; the finding on an edited line carries `rewrite.to`)
    if (f.kind === 'backend') {
      const rw = rewriteBackend(text)
      for (const e of rw.edits) {
        r.rewrites.push({ file: f.rel, ...e })
        for (const fd of r.findings) if (fd.file === f.rel && fd.rule === e.rule && fd.line === e.line && !fd.rewrite) fd.rewrite = { to: e.to }
      }
      for (const s of rw.skipped) r.rewriteSkipped.push({ file: f.rel, ...s })
      if (rw.edits.length) r.rewritten[f.rel] = rw.text
    }
    // meta (frontend.jsx only)
    if (f.rel === 'frontend.jsx') {
      const meta = metaOf(text)
      r.meta = { ...meta, chrome: meta.meta.chrome ?? null, isChrome: !!meta.meta.isChrome, hidden: !!meta.meta.hidden, eager: !!meta.meta.eager }
      delete r.meta.meta
      if (meta.literal) {
        const mj = moduleJsonOf(meta.meta)
        r.moduleJson = mj.json
        r.metaDropped = mj.dropped
        for (const d of mj.dropped) r.findings.push({ rule: d.rule, severity: RULE_BY_ID[d.rule].severity, file: f.rel, line: meta.line, col: 1, evidence: `meta.${d.key}`, answer: d.reason, key: d.key })
        if (moduleJson.present) r.findings.push({ rule: 'N10', severity: 'note', file: f.rel, line: meta.line, col: 1, evidence: 'export const meta beside module.json', answer: 'module.json is the truth; the meta is ignored' })
        else r.findings.push({ rule: 'N10', severity: 'note', file: f.rel, line: meta.line, col: 1, evidence: `export const meta {${meta.keys.join(', ')}}`, answer: 'module.json generated from the literal meta (rules/meta.mjs)' })
      } else if (meta.computed) {
        r.findings.push({ rule: 'N10', severity: 'degrades', file: f.rel, line: meta.line, col: 1, evidence: `export const meta — not a literal${meta.error ? ` (${meta.error})` : ''}`, answer: 'no module.json can be generated from a computed meta — write it by hand: {name, icon, group, primary, color}' })
      }
    }
  }
  r.crossModule = r.ctxModule.filter((x) => x !== 'ctx.id' && x !== id)
  if (moduleJson.present) {
    for (const key of moduleJson.dropped || []) r.findings.push({ rule: 'N11', severity: 'note', file: 'module.json', line: 1, col: 1, evidence: `"${key}"`, answer: RULE_BY_ID.N11.answer, key })
    if (moduleJson.ok === false) r.findings.push({ rule: 'N11', severity: 'breaks-in-fleet', file: 'module.json', line: moduleJson.error.line, col: moduleJson.error.col, evidence: moduleJson.error.message, answer: moduleJson.error.hint })
  }
  for (const rel of r.files.subfolderClient) r.findings.push({ rule: 'N7', severity: 'note', file: rel, line: 1, col: 1, evidence: rel, answer: RULE_BY_ID.N7.answer })
  r.configKeys = configKeysOf(r.env, operatorKeys)
  for (const f of r.findings) if (f.excerpt === undefined) f.excerpt = f.evidence
  return r
}

// runStatic({id, dir, envKeys}) — lane C's entry (report/lanes.mjs): the StaticResult plus static-only `cells`
export async function runStatic({ id, dir, envKeys = new Set() }) {
  const entry = moduleEntry(dir)
  if (id) entry.id = id
  const r = analyzeModule(entry, { operatorKeys: envKeys })
  r.cells = cellsOf(r)
  return r
}

export function analyzeModule(entry, { operatorKeys = new Set(), fs = nodeFs } = {}) {
  const clientFiles = entry.hasFrontend ? walkJsxFiles(entry.dir) : []
  const files = walkSourceFiles(entry.dir).map((abs) => ({
    rel: path.relative(entry.dir, abs),
    kind: abs.endsWith('backend.js') || !clientFiles.includes(abs) ? 'backend' : 'frontend',
    text: fs.readFileSync(abs, 'utf8'),
  }))
  const r = analyzeFiles(entry.id, files, { operatorKeys, moduleJson: checkExistingModuleJson(entry.dir, fs), hasFrontend: entry.hasFrontend, hasBackend: entry.hasBackend })
  r.dir = entry.dir
  r.hasModuleJson = entry.hasModuleJson
  return r
}

// cellsOf(s, probe, tw) → {<rule id>: count} for every catalogue rule
export function cellsOf(s, probe = null, tw = null) {
  const cells = {}
  for (const rule of RULES) cells[rule.id] = rule.count(s, probe, tw) || 0
  return cells
}
