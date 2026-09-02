#!/bin/bash
# The seeded drill's stand-in for the portal system host's entrypoint (portal host/entrypoint.sh): BEFORE the launcher
# runs, root makes /work/apps (mode at creation, then the chown — never a chmod after a chown) and uid 1000 copies two
# drill apps in — `seedy` (declares ctx.suspendable(): the R14 stop/resume road) and `steady` (`hello`, no declaration:
# stays live) — each marked `.atelier-seeded` beside an `.image-stamp`, through a `.seeding` rename — the exact shape the
# real image seeds (two folders: the side-by-side build host-ready waits for). Runs inside the drill pod's session container (root, caps SETUID/SETGID/CHOWN/KILL).
set -eu
W=${ATELIER_WORK:-/work}
if [ ! -d "$W/apps" ]; then mkdir -m 0755 "$W/apps"; chown 1000:1000 "$W/apps"; fi
seed(){ setpriv --reuid=1000 --regid=1000 --clear-groups bash -c '
  src=$1; dst=$2
  umask 022
  rm -rf "$dst.seeding" "$dst"
  mkdir "$dst.seeding"
  cp -R "$src/." "$dst.seeding/"
  echo drill-stamp > "$dst.seeding/.image-stamp"
  : > "$dst.seeding/.atelier-seeded"
  mv "$dst.seeding" "$dst"
  echo "[seed] $(ls -ldn "$dst") $(ls -A "$dst" | tr "\n" " ")"
' seed "$1" "$W/apps/$2"; }
seed /code/drill-apps/seedy seedy
seed /code/drill-apps/hello steady
