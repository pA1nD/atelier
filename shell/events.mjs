// shell/events.mjs — the document socket `/_atelier/ws` (DESIGN §3.4; PLAN §4.4 "Events", §4.5;
// seeds spike-c4/shell.js and r2/spike-mobile-safari-1/shell.js, ported onto protocol/events).
//
// One socket per document. The upgrade already ran lanes 0–4c and 6 (routes.mjs); this file gets
// the resolved person, the document's company and the credential. Per (socket, topic) a cursor
// {stream, seq, gapped}:
//   sub {topics}     → ACL per topic (denied: no frame ever leaks) → cursor = ring head → `subscribed`
//   resume {…}       → ring.since(topic, cursor): contiguous events replayed then `resumed` at head;
//                      gap or streamChange → `gap {topic, stream}` and delivery on that (socket, topic)
//                      STOPS until the next `resume` (the tab snapshots first)
//   pong {at}        → marks the socket pong-live and is answered with `ping {at}` (the same `at`) —
//                      the tab's 1 s liveness round trip inside the protocol frame set
// Fan-out: bus.onAppend → pump every subscribed, non-gapped socket. Gap detection keys on CURSOR
// LAG through ring.since(), never on bufferedAmount (C4 surprise 3): a socket whose userland
// buffer is past `highWater` keeps its cursor and is retried in 20 ms; when the ring has rotated
// past that cursor the retry finds a gap. Liveness (§4.5, pinned in protocol): `ws.ping()` every
// SERVER_PING_MS, SERVER_PING_MISSES → terminate; the per-(person, company) budget SOCKET_BUDGET
// counts pong-live sockets only and evicts the oldest non-live (else the oldest) with CLOSE_EVICTED.
// ACL: an instance topic needs a registry row the person is present on (and, when the socket has
// a company, the row's company); `company:<c>` is the socket's own company only; `shell` and any
// other reserved topic → denied.
import { WebSocketServer } from 'ws'
import { frames, isFrame, isClientMessage, isReservedTopic, companyTopic, SERVER_PING_MS, SERVER_PING_MISSES, SOCKET_BUDGET, CLOSE_EVICTED } from '../protocol/index.js'

export const HIGH_WATER = 64 * 1024
export const RETRY_MS = 20
export { SERVER_PING_MS, SERVER_PING_MISSES, SOCKET_BUDGET, CLOSE_EVICTED }

/**
 * createEventsSocket({ bus, registry, log, now, pingMs, misses, budget, highWater, buffered, setTimer, clearTimer })
 *   bus:      { ring, onAppend(fn) → unsubscribe }
 *   registry: { byInstance(instance) → Promise<AppRow|null>, present(personId, instance) → Promise<boolean> }
 *   buffered: (ws) → bytes queued (tests inject a stall)
 */
export function createEventsSocket({ bus, registry, log = () => {}, now = Date.now, pingMs = SERVER_PING_MS, misses: maxMisses = SERVER_PING_MISSES, budget = SOCKET_BUDGET, highWater = HIGH_WATER, buffered = (ws) => ws.bufferedAmount, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  const conns = new Set()
  const byTopic = new Map()     // topic → Set<conn>
  const byKey = new Map()       // `${person}\n${company}` → Set<conn>
  const stats = { opened: 0, sent: 0, gaps: 0, denied: 0, reaped: 0, evicted: 0, stalls: 0 }
  let seq = 0

  const send = (conn, frame) => {
    if (!isFrame(frame)) throw new Error('events: refusing to send a non-frame ' + JSON.stringify(frame))
    if (conn.ws.readyState !== 1) return false
    try { conn.ws.send(JSON.stringify(frame)); stats.sent++; return true } catch { return false }
  }
  const keyOf = (conn) => `${conn.person.id}\n${conn.company ?? ''}`
  const liveOf = (set) => [...set].filter((c) => c.misses === 0)

  async function allowed(conn, topic) {
    if (typeof topic !== 'string' || !topic) return false
    if (topic.startsWith('company:')) return !!conn.company && topic === companyTopic(conn.company)
    if (isReservedTopic(topic)) return false
    const row = await registry.byInstance(topic)
    if (!row) return false
    if (conn.company && row.company !== conn.company) return false
    return !!(await registry.present(conn.person.id, topic))
  }

  function subscribe(conn, topic, sub) {
    conn.subs.set(topic, sub)
    let s = byTopic.get(topic); if (!s) { s = new Set(); byTopic.set(topic, s) } s.add(conn)
  }

  // pump(conn, topic, ack): deliver what the ring holds past the cursor; a gap stops the topic
  function pump(conn, topic, ack = null) {
    const sub = conn.subs.get(topic)
    if (!sub || sub.gapped || conn.ws.readyState !== 1) return
    if (buffered(conn.ws) > highWater) {
      stats.stalls++
      if (!conn.retry) conn.retry = setTimer(() => { conn.retry = null; for (const t of conn.subs.keys()) pump(conn, t) }, RETRY_MS)
      return
    }
    const cursor = sub.stream ? { stream: sub.stream, seq: sub.seq } : null
    const r = bus.ring.since(topic, cursor)
    const gap = r.gap || (cursor ? r.streamChange : r.events.length > 0 && r.events[0].seq !== 1)
    if (gap) { sub.gapped = true; stats.gaps++; send(conn, frames.gap({ topic, stream: sub.stream })); return }
    for (const ev of r.events) {
      if (buffered(conn.ws) > highWater) { stats.stalls++; if (!conn.retry) conn.retry = setTimer(() => { conn.retry = null; for (const t of conn.subs.keys()) pump(conn, t) }, RETRY_MS); return }
      if (!send(conn, frames.invalidate(ev))) return
      sub.stream = ev.stream; sub.seq = ev.seq
    }
    if (ack) send(conn, frames[ack]({ topic, stream: sub.stream, seq: sub.seq }))
  }

  async function onMessage(conn, data) {
    let m; try { m = JSON.parse(data) } catch { return }
    if (!isClientMessage(m)) { log(`events: ignored message ${String(data).slice(0, 80)}`); return }
    if (m.op === 'pong') { conn.alive = true; conn.misses = 0; conn.pongAt = now(); send(conn, frames.ping({ at: m.at })); return }
    if (m.op === 'sub') {
      for (const topic of m.topics) {
        if (!(await allowed(conn, topic))) { stats.denied++; send(conn, frames.denied({ topic })); continue }
        if (conn.ws.readyState !== 1) return
        const head = bus.ring.head(topic)
        subscribe(conn, topic, { stream: head?.stream ?? null, seq: head?.seq ?? 0, gapped: false })
        send(conn, frames.subscribed({ topic, stream: head?.stream ?? null, seq: head?.seq ?? 0 }))
      }
      return
    }
    if (m.op === 'resume') {
      if (!(await allowed(conn, m.topic))) { stats.denied++; send(conn, frames.denied({ topic: m.topic })); return }
      if (conn.ws.readyState !== 1) return
      subscribe(conn, m.topic, { stream: m.stream, seq: m.seq, gapped: false })
      pump(conn, m.topic, 'resumed')
    }
  }

  function onConnection(ws, { person, company = null, credential = 'none' }) {
    const conn = { id: ++seq, ws, person, company, credential, subs: new Map(), alive: true, misses: 0, openedAt: now(), pongAt: now(), retry: null }
    const key = keyOf(conn)
    let set = byKey.get(key); if (!set) { set = new Set(); byKey.set(key, set) }
    if (liveOf(set).length >= budget) {
      const sorted = [...set].sort((a, b) => a.openedAt - b.openedAt)
      const victim = sorted.find((c) => c.misses > 0) ?? sorted[0]
      stats.evicted++
      log(`events: budget ${budget} for ${person.id}@${company ?? '-'} — evicting socket #${victim.id} (${victim.misses ? 'non-live' : 'oldest'})`)
      try { victim.ws.close(CLOSE_EVICTED, 'socket budget') } catch {}
      drop(victim)
    }
    set.add(conn); conns.add(conn); stats.opened++
    ws.on('pong', () => { conn.alive = true; conn.misses = 0; conn.pongAt = now() })
    ws.on('message', (data) => { onMessage(conn, data).catch((e) => log(`events: message: ${e?.stack ?? e}`)) })
    ws.on('close', () => drop(conn))
    ws.on('error', () => drop(conn))
  }
  function drop(conn) {
    if (!conns.has(conn)) return
    conns.delete(conn)
    const set = byKey.get(keyOf(conn)); if (set) { set.delete(conn); if (!set.size) byKey.delete(keyOf(conn)) }
    for (const t of conn.subs.keys()) { const s = byTopic.get(t); if (s) { s.delete(conn); if (!s.size) byTopic.delete(t) } }
    if (conn.retry) { clearTimer(conn.retry); conn.retry = null }
  }

  const unsub = bus.onAppend((ev) => { for (const conn of byTopic.get(ev.topic) ?? []) pump(conn, ev.topic) })
  const pinger = setInterval(() => {
    for (const conn of conns) {
      if (!conn.alive) {
        conn.misses++
        if (conn.misses >= maxMisses) { stats.reaped++; log(`events: socket #${conn.id} ${conn.person.id} missed ${conn.misses} pings — terminate`); try { conn.ws.terminate() } catch {}; drop(conn); continue }
      }
      conn.alive = false
      try { conn.ws.ping() } catch {}
    }
  }, pingMs)
  pinger.unref?.()

  return {
    // upgrade(req, socket, head, ctx) — ctx = {person, company, credential} from routes.mjs
    upgrade(req, socket, head, ctx) { wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ctx)) },
    // publishTopic(topic): re-pump every subscriber (the bus calls onAppend; this is for a registerEpoch with no event yet)
    pump(topic) { for (const conn of byTopic.get(topic) ?? []) pump(conn, topic) },
    close() { clearInterval(pinger); unsub?.(); for (const conn of [...conns]) { try { conn.ws.terminate() } catch {}; drop(conn) } },
    conns, stats, byTopic, liveCount: (personId, company) => liveOf(byKey.get(`${personId}\n${company ?? ''}`) ?? new Set()).length,
  }
}
