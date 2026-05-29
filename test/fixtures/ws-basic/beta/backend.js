// Backend fixture: a read route and a route that broadcasts on the module's
// own topic (global/beta) — used to characterize scoped routing + the WS
// multiplex round-trip.
export default {
  mountRoutes(router, ctx) {
    router.get('/ping', (req, res) => res.json({ ok: true, qid: ctx.qualifiedId, ws: ctx.workspace }))
    router.post('/echo', async (req, res) => {
      const body = await req.json()
      ctx.broadcast({ type: 'echo', body })
      res.json({ echoed: body })
    })
  },
}
