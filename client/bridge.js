// bridge.js — the tab's side of the events socket (shell/DESIGN.md §4 "per-topic cursors +
// resume" and "the foreground hook"; the port of design/atelier2/r2/spike-mobile-safari-1/
// lab-bridge2.js onto protocol/events' frame set). One socket per document, many topics.
//
// Wire (protocol/events): tab → shell `sub {topics}` · `resume {topic, stream, seq}` · `pong {at}`;
// shell → tab `subscribed | resumed | denied | gap | invalidate | ping`.
//
// Per topic the bridge keeps `{stream, seq, pending}` ACROSS sockets: a new socket sends `resume`
// for every topic with a cursor and `sub` for the rest. `subscribed` → snapshot; `resumed` →
// nothing; `gap` → one snapshot, then `resume`; a frame whose seq ≠ cursor+1 is treated as a gap;
// frames arriving while a snapshot is in flight are buffered and those with seq ≤ snapshot.seq
// dropped (C4 surprise 7); a stream change → snapshot. Snapshots are `GET /_atelier/topics/<t>`.
//
// Liveness never comes from `readyState`, `online` or `navigator.onLine` — they lie on a corpse
// (mobile-safari-1). While visible the bridge probes a silent socket every PING_MS with an
// idempotent `resume` of a cursored topic (the client message set has no ping; any frame back
// answers the probe); no answer within PING_MS = dead → kill() + reconnect at once. A `sub` that
// is not acked within SUB_ACK_MS on an open socket is the same verdict. The foreground hook
// (visibilitychange / online / pageshow(persisted)) measures `hiddenFor` with Date.now()
// (performance.now() may not advance in iPhone sleep): hidden > STALE_HIDE_MS or a bfcache
// restore → reconnect at once, else probe with a FG_PONG_MS budget. A false kill costs one
// reconnect and N idempotent resumes.
//
// Handlers receive: {type:'snapshot', topic, snapshot} · {type:'invalidate', topic, seq, stream} ·
// {type:'denied', topic} · {type:'waking', topic}. The `atelier:connection` banner state
// ('online' | 'offline' | 'unauthed') is reported through `onState`.
//
// Everything the browser owns is injected (WebSocket, fetch, clock, timers, visibility) so the
// state machine runs under node --test.

export const PING_MS = 1000
export const FG_PONG_MS = 500
export const STALE_HIDE_MS = 30_000
export const SUB_ACK_MS = 2000
export const OFFLINE_GRACE_MS = 2500
export const BACKOFF_MIN_MS = 250
export const BACKOFF_MAX_MS = 5000
export const SNAPSHOT_RETRY_MIN_MS = 1000
export const SNAPSHOT_RETRY_MAX_MS = 10_000

export function hiddenFor(hiddenAt, now) {
  return hiddenAt == null ? null : Math.max(0, now - hiddenAt)
}

// The foreground rule: reconnect at once after a bfcache restore or > STALE_HIDE_MS hidden.
export function reconnectOnForeground(how, hidden) {
  return how === 'pageshow' || (hidden != null && hidden > STALE_HIDE_MS)
}

export function createBridge({
  url, WebSocket, fetch, now = () => Date.now(),
  setTimeout, clearTimeout, setInterval, clearInterval,
  isHidden = () => false, onState = () => {},
  snapshotUrl = (topic) => `/_atelier/topics/${encodeURIComponent(topic)}`,
  whoamiUrl = '/_atelier/whoami',
  log = () => {},
}) {
  const topics = new Map()   // topic → st
  let ws = null, backoff = BACKOFF_MIN_MS, reconnectTimer = null, pingTimer = null, fgTimer = null
  let probeAt = null, lastFrameAt = 0, hiddenAt = null, connState = 'online', offlineTimer = null
  let inflight = 0, sockets = 0, stopped = false

  const st = (topic) => {
    let s = topics.get(topic)
    if (!s) {
      s = { stream: null, seq: 0, pending: null, handlers: new Set(), denied: false, acked: true, sentAt: null, retry: null, retryTimer: null,
            gaps: 0, snapshots: 0, received: 0, dup: 0, errors: [] }
      topics.set(topic, s)
    }
    return s
  }
  const open = () => !!ws && ws.readyState === 1
  const send = (msg) => { if (!open()) return false; try { ws.send(JSON.stringify(msg)); return true } catch { return false } }
  const emit = (s, topic, ev) => { for (const fn of s.handlers) { try { fn(ev) } catch (err) { log('handler threw', err) } } }

  function setState(next) {
    if (connState === next) return
    connState = next
    try { onState(next) } catch {}
  }
  function armOfflineTimer() {
    if (offlineTimer) return
    offlineTimer = setTimeout(async () => {
      offlineTimer = null
      if (open()) return
      try {
        const r = await fetch(whoamiUrl, { cache: 'no-store', credentials: 'same-origin' })
        if (r.status === 200) return
        if (r.status === 401) { setState('unauthed'); return }
        setState('offline')
      } catch { setState('offline') }
    }, OFFLINE_GRACE_MS)
  }
  function clearOfflineTimer() { if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null } }

  // ---- socket lifecycle
  function wanted() { return [...topics.entries()].filter(([, s]) => s.handlers.size > 0 && !s.denied) }
  function announce(topic, s) {
    s.acked = false; s.sentAt = now()
    if (s.stream) send({ op: 'resume', topic, stream: s.stream, seq: s.seq })
    else send({ op: 'sub', topics: [topic] })
  }
  function connect(reason) {
    if (stopped) return
    if (ws && ws.readyState <= 1) return
    clearTimeout(reconnectTimer); reconnectTimer = null
    let s
    try { s = new WebSocket(url) } catch { armOfflineTimer(); scheduleReconnect(); return }
    ws = s; sockets++; probeAt = null
    log('connect', { n: sockets, reason })
    s.onopen = () => {
      if (s !== ws) return
      backoff = BACKOFF_MIN_MS; lastFrameAt = now(); probeAt = null
      clearOfflineTimer(); setState('online')
      for (const [topic, t] of wanted()) announce(topic, t)
    }
    s.onmessage = (m) => { if (s !== ws) return; let f; try { f = JSON.parse(m.data) } catch { return } onFrame(f) }
    s.onclose = (e) => { if (s !== ws) return; ws = null; probeAt = null; log('close', { code: e && e.code }); armOfflineTimer(); scheduleReconnect() }
    s.onerror = () => {}
  }
  function scheduleReconnect() {
    if (stopped) return
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => connect('backoff'), backoff)
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
  }
  function kill(reason) {
    const s = ws
    if (!s) { connect('after-' + reason); return }
    log('dead', { reason, readyState: s.readyState })
    s.onmessage = s.onclose = s.onerror = s.onopen = null
    ws = null; probeAt = null
    try { s.close() } catch {}
    backoff = BACKOFF_MIN_MS
    connect('after-' + reason)
  }

  // ---- frames
  function onFrame(f) {
    if (!f || typeof f !== 'object') return
    lastFrameAt = now(); probeAt = null
    if (f.type === 'ping') { send({ op: 'pong', at: f.at }); return }
    if (typeof f.topic !== 'string') return
    const s = topics.get(f.topic)
    if (!s) return
    switch (f.type) {
      case 'subscribed': {
        s.acked = true
        // A `sub` sent right after a snapshot at the same head (a null-stream resume fallback): the
        // state is already consistent at this cursor — no second snapshot.
        if (s.snapshots > 0 && s.pending === null && f.stream === s.stream && f.seq === s.seq) return
        s.stream = f.stream; s.seq = f.seq
        snapshot(f.topic, false)
        return
      }
      case 'resumed': s.acked = true; return
      case 'denied': s.acked = true; s.denied = true; emit(s, f.topic, { type: 'denied', topic: f.topic }); return
      case 'gap': s.acked = true; s.gaps++; s.pending = s.pending || []; snapshot(f.topic, true); return
      case 'invalidate': {
        if (s.pending) { s.pending.push(f); return }
        if (s.stream && f.stream !== s.stream) { s.pending = [f]; snapshot(f.topic, false); return }
        apply(s, f)
        return
      }
      default: return
    }
  }
  function apply(s, f) {
    if (f.seq <= s.seq) { s.dup++; return }
    if (f.seq !== s.seq + 1) {                 // a hole the ring cannot see → treated as a gap
      s.gaps++; s.pending = []; snapshot(f.topic, true); return
    }
    if (s.stream === null) s.stream = f.stream
    s.seq = f.seq; s.received++
    emit(s, f.topic, { type: 'invalidate', topic: f.topic, seq: f.seq, stream: f.stream })
  }
  async function snapshot(topic, resume) {
    const s = st(topic)
    if (s.retryTimer) { clearTimeout(s.retryTimer); s.retryTimer = null }
    s.snapshots++; s.pending = s.pending || []; inflight++
    let snap = null
    try {
      const r = await fetch(snapshotUrl(topic), { cache: 'no-store', credentials: 'same-origin' })
      if (r.status === 401) { setState('unauthed'); s.pending = null; return }
      if (r.status === 503) { emit(s, topic, { type: 'waking', topic }); throw new Error('waking') }
      if (!r.ok) throw new Error('HTTP ' + r.status)
      snap = await r.json()
      if (!snap || typeof snap !== 'object' || !Number.isInteger(snap.seq)) throw new Error('bad snapshot')
    } catch (e) {
      s.errors.push(`snapshot ${topic}: ${e.message}`)
      s.pending = null
      s.retry = s.retry == null ? SNAPSHOT_RETRY_MIN_MS : Math.min(s.retry * 2, SNAPSHOT_RETRY_MAX_MS)
      s.retryTimer = setTimeout(() => { s.retryTimer = null; if (s.handlers.size) snapshot(topic, resume) }, s.retry)
      return
    } finally { inflight-- }
    s.retry = null
    s.stream = snap.stream ?? null; s.seq = snap.seq
    const pend = s.pending; s.pending = null
    emit(s, topic, { type: 'snapshot', topic, snapshot: snap })
    for (let i = 0; i < pend.length; i++) {
      const f = pend[i]
      if (s.pending !== null) { s.pending.push(...pend.slice(i)); break }    // a nested snapshot started: hand it the rest
      if (f.stream !== snap.stream || f.seq <= snap.seq) continue
      apply(s, f)
    }
    if (resume && open()) {
      if (s.stream) send({ op: 'resume', topic, stream: s.stream, seq: s.seq })
      else send({ op: 'sub', topics: [topic] })       // no stream yet (empty ring): only `sub` is a valid message
      s.acked = false; s.sentAt = now()
    }
  }

  // ---- liveness
  function probe() {
    if (!open()) return false
    for (const [topic, s] of wanted()) {
      if (s.stream) { probeAt = now(); send({ op: 'resume', topic, stream: s.stream, seq: s.seq }); return true }
    }
    return false
  }
  function tick() {
    if (!open() || isHidden()) return
    const t = now()
    if (probeAt !== null) { if (t - probeAt >= PING_MS) kill('ping-timeout'); return }
    for (const [, s] of wanted()) {
      if (!s.acked && s.sentAt != null && t - s.sentAt >= SUB_ACK_MS) { kill('sub-timeout'); return }
    }
    if (t - lastFrameAt < PING_MS) return
    probe()
  }
  function onHidden() { if (hiddenAt === null) hiddenAt = now() }
  function onForeground(how) {
    const hf = hiddenFor(hiddenAt, now()); hiddenAt = null
    log('fg', { how, hiddenFor: hf })
    if (!ws) { connect('fg-' + how); return }
    if (ws.readyState !== 1) return                       // still connecting; onclose/backoff handles it
    if (reconnectOnForeground(how, hf)) { kill(how === 'pageshow' ? 'bfcache-restore' : 'stale-after-hide'); return }
    probeAt = null
    if (!probe()) return
    clearTimeout(fgTimer)
    fgTimer = setTimeout(() => { fgTimer = null; if (probeAt !== null) kill('fg-ping-timeout') }, FG_PONG_MS)
  }

  // ---- api
  function subscribe(topic, handler) {
    if (!topic || typeof handler !== 'function') return () => {}
    const s = st(topic)
    const fresh = s.handlers.size === 0
    s.handlers.add(handler)
    if (!ws) connect('subscribe')
    else if (fresh && open() && !s.denied) announce(topic, s)
    return () => {
      const t = topics.get(topic)
      if (!t) return
      t.handlers.delete(handler)
    }
  }
  function start() { if (!pingTimer) pingTimer = setInterval(tick, PING_MS); connect('start') }
  function stop() {
    stopped = true
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
    clearTimeout(reconnectTimer); clearTimeout(fgTimer); clearOfflineTimer()
    for (const s of topics.values()) if (s.retryTimer) { clearTimeout(s.retryTimer); s.retryTimer = null }
    const s = ws; ws = null
    if (s) { s.onmessage = s.onclose = s.onerror = s.onopen = null; try { s.close() } catch {} }
  }
  function state() {
    const o = {}
    for (const [t, s] of topics) o[t] = { stream: s.stream, seq: s.seq, pending: s.pending ? s.pending.length : null, gaps: s.gaps, snapshots: s.snapshots, received: s.received, dup: s.dup, denied: s.denied, errors: s.errors.length, err0: s.errors[0] || null, handlers: s.handlers.size }
    return { topics: o, inflight, open: open(), sockets, connState, probing: probeAt !== null }
  }
  function mark() { for (const s of topics.values()) { s.gaps = 0; s.snapshots = 0; s.received = 0; s.dup = 0; s.errors = [] } }

  return { subscribe, start, stop, connect, kill, tick, onHidden, onForeground, state, mark }
}
