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
import { archiveSpec, commitAll, resolveCommit } from './lastgood.mjs'
import { formatHint, classifyWorkerFailure } from './bundle.mjs'
import { treeId } from './watcher.mjs'
import { REL, commit12, backupId, parseBackupId, newReleaseId, copySpecs, rmSpec, duSpec, lsSpec, extractSpec, parseKb, ownTree, pruneBackups, backupFeasible, mb, deferred, RELEASES_KEEP, COMMIT_RE, DATA_CAP_BYTES, sockName } from './slots.mjs'
import { run } from '../worker/install.mjs'
import { backupPlan, rehearsalPlan, prodPlan, dataPlan, applyJail, jailPlan } from '../worker/jail.mjs'

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
  configFailed: {                                // D16: a config release that failed after its gate → ONE worker report
    kind: 'worker',
    message: (slug, step, error) => `config release failed at ${step}: ${cut(error, 160 - step.length)} — ${slug} is DOWN`,
    hint: (slug) => `fix the config (PUT /v1/apps/<instance>/config): the host restarts ${slug} under the gate within one heartbeat — or deploy`,
  },
  restoreFailed: {                               // a restore that failed after its gate → ONE worker report; the backup is untouched
    kind: 'worker',
    message: (slug, id, step, error) => `restore of ${id} failed at ${step}: ${cut(error, 140 - step.length - id.length)} — ${slug} is DOWN`,
    hint: (slug, id) => `the backup is untouched: atelier restore ${slug} ${id} again, or fix forward and deploy`,
  },
  // ── the one verdict line the CLI prints (the stream's {t:'verdict'} rendered; exit 0 / 2 / 3)
  verdict: {
    green:  (verb, slug, N, c12, url) => `${verb} green: ${slug} rev ${N} commit ${c12} live — ${url}`,
    red:    (verb, step, error, slug, N, c12) => `${verb} RED at ${step}: ${error} — nothing deployed, ${slug} stays on rev ${N} (${c12})`,
    failed: (verb, step, error, slug, id) => `${verb} FAILED at ${step}: ${error} — ${slug} is DOWN, backup ${id} kept`,
    failedNoBackup: (verb, step, error, slug) => `${verb} FAILED at ${step}: ${error} — ${slug} is DOWN, no backup (--no-backup)`,
    restoreGreen:  (slug, N, id, url) => `restore green: ${slug} rev ${N} data from backup ${id} live — ${url}`,
    restoreRed:    (step, error, slug, id) => `restore RED at ${step}: ${error} — nothing restored, ${slug} unchanged, backup ${id} untouched`,   // refused BEFORE the gate (the snapshot of today's data impossible)
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
      backup:        (id, MB) => `${id} (${MB} MB)`,                 // the deploy's `backup` step and the restore's `snapshot` step
      backupNone:    () => `none — prod has no data`,
      backupSkipped: () => `skipped (--no-backup)`,
      gate:          (held) => `${held} request(s) held`,
    },
  },
  // ── refusals BEFORE anything runs (the verdict line carries them: RED at <step>)
  refuse: {
    backupImpossible: (why) => `backup impossible: ${why}`,   // why ∈ `prod data is <MB> MB (> 1024 MB cap)` | `free space <MB> MB < 2× the data (<MB> MB)` — or pass --no-backup;
                                                                //   `could not read the data dir (<why>)` | `could not measure the data dir (<why>)` — a host fault (a failed, killed or
                                                                //   timed-out find/du child, EACCES): the answer is UNKNOWN and unknown never means "no data" — --no-backup does not lift these
    restoreLive:      (slug, id) => `${slug} is live: restore replaces its prod data with backup ${id} (everything written since is lost) — run atelier restore ${slug} ${id} --yes to confirm`,   // 409 body {"error": …}; a DOWN app needs no --yes
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
    seeded:  (slug, N, c12) => `[${slug}] seeded: rev ${N} (${c12}) is the release — prod from the folder, no dev slot`,
    seededFail: (slug, N, hint) => `[${slug}] rev ${N} FAILED (seeded) ${hint}`,                                                    // the folder's answer until its bytes change
    seededRetry: (slug, N, why) => `[${slug}] rev ${N} FAILED (seeded) ${why} — a host-side failure, retried at the next scan`,   // reported once, retried every scan
    config:  (slug, N, at) => `[${slug}] config release: rev ${N} restarted under the gate (config updated ${at})`,
    restore: (slug, id, ms) => `[${slug}] restore ${id} done in ${ms} ms`,
    restoreRed: (slug, id, step, error) => `[${slug}] restore ${id} RED at ${step}: ${error} — nothing restored`,
    bootDown: (slug, N, c12, step, id) => `[${slug}] boot: rev ${N} stays DOWN (deploy of ${c12} failed at ${step}${id ? `; backup ${id} kept` : '; no backup'}) — ${id ? `atelier restore ${slug} ${id}, or ` : ''}fix forward and deploy`,
    devLive: (slug, N, ms) => `[${slug}] rev ${N} LIVE (dev) in ${ms} ms`,
    devFail: (slug, N, hint) => `[${slug}] rev ${N} FAILED (dev) ${hint}`,
  },
  // ── git
  git: {
    adoptMessage: (N) => `adopt: the tree serving rev ${N}`,
    seededMessage: (N) => `seeded: the image's tree serving rev ${N}`,
    gitignore: ['data/', '.env', '.env.*', 'node_modules/', 'CLAIM-REFUSED.txt', '.atelier'].join('\n') + '\n',
  },
  // ── the list verbs (one row per line, newest first)
  list: {
    release: (r) => `${iso(r.at)}  ${r.kind.padEnd(8)} ${r.verdict.padEnd(6)} rev ${String(r.rev ?? '-').padStart(3)}  ${(r.commit ?? '').slice(0, 12)}  ${r.message ? JSON.stringify(r.message) : ''}${r.backup ? `  backup ${r.backup}` : ''}${r.error ? `  ${r.error}` : ''}`,
    releasesNone: (slug) => `${slug}: no releases yet — atelier deploy ${slug} -m "first release"`,
    backup: (b) => `${b.id}  ${String(b.mb).padStart(6)} MB  rev ${b.rev}  ${b.at}`,
    backupsNone: (slug) => `${slug}: no backups (a backup is taken by every deploy that reaches the gate)`,
  },
  usage: `usage: atelier deploy <slug> -m "<what changed, one line>" [--no-backup]
       atelier rollback <slug> <commit>
       atelier releases <slug>
       atelier backups <slug>
       atelier restore <slug> <backup-id> [--yes]`,
}
// host-side words that are not the chat's, the CLI's or the log's (the doors' error bodies)
export const HOST_MESSAGES = Object.freeze({
  unknownBackup: 'unknown backup',
  badMessage: 'message required (-m "<what changed, one line>", ≤ 1000 chars)',
  hostFault: 'host fault',
})

const tail = (s, n = 3) => String(s ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' | ')
const nowIso = (ms) => new Date(ms).toISOString()
// A release row's `at` is a MS EPOCH (`os.now()`): the spine's release door validates it as one inside a window and
// answered `400 at must be a ms epoch` to the ISO string the first live deploy posted (2026-09-02) — every row was
// refused, `deployed_rev` never moved. The ISO form is for eyes only: the log lines and the CLI's list (`iso`).
const iso = (at) => (typeof at === 'number' ? new Date(at).toISOString() : String(at))
const c12 = (c) => (c ? commit12(c) : 'none')
const gb = (bytes) => (bytes / 1024 / 1024 / 1024).toFixed(1)
const childWhy = (r) => tail(r.stderr) || (r.signal ? `killed by ${r.signal}` : `rc=${r.code}`)

/**
 * createDeployer(i) — the supervisor's internals (index.mjs hands them over): os, dirfd, fs, cfg, T, emit, report,
 * registrar, store, metrics, hostEnv, jail, install, hook, treeOk, company(), origin(), rel(), dot(), workerSpec,
 * startWorker, stopLive, buildArtefacts, prune, prodSlot, exportDir, withInstalling, later, onSwap, armIdle,
 * withGroupSync, checkModuleJson, ensureGit (the row's one `git init`).
 *   .deploy(row, {message, commit?, by, noBackup, onStep}) → the verdict (never throws once started; 409 while one runs)
 *   .restore(row, backupId, {by, yes, onStep}) → the verdict (refused unless the app is DOWN or `yes`)
 *   .configRelease(row) → the verdict (D16)
 *   .adopt(row) → the release row (D14)
 *   .seeded(row) → the release row (DESIGN §10.3 "seeded rows": the folder is the release; every scan calls it)
 *   .releases(row) → [rows, newest first]   .backups(row) → [{id, at, rev, commit, bytes}, newest first]
 * Every app-error report here carries rev = row.prod?.rev ?? 0 — the PROD rev (the spine's coalescer keeps ONE running
 * rev per instance and drops lower ones as stale; a dev/rehearsal counter would silence every later prod error).
 *
 * One rule runs through every measurement of prod data (the review of 2026-09-02): an UNKNOWN answer — a child that
 * failed, was killed or timed out, an EACCES, a `du` that printed nothing — is never read as the permissive one ("no
 * data", "0 bytes"). `hasData`/`measure` answer `{unknown}` and `probeData` turns that into the `backup impossible:`
 * refusal BEFORE the gate, so a migration never runs on prod data without a snapshot behind it.
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

  // --- root-side helpers (cp/rm/du as root with group 19999; plain processes on a laptop). A CHILD never sees the
  // host's `/proc/self/fd/N/…` form (fd N is not the dirfd in its table — DESIGN I1.13): every path handed to one is
  // `i.realPath`'d; the host's own reads and writes keep the dirfd form.
  const real = (p) => i.realPath(p)
  async function copyInto(row, src, dst, ms, role = 'data') {
    for (const spec of copySpecs(real(src), real(dst), { uid: row.uid, role, hostEnv, privileged: !!os.privileged })) {
      const r = await run(os, spec, { timeoutMs: ms })
      if (r.code !== 0) throw { error: `${spec.argv[0]}: ${childWhy(r)}` }
    }
  }
  async function rmrf(p, ms = 60_000) { if (!exists(p)) return; const r = await run(os, rmSpec(real(p), hostEnv), { timeoutMs: ms }); if (r.code !== 0) throw { error: `rm -rf: ${childWhy(r)}` } }
  // measure(p) → {bytes} | {unknown: why}: `du -sk` as root+19999; a failed/killed/timed-out child or an unparsable answer is UNKNOWN, never 0
  async function measure(p) {
    if (!exists(p)) return { bytes: 0 }
    const r = await run(os, duSpec(real(p), hostEnv), { timeoutMs: D().probeMs * 6 })
    const kb = parseKb(r.stdout)
    if (r.code !== 0 || kb == null) return { unknown: `du: ${childWhy(r)}${r.code === 0 ? ' (no size printed)' : ''}` }
    return { bytes: kb * 1024 }
  }
  // hasData(p) → {has} | {unknown: why}: a `<uid>:19999 2770` data dir is not readable by userns-root itself (no DAC caps; the
  // row-9 drill's finding) — the question goes to a root+19999 `find -quit` child. A child that failed (EACCES, a signal, the
  // budget) is UNKNOWN: the caller refuses in words, it never reads it as "no data".
  async function hasData(p) {
    try { fs.lstatSync(p) } catch (e) { return e?.code === 'ENOENT' ? { has: false } : { unknown: `lstat: ${e?.code ?? e?.message ?? e}` } }
    const r = await run(os, lsSpec(real(p), hostEnv), { timeoutMs: D().probeMs * 6 })
    if (r.code !== 0) return { unknown: `find: ${childWhy(r)}` }
    return { has: String(r.stdout ?? '').trim().length > 0 }
  }
  // probeData(row, {noBackup}) → {has, bytes}: the D11 question, asked BEFORE the rehearsal (so an unreadable data dir is the
  // cheapest possible red) and again BEFORE the gate (the data may have appeared or grown meanwhile). An unknown answer or a
  // backup that cannot land THROWS {step:'backup', error: `backup impossible: …`}; --no-backup lifts the size/space rule
  // only — an unreadable or unmeasurable data dir is a host fault that refuses either way (the rehearsal copy needs it too).
  async function probeData(row, { noBackup = false } = {}) {
    const refuse = (why) => { throw { step: 'backup', error: MESSAGES.refuse.backupImpossible(why) } }
    const prodData = i.dot(REL.prodData(row.instance))
    const h = await hasData(prodData)
    if (h.unknown) refuse(`could not read the data dir (${h.unknown})`)
    if (!h.has) return { has: false, bytes: 0 }
    const m = await measure(prodData)
    if (m.unknown) refuse(`could not measure the data dir (${m.unknown})`)
    if (!noBackup) {
      const free = os.statfs?.(i.dot(''))?.free ?? null
      const why = backupFeasible({ dataBytes: m.bytes, freeBytes: free })
      if (why) refuse(why)
    }
    return { has: true, bytes: m.bytes }
  }
  function applyPlan(row, plan, what) {
    if (!i.jail) { for (const s of plan) if (s.op === 'mkdir') { try { fs.mkdirSync(s.path, { recursive: true, mode: s.mode & 0o777 }) } catch {} } return }
    const r = applyJail(os, plan, (l) => emit(`[${row.slug}] ${l}`))
    if (!r.ok) { const f = r.results.at(-1); throw { error: `${what}: ${f.step.op} ${f.step.path ?? ''}: ${f.code}` } }
  }
  const readJsonMarker = (row, name) => { try { return JSON.parse(store.readMarker(row.instance, name)) } catch { return null } }

  // --- the export (rows A + T): git archive as uid 1000 piped into tar -x as root, then chmod-then-chown 0:<uid>. Both
  // children die at the budget (a step that times out never leaves a writer behind in the export).
  async function exportCommit(row, commit, dest, ms) {
    const git = os.spawn(archiveSpec({ appDir: row.dir, commit, home: i.cfg.gitHome }))
    const tar = os.spawn(extractSpec(real(dest), hostEnv))
    let gerr = '', terr = ''
    git.stderr?.on?.('data', (d) => { gerr += d }); tar.stderr?.on?.('data', (d) => { terr += d })
    git.stdout.on('error', () => {}); tar.stdin.on('error', () => {}); tar.stdout?.resume?.()
    git.stdout.pipe(tar.stdin)
    const exit = (c) => new Promise((res) => { c.on('exit', (code, sig) => res({ code, sig })); c.on('error', (e) => res({ code: -1, err: e.message })) })
    const timer = setTimeout(() => { for (const c of [git, tar]) { try { os.kill(c.pid, 'SIGKILL') } catch {} } }, ms)
    let g, t
    try { [g, t] = await Promise.all([exit(git), exit(tar)]) } finally { clearTimeout(timer) }
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

  // --- the rows the host keeps: releases.jsonl (0600, last 50) and backups.json (the completion marker + sizes)
  function releases(row) {
    const t = store.readMarker(row.instance, 'releases.jsonl')
    if (!t) return []
    return t.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).reverse()
  }
  async function recordRelease(row, rel) {
    const all = [...releases(row).reverse(), rel].slice(-RELEASES_KEEP)
    try { store.writeMarker(row.instance, 'releases.jsonl', all.map((r) => JSON.stringify(r)).join('\n') + '\n') } catch (e) { emit(`[${row.slug}] releases.jsonl: ${e.code ?? e.message}`) }
    if (!registrar?.release) return rel
    // the spine's door validates `commit` as 40 hex: a red at `commit` (nothing resolved) stays the host's row alone
    if (!COMMIT_RE.test(rel.commit ?? '')) { emit(`[${row.slug}] release row ${rel.id}: kept in releases.jsonl only (no commit to record at the spine)`); return rel }
    await withBudget(Promise.resolve(registrar.release(rel)), D().recordMs).catch((e) => emit(`[${row.slug}] release row ${rel.id}: ${e?.error ?? e?.message ?? e}`))
    return rel
  }
  // backups(row): the ids in backups.json whose dir exists — the marker is written AFTER the copy landed, so a dir a dead
  // host life left half-copied is never listed, never restorable, and is swept by pruneOldBackups
  function backups(row) {
    const meta = readJsonMarker(row, 'backups.json') ?? {}
    return Object.keys(meta).map((id) => { const p = parseBackupId(id); return p && exists(i.dot(REL.backup(row.instance, id))) ? { id, at: nowIso(p.at), rev: p.rev, commit: p.commit, bytes: meta[id]?.bytes ?? null, mb: meta[id]?.bytes != null ? mb(meta[id].bytes) : null } : null }).filter(Boolean).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  }
  // pruneOldBackups(row): D11 (last 3 / ≤ 1 GiB) over the marked backups + every unmarked dir (incomplete). Housekeeping —
  // it runs OUTSIDE the gate (a slow prune must never take prod down).
  async function pruneOldBackups(row) {
    const rows = backups(row)
    const meta = readJsonMarker(row, 'backups.json') ?? {}
    const drop = pruneBackups(rows.map((r) => ({ id: r.id, at: Date.parse(r.at), bytes: r.bytes ?? 0 })))
    let names = []
    try { names = fs.readdirSync(i.dot(REL.backupRoot(row.instance))) } catch {}
    for (const n of names) if (!meta[n] && parseBackupId(n) && !drop.includes(n)) drop.push(n)   // no marker: the copy never finished
    for (const id of drop) {
      try { await rmrf(i.dot(REL.backup(row.instance, id))); delete meta[id]; emit(`[${row.slug}] backup ${id} pruned`) } catch (e) { emit(`[${row.slug}] backup ${id} prune: ${e?.error ?? e?.message ?? e}`) }
    }
    if (drop.length) store.writeMarker(row.instance, 'backups.json', JSON.stringify(meta))
    return drop
  }
  // takeBackup(row, {rev, commit, bytes}): prod data → backup/<inst>/<id> as `0:19999` (dirs 0750, files 0640: root's bytes,
  // the agent reads); `bytes` is the size probeData measured before the gate (no `du` inside the gate); the marker lands last.
  async function takeBackup(row, { rev, commit, bytes }) {
    const src = i.dot(REL.prodData(row.instance))
    let at = os.now(), id = backupId(at, rev, commit), dst = i.dot(REL.backup(row.instance, id))
    while (exists(dst)) { at += 1000; id = backupId(at, rev, commit); dst = i.dot(REL.backup(row.instance, id)) }   // the id has second granularity: two releases of one rev inside a second never share a dir
    applyPlan(row, [...backupPlan(i.dot(REL.backupRoot(row.instance))), ...backupPlan(dst)], 'backup dir')
    await copyInto(row, src, dst, D().backupMs, 'backup')
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

  // the DOWN marker (D10), in memory AND on disk (revision.json.prod.down — a host restart keeps the app down, S1)
  function markDown(row, slot, failure, { backup, rev, commit }) {
    slot.live = null; slot.state = 'down'
    slot.down = { step: failure.step, error: failure.error, backup: backup ?? null, commit: commit ?? null, rev, at: nowIso(os.now()) }
    try { store.prodPatch(row.instance, { down: slot.down, releasing: undefined }) } catch (e) { emit(`[${row.slug}] down marker: ${e?.code ?? e?.message ?? e}`) }
  }

  // --- the gate sequence (D9), shared by deploy / restore / config: hold → drain → stop → body(slot) → start → probe → release
  async function underGate(row, R, { rev, commit, codeDir, appDir, body, onFail }) {
    const slot = row.prod
    const g = deferred()
    slot.gate = g.promise; slot.held = 0
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
      R.rec('release', os.now(), true, MESSAGES.step.notes.gate(slot.held))
      return { ok: true, prev }
    } catch (e) {
      if (started?.live) { try { await i.stopLive(row, slot, started.live, 'failed-release') } catch {} }
      const failure = { step: e?.step ?? 'release', error: e?.error ?? e?.message ?? String(e) }
      markDown(row, slot, failure, { backup: onFail?.backupId?.() ?? null, rev, commit })
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
    // the exports kept at every verdict (S7): the attempted commit (a complete export is reused by the next attempt of the
    // same commit), the commit prod serves, and the one before it (the rollback target) — read from the ledger, so a red
    // deploy leaks nothing
    const keptExports = () => { const cur = current(row)?.commit ?? null; const prevGreen = releases(row).find((r) => r.verdict === 'green' && COMMIT_RE.test(r.commit ?? '') && r.commit !== cur)?.commit ?? null; return [commit, cur, prevGreen] }
    // the verdict: green → the new prod {rev, commit}; red/failed → the prod the app stays on (rev N, commit c12) and the attempted commit
    const finish = async (outcome, extra = {}) => {
      await pruneExports(row, keptExports())
      const cur = current(row)
      const rel = { id, instance: inst, kind, commit: commit ?? (wanted ? String(wanted) : null), message, at: os.now(), by, verdict: outcome, rev: outcome === 'green' ? rev : (cur?.rev ?? null), rehearsal: { ms: extra.rehearsalMs ?? 0, partial, steps: R.steps.map(({ name, ms, ok }) => ({ name, ms, ok })) }, backup: backup?.id ?? null, error: extra.reportMessage ?? extra.error ?? null, changelog: null }
      await recordRelease(row, rel)
      outcomeMetric(row, t0, outcome)
      const v = { t: 'verdict', outcome, kind, slug, url: url(row), api: api(row), release: id, ms: Math.round(os.now() - t0), rehearsal: { ms: rel.rehearsal.ms, ...(partial ? { partial: true } : {}) }, attempted: commit ? { commit } : null }
      if (outcome === 'green') { v.rev = rev; v.commit = commit } else { v.rev = cur?.rev ?? 0; v.commit = cur?.commit ?? null; v.step = extra.step; v.error = extra.error }
      if (backup) v.backup = backup.id
      if (outcome === 'failed') v.noBackup = !backup
      try { onStep?.(v) } catch {}
      return v
    }
    // a refusal before the gate (D11): the verdict line and the agent.log line, no app-error, prod never stopped
    const refused = async (e, rehearsalMs = 0) => {
      R.rec(e.step, os.now(), false, e.error)
      emit(MESSAGES.log.red(slug, c12(commit ?? wanted), e.step, e.error, prodRev(row)))
      if (rev != null) { try { store.remove(inst, rev) } catch {} }
      return finish('red', { step: e.step, error: e.error, rehearsalMs })
    }
    // a failure AFTER the gate (D10): ONE worker report naming the backup, the agent.log line, the rev dir pruned
    const failedAfterGate = async (f, rehearsalMs) => {
      const hint = backup ? MESSAGES.deployFailed.hint(f.prevRev ?? 0, Math.round(mb(backup.bytes)), slug, backup.id) : MESSAGES.deployFailed.hintNoBackup(slug)
      report(MESSAGES.deployFailed.kind, inst, prodRev(row), { message: MESSAGES.deployFailed.message(commit12(commit), f.step, f.error, slug), hint })
      emit(MESSAGES.log.failed(slug, commit12(commit), f.step, f.error, backup?.id ?? null))
      i.prune(row)
      return finish('failed', { step: f.step, error: f.error, reportMessage: MESSAGES.deployFailed.message(commit12(commit), f.step, f.error, slug), rehearsalMs })
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
            const g = await i.ensureGit(row)   // the claim's init when it is still in flight — never a second `git init` on the dir
            if (!g.ok) throw { error: `git ${g.step}: ${g.error}` }
            const r = await commitAll({ os, appDir: row.dir, message, log: emit, home: i.cfg.gitHome })
            if (!r.ok) throw { error: `git ${r.step}: ${r.error}` }
            commit = r.commit; R.commit = commit
            return { note: r.noop ? MESSAGES.step.notes.commitNothing(commit12(commit)) : MESSAGES.step.notes.commit(commit12(commit), message) }
          })
        } catch (e) {
          emit(MESSAGES.log.red(slug, c12(commit ?? wanted), e.step, e.error, prodRev(row)))
          return await finish('red', { step: e.step, error: e.error })
        }
        // ---- the data question, BEFORE anything is exported or installed (D11): unknown / cannot land → red at `backup`, nothing ran
        let data
        try { data = await probeData(row, { noBackup }) } catch (e) { return await refused(e) }
        // ---- 2. rehearsal (prod untouched)
        const rT0 = os.now()
        const left = () => Math.max(1000, D().rehearsalMs - (os.now() - rT0))
        const budget = (ms) => Math.min(ms, left())
        try {
          rev = store.nextRev(inst); row.counter = rev; rehearsalSlot.rev = rev; row.rehearsal = rehearsalSlot
          row.releasing = rev   // pinned for the WHOLE verb (B3): a prune timer from an old save must never delete the rev dir the gate is about to start
          prodDir = i.exportDir(row, commit)
          rehearsalSlot.appDir = prodDir
          const prodData = i.dot(REL.prodData(inst))
          const copyDir = i.dot(REL.rehearsalData(inst))
          await R.step('copy', budget(D().copyMs), async () => {
            await rmrf(copyDir)
            applyPlan(row, rehearsalPlan({ uid: row.uid }, i.dot(REL.rehearsalRoot(inst))), 'rehearsal dir')
            if (!data.has) return { note: MESSAGES.step.notes.copy(0) }
            if (data.bytes > DATA_CAP_BYTES) { partial = true; return { note: MESSAGES.step.notes.copySkipped(gb(data.bytes)) } }
            await copyInto(row, prodData, copyDir, D().copyMs, 'data')
            return { note: MESSAGES.step.notes.copy(Math.round(mb(data.bytes))) }
          })
          const finalRel = REL.prodExport(inst, commit), tmpRel = finalRel + '.tmp'
          const tmpDir = i.dot(tmpRel)
          const kept = exists(prodDir)
          await R.step('export', budget(D().exportMs), async () => {
            if (kept) return { note: 'kept from the previous attempt of this commit' }
            await rmrf(tmpDir)
            applyPlan(row, [...prodPlan({ uid: row.uid }, i.dot(REL.prodRoot(inst))), ...prodPlan({ uid: row.uid }, tmpDir)], 'export dir')
            const n = await exportCommit(row, commit, tmpDir, budget(D().exportMs))
            return { note: `${n} inodes` }
          })
          await R.step('install', budget(D().installMs), async () => {
            if (kept) return { note: 'kept' }
            if (!exists(path.join(tmpDir, 'package.json'))) { fs.renameSync(tmpDir, i.dot(finalRel)); return { note: 'no package.json' } }
            if (i.install) {
              const spec = await i.workerSpec(row, rehearsalSlot, rev, null, { appDir: i.realPath(tmpDir), config: false })   // an install runs without the document
              // npm's own kill lands with the step's budget: a timed-out install never keeps running into the next attempt
              const r = await i.withInstalling(row, () => i.install({ os, dirfd: i.dirfd, spec, log: emit, dest: tmpRel, timeoutMs: budget(D().installMs) }))
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
          const booted = await R.step('boot', budget(D().bootMs + 500), () => i.startWorker(row, rehearsalSlot, rev, written.written.dir, { appDir: prodDir, dataDir: rehearsalSlot.dataDir, sockFile: sockName('rehearsal', rev), lockSocket: 'shared', ephemeral: true }))
          rehearsalSlot.live = booted.live
          try {
            await R.step('probe', budget(D().probeMs + 500), () => probe(booted.live.sock, mj.json.healthz, budget(D().probeMs)))
            await R.step('test', budget(D().testMs + 500), () => runHook('test', { ATELIER_SOCK: booted.live.sock, BASE_URL: 'http://localhost' }, budget(D().testMs)))
            await R.step('smoke', budget(D().smokeMs + 500), () => runHook('smoke', { ATELIER_SOCK: booted.live.sock, BASE_URL: 'http://localhost' }, budget(D().smokeMs)))
          } finally {
            rehearsalSlot.live = null
            await i.stopLive(row, rehearsalSlot, booted.live, 'rehearsal')
            try { fs.rmSync(booted.live.sock, { force: true }) } catch {}   // per-rev naming: nothing else unlinks a rehearsal socket
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
          if (row.installing) await withBudget(row.installing.catch(() => {}), 60_000).catch(() => {})   // a timed-out install settles (freeze/cleanup) before the lock is released
          try { await rmrf(i.dot(REL.rehearsalData(inst))) } catch (e) { emit(`[${slug}] rehearsal copy: ${e?.error ?? e}`) }
        }
        const rehearsalMs = Math.round(os.now() - rT0)
        // ---- the data question again, BEFORE the gate (D11): the data may have appeared or grown during the rehearsal
        try { data = await probeData(row, { noBackup }) } catch (e) { return await refused(e, rehearsalMs) }
        // ---- 3. the gate
        if (!row.prod) { row.prod = i.prodSlot(row, { rev: null, commit: null, legacy: false, appDir: prodDir }); row.prod.state = 'loading' }
        const prevSnapshot = current(row)
        const g = await underGate(row, R, {
          rev, commit, codeDir: written.written.dir, appDir: prodDir,
          body: async (slot) => {
            await R.step('backup', D().backupMs + 500, async () => {
              if (noBackup) return { note: MESSAGES.step.notes.backupSkipped() }
              if (!data.has) return { note: MESSAGES.step.notes.backupNone() }
              backup = await takeBackup(row, { rev: prevSnapshot?.rev ?? 0, commit: prevSnapshot?.commit, bytes: data.bytes })
              return { note: MESSAGES.step.notes.backup(backup.id, Math.round(mb(backup.bytes))) }
            })
            await R.step('migrate', D().migrateMs + 500, async () => {
              const cmd = mj.json.deploy
              if (kind === 'rollback') return { note: 'rollback: no hook, data untouched' }
              if (typeof cmd !== 'string' || !cmd.trim()) return { note: MESSAGES.step.notes.hookNone() }
              if (!i.hook) throw { error: 'hooks are not available on this host' }
              const spec = await i.workerSpec(row, slot, rev, written.written.dir, { appDir: prodDir, dataDir: slot.dataDir })
              if (i.jail) applyPlan(row, jailPlan(spec), 'data dir')
              else { try { fs.mkdirSync(spec.dataDir, { recursive: true, mode: 0o700 }) } catch {} }
              // the in-flight marker: from here prod data may be mid-migration — a host that dies before `record` boots the app DOWN
              try { store.prodPatch(inst, { releasing: { id, commit, rev, backup: backup?.id ?? null, at: nowIso(os.now()) } }) } catch (e) { throw { error: `release marker: ${e?.code ?? e?.message ?? e}` } }
              const r = await i.hook({ os, spec, cmd, cwd: prodDir, extra: {}, hostEnv, timeoutMs: D().migrateMs, log: emit })
              if (!r.ok) throw { error: r.error }
              return { note: `${r.ms} ms` }
            })
          },
          onFail: Object.assign(() => {}, { backupId: () => backup?.id ?? null }),
        })
        if (!g.ok) return await failedAfterGate({ step: g.step, error: g.error, prevRev: prevSnapshot?.rev ?? 0 }, rehearsalMs)
        // ---- 4. record
        const chrome = i.chromeNameOf?.() ?? null   // the chrome buildArtefacts just compiled the prod sheet against (rebuildAll reads it back); none = no key
        try { store.commitProd(inst, rev, { commit, message, deployedAt: nowIso(os.now()), ...(chrome ? { chrome } : {}) }) } catch (e) {
          // the pointer did not land (ENOSPC, EIO): the new worker serves, but a restart would boot the OLD rev over the migrated
          // data — the honest state is DOWN (the marker write may fail too; the in-flight marker then still says so at boot)
          const failure = { step: 'record', error: `revision.json: ${e?.code ?? e?.message ?? e}` }
          R.rec('record', os.now(), false, failure.error)
          const slot = row.prod
          if (slot.live) { try { await i.stopLive(row, slot, slot.live, 'record-failed') } catch {} }
          markDown(row, slot, failure, { backup: backup?.id ?? null, rev, commit })
          slot.rev = prevSnapshot?.rev ?? null; slot.appDir = g.prev.appDir; slot.legacy = g.prev.legacy
          return await failedAfterGate({ ...failure, prevRev: prevSnapshot?.rev ?? 0 }, rehearsalMs)
        }
        row.prod.commit = commit
        try { i.onSwap(inst, rev) } catch (e) { emit(`[${slug}] onSwap: ${e?.message ?? e}`) }
        emit(MESSAGES.log.live(slug, rev, commit12(commit), Math.round(os.now() - t0)))
        R.rec('record', os.now(), true)
        i.prune(row)
        const v = await finish('green', { rehearsalMs })
        // housekeeping after the verdict, outside the gate (S8): the old backups
        if (backup) await pruneOldBackups(row).catch((e) => emit(`[${slug}] backup prune: ${e?.error ?? e?.message ?? e}`))
        return v
      } catch (e) {
        emit(`[${slug}] deploy crashed: ${e?.stack ?? e}`)
        return await finish(row.prod?.state === 'down' ? 'failed' : 'red', { step: 'deploy', error: e?.message ?? String(e) })
      } finally { row.deploying = null; row.releasing = null }
    })()
    return row.deploying
  }

  // exports not referenced by the kept commits are removed (root owns them) — a `.tmp` too: only a COMPLETE export (renamed
  // into place after its install) is ever reused (`kept`), a half-done one is redone by the next attempt from scratch
  async function pruneExports(row, keepCommits) {
    const keep = new Set(keepCommits.filter(Boolean).map(commit12))
    let names = []
    try { names = fs.readdirSync(i.dot(REL.prodRoot(row.instance))) } catch { return }
    for (const n of names) { if (keep.has(n)) continue; try { fs.rmSync(i.dot(`${REL.prodRoot(row.instance)}/${n}`), { recursive: true, force: true }) } catch (e) { emit(`[${row.slug}] export ${n} prune: ${e.code ?? e.message}`) } }
  }

  // ---------------------------------------------------------------------------------------------
  // restore(row, backup, {by, yes}): prod's data becomes the backup — refused unless the app is DOWN or the caller confirmed
  // (`--yes`); today's data is SNAPSHOT first (a backup row like the deploy's, the same caps, refused in words before the
  // gate when it cannot land), then the backup is copied into a staging tree beside `data/<inst>` and swapped in by two
  // renames — prod is never left empty by a copy that died halfway.
  function restore(row, backup, { by = 'agent:local', yes = false, onStep } = {}) {
    if (row.deploying) throw Object.assign(new Error(MESSAGES.refuse.inProgress()), { status: 409 })
    if (!row.prod || row.prod.rev == null) throw Object.assign(new Error(MESSAGES.refuse.notDeployed()), { status: 404 })
    if (typeof backup !== 'string' || !parseBackupId(backup) || !backups(row).some((b) => b.id === backup)) throw Object.assign(new Error(HOST_MESSAGES.unknownBackup), { status: 404 })
    if (row.prod.state !== 'down' && !yes) throw Object.assign(new Error(MESSAGES.refuse.restoreLive(row.slug, backup)), { status: 409 })
    const t0 = os.now(), inst = row.instance, slug = row.slug, id = newReleaseId()
    const R = recorder(row, { commit: row.prod.commit, message: `restore ${backup}`, onStep })
    const cur = store.current(inst)
    let snap = null
    const finish = async (outcome, extra = {}) => {
      const rel = { id, instance: inst, kind: 'restore', commit: row.prod.commit, message: `restore ${backup}`, at: os.now(), by, verdict: outcome, rev: row.prod.rev, rehearsal: { ms: 0, partial: false, steps: R.steps.map(({ name, ms, ok }) => ({ name, ms, ok })) }, backup, error: extra.reportMessage ?? extra.error ?? null, changelog: null }
      await recordRelease(row, rel)
      const v = { t: 'verdict', outcome, kind: 'restore', slug, commit: row.prod.commit, rev: row.prod.rev, url: url(row), api: api(row), backup, release: id, ms: Math.round(os.now() - t0) }
      if (snap) v.snapshot = snap.id
      if (extra.step) v.step = extra.step
      if (extra.error) v.error = extra.error
      try { onStep?.(v) } catch {}
      return v
    }
    row.deploying = (async () => {
      try {
        if (!cur) return await finish('failed', { step: 'restore', error: 'the prod rev dir is missing' })
        // the snapshot's feasibility BEFORE the gate: unknown / cannot land → RED at `snapshot`, nothing moved
        let data
        try { data = await probeData(row, {}) } catch (e) { R.rec('snapshot', os.now(), false, e.error); emit(MESSAGES.log.restoreRed(slug, backup, 'snapshot', e.error)); return await finish('red', { step: 'snapshot', error: e.error }) }
        const g = await underGate(row, R, {
          rev: cur.rev, commit: row.prod.commit, codeDir: cur.dir, appDir: row.prod.appDir,
          body: async (slot) => {
            await R.step('snapshot', D().backupMs + 500, async () => {
              if (!data.has) return { note: MESSAGES.step.notes.backupNone() }
              snap = await takeBackup(row, { rev: row.prod.rev, commit: row.prod.commit, bytes: data.bytes })
              return { note: MESSAGES.step.notes.backup(snap.id, Math.round(mb(snap.bytes))) }
            })
            await R.step('restore', D().backupMs + 500, async () => {
              const data = i.dot(REL.prodData(inst)), staging = `${data}.restore`, old = `${data}.old`
              await rmrf(staging); await rmrf(old)
              applyPlan(row, dataPlan(staging, row.uid), 'staging dir')
              await copyInto(row, i.dot(REL.backup(inst, backup)), staging, D().backupMs, 'data')
              if (exists(data)) fs.renameSync(data, old)   // the swap: today's tree aside, the staged tree in (two renames in root's own `data/`), then the old tree removed
              fs.renameSync(staging, data)
              await rmrf(old)
              return { note: backup }
            })
          },
          onFail: Object.assign((f) => report(MESSAGES.restoreFailed.kind, inst, prodRev(row), { message: MESSAGES.restoreFailed.message(slug, backup, f.step, f.error), hint: MESSAGES.restoreFailed.hint(slug, backup) }), { backupId: () => backup }),
        })
        if (!g.ok) return await finish('failed', { step: g.step, error: g.error, reportMessage: MESSAGES.restoreFailed.message(slug, backup, g.step, g.error) })
        try { store.prodPatch(inst, { down: undefined, releasing: undefined }) } catch (e) { emit(`[${slug}] down marker clear: ${e?.code ?? e?.message ?? e}`) }
        try { i.onSwap(inst, cur.rev) } catch {}
        emit(MESSAGES.log.restore(slug, backup, Math.round(os.now() - t0)))
        const v = await finish('green')
        if (snap) await pruneOldBackups(row).catch((e) => emit(`[${slug}] backup prune: ${e?.error ?? e?.message ?? e}`))
        return v
      } catch (e) {
        emit(`[${slug}] restore crashed: ${e?.stack ?? e}`)
        return await finish('failed', { step: 'restore', error: e?.message ?? String(e) })
      } finally { row.deploying = null }
    })()
    return row.deploying
  }

  // ---------------------------------------------------------------------------------------------
  // D16: a config PUT at the spine is a release of the same commit — gate → stop → start (the config is fetched
  // at spawn) → probe → release row; no rehearsal, no commit, at most one per app per heartbeat. Never on a DOWN app
  // (the supervisor's onConfigStamp refuses first: a config PUT must not resurrect a failed release).
  function configRelease(row, { by = 'spine:config', onStep } = {}) {
    if (row.deploying || !row.prod || row.prod.rev == null || row.prod.state === 'down') return null
    const t0 = os.now(), inst = row.instance, slug = row.slug, id = newReleaseId()
    const stamp = row.configStamp
    const R = recorder(row, { commit: row.prod.commit, message: `config ${stamp ?? ''}`.trim(), onStep })
    const cur = store.current(inst)
    row.deploying = (async () => {
      try {
        if (!cur) return null
        const g = await underGate(row, R, { rev: cur.rev, commit: row.prod.commit, codeDir: cur.dir, appDir: row.prod.appDir, body: async () => {}, onFail: (f) => report(MESSAGES.configFailed.kind, inst, prodRev(row), { message: MESSAGES.configFailed.message(slug, f.step, f.error), hint: MESSAGES.configFailed.hint(slug) }) })
        const outcome = g.ok ? 'green' : 'failed'
        const rel = { id, instance: inst, kind: 'config', commit: row.prod.commit, message: `config ${stamp ?? ''}`.trim(), at: os.now(), by, verdict: outcome, rev: cur.rev, rehearsal: { ms: 0, partial: false, steps: R.steps.map(({ name, ms, ok }) => ({ name, ms, ok })) }, backup: null, error: g.ok ? null : MESSAGES.configFailed.message(slug, g.step, g.error), changelog: null }
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
      const g = await i.ensureGit(row)
      if (!g.ok) { emit(`[${row.slug}] adopt: git ${g.step} failed (${g.error}) — retried on the next scan`); return null }
      const message = MESSAGES.git.adoptMessage(rev)
      const c = await commitAll({ os, appDir: row.dir, message, log: emit, home: i.cfg.gitHome })
      if (!c.ok) { emit(`[${row.slug}] adopt: git ${c.step} failed (${c.error}) — retried on the next scan`); return null }
      store.commitProd(row.instance, rev, { commit: c.commit, message, deployedAt: nowIso(os.now()), legacy: true })
      if (!store.currentDev(row.instance)) store.link(row.instance, 'current-dev', row.dev.rev ?? rev)
      slot.commit = c.commit; slot.legacy = true; slot.appDir = row.dir; slot.adoptPending = false
      const rel = { id: `adopt-${commit12(c.commit)}`, instance: row.instance, kind: 'adopt', commit: c.commit, message, at: os.now(), by: 'host', verdict: 'green', rev, rehearsal: { ms: 0, partial: false, steps: [] }, backup: null, error: null, changelog: null }
      slot.announced = true
      await recordRelease(row, rel)
      emit(MESSAGES.log.adopt(row.slug, rev, commit12(c.commit)))
      return rel
    }).catch((e) => { emit(`[${row.slug}] adopt crashed: ${e?.stack ?? e}`); return null })
    return row.git
  }

  // announce(row): at every boot the host re-tells the spine the prod commit it holds — an `adopt-<c12>` row, green,
  // idempotent by id (a replay answers 200) — unless the register reply already carried that `deployed_rev`. A
  // migrated registry starts every app at `deployed_rev = "legacy"`; this is how it converges. Marked done only once
  // the spine answered: a spine that was unreachable at that scan is asked again at the next one (S9). No local
  // ledger row — it is not a new release.
  function announce(row) {
    const slot = row.prod
    if (!slot?.commit || slot.announced || slot.adoptPending) return Promise.resolve(null)
    if (slot.announcing) return slot.announcing
    const known = registrar?.apps?.()?.get(row.instance)?.deployed_rev ?? null
    if (known === slot.commit || !registrar?.release) { slot.announced = true; return Promise.resolve(null) }
    const rel = { id: `adopt-${commit12(slot.commit)}`, instance: row.instance, kind: 'adopt', commit: slot.commit, message: MESSAGES.git.adoptMessage(slot.rev), at: os.now(), by: 'host', verdict: 'green', rev: slot.rev, rehearsal: { ms: 0, partial: false, steps: [] }, backup: null, error: null, changelog: null }
    slot.announcing = (async () => {
      try {
        const r = await withBudget(Promise.resolve(registrar.release(rel)), D().recordMs).catch((e) => { emit(`[${row.slug}] announce: ${e?.error ?? e?.message ?? e}`); return null })
        if (r) slot.announced = true
        emit(`[${row.slug}] announced prod commit ${commit12(slot.commit)} (rev ${slot.rev}) to the spine${r ? (r.replay ? ' (replay)' : '') : ' — not recorded, asked again at the next scan'}${known ? ` (spine had ${known === 'legacy' ? 'legacy' : commit12(known)})` : ''}`)
        return r ? rel : null
      } finally { slot.announcing = null }
    })()
    return slot.announcing
  }

  // ---------------------------------------------------------------------------------------------
  // A SEEDED row — the folder carries discovery's SEEDED_MARKER (`.atelier-seeded`; the portal's system host seeds `home`
  // and `catalyst-chrome` from its image at every boot — DESIGN §10.3 "seeded rows"): the folder IS the release. Nobody
  // edits it, the pod has no git and a fresh /work every life, so the prod slot is built straight from the folder in the
  // legacy shape (the bundle from the rev dir, static files and createRequire from the folder), its commit is the folder's
  // CONTENT id (watcher.mjs treeId: the same bytes give the same id on every boot, so the spine replays `adopt-<c12>`), the
  // worker starts at once and ONE `adopt` row goes to the spine. No dev slot, no watcher: nothing D18 can idle-stop out from
  // under the company (2026-09-02: both seeded apps came up `(dev)` and stopped ten minutes later; the portal was dark).
  // Every scan calls it: the same id → the boot announce (which converges a row the spine never recorded); a new id (a
  // re-seed over a kept /work) → a new rev the same way, the old worker retired after the swap. Two failure classes
  // (review 2026-09-02, B1/N1): the FOLDER'S answer (its module.json, a build problem, a worker that failed to load its
  // bytes) is one rev and one report until the bytes change (the sweep rule of §6.1: never a rev every 30 s for one broken
  // tree); a HOST-SIDE failure (the rev counter, the snapshot store, the spawn, the jail, the record) is retried at every
  // scan — reported once per (bytes, reason), never left as a row nothing will ever build again.
  // Every read of the folder holds the app's gid (§6.2): on the real pod the folder is `1000:<uid> 2750` after the claim and
  // the host is userns root WITHOUT DAC_OVERRIDE — an ungrouped read is EACCES, and an EACCES on module.json read as
  // "module.json missing" reproduced the outage on the first scan of the pod (review 2026-09-02, B1).
  function seeded(row) {
    const inst = row.instance, slug = row.slug
    const id = i.withGroupSync(row.uid, () => treeId(row.dir, fs))
    if (!id) { emit(`[${slug}] seeded: folder unreadable — retried on the next scan`); return Promise.resolve(null) }
    if (row.prod?.commit === id && !row.prod.adoptPending) return announce(row)
    if (row.deploying) return row.deploying
    if (row.seededAttempted === id) return Promise.resolve(null)   // the folder's answer stands until its bytes change
    const t0 = os.now()
    row.deploying = (async () => {
      let rev = null
      // one report per (bytes, kind, reason): a host-side failure retried at every scan reaches the chat once
      const once = (kind, message, hint, where) => {
        const key = `${id}\0${kind}\0${message}`
        if (row.seededReported === key) return
        row.seededReported = key
        report(kind, inst, prodRev(row), { message, ...(hint ? { hint } : {}), ...where })
      }
      const drop = () => { if (rev != null) { try { store.remove(inst, rev) } catch {} } if (row.prod && !row.prod.live) row.prod.state = 'stopped' }   // a re-seed's old rev resumes on the next request
      // the folder's answer: its bytes are the problem — not retried until they change
      const fail = (kind, message, hint, where = {}) => {
        row.seededAttempted = id
        once(kind, message, hint, where)
        emit(MESSAGES.log.seededFail(slug, rev ?? '?', hint ?? message))
        drop()
        return null
      }
      // a host-side failure: this folder is asked again at the next scan
      const retry = (kind, message, hint = null, where = {}) => {
        once(kind, message, hint, where)
        emit(MESSAGES.log.seededRetry(slug, rev ?? '?', message))
        drop()
        return null
      }
      try { rev = store.nextRev(inst) } catch (e) { return retry('build', `snapshot write failed: ${e?.code ?? e?.message ?? e}`) }
      row.counter = rev
      const mj = i.withGroupSync(row.uid, () => i.checkModuleJson(row.dir))
      if (!mj.ok) return fail('build', mj.error.message, formatHint(mj.error), { file: mj.error.file, line: mj.error.line, col: mj.error.col })
      if (JSON.stringify(mj.meta) !== JSON.stringify(row.meta)) {   // a re-seed that renamed the app or changed its icon: the registry's meta follows (as build() does)
        row.meta = mj.meta
        try { await registrar?.claim?.({ slug, meta: mj.json, dir: row.dir }) } catch (e) { emit(`[${slug}] meta update: ${e.message}`) }
      }
      let built
      try { built = await i.buildArtefacts(row, { appDir: row.dir, rev }) } catch (e) {
        if (e?.problems) { const p = e.problems[0]; return fail('build', p.message, formatHint(p), { file: p.file, line: p.line, col: p.col }) }
        return retry('build', `snapshot write failed: ${e?.code ?? e?.message ?? e}`)
      }
      // load-beside: a re-seed's old worker keeps serving until the new one is READY (a request meanwhile resumes the old rev).
      // The two workers share ONE data dir — a named exception to D13 (prod never overlaps) for a folder nobody deploys to —
      // so a MOUNT-ERROR beside the old worker gets build()'s one-shot retry: stop the old worker, start once more.
      const slot = row.prod ?? i.prodSlot(row, { rev: null, commit: null, legacy: true })
      let next, retried = false
      for (;;) {
        try { next = await i.startWorker(row, slot, rev, built.written.dir); break } catch (e) {
          // the config hold (supervisor §6.1): the door failed and the row has no document — no worker, the prod slot `loading`
          // (a request answers 503 app not ready, never 404 not deployed), the rev dropped, no report; the scan retries once
          // the door answers (`seededAttempted` cleared: the same bytes are built again — the failure was never the folder's)
          if (e?.error === 'config-held') { try { store.remove(inst, rev) } catch {} ; row.seededAttempted = null; slot.configHeld = true; if (!slot.live) slot.state = 'loading'; row.prod = slot; return null }
          if (e.failed?.code === 'MOUNT-ERROR' && slot.live && !retried) {
            retried = true
            emit(`[${slug}] rev ${rev} mount failed beside rev ${slot.live.rev} — retrying once after the old worker exits`)
            const old = slot.live; slot.live = null; slot.state = 'loading'
            await i.stopLive(row, slot, old, 'mount-retry')
            continue
          }
          const p = e.failed ? i.withGroupSync(row.uid, () => classifyWorkerFailure(e.failed, { appDir: row.dir, fs, map: built.map })) : null
          const message = p?.message ?? `${e.error}: ${e.msg}`, hint = p ? formatHint(p) : null, where = p ? { file: p.file, line: p.line, col: p.col } : {}
          return ['spawn-eagain', 'jail', 'host-fault'].includes(e.error) ? retry('worker', message, hint, where) : fail('worker', message, hint, where)
        }
      }
      const chrome = i.chromeNameOf?.() ?? null   // the sheet was compiled against it (rebuildAll reads it back)
      try { store.commitProd(inst, rev, { commit: id, message: MESSAGES.git.seededMessage(rev), deployedAt: nowIso(os.now()), legacy: true, ...(chrome ? { chrome } : {}) }) } catch (e) {
        try { await i.stopLive(row, slot, next.live, 'seeded-record-failed') } catch {}
        return retry('build', `revision.json: ${e?.code ?? e?.message ?? e}`)
      }
      const old = slot.live
      slot.live = next.live; slot.rev = rev; slot.state = 'live'; slot.commit = id; slot.legacy = true; slot.appDir = row.dir
      slot.resources = next.resources; slot.suspendable = next.suspendable; slot.restarts = 0; slot.down = null; slot.adoptPending = false
      row.prod = slot
      if (old) { slot.kept.push({ rev: old.rev, until: os.now() + T.keepMs }); slot.retiring.add(old); i.later(T.swapStopMs, () => i.stopLive(row, slot, old, 'reseed')); i.later(T.keepMs + 50, () => i.prune(row)) }   // retiring: teardown stops it too
      try { i.onSwap(inst, rev) } catch (e) { emit(`[${slug}] onSwap: ${e?.message ?? e}`) }
      i.armIdle(row, slot)   // R14: prod idle-stops only on empty resources, resumed on the next request with requests held
      emit(MESSAGES.log.live(slug, rev, commit12(id), Math.round(os.now() - t0)))
      emit(MESSAGES.log.seeded(slug, rev, commit12(id)))
      // the release row; `announced` is NOT set here — a spine that refused or was unreachable is asked again by the next
      // scan's announce (idempotent by id), and a spine that recorded it already holds the commit (registrar.release notes it)
      const rel = { id: `adopt-${commit12(id)}`, instance: inst, kind: 'adopt', commit: id, message: MESSAGES.git.seededMessage(rev), at: os.now(), by: 'host', verdict: 'green', rev, rehearsal: { ms: 0, partial: false, steps: [] }, backup: null, error: null, changelog: null }
      await recordRelease(row, rel)
      return rel
    })().catch((e) => { emit(`[${slug}] seeded crashed: ${e?.stack ?? e}`); return null }).finally(() => { row.deploying = null })
    return row.deploying
  }

  return { deploy, restore, configRelease, adopt, announce, seeded, releases, backups, pruneOldBackups }
}
