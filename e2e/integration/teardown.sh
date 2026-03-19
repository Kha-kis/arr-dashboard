#!/usr/bin/env bash
# teardown.sh — Stop and remove all integration test containers and volumes
#
# Usage: cd e2e/integration && bash teardown.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Use docker compose v2 if available, fallback to docker-compose v1
if docker compose version &>/dev/null; then
  COMPOSE_CMD="docker compose"
else
  COMPOSE_CMD="docker-compose"
fi

echo "[teardown] Stopping integration stack..."
$COMPOSE_CMD -f "${SCRIPT_DIR}/docker-compose.yml" down -v --remove-orphans

echo "[teardown] Cleaning up generated files..."
rm -f "${SCRIPT_DIR}/.env.services"

echo "[teardown] Done."
