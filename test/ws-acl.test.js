// Per-frame WS access control for multi-tenant instances. The server fans every
// broadcast to every socket, so without an ACL a user receives frames for
// modules they can't see. This proves the ACL mirrors `user.workspaces[].modules`
// (the same per-module membership the rail uses): you receive a topic's frames
// iff you can see that module. Auth is the header-driven `gate` fixture.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { startServer, sleep } from './helpers.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'ws-acl')

let server
before(async () => { server = await startServer(FIXTURE, { ATELIER_AUTH: 'gate', ATELIER_REVALIDATE_MS: '400' }) })
after(async () => { await server?.stop() })

function openWs(user) {
  const ws = new WebSocket(server.base.replace('http', 'ws') + '/_atelier/ws', {
    headers: { 'x-test-user': user },
  })
  const topics = new Set()
  ws.on('message', (d) => { try { const f = JSON.parse(d.toString()); if (f.topic) topics.add(f.topic) } catch {} })
  const ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  return { ws, topics, ready }
}
async function emit(user, qid) {
  await fetch(`${server.base}/api/${qid}/emit`, { method: 'POST', headers: { 'x-test-user': user } })
}
async function ctl(p) {   // mutate the gate fixture (revoke/grant) as admin
  await fetch(`${server.base}/api/global/gate/${p}`, { method: 'POST', headers: { 'x-test-user': 'admin' } })
}

test('WS frames are gated per-module by user.workspaces (cross-org + per-module isolation)', async () => {
  const alice = openWs('alice')   // acme/kanban + global only
  const bob = openWs('bob')       // globex/kanban + global only
  await Promise.all([alice.ready, bob.ready])

  // admin (member of everything) triggers one broadcast on each topic.
  for (const qid of ['global/pub', 'acme/kanban', 'acme/secret', 'globex/kanban']) await emit('admin', qid)
  await sleep(500)
  alice.ws.close(); bob.ws.close()

  // alice: sees acme/kanban + global; must NOT see acme/secret (per-module,
  // even though she IS in workspace acme) or globex/kanban (cross-org).
  assert.ok(alice.topics.has('global/pub'), 'alice should receive global/pub')
  assert.ok(alice.topics.has('acme/kanban'), 'alice should receive acme/kanban')
  assert.ok(!alice.topics.has('acme/secret'), 'alice must NOT receive acme/secret (per-module isolation)')
  assert.ok(!alice.topics.has('globex/kanban'), 'alice must NOT receive globex/kanban (cross-org isolation)')

  // bob: globex/kanban + global only; no acme frames at all.
  assert.ok(bob.topics.has('global/pub'), 'bob should receive global/pub')
  assert.ok(bob.topics.has('globex/kanban'), 'bob should receive globex/kanban')
  assert.ok(!bob.topics.has('acme/kanban') && !bob.topics.has('acme/secret'), 'bob must NOT receive any acme frames')
})

test('revoking a session closes its live WS (periodic re-validation)', async () => {
  const alice = openWs('alice')
  await alice.ready
  let closed = false
  alice.ws.on('close', () => { closed = true })
  await ctl('revoke?user=alice')
  await sleep(1000)   // > 2× the 400ms re-validation interval
  assert.ok(closed || alice.ws.readyState !== 1, "alice's socket should be closed after revoke")
})

test('a mid-session grant starts frames flowing after re-validation', async () => {
  const bob = openWs('bob')   // globex/kanban + global; NOT acme
  await bob.ready
  await emit('admin', 'acme/kanban'); await sleep(300)
  assert.ok(!bob.topics.has('acme/kanban'), 'bob should not receive acme/kanban before the grant')
  await ctl('grant?user=bob&ws=acme&mod=kanban')
  await sleep(1000)   // re-validation refreshes bob's ws.allowed
  await emit('admin', 'acme/kanban'); await sleep(300)
  bob.ws.close()
  assert.ok(bob.topics.has('acme/kanban'), 'bob should receive acme/kanban after the grant + re-validation')
})

test('global modules are gated per-user too — there is no global exception', async () => {
  const eve = openWs('eve')   // acme/kanban only; deliberately NOT granted global/pub
  await eve.ready
  await emit('admin', 'global/pub')
  await emit('admin', 'acme/kanban')
  await sleep(400)
  eve.ws.close()
  assert.ok(eve.topics.has('acme/kanban'), 'eve should receive acme/kanban')
  assert.ok(!eve.topics.has('global/pub'), 'eve must NOT receive global/pub — global is gatable, not hardcoded-open')
})
