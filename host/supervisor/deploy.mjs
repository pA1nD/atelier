// host/supervisor/deploy.mjs — the release protocol (DESIGN §10.3; LEDGER R-DEPLOY v2 "apps deploy like
// releases, no automatic rollback"). One verb, `atelier deploy <slug> -m "<message>"`, is four steps:
//
//   1 commit     the DEV tree committed as uid 1000 (skipped for a rollback: `commit` given = an older commit)
//   2 rehearsal  prod untouched: copy prod data → rehearsal/<inst>/data (cp -a, > 1 GiB → skipped, partial) →
//                export the commit (git archive as 1000 | tar -x as root → prod/<inst>/<commit12>, 0:<uid>) →
//                install from the lockfile (freeze.py --dest) → build the three artefacts into rev-N → run
//                module.json `deploy` (the hook, as the worker, DATA_DIR = the copy) → boot a worker against the
//                copy → probe → `test` → `smoke` (ATELIER_SOCK = the rehearsal socket) → stop, delete the copy.
//                Red = any non-zero exit, timeout, READY failure or 5xx — ONE `build` report, nothing deployed.
//   3 gate       requests to prod held ≤ 10 s (then the shell's waking bytes): drain (inflight 0, ≤ 2 s) → stop
//                old → backup (cp -a of prod data, last 3 / ≤ 1 GiB) → migrate (the hook on PROD data) → start
//                → probe → release. A failure here leaves the app DOWN with ONE `worker` report naming the
//                backup — no automatic rollback, no automatic restore (a human or Bayard decides).
//   4 record     `current` → the new rev, revision.json.prod, modulesChanged, the release row (the host's
//                releases.jsonl first, then the spine — a 404/5xx there never blocks), metrics, agent.log.
//
// Every line the host or the CLI prints about a release lives in MESSAGES below — one source of truth the
// skill quotes verbatim (lane K hands wording changes here, never a second copy).
import http from 'node:http'
import path from 'node:path'
import { archiveSpec, commitAll, resolveCommit, gitInit } from './lastgood.mjs'
import { formatHint, classifyWorkerFailure } from './bundle.mjs'
import { REL, commit12, backupId, parseBackupId, newReleaseId, cpSpec, rmSpec, duSpec, extractSpec, parseKb, ownTree, pruneBackups, backupFeasible, mb, deferred, RELEASES_KEEP, COMMIT_RE, DATA_CAP_BYTES, sockName } from './slots.mjs'
import { run } from '../worker/install.mjs'
import { backupPlan, rehearsalPlan, prodPlan, applyJail, jailPlan } from '../worker/jail.mjs'

export const DEPLOY_TIMING = Object.freeze({
  commitMs: 5000, rehearsalMs: 240_000, copyMs: 30_000, exportMs: 60_000, installMs: 180_000, buildMs: 60_000,
  hookMs: 60_000, bootMs: 8000, probeMs: 5000, testMs: 60_000, smokeMs: 30_000,
  drainMs: 2000, backupMs: 30_000, migrateMs: 60_000, startMs: 8000, recordMs: 30_000,
})
export const KINDS = Object.freeze(['deploy', 'rollback', 'adopt', 'config', 'restore'])

export const cut = (s, n) => String(s ?? '').split('\n')[0].slice(0, n)

// MESSAGES — every deploy word the host or the CLI prints. LANES-DEPLOY-MESSAGES.md is the source; the skill and the
// drills quote these verbatim. Each app-error pair must fit the wire: message ≤ 200 chars on its FIRST line (the
// spine pastes `messageHead(message, 200)` and nothing after it), hint ≤ 200 chars (validateAppError refuses a longer
// one and the WHOLE report is lost). `cut(s, n)` = the first line of s, cut to n chars.
export const MESSAGES = {
  // ── app-error reports (kind, message, hint). The spine pastes:
  //      app-error <slug> rev <N> <kind> at <at>
  //      <file>:<line>:<col> <message>          ← "(no file)" when the report carries no file
  //      fix: <hint>
  //    EVERY report below carries rev = row.prod?.rev ?? 0 — the PROD rev, never the dev/rehearsal counter (see "the rev").
  devBuild: {                                    // a DEV build failure (a save): today's build report with the head `dev:`
    kind: 'build',
    message: (error) => `dev: ${cut(error, 195)}`,            // file/line/col as today; hint = bundle.mjs's classification line, unchanged
  },
  rehearsalRed: {                                // D15: rehearsal red → ONE build report, prod untouched
    kind: 'build',
    message: (step, error) => `rehearsal red at ${step}: ${cut(error, 200 - 19 - step.length)}`,
    hint: (slug, N, c12) => `nothing deployed — ${slug} stays on rev ${N} (${c12}); fix and run atelier deploy again`,
  },
  deployFailed: {                                // D10/D15: a failure AFTER the gate → ONE worker report naming the backup
    kind: 'worker',
    message: (c12, step, error, slug) => `deploy of ${c12} failed at ${step}: ${cut(error, 200 - 46 - step.length - slug.length)} — ${slug} is DOWN`,
    hint: (N, MB, slug, id) => `rev ${N} data (${MB} MB) backed up, never auto-restored: atelier restore ${slug} ${id}, or fix forward and deploy`,
    hintNoBackup: (slug) => `no backup (--no-backup): fix forward and deploy, or ask the operator — ${slug} answers 503 until then`,
  },
  // ── the one verdict line the CLI prints (the stream's {t:'verdict'} rendered; exit 0 / 2 / 3)
  verdict: {
    green:  (verb, slug, N, c12, url) => `${verb} green: ${slug} rev ${N} commit ${c12} live — ${url}`,
    red:    (verb, step, error, slug, N, c12) => `${verb} RED at ${step}: ${error} — nothing deployed, ${slug} stays on rev ${N} (${c12})`,
    failed: (verb, step, error, slug, id) => `${verb} FAILED at ${step}: ${error} — ${slug} is DOWN, backup ${id} kept`,
    failedNoBackup: (verb, step, error, slug) => `${verb} FAILED at ${step}: ${error} — ${slug} is DOWN, no backup (--no-backup)`,
    restoreGreen:  (slug, N, id, url) => `restore green: ${slug} rev ${N} data from backup ${id} live — ${url}`,
    restoreFailed: (step, error, slug, id) => `restore FAILED at ${step}: ${error} — ${slug} is DOWN, backup ${id} kept`,
  },
  // ── step lines the CLI prints while the stream runs (one per {t:'step'}; the note when there is one)
  step: {
    ok:   (name, ms, note) => `  ${name} ok ${ms} ms${note ? ` — ${note}` : ''}`,
    fail: (name, ms, error) => `  ${name} FAILED ${ms} ms — ${error}`,
    notes: {
      commit:        (c12, message) => `${c12} "${message}"`,
      commitNothing: (c12) => `nothing to commit — HEAD ${c12} is the release`,
      commitGiven:   (c12) => `${c12} (rollback: no commit, no hook)`,
      copy:          (MB) => `${MB} MB of prod data copied`,
      copySkipped:   (GB) => `partial — hook ran on empty data (${GB} GB > 1 GiB cap)`,
      hookNone:      () => `no "deploy" hook in module.json`,
      testNone:      () => `no "test" script in module.json`,
      smokeNone:     () => `no "smoke" script in module.json`,
      backup:        (id, MB) => `${id} (${MB} MB)`,
      backupSkipped: () => `skipped (--no-backup)`,
      gate:          (held) => `${held} request(s) held`,
    },
  },
  // ── refusals BEFORE anything runs (the verdict line carries them: RED at <step>)
  refuse: {
    backupImpossible: (why) => `backup impossible: ${why}`,   // why ∈ `prod data <GB> GB > 1 GiB` | `free space <GB> GB < 2 × <GB> GB` — or pass --no-backup
    inProgress:       () => `deploy in progress`,               // 409 body {"error":"deploy in progress"}
    unknownApp:       (slug) => `unknown app ${slug}`,          // 404 body {"error":"unknown app"}
    badCommit:        (commit) => `unknown commit ${commit}`,   // rollback to a commit git cannot resolve in the app's repo
    notDeployed:      () => `not deployed`,                     // prod 404 body {"error":"not deployed"} (a dev-only app on :1845)
  },
  // ── prod bodies (serve.mjs). The waking bytes are NOT here: they are shell/proxy.mjs's WAKING_BODY/WAKING_HEADERS, imported.
  body: {
    notDeployed: { error: 'not deployed' },                                          // 404
    down: (id) => ({ error: 'app down after a failed deploy', ...(id ? { backup: id } : {}) }),   // 503, no waking flag
  },
  // ── agent.log (the protocol table's lines; `<ISO> ` prefix as today)
  log: {
    step:    (slug, c12, message, step, ms, ok, error) => `[${slug}] deploy ${c12} "${message}": ${step} ${ok ? 'ok' : 'FAILED'} ${ms} ms${error ? ` — ${error}` : ''}`,
    live:    (slug, N, c12, ms) => `[${slug}] rev ${N} LIVE (prod) commit ${c12} in ${ms} ms`,
    red:     (slug, c12, step, error, N) => `[${slug}] deploy ${c12} RED at ${step}: ${error} — prod stays on rev ${N}`,
    failed:  (slug, c12, step, error, id) => `[${slug}] deploy ${c12} FAILED at ${step}: ${error} — DOWN, backup ${id ?? 'none'}`,
    adopt:   (slug, N, c12) => `[${slug}] adopt: rev ${N} (${c12}) committed — prod = the legacy tree until its first deploy`,
    config:  (slug, N, at) => `[${slug}] config release: rev ${N} restarted under the gate (config updated ${at})`,
    restore: (slug, id, ms) => `[${slug}] restore ${id} done in ${ms} ms`,
    devLive: (slug, N, ms) => `[${slug}] rev ${N} LIVE (dev) in ${ms} ms`,
    devFail: (slug, N, hint) => `[${slug}] rev ${N} FAILED (dev) ${hint}`,
  },
  // ── git
  git: {
    adoptMessage: (N) => `adopt: the tree serving rev ${N}`,
    gitignore: ['data/', '.env', '.env.*', 'node_modules/', 'CLAIM-REFUSED.txt', '.atelier'].join('\n') + '\n',
  },
  // ── the list verbs (one row per line, newest first)
  list: {
    release: (r) => `${r.at}  ${r.kind.padEnd(8)} ${r.verdict.padEnd(6)} rev ${String(r.rev ?? '-').padStart(3)}  ${(r.commit ?? '').slice(0, 12)}  ${r.message ? JSON.stringify(r.message) : ''}${r.backup ? `  backup ${r.backup}` : ''}${r.error ? `  ${r.error}` : ''}`,
    releasesNone: (slug) => `${slug}: no releases yet — atelier deploy ${slug} -m "first release"`,
    backup: (b) => `${b.id}  ${String(b.mb).padStart(6)} MB  rev ${b.rev}  ${b.at}`,
    backupsNone: (slug) => `${slug}: no backups (a backup is taken by every deploy that reaches the gate)`,
  },
  usage: `usage: atelier deploy <slug> -m "<what changed, one line>" [--no-backup]
       atelier rollback <slug> <commit>
       atelier releases <slug>
       atelier backups <slug>
       atelier restore <slug> <backup-id>`,
}
// host-side words that are not the chat's, the CLI's or the log's (the doors' error bodies, the config/restore reports)
export const HOST_MESSAGES = Object.freeze({
  unknownBackup: 'unknown backup',
  badMessage: 'message required (-m "<what changed, one line>", ≤ 1000 chars)',
  hostFault: 'host fault',
  configFailed: (slug, step, error) => ({ message: `config release failed at ${step}: ${cut(error, 160 - step.length)} — ${slug} is DOWN`, hint: `fix the config (PUT /v1/apps/<instance>/config): the host restarts ${slug} under the gate within one heartbeat — or deploy` }),
  restoreFailed: (slug, id, step, error) => ({ message: `restore of ${id} failed at ${step}: ${cut(error, 140 - step.length - id.length)} — ${slug} is DOWN`, hint: `the backup is untouched: atelier restore ${slug} ${id} again, or fix forward and deploy` }),
})

const tail = (s, n = 3) => String(s ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' | ')
const nowIso = (ms) => new Date(ms).toISOString()
const c12 = (c) => (c ? commit12(c) : 'none')
const gb = (bytes) => (bytes / 1024 / 1024 / 1024).toFixed(1)

/**
 * createDeployer(i) — the supervisor's internals (index.mjs hands them over): os, dirfd, fs, cfg, T, emit, report,
 * registrar, store, metrics, hostEnv, jail, install, hook, treeOk, company(), origin(), rel(), dot(), workerSpec,
 * startWorker, stopLive, buildArtefacts, prune, prodSlot, exportDir, withInstalling, later, onSwap, armIdle,
 * withGroupSync, checkModuleJson.
 *   .deploy(row, {message, commit?, by, noBackup, onStep}) → the verdict (never throws once started; 409 while one runs)
 *   .restore(row, backupId, {by, onStep}) → the verdict
 *   .configRelease(row) → the verdict (D16)
 *   .adopt(row) → the release row (D14)
 *   .releases(row) → [rows, newest first]   .backups(row) → [{id, at, rev, commit, bytes}, newest first]
 * Every app-error report here carries rev = row.prod?.rev ?? 0 — the PROD rev (the spine's coalescer keeps ONE running
 * rev per instance and drops lower ones as stale; a dev/rehearsal counter would silence every later prod error).
 */
export function createDeployer(i) {
  const { os, fs, T, emit, report, registrar, store, metrics, hostEnv = process.env } = i
  const D = () => T.deploy
  const exists = (p) => { try { fs.lstatSync(p); return true } catch { return false } }
  async function withBudget(p, ms) {
    let t
    try { return await Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej({ error: `timeout after ${ms} ms` }), ms) })]) } finally { clearTimeout(t) }
  }
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.() })
  const prodRev = (row) => row.prod?.rev ?? 0

  // --- root-side helpers (cp/rm/du as root with group 19999; plain processes on a laptop) ---
  async function copyInto(src, dst, ms) { const r = await run(os, cpSpec(src, dst, hostEnv), { timeoutMs: ms }); if (r.code !== 0) throw { error: `cp -a: ${tail(r.stderr) || `rc=${r.code ?? r.signal}`}` } }
  async function rmrf(p, ms = 60_000) { if (!exists(p)) return; const r = await run(os, rmSpec(p, hostEnv), { timeoutMs: ms }); if (r.code !== 0) throw { error: `rm -rf: ${tail(r.stderr) || `rc=${r.code ?? r.signal}`}` } }
  async function dirBytes(p) { if (!exists(p)) return 0; const r = await run(os, duSpec(p, hostEnv), { timeoutMs: 30_000 }); const kb = parseKb(r.stdout); return kb == null ? 0 : kb * 1024 }
  const dirEmpty = (p) => { try { return fs.readdirSync(p).length === 0 } catch { return true } }
  function applyPlan(row, plan, what) {
    if (!i.jail) { for (const s of plan) if (s.op === 'mkdir') { try { fs.mkdirSync(s.path, { recursive: true, mode: s.mode & 0o777 }) } catch {} } return }
    const r = applyJail(os, plan, (l) => emit(`[${row.slug}] ${l}`))
    if (!r.ok) { const f = r.results.at(-1); throw { error: `${what}: ${f.step.op} ${f.step.path ?? ''}: ${f.code}` } }
  }
  const readJsonMarker = (row, name) => { try { return JSON.parse(store.readMarker(row.instance, name)) } catch { return null } }

  // --- the export (rows A + T): git archive as uid 1000 piped into tar -x as root, then chmod-then-chown 0:<uid>
  async function exportCommit(row, commit, dest) {
    const git = os.spawn(archiveSpec({ appDir: row.dir, commit, home: i.cfg.gitHome }))
    const tar = os.spawn(extractSpec(dest, hostEnv))
    let gerr = '', terr = ''
    git.stderr?.on?.('data', (d) => { gerr += d }); tar.stderr?.on?.('data', (d) => { terr += d })
    git.stdout.on('error', () => {}); tar.stdin.on('error', () => {}); tar.stdout?.resume?.()
    git.stdout.pipe(tar.stdin)
    const exit = (c) => new Promise((res) => { c.on('exit', (code, sig) => res({ code, sig })); c.on('error', (e) => res({ code: -1, err: e.message })) })
    const [g, t] = await Promise.all([exit(git), exit(tar)])
    if (g.code !== 0) throw { error: `git archive ${commit12(commit)}: ${tail(gerr) || g.err || `rc=${g.code ?? g.sig}`}` }
    if (t.code !== 0) throw { error: `tar -x: ${tail(terr) || t.err || `rc=${t.code ?? t.sig}`}` }
    return ownTree(os, fs, dest, row.uid)
  }

  // --- the probe (≤ probeMs): /_atelier/health then module.json healthz ?? '/', both mount-relative, status < 500
  function probe(sock, healthz, ms) {
    const deadline = os.now() + ms
    const get = (p) => new Promise((resolve, reject) => {
      const left = Math.max(50, deadline - os.now())
      const req = http.request({ socketPath: sock, path: p, method: 'GET', headers: { 'x-atelier-user': 'host', 'x-atelier-name': 'host' } }, (r) => { r.resume(); resolve(r.statusCode) })
      req.setTimeout(left, () => req.destroy(new Error(`no answer within ${left} ms`)))
      req.on('error', (e) => reject({ error: `GET ${p}: ${e.message}` }))
      req.end()
    })
    return (async () => {
      const h = await get('/_atelier/health')
      if (h >= 500) throw { error: `GET /_atelier/health → ${h}` }
      const p = typeof healthz === 'string' && healthz.startsWith('/') && !healthz.split('/').includes('..') ? healthz : '/'
      const s = await get(p)
      if (s >= 500) throw { error: `GET ${p} → ${s}` }
      return { note: `GET ${p} → ${s}` }
    })()
  }

  // --- the rows the host keeps: releases.jsonl (0600, last 50) and backups.json (sizes)
  function releases(row) {
    const t = store.readMarker(row.instance, 'releases.jsonl')
    if (!t) return []
    return t.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).reverse()
  }
  async function recordRelease(row, rel) {
    const all = [...releases(row).reverse(), rel].slice(-RELEASES_KEEP)
    try { store.writeMarker(row.instance, 'releases.jsonl', all.map((r) => JSON.stringify(r)).join('\n') + '\n') } catch (e) { emit(`[${row.slug}] releases.jsonl: ${e.code ?? e.message}`) }
    if (registrar?.release) await withBudget(Promise.resolve(registrar.release(rel)), D().recordMs).catch((e) => emit(`[${row.slug}] release row ${rel.id}: ${e?.error ?? e?.message ?? e}`))
    return rel
  }
  function backups(row) {
    let names = []
    try { names = fs.readdirSync(i.dot(REL.backupRoot(row.instance))) } catch { return [] }
    const meta = readJsonMarker(row, 'backups.json') ?? {}
    return names.map((id) => { const p = parseBackupId(id); return p ? { id, at: nowIso(p.at), rev: p.rev, commit: p.commit, bytes: meta[id]?.bytes ?? null, mb: meta[id]?.bytes != null ? mb(meta[id].bytes) : null } : null }).filter(Boolean).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  }
  async function pruneOldBackups(row) {
    const rows = backups(row)
    const drop = pruneBackups(rows.map((r) => ({ id: r.id, at: Date.parse(r.at), bytes: r.bytes ?? 0 })))
    const meta = readJsonMarker(row, 'backups.json') ?? {}
    for (const id of drop) {
      try { await rmrf(i.dot(REL.backup(row.instance, id))); delete meta[id]; emit(`[${row.slug}] backup ${id} pruned`) } catch (e) { emit(`[${row.slug}] backup ${id} prune: ${e?.error ?? e?.message ?? e}`) }
    }
    if (drop.length) store.writeMarker(row.instance, 'backups.json', JSON.stringify(meta))
    return drop
  }
  async function takeBackup(row, { rev, commit }) {
    const src = i.dot(REL.prodData(row.instance))
    let at = os.now(), id = backupId(at, rev, commit), dst = i.dot(REL.backup(row.instance, id))
    while (exists(dst)) { at += 1000; id = backupId(at, rev, commit); dst = i.dot(REL.backup(row.instance, id)) }   // the id has second granularity: two releases of one rev inside a second never share a dir
    applyPlan(row, [...backupPlan(i.dot(REL.backupRoot(row.instance))), ...backupPlan(dst)], 'backup dir')
    await copyInto(src, dst, D().backupMs)
    const bytes = await dirBytes(dst)
    const meta = readJsonMarker(row, 'backups.json') ?? {}
    meta[id] = { bytes, rev, commit, at: nowIso(os.now()) }
    store.writeMarker(row.instance, 'backups.json', JSON.stringify(meta))
    return { id, bytes }
  }

  // --- the step recorder: one NDJSON line to the verb, one agent.log line, the ledger for the release row
  function recorder(row, { commit, message, onStep }) {
    const steps = []
    const R = { steps, commit }
    const rec = (name, t0, ok, note) => {
      const line = { t: 'step', name, ms: Math.max(0, Math.round(os.now() - t0)), ok }
      if (note) line.note = String(note)
      steps.push(line)
      emit(MESSAGES.log.step(row.slug, c12(R.commit), message ?? '', name, line.ms, ok, ok ? (note ?? '') : (note ?? '')))
      try { onStep?.(line) } catch {}
      return line
    }
    const step = async (name, budget, fn) => {
      const t0 = os.now()
      try { const r = await withBudget(Promise.resolve().then(fn), Math.max(1, budget)); rec(name, t0, true, r?.note); return r }
      catch (e) { const error = (e?.failed ? (e.msg ?? e.error) : (e?.error ?? e?.msg ?? e?.message)) ?? String(e); rec(name, t0, false, error); throw { step: name, error, failed: e?.failed } }
    }
    R.step = step; R.rec = rec
    return R
  }

  // --- the gate sequence (D9), shared by deploy / restore / config: hold → drain → stop → body(slot) → start → probe → release
  async function underGate(row, R, { rev, codeDir, appDir, body, onFail }) {
    const slot = row.prod
    const g = deferred()
    slot.gate = g.promise
    const prev = { rev: slot.rev, commit: slot.commit, appDir: slot.appDir, legacy: slot.legacy }
    let started = null
    try {
      await R.step('drain', D().drainMs + 500, async () => { const t = os.now(); while (slot.inflight > 0 && os.now() - t < D().drainMs) await sleep(20); return { note: slot.inflight ? `${slot.inflight} still in flight after ${D().drainMs} ms` : undefined } })
      await R.step('stop', T.drainMs + 2000, async () => { if (!slot.live) return { note: 'no worker was running' }; const l = slot.live; slot.live = null; slot.state = 'loading'; await i.stopLive(row, slot, l, 'release') })
      await body(slot)
      started = await R.step('start', D().startMs + 500, () => i.startWorker(row, slot, rev, codeDir, { appDir, dataDir: slot.dataDir }))
      await R.step('probe', D().probeMs + 500, () => probe(started.live.sock, row.prodMeta?.healthz, D().probeMs))
      slot.live = started.live; slot.rev = rev; slot.state = 'live'; slot.down = null; slot.appDir = appDir; slot.legacy = false
      slot.resources = started.resources; slot.suspendable = started.suspendable; slot.restarts = 0
      if (prev.rev != null && prev.rev !== rev) { slot.kept.push({ rev: prev.rev, until: os.now() + T.keepMs }); i.later(T.keepMs + 50, () => i.prune(row)) }
      R.rec('release', os.now(), true)
      return { ok: true, prev }
    } catch (e) {
      if (started?.live) { try { await i.stopLive(row, slot, started.live, 'failed-release') } catch {} }
      slot.live = null; slot.state = 'down'
      const failure = { step: e?.step ?? 'release', error: e?.error ?? e?.message ?? String(e) }
      slot.down = { ...failure, backup: null, rev, at: nowIso(os.now()) }
      try { onFail?.(failure) } catch {}
      return { ok: false, prev, ...failure }
    } finally {
      if (slot.gate === g.promise) slot.gate = null
      g.resolve()
      i.armIdle(row, slot)
    }
  }

  const url = (row) => `${i.origin()}/${row.company}/${row.slug}`
  const api = (row) => `${i.origin()}/api/${row.company}/${row.slug}`
  const current = (row) => (row.prod?.rev != null ? { rev: row.prod.rev, commit: row.prod.commit } : null)
  const outcomeMetric = (row, t0, outcome) => { try { metrics.deploy(row.slug, os.now() - t0, outcome) } catch {} }

  // ---------------------------------------------------------------------------------------------
  function deploy(row, { message, commit: wanted = null, by = 'agent:local', noBackup = false, onStep } = {}) {
    if (row.deploying) throw Object.assign(new Error(MESSAGES.refuse.inProgress()), { status: 409 })
    if (!i.treeOk()) throw Object.assign(new Error(HOST_MESSAGES.hostFault), { status: 503 })
    const kind = wanted ? 'rollback' : 'deploy'
    if (kind === 'deploy' && (typeof message !== 'string' || !message.trim() || message.length > 1000)) throw Object.assign(new Error(HOST_MESSAGES.badMessage), { status: 400 })
    if (kind === 'rollback' && !/^[0-9a-f]{7,40}$/i.test(String(wanted))) throw Object.assign(new Error(MESSAGES.refuse.badCommit(String(wanted).slice(0, 40))), { status: 400 })
    message = typeof message === 'string' && message.trim() ? message.trim() : `rollback to ${String(wanted).slice(0, 12)}`
    const t0 = os.now()
    const inst = row.instance, slug = row.slug
    const id = newReleaseId()
    let commit = null, rev = null, prodDir = null, written = null, mj = null, backup = null, partial = false
    const R = recorder(row, { commit: wanted, message, onStep })
    const rehearsalSlot = { name: 'rehearsal', appDir: null, dataDir: i.rel(REL.rehearsalData(inst)), live: null, retiring: new Set(), kept: [], rev: null }
    // the verdict: green → the new prod {rev, commit}; red/failed → the prod the app stays on (rev N, commit c12) and the attempted commit
    const finish = async (outcome, extra = {}) => {
      const cur = current(row)
      const rel = { id, instance: inst, kind, commit: commit ?? (wanted ? String(wanted) : null), message, at: nowIso(os.now()), by, verdict: outcome, rev: outcome === 'green' ? rev : (cur?.rev ?? null), rehearsal: { ms: extra.rehearsalMs ?? 0, partial, steps: R.steps.map(({ name, ms, ok }) => ({ name, ms, ok })) }, backup: backup?.id ?? null, error: extra.reportMessage ?? extra.error ?? null, changelog: null }
      await recordRelease(row, rel)
      outcomeMetric(row, t0, outcome)
      const v = { t: 'verdict', outcome, kind, slug, url: url(row), api: api(row), release: id, ms: Math.round(os.now() - t0), rehearsal: { ms: rel.rehearsal.ms, ...(partial ? { partial: true } : {}) }, attempted: commit ? { commit } : null }
      if (outcome === 'green') { v.rev = rev; v.commit = commit } else { v.rev = cur?.rev ?? 0; v.commit = cur?.commit ?? null; v.step = extra.step; v.error = extra.error }
      if (backup) v.backup = backup.id
      if (outcome === 'failed') v.noBackup = !backup
      try { onStep?.(v) } catch {}
      return v
    }
    row.deploying = (async () => {
      try {
        // ---- 1. commit (a rollback names its commit; `nothing to commit` = the HEAD). Red here = no app-error (nothing was rehearsed)
        try {
          await R.step('commit', D().commitMs, async () => {
            if (wanted) {
              const r = await resolveCommit({ os, appDir: row.dir, ref: String(wanted).toLowerCase(), home: i.cfg.gitHome })
              if (!r.ok) throw { error: MESSAGES.refuse.badCommit(String(wanted).slice(0, 12)) }
              commit = r.commit; R.commit = commit
              return { note: MESSAGES.step.notes.commitGiven(commit12(commit)) }
            }
            if (!row.gitReady) { const g = await gitInit({ os, appDir: row.dir, log: emit, home: i.cfg.gitHome }); if (!g.ok) throw { error: `git ${g.step}: ${g.error}` }; row.gitReady = true }
            const r = await commitAll({ os, appDir: row.dir, message, log: emit, home: i.cfg.gitHome })
            if (!r.ok) throw { error: `git ${r.step}: ${r.error}` }
            commit = r.commit; R.commit = commit
            return { note: r.noop ? MESSAGES.step.notes.commitNothing(commit12(commit)) : MESSAGES.step.notes.commit(commit12(commit), message) }
          })
        } catch (e) {
          emit(MESSAGES.log.red(slug, c12(commit ?? wanted), e.step, e.error, prodRev(row)))
          return await finish('red', { step: e.step, error: e.error })
        }
        // ---- 2. rehearsal (prod untouched)
        const rT0 = os.now()
        const left = () => Math.max(1000, D().rehearsalMs - (os.now() - rT0))
        const budget = (ms) => Math.min(ms, left())
        try {
          rev = store.nextRev(inst); row.counter = rev; rehearsalSlot.rev = rev; row.rehearsal = rehearsalSlot
          prodDir = i.exportDir(row, commit)
          rehearsalSlot.appDir = prodDir
          const prodData = i.dot(REL.prodData(inst))
          const copyDir = i.dot(REL.rehearsalData(inst))
          await R.step('copy', budget(D().copyMs), async () => {
            await rmrf(copyDir)
            applyPlan(row, rehearsalPlan({ uid: row.uid }, i.dot(REL.rehearsalRoot(inst))), 'rehearsal dir')
            if (!row.prod || !exists(prodData) || dirEmpty(prodData)) return { note: MESSAGES.step.notes.copy(0) }
            const bytes = await dirBytes(prodData)
            if (bytes > DATA_CAP_BYTES) { partial = true; return { note: MESSAGES.step.notes.copySkipped(gb(bytes)) } }
            await copyInto(prodData, copyDir, D().copyMs)
            return { note: MESSAGES.step.notes.copy(Math.round(mb(bytes))) }
          })
          const finalRel = REL.prodExport(inst, commit), tmpRel = finalRel + '.tmp'
          const tmpDir = i.dot(tmpRel)
          const kept = exists(prodDir)
          await R.step('export', budget(D().exportMs), async () => {
            if (kept) return { note: 'kept from the previous attempt of this commit' }
            await rmrf(tmpDir)
            applyPlan(row, [...prodPlan({ uid: row.uid }, i.dot(REL.prodRoot(inst))), ...prodPlan({ uid: row.uid }, tmpDir)], 'export dir')
            const n = await exportCommit(row, commit, tmpDir)
            return { note: `${n} inodes` }
          })
          await R.step('install', budget(D().installMs), async () => {
            if (kept) return { note: 'kept' }
            if (!exists(path.join(tmpDir, 'package.json'))) { fs.renameSync(tmpDir, i.dot(finalRel)); return { note: 'no package.json' } }
            if (i.install) {
              const spec = await i.workerSpec(row, rehearsalSlot, rev, null, { appDir: i.realPath(tmpDir) })
              const r = await i.withInstalling(row, () => i.install({ os, dirfd: i.dirfd, spec, log: emit, dest: tmpRel }))
              if (!r?.ok) throw { error: `${r?.class ?? 'install'}: ${r?.message ?? '?'}` }
              fs.renameSync(tmpDir, i.dot(finalRel))
              return { note: `${r.files ?? '?'} files in ${r.ms ?? '?'} ms` }
            }
            // no installer (a laptop): the dev tree's node_modules is copied into the export
            const nm = path.join(row.dir, 'node_modules')
            if (exists(nm)) fs.cpSync(nm, path.join(tmpDir, 'node_modules'), { recursive: true, verbatimSymlinks: true })
            fs.renameSync(tmpDir, i.dot(finalRel))
            return { note: exists(nm) ? 'node_modules copied from the dev tree (no installer)' : 'no installer' }
          })
          await R.step('build', budget(D().buildMs), async () => {
            mj = i.checkModuleJson(prodDir)
            if (!mj.ok) throw { error: formatHint(mj.error), failed: mj.error }
            row.prodMeta = mj.json
            try { written = await i.buildArtefacts(row, { appDir: prodDir, rev }) } catch (e) { if (e?.problems) throw { error: formatHint(e.problems[0]), failed: e.problems[0] }; throw { error: `snapshot write failed: ${e?.code ?? e?.message ?? e}` } }
            return { note: `${written.written.bytes} bytes` }
          })
          const hookSpec = async () => i.workerSpec(row, rehearsalSlot, rev, written.written.dir, { appDir: prodDir, dataDir: rehearsalSlot.dataDir })
          const runHook = async (key, extra, ms) => {
            const cmd = mj.json[key]
            if (typeof cmd !== 'string' || !cmd.trim()) return { note: MESSAGES.step.notes[`${key === 'deploy' ? 'hook' : key}None`]() }
            if (!i.hook) throw { error: 'hooks are not available on this host' }
            const r = await i.hook({ os, spec: await hookSpec(), cmd, cwd: prodDir, extra, hostEnv, timeoutMs: ms, log: emit })
            if (!r.ok) throw { error: r.error }
            return { note: `${r.ms} ms` }
          }
          await R.step('hook', budget(D().hookMs + 500), () => runHook('deploy', {}, budget(D().hookMs)))
          const booted = await R.step('boot', budget(D().bootMs + 500), () => i.startWorker(row, rehearsalSlot, rev, written.written.dir, { appDir: prodDir, dataDir: rehearsalSlot.dataDir, sockFile: sockName('rehearsal', rev), lockSocket: false, ephemeral: true }))
          rehearsalSlot.live = booted.live
          try {
            await R.step('probe', budget(D().probeMs + 500), () => probe(booted.live.sock, mj.json.healthz, budget(D().probeMs)))
            await R.step('test', budget(D().testMs + 500), () => runHook('test', { ATELIER_SOCK: booted.live.sock, BASE_URL: 'http://localhost' }, budget(D().testMs)))
            await R.step('smoke', budget(D().smokeMs + 500), () => runHook('smoke', { ATELIER_SOCK: booted.live.sock, BASE_URL: 'http://localhost' }, budget(D().smokeMs)))
          } finally {
            rehearsalSlot.live = null
            await i.stopLive(row, rehearsalSlot, booted.live, 'rehearsal')
          }
        } catch (e) {
          const step = e?.step ?? 'rehearsal'
          const p = e?.failed?.code ? classifyWorkerFailure(e.failed, { appDir: prodDir, fs, map: written?.map ?? null }) : e?.failed
          const error = p?.hint ? formatHint(p) : (e?.error ?? e?.msg ?? e?.message ?? String(e))
          const detail = { message: MESSAGES.rehearsalRed.message(step, error), hint: MESSAGES.rehearsalRed.hint(slug, prodRev(row), c12(current(row)?.commit)) }
          if (p?.file) { detail.file = p.file; detail.line = p.line; detail.col = p.col }
          report(MESSAGES.rehearsalRed.kind, inst, prodRev(row), detail)
          emit(MESSAGES.log.red(slug, c12(commit), step, error, prodRev(row)))
          if (rev != null) { try { store.remove(inst, rev) } catch {} }
          return await finish('red', { step, error, reportMessage: detail.message, rehearsalMs: Math.round(os.now() - rT0) })
        } finally {
          row.rehearsal = null
          try { await rmrf(i.dot(REL.rehearsalData(inst))) } catch (e) { emit(`[${slug}] rehearsal copy: ${e?.error ?? e}`) }
        }
        const rehearsalMs = Math.round(os.now() - rT0)
        // ---- the backup feasibility check, BEFORE the gate (D11): a backup that cannot land is never discovered after prod stopped
        const prodData = i.dot(REL.prodData(inst))
        const hasData = !!row.prod && exists(prodData) && !dirEmpty(prodData)
        if (hasData && !noBackup) {
          const bytes = await dirBytes(prodData)
          const free = os.statfs?.(i.dot(''))?.free ?? null
          const why = backupFeasible({ dataBytes: bytes, freeBytes: free })
          if (why) {
            const error = MESSAGES.refuse.backupImpossible(why)
            R.rec('backup', os.now(), false, error)
            emit(MESSAGES.log.red(slug, c12(commit), 'backup', error, prodRev(row)))
            try { store.remove(inst, rev) } catch {}
            return await finish('red', { step: 'backup', error, rehearsalMs })
          }
        }
        // ---- 3. the gate
        if (!row.prod) { row.prod = i.prodSlot(row, { rev: null, commit: null, legacy: false, appDir: prodDir }); row.prod.state = 'loading' }
        const prevSnapshot = current(row)
        const g = await underGate(row, R, {
          rev, codeDir: written.written.dir, appDir: prodDir,
          body: async (slot) => {
            await R.step('backup', D().backupMs + 500, async () => {
              if (noBackup) return { note: MESSAGES.step.notes.backupSkipped() }
              if (!hasData) return { note: 'none (first deploy: no prod data yet)' }
              backup = await takeBackup(row, { rev: prevSnapshot?.rev ?? 0, commit: prevSnapshot?.commit })
              const dropped = await pruneOldBackups(row)
              return { note: `${MESSAGES.step.notes.backup(backup.id, Math.round(mb(backup.bytes)))}${dropped.length ? `, pruned ${dropped.length}` : ''}` }
            })
            await R.step('migrate', D().migrateMs + 500, async () => {
              const cmd = mj.json.deploy
              if (kind === 'rollback') return { note: 'rollback: no hook, data untouched' }
              if (typeof cmd !== 'string' || !cmd.trim()) return { note: MESSAGES.step.notes.hookNone() }
              if (!i.hook) throw { error: 'hooks are not available on this host' }
              const spec = await i.workerSpec(row, slot, rev, written.written.dir, { appDir: prodDir, dataDir: slot.dataDir })
              if (i.jail) applyPlan(row, jailPlan(spec), 'data dir')
              else { try { fs.mkdirSync(spec.dataDir, { recursive: true, mode: 0o700 }) } catch {} }
              const r = await i.hook({ os, spec, cmd, cwd: prodDir, extra: {}, hostEnv, timeoutMs: D().migrateMs, log: emit })
              if (!r.ok) throw { error: r.error }
              return { note: `${r.ms} ms` }
            })
          },
          onFail: (f) => {
            row.prod.down.backup = backup?.id ?? null
            const hint = backup ? MESSAGES.deployFailed.hint(prevSnapshot?.rev ?? 0, Math.round(mb(backup.bytes)), slug, backup.id) : MESSAGES.deployFailed.hintNoBackup(slug)
            report(MESSAGES.deployFailed.kind, inst, prodRev(row), { message: MESSAGES.deployFailed.message(commit12(commit), f.step, f.error, slug), hint })
            emit(MESSAGES.log.failed(slug, commit12(commit), f.step, f.error, backup?.id ?? null))
          },
        })
        if (!g.ok) { i.prune(row); return await finish('failed', { step: g.step, error: g.error, reportMessage: MESSAGES.deployFailed.message(commit12(commit), g.step, g.error, slug), rehearsalMs }) }
        // ---- 4. record
        store.commitProd(inst, rev, { commit, message, deployedAt: nowIso(os.now()) })
        row.prod.commit = commit
        try { i.onSwap(inst, rev) } catch (e) { emit(`[${slug}] onSwap: ${e?.message ?? e}`) }
        emit(MESSAGES.log.live(slug, rev, commit12(commit), Math.round(os.now() - t0)))
        R.rec('record', os.now(), true)
        i.prune(row)
        await pruneExports(row, [commit, prevSnapshot?.commit])
        return await finish('green', { rehearsalMs })
      } catch (e) {
        emit(`[${slug}] deploy crashed: ${e?.stack ?? e}`)
        return await finish(row.prod?.state === 'down' ? 'failed' : 'red', { step: 'deploy', error: e?.message ?? String(e) })
      } finally { row.deploying = null }
    })()
    return row.deploying
  }

  // exports not referenced by the current or the previous release are removed (root owns them)
  async function pruneExports(row, keepCommits) {
    const keep = new Set(keepCommits.filter(Boolean).map(commit12))
    let names = []
    try { names = fs.readdirSync(i.dot(REL.prodRoot(row.instance))) } catch { return }
    for (const n of names) { if (keep.has(n)) continue; try { fs.rmSync(i.dot(`${REL.prodRoot(row.instance)}/${n}`), { recursive: true, force: true }) } catch (e) { emit(`[${row.slug}] export ${n} prune: ${e.code ?? e.message}`) } }
  }

  // ---------------------------------------------------------------------------------------------
  function restore(row, backup, { by = 'agent:local', onStep } = {}) {
    if (row.deploying) throw Object.assign(new Error(MESSAGES.refuse.inProgress()), { status: 409 })
    if (!row.prod || row.prod.rev == null) throw Object.assign(new Error(MESSAGES.refuse.notDeployed()), { status: 404 })
    if (typeof backup !== 'string' || !parseBackupId(backup) || !exists(i.dot(REL.backup(row.instance, backup)))) throw Object.assign(new Error(HOST_MESSAGES.unknownBackup), { status: 404 })
    const t0 = os.now(), inst = row.instance, slug = row.slug, id = newReleaseId()
    const R = recorder(row, { commit: row.prod.commit, message: `restore ${backup}`, onStep })
    const cur = store.current(inst)
    const finish = async (outcome, extra = {}) => {
      const rel = { id, instance: inst, kind: 'restore', commit: row.prod.commit, message: `restore ${backup}`, at: nowIso(os.now()), by, verdict: outcome, rev: row.prod.rev, rehearsal: { ms: 0, partial: false, steps: R.steps.map(({ name, ms, ok }) => ({ name, ms, ok })) }, backup, error: extra.reportMessage ?? extra.error ?? null, changelog: null }
      await recordRelease(row, rel)
      const v = { t: 'verdict', outcome, kind: 'restore', slug, commit: row.prod.commit, rev: row.prod.rev, url: url(row), api: api(row), backup, release: id, ms: Math.round(os.now() - t0) }
      if (extra.step) v.step = extra.step
      if (extra.error) v.error = extra.error
      try { onStep?.(v) } catch {}
      return v
    }
    row.deploying = (async () => {
      try {
        if (!cur) return await finish('failed', { step: 'restore', error: 'the prod rev dir is missing' })
        const g = await underGate(row, R, {
          rev: cur.rev, codeDir: cur.dir, appDir: row.prod.appDir,
          body: async (slot) => {
            await R.step('restore', D().backupMs + 500, async () => {
              const data = i.dot(REL.prodData(inst))
              await rmrf(data)
              const spec = await i.workerSpec(row, slot, cur.rev, cur.dir, {})
              if (i.jail) applyPlan(row, jailPlan(spec), 'data dir')
              else { try { fs.mkdirSync(spec.dataDir, { recursive: true, mode: 0o700 }) } catch {} }
              await copyInto(i.dot(REL.backup(inst, backup)), data, D().backupMs)
              return { note: backup }
            })
          },
          onFail: (f) => { const m = HOST_MESSAGES.restoreFailed(slug, backup, f.step, f.error); report('worker', inst, prodRev(row), m) },
        })
        if (!g.ok) return await finish('failed', { step: g.step, error: g.error, reportMessage: HOST_MESSAGES.restoreFailed(slug, backup, g.step, g.error).message })
        try { i.onSwap(inst, cur.rev) } catch {}
        emit(MESSAGES.log.restore(slug, backup, Math.round(os.now() - t0)))
        return await finish('green')
      } catch (e) {
        emit(`[${slug}] restore crashed: ${e?.stack ?? e}`)
        return await finish('failed', { step: 'restore', error: e?.message ?? String(e) })
      } finally { row.deploying = null }
    })()
    return row.deploying
  }

  // ---------------------------------------------------------------------------------------------
  // D16: a config PUT at the spine is a release of the same commit — gate → stop → start (the config is fetched
  // at spawn) → probe → release row; no rehearsal, no commit, at most one per app per heartbeat.
  function configRelease(row, { by = 'spine:config', onStep } = {}) {
    if (row.deploying || !row.prod || row.prod.rev == null) return null
    const t0 = os.now(), inst = row.instance, slug = row.slug, id = newReleaseId()
    const stamp = row.configStamp
    const R = recorder(row, { commit: row.prod.commit, message: `config ${stamp ?? ''}`.trim(), onStep })
    const cur = store.current(inst)
    row.deploying = (async () => {
      try {
        if (!cur) return null
        const g = await underGate(row, R, { rev: cur.rev, codeDir: cur.dir, appDir: row.prod.appDir, body: async () => {}, onFail: (f) => report('worker', inst, prodRev(row), HOST_MESSAGES.configFailed(slug, f.step, f.error)) })
        const outcome = g.ok ? 'green' : 'failed'
        const rel = { id, instance: inst, kind: 'config', commit: row.prod.commit, message: `config ${stamp ?? ''}`.trim(), at: nowIso(os.now()), by, verdict: outcome, rev: cur.rev, rehearsal: { ms: 0, partial: false, steps: R.steps.map(({ name, ms, ok }) => ({ name, ms, ok })) }, backup: null, error: g.ok ? null : HOST_MESSAGES.configFailed(slug, g.step, g.error).message, changelog: null }
        await recordRelease(row, rel)
        if (g.ok) { try { i.onSwap(inst, cur.rev) } catch {} ; emit(MESSAGES.log.config(slug, cur.rev, stamp ?? '-')) }
        return { t: 'verdict', outcome, kind: 'config', slug, commit: row.prod.commit, rev: cur.rev, release: id, ...(g.ok ? {} : { step: g.step, error: g.error }) }
      } catch (e) { emit(`[${slug}] config release crashed: ${e?.stack ?? e}`); return null } finally { row.deploying = null }
    })()
    return row.deploying
  }

  // ---------------------------------------------------------------------------------------------
  // D14: a row whose revision.json has no `prod` block — the pre-release layout — is adopted on the first scan:
  // git init + .gitignore + one commit of the tree serving rev N as uid 1000, `prod = {rev, commit, legacy}`,
  // one release row {kind:'adopt'}. It serves exactly as before (from the folder) until its first deploy.
  // Idempotent across host restarts: the `prod` block is the marker; a failed git step is retried next scan.
  function adopt(row) {
    const slot = row.prod
    if (!slot?.adoptPending) return Promise.resolve(null)
    row.git = row.git.then(async () => {
      if (!slot.adoptPending) return null
      const rev = slot.rev
      const g = await gitInit({ os, appDir: row.dir, log: emit, home: i.cfg.gitHome })
      if (!g.ok) { emit(`[${row.slug}] adopt: git ${g.step} failed (${g.error}) — retried on the next scan`); return null }
      row.gitReady = true
      const message = MESSAGES.git.adoptMessage(rev)
      const c = await commitAll({ os, appDir: row.dir, message, log: emit, home: i.cfg.gitHome })
      if (!c.ok) { emit(`[${row.slug}] adopt: git ${c.step} failed (${c.error}) — retried on the next scan`); return null }
      store.commitProd(row.instance, rev, { commit: c.commit, message, deployedAt: nowIso(os.now()), legacy: true })
      if (!store.currentDev(row.instance)) store.link(row.instance, 'current-dev', row.dev.rev ?? rev)
      slot.commit = c.commit; slot.legacy = true; slot.appDir = row.dir; slot.adoptPending = false
      const rel = { id: `adopt-${commit12(c.commit)}`, instance: row.instance, kind: 'adopt', commit: c.commit, message, at: nowIso(os.now()), by: 'host', verdict: 'green', rev, rehearsal: { ms: 0, partial: false, steps: [] }, backup: null, error: null, changelog: null }
      slot.announced = true
      await recordRelease(row, rel)
      emit(MESSAGES.log.adopt(row.slug, rev, commit12(c.commit)))
      return rel
    }).catch((e) => { emit(`[${row.slug}] adopt crashed: ${e?.stack ?? e}`); return null })
    return row.git
  }

  // announce(row): at every boot the host re-tells the spine the prod commit it holds — an `adopt-<c12>` row, green,
  // idempotent by id (a replay answers 200) — unless the register reply already carried that `deployed_rev`. A
  // migrated registry starts every app at `deployed_rev = "legacy"`; this is how it converges. One attempt per host
  // life (a failure is logged; the next boot posts again); no local ledger row — it is not a new release.
  async function announce(row) {
    const slot = row.prod
    if (!slot?.commit || slot.announced || slot.adoptPending) return null
    slot.announced = true
    const known = registrar?.apps?.()?.get(row.instance)?.deployed_rev ?? null
    if (known === slot.commit) return null
    const rel = { id: `adopt-${commit12(slot.commit)}`, instance: row.instance, kind: 'adopt', commit: slot.commit, message: MESSAGES.git.adoptMessage(slot.rev), at: nowIso(os.now()), by: 'host', verdict: 'green', rev: slot.rev, rehearsal: { ms: 0, partial: false, steps: [] }, backup: null, error: null, changelog: null }
    if (!registrar?.release) return null
    const r = await withBudget(Promise.resolve(registrar.release(rel)), D().recordMs).catch((e) => { emit(`[${row.slug}] announce: ${e?.error ?? e?.message ?? e}`); return null })
    emit(`[${row.slug}] announced prod commit ${commit12(slot.commit)} (rev ${slot.rev}) to the spine${r ? (r.replay ? ' (replay)' : '') : ' — not recorded'}${known ? ` (spine had ${known === 'legacy' ? 'legacy' : commit12(known)})` : ''}`)
    return rel
  }

  return { deploy, restore, configRelease, adopt, announce, releases, backups }
}
