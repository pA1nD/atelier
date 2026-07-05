# Install

Two commands cover everything: **`npm create @pa1nd/atelier`** gives you a running atelier, and **`npx atelier add`** installs modules into it. You need **Node 24 or newer**.

## Create an instance

```sh
npm create @pa1nd/atelier my-studio                          # a fresh, empty instance
npm create @pa1nd/atelier my-studio -- --kit <owner/repo>    # …or preloaded with a starter kit
cd my-studio && npm install
npm run dev                                                  # → http://localhost:1844
```

> The first `--` hands everything after it to the scaffolder instead of npm.

Your instance is a plain folder: a `package.json` that depends on the shell, an `atelier.config.json` for settings, and nothing else — the folder is yours. The shell updates like any dependency — `npm update @pa1nd/atelier`.

| Option | What it does |
|---|---|
| `--kit <owner/repo>` | Start with a whole kit: every module in that repo, theme included. |
| `--chrome <spec>` | Start with just a theme. |
| `--add <spec>` | Start with one extra module (repeat as you like). |

A `<spec>` — here and in `atelier add` — is any of:

| `<spec>` | What you get |
|---|---|
| `kanban` | a module folder, by name. Here: from the kit repo. In `atelier add`: searched across **all** your registered marketplaces — one match installs, several stop and ask you to pick with `--from` |
| `@scope/kanban` | an npm package |
| `github:user/repo` | a git repo that is one module |
| `https://…/kanban.tgz` | a tarball url |
| `../kanban` | a local folder |

Whatever a `<spec>` resolves to must be **one module folder** — a folder with a `frontend.jsx` and/or `backend.js` at its top level (the [module shape](./MODULES.md#module-convention)); anything else is refused. A **chrome is just a module too**, so it installs the same way. A whole *repo of* modules is not a `<spec>` — that's a marketplace: register it with `--marketplace` and pull its modules by name.

## Install modules

Modules come from **marketplaces** — and a marketplace is simply a public GitHub repo whose folders are modules. Register one, see what it offers, pick by name:

```sh
npx atelier add --marketplace bigcorp/modules     # register — installs nothing
npx atelier add --list                            # what your marketplaces offer (✓ = installed)
npx atelier add kanban                            # install one module by name
```

`add` copies the module into your instance, installs its dependencies, and it's live on the next page load — no restart.

Modules don't have to come from a marketplace, though — `add` takes anything npm can fetch:

```sh
npx atelier add kanban --from bigcorp/modules     # one-off from a repo, without registering it
npx atelier add @scope/kanban                     # an npm package
npx atelier add github:someone/kanban             # a git repo
npx atelier add ../kanban --workspace acme        # a local folder, into $acme/
```

Along the way, `add` looks after you:

- **It never overwrites your edits.** An installed module is yours. If the folder already exists, `add` stops; `--force` replaces the code but keeps the module's `data/`.
- **Failures are loud.** If the module's dependencies don't install, you get the full error and the exact command to retry — nothing is swallowed.
- **It tells you what's missing.** Some modules need things a folder can't carry — a CLI like `ffmpeg`, an API key. If a module declares such needs, `add` checks and prints what's missing with the install command for each; add `--yes` to run those commands for you.
- **Nothing is picked silently.** If a name exists in more than one of your marketplaces, `add` stops and shows you the `--from` commands to choose between them.

Two footnotes: anything that isn't a bare name is fetched with npm, so a local folder or git repo needs a `name` and `version` in its `package.json`. And scaffolding with `--kit` registers the kit repo as a marketplace for you — so when that repo gains new modules later, they're one `add` away.

## Shipping your own modules

Publishing is as plain as installing:

- **Push module folders to a public GitHub repo.** That's a marketplace.
- **A module ships everything it needs**: its npm dependencies in its own `package.json`, and anything the folder can't carry declared in an `atelier` field so installers can check for it:

  ```json
  "atelier": {
    "os": ["darwin"],
    "bins": { "ffmpeg": "brew install ffmpeg" },
    "env": ["SOME_API_KEY"],
    "note": "video previews need ffmpeg; without it the module falls back to stills"
  }
  ```

- **Keep `data/` out of the repo** — it's runtime state, and installers preserve it across reinstalls.
- **Don't crash on a missing need** — degrade gracefully, and say what's missing in your module's UI.

For the full module-authoring contract (`ctx`, real-time, hot reload, chromes), see [Modules](./MODULES.md).
