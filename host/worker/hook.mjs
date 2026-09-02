// host/worker/hook.mjs — row K (DESIGN §2.2, §10.3 D8): the app's own `deploy` / `test` / `smoke` commands
// from module.json, run AS THE WORKER UID with the worker's env (row W) plus the step's keys, cwd = the
// prod export, config over stdin exactly as the worker gets it — the OR14 keys never enter the env the root
// wrapper chain (sh → prlimit → setpriv) receives. argv is `node hookrun.mjs <sh command>`: hookrun.mjs reads
// the config document to EOF after the uid drop, assigns it to its env and runs `sh -c <cmd>`; the pgroup is
// SIGKILLed at the budget (`detached: true`, the same shape as a worker's stop()).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { workerEnv, configPayload, lineSplitter } from './spawn.mjs'

export const HOOKRUN_PATH = fileURLToPath(new URL('./hookrun.mjs', import.meta.url))
export const HOOK_KEYS = Object.freeze(['deploy', 'test', 'smoke'])
export const HOOK_BUDGET_MS = Object.freeze({ deploy: 60_000, test: 60_000, smoke: 30_000 })
export const OUTPUT_LINES = 200

/**
 * hookSpec(spec, { cmd, cwd, dataDir, extra, hostEnv }) → SpawnSpec (row K, asserted byte-exact in tests)
 *   spec: the WorkerSpec of the slot (uid, instance, slug, dataDir = the data the hook may touch — the rehearsal
 *   copy or prod's); `cwd` = the export; `extra` = the step's keys (`ATELIER_SOCK`, `BASE_URL` override for smoke).
 *   env = row W + `DATA_DIR` (+ extra); `ATELIER_WORKER` stays so a node hook can read its spec.
 */
export function hookSpec(spec, { cmd, cwd, extra = {}, hostEnv = process.env, hookrun = HOOKRUN_PATH }) {
  const env = { ...workerEnv(spec, hostEnv), DATA_DIR: spec.dataDir, ...extra }
  return {
    argv: ['node', hookrun, cmd],
    env,
    cwd,
    uid: spec.uid, gid: spec.uid, groups: [],
    rlimits: spec.rlimits,
    oomScoreAdj: 1000,
    umask: 0o002,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  }
}

/**
 * runHook({ os, spec, cmd, cwd, extra, hostEnv, timeoutMs, log }) → {ok, code, signal, ms, output:[lines], error?}
 *   Never throws. `output` = the last OUTPUT_LINES of stdout+stderr (the first line of an error is the verdict's).
 *   A timeout SIGKILLs the process group and answers {ok:false, error:'timeout after N ms'}.
 */
export function runHook({ os, spec, cmd, cwd, extra = {}, hostEnv = process.env, timeoutMs = HOOK_BUDGET_MS.deploy, hookrun, log = () => {} }) {
  return new Promise((resolve) => {
    const t0 = os.now()
    const plan = hookSpec(spec, { cmd, cwd, extra, hostEnv, hookrun })
    let child
    try { child = os.spawn(plan) } catch (e) { return resolve({ ok: false, code: null, signal: null, ms: 0, output: [], error: `spawn: ${e.code ?? e.message}` }) }
    try { child.stdin?.on?.('error', () => {}); child.stdin?.end(configPayload(spec)) } catch {}
    const output = []
    const keep = (line) => { output.push(line); if (output.length > OUTPUT_LINES) output.shift() }
    child.stdout?.on?.('data', lineSplitter(keep))
    child.stderr?.on?.('data', lineSplitter(keep))
    let finished = false
    const finish = (r) => { if (finished) return; finished = true; clearTimeout(timer); resolve({ ...r, ms: os.now() - t0, output }) }
    const timer = setTimeout(() => {
      try { os.kill(-child.pid, 'SIGKILL') } catch {}
      try { os.kill(child.pid, 'SIGKILL') } catch {}
      log(`hook ${spec.slug}: timeout after ${timeoutMs} ms → SIGKILL pgroup`)
      finish({ ok: false, code: null, signal: 'SIGKILL', error: `timeout after ${timeoutMs} ms` })
    }, timeoutMs)
    child.on('error', (e) => finish({ ok: false, code: null, signal: null, error: `spawn: ${e.code ?? e.message}` }))
    child.on('exit', (code, signal) => {
      if (code === 0) return finish({ ok: true, code, signal })
      const last = [...output].reverse().find((l) => l.trim()) ?? ''
      finish({ ok: false, code, signal, error: signal ? `killed by ${signal}` : `exit ${code}${last ? `: ${last.trim()}` : ''}` })
    })
  })
}
