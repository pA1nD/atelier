// shell/presence.mjs — the rows a person may see. PLAN §4.1: an app is openable by the people of
// its chat, and a company member outside the app's chat gets the same 404 as a stranger — so the
// document's module list and the rail (`company:<c>` snapshot) name no app the person cannot open
// (review 2026-08-30: before step 5 no company origin carried chat apps, so an unfiltered rail was
// inert; a multi-chat company's rail would otherwise list every room's work to every member).
// `registry.present` is per instance and cached by the provider; one call per row.
export async function visibleRows(registry, personId, rows) {
  const keep = await Promise.all(rows.map((r) => registry.present(personId, r.instance)))
  return rows.filter((_, i) => keep[i])
}
