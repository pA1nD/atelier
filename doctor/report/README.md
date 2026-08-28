# `doctor/report/` — lane C: merge, table, verdicts, output files

What this folder does (DESIGN §5, §6): takes lane A's static findings and lane B's probe observations per module,
merges them into `report.json` with every finding carrying its rule's first-class 2.0 answer, computes the CSV
cells, writes the `--out` layout, prints the per-module `DOCTOR …` line and the final `VERDICT:` line.

| file | role |
|---|---|
| `columns.mjs` | the seed's 37-field CSV header verbatim (`SEED_HEADER`) + the new columns appended after `M4` (`N1mix,N9,N10,N11,R1,R2,R3,long_lines,resident,teardown,killed,config_keys,operator_keys,verdict`) |
| `daily.mjs` | the 18 daily ids; row order = daily first (that order), then alphabetical |
| `seed-rules.mjs` | the report-facing rule fields (id, family, title, severity, answer) from DESIGN §2 — the fallback when the loaded catalogue lacks an id; `NODE_NOISE`, `SHELL_KEYS`, `LAPTOP_KEYS`, `IMAGE_BINS` fallbacks |
| `merge.mjs` | `mergeModule(...)` → report.json. Static findings normalised; probe observations → findings through `OBSERVATIONS` (kind → rule, the seed report.mjs lambdas: an egress is N4/N5/I2 — a `unix:~/…` socket D13, never N5 —, an env read N2/N2op/N3/D13 — row-W keys are none —, a write outside dataDir N1/D13, listens D2, spawns D12 (`note` with its own answer for an `IMAGE_BINS` binary, the spawned script named), signals/exit N8; state ≠ mounted → R1, resources → R2, no teardown / killed → R3). Cells: `rule.count(static, probe, tw)` when the catalogue has one, else `static.cells[id]`, else the R1–R3 fallbacks. `configKeys` = names only |
| `verdict.mjs` | `moduleVerdict` (BREAKS = a breaks-in-fleet finding or a broken probe state; DEGRADES; CLEAN) with `answers` (the rules that break/degrade and their first-class answer), the `DOCTOR <module> …` line, `finalVerdict`, `failVerdict` |
| `table.mjs` | rows, `portability.csv`, `rows.md` (`| row | family | break | modules /N | daily /D |`), `modules.md` (with the verdict column), `summary.json` |
| `write.mjs` | `<out>/doctor/<module>/{report.json, module.json, config-keys.json, rewrite/<rel>}`, `<out>/doctor/{portability.csv, rows.md, modules.md, summary.json, verdict.txt}`; `applyWrite` (--write: git work tree, no uncommitted change to the touched files, an existing module.json only replaced when its sole change is the N11 key drop, a `partial` N1 rewrite refused without `--write-partial`); `outInside` |
| `lanes.mjs` | loads lanes A and B by their DESIGN file names; a missing file is replaced by a stub and named on stderr |

`../cli.mjs` is the verb (`atelier doctor …`, one line in `cli.js`): argument parsing, module/corpus resolution,
the per-module pipeline (static → meta → rewrites → probe → merge → write), the table, exit codes
(0 completed, 1 lane crash, 2 usage or a refused `--write`).

## Cross-lane interfaces (what `lanes.mjs` expects; stubbed while the file is absent)

```
rules/catalogue.mjs   RULES: Rule[]  (+ optional NODE_NOISE, IMAGE_BINS, SHELL_KEYS, LAPTOP_KEYS; a rule may add match.runtime(obs, ctx))
rules/walk.mjs        listModules(corpusDir) → [{id, dir, hasFrontend, hasBackend}]
rules/static.mjs      runStatic({id, dir, rules, envKeys}) → {findings:[{rule, severity, file, line, excerpt, answer?, rewrite?}], cells?:{id:n}, files:{source, client, subfolderClient}, env:{KEY: class}}
rules/meta.mjs        readMeta({dir}) → {declared, literal, error, keys, meta, moduleJson, dropped:[{key, rule, reason}]}
rules/env.mjs         classifyEnv(key, envKeys) → 'operator'|'shell-published'|'node'|'laptop'|'config'|'other'
rules/rewrite.mjs     rewriteModule({id, dir}) → [{file, text, edits:[{rule, line, from, to}], partial, leftover:[file:line]}]
probe/run.mjs         probeModule({id, dir, out, name}) → the DESIGN §4 runtime object (or {runtime, tailwind}); files under <out>/doctor/<id>/probe/
```

Stubs return no findings / no meta / state `skipped`; the run then reports the stubbed files on stderr and
`summary.json.stubbedLanes`. The stub `listModules` is the seed's (alphanumeric first character, has
`frontend.jsx` or `backend.js`).

## Tests

`node --test doctor/test/report.test.js doctor/test/merge.test.js doctor/test/cli.test.js` — the header's first
37 fields equal the seed's string, column order, rows.md / modules.md shape, summary keys, the merge on synthetic
static + probe inputs (attribution, severities, R1–R3, cells, config keys, verdict levels and lines), the CLI on
the two fixture modules under `test/fixtures/report-corpus/` (exit 0, writes only under `--out`, refuses `--out`
inside the corpus, refuses `--write` without `--yes-corpus` and on a dirty tree, `--json` is valid JSON, exit 2 on
usage).
