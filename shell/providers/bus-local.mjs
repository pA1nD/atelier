// shell/providers/bus-local.mjs — where invalidations come from, local column (DESIGN §1.4).
//
// In-proc from the host's events: one WebSocket per host to `ws://127.0.0.1:<devPort>/_atelier/ws`
// with `x-atelier-dev-token`; the dev shell's 1.x frames are MAPPED, never forwarded:
//   {type:'reload', moduleId:'<ws>/<slug>', rev, topic:'shell'} → append({stream:'local:<hostEpoch>', topic:<instance>, seq, type:'invalidate'})
//   {type:'backend-error', qid, message}                       → the same invalidate (the snapshot carries the error)
//   a worker broadcast {…event, topic:'<ws>/<slug>'}            → an invalidate on that instance (the payload is not
//                                                                delivered — 2.0 events are invalidations, §4.4; "buffered
//                                                                ctx.broadcast" is a documented 1.x break, §4.8)
//   a reload for the chrome qid                                 → `company:<c>` on every company (chromeRev moved → full reload)
// seq is per (stream, topic), minted here; `<hostEpoch>` from `/_host/healthz`. The ring is
// `new EventRing({adoptFirst:true})` — the local opt-in. A host restart (a new healthz epoch) →
// `ring.registerEpoch(topic, newEpoch)` for every app of that host → every tab's next `resume` is a
// streamChange → one snapshot. Shell-minted frames (`company:<c>`) ride stream `shell:<shellEpoch>`.
// Reconnects back off 250 ms → 5 s; a socket that never opens is not an error the operator sees
// more than once per backoff step. SKIPPED: the spine stream client, epoch registration from the
// registrar's hello, the per-host ingest rate limit.
import { randomBytes } from 'node:crypto'
import { WebSocket } from 'ws'
import { EventRing, validEvent, companyTopic } from '../../protocol/index.js'
import { DEV_TOKEN_HEADER } from './hostlink-local.mjs'

export const RECONNECT_MS = { min: 250, max: 5000 }
export const SNAPSHOT_ERROR_KINDS = new Set(['build', 'css', 'load'])

/**
 * createBusLocal({ registry, hostLink, log, now, WebSocketImpl, setTimer, clearTimer })
 *   registry: the local registry (companies, apps, byInstance, host, chrome, resolve, refresh, noteProbe)
 */
export function createBusLocal({ registry, hostLink, log = () => {}, now = Date.now, WebSocketImpl = WebSocket, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const ring = new EventRing({ adoptFirst: true })
  const shellEpoch = randomBytes(8).toString('hex')
  const shellStream = `shell:${shellEpoch}`
  const listeners = new Set()
  const seqs = new Map()          // `${stream}|${topic}` → last seq
  const links = new Map()         // company → { ws, epoch, timer, backoff, stopped }
  const stats = { appended: 0, rejected: 0, unknown: 0, reconnects: 0 }
  let started = false

  function append(stream, topic) {
    const key = `${stream}|${topic}`
    const seq = (seqs.get(key) ?? 0) + 1
    seqs.set(key, seq)
    const ev = { stream, topic, seq, type: 'invalidate' }
    if (!validEvent(ev)) throw new Error('bus: minted an invalid event ' + JSON.stringify(ev))
    const r = ring.append(ev)
    if (!r.ok) { stats.rejected++; log(`bus: ring refused ${topic} ${r.reason}`); return null }
    stats.appended++
    for (const fn of listeners) { try { fn(ev) } catch (e) { log(`bus: listener ${e.message}`) } }
    return ev
  }

  async function invalidateQid(company, qid, why) {
    const [c, slug] = String(qid).split('/')
    let row = c && slug ? await registry.resolve(c, slug) : null
    if (!row) {
      stats.unknown++
      await registry.refresh(company)                      // a qid the shell does not know: rescan (DESIGN §1.2 watch)
      row = c && slug ? await registry.resolve(c, slug) : null
      if (!row) { log(`bus: ${why} for unknown ${qid} — rescanned, still unknown`); return null }
    }
    const link = links.get(company)
    const epoch = link?.epoch ?? (await registry.host(company))?.epoch
    if (!epoch) { log(`bus: ${why} for ${qid} before the host's epoch is known — dropped`); return null }
    return append(`local:${epoch}`, row.instance)
  }

  async function onFrame(company, frame) {
    if (!frame || typeof frame !== 'object') return
    const chromeQid = registry.chrome(company)?.qid
    if (frame.type === 'reload' && typeof frame.moduleId === 'string') {
      if (chromeQid && frame.moduleId === chromeQid) { for (const c of registry.companies()) publish(companyTopic(c.id)); return }
      return invalidateQid(company, frame.moduleId, 'reload')
    }
    if (frame.type === 'backend-error' && typeof frame.qid === 'string') return invalidateQid(company, frame.qid, 'backend-error')
    if (typeof frame.topic === 'string' && frame.topic !== 'shell' && frame.topic.includes('/')) return invalidateQid(company, frame.topic, 'broadcast')
  }

  async function adoptEpoch(company, epoch) {
    const link = links.get(company)
    if (!link || !epoch || link.epoch === epoch) return false
    const rows = await registry.apps(company)
    for (const r of rows) ring.registerEpoch(r.instance, epoch)
    if (link.epoch) log(`bus: ${company} host epoch ${link.epoch} → ${epoch} (${rows.length} topics re-registered)`)
    link.epoch = epoch
    return true
  }

  function connect(company) {
    const link = links.get(company)
    if (!link || link.stopped || link.ws) return
    ;(async () => {
      const hostRow = await registry.host(company)
      if (!hostRow?.port || !hostRow.token) return schedule(company)
      const probe = await hostLink.probe(hostRow)
      registry.noteProbe?.(company, probe)
      if (!probe.ok) return schedule(company)
      await adoptEpoch(company, probe.epoch)
      const ws = new WebSocketImpl(`ws://${hostRow.ip}:${hostRow.port}/_atelier/ws`, { headers: { [DEV_TOKEN_HEADER]: hostRow.token } })
      link.ws = ws
      ws.on('open', () => { link.backoff = RECONNECT_MS.min; log(`bus: ${company} connected to the host on ${hostRow.port}`) })
      ws.on('message', (data) => { let f; try { f = JSON.parse(data) } catch { return } onFrame(company, f).catch((e) => log(`bus: frame ${e.message}`)) })
      ws.on('close', () => { link.ws = null; schedule(company) })
      ws.on('error', (e) => { log(`bus: ${company} socket ${e.code ?? e.message}`); try { ws.close() } catch {} })
    })().catch((e) => { log(`bus: ${company} connect ${e.message}`); schedule(company) })
  }
  function schedule(company) {
    const link = links.get(company)
    if (!link || link.stopped || link.timer) return
    stats.reconnects++
    link.timer = setTimer(() => { link.timer = null; connect(company) }, link.backoff)
    link.timer.unref?.()
    link.backoff = Math.min(link.backoff * 2, RECONNECT_MS.max)
  }

  function publish(topic, ev = { type: 'invalidate' }) {
    if (ev?.type !== 'invalidate') throw new Error('bus: only invalidations are published')
    if (!ring.epochOf(topic)?.epoch) ring.registerEpoch(topic, shellEpoch)
    return append(shellStream, topic)
  }

  const moduleRow = (r) => ({ id: r.slug, instance: r.instance, rev: r.rev ?? null, hasFrontend: r.hasFrontend !== false, meta: { ...(r.meta ?? {}), ...(r.primary ? { primary: true } : {}) } })

  async function snapshot(topic) {
    const head = ring.head(topic)
    const base = { stream: head?.stream ?? null, seq: head?.seq ?? 0 }
    if (typeof topic === 'string' && topic.startsWith('company:')) {
      const company = topic.slice('company:'.length)
      const rows = (await registry.apps(company)).filter((r) => !r.isChrome)
      const chrome = registry.chrome(company)
      return { ...base, modules: rows.map(moduleRow), chrome: { qid: chrome.qid, digest: chrome.digest }, chromeRev: chrome.digest }
    }
    let row = await registry.byInstance(topic)
    if (!row) return null
    // the snapshot answers an invalidate the host just sent: read the host's row NOW (the registry's
    // 5 s view may still carry the previous rev — a fixed save would otherwise keep the old error)
    try { await registry.refresh?.(row.company); row = (await registry.byInstance(topic)) ?? row } catch {}
    let error = null
    const hostRow = await registry.host(row.company)
    if (hostRow?.port) {
      try {
        const r = await hostLink.json({ hostRow, path: `/_atelier/events?app=${encodeURIComponent(row.instance)}` })
        const events = r.status === 200 && Array.isArray(r.json) ? r.json : []
        const last = [...events].reverse().find((e) => SNAPSHOT_ERROR_KINDS.has(e.kind) && (row.rev == null || e.rev >= row.rev))
        if (last) error = { message: last.message, hint: last.hint ?? null, file: last.file ?? null, line: last.line ?? null, col: last.col ?? null, rev: last.rev, kind: last.kind }
      } catch (e) { log(`bus: snapshot ${topic}: ${e.code ?? e.message}`) }
    }
    return { ...base, rev: row.rev ?? null, error }
  }

  return {
    kind: 'local', ring, shellEpoch, stats, links,
    start() {
      if (started) return
      started = true
      for (const c of registry.companies()) { links.set(c.id, { ws: null, epoch: null, timer: null, backoff: RECONNECT_MS.min, stopped: false }); ring.registerEpoch(companyTopic(c.id), shellEpoch); connect(c.id) }
    },
    stop() {
      started = false
      for (const [, link] of links) { link.stopped = true; if (link.timer) { clearTimer(link.timer); link.timer = null } try { link.ws?.terminate() } catch {} link.ws = null }
      links.clear()
    },
    publish,
    onAppend(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    snapshot,
    // invalidate(company, instance): a direct append for the drill's fake host (and tests)
    async invalidate(company, instance) { const link = links.get(company); const epoch = link?.epoch ?? (await registry.host(company))?.epoch; return epoch ? append(`local:${epoch}`, instance) : null },
    // reprobe(company): a document-route probe result reaches the bus (a new epoch re-registers the topics)
    async reprobe(company, probe) { if (probe?.ok) return adoptEpoch(company, probe.epoch); return false },
  }
}
