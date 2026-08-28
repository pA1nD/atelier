# `client/` — the 2.0 client (PLAN §4.9 step 4b, shell/DESIGN.md §4)

The fork of the 1.x `client.jsx` + `index.html`, built by the shell and served at
`/assets/client.js`. The 1.x files at the repo root are untouched (`atelier <id>` still runs them).

```
node --test client/test/*.test.js        # 78 tests, no browser, no host process
```

## Files

| file | what |
|---|---|
| `client.jsx` | the fork: bootstrap → chrome + the active app, the events socket, the topic handlers, the rail, the sheet swap, the picker, the waking fallback, the reporter. React classic runtime against the UMD globals |
| `index.html` | the document template with the five slots of `shell/document.mjs` `SLOTS`, in head order: `<!--__STYLES__-->` (one `<link id="atelier-chrome-styles">`), the two static React UMD tags, `<!--__BOOTSTRAP__-->` (`<script nonce>window.__ATELIER__ = …`), `<!--__IMPORTMAP__-->`, `<!--__PRELOADS__-->`, and `<!--__CLIENT__-->` in the body (`<script type="module" src="/assets/client.js">`) |
| `build.mjs` | `buildClient({minify}) → {js, mtime}`: esbuild, ONE bundle (the modules below and `../chrome-resolve.js` inlined); `readTemplate()`, `SLOTS`, `clientMtime()` (the ETag) |
| `bridge.js` | the events socket: per-topic cursors `{stream, seq, pending}` across sockets, `sub`/`resume`, `subscribed`/`resumed`/`gap`/`denied`/`invalidate`/`ping`, snapshots from `/_atelier/topics/<t>`, the liveness probe, the foreground hook, the `atelier:connection` state |
| `self.js` | three-base `self()` (spike-b6 port) + the 1.x fields; `subscribe` maps the qid to the instance topic |
| `route.js` | `parseUrl` / `buildUrl`, one DNS label per segment (`SLUG_RE` = protocol/registry's) |
| `sheet.js` | `sheetHref(app, chrome)` and `swapSheet(doc, href)` — the FOUC-free link swap |
| `picker.js` | `pickTarget(boot, id)` → portal POST (fleet) or `location.assign` (local); `performPick` |
| `waking.js` | `isWakingResponse`, `startWakePoll` (2 s → 10 s → `location.reload()`) |
| `reporter.js` | the always-on error reporter → `POST /_atelier/report`, ≤ 10/min, active app only |
| `test/` | `node --test`; `fakes.js` = virtual clock, scriptable WebSocket/fetch, a tiny DOM |

## What the client expects from the shell (DESIGN §2–§3)

- `window.__ATELIER__` per §2.1: `user.workspaces[0].modules[]` rows carry `{id, instance, rev, hasFrontend, meta}`;
  `workspace` names the document's company; `companies[]` (`{id, name, href}`) and `portal` drive the picker;
  `chromeQid`/`defaultChromeQid`/`chromes` (exactly the document's chrome) and `chromeRev`.
- Assets at their revision: `/modules/<c>/<s>/frontend.js?rev=N`, `styles.css?rev=N`, the chrome at `?rev=<chromeRev>`. No `?v=` anywhere.
- `GET /_atelier/topics/<topic>` → `{stream, seq, rev|null, error:{message}|null}` for an instance topic;
  `/_atelier/rail` and `/_atelier/topics/company:<c>` → `{stream, seq, modules:[rows], chrome:{qid, digest}}` (`chromeRev` also accepted).
- `GET /_atelier/wake?company=<c>` → `{ok:true}` when the host answers; a `503 {waking:true}` (+ `x-atelier-waking: 1`) anywhere on `/_atelier/*` or a failed bundle import that the wake probe confirms → the waking fallback.
- `GET /_atelier/whoami` (200 / 401) for the banner's offline-vs-unauthed probe; `POST /_atelier/report` for the reporter.
- The socket `/_atelier/ws` per protocol/events. **Liveness probe:** the client message set has no `ping`, so a silent socket is probed with an idempotent `resume` of a cursored topic every `PING_MS` (1 s) while visible; any frame back is the answer; none within 1 s → kill + reconnect. A `sub` unacked for 2 s on an open socket is the same verdict. The server's `ping {at}` frames are answered with `pong {at}`.

## Behaviour (the 4b table, DESIGN §4)

- **Mount = subscribe → snapshot**; frames during a snapshot are buffered, `seq ≤ snapshot.seq` dropped. `gap` → one snapshot → `resume` at the cursor after the buffered frames. A frame with `seq ≠ cursor+1` is a gap. A stream change → snapshot. A snapshot with no stream (empty ring) resumes with `sub`; the `subscribed` echo at the same head is not a second snapshot.
- **Foreground hook**: `visibilitychange` / `online` / `pageshow(persisted)`; `hiddenFor` from `Date.now()`; hidden > 30 s or a bfcache restore → reconnect at once, else a probe with a 500 ms budget.
- **App topics**: each loaded app subscribes on its instance; `invalidate` → topic fetch → `{rev, error}`; a higher rev → re-import `frontend.js?rev=N` (token-guarded) + the sheet swap when active; `error` → the overlay for that qid, cleared when null. Never-imported apps do nothing.
- **Rail**: `company:<c>` → rows replaced in state (new app, meta, primary); a moved `chromeRev` → `location.reload()`.
- **Navigation**: SPA inside the company with the per-app sheet swap; another company or the picker → a full page load (portal POST / href). `meta.chrome` naming an unadvertised chrome → the error page (chrome-resolve.js).
- **Removed**: the `shell` topic, `?v=`, `meta.eager`, `TopBarCenter`, the takeover, the observe-gated reporter, `boot.backendErrors`. Module handlers from `self.subscribe` receive `{type:'invalidate', topic:<qid>, seq}` only (1.x payload broadcasts are collapsed to invalidations — a documented 1.x break); the first mount snapshot is not delivered.

## Stubbed / owed by other lanes

- The shell (lane A) fills `index.html`'s slots and serves `buildClient()`'s output; the route shapes above are the contract, not yet proven end to end — the browser drill (DESIGN §7.3) is the integrator's.
- `?token=` pass-through (`withDevToken`) stays a no-op unless the document URL carries one (a fork served through the host's dev shell); the 2.0 document never does.
- The chrome's dev-mode prop `loadedModules[qid].TopBarCenter` is never set (the loader returns `{Module, chrome, meta}` only); catalyst-chrome renders without the slot.
