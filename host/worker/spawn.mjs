// host/worker/spawn.mjs — the spawn plan for one worker (DESIGN §2.2 row W) and the READY wait
// over the fd-3 control lane (§4.1, §9.4). The plan is data (`spawnPlan`) a test asserts
// byte-exact; `spawnWorker` runs it through the adapter and turns the NDJSON control messages
// into a handle the supervisor drives. Host → worker is signals only.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import { afterReady } from './jail.mjs'

export const RUNTIME_PATH = fileURLToPath(new URL('./runtime.mjs', import.meta.url))
export const MB = 1024 * 1024
export const READY_TIMEOUT_MS = 8000
export const DRAIN_MS = 2000

/** `--max-old-space-size` = (RLIMIT_DATA − 576 MB) × 0.85 in MB, min 256 (§2.2). */
export function maxOldSpaceMb(dataBytes) {
  return Math.max(256, Math.floor(((dataBytes - 576 * MB) * 0.85) / MB))
}

/**
 * @typedef {object} WorkerSpec  (DESIGN §4.1; `scratchDir` and `name` are this lane's additions)
 * @property {string} instance   i-<16 hex>
 * @property {string} slug
 * @property {string} [name]     module.json name (ctx.name); defaults to the slug
 * @property {string} company
 * @property {number} uid        20000+i; gid = uid
 * @property {number} rev
 * @property {string} codeDir    last-good/<inst>/rev-N — the bundle to import, never the app folder
 * @property {string} appDir     /work/apps/<slug> — the worker's cwd
 * @property {string} dataDir    ctx.dataDir
 * @property {string} tmpDir     TMPDIR
 * @property {string} sockDir
 * @property {string} sock
 * @property {string} [scratchDir]  scratch/<inst>; HOME = <scratchDir>/home. Derived from dataDir when absent.
 * @property {string} baseUrl    <origin>/api/<company>/<slug>  (ctx.baseUrl, BASE_URL)
 * @property {string} origin     https://<company>.portal.pa1nd.de | http://127.0.0.1:1844
 * @property {Record<string,string>} configEnv   OR14 keys from the spine; never the jail keys
 * @property {{data:number,core:number,nproc:number,nofile:number}} rlimits
 */

export const scratchDirOf = (spec) => spec.scratchDir ?? path.posix.join(path.posix.dirname(path.posix.dirname(spec.dataDir)), 'scratch', spec.instance)

/** HOST/PORT/BASE_URL published from the mount URL (§9.12): HOST = the origin's hostname, PORT = its port (443 / 1844). */
export function publishedAddress(spec) {
  const u = new URL(spec.origin)
  return { HOST: u.hostname, PORT: u.port || (u.protocol === 'https:' ? '443' : '80'), BASE_URL: spec.baseUrl }
}

/** The worker's env, row W exactly, built from an explicit key list — nothing is spread from process.env.
 *  The OR14 config keys are NOT in it: the env is handed to the root wrapper chain (sh → prlimit →
 *  setpriv) before the uid drop, so a config key such as LD_PRELOAD or NODE_OPTIONS would execute as
 *  userns-root; config travels over the worker's stdin instead (`configEnvOf` → `writeConfig`) and the
 *  runtime assigns it to process.env after the drop, before the bundle import. */
export function workerEnv(spec, hostEnv) {
  const { HOST, PORT, BASE_URL } = publishedAddress(spec)
  return {
    PATH: hostEnv.PATH,
    NODE_ENV: hostEnv.NODE_ENV ?? 'production',
    APP_ID: spec.instance,
    HOME: path.posix.join(scratchDirOf(spec), 'home'),
    HOST, PORT, BASE_URL,
    TMPDIR: spec.tmpDir,
    ATELIER_WORKER: JSON.stringify(workerJson(spec)),
  }
}

/** The row-W keys a config key may never override, and the prefixes no config key may carry. */
export const FIXED_ENV_KEYS = Object.freeze(['PATH', 'NODE_ENV', 'APP_ID', 'HOME', 'HOST', 'PORT', 'BASE_URL', 'TMPDIR', 'ATELIER_WORKER'])
export const CONFIG_DENY_RE = /^(LD_|DYLD_|NODE_|ATELIER_)/
const CONFIG_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
/** configEnvOf(spec) → {env, dropped}: the OR14 keys the worker gets, minus the jail's own keys and the loader/runtime knobs. */
export function configEnvOf(spec) {
  const env = {}, dropped = []
  for (const [k, v] of Object.entries(spec.configEnv ?? {})) {
    if (!CONFIG_KEY_RE.test(k) || FIXED_ENV_KEYS.includes(k) || CONFIG_DENY_RE.test(k)) { dropped.push(k); continue }
    env[k] = String(v)
  }
  return { env, dropped }
}
/** The bytes written to the worker's stdin (one JSON document, then EOF): `{env:{K:V}}`. */
export const configPayload = (spec) => JSON.stringify({ env: configEnvOf(spec).env })

/** What the runtime reads from ATELIER_WORKER: the spec minus config values and limits. */
export function workerJson(spec) {
  const { instance, slug, name, company, uid, rev, codeDir, appDir, dataDir, tmpDir, sock, baseUrl, origin } = spec
  return { instance, slug, name: name ?? slug, company, uid, rev, codeDir, appDir, dataDir, tmpDir, sock, baseUrl, origin }
}

/** Row W as a SpawnSpec for `os.spawn` (the adapter wraps it in sh/prlimit/setpriv under linuxRoot). */
export function spawnPlan(spec, { hostEnv, runtime = RUNTIME_PATH } = {}) {
  return {
    argv: ['node', `--max-old-space-size=${maxOldSpaceMb(spec.rlimits.data)}`, runtime],
    env: workerEnv(spec, hostEnv),
    cwd: '/',
    uid: spec.uid, gid: spec.uid, groups: [],
    rlimits: spec.rlimits,
    oomScoreAdj: 1000,
    umask: 0o002,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],     // stdin = the config lane (closed after one write); fd 3 = control
    detached: true,
  }
}

const failure = (error, msg, extra = {}) => Object.assign(new Error(msg), { error, msg, ...extra })

/** Splits a stream (Buffer or string chunks) into lines; the callback gets each complete line. */
export function lineSplitter(onLine) {
  const dec = new StringDecoder('utf8')
  let buf = ''
  return (chunk) => {
    buf += typeof chunk === 'string' ? chunk : dec.write(chunk)
    let i
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.length) onLine(line) }
  }
}

/**
 * Spawns one worker and waits for READY on fd 3.
 * @returns {Promise<{pid:number, sock:string, ready:object, kill(signal?:string):void, stop(drainMs?:number):Promise<{code:number|null, signal:string|null, killed:boolean}>, exited:Promise<{code, signal}>}>}
 *   rejects with an Error carrying `error: 'no-ready'|'spawn-eagain'|'load-failed'` and `msg`
 *   (`load-failed` also carries `code` and the runtime's message as `detail`).
 *   A spawn failure (EAGAIN, exit 134 or a signal before READY) is `spawn-eagain`, never a broken app.
 */
export function spawnWorker({ os, spec, onControl = () => {}, onExit = () => {}, onLog = defaultLog, readyTimeoutMs = READY_TIMEOUT_MS, hostEnv = process.env, runtime, lockSocket = true, log = () => {} }) {
  return new Promise((resolve, reject) => {
    const plan = spawnPlan(spec, { hostEnv, runtime })
    let child
    try { child = os.spawn(plan) } catch (e) { return reject(failure('spawn-eagain', `spawn: ${e.code ?? e.message}`)) }
    // the config lane: one JSON document on stdin, then EOF (the runtime reads it to EOF before the import)
    try { child.stdin?.on?.('error', () => {}); child.stdin?.end(configPayload(spec)) } catch {}
    let settled = false, ready = false
    let exitInfo = null
    let onExited = []
    const exited = new Promise((r) => onExited.push(r))
    const settle = (fn) => { if (settled) return; settled = true; clearTimeout(timer); fn() }
    const timer = setTimeout(() => settle(() => { try { os.kill(-child.pid, 'SIGKILL') } catch {} ; try { os.kill(child.pid, 'SIGKILL') } catch {} ; reject(failure('no-ready', `no READY within ${readyTimeoutMs} ms`)) }), readyTimeoutMs)

    const handle = {
      pid: child.pid, sock: spec.sock, child, ready: null, exited,
      kill: (signal = 'SIGTERM') => os.kill(child.pid, signal),
      // SIGCONT (a no-op on a running process; a watchdog-stopped worker cannot run its teardown otherwise) →
      // SIGTERM → the runtime runs the module teardown and exits; at the deadline the process GROUP is SIGKILLed (§2.3 step 2).
      stop: (drainMs = DRAIN_MS) => new Promise((done) => {
        if (exitInfo) return done({ ...exitInfo, killed: false })
        let finished = false
        const finish = (killed) => { if (finished) return; finished = true; clearTimeout(t); done({ code: exitInfo?.code ?? null, signal: exitInfo?.signal ?? null, killed }) }
        const t = setTimeout(() => { try { os.kill(-child.pid, 'SIGKILL') } catch {} ; try { os.kill(child.pid, 'SIGKILL') } catch {} ; log(`worker ${spec.instance}: drain deadline ${drainMs} ms → SIGKILL pgroup`); finish(true) }, drainMs)
        onExited.push(() => finish(false))
        try { os.kill(child.pid, 'SIGCONT') } catch {}
        try { os.kill(child.pid, 'SIGTERM') } catch (e) { finish(false) }
      }),
    }

    const onMsg = (msg) => {
      if (!ready && msg.t === 'ready') {
        ready = true
        handle.ready = msg
        if (lockSocket) afterReady(os, spec, log)
        settle(() => resolve(handle))
        return
      }
      if (!ready && msg.t === 'load-failed') {
        settle(() => reject(failure('load-failed', `${msg.code}: ${msg.message}`, { code: msg.code, detail: msg })))
      }
      onControl(msg)
    }
    child.stdio[3].on('data', lineSplitter((line) => {
      let msg
      try { msg = JSON.parse(line) } catch { log(`worker ${spec.instance}: bad control line ${line.slice(0, 120)}`); return }
      onMsg(msg)
    }))
    child.stdout?.on('data', lineSplitter((line) => onLog('stdout', line, spec)))
    child.stderr?.on('data', lineSplitter((line) => onLog('stderr', line, spec)))
    child.on('error', (e) => settle(() => reject(failure('spawn-eagain', `spawn: ${e.code ?? e.message}`))))
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal }
      if (!settled) {
        settle(() => {
          if (code === 134 || signal) reject(failure('spawn-eagain', `exit ${code ?? signal} before READY`))
          else reject(failure('load-failed', `worker exited ${code} before READY`, { code: 'RUNTIME-DEAD', detail: { t: 'load-failed', code: 'RUNTIME-DEAD', message: `exit ${code}` } }))
        })
      } else if (ready) onExit(code, signal)
      for (const r of onExited) r(exitInfo)
      onExited = []
    })
  })
}

function defaultLog(stream, line, spec) {
  process.stderr.write(`[${spec.company}/${spec.slug}] ${line}\n`)
}
