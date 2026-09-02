// host/index.mjs — the host: one process that wires the five lanes (DESIGN §1.1, §1.2, §2.3).
//
// In the fleet the launcher spawns it as root with fd 3 = the `.atelier` dirfd (row H); on a
// laptop `node host/index.mjs` runs it unprivileged in local mode (folder registry, identity
// `local`, no uid drop). Boot order is load-bearing (OR8): last-good snapshots are served and
// `host-ready` is written before the first folder scan, the first build or any spine round trip
// completes — in fleet mode `host-ready` waits for the registrar's epoch, local mode has no wait.
// The one exception is a SEEDED host (cfg.seededApps — the portal's system host, whose whole job is
// the two folders its image seeds and whose /work has no last-good at birth): there `host-ready`
// follows the first scan, so Ready never means "listening, 404 for everything the company asks for"
// (readyAfter; bounded, so a broken seeded folder still lets the pod come up and report).
import fs from 'node:fs'
import path from 'node:path'
import { networkInterfaces } from 'node:os'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { linuxRoot, unprivileged } from './adapters/os.mjs'
import { createSupervisor } from './supervisor/index.mjs'
import { buildSheet } from './supervisor/tailwind.mjs'
import { spawnWorker } from './worker/spawn.mjs'
import { proxyRequest } from './worker/proxy.mjs'
import { jailPlan, applyJail, claimRoundTrip } from './worker/jail.mjs'
import { installDeps } from './worker/install.mjs'
import { runHook } from './worker/hook.mjs'
import { createCollector } from './errors/collector.mjs'
import { agentLog } from './errors/agentlog.mjs'
import { push } from './errors/push.mjs'
import { frontendReport } from './errors/report.mjs'
import { createWatchdog } from './errors/watchdog.mjs'
import { createRegistrar, spineTransport, localTransport, HEARTBEAT_MS } from './protocol/registrar.mjs'
import { createAuth } from './protocol/auth.mjs'
import { createServer, HOST_TLS_PLAIN } from './protocol/server.mjs'
import { createEvents } from './protocol/events.mjs'
import { createDevShell } from './protocol/devshell.mjs'
import { createChromeCache, CACHE_REL } from './chrome/fetch.mjs'
import { createMetrics } from './metrics.mjs'

export const TEARDOWN_CAP_MS = 30_000
export const LISTENER_DRAIN_MS = 20_000      // §4.7's 25 s long-poll minus the rest of the teardown inside the 30 s cap
export const DIRFD_CHECK_MS = 5000
export const APPS_WATCH_DEBOUNCE_MS = 300
export const RESCAN_MS = 30_000
export const PENDING_WATCH_MAX = 32

/** config(env) — DESIGN §1.2; env only, set by the launcher (fleet) or the developer (local). */
export function config(env) {
  const dirfd = env.ATELIER_DIRFD !== undefined && /^\d+$/.test(env.ATELIER_DIRFD) ? Number(env.ATELIER_DIRFD) : null
  const spineUrl = env.ATELIER_SPINE_URL || null
  return {
    work: env.ATELIER_WORK ?? '/work',
    run: env.ATELIER_RUN ?? '/run/atelier',
    control: env.ATELIER_CONTROL ?? '/control',
    dirfd,
    chromeDir: env.ATELIER_CHROME_DIR || null,
    hostPort: Number(env.ATELIER_HOST_PORT ?? 1845),
    devPort: Number(env.ATELIER_DEV_PORT ?? 1844),
    spineUrl,
    fleet: !!spineUrl,
    company: env.ATELIER_COMPANY ?? 'local',
    origin: env.ATELIER_ORIGIN ?? `http://127.0.0.1:${env.ATELIER_DEV_PORT ?? 1844}`,
    hostTls: env.ATELIER_HOST_TLS || null,
    nodeEnv: env.NODE_ENV ?? 'production',
    gitCommit: env.ATELIER_GIT_COMMIT !== '0',
    gitHome: env.ATELIER_GIT_HOME ?? (spineUrl ? '/work' : (env.HOME ?? '/work')),   // row G's HOME: /work in the fleet, the developer's on a laptop
    appsLinks: env.ATELIER_APPS_LINKS === '1' && !spineUrl,   // symlinked app folders (shell/ local mode, DESIGN §8 H1); refused in the fleet
    // the seeded road (DESIGN §10.3 "seeded rows") is opened by the HOST's configuration, never by a file in a folder the
    // agent owns: only the portal-host image sets ATELIER_SEEDED_APPS=1 (its Containerfile ENV); the per-folder
    // `.atelier-seeded` marker then says WHICH folders. On every other host the marker is inert — a folder carrying it
    // boots dev-only like any new folder (review 2026-09-02 B2: an agent could otherwise mint a PROD release with
    // `touch .atelier-seeded`, past the gate, the rehearsal, the backup and git)
    seededApps: env.ATELIER_SEEDED_APPS === '1',
  }
}

/** SEEDED_READY_MS — the bound on a seeded host's wait for its first scan before `host-ready` (review 2026-09-02 S1). */
export const SEEDED_READY_MS = 60_000
/** readyAfter(cfg, firstScan, {timeoutMs}) → 'now' | 'scanned' | 'timeout': when `host-ready` may be written. A normal host: at
 *  once (OR8 — snapshots are served, the scan is not waited for). A seeded host (cfg.seededApps): after the first scan settled —
 *  its seeded rows are built and LIVE inside that scan — or after timeoutMs, whichever first; a scan that rejected counts as
 *  settled (the pod comes up and the failure is reported). */
export function readyAfter(cfg, firstScan, { timeoutMs = SEEDED_READY_MS } = {}) {
  if (!cfg.seededApps) return Promise.resolve('now')
  let timer
  const scanned = Promise.resolve(firstScan).then(() => 'scanned', () => 'scanned')
  const late = new Promise((r) => { timer = setTimeout(() => r('timeout'), timeoutMs); timer.unref?.() })
  return Promise.race([scanned, late]).finally(() => clearTimeout(timer))
}

/** The pod IP the heartbeat reports: the first non-internal IPv4 address (null on a laptop with none). */
export function podIp(ifaces = networkInterfaces()) {
  for (const list of Object.values(ifaces)) for (const a of list ?? []) if (!a.internal && a.family === 'IPv4') return a.address
  return null
}

/**
 * The directories the host itself owns beyond the launcher's plan (DESIGN §3, §10.3): `.atelier/tmp` (the
 * workers' TMPDIR parents), `$run/w` (the socket dirs) and the release rows `.atelier/{data-dev,prod,rehearsal,
 * backup}` (0711 root; the per-instance dirs below are the jail plans'). Local mode adds the launcher's rows
 * too (there is no launcher on a laptop) and mints the dev token when none exists.
 */
export function hostDirs(cfg, { local }) {
  const W = cfg.work, R = cfg.run
  const launcherRows = [
    [`${W}/.atelier`, 0o711], [`${W}/.atelier/data`, 0o711], [`${W}/.atelier/last-good`, 0o711], [`${W}/.atelier/scratch`, 0o711],
    [`${W}/apps`, 0o755], [R, 0o711], [`${R}/dev`, 0o710], [`${R}/session`, 0o700],
  ]
  return [...(local ? launcherRows : []), [R, 0o711], [`${W}/.atelier/tmp`, 0o711], [`${R}/w`, 0o711],
    [`${W}/.atelier/data-dev`, 0o711], [`${W}/.atelier/prod`, 0o711], [`${W}/.atelier/rehearsal`, 0o711], [`${W}/.atelier/backup`, 0o711],
    [`${W}/.atelier/${CACHE_REL}`, 0o755]]   // the chrome cache (step 7 ship C): the host's alone; the releases under it 0755/0644
}
// mkdir with the mode (chmod after: the host runs under umask 077); an EXISTING root-owned dir with
// another mode is chmodded (the launcher closes `$run` 1777 → 0711 before any uid-1000 process exists;
// this is the second check). An existing dir NOT owned by root (privileged mode) is a refusal: a
// uid-1000 `$run/w` or `.atelier/tmp` would be the agent's, and the host never spawns into it.
export function ensureDirs(os, rows, log) {
  for (const [p, mode] of rows) {
    try { os.mkdir(p, mode); os.chmod(p, mode) } catch (e) {
      if (e.code !== 'EEXIST') { log(`mkdir ${p}: ${e.code ?? e.message}`); throw e }
      const st = os.lstat(p)
      if (os.privileged && (st.uid !== 0 || st.gid !== 0)) throw Object.assign(new Error(`${p} exists owned ${st.uid}:${st.gid} (want 0:0) — refusing to use it`), { code: 'EOWNER', path: p })
      if (st.uid === 0 && (st.mode & 0o7777) !== mode) { const r = os.chmod(p, mode); log(`chmod ${p} ${(st.mode & 0o7777).toString(8)} → ${mode.toString(8)}${r?.skipped ? ' (skipped)' : ''}`) }
    }
  }
}

/**
 * pendingWatches({watch, onEvent, log, max}) — one non-recursive watch per folder discovery skipped as
 * `no-module-json` (a scaffold in progress: mkdir, files, module.json last — git clone, a generator);
 * the folder's next event (its module.json landing) triggers a rescan instead of the 30 s safety net.
 * `sync(dirs)` reconciles the set (closed once the folder became an app or vanished); ≤ `max` watches.
 */
export function pendingWatches({ watch = (d, opts, cb) => fs.watch(d, opts, cb), onEvent, log = () => {}, max = PENDING_WATCH_MAX } = {}) {
  const watches = new Map()
  return {
    sync(dirs) {
      const want = new Set(dirs.slice(0, max))
      for (const [d, w] of watches) if (!want.has(d)) { try { w.close() } catch {} watches.delete(d) }
      for (const d of want) {
        if (watches.has(d)) continue
        try {
          const w = watch(d, { persistent: false }, () => onEvent(d))
          w.on?.('error', () => { try { w.close() } catch {} watches.delete(d); onEvent(d) })
          watches.set(d, w)
        } catch (e) { log(`pending watch ${d}: ${e.code ?? e.message}`) }
      }
      if (dirs.length > max) log(`pending watches: ${dirs.length} folders without module.json, watching ${max} (the rest on the ${RESCAN_MS / 1000} s rescan)`)
    },
    size: () => watches.size,
    close() { for (const w of watches.values()) { try { w.close() } catch {} } watches.clear() },
  }
}
function ensureDevToken(cfg, log) {
  const p = `${cfg.run}/dev.token`
  if (fs.existsSync(p)) return
  const token = randomBytes(32).toString('hex')
  fs.writeFileSync(p, token, { mode: 0o400, flag: 'wx' })
  try { fs.writeFileSync(`${cfg.run}/session/dev.token`, token, { mode: 0o400, flag: 'wx' }) } catch {}
  log(`dev token minted at ${p} (local mode)`)
}

/**
 * Startup audit (DESIGN §6.5, PLAN §4.3 Hygiene): nothing a uid outside its owner set may read —
 * the tokens (0400 root), `/work/.claude` and `/control` (agent-private, no o bits), the agent's
 * credential files `/work/.claude.json` (API-key tails), `/work/.mcp.json`, `/work/.claude/settings.json`
 * (0600), `last-good/<inst>`, `data/<inst>`, `data-dev/<inst>`, `prod/<inst>`, `rehearsal/<inst>`, `backup/<inst>` (no `o+r`). Returns `{bad, absent}`: the host refuses
 * to serve while `bad` is non-empty; `absent` names what was not there to check (logged, so a drill
 * tells "not there yet" from "checked").
 */
export function audit(os, cfg, dirfd, { fs: fsx = fs } = {}) {
  const bad = [], absent = []
  const check = (p, ok) => { let st; try { st = os.lstat(p) } catch { absent.push(p); return }; if (!ok(st.mode & 0o7777, st)) bad.push(`${p} ${(st.mode & 0o7777).toString(8)} ${st.uid}:${st.gid}`) }
  check(`${cfg.run}/bootstrap.token`, (m) => (m & 0o077) === 0)
  check(`${cfg.run}/dev.token`, (m) => (m & 0o077) === 0)
  check(`${cfg.work}/.claude`, (m) => (m & 0o007) === 0)
  check(cfg.control, (m) => (m & 0o007) === 0)
  for (const f of ['.claude.json', '.mcp.json', '.claude/settings.json']) check(`${cfg.work}/${f}`, (m) => (m & 0o077) === 0)
  for (const sub of ['last-good', 'data', 'data-dev', 'prod', 'rehearsal', 'backup']) {
    let names = []
    try { names = fsx.readdirSync(os.at(dirfd, sub)) } catch {}
    for (const n of names) check(os.at(dirfd, `${sub}/${n}`), (m) => (m & 0o007) === 0)
  }
  return { bad, absent }
}

export async function main({ env = process.env, signals = process, exit = (c) => process.exit(c), stderr = process.stderr } = {}) {
  const cfg = config(env)
  const privileged = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0
  const os = privileged ? linuxRoot() : unprivileged()
  const local = !cfg.fleet
  const say = (line) => { try { stderr.write(`[host] ${line}\n`) } catch {} }
  if (!privileged) say('jail: lifecycle-only (no uid drop)')
  say(`mode: ${local ? 'local' : 'fleet'} work=${cfg.work} run=${cfg.run}${cfg.chromeDir ? ` chrome=${cfg.chromeDir}` : ''}`)
  // mTLS on the protocol port is mandatory in the fleet (PLAN §4.3 "Beyond uid": a worker in the shared
  // netns must be TLS-refused before HTTP); `plain` is an explicit, logged opt-out for a drill, never a default
  if (cfg.fleet && !cfg.hostTls) { say('fleet mode needs ATELIER_HOST_TLS=cert.pem,key.pem,ca.pem (mTLS on the protocol port) — refusing to start'); exit(2); return null }
  if (cfg.fleet && cfg.hostTls === HOST_TLS_PLAIN) say('INSECURE: ATELIER_HOST_TLS=plain — the protocol port serves plain HTTP (bearer-gated only); every worker in this pod can reach it')

  // ---- the tree, the dirfd, the log
  try { ensureDirs(os, hostDirs(cfg, { local: cfg.dirfd === null }), say) } catch (e) { say(`dirs: ${e.message} — exit 2`); exit(2); return null }
  if (cfg.dirfd === null) ensureDevToken(cfg, say)
  const dirfd = cfg.dirfd ?? os.openDir(`${cfg.work}/.atelier`)
  const atelierPath = path.resolve(`${cfg.work}/.atelier`)
  const supervisorRef = { current: null }
  const slugOf = (inst) => supervisorRef.current?.apps().find((r) => r.instance === inst)?.slug
  const log = agentLog({ os, path: os.at(dirfd, 'agent.log'), stderr, slugOf })
  const hostLog = (line) => { say(line) }
  // supervisor lines: every one to stderr; LIVE / STOPPED / RESUMED / the release lines to agent.log (FAILED /
  // KILLED reach agent.log through the collector sink — one line per failure, DESIGN §L1)
  const supLog = (line) => { say(line); if (/ rev \d+ (LIVE |STOPPED|RESUMED)|^\[[^\]]+\] (deploy |adopt: |restore |config release: |boot: rev \d+ stays DOWN|backup \S+ pruned)/.test(line)) log.line(line) }

  // ---- metrics (PLAN §4.5): one recorder, fed by the supervisor, the watchdog and the events lane,
  // served by the protocol port at /_host/metrics
  const metrics = createMetrics()

  // ---- errors
  const collector = createCollector({ log })
  collector.sink(log.appError)

  // ---- registrar + transport (DESIGN §7); the push lanes ride registrar.lane (re-register on epoch-moved)
  const transport = local ? localTransport(cfg, dirfd, { os }) : spineTransport(cfg)
  const ip = podIp()
  const rcfg = { ...cfg, podIp: ip, hostBind: local ? '127.0.0.1' : (ip ?? '0.0.0.0') }   // the protocol port: the pod IP alone in the fleet (no loopback path for a worker), loopback on a laptop
  if (!local && !ip) hostLog('no pod IP found — the protocol port binds 0.0.0.0')
  const chromeRef = { current: null }
  // the heartbeat reports the digest every prod sheet is BUILT with (`chrome.built()`, review 2026-09-02 S2), never the one
  // merely held: the shell composes an app document's JS from the reported digest and its CSS is the sheet the host built
  const registrar = createRegistrar({ os, dirfd, transport, cfg: rcfg, log: hostLog, liveWorkers: () => supervisorRef.current?.workers().filter((w) => w.slot === 'prod').map((w) => w.instance) ?? [], chromeDigest: () => chromeRef.current?.built() ?? null })
  // the chrome cache (DESIGN §6.4, step 7 ship C): the register/heartbeat answer names the computer's effective release
  // (`registrar.onChrome`), the cache fetches and verifies it AFTER `registered` resolves — never on the boot path. A swap,
  // and every later beat naming the held digest, rebuilds what is behind (`supervisor.rebuildAll`, all or nothing, once the
  // supervisor has booted); the digest is reported (one beat, at once) only when every prod sheet is built against it
  let bootDone; const booted = new Promise((r) => { bootDone = r })
  let lastChromeLine = null
  const settle = async (digest, prev) => {
    await booted
    const r = await supervisorRef.current?.rebuildAll(digest.slice(0, 12))
    if (!r) return { complete: false }
    if (r.prod.length || r.dev.length || r.skipped.length) {
      const line = `host: chrome ${prev && prev !== digest ? `${prev.slice(0, 12)}… → ` : ''}${digest.slice(0, 12)}… — ${r.prod.length} prod sheet(s) rebuilt, ${r.dev.length} dev rebuild(s)${r.skipped.length ? `; ${r.skipped.map(([i, why]) => `${slugOf(i) ?? i} ${why.split(':')[0]}`).join(', ')} — nothing moved, still reporting ${prev ? prev.slice(0, 12) + '…' : 'no chrome'}, retry at the next beat` : ''}`
      if (line !== lastChromeLine) { lastChromeLine = line; log.line(line) }   // a stuck row is one line, not one per beat
    }
    return { complete: r.complete }
  }
  const chrome = createChromeCache({
    cache: `${cfg.work}/.atelier/${CACHE_REL}`, fixedDir: cfg.chromeDir, transport: { chrome: (d) => registrar.chromeFetch(d) }, log: hostLog,
    onSwap: settle, onHold: settle,
    onBuilt: async () => { await registrar.beat() },   // report it now, not at the interval's next tick
  })
  chromeRef.current = chrome
  registrar.onChrome = (c) => chrome.want(c)
  const events = createEvents({ transport: registrar.lane, hostId: () => registrar.hostId, epoch: () => registrar.epoch, log: hostLog, metrics })
  const pusher = local ? null : push({ transport: registrar.lane, running: collector.running, log: hostLog })
  if (pusher) collector.sink(pusher)

  // ---- the host-fault state (PLAN §4.3 "Ownership of /work": a missing or renamed .atelier is a fault —
  // refuse to serve, alarm — never a fresh boot). `treeOk()` is checked by the dirfd timer and by the
  // supervisor before any real path leaves the host; `fault` is the reason both listeners answer 503 with.
  let fault = null
  const treeOk = () => {
    if (!privileged) return true
    let target = null
    try { target = os.readlinkFd(dirfd) } catch (e) { target = `error ${e.code}` }
    return target === atelierPath
  }

  // ---- the shells (created before the supervisor so onSwap/onBroadcast can reach them)
  const auth = createAuth({ registrar, os, cfg, log: hostLog })
  const report = frontendReport({ collector })
  let dev = null, server = null

  // ---- supervisor ⇄ workers
  const supervisor = createSupervisor({
    os, dirfd, cfg, log: supLog, registrar, treeOk: () => fault === null && treeOk(), metrics,
    // every report → the collector; a failed save (the `build`/`css`/`load` classes, DESIGN §6.3) also
    // reaches the dev shell's page as the 1.x `backend-error` frame — the agent's browser shows
    // `file:line:col message — fix` while users stay on the previous rev; the next swap clears it
    report: (kind, instance, rev, d) => {
      collector.report(kind, instance, rev, d)
      if (d?.file && d?.hint) dev?.backendError(instance, `rev ${rev}: ${d.hint}`)
    },
    spawn: spawnWorker, proxy: proxyRequest, hook: runHook, hostEnv: process.env,
    jail: privileged ? { jailPlan, applyJail, claimRoundTrip } : null,
    // the install's beforeFreeze: freeze.py SIGKILLs every process of the worker uid (both slots) — the supervisor
    // stops dev and holds prod under its gate until the install settles (DESIGN §10.3)
    install: privileged ? (a) => installDeps({ ...a, beforeFreeze: () => supervisor.stop(a.spec.instance) }) : null,
    // a PROD release (deploy.mjs step 4): the running rev, the shell's invalidate, the registry's rev
    onSwap: (instance, rev) => {
      collector.setRunning(instance, rev)
      events.invalidate(instance)
      registrar.modulesChanged(instance, rev).catch((e) => hostLog(`modules-changed ${instance}: ${e.message}`))
    },
    // a DEV swap (D3): the dev shell's reload frame only — the company's shell never hears of dev
    onDevSwap: (instance, rev) => {
      dev?.backendError(instance, null)
      dev?.invalidate(instance, { rev })
    },
    onResume: (instance, rev) => collector.setRunning(instance, rev),   // frontend reports against a resumed rev are not `no-running-rev`
    onBroadcast: (row, event) => dev?.broadcast(row.instance, event),
    chrome,
  })
  supervisorRef.current = supervisor
  registrar.onConfigStamp = (instance, updated) => supervisor.onConfigStamp(instance, updated)   // D16: the heartbeat's config stamps → a release under the gate
  const watchdog = createWatchdog({ os, workers: supervisor.workers, report: collector.report, kill: (instance, why, slot) => supervisor.kill(instance, why, slot), dataRoot: os.at(dirfd, 'data'), log: hostLog, metrics })

  const refuse = () => fault
  server = createServer({ cfg: rcfg, auth, supervisor, collector, registrar, log: hostLog, frontendReport: report, refuse, metrics })
  // the dev shell's chrome sheet: compiled against the chrome the host holds NOW (the release's cache, else ATELIER_CHROME_DIR)
  const chromeSheet = async () => { const d = chrome.dir(); if (!d) return null; const r = await buildSheet({ chromeDir: d, appDir: null, chromeBase: chrome.base() }); return { body: Buffer.from(r.css), type: 'text/css; charset=utf-8' } }
  dev = createDevShell({ cfg, os, supervisor, collector, registrar, auth, log: hostLog, frontendReport: report, chromeSheet, chrome, refuse })

  // ---- boot (§1.1 order): snapshots → the audit (nothing listens while a credential or a snapshot is
  // readable by a foreign uid) → both listeners → the registrar's epoch (fleet) → host-ready
  const registered = registrar.register()          // fleet: retries with backoff; snapshots are served meanwhile
  registered.catch(() => {})
  if (local) await registered
  await supervisor.boot()
  bootDone()
  say(`boot: ${supervisor.apps().length} snapshot(s)${chrome.digest() ? ` chrome ${chrome.digest().slice(0, 12)}… (cached)` : ''}`)
  let a = audit(os, cfg, dirfd)
  if (a.absent.length) hostLog(`audit: not present (not checked): ${a.absent.join(', ')}`)
  while (a.bad.length) {
    hostLog(`audit: refusing to serve — readable by a foreign uid: ${a.bad.join(', ')} (retry in 5 s)`)
    await new Promise((r) => setTimeout(r, 5000))
    a = audit(os, cfg, dirfd)
  }
  await server.listen()
  await dev.listen()
  if (!local) await registered
  const ready = `${cfg.run}/host-ready`
  // discovery: one scan now, one per change of the apps root (a new or removed folder; debounced —
  // saves inside an app are the per-app watcher's), one per event in a folder still without module.json
  // (pendingWatches), and one every RESCAN_MS as the safety net. Scans are serialized; a change during
  // a scan queues exactly one more. `rescan()` hands back the chain, settled when that scan is done.
  const appsDir = `${cfg.work}/apps`
  let scanChain = Promise.resolve(), scanQueued = false
  const rescan = () => {
    if (scanQueued || fault) return scanChain
    scanQueued = true
    scanChain = scanChain.then(async () => {
      scanQueued = false
      if (fault) return
      const d = await supervisor.scan().catch((e) => { hostLog(`scan: ${e?.stack ?? e}`); return null })
      pending.sync((d?.skipped ?? []).filter((x) => x.reason === 'no-module-json').map((x) => x.dir))
    })
    return scanChain
  }
  let appsTimer = null
  let appsWatch = null
  const debounced = () => { clearTimeout(appsTimer); appsTimer = setTimeout(rescan, APPS_WATCH_DEBOUNCE_MS) }
  const pending = pendingWatches({ onEvent: debounced, log: hostLog })
  try { appsWatch = fs.watch(appsDir, { persistent: false }, debounced) } catch (e) { hostLog(`apps watch: ${e.code ?? e.message} (periodic rescan only)`) }
  appsWatch?.on?.('error', (e) => hostLog(`apps watch error: ${e.code ?? e.message}`))
  const firstScan = rescan()
  const rescanTimer = setInterval(rescan, RESCAN_MS); rescanTimer.unref?.()
  watchdog.start()
  registrar.heartbeat(HEARTBEAT_MS)
  // host-ready: at once on a normal host (OR8: the snapshots serve, the scan is not waited for); on a seeded host after the
  // first scan built its seeded rows — bounded — so Ready never means "listening, 404 for the company's two apps" (S1)
  const why = await readyAfter(cfg, firstScan)
  if (fault) return null
  try { fs.unlinkSync(ready) } catch {}
  fs.writeFileSync(ready, `${process.pid}\n`, { mode: 0o644, flag: 'wx' })   // exclusive: a pre-existing entry is never adopted
  try { os.chmod(ready, 0o644) } catch {}
  log.line(`host: ready pid ${process.pid} ${local ? 'local' : `host=${registrar.hostId} epoch=${registrar.epoch}`}${why === 'now' ? '' : ` (seeded host: ${why === 'scanned' ? 'after the first scan' : `the first scan did not settle within ${SEEDED_READY_MS / 1000} s`})`}`)
  // the fault: 503 on both listeners, no scan, no build, no resume; host-ready unlinked (the kube probe
  // goes red, the launcher's restart does not help — the operator restores the tree); one `worker` event
  // per app so the agent and the spine hear it (OR16); the log line repeats every DIRFD_CHECK_MS
  const enterFault = (why) => {
    if (fault) return
    fault = why
    hostLog(`FAULT: ${why} — refusing to serve (503), no scans, no spawns`)
    log.line(`host: FAULT ${why}`)
    try { fs.unlinkSync(ready) } catch {}
    clearInterval(rescanTimer); clearTimeout(appsTimer); appsWatch?.close?.(); pending.close()
    for (const r of supervisor.apps()) collector.report('worker', r.instance, r.rev ?? 0, { message: `host fault: ${why}`, hint: 'the computer\'s /work/.atelier was renamed or removed — nothing is served until the operator restores it; a fresh folder there is NOT a fresh start' })
  }
  const dirfdCheck = privileged ? setInterval(() => {
    if (treeOk()) return
    let target = null
    try { target = os.readlinkFd(dirfd) } catch (e) { target = `error ${e.code}` }
    enterFault(`.atelier dirfd resolves to ${target} (want ${atelierPath}) — the agent renamed or removed it`)
  }, DIRFD_CHECK_MS) : null
  dirfdCheck?.unref?.()

  // ---- teardown (§2.3)
  let stopping = false
  async function teardown(signal) {
    if (stopping) return
    stopping = true
    say(`${signal} → teardown`)
    const cap = setTimeout(() => { say('teardown: cap reached, exiting'); exit(0) }, TEARDOWN_CAP_MS)
    cap.unref?.()
    try { fs.unlinkSync(ready) } catch {}
    if (dirfdCheck) clearInterval(dirfdCheck)
    clearInterval(rescanTimer); clearTimeout(appsTimer); appsWatch?.close?.(); pending.close()
    registrar.stop()
    if (!local) { try { await Promise.race([registrar.draining(), new Promise((r) => setTimeout(r, 2000))]) } catch (e) { hostLog(`draining: ${e.message}`) } }
    await Promise.all([server.close(LISTENER_DRAIN_MS), dev.close(LISTENER_DRAIN_MS)])   // in-flight shell requests finish (≤ 20 s), new connections refused
    watchdog.stop()                                        // SIGCONT every stopped worker BEFORE the SIGTERMs: a stopped process cannot run its teardown
    await supervisor.teardown()
    await events.drain(1000)
    events.stop()
    pusher?.stop()
    collector.flush()
    log.line('host: stopped')
    clearTimeout(cap)
    exit(0)
  }
  signals.on('SIGTERM', () => teardown('SIGTERM'))
  signals.on('SIGINT', () => teardown('SIGINT'))
  return { cfg, os, dirfd, supervisor, registrar, server, dev, events, collector, watchdog, metrics, chrome, teardown, fault: () => fault, enterFault }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { process.stderr.write(`[host] fatal: ${e?.stack ?? e}\n`); process.exit(2) })
}
