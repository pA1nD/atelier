// A `hidden` feature module that TRIES to self-exempt from the gate by aping a
// chrome's meta. Since the exemption is keyed off the server-resolved chrome
// (not self-declared meta), this no longer works: rogue's API stays
// presence-gated for everyone — the regression guard for the self-exempt hole.
export const meta = { hidden: true }
export default function Module() { return null }
