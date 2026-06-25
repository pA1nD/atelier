// Minimal chrome fixture — claims the chrome slot via meta.chrome and renders
// the active module's element. Just enough to characterize chrome resolution.
export const meta = { isChrome: true, hidden: true, name: 'skin' }
export function chrome({ active }) {
  return active?.element ?? null
}
