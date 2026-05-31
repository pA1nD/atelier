<!-- Hero banner. Animated SVG (SMIL) — renders and animates on GitHub via <img>.
     Hosted in github.com/pA1nD/pa1nd-media (not in this repo) to keep it lean. -->
<p align="center">
  <img src="https://raw.githubusercontent.com/pA1nD/pa1nd-media/main/atelier/banner-painter-animated.svg" alt="Atelier: a luminous painter creating agent helpers in a starlit seaside studio" width="100%" />
</p>
<!-- Static fallback if GitHub ever fails to animate the SVG:
<p align="center">
  <img src="https://raw.githubusercontent.com/pA1nD/pa1nd-media/main/atelier/banner-painter.jpg" alt="Atelier: a luminous painter creating agent helpers in a starlit seaside studio" width="100%" />
</p>
-->


<h3 align="center">Become the creator.</h3>

<p align="center">
  A framework for agent-driven development. You command the agents that build;<br>
  the shell turns each folder into a live, multi-tenant app — and stays the only boundary you trust.
</p>

---

Atelier is an **app shell + module runner**. Point your agent at a folder — a `frontend.jsx` and/or a `backend.js` — and it becomes a routed, hot-reloading, real-time module. The shell handles routing, bundling, a shared real-time WebSocket, workspaces, and (optional) auth, so a module stays a file or two of React and a handful of route handlers.

```
myinstance/
  atelier/            the shell — four files, ~3k lines
  notes/              →  /global/notes      a module (a folder with a frontend.jsx)
  $acme/board/        →  /acme/board         a workspace module
```

The whole shell is **four files (~3k lines)**, and your modules ship **zero dependencies of their own** — no React, no bundler, no WebSocket client to vendor. It ships **zero pixels and zero assumptions**: no default theme, no install step, no dev/prod notion. An instance is a folder you run.

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

Four pages (also browsable in-app via the chrome's Documentation viewer, in this order):

- **[docs/README.md](docs/README.md)** — **Atelier**: running an instance, what lives in `atelier/`, and `atelier.config.json`.
- **[docs/MODULES.md](docs/MODULES.md)** — **Modules**: module shape, `ctx`, real-time (`self`/`broadcast`), hot-reload, cross-module slots — plus the special modules (the **chrome** + `@atelier/kit`).
- **[docs/WORKSPACES.md](docs/WORKSPACES.md)** — **Workspaces**: the multi-tenant model (`global` + `$<ws>/`), the `qualifiedId`, rail and picker.
- **[docs/AUTH.md](docs/AUTH.md)** — **Auth**: the auth-module slot, the `user`/`defaultUser` contract, request + WebSocket gating, takeover render.
- **[CHANGELOG.md](CHANGELOG.md)** — version history and migration notes.

## Tests

```
npm test             # node:test characterization suite (zero extra deps)
```

Run it after any change to the shell (`server.js`, `build.js`, `discovery.js`, `client.jsx`).

## Contributing

The shell (`server.js`, `client.jsx`, `build.js`, `discovery.js`) is cross-cutting — changes there are their own task, separate from any single module. If a module needs something the shell doesn't provide, the convention is to name the gap and propose extending the shell rather than reaching around it. Keep the surface small.

## The name

An *atelier* is a painter's studio. The name comes from an old idea — God is the painter, we are the painting; the creator stands outside what's created. Atelier is where that inverts: you step into the painter's role, and the agents become your servants, the way we are to a creator we can't fully know. The studio is where the created learns to create.

## License

[MIT](LICENSE) © 2026 pa1nd.
