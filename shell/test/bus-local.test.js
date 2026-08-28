// shell/providers/bus-local.mjs — a fake dev-shell WS server: reload/backend-error/broadcast frames
// → one invalidate per topic with monotonic seq; a new healthz epoch → registerEpoch → streamChange.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { createBusLocal } from '../providers/bus-local.mjs'
import { createHostLinkLocal } from '../providers/hostlink-local.mjs'
import { createMinter } from '../minter.mjs'
import { fakeHost, fakeRegistry, TODO, WIKI } from './fixtures.mjs'

async function rig(t) {
  const host = fakeHost({ company: 'global' })
  const hp = await host.start()
  const wss = new WebSocketServer({ noServer: true })
  const sockets = new Set()
  const upgrades = []
  host.server.on('upgrade', (req, socket, head) => {
    upgrades.push(req.headers)
    if (req.headers['x-atelier-dev-token'] !== 'dev') { socket.write('HTTP/1.1 401 x\r\n\r\n'); return socket.destroy() }
    wss.handleUpgrade(req, socket, head, (ws) => { sockets.add(ws); ws.on('close', () => sockets.delete(ws)) })
  })
  const fan = (frame) => { for (const ws of sockets) ws.send(JSON.stringify(frame)) }
  const registry = fakeRegistry({ mode: 'local', companies: { global: { apps: [{ instance: TODO, slug: 'todo', rev: 3 }, { instance: WIKI, slug: 'wiki', rev: 1 }], host: { port: hp, token: 'dev' } } } })
  const refreshes = []
  registry.refresh = async (c) => { refreshes.push(c); return false }
  const logs = []
  const hostLink = createHostLinkLocal({ minter: createMinter(), dialMs: 400 })
  const bus = createBusLocal({ registry, hostLink, log: (l) => logs.push(l) })
  const appended = []
  bus.onAppend((ev) => appended.push(ev))
  bus.start()
  const until = (pred, ms = 2000) => new Promise((resolve, reject) => { const t0 = Date.now(); const tick = () => { if (pred()) return resolve(); if (Date.now() - t0 > ms) return reject(new Error('timeout')); setTimeout(tick, 10) }; tick() })
  await until(() => sockets.size === 1)
  t.after(async () => { bus.stop(); hostLink.close(); for (const ws of sockets) ws.terminate(); await host.stop() })
  return { host, fan, registry, bus, appended, logs, refreshes, until, sockets }
}

test('reload → one invalidate per topic, seq monotonic per (stream, topic); backend-error and a broadcast are invalidates too', async (t) => {
  const r = await rig(t)
  assert.equal(r.bus.links.get('global').epoch, 'e1')
  r.fan({ type: 'reload', moduleId: 'global/todo', rev: 4, topic: 'shell' })
  r.fan({ type: 'reload', moduleId: 'global/todo', rev: 5, cssOnly: true, topic: 'shell' })
  r.fan({ type: 'backend-error', qid: 'global/wiki', message: 'rev 2: backend.js:1:1 x — fix', topic: 'shell' })
  r.fan({ t: 'broadcast', kind: 'tick', payload: { secret: 1 }, topic: 'global/todo' })
  await r.until(() => r.appended.length === 4)
  assert.deepEqual(r.appended, [
    { stream: 'local:e1', topic: TODO, seq: 1, type: 'invalidate' },
    { stream: 'local:e1', topic: TODO, seq: 2, type: 'invalidate' },
    { stream: 'local:e1', topic: WIKI, seq: 1, type: 'invalidate' },
    { stream: 'local:e1', topic: TODO, seq: 3, type: 'invalidate' },
  ])
  assert.ok(!JSON.stringify(r.appended).includes('secret'), 'payloads are never delivered')
  assert.deepEqual(r.bus.ring.head(TODO), { stream: 'local:e1', seq: 3 })
  // the shell-minted rail frame rides its own stream
  const c = r.bus.publish('company:global')
  assert.equal(c.stream, `shell:${r.bus.shellEpoch}`); assert.equal(c.seq, 1)
  assert.equal(r.bus.ring.epochOf('company:global').epoch, r.bus.shellEpoch)
})

test('an unknown qid triggers a registry rescan; the chrome qid publishes the company topic', async (t) => {
  const r = await rig(t)
  r.fan({ type: 'reload', moduleId: 'global/newapp', rev: 1, topic: 'shell' })
  await r.until(() => r.refreshes.length === 1)
  assert.deepEqual(r.refreshes, ['global'])
  assert.equal(r.bus.stats.unknown, 1)
  assert.equal(r.appended.length, 0)
  r.fan({ type: 'reload', moduleId: 'global/catalyst-chrome', rev: 9, topic: 'shell' })
  await r.until(() => r.appended.length === 1)
  assert.equal(r.appended[0].topic, 'company:global')
})

test('a new healthz epoch re-registers every topic of the host: since() is streamChange for every old cursor; snapshot carries rev + the last build error', async (t) => {
  const r = await rig(t)
  r.fan({ type: 'reload', moduleId: 'global/todo', rev: 4, topic: 'shell' })
  await r.until(() => r.appended.length === 1)
  const cursor = { stream: 'local:e1', seq: 1 }
  assert.deepEqual(r.bus.ring.since(TODO, cursor), { events: [], gap: false, streamChange: false })
  // the host restarts: the socket drops, healthz answers a new epoch, the bus reconnects
  r.host.state.epoch = 'e2'
  for (const ws of r.sockets) ws.terminate()
  await r.until(() => r.bus.links.get('global').epoch === 'e2', 4000)
  assert.equal(r.bus.ring.since(TODO, cursor).streamChange, true)
  assert.equal(r.bus.ring.since(WIKI, { stream: 'local:e1', seq: 0 }).streamChange, true)
  await r.until(() => r.sockets.size === 1, 4000)
  r.fan({ type: 'reload', moduleId: 'global/todo', rev: 5, topic: 'shell' })
  await r.until(() => r.appended.length === 2)
  assert.deepEqual(r.appended[1], { stream: 'local:e2', topic: TODO, seq: 1, type: 'invalidate' })
  // snapshots
  r.host.state.events[TODO] = [{ kind: 'build', rev: 4, message: 'backend.js:2:1 Expected ")"', hint: 'fix the syntax at that position', file: 'backend.js', line: 2, col: 1 }, { kind: 'worker', rev: 3, message: 'old' }]
  const snap = await r.bus.snapshot(TODO)
  assert.equal(snap.rev, 3)
  assert.deepEqual(snap.stream, 'local:e2'); assert.equal(snap.seq, 1)
  assert.equal(snap.error.message, 'backend.js:2:1 Expected ")"'); assert.equal(snap.error.hint, 'fix the syntax at that position')
  r.host.state.events[TODO] = [{ kind: 'build', rev: 2, message: 'older than the running rev' }]
  assert.equal((await r.bus.snapshot(TODO)).error, null)
  const rail = await r.bus.snapshot('company:global')
  assert.deepEqual(rail.modules.map((m) => m.id), ['todo', 'wiki'])
  assert.equal(rail.chrome.qid, 'global/catalyst-chrome')
  assert.equal(await r.bus.snapshot('i-0000000000000000'), null)
})
