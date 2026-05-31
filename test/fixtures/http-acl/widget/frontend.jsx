// The active chrome fixture: resolved server-side as the one chrome, so its
// API (like a real chrome's /docs) is exempt from the presence gate — it's in
// nobody's workspaces, but every authed user must reach it.
export const meta = { chrome: true, hidden: true }
export default function Module() { return null }
