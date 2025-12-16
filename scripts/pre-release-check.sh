#!/bin/bash
# Pre-release automated checks for arr-dashboard
# Run this before tagging a release

set -e

echo "========================================="
echo "  Arr Dashboard Pre-Release Checks"
echo "  Version: 2.6.2"
echo "========================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Track failures
FAILURES=0

check_pass() {
    echo -e "${GREEN}✓ PASS${NC}: $1"
}

check_fail() {
    echo -e "${RED}✗ FAIL${NC}: $1"
    FAILURES=$((FAILURES + 1))
}

check_warn() {
    echo -e "${YELLOW}⚠ WARN${NC}: $1"
}

# Navigate to project root
cd "$(dirname "$0")/.."
PROJECT_ROOT=$(pwd)

echo "Project root: $PROJECT_ROOT"
echo ""

# 1. Check version consistency
echo "--- Version Consistency ---"
ROOT_VERSION=$(node -p "require('./package.json').version")
README_VERSION=$(grep -oP '(?<=\*\*Version )[0-9.]+' README.md | head -1)
RELEASE_VERSION=$(grep -oP '(?<=## Version )[0-9.]+' RELEASE_NOTES.md | head -1)

echo "package.json:    $ROOT_VERSION"
echo "README.md:       $README_VERSION"
echo "RELEASE_NOTES:   $RELEASE_VERSION"

if [ "$ROOT_VERSION" = "$README_VERSION" ] && [ "$ROOT_VERSION" = "$RELEASE_VERSION" ]; then
    check_pass "Version numbers match across files"
else
    check_fail "Version mismatch detected"
fi
echo ""

# 2. Run linting
echo "--- Linting ---"
if pnpm run lint > /tmp/lint-output.txt 2>&1; then
    check_pass "Lint passed"
else
    check_fail "Lint failed"
    tail -20 /tmp/lint-output.txt
fi
echo ""

# 3. Run type checking
echo "--- Type Checking ---"
if pnpm --filter @arr/api typecheck > /tmp/typecheck-output.txt 2>&1; then
    check_pass "API typecheck passed"
else
    check_fail "API typecheck failed"
    tail -20 /tmp/typecheck-output.txt
fi
echo ""

# 4. Run build
echo "--- Build ---"
if pnpm run build > /tmp/build-output.txt 2>&1; then
    check_pass "Build completed successfully"
else
    check_fail "Build failed"
    tail -30 /tmp/build-output.txt
fi
echo ""

# 5. Check for security issues
echo "--- Security Checks ---"

# Check for hardcoded secrets patterns
if grep -rE "(password|secret|apikey|api_key)\s*[:=]\s*['\"][^'\"]+['\"]" \
    --include="*.ts" --include="*.tsx" --include="*.js" \
    apps/ packages/ 2>/dev/null | grep -v "test" | grep -v ".d.ts" | head -5; then
    check_warn "Possible hardcoded secrets found (review manually)"
else
    check_pass "No obvious hardcoded secrets"
fi

# Check for console.log in production code
CONSOLE_LOGS=$(grep -r "console.log" --include="*.ts" --include="*.tsx" \
    apps/web/src apps/api/src 2>/dev/null | wc -l)
if [ "$CONSOLE_LOGS" -gt 10 ]; then
    check_warn "Found $CONSOLE_LOGS console.log statements (consider removing)"
else
    check_pass "Console.log count acceptable ($CONSOLE_LOGS)"
fi
echo ""

# 6. Check for TODO comments
echo "--- Code Quality ---"
TODO_COUNT=$(grep -rE "TODO|FIXME|HACK|XXX" --include="*.ts" --include="*.tsx" \
    apps/ packages/ 2>/dev/null | wc -l)
if [ "$TODO_COUNT" -gt 20 ]; then
    check_warn "Found $TODO_COUNT TODO/FIXME comments"
else
    check_pass "TODO count acceptable ($TODO_COUNT)"
fi
echo ""

# 7. Check Docker build (optional, slower)
if [ "$1" = "--docker" ]; then
    echo "--- Docker Build ---"
    if docker build -t arr-dashboard:pre-release-test . > /tmp/docker-output.txt 2>&1; then
        check_pass "Docker build succeeded"
        docker rmi arr-dashboard:pre-release-test > /dev/null 2>&1
    else
        check_fail "Docker build failed"
        tail -30 /tmp/docker-output.txt
    fi
    echo ""
fi

# 8. Git status check
echo "--- Git Status ---"
if [ -z "$(git status --porcelain)" ]; then
    check_pass "Working directory clean"
else
    check_warn "Uncommitted changes detected"
    git status --short
fi
echo ""

# Summary
echo "========================================="
if [ $FAILURES -eq 0 ]; then
    echo -e "${GREEN}All checks passed!${NC}"
    echo "Ready to tag release v$ROOT_VERSION"
    echo ""
    echo "To create the release:"
    echo "  git tag v$ROOT_VERSION"
    echo "  git push origin v$ROOT_VERSION"
else
    echo -e "${RED}$FAILURES check(s) failed${NC}"
    echo "Please fix issues before releasing"
    exit 1
fi
echo "========================================="
