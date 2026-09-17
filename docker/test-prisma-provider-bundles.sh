#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATCH_HELPER="$SCRIPT_DIR/patch-prisma-provider-bundles.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/test-prisma-provider-bundles.XXXXXX")

cleanup() {

    rm -rf "$WORK"
}
trap cleanup EXIT

fail() {

    echo "FAIL: $*" >&2
    exit 1
}

assert_contains() {

    file=$1
    pattern=$2
    grep -F "$pattern" "$file" >/dev/null || fail "expected '$pattern' in $file"
}

assert_not_contains() {

    file=$1
    pattern=$2
    if grep -F "$pattern" "$file" >/dev/null; then
        fail "did not expect '$pattern' in $file"
    fi
}

write_bundle() {

    file=$1
    cat >"$file" <<'EOF'
const prismaConfig = {"activeProvider": "sqlite"};
const inlineSchema = `datasource db {
  provider = "sqlite"
}`;
const compiler = "query_compiler_fast_bg.sqlite.mjs";
const compilerBase64 = "query_compiler_fast_bg.sqlite.wasm-base64.mjs";
const applicationProvider = "sqlite";
EOF
}

run_helper() {

    "$PATCH_HELPER" "$1" "$2"
}

split_dist="$WORK/split/dist"
mkdir -p "$split_dist"
printf '%s\n' 'import "./chunk-prisma.js";' >"$split_dist/index.js"
write_bundle "$split_dist/chunk-prisma.js"
split_before=$(sha256sum "$split_dist/index.js" "$split_dist/chunk-prisma.js")
run_helper "$split_dist" postgresql
assert_contains "$split_dist/chunk-prisma.js" '"activeProvider": "postgresql"'
assert_contains "$split_dist/chunk-prisma.js" 'provider = "postgresql"'
assert_contains "$split_dist/chunk-prisma.js" 'query_compiler_fast_bg.postgresql.mjs'
assert_contains "$split_dist/chunk-prisma.js" 'query_compiler_fast_bg.postgresql.wasm-base64.mjs'
assert_contains "$split_dist/chunk-prisma.js" 'const applicationProvider = "sqlite"'
assert_not_contains "$split_dist/chunk-prisma.js" 'query_compiler_fast_bg.sqlite.'
split_after=$(sha256sum "$split_dist/index.js" "$split_dist/chunk-prisma.js")
[ "$split_before" != "$split_after" ] || fail "split bundle was not changed"
run_helper "$split_dist" postgresql
[ "$split_after" = "$(sha256sum "$split_dist/index.js" "$split_dist/chunk-prisma.js")" ] || fail "already-switched split bundle was not idempotent"

single_dist="$WORK/single/dist"
mkdir -p "$single_dist"
write_bundle "$single_dist/index.js"
run_helper "$single_dist" postgresql
assert_contains "$single_dist/index.js" '"activeProvider": "postgresql"'
assert_contains "$single_dist/index.js" 'query_compiler_fast_bg.postgresql.mjs'
[ "$(grep -o 'query_compiler_fast_bg.postgresql\.' "$single_dist/index.js" | wc -l | tr -d ' ')" = 2 ] || fail "single bundle compiler references are incomplete"

no_match_dist="$WORK/no-match/dist"
mkdir -p "$no_match_dist"
printf '%s\n' 'const applicationProvider = "sqlite";' >"$no_match_dist/index.js"
if run_helper "$no_match_dist" postgresql; then
    fail "no-match bundle was accepted"
fi
assert_contains "$no_match_dist/index.js" 'const applicationProvider = "sqlite"'

incomplete_dist="$WORK/incomplete/dist"
mkdir -p "$incomplete_dist"
printf '%s\n' 'const config = {"activeProvider": "sqlite"};' >"$incomplete_dist/index.js"
if run_helper "$incomplete_dist" postgresql; then
    fail "incomplete bundle was accepted"
fi
assert_contains "$incomplete_dist/index.js" '"activeProvider": "sqlite"'

ambiguous_dist="$WORK/ambiguous/dist"
mkdir -p "$ambiguous_dist"
write_bundle "$ambiguous_dist/sqlite.js"
sed 's/sqlite/postgresql/g' "$ambiguous_dist/sqlite.js" >"$ambiguous_dist/postgresql.js"
if run_helper "$ambiguous_dist" postgresql; then
    fail "mixed-provider bundles were accepted"
fi
assert_contains "$ambiguous_dist/sqlite.js" '"activeProvider": "sqlite"'
assert_contains "$ambiguous_dist/postgresql.js" '"activeProvider": "postgresql"'

duplicate_dist="$WORK/duplicate/dist"
mkdir -p "$duplicate_dist"
write_bundle "$duplicate_dist/first.js"
write_bundle "$duplicate_dist/second.js"
duplicate_before=$(sha256sum "$duplicate_dist/first.js" "$duplicate_dist/second.js")
if run_helper "$duplicate_dist" postgresql; then
    fail "duplicate complete configs were accepted"
fi
[ "$duplicate_before" = "$(sha256sum "$duplicate_dist/first.js" "$duplicate_dist/second.js")" ] || fail "duplicate configs were modified before refusal"

interrupted_dist="$WORK/interrupted/dist"
fake_bin="$WORK/fake-bin"
mkdir -p "$interrupted_dist" "$fake_bin"
write_bundle "$interrupted_dist/chunk-prisma.js"
real_mv=$(command -v mv)
cat >"$fake_bin/mv" <<EOF
#!/bin/sh
"$real_mv" "\$@" || exit 1
kill -KILL "\$PPID"
EOF
chmod 755 "$fake_bin/mv"
interrupted_status=0
TMPDIR="$WORK" PATH="$fake_bin:$PATH" "$PATCH_HELPER" "$interrupted_dist" postgresql || interrupted_status=$?
[ "$interrupted_status" -eq 137 ] || fail "helper was not killed at the rename boundary"
run_helper "$interrupted_dist" postgresql
assert_contains "$interrupted_dist/chunk-prisma.js" '"activeProvider": "postgresql"'
assert_contains "$interrupted_dist/chunk-prisma.js" 'provider = "postgresql"'
[ "$(grep -o 'query_compiler_fast_bg.postgresql\.' "$interrupted_dist/chunk-prisma.js" | wc -l | tr -d ' ')" = 2 ] || fail "interrupted bundle compiler references are incomplete"
assert_not_contains "$interrupted_dist/chunk-prisma.js" 'query_compiler_fast_bg.sqlite.'

permissions_dist="$WORK/permissions/dist"
mkdir -p "$permissions_dist"
write_bundle "$permissions_dist/index.js"
if command -v sudo >/dev/null 2>&1 && sudo -n -u nobody true 2>/dev/null && id nobody >/dev/null 2>&1; then
    chmod 755 "$WORK" "$WORK/permissions" "$permissions_dist"
    chmod 444 "$permissions_dist/index.js"
    permission_helper="$WORK/patch-prisma-provider-bundles.sh"
    cp "$PATCH_HELPER" "$permission_helper"
    chmod 755 "$permission_helper"
    if sudo -n -u nobody -- "$permission_helper" "$permissions_dist" postgresql; then
        fail "read-only bundle was accepted"
    fi
    assert_contains "$permissions_dist/index.js" '"activeProvider": "sqlite"'
else
    echo "SKIP: permission test (passwordless sudo to nobody unavailable)"
fi

[ -z "$(find "$WORK" -type f \( -name '.provider-patch.*' -o -name '.provider-backup.*' \) -print)" ] ||
    fail "provider helper left temporary files behind"

echo "PASS: Prisma provider bundle patch cases"
