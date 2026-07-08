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
]);
const verb = VERBS.get(process.argv[2]);
if (verb) {
  process.argv.splice(2, 1);   // the verb reads its args from argv[2…]
  await import(verb);
} else {
  await import('./server.js');
}
