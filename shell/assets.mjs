// shell/assets.mjs — `/assets/*`, the shell-owned bytes (DESIGN §2.2, §2.4 lane 4a, §4 build):
//   /assets/react.js, /assets/react-dom.js   the UMDs from node_modules — PRODUCTION builds when
//                                            cfg.nodeEnv === 'production' (the fleet always, the local default)
//   /assets/client.js                        esbuild over client/client.jsx (the fork; falls back to the
//                                            1.x client.jsx with a log line while the fork is absent),
//                                            bundled (its ./bridge.js, ./self.js, … and ./chrome-resolve.js
//                                            fold in), es2020, classic runtime, minified in production;
//                                            ETag = the sources' max mtime
//   /assets/chrome-resolve.js                client/chrome-resolve.js, else the 1.x root file as is
//   /assets/<name>.js                        any other plain module under client/ (bridge, self, route, sheet)
// Public bytes, no identity needed (the same for everyone); `cache-control: no-cache` + ETag, 304 on
// revalidation; gzip for text ≥ 1 KiB when accepted. The document template = client/index.html when
// it carries the five slots, else document.mjs's fallback.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build as esbuildBuild } from 'esbuild'
import { createHash } from 'node:crypto'
import { FALLBACK_TEMPLATE, hasSlots } from './document.mjs'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const GZIP_MIN = 1024
const JS = 'application/javascript; charset=utf-8'
const exists = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const mtimeOf = (p) => { try { return Math.floor(fs.statSync(p).mtimeMs) } catch { return 0 } }

export const gzipOk = (req) => /\bgzip\b/.test(String(req.headers?.['accept-encoding'] ?? ''))
export const textual = (type) => /^(text\/|application\/(javascript|json|xml))/.test(type)

// send(req, res, status, body, type, extra): the one small-asset response — ETag/304, gzip, HEAD
export function send(req, res, status, body, type, extra = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
  const headers = { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', ...extra }
  if (extra.etag && req.headers?.['if-none-match'] === extra.etag) { res.writeHead(304, { etag: extra.etag, 'cache-control': headers['cache-control'] }); return res.end() }
  if (gzipOk(req) && textual(type) && buf.length >= GZIP_MIN) { buf = zlib.gzipSync(buf); headers['content-encoding'] = 'gzip'; headers.vary = 'accept-encoding' }
  headers['content-length'] = buf.length
  res.writeHead(status, headers)
  res.end(req.method === 'HEAD' ? undefined : buf)
}

/**
 * createAssets({ repoRoot, clientDir, nodeEnv, log })
 *   → { handle(req, res, pathname) → Promise<boolean>, template(), clientJs(), close() }
 */
export function createAssets({ repoRoot = REPO_ROOT, clientDir = path.join(REPO_ROOT, 'client'), nodeEnv = 'production', log = () => {} } = {}) {
  const prod = nodeEnv === 'production'
  const req = createRequire(path.join(repoRoot, 'package.json'))
  const cache = new Map()
  let warnedFallback = false

  function vendor(name) {
    const [pkg, rel] = name === 'react' ? ['react', prod ? 'umd/react.production.min.js' : 'umd/react.development.js'] : ['react-dom', prod ? 'umd/react-dom.production.min.js' : 'umd/react-dom.development.js']
    let p; try { p = path.join(path.dirname(req.resolve(`${pkg}/package.json`)), rel) } catch { return null }
    if (!exists(p)) return null
    const mtime = mtimeOf(p)
    const hit = cache.get(p)
    if (hit && hit.mtime === mtime) return hit
    const e = withHash({ mtime, body: fs.readFileSync(p), type: JS })
    cache.set(p, e)
    return e
  }
  const clientSource = () => {
    const fork = path.join(clientDir, 'client.jsx')
    if (exists(fork)) return fork
    if (!warnedFallback) { warnedFallback = true; log(`assets: client/client.jsx absent — serving the 1.x client.jsx (the fork is lane C's)`) }
    return path.join(repoRoot, 'client.jsx')
  }
  const dirMtime = (dir) => { let m = 0; let names = []; try { names = fs.readdirSync(dir) } catch {}; for (const n of names) if (/\.(jsx?|mjs)$/.test(n)) m = Math.max(m, mtimeOf(path.join(dir, n))); return m }
  async function clientJs() {
    const src = clientSource()
    const mtime = Math.max(mtimeOf(src), dirMtime(path.dirname(src)), mtimeOf(path.join(repoRoot, 'chrome-resolve.js')))
    const key = `client::${src}::${prod}`
    const hit = cache.get(key)
    if (hit && hit.mtime === mtime) return hit
    const r = await esbuildBuild({
      entryPoints: [src], bundle: true, format: 'esm', platform: 'browser', write: false, target: ['es2020'],
      loader: { '.jsx': 'jsx', '.js': 'jsx' }, jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment',
      minify: prod, sourcemap: prod ? false : 'inline', logLevel: 'silent',
      define: { 'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development') },
    })
    const e = withHash({ mtime, body: Buffer.from(r.outputFiles[0].text), type: JS })
    cache.set(key, e)
    return e
  }
  function plain(name) {
    const candidates = [path.join(clientDir, name), ...(name === 'chrome-resolve.js' ? [path.join(repoRoot, name)] : [])]
    const p = candidates.find(exists)
    if (!p) return null
    const mtime = mtimeOf(p)
    const hit = cache.get(p)
    if (hit && hit.mtime === mtime) return hit
    const e = withHash({ mtime, body: fs.readFileSync(p), type: JS })
    cache.set(p, e)
    return e
  }
  function template() {
    const p = path.join(clientDir, 'index.html')
    if (!exists(p)) return FALLBACK_TEMPLATE
    const mtime = mtimeOf(p)
    const hit = cache.get(p)
    if (hit && hit.mtime === mtime) return hit.body
    const body = fs.readFileSync(p, 'utf8')
    if (!hasSlots(body)) { log('assets: client/index.html lacks the five slots — using the built-in template'); return FALLBACK_TEMPLATE }
    cache.set(p, { mtime, body })
    return body
  }

  // THE URL NAMES THE BYTES (2026-09-05): every entry carries a content hash; document.mjs appends it as `?v=` to the
  // shell's own asset URLs (client.js, chrome-resolve.js, react*), so a cache in front — the browser's, Cloudflare's
  // four-hour browser TTL that overrides `no-cache` — never serves yesterday's client for today's document.
  function withHash(e) { return { ...e, hash: createHash('sha256').update(e.body).digest('hex').slice(0, 16) } }
  return {
    prod, template, clientJs,
    /** versions() → { '/assets/<name>': <16-hex content hash> } for the shell's own assets (an asset that fails to build is absent) */
    async versions() {
      const out = {}
      for (const n of ['react', 'react-dom']) { try { const e = vendor(n); if (e?.hash) out['/assets/' + n + '.js'] = e.hash } catch {} }
      try { const e = await clientJs(); if (e?.hash) out['/assets/client.js'] = e.hash } catch {}
      try { const e = plain('chrome-resolve.js'); if (e?.hash) out['/assets/chrome-resolve.js'] = e.hash } catch {}
      return out
    },
    async handle(req, res, pathname) {
      if (!pathname.startsWith('/assets/')) return false
      const name = pathname.slice('/assets/'.length)
      let e = null
      if (name === 'react.js' || name === 'react-dom.js') e = vendor(name.replace(/\.js$/, ''))
      else if (name === 'client.js') e = await clientJs()
      else if (/^[a-z][a-z0-9-]*\.js$/.test(name)) e = plain(name)
      if (!e) { const b = Buffer.from('{}'); res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'cache-control': 'no-store' }); res.end(b); return true }
      send(req, res, 200, e.body, e.type, { etag: `"${e.mtime}"` })
      return true
    },
    close() { cache.clear() },
  }
}
