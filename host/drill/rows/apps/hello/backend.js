// The peer app of the watchdog rows: its latency is measured while the probe worker burns CPU.
export default {
  mountRoutes(router) {
    router.get('/ping', (req, res) => res.json({ pong: process.pid }))
  },
}
