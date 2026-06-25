export default {
  async mountRoutes(router) {
    router.get('/ping', (req, res) => res.json({ ok: true }))
  },
}
