// shell/providers/gate-local.mjs — the fleet-only rules, local column (DESIGN §1.3; PLAN §4.6):
// every lane answers `null` = not applicable and the route runs on. This list IS §4.6's
// "fleet-only rules the local provider skips, never fakes": the https redirect (no HSTS header is
// ever sent — `http://localhost:<port>` is the origin), the Host = company gate (`localhost:1844`
// has no company host; the path's first label alone names the workspace), the ticket lane
// (`/_t/*` is 404 like any unknown path — no store, no Continue page), the 302-to-/go (identity is
// always resolved locally). The Origin lane is NOT skipped: it is the same rule evaluated with the
// local credential `'none'` → a no-op, which is why the agent's `curl -X POST` works (C3 surprise 3).
export function createGateLocal() {
  return {
    kind: 'local',
    https() { return null },
    hsts() { return null },
    hostAllowed() { return null },
    async ticket() { return false },
    unauthDocument() { return null },
    origin(req, credential) { return credential === 'cookie' ? originRule(req) : null },
  }
}

// originRule(req): shared with the fleet gate — `Origin` must equal the request's own origin;
// `Origin: null` (a sandboxed frame, a redirect chain) → 403; absent on a write → 403.
export function originRule(req, expected = null) {
  const origin = req.headers?.origin
  const want = expected ?? `https://${String(req.headers?.host ?? '').replace(/:\d+$/, '')}`
  if (typeof origin !== 'string' || origin === 'null' || origin !== want) return { status: 403 }
  return null
}
