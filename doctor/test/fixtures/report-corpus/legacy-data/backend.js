import fs from 'node:fs'
import path from 'node:path'
const HERE = path.dirname(new URL(import.meta.url).pathname)
export default {
  mountRoutes(router, ctx) {
    const dir = path.join(HERE, 'data')
    const token = process.env.LEGACY_TOKEN || 'dev'
    router.get('/rows', (req, res) => res.json({ rows: fs.readdirSync(dir), token: token.length, base: `/api/global/${ctx.id}/rows` }))
  },
}
