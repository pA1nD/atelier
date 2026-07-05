#!/usr/bin/env node
/* Atelier bin — dispatches the one subcommand, `add` (the module installer);
 * anything else is the server exactly as before: `atelier` (host mode),
 * `atelier <id>` / `atelier <ws>/<id>` (standalone).
 *
 * NOTE: this makes `add` a reserved word for standalone mode — a module
 * literally named "add" can still be run with `node server.js add`.
 */
if (process.argv[2] === 'add') {
  process.argv.splice(2, 1);   // add.js reads <spec> and flags from argv[2…]
  await import('./add.js');
} else {
  await import('./server.js');
}
