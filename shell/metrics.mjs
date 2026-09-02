// shell/metrics.mjs — the rows PLAN §4.5 "Metrics before fleet rollout" asks the SHELL for, and
// nothing else (the host's worker resume, save→error e2e, Tailwind build time, volume size and
// container restarts are other planes'). One collector per shell, read through
// `GET /_atelier/metrics` (routes.mjs, operator or local only) as Prometheus text exposition —
// no dependency, no scrape state, no push.
//
//   proxy p50/p99 per host    every proxied request is timed twice from dispatch: to the host's
//                             response HEADERS and to the last BODY byte, keyed by the host address
//                             `registry.hostOf(row)` resolved to (`waking.mjs hostKey`) — which is
//                             `<ip>:<port>`, or `company:<id>` for a company with no live host row
//                             (the `waking` refusals of a stopped chat pod); `sum by (host)` therefore
//                             mixes the two, and only an address ever carries timings — plus the
//                             per-host outcome counter ok | waking (a DIAL, or a waking mark that
//                             skipped the dial) | timeout (an idle TIMEOUT) | error (a 502, a cut
//                             response). A 400/413 the shell itself refused is not the host's row.
//   frames/s + gaps           per document-socket topic: frames sent into a 60 × 1 s bucket ring
//                             (read as the window's average), gap frames as a counter
//   resume latency            from a client's `resume` to its replay + `resumed`/`gap` — a denied
//                             resume is a refusal, not a resume, and is not timed
//   bootstrap bytes           the `window.__ATELIER__` JSON per document, per company (§4.5's
//                             document budget is ≤ 500 KB gzip for the whole page; this is the part
//                             the shell composes)
//   cache staleness           the age of the oldest LIVE registry cache entry — how stale a read
//                             can be when a revocation lands (`registry.cacheAgeMs()`, fleet only)
//   wake calls                the spine's wake door as this replica drove it (`waker.stats()`,
//                             waking.mjs): sent | up | refused | unconfirmed | failed | held, and the
//                             calls in flight right now
//
// Cost: a Map lookup and one number into a preallocated ring per event; nothing is sorted, summed
// or formatted until someone reads. Every keyed map is bounded (`MAX_KEYS`, oldest key dropped) so
// a churn of host addresses or topics cannot grow the shell — and a topic reaches the map only after
// the bus has ALLOWED it (events.mjs does not count a `denied` frame), so a member cannot evict the
// real rows by asking for strings that do not exist.
//
// WHAT UNKNOWN LOOKS LIKE: `NaN`, as the spine's and the host's expositions render it — never `0`. A
// zero is a reading; a sample that is not a number is not one, and a poisoned `_sum` must not read as
// a healthy nothing. `push()` refuses a non-finite outright, so no series can be poisoned in the
// first place.
export const RING = 512              // latency samples kept per series
export const MAX_KEYS = 256          // hosts / topics / companies kept per map
export const RATE_WINDOW_S = 60      // the frames/s ring
export const OUTCOMES = ['ok', 'waking', 'timeout', 'error']
export const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'

// ---- the two ring shapes
const samples = (cap) => ({ v: new Float64Array(cap), n: 0, i: 0, sum: 0, count: 0 })
function push(s, x) {
  if (!Number.isFinite(x)) return    // the host's observe() rule: a non-number is not a sample, and one NaN poisons `sum` for the process's life
  s.v[s.i] = x
  s.i = (s.i + 1) % s.v.length
  if (s.n < s.v.length) s.n++
  s.sum += x; s.count++
}
// quantile(s, q): nearest rank over what the ring still holds — the only place that allocates
export function quantile(s, q) {
  if (!s.n) return 0
  const a = s.v.slice(0, s.n).sort()
  return a[Math.min(s.n - 1, Math.max(0, Math.ceil(q * s.n) - 1))]
}

function rate(window) { const r = { b: new Int32Array(window), t: new Float64Array(window), total: 0 }; r.t.fill(-1); return r }
function hit(r, sec) {
  const i = ((sec % r.b.length) + r.b.length) % r.b.length
  if (r.t[i] !== sec) { r.t[i] = sec; r.b[i] = 0 }
  r.b[i]++; r.total++
}
// perSecond(r, sec): the window's average — buckets older than the window are not in it
export function perSecond(r, sec) {
  let n = 0
  for (let i = 0; i < r.b.length; i++) if (r.t[i] >= 0 && sec - r.t[i] < r.b.length) n += r.b[i]
  return n / r.b.length
}

// bounded(map, key, make): the entryCache idiom — insertion order, the oldest key dropped past the cap
function bounded(map, key, make, cap) {
  let v = map.get(key)
  if (v === undefined) { v = make(); map.set(key, v); if (map.size > cap) map.delete(map.keys().next().value) }
  return v
}

// ---- exposition
const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
const num = (v) => (Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000)) : 'NaN')

function counter(out, name, help, rows) {
  if (!rows.length) return
  out.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`)
  for (const [labels, v] of rows) out.push(`${name}${labels} ${num(v)}`)
}
function gauge(out, name, help, rows) {
  if (!rows.length) return
  out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`)
  for (const [labels, v] of rows) out.push(`${name}${labels} ${num(v)}`)
}
function summary(out, name, help, map, label) {
  if (!map.size) return
  out.push(`# HELP ${name} ${help}`, `# TYPE ${name} summary`)
  for (const [key, s] of map) {
    const tag = label ? `{${label}="${esc(key)}"}` : ''
    const q = label ? `{${label}="${esc(key)}",quantile=` : '{quantile='
    out.push(`${name}${q}"0.5"} ${num(quantile(s, 0.5))}`)
    out.push(`${name}${q}"0.99"} ${num(quantile(s, 0.99))}`)
    out.push(`${name}_sum${tag} ${num(s.sum)}`, `${name}_count${tag} ${num(s.count)}`)
  }
}

/**
 * createMetrics({ now, ring, keys, window }) → the collector
 *   the hot side: proxyHeaders(host, ms), proxyDone(host, ms, outcome), proxyOutcome(host, outcome),
 *                 frame(topic), gap(topic), resumed(ms), bootstrap(company, bytes)
 *   the read side: render({ events, bus, registry, waker }) → the exposition text
 */
export function createMetrics({ now = Date.now, ring = RING, keys = MAX_KEYS, window = RATE_WINDOW_S } = {}) {
  const headersMs = new Map()      // host → samples
  const bodyMs = new Map()         // host → samples
  const outcomes = new Map()       // host → {ok, waking, timeout, error}
  const frames = new Map()         // topic → rate ring
  const gaps = new Map()           // topic → n
  const resume = new Map()         // '' → samples (one unlabelled series)
  const bootstrap = new Map()      // company → samples

  const mkSamples = () => samples(ring)
  const mkOutcome = () => ({ ok: 0, waking: 0, timeout: 0, error: 0 })
  const bump = (host, outcome) => { const o = bounded(outcomes, host ?? '-', mkOutcome, keys); if (o[outcome] !== undefined) o[outcome]++ }

  return {
    now,
    proxyHeaders(host, ms) { push(bounded(headersMs, host ?? '-', mkSamples, keys), ms) },
    proxyDone(host, ms, outcome = 'ok') { push(bounded(bodyMs, host ?? '-', mkSamples, keys), ms); bump(host, outcome) },
    proxyOutcome(host, outcome) { bump(host, outcome) },
    frame(topic) { hit(bounded(frames, topic, () => rate(window), keys), Math.floor(now() / 1000)) },
    gap(topic) { gaps.set(topic, (gaps.get(topic) ?? 0) + 1); if (gaps.size > keys) gaps.delete(gaps.keys().next().value) },
    resumed(ms) { push(bounded(resume, '', mkSamples, 1), ms) },
    bootstrap(company, bytes) { push(bounded(bootstrap, company ?? '-', mkSamples, keys), bytes) },

    // render({events, bus, registry}): everything the shell holds, read once. `events`/`bus`/`registry`
    // are read defensively — a shell built with a fake bus in a test still renders.
    render({ events = null, bus = null, registry = null, waker = null } = {}) {
      const out = []
      const sec = Math.floor(now() / 1000)
      const P = 'atelier_shell_'

      summary(out, `${P}proxy_headers_ms`, 'Milliseconds from proxy dispatch to the host\'s response headers.', headersMs, 'host')
      summary(out, `${P}proxy_body_ms`, 'Milliseconds from proxy dispatch to the last body byte.', bodyMs, 'host')
      counter(out, `${P}proxy_requests_total`, 'Proxied requests per host: ok, waking (dial refused or a waking mark), timeout (host idle), error (502 or a cut response).',
        [...outcomes].flatMap(([host, o]) => OUTCOMES.map((k) => [`{host="${esc(host)}",outcome="${k}"}`, o[k]])))

      gauge(out, `${P}events_frames_per_second`, `Document-socket frames sent per topic, averaged over the last ${window} s.`,
        [...frames].map(([topic, r]) => [`{topic="${esc(topic)}"}`, perSecond(r, sec)]))
      counter(out, `${P}events_frames_total`, 'Document-socket frames sent per topic.', [...frames].map(([topic, r]) => [`{topic="${esc(topic)}"}`, r.total]))
      counter(out, `${P}events_gaps_total`, 'Gap frames sent per topic (a cursor the ring has rotated past); delivery stops there until the tab resumes.',
        [...gaps].map(([topic, n]) => [`{topic="${esc(topic)}"}`, n]))
      summary(out, `${P}events_resume_ms`, 'Milliseconds from a client\'s resume to its replay and ack.', resume, null)

      if (events) {
        gauge(out, `${P}events_sockets`, 'Open document sockets on this shell.', [['', events.conns?.size ?? 0]])
        const s = events.stats ?? {}
        counter(out, `${P}events_sockets_total`, 'Document sockets by lifecycle event: opened, denied topics, evicted for the per-person budget, reaped for missed pings, and pump stalls behind a full userland buffer.',
          [['{event="opened"}', s.opened ?? 0], ['{event="denied"}', s.denied ?? 0], ['{event="evicted"}', s.evicted ?? 0], ['{event="reaped"}', s.reaped ?? 0], ['{event="stalled"}', s.stalls ?? 0]])
      }
      if (bus?.stats) {
        counter(out, `${P}bus_events_total`, 'Events the bus ingest lane appended to the ring or refused (envelope, unregistered epoch, non-monotonic seq).',
          [['{outcome="appended"}', bus.stats.appended ?? 0], ['{outcome="rejected"}', bus.stats.rejected ?? 0]])
      }

      summary(out, `${P}document_bootstrap_bytes`, 'Bytes of the window.__ATELIER__ bootstrap composed into a document.', bootstrap, 'company')

      const age = registry?.cacheAgeMs?.()
      if (age != null) gauge(out, `${P}registry_cache_age_seconds`, 'Age of the oldest live registry cache entry — how stale a read can be when a revocation lands.', [['', age / 1000]])

      const w = waker?.stats?.()
      if (w) {
        counter(out, `${P}wake_calls_total`, 'Wake calls to the spine door by verdict: sent (202 accepted), up (200: the pod was live), refused (the spine said no), unconfirmed (no verdict inside the clock), failed (the call threw), held (inside the per-chat window or a call in flight).',
          ['sent', 'up', 'refused', 'unconfirmed', 'failed', 'held'].map((k) => [`{outcome="${k}"}`, w[k] ?? 0]))
        gauge(out, `${P}wake_in_flight`, 'Wake calls to the spine door in flight on this shell.', [['', w.inFlight ?? 0]])
      }

      return out.length ? out.join('\n') + '\n' : ''
    },
  }
}
