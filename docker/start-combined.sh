#!/bin/sh
set -e

echo "=========================================="
echo "Arr Dashboard - Combined Container"
echo "=========================================="

# ============================================
# Rootless detection
# ============================================
# If the container is already running as a non-root user (e.g., --user 911:911),
# skip all privilege management (groupmod, usermod, chown, su-exec).
# This supports Kubernetes, Podman rootless, and security-hardened deployments.

if [ "$(id -u)" -ne 0 ]; then
    ROOTLESS=true
    ACTUAL_UID=$(id -u)
    ACTUAL_GID=$(id -g)
    # Warn if user explicitly set PUID/PGID that differ from actual UID/GID
    # Skip warning when PUID/PGID match the Dockerfile defaults (911) — not user-set
    if [ -n "$PUID" ] && [ "$PUID" != "$ACTUAL_UID" ] && [ "$PUID" != "911" ]; then
        echo ""
        echo "  WARNING: PUID=$PUID is ignored in rootless mode (running as UID $ACTUAL_UID)"
        echo "  Remove PUID/PGID env vars when using --user, or remove --user to use PUID/PGID"
    fi
    if [ -n "$PGID" ] && [ "$PGID" != "$ACTUAL_GID" ] && [ "$PGID" != "911" ]; then
        echo "  WARNING: PGID=$PGID is ignored in rootless mode (running as GID $ACTUAL_GID)"
    fi
    PUID=$ACTUAL_UID
    PGID=$ACTUAL_GID
    echo ""
    echo "Running in rootless mode (--user $PUID:$PGID)"
    echo "  - Skipping PUID/PGID user management"
    echo "  - Skipping ownership changes"

    # Ensure config directory exists (may fail if parent isn't writable).
    # /config/heap-snapshots is the CWD for the node process so V8's
    # --heapsnapshot-near-heap-limit and --heapsnapshot-signal writes land
    # on the persisted volume (see API launch below + Dockerfile NODE_OPTIONS).
    mkdir -p /config /config/logs /config/heap-snapshots 2>/dev/null || true

    # Verify /config is writable — fail fast with actionable message
    if [ ! -d /config ] || ! touch /config/.startup-check 2>/dev/null; then
        echo "ERROR: /config is not writable by UID:$PUID GID:$PGID" >&2
        echo "  In rootless mode, the config volume must be writable by the --user you specified." >&2
        echo "  Example: chown $PUID:$PGID /path/to/config" >&2
        exit 1
    fi
    rm -f /config/.startup-check
else
    ROOTLESS=false

    # ============================================
    # PUID/PGID handling (LinuxServer convention)
    # ============================================

    PUID=${PUID:-911}
    PGID=${PGID:-911}

    echo ""
    echo "Setting up user/group..."
    echo "  - PUID: $PUID"
    echo "  - PGID: $PGID"

    # Validate PUID/PGID are numeric (defense-in-depth)
    case "$PUID" in
    	''|*[!0-9]*) echo "Invalid PUID: $PUID (must be numeric)" >&2; exit 1 ;;
    esac
    case "$PGID" in
    	''|*[!0-9]*) echo "Invalid PGID: $PGID (must be numeric)" >&2; exit 1 ;;
    esac

    # Modify abc group GID if different from default
    if [ "$(id -g abc)" != "$PGID" ]; then
        groupmod -o -g "$PGID" abc
    fi

    # Modify abc user UID if different from default
    if [ "$(id -u abc)" != "$PUID" ]; then
        usermod -o -u "$PUID" abc
    fi

    # ============================================
    # Directory setup and permissions
    # ============================================

    echo ""
    echo "Setting up directories and permissions..."

    # Ensure config directory exists (LinuxServer convention).
    # /config/heap-snapshots is the CWD for the node process so V8's
    # --heapsnapshot-near-heap-limit and --heapsnapshot-signal writes land
    # on the persisted volume (see API launch below + Dockerfile NODE_OPTIONS).
    mkdir -p /config
    mkdir -p /config/logs
    mkdir -p /config/heap-snapshots

    # Set ownership of writable directories using numeric IDs
    # This ensures correct permissions even when mounting pre-existing directories
    chown -R "${PUID}:${PGID}" /config

    # NOTE: We intentionally do NOT chown /app/api recursively here.
    # A recursive chown on /app/api (~40k+ files in node_modules) causes severe
    # performance issues on Unraid's FUSE-based filesystem (shfs), creating
    # startup hangs that can last several minutes or indefinitely.
    # See: https://github.com/Kha-kis/arr-dashboard/issues/29
    #
    # Instead, we only set permissions on specific Prisma directories when
    # a database provider switch actually requires client regeneration (below).
fi

# Helper: run a command as the target user (su-exec when root, direct when rootless)
run_as_user() {
    if [ "$ROOTLESS" = true ]; then
        "$@"
    else
        su-exec abc "$@"
    fi
}

# Next writes optimized image artifacts at runtime. The image creates only
# this disposable cache with a cross-UID writable mode; verify it as the actual
# runtime user before either service can accept traffic.
NEXT_IMAGE_CACHE=/app/web/apps/web/.next/cache
NEXT_IMAGE_CACHE_PROBE="$NEXT_IMAGE_CACHE/.startup-check-$$"
if [ ! -d "$NEXT_IMAGE_CACHE" ] || ! run_as_user sh -c '
    probe=$1
    printf first > "$probe" &&
    printf second >> "$probe" &&
    rm -f "$probe"
' sh "$NEXT_IMAGE_CACHE_PROBE"; then
    run_as_user rm -f "$NEXT_IMAGE_CACHE_PROBE" 2>/dev/null || true
    echo "ERROR: Next image cache is not writable: $NEXT_IMAGE_CACHE (UID:$PUID GID:$PGID)" >&2
    exit 1
fi
echo "Next image cache ready: $NEXT_IMAGE_CACHE (UID:$PUID GID:$PGID)"

# ============================================
# Process supervision helpers
# ============================================

# Seconds to allow a service to stop (after the sibling exits, or on an
# intentional shutdown) before escalating to SIGKILL.
#
# Docker's default Linux container stop timeout is 10 seconds. The internal
# default intentionally stays below it (7s) so start.sh can finish its own
# SIGKILL escalation, child reaping, logging, and exit before Docker force-kills
# PID 1. Operators who raise SHUTDOWN_GRACE must also raise the external
# timeout: `docker run --stop-timeout`, `docker stop --time`, Compose
# `stop_grace_period`, or the equivalent orchestrator setting.
SHUTDOWN_GRACE="${SHUTDOWN_GRACE:-7}"

# Validate SHUTDOWN_GRACE is a non-negative integer. Invalid input (e.g. "abc",
# "-1", "1.5", whitespace) must not break cleanup under `set -e`, so fall back
# to the documented default rather than failing mid-shutdown.
case "$SHUTDOWN_GRACE" in
    ''|*[!0-9]*)
        echo "WARNING: invalid SHUTDOWN_GRACE='$SHUTDOWN_GRACE' (expected a non-negative integer); using default 7" >&2
        SHUTDOWN_GRACE=7
        ;;
esac

# Warn (but do not fail) when the operator configured a grace at or above
# Docker's default 10s Linux stop timeout, which would leave no margin for
# start.sh to finish cleanup before Docker force-kills PID 1.
if [ "$SHUTDOWN_GRACE" -ge 10 ]; then
    echo "WARNING: SHUTDOWN_GRACE is ${SHUTDOWN_GRACE} seconds." >&2
    echo "  Docker's default Linux stop timeout is 10 seconds." >&2
    echo "  Configure the container/orchestrator stop timeout above ${SHUTDOWN_GRACE} seconds" >&2
    echo "  or Docker may force-kill the container before graceful cleanup completes." >&2
fi

# Zombie-aware liveness check. A process that has exited but not yet been
# reaped still appears in /proc with state "Z"; kill -0 would wrongly report
# it as alive, so we read the `State:` line from /proc/<pid>/status. This is
# robust against comm values containing spaces/parentheses (e.g. the web
# server's "next-server (v)" process title), which would break a naive
# whitespace split of /proc/<pid>/stat.
process_is_alive() {
    [ -n "$1" ] || return 1
    [ -d "/proc/$1" ] || return 1
    state=$(sed -n 's/^State:[[:space:]]*\([A-Za-z]\).*/\1/p' "/proc/$1/status" 2>/dev/null)
    case "$state" in
        Z|X|x) return 1 ;;   # zombie or dead — not live
        '')     return 1 ;;   # unreadable/absent — treat as not live
    esac
    return 0
}

# Signal only a known tracked process; ignore errors (it may already be gone).
signal_tracked() {
    [ -n "$1" ] && kill -s "$2" "$1" 2>/dev/null || true
}

# Wait up to $2 seconds for tracked process $1 to exit. Returns 0 when gone.
wait_for_exit() {
    pid=$1
    timeout=$2
    elapsed=0
    while [ "$elapsed" -lt "$timeout" ]; do
        process_is_alive "$pid" || return 0
        sleep 1
        elapsed=$((elapsed + 1))
    done
    return 1
}

# Reap a dead tracked process and record its exit status (128+signal for
# signal deaths). Never aborts the script under set -e.
reap_tracked() {
    set +e
    wait "$1" 2>/dev/null
    _REAPED=$?
    set -e
}

# ============================================
# Signal handling
# ============================================

# Signal both tracked services with SIGTERM, then wait for both to exit within
# a single shared grace deadline. Any survivor after the deadline is SIGKILLed.
# This is the one global shutdown window — it is NOT applied independently per
# service, so a slow API cannot extend the total stop time beyond SHUTDOWN_GRACE.
stop_services() {
    signal_tracked "$WEB_PID" TERM
    signal_tracked "$API_PID" TERM

    elapsed=0
    while [ "$elapsed" -lt "$SHUTDOWN_GRACE" ]; do
        if ! process_is_alive "$WEB_PID" && ! process_is_alive "$API_PID"; then
            break
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done

    # Escalate any survivor to SIGKILL (bounded follow-up wait).
    if process_is_alive "$WEB_PID"; then
        echo "  Web did not stop within ${SHUTDOWN_GRACE}s - sending SIGKILL" >&2
        signal_tracked "$WEB_PID" KILL
        wait_for_exit "$WEB_PID" 5
    fi
    if process_is_alive "$API_PID"; then
        echo "  API did not stop within ${SHUTDOWN_GRACE}s - sending SIGKILL" >&2
        signal_tracked "$API_PID" KILL
        wait_for_exit "$API_PID" 5
    fi

    # Reap both so no orphan or zombie is left behind
    reap_tracked "$WEB_PID"
    reap_tracked "$API_PID"
}

shutdown() {
    echo ""
    echo "Shutting down services..."
    stop_services
    echo "Services stopped gracefully"
    exit 0
}

trap shutdown SIGTERM SIGINT

# ============================================
# Database provider detection and Prisma setup
# ============================================

echo ""
echo "Detecting database type..."
cd /app/api

# Default DATABASE_URL to SQLite if not set or empty
# This handles cases where Unraid template sets DATABASE_URL="" which overrides Dockerfile default
if [ -z "$DATABASE_URL" ]; then
    export DATABASE_URL="file:/config/prod.db"
    echo "  - DATABASE_URL not set, defaulting to SQLite: $DATABASE_URL"
fi

# Detect if DATABASE_URL is PostgreSQL
if echo "$DATABASE_URL" | grep -qE "^postgres(ql)?://"; then
    echo "  - PostgreSQL database detected"
    DB_PROVIDER="postgresql"
else
    echo "  - SQLite database detected"
    DB_PROVIDER="sqlite"
fi

# Check current datasource provider in schema (not the generator provider)
# Look for provider inside datasource block specifically
CURRENT_PROVIDER=$(grep -A2 'datasource db' prisma/schema.prisma | grep 'provider' | sed 's/.*provider = "\([^"]*\)".*/\1/')

echo "  - Current schema provider: $CURRENT_PROVIDER"
echo "  - Required provider: $DB_PROVIDER"

# If provider needs to change, update schema and regenerate client
if [ "$CURRENT_PROVIDER" != "$DB_PROVIDER" ]; then
    echo "  - Switching Prisma datasource provider from $CURRENT_PROVIDER to $DB_PROVIDER..."

    # Update only the datasource provider in schema.prisma (not the generator)
    # Use a more robust sed pattern that handles different formatting
    if ! sed -i '/datasource db/,/^}/ s/provider = "[^"]*"/provider = "'"$DB_PROVIDER"'"/' prisma/schema.prisma; then
        echo "ERROR: Failed to update schema.prisma provider" >&2
        if [ "$ROOTLESS" = true ]; then
            echo "  In rootless mode, schema files may not be writable." >&2
            echo "  Either rebuild the image with DATABASE_URL set, or ensure /app/api is writable." >&2
        fi
        exit 1
    fi

    # Verify the change was applied
    NEW_PROVIDER=$(grep -A2 'datasource db' prisma/schema.prisma | grep 'provider' | sed 's/.*provider = "\([^"]*\)".*/\1/')
    if [ "$NEW_PROVIDER" != "$DB_PROVIDER" ]; then
        echo "ERROR: Schema provider update failed. Expected '$DB_PROVIDER' but got '$NEW_PROVIDER'" >&2
        echo "  This may happen if the schema.prisma format is non-standard." >&2
        exit 1
    fi
    echo "  - Schema updated successfully"

    # sed -i replaces the schema with a root-owned file. Prisma 7 opens that
    # schema with write access while loading prisma.config.ts, so hand the
    # single file back to the remapped runtime user before generation.
    if [ "$ROOTLESS" = false ]; then
        chown "${PUID}:${PGID}" /app/api/prisma/schema.prisma
    fi

    # Regenerate Prisma client for new provider
    echo "  - Regenerating Prisma client (this may take a moment)..."

    # Set permissions ONLY on the specific Prisma client directories that need to be writable
    # This is much faster than chown -R /app/api which causes Unraid startup hangs
    # See: https://github.com/Kha-kis/arr-dashboard/issues/29
    # Skip in rootless mode — the user already owns these files or they were built with correct ownership
    if [ "$ROOTLESS" = false ]; then
        echo "  - Setting permissions for Prisma client directories..."
        for dir in /app/api/node_modules/.pnpm/@prisma+client@*/; do
            [ -d "$dir" ] && chown -R "${PUID}:${PGID}" "$dir"
        done
        # Also handle the top-level @prisma directory symlinks
        [ -d "/app/api/node_modules/@prisma" ] && chown -R "${PUID}:${PGID}" "/app/api/node_modules/@prisma"
        # Ensure prisma directory is writable for any generated files
        [ -d "/app/api/node_modules/.prisma" ] && chown -R "${PUID}:${PGID}" "/app/api/node_modules/.prisma"
        # Ensure Prisma output directory is writable (Prisma 7 generates to src/generated/prisma/)
        [ -d "/app/api/src/generated" ] && chown -R "${PUID}:${PGID}" "/app/api/src/generated"
    fi

    if ! run_as_user ./node_modules/.bin/prisma generate --schema prisma/schema.prisma; then
        echo "ERROR: Failed to regenerate Prisma client" >&2
        if [ "$ROOTLESS" = true ]; then
            echo "  In rootless mode, ensure /app/api is writable by UID:$PUID" >&2
        else
            echo "  Check that /app/api has correct permissions for PUID:$PUID PGID:$PGID" >&2
        fi
        exit 1
    fi

    # Patch the bundled dist/index.js to match the new provider.
    # tsup inlines the Prisma-generated config (activeProvider, inlineSchema, and
    # WASM query compiler import paths) at build time. Since the image always builds
    # with SQLite, the bundle has "sqlite" baked in three places:
    #   1. "activeProvider": "sqlite"        → Prisma runtime provider selection
    #   2. provider = "sqlite"               → inlineSchema datasource block
    #   3. query_compiler_fast_bg.sqlite.*   → WASM query compiler module paths
    # Without this patch, the Prisma runtime loads the SQLite query compiler and
    # generates SQLite-dialect SQL, causing a silent crash with PostgreSQL.
    echo "  - Patching bundled Prisma config in dist/index.js..."
    if [ -f dist/index.js ]; then
        if ! sed -i 's/"activeProvider": "sqlite"/"activeProvider": "'"$DB_PROVIDER"'"/' dist/index.js \
           || ! sed -i 's/provider = "sqlite"/provider = "'"$DB_PROVIDER"'"/' dist/index.js \
           || ! sed -i 's/query_compiler_fast_bg\.sqlite\./query_compiler_fast_bg.'"$DB_PROVIDER"'./g' dist/index.js; then
            echo "ERROR: Failed to patch dist/index.js for $DB_PROVIDER" >&2
            if [ "$ROOTLESS" = true ]; then
                echo "  In rootless mode, ensure /app/api/dist is writable by UID:$PUID" >&2
            fi
            exit 1
        fi
        echo "  - Bundle patched for $DB_PROVIDER"

        # Verify the patch was actually applied (sed returns 0 even when matching nothing)
        echo "  - Verifying patch..."
        echo "    activeProvider: $(grep -o '"activeProvider": "[^"]*"' dist/index.js)"
        echo "    WASM paths: $(grep -c "query_compiler_fast_bg.$DB_PROVIDER." dist/index.js) references"

        if grep -q '"activeProvider": "sqlite"' dist/index.js && [ "$DB_PROVIDER" = "postgresql" ]; then
            echo "ERROR: dist/index.js still contains sqlite provider after patching" >&2
            echo "  The bundle format may have changed — rebuild the image" >&2
            exit 1
        fi
    else
        echo "WARNING: dist/index.js not found, skipping bundle patch" >&2
    fi

    echo "  - Provider switched successfully"
else
    echo "  - Prisma provider already set to $DB_PROVIDER (no change needed)"
fi

# Prisma 7 opens the schema with write access while loading prisma.config.ts
# for `db push`, even when the datasource provider did not change. The image
# files are owned by the build-time abc UID (911), but LinuxServer-style
# PUID/PGID remapping changes abc to the operator's IDs at startup. Hand off
# only the schema file instead of recursively chowning /app/api, which would
# reintroduce the severe Unraid startup cost documented above.
if [ "$ROOTLESS" = false ]; then
    chown "${PUID}:${PGID}" /app/api/prisma/schema.prisma
fi

# ============================================
# Database schema synchronization (run as abc user)
# ============================================

echo ""
echo "Synchronizing database schema..."
# v2.24 broadens the TMDb and Trakt list-cache identity to include mediaType.
# The previous unique indexes are stricter, so an existing row set that
# satisfies them must also satisfy the replacements. Prisma still classifies
# replacement unique indexes as potentially destructive. Apply this reviewed,
# transactional PostgreSQL migration first so db push can remain fail-closed
# without --accept-data-loss.
if [ "$DB_PROVIDER" = "postgresql" ]; then
    echo "  - Applying serialized PostgreSQL schema synchronization..."
    if ! run_as_user node /app/api/sync-postgresql-schema.cjs; then
        echo "ERROR: PostgreSQL schema synchronization failed" >&2
        echo "  - The migration outcome may be unknown; the next startup will reconcile it safely" >&2
        exit 1
    fi
    echo "  - PostgreSQL schema synchronized successfully"
else
    # Use 'db push' instead of 'migrate deploy' to support SQLite without a
    # provider-specific migration history. Deliberately do NOT pass
    # --accept-data-loss: destructive transitions require an explicit path.
    if ! run_as_user ./node_modules/.bin/prisma db push --schema prisma/schema.prisma; then
        echo "ERROR: Database schema synchronization failed" >&2
        if [ "$ROOTLESS" = true ]; then
            echo "  - In rootless mode, ensure the database file is readable/writable by UID:$PUID" >&2
            echo "  - If switching from root to rootless, run: chown $PUID:$PGID /path/to/config/prod.db" >&2
        fi
        echo "  - Destructive schema changes are intentionally rejected at startup" >&2
        echo "  - Restore the previous image and consult the release notes for an explicit upgrade path" >&2
        echo "  - Ensure DATABASE_URL is correct and the database is accessible" >&2
        echo "  - Detected database provider: $DB_PROVIDER" >&2
        exit 1
    fi
    echo "  - Database schema synchronized successfully"
fi

# ============================================
# Read system settings from database
# ============================================

echo ""
echo "Loading system settings from database..."

# Read settings as JSON from database (script is in api dir to access prisma client)
DB_SETTINGS=$(run_as_user node /app/api/read-base-path.cjs 2>/dev/null || echo '{"apiPort":null,"webPort":null,"listenAddress":null}')

# Parse JSON values using node (since jq might not be available)
DB_API_PORT=$(echo "$DB_SETTINGS" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const v=JSON.parse(d).apiPort;console.log(v||'')})")
DB_WEB_PORT=$(echo "$DB_SETTINGS" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const v=JSON.parse(d).webPort;console.log(v||'')})")
DB_LISTEN_ADDRESS=$(echo "$DB_SETTINGS" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const v=JSON.parse(d).listenAddress;console.log(v||'')})")

# Priority: Database settings > Environment variables > Defaults
# Database settings take precedence because users configure them via the UI
# Environment variables are typically Dockerfile defaults, not user-configured
if [ -n "$DB_API_PORT" ]; then
    export API_PORT="$DB_API_PORT"
elif [ -z "$API_PORT" ]; then
    export API_PORT="3001"
fi

if [ -n "$DB_WEB_PORT" ]; then
    export PORT="$DB_WEB_PORT"
elif [ -z "$PORT" ]; then
    export PORT="3000"
fi

if [ -n "$DB_LISTEN_ADDRESS" ]; then
    export HOST="$DB_LISTEN_ADDRESS"
elif [ -z "$HOST" ]; then
    export HOST="0.0.0.0"
fi

echo "  - Listen Address: $HOST"
echo "  - API Port: $API_PORT"
echo "  - Web Port: $PORT"

# ============================================
# Start API server (as abc user)
# ============================================

echo ""
echo "Starting API server on $HOST:$API_PORT..."
cd /app/api

# Heap diagnostics (issue #427 follow-up).
#
# CWD = /config/heap-snapshots so V8's --heapsnapshot-signal writes land on
# the persisted volume instead of the ephemeral /app/api inside the image.
# Using the absolute /app/api/dist/index.js lets us change CWD without
# breaking module resolution for the bundled API.
#
# HEAP_AUTO_SNAPSHOT=1 appends --heapsnapshot-near-heap-limit=1 so V8
# captures a snapshot just before OOM. Off by default because the snapshot
# is ~3x the heap (~2.3 GB at the 768 MB cap). The manual SIGUSR2 trigger
# in NODE_OPTIONS works regardless of this flag.
if [ "${HEAP_AUTO_SNAPSHOT:-0}" = "1" ]; then
    export NODE_OPTIONS="${NODE_OPTIONS} --heapsnapshot-near-heap-limit=1"
    echo "  - HEAP_AUTO_SNAPSHOT enabled — V8 will write up to 1 snapshot to /config/heap-snapshots/ on near-OOM"
fi

# OS-level memory hygiene (issue #427 / #471 follow-up).
#
# Node on glibc allocates many small chunks for decoded JSON, Prisma rows,
# and TLS buffers; glibc's default 8-arena allocator rarely returns those
# pages to the OS. The result is RSS climbing well past V8's heap cap even
# when the JS heap itself is healthy — reporters with 2900+ -item libraries
# see RSS at 3-4x heapTotal (see #471). Capping glibc to 2 arenas typically
# drops long-run RSS 30-50% with no code changes and is the canonical
# Node-on-Linux deployment tweak.
#
# Override via `MALLOC_ARENA_MAX=N` if you have a specific reason
# (multi-CPU NUMA tuning, very high request concurrency).
MALLOC_ARENA_MAX="${MALLOC_ARENA_MAX:-2}"
echo "  - MALLOC_ARENA_MAX: $MALLOC_ARENA_MAX (glibc arena cap — keeps RSS in check on long-running containers)"

# Let stdout/stderr flow directly to the container — Pino handles file logging
# via its pino-roll transport (writes to /config/logs/arr-dashboard.log).
# Previous approach redirected stdout to api.log, which conflicted with Pino's
# worker-thread transport and caused both log files to remain empty.
#
# API service: /app/api/dist/launcher.js (the stable top-level process).
#   - The launcher spawns the inner API server, sets LAUNCHER_MANAGED=true, and
#     restarts it internally on the application-requested exit code 42 (backup
#     restore, manual restart). start.sh supervises the launcher, so a
#     legitimate app restart is never mistaken for an API crash.
#   - A non-42 exit makes the launcher exit with that code, which the combined
#     supervisor treats as a fatal API loss.
#   - CWD = /config/heap-snapshots so V8's --heapsnapshot-signal writes land
#     on the persisted volume (same as before).
#   - The command is backgrounded as a simple external command so BusyBox ash
#     exec's it directly and API_PID is the launcher node process itself. (A
#     run_as_user() function call would fork an untracked subshell instead —
#     verified against the shipped image.)
if [ "$ROOTLESS" = true ]; then
    sh -c "cd /config/heap-snapshots && MALLOC_ARENA_MAX=$MALLOC_ARENA_MAX API_HOST=$HOST API_PORT=$API_PORT HOST=$HOST node /app/api/dist/launcher.js" &
else
    su-exec abc sh -c "cd /config/heap-snapshots && MALLOC_ARENA_MAX=$MALLOC_ARENA_MAX API_HOST=$HOST API_PORT=$API_PORT HOST=$HOST node /app/api/dist/launcher.js" &
fi
API_PID=$!
echo "API started with PID $API_PID"

# Give API a moment to start, then verify it's still running. Uses the
# zombie-aware check: a process that exited but was not yet reaped would pass
# kill -0, so inspect the /proc state explicitly (same as the supervision loop).
sleep 3
if ! process_is_alive "$API_PID"; then
    echo ""
    echo "ERROR: API process (PID $API_PID) died during startup!" >&2

    # Temporarily disable set -e so wait's non-zero exit doesn't kill the script
    set +e
    wait "$API_PID" 2>/dev/null
    API_EXIT=$?
    set -e
    echo "  API exit code: $API_EXIT" >&2

    # Re-run the API in the foreground with a timeout to capture the actual error.
    # Mirror the backgrounded launch above (cd into /config/heap-snapshots,
    # use the absolute path to dist/launcher.js) so any heap snapshot V8 writes
    # during the diagnostic re-run also lands on the persisted volume — and
    # so this branch doesn't silently break if a future edit changes the
    # outer shell's CWD between the two launch sites.
    echo "=== Re-running API in foreground (10s timeout) ===" >&2
    set +e
    if [ "$ROOTLESS" = true ]; then
        timeout 10 sh -c "cd /config/heap-snapshots && API_HOST=$HOST API_PORT=$API_PORT HOST=$HOST node /app/api/dist/launcher.js" 2>&1
    else
        timeout 10 su-exec abc sh -c "cd /config/heap-snapshots && API_HOST=$HOST API_PORT=$API_PORT HOST=$HOST node /app/api/dist/launcher.js" 2>&1
    fi
    RERUN_EXIT=$?
    set -e
    echo "=== Foreground API exit code: $RERUN_EXIT ===" >&2
    exit 1
fi

# ============================================
# Start Web server (as abc user)
# ============================================

echo ""
echo "Starting Web server on $HOST:$PORT..."
cd /app/web
# Use custom server wrapper for runtime API_HOST configuration.
# Backgrounded as a simple external command so WEB_PID is the node process
# itself (not a subshell wrapper) — same rationale as the API launch above.
if [ "$ROOTLESS" = true ]; then
    sh -c "API_HOST=http://localhost:$API_PORT PORT=$PORT HOSTNAME=$HOST HOST=$HOST node server.js" &
else
    su-exec abc sh -c "API_HOST=http://localhost:$API_PORT PORT=$PORT HOSTNAME=$HOST HOST=$HOST node server.js" &
fi
WEB_PID=$!
echo "Web started with PID $WEB_PID"

echo ""
echo "=========================================="
echo "Arr Dashboard is ready!"
echo "Web UI: http://localhost:$PORT"
echo "API: http://localhost:$API_PORT"
echo "Running as UID:$PUID GID:$PGID"
echo "=========================================="

# ============================================
# Service supervision
# ============================================
# State machine:
#   RUNNING                - both top-level services alive (polled below)
#   INTENTIONAL_SHUTDOWN   - SIGTERM/SIGINT received; shutdown() trap handles it
#   UNEXPECTED_API_EXIT    - API launcher exited outside an intentional shutdown
#   UNEXPECTED_WEB_EXIT    - web server exited outside an intentional shutdown
#   CLEANUP_IN_PROGRESS    - sibling termination underway (fatal_exit())
#
# Any tracked top-level service exit outside an intentional shutdown is fatal,
# including exit code 0: both services are required for a functioning install.

fatal_exit() {
    service=$1
    status=$2
    sibling=$3
    sibling_name=$4

    echo ""
    echo "ERROR: $service service exited unexpectedly (status: $status)." >&2
    echo "  Terminating $sibling_name service and shutting down the container." >&2

    # Terminate the surviving sibling (idempotent — safe if it already died)
    signal_tracked "$sibling" TERM
    if ! wait_for_exit "$sibling" "$SHUTDOWN_GRACE"; then
        echo "  $sibling_name did not stop within ${SHUTDOWN_GRACE}s - sending SIGKILL" >&2
        signal_tracked "$sibling" KILL
        wait_for_exit "$sibling" 5
    fi

    # Reap the sibling so no orphan or zombie is left behind
    reap_tracked "$sibling"

    exit 1
}

# Poll both tracked services until one exits. The loop only exits through
# fatal_exit() (unexpected service loss) or the SIGTERM/SIGINT trap
# (intentional stop). Zombie-aware liveness means a service that just died
# is detected on the next tick even before it is reaped.
while :; do
    if ! process_is_alive "$API_PID"; then
        reap_tracked "$API_PID"
        fatal_exit "API" "$_REAPED" "$WEB_PID" "Web"
    fi
    if ! process_is_alive "$WEB_PID"; then
        reap_tracked "$WEB_PID"
        fatal_exit "Web" "$_REAPED" "$API_PID" "API"
    fi
    sleep 1
done
