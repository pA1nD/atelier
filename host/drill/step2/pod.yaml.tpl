# host/drill/step2 — the §4.3 session pod on the pinned agent image, plus the peer that runs the
# fake spine and the signer. __IMAGE__, __NS__, __PEER_IP__ are substituted by remote.sh.
# computer: hostUsers false, runAsUser 0, caps {SETUID,SETGID,CHOWN,KILL}, no fsGroup, restartPolicy
# Always, 2Gi emptyDir /work, tmpfs /run/atelier; PID 1 = bash host/entrypoint.sh (the real launcher,
# the real host); the image's session supervisor is replaced by the sleeping stub (g3 drills it).
# The code tree (host/, protocol/, package.json + npm ci) is staged into the `code` emptyDir by the
# `stage` init container before the session container starts.
apiVersion: v1
kind: Pod
metadata: { name: computer, namespace: __NS__, labels: { app: spike-host-step2 } }
spec:
  restartPolicy: Always
  terminationGracePeriodSeconds: 40
  automountServiceAccountToken: false
  enableServiceLinks: false
  hostUsers: false
  securityContext: { runAsUser: 0, runAsGroup: 0, seccompProfile: { type: RuntimeDefault } }   # NO fsGroup
  imagePullSecrets: [ { name: ghcr-pull } ]
  volumes:
  - { name: work, emptyDir: { sizeLimit: 2Gi } }
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
    command: [ bash, -c ]
    args: [ 'cp /code/host/drill/launcher/session-supervisor-stub.mjs /app/session-supervisor.mjs; exec bash /code/host/entrypoint.sh' ]
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
    - { name: CHAT_ID, value: spike-host-step2 }
    - { name: PERSONA, value: bayard }
    - { name: PERSONA_TEXT, value: "You are a drill persona. Say nothing." }
    - { name: STORY_TEXT, value: "" }
    - { name: CHANNEL_URL, value: "http://__PEER_IP__:7999" }
    - { name: CHANNEL_TOKEN, value: canary-channel-token }
    - { name: CHANNEL_CHAT, value: spike-host-step2 }
    - { name: ATELIER_BOOTSTRAP, value: drill-bootstrap-secret }
    - { name: ATELIER_HOST_TLS, value: plain }   # the drill's signer dials plain HTTP; a fleet host refuses to start without this explicit opt-out
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
