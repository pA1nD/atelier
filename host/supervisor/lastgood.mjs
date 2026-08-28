// host/supervisor/lastgood.mjs — the last-good revision store (PLAN §4.3 "Last-good", DESIGN §3, §6.1).
//
// Layout under the `.atelier` dirfd (every path is `os.at(dirfd, rel)` — never re-resolved by name):
//   <inst>/revision.json   {rev, live, sha256, bytes, builtAt, host, chrome, protocol, fingerprint, slug}
//                          `rev` = the counter (bumped on LIVE and FAILED alike, persisted BEFORE the
//                          worker starts); `live` = the rev `current` names; `fingerprint` = the
//                          watcher fingerprint of the source the live rev was built from.
//   <inst>/current         symlink → ../last-good/<inst>/rev-N, swapped by rename
//   <inst>/slug, uid, registered.json   markers (0644 / 0600), written by the supervisor/registrar
//   last-good/<inst>/rev-N/{backend.js, backend.js.map, frontend/<rel>.js, styles.css}
//                          written to rev-N.tmp-<pid>, every file fsynced, the dir renamed into
//                          place, `0:<uid> 0750` dirs / 0640 files (the host's own inodes: chmod
//                          THEN chown, both through the adapter; never a chmod on a foreign inode).
// The checksum (sha256 over the artefacts in a fixed order) stamps revision.json; a snapshot survives
// a broken folder and a host restart. Old rev dirs are removed by `remove()` (the supervisor's
// 10-minute window). `commitGit` = row G: one `git commit` per LIVE rev as uid 1000, never fatal.
import nodeFs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { PROTOCOL } from '../../protocol/index.js'

export const INSTANCE_RE = /^i-[0-9a-f]{16}$/   // hygiene.mjs INSTANCE_RE (launcher lane) — same shape
export const DIR_MODE = 0o750, FILE_MODE = 0o640

const ignoreEexist = (fn) => { try { fn() } catch (e) { if (e.code !== 'EEXIST') throw e } }

export function createStore({ os, dirfd, fs = nodeFs, log = () => {}, hostVersion = '2.0.0' }) {
  const at = (rel) => os.at(dirfd, rel)
  const markerDir = (inst) => at(inst)
  const lastGood = (inst) => at(`last-good/${inst}`)
  const revDir = (inst, rev) => path.join(lastGood(inst), `rev-${rev}`)
  const fsyncFile = (p, data) => {
    const fd = fs.openSync(p, 'w', 0o600)
    try { fs.writeSync(fd, data); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  }
  const fsyncDir = (p) => { let fd; try { fd = fs.openSync(p, 'r'); fs.fsyncSync(fd) } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd) } catch {} } }
  const own = (p, mode, uid) => { os.chmod(p, mode); os.chown(p, 0, uid) }
  const mkdirOwned = (p, uid) => { fs.mkdirSync(p, { mode: DIR_MODE }); own(p, DIR_MODE, uid) }
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
  const writeJsonAtomic = (p, obj, mode) => {
    const tmp = `${p}.tmp-${process.pid}`
    fsyncFile(tmp, JSON.stringify(obj, null, 1))
    os.chmod(tmp, mode)
    fs.renameSync(tmp, p)
  }

  const store = {
    revDir, lastGood, markerDir,

    // ensure(inst, uid) — the marker dir (0:0 0711) and last-good/<inst> (0:<uid> 0750); EEXIST is fine.
    ensure(inst, uid) {
      ignoreEexist(() => { fs.mkdirSync(markerDir(inst), { mode: 0o711 }); os.chmod(markerDir(inst), 0o711) })
      ignoreEexist(() => mkdirOwned(lastGood(inst), uid))
    },
    writeMarker(inst, name, text, mode = 0o644) {
      const p = path.join(markerDir(inst), name)
      fsyncFile(p, String(text)); os.chmod(p, mode)
    },
    readMarker(inst, name) { try { return fs.readFileSync(path.join(markerDir(inst), name), 'utf8') } catch { return null } },
    revision(inst) { return readJson(path.join(markerDir(inst), 'revision.json')) },

    // nextRev(inst) → the new counter, persisted before anything else of the build happens.
    nextRev(inst) {
      const cur = store.revision(inst) ?? {}
      const rev = (cur.rev ?? cur.live ?? 0) + 1
      writeJsonAtomic(path.join(markerDir(inst), 'revision.json'), { ...cur, rev }, 0o644)
      return rev
    },

    // write(inst, rev, uid, {backend, map, frontend:Map<rel,code>, css}) → {dir, sha256, bytes}
    write(inst, rev, uid, { backend = null, map = null, frontend = new Map(), css = '' }) {
      const final = revDir(inst, rev), tmp = `${final}.tmp-${process.pid}`
      fs.rmSync(tmp, { recursive: true, force: true })
      mkdirOwned(tmp, uid)
      const hash = createHash('sha256')
      let bytes = 0
      const put = (rel, data) => {
        const p = path.join(tmp, rel)
        const dir = path.dirname(p)
        if (dir !== tmp && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE })
        fsyncFile(p, data); own(p, FILE_MODE, uid)
        hash.update(rel).update('\0').update(data).update('\0'); bytes += Buffer.byteLength(data)
      }
      if (backend !== null) put('backend.js', backend)
      if (map !== null) put('backend.js.map', map)
      for (const rel of [...frontend.keys()].sort()) put(path.join('frontend', rel), frontend.get(rel))
      put('styles.css', css)
      for (const d of walkDirs(tmp)) own(d, DIR_MODE, uid)
      fsyncDir(tmp)
      fs.rmSync(final, { recursive: true, force: true })
      fs.renameSync(tmp, final)
      fsyncDir(lastGood(inst))
      return { dir: final, sha256: hash.digest('hex'), bytes }
    },

    // commit(inst, rev, meta) — revision.json + the `current` symlink, both atomic (write-then-rename).
    commit(inst, rev, { slug, sha256, bytes, fingerprint = null, chrome = null }) {
      const cur = store.revision(inst) ?? {}
      writeJsonAtomic(path.join(markerDir(inst), 'revision.json'), {
        rev: Math.max(cur.rev ?? 0, rev), live: rev, sha256, bytes, builtAt: new Date(os.now()).toISOString(),
        host: hostVersion, chrome, protocol: PROTOCOL, fingerprint, slug,
      }, 0o644)
      const link = path.join(markerDir(inst), 'current'), tmp = path.join(markerDir(inst), `.current-tmp-${process.pid}`)
      fs.rmSync(tmp, { force: true })
      fs.symlinkSync(`../last-good/${inst}/rev-${rev}`, tmp)
      fs.renameSync(tmp, link)
      fsyncDir(markerDir(inst))
    },
    current(inst) {
      let target
      try { target = fs.readlinkSync(path.join(markerDir(inst), 'current')) } catch { return null }
      const m = /rev-(\d+)$/.exec(target)
      if (!m) return null
      const rev = Number(m[1])
      return fs.existsSync(revDir(inst, rev)) ? { rev, dir: revDir(inst, rev) } : null
    },
    list(inst) {
      let ents
      try { ents = fs.readdirSync(lastGood(inst)) } catch { return [] }
      return ents.map((n) => /^rev-(\d+)$/.exec(n)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b)
    },
    remove(inst, rev) {
      fs.rmSync(revDir(inst, rev), { recursive: true, force: true })
      fs.rmSync(`${revDir(inst, rev)}.tmp-${process.pid}`, { recursive: true, force: true })
    },
    read(inst, rev, rel) {
      const base = revDir(inst, rev), p = path.resolve(base, rel)
      if (!p.startsWith(base + path.sep)) return null
      try { return fs.readFileSync(p) } catch { return null }
    },
    // instances() — every last-good/<inst> dir (boot input; the folder is never read).
    instances() {
      let ents
      try { ents = fs.readdirSync(at('last-good')) } catch { return [] }
      return ents.filter((n) => INSTANCE_RE.test(n)).sort()
    },
  }
  function walkDirs(root) {
    const out = []
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) { const p = path.join(d, e.name); out.push(p); walk(p) } }
    walk(root)
    return out
  }
  return store
}

// commitGit({os, appDir, rev, log}) → Promise<{ok, step?, code?}> — row G, never throws.
export const GIT_ENV = { HOME: '/work', GIT_AUTHOR_NAME: 'atelier', GIT_AUTHOR_EMAIL: 'atelier@local', GIT_COMMITTER_NAME: 'atelier', GIT_COMMITTER_EMAIL: 'atelier@local' }
export function gitSpec({ appDir, args, home = GIT_ENV.HOME }) {
  return { argv: ['git', '-C', appDir, ...args], uid: 1000, gid: 1000, groups: [], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...GIT_ENV, HOME: home }, umask: 0o022, cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] }
}
export async function commitGit({ os, appDir, rev, log = () => {}, home }) {
  const run = (args) => new Promise((resolve) => {
    let child
    try { child = os.spawn(gitSpec({ appDir, args, home })) } catch (e) { return resolve({ code: -1, err: e.message }) }
    let err = ''
    child.stdout?.on?.('data', (d) => { err += d })
    child.stderr?.on?.('data', (d) => { err += d })
    child.on('error', (e) => resolve({ code: -1, err: e.message }))
    child.on('exit', (code) => resolve({ code, err }))
  })
  for (const [step, args] of [['init', ['init', '-q']], ['add', ['add', '-A', '.']], ['commit', ['commit', '-qm', `rev ${rev}`]]]) {
    const r = await run(args)
    if (r.code !== 0) {
      if (step === 'commit' && /nothing to commit/.test(r.err)) return { ok: true, noop: true }
      log(`git ${step} in ${appDir}: rc=${r.code} ${String(r.err).trim().split('\n')[0]}`)
      return { ok: false, step, code: r.code }
    }
  }
  return { ok: true }
}
