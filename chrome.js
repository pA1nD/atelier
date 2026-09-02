#!/usr/bin/env node
/* atelier chrome — chrome releases (step 7 ship C, R-CHROME; LANES-CHROME decisions 1 and 3).
 *
 *   atelier chrome release <dir> --version V --changelog F [--agent-notes F] [--breaking] [--notice all|none|<chat>] --out release.json
 *   atelier chrome release --digest <hex> --version V --changelog F [--agent-notes F] [--notice …] --out release.json   (a rollback:
 *                          an old digest released again as a new version — the bytes are already on the volume, no files travel)
 *
 * Builds the bundle the fleet serves by digest — `frontend.js` + `kit.js` (esbuild exactly as the host's dev shell and
 * portal/host/vendor.sh: one file each, react* aliased to atelier's shims, nothing left external), `styles.css` (the
 * chrome's sheet SOURCE, every font url rewritten to `fonts/…`), `chrome.css` (the chrome-only compiled sheet,
 * host/supervisor/tailwind.mjs buildSheet over the chrome alone — an app-less document's sheet) and `fonts/*.woff2` —
 * computes the digest (protocol/registry.js: sha256 over the sorted `<path>\n<sha256(bytes)>\n` lines) and writes the
 * release payload `{version, changelog, agent_notes, breaking, notice, digest, files:{path: base64}}` to `--out`.
 * No network: ops/chrome-release.sh ships the payload to the spine's loopback door (`POST /v1/chromes`) over ssh.
 * Deterministic: the same dir twice is the same digest.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuildBuild } from 'esbuild'
import { buildSheet } from './host/supervisor/tailwind.mjs'
import { DIGEST_RE, CHROME_REQUIRED_FILES, validChromePath, chromeDigestOf, sha256Hex } from './protocol/registry.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/
export const NOTICE_RE = /^[A-Za-z0-9+_][A-Za-z0-9._:@+-]{0,255}$/
export const USAGE = `usage: atelier chrome release <dir> --version V --changelog F [--agent-notes F] [--breaking] [--notice all|none|<chat>] --out release.json
       atelier chrome release --digest <hex> --version V --changelog F [--agent-notes F] [--notice all|none|<chat>] --out release.json`

// parseArgs(argv) → {dir, version, changelog, agentNotes, breaking, notice, digest, out} | throws
export function parseArgs(argv) {
  const o = { dir: null, version: null, changelog: null, agentNotes: null, breaking: false, notice: null, digest: null, out: null }
  const takes = { '--version': 'version', '--changelog': 'changelog', '--agent-notes': 'agentNotes', '--notice': 'notice', '--digest': 'digest', '--out': 'out' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--breaking') { o.breaking = true; continue }
    if (a in takes) { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`); o[takes[a]] = v; continue }
    if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    if (o.dir) throw new Error(`one <dir> only (got ${o.dir} and ${a})`)
    o.dir = a
  }
  if (!o.version || !VERSION_RE.test(o.version)) throw new Error('--version V is required: letters, digits, . _ + - (≤ 64)')
  if (!o.changelog) throw new Error('--changelog F is required (a markdown file; its first line is the headline)')
  if (!o.out) throw new Error('--out release.json is required')
  if (o.notice !== null && !NOTICE_RE.test(o.notice)) throw new Error('--notice is all, none, or one chat id')
  if (o.digest !== null && !DIGEST_RE.test(o.digest)) throw new Error('--digest is 64 lowercase hex (a released digest)')
  if (!o.digest && !o.dir) throw new Error('a chrome <dir> is required (or --digest <hex> for a rollback)')
  return o
}

// rewriteFontUrls(css) → css with every relative font url reduced to `fonts/<name>` — the bundle's own folder
// (the vendored sheet names the system host's company-relative `../catalyst-chrome/fonts/…`; served by digest the
// sheet sits beside `fonts/`, and the host's sheet build rebases it under `/_chrome/<digest>/`)
export function rewriteFontUrls(css) {
  return String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, quote, raw) => {
    const u = raw.trim()
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(u)) return m
    const f = /(?:^|\/)fonts\/([^/?#]+)((?:[?#].*)?)$/.exec(u)
    return f ? `url(${quote}fonts/${f[1]}${f[2]}${quote})` : m
  })
}

const exists = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }

// bundleChrome(dir, {shims, log}) → {files: Map<path, Buffer>, shas, digest, notes}
export async function bundleChrome(dir, { shims = path.join(HERE, 'shims'), log = () => {} } = {}) {
  const src = path.resolve(dir)
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error(`${dir} is not a directory`)
  const files = new Map()
  const notes = []
  // 1. frontend.js + kit.js — vendor.sh's recipe (portal/host/vendor.sh step 3 = devshell.mjs chromeBundle, production)
  for (const entry of ['frontend', 'kit']) {
    const file = ['jsx', 'js'].map((x) => path.join(src, `${entry}.${x}`)).find(exists)
    if (!file) throw new Error(`no ${entry}.jsx/js in ${dir}`)
    const r = await esbuildBuild({
      entryPoints: [file], absWorkingDir: src, bundle: true, format: 'esm', platform: 'browser', write: false,
      minify: true, sourcemap: false, target: ['es2020'],
      loader: { '.jsx': 'jsx', '.js': 'jsx', '.svg': 'dataurl', '.png': 'dataurl' }, jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
      alias: { react: path.join(shims, 'react.js'), 'react-dom': path.join(shims, 'react-dom.js'), 'react/jsx-runtime': path.join(shims, 'jsx-runtime.js'), 'react/jsx-dev-runtime': path.join(shims, 'jsx-runtime.js') },
      logLevel: 'error', metafile: true,
    })
    // the shell serves the bundle as one file: an import esbuild left external would 404 in the browser
    const left = Object.values(r.metafile.outputs).flatMap((o) => (o.imports ?? []).filter((i) => i.external).map((i) => i.path))
    if (left.length) throw new Error(`${entry}.js still imports ${[...new Set(left)].join(', ')} — nothing may stay external`)
    files.set(`${entry}.js`, Buffer.from(r.outputFiles[0].text))
    notes.push(`${entry}.js ${(r.outputFiles[0].text.length / 1024).toFixed(0)} KB`)
  }
  // 2. styles.css — the source, font urls → fonts/…
  const sheetPath = path.join(src, 'styles.css')
  if (!exists(sheetPath)) throw new Error(`no styles.css in ${dir}`)
  const source = rewriteFontUrls(fs.readFileSync(sheetPath, 'utf8'))
  files.set('styles.css', Buffer.from(source))
  // 3. fonts/*.woff2
  const fontsDir = path.join(src, 'fonts')
  let fonts = []
  try { fonts = fs.readdirSync(fontsDir).filter((n) => /\.woff2?$/i.test(n)).sort() } catch {}
  for (const n of fonts) { const p = `fonts/${n}`; if (!validChromePath(p)) throw new Error(`bad font name ${n}`); files.set(p, fs.readFileSync(path.join(fontsDir, n))) }
  notes.push(`${fonts.length} font(s)`)
  // 4. chrome.css — the chrome-only compiled sheet (buildSheet over the rewritten source; scan = the chrome's own sources)
  let sheet
  try { sheet = await buildSheet({ chromeDir: src, appDir: null, source }) } catch (e) { const p = e?.problems?.[0]; throw new Error(p ? `chrome.css: ${p.file}:${p.line}:${p.col} ${p.message}` : (e?.message ?? String(e))) }
  files.set('chrome.css', Buffer.from(sheet.css))
  notes.push(`chrome.css ${(sheet.css.length / 1024).toFixed(0)} KB (${sheet.candidates} candidates)`)
  for (const f of CHROME_REQUIRED_FILES) if (!files.has(f)) throw new Error(`bundle incomplete: no ${f}`)
  const shas = {}
  for (const [p, b] of files) shas[p] = sha256Hex(b)
  const digest = chromeDigestOf(shas)
  log(`[chrome] ${notes.join(', ')} → digest ${digest}`)
  return { files, shas, digest, notes }
}

// payloadFor(o, bundle) → the release payload the spine's POST /v1/chromes takes
export function payloadFor({ version, changelog, agentNotes, breaking, notice, digest }, bundle = null) {
  const out = { version, changelog, agent_notes: agentNotes ?? '', breaking: !!breaking, notice: notice ?? 'all', digest }
  if (bundle) { out.files = {}; for (const p of [...bundle.files.keys()].sort()) out.files[p] = bundle.files.get(p).toString('base64') }
  return out
}

export async function release(argv, { log = (l) => process.stderr.write(l + '\n') } = {}) {
  const o = parseArgs(argv)
  const read = (f, what) => { try { return fs.readFileSync(f, 'utf8') } catch (e) { throw new Error(`${what} ${f}: ${e.code ?? e.message}`) } }
  const changelog = read(o.changelog, '--changelog')
  if (!changelog.trim()) throw new Error(`--changelog ${o.changelog} is empty (its first line is the headline)`)
  const agentNotes = o.agentNotes ? read(o.agentNotes, '--agent-notes') : ''
  let bundle = null, digest = o.digest
  if (!digest) { bundle = await bundleChrome(o.dir, { log }); digest = bundle.digest }
  else log(`[chrome] re-release of ${digest} as v${o.version} (no files: the bytes are on the volume)`)
  const payload = payloadFor({ ...o, changelog, agentNotes, digest }, bundle)
  const text = JSON.stringify(payload)
  fs.writeFileSync(o.out, text)
  log(`[chrome] wrote ${o.out} (${(text.length / 1024).toFixed(0)} KB): v${o.version} digest=${digest}${o.breaking ? ' BREAKING' : ''} notice=${payload.notice}${bundle ? ` files=${Object.keys(payload.files).length}` : ''}`)
  return { digest, version: o.version, out: o.out, files: bundle ? [...bundle.files.keys()].sort() : [] }
}

// run as `node chrome.js release …` or through cli.js (`atelier chrome release …`, which splices the verb off argv)
const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (entry === fileURLToPath(import.meta.url) || entry === path.join(HERE, 'cli.js')) {
  const [sub, ...rest] = process.argv.slice(2)
  if (sub !== 'release') { process.stderr.write(USAGE + '\n'); process.exit(2) }
  release(rest).then((r) => { process.stdout.write(r.digest + '\n') }, (e) => { process.stderr.write(`atelier chrome release: ${e.message}\n${USAGE}\n`); process.exit(1) })
}
