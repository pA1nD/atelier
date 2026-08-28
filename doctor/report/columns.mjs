// doctor/report/columns.mjs — the portability table's columns (DESIGN §5).
// The seed's header (spike-migration-local-1/out/portability.csv) is preserved verbatim and in order —
// 5 identity fields + 32 rule columns = 37 — so the 58 × 33 spreadsheet keeps every column where it was.
// New columns are appended after `M4`, never inserted.

export const SEED_HEADER = 'module,daily,dynamic_state,meta_literal,tw_cold_max_ms,D1,D2,D2w,D3,D4,D5,D6,D7,D8,D9,D10,D11,D12,D13,N1,N2,N2op,N3,N4,N5,N6,N7,N8,I1,I2,I3,I4,I5,M1,M2,M3,M4'

export const SEED_COLUMNS = Object.freeze(SEED_HEADER.split(','))
export const IDENTITY_COLUMNS = Object.freeze(SEED_COLUMNS.slice(0, 5))
export const SEED_RULE_IDS = Object.freeze(SEED_COLUMNS.slice(5))

/** Appended after `M4`: rule cells first (N1mix, N9–N11, R1–R3), then probe/tailwind facts, then the verdict. */
export const NEW_RULE_IDS = Object.freeze(['N1mix', 'N9', 'N10', 'N11', 'R1', 'R2', 'R3'])
export const NEW_FACT_COLUMNS = Object.freeze(['long_lines', 'resident', 'teardown', 'killed', 'config_keys', 'operator_keys', 'verdict'])
export const NEW_COLUMNS = Object.freeze([...NEW_RULE_IDS, ...NEW_FACT_COLUMNS])

export const COLUMNS = Object.freeze([...SEED_COLUMNS, ...NEW_COLUMNS])
export const HEADER = COLUMNS.join(',')

/** Every rule id that has a CSV cell, seed ids first (the order rows.md lists them in). */
export const RULE_COLUMN_IDS = Object.freeze([...SEED_RULE_IDS, ...NEW_RULE_IDS])
