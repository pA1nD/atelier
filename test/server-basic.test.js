// Integration characterization of the running shell against an un-gated
// workspace (no auth module): discovery, scoped routing, asset build +
// private-by-name + traversal guards, identity probe, SPA fallback,
// reserved-prefix 404, and the WS multiplex round-trip.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { startServer } from './helpers.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'ws-basic')

let server
before(async () => { server = await startServer(FIXTURE) })
after(async () => { await server?.stop() })

test('serves index HTML with the injected bootstrap', async () => {
  const r = await fetch(server.base + '/')
  assert.equal(r.status, 200)
  const html = await r.text()
  assert.match(html, /window\.__ATELIER__/)
  assert.match(html, /"chromeQid"/)
})

test('bootstrap reflects discovery — globals + the $team workspace', async () => {
  const html = await (await fetch(server.base + '/')).text()
  assert.match(html, /"alpha"/)
  assert.match(html, /"beta"/)
  assert.match(html, /"team"/)   // $team discovered + surfaced as a workspace
})

test('no chrome installed → chromeQid is null (shell ships no default)', async () => {
  const html = await (await fetch(server.base + '/')).text()
  assert.match(html, /"chromeQid":null/)
})

test('the removed cross-module registry is absent from the client bundle', async () => {
  const code = await (await fetch(server.base + '/assets/client.js')).text()
  assert.doesNotMatch(code, /callModule|registerModule/)
})

test('workspace module routes under /api/<ws>/<id> with workspace-aware ctx', async () => {
  const r = await fetch(server.base + '/api/team/gamma/ping')
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.qid, 'team/gamma')
  assert.equal(j.ws, 'team')
})

test('workspace module assets serve under /modules/<ws>/<id>', async () => {
  const r = await fetch(server.base + '/modules/team/gamma/frontend.js')
  assert.equal(r.status, 200)
})

test('oversized request body is rejected, not buffered (memory-DoS guard)', async () => {
  const huge = 'x'.repeat(11 * 1024 * 1024)   // 11 MB, over the 10 MB cap
  let status = null
  try {
    const r = await fetch(server.base + '/api/global/beta/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ huge }),
    })
    status = r.status
  } catch {
    status = 'dropped'   // server may cut the connection rather than reply
  }
  assert.ok(status === 413 || status === 'dropped', `expected 413 or a dropped connection, got ${status}`)
  assert.notEqual(status, 200)
})

test('module API answers under /api/<ws>/<id> (scoped router)', async () => {
  const r = await fetch(server.base + '/api/global/beta/ping')
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.ok, true)
  assert.equal(j.qid, 'global/beta')
  assert.equal(j.ws, 'global')
})

test('compiles frontend.jsx → JS at /modules/<ws>/<id>/frontend.js', async () => {
  const r = await fetch(server.base + '/modules/global/alpha/frontend.js')
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type') || '', /javascript/)
  assert.match(await r.text(), /createElement/)
})

test('private-by-name asset guards deny backend.js + dotfiles', async () => {
  assert.equal((await fetch(server.base + '/modules/global/beta/backend.js')).status, 404)
  assert.equal((await fetch(server.base + '/modules/global/beta/.env')).status, 404)
})

test('path traversal in module assets is denied', async () => {
  const r = await fetch(server.base + '/modules/global/alpha/..%2f..%2fpackage.json')
  assert.equal(r.status, 404)
})

test('a symlink escaping the module dir is denied (realpath containment)', async () => {
  // Plant a symlink INSIDE the module pointing at a real file OUTSIDE it.
  // Lexical path.resolve would pass it; the realpath re-check must reject it.
  const link = path.join(FIXTURE, 'alpha', 'escape.txt')
  const target = path.join(HERE, '..', 'server.js')   // real, outside the module
  try { fs.unlinkSync(link) } catch {}
  fs.symlinkSync(target, link)
  try {
    const r = await fetch(server.base + '/modules/global/alpha/escape.txt')
    assert.equal(r.status, 404)
  } finally {
    fs.unlinkSync(link)
  }
})

test('/_atelier/whoami returns identity JSON (no auth → local)', async () => {
  const r = await fetch(server.base + '/_atelier/whoami')
  assert.equal(r.status, 200)
  assert.equal((await r.json()).id, 'local')
})

test('SPA fallback serves index for /<ws>/<id>', async () => {
  const r = await fetch(server.base + '/global/alpha')
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type') || '', /text\/html/)
})

test('unmatched API route 404s under the reserved prefix (no HTML)', async () => {
  assert.equal((await fetch(server.base + '/api/global/beta/nope')).status, 404)
})

test('WS multiplex: a module broadcast reaches a subscriber', async () => {
  const ws = new WebSocket(server.base.replace('http', 'ws') + '/_atelier/ws')
  const frame = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no matching frame in time')), 9000)
    ws.on('open', () => {
      fetch(server.base + '/api/global/beta/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'ws' }),
      }).catch(reject)
    })
    ws.on('message', (data) => {
      let f
      try { f = JSON.parse(data.toString()) } catch { return }
      if (f.topic === 'global/beta' && f.type === 'echo') { clearTimeout(timer); resolve(f) }
    })
    ws.on('error', reject)
  })
  ws.close()
  assert.equal(frame.body.hello, 'ws')
})
