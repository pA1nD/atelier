// host/index.mjs — the host: one process that wires the five lanes (DESIGN §1.1, §1.2, §2.3).
//
// In the fleet the launcher spawns it as root with fd 3 = the `.atelier` dirfd (row H); on a
// laptop `node host/index.mjs` runs it unprivileged in local mode (folder registry, identity
// `local`, no uid drop). Boot order is load-bearing (OR8): last-good snapshots are served and
// `host-ready` is written before the first folder scan, the first build or any spine round trip
// completes — in fleet mode `host-ready` waits for the registrar's epoch, local mode has no wait.
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
import { createCollector } from './errors/collector.mjs'
import { agentLog } from './errors/agentlog.mjs'
import { push } from './errors/push.mjs'
import { frontendReport } from './errors/report.mjs'
import { createWatchdog } from './errors/watchdog.mjs'
import { createRegistrar, spineTransport, localTransport, HEARTBEAT_MS } from './protocol/registrar.mjs'
import { createAuth } from './protocol/auth.mjs'
import { createServer } from './protocol/server.mjs'
import { createEvents } from './protocol/events.mjs'
import { createDevShell } from './protocol/devshell.mjs'

export const TEARDOWN_CAP_MS = 30_000
export const DIRFD_CHECK_MS = 5000

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
  }
}

/** The pod IP the heartbeat reports: the first non-internal IPv4 address (null on a laptop with none). */
export function podIp(ifaces = networkInterfaces()) {
  for (const list of Object.values(ifaces)) for (const a of list ?? []) if (!a.internal && a.family === 'IPv4') return a.address
  return null
}

/**
 * The directories the host itself owns beyond the launcher's plan (DESIGN §3): `.atelier/tmp` (the
 * workers' TMPDIR parents) and `$run/w` (the socket dirs). Local mode adds the launcher's rows too
 * (there is no launcher on a laptop) and mints the dev token when none exists.
 */
export function hostDirs(cfg, { local }) {
  const W = cfg.work, R = cfg.run
  const launcherRows = [
    [`${W}/.atelier`, 0o755], [`${W}/.atelier/data`, 0o711], [`${W}/.atelier/last-good`, 0o711], [`${W}/.atelier/scratch`, 0o711],
    [`${W}/apps`, 0o755], [R, 0o711], [`${R}/dev`, 0o710], [`${R}/session`, 0o700],
  ]
  return [...(local ? launcherRows : []), [`${W}/.atelier/tmp`, 0o711], [`${R}/w`, 0o711]]
}
function ensureDirs(os, rows, log) {
  for (const [p, mode] of rows) {
    try { os.mkdir(p, mode); os.chmod(p, mode) } catch (e) { if (e.code !== 'EEXIST') { log(`mkdir ${p}: ${e.code ?? e.message}`); throw e } }
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
 * Startup audit (DESIGN §6.5): nothing a uid outside its owner set may read — `bootstrap.token`
 * (0400 root), `/work/.claude` and `/control` (agent-private), `last-good/<inst>` and `data/<inst>`
 * (no `o+r`). Returns the offending paths; the host refuses to serve while the list is non-empty.
 */
export function audit(os, cfg, dirfd, { fs: fsx = fs } = {}) {
  const bad = []
  const check = (p, ok) => { let st; try { st = os.lstat(p) } catch { return }; if (!ok(st.mode & 0o7777, st)) bad.push(`${p} ${(st.mode & 0o7777).toString(8)} ${st.uid}:${st.gid}`) }
  check(`${cfg.run}/bootstrap.token`, (m) => (m & 0o077) === 0)
  check(`${cfg.run}/dev.token`, (m) => (m & 0o077) === 0)
  check(`${cfg.work}/.claude`, (m) => (m & 0o007) === 0)
  check(cfg.control, (m) => (m & 0o007) === 0)
  for (const sub of ['last-good', 'data']) {
    let names = []
    try { names = fsx.readdirSync(os.at(dirfd, sub)) } catch {}
    for (const n of names) check(os.at(dirfd, `${sub}/${n}`), (m) => (m & 0o007) === 0)
  }
  return bad
}

export async function main({ env = process.env, signals = process, exit = (c) => process.exit(c), stderr = process.stderr } = {}) {
  const cfg = config(env)
  const privileged = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0
  const os = privileged ? linuxRoot() : unprivileged()
  const local = !cfg.fleet
  const say = (line) => { try { stderr.write(`[host] ${line}\n`) } catch {} }
  if (!privileged) say('jail: lifecycle-only (no uid drop)')
  say(`mode: ${local ? 'local' : 'fleet'} work=${cfg.work} run=${cfg.run}${cfg.chromeDir ? ` chrome=${cfg.chromeDir}` : ''}`)

  // ---- the tree, the dirfd, the log
  ensureDirs(os, hostDirs(cfg, { local: cfg.dirfd === null }), say)
  if (cfg.dirfd === null) ensureDevToken(cfg, say)
  const dirfd = cfg.dirfd ?? os.openDir(`${cfg.work}/.atelier`)
  const atelierPath = path.resolve(`${cfg.work}/.atelier`)
  const supervisorRef = { current: null }
  const slugOf = (inst) => supervisorRef.current?.apps().find((r) => r.instance === inst)?.slug
  const log = agentLog({ os, path: os.at(dirfd, 'agent.log'), stderr, slugOf })
  const hostLog = (line) => { say(line) }
  // supervisor lines: every one to stderr; LIVE / STOPPED / RESUMED to agent.log (FAILED / KILLED
  // reach agent.log through the collector sink — one line per failure, DESIGN §L1)
  const supLog = (line) => { say(line); if (/ rev \d+ (LIVE in|STOPPED|RESUMED)/.test(line)) log.line(line) }

  // ---- errors
  const collector = createCollector({ log })
  collector.sink(log.appError)

  // ---- registrar + transport (DESIGN §7)
  const transport = local ? localTransport(cfg, dirfd, { os }) : spineTransport(cfg)
  const rcfg = { ...cfg, podIp: podIp() }
  const registrar = createRegistrar({ os, dirfd, transport, cfg: rcfg, log: hostLog, liveWorkers: () => supervisorRef.current?.workers().map((w) => w.instance) ?? [] })
  const events = createEvents({ transport, hostId: () => registrar.hostId, epoch: () => registrar.epoch, log: hostLog })
  const pusher = local ? null : push({ transport, running: collector.running, log: hostLog })
  if (pusher) collector.sink(pusher)

  // ---- the shells (created before the supervisor so onSwap/onBroadcast can reach them)
  const auth = createAuth({ registrar, os, cfg, log: hostLog })
  const report = frontendReport({ collector })
  let dev = null, server = null

  // ---- supervisor ⇄ workers
  const supervisor = createSupervisor({
    os, dirfd, cfg, log: supLog, report: collector.report, registrar,
    spawn: spawnWorker, proxy: proxyRequest,
    jail: privileged ? { jailPlan, applyJail, claimRoundTrip } : null,
    install: privileged ? (a) => installDeps({ ...a, beforeFreeze: () => supervisor.stop(a.spec.instance) }) : null,
    onSwap: (instance, rev) => {
      collector.setRunning(instance, rev)
      events.invalidate(instance)
      dev?.invalidate(instance)
      registrar.modulesChanged(instance, rev).catch((e) => hostLog(`modules-changed ${instance}: ${e.message}`))
    },
    onBroadcast: (row, event) => dev?.broadcast(row.instance, event),
  })
  supervisorRef.current = supervisor
  const watchdog = createWatchdog({ os, workers: supervisor.workers, report: collector.report, kill: supervisor.kill, dataRoot: os.at(dirfd, 'data'), log: hostLog })

  server = createServer({ cfg, auth, supervisor, collector, registrar, log: hostLog, frontendReport: report })
  const chromeSheet = cfg.chromeDir ? async () => { const r = await buildSheet({ chromeDir: cfg.chromeDir, appDir: null }); return { body: Buffer.from(r.css), type: 'text/css; charset=utf-8' } } : undefined
  dev = createDevShell({ cfg, os, supervisor, collector, registrar, auth, log: hostLog, frontendReport: report, chromeSheet })

  // ---- boot (§1.1 order)
  const registered = registrar.register()          // fleet: retries with backoff; snapshots are served meanwhile
  registered.catch(() => {})
  if (local) await registered
  await supervisor.boot()
  say(`boot: ${supervisor.apps().length} snapshot(s)`)
  await server.listen()
  await dev.listen()
  if (!local) await registered
  let bad = audit(os, cfg, dirfd)
  while (bad.length) {
    hostLog(`audit: refusing to serve — readable by a foreign uid: ${bad.join(', ')} (retry in 5 s)`)
    await new Promise((r) => setTimeout(r, 5000))
    bad = audit(os, cfg, dirfd)
  }
  const ready = `${cfg.run}/host-ready`
  fs.writeFileSync(ready, `${process.pid}\n`, { mode: 0o644 })
  try { os.chmod(ready, 0o644) } catch {}
  log.line(`host: ready pid ${process.pid} ${local ? 'local' : `host=${registrar.hostId} epoch=${registrar.epoch}`}`)
  supervisor.scan().catch((e) => hostLog(`scan: ${e?.stack ?? e}`))
  watchdog.start()
  registrar.heartbeat(HEARTBEAT_MS)
  const dirfdCheck = privileged ? setInterval(() => {
    let target = null
    try { target = os.readlinkFd(dirfd) } catch (e) { target = `error ${e.code}` }
    if (target !== atelierPath) hostLog(`fault: .atelier dirfd resolves to ${target} (want ${atelierPath}) — the agent renamed or removed it`)
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
    registrar.stop()
    if (!local) { try { await Promise.race([registrar.draining(), new Promise((r) => setTimeout(r, 2000))]) } catch (e) { hostLog(`draining: ${e.message}`) } }
    await Promise.all([server.close(), dev.close()])
    await supervisor.teardown()
    watchdog.stop()
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
  return { cfg, os, dirfd, supervisor, registrar, server, dev, events, collector, watchdog, teardown }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { process.stderr.write(`[host] fatal: ${e?.stack ?? e}\n`); process.exit(2) })
}
