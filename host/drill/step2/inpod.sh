#!/bin/bash
# Runs INSIDE the session container as root (kubectl exec): row (a) — owner:group:mode of every path
# of DESIGN §3 the launcher, the host, the supervisor and the workers create, plus the process tree
# (host root with fd 3, workers at 20000+i with no groups, umask 002, no caps, cwd = the app folder).
# Args: <inst-blitzfeed> <uid-blitzfeed> <inst-probe> <uid-probe> <rev-blitzfeed>
# Every row prints `PASS <row>` or `FAIL <row> — <what was seen>`; the last line is `INPOD: pass=N fail=M`.
IB=$1; UB=$2; IP=$3; UP=$4; REV=$5
P=0; F=0
pass(){ P=$((P+1)); echo "PASS $1"; }
fail(){ F=$((F+1)); echo "FAIL $1 — $2"; }
check(){ [ "$2" = "$3" ] && pass "$1 = $2" || fail "$1" "want [$3] got [$2]"; }
st(){ stat -c '%u:%g %a' "$1" 2>&1; }
as1000(){ setpriv --reuid=1000 --regid=1000 --clear-groups "$@"; }
A=/work/.atelier; R=/run/atelier

echo "== process tree"
ps -eo pid,ppid,uid,gid,comm,args | grep -v ' ps ' | sed 's/^/   /'
check "PID 1 is bash" "$(cat /proc/1/comm)" "bash"
L=$(pgrep -f '^node /code/host/launcher.mjs' | head -1); H=$(pgrep -f '^node /code/host/index.mjs' | head -1); S=$(pgrep -f '^node /app/session-supervisor.mjs' | head -1)
[ -n "$L" ] && pass "launcher pid $L" || fail "launcher running" "none"
[ -n "$H" ] && pass "host pid $H" || fail "host running" "none"
[ -n "$S" ] && pass "session supervisor pid $S" || fail "session supervisor running" "none"
check "host uid" "$(awk '/^Uid/{print $2}' /proc/$H/status)" "0"
check "host fd 3 → /work/.atelier" "$(readlink /proc/$H/fd/3)" "/work/.atelier"
check "host umask" "$(awk '/^Umask/{print $2}' /proc/$H/status)" "0077"
check "host cwd" "$(readlink /proc/$H/cwd)" "/"
check "host supplementary groups (between reads: none)" "$(awk '/^Groups/{$1=""; print $0}' /proc/$H/status | xargs)" ""
check "session supervisor uid/groups" "$(awk '/^Uid/{print $2}' /proc/$S/status)/$(awk '/^Groups/{$1=""; print $0}' /proc/$S/status | xargs)" "1000/19999"
for pair in "blitzfeed $UB $IB" "probe $UP $IP"; do
  set -- $pair; slug=$1; uid=$2; inst=$3
  W=$(ps -eo pid,uid,args | awk -v u=$uid '$2==u && /worker\/runtime.mjs/ {print $1}' | head -1)
  [ -n "$W" ] && pass "$slug worker pid $W (uid $uid)" || { fail "$slug worker running as $uid" "none"; continue; }
  check "$slug worker Uid line (real/effective/saved/fs)" "$(awk '/^Uid/{print $2,$3,$4,$5}' /proc/$W/status)" "$uid $uid $uid $uid"
  check "$slug worker Gid line" "$(awk '/^Gid/{print $2,$3,$4,$5}' /proc/$W/status)" "$uid $uid $uid $uid"
  check "$slug worker supplementary groups" "$(awk '/^Groups/{$1=""; print $0}' /proc/$W/status | xargs)" ""
  check "$slug worker umask" "$(awk '/^Umask/{print $2}' /proc/$W/status)" "0002"
  check "$slug worker CapEff" "$(awk '/^CapEff/{print $2}' /proc/$W/status)" "0000000000000000"
  echo "   $slug worker cwd/environ: ptrace-restricted for userns root (no CAP_SYS_PTRACE) — readlink cwd → [$(readlink /proc/$W/cwd 2>&1 | head -c 60)]; row (c) reads both from inside the worker"
  check "$slug worker oom_score_adj" "$(cat /proc/$W/oom_score_adj)" "1000"
  check "$slug worker RLIMIT_DATA" "$(awk '/Max data size/{print $4}' /proc/$W/limits)" "1073741824"
  check "$slug worker RLIMIT_NPROC" "$(awk '/Max processes/{print $3}' /proc/$W/limits)" "64"
  check "$slug worker RLIMIT_CORE" "$(awk '/Max core file size/{print $5}' /proc/$W/limits)" "0"

done

echo "== filesystem contract (DESIGN §3)"
check "/work" "$(st /work)" "1000:1000 755"
check "/work/apps" "$(st /work/apps)" "1000:1000 755"
check "/work/apps/blitzfeed" "$(st /work/apps/blitzfeed)" "1000:$UB 2750"
check "/work/apps/probe" "$(st /work/apps/probe)" "1000:$UP 2750"
check "/work/apps/blitzfeed/backend.js (the agent's file, untouched; stat as the owner — root has no DAC)" "$(as1000 stat -c '%u:%g %a' /work/apps/blitzfeed/backend.js 2>&1)" "1000:1000 644"
check "/work/.claude (the agent's)" "$(st /work/.claude)" "1000:1000 700"
check "$A" "$(st $A)" "0:0 755"
check "$A/agent.log" "$(st $A/agent.log)" "0:1000 640"
check "$A/$IB (marker dir)" "$(st $A/$IB)" "0:0 711"
check "$A/$IB/slug" "$(st $A/$IB/slug)" "0:0 644"
check "$A/$IB/uid" "$(st $A/$IB/uid)" "0:0 644"
check "$A/$IB/revision.json" "$(st $A/$IB/revision.json)" "0:0 644"
check "$A/$IB/registered.json" "$(st $A/$IB/registered.json)" "0:0 600"
check "$A/$IB/current → rev-$REV" "$(readlink $A/$IB/current)" "../last-good/$IB/rev-$REV"
check "$A/data" "$(st $A/data)" "0:0 711"
check "$A/data/$IB" "$(st $A/data/$IB)" "$UB:19999 2770"
check "$A/data/$IP" "$(st $A/data/$IP)" "$UP:19999 2770"
echo "   data file the probe worker wrote (stat as its uid — root has no DAC into 2770): $(setpriv --reuid=$UP --regid=$UP --clear-groups stat -c '%u:%g %a %n' $A/data/$IP/probe.txt 2>&1) (umask 002 → 0664 inside a 2770 dir)"
check "$A/last-good" "$(st $A/last-good)" "0:0 711"
check "$A/last-good/$IB" "$(st $A/last-good/$IB)" "0:$UB 750"
check "$A/last-good/$IB/rev-$REV" "$(st $A/last-good/$IB/rev-$REV)" "0:$UB 750"
check "$A/last-good/$IB/rev-$REV/backend.js" "$(st $A/last-good/$IB/rev-$REV/backend.js)" "0:$UB 640"
check "$A/last-good/$IB/rev-$REV/frontend/frontend.js" "$(st $A/last-good/$IB/rev-$REV/frontend/frontend.js)" "0:$UB 640"
check "$A/last-good/$IB/rev-$REV/styles.css" "$(st $A/last-good/$IB/rev-$REV/styles.css)" "0:$UB 640"
check "$A/scratch" "$(st $A/scratch)" "0:0 711"
check "$A/tmp" "$(st $A/tmp)" "0:0 711"
check "$A/tmp/$IB" "$(st $A/tmp/$IB)" "$UB:$UB 700"
check "$R" "$(st $R)" "0:0 711"
check "$R/w" "$(st $R/w)" "0:0 711"
check "$R/w/$IB" "$(st $R/w/$IB)" "0:$UB 730"
check "$R/w/$IB/w-$REV.sock (after READY)" "$(st $R/w/$IB/w-$REV.sock)" "0:0 700"
check "$R/dev" "$(st $R/dev)" "0:1000 710"
check "$R/dev/shell.sock" "$(st $R/dev/shell.sock)" "0:1000 660"
check "$R/bootstrap.token" "$(st $R/bootstrap.token)" "0:0 400"
check "$R/dev.token" "$(st $R/dev.token)" "0:0 400"
check "$R/session" "$(st $R/session)" "1000:1000 700"
check "$R/session/dev.token (stat as the owner)" "$(as1000 stat -c '%u:%g %a' $R/session/dev.token 2>&1)" "1000:1000 400"
check "$R/host-ready" "$(st $R/host-ready)" "0:0 644"
check "/control" "$(st /control)" "1000:1000 700"
check "/work/lost+found" "$(st /work/lost+found)" "1000:1000 700"
check "/tmp/tmux-1000" "$(st /tmp/tmux-1000)" "1000:1000 700"
check "/tmp/.X11-unix" "$(st /tmp/.X11-unix)" "0:0 1777"

echo "== the agent's view (uid 1000, group 1000 only — the real agent also carries 19999)"
check "agent reads agent.log" "$(as1000 head -c 4 $A/agent.log)" "2026"
check "agent lists its app folder" "$(as1000 ls /work/apps/blitzfeed | tr '\n' ' ')" "backend.js frontend.jsx module.json styles.css "
check "agent cannot list last-good/$IB" "$(as1000 ls $A/last-good/$IB 2>&1 | grep -c 'Permission denied')" "1"
check "agent cannot read bootstrap.token" "$(as1000 cat $R/bootstrap.token 2>&1 | grep -c 'Permission denied')" "1"
check "agent reads its dev token" "$(as1000 sh -c "wc -c < $R/session/dev.token")" "64"
check "root-owned inodes in /work outside .atelier, as uid 1000" "$(as1000 find /work ! -uid 1000 -not -path '/work/.atelier' -not -path '/work/.atelier/*' 2>/dev/null | wc -l)" "0"
echo "   .atelier + /run/atelier tree:"; find $A $R -printf '   %m %u:%g %p\n' | sort

echo "INPOD: pass=$P fail=$F"
