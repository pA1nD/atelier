// Characterizes the explicit auth model: auth is opt-in via the `auth` setting
// (here injected as ATELIER_AUTH). A module exporting `authenticate` only gates
// when it's the configured one — so an instance can't be silently gated, nor
// silently exposed. Verifies allow/deny, handleUnauth ownership, whoami 200/401,
// gated module API, public shell assets, and the ungated-by-default path.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from './helpers.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'ws-auth')
const authed = { headers: { 'x-test-auth': 'ok' } }

describe('auth configured (auth = gate)', () => {
  let server
  before(async () => { server = await startServer(FIXTURE, { ATELIER_AUTH: 'gate' }) })
  after(async () => { await server?.stop() })

  test('index 401 without auth — handleUnauth owns the response', async () => {
    const r = await fetch(server.base + '/')
    assert.equal(r.status, 401)
    assert.equal((await r.json()).error, 'unauthorized')
  })

  test('index 200 with auth', async () => {
    const r = await fetch(server.base + '/', authed)
    assert.equal(r.status, 200)
    assert.match(await r.text(), /window\.__ATELIER__/)
  })

  test('whoami: 401 unauth, 200 + id authed', async () => {
    assert.equal((await fetch(server.base + '/_atelier/whoami')).status, 401)
    const r = await fetch(server.base + '/_atelier/whoami', authed)
    assert.equal(r.status, 200)
    assert.equal((await r.json()).id, 'tester')
  })

  test('module API is gated: 401 unauth, reachable authed', async () => {
    assert.equal((await fetch(server.base + '/api/global/gate/me')).status, 401)
    const r = await fetch(server.base + '/api/global/gate/me', authed)
    assert.equal(r.status, 200)
    assert.equal((await r.json()).id, 'tester')
  })

  test('shell assets stay public (client.js loads before auth)', async () => {
    assert.equal((await fetch(server.base + '/assets/client.js')).status, 200)
  })
})

describe('authenticate present but auth NOT configured → ungated', () => {
  let server
  before(async () => { server = await startServer(FIXTURE) })   // no ATELIER_AUTH
  after(async () => { await server?.stop() })

  test('a stray authenticate export does not gate the shell', async () => {
    const r = await fetch(server.base + '/_atelier/whoami')
    assert.equal(r.status, 200)
    assert.equal((await r.json()).id, 'local')
  })

  test('index serves normally (no takeover)', async () => {
    const r = await fetch(server.base + '/')
    assert.equal(r.status, 200)
    assert.match(await r.text(), /window\.__ATELIER__/)
  })
})
