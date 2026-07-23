// Conditional asset serving: every built asset carries an mtime-keyed ETag +
// `no-cache` (= revalidate every time), so a repeat page load costs 304s
// instead of re-downloading multi-MB dev bundles — while an edit (new mtime →
// new ETag) ships fresh bytes immediately.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from './helpers.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'ws-basic')

describe('conditional GETs on assets', () => {
  let server
  before(async () => { server = await startServer(FIXTURE) })
  after(async () => { await server?.stop() })

  const roundTrip = async (p) => {
    const first = await fetch(server.base + p)
    assert.equal(first.status, 200, `${p} should serve`)
    const etag = first.headers.get('etag')
    assert.ok(etag, `${p} should carry an ETag`)
    assert.equal(first.headers.get('cache-control'), 'no-cache')
    const second = await fetch(server.base + p, { headers: { 'If-None-Match': etag } })
    assert.equal(second.status, 304, `${p} should 304 on a matching ETag`)
    assert.equal((await second.text()).length, 0, '304 carries no body')
  }

  test('shell client bundle revalidates', () => roundTrip('/assets/client.js'))
  test('react vendor file revalidates', () => roundTrip('/assets/react.js'))
  test('module frontend revalidates', () => roundTrip('/modules/global/epsilon/frontend.js'))

  test('a mismatched ETag still gets fresh bytes', async () => {
    const r = await fetch(server.base + '/assets/client.js', { headers: { 'If-None-Match': '"nope"' } })
    assert.equal(r.status, 200)
    assert.ok((await r.text()).length > 0)
  })
})
