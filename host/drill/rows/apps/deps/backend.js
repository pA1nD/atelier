// The install row (DESIGN §8.2 row 8): the worker createRequire's the frozen deps from its app folder —
// a native prebuild (better-sqlite3), the hostile postinstall package (loot-pkg) and a plain one (core-js).
import { createRequire } from 'node:module'
export default {
  mountRoutes(router) {
    router.get('/deps', (req, res) => {
      const need = createRequire(process.cwd() + '/package.json')
      const out = { uid: process.getuid(), cwd: process.cwd() }
      try { const D = need('better-sqlite3'); const db = new D(':memory:'); out.sqlite = db.prepare('select 42 as x').get().x; db.close() } catch (e) { out.sqlite = 'FAIL:' + (e.code ?? e.message).slice(0, 80) }
      try { out.loot = need('loot-pkg/package.json').version } catch (e) { out.loot = 'FAIL:' + (e.code ?? e.message).slice(0, 60) }
      try { need('core-js'); out.corejs = 'ok' } catch (e) { out.corejs = 'FAIL:' + (e.code ?? e.message).slice(0, 40) }
      res.json(out)
    })
  },
}
