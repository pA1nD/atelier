// shell/providers/hostlink-local.mjs — the local wire (DESIGN §1.5, local column): plain http to
// `127.0.0.1:<devPort>` with `x-atelier-dev-token: <token>` (the host's dev lane, auth.devRequest);
// every other header rule identical to the fleet. The assertion header is minted and sent by the
// same code path; the dev lane does not verify it today (identity there is the dev token's
// principal, the same `{id:'local'}`) — it becomes verified the day the host's local transport
// takes the shell's key (§8 H2). SKIPPED here: mTLS, the bearer with epoch, the epoch-moved re-dial.
import { createHostLink } from './hostlink-base.mjs'

export const DEV_TOKEN_HEADER = 'x-atelier-dev-token'

export function createHostLinkLocal({ minter, dialMs, idleMs, log } = {}) {
  return createHostLink({
    kind: 'local', minter, dialMs, idleMs, log,
    credential: (hostRow) => (hostRow.token ? { [DEV_TOKEN_HEADER]: hostRow.token } : {}),
  })
}
