// Pins a chrome that isn't mounted → falls back to the default (alpha).
export const meta = { name: 'Broken', chrome: 'ghost' }
export default function Module() {
  return <div className="p-8">broken</div>
}
