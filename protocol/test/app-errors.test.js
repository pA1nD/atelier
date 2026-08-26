import test from 'node:test'
import assert from 'node:assert/strict'
import { coalesce, flush, setRunning, emptyState, fingerprint, fromFrontendReport, formatForAgent, validateAppError, APP_ERROR_KINDS, FOLD_WINDOW_MS, HOURLY_CAP, CHAT_HOURLY_CAP, HOUR_MS, MESSAGE_HEAD_CHARS, MAX_AGENT_TEXT, MAX_PENDING, MAX_OPEN, MAX_MESSAGE_CHARS, MAX_STACK_CHARS, MAX_URL_CHARS, MAX_HINT_CHARS, MAX_UA_CHARS } from '../app-errors.js'
import vectors from '../vectors/app-errors.json' with { type: 'json' }

for (const c of vectors.cases) {
  test(`vector: ${c.name}`, () => {
    if (c.fn === 'fingerprint') return assert.equal(fingerprint(c.input), c.expect)
    if (c.fn === 'fromFrontendReport') {
      const r = fromFrontendReport(c.input, c.now, c.opts)
      assert.deepEqual(r, c.expect)
      if (r.ok) assert.deepEqual(validateAppError(r.ev), { ok: true })
      return
    }
    if (c.fn === 'formatForAgent') {
      const text = formatForAgent(c.delivery, c.opts)
      for (const s of c.contains) assert.ok(text.includes(s), `missing "${s}" in:\n${text}`)
      return assert.ok(text.length <= c.maxLength, `length ${text.length}`)
    }
    let state = emptyState()
    assert.equal(c.events.length, c.expect.length, 'events and expect align 1:1')
    c.events.forEach((e, i) => {
      const x = c.expect[i]
      const now = c.now0 + e.at
      assert.equal(e.at, x.at, `entry ${i}: at`)
      const before = JSON.stringify(state)
      const r = e.flush ? flush(state, now) : e.setRunning ? { state: setRunning(state, e.setRunning.instance, e.setRunning.rev), deliver: null } : coalesce(state, e.ev, now)
      assert.equal(before, JSON.stringify(state), `entry ${i}: coalesce must not mutate its input state`)
      assert.ok(JSON.parse(JSON.stringify(r.state)), 'state is serialisable')
      state = r.state
      const at = `entry ${i} (${e.flush ? 'flush' : e.setRunning ? 'setRunning' : e.ev.fingerprint} @${e.at})`
      assert.equal(r.deliver !== null, x.delivered, `${at}: delivered (reason ${r.reason})`)
      if (x.reason !== undefined) assert.equal(r.reason, x.reason, `${at}: reason`)
      if (x.summary !== undefined) assert.equal(r.deliver?.summary, x.summary, `${at}: summary`)
      if (x.records !== undefined) assert.equal(r.deliver?.records.length, x.records, `${at}: records`)
      if (x.instance !== undefined) assert.equal(r.deliver?.instance, x.instance, `${at}: instance`)
      const rec = x.delivered ? r.deliver.records[r.deliver.records.length - 1] : state.open[e.ev?.instance]?.[e.ev?.fingerprint]
      if (x.count !== undefined) assert.equal(rec?.count, x.count, `${at}: count`)
      if (x.newCount !== undefined) assert.equal(rec?.newCount, x.newCount, `${at}: newCount`)
      if (x.pending !== undefined) for (const [inst, n] of Object.entries(x.pending)) assert.equal(state.pending[inst]?.length ?? 0, n, `${at}: pending ${inst}`)
      if (x.overflow !== undefined) for (const [inst, n] of Object.entries(x.overflow)) assert.equal(state.overflow[inst] ?? 0, n, `${at}: overflow ${inst}`)
      if (x.delivered) for (const d of r.deliver.records) assert.ok(!('lastDeliveredAt' in d) && d.kind && d.fingerprint, `${at}: delivered record shape`)
    })
  })
}

test('constants are pinned by the vector file', () => {
  assert.deepEqual(vectors.constants, { FOLD_WINDOW_MS, HOURLY_CAP, CHAT_HOURLY_CAP, HOUR_MS, MESSAGE_HEAD_CHARS, MAX_AGENT_TEXT, MAX_PENDING, MAX_OPEN, MAX_MESSAGE_CHARS, MAX_STACK_CHARS, MAX_URL_CHARS, MAX_HINT_CHARS, MAX_UA_CHARS })
  assert.deepEqual(APP_ERROR_KINDS, ['build', 'backend', 'frontend', 'http', 'worker'])
  assert.ok(MAX_OPEN > MAX_PENDING, 'open must hold every pending record')
})

test('formatForAgent output for every kind carries a hint and is bounded', () => {
  const now = 1_700_000_000_000
  for (const kind of APP_ERROR_KINDS) {
    const rec = { kind, fingerprint: `${kind}|f.js:1|m`, count: 1, newCount: 1, firstAt: now, lastAt: now, message: 'm'.repeat(1000), file: 'f.js', line: 1, rev: 2, stack: 'x\n'.repeat(500) }
    const text = formatForAgent({ instance: 'i', rev: 2, at: now, records: [rec] })
    assert.ok(text.includes('fix: '), kind)
    assert.ok(text.length <= MAX_AGENT_TEXT, kind)
  }
})

test('flush with nothing pending is a no-op returning the same state', () => {
  const s = emptyState()
  assert.deepEqual(flush(s, 1), { state: s, deliver: null })
})

test('setRunning: same rev is a no-op (same object); a different rev resets the instance; garbage is ignored', () => {
  const s0 = emptyState()
  const s1 = setRunning(s0, 'i', 3)
  assert.equal(setRunning(s1, 'i', 3), s1)
  assert.deepEqual(s1.running, { i: 3 })
  assert.equal(setRunning(s1, 'i', -1), s1)
  assert.equal(setRunning(s1, '', 4), s1)
  assert.deepEqual(s0, emptyState(), 'input untouched')
})

test('bounded state: open fingerprints stop at MAX_OPEN, pending ones are never evicted, and a storm of 5000 stays small', () => {
  const now = 1_700_000_000_000
  let state = emptyState()
  for (let i = 0; i < 5000; i++) {
    const ev = { instance: 'i', rev: 1, kind: 'frontend', fingerprint: `frontend|-:-|fetch failed id=${i}`, count: 1, firstAt: now + i, lastAt: now + i, message: `fetch failed id=${i}`, stack: 's'.repeat(MAX_STACK_CHARS) }
    state = coalesce(state, ev, now + i).state
  }
  assert.equal(Object.keys(state.open.i).length, MAX_OPEN)
  assert.equal(state.pending.i.length, MAX_PENDING)
  assert.equal(state.overflow.i, 5000 - HOURLY_CAP - MAX_PENDING)
  for (const r of state.pending.i) assert.ok(state.open.i[r.fingerprint], 'pending record still open')
  assert.ok(JSON.stringify(state).length < 1_500_000, `state ${JSON.stringify(state).length} bytes`)
  const { deliver } = flush(state, now + HOUR_MS + 1)
  assert.equal(deliver.records.length, MAX_PENDING)
  assert.equal(deliver.summary, `+${5000 - HOURLY_CAP} more`)
  assert.ok(JSON.stringify(deliver).length < 200_000, `delivery ${JSON.stringify(deliver).length} bytes`)
})
