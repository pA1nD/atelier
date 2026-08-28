// The sqlite-writing app of DESIGN §8.2 row 5 / PLAN §10 item 1: node:sqlite in rollback mode with
// locking_mode=EXCLUSIVE, so the worker holds the file lock from its first write until it closes —
// the harshest shape of the flights-class module (g4: "mountRoutes threw: database is locked").
// The new worker's mount writes at once: while the old worker is alive that throws SQLITE_BUSY.
import { DatabaseSync } from 'node:sqlite'
export default {
  mountRoutes(router, ctx) {
    const db = new DatabaseSync(ctx.dataDir + '/locker.sqlite')
    db.exec('PRAGMA locking_mode=EXCLUSIVE')
    db.exec('CREATE TABLE IF NOT EXISTS t (n INTEGER)')
    db.exec('INSERT INTO t VALUES (1)')
    const iv = setInterval(() => { try { db.exec('INSERT INTO t VALUES (2)') } catch {} }, 50)
    router.get('/count', (req, res) => res.json({ count: db.prepare('SELECT count(*) AS c FROM t').get().c, pid: process.pid }))
    return () => { clearInterval(iv); db.close() }
  },
}
