#!/bin/bash
# Runs ON fsn-01 (root, kubectl). Throwaway ns spike-host-launcher, deleted by trap; production
# namespaces are never touched (only `ghcr-pull` is copied out of `agents`, read-only). Ends in VERDICT.
# Rows (DESIGN §8.2 1–3 + the container-restart and SIGTERM semantics of §2.1 step 6):
#   1 Ready ≤ 4 s after the container start   2 inpod.sh (tree, stats, tokens, env, umask, tmux rule, node --test)
#   3 kill -9 the host: new host pid, launcher+supervisor pids unchanged, Ready back ≤ 3 s, one .host-crash
#     line owned 1000, peer curl loop at 50 ms → ≤ 2 non-200
#   4 kill -TERM 1 → exit 1 mirrored (host torn down first) → in-place container restart → Ready again, tokens re-minted, session dir reclaimed
#   5 ten host kills in the second life → parked, pod stays Running, supervisor untouched
#   6 pod delete with grace 40 → SIGTERM order in the logs, host teardown before PID 1 exits, termination ≤ 40 s
set -u
NS=spike-host-launcher; K="kubectl -n $NS"; CODE=/tmp/spike-host-launcher-code; OUT=$CODE/out; mkdir -p $OUT; rm -f $OUT/*
IMAGE=$(cat $CODE/image.txt)
ts(){ date +%T.%3N; }; now(){ date +%s.%N | cut -c1-14; }
log(){ echo "[$(ts)] $*"; }
el(){ python3 -c "print(round($(now)-$1,2))"; }
FAILS=0; WHY=""
fail(){ FAILS=$((FAILS+1)); WHY="$WHY; $1"; log "FAIL: $1"; }
cleanup(){ log "cleanup: deleting ns $NS"; kill ${OBS_PID:-} 2>/dev/null; kubectl delete ns $NS --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT
X(){ $K exec computer -c session -- bash -c "$1" 2>&1; }
readyq(){ $K get pod computer -o jsonpath='{.status.conditions[?(@.type=="Ready")].status} rc={.status.containerStatuses[0].restartCount} phase={.status.phase}' 2>/dev/null; }
waitready(){ local max=$1 t0=$(now); for i in $(seq 1 $((max*5))); do case "$(readyq)" in True*) echo "$(el $t0)"; return 0;; esac; sleep 0.2; done; echo "timeout"; return 1; }
# anchored on ^node so the `bash -c` that runs pgrep never matches itself
hostpid(){ X "pgrep -f '^node /code/host/index.mjs' | head -1" | tr -d '\r\n'; }
suppid(){ X "pgrep -f '^node /app/session-supervisor.mjs' | head -1" | tr -d '\r\n'; }
launcherpid(){ X "pgrep -f '^node /code/host/launcher.mjs' | head -1" | tr -d '\r\n'; }

log "other spike namespaces on the node (untouched): $(kubectl get ns -o name | grep 'spike-' | grep -v "/$NS\$" | tr '\n' ' ')"
kubectl delete ns $NS --wait=true --timeout=90s >/dev/null 2>&1 || true
kubectl create ns $NS >/dev/null || { echo "VERDICT: BLOCKED — cannot create ns"; exit 1; }
kubectl -n agents get secret ghcr-pull -o json | python3 -c 'import json,sys; s=json.load(sys.stdin); print(json.dumps({"apiVersion":"v1","kind":"Secret","type":s["type"],"metadata":{"name":"ghcr-pull","namespace":"'$NS'"},"data":s["data"]}))' | $K apply -f - >/dev/null || { echo "VERDICT: BLOCKED — ghcr-pull copy failed"; exit 1; }
log "image (metal/clusters/prod/spine.yaml AGENT_IMAGE): $IMAGE"
sed "s#__IMAGE__#$IMAGE#g; s#__NS__#$NS#g" $CODE/pod.yaml.tpl | kubectl apply -f - >/dev/null || { echo "VERDICT: BLOCKED — pod apply refused"; exit 1; }

# stage the code tree into the init container, then release it
log "waiting for the stage init container"
for i in $(seq 1 300); do [ "$($K get pod computer -o jsonpath='{.status.initContainerStatuses[?(@.name=="stage")].state.running.startedAt}' 2>/dev/null)" != "" ] && break; sleep 1; done
$K cp $CODE/code.tgz computer:/tmp/code.tgz -c stage || { echo "VERDICT: BLOCKED — kubectl cp into stage failed"; exit 1; }
$K exec computer -c stage -- sh -c 'tar xzf /tmp/code.tgz -C /code && touch /code/.staged && ls /code /code/host' >/dev/null || { echo "VERDICT: BLOCKED — untar in stage failed"; exit 1; }
T_STAGED=$(now)
log "staged; waiting for Ready (≤ 60 s incl. container creation)"
R=$(waitready 60)
[ "$R" = timeout ] && { $K describe pod computer | tail -20; $K logs computer -c session 2>&1 | tail -30; echo "VERDICT: FAIL — never Ready"; exit 1; }
STARTED=$($K get pod computer -o jsonpath='{.status.containerStatuses[0].state.running.startedAt}')
SINCE_START=$(python3 -c "import datetime as d; s=d.datetime.strptime('$STARTED','%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=d.timezone.utc).timestamp(); print(round($(now)-s,1))")
log "row 1: Ready $R s after staging, ≤ $SINCE_START s after the container start (startedAt has 1 s grain) — $(readyq)"
python3 -c "import sys; sys.exit(0 if $SINCE_START <= 4.9 else 1)" || fail "row 1: Ready took $SINCE_START s after the container start (> 4 s)"
IP=$($K get pod computer -o jsonpath='{.status.podIP}')
for i in $(seq 1 60); do [ "$($K get pod peer -o jsonpath='{.status.phase}')" = Running ] && break; sleep 1; done
log "launcher log of the first life:"; $K logs computer -c session 2>&1 | sed 's/^/    | /'

log "row 2: inpod.sh"
$K cp $CODE/inpod.sh computer:/tmp/inpod.sh -c session >/dev/null
X 'bash /tmp/inpod.sh' | tee $OUT/inpod.txt | sed 's/^/    | /'
IN=$(tail -1 $OUT/inpod.txt); case "$IN" in INPOD:*fail=0) ;; *) fail "row 2: $IN ($(grep -c '^FAIL' $OUT/inpod.txt) FAIL lines)";; esac

log "row 3: kill -9 the host; peer curl loop at 50 ms across the blink"
H0=$(hostpid); S0=$(suppid); L0=$(launcherpid)
$K exec peer -- sh -c "nohup sh -c 'for i in \$(seq 1 200); do c=\$(curl -s -o /dev/null -w %{http_code} --max-time 1 http://$IP:1845/); echo \"\$(date +%T.%3N) \$c\"; sleep 0.05; done' > /tmp/loop.txt 2>&1 &"
sleep 1
t0=$(now); X "kill -9 $H0"
for i in $(seq 1 30); do case "$(readyq)" in False*) break;; esac; sleep 0.1; done
R3=$(waitready 10); log "row 3: Ready back $R3 s after the unready flip ($(el $t0) s after the kill) — $(readyq)"
[ "$R3" = timeout ] && fail "row 3: Ready not back within 10 s"
python3 -c "import sys; sys.exit(0 if '$R3'!='timeout' and $(el $t0) <= 3.5 else 1)" || fail "row 3: Ready back after $(el $t0) s (> 3 s)"
sleep 10
H1=$(hostpid); S1=$(suppid); L1=$(launcherpid)
[ "$H1" != "$H0" ] && [ -n "$H1" ] && log "row 3: host pid $H0 → $H1" || fail "row 3: host pid not renewed ($H0 → $H1)"
[ "$S1" = "$S0" ] && [ "$L1" = "$L0" ] && log "row 3: launcher $L0 and supervisor $S0 unchanged" || fail "row 3: launcher/supervisor pid changed ($L0→$L1, $S0→$S1)"
NON200=$($K exec peer -- sh -c 'grep -vc " 200$" /tmp/loop.txt'); TOTAL=$($K exec peer -- sh -c 'wc -l < /tmp/loop.txt')
log "row 3: peer loop: $NON200 non-200 of $TOTAL"; [ "$NON200" -le 2 ] || fail "row 3: $NON200 non-200 across the blink (> 2)"
CRASH=$(X 'stat -c "%u:%g %a" /control/.host-crash; cat /control/.host-crash')
log "row 3: .host-crash: $(echo "$CRASH" | tr '\n' ' ')"
echo "$CRASH" | head -1 | grep -q '^1000:1000 600$' || fail "row 3: .host-crash not 1000:1000 0600"
[ "$(echo "$CRASH" | tail -n +2 | wc -l)" = 1 ] || fail "row 3: .host-crash has $(echo "$CRASH" | tail -n +2 | wc -l) lines (want 1)"
echo "$CRASH" | tail -1 | python3 -c 'import json,sys; j=json.loads(sys.stdin.read()); assert j["signal"]=="SIGKILL" and j["exits"]==1 and j["code"] is None and j["at"]>0, j' || fail "row 3: crash line shape"
X 'test -f /run/atelier/host-ready && echo present' | grep -q present || fail "row 3: host-ready absent after the restart"

log "row 4: kill -TERM 1 → supervisor exit 1 mirrored → in-place container restart over the same /run/atelier"
DT0=$(X 'cat /run/atelier/dev.token' | tr -d '\r\n')
t0=$(now); X 'kill -TERM 1'
for i in $(seq 1 300); do rc=$($K get pod computer -o jsonpath='{.status.containerStatuses[0].restartCount}'); [ "$rc" = 1 ] && break; sleep 0.2; done
EXIT=$($K get pod computer -o jsonpath='{.status.containerStatuses[0].lastState.terminated.exitCode}')
log "row 4: restartCount=$rc after $(el $t0) s; previous container exit code=$EXIT"
[ "$rc" = 1 ] || fail "row 4: no container restart within 60 s"
[ "$EXIT" = 1 ] || fail "row 4: mirrored exit code $EXIT (want 1 = the supervisor stub's SIGTERM exit)"
R5=$(waitready 90); log "row 4: Ready again $R5 s later ($(el $t0) s after the TERM) — $(readyq)"
[ "$R5" = timeout ] && fail "row 4: not Ready after the container restart"
DT1=$(X 'cat /run/atelier/dev.token' | tr -d '\r\n')
[ -n "$DT1" ] && [ "$DT1" != "$DT0" ] && log "row 4: dev token re-minted" || fail "row 4: dev token not re-minted ([$DT0] → [$DT1])"
log "row 4: second life plan lines:"; $K logs computer -c session 2>&1 | grep -E 'reclaimed|exists|unlink|host-ready' | sed 's/^/    | /'
$K logs computer -c session 2>&1 | grep -q 'mkdir /run/atelier/session 0700: ok (exists 1000:1000 0700 — reclaimed 0:0)' || fail "row 4: session dir not reclaimed in the second life"
check5=$(X 'stat -c "%u:%g %a %n" /run/atelier/session /run/atelier/session/dev.token /run/atelier/dev.token /run/atelier/host-ready /work /work/.atelier 2>&1' | tr '\n' '|')
log "row 4: stats after restart: $check5"
echo "$check5" | grep -q '1000:1000 700 /run/atelier/session|1000:1000 400 /run/atelier/session/dev.token|0:0 400 /run/atelier/dev.token|0:0 644 /run/atelier/host-ready|1000:1000 755 /work|0:0 755 /work/.atelier' || fail "row 4: ownership after the restart"
[ "$(X 'cat /run/atelier/session/dev.token' | tr -d '\r\n')" = "$DT1" ] || fail "row 4: session copy differs from the host copy after the restart"
PREV=$($K logs computer -c session --previous 2>&1); echo "$PREV" | grep -q 'SIGTERM: host first' || fail "row 4: first life has no SIGTERM order line"
echo "$PREV" | grep -q '\[host-stub\] SIGTERM → teardown' || fail "row 4: the host was not signalled before exit"
echo "$PREV" | grep -E 'SIGTERM|exit|teardown' | sed 's/^/    | prev: /'

log "row 5: ten host kills inside 10 min (second life) → parked; restart delays 0.5,1,2,4,8,16,30,30,30 s ≈ 2 min"
S2=$(suppid); t0=$(now); n=0
for i in $(seq 1 10); do
  hp=""; for j in $(seq 1 400); do hp=$(hostpid); [ -n "$hp" ] && break; sleep 0.1; done
  [ -z "$hp" ] && { fail "row 5: no host to kill at iteration $i"; break; }
  X "kill -9 $hp"; n=$((n+1)); sleep 0.3
done
sleep 3
PARK=$($K logs computer -c session 2>&1 | grep -c 'host: parked after 10 exits/10 min')
LINES=$(X 'wc -l < /control/.host-crash' | tr -d ' \r\n')
log "row 5: $n kills in $(el $t0) s; parked lines=$PARK; .host-crash lines=$LINES (1 from row 3 + 10); host pid now=[$(hostpid)]; $(readyq)"
[ "$PARK" = 1 ] || fail "row 5: no park line after 10 exits"
[ "$LINES" = 11 ] || fail "row 5: .host-crash has $LINES lines (want 11)"
[ -z "$(hostpid)" ] || fail "row 5: a host is still being restarted while parked"
case "$(readyq)" in "False rc=1 phase=Running") ;; *) fail "row 5: pod state while parked: $(readyq) (want unready, rc=1, Running)";; esac
[ "$(suppid)" = "$S2" ] || fail "row 5: supervisor pid changed during the storm"
$K logs computer -c session 2>&1 | grep 'host: restart in' | sed 's/^/    | /'
X 'stat -c "%u:%g %a" /control/.host-crash; tail -2 /control/.host-crash' | sed 's/^/    | /'

log "row 6: pod delete with grace 40 → SIGTERM order, host teardown, termination time"
t0=$(now); $K delete pod computer --grace-period=40 --wait=false >/dev/null
for i in $(seq 1 300); do $K get pod computer >/dev/null 2>&1 || break; sleep 0.2; done
GONE=$(el $t0); log "row 6: pod gone after $GONE s"
python3 -c "import sys; sys.exit(0 if $GONE < 40 else 1)" || fail "row 6: termination took $GONE s (grace 40)"
# the logs of the deleted pod are gone with it; row 5's --previous capture is the evidence of the order

log "== VERDICT"
[ $FAILS = 0 ] && echo "VERDICT: PASS — Ready ${SINCE_START}s after start; kill -9 → Ready back in $(printf %s "$R3")s, $NON200/$TOTAL non-200 across the blink; parked after 10 exits; restart mirrored exit $EXIT, tokens re-minted; delete in ${GONE}s; inpod $IN" \
                || echo "VERDICT: FAIL — ${FAILS} row(s): ${WHY#; }"
