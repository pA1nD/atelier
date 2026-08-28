// host/launcher.mjs — the thin root launcher (DESIGN §2.1, PLAN §4.3 "Process tree", R1).
// PID 1 (entrypoint.sh) runs it as root with the whole pod env. It executes the boot plan of
// hygiene.mjs through the adapter, spawns the host (root, fd 3 = the .atelier dirfd) and the
// image's session supervisor (uid 1000 + [AGENT_DATA_GID]) in parallel, restarts the host alone
// with backoff, and mirrors the session supervisor's exit. It never exits for a policy reason.
// Everything with a side effect is injected (os, io, clock, exit, signals) so the tests drive it.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { constants as osConstants } from 'node:os'
import { linuxRoot, unprivileged } from './adapters/os.mjs'
import { AGENT, AGENT_DATA_GID, WORKER_UID_BASE, WORKER_UID_MAX, bootPlan, hostEnv, sessionEnv, helperEnv } from './hygiene.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const HOST_ENTRY = path.join(here, 'index.mjs')            // /app/host/index.mjs in the image
export const SESSION_SUPERVISOR = '/app/session-supervisor.mjs'   // the image's, not in this repo
export const RESTART = Object.freeze({ baseMs: 500, capMs: 30_000, parkExits: 10, windowMs: 600_000, supKillMs: 10_000 })

export function config(env) {
  return {
    work: env.ATELIER_WORK ?? '/work',
    run: env.ATELIER_RUN ?? '/run/atelier',
    control: env.ATELIER_CONTROL ?? '/control',
    tmp: '/tmp',
    graceS: Number(env.ATELIER_GRACE_S ?? 40),
  }
}

// The plain-fs side effects the plan needs beyond the adapter: umask, an exclusive create, an unlink.
export const realIo = () => ({
  umask: (mode) => process.umask(mode),
  write: (p, data, mode) => fs.writeFileSync(p, data, { mode, flag: 'wx' }),
  unlink: (p) => { try { fs.unlinkSync(p) } catch (e) { if (e.code !== 'ENOENT') throw e } },
})

const oct = (m, w = 4) => m.toString(8).padStart(w, '0')

/**
 * Runs a bootPlan step by step; every step logs `<op> <path> [mode]: ok|FAILED <errno>`; the first
 * failure stops the run and is returned as `failed`. `openDir` steps land in the result under their `as`.
 */
export function runPlan(steps, { os, io, log }) {
  const out = {}
  const apply = (s) => {
    switch (s.op) {
      case 'umask': io.umask(s.mode); return
      case 'mkdir':
        try { os.mkdir(s.path, s.mode) } catch (e) {
          if (e.code !== 'EEXIST') throw e
          const st = os.lstat(s.path), mode = st.mode & 0o7777
          const fine = mode === s.mode && (!s.owner || (st.uid === s.owner[0] && st.gid === s.owner[1]))
          if (s.reclaim && (st.uid !== 0 || st.gid !== 0)) { os.chown(s.path, 0, 0); return `exists ${st.uid}:${st.gid} ${oct(mode)} — reclaimed 0:0` }
          return fine ? `exists` : `exists ${st.uid}:${st.gid} ${oct(mode)} — wrong (want ${s.owner ? s.owner.join(':') : '?'} ${oct(s.mode)}), left`
        }
        return
      case 'openDir': out[s.as] = os.openDir(s.path); return `fd ${out[s.as]}`
      case 'unlink': io.unlink(s.path); return
      case 'chownIf': {
        let st
        try { st = os.lstat(s.path) } catch (e) { if (e.code === 'ENOENT' && s.missingOk) return 'absent'; throw e }
        if (st.uid !== s.ifOwner[0] || st.gid !== s.ifOwner[1]) return `already ${st.uid}:${st.gid} — untouched`
        os.chown(s.path, s.uid, s.gid); return `${st.uid}:${st.gid} → ${s.uid}:${s.gid}`
      }
      case 'mkdirIfMissing':
        try { os.lstat(s.path); return 'present' } catch (e) { if (e.code !== 'ENOENT') throw e }
        os.mkdir(s.path, s.mode); os.chown(s.path, s.uid, s.gid); return `created ${s.uid}:${s.gid}`
      case 'chown': os.chown(s.path, s.uid, s.gid); return
      case 'chmodIfRootOwned': {
        const st = os.lstat(s.path), mode = st.mode & 0o7777
        if (st.uid !== 0 || st.gid !== 0) return `${st.uid}:${st.gid} ${oct(mode)} — not root-owned, left`
        if (mode === s.mode) return 'already'
        os.chmod(s.path, s.mode); return `${oct(mode)} → ${oct(s.mode)}`
      }
      case 'write': io.write(s.path, s.data, s.mode); return
      default: throw new Error(`unknown plan op ${s.op}`)
    }
  }
  for (const s of steps) {
    const name = s.op === 'umask' ? `umask ${oct(s.mode, 3)}` : `${s.op} ${s.path}${s.mode !== undefined ? ' ' + oct(s.mode) : ''}${s.uid !== undefined ? ` ${s.uid}:${s.gid}` : ''}`
    try { const note = apply(s); log(`${name}: ok${note ? ` (${note})` : ''}`) }
    catch (e) { log(`${name}: FAILED ${e.code ?? ''} ${e.message}`); out.failed = { step: s, error: e }; return out }
  }
  return out
}

export const crashLine = ({ at, code, signal, exits }) => JSON.stringify({ at, code, signal, exits })
/** The launcher's exit code for a session supervisor result: its code, or 128+signal when it died by signal. */
export const exitCode = (r) => (!r ? 1 : r.signal ? 128 + (osConstants.signals[r.signal] ?? 0) : (r.code ?? 1))
/** Restart delay after the n-th host exit inside the window: the first at once (one crash is not a loop; the
 *  blink is the host's boot alone), then 0.5 s doubling, capped at 30 s. */
export const backoffMs = (exitsInWindow) => (exitsInWindow <= 1 ? 0 : Math.min(RESTART.capMs, RESTART.baseMs * 2 ** (exitsInWindow - 2)))

/** Every process whose real uid is a worker's (WORKER_UID_BASE…WORKER_UID_MAX), from /proc — the workers a dead
 *  host left behind (they are detached process groups; nothing else reaps them). `readdir`/`read` injectable. */
export function orphanedWorkers({ readdir = (d) => fs.readdirSync(d), read = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const out = []
  let names = []
  try { names = readdir('/proc') } catch { return out }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue
    let uid = null
    try { const m = /^Uid:\s+(\d+)/m.exec(read(`/proc/${n}/status`)); uid = m ? Number(m[1]) : null } catch { continue }
    if (uid !== null && uid >= WORKER_UID_BASE && uid <= WORKER_UID_MAX) out.push({ pid: Number(n), uid })
  }
  return out
}

/**
 * @param {object} d
 * @param {object} d.os   the adapter (host/adapters/os.mjs)
 * @param {{umask:Function, write:Function, unlink:Function}} d.io
 * @param {Record<string,string|undefined>} d.env   the pod env (holds ATELIER_BOOTSTRAP)
 * @param {(line:string)=>void} d.log
 * @param {{now:Function, setTimeout:Function, clearTimeout:Function}} d.clock
 * @param {(code:number)=>void} d.exit
 * @param {{on:(sig:string, fn:Function)=>void}} d.signals
 * @param {string[]} [d.hostArgv]  @param {string[]} [d.sessionArgv]  @param {string} [d.devToken]  @param {() => {pid:number, uid:number}[]} [d.orphans]
 */
export function createLauncher(d) {
  const { os, io, env, log, clock, exit, signals } = d
  const cfg = d.cfg ?? config(env)
  const hostArgv = d.hostArgv ?? ['node', HOST_ENTRY]
  const sessionArgv = d.sessionArgv ?? ['node', SESSION_SUPERVISOR]
  const t0 = clock.now()
  const say = (m) => log(`[launcher] +${((clock.now() - t0) / 1000).toFixed(2)}s ${m}`)
  const st = { dirfd: null, host: null, sup: null, supResult: null, exiting: false, parked: false, exits: 0, exitTimes: [], timer: null, deadline: null }

  // Fires fn once per child: on 'exit', or on 'error' (a spawn failure, or a kill EPERM) — logged, treated as exited.
  const once = (child, label, fn) => {
    let done = false
    const fire = (code, signal) => { if (!done) { done = true; fn(code, signal) } }
    child.on('exit', fire)
    child.on('error', (e) => { say(`${label}: error ${e.code ?? ''} ${e.syscall ?? ''} ${e.message} — treated as exited`); fire(null, null) })
  }
  const kill = (child, sig) => { try { child.kill(sig) } catch (e) { say(`kill ${sig} pid ${child.pid}: ${e.code ?? e.message}`) } }

  function spawnHost() {
    st.timer = null
    const child = os.spawn({ argv: hostArgv, env: hostEnv(env, cfg), cwd: '/', umask: 0o077, stdio: ['ignore', 'inherit', 'inherit', st.dirfd] })
    st.host = child
    say(`host: spawned pid ${child.pid} (fd 3 = .atelier dirfd ${st.dirfd})`)
    once(child, 'host', (code, signal) => onHostExit(child, code, signal))
  }

  function onHostExit(child, code, signal) {
    if (child !== st.host) return
    st.host = null
    say(`host: exited code=${code} signal=${signal}`)
    if (st.exiting) { settle(); return }
    io.unlink(`${cfg.run}/host-ready`)
    sweepWorkers()
    const now = clock.now()
    st.exits += 1
    st.exitTimes = st.exitTimes.filter((t) => now - t < RESTART.windowMs).concat(now)
    reportCrash({ at: now, code, signal, exits: st.exits })
    if (st.exitTimes.length >= RESTART.parkExits) { st.parked = true; say(`host: parked after ${RESTART.parkExits} exits/${RESTART.windowMs / 60_000} min`); return }
    const delay = backoffMs(st.exitTimes.length)
    say(`host: restart in ${delay} ms (exit ${st.exitTimes.length} in window)`)
    st.timer = clock.setTimeout(spawnHost, delay)
  }

  // A host that died without its teardown (kill -9, a crash) leaves its workers running as detached process
  // groups: they would hold their sockets, sqlite locks and CPU beside the next life's workers. SIGKILL them
  // (root, CAP_KILL) before the restart; a parked host leaves no workers behind either.
  function sweepWorkers() {
    const list = (d.orphans ?? orphanedWorkers)()
    for (const w of list) { try { os.kill(w.pid, 'SIGKILL') } catch (e) { say(`sweep: kill pid ${w.pid} uid ${w.uid}: ${e.code ?? e.message}`) } }
    if (list.length) say(`host: SIGKILLed ${list.length} orphaned worker process(es): ${list.map((w) => `${w.pid}/${w.uid}`).join(' ')}`)
  }

  // Row X: /control is 1000-owned; the line is appended by a uid-1000 helper, never by root.
  function reportCrash(ev) {
    const h = os.spawn({ argv: ['sh', '-c', `cat >> ${cfg.control}/.host-crash`], env: helperEnv(env), cwd: '/', uid: AGENT.uid, gid: AGENT.gid, groups: [], umask: 0o077, stdio: ['pipe', 'ignore', 'inherit'] })
    h.on('error', (e) => say(`host-crash helper: ${e.code ?? e.message}`))
    h.stdin?.end(crashLine(ev) + '\n')
  }

  function spawnSup() {
    const child = os.spawn({ argv: sessionArgv, env: sessionEnv(env), cwd: cfg.work, uid: AGENT.uid, gid: AGENT.gid, groups: [AGENT_DATA_GID], umask: 0o022, stdio: ['ignore', 'inherit', 'inherit'] })
    st.sup = child
    say(`session supervisor: spawned pid ${child.pid} uid ${AGENT.uid}:${AGENT.gid} groups [${AGENT_DATA_GID}]`)
    once(child, 'session supervisor', onSupExit)
  }

  function onSupExit(code, signal) {
    st.sup = null
    st.supResult = { code, signal }
    say(`session supervisor: exited code=${code} signal=${signal}`)
    if (!st.exiting) {
      st.exiting = true
      if (st.timer) clock.clearTimeout(st.timer)
      if (st.host) {
        kill(st.host, 'SIGTERM')
        st.deadline = clock.setTimeout(() => { if (st.host) { say(`host: SIGKILL after ${RESTART.supKillMs} ms`); kill(st.host, 'SIGKILL') } }, RESTART.supKillMs)
      }
    }
    settle()
  }

  function onTerm() {
    if (st.exiting) return
    st.exiting = true
    if (st.timer) clock.clearTimeout(st.timer)
    const budget = Math.max(1, cfg.graceS - 5) * 1000
    say(`SIGTERM: host first, session supervisor next, ${budget} ms for the teardown`)
    if (st.host) kill(st.host, 'SIGTERM')
    if (st.sup) kill(st.sup, 'SIGTERM')
    st.deadline = clock.setTimeout(() => {
      say('SIGTERM: budget spent — SIGKILL')
      if (st.host) kill(st.host, 'SIGKILL')
      if (st.sup) kill(st.sup, 'SIGKILL')
    }, budget)
    settle()
  }

  function settle() {
    if (!st.exiting || st.host || st.sup) return
    if (st.deadline) clock.clearTimeout(st.deadline)
    const code = exitCode(st.supResult)
    say(`exit ${code} (session supervisor code=${st.supResult?.code} signal=${st.supResult?.signal})`)
    exit(code)
  }

  function boot() {
    const devToken = d.devToken ?? randomBytes(32).toString('hex')
    const r = runPlan(bootPlan(cfg, { bootstrap: env.ATELIER_BOOTSTRAP, devToken }), { os, io, log: say })
    if (r.failed) { say('boot: a plan step failed before the host spawn — exit 2'); exit(2); return r }
    st.dirfd = r.dirfd
    spawnHost()      // 4. the host first (OR8) …
    spawnSup()       // 5. … and the session supervisor in parallel, never after host-ready
    signals.on('SIGTERM', onTerm)
    return r
  }

  return { boot, state: st }
}

function main() {
  const privileged = process.platform === 'linux' && process.getuid?.() === 0
  const os = privileged ? linuxRoot() : unprivileged()
  console.log(`[launcher] boot pid=${process.pid} uid=${process.getuid?.()} os=${os.kind} host=${HOST_ENTRY}`)
  createLauncher({
    os, io: realIo(), env: process.env, log: console.log,
    clock: { now: Date.now, setTimeout, clearTimeout },
    exit: (c) => process.exit(c), signals: process,
  }).boot()
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
