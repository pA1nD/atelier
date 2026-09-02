// host/metrics.mjs — the host's scale rows (PLAN §4.5 "Metrics before fleet rollout", DESIGN §6.6).
//
// Served as Prometheus text exposition at `GET /_host/metrics` on the protocol port
// (protocol/server.mjs), behind the same bearer as `/_host/healthz`. Every name is prefixed
// `atelier_host_`; the alarm line of a row rides in its HELP text, so a scrape carries the number
// AND the line it is judged against.
//
// Nothing here grows without bound: a latency lives in a ring of the last `ring` samples (p50/p99
// are nearest-rank over that window; `_sum`/`_count` count the whole host life), and a family
// holds at most `maxApps` series — an app past the cap is counted in
// `atelier_host_metrics_series_dropped_total` and never remembered. The cap counts LIVE apps only:
// the supervisor calls `forget(slug)` when a folder goes (`gone()`), so a host that creates and
// deletes 200 apps over its life is not blind to the 129th — only a host serving 128 at once is.
//
// The rows and who feeds them:
//   save→verdict     supervisor/index.mjs   the watcher's quiescence firing → LIVE or the app-error   alarm 1 s
//   tailwind build   supervisor/index.mjs   buildSheet's own ms; cold = this app's first sheet of this host life   alarm 50 ms cold
//   worker resume    supervisor/index.mjs   the snapshot resume → READY: the idle wake AND the ladder's respawn   alarm 100 ms
//   worker restarts  supervisor/index.mjs   the respawn counter (restartLater, one per backoff)
//   watchdog trips   errors/watchdog.mjs    rss (kill) | cpu (throttle) | disk (stop) | shm (stop)
//   events batch     protocol/events.mjs    frames per push to the spine — the host DOES batch (≤ 128, coalesced per instance)
//   deploy           supervisor/deploy.mjs  `atelier deploy` verb → verdict, by outcome green|red|failed (DESIGN §10.3)
// The other half of the C4 row — the per-host SHARE of shell ingest time — is the shell's to
// measure: a host cannot see how long its batch cost the ring.
//
// The `app` label is the slug (what the agent's log lines and the portal show); an app renamed is a
// new series and the old one simply stops.

export const RING = 128
export const MAX_APPS = 128
export const PROM_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'

/** A bounded window of samples: `values` is the last `size`, `sum`/`count` are the whole life. */
export function createRing(size = RING) { return { size, values: [], at: 0, count: 0, sum: 0, last: null } }

export function observe(r, v) {
  if (!Number.isFinite(v)) return r
  if (r.values.length < r.size) r.values.push(v)
  else r.values[r.at] = v
  r.at = (r.at + 1) % r.size
  r.count++; r.sum += v; r.last = v
  return r
}

/** quantile(r, q) — nearest-rank over the ring's window (not over the whole life); null when empty. */
export function quantile(r, q) {
  const n = r.values.length
  if (!n) return null
  const s = [...r.values].sort((a, b) => a - b)
  return s[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))]
}

const escape = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
const labelStr = (pairs) => (pairs.length ? `{${pairs.map(([k, v]) => `${k}="${escape(v)}"`).join(',')}}` : '')
const num = (n) => (n === null || n === undefined || !Number.isFinite(n) ? 'NaN' : String(Math.round(n * 1000) / 1000))
const keyOf = (labels) => labels.map(([k, v]) => `${k}=${v}`).join(',')

/**
 * createMetrics({ring, maxApps}) — the recorders the lanes call and the exposition the route serves.
 *   .save(app, ms, 'live'|'error')   .tailwind(app, ms, {cold})   .resume(app, ms)
 *   .restart(app)   .watchdogTrip(app, 'rss'|'cpu'|'disk'|'shm')   .eventsBatch(frames)   .deploy(app, ms, 'green'|'red'|'failed')
 *   .exposition() → the Prometheus text body (always ends in a newline)
 * The default instance is a real one: a lane constructed without `metrics` records into its own,
 * which nothing scrapes — no null checks on any hot path.
 */
export function createMetrics({ ring = RING, maxApps = MAX_APPS } = {}) {
  let dropped = 0
  const summary = (name, help, lastName, lastHelp) => ({ name, help, lastName, lastHelp, series: new Map() })
  const counter = (name, help) => ({ name, help, series: new Map() })

  const saveMs = summary(
    'atelier_host_save_verdict_ms', 'save → verdict per app and outcome: the exclusion-list watcher\'s quiescence firing to LIVE, or to the app-error emitted (alarm 1 s). The outcome is a LABEL because the alarm is about the error path — a slow live build must not fire it, and a slow error must not be diluted by fast live saves in one ring',
    'atelier_host_save_verdict_last_ms', 'the last save→verdict of this app, by outcome, in ms')
  const tailwindMs = summary(
    'atelier_host_tailwind_build_ms', 'one Tailwind sheet for this app, in ms; phase="cold" is the app\'s first sheet of this host life (alarm 50 ms cold)',
    'atelier_host_tailwind_build_last_ms', 'the last Tailwind sheet of this app, in ms')
  const resumeMs = summary(
    'atelier_host_worker_resume_ms', 'a worker resumed from the last-good snapshot to READY, in ms — BOTH roads into resume(): the request that wakes an idle-stopped worker and the crash ladder\'s respawn, one series (alarm 100 ms is the wake\'s; the ladder\'s own backoff is outside the clock)',
    'atelier_host_worker_resume_last_ms', 'the last resume of this app, in ms')
  const deployMs = summary(
    'atelier_host_deploy_ms', 'one `atelier deploy` of this app from the verb to its verdict, in ms, by outcome (green = released, red = the rehearsal refused it and prod is untouched, failed = the release failed after the gate and the app is down)',
    'atelier_host_deploy_last_ms', 'the last deploy of this app, by outcome, in ms')
  const batchSize = summary(
    'atelier_host_events_batch', 'invalidation frames per push to the spine (_count = pushes, _sum = frames; coalesced per instance, batches <= 128)',
    'atelier_host_events_batch_last', 'the frames in the last push to the spine')

  const verdicts = counter('atelier_host_save_verdicts_total', 'saves that reached a verdict, by outcome (live = the swap, error = the app-error emitted)')
  const restarts = counter('atelier_host_worker_restarts_total', 'worker respawns scheduled by the supervisor\'s crash ladder')
  const trips = counter('atelier_host_watchdog_trips_total', 'watchdog trips: rss (kill), cpu (throttle cycle), disk (stop), shm (stop)')
  const deploys = counter('atelier_host_deploy_total', 'deploys that reached a verdict, by outcome (green | red | failed)')

  function record(f, labels, v) {
    const k = keyOf(labels)
    let s = f.series.get(k)
    if (!s) {
      if (f.series.size >= maxApps) { dropped++; return }
      s = { labels, ring: createRing(ring) }
      f.series.set(k, s)
    }
    observe(s.ring, v)
  }
  function bump(c, labels) {
    const k = keyOf(labels)
    let s = c.series.get(k)
    if (!s) {
      if (c.series.size >= maxApps) { dropped++; return }
      s = { labels, n: 0 }
      c.series.set(k, s)
    }
    s.n++
  }

  function renderSummary(out, f) {
    if (!f.series.size) return
    out.push(`# HELP ${f.name} ${f.help}`, `# TYPE ${f.name} summary`)
    for (const s of f.series.values()) {
      out.push(`${f.name}${labelStr([...s.labels, ['quantile', '0.5']])} ${num(quantile(s.ring, 0.5))}`)
      out.push(`${f.name}${labelStr([...s.labels, ['quantile', '0.99']])} ${num(quantile(s.ring, 0.99))}`)
      out.push(`${f.name}_sum${labelStr(s.labels)} ${num(s.ring.sum)}`)
      out.push(`${f.name}_count${labelStr(s.labels)} ${s.ring.count}`)
    }
    out.push(`# HELP ${f.lastName} ${f.lastHelp}`, `# TYPE ${f.lastName} gauge`)
    for (const s of f.series.values()) out.push(`${f.lastName}${labelStr(s.labels)} ${num(s.ring.last)}`)
  }
  function renderCounter(out, c) {
    if (!c.series.size) return
    out.push(`# HELP ${c.name} ${c.help}`, `# TYPE ${c.name} counter`)
    for (const s of c.series.values()) out.push(`${c.name}${labelStr(s.labels)} ${s.n}`)
  }

  // forget(app): every series of one slug, dropped. The supervisor calls it when a folder goes — a
  // deleted app holding a slot for the rest of the host life is how a first-come cap latches shut.
  function forget(app) {
    const mine = (s) => s.labels.some(([k, v]) => k === 'app' && v === app)   // the labels, not the key string: a slug is a folder name
    for (const f of [saveMs, tailwindMs, resumeMs, deployMs, verdicts, restarts, trips, deploys]) for (const [k, s] of [...f.series]) if (mine(s)) f.series.delete(k)
  }

  return {
    save(app, ms, outcome) { const o = outcome === 'live' ? 'live' : 'error'; record(saveMs, [['app', app], ['outcome', o]], ms); bump(verdicts, [['app', app], ['outcome', o]]) },
    tailwind(app, ms, { cold = false } = {}) { record(tailwindMs, [['app', app], ['phase', cold ? 'cold' : 'warm']], ms) },
    resume(app, ms) { record(resumeMs, [['app', app]], ms) },
    restart(app) { bump(restarts, [['app', app]]) },
    watchdogTrip(app, kind) { bump(trips, [['app', app], ['kind', kind]]) },
    eventsBatch(frames) { record(batchSize, [], frames) },
    deploy(app, ms, outcome) { const o = ['green', 'red', 'failed'].includes(outcome) ? outcome : 'failed'; record(deployMs, [['app', app], ['outcome', o]], ms); bump(deploys, [['app', app], ['outcome', o]]) },
    forget,
    exposition() {
      const out = []
      for (const f of [saveMs, tailwindMs, resumeMs, deployMs, batchSize]) renderSummary(out, f)
      for (const c of [verdicts, restarts, trips, deploys]) renderCounter(out, c)
      out.push('# HELP atelier_host_metrics_series_dropped_total samples dropped because a family already holds maxApps series')
      out.push('# TYPE atelier_host_metrics_series_dropped_total counter')
      out.push(`atelier_host_metrics_series_dropped_total ${dropped}`)
      return out.join('\n') + '\n'
    },
  }
}
