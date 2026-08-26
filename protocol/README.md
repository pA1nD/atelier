# `protocol/` — atelier/2 as code

The wire format of atelier 2.0 (PLAN §4.4, plus §4.3's app-error channel of OR19) as pure
functions with conformance vectors. No runtime: nothing here opens a socket, reads a file or
touches SQLite. Imports are `node:crypto`, `node:test`, `node:assert` — nothing else.

```
import { PROTOCOL, mint, verify, filterRequestHeaders, EventRing, authorizeWrite, checkSession, coalesce } from '@pa1nd/atelier/protocol/index.js'
```

| module | what it locks | vector file | proved by |
|---|---|---|---|
| `canonical.js` | canonical JSON (sorted keys at every depth, no whitespace) — the bytes both sides sign | `identity.json` (`canonicalSample`) | spike C3 |
| `identity.js` | the identity assertion: Ed25519 over canonical `{typ, aud, app, method, path, nonce, iat, exp, person}` in one `x-atelier-identity` header; mint 30 s, accept `exp − now ≤ 60 s` with ±5 s skew, `iat < hostStartedAt` refused, nonce replay cache, method/path binding, check order signature → schema → non-canonical → aud → app → method/path → exp → iat → nonce | `identity.json` (28 cases) | spike C3 (42/42 rows; surprises 1-2 are the skew and `iat` rules) |
| `headers.js` | the three header lists and the two filters: inbound strip (every `x-atelier-*`, `cookie`, `authorization`, `x-forwarded-*`, hop-by-hop) / pass; response allow; `set-cookie` and `www-authenticate` never pass; cookie-credentialed routes cut every `access-control-*` except an ACAO equal to the company origin (assertion path passes CORS, OR14); `location` only root-absolute or same-origin; framing conflicts rejected | `headers.json` (22 cases) | spikes C3 (strip row, surprise 5) + B6 (surprises 2-3) |
| `events.js` | the per-topic ring: `seq` per (stream, topic), ring 256, ingest batch ≤ 128, gap on cursor lag, epoch bumped at registration (stale stream refused before the first new-epoch event), frames `subscribed \| resumed \| denied \| gap \| invalidate \| ping`, client `sub \| resume \| pong` | `events.json` (25 cases) | spike C4 (surprises 1-5, 7) |
| `registry.js` | computer-token scope (own rows only, company derived from the computer row), `SLUG_RE`, reserved company ids, the `module.json` meta split, the 24 h tombstone reclaim rule | `registry.json` (23 cases) | spike D1 (tests 3, 5, 6, 9, 10; items 2-3, 5-6) |
| `membership.js` | person-epoch revocation for sessions and assertions, host-epoch revocation for bearer tokens, the derived membership model (Q2) | `membership.json` (19 cases) | spike C3 (presence matrix), §0.1 R5 |
| `app-errors.js` | the OR19 `app-error` event, its fingerprint, the coalescing state machine (10-min fold, 6/h cap, "+N more", stale-rev drop) and the agent-facing text | `app-errors.json` (17 cases) | PLAN §4.3; [S:g4] for the 300 ms budget; agent-contract-1 for the message shape |

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
- **Schema rule for the assertion:** unknown top-level keys are refused (`schema`); extra keys
  under `person` pass through (`claims`, `epoch`) — `membership.assertionEpochCheck` reads
  `person.epoch` when present.
- **Epochs in `events.js`** are opaque strings (the registrar hands out a random epoch per
  host start, §4.4); ordering is the integer `epochSeq` the ring assigns per topic at
  `registerEpoch()`. C4's `:epoch<n>` regex is gone. Without a registrar in the loop the first
  stream seen is adopted implicitly; every later stream change needs `registerEpoch`.
- **Event delivery rules the ring cannot enforce** (the shell's and the tab's side, for step 4b):
  after `gap` the server stops delivery on that (socket, topic) until `resume`; the ack of a
  `resume` is `resumed`, never `subscribed`; a tab treats ANY non-contiguous seq as a gap;
  mount = subscribe (cursor = head) → snapshot → drop buffered frames with `seq ≤ snapshot.seq`.
  `PING_MS = 1000` is loopback-tuned, not protocol.
- **`host` is on no header list:** the proxy's own dial sets it. C3 saw `host` and `connection`
  at the worker — they came from the dial, not from the client.
- **The meta split (registry):** two sources disagreed on whether `primary` is
  registrar-writable (D1's allowlist let it through; PLAN §4.4 says no). `allowMeta()` reads
  all six `module.json` keys of OR12, keeps `{name, icon, group, color}` as `meta` and returns
  `{primary, visibility}` as `requested`. The spine's SQLite store (§4.9 step 1, spine
  follow-up) must record them as `requested_primary` / `requested_visibility` and apply them
  only from the portal / a confirmation. OR20: `visibility: company` remains a wire value but
  `authorizeWrite` refuses it (`403 no-promotion-in-v1`) until the dyno target (§12).
- **App-error policy is exported by name** (`FOLD_WINDOW_MS`, `HOURLY_CAP`, `HOUR_MS`) so the
  spine pins the same numbers. One choice not in §4.3's text, recorded in the module header:
  a NEWER rev resets the app's records and hourly window — the fold and the cap are per
  (instance, rev), so a save's build error always lands. The spine lane holds a copy of
  `vectors/app-errors.json` (`test/fixtures/app-error-vectors.json`) until the repos share the
  file; regenerate here, copy there.
- **Where the epochs live** (sessions table, computers table) is the spine's step-1 follow-up;
  `membership.js` takes `currentEpochOf` as an integer or a lookup function and stays
  store-agnostic.

## Deliberately open (not in this folder)

| item | why open | evidence / where it lands |
|---|---|---|
| Transport: mTLS shell↔host, the bearer-with-epoch registration handshake | needs the registrar and a live socket; runtime, not vectors | PLAN §4.4 Transport, [R1:Grok T15], [S:C3] streamed bodies; step 2's host implements against the plan text |
| HKDF per-purpose keys, the shell's signing-key custody | C3 kept the key inside the shell process (a rewrite, §4.9 step 0) | C3 RESULT "not covered" |
| `person.claims` semantics | allowed through the schema; no consumer yet — workers see `req.user = {id, name, claims}` | §4.4, [R1:Grok T3] |
| The WebSocket upgrade lane | 2.1 per B6 (SSE and long-poll are 2.0.0 and plain streamed HTTP) | B6 RESULT (sites live-reload, intercom mic) |
| Tab-liveness client rules (per-topic cursors, foreground hook, `hiddenFor` by `Date.now()`, 30 s reconnect, 1 s ping / 500 ms pong budget) | browser-verified constants, step 4b; the constants are loopback-tuned | `r2/spike-mobile-safari-1/lab-bridge2.js`, §4.4 Tab liveness, §10 item 13 (bfcache on a phone) |
| Per-host ingest rate limit and the per-user socket budget (evict-oldest) | shell runtime, §4.5 | C4 surprises 4, 6 |
