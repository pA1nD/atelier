// Workspace-scoped backend fixture — characterizes that routing + ctx are
// workspace-aware (qualifiedId 'team/gamma', not 'global/gamma').
export default {
  mountRoutes(router, ctx) {
    router.get('/ping', (req, res) => res.json({ qid: ctx.qualifiedId, ws: ctx.workspace }))
  },
}
