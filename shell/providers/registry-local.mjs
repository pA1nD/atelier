// shell/providers/registry-local.mjs — which apps exist, local column (DESIGN §1.2, §5.3).
//
// Folder discovery is the shell's (lane B's `shell/local/discover.mjs`, injected as `discover()`),
// joined with each workspace's host dev registry `GET /_atelier/apps` (token) for {instance, rev,
// state} on the same slug. One host per non-empty workspace; `company` = the workspace id, `global`
// included. `present()` is always true — one person, every app is theirs (the local provider's
// ANSWER, not a skip). `primary` = module.json's value (no portal to apply it). `watch()` fires when
// the mount table changed: on `refresh()` (lane B's apps-root fs.watch and the bus's unknown-qid
// frame call it) and on the unref'd 5 s poll of `/_atelier/apps` (the safety net — one bounded
// tick, a log line only on change, never a foreground wait).
// SKIPPED: the spine round trip, caches with epoch invalidation, computer rows, presence from
// chats, `draining_at`, tombstones (the host's registry.json keeps its own).
import fs from 'node:fs'
import path from 'node:path'

export const APPS_TTL_MS = 1000
export const POLL_MS = 5000
export const CHROME_DIGEST_TTL_MS = 1000

// chromeDigest(dir): the chrome folder's max mtime (ms, integer) — `chromeRev` in the bootstrap
export function chromeDigest(dir) {
  let m = 0
  const skip = new Set(['node_modules', 'data'])
  const walk = (d) => {
    let names; try { names = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const ent of names) {
      if (ent.name.startsWith('.') || skip.has(ent.name)) continue
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) walk(p); else { try { m = Math.max(m, fs.statSync(p).mtimeMs) } catch {} }
    }
  }
  walk(dir)
  return Math.floor(m)
}

/**
 * createRegistryLocal({ workspaces, discover, chrome, hostLink, log, now, pollMs, ttlMs })
 *   workspaces() → [{ id, port, token }]                 lane B (hosts.mjs): one host per workspace
 *   discover()   → [{ workspace, id, dir, meta, hasFrontend, hasBackend }]   lane B (discover.mjs), sync
 *   chrome       → { qid, dir } | null                    the elected chrome (one per run)
 *   hostLink     → { json({hostRow, path}) }
 */
export function createRegistryLocal({ workspaces, discover, chrome = null, hostLink, log = () => {}, now = Date.now, pollMs = POLL_MS, ttlMs = APPS_TTL_MS }) {
  const hostView = new Map()      // company → { at, rows: [{instance, slug, company, rev, state}] | null }
  const probes = new Map()        // company → { heartbeatAt, epoch }
  const unreachable = new Map()   // company → at (the last failed /_atelier/apps fetch; cleared on success)
  const lastRows = new Map()      // company → the last rows /_atelier/apps answered (never dropped by refresh/poll: the stale rows)
  const watchers = new Map()      // company → Set<fn>
  const shapes = new Map()        // company → the last mount-table shape (for change detection)
  let chromeCache = null, poll = null

  const wsRow = (company) => (workspaces() ?? []).find((w) => w.id === company) ?? null
  const hostRow = (company) => {
    const w = wsRow(company)
    if (!w) return null
    const p = probes.get(company)
    return { hostId: 'local', epoch: p?.epoch ?? null, token: w.token ?? null, ip: '127.0.0.1', port: w.port, tls: null, heartbeatAt: p?.heartbeatAt ?? null, drainingAt: null }
  }

  async function hostApps(company) {
    const hit = hostView.get(company)
    if (hit && now() - hit.at < ttlMs) return hit.rows
    const row = hostRow(company)
    let rows = null
    if (row?.port) {
      try {
        const r = await hostLink.json({ hostRow: row, path: '/_atelier/apps' })
        rows = r.status === 200 && Array.isArray(r.json) ? r.json : null
        if (rows) { lastRows.set(company, rows); probes.set(company, { ...(probes.get(company) ?? {}), heartbeatAt: now() }); unreachable.delete(company) }
      } catch (e) {
        // unreachable (a stopped or restarting host): serve the last known rows — the mount table
        // does not vanish because the computer sleeps; the proxy answers 503 waking meanwhile
        rows = hit?.rows ?? lastRows.get(company) ?? null   // refresh()/the poll drop hostView first — lastRows survives them
        unreachable.set(company, now())
        if (!hit?.stale) log(`registry: ${company} host unreachable (${e.code ?? e.message}) — serving ${rows ? rows.length + ' stale rows' : 'no rows'}`)
        hostView.set(company, { at: now(), rows, stale: true })
        return rows
      }
    }
    hostView.set(company, { at: now(), rows })
    return rows
  }

  function folderRows(company) {
    return (discover() ?? []).filter((r) => r.workspace === company && !r.meta?.isChrome)
  }

  async function apps(company) {
    const folders = folderRows(company)
    const host = (await hostApps(company)) ?? []
    const out = []
    for (const f of folders) {
      const h = host.find((r) => r.slug === f.id)
      if (!h) continue                                    // not claimed by the host yet (or a non-slug id refused by lane B)
      const meta = { ...(f.meta ?? {}) }
      const primary = meta.primary === true
      delete meta.primary; delete meta.isChrome
      out.push({ instance: h.instance, slug: f.id, company, meta: { name: meta.name ?? f.id, ...(meta.icon ? { icon: meta.icon } : {}), ...(meta.group ? { group: meta.group } : {}), ...(meta.color ? { color: meta.color } : {}) }, requestedPrimary: primary, primary, rev: h.rev ?? null, state: h.state ?? 'unknown', hasFrontend: f.hasFrontend !== false, dir: f.dir })
    }
    // the chrome staged as an app (its backend answers /api/global/<chrome>/…, DESIGN §8): keep the row, hidden from the rail
    if (chrome?.qid) {
      const [cc, cs] = chrome.qid.split('/')
      const h = cc === company ? host.find((r) => r.slug === cs) : null
      if (h) out.push({ instance: h.instance, slug: cs, company, meta: { name: cs }, requestedPrimary: false, primary: false, rev: h.rev ?? null, state: h.state ?? 'unknown', hasFrontend: false, isChrome: true, dir: chrome.dir })
    }
    return out
  }

  const shapeOf = (rows) => JSON.stringify(rows.map((r) => [r.slug, r.instance, r.rev, r.state, r.meta, r.primary]))
  async function check(company, { fire = true } = {}) {
    const rows = await apps(company)
    const s = shapeOf(rows)
    const changed = shapes.has(company) && shapes.get(company) !== s
    shapes.set(company, s)
    if (changed) { log(`registry: ${company} changed (${rows.length} apps)`); if (fire) for (const fn of watchers.get(company) ?? []) { try { fn() } catch (e) { log(`registry: watcher ${e.message}`) } } }
    return changed
  }

  return {
    kind: 'local',
    company() { return null },
    companies() { return (workspaces() ?? []).map((w) => ({ id: w.id, name: w.id, href: `/${w.id}/` })) },
    apps,
    async resolve(company, slug) { return (await apps(company)).find((r) => r.slug === slug) ?? null },
    async byInstance(instance) {
      for (const w of workspaces() ?? []) { const row = (await apps(w.id)).find((r) => r.instance === instance); if (row) return row }
      return null
    },
    async present() { return true },
    async host(company) { return hostRow(company) },
    async hostOf(row) { return hostRow(row?.company) },     // one host per workspace: the row's company names it
    chrome() {
      if (!chrome?.qid) return { qid: null, dir: null, digest: null }
      if (!chromeCache || now() - chromeCache.at > CHROME_DIGEST_TTL_MS) chromeCache = { at: now(), digest: chrome.dir ? chromeDigest(chrome.dir) : null }
      return { qid: chrome.qid, dir: chrome.dir ?? null, digest: chromeCache.digest }
    },
    watch(company, fn) {
      let s = watchers.get(company); if (!s) { s = new Set(); watchers.set(company, s) }
      s.add(fn)
      return () => { s.delete(fn); if (!s.size) watchers.delete(company) }
    },
    // noteProbe(company, {ok, epoch}): the route's / the bus's healthz result feeds heartbeatAt
    noteProbe(company, r) { if (r?.ok) { probes.set(company, { heartbeatAt: now(), epoch: r.epoch ?? null }); unreachable.delete(company) } },
    // unreachableAt(company): when the last /_atelier/apps fetch failed (the shell's waking marks read it)
    unreachableAt(company) { return unreachable.get(company) ?? null },
    // refresh(company?): drop the caches and rescan now (lane B's fs.watch, the bus's unknown qid)
    async refresh(company = null) {
      chromeCache = null
      const list = company ? [company] : (workspaces() ?? []).map((w) => w.id)
      for (const c of list) hostView.delete(c)
      let changed = false
      for (const c of list) if (await check(c)) changed = true
      return changed
    },
    start() {
      if (poll) return
      poll = setInterval(() => { for (const w of workspaces() ?? []) { hostView.delete(w.id); check(w.id).catch((e) => log(`registry: poll ${w.id}: ${e.message}`)) } }, pollMs)
      poll.unref?.()
    },
    stop() { if (poll) { clearInterval(poll); poll = null } },
    hostRow,
  }
}
