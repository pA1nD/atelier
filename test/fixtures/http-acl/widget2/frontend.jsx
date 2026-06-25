// A SECOND mounted chrome (non-default — `widget` sorts first and wins the
// election). It's still infrastructure: in nobody's workspaces, but its API
// must reach every authed user because some module could pin it via meta.chrome.
// Guards the multi-chrome widening of the isInfra exemption.
export const meta = { isChrome: true, hidden: true }
export default function Module() { return null }
