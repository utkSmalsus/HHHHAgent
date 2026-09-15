#!/bin/bash
# Run by launchd every night (see com.hhhh.daily-ingest.plist), wrapped in `caffeinate -i` so the
# Mac doesn't sleep mid-run. Ensures Docker is up, triggers incremental ingestion (Ollama —
# free, no rate limits — only fetches records changed since the last successful run), and waits
# for it to fully finish before exiting (so caffeinate's sleep-prevention covers the whole thing).
set -uo pipefail

# launchd runs this with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) that doesn't include
# /usr/local/bin, where the `docker` CLI lives — confirmed live (2026-08-19 to 08-24) that every
# nightly run's plain `docker info` check failed with "command not found" (exit 127), which the
# `if ! docker info` check couldn't distinguish from a real down daemon, so the script always
# launched Docker Desktop and waited 240s for nothing before aborting — 6 nights of lost ingestion
# even though the daemon itself was often already up.
export PATH="/usr/local/bin:$PATH"

PROJECT_DIR="/Users/smalsus/office/Agent/HHHHAgent"
API_URL="http://localhost:3000"
LOG_FILE="$HOME/Library/Logs/hhhh-daily-ingest.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"; }

log "=== Starting daily ingest ==="

cd "$PROJECT_DIR" || { log "ERROR: project dir not found"; exit 1; }

# Confirmed live (2026-08-14 to 08-16): after a Mac reboot with Docker Desktop's "start at login"
# off, the daemon itself was down (not just the containers) — `docker compose up -d` failed
# outright, and the script silently moved on to an empty/failing curl instead of catching it,
# so three nights of ingestion were lost with no clear signal why. Launch Docker Desktop
# ourselves and wait for the daemon before assuming `docker compose` can do anything at all.
if ! docker info >/dev/null 2>&1; then
  log "Docker daemon not reachable — launching Docker Desktop"
  open -a Docker
  # 240s, not 120s — confirmed live on 2026-08-17 that a cold Docker Desktop start didn't finish
  # within 120s even after "start at login" was enabled. caffeinate already covers the whole
  # script's runtime regardless, so there's no cost to waiting longer before giving up.
  for i in $(seq 1 120); do
    docker info >/dev/null 2>&1 && break
    sleep 2
  done
  if ! docker info >/dev/null 2>&1; then
    log "ERROR: Docker daemon still not reachable after 240s — aborting, nothing was ingested"
    log "=== Done (failed) ==="
    exit 1
  fi
  log "Docker daemon is up"
fi

# Idempotent — safe even if containers are already up.
/usr/local/bin/docker compose up -d >> "$LOG_FILE" 2>&1

# Wait for the API to actually respond before triggering ingestion (containers may take a few
# seconds to come up if they were stopped).
API_READY=false
for i in $(seq 1 30); do
  if curl -s -o /dev/null "$API_URL/api/ping"; then
    API_READY=true
    break
  fi
  sleep 2
done

if [ "$API_READY" != true ]; then
  log "ERROR: API never became reachable at $API_URL after 60s — aborting, nothing was ingested"
  log "=== Done (failed) ==="
  exit 1
fi

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
