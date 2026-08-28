#!/bin/bash
# Runs INSIDE the session container as root (kubectl exec): stats every path the launcher owns,
# checks the process tree, the token files, the env rows, the umasks, the root-owned-inode rule
# as uid 1000, the tmux socket-dir rule, then runs the launcher's node tests on Linux.
# Every row prints `PASS <row>` or `FAIL <row> — <what was seen>`; the last line is `INPOD: pass=N fail=M`.
P=0; F=0
pass(){ P=$((P+1)); echo "PASS $1"; }
fail(){ F=$((F+1)); echo "FAIL $1 — $2"; }
check(){ [ "$2" = "$3" ] && pass "$1 = $2" || fail "$1" "want [$3] got [$2]"; }
as1000(){ setpriv --reuid=1000 --regid=1000 --clear-groups "$@"; }
as20001(){ setpriv --reuid=20001 --regid=20001 --clear-groups "$@"; }
st(){ stat -c '%u:%g %a' "$1" 2>&1; }

echo "== process tree"
ps -eo pid,ppid,uid,gid,comm,args | grep -v ' ps ' | sed 's/^/   /'
check "PID 1 is bash" "$(cat /proc/1/comm)" "bash"
L=$(pgrep -f '^node /code/host/launcher.mjs' | head -1); H=$(pgrep -f '^node /code/host/index.mjs' | head -1); S=$(pgrep -f '^node /app/session-supervisor.mjs' | head -1)
[ -n "$L" ] && pass "launcher pid $L (ppid $(awk '/^PPid/{print $2}' /proc/$L/status), uid $(awk '/^Uid/{print $2}' /proc/$L/status))" || fail "launcher running" "no launcher.mjs process"
[ -n "$H" ] && pass "host pid $H" || fail "host running" "no host/index.mjs process"
[ -n "$S" ] && pass "session supervisor pid $S" || fail "session supervisor running" "no session-supervisor.mjs process"
check "host uid" "$(awk '/^Uid/{print $2}' /proc/$H/status)" "0"
check "host fd 3 → /work/.atelier" "$(readlink /proc/$H/fd/3)" "/work/.atelier"
check "launcher holds the dirfd too" "$(ls -l /proc/$L/fd | grep -c '/work/.atelier$')" "1"
check "session supervisor uid" "$(awk '/^Uid/{print $2}' /proc/$S/status)" "1000"
check "session supervisor gid" "$(awk '/^Gid/{print $2}' /proc/$S/status)" "1000"
check "session supervisor supplementary groups" "$(awk '/^Groups/{$1=""; print $0}' /proc/$S/status | xargs)" "19999"
check "host supplementary groups (root's, empty)" "$(awk '/^Groups/{$1=""; print $0}' /proc/$H/status | xargs)" ""
check "host umask" "$(awk '/^Umask/{print $2}' /proc/$H/status)" "0077"
check "session supervisor umask" "$(awk '/^Umask/{print $2}' /proc/$S/status)" "0022"
check "host cwd" "$(readlink /proc/$H/cwd)" "/"
check "session supervisor cwd" "$(readlink /proc/$S/cwd)" "/work"
check "host CapEff" "$(awk '/^CapEff/{print $2}' /proc/$H/status)" "$(awk '/^CapEff/{print $2}' /proc/1/status)"
check "session supervisor CapEff" "$(awk '/^CapEff/{print $2}' /proc/$S/status)" "0000000000000000"

echo "== env rows (from /proc/<pid>/environ)"
henv=$(tr '\0' '\n' < /proc/$H/environ); senv=$(tr '\0' '\n' < /proc/$S/environ)
check "H: ATELIER_DIRFD" "$(echo "$henv" | grep '^ATELIER_DIRFD=' )" "ATELIER_DIRFD=3"
check "H: no ATELIER_BOOTSTRAP" "$(echo "$henv" | grep -c '^ATELIER_BOOTSTRAP=')" "0"
check "H: no CHANNEL_*" "$(echo "$henv" | grep -c '^CHANNEL_')" "0"
check "H: HOME" "$(echo "$henv" | grep '^HOME=')" "HOME=/root"
check "H: ATELIER_SPINE_URL = pod CHANNEL_URL" "$(echo "$henv" | grep '^ATELIER_SPINE_URL=')" "ATELIER_SPINE_URL=http://127.0.0.1:9"
check "S: no ATELIER_BOOTSTRAP" "$(echo "$senv" | grep -c '^ATELIER_BOOTSTRAP=')" "0"
check "S: no ATELIER_*" "$(echo "$senv" | grep -c '^ATELIER_')" "0"
check "S: CHANNEL_TOKEN kept" "$(echo "$senv" | grep '^CHANNEL_TOKEN=')" "CHANNEL_TOKEN=canary-channel-token"
check "S: HOME" "$(echo "$senv" | grep '^HOME=')" "HOME=/work"
check "S: PERSONA_TEXT kept" "$(echo "$senv" | grep -c '^PERSONA_TEXT=')" "1"
echo "   H keys: $(echo "$henv" | cut -d= -f1 | sort | tr '\n' ' ')"
echo "   S keys: $(echo "$senv" | cut -d= -f1 | sort | tr '\n' ' ')"
check "/proc/1/environ unreadable by uid 1000" "$(as1000 cat /proc/1/environ 2>&1 >/dev/null | grep -c 'Permission denied')" "1"

echo "== filesystem contract (DESIGN §3 rows the launcher owns)"
check "/work" "$(st /work)" "1000:1000 755"
check "/work/lost+found" "$(st /work/lost+found)" "1000:1000 700"
check "/work/apps" "$(st /work/apps)" "1000:1000 755"
check "/work/.atelier" "$(st /work/.atelier)" "0:0 711"
check "/work/.atelier/data" "$(st /work/.atelier/data)" "0:0 711"
check "/work/.atelier/last-good" "$(st /work/.atelier/last-good)" "0:0 711"
check "/work/.atelier/scratch" "$(st /work/.atelier/scratch)" "0:0 711"
check "/run/atelier" "$(st /run/atelier)" "0:0 711"
check "/run/atelier/dev" "$(st /run/atelier/dev)" "0:1000 710"
check "/run/atelier/session" "$(st /run/atelier/session)" "1000:1000 700"
check "/run/atelier/session/dev.token" "$(st /run/atelier/session/dev.token)" "1000:1000 400"
check "/run/atelier/dev.token" "$(st /run/atelier/dev.token)" "0:0 400"
check "/run/atelier/bootstrap.token" "$(st /run/atelier/bootstrap.token)" "0:0 400"
check "/run/atelier/host-ready" "$(st /run/atelier/host-ready)" "0:0 644"
check "/tmp/tmux-1000" "$(st /tmp/tmux-1000)" "1000:1000 700"
check "/tmp/.X11-unix" "$(st /tmp/.X11-unix)" "0:0 1777"
check "/control" "$(st /control)" "1000:1000 700"

echo "== tokens"
check "bootstrap.token content" "$(cat /run/atelier/bootstrap.token)" "canary-bootstrap-secret"
DT=$(cat /run/atelier/dev.token)
[ "${#DT}" = 64 ] && [[ "$DT" =~ ^[0-9a-f]{64}$ ]] && pass "dev.token is 64 hex" || fail "dev.token is 64 hex" "[$DT]"
check "session copy equals the host copy" "$(cat /run/atelier/session/dev.token)" "$DT"
check "uid 1000 reads its copy" "$(as1000 cat /run/atelier/session/dev.token)" "$DT"
check "uid 1000 cannot read the host copy" "$(as1000 cat /run/atelier/dev.token 2>&1 | grep -c 'Permission denied')" "1"
check "uid 1000 cannot read bootstrap.token" "$(as1000 cat /run/atelier/bootstrap.token 2>&1 | grep -c 'Permission denied')" "1"
check "uid 20001 cannot read the session copy" "$(as20001 cat /run/atelier/session/dev.token 2>&1 | grep -c 'Permission denied')" "1"
check "uid 20001 cannot list /run/atelier/dev" "$(as20001 ls /run/atelier/dev 2>&1 | grep -c 'Permission denied')" "1"
check "uid 1000 can enter /run/atelier/dev" "$(as1000 ls /run/atelier/dev 2>&1 | grep -c 'Permission denied')" "0"

echo "== root-owned inodes in /work + /control as uid 1000 (.atelier excluded by design)"
ROOTS=$(as1000 find /work /control ! -uid 1000 -not -path '/work/.atelier' -not -path '/work/.atelier/*' -printf '%m %u:%g %p\n' 2>&1)
check "count outside .atelier" "$(echo -n "$ROOTS" | grep -c .)" "0"
[ -n "$ROOTS" ] && echo "   $ROOTS"
echo "   .atelier tree (root by design): $(find /work/.atelier -printf '%m %u:%g %p\n' | tr '\n' '|')"
check "uid 1000 can rename .atelier (owner of /work; the host works through the dirfd)" "$(as1000 sh -c 'mv /work/.atelier /work/.atelier.moved && mv /work/.atelier.moved /work/.atelier && echo renamed')" "renamed"
check "host fd 3 still resolves after the rename round trip" "$(readlink /proc/$H/fd/3)" "/work/.atelier"
check "root cannot create in 1000-owned /work (why markers come first)" "$(mkdir /work/h 2>&1 | grep -c 'Permission denied')" "1"

echo "== the tmux socket-dir rule and the X11 dir"
T=$(as1000 env HOME=/work tmux -S /tmp/tmux-1000/default new-session -d -s drill 'sleep 30' 2>&1; echo "rc=$?")
check "tmux as uid 1000 through /tmp/tmux-1000" "$(echo "$T" | tail -1)" "rc=0"
as1000 tmux -S /tmp/tmux-1000/default kill-server 2>/dev/null
check "uid 1000 can create under /tmp/.X11-unix" "$(as1000 sh -c 'mkdir /tmp/.X11-unix/X99 && rmdir /tmp/.X11-unix/X99 && echo ok')" "ok"

echo "== node --test host/test/launcher*.test.js inside the pod (Linux, root)"
cd /code && out=$(ATELIER_DRILL=1 node --test host/test/launcher*.test.js 2>&1); rc=$?
echo "$out" | grep -E '^ℹ (tests|pass|fail)' | sed 's/^/   /'
check "node --test rc" "$rc" "0"

echo "INPOD: pass=$P fail=$F"
