# The peer: the fake spine (port 7999) and the signer live here — outside the computer pod.
apiVersion: v1
kind: Pod
metadata: { name: peer, namespace: __NS__ }
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  enableServiceLinks: false
  imagePullSecrets: [ { name: ghcr-pull } ]
  containers:
  - name: peer
    image: __IMAGE__
    imagePullPolicy: IfNotPresent
    securityContext: { runAsUser: 0, runAsGroup: 0 }
    command: ["sleep", "infinity"]
