// A non-default chrome's API. Exempt from the presence gate because it's a
// mounted chrome (the exemption covers the whole chrome set, not just the
// resolved default).
export default {
  mountRoutes(router) {
    router.get('/ping', (q, s) => s.json({ ok: true, infra: true, chrome: 'widget2' }))
  },
}
