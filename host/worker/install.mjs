// host/worker/install.mjs — two-phase dependency install (PLAN §4.3 "Dependency install", DESIGN §4.1,
// §2.2 rows I and F, §6.2). `npm install` runs AS THE WORKER UID in a root-owned scratch
// (`scratch/<inst>`: `home/` 0700 with the npm cache inside, `build/` with the manifest copy), then
// `freeze.py` moves the tree into the agent-owned app folder as `1000:<appgid>` (worker processes
// SIGKILLed, dirfd-relative O_NOFOLLOW walk, setuid/setgid refused, rename as uid 1000). On a freeze
// abort `freeze.py cleanup` hands the scratch back and nothing lands in the app folder.
// Re-install = thaw (a no-op when nothing is frozen) → install (npm no-op ≈ 300 ms) → freeze.
//
// Under `unprivileged()` (a laptop): npm runs in the app folder as the current user, freeze is
// skipped (logged) — the jail is lifecycle-only there (DESIGN §5).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlan, applyJail, appgid } from './jail.mjs'
import { lineSplitter } from './spawn.mjs'

export const FREEZE_PATH = fileURLToPath(new URL('./freeze.py', import.meta.url))
export const NPM_ARGV = ['npm', 'install', '--no-audit', '--no-fund']
export const INSTALL_TIMEOUT_MS = 10 * 60_000

/** Row I: `npm install` as the worker in <scratch>/build with HOME=<scratch>/home and the cache inside it. */
export function npmSpec(spec, { scratchDir, hostEnv }) {
  const home = path.posix.join(scratchDir, 'home')
  return {
    argv: NPM_ARGV,
    env: { PATH: hostEnv.PATH, NODE_ENV: hostEnv.NODE_ENV ?? 'production', APP_ID: spec.instance, HOME: home, npm_config_cache: path.posix.join(home, '.npm-cache') },
    cwd: path.posix.join(scratchDir, 'build'),
    uid: spec.uid, gid: spec.uid, groups: [],
    umask: 0o022,
    stdio: ['ignore', 'pipe', 'pipe'],
  }
}

/** The manifest copy into build/ runs as the worker (it reads the 2750 app folder through appgid; root cannot). */
export function copyManifestSpec(spec, { scratchDir, hostEnv }) {
  return {
    argv: ['sh', '-c', 'cp -- "$1/package.json" "$2/package.json" && { [ -f "$1/package-lock.json" ] && cp -- "$1/package-lock.json" "$2/package-lock.json" || true; }', 'sh', spec.appDir, path.posix.join(scratchDir, 'build')],
    env: { PATH: hostEnv.PATH },
    cwd: '/',
    uid: spec.uid, gid: spec.uid, groups: [],
    umask: 0o022,
    stdio: ['ignore', 'pipe', 'pipe'],
  }
}

/** Row F: `python3 freeze.py <mode> <inst> <slug> <uid> <appgid>` as root with groups cleared; fd 3 = the .atelier dirfd. */
export function freezeSpec(mode, spec, { dirfd, hostEnv, freeze = FREEZE_PATH }) {
  return {
    argv: ['python3', freeze, mode, spec.instance, spec.slug, String(spec.uid), String(appgid(spec)), '--dirfd', '3'],
    env: { PATH: hostEnv.PATH },
    cwd: '/',
    uid: 0, gid: 0, groups: [],
    umask: 0o022,
    stdio: ['ignore', 'pipe', 'pipe', dirfd],
  }
}

/** `FREEZE-OK <mode> <slug> k=v …` | `FREEZE-ABORT <mode> <slug>: <reason>` → {ok, mode, stats|reason}. */
export function parseFreeze(stdout) {
  const lines = String(stdout).split('\n').map((l) => l.trim()).filter(Boolean)
  for (const l of lines.reverse()) {
    let m = /^FREEZE-OK (\S+) (\S+)(.*)$/.exec(l)
    if (m) {
      const stats = {}
      for (const kv of m[3].trim().split(/\s+/).filter(Boolean)) { const [k, v] = kv.split('='); stats[k] = Number(v) }
      return { ok: true, mode: m[1], stats }
    }
    m = /^FREEZE-ABORT (\S+) (\S+): (.*)$/.exec(l)
    if (m) return { ok: false, mode: m[1], reason: m[3] }
  }
  return { ok: false, reason: 'no verdict line' }
}

/** Runs one adapter child to exit, collecting stdout/stderr (bounded) — the memory fake is driven by the test. */
export function run(os, spec, { timeoutMs = INSTALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child
    try { child = os.spawn(spec) } catch (e) { return resolve({ code: null, signal: null, stdout: '', stderr: `spawn: ${e.code ?? e.message}` }) }
    const out = [], err = []
    const keep = (arr, line) => { arr.push(line); if (arr.length > 200) arr.shift() }
    child.stdout?.on('data', lineSplitter((l) => keep(out, l)))
    child.stderr?.on('data', lineSplitter((l) => keep(err, l)))
    let finished = false
    const finish = (code, signal) => { if (finished) return; finished = true; clearTimeout(t); resolve({ code, signal, stdout: out.join('\n'), stderr: err.join('\n') }) }
    const t = setTimeout(() => { try { os.kill(child.pid, 'SIGKILL') } catch {} ; keep(err, `timeout after ${timeoutMs} ms`); finish(null, 'SIGKILL') }, timeoutMs)
    child.on('error', (e) => { keep(err, `spawn: ${e.code ?? e.message}`); finish(null, null) })
    child.on('exit', (code, signal) => finish(code, signal))
  })
}

/** The scratch dir as a path another process can open: `<readlink(dirfd)>/scratch/<inst>` (the dirfd form when the link cannot be read). */
export function realScratch(os, dirfd, instance, fallback) {
  let base = null
  try { base = os.readlinkFd(dirfd) } catch {}
  return typeof base === 'string' && base ? path.posix.join(base, 'scratch', instance) : fallback
}

const tail = (s, n = 5) => String(s).split('\n').filter(Boolean).slice(-n).join(' | ')

/**
 * @returns {Promise<{ok:true, ms:number, files:number|null} | {ok:false, class:'install'|'freeze-abort'|'setuid-refused', message:string}>}
 *   `beforeFreeze` (optional, async): the supervisor stops the live worker here — freeze.py SIGKILLs every process
 *   of the worker uid, so a still-running worker dies without its teardown otherwise.
 */
export async function installDeps({ os, dirfd, spec, log = () => {}, hostEnv = process.env, freeze = FREEZE_PATH, beforeFreeze, timeoutMs = INSTALL_TIMEOUT_MS }) {
  const t0 = os.now()
  const ms = () => os.now() - t0
  if (!os.privileged) {
    log(`install ${spec.slug}: unprivileged — npm in the app folder as the current user, freeze skipped`)
    const r = await run(os, {
      argv: NPM_ARGV,
      env: { PATH: hostEnv.PATH, NODE_ENV: hostEnv.NODE_ENV ?? 'production', APP_ID: spec.instance, HOME: hostEnv.HOME },
      cwd: spec.appDir, umask: 0o022, stdio: ['ignore', 'pipe', 'pipe'],
    }, { timeoutMs })
    if (r.code !== 0) return { ok: false, class: 'install', message: `npm exit ${r.code ?? r.signal}: ${tail(r.stderr)}` }
    return { ok: true, ms: ms(), files: null }
  }

  const scratchDir = os.at(dirfd, `scratch/${spec.instance}`)
  const buildDir = path.posix.join(scratchDir, 'build')
  // A freeze hands `build` to the AGENT (1000) for the rename and leaves it there; the NEXT install's
  // jail plan wants it `<uid>:<uid>` and applyJail would EOWNER on the agent-owned dir BEFORE thaw can
  // reclaim it. So when build already exists, drop its three plan steps: thaw (next) moves the frozen
  // tree back and chowns build to the worker. On a first install build is missing → the full plan
  // creates it worker-owned and thaw is a no-op.
  const buildExists = (() => { try { return !!os.lstat(buildDir) } catch { return false } })()
  const plan = buildExists ? installPlan(spec, scratchDir).filter((s) => s.path !== buildDir) : installPlan(spec, scratchDir)
  const jail = applyJail(os, plan, log)
  // the cp and npm children see the host's `/proc/self/fd/N/…` as THEIR fd table (fd 3 is not the dirfd
  // there): they get the real path (DESIGN I1.13); freeze.py keeps the dirfd form (it inherits fd 3)
  const scratchReal = realScratch(os, dirfd, spec.instance, scratchDir)
  if (!jail.ok) { const f = jail.results.at(-1); return { ok: false, class: 'install', message: `scratch ${f.step.op} ${f.step.path}: ${f.code}` } }

  // thaw: a frozen tree comes back to build/ as the worker's so npm can re-run in place (no-op when nothing is frozen)
  const thaw = await run(os, freezeSpec('thaw', spec, { dirfd, hostEnv, freeze }), { timeoutMs })
  const thawV = parseFreeze(thaw.stdout)
  log(`install ${spec.slug}: thaw rc=${thaw.code} ${thawV.ok ? JSON.stringify(thawV.stats) : thawV.reason}`)
  if (thaw.code !== 0 || !thawV.ok) return { ok: false, class: 'freeze-abort', message: `thaw: ${thawV.reason ?? tail(thaw.stderr)}` }

  const cp = await run(os, copyManifestSpec(spec, { scratchDir: scratchReal, hostEnv }), { timeoutMs })
  if (cp.code !== 0) return { ok: false, class: 'install', message: `package.json copy failed (rc=${cp.code}): ${tail(cp.stderr)}` }

  const npm = await run(os, npmSpec(spec, { scratchDir: scratchReal, hostEnv }), { timeoutMs })
  log(`install ${spec.slug}: npm rc=${npm.code} in ${ms()} ms`)
  if (npm.code !== 0) return { ok: false, class: 'install', message: `npm exit ${npm.code ?? npm.signal}: ${tail(npm.stderr)}` }

  await beforeFreeze?.()
  const fr = await run(os, freezeSpec('freeze', spec, { dirfd, hostEnv, freeze }), { timeoutMs })
  const frV = parseFreeze(fr.stdout)
  if (fr.code === 0 && frV.ok) {
    log(`install ${spec.slug}: freeze ${JSON.stringify(frV.stats)}`)
    return { ok: true, ms: ms(), files: frV.stats.files ?? null }
  }
  const reason = frV.reason ?? tail(fr.stderr) ?? `rc=${fr.code}`
  log(`install ${spec.slug}: FREEZE-ABORT ${reason} → cleanup`)
  const cl = await run(os, freezeSpec('cleanup', spec, { dirfd, hostEnv, freeze }), { timeoutMs })
  log(`install ${spec.slug}: cleanup rc=${cl.code} ${tail(cl.stdout, 1)}`)
  return { ok: false, class: /setuid\/setgid/.test(reason) ? 'setuid-refused' : 'freeze-abort', message: reason }
}
