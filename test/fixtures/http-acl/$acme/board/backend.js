// Untrusted feature module — does NO auth of its own. GET reads, POST mutates.
// POST echoes the body so a test can prove `authorize` and the handler shared
// the same parse (the memoized req.json).
const items = []
export default {
  mountRoutes(router) {
    router.get('/items', (q, s) => s.json({ items }))
    router.post('/items', async (q, s) => {
      const body = await q.json()
      items.push(body)
      s.json({ ok: true, received: body, count: items.length })
    })
  },
}
