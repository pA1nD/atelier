# The spine's registrar lane, standalone (agent-orchestrator src/registry/serve.ts built to dist/), on
# the ORCHESTRATOR image (node:24-slim, the digest metal/clusters/prod/spine.yaml deploys) — the built
# dist/ is copied in by remote.sh, the server started with setsid. A ClusterIP Service names it for the
# computer pod: http://spine.__NS__.svc:7999.
apiVersion: v1
kind: Pod
metadata: { name: spine, namespace: __NS__, labels: { app: spike-step2-joint-spine } }
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  enableServiceLinks: false
  imagePullSecrets: [ { name: ghcr-pull } ]
  containers:
  - name: spine
    image: __IMAGE__
    imagePullPolicy: IfNotPresent
    securityContext: { runAsUser: 1000, runAsGroup: 1000 }
    command: ["sleep", "infinity"]
    workingDir: /tmp
---
apiVersion: v1
kind: Service
metadata: { name: spine, namespace: __NS__ }
spec:
  selector: { app: spike-step2-joint-spine }
  ports: [ { port: 7999, targetPort: 7999 } ]
