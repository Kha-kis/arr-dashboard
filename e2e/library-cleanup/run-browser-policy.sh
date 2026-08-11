#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/provenance-helpers.sh"
if [ -z "${COMPOSE_PROJECT_NAME:-}" ] && [ -f "$SCRIPT_DIR/.env" ]; then
	COMPOSE_PROJECT_NAME=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$SCRIPT_DIR/.env" | tail -n 1)
	export COMPOSE_PROJECT_NAME
fi

PROJECT_NAME=${COMPOSE_PROJECT_NAME:?Set the unique live COMPOSE_PROJECT_NAME}
. "$SCRIPT_DIR/compose-command.sh"
. "$SCRIPT_DIR/live-project-guard.sh"
RUNNER_SERVICE=${LC_E2E_DASHBOARD_SERVICE:-dashboard-sqlite}
DOCKER_BIN=${ARR_DOCKER_BIN:-docker}

case "$RUNNER_SERVICE" in
	dashboard-sqlite | dashboard-postgres) ;;
	*)
		echo "Unsupported disposable dashboard service: $RUNNER_SERVICE" >&2
		exit 1
		;;
esac

cd "$SCRIPT_DIR"
sh ./validate-compose.sh --live-project "$PROJECT_NAME"
acquire_live_project_lock
verify_live_project

if ! compose ps --status running --services | grep -Fxq "$RUNNER_SERVICE"; then
	echo "Browser policy gate refused: $RUNNER_SERVICE is not running in $PROJECT_NAME." >&2
	exit 1
fi

container_id=$(compose ps -q "$RUNNER_SERVICE")
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
if [ "$CHECKOUT_DIRTY" != false ]; then
	echo "Browser policy gate requires a clean checkout matching the candidate image." >&2
	exit 1
fi
CONTAINER_IMAGE_ID=$("$DOCKER_BIN" inspect "$container_id" --format '{{.Image}}')
CONTAINER_IMAGE_REF=$("$DOCKER_BIN" inspect "$container_id" --format '{{.Config.Image}}')
CONTAINER_REVISION=$("$DOCKER_BIN" inspect "$container_id" \
	--format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
CONTAINER_SOURCE_SHA256=$("$DOCKER_BIN" inspect "$container_id" \
	--format '{{index .Config.Labels "org.arr-dashboard.source-archive-sha256"}}')
if [ "$CONTAINER_REVISION" != "$CHECKOUT_COMMIT" ]; then
	echo "Browser policy gate refused image revision $CONTAINER_REVISION; expected $CHECKOUT_COMMIT." >&2
	exit 1
fi
RECEIPT="$SCRIPT_DIR/.artifacts/candidate-build.json"
if [ ! -f "$RECEIPT" ]; then
	echo "Browser policy gate requires the immutable candidate build receipt." >&2
	exit 1
fi
LOCK_DIR="$SCRIPT_DIR/.artifacts/browser-policy-$PROJECT_NAME.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
	echo "Browser policy gate refused a concurrent run for $PROJECT_NAME." >&2
	exit 1
fi
IDENTITY_TEMP_DIR=""
PENDING_EVIDENCE_DIRECTORY=""
cleanup() {
	if [ -n "$IDENTITY_TEMP_DIR" ]; then
		rm -rf "$IDENTITY_TEMP_DIR"
	fi
	if [ -n "$PENDING_EVIDENCE_DIRECTORY" ] && [ -d "$PENDING_EVIDENCE_DIRECTORY" ]; then
		rm -rf "$PENDING_EVIDENCE_DIRECTORY"
	fi
	rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
receipt_field() {
	sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" "$RECEIPT"
}
RECEIPT_COMMIT=$(receipt_field commit)
RECEIPT_IMAGE_ID=$(receipt_field imageId)
RECEIPT_IMAGE_REF=$(receipt_field imageRef)
RECEIPT_SOURCE_SHA256=$(receipt_field sourceArchiveSha256)
IDENTITY_TEMP_DIR=$(mktemp -d "$SCRIPT_DIR/.artifacts/browser-identity.XXXXXX")
CHECKOUT_ARCHIVE="$IDENTITY_TEMP_DIR/checkout.tar"
if ! git -C "$REPO_ROOT" archive --format=tar "$CHECKOUT_COMMIT" >"$CHECKOUT_ARCHIVE"; then
	echo "Browser policy gate could not archive the selected checkout." >&2
	exit 2
fi
CHECKOUT_SOURCE_SHA256=$(hash_file "$CHECKOUT_ARCHIVE") || {
	echo "Browser policy gate could not calculate a valid source SHA-256 digest." >&2
	exit 2
}
IMMUTABLE_SUITE_DIR="$IDENTITY_TEMP_DIR/e2e/library-cleanup"
if ! tar -xf "$CHECKOUT_ARCHIVE" -C "$IDENTITY_TEMP_DIR" \
	e2e/library-cleanup/browser-policy.spec.ts \
	e2e/library-cleanup/playwright.config.ts \
	e2e/library-cleanup/provenance-helpers.sh \
	e2e/library-cleanup/run-browser-policy.sh; then
	echo "Browser policy gate could not extract the immutable test suite." >&2
	exit 2
fi
if [ "$RECEIPT_COMMIT" != "$CHECKOUT_COMMIT" ] || \
	[ "$RECEIPT_IMAGE_ID" != "$CONTAINER_IMAGE_ID" ] || \
	[ "$RECEIPT_IMAGE_REF" != "$CONTAINER_IMAGE_REF" ] || \
	[ "$RECEIPT_SOURCE_SHA256" != "$CHECKOUT_SOURCE_SHA256" ] || \
	[ "$CONTAINER_SOURCE_SHA256" != "$CHECKOUT_SOURCE_SHA256" ]; then
	echo "Browser policy gate refused a container that does not match the immutable build receipt." >&2
	exit 1
fi
TEST_SUITE_MANIFEST="$IDENTITY_TEMP_DIR/test-suite.sha256"
: >"$TEST_SUITE_MANIFEST"
for test_file in browser-policy.spec.ts playwright.config.ts run-browser-policy.sh provenance-helpers.sh; do
	test_digest=$(hash_file "$IMMUTABLE_SUITE_DIR/$test_file") || {
		echo "Browser policy gate could not hash $test_file." >&2
		exit 2
	}
	printf '%s  %s\n' "$test_digest" "$test_file" >>"$TEST_SUITE_MANIFEST"
done
TEST_SUITE_SHA256=$(hash_file "$TEST_SUITE_MANIFEST") || {
	echo "Browser policy gate could not calculate a valid test-suite SHA-256 digest." >&2
	exit 2
}
EVIDENCE_PARENT="$SCRIPT_DIR/.artifacts/playwright/$RUNNER_SERVICE"
EVIDENCE_DIRECTORY="$EVIDENCE_PARENT/$RUN_ID"
PENDING_EVIDENCE_DIRECTORY="$SCRIPT_DIR/.artifacts/pending/playwright/$RUNNER_SERVICE/$RUN_ID"
PENDING_EVIDENCE_REPORT="$PENDING_EVIDENCE_DIRECTORY/report.json"
mkdir -p "$PENDING_EVIDENCE_DIRECTORY"
PLAYWRIGHT_STATUS=0
LC_E2E_BASE_URL=$BASE_URL \
	LC_E2E_DASHBOARD_SERVICE=$RUNNER_SERVICE \
	LC_E2E_EVIDENCE_DIRECTORY=$PENDING_EVIDENCE_DIRECTORY \
	LC_E2E_RUN_ID=$RUN_ID \
	LC_E2E_CHECKOUT_COMMIT=$CHECKOUT_COMMIT \
	LC_E2E_CHECKOUT_DIRTY=$CHECKOUT_DIRTY \
	LC_E2E_CONTAINER_ID=$container_id \
	LC_E2E_CONTAINER_IMAGE_ID=$CONTAINER_IMAGE_ID \
	LC_E2E_CONTAINER_IMAGE_REF=$CONTAINER_IMAGE_REF \
	LC_E2E_CONTAINER_REVISION=$CONTAINER_REVISION \
	LC_E2E_CONTAINER_SOURCE_SHA256=$CONTAINER_SOURCE_SHA256 \
	LC_E2E_TEST_SUITE_SHA256=$TEST_SUITE_SHA256 \
	LC_E2E_RUN_STARTED_AT=$RUN_STARTED_AT \
	pnpm exec playwright test --config="$IMMUTABLE_SUITE_DIR/playwright.config.ts" || \
	PLAYWRIGHT_STATUS=$?

POST_CHECKOUT_COMMIT=$(git -C "$REPO_ROOT" rev-parse HEAD)
POST_CONTAINER_ID=$(compose ps -q "$RUNNER_SERVICE")
if [ "$POST_CHECKOUT_COMMIT" != "$CHECKOUT_COMMIT" ] || \
	[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ] || \
	[ "$POST_CONTAINER_ID" != "$container_id" ]; then
	echo "Browser policy gate invalidated evidence after concurrent checkout or container drift." >&2
	exit 1
fi
if [ ! -s "$PENDING_EVIDENCE_REPORT" ]; then
	echo "Browser policy gate produced no retained JSON evidence report." >&2
	exit 1
fi
if [ -e "$EVIDENCE_DIRECTORY" ]; then
	echo "Browser policy gate refused to overwrite an existing evidence run." >&2
	exit 1
fi
mkdir -p "$EVIDENCE_PARENT"
REWRITTEN_REPORT="$PENDING_EVIDENCE_DIRECTORY/report.rewritten.json"
node -e '
	const fs = require("node:fs");
	const [reportPath, rewrittenPath, pendingPrefix, finalPrefix] = process.argv.slice(1);
	const rewrite = (value) => {
		if (typeof value === "string") return value.split(pendingPrefix).join(finalPrefix);
		if (Array.isArray(value)) return value.map(rewrite);
		if (value && typeof value === "object") {
			return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child)]));
		}
		return value;
	};
	const rewritten = JSON.stringify(rewrite(JSON.parse(fs.readFileSync(reportPath, "utf8"))));
	if (rewritten.includes(pendingPrefix)) throw new Error("pending evidence path remained in report");
	fs.writeFileSync(rewrittenPath, rewritten);
' "$PENDING_EVIDENCE_REPORT" "$REWRITTEN_REPORT" \
	"$PENDING_EVIDENCE_DIRECTORY" "$EVIDENCE_DIRECTORY"
mv "$REWRITTEN_REPORT" "$PENDING_EVIDENCE_REPORT"
mv "$PENDING_EVIDENCE_DIRECTORY" "$EVIDENCE_DIRECTORY"
PENDING_EVIDENCE_DIRECTORY=""
exit "$PLAYWRIGHT_STATUS"
