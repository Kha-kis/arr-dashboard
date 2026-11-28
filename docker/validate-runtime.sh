#!/bin/sh
# Validates both immutable provider packages and their native startup assets.
# Run inside the built Docker image to catch missing-file regressions (e.g. #130).
#
# Usage:
#   docker build -t arr-test .
#   docker run --rm --entrypoint sh arr-test /app/api/validate-runtime.sh
#
set -e

ERRORS=0
API_DIR="/app/api"

check_file() {
    if [ ! -f "$1" ]; then
        echo "FAIL: missing $1"
        ERRORS=$((ERRORS + 1))
    else
        echo "  OK: $1"
    fi
}

check_dir() {
    if [ ! -d "$1" ]; then
        echo "FAIL: missing directory $1"
        ERRORS=$((ERRORS + 1))
    else
        echo "  OK: $1 (dir)"
    fi
}

echo "=== Runtime file validation ==="
echo ""
echo "Checking shared runtime dependencies..."
check_dir  "$API_DIR/node_modules/@prisma/client"
check_file "$API_DIR/validate-provider-runtime.cjs"

echo ""
echo "Checking manifest-bound provider packages..."
for provider in sqlite postgresql; do
    if ! node "$API_DIR/validate-provider-runtime.cjs" "$API_DIR/providers/$provider" "$provider"; then
        echo "FAIL: $provider runtime package validation"
        ERRORS=$((ERRORS + 1))
    else
        echo "  OK: $provider runtime package"
    fi
    if grep -q 'tsconfig.base.json' "$API_DIR/providers/$provider/tsconfig.json" 2>/dev/null; then
        echo "FAIL: provider tsconfig references an absent monorepo file"
        ERRORS=$((ERRORS + 1))
    fi
done

echo ""
echo "Checking startup scripts..."
check_file "/app/start.sh"
check_file "/app/runtime-health.cjs"

echo ""
echo "Checking core runtime files..."
check_file "$API_DIR/package.json"
check_file "$API_DIR/version.json"

echo ""
if [ "$ERRORS" -gt 0 ]; then
    echo "FAILED: $ERRORS runtime validation error(s) detected"
    exit 1
else
    echo "PASSED: both provider packages and shared runtime files validated"
    exit 0
fi
