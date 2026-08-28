# host/drill/launcher — the userns-root session pod of PLAN §4.3 / DESIGN §8.2 on the pinned agent image.
# __IMAGE__ and __NS__ are substituted by remote.sh. The code tree is staged into the `code` emptyDir
# by the `stage` init container (kubectl cp + tar) before the session container starts.
# /work arrives as a fresh Longhorn root would: 0:0 0755 with lost+found 0:0 0700; /control is the
# spine's 1000-owned claim (0700). restartPolicy Always so the in-place container restart is drilled.
apiVersion: v1
kind: Pod
metadata: { name: computer, namespace: __NS__, labels: { app: spike-host-launcher } }
spec:
  restartPolicy: Always
  terminationGracePeriodSeconds: 40
  automountServiceAccountToken: false
  enableServiceLinks: false
  hostUsers: false
  securityContext: { runAsUser: 0, runAsGroup: 0, seccompProfile: { type: RuntimeDefault } }   # NO fsGroup
  imagePullSecrets: [ { name: ghcr-pull } ]
  volumes:
  - { name: work, emptyDir: {} }
  - { name: control, emptyDir: {} }
  - { name: run, emptyDir: { medium: Memory, sizeLimit: 64Mi } }
  - { name: shm, emptyDir: { medium: Memory, sizeLimit: 1Gi } }
  - { name: code, emptyDir: {} }
  initContainers:
  - name: shape
    image: __IMAGE__
    imagePullPolicy: IfNotPresent
    securityContext: { runAsUser: 0, runAsGroup: 0 }
    command: [ sh, -c, 'chown 0:0 /work && chmod 755 /work && mkdir -m 700 /work/lost+found && chown 1000:1000 /control && chmod 700 /control && ls -ldn /work /work/lost+found /control' ]
    volumeMounts: [ { name: work, mountPath: /work }, { name: control, mountPath: /control } ]
  - name: stage
    image: __IMAGE__
    imagePullPolicy: IfNotPresent
    securityContext: { runAsUser: 0, runAsGroup: 0 }
    command: [ sh, -c, 'echo staging; while [ ! -f /code/.staged ]; do sleep 0.5; done; echo staged' ]
    volumeMounts: [ { name: code, mountPath: /code } ]
  containers:
  - name: session
    image: __IMAGE__
    imagePullPolicy: IfNotPresent
    # the image's session supervisor is replaced by the sleeping stub (g3 drills the real one) and the host by
    # host-stub.mjs: this drill is the launcher's supervision of the host process (no spine, no deps); the real
    # host under the same launcher is drilled in host/drill/step2 and host/drill/rows
    command: [ bash, -c ]
    args: [ 'cp /code/host/drill/launcher/session-supervisor-stub.mjs /app/session-supervisor.mjs; echo "[drill] host entry: $(head -c 90 /code/host/index.mjs | head -1)"; exec bash /code/host/entrypoint.sh' ]
    workingDir: /work
    securityContext:
      runAsUser: 0
      runAsGroup: 0
      allowPrivilegeEscalation: false
      capabilities: { drop: ["ALL"], add: ["SETUID", "SETGID", "CHOWN", "KILL"] }
    env:
    - { name: HOME, value: /work }
    - { name: LANG, value: C.UTF-8 }
    - { name: LC_ALL, value: C.UTF-8 }
    - { name: TERM, value: xterm-256color }
    - { name: CHAT_ID, value: spike-host-launcher }
    - { name: PERSONA, value: bayard }
    - { name: PERSONA_TEXT, value: "You are a drill persona. Say nothing." }
    - { name: STORY_TEXT, value: "" }
    - { name: CHANNEL_URL, value: "http://127.0.0.1:9" }
    - { name: CHANNEL_TOKEN, value: canary-channel-token }
    - { name: CHANNEL_CHAT, value: spike-host-launcher }
    - { name: ATELIER_BOOTSTRAP, value: canary-bootstrap-secret }
    volumeMounts:
    - { name: work, mountPath: /work }
    - { name: control, mountPath: /control }
    - { name: run, mountPath: /run/atelier }
    - { name: shm, mountPath: /dev/shm }
    - { name: code, mountPath: /code }
    resources: { requests: { cpu: 200m, memory: 512Mi }, limits: { memory: 3Gi } }
    readinessProbe:
      exec: { command: ["test", "-f", "/run/atelier/host-ready"] }
      initialDelaySeconds: 1
      periodSeconds: 1
      failureThreshold: 1
---
apiVersion: v1
kind: Pod
metadata: { name: peer, namespace: __NS__ }
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  imagePullSecrets: [ { name: ghcr-pull } ]
  containers:
  - name: curl
    image: __IMAGE__
    imagePullPolicy: IfNotPresent
    command: ["sleep", "infinity"]
