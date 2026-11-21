#!/bin/sh
# Offline only. The compiled actor acquires the existing native database owner.
set -eu
refuse() { echo "Offline recovery runtime is unavailable; no successful recovery was confirmed." >&2; exit 1; }
[ "$#" -eq 0 ] || refuse
DATABASE_URL=${DATABASE_URL:-file:/config/prod.db}
export DATABASE_URL
case "$DATABASE_URL" in
    file:*) provider=sqlite ;;
    postgres://*|postgresql://*) provider=postgresql ;;
    *) refuse ;;
esac
runtime="/app/api/providers/$provider"
set_recovery_directory() {
    [ "$provider" = sqlite ] || return 0
    # Use the native resolver's trim semantics, including Unicode whitespace.
    if "$@" node -e 'process.exit(process.env.DATABASE_URL.slice(5).trim().startsWith("/") ? 0 : 2)' 2>/dev/null; then
        return 0
    else
        [ "$?" -eq 2 ] || refuse
        cd /config/heap-snapshots 2>/dev/null || refuse
    fi
}
if [ "$(id -u)" = 0 ]; then
    PUID=${PUID:-911}
    PGID=${PGID:-911}
    for value in "$PUID" "$PGID"; do
        case "$value" in ''|*[!0-9]*) refuse ;; esac
        [ "${#value}" -le 10 ] && [ "$value" -le 4294967294 ] || refuse
    done
    su-exec "$PUID:$PGID" node /app/api/validate-provider-runtime.cjs "$runtime" "$provider" || refuse
    set_recovery_directory su-exec "$PUID:$PGID"
    exec su-exec "$PUID:$PGID" node "$runtime/dist/reset-admin-password.js"
fi
node /app/api/validate-provider-runtime.cjs "$runtime" "$provider" || refuse
set_recovery_directory
exec node "$runtime/dist/reset-admin-password.js"
