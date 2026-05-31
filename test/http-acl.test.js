// HTTP-side multi-tenant authorization — the twin of ws-acl.test.js. The server
// dispatches every authed request to the module router, so without a gate any
// logged-in user could call any module's API cross-tenant. This proves the two
// TRUSTED layers in front of the (untrusted) module router:
//   1. presence — the request's module must be in user.workspaces, else 403.
//   2. authorize — the auth module's below-module hook: read/write + payload.
// Enforcement lives in the shell + the gate module; the feature modules below
// do no checks of their own. Auth is the header-driven `gate` fixture.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from './helpers.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'http-acl')

const as = (user) => ({ headers: { 'x-test-user': user } })
const post = (user, body) => ({
  method: 'POST',
  headers: { 'x-test-user': user, 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('HTTP presence gate + authorize (auth = gate)', () => {
  let server
  before(async () => { server = await startServer(FIXTURE, { ATELIER_AUTH: 'gate' }) })
  after(async () => { await server?.stop() })

  test('presence: a cross-tenant API call is 403 and never reaches the module', async () => {
    // alice has acme/board + global/pub; globex is another org's workspace.
    const r = await fetch(`${server.base}/api/globex/board/items`, as('alice'))
    assert.equal(r.status, 403)
    assert.equal((await r.json()).error, 'forbidden')
    // The module never ran: bob (who CAN see it) reads it still empty.
    const g = await fetch(`${server.base}/api/globex/board/items`, as('bob'))
    assert.deepEqual((await g.json()).items, [])
  })

  test('authorize: a read grant allows GET but denies POST (write)', async () => {
    // alice: acme/board = READ only.
    assert.equal((await fetch(`${server.base}/api/acme/board/items`, as('alice'))).status, 200)
    const w = await fetch(`${server.base}/api/acme/board/items`, post('alice', { title: 'nope' }))
    assert.equal(w.status, 403)
    // Denied write never reached the handler → acme/board is still empty.
    const after = await fetch(`${server.base}/api/acme/board/items`, as('alice'))
    assert.deepEqual((await after.json()).items, [])
  })

  test('authorize: a write grant allows POST, and the handler sees the body authorize already read', async () => {
    const r = await fetch(`${server.base}/api/acme/board/items`, post('admin', { title: 'ship it' }))
    assert.equal(r.status, 200)
    const j = await r.json()
    assert.deepEqual(j.received, { title: 'ship it' })   // memoized body survived authorize's read
    assert.equal(j.count, 1)
  })

  test('authorize: payload-level deny — it reads req.json down to content', async () => {
    const r = await fetch(`${server.base}/api/acme/board/items`, post('admin', { danger: true }))
    assert.equal(r.status, 403)
  })

  test('the auth module\'s own routes are exempt from both gates', async () => {
    // global/gate is in nobody's workspaces, yet any authed user reaches it —
    // you can't gate the gate.
    const r = await fetch(`${server.base}/api/global/gate/whoami`, as('alice'))
    assert.equal(r.status, 200)
    assert.equal((await r.json()).id, 'alice')
  })

  test('infrastructure modules (chrome/hidden) are exempt from the presence gate', async () => {
    // global/widget is `hidden` → in nobody's workspaces, so the presence gate
    // would 403 it; but infra (a chrome, or its /docs API) must reach every
    // authed user. alice has no widget grant, yet reaches it.
    const r = await fetch(`${server.base}/api/global/widget/ping`, as('alice'))
    assert.equal(r.status, 200)
    assert.equal((await r.json()).infra, true)
  })

  test('unauthenticated → handleUnauth owns the 401', async () => {
    assert.equal((await fetch(`${server.base}/api/acme/board/items`)).status, 401)
  })
})

describe('ungated instance — the gate block is a no-op', () => {
  let server
  before(async () => { server = await startServer(FIXTURE) })   // no ATELIER_AUTH
  after(async () => { await server?.stop() })

  test('any module API is reachable; the presence gate never fires', async () => {
    const r = await fetch(`${server.base}/api/globex/board/items`)
    assert.equal(r.status, 200)
  })
})
