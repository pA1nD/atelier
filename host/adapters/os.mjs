// host/adapters/os.mjs — the ONE seam for Linux-only calls (PLAN §4.3: setpriv, prlimit, chown,
// dirfd-relative paths, /proc reads, signals). Every host module takes an `os` object and never
// imports node:fs/child_process for a privileged operation itself, so `node --test` on macOS
// exercises the logic with `memory()` and the Linux drill (host/drill/) proves the real thing.
//
// Three implementations, one shape (see DESIGN.md §5 for the contract of every method):
//   linuxRoot()     — the fleet: uid 0 inside a userns pod, caps {SETUID,SETGID,CHOWN,KILL}.
//   unprivileged()  — a laptop (`npx atelier`, macOS or Linux non-root): real fs, real spawn,
//                     NO uid drop, NO rlimits, chown/chmod/setgroups are no-ops that return
//                     {skipped:true}. The jail is lifecycle-only (§4.6).
//   memory(state)   — unit tests: a recording fake; every call is appended to `state.calls`
//                     and answered from `state.fs` / `state.procs`; nothing touches the disk.
import fs from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'

export const O_DIRFD = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
export const O_FILEFD = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW

// setpriv/prlimit argv builders are pure and shared by every implementation (tests assert them).
export function setprivArgv({ uid, gid, groups = [] }) {
  const g = groups.length ? [`--groups=${groups.join(',')}`] : ['--clear-groups']
  return ['setpriv', `--reuid=${uid}`, `--regid=${gid}`, ...g, '--']
}
export function prlimitArgv({ data, core = 0, nproc, nofile }) {
  const a = ['prlimit']
  if (data !== undefined) a.push(`--data=${data}`)
  if (core !== undefined) a.push(`--core=${core}`)
  if (nproc !== undefined) a.push(`--nproc=${nproc}`)
  if (nofile !== undefined) a.push(`--nofile=${nofile}`)
  a.push('--')
  return a
}

/**
 * @typedef {object} SpawnSpec
 * @property {string[]} argv          the program and its arguments (NOT wrapped yet)
 * @property {Record<string,string>} env   the COMPLETE environment (nothing is inherited)
 * @property {string} cwd
 * @property {number} [uid]           drop to this uid (linuxRoot wraps in setpriv; others ignore)
 * @property {number} [gid]
 * @property {number[]} [groups]      supplementary groups; [] = --clear-groups
 * @property {{data?:number,core?:number,nproc?:number,nofile?:number}} [rlimits]
 * @property {number} [oomScoreAdj]   self-raise before the uid drop (sh wrapper), linuxRoot only
 * @property {number} [umask]         applied in the wrapper (`umask NNN`), all implementations
 * @property {Array<'ignore'|'pipe'|number>} stdio   exactly what the child inherits; default ['ignore','pipe','pipe']
 * @property {boolean} [detached]     own process group (for the pgroup SIGKILL sweep)
 */

function wrap(spec, privileged) {
  let argv = spec.argv
  if (privileged && spec.uid !== undefined) argv = [...setprivArgv({ uid: spec.uid, gid: spec.gid ?? spec.uid, groups: spec.groups ?? [] }), ...argv]
  if (privileged && spec.rlimits) argv = [...prlimitArgv(spec.rlimits), ...argv]
  const pre = []
  if (spec.umask !== undefined) pre.push(`umask ${spec.umask.toString(8)}`)
  if (privileged && spec.oomScoreAdj !== undefined) pre.push(`echo ${spec.oomScoreAdj} > /proc/self/oom_score_adj`)
  if (pre.length) argv = ['sh', '-c', `${pre.join('; ')}; exec "$@"`, 'sh', ...argv]
  return argv
}

function real({ privileged }) {
  const skip = { skipped: true }
  return {
    kind: privileged ? 'linux-root' : 'unprivileged',
    privileged,
    // --- filesystem (paths may be `at(fd, rel)` forms) ---
    at: (fd, rel) => (process.platform === 'linux' ? path.posix.join(`/proc/self/fd/${fd}`, rel) : path.join(fdPaths.get(fd) ?? '', rel)),
    openDir: (p) => { const fd = fs.openSync(p, O_DIRFD); fdPaths.set(fd, fs.realpathSync(p)); return fd },
    // openFile: O_RDONLY|O_NOFOLLOW on the final component — a planted symlink is ELOOP, never followed
    openFile: (p) => { const fd = fs.openSync(p, O_FILEFD); fdPaths.set(fd, fs.realpathSync(p)); return fd },
    readlinkFd: (fd) => (process.platform === 'linux' ? fs.readlinkSync(`/proc/self/fd/${fd}`) : fdPaths.get(fd)),
    closeFd: (fd) => { fs.closeSync(fd); fdPaths.delete(fd) },
    // the fd-based trio: ownership round trips act on the inode the fd pins, never on a path (jail.mjs)
    fstat: (fd) => fs.fstatSync(fd),
    fchown: (fd, uid, gid) => (privileged ? fs.fchownSync(fd, uid, gid) : skip),
    fchmod: (fd, mode) => (privileged ? fs.fchmodSync(fd, mode) : skip),
    mkdir: (p, mode) => fs.mkdirSync(p, { mode }),
    chown: (p, uid, gid) => (privileged ? fs.chownSync(p, uid, gid) : skip),
    lchown: (p, uid, gid) => (privileged ? fs.lchownSync(p, uid, gid) : skip),
    chmod: (p, mode) => (privileged ? fs.chmodSync(p, mode) : skip),
    lstat: (p) => fs.lstatSync(p),
    setgroups: (groups) => (privileged && process.setgroups ? process.setgroups(groups) : skip),
    getgroups: () => (process.getgroups ? process.getgroups() : []),
    uid: () => (process.getuid ? process.getuid() : -1),
    // --- processes ---
    spawn: (spec) => {
      const argv = wrap(spec, privileged)
      return spawn(argv[0], argv.slice(1), { env: spec.env, cwd: spec.cwd, stdio: spec.stdio ?? ['ignore', 'pipe', 'pipe'], detached: !!spec.detached })
    },
    spawnSync: (spec) => {
      const argv = wrap(spec, privileged)
      return spawnSync(argv[0], argv.slice(1), { env: spec.env, cwd: spec.cwd, encoding: 'utf8', stdio: spec.stdio ?? ['ignore', 'pipe', 'pipe'] })
    },
    kill: (pid, signal) => process.kill(pid, signal),
    // /proc readers: null when unavailable (macOS) — callers treat null as "no sample"
    rssKb: (pid) => { try { const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/); return m ? Number(m[1]) : null } catch { return null } },
    cpuJiffies: (pid) => { try { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const p = f.slice(f.lastIndexOf(')') + 2).split(' '); return Number(p[11]) + Number(p[12]) } catch { return null } },
    statfs: (p) => { try { const s = fs.statfsSync(p); return { bytes: s.blocks * s.bsize, free: s.bavail * s.bsize } } catch { return null } },
    pidsOfUid: (uid) => { try { return fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).filter((n) => { try { return new RegExp(`^Uid:\\s+${uid}\\b`, 'm').test(fs.readFileSync(`/proc/${n}/status`, 'utf8')) } catch { return false } }).map(Number) } catch { return [] } },
    now: () => Date.now(),
    platform: process.platform,
  }
}
const fdPaths = new Map()

export const linuxRoot = () => real({ privileged: true })
export const unprivileged = () => real({ privileged: false })

// memory(state): the recording fake. state = { calls: [], fs: {path → {uid,gid,mode,type}}, procs: {}, now }.
// spawn() returns a fake ChildProcess-like emitter the test drives (state.spawned.push(...)).
export function memory(state = {}) {
  state.calls ??= []; state.fs ??= {}; state.spawned ??= []; state.now ??= 0; state.fds ??= new Map(); state.groups ??= []
  const rec = (op, ...args) => { state.calls.push([op, ...args]); return state.answers?.[op]?.(...args) }
  let nextFd = 3
  const ent = (p) => state.fs[p]
  const errno = (code) => Object.assign(new Error(code), { code })
  return {
    kind: 'memory', privileged: true, platform: 'linux',
    at: (fd, rel) => path.posix.join(state.fds.get(fd) ?? `/fd/${fd}`, rel),
    // openDir/openFile: a `link` entry is ELOOP (O_NOFOLLOW); a missing entry is fine for openDir (the
    // launcher's plan opens what it just created) and ENOENT for openFile
    openDir: (p) => { const e = ent(p); if (e?.type === 'link') throw errno('ELOOP'); const fd = nextFd++; state.fds.set(fd, p); rec('openDir', p, fd); return fd },
    openFile: (p) => { const e = ent(p); if (!e) throw errno('ENOENT'); if (e.type === 'link') throw errno('ELOOP'); const fd = nextFd++; state.fds.set(fd, p); rec('openFile', p, fd); return fd },
    readlinkFd: (fd) => state.fds.get(fd),
    closeFd: (fd) => { state.fds.delete(fd); rec('closeFd', fd) },
    fstat: (fd) => { const e = ent(state.fds.get(fd)); if (!e) throw errno('EBADF'); return { uid: e.uid, gid: e.gid, mode: e.mode, isDirectory: () => e.type === 'dir', isFile: () => e.type === 'file', isSymbolicLink: () => e.type === 'link', nlink: e.nlink ?? 1 } },
    fchown: (fd, uid, gid) => { const e = ent(state.fds.get(fd)); if (e) { e.uid = uid; e.gid = gid } rec('fchown', fd, uid, gid) },
    fchmod: (fd, mode) => { const e = ent(state.fds.get(fd)); if (e) e.mode = mode; rec('fchmod', fd, mode) },
    mkdir: (p, mode) => { if (ent(p)) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e } state.fs[p] = { uid: 0, gid: 0, mode, type: 'dir' }; rec('mkdir', p, mode) },
    chown: (p, uid, gid) => { const e = ent(p); if (e) { e.uid = uid; e.gid = gid } rec('chown', p, uid, gid) },
    lchown: (p, uid, gid) => { const e = ent(p); if (e) { e.uid = uid; e.gid = gid } rec('lchown', p, uid, gid) },
    chmod: (p, mode) => { const e = ent(p); if (e) e.mode = mode; rec('chmod', p, mode) },
    lstat: (p) => { const e = ent(p); if (!e) { const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err } return { uid: e.uid, gid: e.gid, mode: e.mode, isDirectory: () => e.type === 'dir', isSymbolicLink: () => e.type === 'link', nlink: e.nlink ?? 1 } },
    setgroups: (g) => { state.groups = [...g]; rec('setgroups', g) },
    getgroups: () => [...state.groups],
    uid: () => 0,
    spawn: (spec) => { const argv = wrap(spec, true); const child = fakeChild(spec, argv); state.spawned.push(child); rec('spawn', argv, spec); return child },
    spawnSync: (spec) => { const argv = wrap(spec, true); rec('spawnSync', argv, spec); return state.answers?.spawnSync?.(argv, spec) ?? { status: 0, stdout: '', stderr: '' } },
    kill: (pid, signal) => { rec('kill', pid, signal); const c = state.spawned.find((x) => x.pid === pid); if (c?.onSignal) c.onSignal(signal) },
    rssKb: (pid) => state.procs?.[pid]?.rssKb ?? null,
    cpuJiffies: (pid) => state.procs?.[pid]?.jiffies ?? null,
    statfs: (p) => state.statfs?.[p] ?? null,
    pidsOfUid: (uid) => Object.entries(state.procs ?? {}).filter(([, v]) => v.uid === uid).map(([k]) => Number(k)),
    now: () => state.now,
  }
}

let fakePid = 1000
function fakeChild(spec, argv) {
  const { EventEmitter } = eventsMod
  const c = new EventEmitter()
  c.pid = ++fakePid; c.spec = spec; c.argv = argv; c.exitCode = null; c.signalCode = null
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter()
  // stdin as a recording sink when the spec asked for a pipe (the worker's config lane, spawn.mjs)
  c.stdin = spec.stdio?.[0] === 'pipe' ? Object.assign(new EventEmitter(), { written: [], ended: false, write(d) { this.written.push(String(d)); return true }, end(d) { if (d !== undefined) this.written.push(String(d)); this.ended = true } }) : null
  c.stdio = [c.stdin, c.stdout, c.stderr, new EventEmitter()]
  c.kill = (signal = 'SIGTERM') => { if (c.onSignal) c.onSignal(signal); return true }
  c.exit = (code, signal = null) => { c.exitCode = code; c.signalCode = signal; c.emit('exit', code, signal) }
  return c
}
import * as eventsMod from 'node:events'
