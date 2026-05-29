// Multi-tenant auth fixture: the `X-Test-User` header selects a view.
// `user.workspaces[].modules[]` is the PER-MODULE membership the WS ACL enforces
// (same structure the chrome renders the rail from — one source of truth).
// There is NO `global` exception — global modules are gated per-user like any
// other; they "reach everyone" only because they're usually granted to all.
//
//   admin → global/pub + acme/{kanban,secret} + globex/kanban  (used to emit)
//   alice → global/pub + acme/kanban       (in acme, but NOT module secret)
//   bob   → global/pub + globex/kanban
//   eve   → acme/kanban only               (deliberately NOT granted global/pub)
//
// Mutable controls (POST routes) let a test revoke a session or grant a module
// mid-run, exercising the periodic WS re-validation.
const USERS = {
  admin: [['global', ['pub']], ['acme', ['kanban', 'secret']], ['globex', ['kanban']]],
  alice: [['global', ['pub']], ['acme', ['kanban']]],
  bob: [['global', ['pub']], ['globex', ['kanban']]],
  eve: [['acme', ['kanban']]],
}
const revoked = new Set()   // user names whose session has ended
const grants = {}           // name -> [[workspace, module], ...] extra access

function entriesFor(name) {
  const base = (USERS[name] || []).map(([id, mods]) => [id, [...mods]])
  for (const [ws, mod] of grants[name] || []) {
    let e = base.find(([id]) => id === ws)
    if (!e) { e = [ws, []]; base.push(e) }
    if (!e[1].includes(mod)) e[1].push(mod)
  }
  return base
}
const view = (name) => ({
  id: name,
  name,
  workspaces: entriesFor(name).map(([id, mods]) => ({ id, modules: mods.map((m) => ({ id: m })) })),
})

export default {
  async authenticate(req) {
    const name = req.headers['x-test-user']
    if (!name || revoked.has(name)) return null
    return USERS[name] || grants[name] ? view(name) : null
  },
  async handleUnauth(req, res) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end('{"error":"unauthorized"}')
  },
  mountRoutes(router) {
    router.post('/revoke', (q, s) => { revoked.add(q.query.user); s.json({ ok: true }) })
    router.post('/grant', (q, s) => { (grants[q.query.user] ??= []).push([q.query.ws, q.query.mod]); s.json({ ok: true }) })
  },
}
