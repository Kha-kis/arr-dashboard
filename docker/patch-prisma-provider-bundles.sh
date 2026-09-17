#!/bin/sh
set -eu

DIST_ROOT=${1:-}
REQUIRED_PROVIDER=${2:-}

die() {

    echo "ERROR: $*" >&2
    exit 1
}

if [ -z "$DIST_ROOT" ] || [ -z "$REQUIRED_PROVIDER" ]; then
    die "usage: $0 DIST_ROOT PROVIDER"
fi
[ -d "$DIST_ROOT" ] || die "bundle directory does not exist: $DIST_ROOT"

case "$REQUIRED_PROVIDER" in
    sqlite|postgresql) ;;
    *) die "unsupported provider: $REQUIRED_PROVIDER" ;;
esac

WORK=$(mktemp -d "${TMPDIR:-/tmp}/patch-prisma-provider-bundles.XXXXXX") ||
    die "could not create a temporary directory"
created_temps="$WORK/created-temps"
: >"$created_temps"

cleanup() {

    if [ -f "$created_temps" ]; then
        while IFS= read -r temporary; do
            [ -n "$temporary" ] && rm -f "$temporary"
        done <"$created_temps"
    fi
    rm -rf "$WORK"
}
trap cleanup EXIT

count() {

    grep -a -F -o -- "$1" "$2" 2>/dev/null | wc -l | tr -d ' '
}

files="$WORK/files"
: >"$files"
all_files="$WORK/all-files"
find "$DIST_ROOT" -type f -name '*.js' -print >"$all_files"

while IFS= read -r file; do
    sqlite_active=$(count '"activeProvider": "sqlite"' "$file")
    postgres_active=$(count '"activeProvider": "postgresql"' "$file")
    sqlite_schema=$(count 'provider = "sqlite"' "$file")
    postgres_schema=$(count 'provider = "postgresql"' "$file")
    sqlite_compilers=$(count 'query_compiler_fast_bg.sqlite.' "$file")
    postgres_compilers=$(count 'query_compiler_fast_bg.postgresql.' "$file")

    marker_count=$((sqlite_active + postgres_active + sqlite_schema + postgres_schema + sqlite_compilers + postgres_compilers))
    [ "$marker_count" -gt 0 ] || continue

    if [ "$sqlite_active" -eq 1 ] && [ "$sqlite_schema" -eq 1 ] && [ "$sqlite_compilers" -eq 2 ] &&
       [ "$postgres_active" -eq 0 ] && [ "$postgres_schema" -eq 0 ] && [ "$postgres_compilers" -eq 0 ]; then
        printf '%s\t%s\n' sqlite "$file" >>"$files"
    elif [ "$postgres_active" -eq 1 ] && [ "$postgres_schema" -eq 1 ] && [ "$postgres_compilers" -eq 2 ] &&
         [ "$sqlite_active" -eq 0 ] && [ "$sqlite_schema" -eq 0 ] && [ "$sqlite_compilers" -eq 0 ]; then
        printf '%s\t%s\n' postgresql "$file" >>"$files"
    else
        die "incomplete or ambiguous Prisma provider config in $file"
    fi
done <"$all_files"

[ -s "$files" ] || die "no complete Prisma provider bundle found under $DIST_ROOT"

[ "$(wc -l <"$files" | tr -d ' ')" -eq 1 ] ||
    die "ambiguous Prisma provider bundles: expected exactly one complete config module"
IFS="$(printf '\t')" read -r current_provider file <"$files"

if [ "$current_provider" = "$REQUIRED_PROVIDER" ]; then
    echo "Prisma provider bundles already use $REQUIRED_PROVIDER"
    exit 0
fi

# This build contains one generated Prisma client. Reject unexpected layouts
# before writing, then replace that one module with a same-directory rename.
# A process killed at this boundary leaves either the old or new complete file;
# leftover .provider-patch.* files are not JavaScript inputs on the next start.
directory=$(dirname -- "$file")
[ -w "$file" ] || die "Prisma provider bundle is not writable: $file"
[ -w "$directory" ] || die "Prisma provider bundle directory is not writable: $directory"

temporary=$(mktemp "$directory/.provider-patch.XXXXXX") ||
    die "could not create a temporary bundle beside $file"
printf '%s\n' "$temporary" >>"$created_temps"
if ! cp -p "$file" "$temporary" ||
   ! sed -i \
       -e 's/"activeProvider": "'"$current_provider"'"/"activeProvider": "'"$REQUIRED_PROVIDER"'"/g' \
       -e 's/provider = "'"$current_provider"'"/provider = "'"$REQUIRED_PROVIDER"'"/g' \
       -e 's/query_compiler_fast_bg\.'"$current_provider"'\./query_compiler_fast_bg.'"$REQUIRED_PROVIDER"'./g' \
       "$temporary"; then
    die "failed to prepare Prisma provider bundle: $file"
fi

[ "$(count '"activeProvider": "'"$REQUIRED_PROVIDER"'"' "$temporary")" -eq 1 ] ||
    die "prepared bundle has an invalid active provider: $file"
[ "$(count 'provider = "'"$REQUIRED_PROVIDER"'"' "$temporary")" -eq 1 ] ||
    die "prepared bundle has an invalid datasource provider: $file"
[ "$(count 'query_compiler_fast_bg.'"$REQUIRED_PROVIDER"'.' "$temporary")" -eq 2 ] ||
    die "prepared bundle has incomplete query compiler references: $file"

mv "$temporary" "$file" || die "failed to install Prisma provider bundle"

echo "Prisma provider bundles switched from $current_provider to $REQUIRED_PROVIDER"
