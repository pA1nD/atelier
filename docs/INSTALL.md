# Install

Two commands cover everything: **`npm create @pa1nd/atelier`** gives you a running atelier, and the **collection verbs** move modules between instances. You need **Node 24 or newer** and **git**.

## Create an instance

```sh
npm create @pa1nd/atelier my-studio                          # a fresh, empty instance
npm create @pa1nd/atelier my-studio -- --kit <owner/repo>    # …or preloaded with a starter collection
cd my-studio && npm install
npm run dev                                                  # → http://localhost:1844
```

> The first `--` hands everything after it to the scaffolder instead of npm.

Your instance is a plain folder: a `package.json` that depends on the shell, an `atelier.config.json` for settings, and nothing else — the folder is yours. The shell updates like any dependency — `npm update @pa1nd/atelier`. A starter kit is just a collection consumed at scaffold time; the scaffolder's options are documented at [create-atelier](https://github.com/pA1nD/create-atelier).

## Collections — the one shareable thing

Atelier shares exactly one shape: a **collection** — a git repo whose top-level folders are modules. `atelier package` produces them; nothing else is shareable through the tool. That single norm is what makes the rest simple: every collection is a **channel** (subscribe once, new cuts are one command away), everything that arrives carries its git history, and every transport — GitHub, your LAN, a file over chat — moves the identical thing.

| Verb | What it does |
|---|---|
| `atelier package <module> [--to <collection>] [--data]` | cut a **verified** snapshot of a module into a collection (default: a collection named after the module). The cut only lands if the module builds. |
| `atelier publish <collection> [--to <git-url> \| --serve \| --bundle]` | move the collection somewhere: push it, host it on your network, or write it to a single file. Publishes **cuts**, never your working tree. |
| `atelier add <source \| collection[/module]>` | subscribe to a collection (a scheme-prefixed source → `git clone`) and install its modules — or install what you're missing from one you already follow. |
| `atelier update [<collection>[/<module>]] [--merge \| --overwrite]` | pull the channel and upgrade **installed** modules to newer cuts — merge-aware: your local edits ride on top; real conflicts are staged for your agent, never dumped into the running module. |
| `atelier list` | your collections and what they offer (✓ = installed). |

Two grammar rules worth internalizing: **sources wear schemes, names never do** (`github:acme/studio` is a place; `studio` is a subscription you already have — the same command means the same thing on every machine), and **`add` only ever creates** (an installed module is yours; `add` skips it, `--force` replaces it, its `data/` survives either way).

## Example 1 — share a working app with a coworker on your network

```console
# ── you ──────────────────────────────────────────────────────────
$ npx atelier package kanban
  kanban pins chrome "my-chrome" — include it in the collection? [Y/n] y
  ✓ packaged: kanban 1.0.0 + my-chrome 0.3.0  →  _collections/kanban/  (commit 33e4cc2)

$ npx atelier publish kanban --serve
  serving _collections/kanban/ read-only (committed cuts only) — ctrl-c to stop
    atelier add http://studio.local:8787/kanban

# ── your coworker ────────────────────────────────────────────────
$ npx atelier add http://studio.local:8787/kanban
  subscribed: kanban   (cloned → _collections/kanban/)
  installed: global/kanban  ←  kanban
  installed: global/my-chrome  ←  kanban
  ✓ 2 modules installed — a running instance mounts them on the next request.
```

One command each way, no infrastructure — `--serve` hosts the collection's git repo over plain http (git's dumb protocol), so the `add` is a real `git clone`. The coworker gets the app **themed and working**: the chrome traveled with it, and because a collection is a channel, they're now subscribed.

## Example 2 — the working tree is a mess; distribution doesn't care

```console
# agents are mid-refactor and backend.js is currently broken. try anyway:
$ npx atelier package kanban
  ✗ kanban failed the build gate — NOT cut. The collection is unchanged.
  Build failed with 1 error:
  kanban/backend.js:2:0: ERROR: Unexpected end of file

# fix lands, cut again:
$ npx atelier package kanban
  ✓ packaged: kanban 1.1.0 + my-chrome 0.3.0  →  _collections/kanban/  (commit 287bd07)
```

That refusal is the whole philosophy in two lines: **your working tree is never on the wire — only moments you proved good.** The collection keeps serving the last good cut while you work; publish whenever, cut only when it builds.

On the other side, catching up is one command — `add` installs what's new, `update` upgrades what's installed:

```console
$ npx atelier update kanban
  pulled: kanban   (33e4cc2..287bd07)
  ✓ global/kanban 1.0.0 → 1.1.0   (no local edits)
  · global/my-chrome up to date
```

`update` reasons from the provenance `add` recorded (which cut you installed), so it knows whether you've edited a module since. Untouched modules swap to the new cut silently (build-gated, atomically — live `data/` and `.env*` always survive). Edited modules are **your** call: interactively you're asked — merge (your edits stay on top), overwrite, skip, or show the edits first — and `--merge` / `--overwrite` decide without a prompt. Real conflicts are never auto-resolved and never leave markers in a running module; the half-merged tree is staged next to it instead, ready to hand to your agent:

```console
$ npx atelier update kanban --merge
  pulled: kanban   (287bd07..aa9d299)
  → staged: kanban/.update-merge   (your module is untouched, still running the old version)
    conflicts in: frontend.jsx
    have your agent resolve it:
      claude "resolve the merge conflicts in …/kanban/.update-merge, then run: atelier update kanban/kanban --continue"
    or discard it:  atelier update kanban/kanban --abort
```

`--continue` refuses leftover conflict markers, re-runs the build gate, and only then swaps the merge in. Without a terminal (an agent driving `update`), edited modules are skipped and reported — the merge-or-discard decision is never made on your behalf.

## Example 3 — a kit: many modules, one collection

A collection with several modules *is* a kit — cut each module into the same collection, publish once:

```console
# ── you ──────────────────────────────────────────────────────────
$ npx atelier package kanban --to studio
  kanban pins chrome "my-chrome" — include it in the collection? [Y/n] y
  ✓ packaged: kanban 1.1.0 + my-chrome 0.3.0  →  _collections/studio/  (commit 4f09a11)
$ npx atelier package crm --to studio
$ npx atelier package reports --to studio --data     # --data: its content ships too
$ npx atelier publish studio --to github:acme/studio
  ✓ pushed _collections/studio  →  git@github.com:acme/studio.git
    others install it with:  atelier add github:acme/studio

# ── your coworker — the whole kit, under a local name of their choosing ──
$ npx atelier add github:acme/studio --as acme
  subscribed: acme   (cloned → _collections/acme/)
  installed: global/kanban  ←  acme
  installed: global/my-chrome  ←  acme
  installed: global/crm  ←  acme
  installed: global/reports  ←  acme
  ✓ 4 modules installed — a running instance mounts them on the next request.

$ npx atelier add acme/crm        # …or cherry-pick a single module instead
$ npx atelier list
  acme   https://github.com/acme/studio.git
    ✓ kanban  (installed)
    ✓ my-chrome  (installed)
    ✓ crm  (installed)
    ✓ reports  (installed)
```

`--as` names the subscription locally (default: the repo's basename) — useful when two sources share a name, or when `studio` means something else on your machine.

## Where `add` can point

| Source | What it is |
|---|---|
| `github:owner/repo` | a public GitHub repo, cloned anonymously over https |
| `git+ssh://…`, `git@host:…`, `https://….git` | any git remote — **private collections** ride your own ssh keys / credential helper |
| `http://host:port/<name>` | a served collection (`atelier publish --serve`) — or any static host serving a collection's repo via git's dumb protocol |
| `./path`, `~/path`, `/abs/path` | a collection folder on disk or a shared drive (cloned, so it's still a channel) |
| `something.bundle` | a single-file collection (`atelier publish --bundle`) — AirDrop it, USB it, chat it; cloning from it keeps full history |

Bare words (`studio`, `studio/crm`) are never sources — they name your subscriptions under `_collections/`.

## What travels, what doesn't

- **Never on the wire:** `node_modules/` (the consumer's `npm install` rebuilds it — `add` runs it for them), the module's own `.git`, `.env*` (secrets stay home), and `.atelier` (see below).
- **`data/` is runtime state.** It ships only when a cut says `--data` (point-in-time content, placed on first install); a `--force` reinstall always keeps the live `data/`.
- **Provenance:** `add` writes a small `.atelier` file into each installed module — which collection, which mirror commit. That's the merge base `atelier update` reasons from, and it's stripped from any cut you package onward.
- **System needs:** if a module declares an `atelier` block (below), `add` checks and reports what's missing; `--yes` also runs the author's install hints.

## Shipping your own modules

Publishing is as plain as installing:

- **`atelier package` it, `atelier publish` it.** That's the whole pipeline — the collection is the artifact, the channel, and (on GitHub) the repo.
- **A module ships everything it needs**: its npm dependencies in its own `package.json`, and anything the folder can't carry declared in an `atelier` field so installers can check for it — and `atelier add --yes` can install it:

  ```json
  "atelier": {
    "os": ["darwin"],
    "bins": { "ffmpeg": "brew install ffmpeg" },
    "env": ["SOME_API_KEY"],
    "note": "video previews need ffmpeg; without it the module falls back to stills"
  }
  ```

- **Bump the version when you cut.** The module's `package.json` version names the cut; `package` warns when content changed but the version didn't.
- **Keep `data/` out of your cuts unless it's the point** — it's runtime state; `--data` is for shipping content deliberately.
- **Don't crash on a missing need** — degrade gracefully, and say what's missing in your module's UI.

For the full module-authoring contract (`ctx`, real-time, hot reload, chromes), see [Modules](./MODULES.md).
