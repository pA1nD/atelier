#!/usr/bin/env node
/* Atelier bin — dispatches the collection verbs; anything else is the server
 * exactly as before: `atelier` (host mode), `atelier <id>` / `atelier <ws>/<id>`
 * (standalone).
 *
 *   atelier package <module>      cut a verified snapshot into a collection
 *   atelier publish <collection>  push / serve / bundle a collection
 *   atelier add <source|name>     subscribe to a collection / install from one
 *   atelier update [<name>]       upgrade installed modules to newer cuts
 *   atelier list                  your collections and what they offer
 *   atelier chrome release <dir>  build a chrome release payload (step 7 ship C; chrome.js)
 *
 * NOTE: these verbs are reserved words for standalone mode — a module
 * literally named `add` can still be run with `node server.js add`.
 */
const VERBS = new Map([
  ['add', './add.js'],
  ['update', './update.js'],
  ['package', './package.js'],
  ['publish', './publish.js'],
  ['list', './list.js'],
  ['chrome', './chrome.js'],
  ['doctor', './doctor/cli.mjs'],
]);
const verb = VERBS.get(process.argv[2]);
if (verb) {
  process.argv.splice(2, 1);   // the verb reads its args from argv[2…]
  await import(verb);
} else if (process.argv.slice(2).every((a) => a.startsWith('--')) && process.env.ATELIER_1X !== '1') { await import('./shell/cli-local.mjs');
} else {
  await import('./server.js');
}
