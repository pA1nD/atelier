#!/bin/bash
# Runs ON fsn-01 (root, kubectl). Throwaway ns spike-seeded, deleted by trap; production namespaces are never touched (only
# `ghcr-pull` is copied out of `agents`, read-only). Ends in VERDICT. Row 9s — the SEEDED road (DESIGN §10.3 "seeded rows")
# on the integrated host under the REAL permission model (review 2026-09-02, B1/S1/S2: macOS cannot show any of it — setgroups
# is a no-op there and the folders are 0755): the step-2 pod with ATELIER_SEEDED_APPS=1 in its env and a folder seeded by
# seed.sh (uid 1000, `.atelier-seeded` + `.image-stamp`, the portal entrypoint's shape) BEFORE the launcher runs.
#   9s-a  Ready ⇒ LIVE (S1): the first /_atelier/apps answer after the pod turns Ready already shows seedy prod-live at
#         rev 1 with a 40-hex deployed_rev and no dev slot; the host log has `rev 1 LIVE (prod)`, `host: ready … after the
#         first scan`, never `module.json missing`, never a `(dev)` line for seedy
#   9s-b  the permission model is REAL and the road holds the gid (B1): the folder is `1000:<uid> 2750` after the claim, root
#         (no DAC_OVERRIDE) cannot read its module.json, the host's env carries ATELIER_SEEDED_APPS=1
#   9s-c  the prod road answers: the signer's assertion from the peer against :1845 → 200 `pong`
#   9s-d  the release: releases.jsonl holds ONE adopt row (commit = deployed_rev, `at` a ms epoch) and the fake spine saw the
#         POST /v1/host/release (it answers 404 — tolerated)
#   9s-e  R14 on the pod (S2): 70 s quiet → `rev 1 STOPPED`, prod_state stopped, no worker process; the next request from
#         the peer → 200 and `rev 1 RESUMED`
#   9s-f  a re-seed over the kept /work: uid 1000 changes a byte in the folder → within a sweep rev 2 LIVE (prod), a new
#         40-hex deployed_rev, a second adopt row, the prod road answers
set -u
NS=spike-seeded; K="kubectl -n $NS"; CODE=/tmp/$NS-code; OUT=$CODE/out; mkdir -p $OUT; rm -f $OUT/*
IMAGE=$(cat $CODE/image.txt)
ts(){ date +%T.%3N; }; now(){ date +%s.%N | cut -c1-14; }
log(){ echo "[$(ts)] $*"; }
el(){ python3 -c "print(round($(now)-$1,2))"; }
declare -A R; for r in 9s-a 9s-b 9s-c 9s-d 9s-e 9s-f; do R[$r]=PASS; done
FAILS=0
rowfail(){ FAILS=$((FAILS+1)); R[$1]="FAIL($2)"; log "FAIL row $1: $2"; }
cleanup(){ log "cleanup: deleting ns $NS"; kubectl delete ns $NS --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT
X(){ $K exec computer -c session -- bash -c "$1" 2>&1; }
P(){ $K exec peer -- bash -c "$1" 2>&1; }
AS1000="setpriv --reuid=1000 --regid=1000 --groups=19999"
readyq(){ $K get pod computer -o jsonpath='{.status.conditions[?(@.type=="Ready")].status} rc={.status.containerStatuses[0].restartCount} phase={.status.phase}' 2>/dev/null; }
waitready(){ local max=$1 t0=$(now); for i in $(seq 1 $((max*5))); do case "$(readyq)" in True*) echo "$(el $t0)"; return 0;; esac; sleep 0.2; done; echo "timeout"; return 1; }
py(){ python3 -c "$1"; }
D(){ X "curl -s --max-time 10 'http://127.0.0.1:1844$1$(case "$1" in *\?*) echo '&';; *) echo '?';; esac)token=$DT'"; }
apps(){ D /_atelier/apps; }
appfield(){ apps | py "import json,sys; a=[r for r in json.load(sys.stdin) if r['slug']=='$1']; v=a[0].get('$2') if a else ''; print('' if v is None else v)"; }
hostlog(){ $K logs computer -c session 2>&1; }
agentlog(){ X 'cat /work/.atelier/agent.log 2>/dev/null'; }
PING(){ P "cd /code && node host/drill/step2/signer.mjs GET http://$IP:1845/api/acme/seedy/ping --app $INST"; }

log "other spike namespaces on the node (untouched): $(kubectl get ns -o name | grep 'spike-' | grep -v "/$NS\$" | tr '\n' ' ')"
kubectl delete ns $NS --wait=true --timeout=90s >/dev/null 2>&1 || true
kubectl create ns $NS >/dev/null || { echo "VERDICT: BLOCKED — cannot create ns"; exit 1; }
kubectl -n agents get secret ghcr-pull -o json | python3 -c 'import json,sys; s=json.load(sys.stdin); print(json.dumps({"apiVersion":"v1","kind":"Secret","type":s["type"],"metadata":{"name":"ghcr-pull","namespace":"'$NS'"},"data":s["data"]}))' | $K apply -f - >/dev/null || { echo "VERDICT: BLOCKED — ghcr-pull copy failed"; exit 1; }
log "image (metal/clusters/prod/spine.yaml AGENT_IMAGE): $IMAGE"

# ---- the peer: fake spine (step 2's) + signer, outside the computer pod
sed "s#__IMAGE__#$IMAGE#g; s#__NS__#$NS#g" $CODE/peer.yaml.tpl | kubectl apply -f - >/dev/null || { echo "VERDICT: BLOCKED — peer apply refused"; exit 1; }
for i in $(seq 1 120); do [ "$($K get pod peer -o jsonpath='{.status.phase}')" = Running ] && break; sleep 1; done
[ "$($K get pod peer -o jsonpath='{.status.phase}')" = Running ] || { echo "VERDICT: BLOCKED — peer not Running"; exit 1; }
$K cp $CODE/code.tgz peer:/tmp/code.tgz || { echo "VERDICT: BLOCKED — kubectl cp to peer failed"; exit 1; }
P 'mkdir -p /code && tar xzf /tmp/code.tgz -C /code 2>&1 | grep -v "Ignoring unknown extended header"; ls /code' | sed 's/^/    | /'
timeout 10 $K exec peer -- bash -c 'cd /code && setsid -f node host/drill/step2/fake-spine.mjs < /dev/null > /tmp/spine.out 2>&1; sleep 1; cat /tmp/spine.out' 2>&1 | sed 's/^/    | /'
PEER_IP=$($K get pod peer -o jsonpath='{.status.podIP}')
P 'curl -s --max-time 3 http://127.0.0.1:7999/_drill/state | head -c 120' | grep -q host_id || { echo "VERDICT: BLOCKED — fake spine not answering on the peer"; exit 1; }
log "peer $PEER_IP: fake spine up"

# ---- the computer: the step-2 pod, SEEDED — ATELIER_SEEDED_APPS=1 in the session container's env (the portal-host image's
# ENV; the launcher keeps ATELIER_* for the host) and seed.sh before the launcher (the portal entrypoint's shape)
sed "s#__IMAGE__#$IMAGE#g; s#__NS__#$NS#g; s#__PEER_IP__#$PEER_IP#g" $CODE/pod.yaml.tpl > $CODE/pod.yaml
python3 - $CODE/pod.yaml <<'PY' || { echo "VERDICT: BLOCKED — the pod template lost the two lines the seeded pod patches (ATELIER_HOST_TLS env, the entrypoint exec)"; exit 1; }
import sys
p = sys.argv[1]; s = open(p).read()
old_exec = "exec bash /code/host/entrypoint.sh"
old_env = "    - { name: ATELIER_HOST_TLS, value: plain }"
assert s.count(old_exec) == 1 and s.count(old_env) == 1, "template drift"
s = s.replace(old_exec, "bash /code/host/drill/rows/seed.sh && " + old_exec)
s = s.replace(old_env, old_env + "\n    - { name: ATELIER_SEEDED_APPS, value: \"1\" }   # the seeded road's gate (DESIGN §10.3): the portal-host image's ENV")
open(p, "w").write(s)
PY
$K apply -f $CODE/pod.yaml >/dev/null || { echo "VERDICT: BLOCKED — pod apply refused"; exit 1; }
log "waiting for the stage init container"
for i in $(seq 1 300); do [ "$($K get pod computer -o jsonpath='{.status.initContainerStatuses[?(@.name=="stage")].state.running.startedAt}' 2>/dev/null)" != "" ] && break; sleep 1; done
$K cp $CODE/code.tgz computer:/tmp/code.tgz -c stage || { echo "VERDICT: BLOCKED — kubectl cp into stage failed"; exit 1; }
t0=$(now)
$K exec computer -c stage -- sh -c 'tar xzf /tmp/code.tgz -C /code 2>&1 | grep -v "Ignoring unknown extended header"; cd /code && timeout 300 npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -3 && ls /code/node_modules/@esbuild /code/node_modules/@tailwindcss && chmod -R a+rX /code && touch /code/.staged && echo STAGED-OK' | tee $OUT/stage.log | sed 's/^/    | /'
grep -q STAGED-OK $OUT/stage.log || { echo "VERDICT: BLOCKED — stage (untar + npm ci) failed after $(el $t0) s"; exit 1; }
log "staged in $(el $t0) s; waiting for Ready (a seeded host: after its first scan built the seeded row)"
RDY=$(waitready 150)
[ "$RDY" = timeout ] && { $K describe pod computer | tail -20; hostlog | tail -40; echo "VERDICT: FAIL — never Ready"; exit 1; }
# ---- row 9s-a: the FIRST apps answer after Ready — no wait loop on purpose: Ready must already mean LIVE
IP=$($K get pod computer -o jsonpath='{.status.podIP}')
DT=$(X 'cat /run/atelier/dev.token' | tr -d '\r\n')
A=$(apps); echo "$A" > $OUT/apps-at-ready.json
log "Ready $RDY s after staging — $(readyq); pod IP $IP; apps at Ready: $A"
hostlog > $OUT/host-boot.log
INST=$(appfield seedy instance); WUID=$(X "cat /work/.atelier/$INST/uid 2>/dev/null" | tr -d '\r\n ')
C1=$(appfield seedy deployed_rev)
log "row 9s-a: seedy instance=$INST uid=$WUID prod_state=$(appfield seedy prod_state) prod_rev=$(appfield seedy prod_rev) dev_rev=$(appfield seedy dev_rev) deployed_rev=$C1"
[ "$(appfield seedy prod_state)" = live ] || rowfail 9s-a "not prod-live at Ready: prod_state='$(appfield seedy prod_state)' (S1: host-ready must follow the first scan)"
[ "$(appfield seedy prod_rev)" = 1 ] || rowfail 9s-a "prod_rev is '$(appfield seedy prod_rev)', want 1"
[ -z "$(appfield seedy dev_rev)" ] || rowfail 9s-a "a dev slot exists (dev_rev=$(appfield seedy dev_rev)) — a seeded row must have none"
echo "$C1" | grep -qE '^[0-9a-f]{40}$' || rowfail 9s-a "deployed_rev is not 40 hex: '$C1'"
grep -E "\[seedy\]|host: ready|seeded" $OUT/host-boot.log | sed 's/^/    | host: /'
grep -q "\[seedy\] rev 1 LIVE (prod) commit ${C1:0:12}" $OUT/host-boot.log || rowfail 9s-a "no '[seedy] rev 1 LIVE (prod) commit ${C1:0:12}' line in the host log"
grep -q "host: ready .*seeded host: after the first scan" $OUT/host-boot.log || rowfail 9s-a "the 'host: ready' line does not say 'seeded host: after the first scan'"
grep -q "module.json missing" $OUT/host-boot.log && rowfail 9s-a "'module.json missing' in the host log — the B1 outage signature (a read without the gid)"
grep -qE "\[seedy\].*\(dev\)" $OUT/host-boot.log && rowfail 9s-a "a '(dev)' line for seedy — the new-folder road ran"
grep -q "\[seedy\] seeded: rev 1" $OUT/host-boot.log || rowfail 9s-a "no '[seedy] seeded: rev 1 …' line"

# ---- row 9s-b: the permission model is real, and the road holds the gid
OWN=$(X "stat -c '%a %u:%g' /work/apps/seedy" | tr -d '\r\n'); MJ=$(X "cat /work/apps/seedy/module.json 2>&1 | grep -c 'Permission denied'; true" | tr -d '\r\n ')
HPID=$(X "pgrep -f 'host/index.mjs' | head -1" | tr -d '\r\n '); HENV=$(X "tr '\\0' '\\n' < /proc/${HPID:-0}/environ 2>/dev/null | grep '^ATELIER_SEEDED_APPS='" | tr -d '\r\n')
log "row 9s-b: /work/apps/seedy is $OWN (want 2750 1000:$WUID); root reading its module.json → EACCES lines: $MJ (want 1: no DAC_OVERRIDE); host pid $HPID env: '$HENV'"
[ "$OWN" = "2750 1000:$WUID" ] || rowfail 9s-b "the claimed folder is $OWN, not 2750 1000:$WUID"
[ "$MJ" = 1 ] || rowfail 9s-b "root CAN read the claimed folder's module.json — the permission model this drill exists for is not in force here"
[ "$HENV" = "ATELIER_SEEDED_APPS=1" ] || rowfail 9s-b "the host's env does not carry ATELIER_SEEDED_APPS=1 ('$HENV')"
X "ls -lan /work/apps/seedy" | sed 's/^/    | /'

# ---- row 9s-c: the prod road from the peer
PING > $OUT/prod-1.txt; sed 's/^/    | prod: /' $OUT/prod-1.txt
grep -q '^STATUS 200' $OUT/prod-1.txt && grep -q '"pong"' $OUT/prod-1.txt || rowfail 9s-c "the prod road does not answer the seeded app: $(head -1 $OUT/prod-1.txt)"

# ---- row 9s-d: the release row
X "cat /work/.atelier/$INST/releases.jsonl 2>/dev/null" > $OUT/releases-1.jsonl; sed 's/^/    | releases.jsonl: /' $OUT/releases-1.jsonl
REL=$(python3 - $OUT/releases-1.jsonl "$C1" <<'PY'
import json, sys, time
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
ok = len(rows) == 1 and rows[0].get('kind') == 'adopt' and rows[0].get('commit') == sys.argv[2] and isinstance(rows[0].get('at'), int) and abs(time.time()*1000 - rows[0]['at']) < 600_000
print('ok' if ok else f"bad: {[(r.get('kind'), r.get('commit', '')[:12], type(r.get('at')).__name__) for r in rows]}")
PY
)
NREL=$(P 'curl -s --max-time 3 http://127.0.0.1:7999/_drill/log' | grep -c '"/v1/host/release"')
log "row 9s-d: releases.jsonl: $REL; the fake spine saw $NREL POST(s) to /v1/host/release (answered 404 — tolerated, retried each scan)"
[ "$REL" = ok ] || rowfail 9s-d "releases.jsonl is not ONE adopt row with commit=$C1 and a ms at: $REL"
[ "${NREL:-0}" -ge 1 ] 2>/dev/null || rowfail 9s-d "the spine never saw the adopt row"

# ---- row 9s-e: R14 on the real pod — 70 s quiet (idleMs 60 s), then the first request resumes
log "row 9s-e: 70 s quiet for the prod idle window (idleMs 60 s)"
sleep 70
hostlog > $OUT/host-idle.log
ST=$(appfield seedy prod_state); WP=$(X "pgrep -u $WUID | wc -l" | tr -d '\r\n ')
log "row 9s-e: after 70 s: prod_state=$ST (want stopped), processes of uid $WUID: $WP (want 0)"
grep -q "\[seedy\] rev 1 STOPPED" $OUT/host-idle.log || rowfail 9s-e "no '[seedy] rev 1 STOPPED' line after 70 s quiet"
grep -qE "\[seedy\] rev 1 STOPPED \(dev\)" $OUT/host-idle.log && rowfail 9s-e "a dev STOPPED line"
[ "$ST" = stopped ] || rowfail 9s-e "prod_state after the window is '$ST'"
[ "$WP" = 0 ] || rowfail 9s-e "$WP process(es) of the worker uid still alive after the stop"
t0=$(now); PING > $OUT/prod-2.txt; T2=$(el $t0); sed 's/^/    | prod after idle: /' $OUT/prod-2.txt
grep -q '^STATUS 200' $OUT/prod-2.txt && grep -q '"pong"' $OUT/prod-2.txt || rowfail 9s-e "the first request after the stop is not 200: $(head -1 $OUT/prod-2.txt) (S2: never a 404, held and answered)"
hostlog | grep -q "\[seedy\] rev 1 RESUMED" || rowfail 9s-e "no '[seedy] rev 1 RESUMED' line"
log "row 9s-e: the resume answered in $T2 s: $(hostlog | grep -o '\[seedy\] rev 1 RESUMED [0-9]* ms' | tail -1)"

# ---- row 9s-f: a re-seed over the kept /work — new bytes, the next sweep (≤ 30 s) is a new rev
X "$AS1000 sh -c 'echo \"// re-seed\" >> /work/apps/seedy/backend.js'" | sed 's/^/    | /'
t0=$(now)
for i in $(seq 1 300); do [ "$(appfield seedy prod_rev)" = 2 ] && break; sleep 0.2; done
C2=$(appfield seedy deployed_rev)
log "row 9s-f: after $(el $t0) s: prod_rev=$(appfield seedy prod_rev) prod_state=$(appfield seedy prod_state) deployed_rev=$C2 (was ${C1:0:12})"
[ "$(appfield seedy prod_rev)" = 2 ] || rowfail 9s-f "no rev 2 within 60 s of the byte change"
echo "$C2" | grep -qE '^[0-9a-f]{40}$' && [ "$C2" != "$C1" ] || rowfail 9s-f "deployed_rev did not move to a new 40-hex id: '$C2'"
hostlog | grep -q "\[seedy\] rev 2 LIVE (prod) commit ${C2:0:12}" || rowfail 9s-f "no '[seedy] rev 2 LIVE (prod) commit ${C2:0:12}' line"
PING > $OUT/prod-3.txt; grep -q '^STATUS 200' $OUT/prod-3.txt || rowfail 9s-f "the prod road after the re-seed: $(head -1 $OUT/prod-3.txt)"
X "cat /work/.atelier/$INST/releases.jsonl 2>/dev/null" > $OUT/releases-2.jsonl
[ "$(grep -c '"kind":"adopt"' $OUT/releases-2.jsonl)" = 2 ] || rowfail 9s-f "releases.jsonl does not hold two adopt rows: $(cat $OUT/releases-2.jsonl | cut -c1-200)"

agentlog > $OUT/agent-log-final.txt; hostlog > $OUT/host-final.log; apps > $OUT/apps-final.json
X "find /work/.atelier -maxdepth 3 -printf '%m %u:%g %p\n' | sort" > $OUT/tree-final.txt 2>&1

log "== VERDICT"
SUM="9s-a:${R[9s-a]} 9s-b:${R[9s-b]} 9s-c:${R[9s-c]} 9s-d:${R[9s-d]} 9s-e:${R[9s-e]} 9s-f:${R[9s-f]}"
[ $FAILS = 0 ] && echo "VERDICT: PASS — $SUM; Ready $RDY s ⇒ seedy rev 1 LIVE (prod) ${C1:0:12} (folder $OWN, root EACCES, the host configured); prod road 200; one adopt row (ms at), the spine saw $NREL; idle: STOPPED after 70 s, the first request 200 in $T2 s + RESUMED; re-seed → rev 2 ${C2:0:12}" \
                || echo "VERDICT: FAIL — $SUM"
