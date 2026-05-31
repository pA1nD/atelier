// A hidden infrastructure module (like a chrome): in nobody's workspaces, so
// the presence gate would 403 it — but the shell exempts chrome/hidden infra.
export default {
  mountRoutes(router) {
    router.get('/ping', (q, s) => s.json({ ok: true, infra: true }))
  },
}
