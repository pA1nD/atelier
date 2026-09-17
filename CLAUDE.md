# atelier — working rules for this repo

This repo is the platform every fleet app runs on: the shell (`shell/`, `client/`), the host that builds, stores and
serves an app's releases (`host/`), the protocol (`protocol/`). Hundreds of deployed apps, each built by an agent in
a chat, depend on it. Full rules: fleet-infra `CLAUDE.md` §10.

1. **A platform change is a breaking change for every app.** Anything a deployed app depends on — the release store's
   layout (`host/supervisor/lastgood.mjs`, `serve.mjs`, `bundle.mjs`), the shell contract (`ctx`, the WebSocket, the
   routes an app relies on), the kit, the module shape — is changed only as a named PLATFORM CHANGE: in the commit,
   the PR, the ship note, the board card. Never slipped into another track. Prefer a compatible design first.
2. **The fleet never rebuilds an app silently.** A release carries the LAYOUT VERSION that built it (today 1,
   everywhere). Bump it only when the stored shape changes, and then the change says out loud how the apps' agents
   are told to review and deploy again; the machine does not rewrite apps on its own.
3. **A platform change ships with its migration story**: the version bumped when the stored shape moves, a test that
   a release from the previous layout still serves (or is detected), and the count of apps it touches.
4. The fleet client is `client/client.jsx`; the top-level `client.jsx` is the local shell's. Work in a worktree
   (`.claude/worktrees/<branch>`); the operator's local atelier runs from the repo root.
