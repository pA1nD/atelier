// shell/providers/hostlink-fleet.mjs — the fleet wire (DESIGN §1.5, fleet column; PLAN §4.4
// Transport): https to `hostRow.ip:hostRow.port` (1845) with the shell's client certificate
// (`hostRow.tls = {cert, key, ca}` — mTLS is mandatory on the host side, `requestCert`), and
// `Authorization: Bearer <epoch>.<token>` from the registry row. A row without `tls` dials plain
// http — the step-2 drill's `ATELIER_HOST_TLS=plain` opt-out and the shell tests' fake host; the
// fleet registry never hands out such a row. The epoch-moved re-dial (a 401 from a host that
// re-registered → refetch the row once) is the registry provider's refresh, not a retry here.
import https from 'node:https'
import http from 'node:http'
import { createHostLink } from './hostlink-base.mjs'

export const bearer = (hostRow) => `Bearer ${hostRow.epoch}.${hostRow.token}`

export function createHostLinkFleet({ minter, dialMs, idleMs, log } = {}) {
  return createHostLink({
    kind: 'fleet', minter, dialMs, idleMs, log,
    credential: (hostRow) => ({ authorization: bearer(hostRow) }),
    transport: (hostRow) => (hostRow.tls
      ? { lib: https, options: { cert: hostRow.tls.cert, key: hostRow.tls.key, ca: hostRow.tls.ca, servername: hostRow.tls.servername ?? hostRow.hostId, rejectUnauthorized: true } }
      : { lib: http, options: {} }),
  })
}
