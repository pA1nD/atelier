#!/bin/bash
# host/entrypoint.sh — PID 1 of the session container (DESIGN §2.1, PLAN §4.3 R1): bash reaps every
# orphan the agent tree loses (a node PID 1 leaves zombies), forwards SIGTERM to the launcher and
# mirrors its exit code. It runs nothing but the launcher; the double `wait` collects the real
# status after the trap interrupts the first one.
trap 'kill -TERM $c' TERM
node "$(dirname "$0")/launcher.mjs" & c=$!
wait $c; wait $c
exit $?
