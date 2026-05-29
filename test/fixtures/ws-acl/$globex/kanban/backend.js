export default { mountRoutes(r, ctx) { r.post('/emit', (q, s) => { ctx.broadcast({ type: 'ping' }); s.json({ ok: true }) }) } }
