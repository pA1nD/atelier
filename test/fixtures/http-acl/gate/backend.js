// Multi-tenant HTTP auth fixture. `x-test-user` selects a view (authenticate),
// and `authorize` enforces read/write + a payload rule BELOW the module
// boundary. Only THIS module is trusted — the feature modules alongside it do
// no checks of their own (they're stand-ins for vibe-coded modules).
//
//   admin → global/pub, acme/board, globex/board   (all write)
//   alice → global/pub (write), acme/board (READ)    — in acme, but read-only
//   bob   → global/pub (write), globex/board (write) — not acme at all
//
// Grants are keyed by qualifiedId so they match `target.qualifiedId` directly.
const USERS = {
  admin: { 'global/pub': 'write', 'acme/board': 'write', 'globex/board': 'write' },
  alice: { 'global/pub': 'write', 'acme/board': 'read' },
  bob:   { 'global/pub': 'write', 'globex/board': 'write' },
}
const READ = new Set(['GET', 'HEAD'])

function view(name) {
  const byWs = {}
  for (const qid of Object.keys(USERS[name])) {
    const [ws, id] = qid.split('/')
    ;(byWs[ws] ??= []).push({ id })
  }
  return {
    id: name,
    name,
    workspaces: Object.entries(byWs).map(([id, modules]) => ({ id, modules })),
  }
}

export default {
  async authenticate(req) {
    const name = req.headers['x-test-user']
    return name && USERS[name] ? view(name) : null
  },
  // Trusted below-module enforcement. The shell runs this AFTER the presence
  // gate (so the module is already known-visible) and BEFORE the module router.
  async authorize(req, user, { qualifiedId, method }) {
    const level = USERS[user.id]?.[qualifiedId]
    if (!level) return false                 // default-deny (belt; presence already gated)
    if (READ.has(method)) return true        // reads ok for read OR write grant
    const body = await req.json().catch(() => ({}))   // payload-level inspection
    if (body?.danger === true) return false  // this payload is never allowed, any level
    return level === 'write'                 // mutations need a write grant
  },
  async handleUnauth(req, res) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end('{"error":"unauthorized"}')
  },
  mountRoutes(router) {
    // The auth module's OWN route — reachable by any authed user even though
    // `global/gate` is in nobody's workspaces (the shell exempts the gate qid
    // from both the presence gate and authorize).
    router.get('/whoami', (q, s) => s.json({ id: q.user.id }))
  },
}
