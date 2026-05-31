export default {
  mountRoutes(router) {
    router.get('/ping', (q, s) => s.json({ ok: true, infra: true }))
  },
}
