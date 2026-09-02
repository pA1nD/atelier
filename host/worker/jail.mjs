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
//     dataFileRoundTrip (b) — chown to root, join the group, chmod, chown back, drop the group;
//     both act on an O_NOFOLLOW fd after an fstat guard (`fdTrip`), never on a path, because the
//     entry lives in an agent-owned directory the agent can swap for a symlink at any moment.
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

/**
 * The release rows (DESIGN §10.3 D1), every one a root-owned dir under the `.atelier` dirfd tree:
 *   backupPlan(dir)            backup/<inst> and backup/<inst>/<id>   `0:19999 0750`  — the agent reads through gid 19999, no worker traverses
 *   rehearsalPlan(spec, root)  rehearsal/<inst> `0:<uid> 0750`, rehearsal/<inst>/data `<uid>:19999 2770` (the prod data copy the rehearsal worker writes)
 *   prodPlan(spec, dir)        prod/<inst> and prod/<inst>/<commit12> `0:<uid> 0750` — the export the worker reads, EACCES to uid 1000
 * `dir` / `root` are full paths (dirfd forms in the fleet); the caller passes each level it wants created.
 */
export function backupPlan(dir) { return mkdirOwned(dir, 0o750, 0, AGENT_DATA_GID) }
export function rehearsalPlan(spec, root) {
  return [...mkdirOwned(root, 0o750, 0, spec.uid), ...mkdirOwned(path.posix.join(root, 'data'), 0o2770, spec.uid, AGENT_DATA_GID)]
}
export function prodPlan(spec, dir) { return mkdirOwned(dir, 0o750, 0, spec.uid) }

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
 * EEXIST on mkdir is ok (the dir was claimed before) — the existing inode is lstat'ed: root-owned →
 * the chmod/chown that follow run (root chmods what it owns, no FOWNER needed); already owned by
 * the plan's `<uid>:<gid>` (a re-spawn, a resume: `data/<inst>` is `<uid>:19999`, root cannot chmod
 * it under the plan caps) → that path's chmod/chown are skipped as `owned`; anything else (a foreign
 * owner, a symlink, a file) → `EOWNER`/`ENOTDIR`, the plan stops. Any other failure stops the plan.
 * @returns {{ok:boolean, results:Array<{step:Step, ok:boolean, code?:string}>}}
 */
export function applyJail(os, steps, log = () => {}) {
  const results = []
  let owned = null   // the path whose mkdir hit EEXIST on an inode already handed to its owner
  const fail = (step, code) => { log(`[priv] ${step.op} ${step.path ?? ''}: ${code}`); results.push({ step, ok: false, code }); return { ok: false, results } }
  for (const [i, step] of steps.entries()) {
    if (owned && step.path === owned && (step.op === 'chmod' || step.op === 'chown')) {
      log(`[priv] ${step.op} ${step.path}: skipped (owned)`)
      results.push({ step, ok: true, code: 'EEXIST' })
      continue
    }
    let code
    try {
      if (step.op === 'mkdir') os.mkdir(step.path, step.mode)
      else if (step.op === 'chmod') os.chmod(step.path, step.mode)
      else if (step.op === 'chown') os.chown(step.path, step.uid, step.gid)
      else if (step.op === 'setgroups') os.setgroups(step.groups)
      else throw Object.assign(new Error(`unknown op ${step.op}`), { code: 'EINVAL' })
    } catch (e) {
      code = e.code ?? 'EIO'
      if (!(step.op === 'mkdir' && code === 'EEXIST')) return fail(step, code)
      let st
      try { st = os.lstat(step.path) } catch (e2) { return fail(step, e2.code ?? 'EIO') }
      if (!st.isDirectory()) return fail(step, 'ENOTDIR')
      const want = steps.slice(i + 1).find((s) => s.op === 'chown' && s.path === step.path)
      if (st.uid !== 0) {
        if (!(want && st.uid === want.uid && st.gid === want.gid)) return fail(step, 'EOWNER')
        owned = step.path
      }
    }
    log(`[priv] ${step.op} ${step.path ?? step.groups?.join(',') ?? ''}: ok${code ? ` (${code})` : ''}`)
    results.push({ step, ok: true, code })
  }
  return { ok: true, results }
}

/**
 * After READY: the socket the worker bound (`<uid>:<uid>`) becomes `0:0 0700` — only the host dials
 * it — and the socket dir drops the worker's write bit (`0730` → `0710`): the worker cannot fill the
 * `/run/atelier` tmpfs for life; `jailPlan` re-sets `0730` before the next spawn (prepareDirs).
 * `shared` (the rehearsal worker, DESIGN §10.3 D8): `0:<uid> 0770` — the host (owner) AND the worker uid
 * (the smoke hook's `curl --unix-socket`) dial it; connect(2) needs write on the socket inode and
 * userns-root has no DAC caps, so a `0:0 0700` socket is the host's alone and a worker-owned 0775 one
 * is EACCES to root. Chown first, chmod while root owns it.
 */
export function afterReady(os, spec, log = () => {}, { shared = false } = {}) {
  return applyJail(os, [
    { op: 'chown', path: spec.sock, uid: 0, gid: shared ? spec.uid : 0 },
    { op: 'chmod', path: spec.sock, mode: shared ? 0o770 : 0o700 },
    ...(spec.sockDir ? [{ op: 'chmod', path: spec.sockDir, mode: 0o710 }] : []),
  ], log)
}

// The fd-based round trips (§6.2). chown(2)/chmod(2) follow symlinks, and both round trips act on
// an inode inside an AGENT-owned directory — the agent can swap the entry for a symlink between the
// check and the chown (PLAN §4.3 "Symlink rule": realpath→open is a TOCTOU). So: open the entry
// O_NOFOLLOW → fstat the pinned inode → refuse anything but the expected type/owner → fchown /
// fchmod on the fd → close. A refusal or an errno stops the trip; nothing is chowned by path.
function fdTrip(os, path, { open, expect, steps, groups }, log) {
  const results = []
  const fail = (step, code) => { log(`[priv] ${step.op} ${path}: ${code}`); results.push({ step, ok: false, code }); return { ok: false, results } }
  const before = groups !== undefined ? os.getgroups() : null
  if (groups !== undefined) { try { os.setgroups(groups) } catch (e) { return fail({ op: 'setgroups', groups }, e.code ?? 'EIO') } }
  let fd
  try {
    try { fd = open() } catch (e) { return fail({ op: 'open', path }, e.code ?? 'EIO') }
    let st
    try { st = os.fstat(fd) } catch (e) { return fail({ op: 'fstat', path }, e.code ?? 'EIO') }
    const why = expect(st)
    if (why) return fail({ op: 'fstat', path }, why)
    results.push({ step: { op: 'fstat', path }, ok: true })
    for (const step of steps) {
      try {
        if (step.op === 'fchown') os.fchown(fd, step.uid, step.gid)
        else if (step.op === 'fchmod') os.fchmod(fd, step.mode)
      } catch (e) { return fail(step, e.code ?? 'EIO') }
      log(`[priv] ${step.op} ${path}: ok`)
      results.push({ step, ok: true })
    }
    return { ok: true, results }
  } finally {
    if (fd !== undefined) { try { os.closeFd(fd) } catch {} }
    if (before) { try { os.setgroups(before) } catch (e) { log(`[priv] setgroups restore: ${e.code ?? e.message}`) } }
  }
}

/**
 * §6.2(a) — the agent-created `1000:1000` app folder becomes `1000:<uid> 2750` at claim, on an fd:
 * setgroups([<uid>]) (a re-claim finds the folder `2750 1000:<uid>` — root enters it only as a group
 * member; the setgid bit also sticks only while the caller is in the dir's group, g2 T0b) → open
 * O_DIRECTORY|O_NOFOLLOW → fstat must be a directory owned by 1000 with gid 1000 or <uid> (anything
 * else — a swapped-in root inode, a symlink — is refused as EOWNER/ELOOP and left untouched) →
 * fchown 0:<uid> → fchmod 2750 → fchown 1000:<uid> → close → the host's groups restored.
 */
export function claimRoundTrip(os, appDir, uid, log = () => {}) {
  return fdTrip(os, appDir, {
    groups: [uid],
    open: () => os.openDir(appDir),
    expect: (st) => (!st.isDirectory() ? 'ENOTDIR' : st.uid !== AGENT.uid || (st.gid !== AGENT.gid && st.gid !== uid) ? 'EOWNER' : null),
    steps: [{ op: 'fchown', uid: 0, gid: uid }, { op: 'fchmod', mode: 0o2750 }, { op: 'fchown', uid: AGENT.uid, gid: uid }],
  }, log)
}

/**
 * §6.2(b) — an agent-created sqlite `-wal`/`-shm` found `0644` inside dataDir becomes `<uid>:19999 0660`
 * by the same trip: open O_NOFOLLOW → fstat must be a regular file with one link owned by 1000 →
 * fchown 0:19999 → fchmod 0660 → fchown <uid>:19999. The caller holds group 19999 (dataDir is
 * `<uid>:19999 2770`; root without DAC cannot enter it otherwise).
 */
export function dataFileRoundTrip(os, file, uid, log = () => {}) {
  return fdTrip(os, file, {
    open: () => os.openFile(file),
    expect: (st) => (!st.isFile() ? 'ENOTREG' : st.nlink !== 1 ? 'EMLINK' : st.uid !== AGENT.uid ? 'EOWNER' : null),
    steps: [{ op: 'fchown', uid: 0, gid: AGENT_DATA_GID }, { op: 'fchmod', mode: 0o660 }, { op: 'fchown', uid, gid: AGENT_DATA_GID }],
  }, log)
}
