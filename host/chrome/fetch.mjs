// host/chrome/fetch.mjs — the host's chrome cache (DESIGN §3 row `chrome`, §6.4, §7; step 7 ship C, R-CHROME
// decisions 7–8). The spine names the computer's EFFECTIVE chrome in every register and heartbeat answer
// (`chrome: {digest, version} | null`); the host fetches the bundle it does not hold (`GET /v1/host/chrome/<digest>`,
// the host bearer, JSON `{digest, version, files: {path: base64}}`), VERIFIES every sha and the recomputed digest,
// writes `/work/.atelier/chrome/<digest>/` (root; dirs 0755, files 0644 — the host alone reads it, §3) with
// `manifest.json` last, swaps the `current` symlink and prunes the cache to current + previous. A failed or refused
// fetch keeps `current` (the cached fallback) and is retried at the next beat; with no cache at all the host has no
// chrome dir, as before a release. Bounded: one fetch in flight, ≤ FETCH_MS.
//
//   ensureChrome({digest, transport, cache, fs, log, fetchMs, now}) → {dir, digest, fetched, error?}
//     dir/digest = what `current` points at AFTER the call (the wanted digest on success; the previous one, or null, on
//     a failure); fetched = the bytes were fetched and verified by this call
//   createChromeCache({cache, fixedDir, transport, fs, log, onSwap, onHold, onBuilt}) → { dir(), digest(), built(), base(), version(), want(answer), settle() }
//     dir(): the cache's `current` when it holds a bundle, else `fixedDir` (ATELIER_CHROME_DIR — local mode, the system
//     host's /opt/chrome while the spine names no release); digest(): the HELD digest (the sheets compile against it);
//     built(): the digest the heartbeat REPORTS — the last one `onSwap`/`onHold` settled complete, i.e. every prod sheet
//     is built against it (review 2026-09-02, S2: a report of D over a sheet built with PREV is impossible — a rebuild
//     that skips a row keeps reporting PREV, and the next beat retries); base(): `/_chrome/<digest>` when a digest is
//     held (the sheet build's url() base); want(answer): the register / heartbeat answer's `chrome` — serialized,
//     coalesced, never throws; onSwap(digest, prev) after a swap and onHold(digest, built) at every want naming the held
//     digest, both → `{complete}` (undefined/true = complete); onBuilt(digest, prev) once `built()` moves.
import nodeFs from 'node:fs'
import path from 'node:path'
import { DIGEST_RE, CHROME_REQUIRED_FILES, validChromePath, chromeDigestOf, sha256Hex } from '../../protocol/index.js'

export const CACHE_REL = 'chrome'
export const FETCH_MS = 15_000
export const DIR_MODE = 0o755
export const FILE_MODE = 0o644
export const CURRENT = 'current'
export const CHROME_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const TYPES = { js: 'application/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', woff2: 'font/woff2', woff: 'font/woff', svg: 'image/svg+xml', png: 'image/png' }
export const chromeType = (p) => TYPES[path.posix.extname(String(p)).slice(1).toLowerCase()] ?? 'application/octet-stream'

// verifyOnDisk(dir, digest, fs) → true when the bundle on disk IS the digest: a manifest naming every required file with
// a sha, every listed file hashing to its sha, the shas recomputing to `digest`. The cache is root's under a root 0711
// parent, but a disk is a disk (a torn write, a corruption, a previous host life): a bundle is never swapped to, and
// `current` is never adopted at boot, on the strength of its manifest alone (review 2026-09-02, Codex 2).
export function verifyOnDisk(dir, digest, fs = nodeFs) {
  let m
  try { m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) } catch { return false }
  if (!m || typeof m !== 'object' || !m.files || typeof m.files !== 'object' || Array.isArray(m.files)) return false
  if (m.digest !== undefined && m.digest !== digest) return false
  const shas = Object.create(null)
  for (const p of Object.keys(m.files)) {
    if (!validChromePath(p) || typeof m.files[p]?.sha256 !== 'string') return false
    let bytes
    try { bytes = fs.readFileSync(path.join(dir, p)) } catch { return false }
    shas[p] = sha256Hex(bytes)
    if (shas[p] !== m.files[p].sha256) return false
  }
  if (CHROME_REQUIRED_FILES.some((f) => !(f in shas))) return false
  return chromeDigestOf(shas) === digest
}

// currentOf(cache, fs) → {digest, dir} | null: the `current` link's target when it names a bundle that verifies (above)
export function currentOf(cache, fs = nodeFs) {
  let target
  try { target = fs.readlinkSync(path.join(cache, CURRENT)) } catch { return null }
  const digest = path.basename(target)
  if (!DIGEST_RE.test(digest)) return null
  const dir = path.join(cache, digest)
  if (!verifyOnDisk(dir, digest, fs)) return null
  return { digest, dir }
}

// verifyBundle(digest, answer) → {files: Map<path, Buffer>, shas, version} | {error}
export function verifyBundle(digest, answer) {
  if (!answer || typeof answer !== 'object' || !answer.files || typeof answer.files !== 'object' || Array.isArray(answer.files)) return { error: 'no files in the answer' }
  if (answer.digest !== undefined && answer.digest !== digest) return { error: `the answer names digest ${String(answer.digest).slice(0, 12)}…, asked for ${digest.slice(0, 12)}…` }
  const files = new Map(), shas = {}
  for (const [p, raw] of Object.entries(answer.files)) {
    if (!validChromePath(p)) return { error: `bad path ${p}` }
    if (typeof raw !== 'string') return { error: `${p} is not base64` }
    const bytes = Buffer.from(raw, 'base64')
    files.set(p, bytes); shas[p] = sha256Hex(bytes)
  }
  const missing = CHROME_REQUIRED_FILES.filter((f) => !files.has(f))
  if (missing.length) return { error: `bundle incomplete: missing ${missing.join(', ')}` }
  const computed = chromeDigestOf(shas)
  if (computed !== digest) return { error: `digest mismatch: the bytes hash to ${computed.slice(0, 12)}…, asked for ${digest.slice(0, 12)}…` }
  return { files, shas, version: typeof answer.version === 'string' ? answer.version : null }
}

// writeBundle(cache, digest, {files, shas, version}, fs): temp + rename, manifest last, explicit modes (the host runs
// under umask 077). A bundle already there is left alone: the same digest IS the same bytes.
export function writeBundle(cache, digest, { files, shas, version }, fs = nodeFs) {
  const final = path.join(cache, digest)
  try { if (fs.statSync(path.join(final, 'manifest.json')).isFile()) return false } catch {}
  const tmp = path.join(cache, `.tmp-${digest.slice(0, 8)}-${process.pid}`)
  fs.rmSync(tmp, { recursive: true, force: true })
  const mkdir = (d) => { fs.mkdirSync(d, { mode: DIR_MODE }); fs.chmodSync(d, DIR_MODE) }
  mkdir(tmp)
  try {
    const manifest = { digest, ...(version ? { version } : {}), files: {} }
    for (const p of [...files.keys()].sort()) {
      const file = path.join(tmp, p)
      const missing = []
      for (let d = path.dirname(file); d !== tmp && !fs.existsSync(d); d = path.dirname(d)) missing.unshift(d)
      for (const d of missing) mkdir(d)
      fs.writeFileSync(file, files.get(p), { mode: FILE_MODE }); fs.chmodSync(file, FILE_MODE)
      manifest.files[p] = { sha256: shas[p], bytes: files.get(p).length }
    }
    const mf = path.join(tmp, 'manifest.json')
    fs.writeFileSync(mf, JSON.stringify(manifest, null, 2) + '\n', { mode: FILE_MODE }); fs.chmodSync(mf, FILE_MODE)
    fs.renameSync(tmp, final)
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true })
    try { if (fs.statSync(path.join(final, 'manifest.json')).isFile()) return false } catch {}   // a concurrent write of the same digest won
    throw e
  }
  return true
}

// swapCurrent(cache, digest, fs): `current` → `<digest>` (relative), atomic through a temp link + rename
export function swapCurrent(cache, digest, fs = nodeFs) {
  const tmp = path.join(cache, `.${CURRENT}-tmp-${process.pid}`)
  fs.rmSync(tmp, { force: true })
  fs.symlinkSync(digest, tmp)
  fs.renameSync(tmp, path.join(cache, CURRENT))
}

// sweepTmp(cache, fs): the `.tmp-*` leftovers of a host life that died mid-write (boot)
export function sweepTmp(cache, fs = nodeFs) {
  let names = []
  try { names = fs.readdirSync(cache) } catch { return }
  for (const n of names) if (n.startsWith('.tmp-') || n.startsWith(`.${CURRENT}-tmp-`)) { try { fs.rmSync(path.join(cache, n), { recursive: true, force: true }) } catch {} }
}
// pruneChrome(cache, keep, fs) → [removed digests]: every bundle dir but `keep` (current + previous), plus `.tmp-*` leftovers
export function pruneChrome(cache, keep = [], fs = nodeFs) {
  let names = []
  try { names = fs.readdirSync(cache) } catch { return [] }
  const removed = []
  const keepSet = new Set(keep.filter(Boolean))
  for (const n of names) {
    if (n === CURRENT) continue
    const bundle = DIGEST_RE.test(n), tmp = n.startsWith('.tmp-') || n.startsWith(`.${CURRENT}-tmp-`)
    if (!bundle && !tmp) continue
    if (bundle && keepSet.has(n)) continue
    try { fs.rmSync(path.join(cache, n), { recursive: true, force: true }); if (bundle) removed.push(n) } catch {}
  }
  return removed
}

const withTimeout = (p, ms, what) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`${what}: no answer within ${ms} ms`)), ms); t.unref?.()
  Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
})

/**
 * ensureChrome({digest, transport, cache, fs, log, fetchMs}) → {dir, digest, fetched, error?}
 *   transport.chrome(digest) → Promise<{digest, version, files:{path: base64}}>  (the registrar's `chromeFetch`)
 */
export async function ensureChrome({ digest, transport, cache, fs = nodeFs, log = () => {}, fetchMs = FETCH_MS }) {
  const cur = currentOf(cache, fs)
  const held = (error) => ({ dir: cur?.dir ?? null, digest: cur?.digest ?? null, fetched: false, ...(error ? { error } : {}) })
  if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) return held(`not a digest: ${String(digest).slice(0, 24)}`)
  if (cur?.digest === digest) return { dir: cur.dir, digest, fetched: false }
  // EEXIST is not re-checked for its owner here: the cache lives under root's 0711 `.atelier`, and index.mjs `ensureDirs`
  // refused to boot on a cache dir root does not own — the fence is that parent, this mkdir is for a cache never made
  try { fs.mkdirSync(cache, { mode: DIR_MODE }); fs.chmodSync(cache, DIR_MODE) } catch (e) { if (e.code !== 'EEXIST') return held(`cache: ${e.code ?? e.message}`) }
  let fetched = false
  const dir = path.join(cache, digest)
  const present = (() => { try { return fs.statSync(path.join(dir, 'manifest.json')).isFile() } catch { return false } })()
  const have = present && verifyOnDisk(dir, digest, fs)
  if (present && !have) {   // a bundle dir that is not its digest (a torn write, a corruption): removed, fetched again — never swapped to
    log(`chrome: ${digest.slice(0, 12)}… on disk does not verify — removed, fetching again`)
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) { return held(`remove ${digest.slice(0, 12)}…: ${e.code ?? e.message}`) }
  }
  if (!have) {
    let answer
    try { answer = await withTimeout(transport.chrome(digest), fetchMs, `chrome ${digest.slice(0, 12)}…`) } catch (e) {
      const why = e?.status ? `spine ${e.status} ${e.body?.error ?? ''}`.trim() : (e?.message ?? String(e))
      log(`chrome: fetch ${digest.slice(0, 12)}… failed (${why}) — ${cur ? `keeping ${cur.digest.slice(0, 12)}…` : 'no chrome cached'}; retry at the next beat`)
      return held(why)
    }
    const v = verifyBundle(digest, answer)
    if (v.error) { log(`chrome: ${digest.slice(0, 12)}… REFUSED (${v.error}) — ${cur ? `keeping ${cur.digest.slice(0, 12)}…` : 'no chrome cached'}`); return held(v.error) }
    try { fetched = writeBundle(cache, digest, v, fs) } catch (e) { log(`chrome: write ${digest.slice(0, 12)}… failed (${e.code ?? e.message}) — ${cur ? `keeping ${cur.digest.slice(0, 12)}…` : 'no chrome cached'}`); return held(e.code ?? e.message) }
  }
  try { swapCurrent(cache, digest, fs) } catch (e) { log(`chrome: current → ${digest.slice(0, 12)}… failed (${e.code ?? e.message})`); return held(e.code ?? e.message) }
  const removed = pruneChrome(cache, [digest, cur?.digest], fs)
  log(`chrome: current → ${digest.slice(0, 12)}… (${fetched ? 'fetched' : 'cached'}${cur ? `, previous ${cur.digest.slice(0, 12)}… kept` : ''}${removed.length ? `, pruned ${removed.length}` : ''})`)
  return { dir: path.join(cache, digest), digest, fetched }
}

/**
 * createChromeCache({cache, fixedDir, transport, fs, log, onSwap, fetchMs})
 */
export function createChromeCache({ cache, fixedDir = null, transport, fs = nodeFs, log = () => {}, onSwap = () => {}, onHold = null, onBuilt = () => {}, fetchMs = FETCH_MS }) {
  sweepTmp(cache, fs)   // a `.tmp-*` a previous host life left mid-write; the bundles stay (current + previous) until the next swap prunes
  let cur = currentOf(cache, fs)
  let version = null
  let built = null      // reported: the last digest settled COMPLETE (null until the first settle of this host life — a boot
                        // with `current` on disk reports it after the first want, once every prod sheet is found built against it)
  let chain = Promise.resolve(), wanted = null, running = false
  const dir = () => cur?.dir ?? (fixedDir ? path.resolve(fixedDir) : null)
  // settle(hook, digest, prev): the hook's `{complete}` (undefined/true = complete) moves `built`; a throw is logged, never unhandled
  async function settle(hook, what, digest, prev) {
    let r
    try { r = await hook(digest, prev) } catch (e) { log(`chrome: after ${what} ${digest.slice(0, 12)}…: ${e?.stack ?? e}`); return }
    const complete = r === undefined || r === true || (r !== null && typeof r === 'object' && r.complete !== false)
    if (!complete || built === digest) return
    const was = built; built = digest
    try { await onBuilt(digest, was) } catch (e) { log(`chrome: built ${digest.slice(0, 12)}…: ${e?.stack ?? e}`) }
  }
  async function run() {
    running = true
    try {
      while (wanted) {
        const w = wanted; wanted = null
        if (w.digest === cur?.digest) { version = w.version ?? version; if (onHold) await settle(onHold, 'hold', w.digest, built); continue }
        const prev = cur?.digest ?? null
        const r = await ensureChrome({ digest: w.digest, transport, cache, fs, log, fetchMs })
        if (r.error || r.digest !== w.digest) continue
        cur = { digest: r.digest, dir: r.dir }; version = w.version ?? null
        await settle(onSwap, 'swap', r.digest, prev)
      }
    } finally { running = false }
  }
  const manifests = new Map()
  return {
    cache,
    dir, digest: () => cur?.digest ?? null, built: () => built, version: () => version, base: () => (cur ? `/_chrome/${cur.digest}` : null),
    // open(digest, p) → Buffer | null: a cached bundle's file, when its manifest names it (the dev shell's `/_chrome/<digest>/<p>`
    // lane — Bayard's browser resolves the sheet's `/_chrome/…` urls against the dev origin)
    open(digest, p) {
      if (!DIGEST_RE.test(String(digest)) || !validChromePath(p)) return null
      let m = manifests.get(digest)
      if (!m) { try { m = JSON.parse(fs.readFileSync(path.join(cache, digest, 'manifest.json'), 'utf8')) } catch { return null }; if (!m?.files || typeof m.files !== 'object') return null; manifests.set(digest, m) }
      if (!Object.hasOwn(m.files, p)) return null   // hasOwn: `constructor`/`__proto__` are URL segments too (N1)
      try { return fs.readFileSync(path.join(cache, digest, p)) } catch { return null }
    },
    // want(answer): the register/heartbeat answer's `chrome` — `{digest, version}` | null (no release yet: nothing to do)
    want(answer) {
      if (!answer || typeof answer !== 'object' || typeof answer.digest !== 'string' || !DIGEST_RE.test(answer.digest)) return
      wanted = { digest: answer.digest, version: typeof answer.version === 'string' ? answer.version : null }
      if (!running) chain = chain.then(run, run)
    },
    settle: () => chain,
  }
}
