// The active chrome's API: in nobody's workspaces, but the shell waves the
// server-resolved chrome qid through the gate so every authed user reaches it.
export default {
  mountRoutes(router) {
    router.get('/ping', (q, s) => s.json({ ok: true, infra: true }))
  },
}
