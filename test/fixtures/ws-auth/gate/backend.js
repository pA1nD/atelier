// Minimal auth fixture: claims the auth slot by exporting `authenticate`.
// Gates on a header so tests can flip between authed/unauth deterministically.
// Returns a user when `X-Test-Auth: ok`, else null → `handleUnauth` owns the
// response (401 JSON).
export default {
  async authenticate(req, defaultUser) {
    if (req.headers['x-test-auth'] === 'ok') return { ...defaultUser, id: 'tester', name: 'tester' }
    return null
  },
  async handleUnauth(req, res) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
  },
  mountRoutes(router) {
    router.get('/me', (req, res) => res.json({ id: req.user?.id || null }))
  },
}
