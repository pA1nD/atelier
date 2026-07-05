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

## Install modules

```sh
npx atelier add kanban                            # by name, from your marketplaces
npx atelier add kanban --from bigcorp/modules     # by name, from a specific repo
npx atelier add @scope/kanban                     # an npm package
npx atelier add github:someone/kanban             # a git repo
npx atelier add ../kanban --workspace acme        # a local folder, into $acme/
```

`add` copies the module into your instance, installs its dependencies, and it's live on the next page load — no restart. Along the way it looks after you:

- **It never overwrites your edits.** An installed module is yours. If the folder already exists, `add` stops; `--force` replaces the code but keeps the module's `data/`.
- **Failures are loud.** If the module's dependencies don't install, you get the full error and the exact command to retry — nothing is swallowed.
- **It tells you what's missing.** Some modules need things a folder can't carry — a CLI like `ffmpeg`, an API key. If a module declares such needs, `add` checks and prints what's missing with the install command for each; add `--yes` to run those commands for you.

One thing to know: anything that isn't a bare name is fetched with npm, so a local folder or git repo needs a `name` and `version` in its `package.json`.

## Marketplaces

A marketplace is simply a **public GitHub repo whose folders are modules** — and you don't need to install any of it to use it. Register it, browse it, pick what you want:

```sh
npx atelier add --marketplace bigcorp/modules     # register — installs nothing
npx atelier add --list                            # see what your marketplaces offer
npx atelier add kanban                            # pick one module by name
```

If the same name exists in more than one of your marketplaces, `add` stops and asks you to choose with `--from` — nothing is picked silently.

Two related conveniences: `--from <owner/repo>` installs from a repo without registering it, and scaffolding with `--kit` registers the kit repo for you — so when that repo gains new modules later, they're one `add` away.

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
