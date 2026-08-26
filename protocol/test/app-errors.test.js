import test from 'node:test'
import assert from 'node:assert/strict'
import { coalesce, flush, emptyState, fingerprint, fromFrontendReport, formatForAgent, validateAppError, APP_ERROR_KINDS, FOLD_WINDOW_MS, HOURLY_CAP, HOUR_MS, MESSAGE_HEAD_CHARS, MAX_AGENT_TEXT } from '../app-errors.js'
import vectors from '../vectors/app-errors.json' with { type: 'json' }

for (const c of vectors.cases) {
  test(`vector: ${c.name}`, () => {
    if (c.fn === 'fingerprint') return assert.equal(fingerprint(c.input), c.expect)
    if (c.fn === 'fromFrontendReport') {
      const ev = fromFrontendReport(c.input, c.now)
      assert.deepEqual(ev, c.expect)
      return assert.deepEqual(validateAppError(ev), { ok: true })
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
      const r = e.flush ? flush(state, now) : coalesce(state, e.ev, now)
      assert.equal(before, JSON.stringify(state), `entry ${i}: coalesce must not mutate its input state`)
      assert.ok(JSON.parse(JSON.stringify(r.state)), 'state is serialisable')
      state = r.state
      const at = `entry ${i} (${e.flush ? 'flush' : e.ev.fingerprint} @${e.at})`
      assert.equal(r.deliver !== null, x.delivered, `${at}: delivered (reason ${r.reason})`)
      if (x.reason !== undefined) assert.equal(r.reason, x.reason, `${at}: reason`)
      if (x.summary !== undefined) assert.equal(r.deliver?.summary, x.summary, `${at}: summary`)
      if (x.records !== undefined) assert.equal(r.deliver?.records.length, x.records, `${at}: records`)
      if (x.instance !== undefined) assert.equal(r.deliver?.instance, x.instance, `${at}: instance`)
      const rec = x.delivered ? r.deliver.records[r.deliver.records.length - 1] : state.open[e.ev?.instance]?.[e.ev?.fingerprint]
      if (x.count !== undefined) assert.equal(rec?.count, x.count, `${at}: count`)
      if (x.newCount !== undefined) assert.equal(rec?.newCount, x.newCount, `${at}: newCount`)
      if (x.delivered) for (const d of r.deliver.records) assert.ok(!('lastDeliveredAt' in d) && d.kind && d.fingerprint, `${at}: delivered record shape`)
    })
  })
}

test('constants are pinned by the vector file', () => {
  assert.deepEqual(vectors.constants, { FOLD_WINDOW_MS, HOURLY_CAP, HOUR_MS, MESSAGE_HEAD_CHARS, MAX_AGENT_TEXT })
  assert.deepEqual(APP_ERROR_KINDS, ['build', 'backend', 'frontend', 'http', 'worker'])
})

test('formatForAgent output for every kind carries a hint and is bounded', () => {
  const now = 1_700_000_000_000
  for (const kind of APP_ERROR_KINDS) {
    const rec = { kind, fingerprint: `${kind}|f.js:1|m`, count: 1, newCount: 1, firstAt: now, lastAt: now, message: 'm'.repeat(5000), file: 'f.js', line: 1, rev: 2, stack: 'x\n'.repeat(500) }
    const text = formatForAgent({ instance: 'i', rev: 2, at: now, records: [rec] })
    assert.ok(text.includes('fix: '), kind)
    assert.ok(text.length <= MAX_AGENT_TEXT, kind)
  }
})

test('flush with nothing pending is a no-op returning the same state', () => {
  const s = emptyState()
  assert.deepEqual(flush(s, 1), { state: s, deliver: null })
})
