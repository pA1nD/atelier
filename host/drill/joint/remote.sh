#!/bin/bash
# Runs ON fsn-01 (root, kubectl). Throwaway ns spike-step2-joint, deleted by trap; production
# namespaces are never touched (only `ghcr-pull` is copied out of `agents`, read-only). Ends in VERDICT.
# Pod `spine` = the real registrar (serve.js on the orchestrator image) behind Service `spine`; pod
# `computer` = the §4.3 host pod with ATELIER_SPINE_URL → that Service and the spine-minted bootstrap.
# Rows: (1) register / revoke / self re-register  (2) heartbeats  (3) claim 201 ×2, rename, unlink →
# tombstone, revive  (4) modules-changed uid+rev, register().apps after a host restart  (5) the ring:
# seq per (stream, instance), batch > 128 → 400, stale-epoch → 401 → re-register + re-queue
# (6) broken save → ONE app-error at /v1/host/event  (7) GET config env reaches the worker
# (8) draining on SIGTERM.
set -u
NS=spike-step2-joint; K="kubectl -n $NS"; CODE=/tmp/$NS-code; OUT=$CODE/out; mkdir -p $OUT; rm -f $OUT/*
AGENT_IMAGE=$(sed -n 1p $CODE/images.txt); ORCH_IMAGE=$(sed -n 2p $CODE/images.txt)
SPINE_URL="http://spine.$NS.svc:7999"
ts(){ date +%T.%3N; }; now(){ date +%s.%N | cut -c1-14; }
log(){ echo "[$(ts)] $*"; }
el(){ python3 -c "print(round($(now)-$1,2))"; }
declare -A R; for r in 1 2 3 4 5 6 7 8; do R[$r]=PASS; done
FAILS=0
rowfail(){ FAILS=$((FAILS+1)); R[$1]="FAIL($2)"; log "FAIL row $1: $2"; }
cleanup(){ log "cleanup: deleting ns $NS"; kubectl delete ns $NS --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT
X(){ $K exec computer -c session -- bash -c "$1" 2>&1; }
S(){ $K exec spine -- sh -c "$1" 2>&1; }
AS1000="setpriv --reuid=1000 --regid=1000 --clear-groups"
readyq(){ $K get pod computer -o jsonpath='{.status.conditions[?(@.type=="Ready")].status} rc={.status.containerStatuses[0].restartCount} phase={.status.phase}' 2>/dev/null; }
waitready(){ local max=$1 t0=$(now); for i in $(seq 1 $((max*5))); do case "$(readyq)" in True*) echo "$(el $t0)"; return 0;; esac; sleep 0.2; done; echo "timeout"; return 1; }
hostpid(){ X "pgrep -f '^node /code/host/index.mjs' | head -1" | tr -d '\r\n'; }
workerpid(){ X "ps -eo pid,uid,args | awk '\$2==$1 && /worker\\/runtime.mjs/ {print \$1}' | sort -n | tail -1" | tr -d '\r\n'; }
# CALL <method> <path> <bearer> [json]  → body, then "HTTP <code>" (from the computer pod, as a peer would)
CALL(){ X "curl -s --max-time 10 -X $1 -H 'authorization: Bearer $3' -H 'content-type: application/json' ${4:+-d '$4'} -w '\nHTTP %{http_code}' $SPINE_URL$2"; }
CALLF(){ X "curl -s --max-time 10 -X $1 -H 'authorization: Bearer $3' -H 'content-type: application/json' -d @$4 -w '\nHTTP %{http_code}' $SPINE_URL$2"; }
STATE(){ X "curl -s --max-time 5 $SPINE_URL/_drill/state"; }
snap(){ S 'cat /tmp/reg/data/spine.jsonl' > $OUT/spine.jsonl; }
# pyj '<python over L (the spine's JSON lines)>'
pyj(){ python3 -c "
import json,sys
L=[json.loads(l) for l in open('$OUT/spine.jsonl') if l.strip()]
REG=[l for l in L if l.get('path')=='/v1/host/register']
$1"; }
count(){ S "grep -c '\"path\":\"$1\"' /tmp/reg/data/spine.jsonl 2>/dev/null || true" | tr -d '\r\n '; }
waitline(){ local path=$1 want=$2 max=$3; for i in $(seq 1 $((max*4))); do [ "$(count $path)" -ge "$want" ] && return 0; sleep 0.25; done; return 1; }
DEV(){ X "curl -s --max-time 10 'http://127.0.0.1:1844$1?token=$DT'"; }
apps(){ DEV /_atelier/apps; }

log "other spike namespaces on the node (untouched): $(kubectl get ns -o name | grep 'spike-' | grep -v "/$NS\$" | tr '\n' ' ')"
kubectl delete ns $NS --wait=true --timeout=90s >/dev/null 2>&1 || true
kubectl create ns $NS >/dev/null || { echo "VERDICT: BLOCKED — cannot create ns"; exit 1; }
kubectl -n agents get secret ghcr-pull -o json | python3 -c 'import json,sys; s=json.load(sys.stdin); print(json.dumps({"apiVersion":"v1","kind":"Secret","type":s["type"],"metadata":{"name":"ghcr-pull","namespace":"'$NS'"},"data":s["data"]}))' | $K apply -f - >/dev/null || { echo "VERDICT: BLOCKED — ghcr-pull copy failed"; exit 1; }
log "agent image: $AGENT_IMAGE"; log "orchestrator image: $ORCH_IMAGE"

# ---- pod A: the real registrar (serve.js) on the orchestrator image, behind Service `spine`
sed "s#__IMAGE__#$ORCH_IMAGE#g; s#__NS__#$NS#g" $CODE/spine.yaml.tpl | kubectl apply -f - >/dev/null || { echo "VERDICT: BLOCKED — spine apply refused"; exit 1; }
for i in $(seq 1 120); do [ "$($K get pod spine -o jsonpath='{.status.phase}')" = Running ] && break; sleep 1; done
[ "$($K get pod spine -o jsonpath='{.status.phase}')" = Running ] || { $K describe pod spine | tail -8; echo "VERDICT: BLOCKED — spine pod not Running"; exit 1; }
$K cp $CODE/spine.tgz spine:/tmp/spine.tgz || { echo "VERDICT: BLOCKED — kubectl cp to spine failed"; exit 1; }
S 'mkdir -p /tmp/reg/data && tar xzf /tmp/spine.tgz -C /tmp/reg && node --version && ls /tmp/reg/dist/registry' | sed 's/^/    | spine: /'
SESSION_EPOCH=$(python3 -c 'import secrets; print(secrets.token_hex(8))')
timeout 15 $K exec spine -- sh -c "cd /tmp/reg && REGISTRY_DATA_DIR=/tmp/reg/data REGISTRY_CHAT=chat-drill REGISTRY_EPOCH=$SESSION_EPOCH REGISTRY_COMPANY=acme setsid -f node dist/registry/serve.js < /dev/null > /tmp/reg/serve.out 2>&1; sleep 2; cat /tmp/reg/serve.out" 2>&1 | tee $OUT/serve-boot.out | sed 's/^/    | serve: /'
grep -q '^LISTENING 7999' $OUT/serve-boot.out || { echo "VERDICT: BLOCKED — serve.js did not come up"; exit 1; }
BOOTSTRAP=$(S 'cat /tmp/reg/data/bootstrap.token' | tr -d '\r\n')
SECRET_HEX=$(S 'cat /tmp/reg/data/channel-secret' | tr -d '\r\n')
[ "$(grep '^BOOTSTRAP' $OUT/serve-boot.out | awk '{print $2}')" = "$BOOTSTRAP" ] || { echo "VERDICT: BLOCKED — bootstrap.token ≠ the BOOTSTRAP line"; exit 1; }
# the mint, recomputed independently (docs/step2-registrar.md "Credentials"): HMAC-SHA256(channel secret, "<chat>:<sessionEpoch>:host-bootstrap")
MINT=$(python3 -c "import hmac,hashlib; print(hmac.new(bytes.fromhex('$SECRET_HEX'), b'chat-drill:$SESSION_EPOCH:host-bootstrap', hashlib.sha256).hexdigest())")
[ "$MINT" = "$BOOTSTRAP" ] && log "bootstrap minted by serve.js = HMAC-SHA256(channel secret, chat-drill:$SESSION_EPOCH:host-bootstrap) recomputed on fsn-01: EQUAL (${BOOTSTRAP:0:12}…)" || { echo "VERDICT: BLOCKED — bootstrap mint mismatch"; exit 1; }
SPINE_IP=$($K get pod spine -o jsonpath='{.status.podIP}'); log "spine pod $SPINE_IP, Service $SPINE_URL"

# ---- pod B: the computer (stage the tree + npm ci, then the §4.3 pod boots the real launcher + host)
sed "s#__IMAGE__#$AGENT_IMAGE#g; s#__NS__#$NS#g; s#__SPINE_URL__#$SPINE_URL#g; s#__BOOTSTRAP__#$BOOTSTRAP#g" $CODE/pod.yaml.tpl | kubectl apply -f - >/dev/null || { echo "VERDICT: BLOCKED — pod apply refused"; exit 1; }
for i in $(seq 1 300); do [ "$($K get pod computer -o jsonpath='{.status.initContainerStatuses[?(@.name=="stage")].state.running.startedAt}' 2>/dev/null)" != "" ] && break; sleep 1; done
$K cp $CODE/code.tgz computer:/tmp/code.tgz -c stage || { echo "VERDICT: BLOCKED — kubectl cp into stage failed"; exit 1; }
t0=$(now)
$K exec computer -c stage -- sh -c 'tar xzf /tmp/code.tgz -C /code 2>&1 | grep -v "Ignoring unknown extended header"; cd /code && timeout 300 npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -2 && ls /code/node_modules/@esbuild /code/node_modules/@tailwindcss >/dev/null && touch /code/.staged && echo STAGED-OK' | tee $OUT/stage.log | sed 's/^/    | /'
grep -q STAGED-OK $OUT/stage.log || { echo "VERDICT: BLOCKED — stage (untar + npm ci) failed after $(el $t0) s"; exit 1; }
log "staged in $(el $t0) s; waiting for Ready (fleet mode: after registration at the REAL spine)"
RDY=$(waitready 120)
[ "$RDY" = timeout ] && { $K describe pod computer | tail -20; $K logs computer -c session 2>&1 | tail -40; snap; echo "VERDICT: FAIL — never Ready"; exit 1; }
IP=$($K get pod computer -o jsonpath='{.status.podIP}')
log "Ready $RDY s after staging — $(readyq); pod IP $IP"
$K logs computer -c session > $OUT/launcher-life1-boot.log 2>&1
grep -E 'registrar|ready|mode:' $OUT/launcher-life1-boot.log | sed 's/^/    | boot: /'
HOST0=$(hostpid); DT=$(X 'cat /run/atelier/dev.token' | tr -d '\r\n')

# ---- row (1a): register → host_id / epoch / token at the spine
snap
R1=$(pyj "r=REG[-1]; print(r['auth'], r['status'], r['reply']['host_id'], r['reply']['epoch'], r['reply']['company'], r['reply']['chat'], len(r['reply']['apps']), len(r['reply']['shell_public_key_hex']))")
log "row (1a): register → $R1"
echo "$R1" | grep -q '^bootstrap 200 computer-[0-9a-f]\{24\} [0-9a-f]\{16\} acme chat-drill 0 ' || rowfail 1 "register reply: $R1"
HOST_ID=$(echo "$R1" | awk '{print $3}'); EPOCH1=$(echo "$R1" | awk '{print $4}')
TOKEN1=$(pyj "print(REG[-1]['reply']['token'])")
grep -q "registrar: registered host=$HOST_ID epoch=$EPOCH1" $OUT/launcher-life1-boot.log || rowfail 1 "host log has no 'registered host=$HOST_ID epoch=$EPOCH1'"
X "cat /run/atelier/bootstrap.token" | tr -d '\r\n' | grep -q "^$BOOTSTRAP\$" && log "row (1a): /run/atelier/bootstrap.token = the minted bootstrap ($(X 'stat -c %u:%g/%a /run/atelier/bootstrap.token'))" || rowfail 1 "bootstrap.token in the pod ≠ the mint"

# ---- the agent puts the apps in place (uid 1000)
X "$AS1000 sh -c 'cp -r /code/drill-apps/blitzfeed /work/apps/blitzfeed && cp -r /code/drill-apps/probe /work/apps/probe && ls -ldn /work/apps/*'" | sed 's/^/    | /'
T_SAVE=$(now); APPS=""
for i in $(seq 1 100); do
  APPS=$(apps)
  echo "$APPS" | python3 -c 'import json,sys; a=json.load(sys.stdin); sys.exit(0 if {r["slug"] for r in a if r["state"]=="live"}=={"blitzfeed","probe"} else 1)' 2>/dev/null && break
  sleep 0.2
done
T_LIVE=$(el $T_SAVE); log "apps after $T_LIVE s: $APPS"; echo "$APPS" > $OUT/apps-after-scan.json
echo "$APPS" | python3 -c 'import json,sys; a=json.load(sys.stdin); sys.exit(0 if {r["slug"] for r in a if r["state"]=="live"}=={"blitzfeed","probe"} else 1)' 2>/dev/null || { rowfail 3 "apps not live within 20 s: $APPS"; }
INST_B=$(echo "$APPS" | python3 -c 'import json,sys; print([r["instance"] for r in json.load(sys.stdin) if r["slug"]=="blitzfeed"][0])')
INST_P=$(echo "$APPS" | python3 -c 'import json,sys; print([r["instance"] for r in json.load(sys.stdin) if r["slug"]=="probe"][0])')
UID_B=$(X "cat /work/.atelier/$INST_B/uid" | tr -d '\r\n '); UID_P=$(X "cat /work/.atelier/$INST_P/uid" | tr -d '\r\n ')
REV0=$(echo "$APPS" | python3 -c 'import json,sys; print([r["rev"] for r in json.load(sys.stdin) if r["slug"]=="blitzfeed"][0])')
log "blitzfeed $INST_B uid $UID_B rev $REV0; probe $INST_P uid $UID_P"
X 'cat /work/.atelier/agent.log' | sed 's/^/    | agent.log: /'

# ---- row (3a): two claims → 201 at the real spine
sleep 1; snap
C3=$(pyj "
P=[l for l in L if l.get('method')=='PUT' and l['path'].startswith('/v1/apps/')]
print(' '.join(f\"{l['path'].split('/')[-1]}:{l['status']}:{l['reply'].get('claimed')}:{l['body'].get('slug')}\" for l in P))")
log "row (3a): PUT /v1/apps → $C3"
echo "$C3" | grep -q "$INST_B:201:True:blitzfeed" && echo "$C3" | grep -q "$INST_P:201:True:probe" || rowfail 3 "expected two 201 claimed: $C3"
STATE > $OUT/state-after-claims.json
python3 -c "
import json; s=json.load(open('$OUT/state-after-claims.json'))
a={x['instance']:x for x in s['apps']}; h=s['hosts'][0]
print('    | spine rows:', {i:(x['slug'],x['company'],x['computer']==h['id'],x['uid'],x['rev']) for i,x in a.items()})
assert a['$INST_B']['computer']==h['id'] and a['$INST_P']['computer']==h['id'] and a['$INST_B']['company']=='acme'" || rowfail 3 "spine app rows not owned by the host's computer"

# ---- row (4a): modules-changed carries uid + rev
M4=$(pyj "
M=[l for l in L if l.get('path')=='/v1/host/modules-changed']
print(len(M), json.dumps([a for l in M for a in l['body']['apps']]))
SR=[l for l in L if l.get('lane')=='set-running']; print('set-running', json.dumps([(l['instance'],l['rev']) for l in SR]))")
log "row (4a): $M4"
echo "$M4" | python3 -c "
import json,sys; t=sys.stdin.read(); rows=json.loads(t.split('\n')[0].split(' ',1)[1])
by={r['instance']:r for r in rows}
assert by['$INST_B']['uid']==$UID_B and by['$INST_P']['uid']==$UID_P and isinstance(by['$INST_B']['rev'],int) and isinstance(by['$INST_P']['rev'],int), by
assert 'set-running' in t and '\"$INST_B\"' in t" || rowfail 4 "modules-changed without uid+rev for both: $M4"
python3 -c "
import json; s=json.load(open('$OUT/state-after-claims.json')); a={x['instance']:x for x in s['apps']}
assert a['$INST_B']['uid']==$UID_B and a['$INST_P']['uid']==$UID_P and a['$INST_B']['rev'] is not None, a" || rowfail 4 "uid/rev not persisted in the spine rows"

# ---- row (6): broken save → ONE app-error at /v1/host/event (the step-1 shape)
log "row (6): syntax-error save as uid 1000"
X "$AS1000 sh -c 'printf \"export default { mountRoutes(r) { r.get(\\n\" > /work/apps/blitzfeed/backend.js'"
t0=$(now); for i in $(seq 1 100); do X 'grep -q "FAILED" /work/.atelier/agent.log' && break; sleep 0.1; done
T_FAILED=$(el $t0); FL=$(X 'grep FAILED /work/.atelier/agent.log | tail -1'); log "row (6): FAILED line $T_FAILED s after the save: $FL"
waitline /v1/host/event 1 10; sleep 1; snap
E6=$(pyj "
E=[l for l in L if l.get('path')=='/v1/host/event']; A=[l for l in L if l.get('lane')=='app-error']
print(len(E), [l['status'] for l in E], [l['auth'] for l in E], len(A))
for l in E: print('    |', json.dumps(l['body'])[:400])
mine=[l for l in E if l['body'].get('kind')=='app-error' and l['body'].get('error',{}).get('instance')=='$INST_B' and l['body']['error'].get('kind')=='build']
print('APPERROR', len(mine), mine[0]['status'] if mine else None, mine[0]['body']['error'].get('rev') if mine else None, (mine[0]['body']['error'].get('hint') or '')[:40] if mine else None, 'delivered' if len(A)==len(mine) else 'NOT-DELIVERED')")
echo "$E6" | sed 's/^/    | /'
echo "$E6" | grep -q "^APPERROR 1 200 $((REV0+1)) backend.js:.* delivered$" || rowfail 6 "$(echo "$E6" | tail -1)"
S=$(DEV /api/acme/blitzfeed/state | head -c 60); log "row (6): /state still served after the broken save: ${S:0:60}"
log "row (6): good save"
X "$AS1000 cp /code/drill-apps/blitzfeed/backend.js /work/apps/blitzfeed/backend.js"
REV1=""; for i in $(seq 1 150); do A=$(apps); REV1=$(echo "$A" | python3 -c "import json,sys; a=[r for r in json.load(sys.stdin) if r['slug']=='blitzfeed'][0]; print(a['rev'] if a['rev']>$REV0 and a['state']=='live' else '')" 2>/dev/null); [ -n "$REV1" ] && break; sleep 0.1; done
[ -n "$REV1" ] || { rowfail 6 "no new live rev after the good save"; REV1=$REV0; }
log "row (6): blitzfeed live at rev $REV1"

# ---- row (7): GET config env reaches the worker after the uid drop — from the REAL spine
log "row (7): PUT /_drill/config/$INST_P {DRILL_CONFIG: from-spine} (stands in for the admin plane's PUT /v1/apps/<i>/config), then a save → respawn"
C7=$(X "curl -s --max-time 5 -X PUT -H 'content-type: application/json' -d '{\"env\":{\"DRILL_CONFIG\":\"from-spine\"}}' -w ' HTTP %{http_code}' $SPINE_URL/_drill/config/$INST_P"); log "row (7): config write → $C7"
PROBE0=$(DEV /api/acme/probe/probe); log "row (7): before the respawn DRILL_CONFIG = $(echo "$PROBE0" | python3 -c 'import json,sys; print(json.load(sys.stdin)["DRILL_CONFIG"])' 2>/dev/null)"
W_P0=$(workerpid $UID_P)
X "$AS1000 sh -c 'printf \"\\n// joint drill: config respawn\\n\" >> /work/apps/probe/backend.js'"
W_P1=""; for i in $(seq 1 100); do W_P1=$(workerpid $UID_P); [ -n "$W_P1" ] && [ "$W_P1" != "$W_P0" ] && break; sleep 0.1; done
sleep 0.5
PROBE=$(DEV /api/acme/probe/probe); echo "$PROBE" > $OUT/probe.json
P7=$(echo "$PROBE" | python3 -c 'import json,sys; j=json.load(sys.stdin); print(j["uid"], j["DRILL_CONFIG"], "DRILL_CONFIG" in j["envKeys"], j["envKeys"])' 2>/dev/null)
log "row (7): worker $W_P0 → $W_P1; probe from inside: $P7"
echo "$P7" | grep -q "^$UID_P from-spine True " || rowfail 7 "probe: $P7"
snap; G7=$(pyj "G=[l for l in L if l.get('method')=='GET' and l['path']=='/v1/apps/$INST_P/config']; print(len(G), [(l['status'], l['reply']) for l in G])"); log "row (7): GET /v1/apps/$INST_P/config at the spine: $G7"
echo "$G7" | grep -q "'DRILL_CONFIG': 'from-spine'" || rowfail 7 "no config GET with the env at the spine: $G7"

# ---- row (5a): the ring at the spine — seq per (stream, instance)
sleep 1; snap
R5=$(pyj "
F=[f for l in L if l.get('path')=='/v1/host/events' for f in (l['body'] or [])]
by={}
for f in F: by.setdefault(f['topic'],[]).append((f['stream'].split(':')[1][:6], f['seq']))
print(json.dumps(by))")
RING_B=$(X "curl -s $SPINE_URL/_drill/events?topic=$INST_B"); RING_P=$(X "curl -s $SPINE_URL/_drill/events?topic=$INST_P"); echo "$RING_B" > $OUT/ring-blitzfeed.json; echo "$RING_P" > $OUT/ring-probe.json
Q5=$(python3 -c "
import json; b=json.load(open('$OUT/ring-blitzfeed.json')); p=json.load(open('$OUT/ring-probe.json'))
sb=[e['seq'] for e in b['events']]; sp=[e['seq'] for e in p['events']]
st={e['stream'] for e in b['events']+p['events']}
print('blitzfeed', sb, 'probe', sp, 'streams', sorted(st), 'epoch', b['epoch'])
assert sb==[1,2] and sp==[1,2] and st=={'$HOST_ID:$EPOCH1'}, (sb,sp,st)"); rc=$?
log "row (5a): frames pushed $R5; ring since(null): $Q5"; [ $rc = 0 ] || rowfail 5 "ring seq: $Q5"

# ---- row (2): heartbeats every 10 s with visible_apps / last_served_at
snap; HB0=$(count /v1/host/heartbeat); log "row (2): $HB0 heartbeats so far — waiting for ≥ 3"
waitline /v1/host/heartbeat 3 40; snap
H2=$(pyj "
H=[l for l in L if l.get('path')=='/v1/host/heartbeat']
gaps=[round((H[i]['at']-H[i-1]['at'])/1000,2) for i in range(1,len(H))]
last=H[-1]['body']; print(len(H), gaps, json.dumps(last), [l['status'] for l in H])
assert all(9<=g<=11.5 for g in gaps) and last['visible_apps']==2 and isinstance(last['last_served_at'],int) and last['pod_ip']=='$IP' and all(l['status']==200 for l in H), (gaps,last)"); rc=$?
log "row (2): $H2"; [ $rc = 0 ] || rowfail 2 "$H2"
STATE > $OUT/state-heartbeat.json
python3 -c "
import json; h=json.load(open('$OUT/state-heartbeat.json'))['hosts'][0]
print('    | computer row:', {k:h[k] for k in ('id','chat','company','epoch','pod_ip','visible_apps','last_served_at','last_heartbeat_at','draining_at')})
assert h['visible_apps']==2 and h['last_heartbeat_at'] and h['last_served_at'] and 'token' not in json.dumps(h)" || rowfail 2 "computer row after heartbeats"

# ---- row (1b): a second register revokes the previous epoch; the host re-registers by itself
log "row (1b): forced POST /v1/host/register with the bootstrap (a second life claiming the chat)"
F1=$(CALL POST /v1/host/register "$BOOTSTRAP" '{"pod_ip":"forced","host_started_at":1}'); EPOCH2=$(echo "$F1" | head -1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["epoch"])'); TOKEN2=$(echo "$F1" | head -1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
log "row (1b): forced register → $(echo "$F1" | tail -1), epoch $EPOCH1 → $EPOCH2"
O1=$(CALL POST /v1/host/heartbeat "$TOKEN1" '{"visible_apps":0}'); log "row (1b): the host's previous token → $(echo "$O1" | tr '\n' ' ')"
echo "$O1" | grep -q 'host-epoch-moved' && echo "$O1" | grep -q 'HTTP 401' || rowfail 1 "old token not revoked: $O1"
t0=$(now); NREG=$(count /v1/host/register)
for i in $(seq 1 80); do [ "$(count /v1/host/register)" -gt "$NREG" ] && break; sleep 0.25; done
T_REREG=$(el $t0); snap
E1=$(pyj "r=REG[-1]; print(r['auth'], r['status'], r['reply']['epoch'], r['body'].get('pod_ip'), len(REG))"); EPOCH3=$(echo "$E1" | awk '{print $3}'); TOKEN3=$(pyj "print(REG[-1]['reply']['token'])")
$K logs computer -c session > $OUT/launcher-life1.log 2>&1
HL=$(grep -E 'host-epoch-moved|registrar: registered' $OUT/launcher-life1.log | tail -3); echo "$HL" | sed 's/^/    | host: /'
log "row (1b): the host re-registered $T_REREG s after the forced register (at its next heartbeat): $E1 — epoch $EPOCH2 → $EPOCH3"
echo "$E1" | grep -q "^bootstrap 200 [0-9a-f]\{16\} $IP 3$" && [ "$EPOCH3" != "$EPOCH2" ] && echo "$HL" | grep -q "host-epoch-moved → re-register" || rowfail 1 "host did not re-register by itself: $E1 / $HL"
O2=$(CALL POST /v1/host/heartbeat "$TOKEN2" '{"visible_apps":0}' | tail -1); O3=$(CALL POST /v1/host/heartbeat "$TOKEN3" '{"visible_apps":2}' | tail -1)
log "row (1b): forced token now → $O2; the host's new token → $O3"; [ "$O2" = "HTTP 401" ] && [ "$O3" = "HTTP 200" ] || rowfail 1 "revocation chain: forced $O2, current $O3"

# ---- row (5b): a batch > 128 is refused
python3 -c "
import json; print(json.dumps([{'stream':'$HOST_ID:$EPOCH3','topic':'$INST_B','seq':i+1,'type':'invalidate'} for i in range(129)]))" > $OUT/batch129.json
$K cp $OUT/batch129.json computer:/tmp/batch129.json -c session >/dev/null
B5=$(CALLF POST /v1/host/events "$TOKEN3" /tmp/batch129.json); log "row (5b): 129 frames → $(echo "$B5" | tr '\n' ' ')"
echo "$B5" | grep -q 'batch-too-large' && echo "$B5" | grep -q 'HTTP 400' || rowfail 5 "batch of 129: $B5"

# ---- row (5c): the revoked epoch at the events lane. A save's swap calls the spine three times in
# ~100 ms: GET config (before the worker spawns), then — synchronously at the swap — modules-changed,
# and 10 ms later the events push. trip.js in the spine pod revokes the token the instant the config
# GET lands. Two outcomes, both correct, both seen on fsn-01 (the race is the ~5-10 ms re-registration
# round trip vs the 10 ms flush timer): case A — the batch minted under the old epoch meets the 401,
# the host re-registers, the retried batch is rejected `stale-epoch` per event, the instance is
# re-queued and re-minted under the new stream (seq 1); case B — modules-changed took the 401 and the
# registration landed before the flush, so the batch is minted under the new stream at once. Up to 3
# attempts for case A; the case is printed and recorded in the verdict.
STALE_CASE=""; STALE_TRIES=0
$K cp $CODE/trip.js spine:/tmp/reg/trip.js >/dev/null
for attempt in 1 2 3; do
  STALE_TRIES=$attempt
  EPOCH_OLD=$(pyj "print(REG[-1]['reply']['epoch'])"); NEV=$(count /v1/host/events)
  FROM=$(S 'wc -l < /tmp/reg/data/spine.jsonl' | tr -d '\r\n ')
  timeout 10 $K exec spine -- sh -c "cd /tmp/reg && setsid -f node trip.js /tmp/reg/data/spine.jsonl $BOOTSTRAP $INST_B $FROM < /dev/null > /tmp/reg/trip.out 2>&1; echo armed" 2>&1 | sed 's/^/    | trip: /'
  log "row (5c) attempt $attempt: trip armed on the next GET config of $INST_B (epoch $EPOCH_OLD); saving blitzfeed"
  X "$AS1000 sh -c 'printf \"\\n// joint drill: stale-epoch save $attempt\\n\" >> /work/apps/blitzfeed/backend.js'"
  for i in $(seq 1 60); do [ "$(count /v1/host/events)" -ge $((NEV+1)) ] && break; sleep 0.25; done
  sleep 1.5; snap; S 'cat /tmp/reg/trip.out' | sed 's/^/    | /'
  E5=$(pyj "
E=[l for l in L if l.get('path')=='/v1/host/events'][$NEV:]
for l in E: print('    |', l['auth'], l['status'], json.dumps(l['body'])[:100], '→', json.dumps(l['reply']))
seq=[(l['status'], [r['reason'] for r in (l['reply'] or {}).get('rejected',[])] if isinstance(l['reply'],dict) else [], (l['reply'] or {}).get('accepted') if isinstance(l['reply'],dict) else None, l['body'][0]['stream'].split(':')[1] if l['body'] else None, l['body'][0]['seq'] if l['body'] else None) for l in E]
A = len(seq)>=3 and seq[0][0]==401 and seq[0][3]=='$EPOCH_OLD' and seq[1][0]==200 and seq[1][1]==['stale-epoch'] and seq[1][3]=='$EPOCH_OLD' and seq[2][0]==200 and seq[2][2]==1 and seq[2][3]!='$EPOCH_OLD' and seq[2][4]==1
B = len(seq)>=1 and all(x[0]==200 for x in seq) and seq[0][3]!='$EPOCH_OLD' and seq[0][2]==1 and seq[0][4]==1
print('CASE', 'A' if A else 'B' if B else 'NONE', json.dumps(seq))")
  echo "$E5"
  case "$(echo "$E5" | grep '^CASE' | awk '{print $2}')" in A) STALE_CASE=A; break;; B) STALE_CASE=B;; *) STALE_CASE=NONE;; esac
done
$K logs computer -c session > $OUT/launcher-life1.log 2>&1; grep -E 'events:|host-epoch-moved' $OUT/launcher-life1.log | tail -5 | sed 's/^/    | host: /'
log "row (5c): case $STALE_CASE after $STALE_TRIES attempt(s)"
[ "$STALE_CASE" = A ] || [ "$STALE_CASE" = B ] || rowfail 5 "epoch move during a swap: case $STALE_CASE after $STALE_TRIES attempts"
snap; EPOCH5=$(pyj "print(REG[-1]['reply']['epoch'])"); TOKEN5=$(pyj "print(REG[-1]['reply']['token'])")
# (5d) the ring's stale-epoch verdict, injected: the CURRENT token, a frame under the previous epoch
D5=$(CALL POST /v1/host/events "$TOKEN5" "[{\"stream\":\"$HOST_ID:$EPOCH_OLD\",\"topic\":\"$INST_B\",\"seq\":1,\"type\":\"invalidate\"}]"); log "row (5d): injected frame under the revoked epoch $EPOCH_OLD with the live token → $(echo "$D5" | tr '\n' ' ')"
echo "$D5" | grep -q '"rejected":\[{"index":0,"reason":"stale-epoch"}\]' && echo "$D5" | grep -q 'HTTP 200' || rowfail 5 "injected stale frame: $D5"
E5e=$(CALL POST /v1/host/events "$TOKEN3" "[{\"stream\":\"$HOST_ID:$EPOCH3\",\"topic\":\"$INST_B\",\"seq\":9,\"type\":\"invalidate\"}]"); log "row (5e): a batch under a revoked epoch with its (revoked) token → $(echo "$E5e" | tr '\n' ' ')"
echo "$E5e" | grep -q 'host-epoch-moved' && echo "$E5e" | grep -q 'HTTP 401' || rowfail 5 "revoked token on /v1/host/events: $E5e"
RING_B=$(X "curl -s $SPINE_URL/_drill/events?topic=$INST_B"); echo "$RING_B" > $OUT/ring-blitzfeed-after.json; log "row (5c): ring for blitzfeed now: $(echo "$RING_B" | python3 -c 'import json,sys; j=json.load(sys.stdin); print([(e["stream"].split(":")[1][:6], e["seq"]) for e in j["events"]], j["epoch"])')"

# ---- row (3b): rename → 200 renamed; folder removed → unlink tombstone; re-created → revived, same instance
RN=$(CALL PUT /v1/apps/$INST_B "$TOKEN5" '{"slug":"blitzfeed-x","meta":{"name":"BlitzFeed"}}'); log "row (3b): PUT rename blitzfeed → blitzfeed-x: $(echo "$RN" | tr '\n' ' ')"
echo "$RN" | grep -q '"renamed":true' && echo "$RN" | grep -q 'HTTP 200' || rowfail 3 "rename: $RN"
RN2=$(CALL PUT /v1/apps/$INST_B "$TOKEN5" '{"slug":"blitzfeed","meta":{"name":"BlitzFeed"}}'); echo "$RN2" | grep -q '"renamed":true' || rowfail 3 "rename back: $RN2"
RN3=$(CALL PUT /v1/apps/$INST_B "$TOKEN5" '{"slug":"blitzfeed","meta":{"name":"BlitzFeed"}}'); echo "$RN3" | grep -q '"renamed":false' || rowfail 3 "same slug again: $RN3"
log "row (3b): rm -rf /work/apps/probe as uid 1000 → unlink"
NUL=$(count "/v1/apps/$INST_P/unlink"); t0=$(now)
X "$AS1000 rm -rf /work/apps/probe"
for i in $(seq 1 80); do [ "$(count "/v1/apps/$INST_P/unlink")" -gt "$NUL" ] && break; sleep 0.25; done
T_UNLINK=$(el $t0); snap
U3=$(pyj "U=[l for l in L if l.get('path')=='/v1/apps/$INST_P/unlink']; print(len(U), [(l['status'], l['reply']) for l in U])"); log "row (3b): unlink $T_UNLINK s after the rm: $U3"
echo "$U3" | grep -q "^1 \[(200, {'tombstone_at': [0-9]" || rowfail 3 "unlink: $U3"
STATE | python3 -c "import json,sys; a=[x for x in json.load(sys.stdin)['apps'] if x['instance']=='$INST_P'][0]; print('    | spine row:', a['slug'], 'tombstone_at', a['tombstone_at']); assert a['tombstone_at']" || rowfail 3 "no tombstone on the spine row"
X 'grep -E "unlinked|removed" /work/.atelier/agent.log | tail -1' | sed 's/^/    | agent.log: /'
log "row (3b): re-create the folder within 24 h → revived with the same instance id"
NPUT=$(count /v1/apps/$INST_P); t0=$(now)
X "$AS1000 cp -r /code/drill-apps/probe /work/apps/probe"
for i in $(seq 1 80); do [ "$(count /v1/apps/$INST_P)" -gt "$NPUT" ] && break; sleep 0.25; done
T_REVIVE=$(el $t0); snap
V3=$(pyj "P=[l for l in L if l.get('method')=='PUT' and l['path']=='/v1/apps/$INST_P']; print(len(P), P[-1]['status'], json.dumps(P[-1]['reply']))"); log "row (3b): PUT $T_REVIVE s after the copy: $V3"
echo "$V3" | grep -q '200 {"instance_id": "'$INST_P'", "updated": true, "renamed": false, "revived": true}' || rowfail 3 "revive: $V3"
for i in $(seq 1 100); do apps | python3 -c "import json,sys; a=[r for r in json.load(sys.stdin) if r['slug']=='probe']; sys.exit(0 if a and a[0]['state']=='live' and a[0]['instance']=='$INST_P' else 1)" 2>/dev/null && break; sleep 0.2; done
PR="$(apps | python3 -c "import json,sys; a=[r for r in json.load(sys.stdin) if r['slug']=='probe'][0]; print(a['instance'], a['state'])") $(X "cat /work/.atelier/$INST_P/uid" | tr -d '\r\n ')"; log "row (3b): probe after the revive (instance state uid-marker): $PR"
echo "$PR" | grep -q "^$INST_P live $UID_P$" || rowfail 3 "probe after revive: $PR"
STATE | python3 -c "import json,sys; a=[x for x in json.load(sys.stdin)['apps'] if x['instance']=='$INST_P'][0]; assert a['tombstone_at'] is None" || rowfail 3 "tombstone not cleared"
X 'grep -E "revived|adopted|claimed" /work/.atelier/agent.log | tail -1' | sed 's/^/    | agent.log: /'
P7b=$(DEV /api/acme/probe/probe | python3 -c 'import json,sys; j=json.load(sys.stdin); print(j["DRILL_CONFIG"])' 2>/dev/null); log "row (3b/7): the revived worker's DRILL_CONFIG = $P7b (config keyed by the instance survived the tombstone)"

# ---- row (4b): host restart → register().apps carries uid + rev
snap; EXP4=$(pyj "
M=[a for l in L if l.get('path')=='/v1/host/modules-changed' for a in l['body']['apps']]
last={}
for a in M: last[a['instance']]=(a['uid'],a['rev'])
print(json.dumps(last))")
log "row (4b): kill -9 the host (pid $HOST0) → launcher restart → register; expected uid/rev from the last modules-changed: $EXP4"
NREG=$(count /v1/host/register); t0=$(now); X "kill -9 $HOST0"
for i in $(seq 1 100); do [ "$(count /v1/host/register)" -gt "$NREG" ] && break; sleep 0.2; done
T_RESTART=$(el $t0); HOST1=$(hostpid); sleep 0.5; snap
A4=$(pyj "
r=REG[-1]; got={a['instance']:[a['uid'],a['rev']] for a in r['reply']['apps']}
exp=json.loads('$EXP4'); print(json.dumps(got), 'tombstones', [a['tombstone_at'] for a in r['reply']['apps']], 'match' if got==exp else 'MISMATCH '+json.dumps(exp))")
log "row (4b): host $HOST0 → $HOST1, re-registered $T_RESTART s after the kill; register().apps = $A4"
echo "$A4" | grep -q ' match$' && [ -n "$HOST1" ] && [ "$HOST1" != "$HOST0" ] || rowfail 4 "register().apps after the host restart: $A4"
$K logs computer -c session | grep -E 'boot:|registered|snapshot' | tail -3 | sed 's/^/    | host: /'
X "cat /work/.atelier/$INST_B/uid /work/.atelier/$INST_P/uid" | tr '\n' ' ' | sed 's/^/    | uid markers: /'; echo

# ---- row (8): draining on SIGTERM
log "row (8): kill -TERM 1 → POST /v1/host/draining, container restart, the second life registers (draining_at cleared)"
$K logs computer -c session > $OUT/launcher-life1.log 2>&1
NDR=$(count /v1/host/draining); t0=$(now); X 'kill -TERM 1'
for i in $(seq 1 100); do [ "$(count /v1/host/draining)" -gt "$NDR" ] && break; sleep 0.2; done
T_DRAIN=$(el $t0)
DR=$(STATE | python3 -c "import json,sys; h=json.load(sys.stdin)['hosts'][0]; print(h['draining_at'], h['epoch'])"); log "row (8): draining $T_DRAIN s after SIGTERM; computer row draining_at/epoch right after: $DR"
for i in $(seq 1 300); do rc=$($K get pod computer -o jsonpath='{.status.containerStatuses[0].restartCount}'); [ "$rc" = 1 ] && break; sleep 0.2; done
log "row (8): restartCount=$rc after $(el $t0) s"; [ "$rc" = 1 ] || rowfail 8 "no container restart within 60 s"
RDY2=$(waitready 90); log "row (8): Ready again $RDY2 s later — $(readyq)"; [ "$RDY2" = timeout ] && rowfail 8 "not Ready after the restart"
sleep 0.5; snap
D8=$(pyj "
D=[l for l in L if l.get('path')=='/v1/host/draining']; r=REG[-1]
print(len(D), [l['status'] for l in D], 'draining→register', round((r['at']-D[-1]['at'])/1000,2), 's; apps in reply', len(r['reply']['apps']))
assert len(D)==1 and D[0]['status']==200 and r['at']>D[-1]['at']"); rc=$?
log "row (8): $D8"; [ $rc = 0 ] || rowfail 8 "$D8"
echo "$DR" | grep -q '^[0-9]\{13\} ' && log "row (8): draining_at was set before the second life registered" || log "row (8): draining_at snapshot raced the second life's register (the draining line is the proof)"
STATE > $OUT/state-final.json
python3 -c "import json; h=json.load(open('$OUT/state-final.json'))['hosts'][0]; print('    | after the second life:', {k:h[k] for k in ('epoch','draining_at','pod_ip','visible_apps')}); assert h['draining_at'] is None" || rowfail 8 "draining_at not cleared by the second life's register"
$K logs computer -c session --previous > $OUT/launcher-life1-prev.log 2>&1; $K logs computer -c session > $OUT/launcher-life2-boot.log 2>&1
grep -E 'teardown|stopped|SIGTERM|draining' $OUT/launcher-life1-prev.log | sed 's/^/    | prev: /'
X 'cat /work/.atelier/agent.log' > $OUT/agent-log-final.txt
grep -q 'host: stopped' $OUT/agent-log-final.txt || rowfail 8 "no 'host: stopped' in agent.log"
DT=$(X 'cat /run/atelier/dev.token' | tr -d '\r\n'); S2=$(DEV /api/acme/blitzfeed/state | head -c 40); log "row (8): first request of the second life → ${S2:0:40}"
X 'grep RESUMED /work/.atelier/agent.log | tail -1' | sed 's/^/    | agent.log: /'

# ---- evidence
snap; cp $OUT/spine.jsonl $OUT/spine-final.jsonl; S 'cat /tmp/reg/serve.out' > $OUT/serve.out 2>&1
X "find /work/.atelier /run/atelier -printf '%m %u:%g %p\n' | sort" > $OUT/tree-final.txt 2>&1
S 'ls -ln /tmp/reg/data' > $OUT/spine-data-dir.txt 2>&1
python3 -c "import json; L=[json.loads(l) for l in open('$OUT/spine-final.jsonl') if l.strip()]; from collections import Counter; print('    | spine calls:', dict(Counter((l.get('method') or l.get('lane'), l.get('path') or '', l.get('status')) for l in L)))"
log "== VERDICT"
SUM="1:${R[1]} 2:${R[2]} 3:${R[3]} 4:${R[4]} 5:${R[5]} 6:${R[6]} 7:${R[7]} 8:${R[8]}"
[ $FAILS = 0 ] && echo "VERDICT: PASS — $SUM; host $HOST_ID epochs $EPOCH1→$EPOCH2(forced)→$EPOCH3→…→$EPOCH5; Ready ${RDY}s after staging; 2 apps live ${T_LIVE}s after the copy; app-error 1; unlink ${T_UNLINK}s; revive ${T_REVIVE}s; host-restart re-register ${T_RESTART}s; draining ${T_DRAIN}s; stale-epoch case $STALE_CASE in $STALE_TRIES attempt(s)" \
                || echo "VERDICT: FAIL — $SUM"
