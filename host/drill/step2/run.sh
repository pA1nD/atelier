#!/bin/bash
# Laptop side of the step-2 drill (PLAN §4.9 step 2, DESIGN §8.2 rows the integrator owes): pins the
# agent image digest from metal/clusters/prod/spine.yaml, tars host/ + protocol/ + package.json(+lock)
# + the drill apps (one real 1.x module copied from 003-atelier-modules, the probe app), ships it with
# remote.sh + inpod.sh + the pod templates to fsn-01, runs remote.sh there (bounded), copies out/ back,
# makes sure the namespace is gone. ONE backgrounded task; the last line is the VERDICT.
#   bash host/drill/step2/run.sh > host/drill/step2/run.log
set -u
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
SPINE_YAML=${SPINE_YAML:-/Users/pa1nd/pro/005-fleet-infra/metal/clusters/prod/spine.yaml}
MODULES=${MODULES:-/Users/pa1nd/pro/003-atelier-modules}
CODE=/tmp/spike-host-step2-code
echo "== host step-2 drill $(date -u +%FT%TZ) — repo $REPO ($(git -C "$REPO" branch --show-current) @ $(git -C "$REPO" rev-parse --short HEAD)), target fsn-01, ns spike-host-step2"
IMAGE=$(grep -o 'ghcr.io/pa1nd/agent-image@sha256:[0-9a-f]*' "$SPINE_YAML" | head -1)
[ -n "$IMAGE" ] || { echo "VERDICT: BLOCKED — no agent-image digest in $SPINE_YAML"; exit 1; }
echo "== image: $IMAGE"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
STAGE=$TMP/tree; mkdir -p "$STAGE/drill-apps"
for p in host protocol package.json package-lock.json index.html client.jsx chrome-resolve.js shims; do [ -e "$REPO/$p" ] && cp -R "$REPO/$p" "$STAGE/$p"; done
rm -rf "$STAGE/host/drill/step2/out" "$STAGE/host/drill/launcher/out"
# the one real 1.x module: blitzfeed (backend.js + frontend.jsx, no package.json, no native deps) + module.json + a sheet
[ -f "$MODULES/blitzfeed/backend.js" ] || { echo "VERDICT: BLOCKED — $MODULES/blitzfeed missing"; exit 1; }
mkdir -p "$STAGE/drill-apps/blitzfeed"
cp "$MODULES/blitzfeed/backend.js" "$MODULES/blitzfeed/frontend.jsx" "$STAGE/drill-apps/blitzfeed/"
echo '{ "name": "BlitzFeed" }' > "$STAGE/drill-apps/blitzfeed/module.json"
printf '.blitzfeed-drill { color: rebeccapurple }\n' > "$STAGE/drill-apps/blitzfeed/styles.css"
cp -R "$HERE/probe" "$STAGE/drill-apps/probe"
tar -C "$STAGE" --exclude='*.log' -czf "$TMP/code.tgz" . || { echo "VERDICT: BLOCKED — tar failed"; exit 1; }
echo "== shipping $(du -h "$TMP/code.tgz" | cut -f1): $(ls "$STAGE" | tr '\n' ' ')"
echo "$IMAGE" > "$TMP/image.txt"
ssh -n -o ConnectTimeout=15 fsn-01 "rm -rf $CODE && mkdir -p $CODE/out" || { echo "VERDICT: BLOCKED — ssh fsn-01 failed"; exit 1; }
scp -q "$TMP/code.tgz" "$TMP/image.txt" "$HERE/remote.sh" "$HERE/inpod.sh" "$HERE/pod.yaml.tpl" "$HERE/peer.yaml.tpl" "fsn-01:$CODE/" || { echo "VERDICT: BLOCKED — scp failed"; exit 1; }
timeout 1200 ssh -n fsn-01 "bash $CODE/remote.sh" 2>&1 | tee "$TMP/remote.log"; rc=${PIPESTATUS[0]}
mkdir -p "$HERE/out"; scp -q "fsn-01:$CODE/out/*" "$HERE/out/" 2>/dev/null; cp "$TMP/remote.log" "$HERE/out/remote.log"
ssh -n fsn-01 "kubectl get ns spike-host-step2 >/dev/null 2>&1 && kubectl delete ns spike-host-step2 --wait=false; rm -rf $CODE" 2>/dev/null
echo "== remote exit=$rc; ns after run: $(ssh -n fsn-01 'kubectl get ns spike-host-step2 2>&1 | tail -1')"
V=$(grep '^VERDICT:' "$TMP/remote.log" | tail -1)
[ -n "$V" ] && echo "$V" || echo "VERDICT: FAIL — remote.sh ended without a verdict (rc=$rc)"
