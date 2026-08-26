# `protocol/` — atelier/2 as code

The wire format of atelier 2.0 (PLAN §4.4, plus §4.3's app-error channel of OR19) as pure
functions with conformance vectors. No runtime: nothing here opens a socket, reads a file or
touches SQLite. Imports are `node:crypto`, `node:test`, `node:assert` — nothing else.

```
import { PROTOCOL, mint, verify, filterRequestHeaders, EventRing, authorizeWrite, checkSession, coalesce, setRunning } from '@pa1nd/atelier/protocol/index.js'
```

| module | what it locks | vector file | proved by |
|---|---|---|---|
| `canonical.js` | canonical JSON (sorted keys at every depth, no whitespace) — the bytes both sides sign | `identity.json` (`canonicalSample`) | spike C3 |
| `identity.js` | the identity assertion: Ed25519 over canonical `{typ, aud, app, method, path, nonce, iat, exp, person:{id, name, claims?}}` in one `x-atelier-identity` header; mint 30 s, accept `exp − now ≤ 60 s` with ±5 s skew, `iat < hostStartedAt − skew` refused (`hostStartedAt` mandatory), nonce replay cache, method/path binding, closed person key set, check order signature → schema → non-canonical → aud → app → method/path → exp → iat → nonce | `identity.json` (32 cases) | spike C3 (42/42 rows; surprises 1-2 are the skew and `iat` rules) |
| `headers.js` | the three header lists and the two filters: inbound strip (every `x-atelier-*`, `cookie`, `authorization`, `x-forwarded-*`, hop-by-hop incl. `connection`-named tokens) / pass; response allow; `set-cookie` and `www-authenticate` never pass; cookie-credentialed routes cut every `access-control-*` except an ACAO equal to the company origin (assertion path passes CORS, OR14); `location` passes unless protocol-relative; framing conflicts rejected on the raw headers; `BODY_CAP_DEFAULT` 64 MiB | `headers.json` (24 cases) | spikes C3 (strip row, surprise 5) + B6 (surprises 1-3) |
| `events.js` | the per-topic ring: `seq` per (stream, topic), ring 256, ingest batch ≤ 128, gap on cursor lag, epoch bumped at registration (stale stream refused before the first new-epoch event; no implicit adoption in fleet mode), `since()` keyed on the cursor's epoch, frames `subscribed \| resumed \| denied \| gap \| invalidate \| ping`, client `sub \| resume \| pong`; server ping 10 s × 2 misses, socket budget 8, close 4001 | `events.json` (27 cases) | spike C4 (surprises 1-5, 7), §4.5, mobile-safari-1 |
| `registry.js` | computer-token scope (own rows only, company derived from the computer row), `SLUG_RE` (one DNS label, no leading/trailing `-`), §2's reserved company ids verbatim, the `module.json` meta split (`primary` is a request), the closed PUT body, the 24 h tombstone reclaim rule | `registry.json` (33 cases) | spike D1 (tests 3, 5, 6, 9, 10; items 2-3, 5-6), §2, OR20 |
| `membership.js` | person-epoch revocation for sessions, host-epoch revocation for bearer tokens, the derived membership model (Q2; presence = the app's chat, OR20) | `membership.json` (16 cases) | spike C3 (presence matrix), §0.1 R5 |
| `app-errors.js` | the OR19 `app-error` event (with the host's `hint`), its fingerprint, the coalescing state machine (10-min fold, 6/h per app, 12/h per chat, "+N more" with bounded pending, stale-rev drop, `setRunning` as the registration fact, untrusted client rev) and the agent-facing text | `app-errors.json` (25 cases) | PLAN §4.3; [S:g4] for the 300 ms budget; agent-contract-1 for the message and hint shape |

## The conformance contract

A second implementation of a module **passes when every case in its vector file yields the
same verdict and reason** (`deepEqual` on the expected object; for identity the `mintedWith`
cases must also re-mint to the exact `header` string). The test files under `protocol/test/`
are the reference runners; they are deliberately dumb loops so the vectors carry the meaning.
Regenerate a generated file with its script under `vectors/gen/` and commit the diff — never
edit `identity.json` or `app-errors.json` by hand.

- **Identity vectors are byte-stable.** Ed25519 is deterministic (RFC 8032: no per-signature
  randomness), the seed and nonces are fixed, so the header strings never move between runs,
  machines or implementations.
- **Schema rule for the assertion:** unknown top-level keys are refused (`schema`); `person` is
  exactly `{id, name, claims?}` — any other key under it (`admin`, `role`, `epoch`) is `schema`.
  The assertion carries no epoch (§4.4); revocation reaches it through the shell's session
  (`membership.checkSession`). **`hostStartedAt` is mandatory** in `verify()` — it is the C3
  restart-replay fence, and a host that omits it gets a throw, not a silent pass. `iat` is
  compared with the same ±5 s skew as every other clock check (a shell 2 s behind the hosts
  on a fleet ship would otherwise 401 every first request); the ≤5 s replay window this
  reopens for a nonce captured just before a restart is accepted and recorded in the module.
- **Epochs in `events.js`** are opaque strings (the registrar hands out a random epoch per
  host start, §4.4); ordering is the integer `epochSeq` the ring assigns per topic at
  `registerEpoch()`. C4's `:epoch<n>` regex is gone. **No implicit adoption in fleet mode:** an
  append on a topic with no registered epoch is `unregistered`; `new EventRing({adoptFirst:
  true})` is local mode's opt-in (no registrar in the loop). `since()` compares the cursor's
  epoch, not the stream string: an old-epoch cursor is `streamChange` even before the new
  epoch's first event, and a fresh ring (no epoch registered — the spine just restarted)
  answers `streamChange` to every cursor. A forged foreign stream at ingest is `foreign-host`,
  a distinct class from a malformed `envelope`.
- **Event delivery rules the ring cannot enforce** (the shell's and the tab's side, for step 4b):
  after `gap` the server stops delivery on that (socket, topic) until `resume`; the ack of a
  `resume` is `resumed`, never `subscribed`; a tab treats ANY non-contiguous seq as a gap;
  mount = subscribe (cursor = head) → snapshot → drop buffered frames with `seq ≤ snapshot.seq`.
  `PING_MS = 1000` is the tab's loopback-tuned ping, not protocol; `SERVER_PING_MS = 10000`,
  `SERVER_PING_MISSES = 2`, `SOCKET_BUDGET = 8`, `CLOSE_EVICTED = 4001` are §4.5's server-side
  numbers and are protocol (pinned in `events.json`).
- **Header order:** the proxy calls `rejectFraming(raw)` on the RAW header set BEFORE either
  filter — after filtering `transfer-encoding` is gone and a CL+TE conflict is invisible; the
  proxy re-frames the body it forwards. Tokens named by the message's own `connection` header
  are hop-by-hop (RFC 7230 §6.1) and stripped both ways. `host` is on no list: the proxy's own
  dial sets it (C3 saw `host` and `connection` at the worker — they came from the dial).
  `www-authenticate` is stripped on BOTH paths — a deliberate tightening of §4.4's cookie-route
  scope: it is not on the response allowlist either way, and a challenge has no consumer on the
  assertion path. `location`: root-absolute passes (the shell rewrites it onto the mount),
  relative and absolute pass unchanged whatever the origin (OR7: an app may send a person to its
  OAuth provider); only protocol-relative `//host` is cut (B6 surprise 1).
- **The meta split (registry):** two sources disagreed on whether `primary` is
  registrar-writable (D1's allowlist let it through; PLAN §4.4 says no). `allowMeta()` reads
  `{name, icon, group, primary, color}`, keeps `{name, icon, group, color}` as `meta` and returns
  `{primary}` as `requested`. The spine's SQLite store (§4.9 step 1, spine follow-up) must record
  it as `requested_primary` and apply it only from the portal / a confirmation. **OR20: there is
  no `visibility` anywhere in v1** — a `visibility` key in `module.json` is an unknown key
  (`dropped`), a `visibility` field in the PUT body is `400 unknown-field` (the body is the closed
  set `{slug, company?, meta?, computer?}`), the model's presence is the app's chat only. The enum
  and the promotion verb return with the dyno target (§12). Reserved company ids are §2's list
  verbatim (`api assets modules global atelier portal apps www go` + `p-*`); `shell` is a reserved
  events topic, not a company id.
- **App-error policy is exported by name** (`FOLD_WINDOW_MS`, `HOURLY_CAP`, `CHAT_HOURLY_CAP`,
  `HOUR_MS`, `MAX_PENDING`, `MAX_OPEN`, the char caps) so the spine pins the same numbers. One
  state object per chat. Choices not in §4.3's text, recorded in the module header: a NEWER rev
  resets the app's records and hourly window (the fold and the cap are per (instance, rev), so a
  save's build error always lands); the running rev is a registration fact the spine records with
  `setRunning()` (the registrar's lane feeds it — `hello` and `modules-changed` carry the rev), and
  registration is authoritative even when lower; `rev` is a per-instance counter the host persists
  at `/work/.atelier/<instance>/revision.json` and never restarts at 1; a frontend report's rev
  must AGREE with the host's running rev (`rev-mismatch` otherwise) and is never copied; a chat
  cap of 12 deliveries an hour across apps; pending is bounded at 20 records + an overflow count,
  open fingerprints at 200; `hint` (≤ 200 chars) is the host's classification line, printed
  verbatim as the `fix:` line.
- **The spine lane's copy is NOT this contract yet** (review 2026-08-26 — do not ship the pair
  as-is; the spine's S6 import of `protocol/app-errors` is gated on this diff closing, and a host
  built on this file would have every push refused at the spine channel with
  `firstAt/lastAt must be short strings`, which makes OR19 silent-by-bug — indistinguishable
  from "silence means LIVE"). `step1-spine` vs `protocol/app-errors.js`:
  | field / rule | protocol/ (this file — the source) | step1-spine (`src/channel/channel.ts` L110-118, `src/runner/app-errors.ts`) |
  |---|---|---|
  | `firstAt`, `lastAt` | integer ms | short strings (≤ 40) |
  | `sample` | object `{url?, ua?, request?:{method, path, status}}` | string ≤ 1000 |
  | `hint` | optional string ≤ 200 | absent |
  | `rev` for frontend reports | host's running rev; body must agree | body copied |
  | running rev | `setRunning()` from registration; reset on change | highest rev seen in errors |
  | fold window | from the last DELIVERY of the fingerprint | from the record's `openedAt` |
  | "+N more" | its own delivery on `flush()` (the sweep) when the hour reopens | text appended to the next delivered message |
  | newer rev | resets open/hourly/pending | no reset |
  | chat cap, bounded pending/open, char caps | 12/h, 20 + overflow, 200, 1000/4000/1024/200 | none |
  | vectors | `{cases:[{now0, events:[{at, ev} \| {at, flush} \| {at, setRunning}], expect:[…]}]}` | `{vectors:[{events:[{t, …}], expect:{deliveries:[idx]}}]}` |
  Port: `AppErrorEvent` + `parseAppError` to integer ms and the object `sample` (+ `hint`),
  `test/fixtures/app-error-vectors.json` to this file's `cases` shape (honouring `flush` and
  `setRunning`), and make the spine's coalescer pass it.
- **Where the epochs live** (sessions table, computers table) is the spine's step-1 follow-up;
  `membership.js` takes `currentEpochOf` as an integer or a lookup function and stays
  store-agnostic. **On spine boot the registrar re-registers every live host's epoch from the
  computers table before ingest opens** — the ring refuses pushes until then (`unregistered`),
  so a zombie host from the previous epoch can never become the accepted one.

## Deliberately open (not in this folder)

| item | why open | evidence / where it lands |
|---|---|---|
| Transport: mTLS shell↔host, the bearer-with-epoch registration handshake | needs the registrar and a live socket; runtime, not vectors | PLAN §4.4 Transport, [R1:Grok T15], [S:C3] streamed bodies; step 2's host implements against the plan text |
| HKDF per-purpose keys, the shell's signing-key custody | C3 kept the key inside the shell process (a rewrite, §4.9 step 0) | C3 RESULT "not covered" |
| `person.claims` semantics | allowed through the schema (an object); no consumer yet — workers see `req.user = {id, name, claims}` | §4.4, [R1:Grok T3] |
| A person epoch INSIDE the assertion (§4.5 "rejects stale assertions") | §4.4 says the assertion carries no epoch field; revocation reaches it through the session today. Pending ruling: add `person.epoch` to the closed set, or keep the session as the only revocation path | §4.4 vs §4.5; the `assertionEpochCheck` of the first draft was removed on review 2026-08-26 |
| The membership TABLE of §4.2 (chat participation + accepted portal invites) and the company epoch of §4.5 | §4.2 leaves open whether bare chat participation writes the table automatically or needs a first confirmation — "decided before step 1". `MembershipModel` derives membership from chats only and bumps the person epoch; an invite source, the table and a company epoch follow the ruling | PLAN §4.2 [R3:Grok E2, Opus D5], §4.5 |
| The WebSocket upgrade lane | 2.1 per B6 (SSE and long-poll are 2.0.0 and plain streamed HTTP) | B6 RESULT (sites live-reload, intercom mic) |
| Tab-liveness client rules (per-topic cursors, foreground hook, `hiddenFor` by `Date.now()`, 30 s reconnect, 1 s ping / 500 ms pong budget) | browser-verified constants, step 4b; the tab-side constants are loopback-tuned | `r2/spike-mobile-safari-1/lab-bridge2.js`, §4.4 Tab liveness, §10 item 13 (bfcache on a phone) |
| Per-host ingest rate limit; the socket budget's eviction order ("oldest non-live first") | shell runtime, §4.5 — the numbers are pinned here, the mechanism is not | C4 surprises 4, 6; mobile-safari-1 |
| Spine-restart ring recovery | rings are in-memory; after a spine Recreate every topic is empty and re-registration (above) makes every cursor `streamChange` → one re-snapshot per tab; persisting rings instead is a spine choice | this README, `events.js` header |

## Scope note for the fleet (recorded so the orchestrator does not re-ask)

This lane touches only the atelier repo (branch `v2`). No spine, image, pod spec, sentinel,
label, hook or env change; `@pa1nd/atelier` has no consumer in agent-image, the spine or metal,
`publishConfig` is untouched and nothing is published — the 14 live chats cannot pick up
`2.0.0-alpha.0`. No wait loops or polls exist in `protocol/`. The regressions the review found
land only when the spine/host lanes import these modules — gate the spine lane's S6 import of
`protocol/app-errors` on the diff table above, and the shell/registrar work on the `events.js`
rules (`unregistered`, boot re-registration).
