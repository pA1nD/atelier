// Regenerates vectors/app-errors.json: `node protocol/vectors/gen/app-errors.mjs > protocol/vectors/app-errors.json`.
// protocol/ is the single source for the app-error wire shape and these vectors; the spine lane's
// coalescer (step1-spine, src/runner/app-errors.ts) must be ported to this shape and pass this file (README).
import { fingerprint } from '../../app-errors.js'

const NOW0 = 1_700_000_000_000
const S = 1000, MIN = 60 * S, H = 60 * MIN
const build = (file, line, message, rev = 4, extra = {}) => ({
  instance: 'i-todo', rev, kind: 'build', fingerprint: fingerprint({ kind: 'build', file, line, message }),
  count: 1, firstAt: 0, lastAt: 0, message, file, line, col: 1, ...extra,
})
const jsx = (rev = 4) => build('frontend.jsx', 4, 'Unexpected end of file', rev)
const ev = (at, e) => ({ at, ev: { ...e, firstAt: NOW0 + at, lastAt: NOW0 + at } })
const flush = (at) => ({ at, flush: true })
const setRunning = (at, instance, rev) => ({ at, setRunning: { instance, rev } })
const distinct = (n, instance = 'i-todo', everyMs = 10 * S, offset = 0, rev = 4) =>
  Array.from({ length: n }, (_, i) => ev(offset + i * everyMs, { ...build('backend.js', 10 + i, `error ${i}`, rev), instance }))
const delivered = (n, everyMs = 10 * S, offset = 0) => Array.from({ length: n }, (_, i) => ({ at: offset + i * everyMs, delivered: true, count: 1 }))

const cases = [
  {
    name: 'three same-fingerprint build errors in 2 min → one delivery (count 1), the rest fold (record count 3)',
    now0: NOW0,
    events: [ev(0, jsx()), ev(1 * MIN, jsx()), ev(2 * MIN, jsx())],
    expect: [{ at: 0, delivered: true, count: 1 }, { at: 1 * MIN, delivered: false, count: 2, reason: 'folded' }, { at: 2 * MIN, delivered: false, count: 3, reason: 'folded' }],
  },
  {
    name: 'a fourth at +11 min (past the 10-min fold window) → a new delivery carrying count 4',
    now0: NOW0,
    events: [ev(0, jsx()), ev(1 * MIN, jsx()), ev(2 * MIN, jsx()), ev(11 * MIN, jsx())],
    expect: [{ at: 0, delivered: true, count: 1 }, { at: 1 * MIN, delivered: false, count: 2 }, { at: 2 * MIN, delivered: false, count: 3 }, { at: 11 * MIN, delivered: true, count: 4, newCount: 3 }],
  },
  {
    name: 'the fold window counts from the last DELIVERY, not the last event: 0, 9, 18 min → two deliveries',
    now0: NOW0,
    events: [ev(0, jsx()), ev(9 * MIN, jsx()), ev(18 * MIN, jsx())],
    expect: [{ at: 0, delivered: true, count: 1 }, { at: 9 * MIN, delivered: false, count: 2, reason: 'folded' }, { at: 18 * MIN, delivered: true, count: 3 }],
  },
  {
    name: 'eight distinct fingerprints in 5 min → six deliveries, two capped, a flush while still capped is a no-op (pending kept), one "+2 more" when the hour reopens',
    now0: NOW0,
    events: [...distinct(8, 'i-todo', 40 * S), flush(30 * MIN), flush(60 * MIN)],
    expect: [
      ...delivered(6, 40 * S),
      { at: 6 * 40 * S, delivered: false, reason: 'capped', pending: { 'i-todo': 1 } },
      { at: 7 * 40 * S, delivered: false, reason: 'capped', pending: { 'i-todo': 2 } },
      { at: 30 * MIN, delivered: false, pending: { 'i-todo': 2 } },
      { at: 60 * MIN, delivered: true, summary: '+2 more', records: 2, pending: { 'i-todo': 0 } },
    ],
  },
  {
    name: 'a capped fingerprint seen again folds into its pending record; the summary carries the count',
    now0: NOW0,
    events: [...distinct(7), ev(80 * S, build('backend.js', 16, 'error 6')), flush(61 * MIN)],
    expect: [
      ...delivered(6),
      { at: 60 * S, delivered: false, reason: 'capped', count: 1 },
      { at: 80 * S, delivered: false, reason: 'folded-pending', count: 2 },
      { at: 61 * MIN, delivered: true, summary: '+1 more', records: 1, count: 2 },
    ],
  },
  {
    name: 'a new event arriving as the hour reopens rides along in the "+N more" delivery (merged), never waits',
    now0: NOW0,
    events: [...distinct(7), ev(61 * MIN, build('backend.js', 99, 'late error'))],
    expect: [
      ...delivered(6),
      { at: 60 * S, delivered: false, reason: 'capped' },
      { at: 61 * MIN, delivered: true, summary: '+2 more', records: 2, reason: 'merged' },
    ],
  },
  {
    name: 'rev 3 after rev 4 → dropped (stale-rev): a fleet ship restarting every host is not news',
    now0: NOW0,
    events: [ev(0, jsx(4)), ev(5 * S, jsx(3))],
    expect: [{ at: 0, delivered: true, count: 1 }, { at: 5 * S, delivered: false, reason: 'stale-rev' }],
  },
  {
    name: 'a newer rev resets the fold and the cap: the same file:line failing at rev 5 lands at once',
    now0: NOW0,
    events: [ev(0, jsx(4)), ev(30 * S, jsx(5)), ev(40 * S, jsx(5))],
    expect: [{ at: 0, delivered: true, count: 1 }, { at: 30 * S, delivered: true, count: 1 }, { at: 40 * S, delivered: false, count: 2, reason: 'folded' }],
  },
  {
    name: 'setRunning is the registration fact: a rev that built clean is silence, and a late error from the older rev is stale-rev',
    now0: NOW0,
    events: [setRunning(0, 'i-todo', 5), ev(1 * S, jsx(4)), ev(2 * S, jsx(5))],
    expect: [{ at: 0, delivered: false }, { at: 1 * S, delivered: false, reason: 'stale-rev' }, { at: 2 * S, delivered: true, count: 1 }],
  },
  {
    name: 'rev contract: a host restart re-registers its persisted rev (no reset, the fold holds); a host that lost its counter re-registers lower and is still heard (registration is authoritative, never a silent channel)',
    now0: NOW0,
    events: [ev(0, jsx(41)), setRunning(10 * S, 'i-todo', 41), ev(1 * MIN, jsx(41)), setRunning(2 * MIN, 'i-todo', 1), ev(3 * MIN, jsx(1)), ev(4 * MIN, jsx(1))],
    expect: [
      { at: 0, delivered: true, count: 1 },
      { at: 10 * S, delivered: false },
      { at: 1 * MIN, delivered: false, reason: 'folded', count: 2 },
      { at: 2 * MIN, delivered: false },
      { at: 3 * MIN, delivered: true, count: 1 },
      { at: 4 * MIN, delivered: false, reason: 'folded', count: 2 },
    ],
  },
  {
    name: 'the cap is per instance: a second app keeps its own six, and its event leaves the first app\'s pending untouched',
    now0: NOW0,
    events: [...distinct(7, 'i-todo', 1 * S), ev(10 * S, { ...build('backend.js', 1, 'other app'), instance: 'i-wiki' })],
    expect: [
      ...delivered(6, 1 * S),
      { at: 6 * S, delivered: false, reason: 'capped', pending: { 'i-todo': 1 } },
      { at: 10 * S, delivered: true, count: 1, instance: 'i-wiki', pending: { 'i-todo': 1, 'i-wiki': 0 } },
    ],
  },
  {
    name: 'the chat cap (12/h across apps): two apps × 7 fill it; a third app\'s first error is chat-capped; every pending drains one flush at a time when the hour reopens',
    now0: NOW0,
    events: [
      ...distinct(7, 'i-todo', 1 * S, 0),
      ...distinct(7, 'i-wiki', 1 * S, 10 * S),
      ev(20 * S, { ...build('backend.js', 1, 'third app'), instance: 'i-crm' }),
      flush(61 * MIN), flush(61 * MIN + S), flush(61 * MIN + 2 * S), flush(61 * MIN + 3 * S),
    ],
    expect: [
      ...delivered(6, 1 * S, 0),
      { at: 6 * S, delivered: false, reason: 'capped' },
      ...delivered(6, 1 * S, 10 * S),
      { at: 16 * S, delivered: false, reason: 'capped' },
      { at: 20 * S, delivered: false, reason: 'chat-capped', pending: { 'i-crm': 1 } },
      { at: 61 * MIN, delivered: true, instance: 'i-todo', summary: '+1 more', records: 1 },
      { at: 61 * MIN + S, delivered: true, instance: 'i-wiki', summary: '+1 more', records: 1 },
      { at: 61 * MIN + 2 * S, delivered: true, instance: 'i-crm', summary: '+1 more', records: 1 },
      { at: 61 * MIN + 3 * S, delivered: false },
    ],
  },
  {
    name: 'bounded pending: a storm of 36 distinct fingerprints → 6 delivered, 20 pending + 10 overflow, one "+30 more" with 20 records when the hour reopens',
    now0: NOW0,
    events: [...distinct(36, 'i-todo', 100), flush(61 * MIN)],
    expect: [
      ...delivered(6, 100),
      ...Array.from({ length: 30 }, (_, i) => ({ at: (6 + i) * 100, delivered: false, reason: 'capped', pending: { 'i-todo': Math.min(i + 1, 20) }, overflow: { 'i-todo': Math.max(0, i + 1 - 20) } })),
      { at: 61 * MIN, delivered: true, summary: '+30 more', records: 20, pending: { 'i-todo': 0 }, overflow: { 'i-todo': 0 } },
    ],
  },
  {
    name: 'invalid events are refused with a schema reason and change nothing',
    now0: NOW0,
    events: [
      ev(0, { ...jsx(), kind: 'panic' }),
      ev(1 * S, { ...jsx(), person: 'p1' }),
      ev(2 * S, { ...jsx(), count: 0 }),
      ev(3 * S, { ...jsx(), rev: -1 }),
      ev(4 * S, { ...jsx(), hint: 'x'.repeat(201) }),
      ev(5 * S, { ...jsx(), message: 'x'.repeat(1001) }),
      ev(6 * S, { ...jsx(), sample: { url: 'https://x/' + 'y'.repeat(1024) } }),
      ev(7 * S, { ...jsx(), hint: 'close the <div> opened on line 3 before the return' }),
    ],
    expect: [
      { at: 0, delivered: false, reason: 'schema:kind' },
      { at: 1 * S, delivered: false, reason: 'schema:person' },
      { at: 2 * S, delivered: false, reason: 'schema:count' },
      { at: 3 * S, delivered: false, reason: 'schema:rev' },
      { at: 4 * S, delivered: false, reason: 'schema:hint' },
      { at: 5 * S, delivered: false, reason: 'schema:message' },
      { at: 6 * S, delivered: false, reason: 'schema:sample' },
      { at: 7 * S, delivered: true, count: 1 },
    ],
  },
]

const frontendInput = { instance: 'i-todo', rev: 4, url: 'https://acme.portal.pa1nd.de/acme/todo/list?x=1', ua: 'Mozilla/5.0 (iPhone)', message: "TypeError: Cannot read properties of undefined (reading 'map')\n  at List (todo.js:12:3)", stack: 'TypeError: Cannot read properties of undefined\n    at List (https://acme.portal.pa1nd.de/modules/acme/todo/frontend.js:12:3)', person: 'p1', ip: '1.2.3.4', cookie: 'x' }
const frontend = [
  {
    name: 'a frontend report normalises to kind frontend with the fingerprint from the url-less message head; no person data; rev is the host\'s running rev',
    fn: 'fromFrontendReport',
    now: NOW0,
    input: frontendInput,
    opts: { rev: 4 },
    expect: {
      ok: true,
      ev: {
        instance: 'i-todo', rev: 4, kind: 'frontend',
        fingerprint: "frontend|-:-|TypeError: Cannot read properties of undefined (reading 'map')",
        count: 1, firstAt: NOW0, lastAt: NOW0,
        message: "TypeError: Cannot read properties of undefined (reading 'map')\n  at List (todo.js:12:3)",
        sample: { url: 'https://acme.portal.pa1nd.de/acme/todo/list?x=1', ua: 'Mozilla/5.0 (iPhone)' },
        stack: 'TypeError: Cannot read properties of undefined\n    at List (https://acme.portal.pa1nd.de/modules/acme/todo/frontend.js:12:3)',
      },
    },
  },
  {
    name: 'a frontend report with a foreign rev is dropped (rev-mismatch): a client rev never advances `running` or mints a delivery',
    fn: 'fromFrontendReport',
    now: NOW0,
    input: { ...frontendInput, rev: 57 },
    opts: { rev: 7 },
    expect: { ok: false, reason: 'rev-mismatch' },
  },
  {
    name: 'a frontend report without a running rev (instance unknown to the host) is dropped',
    fn: 'fromFrontendReport',
    now: NOW0,
    input: frontendInput,
    opts: {},
    expect: { ok: false, reason: 'no-running-rev' },
  },
  {
    name: 'a frontend report is truncated to the wire caps: message 1000, url 1024, ua 200, stack 4000',
    fn: 'fromFrontendReport',
    now: NOW0,
    input: { instance: 'i-todo', rev: 4, url: 'https://x/' + 'u'.repeat(2000), ua: 'a'.repeat(300), message: 'm'.repeat(1500), stack: 's'.repeat(5000) },
    opts: { rev: 4 },
    expect: {
      ok: true,
      ev: {
        instance: 'i-todo', rev: 4, kind: 'frontend',
        fingerprint: 'frontend|-:-|' + 'm'.repeat(80),
        count: 1, firstAt: NOW0, lastAt: NOW0,
        message: 'm'.repeat(1000),
        sample: { url: ('https://x/' + 'u'.repeat(2000)).slice(0, 1024), ua: 'a'.repeat(200) },
        stack: 's'.repeat(4000),
      },
    },
  },
]
const fps = [
  { name: 'fingerprint: kind|file:line|message head (80 chars, first line)', fn: 'fingerprint', input: { kind: 'build', file: 'frontend.jsx', line: 4, message: 'Unexpected end of file\nsecond line ignored' }, expect: 'build|frontend.jsx:4|Unexpected end of file' },
  { name: 'fingerprint: missing file/line become -', fn: 'fingerprint', input: { kind: 'worker', message: '  RSS over 1024M  ' }, expect: 'worker|-:-|RSS over 1024M' },
  { name: 'fingerprint: message head is cut at 80 chars', fn: 'fingerprint', input: { kind: 'http', file: 'backend.js', line: 7, message: 'x'.repeat(100) }, expect: 'http|backend.js:7|' + 'x'.repeat(80) },
]
const formats = [
  {
    name: 'formatForAgent: a build error carries app, rev, file:line:col, the message and the generic build hint when the host sent none',
    fn: 'formatForAgent',
    delivery: { instance: 'i-todo', rev: 4, at: NOW0, records: [{ ...jsx(), firstAt: NOW0, lastAt: NOW0, newCount: 1 }] },
    opts: { appName: 'todo' },
    contains: ['app-error todo rev 4 build', 'frontend.jsx:4:1 Unexpected end of file', 'fix: fix frontend.jsx:4:1 and save'],
    maxLength: 2000,
  },
  {
    name: 'formatForAgent: the host\'s hint (agent-contract-1\'s `<file>:<line>:<col> <message> — <fix>` classification) travels verbatim and replaces the generic hint',
    fn: 'formatForAgent',
    delivery: { instance: 'i-todo', rev: 4, at: NOW0, records: [{ ...build('frontend.jsx', 9, 'Unexpected token "}"', 4, { hint: 'the <div> opened on line 3 is never closed — close it before the return' }), firstAt: NOW0, lastAt: NOW0, newCount: 1 }] },
    opts: { appName: 'todo' },
    contains: ['app-error todo rev 4 build', 'frontend.jsx:9:1 Unexpected token "}"', 'fix: the <div> opened on line 3 is never closed — close it before the return'],
    maxLength: 2000,
  },
  {
    name: 'formatForAgent: an http error names the triggering request and the count',
    fn: 'formatForAgent',
    delivery: { instance: 'i-todo', rev: 4, at: NOW0, records: [{ kind: 'http', fingerprint: 'http|backend.js:7|boom', count: 3, newCount: 3, firstAt: NOW0, lastAt: NOW0 + 2 * MIN, message: 'boom', file: 'backend.js', line: 7, rev: 4, sample: { request: { method: 'GET', path: '/api/acme/todo/items', status: 500 } }, stack: 'Error: boom\n    at handler (backend.js:7:9)\n    at next (router.js:1:1)' }] },
    contains: ['app-error i-todo rev 4 http ×3 (first 2023-11-14T22:13:20Z, last 2023-11-14T22:15:20Z)', 'backend.js:7 boom', 'request: GET /api/acme/todo/items → 500', 'stack: Error: boom | at handler (backend.js:7:9)'],
    maxLength: 2000,
  },
  {
    name: 'formatForAgent: a "+N more" summary lists one line per record, names the unlisted overflow, and stays under 2000 chars',
    fn: 'formatForAgent',
    delivery: { instance: 'i-todo', rev: 4, at: NOW0, summary: '+5 more', folded: 5, records: [{ ...build('backend.js', 16, 'error 6'), firstAt: NOW0, lastAt: NOW0, newCount: 1 }, { ...build('backend.js', 17, 'error 7'.repeat(300)), firstAt: NOW0, lastAt: NOW0, newCount: 1 }] },
    contains: ['app-error i-todo rev 4: +5 more (folded — 6/h per app, 12/h per chat', '3 not listed', '- backend.js:16:1 error 6', '- backend.js:17:1 error 7'],
    maxLength: 2000,
  },
]

const out = {
  module: 'protocol/app-errors.js',
  source: 'PLAN §0 OR19 + §4.3 "App errors reach the agent, always"',
  constants: { FOLD_WINDOW_MS: 10 * MIN, HOURLY_CAP: 6, CHAT_HOURLY_CAP: 12, HOUR_MS: H, MESSAGE_HEAD_CHARS: 80, MAX_AGENT_TEXT: 2000, MAX_PENDING: 20, MAX_OPEN: 200, MAX_MESSAGE_CHARS: 1000, MAX_STACK_CHARS: 4000, MAX_URL_CHARS: 1024, MAX_HINT_CHARS: 200, MAX_UA_CHARS: 200 },
  note: 'Coalescing cases: one state (= one chat) from emptyState(); for each entry in `events` (ordered by `at`, ms after now0) call coalesce(state, ev, now0 + at) — or flush(state, now0 + at) when the entry is `{at, flush:true}`, or setRunning(state, instance, rev) (no delivery) when it is `{at, setRunning:{instance, rev}}` — and compare with the same-index `expect`: delivered (deliver !== null), reason (the returned reason), summary (deliver.summary), records (deliver.records.length), instance (deliver.instance), count / newCount (when delivered: the last delivered record; otherwise the open record for ev.fingerprint), pending ({instance → state.pending[instance].length, missing = 0}), overflow ({instance → state.overflow[instance], missing = 0}). Other cases: fn ∈ fingerprint(input) | fromFrontendReport(input, now, opts) → {ok, ev} | {ok, reason} | formatForAgent(delivery, opts) with `contains` substrings and `maxLength`.',
  cases: [...cases, ...frontend, ...fps, ...formats],
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n')
