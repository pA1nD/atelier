# Atelier

The app shell + module runner. Atelier discovers sibling module directories, mounts their backends, serves their frontends, and renders whatever **chrome** (theme) you install around them — one runtime hosting many small modules.

A module is just a directory with a `frontend.jsx` and/or a `backend.js`. The shell handles routing, bundling, hot reload, a shared real-time WebSocket, workspaces, and (optional) auth, so a module stays a file or two of React + a handful of route handlers.

The shell ships **zero pixels and zero assumptions**: no default theme, no install step, no dev/prod notion. An instance is a folder you run.

> **Platform.** Atelier runs anywhere Node 24+ does — there is no OS-specific install layer (you run it; your process manager / PaaS / reverse proxy is your concern).

## Quickstart

```
npm install
npm run dev          # http://localhost:1844 (override with PORT=…), hot reload, discovers sibling modules
```

The folder you run from **is** the instance. Its [`atelier.config.json`](docs/README.md#configuration--discovery) is the source of truth (which modules run, which chrome, port, auth, …); environment variables override it at startup. Want a second instance? Run a second folder — or the same folder with different startup config (e.g. a different `PORT` and `auth`).

You'll see an "add a chrome" screen until you install a chrome module — the shell has no built-in theme. Point your config's `chrome` at one (a folder exporting `meta = { chrome: true }` and a `chrome` function); `catalyst-chrome` and `gruvbox-chrome` are two you can copy.

## Write a module

Scaffold one — paste this next to `atelier/` (or anywhere your config path-mounts):

```bash
mkdir -p hello && cat > hello/frontend.jsx <<'EOF'
export const meta = { name: 'Hello', icon: 'sparkles' }   // icon: any lucide name
export default function Module() {
  return <div className="p-8 text-xl">hello from a module</div>
}
EOF
```

Reload — it appears in the rail. A folder with a `frontend.jsx` is the whole requirement. Add a `backend.js` for an API:

```js
// hello/backend.js — routes mount at /api/<workspace>/hello
export default {
  mountRoutes(router, ctx) {
    router.get('/ping', (req, res) => res.json({ ok: true, from: ctx.qualifiedId }))
  },
}
```

The full contract — `ctx`, the real-time WebSocket, `ctx.module(id)` slots, hot-reload teardown, the chrome slot, `@atelier/kit`, workspaces, and `atelier.config.json` — is in the [documentation](#documentation).

## Documentation

- **[docs/README.md](docs/README.md)** — the full guide: module convention, `ctx` and routing, data lifecycle, workspaces, hot reload, the `/_atelier/ws` real-time transport, cross-module slots, the chrome slot and `@atelier/kit`, and `atelier.config.json`.
- **[docs/AUTH.md](docs/AUTH.md)** — the authentication layer: the auth-module slot, the `user`/`defaultUser` contract, per-request and WebSocket gating, takeover render, and the workspace-portability checklist.
- **[CHANGELOG.md](CHANGELOG.md)** — version history and migration notes.

## Tests

```
npm test             # node:test characterization suite (zero extra deps)
```

Run it after any change to the shell (`server.js`, `build.js`, `discovery.js`, `client.jsx`).

## Contributing

The shell (`server.js`, `client.jsx`, `build.js`, `discovery.js`) is cross-cutting — changes there are their own task, separate from any single module. If a module needs something the shell doesn't provide, the convention is to name the gap and propose extending the shell rather than reaching around it. Keep the surface small.

## License

[MIT](LICENSE) © 2026 pa1nd.
