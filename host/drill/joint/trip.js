// Runs in the spine pod (node:24-slim). Tails the registrar's JSON-line log and, the instant the
// host's GET /v1/apps/<instance>/config lands (the last call before a swap's events push), fires a
// register with the bootstrap — revoking the host's token in the ~100 ms window between that GET
// and the invalidation push, so the events batch is the call that meets 401 host-epoch-moved.
//   node trip.js <log> <bootstrap> <instance> <fromLine>
const fs = require('node:fs'), http = require('node:http')
const [log, bootstrap, instance, from] = process.argv.slice(2)
const want = `"path":"/v1/apps/${instance}/config"`
const t0 = Date.now()
const tick = () => {
  const lines = fs.readFileSync(log, 'utf8').split('\n').slice(Number(from))
  const hit = lines.find((l) => l.includes(want) && l.includes('"status":200'))
  if (!hit) { if (Date.now() - t0 > 30000) { console.log('TRIP timeout'); process.exit(1) } return setTimeout(tick, 2) }
  const req = http.request({ host: '127.0.0.1', port: 7999, path: '/v1/host/register', method: 'POST', headers: { authorization: `Bearer ${bootstrap}`, 'content-type': 'application/json' } }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { console.log(`TRIP ${res.statusCode} after ${Date.now() - t0} ms epoch ${JSON.parse(b).epoch}`); process.exit(0) })
  })
  req.end(JSON.stringify({ pod_ip: 'tripped' }))
}
tick()
