#!/bin/bash
# Fixes broken Docker CLI symlinks (common after installing from .dmg)
DOCKER_BIN="/Applications/Docker.app/Contents/Resources/bin"

if [ ! -d "$DOCKER_BIN" ]; then
  echo "Docker Desktop not found at /Applications/Docker.app"
  exit 1
fi

echo "Linking Docker tools into /usr/local/bin ..."
for tool in docker docker-compose docker-credential-desktop docker-credential-osxkeychain; do
  if [ -f "$DOCKER_BIN/$tool" ]; then
    sudo ln -sf "$DOCKER_BIN/$tool" "/usr/local/bin/$tool"
    echo "  OK $tool"
  fi
done

echo ""
echo "Add to ~/.zshrc (recommended):"
echo '  export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"'
echo ""
echo "Then run: docker compose up -d --build"
