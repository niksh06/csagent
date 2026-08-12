#!/bin/bash
# Irida medic: cheap probes every launchd tick; on red, launch a headless
# Claude agent with a runbook to diagnose and repair, then report to Telegram.
# Design rules: probes are free (no LLM); the agent runs only past a cooldown
# and a daily cap; the agent does service ops only (never edits code/git).
set -u
HOME_DIR="$HOME"
LOG="$HOME_DIR/.irida/logs/medic.log"
STATE="$HOME_DIR/.irida/.agent/medic-state.json"
GW_ERR="$HOME_DIR/.irida/logs/gateway.error.log"
GW_LOG="$HOME_DIR/.irida/logs/gateway.log"
PROMPT_FILE="$HOME_DIR/.irida/irida/deploy/prompts/irida-medic.txt"
export PATH="$HOME_DIR/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

ts() { date -u +%FT%TZ; }
note() { echo "$(ts) $1" >> "$LOG"; }

DOCKER="$HOME_DIR/.orbstack/bin/docker"; [ -x "$DOCKER" ] || DOCKER="/usr/local/bin/docker"

# ── probes ──────────────────────────────────────────────────────────
RED=()
REPORT=""
add() { REPORT+="$1"$'\n'; }

if "$DOCKER" ps >/dev/null 2>&1; then add "docker: OK"; else add "docker: DEAD"; RED+=("docker"); fi
for probe in "5435 memory-pg" "8014 embedder"; do
  port="${probe%% *}"; name="${probe#* }"
  if nc -z -w 2 127.0.0.1 "$port" >/dev/null 2>&1; then add "$name ($port): OK"; else add "$name ($port): REFUSED"; RED+=("$name"); fi
done
GW_PID=$(launchctl list 2>/dev/null | awk '$3=="ai.irida.gateway"{print $1}')
if [ -n "$GW_PID" ] && [ "$GW_PID" != "-" ]; then add "gateway: PID $GW_PID"; else add "gateway: NOT RUNNING"; RED+=("gateway"); fi
if [ -f "$GW_LOG" ]; then
  AGE=$(( $(date +%s) - $(stat -f %m "$GW_LOG") ))
  if [ "$AGE" -lt 600 ]; then add "gateway poll: fresh (${AGE}s)"; else add "gateway poll: STALE (${AGE}s)"; RED+=("poll-stale"); fi
fi
# error-log burst since last probe (gateway error lines carry no timestamps).
# First run (no state yet) only records the baseline — history is not a burst.
ERR_SIZE=$(stat -f %z "$GW_ERR" 2>/dev/null || echo 0)
if [ ! -f "$STATE" ]; then
  LAST_SIZE="$ERR_SIZE"
  add "gateway errors: baseline initialized"
else
  LAST_SIZE=$(python3 -c "import json;print(json.load(open('$STATE')).get('errSize',0))" 2>/dev/null || echo 0)
fi
if [ "$ERR_SIZE" -gt "$LAST_SIZE" ]; then
  DELTA=$(tail -c $((ERR_SIZE - LAST_SIZE)) "$GW_ERR" 2>/dev/null)
  BURST=$(printf '%s' "$DELTA" | grep -c "sendTurn error" || true)
  if [ "${BURST:-0}" -ge 3 ]; then add "gateway errors: BURST ($BURST sendTurn errors since last probe)"; RED+=("turn-errors");
  else add "gateway errors: +$BURST turn error(s) (below threshold)"; fi
else
  add "gateway errors: quiet"
fi

python3 - "$STATE" "$ERR_SIZE" <<'PY'
import json,sys,os
p,size=sys.argv[1],int(sys.argv[2])
st={}
if os.path.exists(p):
    try: st=json.load(open(p))
    except Exception: st={}
st['errSize']=size
json.dump(st,open(p,'w'))
PY

[ ${#RED[@]} -eq 0 ] && exit 0

note "RED: ${RED[*]}"
note "$REPORT"

# ── cooldown: agent at most once per 2h and 3 times per 24h ─────────
NOW=$(date +%s)
GATE=$(python3 - "$STATE" "$NOW" <<'PY'
import json,sys,os,time
p,now=sys.argv[1],int(sys.argv[2])
st=json.load(open(p)) if os.path.exists(p) else {}
runs=[t for t in st.get('agentRuns',[]) if now-t < 86400]
if runs and now-runs[-1] < 7200: print('cooldown'); sys.exit()
if len(runs) >= 3: print('daycap'); sys.exit()
runs.append(now); st['agentRuns']=runs
json.dump(st,open(p,'w'))
print('go')
PY
)
if [ "$GATE" != "go" ]; then
  note "agent skipped ($GATE)"
  if [ "$GATE" = "daycap" ]; then
    (cd "$HOME_DIR/vesper" && npm run --silent fable:send -- "⚕️ Ирида-медик: третья краснота за сутки (${RED[*]}), агент выработал дневной лимит — нужен человек. Отчёт в ~/.irida/logs/medic.log" >/dev/null 2>&1)
  fi
  exit 0
fi

# ── the agent ───────────────────────────────────────────────────────
note "launching medic agent"
CLAUDE_BIN=$(command -v claude || echo "$HOME_DIR/.local/bin/claude")
PROMPT=$(cat "$PROMPT_FILE"; echo; echo "── ОТЧЁТ ПРОБ ($(ts)) ──"; echo "$REPORT"; echo "Красные зоны: ${RED[*]}")
OUT=$("$CLAUDE_BIN" -p "$PROMPT" --allowedTools "Bash,Read,Grep,Glob" --max-turns 50 2>>"$LOG")
note "agent done"
printf '%s\n' "$OUT" >> "$LOG"

SUMMARY=$(printf '%s' "$OUT" | tail -c 900)
(cd "$HOME_DIR/vesper" && npm run --silent fable:send -- "⚕️ Ирида-медик отработал (красное: ${RED[*]}). Итог: $SUMMARY" >/dev/null 2>&1)
exit 0
