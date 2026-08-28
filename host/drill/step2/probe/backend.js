// The drill's probe app — row (c): what a worker sees from inside (uid, groups, env keys, the ctx
// contract) and what it can and cannot touch (its dataDir, the seed/credential paths, PID 1's env,
// a peer's dataDir passed as ?peer=<dir>). A 1.x module: default export { mountRoutes }.
import fs from 'node:fs'
import net from 'node:net'

const tryRead = (p) => { try { fs.readFileSync(p); return 'READ' } catch (e) { return e.code } }
const tryList = (p) => { try { fs.readdirSync(p); return 'LISTED' } catch (e) { return e.code } }
const tryWrite = (p) => { try { fs.writeFileSync(p, 'probe\n'); return 'WROTE' } catch (e) { return e.code } }
const tryConnect = (p) => new Promise((r) => { const s = net.connect(p); s.on('connect', () => { s.destroy(); r('CONNECTED') }); s.on('error', (e) => r(e.code)) })

export default {
  mountRoutes(router, ctx) {
    router.get('/probe', async (req, res) => {
      const peer = req.query.peer
      const run = '/run/atelier'
      res.json({
        uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(), cwd: process.cwd(), umask: process.umask().toString(8),
        envKeys: Object.keys(process.env).sort(), DRILL_CONFIG: process.env.DRILL_CONFIG ?? null,
        ctxKeys: Object.keys(ctx).sort(), frozen: Object.isFrozen(ctx),
        ctx: { id: ctx.id, name: ctx.name, workspace: ctx.workspace, qualifiedId: ctx.qualifiedId, label: ctx.label, port: ctx.port, host: ctx.host, baseUrl: ctx.baseUrl, dataDir: ctx.dataDir },
        user: req.user ?? null,
        dataDir: { write: tryWrite(ctx.dataDir + '/probe.txt'), list: tryList(ctx.dataDir) },
        denied: {
          pid1Environ: tryRead('/proc/1/environ'),
          bootstrapToken: tryRead(run + '/bootstrap.token'), devToken: tryRead(run + '/dev.token'), sessionDevToken: tryRead(run + '/session/dev.token'),
          claudeCredentials: tryRead('/work/.claude/.credentials.json'), claudeDir: tryList('/work/.claude'), control: tryList('/control'),
          agentLog: tryRead('/work/.atelier/agent.log'), lastGood: tryList('/work/.atelier/last-good'), dataRoot: tryList('/work/.atelier/data'),
          peerDataDir: peer ? tryList(peer) : 'n/a', peerSock: peer ? tryList(peer.replace(/\/work\/\.atelier\/data\//, run + '/w/')) : 'n/a',
          devShellSock: await tryConnect(run + '/dev/shell.sock'), ownAppsDir: tryWrite('/work/apps/probe/planted.txt'),
        },
      })
    })
    return () => ctx.log('probe teardown')
  },
}
