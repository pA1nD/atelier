// shell/providers/registry-fleet.mjs — which apps exist, fleet column (DESIGN §1.2; PLAN §4.1
// presence, §4.5 caches; host/DESIGN §7 for the rows the registrar writes). The read side of the
// spine registrar: `GET /v1/companies/<c>/apps` cached per replica with a TTL and invalidated by
// the spine's `company:<id>` frames (the same topic the rail uses); the computer row for
// `host()`; presence = membership of the app's chat (protocol/membership, OR20). The spine client
// and the membership model are seams (`spine`, `membership`) — step 5 wires the real ones, the
// shell tests pass fakes. `company(host)` parses `<c>.<domain>`.
export const APPS_TTL_MS = 5000
export const HEARTBEAT_STALE_MS = 30_000

/**
 * createRegistryFleet({ spine, membership, domain, ttlMs, now })
 *   spine.apps(company)  → Promise<[{instance, slug, company, meta, requested_primary, primary, rev, state, computer}]>
 *   spine.host(company)  → Promise<{host_id, epoch, token, pod_ip, port, tls, heartbeat_at, draining_at} | null>
 *   spine.instance(instance) → Promise<{company} | null>   the instance's company when this replica has not seen it (a fresh replica, a socket before any document)
 *   spine.chrome(company) → {qid, digest}
 *   spine.onCompany(fn)  → unsubscribe        fn(company) on a registry/membership change
 *   membership.present(personId, row) → boolean
 */
export function createRegistryFleet({ spine, membership, domain = 'portal.pa1nd.de', ttlMs = APPS_TTL_MS, now = Date.now }) {
  const cache = new Map()        // company → { at, rows }
  const byInst = new Map()       // instance → company
  const watchers = new Map()
  const invalidate = (company) => { cache.delete(company); for (const fn of watchers.get(company) ?? []) { try { fn() } catch {} } }
  const unsub = spine.onCompany?.((company) => invalidate(company))

  async function apps(company) {
    const hit = cache.get(company)
    if (hit && now() - hit.at < ttlMs) return hit.rows
    const raw = (await spine.apps(company)) ?? []
    const rows = raw.map((r) => ({ instance: r.instance, slug: r.slug, company, meta: r.meta ?? {}, requestedPrimary: r.requested_primary ?? null, primary: r.primary === true, rev: r.rev ?? null, state: r.state ?? 'unknown', computer: r.computer ?? null, chat: r.chat ?? null, hasFrontend: r.hasFrontend !== false }))
    cache.set(company, { at: now(), rows })
    for (const r of rows) byInst.set(r.instance, company)
    return rows
  }

  return {
    kind: 'fleet',
    company(host) {
      const h = String(host ?? '').replace(/:\d+$/, '').toLowerCase()
      if (!h.endsWith('.' + domain)) return null
      const c = h.slice(0, -(domain.length + 1))
      return c && !c.includes('.') ? c : null
    },
    companies() { return [] },     // the picker lives on the portal
    apps,
    async resolve(company, slug) { return (await apps(company)).find((r) => r.slug === slug) ?? null },
    async byInstance(instance) {
      let c = byInst.get(instance)
      if (!c && spine.instance) c = (await spine.instance(instance))?.company ?? null
      if (c) { const row = (await apps(c)).find((r) => r.instance === instance); if (row) return row }
      return null
    },
    async present(personId, instance) {
      const row = await this.byInstance(instance)
      return !!row && !!(await membership.present(personId, row))
    },
    async host(company) {
      const h = await spine.host(company)
      if (!h) return null
      return { hostId: h.host_id, epoch: h.epoch, token: h.token, ip: h.pod_ip, port: h.port ?? 1845, tls: h.tls ?? null, heartbeatAt: h.heartbeat_at ?? null, drainingAt: h.draining_at ?? null }
    },
    chrome(company) { const c = spine.chrome?.(company) ?? null; return { qid: c?.qid ?? null, dir: null, digest: c?.digest ?? null } },
    watch(company, fn) { let s = watchers.get(company); if (!s) { s = new Set(); watchers.set(company, s) } s.add(fn); return () => s.delete(fn) },
    invalidate,
    stale: (hostRow) => hostRow.drainingAt != null || hostRow.heartbeatAt == null || now() - hostRow.heartbeatAt > HEARTBEAT_STALE_MS,
    stop() { unsub?.() },
  }
}
