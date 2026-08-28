---
name: atelier-app
description: Build or change an atelier app — a folder under apps/ that is live the moment it is saved. Use for ANY request to build an app, page, tool, list, timer, poll, board, dashboard or game for the people in this chat. Covers module.json, backend.js routes, frontend.jsx (global React), and checking that a save went LIVE.
---

# Building an atelier app

An app is one folder: `apps/<slug>/` with `module.json`, `frontend.jsx`, `backend.js` (and optionally `styles.css`).
**Saving is deploying.** The host watches `apps/`, rebuilds on every save, and the people in the chat see the new
version immediately — there is no build step, no server to start, no deploy command. A save that does not build
changes nothing for users (they stay on the last good version) and the error comes back to you.

**Order of work (four tool calls is the norm):** `mkdir -p apps/<slug>`, then write `backend.js` and `frontend.jsx`,
and `module.json` LAST — module.json is the switch that turns the folder into a live app, so nothing builds (and
nobody sees a half-written app) until it exists; a module.json written before the other files makes every save in
between a FAILED "file missing" verdict. Then one Bash call with every curl check; then answer the chat. Write and
change files only with the Write/Edit tools — a file written from a shell command (`cat >`, python, sed) still goes
live but its verdict never reaches you. Do not copy `apps/hello` (in the fleet a copied `.instance` file is refused);
its three files are exactly the templates below, so there is nothing to read first. The slug is the URL and must be a
lowercase DNS label (`shopping-list`, not `Shopping List`). Keep the app small — one folder, a few files.

## module.json — the folder is not an app until this exists

```json
{ "name": "Shopping list", "icon": "shopping-cart" }
```

Keys, all optional except `name` and `icon`: `name` (rail label), `icon` (a lucide icon name, e.g. `timer`,
`list-checks`, `bar-chart-3`), `group` (rail section), `primary` (boolean — the landing app), `color`. No other
keys — the registrar drops anything else silently.
An app belongs to its chat: everyone in the conversation sees it, nobody else. There is no visibility switch to
set; a company-wide app is a dyno app, which is not something module.json expresses.

## backend.js — routes, relative to the app's mount

```js
import fs from 'node:fs'
import path from 'node:path'
export default {
  mountRoutes(router, ctx) {
    router.get('/items', (req, res) => res.json(read()))          // served at /api/<company>/<slug>/items
    router.post('/items', async (req, res) => {
      const { text } = await req.json()                            // parsed JSON body (10 MB cap)
      if (!text) return res.json({ error: 'text required' }, 400)
      write([...read(), { id: Date.now(), text, by: req.user.name }])
      ctx.broadcast({ type: 'changed' })                            // push to every open tab of this app
      res.json({ ok: true })
    })
    router.delete('/items/:id', (req, res) => { remove(req.params.id); ctx.broadcast({ type: 'changed' }); res.json({ ok: true }) })
  },
}
```

- Paths are **relative**; the host mounts them at `/api/<company>/<slug>`. Never write that prefix in backend.js.
- Router: `get/post/put/patch/delete/options/all(pattern, handler)`; patterns: exact, `:param`, trailing `/*`
  (rest in `req.params['*']`), bare `/`. First registered match wins — specific before wildcard.
- `req.params`, `req.query`, `await req.json()`, `req.user` = `{ id, name }` of the person calling (trusted — the host
  set it); `res.json(data, status = 200)`; or use the raw Node `res` for anything else (streams, SSE, files).
- `ctx` (frozen): `id`, `workspace` (the company), `qualifiedId`, `baseUrl` (the app's public API URL — the only
  source of it), `host` and `port` (the PUBLIC origin's hostname and port — the address users reach the app at, for
  composing URLs; never something to bind), `dataDir` (a private, persistent folder for this app's files — keep
  state there, e.g. a JSON file or SQLite via `node:sqlite`), `log(...)`, `broadcast(event)`, `module(id)`.
- State: module-level variables are lost on every save; persist in `ctx.dataDir`, load lazily.
- `mountRoutes` must only register routes; heavy or failing work belongs inside handlers. It may return a teardown
  function (timers, watchers) that runs before the next revision replaces this one.
- **npm packages:** `npm install <pkg>` inside the app folder (its own `package.json`), then load with
  `const require = createRequire(import.meta.url); const x = require('<pkg>')` (`import { createRequire } from 'node:module'`).
  A static `import x from '<pkg>'` is refused. Prefer `node:` builtins — most apps need none.
- Never `listen()` on a port or open your own server: the host is the only door; a port would be unreachable.
- A pure-frontend app still ships `backend.js`: `export default { mountRoutes() {} }`.

## frontend.jsx — global React, classic JSX

```jsx
import { Heading, Text, Button, Input } from '@atelier/kit'   // the chrome's primitives — the ONLY bare import allowed
const { useState, useEffect } = React                          // React is a global; NEVER `import React`
const self = window.__atelier.self(import.meta.url)            // { api, qid, subscribe, ... } — never a literal /api path
export default function Module() {
  const [items, setItems] = useState([])
  const load = () => fetch(self.api + '/items').then(r => r.json()).then(setItems)
  useEffect(() => { load(); return self.subscribe(frame => { if (frame.type === 'changed') load() }) }, [])
  const { path, navigate } = window.__atelier.useRoute()       // optional sub-routes: '' at the root, navigate('x/1')
  return <div className="flex flex-col gap-3">…</div>
}
```

- The file is compiled with the **classic** JSX transform against the global `React` (`React.createElement`).
  `import React from 'react'` breaks the app; so does any `react-dom` import. Hooks: `const { useState } = React`.
- Imports that resolve in the browser: relative files next to frontend.jsx (`./util.js`) and `@atelier/kit`.
  No npm packages in the frontend — put the logic in backend.js or inline it.
- Kit (this is the whole prop sheet — the chrome's source is not on this computer, do not go looking for it):
  `Button` (`color="blue|red|green|amber|zinc|…"`, `outline`, `plain`, `disabled`, `onClick`, `href`) · `Badge`
  (`color`) · `Input` / `Textarea` / `Select` (native props: `type value onChange placeholder`) · `Switch`
  (`checked onChange color`) · `Field` > `Label` + control · `Heading`, `Subheading`, `Text`, `Strong`, `Code`,
  `Divider`, `Link` (`href`) · `Table, TableHead, TableBody, TableRow, TableHeader, TableCell` · `Dialog`
  (`open onClose size`) + `DialogTitle, DialogBody, DialogActions`. All take `className`. Tailwind utilities work
  (`className="flex gap-2 text-sm"`). Do not add a card/frame around the app — it already sits inside padding.
- `self.api` is the app's API base; `self.subscribe(handler)` receives every `ctx.broadcast` frame from this app's
  backend (returns an unsubscribe fn — return it from `useEffect`). For initial state fetch a snapshot, then keep
  in sync via the subscription. `self.qid` is `<company>/<slug>`.
- Must `export default` one component. It must render once with empty state before any fetch resolves.
- Sub-navigation only through `window.__atelier.useRoute()`; no `history.*`, no `<a href="/...">` to other apps.

## styles.css (optional)

Plain CSS, scoped by your own class names. Tailwind utilities need no file.

## Check every save — the tool result tells you

After each Write/Edit inside `apps/<slug>/`, the tool result carries one line starting with `atelier:`:

- `atelier: LIVE rev N <slug> in 40 ms — <url> (api: <api url>)` — users have this version now.
- `atelier: FAILED <slug> (users still on rev N) <file>:<line>:<col> <message> — <fix>` — nothing changed for users;
  apply the fix and save again. A verdict names every broken file at once (module.json, frontend, css, backend).
- `atelier: idle` or no line — the save did not trigger a build (a file outside an app, or `module.json` missing).

Then exercise the backend in ONE Bash call with curl against the `api:` URL in the LIVE line, e.g.
`curl -s <api>/items` and `curl -s -X POST <api>/items -H 'content-type: application/json' -d '{"text":"milk"}'`;
pass `-H 'x-atelier-user: u2' -H 'x-atelier-name: Bea'` to act as a second person. Delete your test data after.
Broadcast frames the backend emitted are listed at `<host>/_atelier/events?app=<slug>` (host = the origin of the
`api:` URL). A 500 from a handler is also reported in the next verdict as a runtime error.

You have no browser here; the render smoke in the verdict covers the first paint. Do not start servers, do not
`npm run` anything, do not create package.json unless you install a package. When the LIVE line shows and the API
answers, the app is done: tell the chat the app's name and what it does, in one or two lines.

## Do not

- `import React` / `from 'react'` · a literal `/api/<slug>` path · a static `import` of an npm package in backend.js ·
  `listen()` · a missing `module.json` · state in module-level variables · keys in module.json beyond the five above.
