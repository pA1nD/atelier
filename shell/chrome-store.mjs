// shell/chrome-store.mjs — the chrome releases the shell serves by digest (step 7 ship C, R-CHROME;
// LANES-CHROME decisions 2 and 4). The spine writes each release content-addressed on the shared
// artifacts volume — `<root>/<digest>/{frontend.js, kit.js, styles.css, chrome.css, fonts/*.woff2}` +
// `manifest.json` LAST (temp + rename) — and the shell reads it off its read-only mount with no proxy
// hop, at `/_chrome/<digest>/<path>` on every company origin (routes.mjs lane 4a). A digest is a
// bundle when its manifest is there; a path is served only when the manifest names it, and its bytes
// are checked ONCE against the manifest's sha (a corrupted volume would otherwise serve garbage under
// an immutable cache-control for a year). Bytes and manifests are cached per digest; the map is bounded
// (oldest digest dropped) so a churn of releases cannot grow a replica.
//
//   createChromeStore({root, fs, max}) → { root, has(digest), manifest(digest), open(digest, path), type(path), close() }
//     manifest(digest) → {digest, version?, files:{path:{sha256, bytes}}} | null     (null: unknown digest, no/bad manifest)
//     open(digest, path) → Buffer | null                                             (null: unknown digest or a path the manifest does not name)
import nodeFs from 'node:fs'
import path from 'node:path'
import { DIGEST_RE, validChromePath, sha256Hex } from '../protocol/index.js'

export const CHROME_TYPES = {
  js: 'application/javascript; charset=utf-8', mjs: 'application/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8', woff2: 'font/woff2', woff: 'font/woff',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8', html: 'text/html; charset=utf-8', wasm: 'application/wasm',
}
export const CHROME_CACHE_CONTROL = 'public, max-age=31536000, immutable'
export const chromeType = (p) => CHROME_TYPES[path.posix.extname(String(p)).slice(1).toLowerCase()] ?? 'application/octet-stream'

export function createChromeStore({ root, fs = nodeFs, max = 8, log = () => {} }) {
  if (!root) throw new Error('createChromeStore: root is required')
  const entries = new Map()   // digest → { manifest, files: Map<path, Buffer> }
  const remember = (digest, e) => { entries.delete(digest); entries.set(digest, e); while (entries.size > max) entries.delete(entries.keys().next().value) }
  const dirOf = (digest) => path.join(root, digest)

  function readManifest(digest) {
    let raw
    try { raw = fs.readFileSync(path.join(dirOf(digest), 'manifest.json'), 'utf8') } catch { return null }
    let m
    try { m = JSON.parse(raw) } catch { log(`chrome-store: ${digest.slice(0, 12)}… manifest.json is not JSON`); return null }
    if (!m || typeof m !== 'object' || !m.files || typeof m.files !== 'object' || Array.isArray(m.files)) { log(`chrome-store: ${digest.slice(0, 12)}… manifest.json has no files`); return null }
    if (m.digest !== undefined && m.digest !== digest) { log(`chrome-store: ${digest.slice(0, 12)}… manifest names another digest (${String(m.digest).slice(0, 12)}…)`); return null }
    const files = {}
    for (const [p, f] of Object.entries(m.files)) {
      if (!validChromePath(p)) { log(`chrome-store: ${digest.slice(0, 12)}… manifest names a bad path (${p})`); return null }
      files[p] = { sha256: typeof f?.sha256 === 'string' ? f.sha256 : null, bytes: Number.isInteger(f?.bytes) ? f.bytes : null }
    }
    return { digest, ...(typeof m.version === 'string' ? { version: m.version } : {}), files }
  }

  return {
    root,
    has(digest) { return this.manifest(digest) !== null },
    manifest(digest) {
      if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) return null
      const hit = entries.get(digest)
      if (hit) return hit.manifest
      const manifest = readManifest(digest)
      if (!manifest) return null           // a 404 is never cached: the bundle may land on the volume a moment later
      remember(digest, { manifest, files: new Map() })
      return manifest
    },
    open(digest, p) {
      const manifest = this.manifest(digest)
      if (!manifest) return null
      const want = manifest.files[p]
      if (!want) return null
      const e = entries.get(digest)
      const cached = e.files.get(p)
      if (cached) return cached
      let body
      try { body = fs.readFileSync(path.join(dirOf(digest), p)) } catch { return null }
      if (want.sha256 && sha256Hex(body) !== want.sha256) { log(`chrome-store: ${digest.slice(0, 12)}…/${p} does not match its manifest sha — refused`); return null }
      e.files.set(p, body)
      return body
    },
    type: chromeType,
    close() { entries.clear() },
  }
}
