// Build-pipeline characterization — locks getJsx/getCss BEFORE Phase 1 splits
// atelier.js into build.js. If the compiled output shape changes during the
// split, these break.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getJsx, getCss } from '../build.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ATELIER_DIR = path.resolve(HERE, '..')
const ALPHA = path.join(HERE, 'fixtures', 'ws-basic', 'alpha', 'frontend.jsx')

test('getJsx transforms JSX to ESM with the React.createElement factory', async () => {
  const out = await getJsx(ALPHA)
  assert.match(out.content, /React\.createElement/)
  assert.match(out.contentType, /javascript/)
})

test('getCss compiles Tailwind from a stylesheet + scan sources', async () => {
  const css = path.join(HERE, 'fixtures', 'tw.css')
  const out = await getCss(css, [ALPHA], ATELIER_DIR)
  assert.match(out.contentType, /text\/css/)
  assert.ok(out.content.length > 0, 'expected non-empty compiled CSS')
})
