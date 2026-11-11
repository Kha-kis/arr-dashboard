#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
. "$SCRIPT_DIR/provenance-helpers.sh"
DOCKER_BIN=${ARR_DOCKER_BIN:-docker}
COMMIT=$(git -C "$REPO_ROOT" rev-parse --verify 'HEAD^{commit}')
IMAGE_REF="arr-dashboard-library-cleanup:$COMMIT"
ARTIFACT_DIR="$SCRIPT_DIR/.artifacts"

if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
	echo "Candidate image build requires a clean checkout." >&2
	exit 1
fi
if ! command -v tar >/dev/null 2>&1; then
	echo "Candidate image build requires tar." >&2
	exit 2
fi

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lc-e2e-candidate.XXXXXX")
BUILD_CONTEXT="$TEMP_DIR/context"
RECEIPT_TEMP=""
cleanup() {
	if [ -n "$RECEIPT_TEMP" ] && [ -f "$RECEIPT_TEMP" ]; then
		rm "$RECEIPT_TEMP"
	fi
	rm -rf "$TEMP_DIR"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

ARCHIVE="$TEMP_DIR/source.tar"
git -C "$REPO_ROOT" archive --format=tar "$COMMIT" >"$ARCHIVE"
SOURCE_ARCHIVE_SHA256=$(hash_file "$ARCHIVE") || {
	echo "Candidate image build could not calculate a valid source SHA-256 digest." >&2
	exit 2
}

umask 022
mkdir "$BUILD_CONTEXT"
tar -xf "$ARCHIVE" -C "$BUILD_CONTEXT"
"$DOCKER_BIN" build \
	--build-arg VERSION=library-cleanup-e2e \
	--build-arg COMMIT_SHA="$COMMIT" \
	--label "org.arr-dashboard.source-archive-sha256=$SOURCE_ARCHIVE_SHA256" \
	-t "$IMAGE_REF" "$BUILD_CONTEXT" >&2

IMAGE_ID=$("$DOCKER_BIN" image inspect "$IMAGE_REF" --format '{{.Id}}')
IMAGE_REVISION=$("$DOCKER_BIN" image inspect "$IMAGE_REF" \
	--format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
IMAGE_SOURCE_SHA256=$("$DOCKER_BIN" image inspect "$IMAGE_REF" \
	--format '{{index .Config.Labels "org.arr-dashboard.source-archive-sha256"}}')
if [ "$IMAGE_REVISION" != "$COMMIT" ] || [ "$IMAGE_SOURCE_SHA256" != "$SOURCE_ARCHIVE_SHA256" ]; then
	echo "Candidate image labels do not match the immutable source archive." >&2
	exit 1
fi

umask 077
mkdir -p "$ARTIFACT_DIR"
RECEIPT_TEMP=$(mktemp "$ARTIFACT_DIR/candidate-build.XXXXXX")
BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '%s\n' \
	"{\"commit\":\"$COMMIT\",\"imageId\":\"$IMAGE_ID\",\"imageRef\":\"$IMAGE_REF\",\"sourceArchiveSha256\":\"$SOURCE_ARCHIVE_SHA256\",\"builtAt\":\"$BUILT_AT\"}" \
	>"$RECEIPT_TEMP"
mv "$RECEIPT_TEMP" "$ARTIFACT_DIR/candidate-build.json"
RECEIPT_TEMP=""

printf '%s\n' "$IMAGE_REF"
