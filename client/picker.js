// picker.js — the company picker's navigation (shell/DESIGN.md §4 "picker → portal POST"). The
// picker renders `boot.companies`; picking one is a full page load in both modes:
//   fleet (boot.portal set)   a same-origin-to-the-portal <form method=post action="<portal>/picker">
//                             with the company id — one page load, one tap (PLAN §4.1)
//   local (boot.portal null)  location.assign(row.href) — every workspace as `/<ws>/`
// `pickTarget` is pure; `performPick` touches the document.

export function pickTarget(boot, id) {
  if (!id) return null
  const rows = Array.isArray(boot?.companies) ? boot.companies : []
  const row = rows.find((c) => c && c.id === id) || null
  if (boot?.portal) {
    return { kind: 'post', action: `${String(boot.portal).replace(/\/+$/, '')}/picker`, fields: { company: id } }
  }
  const href = row && row.href ? row.href : `/${encodeURIComponent(id)}/`
  return { kind: 'assign', href }
}

export function performPick(doc, target) {
  if (!target) return false
  if (target.kind === 'assign') { doc.defaultView.location.assign(target.href); return true }
  if (target.kind === 'post') {
    const form = doc.createElement('form')
    form.setAttribute('method', 'post')
    form.setAttribute('action', target.action)
    for (const [k, v] of Object.entries(target.fields || {})) {
      const input = doc.createElement('input')
      input.setAttribute('type', 'hidden')
      input.setAttribute('name', k)
      input.setAttribute('value', String(v))
      form.appendChild(input)
    }
    doc.body.appendChild(form)
    form.submit()
    return true
  }
  return false
}
