// shell/providers/bus-fleet.mjs — where invalidations come from, fleet column (DESIGN §1.4; PLAN
// §4.4 "Events", §4.5). The spine stream (the spine's existing stream until replica #2, then NATS)
// feeds this replica's ring: `registerEpoch(topic, epoch)` from the registrar's hello, `append(ev)`
// per accepted host push. The ring is `new EventRing()` — NO implicit adoption (protocol/events): a
// zombie host from the previous epoch can never become the accepted one. The stream client is a
// seam (`stream.subscribe(handlers)`); step 5 wires the spine's, the shell tests pass a fake.
// `snapshot(instance)`: `rev` from the registry row; `error: null` always — errors go to the agent
// (OR16), never to a member's tab.
import { EventRing, validEvent, companyTopic } from '../../protocol/index.js'
import { randomBytes } from 'node:crypto'

/**
 * createBusFleet({ registry, stream, log })
 *   stream.subscribe({ onEpoch(topic, epoch), onEvent(ev), onCompany(company) }) → unsubscribe
 */
export function createBusFleet({ registry, stream, log = () => {} }) {
  const ring = new EventRing()
  const shellEpoch = randomBytes(8).toString('hex')
  const shellStream = `shell:${shellEpoch}`
  const listeners = new Set()
  const seqs = new Map()
  const stats = { appended: 0, rejected: 0 }
  let unsub = null
  const fire = (ev) => { for (const fn of listeners) { try { fn(ev) } catch (e) { log(`bus: listener ${e.message}`) } } }
  const moduleRow = (r) => ({ id: r.slug, instance: r.instance, rev: r.rev ?? null, hasFrontend: r.hasFrontend !== false, meta: { ...(r.meta ?? {}), ...(r.primary ? { primary: true } : {}) } })

  function accept(ev) {
    if (!validEvent(ev)) { stats.rejected++; return { ok: false, reason: 'envelope' } }
    const r = ring.append(ev)
    if (!r.ok) { stats.rejected++; return r }
    stats.appended++; fire(ev); return r
  }

  return {
    kind: 'fleet', ring, shellEpoch, stats,
    start() {
      unsub = stream.subscribe({
        onEpoch: (topic, epoch) => { const r = ring.registerEpoch(topic, epoch); if (!r.ok) log(`bus: registerEpoch ${topic} ${r.reason}`) },
        onEvent: accept,
        onCompany: (company) => this.publish(companyTopic(company)),
      })
    },
    stop() { unsub?.(); unsub = null },
    publish(topic, ev = { type: 'invalidate' }) {
      if (ev?.type !== 'invalidate') throw new Error('bus: only invalidations are published')
      if (!ring.epochOf(topic)?.epoch) ring.registerEpoch(topic, shellEpoch)
      const seq = (seqs.get(topic) ?? 0) + 1; seqs.set(topic, seq)
      const frame = { stream: shellStream, topic, seq, type: 'invalidate' }
      return accept(frame).ok ? frame : null
    },
    onAppend(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    async snapshot(topic) {
      const head = ring.head(topic)
      const base = { stream: head?.stream ?? null, seq: head?.seq ?? 0 }
      if (typeof topic === 'string' && topic.startsWith('company:')) {
        const company = topic.slice('company:'.length)
        const rows = await registry.apps(company)
        const chrome = registry.chrome(company)
        return { ...base, modules: rows.map(moduleRow), chrome: { qid: chrome.qid, digest: chrome.digest }, chromeRev: chrome.digest }
      }
      const row = await registry.byInstance(topic)
      return row ? { ...base, rev: row.rev ?? null, error: null } : null
    },
    accept,
  }
}
