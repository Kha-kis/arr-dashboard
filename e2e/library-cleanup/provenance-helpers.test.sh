#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/provenance-helpers.sh"

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lc-e2e-provenance-test.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT
printf '%s\n' test >"$TEMP_DIR/input"

digest=$(hash_file "$TEMP_DIR/input")
is_sha256 "$digest"

sha256sum() {
	return 7
}
if hash_file "$TEMP_DIR/input" >/dev/null 2>&1; then
	echo "hash_file accepted a failed hash command." >&2
	exit 1
fi

sha256sum() {
	printf '\n'
}
if hash_file "$TEMP_DIR/input" >/dev/null 2>&1; then
	echo "hash_file accepted an empty digest." >&2
	exit 1
fi

sha256sum() {
	printf '%s  %s\n' invalid "$1"
}
if hash_file "$TEMP_DIR/input" >/dev/null 2>&1; then
	echo "hash_file accepted a malformed digest." >&2
	exit 1
fi

echo "provenance hash negative tests passed: 3"
