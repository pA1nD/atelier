// A second, non-default chrome — selectable by a module via meta.chrome: 'beta'.
export const meta = { isChrome: true, hidden: true, name: 'beta' }
export function chrome({ active }) {
  return active?.element ?? null
}
