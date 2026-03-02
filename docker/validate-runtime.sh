#!/bin/sh
# Validates that the runtime container has all files needed for Prisma operations.
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
echo "Checking Prisma files..."
check_file "$API_DIR/prisma/schema.prisma"
check_file "$API_DIR/prisma.config.ts"
check_file "$API_DIR/tsconfig.json"
check_dir  "$API_DIR/node_modules/@prisma/client"
# Note: .prisma/client is generated on-demand by `prisma generate` at runtime
# (e.g. during SQLite→PostgreSQL provider switch). It does not need to exist
# in the image — tsup bundles the build-time generated client into dist/.

echo ""
echo "Checking tsconfig.json does not reference missing files..."
if grep -q 'tsconfig.base.json' "$API_DIR/tsconfig.json" 2>/dev/null; then
    echo "FAIL: tsconfig.json still extends ../../tsconfig.base.json (not available in container)"
    ERRORS=$((ERRORS + 1))
else
    echo "  OK: tsconfig.json is standalone (no monorepo extends)"
fi

echo ""
echo "Checking startup scripts..."
check_file "/app/start.sh"
check_file "$API_DIR/read-base-path.cjs"

echo ""
echo "Checking core runtime files..."
check_dir  "$API_DIR/dist"
check_file "$API_DIR/package.json"

echo ""
if [ "$ERRORS" -gt 0 ]; then
    echo "FAILED: $ERRORS missing file(s) detected"
    exit 1
else
    echo "PASSED: all runtime files present"
    exit 0
fi
