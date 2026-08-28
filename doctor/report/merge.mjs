// doctor/report/merge.mjs — one module's report.json (DESIGN §5): the static findings (lane A) and the
// probe's hook observations (lane B) merged into one findings list, every finding carrying its rule's
// first-class 2.0 answer; the CSV cells; the config-key manifest (names only); the verdict. Pure.
//
// A probe observation becomes a finding of the rule whose `detect.runtime` names its kind — the
// classification of the ambiguous kinds (an egress is N4, N5 or I2; an env read is N2, N2op, N3 or D13;
// a write outside dataDir is N1 or D13) is the seed report.mjs's row lambdas, ported here as
// `OBSERVATIONS`. A catalogue rule may override it with `match.runtime(obs, ctx) → boolean`.
// "mounted" is never evidence of anything (RESULT surprise 6): only `state ∉ OK_STATES` (R1) reads the state.
import { RULE_COLUMN_IDS } from './columns.mjs'
import { SEED_RULE_BY_ID, NODE_NOISE, SHELL_KEYS, LAPTOP_KEYS, ROW_W_ENV, IMAGE_BINS } from './seed-rules.mjs'
import { moduleVerdict, isBrokenState } from './verdict.mjs'

const text = (o) => (typeof o === 'string' ? o : o == null ? '' : String(o?.target ?? o?.key ?? o?.bin ?? o?.path ?? o?.signal ?? o?.addr ?? o?.address ?? (typeof o === 'object' && 'code' in o ? o.code ?? '' : JSON.stringify(o))))
const strings = (list) => (Array.isArray(list) ? list.map(text) : list == null || list === false ? [] : [text(list)])

/**
 * The probe's runtime object in the SEED's shape — string lists per kind (`envReads` = key names, `listens` =
 * targets, `spawns` = binaries, `writesOutside`/`selfData` = shortened paths, `egress` = targets,
 * `signalHandlers` = names, `processExit` = false or the exit codes) plus `state`, `error` (from `died`),
 * `resources`, `teardown`, `stop`, `rss`. The catalogue's `count(s, p, tw)` and this file's classifier read
 * this view; report.json keeps the probe's own object. Lane B's `[{key, n, frame}]` / `[{target, frame}]`
 * records and the seed's plain strings both normalise to it.
 */
export function seedShape(runtime) {
  if (!runtime) return null
  const exits = strings(runtime.processExit)
  const err = runtime.error ?? runtime.died?.error ?? null
  return {
    state: runtime.state,
    error: err && typeof err === 'object' ? `${err.message ?? ''}${err.file ? ` (${err.file}:${err.line ?? '?'}${err.col ? ':' + err.col : ''})` : ''}` : err,
    resources: runtime.resources ?? null,
    teardown: runtime.teardown ?? null,
    stop: runtime.stop ?? null,
    rss: runtime.rss ?? null,
    envReads: strings(runtime.envReads),
    listens: strings(runtime.listens),
    spawns: strings(runtime.spawns),
    writesOutside: strings(runtime.writesOutside),
    selfData: strings(runtime.selfData),
    egress: strings(runtime.egress),
    signalHandlers: strings(runtime.signalHandlers),
    processExit: exits.length ? exits : false,
    ctxModule: Array.isArray(runtime.ctxModule) ? runtime.ctxModule.map((o) => (typeof o === 'string' ? o : o?.id ?? text(o))) : [],
  }
}
const isLoopback = (s) => /(^|\/\/|@)(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(s)      // a peer app IS a Unix socket in 2.0: `unix:` is never N5
const isInternet = (s) => /^https?:\/\//.test(s) && !isLoopback(s)
const isHomePath = (s) => /(^|['"\s])~\//.test(s) || /\/Users\/|\/home\/|<home>|<scratch>/.test(s)
const isAppPath = (s) => /<app>/.test(s)
const binOf = (s) => s.split(/\s/)[0].split('/').pop()
const LAPTOP_SOCKET = /^unix:(?:~\/|\/Users\/|\/home\/)/      // a Unix-socket connect into the laptop's home (D13)

/**
 * kind → the rules an observation of that kind can belong to. `excerpt` renders the finding text,
 * `severity` (optional) overrides the rule's default per observation, `answer` (optional) the rule's answer,
 * `when` (optional) filters.
 * The probe records `runtime.<kind>` as an array of strings or `{…}` objects (DESIGN §4).
 */
export const OBSERVATIONS = Object.freeze({
  listens: [{ rule: 'D2', excerpt: (s) => `listen ${s}` }],
  spawns: [{
    rule: 'D12', excerpt: (s) => `spawn ${s}`,
    severity: (s, c) => (c.imageBins.has(binOf(s)) ? 'note' : undefined),
    answer: (s, c) => (c.imageBins.has(binOf(s)) ? `\`${binOf(s)}\` is in the image (IMAGE_BINS)${/ <app>\//.test(s) ? '; the spawned script is a walked file — its own habits (a listen() is D2) are judged by the static rules' : ''}` : undefined),
  }],
  envReads: [
    { rule: 'N3', when: (k, c) => c.shellKeys.has(k), excerpt: (k) => `process.env.${k}` },
    { rule: 'D13', when: (k, c) => c.laptopKeys.has(k), excerpt: (k) => `process.env.${k}`, severity: () => 'degrades' },
    { rule: 'N2', when: (k, c) => !c.nodeNoise.has(k) && !c.shellKeys.has(k) && !c.rowW.has(k) && !c.laptopKeys.has(k), excerpt: (k) => `process.env.${k}` },
    { rule: 'N2op', when: (k, c) => c.envKeys.has(k), excerpt: (k) => `process.env.${k} (operator .env key)` },
  ],
  egress: [
    { rule: 'N4', when: (s) => /\/api\/global\//.test(s), excerpt: (s) => `egress ${s}` },
    { rule: 'N5', when: (s) => isLoopback(s), excerpt: (s) => `egress ${s}` },
    { rule: 'D13', when: (s) => LAPTOP_SOCKET.test(s), excerpt: (s) => `egress ${s} (a laptop socket)`, severity: () => 'breaks-in-fleet' },
    { rule: 'I2', when: (s) => isInternet(s), excerpt: (s) => `egress ${s}` },
  ],
  writesOutside: [
    { rule: 'N1', when: (s) => isAppPath(s), excerpt: (s) => `write ${s} (refused EACCES)` },
    { rule: 'D13', when: (s) => !isAppPath(s), excerpt: (s) => `write ${s} (refused EACCES)`, severity: (s) => (isHomePath(s) ? 'breaks-in-fleet' : undefined) },
  ],
  selfData: [{ rule: 'N1', excerpt: (s) => `touches ${s}` }],
  signalHandlers: [{ rule: 'N8', excerpt: (s) => `process.on('${s}')` }],
  processExit: [{ rule: 'N8', excerpt: (s) => `process.exit(${s === 'true' ? '' : s})` }],
})

const RUNTIME_FILE = '<runtime>'

function ruleOf(rules, id) {
  return rules.find((r) => r.id === id) ?? SEED_RULE_BY_ID[id] ?? { id, family: 'NEW', title: id, severity: 'note', answer: '' }
}

const baseSeverity = (rule) => (typeof rule.severity === 'string' ? rule.severity.split(/[;\s]/)[0] : 'note')

/** Probe observations → findings. `runtime` is the §4 object; missing arrays are empty. */
export function runtimeFindings(runtimeIn, rules = [], { envKeys = new Set(), constants = {} } = {}) {
  const runtime = seedShape(runtimeIn)
  if (!runtime) return []
  const c = {
    envKeys, imageBins: constants.IMAGE_BINS ?? IMAGE_BINS, nodeNoise: constants.NODE_NOISE ?? NODE_NOISE,
    shellKeys: constants.SHELL_KEYS ?? SHELL_KEYS, laptopKeys: constants.LAPTOP_KEYS ?? LAPTOP_KEYS, rowW: constants.ROW_W_ENV ?? ROW_W_ENV,
  }
  const out = []
  const push = (rule, excerpt, severity, answer) => out.push({ rule: rule.id, severity: severity ?? baseSeverity(rule), file: RUNTIME_FILE, line: 0, excerpt, answer: answer ?? rule.answer ?? '' })
  for (const [kind, targets] of Object.entries(OBSERVATIONS)) {
    let obs = kind === 'spawns' && Array.isArray(runtimeIn.spawns) ? runtimeIn.spawns : runtime[kind]     // lane B's spawn records carry the script
    if (obs == null) continue
    if (!Array.isArray(obs)) obs = obs === false ? [] : [obs]
    for (const o of obs) {
      const s = kind === 'spawns' && o?.script ? `${text(o)} ${o.script}` : text(o)      // the spawned script beside the binary
      for (const t of targets) {
        const rule = ruleOf(rules, t.rule)
        const match = rule.match?.runtime ? rule.match.runtime(o, { kind, ...c }) : t.when ? t.when(s, c) : true
        if (!match) continue
        push(rule, t.excerpt(s), t.severity?.(s, c), t.answer?.(s, c))
      }
    }
  }
  if (isBrokenState(runtime.state)) {
    const r = ruleOf(rules, 'R1')
    push(r, `${runtime.state}${runtime.error ? ' — ' + (typeof runtime.error === 'string' ? runtime.error : runtime.error.message ?? JSON.stringify(runtime.error)) : ''}`)
  }
  const resident = residentCount(runtime.resources)
  if (resident > 0) push(ruleOf(rules, 'R2'), `resident: ${Object.entries(runtime.resources).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  if (runtime.state === 'mounted' && (runtime.teardown === false || runtime.stop?.killed)) {
    const r = ruleOf(rules, 'R3')
    push(r, runtime.stop?.killed ? 'killed at the drain deadline (SIGKILL after 2 s)' : 'no teardown returned from mountRoutes')
  }
  return out
}

export const residentCount = (resources) => (resources && typeof resources === 'object' ? Object.values(resources).reduce((n, v) => n + (Number(v) || 0), 0) : 0)

/** Static findings normalised: every finding has file, line, excerpt, severity and its rule's answer. */
export function staticFindings(st, rules = []) {
  return (st?.findings ?? []).map((f) => {
    const rule = ruleOf(rules, f.rule)
    return { rule: f.rule, severity: f.severity ?? baseSeverity(rule), file: f.file ?? '', line: f.line ?? 0, excerpt: f.excerpt ?? '', answer: f.answer ?? rule.answer ?? '', ...(f.rewrite ? { rewrite: f.rewrite } : {}), ...(f.skipped ? { skipped: f.skipped } : {}) }
  })
}

/**
 * The CSV cells. A catalogue rule's `count(static, probe, tw)` is the cell (seed semantics per id);
 * without one, lane A's `static.cells[id]`; the runtime ids R1–R3 fall back to the probe object.
 */
export function cellsOf({ rules = [], static: st, runtime: runtimeIn, tailwind }) {
  const runtime = seedShape(runtimeIn)
  const cells = {}
  const ids = [...RULE_COLUMN_IDS]
  for (const r of rules) if (!ids.includes(r.id)) ids.push(r.id)
  for (const id of ids) {
    const rule = rules.find((r) => r.id === id)
    let v
    if (typeof rule?.count === 'function') v = rule.count(st ?? {}, runtime, tailwind ?? {})
    else if (st?.cells && id in st.cells) v = st.cells[id]
    else if (id === 'R1') v = isBrokenState(runtime?.state) ? 1 : 0
    else if (id === 'R2') v = residentCount(runtime?.resources) > 0 ? 1 : 0
    else if (id === 'R3') v = runtime?.state === 'mounted' && (runtime.teardown === false || runtime.stop?.killed) ? 1 : 0
    cells[id] = Number(v) || 0
  }
  return cells
}

/** `{operator, config, shell, laptop}` — key NAMES only — from lane A's `static.env` (KEY → class) and the probe's env reads. */
export function configKeysOf({ static: st, runtime, classifyEnv, envKeys = new Set(), constants = {} }) {
  const nodeNoise = constants.NODE_NOISE ?? NODE_NOISE
  const classes = { operator: new Set(), config: new Set(), shell: new Set(), laptop: new Set() }
  const put = (k, cls) => {
    if (cls === 'operator' || cls === 'operator-env') classes.operator.add(k)
    else if (cls === 'shell' || (cls === 'shell-published' && (constants.SHELL_KEYS ?? SHELL_KEYS).has(k))) classes.shell.add(k)     // APP_ID/ATELIER_WORKER/TMPDIR are row W, not the portal's
    else if (cls === 'laptop') classes.laptop.add(k)
    else if (cls === 'config' || cls === 'other') classes.config.add(k)
  }
  for (const [k, cls] of Object.entries(st?.env ?? {})) put(k, cls)
  for (const k of seedShape(runtime)?.envReads ?? []) {
    if (nodeNoise.has(k)) continue
    put(k, classifyEnv ? classifyEnv(k, envKeys) : envKeys.has(k) ? 'operator' : SHELL_KEYS.has(k) ? 'shell' : ROW_W_ENV.has(k) ? 'shell-published' : LAPTOP_KEYS.has(k) ? 'laptop' : 'config')
  }
  for (const k of classes.config) if (envKeys.has(k)) { classes.config.delete(k); classes.operator.add(k) }
  return Object.fromEntries(Object.entries(classes).map(([c, s]) => [c, [...s].sort()]))
}

/**
 * One module → report.json (DESIGN §5).
 * @param {{ id:string, dir:string, daily:boolean, static?:object, meta?:object, rewrites?:Array<{file:string, edits:Array<{line:number, from:string, to:string}>, leftover?:string[]}>,
 *   runtime?:object, tailwind?:{coldMs?:number, longLines?:number}, rules?:Array, envKeys?:Set<string>, classifyEnv?:Function, constants?:object }} m
 */
export function mergeModule(m) {
  const { id, dir, daily = false, static: st = {}, meta = {}, rewrites = [], runtime, tailwind, rules = [], envKeys = new Set(), classifyEnv, constants } = m
  const findings = [...staticFindings(st, rules), ...runtimeFindings(runtime, rules, { envKeys, constants })]
  const flatRewrites = rewrites.flatMap((r) => (r.edits ?? []).map((e) => ({ file: r.file, line: e.line, from: e.from, to: e.to })))
  const rewriteLeftover = [...new Set(rewrites.flatMap((r) => r.leftover ?? []))]     // self-pathed data/ the N1 rewrite did not reach (file:line) — the rewrite is partial
  const cells = cellsOf({ rules, static: st, runtime, tailwind })
  const configKeys = configKeysOf({ static: st, runtime, classifyEnv, envKeys, constants })
  const verdict = moduleVerdict({ module: id, findings, runtime, rewrites: flatRewrites })
  return {
    module: id,
    dir,
    daily,
    files: { source: st.files?.source ?? 0, client: st.files?.client ?? 0, subfolderClient: Array.isArray(st.files?.subfolderClient) ? st.files.subfolderClient.length : st.files?.subfolderClient ?? 0 },
    meta: { declared: !!meta.declared, literal: !!meta.literal, error: meta.error ?? null, keys: meta.keys ?? [], dropped: meta.dropped ?? [] },
    moduleJson: meta.moduleJson ?? null,
    configKeys,
    findings,
    rewrites: flatRewrites,
    rewriteLeftover,
    runtime: runtime ?? { state: 'skipped' },
    tailwind: { coldMs: tailwind?.coldMs ?? null, longLines: tailwind?.longLines ?? 0 },
    cells,
    verdict,
  }
}
