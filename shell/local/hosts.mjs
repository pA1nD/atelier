// shell/local/hosts.mjs — one host process per non-empty workspace (DESIGN §5.1): the port plan, the
// env rows, the dev-token mint, spawn / restart with backoff / stop, and the registry rows the shell's
// local `registry.host(company)` answers from. The host is `node host/index.mjs` in local mode (no
// ATELIER_SPINE_URL): folder registry, identity `local`, lifecycle-only jail.
import nodeFs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { workOf } from './stage.mjs'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const HOST_ENTRY = path.join(REPO_ROOT, 'host', 'index.mjs')
export const STOP_GRACE_MS = 5000
export const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 16000, 30000]
export const PARK_EXITS = 10
export const PARK_WINDOW_MS = 10 * 60_000
export const STABLE_MS = 60_000            // a host up this long resets the backoff
// the env keys of the CLI's own process a host inherits (explicit list; nothing else is spread)
export const INHERIT = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NO_COLOR', 'FORCE_COLOR']

export const hash8 = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 8)
// `/tmp/atelier-<hash8(root)>` — short on purpose: macOS caps a Unix socket path at 104 bytes
export const runBase = (root) => `/tmp/atelier-${hash8(path.resolve(root))}`
export const runOf = (root, ws) => path.join(runBase(root), ws)
export const portPlan = (port, k) => ({ dev: port + 10 + k, host: port + 20 + k })

/** hostEnv({root, ws, k, port, chromeDir, nodeEnv, base}) — the host's env, DESIGN §5.1 */
export function hostEnv({ root, ws, k, port, chromeDir = null, nodeEnv = 'production', base = process.env }) {
  const env = {}
  for (const key of INHERIT) if (base[key] !== undefined) env[key] = base[key]
  const ports = portPlan(port, k)
  Object.assign(env, {
    ATELIER_WORK: workOf(root, ws),
    ATELIER_RUN: runOf(root, ws),
    ATELIER_COMPANY: ws,
    ATELIER_ORIGIN: `http://localhost:${port}`,
    ATELIER_DEV_PORT: String(ports.dev),
    ATELIER_HOST_PORT: String(ports.host),
    NODE_ENV: nodeEnv,
    ATELIER_GIT_COMMIT: '0',           // the host's per-LIVE commit would write into the user's own repo
    ATELIER_APPS_LINKS: '1',           // the staged apps are symlinks (host H1)
  })
  if (chromeDir) env.ATELIER_CHROME_DIR = chromeDir
  return env
}

/** mintDevToken(runDir, fs) → token: `$run/dev.token`, 32 random bytes hex, mode 0600, fresh per run */
export function mintDevToken(runDir, fs = nodeFs) {
  fs.mkdirSync(runDir, { recursive: true })
  const file = path.join(runDir, 'dev.token')
  const token = randomBytes(32).toString('hex')
  try { fs.unlinkSync(file) } catch {}
  fs.writeFileSync(file, token, { mode: 0o600, flag: 'wx' })
  return token
}

/**
 * createHosts({ root, port, chromeDir, nodeEnv, spawn, fs, log, now, setTimer, clearTimer, execPath, entry })
 *   sync(workspaces: [{id, work}]) starts a host per new workspace, stops the ones that vanished
 *   start(ws) / stop(ws) / stopAll(graceMs) — SIGTERM, wait ≤ graceMs, SIGKILL the rest
 *   row(ws) → {hostId:'local', ip:'127.0.0.1', port:<dev port>, tls:null, token, drainingAt:null} | null (parked/unknown)
 *   workspaces() → [{id, port, token}] — what registry-local's `workspaces()` reads
 *   list() → [{ws, k, pid, state, devPort, hostPort, work, run}]
 */
export function createHosts({ root, port, chromeDir = null, nodeEnv = 'production', spawn = nodeSpawn, fs = nodeFs, log = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, execPath = process.execPath, entry = HOST_ENTRY, env = process.env }) {
  const hosts = new Map()      // ws → h
  let nextK = 0
  let stopping = false
  const line = (ws, s) => log(`[${ws}] ${s}`)

  function launch(h) {
    const ws = h.ws
    fs.mkdirSync(path.join(h.work, 'apps'), { recursive: true })
    h.token = mintDevToken(h.run, fs)
    const childEnv = hostEnv({ root, ws, k: h.k, port, chromeDir, nodeEnv, base: env })
    const child = spawn(execPath, [entry], { env: childEnv, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    h.child = child; h.pid = child.pid ?? null; h.state = 'running'; h.startedAt = now()
    const relay = (stream) => { let buf = ''; stream?.on?.('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { line(ws, buf.slice(0, i)); buf = buf.slice(i + 1) } }) }
    relay(child.stdout); relay(child.stderr)
    child.on?.('error', (e) => { line(ws, `spawn error: ${e.code ?? e.message}`); onExit(h, child, null, 'spawn-error') })
    child.on?.('exit', (code, signal) => onExit(h, child, code, signal))
    line(ws, `host ${h.k} pid ${h.pid} dev 127.0.0.1:${portPlan(port, h.k).dev}`)
  }
  function onExit(h, child, code, signal) {
    if (h.child !== child) return
    h.child = null; h.pid = null
    const why = signal ? `signal ${signal}` : `exit ${code}`
    if (h.stopWanted || stopping) { h.state = 'stopped'; h.stopped?.(); return }
    const t = now()
    if (t - h.startedAt >= STABLE_MS) h.restarts = 0
    h.exits = h.exits.filter((x) => t - x < PARK_WINDOW_MS); h.exits.push(t)
    if (h.exits.length >= PARK_EXITS) { h.state = 'parked'; line(h.ws, `host parked after ${PARK_EXITS} exits in ${PARK_WINDOW_MS / 60_000} min (last: ${why}) — fix the cause and restart atelier`); return }
    const ms = BACKOFF_MS[Math.min(h.restarts, BACKOFF_MS.length - 1)]
    h.restarts++; h.state = 'restarting'
    line(h.ws, `host died (${why}) — restart in ${ms / 1000} s`)
    h.timer = setTimer(() => { h.timer = null; if (hosts.get(h.ws) === h && !h.stopWanted && !stopping) launch(h) }, ms)
  }
  function start(ws, work = workOf(root, ws)) {
    if (hosts.has(ws)) return hosts.get(ws)
    const h = { ws, k: nextK++, work, run: runOf(root, ws), child: null, pid: null, token: null, state: 'starting', startedAt: 0, restarts: 0, exits: [], timer: null, stopWanted: false }
    hosts.set(ws, h)
    launch(h)
    return h
  }
  function stop(ws, graceMs = STOP_GRACE_MS) {
    const h = hosts.get(ws)
    if (!h) return Promise.resolve()
    hosts.delete(ws)
    return halt(h, graceMs)
  }
  function halt(h, graceMs) {
    h.stopWanted = true
    if (h.timer) { clearTimer(h.timer); h.timer = null }
    const child = h.child
    if (!child) { h.state = 'stopped'; return Promise.resolve() }
    return new Promise((resolve) => {
      let done = false
      const finish = () => { if (done) return; done = true; clearTimer(t); h.state = 'stopped'; resolve() }
      h.stopped = finish
      const t = setTimer(() => { line(h.ws, `host did not exit within ${graceMs / 1000} s — SIGKILL`); try { child.kill('SIGKILL') } catch {}; finish() }, graceMs)
      try { child.kill('SIGTERM') } catch { finish() }
    })
  }
  return {
    start, stop,
    sync(workspaces) {
      const want = new Map(workspaces.map((w) => [w.id, w]))
      const gone = [...hosts.keys()].filter((ws) => !want.has(ws))
      for (const w of workspaces) if (!hosts.has(w.id)) start(w.id, w.work)
      return Promise.all(gone.map((ws) => { line(ws, 'workspace gone — stopping its host'); return stop(ws) }))
    },
    async stopAll(graceMs = STOP_GRACE_MS) {
      stopping = true
      const all = [...hosts.values()]
      hosts.clear()
      await Promise.all(all.map((h) => halt(h, graceMs)))
    },
    row(ws) {
      const h = hosts.get(ws)
      if (!h || h.state === 'parked') return null
      return { hostId: 'local', ip: '127.0.0.1', port: portPlan(port, h.k).dev, tls: null, token: h.token, drainingAt: null }
    },
    list() { return [...hosts.values()].map((h) => ({ ws: h.ws, k: h.k, pid: h.pid, state: h.state, devPort: portPlan(port, h.k).dev, hostPort: portPlan(port, h.k).host, work: h.work, run: h.run })) },
    // the registry-local seam: [{id, port, token}] per running (non-parked) host
    workspaces() { return [...hosts.values()].filter((h) => h.state !== 'parked').map((h) => ({ id: h.ws, port: portPlan(port, h.k).dev, token: h.token })) },
  }
}
