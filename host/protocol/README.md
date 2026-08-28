# `host/protocol/` — the host's HTTP front (PLAN §4.9 step 2, protocol-server lane)

The pod's only non-loopback TCP listener, the dev shell, the registrar client and the event
push. Runtime only: every wire rule is imported from `protocol/` (identity, headers, events,
registry, app-errors) and never restated. `node --test host/test/protocol-*.test.js` — 71 tests,
macOS, no root; the seven files of DESIGN §8.1 plus `protocol-fixtures.mjs` (fakes).

| module | what it is | interface |
|---|---|---|
| `auth.mjs` | bearer + epoch, the identity assertion, the dev token | `createAuth({registrar, os, cfg, devToken?, nonceMax?, now?, log?})` → `.bearer(req)`, `.verifyRequest(req, {instance})`, `.devRequest(req)`, `.nonces`, `.hasDevToken`; `readDevToken(cfg)` |
| `headers.mjs` | protocol/headers at runtime, both ways; the body budget | `inbound(req, {user, cap})`, `outbound(headers, {mount, companyOrigin})`, `stampUser(headers, user)`, `countedBody({cap})`, `isRootAbsolute(v)` |
| `events.mjs` | invalidations → spine stream, coalesced, batches ≤ 128 | `createEvents({transport, hostId, epoch, flushMs?, maxBatch?, log?})` → `.invalidate(instance)`, `.flush()`, `.drain(capMs)`, `.stop()`, `.stats` |
| `registrar.mjs` | register / claim / unlink / modules-changed / heartbeat / reconcile / draining; the two transports | `createRegistrar({os, dirfd, transport, cfg, log, now?, fsx?, backoffMs?, liveWorkers?})`; `spineTransport(cfg, {bootstrapToken?})`; `localTransport(cfg, dirfd, {os, fsx?, now?, keys?})` |
| `server.mjs` | the pod-IP listener and its routes | `createServer({cfg, auth, supervisor, collector, registrar, log?, frontendReport?, listen?})` → `.listen()`, `.close()`; shared: `parseMount`, `safeRel`, `readJson`, `serveAssetResult`, `appsView`, `frontendReportHandler` |
| `devshell.mjs` | the local-mode shell: Unix socket + `127.0.0.1:1844`, the 1.x document | `createDevShell({cfg, os, supervisor, collector, registrar, auth, principal?, log?, frontendReport?, chromeSheet?, sockPath?, devPort?})` → `.listen()`, `.close()`, `.broadcast(instance, ev)`, `.invalidate(instance)`, `.backendError(instance, msg)` |

## The rules, as built

**Bearer with epoch.** `Authorization: Bearer <epoch>.<token>` — the pair `register()` returned.
Check order per request: bearer (`no-bearer` · `bad-bearer` · `unregistered` · `epoch-moved` ·
`bad-token`) → the app is resolved (404 with a bearer, never without) → the assertion
(`x-atelier-identity`, protocol/identity `verify`: signature → schema → aud → app → method/path
→ exp → iat → nonce). `hostStartedAt` = the registrar's `startedAt` (ms → s), stamped at every
successful registration: the C3 restart fence. The nonce cache is one Map per process, pruned
by protocol/ at 10 000 with a hard ceiling on top. Every failure is `401 {}`; the reason is one
`auth: 401 <reason> <method> <url>` log line, host-side only. `path` in the assertion is the raw
`req.url` (query included) — the shell signs what it forwards.

**Headers.** `inbound()` runs `rejectFraming` on the raw set (400), refuses a `content-length`
over the cap before a byte is read (413), then `filterRequestHeaders` and the stamp
(`x-atelier-user` / `-name` / `-claims`) — a forged `x-atelier-*` is stripped first, so the stamp
always replaces it. `outbound()` runs `rejectFraming`, `filterResponseHeaders` with
`cookieCredentialed:false` (the shell applies the cookie cut, OR12), and rewrites a root-absolute
`location` onto `/api/<company>/<slug>`; relative and absolute pass unchanged, `//host` was cut
by the filter. The host therefore emits the final company-origin path — **the shell must not
rewrite `location` again.** `countedBody({cap})` is the byte counter for both directions; the
tests pass the verified 1 MiB in / 4 MiB out and cut at cap+1 (`err.code = 'BODY_CAP'`).
worker/proxy.mjs (workers lane) is the caller of all three.

**Events.** Frames `{stream:'<hostId>:<epoch>', topic:<instance>, seq, type:'invalidate'}`
(validated with protocol `validEvent` before they leave); `seq` per (stream, topic), restarting
at 1 when the epoch moves; the pending set holds instances, frames are minted at flush (N saves
of one app in a tick = one frame); batches ≤ 128; one POST in flight; a failed push re-queues the
instances and re-mints under the current stream after 50 → 200 → 1000 → 5000 ms. `hostId` and
`epoch` may be functions — the integrator passes `() => registrar.hostId` / `() => registrar.epoch`
because both are known only after `register()`; before that the queue holds.

**Registrar.** `register()` posts `{pod_ip, host_started_at}` with the bootstrap secret and keeps
`{host_id, epoch, token, company, origin, chat, principal, apps[], shell_public_key_hex}`;
retries 0.5 → 30 s forever (the host serves snapshots meanwhile). Any later `401 host-epoch-moved`
registers again and retries the call once. `claim({slug, meta, dir})`: slug through `SLUG_RE`,
meta through `allowMeta` (unknown keys never leave; `primary` travels as the request the registry
records as `requested_primary`); the instance id is the registrar's own row for that slug or a
fresh `i-<16 hex>`; the uid is the row's, else the `<inst>/uid` marker's, else the lowest free
`20000+i` from 20001. Verdicts `claimed | adopted | revived`; a 4xx from the registry or a bad slug
is `{refused:{code, error}}` plus `CLAIM-REFUSED.txt` written **as uid 1000** through
`os.spawnSync` (row G shape: `setpriv --reuid=1000 --regid=1000 --clear-groups`, env `{PATH}`,
umask 022, `node -e … wx 0644`) — never root into the agent's folder. Markers `<inst>/slug`,
`<inst>/uid`, `<inst>/registered.json` (each 0600 — the host's alone) are `os.at(dirfd, …)` writes
under `/work/.atelier/<inst>/` (mkdir 0711). `registrar.lane` = `{events(batch), appError(body)}`
routed through `call()`, so a `401 host-epoch-moved` on either push lane re-registers and retries
once like every registry write. The uid reaches the spine with the first
`modulesChanged(instance, rev)` (`{apps:[{instance, slug, uid, rev}]}`) and comes back in
`register().apps`. `heartbeat(10 s)` posts `{visible_apps, last_served_at, pod_ip}`,
`visible_apps` = live workers (`liveWorkers()`) ∪ instances served in the last 10 min
(`served(instance)` from serve.mjs). `reconcile(rows|null)`: `null` = `/work/apps` unreadable
(resets the settle clock); otherwise, 5 s after the first readable pass, registered live rows
with no folder are unlinked ≤ 5 per pass with one loud log line. `spineTransport` speaks the
DESIGN §7 table (`/v1/host/register|heartbeat|modules-changed|events|event|draining`,
`/v1/apps/<i>`, `/v1/apps/<i>/unlink`, `/v1/apps/<i>/config`) over node http/https, 5 s
connect / 30 s total, bearer = the token in memory (`setToken`), a `TransportError {status, body}`
on non-2xx. `localTransport` answers from `.atelier/registry.json` (0600, `fsx` seam) with the
D1 semantics through protocol `reclaimRule`, identity `{id:'local'}`, a random epoch per start,
an Ed25519 keypair (`transport.keys`, the shell key of local mode), events into an
`EventRing({adoptFirst:true})`, app errors kept in memory.

**Server.** Routes and order in `server.mjs`'s header. `req.url` reaches `supervisor.handle`
untouched (the mount is derivable from the row; serve.mjs/proxy.mjs strip it). `/modules/…`
passes `{rev}` as a third argument to `supervisor.asset(row, rel, {rev})` (`?rev=N`; a rev past
the window is the supervisor's `null` → 404); assets answer with `etag "rev-N"`,
`cache-control: no-cache`, 304 on `if-none-match`. `..` is normalised by URL parsing before the
gate (B6 surprise 5) and `safeRel` refuses anything that survives. `/_atelier/report` needs the
bearer AND an assertion for `body.instance` (the shell signs `POST /_atelier/report` with
`app = instance`); the report path is errors/report.mjs when wired (`frontendReport`), else
protocol `fromFrontendReport` + `collector.report('frontend', …)`. An Upgrade is 426.
`cfg.hostTls = 'cert.pem,key.pem,ca.pem'` → https with `requestCert + rejectUnauthorized`.

**Dev shell.** Two listeners, one handler: `$ATELIER_RUN/dev/shell.sock` (chown `0:1000`, chmod
`0660` after bind through the adapter) and `127.0.0.1:1844`. Every request needs the dev token
— `x-atelier-dev-token`, `?token=`, or the `?token=` of a same-origin `referer` (what a browser's
sub-requests of a `/?token=…` document carry); a WebSocket handshake carries no referer, so the
agent's browser passes the header (CDP `Network.setExtraHTTPHeaders`) for a live socket. No
token file → `hasDevToken:false`, everything 401, one log line (`doctor: dev-token-missing`).
Identity = `registrar.principal`; act-as headers only beside the token. The document is 1.x's
`index.html` with `window.__ATELIER__ = {mode:'host', label:null, observe:false, user:{id, name,
workspaces:[{id:<company>, modules:[{id:<slug>, meta}]}]}, workspace, workspaces, chromeQid,
defaultChromeQid, chromes, backendErrors:[]}`, the import map `@atelier/kit →
/modules/global/<chrome>/kit.js` when the chrome folder has `kit.js|jsx`, and ONE `<link>` (the
app's `/modules/<company>/<slug>/styles.css` on `/<company>/<slug>…`, the chrome's sheet
otherwise). `/assets/{react,react-dom}.js` are the UMDs (production when `NODE_ENV=production`),
`/assets/client.js` the classic-runtime transform of `client.jsx`, `/modules/global/<chrome>/
{frontend,kit}.js` the esbuild bundle with `react*` aliased to `shims/`, minified in production.
`/modules/<c>/<s>/*` and `/api/<c>/<s>/*` are the same `supervisor.asset` / `supervisor.handle`
as the protocol port (`protocol-samebytes.test.js`). WS frames are 1.x's: `{…event, topic:
'<company>/<slug>'}` from `.broadcast(instance, event)` (topic stamped last), `{type:'reload',
moduleId:<slug>, cssOnly, topic:'shell'}` from `.invalidate(instance)`, `{type:'backend-error',
qid, message, topic:'shell'}` from `.backendError()`. gzip for text bodies ≥ 1 KiB when accepted.

## Stubs and seams (what another lane or the integrator supplies)

- `chromeSheet()` on the dev shell: the chrome's compiled Tailwind sheet is `supervisor/tailwind.mjs`
  (supervisor lane); until wired, the chrome's `styles.css` is passed through unchanged.
- `frontendReport` on server and dev shell: errors/report.mjs (`frontendReport({collector})`);
  the built-in default is protocol `fromFrontendReport` + `collector.report`.
- `liveWorkers` on the registrar: `() => supervisor.workers().map((w) => w.instance)`.
- `dev.broadcast` / `dev.invalidate` / `dev.backendError` are called by the integrator from the
  supervisor's control-lane messages and `onSwap`.
- `createAuth` needs `cfg` (for `$ATELIER_RUN/dev.token`) or an explicit `devToken`.
- The shell (step 4/5) obtains the host's `<epoch>.<token>` pair from the spine and signs
  `path = req.url` as forwarded; `/_atelier/report` is signed with `app = body.instance`.

## What the Linux drill must still prove (DESIGN §8.2 rows 6 and 9)

1. `/run/atelier/dev/shell.sock` is `0:1000 0660` in the `0710` dir: uid 1000 connects, uid 20001
   gets EACCES; `127.0.0.1:1844` from uid 20001 without the token → 401 for `/`, `/_atelier/whoami`
   and the WS handshake.
2. `/run/atelier/{bootstrap,dev}.token` EACCES from uid 1000 and 20001; the host read them once.
3. `CLAIM-REFUSED.txt` lands `1000:1000 0644` inside a `1000:<uid> 2750` folder; a planted symlink
   at that name is refused (`wx`), nothing lands elsewhere; `node` is on the helper's `{PATH}`.
4. The protocol port on the pod IP is TLS-refused before HTTP from uid 20001 once `ATELIER_HOST_TLS`
   is set (step 5); today: a bearer-less dial is `401 {}`.
5. The registrar against the real spine lane: register → claim → modules-changed → heartbeat →
   `401 host-epoch-moved` after a second registration → re-register; `visible-apps` label flips.
6. The agent's headless browser renders the document through the Unix socket / loopback port with
   the token header on every request (the CDP extra-headers path), sub-resources included.
