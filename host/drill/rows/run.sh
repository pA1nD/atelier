#!/bin/bash
# Laptop side of the rows drill (DESIGN §8.2 rows 5–8 on the integrated host; the launcher rows 1–6 are
# host/drill/launcher/run.sh). Pins the agent image digest from metal/clusters/prod/spine.yaml, tars host/ +
# protocol/ + package.json(+lock) + the drill apps (probe, hello, locker, deps + the hostile loot-pkg tgz),
# ships it with remote.sh and the step-2 harness (fake spine, signer, pod templates) to fsn-01, runs
# remote.sh there (bounded), copies out/ back, makes sure the namespace is gone. ONE backgrounded task;
# the last line is the VERDICT.
#   bash host/drill/rows/run.sh > host/drill/rows/run.log
set -u
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd); STEP2=$HERE/../step2
SPINE_YAML=${SPINE_YAML:-/Users/pa1nd/pro/005-fleet-infra/metal/clusters/prod/spine.yaml}
NS=spike-step2-rows; CODE=/tmp/$NS-code
echo "== host rows drill $(date -u +%FT%TZ) — repo $REPO ($(git -C "$REPO" branch --show-current) @ $(git -C "$REPO" rev-parse --short HEAD)), target fsn-01, ns $NS"
IMAGE=$(grep -o 'ghcr.io/pa1nd/agent-image@sha256:[0-9a-f]*' "$SPINE_YAML" | head -1)
[ -n "$IMAGE" ] || { echo "VERDICT: BLOCKED — no agent-image digest in $SPINE_YAML"; exit 1; }
echo "== image: $IMAGE"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
STAGE=$TMP/tree; mkdir -p "$STAGE/drill-apps"
for p in host protocol package.json package-lock.json index.html client.jsx chrome-resolve.js shims; do [ -e "$REPO/$p" ] && cp -R "$REPO/$p" "$STAGE/$p"; done
rm -rf "$STAGE/host/drill/step2/out" "$STAGE/host/drill/launcher/out" "$STAGE/host/drill/rows/out"
cp -R "$HERE/apps/." "$STAGE/drill-apps/"
cp "$HERE/loot-pkg-1.0.0.tgz" "$STAGE/drill-apps/"
COPYFILE_DISABLE=1 tar -C "$STAGE" --exclude='*.log' -czf "$TMP/code.tgz" . || { echo "VERDICT: BLOCKED — tar failed"; exit 1; }
echo "== shipping $(du -h "$TMP/code.tgz" | cut -f1): $(ls "$STAGE/drill-apps" | tr '\n' ' ')"
echo "$IMAGE" > "$TMP/image.txt"
ssh -n -o ConnectTimeout=15 fsn-01 "rm -rf $CODE && mkdir -p $CODE/out" || { echo "VERDICT: BLOCKED — ssh fsn-01 failed"; exit 1; }
scp -q "$TMP/code.tgz" "$TMP/image.txt" "$HERE/remote.sh" "$STEP2/pod.yaml.tpl" "$STEP2/peer.yaml.tpl" "fsn-01:$CODE/" || { echo "VERDICT: BLOCKED — scp failed"; exit 1; }
timeout 1500 ssh -n fsn-01 "bash $CODE/remote.sh" 2>&1 | tee "$TMP/remote.log"; rc=${PIPESTATUS[0]}
mkdir -p "$HERE/out"; scp -q "fsn-01:$CODE/out/*" "$HERE/out/" 2>/dev/null; cp "$TMP/remote.log" "$HERE/out/remote.log"
ssh -n fsn-01 "kubectl get ns $NS >/dev/null 2>&1 && kubectl delete ns $NS --wait=false; rm -rf $CODE" 2>/dev/null
echo "== remote exit=$rc; ns after run: $(ssh -n fsn-01 "kubectl get ns $NS 2>&1 | tail -1")"
V=$(grep '^VERDICT:' "$TMP/remote.log" | tail -1)
[ -n "$V" ] && echo "$V" || echo "VERDICT: FAIL — remote.sh ended without a verdict (rc=$rc)"
