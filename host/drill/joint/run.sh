#!/bin/bash
# Laptop side of the JOINT step-2 drill (PLAN §4.9 step 2, the last proof): the real host (this repo,
# branch host) against the real spine registrar (agent-orchestrator branch step2-spine,
# src/registry/serve.ts built to dist/) in ONE throwaway namespace on fsn-01. Pins both image digests
# from metal/clusters/prod/spine.yaml (the orchestrator image for the registrar pod, the agent image
# for the computer pod), tars the host tree + drill apps (as host/drill/step2 does) and the spine's
# dist/, ships remote.sh + the pod templates, runs remote.sh there (bounded), copies out/ back, makes
# sure the namespace is gone. ONE backgrounded task; the last line is the VERDICT.
#   bash host/drill/joint/run.sh > host/drill/joint/run.log
set -u
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
SPINE_YAML=${SPINE_YAML:-/Users/pa1nd/pro/005-fleet-infra/metal/clusters/prod/spine.yaml}
MODULES=${MODULES:-/Users/pa1nd/pro/003-atelier-modules}
SPINE_WT=${SPINE_WT:-/Users/pa1nd/pro/005-fleet-infra/agent-orchestrator/.claude/worktrees/step2-spine}
NS=spike-step2-joint
CODE=/tmp/$NS-code
echo "== joint step-2 drill $(date -u +%FT%TZ) — host $REPO ($(git -C "$REPO" branch --show-current) @ $(git -C "$REPO" rev-parse --short HEAD)); spine $SPINE_WT ($(git -C "$SPINE_WT" branch --show-current) @ $(git -C "$SPINE_WT" rev-parse --short HEAD)); target fsn-01, ns $NS"
AGENT_IMAGE=$(grep -o 'ghcr.io/pa1nd/agent-image@sha256:[0-9a-f]*' "$SPINE_YAML" | head -1)
ORCH_IMAGE=$(grep -o 'ghcr.io/pa1nd/agent-orchestrator@sha256:[0-9a-f]*' "$SPINE_YAML" | head -1)
[ -n "$AGENT_IMAGE" ] && [ -n "$ORCH_IMAGE" ] || { echo "VERDICT: BLOCKED — image digests missing in $SPINE_YAML"; exit 1; }
echo "== agent image: $AGENT_IMAGE"; echo "== orchestrator image: $ORCH_IMAGE"
[ -f "$SPINE_WT/dist/registry/serve.js" ] || { echo "VERDICT: BLOCKED — $SPINE_WT/dist/registry/serve.js missing (npm run build in the spine worktree)"; exit 1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
STAGE=$TMP/tree; mkdir -p "$STAGE/drill-apps"
for p in host protocol package.json package-lock.json index.html client.jsx chrome-resolve.js shims; do [ -e "$REPO/$p" ] && cp -R "$REPO/$p" "$STAGE/$p"; done
rm -rf "$STAGE"/host/drill/*/out
[ -f "$MODULES/blitzfeed/backend.js" ] || { echo "VERDICT: BLOCKED — $MODULES/blitzfeed missing"; exit 1; }
mkdir -p "$STAGE/drill-apps/blitzfeed"
cp "$MODULES/blitzfeed/backend.js" "$MODULES/blitzfeed/frontend.jsx" "$STAGE/drill-apps/blitzfeed/"
echo '{ "name": "BlitzFeed" }' > "$STAGE/drill-apps/blitzfeed/module.json"
printf '.blitzfeed-drill { color: rebeccapurple }\n' > "$STAGE/drill-apps/blitzfeed/styles.css"
cp -R "$HERE/../step2/probe" "$STAGE/drill-apps/probe"
tar -C "$STAGE" --exclude='*.log' -czf "$TMP/code.tgz" . || { echo "VERDICT: BLOCKED — tar failed"; exit 1; }
tar -C "$SPINE_WT" -czf "$TMP/spine.tgz" dist || { echo "VERDICT: BLOCKED — spine dist tar failed"; exit 1; }
echo "== shipping code $(du -h "$TMP/code.tgz" | cut -f1), spine dist $(du -h "$TMP/spine.tgz" | cut -f1)"
printf '%s\n%s\n' "$AGENT_IMAGE" "$ORCH_IMAGE" > "$TMP/images.txt"
ssh -n -o ConnectTimeout=15 fsn-01 "rm -rf $CODE && mkdir -p $CODE/out" || { echo "VERDICT: BLOCKED — ssh fsn-01 failed"; exit 1; }
scp -q "$TMP/code.tgz" "$TMP/spine.tgz" "$TMP/images.txt" "$HERE/remote.sh" "$HERE/trip.js" "$HERE/pod.yaml.tpl" "$HERE/spine.yaml.tpl" "fsn-01:$CODE/" || { echo "VERDICT: BLOCKED — scp failed"; exit 1; }
timeout 1200 ssh -n fsn-01 "bash $CODE/remote.sh" 2>&1 | tee "$TMP/remote.log"; rc=${PIPESTATUS[0]}
mkdir -p "$HERE/out"; scp -q "fsn-01:$CODE/out/*" "$HERE/out/" 2>/dev/null; cp "$TMP/remote.log" "$HERE/out/remote.log"
ssh -n fsn-01 "kubectl get ns $NS >/dev/null 2>&1 && kubectl delete ns $NS --wait=false; rm -rf $CODE" 2>/dev/null
echo "== remote exit=$rc; ns after run: $(ssh -n fsn-01 "kubectl get ns $NS 2>&1 | tail -1")"
V=$(grep '^VERDICT:' "$TMP/remote.log" | tail -1)
[ -n "$V" ] && echo "$V" || echo "VERDICT: FAIL — remote.sh ended without a verdict (rc=$rc)"
