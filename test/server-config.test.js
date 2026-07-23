// Characterizes the v2 settings model: defaults ← atelier.config.json ← env.
// The ws-settings fixture sets { label: "studio", defaultChrome: "theme2" }; two
// chromes exist (skin, theme2) so the `defaultChrome` selector is proven to
// override alphabetical election (which would pick "skin").
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
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

describe('host setting', () => {
  // The machine's first dialable IPv4, if it has one — lets these tests prove
  // real off-loopback reachability, not just "the option didn't crash boot".
  const lanIp = Object.values(os.networkInterfaces()).flat()
    .find((a) => a && a.family === 'IPv4' && !a.internal)?.address

  describe('default stays loopback-only', () => {
    let server
    before(async () => { server = await startServer(FIXTURE) })
    after(async () => { await server?.stop() })

    test('the LAN address refuses connections', { skip: !lanIp && 'no non-loopback IPv4 on this machine' }, async () => {
      await assert.rejects(fetch(`http://${lanIp}:${server.port}/`))
    })
  })

  describe('HOST=0.0.0.0 exposes the instance', () => {
    let server
    before(async () => { server = await startServer(FIXTURE, { HOST: '0.0.0.0' }) })
    after(async () => { await server?.stop() })

    test('loopback still answers', async () => {
      assert.equal((await fetch(server.base + '/')).status, 200)
    })

    test('the LAN address answers', { skip: !lanIp && 'no non-loopback IPv4 on this machine' }, async () => {
      assert.equal((await fetch(`http://${lanIp}:${server.port}/`)).status, 200)
    })

    test('ungated + exposed prints the footgun warning', async () => {
      assert.match(server.output(), /auth is off and host is 0\.0\.0\.0/)
    })
  })
})

describe('observe flag', () => {
  describe('default off', () => {
    let server
    before(async () => { server = await startServer(FIXTURE) })
    after(async () => { await server?.stop() })

    test('/_atelier/inflight does not exist', async () => {
      assert.equal((await fetch(`${server.base}/_atelier/inflight`)).status, 404)
    })
  })

  describe('ATELIER_OBSERVE=1', () => {
    let server
    before(async () => { server = await startServer(FIXTURE, { ATELIER_OBSERVE: '1' }) })
    after(async () => { await server?.stop() })

    test('/_atelier/inflight serves a snapshot with a monotonic total', async () => {
      const a = await (await fetch(`${server.base}/_atelier/inflight`)).json()
      assert.equal(typeof a.total, 'number')
      assert.ok(Array.isArray(a.inflight))
      const b = await (await fetch(`${server.base}/_atelier/inflight`)).json()
      assert.ok(b.total > a.total, `total should grow (${a.total} → ${b.total})`)
    })
  })
})
