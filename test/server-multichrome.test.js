// Multi-chrome resolution: a module may pin its chrome via `meta.chrome`. The
// shell resolves the chrome PER REQUESTED MODULE (meta.chrome → default), ships
// the default + available set in the bootstrap, and treats every mounted chrome
// as infrastructure. Purely additive: a module with no `meta.chrome` resolves
// to the default exactly as the single-chrome shell did.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer, sleep } from './helpers.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'ws-multichrome')

let server
before(async () => { server = await startServer(FIXTURE) })
after(async () => { await server?.stop() })

const boot = async (urlPath) => {
  const html = await (await fetch(server.base + urlPath)).text()
  const m = html.match(/window\.__ATELIER__ = (\{.*?\});/)
  assert.ok(m, `bootstrap present for ${urlPath}`)
  return JSON.parse(m[1])
}

test('default chrome is the alphabetically-first mounted chrome (election unchanged)', async () => {
  const b = await boot('/')
  assert.equal(b.chromeQid, 'global/alpha')
  assert.equal(b.defaultChromeQid, 'global/alpha')
})

test('bootstrap ships the available chrome set', async () => {
  const b = await boot('/')
  assert.deepEqual(b.chromes, ['global/alpha', 'global/beta'])
})

test('a module with no meta.chrome resolves to the default chrome', async () => {
  const b = await boot('/global/plain')
  assert.equal(b.chromeQid, 'global/alpha')
})

test('a module pinning a mounted chrome resolves to that chrome', async () => {
  const b = await boot('/global/fancy')
  assert.equal(b.chromeQid, 'global/beta')
  // ...while the instance default is unchanged.
  assert.equal(b.defaultChromeQid, 'global/alpha')
})

test('a module pinning a MISSING chrome → default chrome hosts a clear error, and the server warns (no silent fallback)', async () => {
  // The server resolves the default purely as a host frame; the client renders
  // a "chrome not installed" error in it instead of the module (browser-verified).
  const b = await boot('/global/broken')
  assert.equal(b.chromeQid, 'global/alpha')        // host frame = default
  await sleep(50)                                    // let the warn flush to output
  assert.match(server.output(), /pins chrome 'ghost', which is not a mounted chrome/)
})

test('a workspace home (no module) resolves to the default chrome', async () => {
  const b = await boot('/global/')
  assert.equal(b.chromeQid, 'global/alpha')
})

test('every mounted chrome bundle serves (both are infrastructure)', async () => {
  for (const id of ['alpha', 'beta']) {
    const r = await fetch(server.base + `/modules/global/${id}/frontend.js`)
    assert.equal(r.status, 200, `${id} bundle serves`)
    assert.match(r.headers.get('content-type') || '', /javascript/)
  }
})
