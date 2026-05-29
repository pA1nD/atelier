// global/pub — broadcasts on POST /emit; everyone may receive its frames.
export default { mountRoutes(r, ctx) { r.post('/emit', (q, s) => { ctx.broadcast({ type: 'ping' }); s.json({ ok: true }) }) } }
