# Install

Two commands cover the whole consumer side of atelier: **`npm create @pa1nd/atelier`** turns an empty folder into a running instance, and **`npx atelier add`** installs modules into it. This page documents both — plus the conventions they implement: how modules ship, and what a marketplace is.

## Create an instance — `npm create @pa1nd/atelier`

```sh
npm create @pa1nd/atelier my-studio                          # a tiny, empty instance
npm create @pa1nd/atelier my-studio -- --kit <owner/repo>    # …preloaded with a whole starter kit
cd my-studio && npm install
npm run dev                                                  # → http://localhost:1844
```

> The first `--` is npm's pass-through separator — everything after it goes to the scaffolder instead of being parsed by npm itself. (`npm create vite my-app -- --template react` has the same shape.)

The scaffold is deliberately tiny — an instance is a folder, and this writes exactly four files:

- **`package.json`** — depends on `@pa1nd/atelier` (the shell arrives from npm and runs itself from `node_modules`; update it with `npm update @pa1nd/atelier`), with `dev` / `dev:module` scripts calling the `atelier` bin.
- **`atelier.config.json`** — `label`, `port`; `defaultChrome` when a kit or `--chrome` supplied one; `marketplaces: ["<kit repo>"]` when `--kit` was used, so bare-name `atelier add` works from day one.
- **`.gitignore`**, **`README.md`**.

| Option | Meaning |
|---|---|
| `--kit <owner/repo>` | Pull **every module folder** of a kit repo into the instance (same rule as the shell's discovery: a folder with a `frontend.jsx` or `backend.js`). The kit's chrome — detected via `isChrome: true` — becomes `defaultChrome`. |
| `--chrome <spec>` | One chrome module, set as `defaultChrome`. |
| `--add <spec>` | Any other module (repeatable). |

A bare `<spec>` names one folder of the kit repo; anything else is fetched via `npm pack` (registry name, git url, tarball url, local folder). Node ≥ 24 runs the instance; the scaffolder itself runs on Node ≥ 18 so old setups get a friendly message instead of a crash.

## Install modules — `npx atelier add`

```
npx atelier add <spec> [--from <owner/repo>] [--workspace <ws>] [--force] [--yes]
```

```sh
npx atelier add kanban                            # a folder of the first configured marketplace
npx atelier add kanban --from bigcorp/modules     # …or of a specific repo
npx atelier add @scope/kanban                     # an npm package
npx atelier add github:someone/kanban             # a git repo that is one module
npx atelier add ../kanban --workspace acme        # a local folder, into $acme/
npx atelier add kanban --force                    # replace an existing copy (data/ kept)
```

What one `add` does, in order:

1. **Fetch.** A bare name comes straight off a marketplace repo's folders — resolved against `--from <owner/repo>`, else each entry of `"marketplaces": […]` in `atelier.config.json`, in order. Every *other* spec goes through `npm pack`, which requires a `package.json` with a `name` and `version` in the module (npm's rule, not atelier's).
2. **Copy the folder** into the instance (or `$<ws>/` with `--workspace`) — excluding `node_modules`, `data`, and `.git`. An existing folder is **never overwritten silently**: it may carry local edits, so `add` refuses unless you pass `--force`, which replaces the code but **preserves the module's `data/`**.
3. **Install its npm deps** — `npm install` inside the folder, when its `package.json` declares dependencies. A failure is **loud**: the folder stays put with exact instructions to fix and re-run `npm install` there.
4. **Check its declared system needs** (the `atelier` field, below) and print an **ACTION NEEDED** block for anything missing. The module still installs and runs — degrading gracefully is part of the shipping convention.
5. **Keep the instance's filter honest.** On an allow-mode `modules` filter, the new module is appended to `atelier.config.json` — and since the filter is re-read per request, the install is live with no restart.

`add` has no dependencies of its own: Node's standard library, the npm that invoked it, and the system `tar`.

## Declared system needs — the `atelier` field

Some needs can't ship in a folder — a system CLI, a platform, an API key. A module declares them in its own `package.json` so installers can check them:

```json
"atelier": {
  "os": ["darwin"],
  "bins": { "ffmpeg": "brew install ffmpeg" },
  "env": ["SOME_API_KEY"],
  "note": "video previews need ffmpeg; without it the module falls back to stills"
}
```

Everything is optional and **declarative**. The installer *checks and reports* — missing bins with their author-supplied install hints, unset env vars, an OS mismatch — and never runs anything beyond `npm install` unless asked: **`--yes`** executes the missing bins' hints (the same trust already extended to npm lifecycle scripts) and re-checks honestly afterwards. The scaffolder prints the same report, check-only, for every starter module. The shell itself never reads this field — it's an installer/tooling convention.

## Marketplaces & kits

A **marketplace is just a public github repo whose top-level folders are modules.** The same repo is a **kit** when `npm create --kit` pulls all of it at scaffold time, and a **marketplace** when `atelier add <name>` pulls one folder later. Publishing a module *is* pushing its folder to such a repo.

- Bare-name resolution is configured per instance: `"marketplaces": ["<owner/repo>", …]` in `atelier.config.json`, tried in order. The key is read by tooling only — the server ignores it.
- A repo may carry `.atelier/marketplace.json` — **marketing only** (store name, icon, accent, per-app taglines and screenshots, which don't belong inside module folders). It has no install semantics: the folders are the inventory.

## How modules ship — the convention

For module authors, the contract that makes all of the above work:

- **`<module>/package.json` is the whole dependency manifest.** If it imports a package, it declares it there — no external registry of a module's needs. (In `backend.js`, load deps with `createRequire` — see [Modules → Dependencies](./MODULES.md#dependencies).)
- **`data/` never ships.** It's runtime state; installers skip it on copy and preserve it on reinstall.
- **Degrade gracefully.** A missing system need must not crash the module — fall back, surface what's missing in the module's own UI, and declare it in the `atelier` field so installers can say so up front.
- **Don't assume a chrome.** Pin `meta.chrome` or inline what you borrow — kit exports beyond your target chrome's are not portable.
