#!/bin/bash
# Host watchdog: restart OrbStack when the docker daemon stops answering.
# Symptom it exists for: OrbStack app processes stay alive while the docker
# socket vanishes — every container (irida-memory PG, embedder, tparser,
# aleph) goes dark until someone notices. Runs from launchd every 5 minutes;
# quiet exit while docker answers, one log line per state change otherwise.
set -u
LOG="$HOME/.irida/logs/docker-watchdog.log"
DOCKER="$HOME/.orbstack/bin/docker"
[ -x "$DOCKER" ] || DOCKER="/usr/local/bin/docker"

"$DOCKER" ps >/dev/null 2>&1 && exit 0
# Double-check after a pause so a transiently slow daemon is not restarted.
sleep 10
"$DOCKER" ps >/dev/null 2>&1 && exit 0

echo "$(date -u +%FT%TZ) docker unresponsive — restarting OrbStack" >> "$LOG"
osascript -e 'quit app "OrbStack"' >/dev/null 2>&1
sleep 8
open -a OrbStack
for _ in $(seq 1 15); do
  sleep 5
  if "$DOCKER" ps >/dev/null 2>&1; then
    echo "$(date -u +%FT%TZ) recovered after OrbStack restart" >> "$LOG"
    exit 0
  fi
done
echo "$(date -u +%FT%TZ) STILL DOWN after OrbStack restart — needs a human" >> "$LOG"
exit 1
