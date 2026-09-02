// host/supervisor/lastgood.mjs — the last-good revision store (PLAN §4.3 "Last-good", DESIGN §3, §6.1).
//
// Layout under the `.atelier` dirfd (every path is `os.at(dirfd, rel)` — never re-resolved by name):
//   <inst>/revision.json   {rev, live, sha256, bytes, builtAt, host, chrome, protocol, fingerprint, slug, prod:{…, chrome?}}
//                          `rev` = the counter (bumped by dev and prod builds alike, LIVE and FAILED,
//                          persisted BEFORE the worker starts); `live` = the DEV rev `current-dev`
//                          names; `fingerprint` = the watcher fingerprint of the source the dev rev was
//                          built from; `prod` = {rev, commit, deployedAt, message, legacy?, down?, releasing?}
//                          — the PROD slot (DESIGN §10.3 D4): `commit` is the deployed git sha, `legacy`
//                          marks a row adopted from the pre-release layout (served from the app folder);
//                          `down` = {step, error, backup, commit, rev, at} the DOWN marker of a failed
//                          release (D10 — on disk, so a host restart keeps the app down); `releasing` =
//                          {id, commit, rev, backup, at} while a migration runs on prod data (a host that
//                          dies inside that window boots the app DOWN, never the old rev over migrated data).
//   <inst>/current         symlink → ../last-good/<inst>/rev-N — the PROD rev (what boot() resumes and
//                          `?rev=` addresses); swapped by rename
//   <inst>/current-dev     symlink → ../last-good/<inst>/rev-N — the DEV rev (the dev shell's)
//   <inst>/slug, uid, registered.json   markers (0600 — the host's alone), written by the supervisor/registrar
//   last-good/<inst>/rev-N/{backend.js, backend.js.map, frontend/<rel>.js, styles.css}
//                          written to rev-N.tmp-<pid>, every file fsynced, the dir renamed into
//                          place, `0:<uid> 0750` dirs / 0640 files (the host's own inodes: chmod
//                          THEN chown, both through the adapter; never a chmod on a foreign inode).
// The checksum (sha256 over the artefacts in a fixed order) stamps revision.json; a snapshot survives
// a broken folder and a host restart. Old rev dirs are removed by `remove()` (the supervisor's
// 10-minute window). The git helpers at the bottom run as uid 1000 (row G): `gitInit` at claim/adopt,
// `commitAll` + `resolveCommit` + `archiveSpec` for the deploy (supervisor/deploy.mjs).
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
    writeMarker(inst, name, text, mode = 0o600) {
      const p = path.join(markerDir(inst), name)
      fsyncFile(p, String(text)); os.chmod(p, mode)
    },
    readMarker(inst, name) { try { return fs.readFileSync(path.join(markerDir(inst), name), 'utf8') } catch { return null } },
    revision(inst) { return readJson(path.join(markerDir(inst), 'revision.json')) },

    // nextRev(inst) → the new counter, persisted before anything else of the build happens.
    nextRev(inst) {
      const cur = store.revision(inst) ?? {}
      const rev = (cur.rev ?? cur.live ?? 0) + 1
      writeJsonAtomic(path.join(markerDir(inst), 'revision.json'), { ...cur, rev }, 0o600)
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

    // commit(inst, rev, meta) — the DEV build: revision.json (`live`, `fingerprint`, …) + the `current-dev`
    // symlink, both atomic (write-then-rename). The `prod` block and `current` are commitProd's.
    commit(inst, rev, { slug, sha256, bytes, fingerprint = null, chrome = null }) {
      const cur = store.revision(inst) ?? {}
      writeJsonAtomic(path.join(markerDir(inst), 'revision.json'), {
        ...cur, rev: Math.max(cur.rev ?? 0, rev), live: rev, sha256, bytes, builtAt: new Date(os.now()).toISOString(),
        host: hostVersion, chrome, protocol: PROTOCOL, fingerprint, slug,
      }, 0o600)
      link(inst, 'current-dev', rev)
    },
    // commitProd(inst, rev, prod) — the PROD release: `revision.json.prod = {rev, commit, deployedAt, message, legacy?,
    // chrome?}` + the `current` symlink. The counter is bumped to `rev` when a deploy minted it. `chrome` (step 7 ship C:
    // the chrome the PROD sheet was built with — a release digest, else the folder's name) stamps `prod.chrome` when
    // given; the top-level `chrome` stays the DEV build's (`commit`), so the two slots are told apart — an adopt or a
    // rollback names none, and a prod sheet of unknown chrome is rebuilt at the next beat (supervisor rebuildAll).
    commitProd(inst, rev, { commit, deployedAt = new Date(os.now()).toISOString(), message = null, legacy = false, chrome }) {
      const cur = store.revision(inst) ?? {}
      const prod = { rev, commit, deployedAt, message }
      if (legacy) prod.legacy = true
      if (chrome !== undefined) prod.chrome = chrome
      writeJsonAtomic(path.join(markerDir(inst), 'revision.json'), { ...cur, rev: Math.max(cur.rev ?? 0, rev), prod }, 0o600)
      link(inst, 'current', rev)
    },
    // prodPatch(inst, patch) — merges fields into the `prod` block (a key set to undefined is removed): the DOWN
    // marker and the in-flight release marker. commitProd writes a fresh block, so a green release clears both.
    prodPatch(inst, patch) {
      const cur = store.revision(inst) ?? {}
      const prod = { ...(cur.prod ?? {}), ...patch }
      for (const k of Object.keys(patch)) if (patch[k] === undefined) delete prod[k]
      writeJsonAtomic(path.join(markerDir(inst), 'revision.json'), { ...cur, prod }, 0o600)
    },
    // clone(inst, fromRev, toRev, uid, {css}) → {dir, sha256, bytes}: a NEW rev = rev-<from>'s artefacts (backend, map,
    // frontend/*) with `styles.css` replaced — the chrome swap's prod sheet rebuild (step 7 ship C): the same code the
    // worker runs, one new sheet, one new rev (the ETag is `rev-N`, so a sheet change is a rev change)
    clone(inst, fromRev, toRev, uid, { css }) {
      const from = revDir(inst, fromRev)
      const frontend = new Map()
      const fe = path.join(from, 'frontend')
      const walk = (d, rel) => { for (const ent of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${ent.name}` : ent.name; if (ent.isDirectory()) walk(path.join(d, ent.name), r); else if (ent.isFile()) frontend.set(r, fs.readFileSync(path.join(d, ent.name))) } }
      try { walk(fe, '') } catch (e) { if (e.code !== 'ENOENT') throw e }
      const readOr = (rel) => { try { return fs.readFileSync(path.join(from, rel)) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
      return store.write(inst, toRev, uid, { backend: readOr('backend.js'), map: readOr('backend.js.map'), frontend, css })
    },
    // link(inst, name, rev) — one pointer symlink, swapped by rename
    link: (inst, name, rev) => link(inst, name, rev),
    // current(inst) → {rev, dir} the PROD pointer; currentDev(inst) the DEV pointer; null when unset or pruned
    current(inst) { return pointer(inst, 'current') },
    currentDev(inst) { return pointer(inst, 'current-dev') },
    list(inst) {
      let ents
      try { ents = fs.readdirSync(lastGood(inst)) } catch { return [] }
      return ents.map((n) => /^rev-(\d+)$/.exec(n)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b)
    },
    remove(inst, rev) {
      fs.rmSync(revDir(inst, rev), { recursive: true, force: true })
      fs.rmSync(`${revDir(inst, rev)}.tmp-${process.pid}`, { recursive: true, force: true })
    },
    // sweepTmp(inst) → [names]: every `rev-N.tmp-<pid>` left by a host life that died mid-write (boot).
    sweepTmp(inst) {
      let ents
      try { ents = fs.readdirSync(lastGood(inst)) } catch { return [] }
      const gone = ents.filter((n) => /^rev-\d+\.tmp-\d+$/.test(n))
      for (const n of gone) fs.rmSync(path.join(lastGood(inst), n), { recursive: true, force: true })
      return gone
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
  function link(inst, name, rev) {
    const p = path.join(markerDir(inst), name), tmp = path.join(markerDir(inst), `.${name}-tmp-${process.pid}`)
    fs.rmSync(tmp, { force: true })
    fs.symlinkSync(`../last-good/${inst}/rev-${rev}`, tmp)
    fs.renameSync(tmp, p)
    fsyncDir(markerDir(inst))
  }
  function pointer(inst, name) {
    let target
    try { target = fs.readlinkSync(path.join(markerDir(inst), name)) } catch { return null }
    const m = /rev-(\d+)$/.exec(target)
    if (!m) return null
    const rev = Number(m[1])
    return fs.existsSync(revDir(inst, rev)) ? { rev, dir: revDir(inst, rev) } : null
  }
  function walkDirs(root) {
    const out = []
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) { const p = path.join(d, e.name); out.push(p); walk(p) } }
    walk(root)
    return out
  }
  return store
}

// Git as uid 1000 (row G env, cleared groups, umask 022) — DESIGN §2.2 row G, §10.3 D7. Never throws.
//   gitInit({os, appDir})          `git init -q` (a no-op on a repo) + `.gitignore` written `wx` (noclobber: the
//                                  agent's own file is never overwritten) — once at claim and at adopt.
//   commitAll({os, appDir, message}) `git add -A && git commit -m <message>` → {ok, commit} — `nothing to commit`
//                                  → ok with the HEAD; the deploy's step 1.
//   resolveCommit({os, appDir, ref}) → {ok, commit} the full sha of a ref/abbrev (the rollback's argument).
// The per-LIVE-rev auto-commit is retired: history = releases; Bayard may commit himself.
export const GIT_ENV = { HOME: '/work', GIT_AUTHOR_NAME: 'atelier', GIT_AUTHOR_EMAIL: 'atelier@local', GIT_COMMITTER_NAME: 'atelier', GIT_COMMITTER_EMAIL: 'atelier@local' }
export const GITIGNORE = ['data/', '.env', '.env.*', 'node_modules/', 'CLAIM-REFUSED.txt', '.atelier'].join('\n') + '\n'   // = deploy.mjs MESSAGES.git.gitignore
// cwd is `/`, never the app folder: node chdirs into `cwd` BEFORE the wrapper's uid drop, and userns-root without DAC
// caps cannot enter a `1000:<uid> 2750` folder (EACCES at spawn); `git -C <appDir>` enters it as uid 1000 itself.
export function gitSpec({ appDir, args, home = GIT_ENV.HOME, stdio = ['ignore', 'pipe', 'pipe'] }) {
  return { argv: ['git', '-C', appDir, ...args], uid: 1000, gid: 1000, groups: [], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...GIT_ENV, HOME: home }, umask: 0o022, cwd: '/', stdio }
}
/** The .gitignore write: uid 1000, `set -C` (O_EXCL) so an existing file — the agent's — stays. */
export function gitignoreSpec({ appDir, home }) {
  return { ...gitSpec({ appDir, args: [], home }), argv: ['sh', '-c', 'set -C; printf %s "$2" > "$1/.gitignore" 2>/dev/null || true', 'sh', appDir, GITIGNORE] }
}
/** Row A: `git archive --format=tar <commit>` as uid 1000, stdout = the tar stream (piped into row T). */
export function archiveSpec({ appDir, commit, home }) {
  return gitSpec({ appDir, args: ['archive', '--format=tar', commit], home })
}
export function runGit(os, spec) {
  return new Promise((resolve) => {
    let child
    try { child = os.spawn(spec) } catch (e) { return resolve({ code: -1, out: '', err: e.message }) }
    let out = '', err = ''
    child.stdout?.on?.('data', (d) => { out += d })
    child.stderr?.on?.('data', (d) => { err += d })
    child.on('error', (e) => resolve({ code: -1, out, err: e.message }))
    child.on('exit', (code) => resolve({ code, out, err }))
  })
}
const firstLine = (s) => String(s).trim().split('\n')[0]
export async function gitInit({ os, appDir, log = () => {}, home }) {
  for (const [step, spec] of [['init', gitSpec({ appDir, args: ['init', '-q'], home })], ['gitignore', gitignoreSpec({ appDir, home })]]) {
    const r = await runGit(os, spec)
    if (r.code !== 0) { log(`git ${step} in ${appDir}: rc=${r.code} ${firstLine(r.err)}`); return { ok: false, step, code: r.code, error: firstLine(r.err) } }
  }
  return { ok: true }
}
export async function commitAll({ os, appDir, message, log = () => {}, home }) {
  const add = await runGit(os, gitSpec({ appDir, args: ['add', '-A', '.'], home }))
  if (add.code !== 0) { log(`git add in ${appDir}: rc=${add.code} ${firstLine(add.err)}`); return { ok: false, step: 'add', error: firstLine(add.err) || `git add rc=${add.code}` } }
  const c = await runGit(os, gitSpec({ appDir, args: ['commit', '-q', '-m', message], home }))
  if (c.code !== 0 && !/nothing to commit|nothing added to commit|no changes added/.test(c.out + c.err)) {
    log(`git commit in ${appDir}: rc=${c.code} ${firstLine(c.err || c.out)}`)
    return { ok: false, step: 'commit', error: firstLine(c.err || c.out) || `git commit rc=${c.code}` }
  }
  const head = await resolveCommit({ os, appDir, ref: 'HEAD', home })
  if (!head.ok) return head
  return { ok: true, commit: head.commit, noop: c.code !== 0 }
}
export async function resolveCommit({ os, appDir, ref, home }) {
  if (typeof ref !== 'string' || !/^[0-9a-zA-Z_./-]{1,64}$/.test(ref) || ref.startsWith('-')) return { ok: false, step: 'rev-parse', error: `bad commit '${String(ref).slice(0, 40)}'` }
  const r = await runGit(os, gitSpec({ appDir, args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], home }))
  const sha = firstLine(r.out)
  if (r.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) return { ok: false, step: 'rev-parse', error: `unknown commit '${ref}'` }
  return { ok: true, commit: sha }
}
