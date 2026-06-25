// The bundle path:
//  (1) the `env` setting (NODE_ENV) picks the dev vs prod React UMD — so
//      development ships React's warnings, production ships the minified build;
//  (2) a JS `import` of CSS fails LOUD (a build error on the bundle) instead of
//      being silently dropped, so the mistake is actionable, not invisible.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from './helpers.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'css-import')

describe('env: development (the default)', () => {
  let server
  before(async () => { server = await startServer(FIXTURE) })   // helpers default NODE_ENV=development
  after(async () => { await server?.stop() })

  test('serves the DEVELOPMENT React UMD (unminified, with warnings)', async () => {
    const js = await (await fetch(server.base + '/assets/react.js')).text()
    assert.match(js, /react\.development\.js/)              // dev-build marker (authoritative)
    assert.match(js, /React/)                               // a real React build, not an error page
  })

  test('a JS `import` of CSS fails the bundle with a loud, actionable error', async () => {
    const res = await fetch(server.base + '/modules/global/cssimporter/frontend.js')
    assert.equal(res.status, 500)
    const body = await res.text()
    assert.match(body, /CSS imports aren't bundled/)        // names the problem
    assert.match(body, /styles\.css/)                       // names the fix
  })
})

describe('env: production (NODE_ENV=production)', () => {
  let server
  before(async () => { server = await startServer(FIXTURE, { NODE_ENV: 'production' }) })
  after(async () => { await server?.stop() })

  test('serves the PRODUCTION React UMD (minified)', async () => {
    const js = await (await fetch(server.base + '/assets/react.js')).text()
    assert.doesNotMatch(js, /react\.development\.js/)       // not the dev UMD (authoritative)
    assert.match(js, /React/)                               // a real (minified) React build, not an error page
  })
})
