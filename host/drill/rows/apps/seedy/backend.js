// The seeded drill's app (row 9s): `hello`'s /ping plus ctx.suspendable() — the R14 declaration that lets the host stop
// the prod worker after 60 s quiet and resume it on the next request (row 9s-e measures that on the real pod; `steady`,
// the same app without the declaration, must stay live across the window).
export default {
  mountRoutes(router, ctx) {
    ctx.suspendable()
    router.get('/ping', (req, res) => res.json({ pong: process.pid }))
  },
}
