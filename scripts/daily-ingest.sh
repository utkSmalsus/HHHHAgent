#!/bin/bash
# Run by launchd every night (see com.hhhh.daily-ingest.plist), wrapped in `caffeinate -i` so the
# Mac doesn't sleep mid-run. Ensures Docker is up, triggers incremental ingestion (Ollama —
# free, no rate limits — only fetches records changed since the last successful run), and waits
# for it to fully finish before exiting (so caffeinate's sleep-prevention covers the whole thing).
set -uo pipefail

PROJECT_DIR="/Users/smalsus/office/Agent/HHHHAgent"
API_URL="http://localhost:3000"
LOG_FILE="$HOME/Library/Logs/hhhh-daily-ingest.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"; }

log "=== Starting daily ingest ==="

cd "$PROJECT_DIR" || { log "ERROR: project dir not found"; exit 1; }

# Idempotent — safe even if containers are already up.
/usr/local/bin/docker compose up -d >> "$LOG_FILE" 2>&1

# Wait for the API to actually respond before triggering ingestion (containers may take a few
# seconds to come up if they were stopped).
for i in $(seq 1 30); do
  if curl -s -o /dev/null "$API_URL/api/ping"; then
    break
  fi
  sleep 2
done

RESPONSE=$(curl -s -X POST "$API_URL/api/ingest/incremental" -H 'Content-Type: application/json')
log "Triggered: $RESPONSE"

# Poll until done — this is what caffeinate is actually protecting.
while true; do
  STATUS=$(curl -s "$API_URL/api/ingest/progress" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','unknown'))" 2>/dev/null)
  if [ "$STATUS" != "running" ]; then
    break
  fi
  sleep 30
done

log "Finished with status: $STATUS"
log "=== Done ==="
