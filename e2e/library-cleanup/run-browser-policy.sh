#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -z "${COMPOSE_PROJECT_NAME:-}" ] && [ -f "$SCRIPT_DIR/.env" ]; then
	COMPOSE_PROJECT_NAME=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$SCRIPT_DIR/.env" | tail -n 1)
	export COMPOSE_PROJECT_NAME
fi

PROJECT_NAME=${COMPOSE_PROJECT_NAME:?Set the unique live COMPOSE_PROJECT_NAME}
RUNNER_SERVICE=${LC_E2E_DASHBOARD_SERVICE:-dashboard-sqlite}
DOCKER_BIN=${ARR_DOCKER_BIN:-docker}

run_compose() {
	if [ -n "${ARR_COMPOSE_BIN:-}" ]; then
		"$ARR_COMPOSE_BIN" "$@"
	else
		"$DOCKER_BIN" compose "$@"
	fi
}

case "$RUNNER_SERVICE" in
	dashboard-sqlite | dashboard-postgres) ;;
	*)
		echo "Unsupported disposable dashboard service: $RUNNER_SERVICE" >&2
		exit 1
		;;
esac

cd "$SCRIPT_DIR"
sh ./validate-compose.sh --live-project "$PROJECT_NAME"

if ! run_compose -p "$PROJECT_NAME" -f compose.yml -f compose.debug.yml \
	ps --status running --services | grep -Fxq "$RUNNER_SERVICE"; then
	echo "Browser policy gate refused: $RUNNER_SERVICE is not running in $PROJECT_NAME." >&2
	exit 1
fi

container_id=$(run_compose -p "$PROJECT_NAME" -f compose.yml -f compose.debug.yml \
	ps -q "$RUNNER_SERVICE")
container_project=$("$DOCKER_BIN" inspect "$container_id" \
	--format '{{index .Config.Labels "com.docker.compose.project"}}')
container_service=$("$DOCKER_BIN" inspect "$container_id" \
	--format '{{index .Config.Labels "com.docker.compose.service"}}')
if [ "$container_project" != "$PROJECT_NAME" ] || [ "$container_service" != "$RUNNER_SERVICE" ]; then
	echo "Browser policy gate refused a container outside $PROJECT_NAME/$RUNNER_SERVICE." >&2
	exit 1
fi

BASE_URL=""
published_binding=$("$DOCKER_BIN" port "$container_id" 3000/tcp 2>/dev/null | tail -n 1 || true)
case "$published_binding" in
	127.0.0.1:*)
		published_port=${published_binding##*:}
		candidate_url="http://127.0.0.1:$published_port"
		if curl -fsS --max-time 2 "$candidate_url/health" >/dev/null 2>&1; then
			BASE_URL=$candidate_url
		fi
		;;
esac

if [ -z "$BASE_URL" ]; then
	network_ids=$("$DOCKER_BIN" network ls \
		--filter "label=com.docker.compose.project=$PROJECT_NAME" \
		--filter "label=com.docker.compose.network=cleanup-internal" --quiet)
	set -- $network_ids
	if [ "$#" -ne 1 ]; then
		echo "Browser policy gate could not identify the exact disposable network." >&2
		exit 1
	fi
	network_id=$1
	container_ip=$("$DOCKER_BIN" network inspect "$network_id" \
		--format "{{with index .Containers \"$container_id\"}}{{.IPv4Address}}{{end}}")
	container_ip=${container_ip%%/*}
	if [ -z "$container_ip" ]; then
		echo "Browser policy gate found no selected-container address on the disposable network." >&2
		exit 1
	fi
	BASE_URL="http://$container_ip:3000"
	if ! curl -fsS --max-time 5 "$BASE_URL/health" >/dev/null; then
		echo "Browser policy gate could not reach $RUNNER_SERVICE inside the isolated network." >&2
		exit 1
	fi
fi

REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
RUN_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RUN_ID=$(date -u +%Y%m%dT%H%M%SZ)-$$
CHECKOUT_COMMIT=$(git -C "$REPO_ROOT" rev-parse HEAD)
if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
	CHECKOUT_DIRTY=true
else
	CHECKOUT_DIRTY=false
fi
CONTAINER_IMAGE_ID=$("$DOCKER_BIN" inspect "$container_id" --format '{{.Image}}')
CONTAINER_IMAGE_REF=$("$DOCKER_BIN" inspect "$container_id" --format '{{.Config.Image}}')
CONTAINER_REVISION=$("$DOCKER_BIN" inspect "$container_id" \
	--format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
if command -v sha256sum >/dev/null 2>&1; then
	TEST_SUITE_SHA256=$(sha256sum browser-policy.spec.ts playwright.config.ts run-browser-policy.sh \
		| sha256sum | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
	TEST_SUITE_SHA256=$(shasum -a 256 browser-policy.spec.ts playwright.config.ts run-browser-policy.sh \
		| shasum -a 256 | awk '{print $1}')
else
	echo "Browser policy gate requires sha256sum or shasum for evidence identity." >&2
	exit 2
fi
LC_E2E_BASE_URL=$BASE_URL \
	LC_E2E_DASHBOARD_SERVICE=$RUNNER_SERVICE \
	LC_E2E_RUN_ID=$RUN_ID \
	LC_E2E_CHECKOUT_COMMIT=$CHECKOUT_COMMIT \
	LC_E2E_CHECKOUT_DIRTY=$CHECKOUT_DIRTY \
	LC_E2E_CONTAINER_ID=$container_id \
	LC_E2E_CONTAINER_IMAGE_ID=$CONTAINER_IMAGE_ID \
	LC_E2E_CONTAINER_IMAGE_REF=$CONTAINER_IMAGE_REF \
	LC_E2E_CONTAINER_REVISION=$CONTAINER_REVISION \
	LC_E2E_TEST_SUITE_SHA256=$TEST_SUITE_SHA256 \
	LC_E2E_RUN_STARTED_AT=$RUN_STARTED_AT \
	pnpm exec playwright test --config=playwright.config.ts
