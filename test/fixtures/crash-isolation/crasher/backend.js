export default {
  async mountRoutes(router) {
    router.get('/ping', (req, res) => res.json({ ok: true }))
    // An uncaught async throw OUTSIDE any request — the classic shell-killer.
    // The shell must isolate this (surface it, stay alive), not crash.
    setTimeout(() => { throw new Error('boom from a module timer') }, 50)
  },
}
