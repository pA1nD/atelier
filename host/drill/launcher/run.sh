#!/bin/bash
# Laptop side of the launcher drill (DESIGN §8.2): pins the agent image digest from
# metal/clusters/prod/spine.yaml, tars the code tree, ships it with remote.sh + inpod.sh to fsn-01,
# runs remote.sh there (bounded), copies out/ back, makes sure the namespace is gone. ONE backgrounded
# task; the last line is the VERDICT. Never pushes, never deploys, never touches a production namespace.
#   bash host/drill/launcher/run.sh > host/drill/launcher/run.log
set -u
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
SPINE_YAML=${SPINE_YAML:-/Users/pa1nd/pro/005-fleet-infra/metal/clusters/prod/spine.yaml}
CODE=/tmp/spike-host-launcher-code
echo "== host launcher drill $(date -u +%FT%TZ) — repo $REPO ($(git -C "$REPO" branch --show-current) @ $(git -C "$REPO" rev-parse --short HEAD)), target fsn-01, ns spike-host-launcher"
IMAGE=$(grep -o 'ghcr.io/pa1nd/agent-image@sha256:[0-9a-f]*' "$SPINE_YAML" | head -1)
[ -n "$IMAGE" ] || { echo "VERDICT: BLOCKED — no agent-image digest in $SPINE_YAML"; exit 1; }
echo "== image: $IMAGE"
# host/ (the launcher, its stubs and tests), protocol/, package.json — the host stub needs no dependencies.
# host/index.mjs is REPLACED by the stub in the staged tree: /code is an idmapped mount whose files are
# 501-owned, and container-root cannot overwrite them in place — so the stub must arrive already named
# index.mjs (this drill is the launcher supervising the host process; the real host runs in step2/rows).
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
STAGE=$TMP/tree; mkdir -p "$STAGE"
for p in host protocol package.json; do [ -e "$REPO/$p" ] && cp -R "$REPO/$p" "$STAGE/$p"; done
rm -rf "$STAGE/host/drill/launcher/out"
cp "$STAGE/host/drill/launcher/host-stub.mjs" "$STAGE/host/index.mjs"
echo "== shipping: host (index.mjs = host-stub.mjs) protocol package.json"
COPYFILE_DISABLE=1 tar -C "$STAGE" --exclude='*.log' -czf "$TMP/code.tgz" . || { echo "VERDICT: BLOCKED — tar failed"; exit 1; }
echo "$IMAGE" > "$TMP/image.txt"
ssh -n -o ConnectTimeout=15 fsn-01 "rm -rf $CODE && mkdir -p $CODE/out" || { echo "VERDICT: BLOCKED — ssh fsn-01 failed"; exit 1; }
scp -q "$TMP/code.tgz" "$TMP/image.txt" "$HERE/remote.sh" "$HERE/inpod.sh" "$HERE/pod.yaml.tpl" "fsn-01:$CODE/" || { echo "VERDICT: BLOCKED — scp failed"; exit 1; }
timeout 1200 ssh -n fsn-01 "bash $CODE/remote.sh" 2>&1 | tee "$TMP/remote.log"; rc=${PIPESTATUS[0]}
mkdir -p "$HERE/out"; scp -q "fsn-01:$CODE/out/*" "$HERE/out/" 2>/dev/null
ssh -n fsn-01 "kubectl get ns spike-host-launcher >/dev/null 2>&1 && kubectl delete ns spike-host-launcher --wait=false; rm -rf $CODE" 2>/dev/null
echo "== remote exit=$rc; ns after run: $(ssh -n fsn-01 'kubectl get ns spike-host-launcher 2>&1 | tail -1')"
V=$(grep '^VERDICT:' "$TMP/remote.log" | tail -1)
[ -n "$V" ] && echo "$V" || echo "VERDICT: FAIL — remote.sh ended without a verdict (rc=$rc)"
