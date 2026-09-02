// supervisor/tailwind.mjs — one sheet per app over a 3-file chrome fixture, long-line split,
// no candidate leak between two apps, pass-through without a chrome, css failure class
// (DESIGN §6.4, §8.1; budget b5: ≤ 50 ms cold for the median corpus app).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSheet, splitLongLines, scanSources, rebaseUrls, LONG_LINE } from '../supervisor/tailwind.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CHROME_CSS = `@import 'tailwindcss';\n@custom-variant dark (&:where(.dark, .dark *));\n@theme {\n  --color-brand: #2563eb;\n  --radius-card: 10px;\n}\n.atelier-doc-prose { line-height: 1.7; }\n`

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-tw-'))
  const chrome = path.join(root, 'chrome')
  fs.mkdirSync(path.join(chrome, 'components'), { recursive: true })
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(chrome, 'node_modules'))   // `@import 'tailwindcss'` resolves from the chrome dir
  fs.writeFileSync(path.join(chrome, 'styles.css'), CHROME_CSS)
  fs.writeFileSync(path.join(chrome, 'frontend.jsx'), `export default () => <header className="flex lg:hidden text-brand">h</header>\n`)
  fs.writeFileSync(path.join(chrome, 'kit.js'), `export const Button = () => React.createElement('button', { className: 'rounded-[var(--radius-card)] px-3' })\n`)
  fs.writeFileSync(path.join(chrome, 'components', 'rail.jsx'), `export const Rail = () => <nav className="w-64 dark:bg-zinc-900">r</nav>\n`)
  const app = (name, files) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c) } return d }
  return { root, chrome, app, done: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('one sheet = chrome styles.css compiled with scan = chrome ∪ app; recursive app scan; no leak between two apps', async () => {
  const f = fixture()
  const a = f.app('alpha', { 'frontend.jsx': `export default () => <div className="p-4 text-brand">a</div>`, 'views/deep.jsx': `export const D = () => <i className="italic mt-[13px]">d</i>`, 'node_modules/x/index.js': `<p className="mb-96">never</p>`, 'data/x.jsx': `<p className="mb-80">never</p>`, 'backend.js': `const c = 'mb-72'` })
  const b = f.app('beta', { 'frontend.jsx': `export default () => <div className="grid gap-8 text-brand">b</div>` })
  const sa = await buildSheet({ chromeDir: f.chrome, appDir: a })
  const sb = await buildSheet({ chromeDir: f.chrome, appDir: b })
  assert.equal(sa.chrome, true)
  for (const [css, has, hasNot] of [[sa.css, ['.p-4', '.italic', '.mt-\\[13px\\]', '.text-brand', '.lg\\:hidden', '.w-64', '.dark\\:bg-zinc-900', '.atelier-doc-prose', '--color-brand'], ['.grid', '.gap-8', '.mb-96', '.mb-80', '.mb-72']], [sb.css, ['.grid', '.gap-8', '.text-brand', '.lg\\:hidden'], ['.p-4', '.italic']]]) {
    for (const h of has) assert.ok(css.includes(h), `expected ${h}`)
    for (const h of hasNot) assert.ok(!css.includes(h), `leaked ${h}`)
  }
  assert.ok(sa.css.includes('@layer') || sa.css.includes('layer'), 'Tailwind-ordered output (one sheet, not an unlayered utilities tail)')
  assert.ok(sa.ms < 500, `cold build ${sa.ms} ms`)   // b5: 4.9 ms median in-process; the process-cold first call pays module load
  f.done()
})

test('lines > 8 KB are split at 200 chars before scanning (the scanner still finds the classes)', async () => {
  const f = fixture()
  const long = `const s = "${'x'.repeat(LONG_LINE + 10)}"; const c = <div className="underline">y</div>`
  const a = f.app('gamma', { 'frontend.jsx': long, 'vendor.js': `/*${'a'.repeat(9000)}*/ document.body.className = "tracking-widest"` })
  const srcs = scanSources([a])
  for (const s of srcs) for (const l of s.content.split('\n')) assert.ok(l.length <= LONG_LINE, 'no long line reaches the scanner')
  const sheet = await buildSheet({ chromeDir: f.chrome, appDir: a })
  assert.ok(sheet.css.includes('.underline'))
  assert.ok(sheet.css.includes('.tracking-widest'))
  assert.equal(splitLongLines('short\nlines'), 'short\nlines')
  const split = splitLongLines('a'.repeat(500), 100, 200)
  assert.deepEqual(split.split('\n').map((l) => l.length), [200, 200, 100])
  f.done()
})

test('no chrome dir → the app styles.css passes through unchanged; a broken chrome sheet → css class with a hint', async () => {
  const f = fixture()
  const a = f.app('delta', { 'frontend.jsx': `<i className="p-1"/>`, 'styles.css': `.mine { color: red }\n` })
  const s = await buildSheet({ chromeDir: null, appDir: a })
  assert.equal(s.css, '.mine { color: red }\n'); assert.equal(s.chrome, false)
  const none = await buildSheet({ chromeDir: null, appDir: f.app('eps', {}) })
  assert.equal(none.css, '')
  fs.writeFileSync(path.join(f.chrome, 'styles.css'), `@import 'tailwindcss';\n.broken { color: red\n@theme {\n`)
  await assert.rejects(buildSheet({ chromeDir: f.chrome, appDir: a }), (e) => {
    const p = e.problems[0]
    assert.equal(p.file, 'chrome/styles.css'); assert.ok(p.line >= 1); assert.ok(p.col >= 1); assert.ok(p.message.length)
    assert.match(p.hint, /close the rule with \}|fix the CSS at that position/)
    return true
  })
  f.done()
})

test("a chrome folder without its own node_modules compiles: `@import 'tailwindcss'` resolves from the host", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-tw-nomod-'))
  const chrome = path.join(root, 'chrome')
  fs.mkdirSync(chrome)
  fs.writeFileSync(path.join(chrome, 'styles.css'), CHROME_CSS)
  fs.writeFileSync(path.join(chrome, 'frontend.jsx'), `export default () => <div className="flex text-brand">c</div>\n`)
  const app = path.join(root, 'app'); fs.mkdirSync(app)
  fs.writeFileSync(path.join(app, 'frontend.jsx'), `export default () => <p className="italic">a</p>`)
  try {
    const s = await buildSheet({ chromeDir: chrome, appDir: app })
    assert.ok(s.chrome)
    assert.match(s.css, /\.flex\b/)
    assert.match(s.css, /\.italic\b/)
    assert.match(s.css, /--color-brand/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('splitLongLines never cuts inside a token: every cut lands after a space or a quote, so a class that straddles the 200-char window still reaches the scanner (`fixed inset-x-0 bot|tom-0` in a minified chrome bundle lost `.bottom-0` from every sheet, 2026-09-02)', () => {
  const line = 'x'.repeat(190) + ' fixed inset-x-0 bottom-0 z-40 ' + 'className:"rounded-xl shadow-lg" '.repeat(400)
  const out = splitLongLines(line, 100, 200).split('\n')
  assert.ok(out.every((l) => l.length <= 200), 'no chunk longer than the window')
  assert.ok(out.some((l) => /(^| )bottom-0( |$)/.test(l)), `bottom-0 whole in one chunk\n${out.slice(0, 3).join('\n')}`)
  assert.equal(out.join(''), line, 'nothing lost, nothing added')
  // a window with no space or quote is cut hard (a 200-char token cannot be kept whole)
  assert.equal(splitLongLines('a'.repeat(450), 100, 200).split('\n').map((l) => l.length).join(','), '200,200,50')
})

test('chromeBase (step 7 ship C, decision 8): every RELATIVE url() of the chrome\'s source is rebased under /_chrome/<digest>/ before the compile — root-relative, absolute, data: and fragment urls untouched, a ../ prefix cannot leave the bundle; without chromeBase the sheet is byte for byte the same as before; `source` replaces the chrome\'s styles.css read', async () => {
  const D = 'd'.repeat(64)
  assert.equal(rebaseUrls("src: url('fonts/Inter.woff2') format('woff2')", `/_chrome/${D}`), `src: url('/_chrome/${D}/fonts/Inter.woff2') format('woff2')`)
  assert.equal(rebaseUrls('url("./fonts/a.woff2?v=1#x")', '/_chrome/x/'), 'url("/_chrome/x/fonts/a.woff2?v=1#x")')
  assert.equal(rebaseUrls("url( '../catalyst-chrome/fonts/a.woff2' )", '/_chrome/x'), "url('/_chrome/x/catalyst-chrome/fonts/a.woff2')")
  assert.equal(rebaseUrls('url(../../a.png)', '/_chrome/x'), 'url(/_chrome/x/a.png)')
  const untouched = "url('/fonts/a.woff2') url(data:font/woff2;base64,AAAA) url(https://x/a.woff2) url('#frag') url(blob:x)"
  assert.equal(rebaseUrls(untouched, '/_chrome/x'), untouched)
  assert.equal(rebaseUrls('url(fonts/a.woff2)', null), 'url(fonts/a.woff2)')
  const f = fixture()
  fs.writeFileSync(path.join(f.chrome, 'styles.css'), `@font-face { font-family: 'Inter'; src: url('fonts/Inter.woff2') format('woff2'); }\n` + CHROME_CSS)
  const a = f.app('alpha', { 'frontend.jsx': `export default () => <div className="p-4">a</div>` })
  const plain = await buildSheet({ chromeDir: f.chrome, appDir: a })
  const based = await buildSheet({ chromeDir: f.chrome, appDir: a, chromeBase: `/_chrome/${D}` })
  assert.ok(plain.css.includes("url('fonts/Inter.woff2')") || plain.css.includes('url(fonts/Inter.woff2)'), 'no base: the relative url stays')
  assert.ok(!plain.css.includes('/_chrome/'))
  assert.ok(based.css.includes(`/_chrome/${D}/fonts/Inter.woff2`), based.css.slice(0, 600))
  assert.ok(based.css.includes('.p-4') && based.css.includes('.atelier-doc-prose'), 'the same rules')
  assert.equal(based.css.replace(`/_chrome/${D}/fonts/Inter.woff2`, 'fonts/Inter.woff2'), plain.css, 'the url is the only difference')
  const again = await buildSheet({ chromeDir: f.chrome, appDir: a })
  assert.equal(again.css, plain.css, 'deterministic')
  const fromSource = await buildSheet({ chromeDir: f.chrome, appDir: null, source: `@import 'tailwindcss';\n.only-from-source { color: red }\n` })
  assert.ok(fromSource.css.includes('.only-from-source') && !fromSource.css.includes('.atelier-doc-prose'), 'source replaces the file')
  f.done()
})
