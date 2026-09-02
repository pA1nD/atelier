#!/bin/bash
# Runs ON fsn-01 (root, kubectl). Throwaway ns spike-step7-deploy, deleted by trap; production namespaces are never
# touched (only `ghcr-pull` is copied out of `agents`, read-only). Ends in VERDICT. The integrated host (step-2 pod +
# fake spine) under DESIGN §10.3's row 9 — the release protocol in the userns jail:
#   9t  `node --test host/test/*.test.js` inside the pod (as uid 1000: every row green, the Mac suite's twin)
#   9a  `atelier deploy` (the CLI as uid 1000, the dev token) → green; the export prod/<inst>/<c12> is 0:<uid> 0750 /
#       0640: EACCES as uid 1000, readable as the worker uid; the prod worker's cwd
#   9b  the deploy hook ran as <uid> with the spine's config key (DRILL_CONFIG) and without any token
#   9c  a second deploy backs prod data up: backup/<inst>/<id> is 0:19999 0750 — EACCES for the worker, readable as
#       uid 1000 (group 19999), the pre-migration bytes inside
#   9d  `locker` (node:sqlite, EXCLUSIVE lock, writing every 50 ms) deploys green 3/3 under a 50 ms loop on the PROD
#       road (the signer's assertions from the peer, the protocol port): 0 non-200, max latency < the 10 s hold
#   9e  `deps` (better-sqlite3 prebuild + the loot-pkg tgz + core-js): the dev install first, then `atelier deploy` runs
#       the rehearsal's install in the export — `freeze.py take` (the dev tree keeps its node_modules) → npm from the
#       warm cache → `freeze.py --dest`: the export's node_modules is 0:<uid> (readable as the worker), the prod worker
#       createRequire's all three from its cwd; a second deploy under the 50 ms loop MEASURES the install hold (the
#       freeze SIGKILLs the worker uid; requests wait ≤ 10 s, then the waking 503) — logged, only mixed revs fail it
set -u
NS=spike-step7-deploy; K="kubectl -n $NS"; CODE=/tmp/$NS-code; OUT=$CODE/out; mkdir -p $OUT; rm -f $OUT/*
IMAGE=$(cat $CODE/image.txt)
ts(){ date +%T.%3N; }; now(){ date +%s.%N | cut -c1-14; }
log(){ echo "[$(ts)] $*"; }
el(){ python3 -c "print(round($(now)-$1,2))"; }
declare -A R; for r in 9t 9a 9b 9c 9d 9e; do R[$r]=PASS; done
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
# the CLI as uid 1000 inside the pod (the image's /usr/local/bin/atelier symlink is lane K's; the file is the same)
CLI(){ X "$AS1000 env HOME=/work ATELIER_DEV_TOKEN_FILE=/run/atelier/session/dev.token node /code/host/devcli.mjs $1"; }

log "other spike namespaces on the node (untouched): $(kubectl get ns -o name | grep 'spike-' | grep -v "/$NS\$" | tr '\n' ' ')"
kubectl delete ns $NS --wait=true --timeout=90s >/dev/null 2>&1 || true
kubectl create ns $NS >/dev/null || { echo "VERDICT: BLOCKED — cannot create ns"; exit 1; }
kubectl -n agents get secret ghcr-pull -o json | python3 -c 'import json,sys; s=json.load(sys.stdin); print(json.dumps({"apiVersion":"v1","kind":"Secret","type":s["type"],"metadata":{"name":"ghcr-pull","namespace":"'$NS'"},"data":s["data"]}))' | $K apply -f - >/dev/null || { echo "VERDICT: BLOCKED — ghcr-pull copy failed"; exit 1; }
log "image (metal/clusters/prod/spine.yaml AGENT_IMAGE): $IMAGE"

# ---- the peer: fake spine (step 2's) + signer + loop, outside the computer pod
sed "s#__IMAGE__#$IMAGE#g; s#__NS__#$NS#g" $CODE/peer.yaml.tpl | kubectl apply -f - >/dev/null || { echo "VERDICT: BLOCKED — peer apply refused"; exit 1; }
for i in $(seq 1 120); do [ "$($K get pod peer -o jsonpath='{.status.phase}')" = Running ] && break; sleep 1; done
[ "$($K get pod peer -o jsonpath='{.status.phase}')" = Running ] || { echo "VERDICT: BLOCKED — peer not Running"; exit 1; }
$K cp $CODE/code.tgz peer:/tmp/code.tgz || { echo "VERDICT: BLOCKED — kubectl cp to peer failed"; exit 1; }
P 'mkdir -p /code && tar xzf /tmp/code.tgz -C /code 2>&1 | grep -v "Ignoring unknown extended header"; ls /code' | sed 's/^/    | /'
timeout 10 $K exec peer -- bash -c 'cd /code && setsid -f node host/drill/step2/fake-spine.mjs < /dev/null > /tmp/spine.out 2>&1; sleep 1; cat /tmp/spine.out' 2>&1 | sed 's/^/    | /'
PEER_IP=$($K get pod peer -o jsonpath='{.status.podIP}')
P 'curl -s --max-time 3 http://127.0.0.1:7999/_drill/state | head -c 120' | grep -q host_id || { echo "VERDICT: BLOCKED — fake spine not answering on the peer"; exit 1; }
log "peer $PEER_IP: fake spine up"

# ---- the computer: stage the tree (+ npm ci), then the §4.3 pod boots the real launcher + host
sed "s#__IMAGE__#$IMAGE#g; s#__NS__#$NS#g; s#__PEER_IP__#$PEER_IP#g" $CODE/pod.yaml.tpl | kubectl apply -f - >/dev/null || { echo "VERDICT: BLOCKED — pod apply refused"; exit 1; }
log "waiting for the stage init container"
for i in $(seq 1 300); do [ "$($K get pod computer -o jsonpath='{.status.initContainerStatuses[?(@.name=="stage")].state.running.startedAt}' 2>/dev/null)" != "" ] && break; sleep 1; done
$K cp $CODE/code.tgz computer:/tmp/code.tgz -c stage || { echo "VERDICT: BLOCKED — kubectl cp into stage failed"; exit 1; }
t0=$(now)
$K exec computer -c stage -- sh -c 'tar xzf /tmp/code.tgz -C /code 2>&1 | grep -v "Ignoring unknown extended header"; cd /code && timeout 300 npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -3 && ls /code/node_modules/@esbuild /code/node_modules/@tailwindcss && chmod -R a+rX /code && touch /code/.staged && echo STAGED-OK' | tee $OUT/stage.log | sed 's/^/    | /'
grep -q STAGED-OK $OUT/stage.log || { echo "VERDICT: BLOCKED — stage (untar + npm ci) failed after $(el $t0) s"; exit 1; }
log "staged in $(el $t0) s; waiting for Ready"
RDY=$(waitready 120)
[ "$RDY" = timeout ] && { $K describe pod computer | tail -20; hostlog | tail -40; echo "VERDICT: FAIL — never Ready"; exit 1; }
IP=$($K get pod computer -o jsonpath='{.status.podIP}')
log "Ready $RDY s after staging — $(readyq); pod IP $IP"
hostlog > $OUT/host-boot.log
DT=$(X 'cat /run/atelier/dev.token' | tr -d '\r\n')

# ---- row 9t: the whole suite inside the pod, as uid 1000 (the same rows the Mac runs), bounded
log "row 9t: node --test host/test/*.test.js inside the pod as uid 1000 (≤ 600 s)"
t0=$(now)
X "cd /code && $AS1000 env HOME=/tmp TMPDIR=/tmp timeout 600 node --test host/test/*.test.js 2>&1" > $OUT/pod-tests.log; grep -E '^(✖|not ok)|^ℹ (tests|pass|fail)' $OUT/pod-tests.log | head -20 | sed 's/^/    | /'
TP=$(grep -o 'ℹ pass [0-9]*' $OUT/pod-tests.log | awk '{print $3}'); TF=$(grep -o 'ℹ fail [0-9]*' $OUT/pod-tests.log | awk '{print $3}')
log "row 9t: pass=${TP:-?} fail=${TF:-?} in $(el $t0) s"
[ "${TF:-1}" = 0 ] && [ -n "$TP" ] || rowfail 9t "pass=${TP:-?} fail=${TF:-?}"

# ---- the agent puts the apps in place (uid 1000): locker (sqlite exclusive; its module.json carries a deploy hook that records who ran it) + hello (the peer)
X "$AS1000 sh -c 'for a in locker hello; do cp -r /code/drill-apps/\$a /work/apps/\$a; done; ls -ldn /work/apps/*; cat /work/apps/locker/module.json'" | sed 's/^/    | /'
T_SAVE=$(now)
for i in $(seq 1 150); do
  apps | py 'import json,sys; a=json.load(sys.stdin); sys.exit(0 if {r["slug"] for r in a if r["dev_state"]=="live"}=={"locker","hello"} else 1)' 2>/dev/null && break
  sleep 0.2
done
A=$(apps); log "apps after $(el $T_SAVE) s: $A"; echo "$A" > $OUT/apps-after-scan.json
echo "$A" | py 'import json,sys; a=json.load(sys.stdin); sys.exit(0 if {r["slug"] for r in a if r["dev_state"]=="live"}=={"locker","hello"} else 1)' 2>/dev/null || { hostlog | tail -30; echo "VERDICT: FAIL — apps not dev-live within 30 s: $A"; exit 1; }
INST=$(appfield locker instance); WUID=$(X "cat /work/.atelier/$INST/uid" | tr -d '\r\n ')
log "locker: instance $INST uid $WUID; prod before any deploy: state=$(appfield locker state) prod_rev=$(appfield locker prod_rev) deployed_rev=$(appfield locker deployed_rev)"
[ "$(appfield locker state)" = undeployed ] || rowfail 9a "a new folder is not 'undeployed' before its first deploy: $(appfield locker state)"
AS_WORKER="setpriv --reuid=$WUID --regid=$WUID --clear-groups"

# ---- row 9a: the first deploy — the CLI as uid 1000; the export's ownership
log "row 9a: atelier deploy locker -m 'first release' (the CLI as uid 1000)"
t0=$(now); CLI 'deploy locker -m "first release"' > $OUT/deploy-1.log; RC1=$?; sed 's/^/    | /' $OUT/deploy-1.log
log "row 9a: rc=$RC1 in $(el $t0) s; row: state=$(appfield locker state) prod_rev=$(appfield locker prod_rev) dev_rev=$(appfield locker dev_rev) deployed_rev=$(appfield locker deployed_rev)"
grep -q '^deploy green: locker rev [0-9]* commit [0-9a-f]\{12\} live — ' $OUT/deploy-1.log && [ "$RC1" = 0 ] || rowfail 9a "the CLI did not print the green line / exit 0 (rc=$RC1)"
C1=$(appfield locker deployed_rev); C12=${C1:0:12}
[ "${#C1}" = 40 ] || rowfail 9a "deployed_rev is not 40 hex: '$C1'"
EXP=/work/.atelier/prod/$INST/$C12
TREE=$(X "find $EXP -printf '%m %U:%G %y %p\n' | sort"); echo "$TREE" > $OUT/export-tree.txt; echo "$TREE" | head -8 | sed 's/^/    | /'
echo "$TREE" | grep -q "^750 0:$WUID d $EXP\$" || rowfail 9a "the export dir is not 0:$WUID 0750: $(echo "$TREE" | grep " $EXP\$")"
echo "$TREE" | grep " f " | grep -vq "^640 0:$WUID f " && rowfail 9a "an export file is not 0:$WUID 0640: $(echo "$TREE" | grep ' f ' | grep -v "^640 0:$WUID f " | head -2)"
E1000=$(X "$AS1000 cat $EXP/backend.js 2>&1 | grep -c 'Permission denied'; true" | tr -d '\r\n '); EW=$(X "$AS_WORKER head -c 40 $EXP/backend.js 2>&1 | grep -c 'Permission denied'; true" | tr -d '\r\n ')
log "row 9a: export as uid 1000 → EACCES lines: $E1000 (want 1); as the worker uid $WUID → EACCES lines: $EW (want 0)"
[ "$E1000" = 1 ] || rowfail 9a "the export is readable by uid 1000"
[ "$EW" = 0 ] || rowfail 9a "the export is not readable by the worker uid"
WCWD=$(X "for p in \$(pgrep -u $WUID -f worker/runtime.mjs); do $AS_WORKER readlink /proc/\$p/cwd; done; true" | sort -u | tr '\n' ' ')   # /proc/<pid>/cwd of a foreign uid needs ptrace access: read as the worker itself
log "row 9a: prod worker cwd(s): $WCWD"
echo "$WCWD" | grep -q "$EXP" || rowfail 9a "no prod worker runs from the export (cwds: $WCWD)"
X "grep -E 'locker' /work/.atelier/agent.log | tail -6" | sed 's/^/    | agent.log: /'

# ---- row 9b: the hook ran as the worker uid with the spine's config key and without any token
log "row 9b: the deploy hook's footprint in prod data (read as uid 1000 through group 19999)"
HU=$(X "$AS1000 cat /work/.atelier/data/$INST/hook-uid" | tr -d '\r\n '); HC=$(X "$AS1000 cat /work/.atelier/data/$INST/hook-cwd" | tr -d '\r\n')
X "$AS1000 cat /work/.atelier/data/$INST/hook-env" > $OUT/hook-env.txt
HE_KEYS=$(cut -d= -f1 $OUT/hook-env.txt | tr '\n' ' ')
log "row 9b: hook uid=$HU (want $WUID) cwd=$HC; env keys: $HE_KEYS"
[ "$HU" = "$WUID" ] || rowfail 9b "the hook did not run as the worker uid ($HU)"
[ "$HC" = "$EXP" ] || rowfail 9b "the hook's cwd is not the export ($HC)"
grep -q '^DRILL_CONFIG=from-spine$' $OUT/hook-env.txt || rowfail 9b "the spine's config key did not reach the hook"
grep -q "^DATA_DIR=/work/.atelier/data/$INST\$" $OUT/hook-env.txt || rowfail 9b "DATA_DIR is not prod's data dir: $(grep '^DATA_DIR' $OUT/hook-env.txt)"
grep -qiE 'token|BOOTSTRAP|CHANNEL' $OUT/hook-env.txt && rowfail 9b "a token-shaped key reached the hook: $(grep -iE 'token|BOOTSTRAP|CHANNEL' $OUT/hook-env.txt | cut -d= -f1 | tr '\n' ' ')"
HD=$(X "$AS_WORKER curl -s -o /dev/null -w %{http_code} --max-time 3 'http://127.0.0.1:1844/_atelier/apps'"); log "row 9b: the dev shell without a token from the worker uid → $HD (want 401)"
[ "$HD" = 401 ] || rowfail 9b "the dev shell answered $HD to a token-less worker"

# ---- the prod road from the peer: the signer's assertions on :1845 (the shell's road); the locker writes its own rows every 50 ms
P "cd /code && node host/drill/step2/signer.mjs GET http://$IP:1845/api/acme/locker/count --app $INST" > $OUT/prod-1.txt; sed 's/^/    | prod: /' $OUT/prod-1.txt
grep -q '^STATUS 200' $OUT/prod-1.txt || rowfail 9d "the prod road does not answer the released locker: $(head -1 $OUT/prod-1.txt)"
DEV1=$(D "/api/acme/locker/count"); log "dev road (the dev shell, the DEV slot): $DEV1"

# ---- row 9c: a second deploy backs the prod data up — the backup dir's owner and readers
log "row 9c: a source change, then the second deploy (prod has data now → a backup)"
X "$AS1000 sh -c 'echo \"// release 2\" >> /work/apps/locker/backend.js'"; sleep 1
for i in $(seq 1 50); do [ "$(appfield locker dev_rev)" -gt "$(appfield locker prod_rev)" ] 2>/dev/null && break; sleep 0.2; done
sleep 1.2
t0=$(now); CLI 'deploy locker -m "second release"' > $OUT/deploy-2.log; RC2=$?; sed 's/^/    | /' $OUT/deploy-2.log
log "row 9c: rc=$RC2 in $(el $t0) s; deployed_rev now $(appfield locker deployed_rev)"
[ "$RC2" = 0 ] || rowfail 9c "the second deploy was not green (rc=$RC2)"
BID=$(grep -o 'backup ok [0-9]* ms — [0-9A-Z]*-rev[0-9]*-[0-9a-f]*' $OUT/deploy-2.log | awk '{print $6}' | head -1)
[ -n "$BID" ] || BID=$(X "ls /work/.atelier/backup/$INST 2>/dev/null | head -1" | tr -d '\r\n')
log "row 9c: backup id $BID"
[ -n "$BID" ] || rowfail 9c "no backup dir after the second deploy"
BT=$(X "stat -c '%a %u:%g' /work/.atelier/backup/$INST/$BID; stat -c '%a %u:%g' /work/.atelier/backup/$INST" | tr '\n' ' '); log "row 9c: backup dir + root: $BT (want 750 0:19999 both)"
echo "$BT" | grep -q "^750 0:19999 750 0:19999" || rowfail 9c "the backup dirs are not 0:19999 0750: $BT"
BW=$(X "$AS_WORKER ls /work/.atelier/backup/$INST/$BID 2>&1 | grep -c 'Permission denied'; true" | tr -d '\r\n '); B1000=$(X "$AS1000 ls /work/.atelier/backup/$INST/$BID 2>&1 | grep -vc 'Permission denied'; true" | tr -d '\r\n ')
log "row 9c: backup as the worker → EACCES lines: $BW (want 1); as uid 1000 (group 19999) → entries: $B1000 (want > 0)"
[ "$BW" = 1 ] || rowfail 9c "the backup is listable by the worker"
[ "$B1000" -gt 0 ] 2>/dev/null || rowfail 9c "the backup is not readable by uid 1000"
X "$AS1000 ls -ln /work/.atelier/backup/$INST/$BID" | sed 's/^/    | backup: /'
X "$AS1000 test -s /work/.atelier/backup/$INST/$BID/locker.sqlite" || rowfail 9c "the backup does not hold locker.sqlite"
CLI 'backups locker' | sed 's/^/    | atelier backups: /'
CLI 'releases locker' | sed 's/^/    | atelier releases: /'

# ---- row 9d: three deploys of the sqlite-locking app under the prod loop from the peer
log "row 9d: locker deploys 3/3 under a 50 ms prod loop from the peer (the signer's assertions on :1845)"
P "cd /code && rm -f /tmp/loop.txt; setsid -f bash -c 'node host/drill/rows/loop.mjs http://$IP:1845/api/acme/locker/count $INST 1200 50 > /tmp/loop.txt' < /dev/null > /dev/null 2>&1"
sleep 1
GREEN=0; TIMES=""
for n in 3 4 5; do
  X "$AS1000 sh -c 'echo \"// release $n\" >> /work/apps/locker/backend.js'"
  for i in $(seq 1 50); do [ "$(appfield locker dev_rev)" -gt "$(appfield locker prod_rev)" ] 2>/dev/null && break; sleep 0.2; done
  sleep 1.2
  t0=$(now); CLI "deploy locker -m \"release $n\"" > $OUT/deploy-$n.log; rc=$?; dt=$(el $t0); TIMES="$TIMES $dt"
  grep -q '^deploy green' $OUT/deploy-$n.log && [ "$rc" = 0 ] && GREEN=$((GREEN+1))
  log "row 9d: deploy $n → $(head -c 120 < <(grep -E '^deploy' $OUT/deploy-$n.log)) in $dt s"
  grep -E 'FAILED|RED' $OUT/deploy-$n.log | sed 's/^/    | /'
  sleep 2
done
sleep 3
P 'cat /tmp/loop.txt' > $OUT/prod-loop.txt
LOOP=$(python3 - $OUT/prod-loop.txt <<'PY'
import sys
rows = [l.split() for l in open(sys.argv[1]) if l.strip()]
non = [r for r in rows if r[0] != '200']
ms = sorted(int(r[1]) for r in rows)
revs = [int(r[2]) for r in rows if r[0] == '200' and r[2].isdigit()]
mixed = sum(1 for a, b in zip(revs, revs[1:]) if b < a)
print(f"n={len(rows)} non200={len(non)} mixed={mixed} p50={ms[len(ms)//2] if ms else -1} max={ms[-1] if ms else -1} revs={sorted(set(revs))}")
PY
)
log "row 9d: $GREEN/3 green; deploy times (s):$TIMES; prod loop: $LOOP"
grep -v '^200 ' $OUT/prod-loop.txt | head -5 | sed 's/^/    | non-200: /'
[ "$GREEN" = 3 ] || rowfail 9d "$GREEN/3 deploys green"
echo "$LOOP" | grep -q ' non200=0 ' || rowfail 9d "non-200 answers in the prod loop: $LOOP"
echo "$LOOP" | grep -q ' mixed=0 ' || rowfail 9d "a lower rev after a higher one in the prod loop"
PMAX=$(echo "$LOOP" | grep -o 'max=[0-9-]*' | cut -d= -f2); python3 -c "import sys; sys.exit(0 if 0 <= int('${PMAX:--1}') < 10000 else 1)" || rowfail 9d "max latency ${PMAX} ms (≥ the 10 s hold)"
C2=$(P 'curl -s --max-time 3 http://127.0.0.1:7999/_drill/log' | grep -c '"/v1/host/release"'); log "row 9d: release rows the (v42) fake spine saw at /v1/host/release: $C2 (answered 404 — tolerated, the host keeps releases.jsonl)"
X "cat /work/.atelier/$INST/releases.jsonl | python3 -c 'import json,sys; rows=[json.loads(l) for l in sys.stdin if l.strip()]; print(len(rows), [(r[\"kind\"], r[\"verdict\"], r[\"rev\"]) for r in rows])'" | sed 's/^/    | releases.jsonl: /'
hostlog | grep -E 'release row|not recorded at the spine' | tail -2 | sed 's/^/    | host: /'

# ---- row 9e: an app WITH dependencies — the rehearsal's install in the export (take → npm → freeze --dest), the export's
# node_modules 0:<uid>, the worker createRequire's them, the dev tree keeps its own; then the install hold measured under the loop
log "row 9e: deps (better-sqlite3 + loot-pkg tgz + core-js): the dev install first (row 8's shape), then atelier deploy deps"
X "$AS1000 sh -c 'cp -r /code/drill-apps/deps /work/apps/deps; ls -ln /work/apps/deps'" | sed 's/^/    | /'
t0=$(now)
for i in $(seq 1 900); do hostlog | grep -q 'install deps: \(freeze {\|FREEZE-ABORT\|npm rc=[^0]\)' && break; sleep 0.2; done
for i in $(seq 1 100); do [ "$(appfield deps dev_state)" = live ] && break; sleep 0.2; done
hostlog | grep 'install deps' > $OUT/deps-install-dev.log; sed 's/^/    | /' $OUT/deps-install-dev.log
log "row 9e: dev install + LIVE in $(el $t0) s: dev_state=$(appfield deps dev_state)"
grep -q 'freeze {' $OUT/deps-install-dev.log && [ "$(appfield deps dev_state)" = live ] || rowfail 9e "the dev install of deps did not freeze / go LIVE: $(tail -1 $OUT/deps-install-dev.log)"
DINST=$(appfield deps instance); DUID=$(X "cat /work/.atelier/$DINST/uid" | tr -d '\r\n ')
AS_DWORKER="setpriv --reuid=$DUID --regid=$DUID --clear-groups"
LC0=$(hostlog | grep -c 'install deps')
t0=$(now); CLI 'deploy deps -m "deps release"' > $OUT/deploy-deps-1.log; RCD=$?; sed 's/^/    | /' $OUT/deploy-deps-1.log
log "row 9e: rc=$RCD in $(el $t0) s; deployed_rev $(appfield deps deployed_rev)"
grep -q '^deploy green: deps ' $OUT/deploy-deps-1.log && [ "$RCD" = 0 ] || rowfail 9e "atelier deploy deps was not green (rc=$RCD)"
hostlog | grep 'install deps' | tail -n +$((LC0+1)) > $OUT/deps-install-export.log; sed 's/^/    | /' $OUT/deps-install-export.log
grep -q 'install deps: take rc=0' $OUT/deps-install-export.log && grep -q 'install deps: freeze {' $OUT/deps-install-export.log || rowfail 9e "the export install did not take + freeze --dest: $(tail -2 $OUT/deps-install-export.log | tr '\n' ' ')"
DC12=$(appfield deps deployed_rev | cut -c1-12); DEXP=/work/.atelier/prod/$DINST/$DC12
X "find $DEXP/node_modules -printf '%m %U:%G %y\n' | sort | uniq -c | sort -rn | head -4" | sed 's/^/    | export node_modules: /'
NMF=$(X "find $DEXP/node_modules ! -user 0 | wc -l" | tr -d '\r\n '); NMG=$(X "find $DEXP/node_modules ! -group $DUID | wc -l" | tr -d '\r\n '); NMS=$(X "find $DEXP/node_modules -perm /6022 ! -type l ! -type d | wc -l" | tr -d '\r\n ')
log "row 9e: export node_modules inodes not root-owned: $NMF; not group $DUID: $NMG; setuid/setgid/g+w/o+w files: $NMS (want 0 0 0)"
[ "$NMF" = 0 ] && [ "$NMG" = 0 ] && [ "$NMS" = 0 ] || rowfail 9e "the export's node_modules is not 0:$DUID |040/|050"
X "$AS_DWORKER test -r $DEXP/node_modules/better-sqlite3/package.json" || rowfail 9e "the worker uid cannot read the export's node_modules"
X "$AS1000 test -d /work/apps/deps/node_modules/better-sqlite3" || rowfail 9e "the dev tree lost its node_modules (take must never thaw)"
X "$AS1000 test -s $DEXP/package-lock.json" || rowfail 9e "no package-lock.json in the export"
P "cd /code && node host/drill/step2/signer.mjs GET http://$IP:1845/api/acme/deps/deps --app $DINST" > $OUT/prod-deps.txt; sed 's/^/    | prod: /' $OUT/prod-deps.txt
grep -q '^STATUS 200' $OUT/prod-deps.txt && grep -q '"sqlite":42' $OUT/prod-deps.txt && grep -q '"loot":"1.0.0"' $OUT/prod-deps.txt && grep -q '"corejs":"ok"' $OUT/prod-deps.txt && grep -q "\"cwd\":\"$DEXP\"" $OUT/prod-deps.txt || rowfail 9e "the prod worker did not resolve its deps from the export: $(tail -1 $OUT/prod-deps.txt | head -c 200)"
# the install hold (DESIGN §10.3, S6 of the review): the second deploy's rehearsal install SIGKILLs the worker uid — prod is held under
# its gate through the freeze and a cold resume; measured here, never asserted below the 10 s hold (the 503s past it are the waking answer)
log "row 9e: the second deploy of deps under a 50 ms prod loop — the install hold, measured"
P "cd /code && rm -f /tmp/loop-deps.txt; setsid -f bash -c 'node host/drill/rows/loop.mjs http://$IP:1845/api/acme/deps/deps $DINST 900 50 > /tmp/loop-deps.txt' < /dev/null > /dev/null 2>&1"
sleep 1
X "$AS1000 sh -c 'echo \"// release 2\" >> /work/apps/deps/backend.js'"
for i in $(seq 1 50); do [ "$(appfield deps dev_rev)" -gt "$(appfield deps prod_rev)" ] 2>/dev/null && break; sleep 0.2; done
sleep 1.2
t0=$(now); CLI 'deploy deps -m "deps release 2"' > $OUT/deploy-deps-2.log; RCD2=$?; T_D2=$(el $t0); sed 's/^/    | /' $OUT/deploy-deps-2.log
grep -q '^deploy green: deps ' $OUT/deploy-deps-2.log && [ "$RCD2" = 0 ] || rowfail 9e "the second deploy of deps was not green (rc=$RCD2)"
sleep 3
P 'cat /tmp/loop-deps.txt' > $OUT/prod-loop-deps.txt
LOOPD=$(python3 - $OUT/prod-loop-deps.txt <<'PY'
import sys
rows = [l.split() for l in open(sys.argv[1]) if l.strip()]
non = [r for r in rows if r[0] != '200']
ms = sorted(int(r[1]) for r in rows)
revs = [int(r[2]) for r in rows if r[0] == '200' and r[2].isdigit()]
mixed = sum(1 for a, b in zip(revs, revs[1:]) if b < a)
print(f"n={len(rows)} non200={len(non)} waking503={sum(1 for r in non if r[0] == '503')} mixed={mixed} p50={ms[len(ms)//2] if ms else -1} max={ms[-1] if ms else -1}")
PY
)
log "row 9e: deploy 2 in $T_D2 s; the prod loop across the rehearsal's freeze: $LOOPD (the install hold; a 503 here is the waking answer past the 10 s hold)"
grep -v '^200 ' $OUT/prod-loop-deps.txt | head -3 | sed 's/^/    | non-200: /'
echo "$LOOPD" | grep -q ' mixed=0 ' || rowfail 9e "a lower rev after a higher one in the deps loop"

X 'cat /work/.atelier/agent.log' > $OUT/agent-log-final.txt; hostlog > $OUT/host-final.log
X "find /work/.atelier -maxdepth 3 -printf '%m %u:%g %p\n' | sort" > $OUT/tree-final.txt 2>&1

log "== VERDICT"
SUM="9t:${R[9t]} 9a:${R[9a]} 9b:${R[9b]} 9c:${R[9c]} 9d:${R[9d]} 9e:${R[9e]}"
[ $FAILS = 0 ] && echo "VERDICT: PASS — $SUM; pod tests pass=$TP fail=$TF; export 0:$WUID 0750/0640 (EACCES as 1000, readable as $WUID); hook uid $HU with DRILL_CONFIG, no token; backup $BID 0:19999 0750 (worker EACCES, 1000 reads); locker $GREEN/3 green, prod loop $LOOP; deps export node_modules 0:$DUID, the install hold: $LOOPD" \
                || echo "VERDICT: FAIL — $SUM"
