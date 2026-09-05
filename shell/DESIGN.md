# `shell/` + `client/` — design for PLAN §4.9 steps 4 and 4b

The 2.0 shell (document composition, the route matrix with its provider seam, the events socket,
the assertion minter, the proxy) and the forked client, built so that `npx atelier` on a laptop is
**the same shell and the same host with local providers** (PLAN §4.6), and step 5 adds only the
fleet providers. Everything the host does (transforms, CSS, watching, workers, last-good) stays in
`host/` — the shell does no module work (P10) and talks to the host only over a token-bearing
link on a separate process (P11). Branch `local` from `host` (base `6280b61`); the doctor lane
(`doctor/`, branch `doctor`) is untouched.

What is already true on the base: `host/` serves the 1.x document itself through its dev shell
(`host/protocol/devshell.mjs`, token-only, `127.0.0.1:1844`) and that document renders weather and
toybox in Chrome with the chrome, the API and the WS (r2/spike-host-devshell). `protocol/` holds
identity, headers, events, registry, membership with vectors. The 1.x files at the repo root
(`client.jsx` — the host branch added `withDevToken` and the `rev` argument, `index.html`,
`server.js`, `build.js`, `discovery.js`, `cli.js`, `chrome-resolve.js`, `shims/`) are **forked,
never edited**: `atelier <id>` (standalone / `dev:module`) and the collection verbs keep running
the 1.x `server.js` byte for byte.

Contents: §1 the provider seam · §2 the document and the route matrix · §3 shell ↔ host · §4 the
client fork · §5 local mode · §6 file layout · §7 tests and the browser drill · §8 seams owed by
other lanes and resolutions.

---

## 1. The provider seam

One shell, five provider objects, two implementations each. Every call site in `shell/` is
identical for fleet and local; a local provider **returns "not applicable" for a fleet-only rule
— it never fakes a cookie, a Host, a redirect or a session**. The shell is constructed once:

```js
// shell/index.mjs
createShell({ cfg, providers: { identity, registry, gate, bus, hostLink }, log })
  → { listen(): Promise<{port}>, close(drainMs): Promise<void>, handle(req, res), upgrade(req, socket, head) }
```

`cfg` (shell/config.mjs, from `atelier.config.json` + env in local mode, from env in the fleet):
`{ mode: 'fleet'|'local', port, bind, origin(company) → 'https://<c>.portal.pa1nd.de' | 'http://localhost:<port>',
   chromeQid, chromeDir, nodeEnv, label, csp: {fontHosts:[]}, portalOrigin? }`.

### 1.1 `identity` — who is the person

```js
identity.kind                                   // 'fleet' | 'local'
identity.resolve(req) → Promise<
    { ok: true,  person: {id, name, claims}, credential: 'cookie' | 'none', epoch: number|null, op: boolean }
  | { ok: false, reason: 'no-session' | 'revoked' }>
identity.session(req) → the raw session id or null      // fleet: the `__Host-session` cookie value; local: null
```

| | fleet (step 5) | local (step 4) |
|---|---|---|
| source | `__Host-session` cookie → spine store `{person, epoch, aud}`; `aud` must equal the request's company; `membership.checkSession(session, currentEpochOf)` — a bumped person epoch is `revoked` (§4.1 Cookie, §4.5) | constant: `{ok:true, person:{id:'local', name:'local', claims:{}}, credential:'none', epoch:null}` — the host's dev-shell principal (`registrar.principal` in local mode is the same `{id:'local', name:'local'}`) |
| `credential` | `'cookie'` — this is what turns the Origin lane on (§1.3) | `'none'` — the Origin lane evaluates to a no-op by the **same rule** ("Origin iff the credential is a cookie", OR12); nothing is skipped here |
| `op` | `true` on an operator session — the spine marks the row its operator door mints (`op` on the row, and `op: true` in the person's claims through the portal); it admits `GET /_atelier/metrics` (§3.6) and nothing else: rows, presence and the proxy are unchanged by it | `false` — local mode admits the metrics route by mode instead: the shell IS the operator's process |
| what the shell stamps into the assertion | `person` from the session | `person` = the constant |
| SKIPPED locally | the session store, the person epoch, the `aud` check — there is no session at all (identity is the process's) | |

### 1.2 `registry` — which apps exist, where their host is, who may open them

```js
registry.kind
registry.company(host)          → company | null           // fleet: from the Host header (label below portal); local: null (unused)
registry.apps(company)          → Promise<AppRow[]>         // AppRow = {instance, slug, company, meta:{name,icon,group,color}, requestedPrimary, rev|null, state}
registry.resolve(company, slug) → Promise<AppRow | null>
registry.present(personId, instance) → Promise<boolean>     // the ACL (§4.1 route lane 5)
registry.host(company)          → Promise<HostRow | null>   // HostRow = {hostId, epoch, token, ip, port, tls, heartbeatAt, drainingAt}
registry.chrome(company)        → {qid, dir|null, digest|null, version|null, base}   // the company DEFAULT chrome; AppRow.chromeDigest = the digest ITS computer reports (step 7 ship C)
registry.watch(company, fn)     → unsubscribe               // fn() when the app set / meta / primary changed → the shell mints a `company:<id>` frame (§3.4)
registry.cacheAgeMs()           → ms | null                 // fleet only: the age of the oldest LIVE apps-cache entry (§3.6 cache staleness)
registry.wake(chat, {by})       → Promise<{ok, state, reason, error?, status}>   // fleet only (absent locally): the spine's sleep/wake door, POST /v1/computers/<chat>/wake {by:"session:<id>"} (§3.5)
registry.presentOnChat(person, company, chat) → Promise<boolean>   // fleet only: chat membership — the app-less wake target is woken for a caller present on it alone (§3.5)
```

| | fleet | local |
|---|---|---|
| `apps` / `resolve` | the spine registrar's read side: `GET /v1/companies/<c>/apps` cached per replica with a TTL and invalidated by the spine's membership/registry epochs (§4.5); rows carry `meta`, `requested_primary`, the computer and its uid | **folder discovery done by the shell** (1.x rules: `discovery.js` unchanged — `$<ws>/`, reserved names, `atelier.config.json` filter and path entries) joined with the host's dev registry `GET /_atelier/apps` (token) for `{instance, rev, state}` on the same slug. Meta comes from the folder's `module.json` (generated from the literal `meta` when absent, §5.3). One host per non-empty workspace (§5.1); `company` = the workspace id, `global` included |
| `present` | membership derived from chats + the accepted-invite table (§4.2; the ruling of §10 item 7 decides the automatic write): a person outside the app's chat → `false` → 404 identical to a stranger | always `true` — one person, every app is theirs. This is the local provider's *answer*, not a skip |
| `host` / `hostOf(row)` | `hostOf(row)` = the computer row the APP lives on (the spine's `host` on every app row, v36): pod IP, `chat` (the wake target — a chat owns one computer), `host_epoch`, the host token the spine handed the shell, `heartbeat_at` (stale > 30 s → waking), `draining_at` — THE ROUTING SEAM, since a company owns one host per chat it owns; `host(c)` = the company's freshest, asked only by an app-less document ("is anything up") | `{hostId:'local', ip:'127.0.0.1', port:<dev port of that workspace's host>, tls:null, token:<dev token>, heartbeatAt: last successful `/_host/healthz`, drainingAt:null}` |
| `chrome` | the chrome row's qid (`portal/catalyst-chrome`, the system host's) and, since the first RELEASE (step 7 ship C, spine v45), the company default `digest` (`override ?? the fleet default`, 64 hex; null before it) + `version`; every app row and dial row carries `chromeDigest` — what ITS computer reported on its heartbeat (null = none). `routes.mjs chromeShape` composes an APP document with the row's digest (the sheet its host built carries that chrome's rules: JS and CSS are one digest), an app-less one with the default; a digest puts every chrome asset at `/_chrome/<digest>/…` off `cfg.chromeStore` (`shell/chrome-store.mjs`, the spine's `${ARTIFACTS_MOUNT}/_chromes` read-only), no digest = the row's `/modules/<qid>/…?rev=` path byte for byte | the elected chrome folder (1.x election: `defaultChrome` setting, else alphabetical among global modules whose literal meta has `isChrome:true`); passed to every host as `ATELIER_CHROME_DIR`; one chrome per run; `digest` = the folder's max mtime (never a `/_chrome/` URL: not 64 hex) |
| `watch` | the spine's `company:<id>` topic on the stream | the shell's own rescan: the apps-root `fs.watch` (debounced 300 ms) + a `reload` frame from the host's dev WS for a qid the shell does not know → rescan → `fn()`; safety net one unref'd 5 s poll of `/_atelier/apps` (a bounded loop with a verdict per tick, never a foreground wait) |
| SKIPPED locally | the spine round trip, the caches and their epoch invalidation, computer rows, presence derived from chats, `draining_at`, tombstones (the host's local registry.json keeps its own) | |

### 1.3 `gate` — the fleet-only rules

```js
gate.kind
gate.https(req)            → { redirect: 'https://…', hsts: true } | null
gate.hostAllowed(req)      → { company } | { portal: true } | { status: 404 } | null      // null = not applicable
gate.ticket(req, res)      → Promise<boolean>     // true = the `/_t/<opaque>` lane handled the response
gate.unauthDocument(req)   → { status: 302, location, cookie? } | null    // the 302-to-/go (+ loop breaker)
gate.origin(req, credential) → { status: 403 } | null    // only when credential === 'cookie'; `Origin: null` → 403
```

| lane | fleet | local — **skipped, never faked** (each returns `null`, the route runs on) |
|---|---|---|
| https + HSTS (OR11) | `x-forwarded-proto: http` → 301 to https; `Strict-Transport-Security: max-age=…; includeSubDomains` on `portal.pa1nd.de` | no redirect — `http://localhost:<port>` is the origin; no HSTS header is ever sent |
| Host allowlist (§4.1 lane 2) | Host is `portal.pa1nd.de` or a registered company id, else 404 (never a redirect); Host must equal the path's company on document routes | no Host check — `localhost:1844` has no company host [S:C3]; the path's first label alone names the workspace |
| ticket `/_t/<opaque>` | the single-use store, sec-fetch gate, the Continue page, 410/403/404 [S:C2] | `/_t/*` is 404 like any unknown path; no store, no Continue page |
| 302-to-`/go` | unauthenticated document GET → `302 https://portal.pa1nd.de/go/<c>/<path>` + the loop breaker (§10 item 14) | never — identity is always resolved locally |
| Origin (OR12) | on writes and WS upgrades when the credential is a cookie | the same rule; the local credential is `'none'`, so the lane is a no-op *by evaluation* (the agent's `curl -X POST` against the local shell works, C3 surprise 3) |

The gate is the only provider with fleet-only rules; the list above **is** §4.6's "fleet-only
rules the local provider skips": the Host = company gate, the https redirect, the 302-to-`/go`
(and the ticket lane those two imply).

### 1.4 `bus` — where invalidations come from

```js
bus.kind
bus.ring                                   // protocol/events EventRing — the per-topic rings this replica serves sockets from
bus.start() / bus.stop()
bus.publish(topic, {type:'invalidate'})    // shell-minted frames: `company:<id>` (rail) — stream `shell:<shellEpoch>`
bus.onAppend(fn)                           // fn(ev) after every accepted append → the socket layer fans out (§3.4)
bus.snapshot(topic) → Promise<Snapshot>    // Snapshot = {stream, seq, rev|null, error:{message}|null} — what a tab fetches after `subscribed`/`gap`/streamChange
```

| | fleet | local |
|---|---|---|
| feed | the spine stream (the spine's existing stream until replica #2, then NATS): every host push the spine accepted is re-appended into this replica's ring (`ring.registerEpoch(topic, epoch)` from the registrar's hello, `ring.append(ev)` per frame); the ring is `new EventRing()` — **no implicit adoption** (protocol/events) | **in-proc from the host's events**: the shell holds one WebSocket per host to `ws://127.0.0.1:<devPort>/_atelier/ws` with `x-atelier-dev-token`; frames are the dev shell's 1.x set and are mapped: `{type:'reload', moduleId:'<ws>/<slug>', rev, topic:'shell'}` → `append({stream:'local:<hostEpoch>', topic:<instance>, seq, type:'invalidate'})` (seq per topic, minted by the bus; `<hostEpoch>` from `/_host/healthz`); `{type:'backend-error', qid, message}` → the same invalidate (the snapshot carries the error); a worker broadcast `{…event, topic:'<ws>/<slug>'}` → an invalidate on that instance (the payload is not delivered — 2.0 events are invalidations, §4.4; "buffered `ctx.broadcast`" is a documented 1.x break, §4.8). The ring is `new EventRing({adoptFirst:true})` — the local opt-in. A host restart (new `/_host/healthz` epoch) → `ring.registerEpoch(topic, newEpoch)` for every app of that host → every tab's next `resume` is a `streamChange` → one snapshot |
| `snapshot(instance)` | `rev` from the registry row (`modules-changed` keeps it current); `error: null` — errors go to the agent (OR16), never to a member's tab | `rev` and `error` from the host's dev shell: `GET /_atelier/apps` (rev) + `GET /_atelier/events?app=<instance>` (the collector's most recent build/load failure of the running save, else null) |
| `snapshot('company:<id>', {person})` | the rail: `registry.apps(company)` filtered by `present(person, row)` (a member outside an app's chat sees no row of it — PLAN §4.1) mapped to bootstrap module rows (each with its `chromeDigest`) + `chrome: {qid, digest, version?}` + `chromeRev` = the company DEFAULT — the client compares an app document against its row, an app-less one against the default (§4) | the same (`present` is always true), `chrome.digest` = the chrome folder's max mtime |
| SKIPPED locally | the spine stream client, epoch registration from the registrar's hello, the per-host ingest rate limit | |

### 1.5 `hostLink` — the wire to the host

```js
hostLink.kind
hostLink.request({ hostRow, app: {instance, company, slug}, person, req })
  → Promise<{ status, headers, body: Readable }>     // streamed both ways; throws {code:'DIAL'|'TIMEOUT'|'BODY_CAP'}
hostLink.dialMs                                    // 1000 — the connect cap (§4.3 Network: never a silent 2 s per request)
hostLink.probe(hostRow) → Promise<{ok, epoch, apps} | {ok:false}>   // `/_host/healthz`
```

| | fleet | local |
|---|---|---|
| transport | `https` to `hostRow.ip:1845` with the shell's client cert (`requestCert` on the host, mTLS mandatory); `Authorization: Bearer <epoch>.<token>` from the registry row | `http` to `127.0.0.1:<devPort>` with `x-atelier-dev-token: <token>` (the host's dev lane, `auth.devRequest`); every other header rule identical |
| identity | the assertion header (§3.1), verified by the host (`auth.verifyRequest`) | the assertion header is **minted and sent by the same code path**; the dev lane does not verify it today (identity there is the dev token's principal, which is the same `{id:'local'}`). It becomes verified the day the host's local transport takes the shell's key (§8 H2) — until then this is stated, not pretended |
| SKIPPED locally | mTLS, the bearer with epoch, the epoch-moved re-dial | |

---

## 2. The document and the route matrix

### 2.1 Bootstrap (verbatim shape, §4.1 + what the client needs)

```js
window.__ATELIER__ = {
  mode: 'host', label: <cfg.label|null>, observe: false,
  chromeApi: 2,
  user: { id, name, epoch: <person epoch|null>,
          workspaces: [ { id: <company>, name: <company>, modules: [ { id: <slug>, instance, rev, hasFrontend: true, meta: {name, icon, group, color, primary?, chrome?} } ] } ] },
  workspace: <company>, workspaces: [ { id: <company>, name } ],          // ONE company per document (bounded by construction)
  companies: [ { id, name, href } ],   // the picker: local = every workspace as `/<ws>/`; fleet = [] (the picker lives on the portal)
  portal: <cfg.portalOrigin|null>,     // fleet: 'https://portal.pa1nd.de' — the picker POSTs there; local: null
  activeQid: '<company>/<slug>' | null,
  chromeQid: 'global/<chrome>', defaultChromeQid: 'global/<chrome>', chromes: ['global/<chrome>'],   // advertised: the client renders an error for an unadvertised `meta.chrome` (52/58 pin catalyst)
  chromeRev: <digest|mtime>,           // a change FOR THIS ROUTE → the client full-reloads (chrome JS cannot swap inside a document; §4)
  chromeBase: '/_chrome/<digest>',     // ONLY when the document is composed by digest (step 7 ship C): where the chrome's frontend.js, kit.js, chrome.css and fonts/ are — immutable, no ?rev=; absent otherwise (a null digest is the step-5 document byte for byte)
  backendErrors: [],                   // always empty in 2.0: the overlay is fed by the topic snapshot (§4)
}
```

A module row carries `chromeDigest` (the digest ITS computer reported) only when there is one. By digest an APP document is composed with its row's digest, an app-less one with the company default (`routes.mjs chromeShape`); `chromeRev` is then that digest.

Escaped with the `<` → `<`, U+2028/9 replacer and `JSON.stringify(…, (k, v) => typeof v === 'function' ? undefined : v)`; `primary` in a module row is the registry's *applied* primary in the fleet and `module.json`'s `primary` locally (there is no portal to apply it — the local provider's answer, documented as such).

### 2.2 Head order (contract, [S:migration-local-3]) and the sheet

`client/index.html` is the fork of `index.html` with five slots, filled in this order and no other:

1. `<!--__STYLES__-->` → ONE render-blocking `<link id="atelier-chrome-styles" rel="stylesheet" href="/modules/<c>/<s>/styles.css?rev=<content id>">  (`sheetRev`: the app's content id — `deployed_rev`, the counter for a bare row — plus the chrome release's digest tail, `<rev>.<digest12>`; the URL names the bytes, no purge — 2026-09-05)` on `/<c>/<s>…`, the chrome's `/modules/global/<chrome>/styles.css?rev=<chromeRev>` on an app-less document (R11: one sheet per app, chrome + app scan, built by the host) — by digest the bundle's compiled chrome-only sheet `/_chrome/<digest>/chrome.css`.
2. React UMDs `/assets/react.js`, `/assets/react-dom.js` — **production** builds (`react.production.min.js`, `react-dom.production.min.js`) whenever `cfg.nodeEnv === 'production'`, which is the fleet always and the local default (`env` in `atelier.config.json` flips it).
3. `<script nonce>` bootstrap.
4. `<script type="importmap" nonce>` `{"imports": {"@atelier/kit": "/modules/global/<chrome>/kit.js?rev=<chromeRev>"}}` when the chrome ships `kit.js|jsx` (by digest `/_chrome/<digest>/kit.js` — a bundle always ships one).
5. `<!--__PRELOADS__-->` → `<link rel="modulepreload">` for `/assets/client.js`, `/assets/chrome-resolve.js`, the chrome bundle, kit, the app entry `frontend.js?rev=<content id>` (`assetRev`: `deployed_rev`, the counter for a bare row) and its relative imports (the host names them: `GET /modules/<c>/<s>/frontend.js` is fetched by the shell once per rev and its `from './x'` specifiers listed — cached per (instance, rev)). Preloads AFTER the import map, always: a preload before it resolves `@atelier/kit` eagerly, caches the failure and the later `import()` dies with zero network errors.
6. `<script type="module" src="/assets/client.js">`.

The chrome bundle and kit are the host's `/modules/global/<chrome>/{frontend,kit}.js` (minified in production, `react*` aliased to the shims) — the shell proxies them like any module asset, session-gated only, **exempt from presence** (the chrome is not an app). **By digest** (step 7 ship C, LANES-CHROME decisions 2–5) they are `/_chrome/<digest>/{frontend,kit}.js` + `chrome.css` + `fonts/*.woff2`, read by lane 4a off `cfg.chromeStore` (`shell/chrome-store.mjs`: the spine's `${ARTIFACTS_MOUNT}/_chromes/<digest>/` on the read-only mount, a path served only when the bundle's `manifest.json` names it — a manifest is trusted only as far as the digest vouches for it: every entry a 64-hex sha, the shas recomputing to the URL's digest, else the bundle is refused whole — its bytes read as a regular file inside the digest dir, never through a symlink, and checked once against the manifest's sha; 8 digests cached, the least recently used dropped) with `cache-control: public, max-age=31536000, immutable`, `etag: "<digest>:<path>"`, gzip ≥ 1 KiB for text — public bytes, no identity, as `/assets/*`; unknown digest, unlisted path, no store → 404. The fonts are self-hosted, so the fleet's `csp.fontHosts` is `[]`. Budget the drill asserts: ≤ 500 KB gzip transferred, 14 requests, depth 3 for weather-class apps; the shell gzips text ≥ 1 KiB itself (local) and lets the edge do it in the fleet.

### 2.3 CSP and caching

`Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-<r>'; style-src 'self' 'unsafe-inline' <fontHosts>; font-src 'self' data: <fontHosts>; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' <portalOrigin>; object-src 'none'` — `cfg.csp.fontHosts` is `[]` in the fleet (the fonts ride `/_chrome/<digest>/fonts/`, §2.2) and `['https://rsms.me']` locally (the chrome folder's frontend.jsx loads Inter from there; `shell/config.mjs`, an `atelier.config.json` `csp.fontHosts` overrides either); one nonce per document for the two inline scripts. `Cache-Control: no-store` on the document (§4.4 tab liveness: the `pageshow` hook makes reload and bfcache restore both safe); `no-cache` + `ETag: "rev-N"` on `/modules/*` (the host's, passed through); `X-Content-Type-Options: nosniff`; `Referrer-Policy: same-origin`. Every response on company routes: **no** `Access-Control-Allow-Origin` (reads are protected by CORS, C3).

### 2.4 The route matrix — lanes in order

`shell/routes.mjs` is a list of lane functions run in this order; a lane returns a response, a redirect, or `null` (next lane). `fleet` = the lane exists only in the fleet gate; `both` = identical code in both modes.

| # | lane | what | mode |
|---|---|---|---|
| 0 | normalise | percent-decode once, remove dot segments, collapse `//`, refuse NUL and a second `%` layer — before anything reads the path [S:B6]; `..` that survives → 404 | both |
| 1 | https | `gate.https(req)` → 301 + HSTS | fleet |
| 2 | Host | `gate.hostAllowed(req)` → portal / company / 404 (never a redirect) | fleet |
| 3 | ticket | `gate.ticket(req, res)` on `/_t/<opaque>` — creates the session, no session needed | fleet |
| 4a | shell-owned assets | `/assets/{react,react-dom,client,chrome-resolve}.js` — public bytes, no identity needed (the same bytes for everyone); `/_chrome/<64 hex>/<path>` — a chrome release's bytes off `cfg.chromeStore` (§2.2; `_chrome` is a reserved head; 404 without a store, for an unknown digest or a path the manifest does not name) | both |
| 4b | document routes, **Host-first** | `/`, `/<c>/`, `/<c>/<s>[/rest]` (GET/HEAD): Host = path company else 404 (fleet) → `identity.resolve` → no session → `gate.unauthDocument` 302 (fleet) → the APP's host (`registry.hostOf(row)`; `registry.host(c)`, the company's freshest, for an app-less document or an unknown slug) stale/draining/dial-fail → the waking page (§3.5) → compose (§2.1–2.3) with the person's rows (presence). A slug the registry does not know still renders the document (the client tidies the URL, 1.x behaviour) | both (Host and 302 fleet) |
| 4c | fetch routes, **session-first** | `/api/<c>/<s>/*`, `/modules/<c>/<s>/*`, the chrome's `/modules/<chrome qid>/*` and `/api/<chrome qid>/*`, `/_atelier/*`: `identity.resolve` fails → 401 `{}` without `Location` (fetches cannot follow a gate redirect) → then Host = path company else 404 (fleet; the chrome's two paths are exempt — the qid the Host company's `registry.chrome()` names is served on every company origin: the fleet's `portal/catalyst-chrome`, the system host's row, for every company; locally `global/<chrome>`); `/modules/<c>` where `<c>` ∈ reserved (`modules`, `api`, …) → 404 [S:B6] | both (Host fleet) |
| 5 | presence | `registry.resolve(c, s)` → 404; `registry.present(person.id, row.instance)` → 404 (same status as a stranger, 42/42 [S:C3]); the chrome's two paths skip presence (session-gated only) but still need the chrome's registry row on the QID's company (`registry.resolve('portal', 'catalyst-chrome')` in the fleet — the proxy then dials that company's host, the system host; locally the staged `global/<chrome>` row): the assertion's `app` is that row's instance, the one the host verifies; no row → 404 + a log line (chrome delivery by digest per computer, PLAN §10 item 6, is step 7) | both |
| 6 | Origin | `gate.origin(req, credential)` on `POST/PUT/PATCH/DELETE` and the WS upgrade — only when `credential === 'cookie'`; `Origin: null` → 403 | both (a no-op locally by evaluation) |
| 7 | authorize | the optional per-app hook — none in 2.0.0 (§9: no read/write gate; presence is the ACL); the lane exists as a no-op function so the order is visible | both |
| 8 | proxy | `/api` and `/modules` through `hostLink.request` (§3.2–3.3); `/_atelier/ws` upgrade → the events socket (§3.4); `/_atelier/whoami` → `{id, name, anonymous:false}`; `/_atelier/report` (POST, ≤ 64 KiB) → forwarded to the host signed with `app = body.instance` (presence-gated on that instance); `/_atelier/topics/<topic>` → `bus.snapshot(topic, {person})`; `/_atelier/rail` = `bus.snapshot('company:<c>', {person})` — the person's rows; `/api`/`/modules` dial `registry.hostOf(row)` (the app's computer); `/_atelier/metrics` (GET) → the exposition of §3.6, admitted to an operator session or local mode, 404 otherwise | both |

Anything else → 404 `{}`; a non-GET/HEAD on a document route → 401 `{}` unauthenticated (no `Location`, no ticket mint — PLAN §4.1) and 405 with a session; an Upgrade anywhere but `/_atelier/ws` → 426. The 1.x-only surfaces (`/_atelier/inflight`, `/_atelier/client-errors`, the takeover bootstrap, `observe`) do not exist in 2.0 — they are not "skipped", they are gone (§4.8 N6).

---

## 3. How the shell talks to the host

### 3.1 The assertion minter

`shell/minter.mjs`: one Ed25519 key pair per shell process, generated at start (`generateKeyPairSync('ed25519')`), **private key never leaves the process** (no file, no env — C3 rewrite, §4.9 step 0); the public key travels to the spine at the shell's own registration (step 5) and is what `register()` hands each host as `shell_public_key_hex`. Local mode: the key exists and mints; the host's local transport currently mints its own pair (§8 H2).

```js
createMinter({ keys = generateKeyPairSync('ed25519'), now = () => Math.floor(Date.now() / 1000) })
  → { publicKeyHex, header({ hostId, instance, method, path, person }) → string }
// header() = protocol/identity mint(priv, {aud: hostId, app: instance, method, path, person}, {now: now()})   ttl = MINT_TTL_S (30 s)
```

`path` is `req.url` **exactly as forwarded** (query included, after lane 0's normalisation — the host verifies `path` against the `req.url` it receives, so what is signed is what is sent); `person` = `{id, name, claims}` from the identity provider, nothing else (the closed key set). Header: `x-atelier-identity: <b64u(payload)>.<b64u(sig)>`. Every request mints a fresh nonce; nothing is cached. `/_atelier/report` is signed with `app = body.instance` after the body was read (≤ 64 KiB) and re-sent as a buffered body.

### 3.2 Header lists (protocol/headers, applied by `shell/proxy.mjs`)

- Request: `rejectFraming(raw)` on the RAW set → 400; `filterRequestHeaders` keeps the allowlist (`accept, accept-encoding, accept-language, content-type, content-length, if-none-match, if-modified-since, range, if-range, last-event-id, origin, access-control-request-*, user-agent`) and strips `cookie`, `authorization`, every `x-forwarded-*` and **every inbound `x-atelier-*`** (a forged identity header is dropped before the minter adds the real one); the shell adds `x-atelier-identity` (+ `authorization: Bearer <epoch>.<token>` fleet / `x-atelier-dev-token` local); `host` is the dial's.
- Response: `filterResponseHeaders(raw, { cookieCredentialed: credential === 'cookie', companyOrigin })` — the response allowlist, `set-cookie` and `www-authenticate` never pass, on cookie-credentialed routes every `access-control-*` is cut except an ACAO equal to the company origin, and the shell answers preflights itself; **`location` is passed unchanged** — the host already rewrote a root-absolute one onto `/api/<c>/<s>` (host/protocol/headers.mjs), the shell must not rewrite it again.

### 3.3 Streamed bodies

Both directions are piped, never buffered (the 30 MB artifacts upload and the 25 s spaces long-poll of B6 go through): `req → countedBody({cap: BODY_CAP_DEFAULT}) → upstream`, `upstream → countedBody → res`; `err.code === 'BODY_CAP'` → 413 while headers are open, else the response is cut. The dial: `hostLink.dialMs = 1000` connect cap; a proxy timeout of 30 s **between bytes** (not total — SSE and long-poll live); the dev/protocol socket is reused per host (`http.Agent({keepAlive:true, maxSockets: 64})`). Upstream refused/timeout on a **fetch** route → `503 {waking:true}` + `Retry-After: 2` + `x-atelier-waking: 1`; on a document route → the waking page. C3's byte counters (1 MiB in / 4 MiB out) are the test rows.

### 3.4 The events socket — `/_atelier/ws`

One socket per document; the upgrade runs lanes 0–4c, 6 (Origin iff cookie); `shell/events.mjs`:

- Client messages (`protocol/events messages`): `sub {topics}` → for each topic: presence check by instance (`denied` frame, no frames ever leak, 0/50 in C4) → cursor = ring head → `subscribed {topic, stream, seq}`; `resume {topic, stream, seq}` → `ring.since(topic, {stream, seq})` → contiguous events replayed then `resumed {topic, stream, seq:<head>}`; `gap` or `streamChange` → `gap {topic, stream}` and **delivery on that (socket, topic) stops until the next `resume`**; `pong {at}` answers the server ping.
- Server frames: `subscribed | resumed | denied | gap | invalidate | ping` (`isFrame` on every frame before send). `invalidate` is fanned out from `bus.onAppend` to every (socket, topic) not gapped; gap detection at fan-out keys on cursor lag `head − cursor > RING`, never on `bufferedAmount` (C4 surprise 3).
- Topics a tab may name: an instance id of an app it is present on, `company:<c>` of the document's company; `shell` is reserved → `denied`.
- Liveness (§4.5, pinned in protocol): `ws.ping()` every `SERVER_PING_MS` (10 s), `SERVER_PING_MISSES` (2) → `terminate`; per-(person, company) budget `SOCKET_BUDGET` (8) counting pong-live sockets only, evict the oldest non-live with `CLOSE_EVICTED` (4001).
- Rail: `registry.watch(company)` → `bus.publish('company:<c>')` → tabs refetch `/_atelier/rail` (the digest FOR THE TAB'S ROUTE inside — the active row's `chromeDigest`, the frame's `chromeRev` on an app-less route — → full reload when it moved away from the document's `chromeRev`; never an app document against the default, §4).

### 3.5 The waking page

The app's host row (`registry.hostOf(row)`; `registry.host(c)` for an app-less document) says waking when `heartbeatAt` is older than 30 s or `drainingAt` is set (fleet), or when `hostLink.probe`/the dial fails within `dialMs` (both modes). The document route then serves the waking page (`shell/waking.mjs`: no chrome, plain, a 2 s JS poll of `/_atelier/wake?company=<c>[&app=<slug>]` that `location.reload()`s on `{ok:true}` — with `app`, that app's host is asked, and only when the person is present on it), status 503, `Retry-After: 3`, `Cache-Control: no-store`. **The poll probes and wakes**: on `{ok:false}` the route calls `registry.wake(chat, {by})` — the fleet provider's verb, the spine's `POST /v1/computers/<chat>/wake {by:"session:<portal session id>"}` door, sent by the portal's client with the `x-spine-portal-key` the dial-row reads present. **Never a draining computer** (the drain is a decision — a rollout, the 24 h sleep — and a 2 s poll must not fight it: probe only). **The target is the dial row's `chat`** (`state.hostRow.chat`, the routing seam), the app row's own only when the spine knows no computer for it (no-host); the shell validates the shape (`CHAT_RE`, `[A-Za-z0-9_-]{1,64}`) before firing, the portal encodes it once. **Presence first for the wake as for the probe**: on the app path the person is present on the app; on the app-less path the host is the company's freshest — a room the person may not be in — and it is woken only when `registry.presentOnChat` says they are present on that chat, else probed only. **`by` is the caller** — the portal session id from the request's cookie (`identity.session(req)`); a poll with no session never wakes, and the spine resolves the actor itself and answers 403 for a person not in the chat, 503 when the pool or quota denies, 429 at the fleet-wide wake bound, 202 waking / 200 up otherwise. `createWaker` holds **one call per chat per 30 s PER REPLICA and one in flight** (`{until, inFlight}` per chat: a hung door gets no second socket, however long it holds) — the 30 s window is a per-process courtesy, not the limit; **the spine's own bound is the real limit**. The call is **fired, not awaited** (the door can hold; the portal's client bounds it at 15 s), so the probe's answer never waits on that hop — and **the verdict is read**: the provider answers `{ok, state, reason, error, status}` and the log says `sent` (202: the create accepted) · `up` (200: the pod was live — the host inside it is what failed the probe; the spine's sweep is the repair) · `refused: <reason>` (403/429/503/a plane below v41) · `unconfirmed: <reason>` (the portal's clock ran out, a 2xx without a state — the create may still land) · `failed` (the verb threw); never `sent` for a refusal. The counters ride `GET /_atelier/metrics` (§3.6). Local mode has no verb (the CLI restarts a dead host by itself, §5.1), so the poll only probes there. The fleet's silent gaps are logged: a fleet registry without the verb (an older portal) once per process; a dial row that names no `chat`, or one whose chat is not a chat id, or a poll with no actor, once per company per 30 s — the spine puts `chat` on every row, so the portal's row shaping must pass it through, or the app-less poll has nothing to wake. `{ok:true}` means exactly "the host answered a probe". **The give-up**: 60 s locally (`WAKE_GIVE_UP_MS`), **180 s in the fleet** (`WAKE_GIVE_UP_FLEET_MS`: a cold pod birth is a schedule, a 700 MB pull and a host boot — the wake and the bound are one decision); every poll fetch is aborted at the remaining deadline (a hung shell cannot hold the poll open past it); the tick that lands on the deadline is the give-up: the poll stops and the copy says so — "This computer is taking unusually long to wake, and this page has stopped checking. Wait a minute, then reload this page." — because nothing reloads the page for the person once it stopped; no `<meta refresh>`. **A tab that comes back to the front** (`visibilitychange` → visible) drops the in-flight probe, restores the copy, re-arms the deadline and probes at once — a phone locked while the pod is born never lands on the give-up copy against a computer that is up; the give-up is only ever reached in front of someone. Fetch routes answer `503 {waking:true}` (§3.3) and the client shows its own waking fallback (§4) with the same poll and the same bounds (`client/waking.js`, `boot.portal` picks the fleet's). A dial is capped at **1 s** so a sleeping computer costs one second, never a hung request (§4.3 Network).

### 3.6 Metrics — `GET /_atelier/metrics`

`shell/metrics.mjs`: one collector per shell, read as **Prometheus text exposition** (`text/plain; version=0.0.4`, `no-store`) — no dependency, no scrape state, no push. It carries the rows of PLAN §4.5 the shell owns and no others; the host's worker resume, save→error e2e, Tailwind build time, volume size and container restarts belong to other planes.

**Who may read it.** An **operator session** (`identity.resolve(req).op`, §1.1) or **local mode** (the shell is the operator's own process). To anyone else — a signed-in member included — it is **404**, the same answer lane 5 gives a stranger and the same answer an unknown `/_atelier/<name>` already gives, so the route is not an existence oracle. No session at all is the fetch lane's 401.

| metric | type | labels | what it measures |
|---|---|---|---|
| `atelier_shell_proxy_headers_ms` | summary (p50, p99, `_sum`, `_count`) | `host` | ms from proxy dispatch to the host's response headers |
| `atelier_shell_proxy_body_ms` | summary | `host` | ms from proxy dispatch to the last body byte |
| `atelier_shell_proxy_requests_total` | counter | `host`, `outcome` | `ok` · `waking` (a refused dial, or a waking mark that skipped the dial) · `timeout` (host idle past `idleMs`) · `error` (502, or a response cut past the cap) |
| `atelier_shell_events_frames_per_second` | gauge | `topic` | document-socket frames sent, averaged over the last 60 s |
| `atelier_shell_events_frames_total` | counter | `topic` | the same frames, lifetime |
| `atelier_shell_events_gaps_total` | counter | `topic` | `gap` frames — a cursor the ring rotated past; delivery on that (socket, topic) stops until the tab resumes |
| `atelier_shell_events_resume_ms` | summary | — | ms from a client's `resume` to its replay and ack (a **denied** resume is a refusal, not a resume, and is not timed) |
| `atelier_shell_events_sockets` | gauge | — | open document sockets (budget 8 per person per company, §4.5) |
| `atelier_shell_events_sockets_total` | counter | `event` | `opened` · `denied` · `evicted` · `reaped` · `stalled` |
| `atelier_shell_bus_events_total` | counter | `outcome` | events the ingest lane `appended` to the ring or `rejected` (envelope, unregistered epoch, non-monotonic seq) |
| `atelier_shell_document_bootstrap_bytes` | summary | `company` | bytes of the `window.__ATELIER__` JSON composed into a document (§4.5's page budget is ≤ 500 KB gzip for the whole document; this is the part the shell writes) |
| `atelier_shell_registry_cache_age_seconds` | gauge | — | the age of the **oldest live** registry cache entry — how stale a read can still be when a revocation lands. Fleet only: the local registry's 1 s host view is not a revocation cache |
| `atelier_shell_wake_calls_total` | counter | `outcome` | wake calls to the spine door by verdict (§3.5): `sent` (202 accepted) · `up` (200: the pod was live) · `refused` (the spine said no) · `unconfirmed` (no verdict inside the portal's clock) · `failed` (the verb threw) · `held` (inside the per-chat window, or a call in flight). Zero locally: no verb |
| `atelier_shell_wake_in_flight` | gauge | — | wake calls to the spine door in flight on this replica |

The `host` label is the address `registry.hostOf(row)` resolved to (`waking.mjs hostKey`) — the string lane 8 already built for the waking mark, so the proxy adds no per-request allocation of its own. A 400/413 the shell itself refused is not the host's row and is not counted.

Two shapes ride that one label, because `hostKey` has two: `<ip>:<port>` for a company with a live host row, and `company:<id>` for one with none — the `waking` refusal a stopped chat pod earns before any dial. Only an address ever carries `_headers_ms`/`_body_ms`, so `sum by (host)` over `atelier_shell_proxy_requests_total` mixes an address with a company id and a per-host panel grows rows that are not hosts. A reader wanting hosts alone selects `host=~".+:.+"`.

**Unknown reads `NaN`**, as the spine's and the host's expositions render it — never `0`, which is a reading. A sample that is not a finite number never enters a ring (`push()` refuses it), so no `_sum` can be poisoned into reading as a healthy nothing.

The `topic` label holds only topics the bus **allowed**: a `denied` frame carries the client's own string back, and counting it would let any member fill the bounded topic map — whose cap drops the OLDEST key — with strings of their choosing and evict every real row. `events.mjs` skips `denied` in `send()`, the same law the ring keeps when it refuses to create a ring for an unregistered topic.

All latencies are milliseconds off the shell's own clock — the one `trace` stamps `ms` with — so a resume answered inside a millisecond reads 0.

**Cost.** One Map lookup and one number into a preallocated ring per event; nothing is sorted, summed or formatted until someone reads. Latency series are a 512-sample ring (the quantiles are over what the ring holds; `_sum`/`_count` are lifetime), frames/s a ring of 60 one-second buckets. Every keyed map is bounded at 256 keys, oldest dropped, so a churn of host addresses or topics cannot grow the shell. A collector with nothing in it renders an empty body rather than a page of zeroes.

**Not here, and why.** *Ingest batch size and the per-host share of ingest time* (§4.5): the shell's ingest is one event at a time — the spine stream's `onEvent` in the fleet, one mapped host frame per company socket locally. Batching and per-host attribution live where the batch does, in the host→spine push and the spine's per-host ingest limit; the shell can only count what it accepted and refused, which is the `bus_events_total` row. *Membership cache staleness*: `registry.present` delegates to the membership seam, whose cache is the portal's, not the shell's.

---

## 4. The client fork — `client/client.jsx`

The fork starts from the worktree's `client.jsx` (the host branch's version: main + `withDevToken` and the `rev` argument); line numbers below are that file's. `client/index.html` is the head-order template of §2.2. Built by the shell with esbuild (`loader: 'jsx', jsx: 'transform', jsxFactory: 'React.createElement', format: 'esm', target: 'es2020'`, minified in production) and served at `/assets/client.js` with `ETag` = the source mtime; `client/bridge.js`, `client/self.js`, `client/route.js`, `client/sheet.js` are plain ES modules the fork imports (so `node --test` can run them without a DOM).

| 4b item | 1.x (client.jsx line) | 2.0 behaviour |
|---|---|---|
| **three-base `self()`** | `window.__atelier.self` L160–172: `qid` from `import.meta.url` minus `/modules/`, `api`, `topic`, `subscribe` | `client/self.js` = spike-b6 `self.js` ported: accepts `import.meta.url`, `location.pathname` or an API URL; returns `{company, app, qid, base:'/acme/todo/', modules:'/modules/acme/todo/', api:'/api/acme/todo', rest}` **plus the 1.x fields** `workspace`(=company), `id`(=app), `topic`(=qid), `subscribe(handler)`; `modules`/`api` as a first segment never parse as a company. `subscribe` maps the qid to the app's **instance** through the bootstrap module row and subscribes on that topic — a module still writes `self.subscribe(fn)` and never sees instance ids |
| **per-topic cursors + `resume`** | `wireWsBridge` L38–175: one socket, topic → handlers, backoff 250 ms → 5 s, `probeAuth` L66, `OFFLINE_GRACE_MS` L55, no keepalive, no cursor | `client/bridge.js` = r2/spike-mobile-safari-1 `lab-bridge2.js` ported: per-topic `{stream, seq, pending}` kept across sockets; a new socket sends `resume{topic, stream, seq}` for every topic with a cursor and `sub` for the rest; `subscribed` → snapshot; `resumed` → nothing; `gap` → one snapshot then `resume`; a frame with `seq ≠ cursor+1` → treated as a gap; frames during a snapshot are buffered and those with `seq ≤ snapshot.seq` dropped (C4 surprise 7); a `stream` change → snapshot. `probeAuth`/`OFFLINE_GRACE` stay for the `atelier:connection` banner event but the state comes from the ping, never from `readyState` |
| **the foreground hook** | none (`online`/`readyState` were the only signals — and they lie on a corpse) | app-level `ping`/`pong` every `PING_MS` (1 s) while visible, a pong older than 1 s = dead → `kill()` + reconnect; `visibilitychange`/`online`/`pageshow(persisted)` hooks: `hiddenFor` measured with **`Date.now()`** (`performance.now()` may not advance in iPhone sleep), hidden > 30 s or a bfcache restore → reconnect at once, else ping with a 500 ms pong budget. Acceptance bar = the spike's numbers: consistent ≤ 0.6 s after foreground, exactly one gap + one snapshot per over-ring topic, 0 dup / 0 out-of-order |
| **replaces the shell-topic hot-reload path** | `subscribe('shell', …)` L690–734: `reload` frames with `moduleId`/`cssOnly`, `?v=` re-import, `refreshChromeStyles()`, `location.reload()` for the chrome/shell/unknown ids; `backend-error` frames → overlay | no `shell` topic (reserved). Each **loaded** module subscribes on its instance topic; `invalidate` → `GET /_atelier/topics/<instance>` → `{rev, error}` → if `rev` moved: re-import `frontend.js?rev=N` (token-guarded as before) + sheet swap to `styles.css?rev=N` when it is the active app; `error` → the overlay for that qid (cleared when null). The document subscribes on `company:<c>` → `GET /_atelier/rail` → module rows replaced in state (new app appears, meta/primary changes), the digest for THIS route moved (`client/chrome.js chromeMoved`: the active app's row `chromeDigest`, the frame's default on an app-less route, against `boot.chromeRev`) → `location.reload()` (a chrome cannot swap inside a document; a computer lagging the default — pinned, still fetching — loads once, never a loop); a navigation to an app whose row names another digest is a page load (`location.assign`). The chrome bundle loads from `boot.chromeBase` when set (`/_chrome/<digest>/frontend.js`, immutable), else `/modules/<qid>/frontend.js?rev=<chromeRev>`. A module never imported in this document (lazy) needs nothing — its first visit imports the current rev |
| **picker → portal POST** | `pickWorkspace` L780–796: SPA to `/<ws>/<id>` | the picker renders `boot.companies` (local: every workspace, `href:'/<ws>/'`, `location.assign`) and, when `boot.portal` is set (fleet), a same-origin-to-the-portal `<form method=post action="<portal>/picker">` per company — one page load, one tap (§4.1). `pickWorkspace(ws)` keeps its signature for the chrome (`chromeApi: 2` chromes may read `boot.companies` directly); it navigates by full page load in both modes |
| **rail refetch on the company topic** | the module list is frozen in the bootstrap; a new module = `reload 'shell'` → full reload (L913–920 server side) | above: `company:<c>` invalidate → `/_atelier/rail` → `setModules(rows)`; no reload |
| **the waking page** | none (502/ECONNREFUSED = a broken page) | a `503 {waking:true}` on a bundle import, a snapshot or an API call the client itself makes (`/_atelier/*`) → `WakingFallback` (plain `<pre>`, like the fallbacks at L414) with a 2 s → 10 s backoff poll of `/_atelier/wake?company=<c>[&app=<active slug>]` (the shell wakes the computer on the first miss, §3.5), bounded at 60 s like the shell's page (`onGiveUp` → the copy says the wake is taking unusually long, reload by hand); on `{ok:true}` → `location.reload()`. App fetches are the app's own; the fallback covers the shell's |
| **revision ids instead of `?v=`** | `loadModuleBundle(qid, bust, rev)` L310–334 (`?v=${bust}` for 1.x frames, `?rev=` when the frame carries one); `refreshChromeStyles` L347–360 `?v=${++_cssBust}` | `loadModuleBundle(qid, rev)`: `/modules/<c>/<s>/frontend.js?rev=N` always (`rev` from the bootstrap row, then from snapshots); no `?v=` anywhere; the host serves exactly that revision (`ETag "rev-N"`, 304 on revalidation) |
| **per-app sheet swap on SPA navigation** | one chrome sheet baked at load; `refreshChromeStyles` re-fetches it | `client/sheet.js` `swapSheet(href)`: the 1.x FOUC-free clone-load-drop mechanism (L347–360) generalised to a *target href*: on every navigation to `<c>/<s>` → `/modules/<c>/<s>/styles.css?rev=N`; to an app-less route → the chrome sheet; on an invalidate of the active app → the new rev's sheet. Cost measured in the drill (§10 item 13) |
| **`chromes` from the bootstrap** | `boot.chromes` L564 + `chrome-resolve.js` | unchanged mechanism; the shell always advertises exactly the document's chrome, so an unadvertised `meta.chrome` renders the existing error (L815–825) and `requiredChromeForQid` never triggers a cross-chrome full load in the fleet |
| **no eager / TopBarCenter** | `meta.eager` boot loads L622–624; `TopBarCenter` export read at L322 | both removed: nothing loads at boot but the chrome and the active app; the loader returns `{Module, chrome, meta}` only |
| **`withDevToken` / `?rev` folded in** | L41–48, L310–318 (host branch) | `?rev` is the mechanism above. `withDevToken` is kept as a no-op-by-default helper (the 2.0 document has no token in its URL — the browser talks to the shell, not the host's dev shell), so a fork served through the host's dev shell still works |
| removed | `Takeover` L383–407 + the L550 check (1.x auth hand-off); the `observe` reporter L255–298; `flattenUserModules` L362–377 | the gate is the portal (no auth module); the reporter becomes **always on**: `window.onerror`, `unhandledrejection`, first-per-message `console.error` → `POST /_atelier/report {instance, rev, url, ua, message, stack}` for the active app, ≤ 10/min per page (OR16, the kit's channel); modules come from `boot.user.workspaces[0].modules` with `instance` and `rev` per row |
| kept | `parseUrl`/`buildUrl` L188–207 (now `client/route.js`, one DNS label per segment: `SLUG_RE`, decode once), `useRoute`/`navigate` L221–244, `ChromeMissingFallback` L414, `BackendErrorOverlay` L437 (fed by snapshots), the two boundaries L488/L524, the App skeleton L548–861, `navigateTo` L759 (+ the sheet swap), `navigateByQid` L768 | |

The chrome contract (`chromeApi: 2`) is the 1.x prop set (`boot, user, modules, workspaces, workspace, activeQid, active, loadedModules, navigate, pickWorkspace`) minus slot claims; catalyst-chrome renders unchanged (it reads none of the removed surfaces — verified in the drill).

---

## 5. Local mode — `npx atelier`

### 5.1 Process layout

```
npx atelier                                 cli.js → shell/cli-local.mjs
  ├─ SHELL   http://localhost:<P>            (P = config `port` | env PORT | 1844) — the 2.0 document, the WS, the proxy
  └─ HOST k  node host/index.mjs             one per non-empty workspace, k = 0…, loopback only
       dev shell  127.0.0.1:<P+10+k>         token-only (the shell's link); the agent's byte-identical view too
       protocol   127.0.0.1:<P+20+k>         bearer-only; unused by the local shell (§8 H2)
```

Env per host k (workspace `ws`): `ATELIER_WORK=<root>/.atelier/local/<ws>`, `ATELIER_RUN=/tmp/atelier-<hash8(root)>/<ws>` (short: macOS caps a socket path at 104 bytes), `ATELIER_COMPANY=<ws>`, `ATELIER_ORIGIN=http://localhost:<P>`, `ATELIER_CHROME_DIR=<elected chrome folder>`, `ATELIER_DEV_PORT=<P+10+k>`, `ATELIER_HOST_PORT=<P+20+k>`, `NODE_ENV=<env setting>`, `ATELIER_GIT_COMMIT=0` (the host's per-LIVE commit would write into the user's own repo), `ATELIER_APPS_LINKS=1` (§8 H1). Every host is a child of the CLI (stdio inherited with a `[host ws]` prefix); SIGINT/SIGTERM → SIGTERM to every host, wait ≤ 5 s, exit; a host that exits is restarted with 0.5 → 30 s backoff (the shell serves the waking page for that workspace meanwhile); after 10 exits in 10 min it stays down and the CLI prints why.

**The dev token hand-off.** The CLI mints `$ATELIER_RUN/dev.token` (32 random bytes hex, mode 0600) before spawning the host; the host reads it once at boot (`readDevToken`) and never mints its own because the file exists; the shell's local `hostLink` reads the same file. No token in any env, no token in any browser URL — the browser talks to the shell only.

On this Mac the 1.x atelier owns 1844: the drill runs `PORT=18440 npx atelier` → hosts on 18450/18460.

### 5.2 What "unchanged" means concretely

| 1.x surface | in `npx atelier` (2.0 local) |
|---|---|
| the instance folder | resolved as 1.x (`discovery.js resolveRoot`: `ATELIER_ROOT` → the `node_modules` owner → the parent of `PWD`), printed at start `Atelier · local · <root> · http://localhost:<P>` |
| root-folder modules = `global` | company `global`, host 0; URLs `/global/<id>` exactly as 1.x |
| `$<ws>/` folders | one company per workspace, its own host; URLs `/<ws>/<id>`; the picker lists them |
| `atelier.config.json` `modules` filter (allow/deny, `{workspace}` blocks, path entries `./dir`, `~/dir`, `{path, id}`) | applied by the shell's discovery with the unchanged `discovery.js` functions; path entries mount into the named workspace's host like any folder; the filter is re-read on the apps-root watch (live, as 1.x) |
| settings `port`, `host`, `defaultChrome`, `env`, `label` | honoured (`PORT`/`HOST`/`NODE_ENV`/`ATELIER_DEFAULT_CHROME`/`ATELIER_LABEL` env override, as 1.x) |
| the chrome | elected as 1.x (setting, else alphabetical `isChrome`), served from the host as `global/<chrome>`; **one chrome per run** |
| `npx atelier <id>` / `<ws>/<id>` (standalone, `npm run dev:module`) | untouched: the dispatch line fires only for a bare `atelier` (no non-flag argument), everything else reaches 1.x `server.js` as before |
| `atelier add/update/package/publish/list` | untouched `VERBS` |
| `ATELIER_1X=1 npx atelier` | the 1.x host mode (`server.js`) — the operator's escape hatch while both exist |
| `ctx.dataDir` | the **host's** contract: `<root>/.atelier/local/<ws>/.atelier/data/<instance>/` — outside the module folder, keyed by instance (§2, [S:D1]); a 1.x module's `<module>/data/` is not read (the doctor's N1 rewrites self-pathed data; a module that only ever used `ctx.dataDir` starts empty here and keeps its 1.x data where it was) — stated, not hidden |
| hot reload | the host's watcher + last-good (a broken save changes nothing for the page; the overlay shows the failure from the topic snapshot) |
| `module.json` | required by the host (OR10); absent → generated once from the literal `export const meta` (§5.3) |

### 5.3 Discovery and staging (`shell/local/`)

1. `discover(root, config)` → rows `{workspace, id, dir, meta, hasFrontend, hasBackend}` using `discovery.js` (`isSpecialDir`, `isWorkspaceDir`, `RESERVED_NAMES`, `loadModuleConfig`, `shouldIncludeModule`, `collectConfigPaths`) and 1.x's static literal reader ported to `shell/local/meta.mjs` (server.js `extractMetaStatically`; the sandbox fallback is dropped — 0/58 corpus modules needed it). A folder is a module when it has `frontend.jsx` or `backend.js`.
2. `module.json`: present → read; absent → written next to `frontend.jsx` as `{name, icon, group, primary, color}` from the literal meta (`name` defaults to the folder name), mode 0644, one log line `wrote <dir>/module.json from the literal meta`. Chromes (`isChrome`) are never staged as apps.
3. Slugs: a 1.x id that is not one DNS label (`SLUG_RE`: lowercase, `-` only) is **not mounted** and logged with the doctor's wording (`'My_App' is not a slug — rename the folder`); the corpus has none.
4. Staging: `<root>/.atelier/local/<ws>/apps/<id>` → symlink to the module folder (a real dir: relative imports, `data/`, `node_modules` resolve in place); stale links removed; `<root>/.atelier/` is a dotdir so 1.x discovery ignores it. The host discovers the symlinks (§8 H1) and claims them into its `registry.json` under company `<ws>`.
5. Ports and env as §5.1; hosts spawned; the shell starts at once and serves the waking page for a workspace until its host's `/_host/healthz` answers (bounded: the probe is per request, 1 s cap — never a startup wait).

### 5.4 The macOS jail note (documented, not pretended)

Without root the host's adapter is `unprivileged()`: no uid drop, chown/chmod are logged no-ops, workers run as you. The jail is **lifecycle-only** — SIGSTOP/SIGCONT CPU throttle, RSS kill, fork cap (`RLIMIT_NPROC` where `prlimit` exists — not on macOS; the RSS watchdog and the throttle do) — and gives **no confinement between apps**: any worker reads any folder you can read. The CLI prints one line at start: `jail: lifecycle-only (no uid drop) — apps are not isolated from each other on this machine`. Sidecars (`listen()` in a backend) keep working exactly as in 1.x on a laptop (§4.7).

### 5.5 Fleet-ignored settings (listed explicitly)

Read from `atelier.config.json` and honoured locally, **ignored in the fleet** (the fleet value in parentheses; the fleet shell logs each one it finds in a deployed folder's config exactly once, `ignored in the fleet: <key>`): `port` (the shell's own), `host` (pod IP / loopback), `baseUrl` (the company origin, published to workers as `ctx.baseUrl`), `env` (production), `defaultChrome` (the pinned chrome), `label` (the company name), the `modules` filter (the registry: every claimed app of the chat). Ignored in **both** modes — the 1.x surfaces that do not exist in 2.0, logged once locally as `ignored in 2.0: <key>`: `hotReload` (always on: the host watches), `auth` (the gate is the portal; local identity is the process's), `revalidateMs`, `observe` (compiled out; the error reporter is always on). `ATELIER_ROOT`, `PORT`, `HOST`, `NODE_ENV`, `ATELIER_DEFAULT_CHROME`, `ATELIER_LABEL` env overrides work locally as 1.x.

### 5.6 The CLI wiring

`cli.js` takes **one inserted line** between the verb branch and the `else`:

```js
} else if (process.argv.slice(2).every((a) => a.startsWith('--')) && process.env.ATELIER_1X !== '1') { await import('./shell/cli-local.mjs');
```

A bare `atelier` (flags only: `--port`, `--open`) is 2.0 local mode; `atelier <id>` stays 1.x standalone; the doctor lane's own line goes into the `VERBS` map, so the merge is two independent hunks. No `bin/atelier2.js`.

---

## 6. File layout — three lanes

```
shell/
  DESIGN.md                this file · README.md — how to run it
  index.mjs                createShell({cfg, providers}) — wires routes, events, proxy, document, assets
  config.mjs               cfg from atelier.config.json + env (local) / env (fleet); the ignored-settings log
  routes.mjs               the lane list of §2.4, in order; lane functions are exported for tests
  document.mjs             bootstrap + head order + preloads + CSP + escaping (§2.1–2.3)
  assets.mjs               /assets/*: UMDs (prod/dev), client build (esbuild over client/client.jsx), chrome-resolve.js, gzip
  proxy.mjs                streamed proxy through hostLink: header lists, counted bodies, 503-waking mapping
  minter.mjs               the Ed25519 key + header()
  events.mjs               /_atelier/ws: sub/resume/gap/ping, per-socket cursors, budget, server ping, fan-out
  waking.mjs               the waking page + /_atelier/wake
  metrics.mjs              the §4.5 rows the shell owns + GET /_atelier/metrics (operator / local only)
  providers/
    identity-local.mjs   identity-fleet.mjs (step 5: interface + a fake for the shell tests)
    registry-local.mjs   registry-fleet.mjs (step 5)
    gate-local.mjs       gate-fleet.mjs (step 5)
    bus-local.mjs        bus-fleet.mjs (step 5)
    hostlink-local.mjs   hostlink-fleet.mjs (step 5)
  local/
    discover.mjs           1.x discovery (discovery.js) + module.json generation; meta.mjs (the literal reader)
    stage.mjs              the symlink tree under <root>/.atelier/local/<ws>/
    hosts.mjs              spawn / restart / stop the hosts; the dev-token mint; port plan
  cli-local.mjs            the `npx atelier` entry (§5)
  test/                    node --test shell/test/*.test.js
client/
  index.html               the head-order template (five slots)
  client.jsx               the fork (§4)
  bridge.js self.js route.js sheet.js
  test/                    node --test client/test/*.test.js (pure modules; the DOM parts are the drill's)
```

Lane A (shell core + local providers): `shell/{index,config,routes,document,assets,proxy,minter,events,waking,metrics}.mjs`, `providers/*-local.mjs`, the fleet interfaces as fakes. Lane B (local wiring): `shell/local/*`, `shell/cli-local.mjs`, the one `cli.js` line, `shell/README.md`. Lane C (client): `client/*`. No new runtime dependency: `react`/`react-dom` UMDs, `esbuild`, `ws` are in `package.json`; Tailwind is the host's.

---

## 7. Tests

### 7.1 `node --test shell/test/*.test.js` (no browser, no host process; fakes for the providers)

- `routes.test.js` — lane order as a table: each row = `{mode, req} → {status, location?, lane}`; the fleet rows use a fake gate (Host mismatch 404, unauth document 302 with path only, fetch 401 without Location, `/modules/modules/x` 404, Origin 403 on cookie writes and `Origin: null`, GET with a foreign Origin 200); the local rows prove the skips (`http://localhost` no redirect, no HSTS header, `/_t/x` 404, POST without Origin 200); normalisation rows from B6 (`%2e%2e`, `//`, NUL).
- `document.test.js` — head order by regex position (styles < react < react-dom < bootstrap < importmap < preloads < client), the preload list for an app with a relative import, the bootstrap escaping (`</script>`, U+2028, a function value), `chromeApi: 2`, `chromes` = exactly the document's chrome, one `<link>` (app sheet on `/c/s`, chrome sheet on `/c/`), CSP nonce equality, `no-store`.
- `proxy.test.js` — header lists both ways against a fake upstream (forged `x-atelier-*` stripped, `cookie`/`authorization` never forwarded, `set-cookie` never returned, `location` passed as-is, ACAO cut on cookie routes), C3's counted bodies (1 MiB in / 4 MiB out streamed through a `PassThrough`), 413 at cap+1, ECONNREFUSED → `503 {waking:true}` within `dialMs`, SSE chunks flushed before end.
- `minter.test.js` — every header verifies with `protocol/identity verify` against the minted public key with `hostStartedAt`; `path` = the forwarded `req.url` including the query; ttl 30 s; a re-signed report carries `app = body.instance`.
- `events.test.js` — the C4/mobile-safari rows with an in-process ring and a `ws` client: `sub` → `subscribed` at head; 300 events on a paused socket → exactly one `gap`, delivery stopped until `resume`, then contiguous; `resume` with a stale stream → `gap` (streamChange); `denied` for a foreign instance and for `shell`; server ping 2 misses → terminate; budget 9th socket → the oldest non-live closed 4001.
- `bus-local.test.js` — a fake dev-shell WS server: `reload {moduleId, rev}` → one invalidate per topic with monotonic seq; `backend-error` → invalidate; a broadcast → invalidate; a new healthz epoch → `registerEpoch` → `since()` is `streamChange` for every old cursor.
- `registry-local.test.js` — discovery over a fixture instance (`global/a`, `$ws/b`, a chrome, `_skip`, a config with a deny and a path entry) → the mount table; `module.json` generated from a literal meta and not rewritten when present; a non-slug id refused with the message; `present()` true.
- `metrics.test.js` — the ring math with an injected clock (p50/p99 over the last samples while `_sum`/`_count` stay lifetime, the 60 s rate window emptying, the key cap dropping the oldest host), every exposition line against the text grammar with an escaped label, `registry-fleet cacheAgeMs` (the oldest live entry, `null` once every entry expired), the gate (local 200, a fleet member 404, no session 401, an op session 200, non-GET refused) and the live rows through a running shell: one proxied request per host address, a stopped host counted `waking` twice (the second answer is the mark's), the document's bootstrap bytes, socket frames, one gap and one timed resume.
- `cli-local.test.js` — the port plan, the env of each spawned host (a fake `spawn`), the dev token minted 0600 before the spawn, `ATELIER_GIT_COMMIT=0`, SIGTERM order and the ≤ 5 s bound, the ignored-settings log lines.

### 7.2 `node --test client/test/*.test.js`

- `self.test.js` — spike-b6's `test-self.mjs` vectors (the three URL shapes, `modules`/`api` never a company, encoding, `rest`) plus the 1.x compatibility fields.
- `route.test.js` — `parseUrl`/`buildUrl` rows (deep links, trailing slash, decode once, non-slug → null).
- `bridge.test.js` — the bridge with a fake `WebSocket` and fake `fetch`: cursor kept across a socket death and `resume` sent per topic on the new socket; `gap` → one snapshot → `resume`; buffered frames ≤ snapshot.seq dropped; a non-contiguous seq → gap; ping timeout at 1 s; the foreground rule (`hiddenFor` > 30 s → reconnect; `pageshow persisted` → reconnect; else 500 ms pong budget) with an injected clock.
- `sheet.test.js` — `swapSheet` with a fake DOM: the new link inserted after the old, the old dropped on `load`/`error`, the id transferred, no-op on an equal href.

### 7.3 The browser drill (horse-browser, own tabs, closed at the end; ports 18440/18450/18460)

Setup: a scratch instance folder with `weather/` and `toybox/` copied from `003-atelier-modules` (no `module.json` — the generator must write them) and `catalyst-chrome/` linked as a global module; `PORT=18440 NODE_ENV=production npx atelier` from that folder as ONE background task with a bounded verdict (≤ 3 min per row, `VERDICT:` last line); every row reads the tab's console and resource timings.

| row | what | pass |
|---|---|---|
| a | `http://localhost:18440/global/weather` and `/global/toybox` render inside catalyst-chrome | 0 console errors, 0 failed loads, the bootstrap has `chromeApi: 2`, one `<link>` (the app sheet, `?rev=N`), preloads after the import map, ≤ 500 KB gzip / ≤ 14 requests / depth 3 for weather |
| b | API through the shell | from the page: weather `/api/global/weather/forecast` and `/current` 200 (live data on screen), toybox `/api/global/toybox/skills` 200; every request carried `x-atelier-identity` at the host (host stderr) and none of `cookie`/`authorization`/a forged `x-atelier-user` (send one from the page — the worker sees `req.user.id === 'local'`) |
| c | WS `sub`/`resume`/`gap` on a severed socket | subscribe on toybox's instance topic; save `backend.js` → one `invalidate` → the page re-imported `frontend.js?rev=N` (no navigation, a page-lifetime marker survives) and `fetch(self.api + '/skills')` returns the new field; then sever the socket (kill the shell's ws server side via `wss.clients` from a debug hook) and push 300 saves' worth of invalidates from a fake host into the bus → on the new socket: exactly one `gap`, one snapshot, `resume`, then contiguous seq; a broken save → the overlay shows `backend.js:L:C … — fix …` from the snapshot; the fix clears it |
| d | hard reload | `Page.reload(ignoreCache)`: renders, 0 errors, every host URL carries `?rev=<content id>`; the shell's own assets (`/assets/*.js`, the gate's sheet) carry `?v=<sha256 of the bytes, 16 hex>` (`shell/assets.mjs versions()` — 2026-09-05); no `?token=` anywhere |
| e | SPA navigation weather → toybox → weather with the per-app sheet swap | rail click: no navigation, `document.getElementById('atelier-chrome-styles').href` moves to `/modules/global/toybox/styles.css?rev=N`, exactly one link at rest, the chrome's `lg:hidden` header layout unchanged (main.x stable), swap cost measured (§10 item 13: time from click to the new sheet's `load`) |
| f | the waking page | `kill -STOP` the host → a document GET answers 503 + the waking page within 1.2 s; a bundle fetch from the page gets `503 {waking:true}` and the client shows `WakingFallback`; `kill -CONT` → the page reloads itself and renders; a host kill (`-9`) → the CLI restarts it and the page comes back |
| g | `atelier <id>` unchanged | `node cli.js weather` in the same folder is 1.x standalone (`server.js` banner, 1.x document, no `shell/` code loaded — `--require` hook counts imports) |

Screenshots per row into `shell/drill/out/`; the run script `shell/drill/run.sh` is the backgrounded task.

---

## 8. Seams owed by other lanes, and resolutions

- **H1 (host, ~2 lines, gates step 4's local wiring):** `host/supervisor/discovery.mjs` L77 treats a symlink to a directory in `/work/apps` as a folder when `ATELIER_APPS_LINKS=1` — local mode only; `host/index.mjs config()` refuses the variable in fleet mode (a symlink in `/work/apps` planted by the agent must stay `not-a-dir` there). Without it the staging of §5.3 cannot work; the alternative (pointing a host's apps root at the instance folder itself) writes `CLAIM-REFUSED.txt` into every `$<ws>/` folder and is rejected.
- **H2 (host, later, not gating):** `localTransport` takes the shell's public key and writes the host's `<epoch>.<token>` to `$ATELIER_RUN/host-link.json` (0600) so the local shell can dial the protocol port with a verified assertion instead of the dev lane. Until then §1.5's local row holds.
- **The chrome's backend** (catalyst-chrome ships `backend.js`, [S:migration-local-3] surprise 5): the host mounts the chrome folder as a worker only when it is under `/work/apps`; `ATELIER_CHROME_DIR` is assets + sheet only. Local mode therefore stages the chrome folder as an app too (`global/<chrome>`, `module.json` from its literal meta) so `/api/global/catalyst-chrome/docs` answers; the shell's chrome exemption from presence covers `/modules/global/<chrome>/*` and `/api/global/<chrome>/*` alike (PLAN §4.1) — both signed with the staged row's instance, the one the host's protocol lane verifies.
- **Resolutions:** (1) one shell socket frame set — 1.x payload broadcasts are collapsed to invalidations (§1.4), the doctor names the break; (2) the overlay stays, fed by the snapshot's `error` (local only; the fleet snapshot never carries one — OR16); (3) `primary` locally = `module.json`'s value (no portal to apply it); (4) local mode = one chrome; a `meta.chrome` naming another renders the client's error; (5) `?token=` never reaches a browser in 2.0 local mode; (6) every local wait is per request with a 1 s dial cap and a `VERDICT`-ended background task in the drill — the CLI never blocks on a host boot.

---

## A1. Lane A (shell core + providers) — current state (append-only)

Built: `index, routes, document, assets, proxy, minter, events, waking, config, metrics` and all
ten providers (`providers/*-{local,fleet}.mjs` + `hostlink-base.mjs`); 65 tests in `shell/test/`;
`shell/drill/smoke.mjs` runs the shell with local providers in front of the real host. Deviations
from §1–§3 as built, each a stated choice:

1. **Interface additions** (README lists them ⊕): `registry.companies()`, `registry.byInstance()`,
   `registry.noteProbe()`, `registry.refresh()`, `gate.hsts()`, `bus.reprobe()`, `hostLink.json()`.
   `byInstance` exists because the socket, `/_atelier/topics/<instance>` and `/_atelier/report` name
   apps by instance while §1.2 resolves by (company, slug); the fleet provider falls back to
   `spine.instance(id)` for an instance this replica has not listed yet.
2. **The tab's ping**: protocol/events has no client `ping` (messages are `sub|resume|pong`), so the
   1 s liveness is the tab's `{op:'pong', at}` answered by `{type:'ping', at}`; a `pong` also marks
   the socket pong-live for the budget. §3.4's "pong answers the server ping" holds for `ws.ping()`.
3. **The socket's company**: `/_atelier/ws` has no path company; the fleet derives it from the Host
   (lane 2), local mode reads `?company=<ws>` (validated by `SLUG_RE`); the same for `/_atelier/rail`.
   A `company:<x>` topic is allowed only for the socket's own company.
4. **Gap on a fresh subscription**: a `subscribed` at an empty ring has cursor `{stream:null, seq:0}`;
   the pump treats a first delivered seq ≠ 1 on that cursor as a gap (the ring rotated past the
   subscription) — `since()` alone answers `streamChange` for a null cursor.
5. **Chrome routing**: `/modules/global/<chrome>/*` and the chrome's backend `/api/global/<chrome>/*`
   are exempt from the fleet's Host = path company check as well as from presence (served on every
   company origin by the Host company's host — PLAN §4.1: the chrome is not an app). Both are signed
   with the chrome's registry row on the Host company (locally the staged row, `isChrome`, hidden
   from the rail and the bootstrap): the host verifies the assertion's `app` against the row's
   instance, so a synthetic id is a 401 on the protocol lane. No row → 404 with a log line. The
   chrome by digest is lane 4a + `chromeShape` (§1.2, §2.1–2.2; step 7 ship C).
6. **Unknown company locally → 404** on document routes (the fleet's Host gate does this in lane 2;
   locally the registry's workspace list decides) — without it every typo was a waking page.
7. **The loop breaker** (§10 item 14), two layers: `__Host-tried=1` (Max-Age 30) set with the 302; a
   document request that still carries it with no session answers 403 with a one-line text page —
   this covers only a client that stores cookies at all (one that drops `__Host-session` drops
   `__Host-tried` too, same attributes). The ticket lane is the second layer: a ticket for the same
   person + `next` consumed within 30 s of the previous one, on a request without a session cookie,
   is burnt and answered with the same 403 page instead of another 302 — the cycle ends at the
   shell after two tickets (per replica, an in-memory map; `/go` refusing the second mint on the
   portal is step 5). `next` itself is trusted only as a normalised `/<c>/<slug>[/rest]` of the
   ticket's company (no `//`, scheme, dot segments out of it, API/ticket paths, reserved head as
   the slug); anything else lands on `/<c>/`.
8. **Assets**: `/assets/client.js` is an esbuild BUNDLE (client.jsx + its `./bridge.js`… + `chrome-resolve.js`),
   so the preload list's depth is 3 with one client request; `/assets/<name>.js` also serves the plain
   files under `client/` for a fork that prefers separate modules. Until `client/client.jsx` exists
   the 1.x `client.jsx` is bundled (one log line).
9. **`hostlink-fleet`** dials plain http when the row has no `tls` (the drill's `plain` opt-out and the
   tests' fake host); the fleet registry never hands out such a row.
10. **Waking marks** (§3.5 addendum, found by the smoke drill): a `kill -STOP`ped host still accepts
    TCP, so a fetch would sit in the 30 s idle cap. A failed probe or dial marks that HOST (`hostKey`: its
    address — a company owns one host per chat it owns) waking for
    2 s per shell (`createWakingMarks`); fetches to it in that window answer `503 {waking:true}` without a
    dial; the local registry serves its last known rows while `/_atelier/apps` is unreachable
    (`unreachableAt`) instead of an empty mount table (which made presence answer 404 for a sleeping
    host). The document route still probes on every request (1 s cap).

Owed to other lanes: B — `shell/local/{discover,stage,hosts}.mjs` feeding `createRegistryLocal({workspaces, discover, chrome})`
and calling `registry.refresh()` from its apps-root watch; `cli-local.mjs` wiring `createShell` as `drill/smoke.mjs` does.
C — `client/index.html` with the five slots and the socket/topic contract in README "What the client gets".
