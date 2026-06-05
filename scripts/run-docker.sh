#!/bin/bash
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
cd "$(dirname "$0")/.."
docker compose up -d --build "$@"
