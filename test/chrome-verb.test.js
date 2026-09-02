// chrome.js — `atelier chrome release` (step 7 ship C, decisions 1 and 3): the bundle's shape, the digest's
// determinism (the same dir twice = the same digest; one changed byte = another), the font-url rewrite, the payload
// the spine's POST /v1/chromes takes, the `--digest` re-release (no files), the argument rules, the cli dispatch.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { release, bundleChrome, parseArgs, rewriteFontUrls, payloadFor } from '../chrome.js'
import { chromeDigestOf, sha256Hex, DIGEST_RE } from '../protocol/registry.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(REPO, 'cli.js')

// a chrome folder: sources (jsx → the Tailwind scan), a sheet importing tailwind with a company-relative font url, a font
function chromeDir(root, { stamp = 'v1' } = {}) {
  const d = path.join(root, 'my-chrome')
  fs.mkdirSync(path.join(d, 'fonts'), { recursive: true })
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(d, 'node_modules'))
  fs.writeFileSync(path.join(d, 'frontend.jsx'), `import React from 'react'\nimport { Button } from './kit.js'\nexport const meta = { isChrome: true }\nexport function chrome(props) { return <div className="flex text-brand">${stamp}<Button /></div> }\n`)
  fs.writeFileSync(path.join(d, 'kit.js'), `import React from 'react'\nexport const Button = () => React.createElement('button', { className: 'rounded px-3' }, 'b')\n`)
  fs.writeFileSync(path.join(d, 'styles.css'), `@font-face { font-family: 'Inter'; src: url('../my-chrome/fonts/Inter.woff2') format('woff2'); }\n@font-face { font-family: 'Inter'; font-style: italic; src: url("./fonts/Inter-Italic.woff2?v=1") }\n@import 'tailwindcss';\n@theme { --color-brand: #2563eb; }\n.atelier-rail { display: flex; background: url(data:image/png;base64,AAAA); }\n`)
  fs.writeFileSync(path.join(d, 'fonts', 'Inter.woff2'), Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(64, 1)]))
  fs.writeFileSync(path.join(d, 'fonts', 'Inter-Italic.woff2'), Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(64, 2)]))
  fs.writeFileSync(path.join(d, 'backend.js'), 'export default { mountRoutes() {} }\n')
  fs.writeFileSync(path.join(d, 'module.json'), '{ "name": "my-chrome" }\n')
  return d
}
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-verb-')))

test('rewriteFontUrls: every relative url naming a fonts/ file becomes fonts/<name> (query kept); absolute, data: and non-font urls stay', () => {
  assert.equal(rewriteFontUrls("src: url('../catalyst-chrome/fonts/InterVariable.woff2') format('woff2')"), "src: url('fonts/InterVariable.woff2') format('woff2')")
  assert.equal(rewriteFontUrls('url("./fonts/a.woff2?v=1")'), 'url("fonts/a.woff2?v=1")')
  assert.equal(rewriteFontUrls('url(fonts/a.woff2)'), 'url(fonts/a.woff2)')
  assert.equal(rewriteFontUrls("url('/fonts/a.woff2') url(data:font/woff2;base64,AAAA) url(https://x/fonts/a.woff2) url('../img/x.png')"), "url('/fonts/a.woff2') url(data:font/woff2;base64,AAAA) url(https://x/fonts/a.woff2) url('../img/x.png')")
})

test('bundleChrome: {frontend.js, kit.js, styles.css (fonts → fonts/…), chrome.css (compiled, the chrome\'s own rules), fonts/*} — nothing else (no backend.js, no module.json, no manifest); the digest is protocol/registry\'s rule; the same dir twice = the same digest; one byte changed = another digest', async () => {
  const root = tmp()
  const d = chromeDir(root)
  const b1 = await bundleChrome(d)
  assert.deepEqual([...b1.files.keys()].sort(), ['chrome.css', 'fonts/Inter-Italic.woff2', 'fonts/Inter.woff2', 'frontend.js', 'kit.js', 'styles.css'])
  assert.match(b1.digest, DIGEST_RE)
  assert.equal(b1.digest, chromeDigestOf(Object.fromEntries([...b1.files].map(([p, buf]) => [p, sha256Hex(buf)]))))
  const styles = b1.files.get('styles.css').toString()
  assert.ok(styles.includes("url('fonts/Inter.woff2')") && styles.includes('url("fonts/Inter-Italic.woff2?v=1")'), styles)
  assert.ok(!styles.includes('../my-chrome'), 'no company-relative url survives')
  const chromeCss = b1.files.get('chrome.css').toString()
  for (const rule of ['.atelier-rail', '.flex', '.text-brand', '.rounded', '.px-3', '--color-brand', "url('fonts/Inter.woff2')"]) assert.ok(chromeCss.includes(rule), `chrome.css carries ${rule}`)
  assert.ok(!chromeCss.includes('/_chrome/'), 'chrome.css is digest-free: a relative url resolves beside it')
  const fe = b1.files.get('frontend.js').toString()
  assert.ok(!/from\s*["']react["']/.test(fe) && !fe.includes('import React'), 'react is aliased to the shims, nothing left external')
  assert.ok(fe.includes('v1'))
  const b2 = await bundleChrome(d)
  assert.equal(b2.digest, b1.digest, 'deterministic')
  for (const [p, buf] of b1.files) assert.ok(buf.equals(b2.files.get(p)), `${p} byte for byte`)
  const d2 = chromeDir(path.join(root, 'two'), { stamp: 'v2' })
  const b3 = await bundleChrome(d2)
  assert.notEqual(b3.digest, b1.digest)
  await assert.rejects(bundleChrome(path.join(root, 'nope')), /not a directory/)
  fs.rmSync(path.join(d2, 'kit.js'))
  await assert.rejects(bundleChrome(d2), /kit/)
})

test('release(): the payload {version, changelog, agent_notes, breaking, notice, digest, files:{path: base64}} written to --out and nowhere else; --digest re-releases without files; the argument rules', async () => {
  const root = tmp()
  const d = chromeDir(root)
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# 0.2.3 — tighter rail\n\nThe rail is 4 px narrower.\n')
  fs.writeFileSync(path.join(root, 'NOTES.md'), 'Nothing to do.\n')
  const out = path.join(root, 'release.json')
  const logs = []
  const r = await release([d, '--version', '0.2.3', '--changelog', path.join(root, 'CHANGELOG.md'), '--agent-notes', path.join(root, 'NOTES.md'), '--notice', 'qa-e2e', '--out', out], { log: (l) => logs.push(l) })
  assert.match(r.digest, DIGEST_RE); assert.equal(r.version, '0.2.3'); assert.deepEqual(r.files, ['chrome.css', 'fonts/Inter-Italic.woff2', 'fonts/Inter.woff2', 'frontend.js', 'kit.js', 'styles.css'])
  const p = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.deepEqual(Object.keys(p), ['version', 'changelog', 'agent_notes', 'breaking', 'notice', 'digest', 'files'])
  assert.equal(p.version, '0.2.3'); assert.equal(p.changelog, '# 0.2.3 — tighter rail\n\nThe rail is 4 px narrower.\n'); assert.equal(p.agent_notes, 'Nothing to do.\n')
  assert.equal(p.breaking, false); assert.equal(p.notice, 'qa-e2e'); assert.equal(p.digest, r.digest)
  assert.deepEqual(Object.keys(p.files), r.files)
  // the spine's check: base64 → bytes → shas → the digest
  const shas = Object.fromEntries(Object.entries(p.files).map(([f, b64]) => [f, sha256Hex(Buffer.from(b64, 'base64'))]))
  assert.equal(chromeDigestOf(shas), p.digest)
  assert.equal(Buffer.from(p.files['fonts/Inter.woff2'], 'base64').length, 68)
  assert.deepEqual(fs.readdirSync(root).sort(), ['CHANGELOG.md', 'NOTES.md', 'my-chrome', 'release.json'], 'the verb writes --out alone')
  assert.ok(logs.some((l) => l.includes(`digest ${r.digest}`)) && logs.some((l) => l.includes('notice=qa-e2e files=6')), logs.join('\n'))
  // breaking + default notice
  const r2 = await release([d, '--version', '1.0.0', '--changelog', path.join(root, 'CHANGELOG.md'), '--breaking', '--out', out], { log: () => {} })
  const p2 = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(p2.breaking, true); assert.equal(p2.notice, 'all'); assert.equal(p2.agent_notes, ''); assert.equal(p2.digest, r2.digest); assert.equal(r2.digest, r.digest, 'the same dir: the same digest whatever the version')
  // --digest: a rollback re-release carries no files and needs no dir
  const r3 = await release(['--digest', r.digest, '--version', '0.2.4', '--changelog', path.join(root, 'CHANGELOG.md'), '--notice', 'none', '--out', out], { log: (l) => logs.push(l) })
  const p3 = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.deepEqual(Object.keys(p3), ['version', 'changelog', 'agent_notes', 'breaking', 'notice', 'digest']); assert.equal(p3.digest, r.digest); assert.equal(p3.notice, 'none'); assert.deepEqual(r3.files, [])
  assert.ok(logs.some((l) => l.includes('re-release of')))
  // the rules
  for (const [argv, why] of [
    [[d, '--changelog', 'x', '--out', out], /--version/], [[d, '--version', 'bad version!', '--changelog', 'x', '--out', out], /--version/],
    [[d, '--version', '1', '--out', out], /--changelog/], [[d, '--version', '1', '--changelog', 'x'], /--out/],
    [['--version', '1', '--changelog', 'x', '--out', out], /<dir> is required/], [[d, '--version', '1', '--changelog', 'x', '--out', out, '--digest', 'abc'], /--digest is 64/],
    [[d, '--version', '1', '--changelog', 'x', '--out', out, '--notice', 'a b'], /--notice/], [[d, '--version', '1', '--changelog', 'x', '--out', out, '--bogus'], /unknown option/],
    [[d, d, '--version', '1', '--changelog', 'x', '--out', out], /one <dir>/], [[d, '--version'], /needs a value/],
  ]) assert.throws(() => parseArgs(argv), why, argv.join(' '))
  await assert.rejects(release([d, '--version', '1', '--changelog', path.join(root, 'missing.md'), '--out', out], { log: () => {} }), /--changelog .*ENOENT/)
  assert.deepEqual(payloadFor({ version: 'v', changelog: 'c', agentNotes: null, breaking: false, notice: null, digest: 'd' }), { version: 'v', changelog: 'c', agent_notes: '', breaking: false, notice: 'all', digest: 'd' })
})

test('the cli: `atelier chrome release …` dispatches to chrome.js and prints the digest; a bad call exits 1 with the usage; `atelier chrome` alone exits 2', () => {
  const root = tmp()
  const d = chromeDir(root)
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), 'first\n')
  const out = path.join(root, 'release.json')
  const stdout = execFileSync(process.execPath, [CLI, 'chrome', 'release', d, '--version', '0.0.1', '--changelog', path.join(root, 'CHANGELOG.md'), '--out', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.match(stdout.trim(), DIGEST_RE)
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).digest, stdout.trim())
  assert.throws(() => execFileSync(process.execPath, [CLI, 'chrome', 'release', d, '--out', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), (e) => e.status === 1 && /--version/.test(e.stderr) && /usage: atelier chrome release/.test(e.stderr))
  assert.throws(() => execFileSync(process.execPath, [CLI, 'chrome'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), (e) => e.status === 2 && /usage/.test(e.stderr))
})
