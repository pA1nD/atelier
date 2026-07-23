# Recipes

Proven shapes for common module-authoring situations. Nothing here is contract — the contract is in [Modules](./MODULES.md) — but each recipe exists because getting it wrong produced a real bug in a real module. Copy freely.

## Links that work from wherever the reader is

A module's URLs are read from three different places, and each wants a different base:

1. **The browser** (your frontend, rendered HTML) — use **relative URLs**, always. The browser resolves them against whatever host the visitor used; a page that works on `localhost` works identically over a LAN IP, a VPN hostname, or a reverse-proxied domain. No code needed.
2. **A response to a live request** (a served `skill.md`, an API payload containing links, a share/preview URL) — derive the base **from the request**. The one host that provably reaches you *for this reader* is the one they just used. Never bake in `localhost`: a reader who fetched your content over the network gets instructions that point at *their own* machine.
3. **Content that leaves without a request context** (emails, webhooks, records another system stores) — use **`ctx.baseUrl`**, the operator's declared canonical address. This is the only case where a configured value beats a derived one.

The request-derived base, ready to copy:

```js
// Content only — never use request headers for auth or routing decisions.
const reqBase = (req) => {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${ctx.port}`)
    .split(',')[0].trim()
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
  return `${proto}://${host}`
}

router.get('/skill.md', (req, res) => {
  res.end(fs.readFileSync(skillPath, 'utf8').replaceAll('{{BASE}}', reqBase(req)))
})
```

Author the file with `{{BASE}}/api/global/kanban/...` and substitute at serve time. For content the reader *copies to another machine* (agent skills, setup snippets), freezing the base at fetch time is correct: each copy carries the URLs that work from the machine that fetched it.

## A sidecar that follows the instance's exposure

A module that opens its own listener (an upload server, a preview server, a WebSocket bridge) should bind **`ctx.host`** (also published as `process.env.HOST`):

```js
server.listen(MY_PORT, process.env.HOST || '127.0.0.1')
```

The shell resolves `host` from the instance's config and publishes it, so a sidecar that follows it is **never more exposed than the instance itself**: loopback on a private instance, wider only when the operator deliberately widened the whole thing. Never hardcode `0.0.0.0` — that exposes the sidecar to every network the machine is on even while the instance stays private. If the sidecar has a genuine reason to be reachable more widely than the instance (say, byte-uploads from a VM), make that its own opt-in setting (`MYMODULE_HOST`), not a default.

## Live data without polling

A frontend that `setInterval`-fetches its API multiplies work by every open tab and still lags by up to one interval. The shell already gives you the better shape for free: the backend is the **one** place that watches, and `ctx.broadcast` fans the result to every subscribed tab.

**Backend — one watcher for all viewers.** Watch the source of truth (`fs.watch` on your data files, or one timer when there's nothing to watch), then broadcast **only on change** — diff against the last state so reconnecting tabs and no-op writes don't produce frames:

```js
// backend.js — inside mountRoutes(router, ctx)
const slot = ctx.module                       // survives hot reloads
let timer = null
const push = () => {                          // debounce: fs.watch can fire twice per atomic rename
  clearTimeout(timer)
  timer = setTimeout(() => {
    const state = readState()
    const key = JSON.stringify(state)
    if (key === slot.lastKey) return
    slot.lastKey = key
    ctx.broadcast({ type: 'state', ...state })
  }, 250)
}
if (slot.watcher) { try { slot.watcher.close() } catch {} }   // never stack watchers across reloads
slot.watcher = fs.watch(ctx.dataDir, { persistent: false }, push)
```

Two payload styles, both legitimate: broadcast **the state itself** when it's small and the same for every viewer, or broadcast an **invalidation ping** (`{ type: 'changed' }`) that the client answers with a normal fetch — the right choice when payloads are large or per-user, since the refetch goes back through the auth-gated HTTP path.

**Frontend — fetch once, then listen; refetch only to heal.** The initial fetch paints the page; the subscription keeps it current; a cheap refetch on tab-visibility covers frames missed while the laptop slept or the socket reconnected. That heal is a repair, not the data path:

```js
useEffect(() => {
  load()                                                        // first paint
  const unsub = self.subscribe((f) => { if (f.type === 'state') setData(f) })
  const onVis = () => { if (!document.hidden) load() }          // heal missed frames
  document.addEventListener('visibilitychange', onVis)
  return () => { unsub(); document.removeEventListener('visibilitychange', onVis) }
}, [])
```

**What legitimately stays a poll:** external services you can't watch (refresh on their natural cadence), presence heartbeats, and a long-interval reconcile as a safety net *behind* the push — never instead of it.

**Pitfalls that produced real bugs:** broadcasting transient failures (a momentary timeout became flapping UI — broadcast durable state, let errors resolve first); a busy-guard that swallowed pushes triggered *during* the guarded work (queue one trailing run); and hand-building the broadcast topic (the shell stamps it from your module identity — a hardcoded topic breaks the moment the module is installed under another workspace).

## Frontends reaching a sidecar port

First preference: don't. Route the traffic through your backend under `/api/<ws>/<id>/…` and push events over `ctx.broadcast` — then there is no second port, remote visitors need nothing special, and the instance's auth gate covers the traffic.

When a direct connection is genuinely necessary (high-bandwidth streams, WebRTC), build the URL from the page's own location:

```js
const ws = new WebSocket(`ws://${window.location.hostname}:${SIDECAR_PORT}`)
```

Never `localhost` — for a remote visitor, `localhost` is *their* machine, and the connection dies for everyone but you. And remember a directly-dialed sidecar port sits outside the instance's auth gate; treat exposing it as its own decision.
