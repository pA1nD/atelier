#!/bin/bash
# Runs ON fsn-01 (root, kubectl). Throwaway ns spike-step2-rows, deleted by trap; production namespaces
# are never touched (only `ghcr-pull` is copied out of `agents`, read-only). Ends in VERDICT.
# The integrated host (step-2 pod + fake spine, host/drill/step2's harness) under the rows of DESIGN §8.2
# the step-2 drill did not cover:
#   3' kill -9 the REAL host under a 50 ms request loop on a live app → Ready back ≤ 3 s, non-200 count
#   6  from a worker: credential / peer dataDir / peer socket / dev socket / token files EACCES,
#      127.0.0.1:1844 without token → 401, env keys = row W; last-good EACCES as uid 1000
#   7  watchdogs: CPU burn → throttle cycles > 0, peer max < 200 ms, worker alive; 2 GB alloc → in-worker
#      RangeError, oom_kill 0; fork 200 → EAGAIN at the NPROC limit
#   8  install: hostile postinstall (setuid plant) refused, nothing lands; cold install rc=0 ≤ 5 s with a
#      postinstall dep + a native prebuild (better-sqlite3@12); freeze ≤ 100 ms; thaw/no-op/freeze#2 rc=0;
#      tree 1000:<uid>; the worker createRequire's the deps
#   5  the sqlite overlap gate (PLAN §10 item 1): 10 saves of an app holding an EXCLUSIVE sqlite lock —
#      how many needed the one mount retry, how many failed
set -u
NS=spike-step2-rows; K="kubectl -n $NS"; CODE=/tmp/$NS-code; OUT=$CODE/out; mkdir -p $OUT; rm -f $OUT/*
IMAGE=$(cat $CODE/image.txt)
ts(){ date +%T.%3N; }; now(){ date +%s.%N | cut -c1-14; }
log(){ echo "[$(ts)] $*"; }
el(){ python3 -c "print(round($(now)-$1,2))"; }
declare -A R; for r in 3 5 6 7a 7b 7c 8; do R[$r]=PASS; done
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
workerpid(){ X "ps -eo pid,uid,args | awk '\$2==$1 && /worker\\/runtime.mjs/ {print \$1}' | sort -n | tail -1" | tr -d '\r\n'; }
py(){ python3 -c "$1"; }
# the dev shell from inside the pod (loopback, token) — the drill's query path; the protocol port is step 2's row (b)
D(){ X "curl -s --max-time 10 'http://127.0.0.1:1844$1$(case "$1" in *\?*) echo '&';; *) echo '?';; esac)token=$DT'"; }
apps(){ D /_atelier/apps; }
appfield(){ apps | py "import json,sys; a=[r for r in json.load(sys.stdin) if r['slug']=='$1']; print(a[0]['$2'] if a else '')"; }
hostlog(){ $K logs computer -c session 2>&1; }

log "other spike namespaces on the node (untouched): $(kubectl get ns -o name | grep 'spike-' | grep -v "/$NS\$" | tr '\n' ' ')"
kubectl delete ns $NS --wait=true --timeout=90s >/dev/null 2>&1 || true
kubectl create ns $NS >/dev/null || { echo "VERDICT: BLOCKED — cannot create ns"; exit 1; }
kubectl -n agents get secret ghcr-pull -o json | python3 -c 'import json,sys; s=json.load(sys.stdin); print(json.dumps({"apiVersion":"v1","kind":"Secret","type":s["type"],"metadata":{"name":"ghcr-pull","namespace":"'$NS'"},"data":s["data"]}))' | $K apply -f - >/dev/null || { echo "VERDICT: BLOCKED — ghcr-pull copy failed"; exit 1; }
log "image (metal/clusters/prod/spine.yaml AGENT_IMAGE): $IMAGE"

# ---- the peer: fake spine (step 2's), outside the computer pod
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
$K exec computer -c stage -- sh -c 'tar xzf /tmp/code.tgz -C /code 2>&1 | grep -v "Ignoring unknown extended header"; cd /code && timeout 300 npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -3 && ls /code/node_modules/@esbuild /code/node_modules/@tailwindcss && touch /code/.staged && echo STAGED-OK' | tee $OUT/stage.log | sed 's/^/    | /'
grep -q STAGED-OK $OUT/stage.log || { echo "VERDICT: BLOCKED — stage (untar + npm ci) failed after $(el $t0) s"; exit 1; }
log "staged in $(el $t0) s; waiting for Ready"
RDY=$(waitready 120)
[ "$RDY" = timeout ] && { $K describe pod computer | tail -20; hostlog | tail -40; echo "VERDICT: FAIL — never Ready"; exit 1; }
IP=$($K get pod computer -o jsonpath='{.status.podIP}')
log "Ready $RDY s after staging — $(readyq); pod IP $IP"
hostlog > $OUT/host-boot.log
HOST0=$(hostpid); DT=$(X 'cat /run/atelier/dev.token' | tr -d '\r\n')
X 'cat /sys/fs/cgroup/memory.events' > $OUT/memory-events-before.txt; log "memory.events at boot: $(tr '\n' ' ' < $OUT/memory-events-before.txt)"

# ---- the agent puts the apps in place (uid 1000): probe, hello, locker, deps (no package.json yet) + its credential
X "$AS1000 sh -c 'mkdir -m 700 /work/.claude && echo canary-credential > /work/.claude/.credentials.json && chmod 600 /work/.claude/.credentials.json && for a in probe hello locker deps; do cp -r /code/drill-apps/\$a /work/apps/\$a; done && rm -f /work/apps/deps/package.json && ls -ldn /work/apps/*'" | sed 's/^/    | /'
T_SAVE=$(now)
for i in $(seq 1 150); do
  apps | py 'import json,sys; a=json.load(sys.stdin); sys.exit(0 if {r["slug"] for r in a if r["state"]=="live"}=={"probe","hello","locker","deps"} else 1)' 2>/dev/null && break
  sleep 0.2
done
T_LIVE=$(el $T_SAVE); A=$(apps); log "apps after $T_LIVE s: $A"; echo "$A" > $OUT/apps-after-scan.json
echo "$A" | py 'import json,sys; a=json.load(sys.stdin); sys.exit(0 if {r["slug"] for r in a if r["state"]=="live"}=={"probe","hello","locker","deps"} else 1)' 2>/dev/null || { hostlog | tail -30; echo "VERDICT: FAIL — apps not live within 30 s: $A"; exit 1; }
declare -A INST UIDS
for s in probe hello locker deps; do INST[$s]=$(appfield $s instance); UIDS[$s]=$(X "cat /work/.atelier/${INST[$s]}/uid" | tr -d '\r\n '); done
log "instances: probe ${INST[probe]}/${UIDS[probe]} hello ${INST[hello]}/${UIDS[hello]} locker ${INST[locker]}/${UIDS[locker]} deps ${INST[deps]}/${UIDS[deps]}"
X 'cat /work/.atelier/agent.log' | sed 's/^/    | agent.log: /'

# ---- row 3': kill -9 the REAL host under a 50 ms loop on hello (snapshots + workers survive the host)
log "row 3': kill -9 the host $HOST0 under a 50 ms curl loop on /api/acme/hello/ping (dev shell, loopback)"
X "rm -f /tmp/blink.txt; setsid -f bash -c 'for i in \$(seq 1 160); do echo \"\$(date +%T.%3N) \$(curl -s -o /dev/null -w %{http_code} --max-time 1 \"http://127.0.0.1:1844/api/acme/hello/ping?token=$DT\")\"; sleep 0.05; done > /tmp/blink.txt' < /dev/null > /dev/null 2>&1"
declare -A W0; for s in probe hello locker deps; do W0[$s]=$(workerpid ${UIDS[$s]}); done
PREKILL="${W0[probe]} ${W0[hello]} ${W0[locker]} ${W0[deps]}"
log "row 3': pre-kill workers [$PREKILL] — detached orphans of the dying host; the launcher SIGKILLs them, the second life resumes fresh (the sqlite-lock fix)"
sleep 1
t0=$(now); X "kill -9 $HOST0"
# the kube Ready flag has a 1 s probe grain and may never see a sub-second blink; the blink itself is measured
# from the crash line's `at` (ms) to the second life's `host: ready` line in agent.log, plus the 50 ms loop
for i in $(seq 1 100); do X 'test -f /run/atelier/host-ready' >/dev/null 2>&1 && [ "$(hostpid)" != "$HOST0" ] && break; sleep 0.1; done
T_BACK=$(el $t0); log "row 3': host-ready present again $T_BACK s after the kill (poll grain 0.1 s + exec) — $(readyq)"
python3 -c "import sys; sys.exit(0 if $T_BACK <= 3.5 else 1)" || rowfail 3 "host-ready back after $T_BACK s (> 3 s)"
sleep 9
HOST1=$(hostpid); X 'cat /tmp/blink.txt' > $OUT/blink.txt
NON200=$(grep -vc ' 200$' $OUT/blink.txt); TOTAL=$(wc -l < $OUT/blink.txt)
DT1=$(X 'cat /run/atelier/dev.token' | tr -d '\r\n'); [ "$DT1" = "$DT" ] || DT=$DT1
CRASH=$(X "$AS1000 cat /control/.host-crash" | tr '\n' ' ')
BLINK_MS=$(python3 - "$CRASH" "$(X 'grep "host: ready" /work/.atelier/agent.log | tail -1')" <<'PY'
import json, sys, datetime as d
try:
    at = json.loads(sys.argv[1].strip().split(' ')[-1])['at']
    ts = sys.argv[2].split(' ')[0]
    ready = d.datetime.strptime(ts, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=d.timezone.utc).timestamp() * 1000
    print(round(ready - at))
except Exception as e: print('?')
PY
)
# the door IS the host: a host kill is a full :1844 outage until the second life re-binds (~200 ms = a few
# 50 ms probes). The ≤2-non-200 "snapshots served across the blink" is the LAUNCHER drill (a host-STUB is
# the server and only it restarts). Here we RECORD the door blink and PROVE recovery + the orphan sweep.
STILL=$(X "for p in $PREKILL; do [ -d /proc/\$p ] && echo \$p; done" | tr '\r\n' '  ')
SWEEP=$(hostlog | grep -c 'orphaned worker'); SWEEPLINE=$(hostlog | grep 'orphaned worker' | tail -1)
log "row 3': host pid $HOST0 → $HOST1; crash → ready ${BLINK_MS} ms; door blink $NON200/$TOTAL non-200 at 50 ms; dev token $([ "$DT1" = "$DT" ] && echo unchanged || echo CHANGED); crash line: $CRASH"
log "row 3': pre-kill workers still alive after: [${STILL:-none}]; sweep: $SWEEPLINE"
[ -n "$HOST1" ] && [ "$HOST1" != "$HOST0" ] || rowfail 3 "host pid not renewed"
python3 -c "import sys; sys.exit(0 if '$BLINK_MS'!='?' and int('$BLINK_MS')<=3000 else 1)" || rowfail 3 "crash→ready ${BLINK_MS} ms (> 3 s)"
echo "$CRASH" | grep -q '\"signal\":\"SIGKILL\",\"exits\":1' || rowfail 3 "crash line shape: $CRASH"
[ "$SWEEP" -ge 1 ] || rowfail 3 "no launcher 'orphaned worker' sweep line"
[ -z "${STILL// /}" ] || rowfail 3 "pre-kill worker(s) still alive after the restart: $STILL"
grep -v ' 200$' $OUT/blink.txt | sed 's/^/    | non-200: /'
[ "$(appfield hello state)" = live ] || log "row 3': hello is $(appfield hello state) after the host restart (resume on the next request)"
HOST0=$HOST1

# ---- row 6: the worker from inside
log "row 6: probe app — denied paths, the dev shell without a token, env keys"
PR=$(D "/api/acme/probe/probe?peer=/work/.atelier/data/${INST[hello]}"); echo "$PR" > $OUT/probe.json
python3 - "${UIDS[probe]}" $OUT/probe.json <<'PY' | tee $OUT/probe-verdict.txt | sed 's/^/    | /'
import json, sys
uid = int(sys.argv[1]); j = json.load(open(sys.argv[2]))
bad = []
def want(name, got, exp):
    ok = got == exp
    print(f"{'PASS' if ok else 'FAIL'} {name} = {json.dumps(got)}" + ('' if ok else f" (want {json.dumps(exp)})"))
    if not ok: bad.append(name)
want('uid', j['uid'], uid); want('gid', j['gid'], uid); want('umask', j['umask'], '2'); want('cwd', j['cwd'], '/work/apps/probe')
want('env keys = row W (+ the spine-held config key)', j['envKeys'], ['APP_ID','ATELIER_WORKER','BASE_URL','DRILL_CONFIG','HOME','HOST','NODE_ENV','PATH','PORT','TMPDIR'])
want('dataDir write', j['dataDir']['write'], 'WROTE')
for k, v in j['denied'].items(): want(f'denied.{k}', v, 'EACCES')
want('127.0.0.1:1844 without token', j['devShellHttp']['noToken'], 401)
want('127.0.0.1:1844 with a wrong token', j['devShellHttp']['badToken'], 401)
print(f"PROBE: fail={len(bad)} {' '.join(bad)}")
PY
grep -q '^PROBE: fail=0' $OUT/probe-verdict.txt || rowfail 6 "$(tail -1 $OUT/probe-verdict.txt)"
LG=$(X "$AS1000 ls /work/.atelier/last-good/${INST[probe]} 2>&1 | grep -c 'Permission denied'"); log "row 6: last-good/<inst> as uid 1000 → EACCES lines: $LG"
[ "$LG" = 1 ] || rowfail 6 "last-good listable by uid 1000"

# ---- row 7a: CPU burn → throttled, peer unaffected, worker alive
WP=$(workerpid ${UIDS[probe]}); WH=$(workerpid ${UIDS[hello]})
log "row 7a: probe worker $WP burns one core; hello worker $WH is the peer; 25 s"
X "rm -f /tmp/lat.txt /tmp/state.txt; setsid -f bash -c 'for i in \$(seq 1 400); do curl -s -o /dev/null -w \"%{http_code} %{time_total}\n\" --max-time 2 \"http://127.0.0.1:1844/api/acme/hello/ping?token=$DT\"; sleep 0.05; done > /tmp/lat.txt' < /dev/null > /dev/null 2>&1; setsid -f bash -c 'for i in \$(seq 1 1200); do awk \"/^State/{print \\\$2}\" /proc/$WP/status; sleep 0.02; done > /tmp/state.txt' < /dev/null > /dev/null 2>&1"
D /api/acme/probe/burn | sed 's/^/    | burn: /'
sleep 25
D /api/acme/probe/burn-stop | sed 's/^/    | burn-stop: /'
sleep 2
X 'cat /tmp/lat.txt' > $OUT/peer-latency.txt; X 'cat /tmp/state.txt' > $OUT/probe-state.txt
LAT=$(python3 - $OUT/peer-latency.txt <<'PY'
import sys
rows = [l.split() for l in open(sys.argv[1]) if l.strip()]
ms = sorted(float(t) * 1000 for c, t in rows)
non = sum(1 for c, t in rows if c != '200')
print(f"n={len(ms)} non200={non} p50={ms[len(ms)//2]:.1f} p99={ms[int(len(ms)*0.99)]:.1f} max={ms[-1]:.1f}")
PY
)
TSAMPLES=$(grep -c '^T' $OUT/probe-state.txt); RSAMPLES=$(grep -c '^R' $OUT/probe-state.txt); SSAMPLES=$(wc -l < $OUT/probe-state.txt)
CPU_REPORT=$(X 'grep "cpu throttled" /work/.atelier/agent.log | tail -1')
CYCLES=$(echo "$CPU_REPORT" | grep -o '[0-9]* SIGSTOP cycles' | awk '{print $1}')
WP2=$(workerpid ${UIDS[probe]})
log "row 7a: peer latency during the burn: $LAT; probe State samples: T=$TSAMPLES R=$RSAMPLES of $SSAMPLES; watchdog report: ${CPU_REPORT:-none}; probe worker $WP → $WP2"
PMAX=$(echo "$LAT" | grep -o 'max=[0-9.]*' | cut -d= -f2)
[ -n "$CYCLES" ] && [ "$CYCLES" -gt 0 ] || rowfail 7a "no cpu-throttle report with a cycle count in agent.log (T samples $TSAMPLES)"
[ "$TSAMPLES" -gt 0 ] || rowfail 7a "the worker was never seen stopped"
python3 -c "import sys; sys.exit(0 if float('${PMAX:-999}') < 200 else 1)" || rowfail 7a "peer max ${PMAX} ms (≥ 200)"
[ "$WP2" = "$WP" ] || rowfail 7a "probe worker pid changed $WP → $WP2 (killed?)"
P 'grep -c "cpu throttled" /tmp/spine.jsonl' | sed 's/^/    | cpu reports at the spine: /'

# ---- row 7b: 2 GB alloc → RangeError inside the worker, no OOM kill
log "row 7b: 2 GB alloc in the probe worker"
AL=$(D /api/acme/probe/alloc); echo "$AL" | sed 's/^/    | alloc: /'; echo "$AL" > $OUT/alloc.json
X 'cat /sys/fs/cgroup/memory.events' > $OUT/memory-events-after.txt; OOM=$(awk '/^oom_kill/{print $2}' $OUT/memory-events-after.txt)
WP3=$(workerpid ${UIDS[probe]}); K7B=$(X 'grep -c "KILLED worker died" /work/.atelier/agent.log || true' | tr -dc 0-9 | head -c3); K7B=${K7B:-0}; log "row 7b: oom_kill=$OOM; probe worker $WP2 → $WP3; worker deaths in agent.log: $K7B; RLIMIT_DATA of the worker: $(X "awk '/Max data size/{print \$4}' /proc/$WP3/limits")"
echo "$AL" | py 'import json,sys; j=json.load(sys.stdin); e=j.get("error") or {}; sys.exit(0 if e.get("name")=="RangeError" and j["allocatedMb"]<2048 else 1)' || rowfail 7b "no in-worker RangeError: $AL"
[ "${OOM:-x}" = 0 ] || rowfail 7b "oom_kill=$OOM"
[ "$K7B" = 0 ] || rowfail 7b "a worker died during the alloc ($K7B KILLED lines)"
log "row 7b (record only): the chunked shape — 64 MB pieces until the wall"
ALC=$(D "/api/acme/probe/alloc?chunked=1"); echo "$ALC" | sed 's/^/    | alloc chunked: /'; echo "$ALC" > $OUT/alloc-chunked.json
sleep 2; X 'grep -E "KILLED|RESUMED" /work/.atelier/agent.log | tail -2' | sed 's/^/    | agent.log: /'; X 'cat /sys/fs/cgroup/memory.events' | grep oom_kill | sed 's/^/    | after chunked: /'
for i in $(seq 1 50); do [ "$(appfield probe state)" = live ] && break; sleep 0.2; done

# ---- row 7c: fork 200 → EAGAIN at the NPROC limit
log "row 7c: fork 200 in the probe worker (RLIMIT_NPROC 64 per uid)"
FK=$(D "/api/acme/probe/fork?n=200"); echo "$FK" | sed 's/^/    | fork: /'; echo "$FK" > $OUT/fork.json
sleep 1; WP4=$(workerpid ${UIDS[probe]}); K7C=$(X 'grep -c "KILLED worker died" /work/.atelier/agent.log || true' | tr -dc 0-9 | head -c3); K7C=${K7C:-0}; log "row 7c: probe worker now $WP4; NPROC: $(X "awk '/Max processes/{print \$3}' /proc/$WP4/limits"); worker deaths in agent.log: $K7C"
echo "$FK" | py 'import json,sys; j=json.load(sys.stdin); sys.exit(0 if j["eagain"]>0 and j["spawned"]<=64 and j["spawned"]+j["eagain"]==200 else 1)' || rowfail 7c "fork numbers: $FK"
[ "$K7C" = "$K7B" ] || rowfail 7c "a worker died during the fork storm ($K7B → $K7C KILLED lines)"
[ "$(echo "$FK" | py 'import json,sys; print(json.load(sys.stdin)["pid"])')" = "$WP4" ] || rowfail 7c "the worker that answered is not the live one"
sleep 1; X "ps -eo pid,uid,args | awk '\$2==${UIDS[probe]}' | wc -l" | sed 's/^/    | processes of the probe uid after the storm: /'

# ---- row 8: install
log "row 8a: hostile install — the postinstall plants a 4755 file (gated on /tmp/loot-suid) → freeze refused, nothing lands"
X 'touch /tmp/loot-suid; chmod 644 /tmp/loot-suid'
X "$AS1000 cp /code/drill-apps/deps/package.json /work/apps/deps/package.json"
t0=$(now)
for i in $(seq 1 600); do hostlog | grep -q 'install deps: \(freeze\|FREEZE-ABORT\|npm rc=[^0]\)' && break; sleep 0.2; done
T_INST1=$(el $t0); hostlog | grep 'install deps' > $OUT/install-a.log; sed 's/^/    | /' $OUT/install-a.log
NPM1=$(grep -o 'npm rc=[0-9]* in [0-9]* ms' $OUT/install-a.log | head -1)
grep -q 'FREEZE-ABORT.*setuid/setgid' $OUT/install-a.log && grep -q 'cleanup rc=0' $OUT/install-a.log || rowfail 8 "the setuid plant was not refused: $(tail -1 $OUT/install-a.log)"
sleep 1
NM=$(X "$AS1000 ls -A /work/apps/deps" | tr '\n' ' '); log "row 8a: $T_INST1 s; $NPM1; app folder after the abort: $NM"
echo "$NM" | grep -q node_modules && rowfail 8 "node_modules landed after the refused freeze"
X 'grep "install failed" /work/.atelier/agent.log | tail -1' | sed 's/^/    | agent.log: /'
X 'grep -E "\[deps\] rev [0-9]+ FAILED.*(setuid/setgid|setuid-refused)" /work/.atelier/agent.log' | sed 's/^/    | agent.log FAILED: /'
X 'grep -qE "\[deps\] rev [0-9]+ FAILED.*(setuid/setgid|setuid-refused)" /work/.atelier/agent.log' || rowfail 8 "the agent got no FAILED line naming the refused setuid file"

log "row 8b: the plant gate removed; the agent re-saves package.json → thaw (no-op) → install (cache warm, node_modules gone) → freeze → LIVE"
X 'rm -f /tmp/loot-suid'
X "$AS1000 sh -c 'python3 - <<PY
import json; p=\"/work/apps/deps/package.json\"; j=json.load(open(p)); j[\"description\"]=\"rows drill\"; json.dump(j, open(p,\"w\"), indent=2)
PY'"
t0=$(now); REVD0=$(appfield deps rev)
for i in $(seq 1 600); do hostlog | grep -q 'install deps: \(freeze {\|FREEZE-ABORT\|npm rc=[^0]\)' && [ "$(hostlog | grep -c 'install deps: npm rc=')" -ge 2 ] && break; sleep 0.2; done
for i in $(seq 1 100); do [ "$(appfield deps rev)" != "$REVD0" ] && [ "$(appfield deps state)" = live ] && break; sleep 0.2; done
T_INST2=$(el $t0); hostlog | grep 'install deps' | tail -n +$(( $(wc -l < $OUT/install-a.log) + 1 )) > $OUT/install-b.log; sed 's/^/    | /' $OUT/install-b.log
NPM2=$(grep -o 'npm rc=[0-9]* in [0-9]* ms' $OUT/install-b.log | head -1); FR2=$(grep -o 'freeze {.*}' $OUT/install-b.log | head -1)
FR2_MS=$(echo "$FR2" | grep -o '"total_ms":[0-9.]*' | cut -d: -f2)
log "row 8b: $T_INST2 s to LIVE rev $(appfield deps rev) (was $REVD0); $NPM2; $FR2"
grep -q 'thaw rc=0' $OUT/install-b.log && grep -q 'freeze {' $OUT/install-b.log || rowfail 8 "second install did not thaw+freeze: $(tail -1 $OUT/install-b.log)"
[ "$(appfield deps state)" = live ] && [ "$(appfield deps rev)" != "$REVD0" ] || rowfail 8 "deps not LIVE at a new rev after the install"
python3 -c "import sys; sys.exit(0 if float('${FR2_MS:-999}') <= 100 else 1)" || rowfail 8 "freeze ${FR2_MS} ms (> 100)"
DP=$(D /api/acme/deps/deps); log "row 8b: /deps from the worker: $DP"; echo "$DP" > $OUT/deps.json
echo "$DP" | py 'import json,sys; j=json.load(sys.stdin); sys.exit(0 if j["sqlite"]==42 and j["loot"]=="1.0.0" and j["corejs"]=="ok" else 1)' || rowfail 8 "the worker cannot require the frozen deps: $DP"
TREE=$(X "$AS1000 sh -c 'cd /work/apps/deps && echo total=\$(find node_modules | wc -l) foreign=\$(find node_modules -printf \"%U:%G\\n\" | grep -vc \"^1000:${UIDS[deps]}\$\") gowrite=\$(find node_modules \\( -perm -g=w -o -perm -o=w \\) ! -type l | wc -l) setuid=\$(find node_modules -perm /6000 ! -type d | wc -l) nogroupread=\$(find node_modules ! -type l ! -perm -g=r | wc -l) lock=\$(stat -c %u:%g:%a package-lock.json 2>&1)'")
log "row 8b: tree as uid 1000: $TREE"
echo "$TREE" | grep -q 'foreign=0 gowrite=0 setuid=0 nogroupread=0' || rowfail 8 "tree ownership/modes: $TREE"
hostlog | grep -q "stopped by the install's freeze" && log "row 8b: the live worker's death under the freeze was not reported as a crash (log line present)" || log "row 8b: no 'stopped by the install's freeze' line (the worker may have been stopped before the freeze)"
X 'grep -c "KILLED worker died" /work/.atelier/agent.log' | sed 's/^/    | KILLED lines in agent.log (want 0): /'

log "row 8c: package.json touched again → thaw / no-op install / freeze#2"
LC0=$(hostlog | grep -c 'install deps')
X "$AS1000 sh -c 'python3 - <<PY
import json; p=\"/work/apps/deps/package.json\"; j=json.load(open(p)); j[\"description\"]=\"rows drill 2\"; json.dump(j, open(p,\"w\"), indent=2)
PY'"
t0=$(now)
for i in $(seq 1 150); do hostlog | grep 'install deps' | tail -n +$((LC0+1)) | grep -q 'freeze {\|FREEZE-ABORT\|install ok' && break; sleep 0.2; done
T_INST3=$(el $t0); hostlog | grep 'install deps' | tail -n +$((LC0+1)) > $OUT/install-c.log; sed 's/^/    | /' $OUT/install-c.log
TH3=$(grep -o 'thaw rc=[0-9]* {[^}]*}' $OUT/install-c.log | head -1); NPM3=$(grep -o 'npm rc=[0-9]* in [0-9]* ms' $OUT/install-c.log | head -1); FR3=$(grep -o 'freeze {.*}' $OUT/install-c.log | head -1)
log "row 8c: $T_INST3 s; $TH3; $NPM3; $FR3"
echo "$TH3" | grep -q 'thaw rc=0' && echo "$NPM3" | grep -q 'npm rc=0' && [ -n "$FR3" ] || rowfail 8 "thaw/no-op/freeze#2: $TH3 | $NPM3 | $FR3"
DP=$(D /api/acme/deps/deps); echo "$DP" | py 'import json,sys; j=json.load(sys.stdin); sys.exit(0 if j["sqlite"]==42 else 1)' || rowfail 8 "deps after freeze#2: $DP"
X 'cat /work/.atelier/agent.log' > $OUT/agent-log-after-install.txt

# ---- row 5: the sqlite overlap gate
log "row 5: locker holds an EXCLUSIVE sqlite lock in its dataDir; 10 saves — count LIVE / mount retries / FAILED"
C0=$(D /api/acme/locker/count); log "row 5: /count before: $C0"
REV=$(appfield locker rev); SAVES=10; LIVE=0; FAILED=0; RETRY0=$(hostlog | grep -c 'retrying once after the old worker exits'); TIMES=""
for i in $(seq 1 $SAVES); do
  X "$AS1000 sh -c 'echo \"// save $i\" >> /work/apps/locker/backend.js'"
  t0=$(now); res=timeout
  for j in $(seq 1 150); do
    r=$(appfield locker rev); st=$(appfield locker state)
    if [ "$r" -gt "$REV" ] 2>/dev/null && [ "$st" = live ]; then res=live; break; fi
    if X "grep -q 'locker.*rev $((REV+1)) FAILED' /work/.atelier/agent.log"; then res=failed; break; fi
    sleep 0.1
  done
  dt=$(el $t0); TIMES="$TIMES $dt"
  case $res in live) LIVE=$((LIVE+1)); REV=$r;; failed) FAILED=$((FAILED+1)); REV=$((REV+1));; *) FAILED=$((FAILED+1)); REV=$(appfield locker rev);; esac
  log "row 5: save $i → $res in $dt s (rev $REV, retries so far $(( $(hostlog | grep -c 'retrying once after the old worker exits') - RETRY0 )))"
  sleep 1
done
RETRIES=$(( $(hostlog | grep -c 'retrying once after the old worker exits') - RETRY0 ))
C1=$(D /api/acme/locker/count); log "row 5: $LIVE LIVE / $FAILED FAILED of $SAVES saves; $RETRIES mount retries; swap times (s):$TIMES; /count after: $C1"
hostlog | grep -E '\[locker\]' > $OUT/locker-host.log; X 'grep locker /work/.atelier/agent.log' > $OUT/locker-agent.log
grep -i 'locked\|BUSY\|mount failed' $OUT/locker-host.log | head -5 | sed 's/^/    | /'
[ "$FAILED" = 0 ] || rowfail 5 "$FAILED of $SAVES saves FAILED with the single mount retry"
echo "$C1" | grep -q '"count"' || rowfail 5 "locker not serving after the saves: $C1"

X 'cat /work/.atelier/agent.log' > $OUT/agent-log-final.txt; P 'cat /tmp/spine.jsonl' > $OUT/spine-final.jsonl; hostlog > $OUT/host-final.log
X "find /work/.atelier /run/atelier -printf '%m %u:%g %p\n' | sort" > $OUT/tree-final.txt 2>&1

log "== VERDICT"
SUM="3':${R[3]} 6:${R[6]} 7a:${R[7a]} 7b:${R[7b]} 7c:${R[7c]} 8:${R[8]} 5:${R[5]}"
[ $FAILS = 0 ] && echo "VERDICT: PASS — $SUM; host kill -9 → Ready back ${T_BACK}s, $NON200/$TOTAL non-200; burn: $CYCLES cycles, T-samples $TSAMPLES, peer $LAT; alloc: $(echo "$AL" | py 'import json,sys; j=json.load(sys.stdin); print(j["allocatedMb"],"MB then",(j.get("error") or {}).get("name"))') oom_kill $OOM; fork: $(echo "$FK" | py 'import json,sys; j=json.load(sys.stdin); print(j["spawned"],"spawned",j["eagain"],"EAGAIN")'); install: cold $NPM1 (refused), warm $NPM2, freeze ${FR2_MS} ms, re-run $TH3/$NPM3; sqlite: $LIVE/$SAVES LIVE with $RETRIES retries" \
                || echo "VERDICT: FAIL — $SUM"
