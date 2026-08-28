// shell/events.mjs — the C4 / mobile-safari rows with an in-process ring and a `ws` client.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { WebSocket } from 'ws'
import { createEventsSocket } from '../events.mjs'
import { EventRing, CLOSE_EVICTED } from '../../protocol/index.js'

const A = 'i-aaaaaaaaaaaaaaaa', B = 'i-bbbbbbbbbbbbbbbb', FOREIGN = 'i-ffffffffffffffff'
const rows = { [A]: { instance: A, company: 'acme', slug: 'a' }, [B]: { instance: B, company: 'acme', slug: 'b' }, [FOREIGN]: { instance: FOREIGN, company: 'other', slug: 'f' } }

function fakeBus() {
  const ring = new EventRing({ adoptFirst: true })
  const listeners = new Set()
  const seqs = new Map()
  return {
    ring,
    onAppend(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    emit(topic, n = 1, stream = 'local:e1') {
      for (let i = 0; i < n; i++) {
        const key = `${stream}|${topic}`; const s = (seqs.get(key) ?? 0) + 1; seqs.set(key, s)
        const ev = { stream, topic, seq: s, type: 'invalidate' }
        const r = ring.append(ev); if (!r.ok) throw new Error(r.reason)
        for (const fn of listeners) fn(ev)
      }
    },
  }
}
const registry = { byInstance: async (i) => rows[i] ?? null, present: async (personId, i) => personId === 'p1' || i === B }

async function rig(t, opts = {}) {
  const bus = fakeBus()
  const paused = new Set()
  const events = createEventsSocket({ bus, registry, buffered: (ws) => (paused.has(ws) ? Infinity : ws.bufferedAmount), ...opts })
  const server = http.createServer((req, res) => { res.writeHead(404); res.end() })
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://x')
    events.upgrade(req, socket, head, { person: { id: u.searchParams.get('p') ?? 'p1', name: 'P' }, company: u.searchParams.get('c') ?? 'acme', credential: 'none' })
  })
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
  const clients = []
  const open = (qs = '') => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/_atelier/ws?${qs}`)
    ws.frames = []; ws.on('message', (d) => ws.frames.push(JSON.parse(d)))
    ws.on('open', () => resolve(ws)); ws.on('error', reject); clients.push(ws)
  })
  const until = (ws, pred, ms = 2000) => new Promise((resolve, reject) => {
    const t0 = Date.now(); const tick = () => { const f = ws.frames.find(pred); if (f) return resolve(f); if (Date.now() - t0 > ms) return reject(new Error('timeout waiting for ' + pred)); setTimeout(tick, 5) }; tick()
  })
  const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms))
  const close = async () => { for (const c of clients) { try { c.terminate() } catch {} } events.close(); await new Promise((r) => server.close(r)) }
  t.after(close)
  // paused: server-side ws objects the fake `buffered` reports as stalled — `r.stall(i)` names the i-th connection
  const stall = (i, on = true) => { const c = [...events.conns][i]; if (on) paused.add(c.ws); else paused.delete(c.ws) }
  return { bus, events, open, until, settle, close, paused, clients, stall }
}
const sendJson = (ws, m) => ws.send(JSON.stringify(m))

test('sub → subscribed at head; frames contiguous; the company topic; app-level pong is answered with ping', async (t) => {
  const r = await rig(t)
  const ws = await r.open()
  sendJson(ws, { op: 'sub', topics: [A, 'company:acme'] })
  assert.deepEqual(await r.until(ws, (f) => f.type === 'subscribed' && f.topic === A), { type: 'subscribed', topic: A, stream: null, seq: 0 })
  assert.deepEqual(await r.until(ws, (f) => f.type === 'subscribed' && f.topic === 'company:acme'), { type: 'subscribed', topic: 'company:acme', stream: null, seq: 0 })
  r.bus.emit(A, 3)
  await r.until(ws, (f) => f.type === 'invalidate' && f.seq === 3)
  assert.deepEqual(ws.frames.filter((f) => f.type === 'invalidate').map((f) => [f.topic, f.stream, f.seq]), [[A, 'local:e1', 1], [A, 'local:e1', 2], [A, 'local:e1', 3]])
  // a second socket subscribing now gets the head (3), no replay
  const ws2 = await r.open()
  sendJson(ws2, { op: 'sub', topics: [A] })
  assert.deepEqual(await r.until(ws2, (f) => f.type === 'subscribed'), { type: 'subscribed', topic: A, stream: 'local:e1', seq: 3 })
  sendJson(ws2, { op: 'pong', at: 77 })
  assert.deepEqual(await r.until(ws2, (f) => f.type === 'ping'), { type: 'ping', at: 77 })
})

test('300 events on a paused socket → exactly one gap, delivery stopped until resume, then contiguous', async (t) => {
  const r = await rig(t)
  const ws = await r.open()
  sendJson(ws, { op: 'sub', topics: [A, B] })
  await r.until(ws, (f) => f.type === 'subscribed' && f.topic === B)
  r.bus.emit(A, 2)
  await r.until(ws, (f) => f.type === 'invalidate' && f.seq === 2)
  r.stall(0)
  r.bus.emit(A, 300)      // > ring 256 while the socket is stalled: the cursor stays at 2
  r.bus.emit(B, 40)       // < ring: B stays contiguous
  await r.settle(60)
  assert.equal(ws.frames.filter((f) => f.type === 'gap').length, 0, 'nothing is decided while stalled')
  r.stall(0, false)
  await r.until(ws, (f) => f.type === 'gap', 1000)
  await r.until(ws, (f) => f.type === 'invalidate' && f.topic === B && f.seq === 40)
  await r.settle(60)
  const gaps = ws.frames.filter((f) => f.type === 'gap')
  assert.deepEqual(gaps, [{ type: 'gap', topic: A, stream: 'local:e1' }])
  const aFrames = ws.frames.filter((f) => f.type === 'invalidate' && f.topic === A).map((f) => f.seq)
  assert.deepEqual(aFrames, [1, 2], 'delivery on A stopped after the gap')
  const bFrames = ws.frames.filter((f) => f.type === 'invalidate' && f.topic === B).map((f) => f.seq)
  assert.deepEqual(bFrames, Array.from({ length: 40 }, (_, i) => i + 1))
  // more events on A while gapped: still nothing
  r.bus.emit(A, 5)
  await r.settle(40)
  assert.equal(ws.frames.filter((f) => f.type === 'invalidate' && f.topic === A).length, 2)
  // the tab snapshots (head = 307) and resumes from there → resumed, then contiguous
  const head = r.bus.ring.head(A)
  sendJson(ws, { op: 'resume', topic: A, stream: head.stream, seq: head.seq })
  assert.deepEqual(await r.until(ws, (f) => f.type === 'resumed'), { type: 'resumed', topic: A, stream: 'local:e1', seq: 307 })
  r.bus.emit(A, 3)
  await r.until(ws, (f) => f.type === 'invalidate' && f.topic === A && f.seq === 310)
  assert.deepEqual(ws.frames.filter((f) => f.type === 'invalidate' && f.topic === A).map((f) => f.seq), [1, 2, 308, 309, 310])
  assert.equal(r.events.stats.gaps, 1)
})

test('resume behind the head replays the contiguous tail; resume with a stale stream → gap (streamChange); resume on a fresh ring → gap', async (t) => {
  const r = await rig(t)
  r.bus.emit(A, 10)
  const ws = await r.open()
  sendJson(ws, { op: 'resume', topic: A, stream: 'local:e1', seq: 7 })
  await r.until(ws, (f) => f.type === 'resumed')
  assert.deepEqual(ws.frames.map((f) => [f.type, f.seq]), [['invalidate', 8], ['invalidate', 9], ['invalidate', 10], ['resumed', 10]])
  // the host restarted: a new epoch on the topic; the old cursor is a streamChange
  r.bus.ring.registerEpoch(A, 'e2')
  ws.frames.length = 0
  sendJson(ws, { op: 'resume', topic: A, stream: 'local:e1', seq: 10 })
  assert.deepEqual(await r.until(ws, (f) => f.type === 'gap'), { type: 'gap', topic: A, stream: 'local:e1' })
  assert.equal(ws.frames.some((f) => f.type === 'resumed'), false)
  // events on the new stream do not reach the gapped topic; a resume on the new stream does
  r.bus.emit(A, 2, 'local:e2')
  await r.settle(30)
  assert.equal(ws.frames.filter((f) => f.type === 'invalidate').length, 0)
  sendJson(ws, { op: 'resume', topic: A, stream: 'local:e2', seq: 2 })
  assert.deepEqual(await r.until(ws, (f) => f.type === 'resumed'), { type: 'resumed', topic: A, stream: 'local:e2', seq: 2 })
  // a topic with no ring at all: resume → gap (the ring cannot vouch)
  sendJson(ws, { op: 'resume', topic: B, stream: 'local:e1', seq: 3 })
  assert.deepEqual(await r.until(ws, (f) => f.type === 'gap' && f.topic === B), { type: 'gap', topic: B, stream: 'local:e1' })
})

test('denied: a foreign instance, an unknown instance, shell, another company topic — and no frame ever leaks', async (t) => {
  const r = await rig(t)
  const ws = await r.open('p=p2')     // p2 is present on B only
  sendJson(ws, { op: 'sub', topics: [A, B, FOREIGN, 'shell', 'company:other', 'company:acme', 'i-0000000000000000'] })
  await r.until(ws, (f) => f.type === 'subscribed' && f.topic === 'company:acme')
  await r.settle(30)
  const denied = ws.frames.filter((f) => f.type === 'denied').map((f) => f.topic).sort()
  assert.deepEqual(denied, [A, FOREIGN, 'company:other', 'i-0000000000000000', 'shell'].sort())
  assert.deepEqual(ws.frames.filter((f) => f.type === 'subscribed').map((f) => f.topic).sort(), [B, 'company:acme'].sort())
  r.bus.emit(A, 3); r.bus.emit(FOREIGN, 3); r.bus.emit(B, 1)
  await r.until(ws, (f) => f.type === 'invalidate' && f.topic === B)
  await r.settle(30)
  assert.deepEqual(ws.frames.filter((f) => f.type === 'invalidate').map((f) => f.topic), [B])
  // resume on a denied topic is denied too
  sendJson(ws, { op: 'resume', topic: A, stream: 'local:e1', seq: 1 })
  await r.settle(30)
  assert.equal(ws.frames.filter((f) => f.type === 'denied' && f.topic === A).length, 2)
  assert.equal(r.events.stats.denied, 6)
})

test('server ping: 2 misses → terminate; a live socket survives', async (t) => {
  const r = await rig(t, { pingMs: 60, misses: 2 })
  const live = await r.open()
  const zombie = await r.open()
  zombie._socket.pause()             // reads nothing → never pongs (the corpse of mobile-safari-1)
  await r.settle(60 * 4)
  assert.equal(r.events.stats.reaped, 1)
  assert.equal(r.events.conns.size, 1)
  assert.equal([...r.events.conns][0].ws.readyState, 1)
  assert.equal(r.events.liveCount('p1', 'acme'), 1)
  zombie._socket.resume()
  await r.settle(30)
  assert.equal(live.readyState, 1)
})

test('budget: the 9th socket evicts the oldest non-live with 4001', async (t) => {
  const r = await rig(t, { pingMs: 60, misses: 10, budget: 8 })
  const socks = []
  for (let i = 0; i < 8; i++) socks.push(await r.open())
  const closed = new Map()
  for (const [i, s] of socks.entries()) s.on('close', (code) => closed.set(i, code))
  // make #2 non-live (misses a ping), the rest answer
  socks[2]._socket.pause()
  await r.settle(60 * 2 + 20)
  assert.equal(r.events.liveCount('p1', 'acme'), 7)
  // 7 live < 8: a 9th fits without eviction
  socks.push(await r.open())
  await r.settle(20)
  assert.equal(r.events.stats.evicted, 0)
  // now 8 live: the 10th evicts — the oldest NON-live (#2), not #0
  socks.push(await r.open())
  await r.settle(30)
  assert.equal(r.events.stats.evicted, 1)
  socks[2]._socket.resume()
  await r.settle(60)
  assert.equal(closed.get(2), CLOSE_EVICTED)
  assert.equal(closed.has(0), false)
  assert.equal(socks[0].readyState, 1)
  // all live now: the next one evicts the oldest (#0)
  socks.push(await r.open())
  await r.settle(60)
  assert.equal(closed.get(0), CLOSE_EVICTED)
})
