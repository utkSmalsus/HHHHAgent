#!/bin/bash
# Run without Docker: Node API + Qdrant (via Homebrew or existing install)
set -e
cd "$(dirname "$0")/.."

if [ -z "$HUGGINGFACE_API_KEY" ] && ! grep -q '^HUGGINGFACE_API_KEY=.\+' .env 2>/dev/null; then
  echo "ERROR: Set HUGGINGFACE_API_KEY in .env before ingesting data."
  exit 1
fi

# Start Qdrant if not already running on 6333
if ! curl -sf http://localhost:6333/readyz >/dev/null 2>&1; then
  if command -v qdrant >/dev/null 2>&1; then
    echo "Starting Qdrant..."
    qdrant &
    sleep 3
  else
    echo "Qdrant is not running on :6333."
    echo "Install: brew install qdrant"
    echo "Or fix Docker (see README) and run: docker compose up -d"
    exit 1
  fi
fi

echo "Starting Node API on http://localhost:3000"
npm run dev
