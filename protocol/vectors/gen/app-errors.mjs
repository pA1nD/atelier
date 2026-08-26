// Regenerates vectors/app-errors.json: `node protocol/vectors/gen/app-errors.mjs > protocol/vectors/app-errors.json`.
// Shared with the spine lane (its test/fixtures/app-error-vectors.json is a copy until the repos share it).
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
    name: 'eight distinct fingerprints in 5 min → six deliveries, two capped, one "+2 more" when the hour reopens',
    now0: NOW0,
    events: [
      ...Array.from({ length: 8 }, (_, i) => ev(i * 40 * S, build('backend.js', 10 + i, `error ${i}`))),
      flush(30 * MIN),
      flush(60 * MIN),
    ],
    expect: [
      ...Array.from({ length: 6 }, (_, i) => ({ at: i * 40 * S, delivered: true, count: 1 })),
      { at: 6 * 40 * S, delivered: false, reason: 'capped' },
      { at: 7 * 40 * S, delivered: false, reason: 'capped' },
      { at: 30 * MIN, delivered: false },
      { at: 60 * MIN, delivered: true, summary: '+2 more', records: 2 },
    ],
  },
  {
    name: 'a capped fingerprint seen again folds into its pending record; the summary carries the count',
    now0: NOW0,
    events: [
      ...Array.from({ length: 7 }, (_, i) => ev(i * 10 * S, build('backend.js', 10 + i, `error ${i}`))),
      ev(80 * S, build('backend.js', 16, 'error 6')),
      flush(61 * MIN),
    ],
    expect: [
      ...Array.from({ length: 6 }, (_, i) => ({ at: i * 10 * S, delivered: true, count: 1 })),
      { at: 60 * S, delivered: false, reason: 'capped', count: 1 },
      { at: 80 * S, delivered: false, reason: 'folded-pending', count: 2 },
      { at: 61 * MIN, delivered: true, summary: '+1 more', records: 1, count: 2 },
    ],
  },
  {
    name: 'a new event arriving as the hour reopens rides along in the "+N more" delivery (merged), never waits',
    now0: NOW0,
    events: [
      ...Array.from({ length: 7 }, (_, i) => ev(i * 10 * S, build('backend.js', 10 + i, `error ${i}`))),
      ev(61 * MIN, build('backend.js', 99, 'late error')),
    ],
    expect: [
      ...Array.from({ length: 6 }, (_, i) => ({ at: i * 10 * S, delivered: true, count: 1 })),
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
    name: 'the cap is per instance: a second app keeps its own six',
    now0: NOW0,
    events: [
      ...Array.from({ length: 7 }, (_, i) => ev(i * S, build('backend.js', 10 + i, `error ${i}`))),
      ev(10 * S, { ...build('backend.js', 1, 'other app'), instance: 'i-wiki' }),
    ],
    expect: [
      ...Array.from({ length: 6 }, (_, i) => ({ at: i * S, delivered: true, count: 1 })),
      { at: 6 * S, delivered: false, reason: 'capped' },
      { at: 10 * S, delivered: true, count: 1, instance: 'i-wiki' },
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
      ev(4 * S, jsx()),
    ],
    expect: [
      { at: 0, delivered: false, reason: 'schema:kind' },
      { at: 1 * S, delivered: false, reason: 'schema:person' },
      { at: 2 * S, delivered: false, reason: 'schema:count' },
      { at: 3 * S, delivered: false, reason: 'schema:rev' },
      { at: 4 * S, delivered: true, count: 1 },
    ],
  },
]

const frontend = {
  name: 'a frontend report normalises to kind frontend with the fingerprint from the url-less message head; no person data',
  fn: 'fromFrontendReport',
  now: NOW0,
  input: { instance: 'i-todo', rev: 4, url: 'https://acme.portal.pa1nd.de/acme/todo/list?x=1', ua: 'Mozilla/5.0 (iPhone)', message: "TypeError: Cannot read properties of undefined (reading 'map')\n  at List (todo.js:12:3)", stack: 'TypeError: Cannot read properties of undefined\n    at List (https://acme.portal.pa1nd.de/modules/acme/todo/frontend.js:12:3)', person: 'p1', ip: '1.2.3.4', cookie: 'x' },
  expect: {
    instance: 'i-todo', rev: 4, kind: 'frontend',
    fingerprint: "frontend|-:-|TypeError: Cannot read properties of undefined (reading 'map')",
    count: 1, firstAt: NOW0, lastAt: NOW0,
    message: "TypeError: Cannot read properties of undefined (reading 'map')\n  at List (todo.js:12:3)",
    sample: { url: 'https://acme.portal.pa1nd.de/acme/todo/list?x=1', ua: 'Mozilla/5.0 (iPhone)' },
    stack: 'TypeError: Cannot read properties of undefined\n    at List (https://acme.portal.pa1nd.de/modules/acme/todo/frontend.js:12:3)',
  },
}
const fps = [
  { name: 'fingerprint: kind|file:line|message head (80 chars, first line)', fn: 'fingerprint', input: { kind: 'build', file: 'frontend.jsx', line: 4, message: 'Unexpected end of file\nsecond line ignored' }, expect: 'build|frontend.jsx:4|Unexpected end of file' },
  { name: 'fingerprint: missing file/line become -', fn: 'fingerprint', input: { kind: 'worker', message: '  RSS over 1024M  ' }, expect: 'worker|-:-|RSS over 1024M' },
  { name: 'fingerprint: message head is cut at 80 chars', fn: 'fingerprint', input: { kind: 'http', file: 'backend.js', line: 7, message: 'x'.repeat(100) }, expect: 'http|backend.js:7|' + 'x'.repeat(80) },
]
const formats = [
  {
    name: 'formatForAgent: a build error carries app, rev, file:line:col, the message and the build hint',
    fn: 'formatForAgent',
    delivery: { instance: 'i-todo', rev: 4, at: NOW0, records: [{ ...jsx(), firstAt: NOW0, lastAt: NOW0, newCount: 1 }] },
    opts: { appName: 'todo' },
    contains: ['app-error todo rev 4 build', 'frontend.jsx:4:1 Unexpected end of file', 'fix: fix frontend.jsx:4:1 and save'],
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
    name: 'formatForAgent: a "+N more" summary lists one line per record and stays under 2000 chars',
    fn: 'formatForAgent',
    delivery: { instance: 'i-todo', rev: 4, at: NOW0, summary: '+2 more', records: [{ ...build('backend.js', 16, 'error 6'), firstAt: NOW0, lastAt: NOW0, newCount: 1 }, { ...build('backend.js', 17, 'error 7'.repeat(300)), firstAt: NOW0, lastAt: NOW0, newCount: 1 }] },
    contains: ['app-error i-todo rev 4: +2 more (folded — 6/h cap', '- backend.js:16:1 error 6', '- backend.js:17:1 error 7'],
    maxLength: 2000,
  },
]

const out = {
  module: 'protocol/app-errors.js',
  source: 'PLAN §0 OR19 + §4.3 "App errors reach the agent, always"',
  constants: { FOLD_WINDOW_MS: 10 * MIN, HOURLY_CAP: 6, HOUR_MS: H, MESSAGE_HEAD_CHARS: 80, MAX_AGENT_TEXT: 2000 },
  note: 'Coalescing cases: start from emptyState(); for each entry in `events` (ordered by `at`, ms after now0) call coalesce(state, ev, now0 + at) — or flush(state, now0 + at) when the entry is `{at, flush:true}` — and compare with the same-index `expect`: delivered (deliver !== null), reason (the returned reason), summary (deliver.summary), records (deliver.records.length), instance (deliver.instance), count / newCount (when delivered: the last delivered record; otherwise the open record for ev.fingerprint). Other cases: fn ∈ fingerprint | fromFrontendReport(input, now) | formatForAgent(delivery, opts) with `contains` substrings and `maxLength`.',
  cases: [...cases, frontend, ...fps, ...formats],
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n')
