#!/bin/bash
# Start ingest and show a live terminal progress bar
API="${API_URL:-http://localhost:3000}"

echo "Starting ingest..."
curl -s -X POST "$API/api/ingest/all" -H "Content-Type: application/json" | head -c 200
echo ""
echo ""
echo "Live progress (Ctrl+C to stop watching — ingest continues on server):"
echo ""

while true; do
  JSON=$(curl -s "$API/api/ingest/progress")
  STATUS=$(echo "$JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status',''))" 2>/dev/null)
  BAR=$(echo "$JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('progressBar',''))" 2>/dev/null)
  MSG=$(echo "$JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',''))" 2>/dev/null)
  PROC=$(echo "$JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('processed',0))" 2>/dev/null)
  TOT=$(echo "$JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('total',0))" 2>/dev/null)

  printf "\r%s | %s/%s | %s   " "$BAR" "$PROC" "$TOT" "$MSG"

  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ] || [ "$STATUS" = "idle" ]; then
    echo ""
    echo "$JSON" | python3 -m json.tool 2>/dev/null | head -30
    break
  fi
  sleep 2
done
