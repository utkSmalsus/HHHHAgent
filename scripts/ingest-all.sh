#!/bin/sh
set -e
API="${API_URL:-http://localhost:3000}"

echo "Checking config..."
curl -s "$API/api/ingest/config" | head -c 500
echo ""
echo "Ingesting all SharePoint lists into Qdrant..."
curl -s -X POST "$API/api/ingest/all" -H "Content-Type: application/json"
echo ""
