---
name: atelier-app
description: Build, change, deploy, roll back or restore an atelier app — a folder under /work/apps you develop in a private DEV slot and release to the chat with `atelier deploy`. Use for ANY request to build an app, page, tool, list, timer, poll, board, dashboard or game for the people in this chat, and for changing one that exists. Covers module.json, backend.js routes, frontend.jsx (global React), the deploy hook (migrations), test and smoke scripts, releases and backups.
---

# Building and deploying an atelier app

An app is one folder, `/work/apps/<slug>/`: `module.json`, `frontend.jsx`, `backend.js` (optionally `styles.css`), plus a git
repo the host keeps for you. It has two slots. **DEV** is yours: every save rebuilds it within a second, you check it with curl
and screenshots, nobody in the chat can see it. **PROD** is what the chat uses, and it changes only when you run `atelier deploy
<slug> -m "<what changed, one line>"`. A new app does not exist for the chat until its first green deploy. A save that does not
build changes nothing anywhere; a deploy that goes red deploys nothing. An app belongs to its chat and only its chat.

**Order of work (build → check → deploy → tell):** `mkdir -p /work/apps/<slug>`, write `backend.js` and `frontend.jsx`, then
`module.json` LAST — it is the switch that makes the folder an app; written first, every save in between fails "file missing".
Then ONE Bash call with every curl check against DEV, then `atelier deploy`, then answer the chat. Write files with the
Write/Edit tools; do not copy `apps/hello` (a copied `.instance` file is refused). The slug is the URL: a lowercase DNS label.

## module.json — the folder is not an app until this exists

```json
{ "name": "Shopping list", "icon": "shopping-cart", "deploy": "node migrate.js", "test": "node test.js",
  "smoke": "curl -sf --unix-socket \"$ATELIER_SOCK\" \"$BASE_URL/items\" >/dev/null", "healthz": "/items" }
```

`name` (rail label) and `icon` (a lucide name: `timer`, `list-checks`, `bar-chart-3`) are required; `group` (rail section),
`primary` (the landing app), `color` are optional. Four release keys, optional, run by the deploy alone (§ Deploy): `deploy` — sh,
migrations, ≤ 60 s; `test` — sh, ≤ 60 s; `smoke` — sh against the rehearsal worker, ≤ 30 s (`$ATELIER_SOCK` its Unix socket,
`$BASE_URL` its API base); `healthz` — a mount-relative GET path answering < 500 (default `/`). No other keys — the rest is dropped.

## backend.js — routes, relative to the app's mount

```js
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
  },
}
```

- Paths are **relative**; the host mounts them at `/api/<company>/<slug>` — never write that prefix. Router:
  `get/post/put/patch/delete/options/all(pattern, handler)`; patterns: exact, `:param`, trailing `/*` (rest in
  `req.params['*']`), bare `/`. First registered match wins — specific before wildcard.
- `req.params`, `req.query`, `await req.json()`, `req.user` = `{ id, name }` of the caller (trusted — the host set it);
  `res.json(data, status = 200)`; or the raw Node `res` for anything else (streams, SSE, files).
- `ctx` (frozen): `id`, `workspace` (the company), `qualifiedId`, `baseUrl` (the app's public API URL), `host` and `port` (the
  PUBLIC origin — for composing URLs, never something to bind), `dataDir` (a private, persistent folder for this app's files —
  keep state there: a JSON file, or SQLite via `node:sqlite`; DEV and PROD get DIFFERENT folders), `log(...)`, `broadcast(event)`.
- Module-level variables are lost on every save and every deploy; persist in `ctx.dataDir`, load lazily. `mountRoutes` must
  only register routes; heavy or failing work belongs inside handlers. It may return a teardown function (timers, watchers).
- **npm packages:** `npm install <pkg>` inside the app folder (its own `package.json` + `package-lock.json` — the deploy
  installs PROD from the lockfile), then `const require = createRequire(import.meta.url); const x = require('<pkg>')`
  (`import { createRequire } from 'node:module'`). A static `import x from '<pkg>'` is refused. Prefer `node:` builtins.
- Never `listen()` — the host is the only door; a port would be unreachable. A pure-frontend app still ships `backend.js`:
  `export default { mountRoutes() {} }`.

## frontend.jsx — global React, classic JSX

```jsx
import { Heading, Text, Button, Input } from '@atelier/kit'   // the chrome's primitives — the ONLY bare import allowed
const { useState, useEffect } = React                          // React is a global; NEVER `import React`
const self = window.__atelier.self(import.meta.url)            // { api, qid, subscribe, ... } — never a literal /api path
export default function Module() {
  const [items, setItems] = useState([])
  const load = () => fetch(self.api + '/items').then(r => r.json()).then(setItems)
  useEffect(() => { load(); return self.subscribe(frame => { if (frame.type === 'changed') load() }) }, [])
  return <div className="flex flex-col gap-3">…</div>
}
```

- **Classic** JSX transform against the global `React`: `import React from 'react'` breaks the app, so does any `react-dom`
  import; hooks `const { useState } = React`. Browser imports: relative files (`./util.js`) and `@atelier/kit` only — no npm.
- Kit (the whole prop sheet; its source is not on this computer): `Button` (`color="blue|red|green|amber|zinc|…"`, `outline`,
  `plain`, `disabled`, `onClick`, `href`) · `Badge` (`color`) · `Input` / `Textarea` / `Select` (native props) · `Switch`
  (`checked onChange color`) · `Field` > `Label` + control · `Heading`, `Subheading`, `Text`, `Strong`, `Code`, `Divider`, `Link`
  (`href`) · `Table, TableHead, TableBody, TableRow, TableHeader, TableCell` · `Dialog` (`open onClose size`) + `DialogTitle,
  DialogBody, DialogActions`. All take `className`; Tailwind utilities work. `styles.css` (optional): plain CSS, your own classes.
- `self.api` is the app's API base; `self.subscribe(handler)` receives every `ctx.broadcast` frame (returns an unsubscribe fn —
  return it from `useEffect`). Fetch a snapshot first, then keep in sync. `self.qid` = `<company>/<slug>`. Must `export default`
  one component that renders once with empty state before any fetch resolves. Sub-routes only through `const { path, navigate }
  = window.__atelier.useRoute()`; no `history.*`, no `<a href="/...">` to other apps.

## Check every save — DEV, and only you

`T=$(cat /run/atelier/session/dev.token)`; the dev shell is `http://127.0.0.1:1844`, every request carries `?token=$T`, and
everything it serves is the DEV slot. After the last save of a batch, in ONE Bash call:

```sh
curl -s "127.0.0.1:1844/_atelier/apps?token=$T" | jq -c '.[]|select(.slug=="<slug>")'   # {instance, company, state, dev_rev, prod_rev, deployed_rev, prod_state, …}
curl -s "127.0.0.1:1844/api/<company>/<slug>/items?token=$T"                              # your DEV backend
curl -s -X POST "127.0.0.1:1844/api/<company>/<slug>/items?token=$T" -H 'content-type: application/json' -d '{"text":"milk"}'
curl -s "127.0.0.1:1844/_atelier/events?app=<instance>&token=$T"                          # the app's recent errors, newest last
```

`state: "live"` with a `dev_rev` that moved = the save built. A save that does not build reaches you as an app-error whose
message starts with `dev:` — nobody else saw it; fix and save again:

```
app-error <slug> rev <N> build at <at>
<file>:<line>:<col> dev: <message>
fix: <file>:<line>:<col> <message> — <fix>
```

Screenshot the DEV document with horse-browser at `http://127.0.0.1:1844/<company>/<slug>?token=$T` — your screenshot is the
preview. Act as a second person with `-H 'x-atelier-user: u2' -H 'x-atelier-name: Bea'`. Delete test data after. No servers.

**Data.** `ctx.dataDir` differs for DEV and PROD. Dev starts empty; for a realistic test copy prod → dev once (never the
reverse), while the dev worker is not mid-request: `cp -a /work/.atelier/data/<instance>/. /work/.atelier/data-dev/<instance>/`.
The host wrote `.gitignore` (`data/`, `.env`, `.env.*`, `node_modules/`) — keep no state under the app folder; secrets never
enter git (`.env` is ignored; configuration is the operator's, set per app in the portal).

## Deploy — the chat sees it

`atelier deploy <slug> -m "<what changed, one line>"` commits your DEV tree (the message is the commit message), REHEARSES the
commit against a copy of prod's data — export, install from the lockfile, build, the `deploy` hook, boot, probe (`healthz`),
`test`, `smoke` — and only when everything is green gates the app's routes (requests wait ≤ 10 s, none are lost), backs prod's
data up, runs the hook on prod's data, starts the new worker, probes it and releases (≤ 4 min; the steps stream as they
run). It ends with ONE line — read it, then tell the chat what changed:

- `deploy green: <slug> rev <N> commit <c12> live — <url>` — the chat has this version now (exit 0).
- `deploy RED at <step>: <error> — nothing deployed, <slug> stays on rev <N> (<c12>)` — the rehearsal failed at that step; prod
  and its data are untouched. Fix and deploy again (exit 2). The chat's record gets an app-error `rehearsal red at <step>: …`.
- `deploy FAILED at <step>: <error> — <slug> is DOWN, backup <id> kept` — rare: the rehearsal passed but prod did not come up.
  The app answers 503 `{"error":"app down after a failed deploy","backup":"<id>"}` until you act; nothing is restored for
  you. Fix forward and deploy again, or `atelier restore <slug> <id>` (below). Tell the chat at once (exit 3).

Green sends no message to the chat; you do. A new app is invisible until its first green deploy — do not announce it before.
`atelier deploy` while one is running answers `deploy in progress` — wait for the verdict, never run two.

- `atelier releases <slug>` — one line per release, newest first: `<at>  <kind> <verdict> rev <N>  <c12>  "<message>"`;
  `atelier backups <slug>` — the pre-migration snapshots the deploys kept (last 3, ≤ 1 GiB): `<id>  <MB> MB  rev <N>  <at>`.
- `atelier rollback <slug> <commit>` — deploy an earlier commit (7–40 hex from the releases list): the same rehearsal and
  gate, no hook, data untouched. Ends `rollback green: <slug> rev <N> commit <c12> live — <url>` or `rollback RED …`.
- `atelier restore <slug> <backup-id>` — replaces prod's data with that snapshot under the gate; code stays. Ends `restore
  green: <slug> rev <N> data from backup <id> live — <url>`. Everything written since the backup is gone — say so first.

## Migrations — the `deploy` hook (forward-only, expand/contract)

The hook runs twice per deploy: on the rehearsal COPY, then on prod's data — worker uid, cwd = the exported commit, `DATA_DIR`
= the data folder, config on stdin, ≤ 60 s. It must be **idempotent and additive**: create what is missing (tables, columns,
files, backfills), never drop, rename or rewrite in place. Reads switch to the new shape in the deploy AFTER the one that added
it; drops come two deploys later. A rollback runs NO hook and touches no data — the old code must still find data it understands.

    import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.env.DATA_DIR + '/app.db')   // migrate.js
    db.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, text TEXT, by TEXT)')
    try { db.exec('ALTER TABLE items ADD COLUMN done INTEGER DEFAULT 0') } catch (e) { if (!/duplicate column/.test(e.message)) throw e }

## Do not

`import React` / `from 'react'` · a literal `/api/<slug>` path · a static `import` of an npm package in backend.js · `listen()` ·
a missing `module.json` · state in module-level variables · module.json keys beyond the nine above · announcing an app before its
first green deploy · a hook that drops, renames or rewrites data · `git push`, deleting `.git`, committing `.env` or `data/` ·
copying dev data over prod · a second `atelier deploy` while one runs.
