export default {
  mountRoutes(router, ctx) {
    router.get('/hi', (req, res) => res.json({ hi: req.user.name, data: ctx.dataDir }))
  },
}
