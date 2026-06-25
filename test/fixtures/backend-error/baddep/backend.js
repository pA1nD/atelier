// Static import of a node_modules dep — can't resolve from the data: URL the
// backend is hot-loaded as (the exact gotcha). The shell should surface this as
// a 500 on THIS module's /api only, with the createRequire fix in the message.
import 'totally-missing-pkg-xyz'
export default {
  async mountRoutes(router) {
    router.get('/ping', (req, res) => res.json({ ok: true }))
  },
}
