// host/supervisor/slots.mjs — the two slots of an app row (DESIGN §10.3 D1–D5) and the root-side helpers the
// deploy needs: the layout under the `.atelier` dirfd (`prod/`, `data-dev/`, `rehearsal/`, `backup/`), the
// per-slot socket names, the export walk (chmod-then-chown on inodes root created), the `cp -a` / `rm -rf` /
// `du` specs that run as root WITH group 19999 (a `<uid>:19999 2770` data dir is EACCES to userns-root
// otherwise — no DAC caps), the backup id and the pruning rule (D11). Pure where it can be; every process
// goes through the adapter.
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { AGENT_DATA_GID } from '../worker/jail.mjs'

export const SLOT_NAMES = Object.freeze(['dev', 'prod'])
export const BACKUP_KEEP = 3
export const BACKUP_CAP_BYTES = 1024 * 1024 * 1024
export const DATA_CAP_BYTES = 1024 * 1024 * 1024
export const FREE_FACTOR = 2
export const RELEASES_KEEP = 50
export const COMMIT_RE = /^[0-9a-f]{40}$/

export const commit12 = (c) => String(c ?? '').slice(0, 12)
export const sockName = (slot, rev) => `w-${slot}-${rev}.sock`
export const newReleaseId = () => 'r-' + randomBytes(8).toString('hex')
/** The backup id: `<YYYYMMDDTHHMMSSZ>-rev<N>-<commit12>` (ISO 8601 basic, 34 chars — one directory name, sortable, no quoting). */
export const backupId = (atMs, rev, commit) => `${new Date(atMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-rev${rev ?? 0}-${commit12(commit) || 'none'}`
export const BACKUP_ID_RE = /^\d{8}T\d{6}Z-rev\d+-(?:[0-9a-f]{1,12}|none)$/
export function parseBackupId(id) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-rev(\d+)-([0-9a-f]{1,12}|none)$/.exec(String(id))
  if (!m) return null
  const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  return Number.isFinite(at) ? { at, rev: Number(m[7]), commit: m[8] === 'none' ? null : m[8] } : null
}

/** The relative rows under the dirfd (`os.at(dirfd, rel)` forms them into paths). */
export const REL = Object.freeze({
  prodData: (inst) => `data/${inst}`,
  devData: (inst) => `data-dev/${inst}`,
  prodRoot: (inst) => `prod/${inst}`,
  prodExport: (inst, commit) => `prod/${inst}/${commit12(commit)}`,
  rehearsalRoot: (inst) => `rehearsal/${inst}`,
  rehearsalData: (inst) => `rehearsal/${inst}/data`,
  backupRoot: (inst) => `backup/${inst}`,
  backup: (inst, id) => `backup/${inst}/${id}`,
})

/** mkSlot(name, {appDir, dataDir}) — the per-slot state the supervisor and serve.mjs drive (D3). */
export function mkSlot(name, { appDir, dataDir, rev = null, commit = null, legacy = false }) {
  return {
    name, rev, live: null, state: rev != null ? 'stopped' : 'loading', appDir, dataDir, commit, legacy,
    resources: null, suspendable: false, lastServedAt: 0, inflight: 0, idleTimer: null, restarts: 0, resuming: null,
    retiring: new Set(), kept: [], gate: null, down: null, configAt: null,
  }
}

/** deferred() → {promise, resolve} — the gate (D9) is one of these; `resolve()` releases every waiting request. */
export function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

// --- root + group 19999 process specs (the adapter wraps them in setpriv --groups=19999; unprivileged ignores) ---
const ROOT_G = { uid: 0, gid: 0, groups: [AGENT_DATA_GID], umask: 0o022, cwd: '/', stdio: ['ignore', 'pipe', 'pipe'] }
const envOf = (hostEnv) => ({ PATH: hostEnv.PATH ?? '/usr/bin:/bin' })
/**
 * The data copy — the contents of src into an existing dst. On Linux (GNU cp, the fleet): ownership, timestamps and
 * links preserved (root has CAP_CHOWN), modes NOT — cp chowns each copied inode to `<uid>` and then chmods it, and
 * userns-root has no CAP_FOWNER (`preserving permissions … Operation not permitted`, the row-9 drill); umask 007
 * gives files 0660 and dirs 0770 (the setgid bit is inherited from the 2770 parent) — DESIGN §3's data shape.
 * Elsewhere (a laptop, BSD cp) `cp -a` as the developer.
 */
export const cpSpec = (src, dst, hostEnv = process.env, { gnu = process.platform === 'linux' } = {}) => (gnu
  ? { ...ROOT_G, umask: 0o007, argv: ['cp', '-dR', '--preserve=ownership,timestamps,links', '--', `${String(src).replace(/\/+$/, '')}/.`, dst], env: envOf(hostEnv) }
  : { ...ROOT_G, argv: ['cp', '-a', '--', `${String(src).replace(/\/+$/, '')}/.`, dst], env: envOf(hostEnv) })
/** `rm -rf <dir>` — a data dir or a rehearsal copy; root enters the `2770` dir through group 19999. */
export const rmSpec = (dir, hostEnv = process.env) => ({ ...ROOT_G, argv: ['rm', '-rf', '--', dir], env: envOf(hostEnv) })
/** `du -sk <dir>` → KiB on stdout. */
export const duSpec = (dir, hostEnv = process.env) => ({ ...ROOT_G, argv: ['du', '-s', '-k', '--', dir], env: envOf(hostEnv) })
/** `find <dir> -mindepth 1 -maxdepth 1 -print -quit` → one line when the dir has an entry, nothing when empty (root cannot readdir a 2770 data dir itself). */
export const lsSpec = (dir, hostEnv = process.env) => ({ ...ROOT_G, argv: ['find', dir, '-mindepth', '1', '-maxdepth', '1', '-print', '-quit'], env: envOf(hostEnv) })
/** Row T: `tar -x -C <dest> -f -` as root, stdin = row A's stdout (git archive as uid 1000). */
export const extractSpec = (dest, hostEnv = process.env) => ({ argv: ['tar', '-x', '-C', dest, '-f', '-'], env: envOf(hostEnv), cwd: '/', uid: 0, gid: 0, groups: [], umask: 0o077, stdio: ['pipe', 'pipe', 'pipe'] })

export const parseKb = (s) => { const m = /^\s*(\d+)/.exec(String(s ?? '')); return m ? Number(m[1]) : null }

/**
 * ownTree(os, fs, root, uid) — the export's ownership pass (D1/D2): every inode tar created is root's, so each is
 * chmod'ed first (dirs 0750, files 0640 — never a chmod on a foreign inode) then chowned `0:<uid>`; symlinks are
 * lchowned only. Returns the count of inodes.
 */
export function ownTree(os, fs, root, uid) {
  let n = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isSymbolicLink()) { os.lchown(p, 0, uid); n++; continue }
      if (e.isDirectory()) { walk(p); os.chmod(p, 0o750); os.chown(p, 0, uid); n++; continue }
      os.chmod(p, 0o640); os.chown(p, 0, uid); n++
    }
  }
  walk(root)
  os.chmod(root, 0o750); os.chown(root, 0, uid)
  return n + 1
}

/**
 * pruneBackups(rows, {keep, capBytes}) → the ids to delete (D11): rows = [{id, at, bytes}]; the newest `keep` stay
 * unless the total passes the cap, then the oldest go first — the newest one is always kept.
 */
export function pruneBackups(rows, { keep = BACKUP_KEEP, capBytes = BACKUP_CAP_BYTES } = {}) {
  const sorted = [...rows].sort((a, b) => b.at - a.at)   // newest first
  const drop = new Set(sorted.slice(keep).map((r) => r.id))
  let total = sorted.filter((r) => !drop.has(r.id)).reduce((s, r) => s + (r.bytes ?? 0), 0)
  for (let i = sorted.length - 1; i > 0 && total > capBytes; i--) {
    const r = sorted[i]
    if (drop.has(r.id)) continue
    drop.add(r.id); total -= r.bytes ?? 0
  }
  return [...drop]
}

/** backupFeasible({dataBytes, freeBytes}) → null | the refusal text (D11): data > 1 GiB or free < 2× its size. */
export function backupFeasible({ dataBytes, freeBytes }, { capBytes = DATA_CAP_BYTES, factor = FREE_FACTOR } = {}) {
  if (dataBytes > capBytes) return `prod data is ${mb(dataBytes)} MB (> ${Math.round(capBytes / 1024 / 1024)} MB cap)`
  if (freeBytes != null && freeBytes < factor * dataBytes) return `free space ${mb(freeBytes)} MB < ${factor}× the data (${mb(dataBytes)} MB)`
  return null
}
export const mb = (bytes) => Math.round((bytes ?? 0) / 1024 / 1024 * 10) / 10
