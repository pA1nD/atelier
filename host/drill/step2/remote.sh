#!/bin/bash
# Runs ON fsn-01 (root, kubectl). Throwaway ns spike-host-step2, deleted by trap; production
# namespaces are never touched (only `ghcr-pull` is copied out of `agents`, read-only). Ends in VERDICT.
# Rows (the integrator's brief): (a) filesystem contract  (b) discovered/built/served with an identity
# assertion, 401 without  (c) worker uid + ctx contract from inside  (d) broken save → old rev served +
# ONE app-error in the step1-contract shape; good save → one new rev for bundle+css+worker
# (e) kill -9 the worker → relaunched, host never blinks  (f) invalidation frames with seq per
# (stream, instance) at the (fake) spine. Plus: SIGTERM teardown + boot from last-good in the second life.
set -u
NS=spike-host-step2; K="kubectl -n $NS"; CODE=/tmp/spike-host-step2-code; OUT=$CODE/out; mkdir -p $OUT; rm -f $OUT/*
IMAGE=$(cat $CODE/image.txt)
ts(){ date +%T.%3N; }; now(){ date +%s.%N | cut -c1-14; }
log(){ echo "[$(ts)] $*"; }
el(){ python3 -c "print(round($(now)-$1,2))"; }
declare -A R; for r in a b c d e f g; do R[$r]=PASS; done
FAILS=0
rowfail(){ FAILS=$((FAILS+1)); R[$1]="FAIL($2)"; log "FAIL row $1: $2"; }
cleanup(){ log "cleanup: deleting ns $NS"; kubectl delete ns $NS --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT
X(){ $K exec computer -c session -- bash -c "$1" 2>&1; }
P(){ $K exec peer -- bash -c "$1" 2>&1; }
AS1000="setpriv --reuid=1000 --regid=1000 --clear-groups"
readyq(){ $K get pod computer -o jsonpath='{.status.conditions[?(@.type=="Ready")].status} rc={.status.containerStatuses[0].restartCount} phase={.status.phase}' 2>/dev/null; }
waitready(){ local max=$1 t0=$(now); for i in $(seq 1 $((max*5))); do case "$(readyq)" in True*) echo "$(el $t0)"; return 0;; esac; sleep 0.2; done; echo "timeout"; return 1; }
hostpid(){ X "pgrep -f '^node /code/host/index.mjs' | head -1" | tr -d '\r\n'; }
workerpid(){ X "ps -eo pid,uid,args | awk '\$2==$1 && /worker\\/runtime.mjs/ {print \$1}' | head -1" | tr -d '\r\n'; }
SIGN(){ P "cd /code && node host/drill/step2/signer.mjs $*"; }
py(){ python3 -c "$1"; }

log "other spike namespaces on the node (untouched): $(kubectl get ns -o name | grep 'spike-' | grep -v "/$NS\$" | tr '\n' ' ')"
kubectl delete ns $NS --wait=true --timeout=90s >/dev/null 2>&1 || true
kubectl create ns $NS >/dev/null || { echo "VERDICT: BLOCKED — cannot create ns"; exit 1; }
kubectl -n agents get secret ghcr-pull -o json | python3 -c 'import json,sys; s=json.load(sys.stdin); print(json.dumps({"apiVersion":"v1","kind":"Secret","type":s["type"],"metadata":{"name":"ghcr-pull","namespace":"'$NS'"},"data":s["data"]}))' | $K apply -f - >/dev/null || { echo "VERDICT: BLOCKED — ghcr-pull copy failed"; exit 1; }
log "image (metal/clusters/prod/spine.yaml AGENT_IMAGE): $IMAGE"

# ---- the peer: fake spine + signer, outside the computer pod
sed "s#__IMAGE__#$IMAGE#g; s#__NS__#$NS#g" $CODE/peer.yaml.tpl | kubectl apply -f - >/dev/null || { echo "VERDICT: BLOCKED — peer apply refused"; exit 1; }
for i in $(seq 1 120); do [ "$($K get pod peer -o jsonpath='{.status.phase}')" = Running ] && break; sleep 1; done
[ "$($K get pod peer -o jsonpath='{.status.phase}')" = Running ] || { echo "VERDICT: BLOCKED — peer not Running"; exit 1; }
$K cp $CODE/code.tgz peer:/tmp/code.tgz || { echo "VERDICT: BLOCKED — kubectl cp to peer failed"; exit 1; }
P 'mkdir -p /code && tar xzf /tmp/code.tgz -C /code && cd /code && nohup node host/drill/step2/fake-spine.mjs > /tmp/spine.out 2>&1 & sleep 1; cat /tmp/spine.out' | sed 's/^/    | /'
PEER_IP=$($K get pod peer -o jsonpath='{.status.podIP}')
P 'curl -s --max-time 3 http://127.0.0.1:7999/_drill/state | head -c 120' | grep -q host_id || { echo "VERDICT: BLOCKED — fake spine not answering on the peer"; exit 1; }
log "peer $PEER_IP: fake spine up"

# ---- the computer: stage the tree (+ npm ci), then the §4.3 pod boots the real launcher + host
sed "s#__IMAGE__#$IMAGE#g; s#__NS__#$NS#g; s#__PEER_IP__#$PEER_IP#g" $CODE/pod.yaml.tpl | kubectl apply -f - >/dev/null || { echo "VERDICT: BLOCKED — pod apply refused"; exit 1; }
log "waiting for the stage init container"
for i in $(seq 1 300); do [ "$($K get pod computer -o jsonpath='{.status.initContainerStatuses[?(@.name=="stage")].state.running.startedAt}' 2>/dev/null)" != "" ] && break; sleep 1; done
$K cp $CODE/code.tgz computer:/tmp/code.tgz -c stage || { echo "VERDICT: BLOCKED — kubectl cp into stage failed"; exit 1; }
t0=$(now)
$K exec computer -c stage -- sh -c 'tar xzf /tmp/code.tgz -C /code && cd /code && timeout 300 npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -3 && ls /code/node_modules/@esbuild /code/node_modules/@tailwindcss && touch /code/.staged' | sed 's/^/    | /'
X_STAGED=$($K exec computer -c stage -- sh -c 'test -f /code/.staged && echo yes' 2>/dev/null)
[ "$X_STAGED" = yes ] || { echo "VERDICT: BLOCKED — stage (untar + npm ci) failed after $(el $t0) s"; exit 1; }
log "staged in $(el $t0) s (npm ci for the linux esbuild/tailwind binaries); waiting for Ready (fleet mode: after registration)"
T_STAGED=$(now)
RDY=$(waitready 120)
[ "$RDY" = timeout ] && { $K describe pod computer | tail -20; $K logs computer -c session 2>&1 | tail -40; echo "VERDICT: FAIL — never Ready"; exit 1; }
STARTED=$($K get pod computer -o jsonpath='{.status.containerStatuses[0].state.running.startedAt}')
SINCE_START=$(python3 -c "import datetime as d; s=d.datetime.strptime('$STARTED','%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=d.timezone.utc).timestamp(); print(round($(now)-s,1))")
IP=$($K get pod computer -o jsonpath='{.status.podIP}')
log "Ready $RDY s after staging, ≤ $SINCE_START s after the container start (1 s grain) — $(readyq); pod IP $IP"
$K logs computer -c session > $OUT/launcher-life1-boot.log 2>&1
log "launcher + host boot log:"; sed 's/^/    | /' $OUT/launcher-life1-boot.log
HOST0=$(hostpid)

# ---- the agent puts the apps in place (uid 1000, as the agent would) — and its credential
X "$AS1000 sh -c 'mkdir -m 700 /work/.claude && echo canary-credential > /work/.claude/.credentials.json && chmod 600 /work/.claude/.credentials.json && cp -r /code/drill-apps/blitzfeed /work/apps/blitzfeed && cp -r /code/drill-apps/probe /work/apps/probe && ls -ldn /work/apps/*'" | sed 's/^/    | /'
T_SAVE=$(now)
APPS=""
for i in $(seq 1 100); do
  APPS=$(SIGN GET http://$IP:1845/_atelier/apps | tail -1)
  echo "$APPS" | python3 -c 'import json,sys; a=json.load(sys.stdin); sys.exit(0 if {r["slug"] for r in a if r["state"]=="live"}=={"blitzfeed","probe"} else 1)' 2>/dev/null && break
  sleep 0.2
done
T_LIVE=$(el $T_SAVE)
log "apps after $T_LIVE s: $APPS"
echo "$APPS" > $OUT/apps-after-scan.json
echo "$APPS" | python3 -c 'import json,sys; a=json.load(sys.stdin); sys.exit(0 if {r["slug"] for r in a if r["state"]=="live"}=={"blitzfeed","probe"} else 1)' 2>/dev/null || { rowfail b "apps not live within 20 s: $APPS"; }
INST_B=$(echo "$APPS" | py 'import json,sys; print([r["instance"] for r in json.load(sys.stdin) if r["slug"]=="blitzfeed"][0])' 2>/dev/null)
INST_P=$(echo "$APPS" | py 'import json,sys; print([r["instance"] for r in json.load(sys.stdin) if r["slug"]=="probe"][0])' 2>/dev/null)
UID_B=$(X "cat /work/.atelier/$INST_B/uid" | tr -d '\r\n '); UID_P=$(X "cat /work/.atelier/$INST_P/uid" | tr -d '\r\n ')
REV0=$(echo "$APPS" | py 'import json,sys; print([r["rev"] for r in json.load(sys.stdin) if r["slug"]=="blitzfeed"][0])')
log "blitzfeed $INST_B uid $UID_B rev $REV0; probe $INST_P uid $UID_P"
X 'cat /work/.atelier/agent.log' > $OUT/agent-log-after-scan.txt; sed 's/^/    | agent.log: /' $OUT/agent-log-after-scan.txt

# ---- row (a): the filesystem contract + process tree, from inside
log "row (a): inpod.sh"
$K cp $CODE/inpod.sh computer:/tmp/inpod.sh -c session >/dev/null
X "bash /tmp/inpod.sh $INST_B $UID_B $INST_P $UID_P $REV0" | tee $OUT/inpod.txt | sed 's/^/    | /'
IN=$(tail -1 $OUT/inpod.txt); case "$IN" in INPOD:*fail=0) ;; *) rowfail a "$IN ($(grep -c '^FAIL' $OUT/inpod.txt) FAIL lines)";; esac

# ---- row (b): served with an assertion, refused without
log "row (b): protocol port :1845 with / without the identity assertion"
B1=$(SIGN GET "http://$IP:1845/api/acme/blitzfeed/state" --app $INST_B); echo "$B1" | sed 's/^/    | state+assert: /'
echo "$B1" | head -1 | grep -q '^STATUS 200' && echo "$B1" | tail -1 | grep -q '"port"' || rowfail b "state with assertion: $(echo "$B1" | head -1)"
for v in "--no-assert" "--no-bearer" "--wrong-key"; do
  S=$(SIGN GET "http://$IP:1845/api/acme/blitzfeed/state" --app $INST_B $v | head -1); log "row (b): $v → $S"
  echo "$S" | grep -q '^STATUS 401' || rowfail b "$v → $S (want 401)"
done
S=$(SIGN GET "http://$IP:1845/api/acme/blitzfeed/state" --app $INST_P | head -1); log "row (b): assertion bound to the other app → $S"; echo "$S" | grep -q '^STATUS 401' || rowfail b "wrong app binding → $S"
FJ=$(SIGN GET "http://$IP:1845/modules/acme/blitzfeed/frontend.js" --app $INST_B); ET_FJ=$(echo "$FJ" | head -1 | awk '{print $4}')
echo "$FJ" | head -1 | grep -q '^STATUS 200' && echo "$FJ" | grep -q 'BlitzFeed' || rowfail b "frontend.js: $(echo "$FJ" | head -1)"
CS=$(SIGN GET "http://$IP:1845/modules/acme/blitzfeed/styles.css" --app $INST_B); ET_CS=$(echo "$CS" | head -1 | awk '{print $4}')
echo "$CS" | head -1 | grep -q '^STATUS 200' && echo "$CS" | grep -q 'rebeccapurple' || rowfail b "styles.css: $(echo "$CS" | head -1)"
log "row (b): frontend.js etag $ET_FJ, styles.css etag $ET_CS (rev $REV0)"; [ "$ET_FJ" = "\"rev-$REV0\"" ] && [ "$ET_CS" = "$ET_FJ" ] || rowfail b "etags $ET_FJ $ET_CS ≠ rev-$REV0"
S=$(SIGN GET "http://$IP:1845/modules/acme/blitzfeed/frontend.js" --app $INST_B --no-bearer | head -1); echo "$S" | grep -q '^STATUS 401' || rowfail b "frontend.js without bearer → $S"
S=$(SIGN GET "http://$IP:1845/modules/acme/blitzfeed/backend.js" --app $INST_B | head -1); echo "$S" | grep -q '^STATUS 404' || rowfail b "backend.js via /modules → $S (want 404)"
HZ=$(SIGN GET "http://$IP:1845/_host/healthz"); echo "$HZ" | sed 's/^/    | healthz: /'; echo "$HZ" | grep -q '"hostId":"computer-drill"' || rowfail b "healthz: $HZ"
# the dev shell: loopback, token only
DT=$(X 'cat /run/atelier/dev.token' | tr -d '\r\n')
S=$(X "curl -s -o /dev/null -w %{http_code} http://127.0.0.1:1844/_atelier/apps"); [ "$S" = 401 ] || rowfail b "dev shell without token → $S"
S=$(X "curl -s -o /dev/null -w %{http_code} 'http://127.0.0.1:1844/api/acme/blitzfeed/state?token=$DT'"); [ "$S" = 200 ] || rowfail b "dev shell with token → $S"
log "row (b): dev shell 401 without token, 200 with; ${R[b]}"

# ---- row (c): the worker from inside
log "row (c): probe app — uid, groups, env, ctx, denied paths"
PR=$(SIGN GET "http://$IP:1845/api/acme/probe/probe?peer=/work/.atelier/data/$INST_B" --app $INST_P --person p1:Ada)
echo "$PR" | tail -1 > $OUT/probe.json; echo "$PR" | head -1 | grep -q '^STATUS 200' || rowfail c "probe: $(echo "$PR" | head -1)"
python3 - "$UID_P" $OUT/probe.json <<'PY' | tee $OUT/probe-verdict.txt | sed 's/^/    | /'
import json, sys
uid = int(sys.argv[1]); j = json.load(open(sys.argv[2]))
bad = []
def want(name, got, exp):
    ok = got == exp
    print(f"{'PASS' if ok else 'FAIL'} {name} = {json.dumps(got)}" + ('' if ok else f" (want {json.dumps(exp)})"))
    if not ok: bad.append(name)
want('uid', j['uid'], uid); want('gid', j['gid'], uid); want('groups', j['groups'], []); want('umask', j['umask'], '2')
want('cwd', j['cwd'], '/work/apps/probe')
want('env keys (row W + the spine-held config key)', j['envKeys'], ['APP_ID','ATELIER_WORKER','BASE_URL','DRILL_CONFIG','HOME','HOST','NODE_ENV','PATH','PORT','TMPDIR'])
want('DRILL_CONFIG (OR14 from the registrar)', j['DRILL_CONFIG'], 'from-spine')
want('ctx keys', j['ctxKeys'], sorted(['id','name','workspace','qualifiedId','label','port','host','baseUrl','dataDir','log','broadcast','module','suspendable']))
want('ctx frozen', j['frozen'], True)
want('ctx.qualifiedId', j['ctx']['qualifiedId'], 'acme/probe'); want('ctx.name', j['ctx']['name'], 'Probe'); want('ctx.host', j['ctx']['host'], 'acme.portal.pa1nd.de'); want('ctx.port', j['ctx']['port'], 443)
want('ctx.baseUrl', j['ctx']['baseUrl'], 'https://acme.portal.pa1nd.de/api/acme/probe')
want('req.user from the assertion', j['user'], {'id':'p1','name':'Ada','claims':{}})
want('dataDir write', j['dataDir']['write'], 'WROTE'); want('dataDir list', j['dataDir']['list'], 'LISTED')
for k, v in j['denied'].items(): want(f'denied.{k}', v, 'EACCES')
print(f"PROBE: fail={len(bad)} {' '.join(bad)}")
PY
grep -q '^PROBE: fail=0' $OUT/probe-verdict.txt || rowfail c "$(tail -1 $OUT/probe-verdict.txt)"
PF=$(X "stat -c '%u:%g %a %n' /work/.atelier/data/$INST_P/probe.txt"); log "row (c): the file the worker wrote: $PF"

# ---- row (d): broken save → old rev + ONE app-error; good save → one new rev
log "row (d): syntax-error save as uid 1000"
W_B0=$(workerpid $UID_B)
X "$AS1000 sh -c 'printf \"export default { mountRoutes(r) { r.get(\\n\" > /work/apps/blitzfeed/backend.js'"
t0=$(now)
for i in $(seq 1 100); do X 'grep -q "FAILED" /work/.atelier/agent.log' && break; sleep 0.1; done
T_FAILED=$(el $t0); FL=$(X 'grep FAILED /work/.atelier/agent.log | tail -1'); log "row (d): FAILED line $T_FAILED s after the save: $FL"
echo "$FL" | grep -q "rev $((REV0+1)) FAILED (users still on rev $REV0)" || rowfail d "no FAILED line for rev $((REV0+1)) within 10 s: $FL"
S=$(SIGN GET "http://$IP:1845/api/acme/blitzfeed/state" --app $INST_B); echo "$S" | head -1 | grep -q '^STATUS 200' || rowfail d "state after the broken save: $(echo "$S" | head -1)"
A=$(SIGN GET "http://$IP:1845/_atelier/apps" | tail -1); echo "$A" | py "import json,sys; a=[r for r in json.load(sys.stdin) if r['slug']=='blitzfeed'][0]; sys.exit(0 if a['rev']==$REV0 and a['state']=='live' else 1)" || rowfail d "apps after the broken save: $A"
sleep 2
P 'cat /tmp/spine.jsonl' > $OUT/spine-after-broken.jsonl
python3 - $OUT/spine-after-broken.jsonl "$INST_B" $REV0 <<'PY' | tee $OUT/apperror-verdict.txt | sed 's/^/    | /'
import json, sys
lines = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
inst, rev0 = sys.argv[2], int(sys.argv[3])
ev = [l for l in lines if l['path'] == '/v1/host/event']
print(f"app-error POSTs: {len(ev)}")
for e in ev: print(json.dumps(e['body'])[:600], '| valid' if e.get('valid') else f"| INVALID {e.get('reason')}", '| auth', e['auth'], '| status', e['status'])
mine = [e for e in ev if e['body'].get('error', {}).get('instance') == inst and e['body']['error'].get('kind') == 'build']
ok = len(mine) == 1 and mine[0]['valid'] and mine[0]['auth'] == 'token' and mine[0]['body']['kind'] == 'app-error' and mine[0]['body']['error']['rev'] == rev0 + 1 and mine[0]['body']['error'].get('hint', '').startswith('backend.js:')
print(f"APPERROR: {'ok' if ok else 'FAIL'} — {len(mine)} build record(s) for {inst} rev {rev0+1}, shape {{kind:'app-error', error:{{…}}}} validateAppError={mine[0]['valid'] if mine else None}")
sys.exit(0 if ok else 1)
PY
[ ${PIPESTATUS[0]} = 0 ] || rowfail d "app-error record: $(tail -1 $OUT/apperror-verdict.txt)"
log "row (d): good save (the original backend.js back, as uid 1000)"
X "$AS1000 cp /code/drill-apps/blitzfeed/backend.js /work/apps/blitzfeed/backend.js"
t0=$(now); REV1=""
for i in $(seq 1 150); do
  A=$(SIGN GET "http://$IP:1845/_atelier/apps" | tail -1)
  REV1=$(echo "$A" | py "import json,sys; a=[r for r in json.load(sys.stdin) if r['slug']=='blitzfeed'][0]; print(a['rev'] if a['rev']>$REV0 and a['state']=='live' else '')" 2>/dev/null)
  [ -n "$REV1" ] && break; sleep 0.1
done
T_SWAP=$(el $t0); log "row (d): live at rev $REV1 $T_SWAP s after the good save (rev0 $REV0)"
[ -n "$REV1" ] || { rowfail d "no new live rev within 15 s: $A"; REV1=$REV0; }
W_B1=$(workerpid $UID_B)
FJ=$(SIGN GET "http://$IP:1845/modules/acme/blitzfeed/frontend.js" --app $INST_B | head -1 | awk '{print $4}'); CS=$(SIGN GET "http://$IP:1845/modules/acme/blitzfeed/styles.css" --app $INST_B | head -1 | awk '{print $4}')
S=$(SIGN GET "http://$IP:1845/api/acme/blitzfeed/state" --app $INST_B | head -1)
CUR=$(X "readlink /work/.atelier/$INST_B/current"); RJ=$(X "cat /work/.atelier/$INST_B/revision.json" | py 'import json,sys; j=json.load(sys.stdin); print(j["rev"], j["live"])')
log "row (d): etags $FJ $CS, worker pid $W_B0 → $W_B1, current → $CUR, revision.json rev/live = $RJ, state $S"
[ "$FJ" = "\"rev-$REV1\"" ] && [ "$CS" = "$FJ" ] || rowfail d "etags after the swap $FJ $CS ≠ rev-$REV1"
[ -n "$W_B1" ] && [ "$W_B1" != "$W_B0" ] || rowfail d "worker pid not renewed ($W_B0 → $W_B1)"
[ "$CUR" = "../last-good/$INST_B/rev-$REV1" ] || rowfail d "current → $CUR"
echo "$S" | grep -q '^STATUS 200' || rowfail d "state after the swap: $S"
OLD=$(SIGN GET "http://$IP:1845/modules/acme/blitzfeed/frontend.js?rev=$REV0" --app $INST_B | head -1); log "row (d): the previous rev via ?rev=$REV0 → $OLD (kept 10 min)"
X 'cat /work/.atelier/agent.log' > $OUT/agent-log-after-saves.txt; sed 's/^/    | agent.log: /' $OUT/agent-log-after-saves.txt

# ---- row (e): kill -9 the worker; the host never blinks
log "row (e): kill -9 the blitzfeed worker $W_B1 under a request loop from the peer"
P "cd /code && nohup sh -c 'for i in \$(seq 1 40); do node host/drill/step2/signer.mjs GET http://$IP:1845/api/acme/blitzfeed/state --app $INST_B | head -1; done' > /tmp/loop.txt 2>&1 &"
sleep 0.7
t0=$(now); X "kill -9 $W_B1"
W_B2=""; for i in $(seq 1 100); do W_B2=$(workerpid $UID_B); [ -n "$W_B2" ] && [ "$W_B2" != "$W_B1" ] && break; sleep 0.1; done
T_RELAUNCH=$(el $t0)
for i in $(seq 1 60); do [ "$(P 'wc -l < /tmp/loop.txt' | tr -d ' \r\n')" -ge 40 ] && break; sleep 0.5; done
LOOP=$(P 'cat /tmp/loop.txt'); echo "$LOOP" > $OUT/kill-loop.txt
NON200=$(echo "$LOOP" | grep -vc '^STATUS 200'); TOTAL=$(echo "$LOOP" | grep -c '^STATUS')
HOST1=$(hostpid); RDY=$(X 'test -f /run/atelier/host-ready && echo present')
log "row (e): worker $W_B1 → $W_B2 in $T_RELAUNCH s; loop $NON200 non-200 of $TOTAL; host pid $HOST0 → $HOST1; host-ready $RDY; $(readyq)"
[ -n "$W_B2" ] && [ "$W_B2" != "$W_B1" ] || rowfail e "worker not relaunched"
[ "$NON200" = 0 ] || rowfail e "$NON200 non-200 during the worker restart"
[ "$HOST1" = "$HOST0" ] || rowfail e "host pid changed $HOST0 → $HOST1"
[ "$RDY" = present ] || rowfail e "host-ready missing"
X 'grep -E "KILLED|RESUMED" /work/.atelier/agent.log | tail -2' | sed 's/^/    | agent.log: /'
X 'grep -q "KILLED worker died: signal SIGKILL" /work/.atelier/agent.log && grep -q RESUMED /work/.atelier/agent.log' || rowfail e "no KILLED signal SIGKILL + RESUMED lines"

# ---- row (f): invalidation frames at the spine
sleep 1
P 'cat /tmp/spine.jsonl' > $OUT/spine-life1.jsonl; P 'cat /tmp/spine-state.json' > $OUT/spine-state.json
python3 - $OUT/spine-life1.jsonl "$INST_B" "$INST_P" $REV1 <<'PY' | tee $OUT/events-verdict.txt | sed 's/^/    | /'
import json, sys
lines = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
inst_b, inst_p, rev1 = sys.argv[2], sys.argv[3], int(sys.argv[4])
st = json.load(open(sys.argv[1].replace('spine-life1.jsonl', 'spine-state.json')))
stream = f"{st['host_id']}:{st['epoch']}"
frames = [f for l in lines if l['path'] == '/v1/host/events' for f in l['body']]
print(f"events POSTs: {sum(1 for l in lines if l['path']=='/v1/host/events')}, frames: {len(frames)}")
for f in frames: print(json.dumps(f))
by = {}
for f in frames: by.setdefault(f['topic'], []).append(f['seq'])
ok = all(f['stream'] == stream and f['type'] == 'invalidate' for f in frames) and by.get(inst_b) == [1, 2] and by.get(inst_p) == [1]
mc = [l['body'] for l in lines if l['path'] == '/v1/host/modules-changed']
print(f"modules-changed: {json.dumps(mc)}")
reg = [l for l in lines if l['path'] == '/v1/host/register']; hb = [l for l in lines if l['path'] == '/v1/host/heartbeat']
print(f"register: {len(reg)} (auth {[r['auth'] for r in reg]}), heartbeats: {len(hb)}, last heartbeat body: {json.dumps(hb[-1]['body']) if hb else None}")
print(f"EVENTS: {'ok' if ok else 'FAIL'} — stream {stream}, seq per topic {json.dumps(by)}")
sys.exit(0 if ok else 1)
PY
[ ${PIPESTATUS[0]} = 0 ] || rowfail f "$(tail -1 $OUT/events-verdict.txt)"

# ---- row (g): SIGTERM the pod's PID 1 → host teardown, container restart, boot from last-good
log "row (g): kill -TERM 1 → teardown order, then the second life boots from last-good"
$K logs computer -c session > $OUT/launcher-life1.log 2>&1
t0=$(now); X 'kill -TERM 1'
for i in $(seq 1 300); do rc=$($K get pod computer -o jsonpath='{.status.containerStatuses[0].restartCount}'); [ "$rc" = 1 ] && break; sleep 0.2; done
log "row (g): restartCount=$rc after $(el $t0) s"; [ "$rc" = 1 ] || rowfail g "no container restart within 60 s"
RDY2=$(waitready 90); log "row (g): Ready again $RDY2 s later — $(readyq)"; [ "$RDY2" = timeout ] && rowfail g "not Ready after the restart"
$K logs computer -c session --previous > $OUT/launcher-life1-prev.log 2>&1; $K logs computer -c session > $OUT/launcher-life2-boot.log 2>&1
grep -E 'teardown|stopped|SIGTERM|draining' $OUT/launcher-life1-prev.log | sed 's/^/    | prev: /'
X 'cat /work/.atelier/agent.log' > $OUT/agent-log-final.txt
grep -q 'host: stopped' $OUT/agent-log-final.txt || rowfail g "no 'host: stopped' in agent.log"
P 'grep -c draining /tmp/spine.jsonl' | grep -q '^[1-9]' || rowfail g "no draining call at the spine"
sed 's/^/    | life2: /' $OUT/launcher-life2-boot.log | grep -E 'boot:|registrar|ready|LIVE|RESUMED' | head
A=$(SIGN GET "http://$IP:1845/_atelier/apps" | tail -1); log "row (g): apps after the restart (from last-good, no rebuild yet): $A"
t0=$(now); S=$(SIGN GET "http://$IP:1845/api/acme/blitzfeed/state" --app $INST_B | head -1); log "row (g): first request after the restart (held resume) → $S in $(el $t0) s"
echo "$S" | grep -q '^STATUS 200' || rowfail g "resume after the restart → $S"
X 'grep RESUMED /work/.atelier/agent.log | tail -1' | sed 's/^/    | agent.log: /'
X 'cat /work/.atelier/agent.log' > $OUT/agent-log-final.txt; P 'cat /tmp/spine.jsonl' > $OUT/spine-final.jsonl
X "find /work/.atelier /run/atelier -printf '%m %u:%g %p\n' | sort" > $OUT/tree-final.txt 2>&1

log "== VERDICT"
SUM="a:${R[a]} b:${R[b]} c:${R[c]} d:${R[d]} e:${R[e]} f:${R[f]} g:${R[g]}"
[ $FAILS = 0 ] && echo "VERDICT: PASS — $SUM; Ready ${SINCE_START}s after start; 2 apps live $T_LIVE s after the agent's copy; broken save → FAILED line in ${T_FAILED}s, 1 app-error; good save → rev $REV1 live in ${T_SWAP}s; worker kill → relaunch ${T_RELAUNCH}s, $NON200/$TOTAL non-200; inpod $IN" \
                || echo "VERDICT: FAIL — $SUM"
