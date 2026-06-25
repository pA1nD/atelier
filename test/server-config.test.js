// Characterizes the v2 settings model: defaults ← atelier.config.json ← env.
// The ws-settings fixture sets { label: "studio", defaultChrome: "theme2" }; two
// chromes exist (skin, theme2) so the `defaultChrome` selector is proven to
// override alphabetical election (which would pick "skin").
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from './helpers.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'ws-settings')

describe('config provides settings', () => {
  let server
  before(async () => { server = await startServer(FIXTURE) })
  after(async () => { await server?.stop() })

  test('config "label" lands in the bootstrap', async () => {
    const html = await (await fetch(server.base + '/')).text()
    assert.match(html, /"label":"studio"/)
  })

  test('config "defaultChrome" selects the named chrome over alphabetical election', async () => {
    const html = await (await fetch(server.base + '/')).text()
    // Election alone would pick global/skin (alphabetically first); the
    // defaultChrome selector names theme2.
    assert.match(html, /"chromeQid":"global\/theme2"/)
  })
})

describe('env overrides config', () => {
  let server
  before(async () => { server = await startServer(FIXTURE, { ATELIER_LABEL: 'override' }) })
  after(async () => { await server?.stop() })

  test('ATELIER_LABEL wins over the config label', async () => {
    const html = await (await fetch(server.base + '/')).text()
    assert.match(html, /"label":"override"/)
    assert.doesNotMatch(html, /"label":"studio"/)
  })
})
