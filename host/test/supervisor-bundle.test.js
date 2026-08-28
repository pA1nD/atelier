// supervisor/bundle.mjs — real esbuild: backend snapshot with import.meta.url rewritten (createRequire
// resolves from the app folder), per-file frontend transform with `?rev=`, the failure classes
// with file:line:col + hint, the source-map lookup (DESIGN §6.1, §6.3, §8.1).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { bundleBackend, transformFrontend, classifyWorkerFailure, formatHint, sourceMapLookup, versionRelativeImports, walkFiles, locateImport } from '../supervisor/bundle.mjs'

const mkApp = (files) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sup-bundle-')))
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c) }
  return dir
}

test('backend bundle: relative imports inlined, packages external, import.meta.url → the source file URL, createRequire resolves in the app folder', async () => {
  const dir = mkApp({
    'backend.js': `import { createRequire } from 'node:module'\nimport { helper } from './lib/helper.js'\nconst require = createRequire(import.meta.url)\nconst dep = require('mydep')\nexport const HERE = import.meta.url\nexport default { mountRoutes(router) { router.get('/x', () => helper() + dep.v) } }\nexport { helper, dep }\n`,
    'lib/helper.js': `export const helper = () => 'h:' + import.meta.url.split('/').pop()\n`,
    'node_modules/mydep/package.json': '{"name":"mydep","main":"index.js"}',
    'node_modules/mydep/index.js': 'module.exports = { v: 42 }',
  })
  const b = await bundleBackend({ appDir: dir })
  assert.ok(b.code.includes(JSON.stringify(pathToFileURL(path.join(dir, 'backend.js')).href)), 'entry import.meta.url rewritten')
  assert.ok(b.code.includes(JSON.stringify(pathToFileURL(path.join(dir, 'lib/helper.js')).href)), 'helper import.meta.url rewritten to ITS file')
  assert.ok(!b.code.includes('import.meta.url'), 'no import.meta.url left')
  assert.ok(/from\s*["']node:module["']/.test(b.code), 'node builtins stay external')
  assert.deepEqual(b.inputs.sort(), ['backend.js', 'lib/helper.js'])
  assert.ok(b.map && JSON.parse(b.map).sources.length === 2)
  // run the snapshot from a DIFFERENT directory: createRequire must still find the app's node_modules
  const snap = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-snap-'))
  fs.writeFileSync(path.join(snap, 'backend.js'), b.code)
  const mod = await import(pathToFileURL(path.join(snap, 'backend.js')))
  assert.equal(mod.dep.v, 42)
  assert.equal(mod.helper(), 'h:helper.js')
  assert.equal(mod.HERE, pathToFileURL(path.join(dir, 'backend.js')).href)
  // no backend.js → null (a frontend-only app)
  fs.rmSync(path.join(dir, 'backend.js'))
  assert.equal(await bundleBackend({ appDir: dir }), null)
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(snap, { recursive: true, force: true })
})

test('backend failure classes: syntax with file:line:col, missing relative import with the multi-file hint', async () => {
  const dir = mkApp({ 'backend.js': `export default {\n  mountRoutes(router) {\n    router.get('/x', () => 1\n  }\n}\n` })
  await assert.rejects(bundleBackend({ appDir: dir }), (e) => {
    const p = e.problems[0]
    assert.equal(p.file, 'backend.js'); assert.equal(p.line, 4); assert.ok(p.col >= 1)
    assert.match(formatHint(p), /^backend\.js:4:\d+ Expected .* — fix the syntax at that position/)
    return true
  })
  fs.writeFileSync(path.join(dir, 'backend.js'), `import { x } from './missing.js'\nexport default { mountRoutes() {} }\n`)
  await assert.rejects(bundleBackend({ appDir: dir }), (e) => {
    const p = e.problems[0]
    assert.equal(p.file, 'backend.js'); assert.equal(p.line, 1); assert.ok(p.col >= 1)
    assert.match(p.message, /Could not resolve "\.\/missing\.js"/)
    assert.match(p.hint, /create \.\/missing\.js next to backend\.js \(a multi-file save: write the imported file, then re-save\)/)
    return true
  })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('frontend per-file transform: classic JSX, .jsx → .js, ?rev= on relative imports only, exclusions', async () => {
  const dir = mkApp({
    'frontend.jsx': `import { Button } from '@atelier/kit'\nimport { Card } from './components/card.js'\nimport data from './data.json'\nexport default function App() { return <div className="p-4"><Button/><Card/></div> }\n`,
    'components/card.jsx': `export const Card = () => <><span>c</span></>\n`,
    'helper.js': `export const h = () => import('./components/card.js')\n`,
    'data.json': '{}',
    'backend.js': 'export default {}',
    '_private/x.jsx': '<bad',
    'node_modules/dep/index.js': 'x',
    'data/x.jsx': '<bad',
    '.hidden.jsx': '<bad',
  })
  const { files } = await transformFrontend({ appDir: dir, rev: 7 })
  assert.deepEqual([...files.keys()].sort(), ['components/card.js', 'frontend.js', 'helper.js'])
  const fe = files.get('frontend.js')
  assert.ok(fe.includes('React.createElement("div"'), 'classic transform, global React')
  assert.ok(fe.includes(`from "@atelier/kit"`), 'bare specifiers untouched')
  assert.ok(fe.includes(`from "./components/card.js?rev=7"`), 'relative import tagged with the revision')
  assert.ok(fe.includes(`from "./data.json?rev=7"`))
  assert.ok(files.get('components/card.js').includes('React.Fragment'))
  assert.ok(files.get('helper.js').includes(`import("./components/card.js?rev=7")`))
  assert.equal(versionRelativeImports(`import a from "../x.js"; import "./y.js"; import "z";`, 3), `import a from "../x.js?rev=3"; import "./y.js?rev=3"; import "z";`)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('frontend failure classes: JSX syntax, and the half-written multi-file save', async () => {
  const dir = mkApp({ 'frontend.jsx': `export default function App() {\n  return <div>\n    <span>x</span>\n}\n` })
  await assert.rejects(transformFrontend({ appDir: dir, rev: 1 }), (e) => {
    const p = e.problems[0]
    assert.equal(p.file, 'frontend.jsx'); assert.ok(p.line >= 2); assert.ok(p.col >= 1)
    assert.match(p.hint, /close the open JSX element|fix the syntax at that position/)
    return true
  })
  fs.writeFileSync(path.join(dir, 'frontend.jsx'), `import { helper } from './helpers.js'\nexport default () => helper()\n`)
  await assert.rejects(transformFrontend({ appDir: dir, rev: 1 }), (e) => {
    const p = e.problems[0]
    assert.deepEqual([p.file, p.line, p.col], ['frontend.jsx', 1, 24])
    assert.equal(formatHint(p), 'frontend.jsx:1:24 Could not resolve "./helpers.js" — create ./helpers.js next to frontend.jsx (a multi-file save: write the imported file, then re-save) or fix the import path')
    return true
  })
  fs.writeFileSync(path.join(dir, 'helpers.jsx'), 'export const helper = () => <b/>')   // the .jsx sibling satisfies a ./helpers.js import
  const { files } = await transformFrontend({ appDir: dir, rev: 2 })
  assert.deepEqual([...files.keys()].sort(), ['frontend.js', 'helpers.js'])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('frontend relative imports resolve as the 1.x bundler did: extensionless, .jsx, a folder index — rewritten to the served .js path', async () => {
  const dir = mkApp({
    'frontend.jsx': `import { a } from './a'\nimport { b } from './b.jsx'\nimport { c } from './ui'\nimport { d } from './d.js'\nexport default () => a + b + c + d\n`,
    'a.jsx': 'export const a = 1', 'b.jsx': 'export const b = 2', 'ui/index.jsx': 'export const c = 3', 'd.js': 'export const d = 4',
  })
  const { files } = await transformFrontend({ appDir: dir, rev: 5 })
  const fe = files.get('frontend.js')
  assert.ok(fe.includes(`from "./a.js?rev=5"`), fe)
  assert.ok(fe.includes(`from "./b.js?rev=5"`), fe)
  assert.ok(fe.includes(`from "./ui/index.js?rev=5"`), fe)
  assert.ok(fe.includes(`from "./d.js?rev=5"`), fe)
  fs.writeFileSync(path.join(dir, 'frontend.jsx'), `import { e } from './e'\nexport default () => e\n`)
  await assert.rejects(transformFrontend({ appDir: dir, rev: 6 }), (e) => /Could not resolve "\.\/e"/.test(e.problems[0].message))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('worker failure classes: MOUNT-ERROR, ERR_MODULE_NOT_FOUND (located textually), RUNTIME-DEAD, LOAD-ERROR via the source map', async () => {
  const dir = mkApp({ 'backend.js': `import { createRequire } from 'node:module'\nimport 'leftpad'\nexport default {\n  mountRoutes(router) {\n    throw new Error('db not reachable')\n  }\n}\n` })
  const mount = classifyWorkerFailure({ code: 'MOUNT-ERROR', message: 'db not reachable', line: 5, col: 11 }, { appDir: dir })
  assert.equal(formatHint(mount), 'backend.js:5:11 mountRoutes threw: db not reachable — mountRoutes must only register routes — move the failing work into a handler (or guard it), nothing was mounted')
  const nf = classifyWorkerFailure({ code: 'ERR_MODULE_NOT_FOUND', message: `Cannot find package 'leftpad' imported from ${dir}/backend.js` }, { appDir: dir })
  assert.equal(formatHint(nf), `backend.js:2:8 Cannot find package 'leftpad' — run npm install leftpad in ${dir} and re-save backend.js, or remove the import`)
  const dead = classifyWorkerFailure({ code: 'RUNTIME-DEAD', message: 'exit 1 before READY' }, { appDir: dir })
  assert.match(formatHint(dead), /^backend\.js:1:1 exit 1 before READY — the worker exited during load/)
  const noready = classifyWorkerFailure({ code: 'no-ready', message: 'no READY within 8000 ms' }, { appDir: dir })
  assert.match(noready.hint, /never reported READY/)
  // LOAD-ERROR positions come in bundle coordinates; the source map takes them back to the source file
  fs.writeFileSync(path.join(dir, 'backend.js'), `import { boom } from './lib/boom.js'\nboom()\nexport default { mountRoutes() {} }\n`)
  fs.mkdirSync(path.join(dir, 'lib')); fs.writeFileSync(path.join(dir, 'lib/boom.js'), `export function boom() {\n  throw new Error('top-level')\n}\n`)
  const b = await bundleBackend({ appDir: dir })
  const lookup = sourceMapLookup(JSON.parse(b.map))
  const bundleLine = b.code.split('\n').findIndex((l) => l.includes("throw new Error('top-level')") || l.includes('throw new Error("top-level")')) + 1
  assert.ok(bundleLine > 0)
  const le = classifyWorkerFailure({ code: 'LOAD-ERROR', message: 'top-level', line: bundleLine, col: 9 }, { appDir: dir, map: lookup })
  assert.equal(le.file, 'lib/boom.js'); assert.equal(le.line, 2)
  assert.match(le.hint, /fix the top-level code at that position/)
  assert.deepEqual(locateImport(`const x = 1\nimport y from "pkg"`, 'pkg'), { line: 2, col: 15 })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('walkFiles applies the 1.x exclusions', () => {
  const dir = mkApp({ 'a.jsx': '', 'b.js': '', 'c.html': '', 'backend.js': '', 'sub/d.tsx': '', 'node_modules/x.js': '', 'data/y.js': '', '_p/z.js': '', '-q/z.js': '', '.h/z.js': '', '.env.js': '' })
  assert.deepEqual(walkFiles(dir).map((f) => f.rel).sort(), ['a.jsx', 'b.js', 'c.html', 'sub/d.tsx'])
  assert.deepEqual(walkFiles(dir, { exts: ['jsx', 'js'] }).map((f) => f.rel).sort(), ['a.jsx', 'b.js'])
  fs.rmSync(dir, { recursive: true, force: true })
})
