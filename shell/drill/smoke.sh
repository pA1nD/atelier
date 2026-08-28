#!/usr/bin/env bash
# shell/drill/smoke.sh — ONE background task: the shell (local providers) in front of the real host on this Mac.
# Ends in a VERDICT line; ≤ 3 min. Ports 18440/18450/18460.
cd "$(dirname "$0")/../.." || exit 1
timeout 190 node shell/drill/smoke.mjs 2>&1
rc=$?
[ $rc -eq 124 ] && echo "VERDICT: FAIL — timeout 190 s"
exit $rc
