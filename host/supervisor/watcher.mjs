// host/supervisor/watcher.mjs — the exclusion-list watcher (PLAN §4.3 "Supervisor", DESIGN §6.1).
//
// Shape: one NON-recursive `fs.watch` per non-excluded directory of the app folder, registered
// by walking the tree with the exclusion list applied at registration time (g8: node's recursive
// watch registers one inotify watch per directory INCLUDING node_modules — 18 299 for 5 corpus
// apps — while excluding at registration holds ≤ 2 k). New directories are registered when
// their parent fires; vanished ones are closed after the next walk.
//
// Every event only marks the folder dirty; the quiescence loop is a full rescan: two
// fingerprints (path+size+mtime of the non-excluded set) taken `quiesceMs` apart must be
// identical before `onChange(fp)` fires — so a burst past the inotify queue (one overflow event,
// the rest lost) is still built once the folder is quiet, and a `watch error` re-registers.
//
// Exclusion list (exact): `node_modules/`, `data/`, `.atelier`, dotfiles, `_*`, `package.json`,
// `package-lock.json`, `CLAIM-REFUSED.txt`. Heal rule: while `isBroken()` (the app is in a
// load-error state) `node_modules`/lockfile events pass through as changes. `package.json` /
// `package-lock.json` at the app root → `onInstall()` (the supervisor runs installDeps and, on
// success, a rebuild).
import nodeFs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const EXCLUDED_FILES = ['package.json', 'package-lock.json', 'CLAIM-REFUSED.txt']
export const INSTALL_FILES = ['package.json', 'package-lock.json']
export const excludedSegment = (s) => s === 'node_modules' || s === 'data' || s.startsWith('.') || s.startsWith('_')

// excluded(rel) — rel = path relative to the app folder ('' = the folder itself)
export function excluded(rel) {
  if (!rel) return false
  const segs = rel.split(path.sep)
  if (segs.some(excludedSegment)) return true
  return EXCLUDED_FILES.includes(segs[segs.length - 1])
}

// fingerprint(dir, fs) → {hash, files, dirs:[abs]} over the non-excluded set; `hash` is null when the
// folder is missing. Sorted, so two walks of an unchanged tree give the same hash.
export function fingerprint(dir, fs = nodeFs) {
  const rows = [], dirs = []
  const walk = (d, rel) => {
    let ents
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return false }
    dirs.push(d)
    for (const ent of ents) {
      const r = rel ? rel + path.sep + ent.name : ent.name
      if (excluded(r)) continue
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) { walk(p, r); continue }
      if (!ent.isFile()) continue
      try { const st = fs.statSync(p); rows.push(`${r}:${st.size}:${st.mtimeMs}`) } catch {}
    }
    return true
  }
  if (!walk(dir, '')) return { hash: null, files: 0, dirs: [] }
  rows.sort()
  return { hash: createHash('sha1').update(rows.join('\n')).digest('hex'), files: rows.length, dirs }
}

/**
 * createWatcher({dir, fs, quiesceMs, onChange, onInstall, onGone, isBroken, log})
 *   .start() → the initial fingerprint   .stop()   .watchCount()   .touch() (schedule a rescan)
 *   .settled → the last fingerprint reported or seen at start
 * onChange(fp) fires once per quiet change (fp !== settled); onInstall() once per quiet
 * package.json/lockfile change; onGone() when the folder itself is missing after a change.
 */
export function createWatcher({ dir, fs = nodeFs, quiesceMs = 100, onChange = () => {}, onInstall = () => {}, onGone = () => {}, isBroken = () => false, log = () => {} }) {
  const watches = new Map()   // abs dir → FSWatcher
  let dirty = false, installDirty = false, heal = false, loop = null, stopped = false
  const w = { settled: null }

  const onEvent = (base) => (ev, filename) => {
    if (stopped) return
    const abs = filename ? path.join(base, String(filename)) : base
    const rel = path.relative(dir, abs)
    if (rel.startsWith('..')) return
    if (excluded(rel)) {
      const segs = rel.split(path.sep)
      const installFile = segs.length === 1 && INSTALL_FILES.includes(segs[0])
      if (installFile) installDirty = true
      // heal rule: an install's visible signals (the root `node_modules` entry, the root lockfile /
      // package.json — deeper node_modules writes are not watched) rebuild a broken app
      if (isBroken() && (segs[0] === 'node_modules' || installFile)) { dirty = true; heal = true }
      if (installDirty || heal) schedule()
      return
    }
    dirty = true
    schedule()
  }
  const register = (d) => {
    if (watches.has(d)) return
    try {
      const fw = fs.watch(d, { persistent: false }, onEvent(d))
      fw.on('error', (e) => { log(`watch error ${d}: ${e.code ?? e.message}`); watches.delete(d); try { fw.close() } catch {}; dirty = true; schedule() })
      watches.set(d, fw)
    } catch (e) { log(`watch failed ${d}: ${e.code ?? e.message}`) }
  }
  const reconcile = (dirs) => {
    const live = new Set(dirs)
    for (const [d, fw] of watches) if (!live.has(d)) { try { fw.close() } catch {}; watches.delete(d) }
    for (const d of dirs) register(d)
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const schedule = () => { if (!loop) loop = quiesce().catch((e) => log(`watcher loop: ${e.message}`)).finally(() => { loop = null; if (!stopped && (dirty || installDirty)) schedule() }) }
  async function quiesce() {
    let a = fingerprint(dir, fs)
    for (;;) {
      dirty = false
      await sleep(quiesceMs)
      if (stopped) return
      const b = fingerprint(dir, fs)
      if (a.hash === b.hash && !dirty) { a = b; break }
      a = b
    }
    const install = installDirty; installDirty = false
    if (a.hash === null) { reconcile([]); onGone(); return }
    reconcile(a.dirs)
    if (install) onInstall()
    const healing = heal; heal = false
    if (a.hash !== w.settled || healing) { w.settled = a.hash; onChange(a.hash) }
  }

  w.start = () => { const fp = fingerprint(dir, fs); w.settled = fp.hash; reconcile(fp.dirs); return fp }
  w.stop = () => { stopped = true; for (const fw of watches.values()) { try { fw.close() } catch {} } watches.clear() }
  w.watchCount = () => watches.size
  w.touch = () => { dirty = true; schedule() }
  w.fingerprint = () => fingerprint(dir, fs)
  return w
}
