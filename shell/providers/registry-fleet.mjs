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
 *   spine.apps(company)  → Promise<[{instance, slug, company, meta, requested_primary, primary, rev, state, computer, chat, host}]>
 *                          `host` = the dial row of the app's OWN computer (spine v36) — the routing seam: a company owns
 *                          one host per chat it owns, so an app is proxied to the host on its row, never to host(company)
 *   spine.host(company)  → Promise<{host_id, chat, epoch, token, pod_ip, port, tls, heartbeat_at, draining_at} | null>
 *                          the company's freshest — the app-less document's "is anything up" probe only. `chat` MUST
 *                          ride this row (the spine sends it; the portal's row shaping passes it through): it is the
 *                          only wake target an app-less poll has — a row without one wakes nothing (waking.mjs says so)
 *   spine.instance(instance) → Promise<{company} | null>   the instance's company when this replica has not seen it (a fresh replica, a socket before any document)
 *   spine.wake(chat, {by}) → Promise<{ok, state:'up'|'waking'|'unconfirmed'|null, reason, error?, status}>
 *                          POST /v1/computers/<chat>/wake {by:"session:<portal session id>"} — the sleep/wake door (step 7).
 *                          `by` names who asked (the shell passes the caller's session; the spine resolves the actor and
 *                          refuses one who is not in the chat: 403); the spine also answers 503 (pool/quota) and 429 (the
 *                          fleet-wide wake bound). The portal's client encodes `chat` (encodeURIComponent, once — the shell
 *                          validates the shape, waking.mjs CHAT_RE), bounds the call (15 s) and never throws: a timeout is
 *                          `{ok:false, state:'unconfirmed', reason:'timeout'}`. Optional: without it the registry has no
 *                          `wake` and the shell's poll only probes (an older portal in front of a newer shell)
 *   spine.chrome(company) → {qid, digest, version?, base?}   the company's chrome: the row's qid and, since the first release
 *                          (step 7 ship C, spine v45), the company DEFAULT digest (`override ?? default`; null before it);
 *                          app rows and dial rows carry `chrome_digest` — the digest ITS computer reported (the sheet its
 *                          host built) — mapped to `chromeDigest` (routes.mjs chromeShape composes each document from those)
 *   spine.onCompany(fn)  → unsubscribe        fn(company) on a registry/membership change
 *   membership.present(personId, row) → boolean
 */
export function createRegistryFleet({ spine, membership, domain = 'portal.pa1nd.de', ttlMs = APPS_TTL_MS, now = Date.now }) {
  const cache = new Map()        // company → { at, rows }
  const byInst = new Map()       // instance → company
  const watchers = new Map()
  const invalidate = (company) => { cache.delete(company); for (const fn of watchers.get(company) ?? []) { try { fn() } catch {} } }
  const unsub = spine.onCompany?.((company) => invalidate(company))
  // `chat` on the dial row is the wake target (a chat owns exactly one computer); an app row's `host` may carry none — the row's own then
  const hostShape = (h, chat = null) => (h ? { hostId: h.host_id, chat: h.chat ?? chat, epoch: h.epoch, token: h.token, ip: h.pod_ip, port: h.port ?? 1845, tls: h.tls ?? null, heartbeatAt: h.heartbeat_at ?? null, drainingAt: h.draining_at ?? null, chromeDigest: h.chrome_digest ?? null } : null)

  async function apps(company) {
    const hit = cache.get(company)
    if (hit && now() - hit.at < ttlMs) return hit.rows
    const raw = (await spine.apps(company)) ?? []
    const rows = raw.map((r) => ({ instance: r.instance, slug: r.slug, company, meta: r.meta ?? {}, requestedPrimary: r.requested_primary ?? null, primary: r.primary === true, rev: r.rev ?? null, state: r.state ?? 'unknown', computer: r.computer ?? null, chat: r.chat ?? null, hasFrontend: r.hasFrontend !== false, chromeDigest: r.chrome_digest ?? null, host: hostShape(r.host ?? null, r.chat ?? null) }))
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
    // presentOnChat(personId, company, chat): the same membership rule for a CHAT — the app-less wake target
    // (host(company)'s row) is woken only for a caller present on it (routes.mjs; review 2026-09-02, C5)
    async presentOnChat(personId, company, chat) { return !!chat && !!(await membership.present(personId, { company, chat })) },
    async host(company) { return hostShape(await spine.host(company)) },
    // hostOf(row): the row's own computer — null when the spine knows no computer for it (never a fallback to
    // host(company): that is the coin toss between two live pods this seam exists to end)
    async hostOf(row) { return row?.host ?? null },
    // wake(chat, {by}): the spine's sleep/wake door; present only when the spine client has the verb (shell/waking.mjs createWaker
    // reads its absence as "probe only"). The spine rate-bounds the door; the waker holds this side to one call per chat per 30 s
    // per replica and one in flight, and reads the verdict the client answers
    ...(typeof spine.wake === 'function' ? { wake: (chat, opts) => spine.wake(chat, opts) } : {}),
    // chrome(company) → {qid, dir: null, digest, version, base}: the company DEFAULT (the app document picks its row's
    // `chromeDigest` first, routes.mjs chromeShape); `base` is where the chrome assets are (`/_chrome/<digest>` | `/modules/<qid>`)
    chrome(company) { const c = spine.chrome?.(company) ?? null; const digest = c?.digest ?? null; return { qid: c?.qid ?? null, dir: null, digest, version: c?.version ?? null, base: c?.base ?? (c?.qid ? (digest ? `/_chrome/${digest}` : `/modules/${c.qid}`) : null) } },
    watch(company, fn) { let s = watchers.get(company); if (!s) { s = new Set(); watchers.set(company, s) } s.add(fn); return () => s.delete(fn) },
    // cacheAgeMs(): the age of the OLDEST live per-company apps entry — how stale a read can still
    // be when a revocation lands (PLAN §4.5 "cache staleness at revocation"; shell/metrics.mjs
    // reads it). An expired entry is not staleness: the next read refetches. null = nothing cached.
    cacheAgeMs() {
      let oldest = null
      for (const hit of cache.values()) { const age = now() - hit.at; if (age < ttlMs && (oldest === null || age > oldest)) oldest = age }
      return oldest
    },
    invalidate,
    stale: (hostRow) => hostRow.drainingAt != null || hostRow.heartbeatAt == null || now() - hostRow.heartbeatAt > HEARTBEAT_STALE_MS,
    stop() { unsub?.() },
  }
}
