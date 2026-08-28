// The worker router (runtime.mjs createRouter) — spike-b6's 20 asserts + req.json (memoized, 413 cap),
// HEAD→GET through handle(), res.json, and the onError hook for 5xx.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createRouter, JSON_BODY_CAP } from '../worker/runtime.mjs'

test('b6 matrix: exact, :param, trailing /* (bare parent too), bare /, every method, all(), HEAD→GET, first match wins', () => {
  const r = createRouter()
  const hits = []
  const h = (tag) => (req) => { hits.push([tag, req.method, req.params]) }
  r.get('/', h('root'))
  r.get('/items/:id', h('item'))
  r.get('/s/:id/space.js', h('spacejs'))
  r.get('/s/:id/api/*', h('spaceapi'))
  r.get('/s/:id/*', h('spacestatic'))
  r.options('/*', h('cors'))
  r.post('/upload', h('upload'))
  r.all('/*', h('catchall'))
  const tag = (method, path) => { const x = r.match(method, path); if (!x) return null; hits.length = 0; x.route.handler({ method, params: x.params }); return hits[0] }
  const t = (method, path, wantTag, wantParams) => {
    const got = tag(method, path)
    assert.ok(got, `${method} ${path}: no match`)
    assert.equal(got[0], wantTag, `${method} ${path}: ${got[0]} != ${wantTag}`)
    if (wantParams) assert.deepEqual(got[2], wantParams, `${method} ${path}: params ${JSON.stringify(got[2])}`)
  }
  t('GET', '', 'root')
  t('GET', '/', 'root')
  t('HEAD', '/', 'root')
  t('GET', '/items/42', 'item', { id: '42' })
  t('GET', '/items/a%2Fb', 'item', { id: 'a/b' })
  t('GET', '/s/abc/space.js', 'spacejs', { id: 'abc' })
  t('GET', '/s/abc/api/db/query', 'spaceapi', { id: 'abc', '*': 'db/query' })
  t('GET', '/s/abc/api', 'spaceapi', { id: 'abc', '*': '' })
  t('GET', '/s/abc', 'spacestatic', { id: 'abc', '*': '' })
  t('GET', '/s/abc/', 'spacestatic', { id: 'abc', '*': '' })
  t('GET', '/s/abc/deep/er/still/index.html', 'spacestatic', { id: 'abc', '*': 'deep/er/still/index.html' })
  t('OPTIONS', '/anything/at/all', 'cors', { '*': 'anything/at/all' })
  t('POST', '/upload', 'upload')
  t('PUT', '/whatever/deep', 'catchall', { '*': 'whatever/deep' })
  t('PROPFIND', '/dav/x', 'catchall')
  t('DELETE', '/', 'catchall', { '*': '' })
  assert.equal(r.match('GET', '/items').route.method, 'ALL')
  const r2 = createRouter(); r2.get('/only', () => {})
  assert.equal(r2.match('GET', '/nope'), null)
  assert.equal(r2.match('POST', '/only'), null)
})

// a minimal req/res pair for handle()
function fakeReq({ method = 'GET', url = '/', body = null, headers = {} } = {}) {
  const req = Readable.from(body === null ? [] : [Buffer.from(body)])
  Object.assign(req, { method, url, headers })
  return req
}
function fakeRes() {
  const res = { status: null, headers: null, body: '', headersSent: false, writableEnded: false }
  res.writeHead = (s, h) => { res.status = s; res.headers = h; res.headersSent = true }
  res.end = (b = '') => { res.body += b; res.writableEnded = true }
  res.write = (b) => { res.body += b }
  return res
}

test('handle(): params/query/path, res.json(data, status), 404 = false, HEAD served by the GET route', async () => {
  const r = createRouter()
  r.get('/items/:id', (req, res) => res.json({ id: req.params.id, q: req.query, path: req.path }, 201))
  let res = fakeRes()
  assert.equal(await r.handle(fakeReq({ url: '/items/7?x=1&y=2' }), res), true)
  assert.equal(res.status, 201)
  assert.deepEqual(res.headers, { 'content-type': 'application/json' })
  assert.deepEqual(JSON.parse(res.body), { id: '7', q: { x: '1', y: '2' }, path: '/items/7' })
  res = fakeRes()
  assert.equal(await r.handle(fakeReq({ method: 'HEAD', url: '/items/7' }), res), true)
  assert.equal(res.status, 201)
  assert.equal(await r.handle(fakeReq({ url: '/nope' }), fakeRes()), false)
  res = fakeRes()
  assert.equal(await r.handle(fakeReq({ url: '/items/%E0%A4%A' }), res), true)   // bad encoding → 400, still handled
  assert.equal(res.status, 400)
})

test('req.json(): memoized, {} on an empty body, 400 on bad JSON, 413 past 10 MiB', async () => {
  const r = createRouter({ onError: () => {} })
  let seen
  r.post('/j', async (req, res) => { const a = req.json(); const b = req.json(); seen = a === b; res.json(await a) })
  let res = fakeRes()
  await r.handle(fakeReq({ method: 'POST', url: '/j', body: '{"a":1}' }), res)
  assert.deepEqual(JSON.parse(res.body), { a: 1 })
  assert.equal(seen, true)
  res = fakeRes()
  await r.handle(fakeReq({ method: 'POST', url: '/j' }), res)
  assert.deepEqual(JSON.parse(res.body), {})
  res = fakeRes()
  await r.handle(fakeReq({ method: 'POST', url: '/j', body: '{nope' }), res)
  assert.equal(res.status, 400)
  res = fakeRes()
  const big = Buffer.alloc(JSON_BODY_CAP + 1, 0x20)
  await r.handle(fakeReq({ method: 'POST', url: '/j', body: big }), res)
  assert.equal(res.status, 413)
  assert.deepEqual(JSON.parse(res.body), { error: 'body too large' })
})

test('a handler throw → 500 {error} + onError(err, req, res, 500); err.statusCode < 500 → no onError', async () => {
  const errors = []
  const r = createRouter({ onError: (err, req, res, status) => errors.push([err.message, req.path, status]) })
  r.get('/boom', () => { throw new Error('kaboom') })
  r.get('/teapot', () => { throw Object.assign(new Error('short'), { statusCode: 418 }) })
  let res = fakeRes()
  await r.handle(fakeReq({ url: '/boom' }), res)
  assert.equal(res.status, 500)
  assert.deepEqual(JSON.parse(res.body), { error: 'kaboom' })
  res = fakeRes()
  await r.handle(fakeReq({ url: '/teapot' }), res)
  assert.equal(res.status, 418)
  assert.deepEqual(errors, [['kaboom', '/boom', 500]])
})
