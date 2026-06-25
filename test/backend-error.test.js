// A backend that fails to (re)load surfaces as a clear 500 on ITS OWN /api lane
// — carrying the actionable `createRequire` hint — while every other module
// keeps serving normally. The failure is ISOLATED, never instance-wide: a
// broken (or vibe-coded) backend can't take the rest of the instance down.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from './helpers.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'backend-error')

let server
before(async () => { server = await startServer(FIXTURE) })
after(async () => { await server?.stop() })

test('broken backend → 500 on its own /api, with the actionable createRequire hint', async () => {
  const res = await fetch(server.base + '/api/global/baddep/ping')
  assert.equal(res.status, 500)
  const body = await res.json()
  assert.equal(body.module, 'global/baddep')
  assert.match(body.message, /totally-missing-pkg-xyz/)       // names the failing dep
  assert.match(body.message, /createRequire\(import\.meta\.url\)/)  // names the fix
})

test('isolation: an unrelated module keeps serving 200 while the other is broken', async () => {
  const res = await fetch(server.base + '/api/global/gooddep/ping')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
})

test('the broken backend is seeded into the bootstrap so a fresh page load can show it', async () => {
  const html = await (await fetch(server.base + '/')).text()
  const m = html.match(/window\.__ATELIER__ = (\{.*?\});/)
  assert.ok(m, 'bootstrap present')
  const boot = JSON.parse(m[1])
  const be = (boot.backendErrors || []).find((e) => e.qid === 'global/baddep')
  assert.ok(be, 'baddep backend error present in the bootstrap')
  assert.match(be.message, /createRequire/)
})
