// host/worker/jail.mjs — the per-instance directory/socket/ownership plan (DESIGN §3, §4.1, §6.2).
// Pure plan + apply: `jailPlan(spec)` is data a test asserts byte-exact; `applyJail(os, steps)`
// runs it through the adapter (host/adapters/os.mjs) so nothing here touches node:fs itself.
//
// Rules carried from PLAN §4.3 (R1: caps {SETUID, SETGID, CHOWN, KILL}, no FOWNER):
//   - every dir is created with its mode (mkdir with mode), then chmod'ed to that mode WHILE ROOT
//     STILL OWNS IT (the host runs under umask 077, row H, so the mkdir mode alone lands as 0700),
//     then chowned. Chmod-before-chown needs no FOWNER; the directory setgid bit survives a chown
//     (the kernel kills SUID/SGID on chown for regular files only).
//   - the only chmod-after-chown sites are the two round trips of §6.2: claimRoundTrip (a) and
//     dataFileRoundTrip (b) — chown to root, join the group, chmod, chown back, drop the group.
//   - the host never writes into an agent-owned (1000) or worker-owned directory as root.
import path from 'node:path'

// Constants shared with hygiene.mjs (launcher lane). Kept here so this lane tests alone; the
// integrator points both files at one source (see DESIGN.md, workers lane section).
export const AGENT = Object.freeze({ uid: 1000, gid: 1000 })
export const AGENT_DATA_GID = 19999
export const WORKER_UID_BASE = 20000
export const WORKER_UID_MAX = 65535
export const INSTANCE_RE = /^i-[0-9a-f]{16}$/
export const appgid = (spec) => spec.uid

/** @typedef {{op:'mkdir'|'chown'|'chmod'|'setgroups', path?:string, mode?:number, uid?:number, gid?:number, groups?:number[]}} Step */

const mkdirOwned = (p, mode, uid, gid) => [
  { op: 'mkdir', path: p, mode },
  { op: 'chmod', path: p, mode },
  { op: 'chown', path: p, uid, gid },
]

/**
 * The plan for one instance at claim + spawn (§3 rows the worker needs):
 *   data/<inst>   <uid>:19999 2770   ctx.dataDir (agent reads/writes via group 19999, peers EACCES)
 *   tmp/<inst>    <uid>:<uid> 0700   TMPDIR (keeps /dev/shm clean, R6)
 *   w/<inst>      0:<uid> 0730       socket dir: the worker binds, cannot list
 * last-good/<inst> and the marker dir are the supervisor's (it writes into them); scratch is
 * installPlan's (install.mjs). Every path comes from the spec so the supervisor decides the roots
 * (dirfd-relative `/proc/self/fd/N/...` forms in the fleet, plain paths on a laptop).
 * @param {{uid:number, dataDir:string, tmpDir:string, sockDir:string}} spec
 * @returns {Step[]}
 */
export function jailPlan(spec) {
  const { uid } = spec
  return [
    ...mkdirOwned(spec.dataDir, 0o2770, uid, AGENT_DATA_GID),
    ...mkdirOwned(spec.tmpDir, 0o700, uid, uid),
    ...mkdirOwned(spec.sockDir, 0o730, 0, uid),
  ]
}

/** scratch/<inst> at first install: `0:<uid> 0750`, `home/` `<uid>:<uid> 0700`, `build/` `<uid>:<uid> 0755`. */
export function installPlan(spec, scratchDir) {
  const { uid } = spec
  return [
    ...mkdirOwned(scratchDir, 0o750, 0, uid),
    ...mkdirOwned(path.posix.join(scratchDir, 'home'), 0o700, uid, uid),
    ...mkdirOwned(path.posix.join(scratchDir, 'build'), 0o755, uid, uid),
  ]
}

/**
 * Runs a plan through the adapter. Each step is logged `[priv] <op> <path>: ok|<errno>`.
 * EEXIST on mkdir is ok (the dir was claimed before); any other failure stops the plan.
 * @returns {{ok:boolean, results:Array<{step:Step, ok:boolean, code?:string}>}}
 */
export function applyJail(os, steps, log = () => {}) {
  const results = []
  for (const step of steps) {
    let code
    try {
      if (step.op === 'mkdir') os.mkdir(step.path, step.mode)
      else if (step.op === 'chmod') os.chmod(step.path, step.mode)
      else if (step.op === 'chown') os.chown(step.path, step.uid, step.gid)
      else if (step.op === 'setgroups') os.setgroups(step.groups)
      else throw Object.assign(new Error(`unknown op ${step.op}`), { code: 'EINVAL' })
    } catch (e) {
      code = e.code ?? 'EIO'
      if (!(step.op === 'mkdir' && code === 'EEXIST')) {
        log(`[priv] ${step.op} ${step.path ?? ''}: ${code}`)
        results.push({ step, ok: false, code })
        return { ok: false, results }
      }
    }
    log(`[priv] ${step.op} ${step.path ?? step.groups?.join(',') ?? ''}: ok${code ? ` (${code})` : ''}`)
    results.push({ step, ok: true, code })
  }
  return { ok: true, results }
}

/** After READY: the socket the worker bound (`<uid>:<uid>`) becomes `0:0 0700` — only the host dials it. */
export function afterReady(os, spec, log = () => {}) {
  return applyJail(os, [
    { op: 'chown', path: spec.sock, uid: 0, gid: 0 },
    { op: 'chmod', path: spec.sock, mode: 0o700 },
  ], log)
}

/**
 * §6.2(a) — the agent-created `1000:1000` app folder becomes `1000:<uid> 2750` at claim:
 * chown 0:<uid> → setgroups([<uid>]) → chmod 2750 → chown 1000:<uid> → restore the host's groups.
 * The setgid bit sticks only while the caller is a member of the dir's group (g2 T0b), hence the
 * setgroups around the chmod; root owns the inode at that moment, so no FOWNER is needed.
 */
export function claimRoundTrip(os, appDir, uid, log = () => {}) {
  const before = os.getgroups()
  const r = applyJail(os, [
    { op: 'chown', path: appDir, uid: 0, gid: uid },
    { op: 'setgroups', groups: [uid] },
    { op: 'chmod', path: appDir, mode: 0o2750 },
    { op: 'chown', path: appDir, uid: AGENT.uid, gid: uid },
  ], log)
  applyJail(os, [{ op: 'setgroups', groups: before }], log)
  return r
}

/**
 * §6.2(b) — an agent-created sqlite `-wal`/`-shm` found `0644` inside dataDir becomes
 * `<uid>:19999 0660` by the same round trip (chown to root → chmod → chown on).
 */
export function dataFileRoundTrip(os, file, uid, log = () => {}) {
  return applyJail(os, [
    { op: 'chown', path: file, uid: 0, gid: AGENT_DATA_GID },
    { op: 'chmod', path: file, mode: 0o660 },
    { op: 'chown', path: file, uid, gid: AGENT_DATA_GID },
  ], log)
}
