import test from 'node:test'
import assert from 'node:assert/strict'
import { createReporter, REPORT_BUDGET } from '../reporter.js'
import { fakeFetch } from './fakes.js'

function make(ctx, t = { v: 0 }) {
  const fetch = fakeFetch([{ match: (u) => u === '/_atelier/report', respond: () => ({ status: 204, body: null }) }])
  const r = createReporter({ fetch, now: () => t.v, context: () => ctx, page: () => 'http://localhost/global/toybox', ua: 'UA' })
  return { fetch, r }
}

test('reports for the active app with instance + rev, budget 10/min', () => {
  const t = { v: 0 }
  const { fetch, r } = make({ instance: 'inst-1', rev: 7 }, t)
  assert.equal(r.report('error', 'boom', 'stack'), true)
  const body = JSON.parse(fetch.calls[0].opts.body)
  assert.deepEqual(body, { instance: 'inst-1', rev: 7, url: 'http://localhost/global/toybox', ua: 'UA', kind: 'error', message: 'boom', stack: 'stack' })
  assert.equal(fetch.calls[0].opts.method, 'POST')
  for (let i = 1; i < REPORT_BUDGET; i++) assert.equal(r.report('error', 'e' + i), true)
  assert.equal(r.report('error', 'over'), false)
  assert.equal(fetch.calls.length, REPORT_BUDGET)
  t.v = 60_001
  assert.equal(r.report('error', 'window moved'), true)
})

test('no active app → nothing to report', () => {
  const { fetch, r } = make(null)
  assert.equal(r.report('error', 'boom'), false)
  assert.equal(fetch.calls.length, 0)
})

test('console lane: first occurrence per distinct message only', () => {
  const { fetch, r } = make({ instance: 'inst-1', rev: 1 })
  assert.equal(r.consoleError(['Warning: key', { x: 1 }]), true)
  assert.equal(r.consoleError(['Warning: key', { x: 2 }]), false)
  assert.equal(r.consoleError(['other']), true)
  assert.equal(fetch.calls.length, 2)
  assert.equal(JSON.parse(fetch.calls[0].opts.body).kind, 'console')
})

test('install wires window events and wraps console.error without breaking it', () => {
  const { fetch, r } = make({ instance: 'inst-1', rev: 1 })
  const listeners = {}
  const win = { addEventListener: (ev, fn) => { listeners[ev] = fn } }
  const seen = []
  const con = { error: (...a) => seen.push(a) }
  r.install(win, con)
  listeners.error({ message: 'x', error: { stack: 's' } })
  listeners.unhandledrejection({ reason: { message: 'rej', stack: 's2' } })
  con.error('from console')
  assert.equal(fetch.calls.length, 3)
  assert.deepEqual(seen, [['from console']])
})
