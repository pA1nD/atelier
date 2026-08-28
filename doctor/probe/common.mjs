// doctor/probe/common.mjs — pure helpers shared by hooks.mjs (inside the worker) and run.mjs (the host side).
// No side effects: hooks.mjs installs its hooks on import and is loaded only inside the worker.
import { fileURLToPath } from 'node:url'

/** The observation kinds hooks.mjs streams on fd 3 and run.mjs collects. */
export const KINDS = Object.freeze(['envRead', 'listen', 'spawn', 'writeOutside', 'selfData', 'egress', 'ctxModule', 'signal', 'exit'])
/** kind → the report list it lands in. */
export const LISTS = Object.freeze({ envRead: 'envReads', listen: 'listens', spawn: 'spawns', writeOutside: 'writesOutside', selfData: 'selfData', egress: 'egress', ctxModule: 'ctxModule', signal: 'signalHandlers', exit: 'processExit' })

export const HOOK_FILES = Object.freeze([fileURLToPath(new URL('./hooks.mjs', import.meta.url)), fileURLToPath(new URL('./entry.mjs', import.meta.url))])
export const RUNTIME_RE = /\/host\/worker\/(runtime|spawn)\.mjs$/
const FRAME_RE = /(?:\(|at )(?:async )?((?:file:\/\/)?\/[^():\n]+|node:[^():\n]+):(\d+):(\d+)\)?/

/**
 * attributeStack(stack, {hookFiles, skipRuntime}) → {by:'app'|'runtime'|'node', frame}: the first frame outside
 * the hook files and `node:` internals decides — host/worker/runtime.mjs or spawn.mjs → 'runtime', anything
 * else (the bundle, its deps) → 'app', no such frame → 'node'. `skipRuntime` looks past runtime frames too
 * (ctx.module's closure lives in runtime.mjs; its caller is the app).
 */
export function attributeStack(stack, { hookFiles = HOOK_FILES, skipRuntime = false } = {}) {
  for (const line of String(stack).split('\n').slice(1)) {
    const m = FRAME_RE.exec(line)
    if (!m) continue
    let f = m[1]
    if (f.startsWith('node:')) continue
    if (f.startsWith('file://')) { try { f = fileURLToPath(f) } catch { continue } }
    if (hookFiles.includes(f)) continue
    if (RUNTIME_RE.test(f)) { if (skipRuntime) continue; return { by: 'runtime', frame: `${f}:${m[2]}:${m[3]}` } }
    return { by: 'app', frame: `${f}:${m[2]}:${m[3]}` }
  }
  return { by: 'node', frame: null }
}
