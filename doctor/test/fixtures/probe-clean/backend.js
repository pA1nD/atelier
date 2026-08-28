// probe-clean — a backend the fleet runs as-is: routes only, a teardown, nothing held after mount.
export default {
  mountRoutes(router, ctx) {
    router.get('/', (req, res) => res.json({ ok: true, app: ctx.qualifiedId, data: ctx.dataDir }))
    return () => {}
  },
}
