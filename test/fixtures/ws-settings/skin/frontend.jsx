export const meta = { chrome: true, hidden: true, name: 'skin' }
export function chrome({ active }) {
  return active?.element ?? null
}
