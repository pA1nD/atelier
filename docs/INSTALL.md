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

One command each way, no infrastructure — `--serve` hosts the collection's git repo over plain http (git's dumb protocol) on port **8787** by default (`--port <n>` to change), so the `add` is a real `git clone`. The coworker gets the app **themed and working**: the chrome traveled with it, and because a collection is a channel, they're now subscribed.

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

`update` reasons from the provenance `add` recorded (which cut you installed), so it knows whether you've edited a module since. (`package-lock.json` is machine-owned — npm rewrites it during the staged install — so it never counts as a local edit; a landing always carries the published cut's lockfile.) Untouched modules swap to the new cut silently (build-gated, atomically — live `data/` and `.env*` always survive). Edited modules are **your** call: interactively you're asked — merge (your edits stay on top), overwrite, skip, or show the edits first — and `--merge` / `--overwrite` decide without a prompt. Real conflicts are never auto-resolved and never leave markers in a running module; the half-merged tree is staged next to it instead, ready to hand to your agent:

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

## Example 4 — two people, one collection: contributing back

The full loop, where everything above meets. You and a coworker both subscribe to your team's collection with push rights; you improve kanban while they improve crm.

```console
# ── you — improve kanban, then cut it into the team collection ───
$ …edit kanban…
$ npx atelier package kanban --to studio
  ✓ kanban 1.4.0
  ✓ packaged  →  _collections/studio/  (commit 9c41f02)
```

That cut landed in **your mirror's local branch — the outbox**. Nothing is published yet; the team hasn't seen it. Meanwhile your coworker publishes their crm cut first. Note what does *not* happen to you:

```console
$ npx atelier update studio
  pulled: studio   (bebf969..40aa1c7)
  · studio: 1 unpublished local cut on the mirror — receiving from the published channel; npx atelier publish studio when ready
  ✓ global/crm 2.1.0 → 2.2.0   (no local edits)
  · global/kanban up to date
```

A full outbox never blocks the channel: you received their crm cut normally, your kanban work sat untouched, and the note reminds you there's something waiting to ship. Now ship it:

```console
$ npx atelier publish studio
  ✗ upstream moved while this mirror holds 1 unpublished local cut — push rejected.

  Nothing is lost and nothing needs merging here: a cut is regenerated from
  your working tree in one command. The path is realign → recut → publish:

    1. realign the mirror to the published channel   (offered below — your
       local cuts stay recoverable under refs/atelier/discarded/)
    2. only if others changed a module you also changed:
         npx atelier update studio --merge
    3. npx atelier package kanban --to studio
    4. npx atelier publish studio

  realign now? (non-destructive — cuts kept under refs/atelier/discarded/) [Y/n] y
  ✓ realigned to the published channel — your cuts are kept at refs/atelier/discarded/…

$ npx atelier package kanban --to studio
$ npx atelier publish studio
  ✓ pushed _collections/studio  →  git@github.com:acme/studio.git
```

Step 2 was skippable here — they touched crm, you touched kanban. Had you both changed the *same* module, `update studio --merge` would have brought their cut into your working tree first (the staged, verified merge from Example 2 — conflicts hand off to your agent, never auto-picked), and your recut would then contain both. That's the one rule that keeps team collections simple: **merges happen in working trees; a collection only ever receives finished, build-gated snapshots.** Your coworker's next `update studio` picks up kanban 1.4.0, both sides converge, and nobody ever ran a raw git command.

## Where `add` can point

| Source | What it is |
|---|---|
| `github:owner/repo` | a public GitHub repo, cloned anonymously over https |
| `git+ssh://…`, `git@host:…`, `https://….git` | any git remote — **private collections** ride your own ssh keys / credential helper |
| `http://host:port/<name>` | a served collection (`atelier publish --serve`, port `8787` unless `--port` was passed) — or any static host serving a collection's repo via git's dumb protocol |
| `./path`, `~/path`, `/abs/path` | a collection folder on disk or a shared drive (cloned, so it's still a channel) |
| `something.bundle` | a single-file collection (`atelier publish --bundle`) — AirDrop it, USB it, chat it; cloning from it keeps full history |

Bare words (`studio`, `studio/crm`) are never sources — they name your subscriptions under `_collections/`.

## What travels, what doesn't

- **Never on the wire:** `node_modules/` (the consumer's `npm install` rebuilds it — `add` runs it for them), the module's own `.git`, `.env*` (secrets stay home), and `.atelier` (see below).
- **`data/` is runtime state.** It ships only when a cut says `--data` (point-in-time content, placed on first install); a `--force` reinstall always keeps the live `data/`.
- **Where installs land:** by default, in the instance folder (or `$<ws>/` with `--workspace`). Set `installPath` in `atelier.config.json` — `{ "installPath": { "modules": "~/work/modules", "chromes": "~/work/chromes" } }` — and `add` places new working copies there instead (chromes separately: many operators keep them in a different repo, under different agent rules, so an agent hammering on an app can't restyle the chrome). External installs are path-mounted into the config automatically (live, no restart), `update` upgrades them in place wherever they live, and modules that already exist somewhere else are never relocated — the paths only route *new* installs.
- **Provenance:** `add` writes a small `.atelier` file into each installed module — which collection, which mirror commit. That's the merge base `atelier update` reasons from, and it's stripped from any cut you package onward.
- **System needs:** if a module declares an `atelier` block (below), `add` checks and reports what's missing; `--yes` also runs the author's install hints.

## Under the hood: the mirror, the channel, and `.atelier`

Three small mechanisms carry everything above — knowing them makes the system predictable instead of magical:

**The mirror.** A subscription is a full `git clone` under `_collections/<name>/`. The history is the point: it's what makes updates incremental, merge bases real, and offline installs possible.

**The channel vs. the outbox.** What you *receive* is the **published channel** — the mirror's `origin/HEAD`. What you *contribute* stacks up as ordinary commits on the mirror's local branch: your **outbox** (`package --to <subscribed collection>` writes there; `publish` pushes it). Reception reads the channel ref exclusively — installs, update baselines, and provenance all come from it — so a full outbox never blocks incoming cuts, and your unpublished work can never be mistaken for upstream's baseline. When someone publishes before you, your push is rejected and `publish` walks you through realign → recut → publish; realigning is **non-destructive** (discarded cuts stay recoverable under `refs/atelier/discarded/`), and since every cut is regenerated from your working tree in one command, nothing of value ever lives *only* in the mirror.

**`.atelier` — the membership card.** `add` writes a small JSON file into each installed module: which collection it came from, and the **published** commit it was installed from. That commit is the merge base `update` reasons from — "you've edited 3 files" is a diff against it, and updates merge upstream's changes *onto* yours instead of over them. Because it only ever references published commits, nothing you do to your mirror's local branch can invalidate it. It never travels (`package` strips it from every cut), and deleting it simply disconnects the module from its channel — a module without one is just a folder, and everything except `update` treats it exactly the same. If upstream ever rewrites history out from under a pointer, `update` says so loudly and offers `--overwrite` or resubscribing — never a silent guess.

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
