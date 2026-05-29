// Backend hot-reload characterization (the path that used to depend on
// chokidar, now native fs.watch). Mutates module files, so it runs against a
// throwaway workspace in tmp — not a shared committed fixture — created here
// and removed after. Guards: atomic-save reload (incl. a 2nd consecutive save,
// the case that broke fs.watch-on-file), transitive-import reload (the dedupe
// fix), and teardown on delete.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer, sleep } from './helpers.js'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-hot-'))
const PROBE = path.join(ROOT, 'probe')
const BACKEND = path.join(PROBE, 'backend.js')
const LIB = path.join(PROBE, 'lib.js')
const backendSrc = (v) =>
  `import { LIB_V } from './lib.js'\nexport default { mountRoutes(r) { r.get('/v', (q, s) => s.json({ v: ${v}, lib: LIB_V })) } }\n`
const libSrc = (v) => `export const LIB_V = ${v}\n`

let server
before(async () => {
  fs.mkdirSync(PROBE, { recursive: true })
  fs.writeFileSync(BACKEND, backendSrc(1))
  fs.writeFileSync(LIB, libSrc(1))
  server = await startServer(ROOT)   // hotReload defaults true → watchers on
})
after(async () => {
  await server?.stop()
  fs.rmSync(ROOT, { recursive: true, force: true })
})

async function getV() {
  const r = await fetch(server.base + '/api/global/probe/v')
  return r.status === 200 ? await r.json() : { status: r.status }
}
async function waitFor(pred, timeout = 8000) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeout) {
    try { last = await getV() } catch { last = { status: 'err' } }
    if (pred(last)) return
    await sleep(80)
  }
  throw new Error('hot-reload timeout; last = ' + JSON.stringify(last))
}
function atomicWrite(file, content) {   // realistic editor save: write temp + rename-over
  const tmp = `${file}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
}

test('backend hot-swaps on atomic save, incl. a 2nd consecutive save', async () => {
  await waitFor((x) => x.v === 1)
  atomicWrite(BACKEND, backendSrc(2))
  await waitFor((x) => x.v === 2)
  atomicWrite(BACKEND, backendSrc(3))   // the rename-over case that killed fs.watch-on-file
  await waitFor((x) => x.v === 3)
})

test('editing a transitive import (lib.js) triggers a reload', async () => {
  atomicWrite(LIB, libSrc(9))
  await waitFor((x) => x.lib === 9)
})

test('deleting backend.js tears the module down (route 404s)', async () => {
  fs.rmSync(BACKEND)
  await waitFor((x) => x.status === 404)
})
