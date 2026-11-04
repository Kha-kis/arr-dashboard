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

    # NOTE: Image-owned application code keeps its build-time ownership.
    # Recursively changing dependency ownership (~40k+ files) causes severe
    # performance issues on Unraid's FUSE-based filesystem (shfs), creating
    # startup hangs that can last several minutes or indefinitely.
    # See: https://github.com/Kha-kis/arr-dashboard/issues/29
    #
    # Both provider packages are prebuilt; no application write is needed.
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

API_PID=""
WEB_PID=""
STARTUP_CHANNEL_PREPARED=false
SHUTDOWN_IN_PROGRESS=false

# Seconds to allow a service to stop (after the sibling exits, or on an
# intentional shutdown) before escalating to SIGKILL.
#
# Entered cache publication transactions may need up to 60 seconds. Allow
# their real result and infrastructure closure before forcing a failed stop.
# The launcher reserves one second of this shared window for its final join.
# Compose and the documented Docker commands allow 120 seconds externally;
# an image cannot override Docker's otherwise too-short 10-second default.
SHUTDOWN_GRACE="${SHUTDOWN_GRACE:-90}"

# Validate SHUTDOWN_GRACE is a non-negative integer. Invalid input (e.g. "abc",
# "-1", "1.5", whitespace) must not break cleanup under `set -e`, so fall back
# to the documented default rather than failing mid-shutdown.
case "$SHUTDOWN_GRACE" in
    ''|*[!0-9]*)
        echo "WARNING: invalid SHUTDOWN_GRACE (expected a bounded non-negative integer); using default 90" >&2
        SHUTDOWN_GRACE=90
        ;;
esac

# Match the launcher's safe timer range. Strip leading zeroes before shell
# arithmetic so an oversized value never overflows or disables bounded cleanup.
SHUTDOWN_GRACE=$(printf '%s' "$SHUTDOWN_GRACE" | sed 's/^0*//')
SHUTDOWN_GRACE=${SHUTDOWN_GRACE:-0}
if [ "${#SHUTDOWN_GRACE}" -gt 7 ] || [ "$SHUTDOWN_GRACE" -gt 2147483 ]; then
    echo "WARNING: invalid SHUTDOWN_GRACE (timer range exceeded); using default 90" >&2
    SHUTDOWN_GRACE=90
fi
export SHUTDOWN_GRACE

# Warn (but do not fail) when the operator configured a grace at or above
# Docker's default 10s Linux stop timeout, which would leave no margin for
# start.sh to finish cleanup before Docker force-kills PID 1.
if [ "$SHUTDOWN_GRACE" -ge 10 ]; then
    echo "WARNING: SHUTDOWN_GRACE is ${SHUTDOWN_GRACE} seconds." >&2
    echo "  Docker's default Linux stop timeout is 10 seconds." >&2
    echo "  Configure the container/orchestrator stop timeout with cleanup margin (default: 120 seconds)" >&2
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
    ! process_is_alive "$pid"
}

# Reap a dead tracked process and record its exit status (128+signal for
# signal deaths). Never aborts the script under set -e.
reap_tracked() {
    set +e
    wait "$1" 2>/dev/null
    _REAPED=$?
    echo "SUPERVISOR_WAIT_COMPLETED pid=$1 status=$_REAPED"
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
    STOP_FAILED=0
    WEB_TERM_SENT=false
    if process_is_alive "$WEB_PID" && kill -s TERM "$WEB_PID" 2>/dev/null; then
        WEB_TERM_SENT=true
    fi
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
        STOP_FAILED=1
        echo "  Web did not stop within ${SHUTDOWN_GRACE}s - sending SIGKILL" >&2
        signal_tracked "$WEB_PID" KILL
        wait_for_exit "$WEB_PID" 5
    fi
    # Give the launcher its bounded final join tick, including a configured
    # zero-second grace. It escalates the actual API child before its own exit.
    if process_is_alive "$API_PID" && ! wait_for_exit "$API_PID" 1; then
        STOP_FAILED=1
        echo "  API did not stop within ${SHUTDOWN_GRACE}s - sending SIGKILL" >&2
        signal_tracked "$API_PID" KILL
        wait_for_exit "$API_PID" 5
    fi

    # Reap both so no orphan or zombie is left behind
    if [ -n "$WEB_PID" ]; then
        reap_tracked "$WEB_PID"
        # Next completes SIGTERM cleanup with status 143. Accept that convention
        # only after we signalled a live web service; never erase forced-stop
        # failure or normalize an unexpected exit in the supervision loop.
        case "$_REAPED" in
            0) ;;
            143) if [ "$WEB_TERM_SENT" != true ]; then STOP_FAILED=1; fi ;;
            *) STOP_FAILED=1 ;;
        esac
    fi
    if [ -n "$API_PID" ]; then reap_tracked "$API_PID"; if [ "$_REAPED" -ne 0 ]; then STOP_FAILED=1; fi; fi
}

cleanup_startup_channel() {
    if [ "$STARTUP_CHANNEL_PREPARED" = true ]; then
        if ! run_as_user node "$API_RUNTIME_DIR/dist/combined-startup.js" cleanup; then
            echo "ERROR: Startup metadata could not be safely removed; preserving evidence" >&2
            return 1
        fi
        STARTUP_CHANNEL_PREPARED=false
    fi
}

startup_failure() {
    echo "ERROR: API startup handoff did not complete; web was not started" >&2
    echo "  - Destructive schema changes are intentionally rejected at startup" >&2
    echo "  - An unacknowledged commit is unknown; do not assume rollback" >&2
    echo "  - Keep services stopped and consult the release notes for an explicit upgrade path" >&2
    stop_services
    cleanup_startup_channel || true
    exit 1
}

shutdown() {
    if [ "$SHUTDOWN_IN_PROGRESS" = true ]; then return; fi
    SHUTDOWN_IN_PROGRESS=true
    echo ""
    echo "Shutting down services..."
    stop_services
    cleanup_startup_channel || true
    if [ "$STOP_FAILED" -ne 0 ]; then
        echo "ERROR: Services required forced or failed termination" >&2
        exit 1
    fi
    echo "Services stopped gracefully"
    exit 0
}

trap shutdown SIGTERM SIGINT

# ============================================
# Database provider detection and immutable runtime selection
# ============================================

echo ""
echo "Detecting database type..."
cd /app/api

# Default DATABASE_URL to SQLite if not set or empty
# This handles cases where Unraid template sets DATABASE_URL="" which overrides Dockerfile default
if [ -z "$DATABASE_URL" ]; then
    export DATABASE_URL="file:/config/prod.db"
    echo "  - DATABASE_URL not set, selecting the default SQLite database"
fi

# Never infer SQLite from an unsupported connection scheme.
case "$DATABASE_URL" in
    postgres://*|postgresql://*) DB_PROVIDER="postgresql" ;;
    file:*) DB_PROVIDER="sqlite" ;;
    *) echo "ERROR: Unsupported database provider; services were not started" >&2; exit 1 ;;
esac
echo "  - Detected database provider: $DB_PROVIDER"

# The provider is an allowlisted value, never an operator-supplied code path.
# Validate matching schema, compiled client, assets and manifest before any DB
# actor or service starts. No generation, patching or code ownership change.
API_RUNTIME_DIR="/app/api/providers/$DB_PROVIDER"
readonly API_RUNTIME_DIR
echo "  - Verifying packaged Prisma runtime for $DB_PROVIDER..."
if ! run_as_user node /app/api/validate-provider-runtime.cjs "$API_RUNTIME_DIR" "$DB_PROVIDER"; then
    echo "ERROR: Provider runtime validation failed; services were not started" >&2
    exit 1
fi

# ============================================
# Prepare a private boot-scoped coordination channel (no database I/O)
# ============================================

echo ""
echo "Preparing API-owned native startup..."
if ! STARTUP_CONTEXT=$(run_as_user node "$API_RUNTIME_DIR/dist/combined-startup.js" prepare); then
    startup_failure
fi
STARTUP_TAB=$(printf '\t')
IFS="$STARTUP_TAB" read -r ARR_COMBINED_STARTUP_DIR ARR_COMBINED_STARTUP_NONCE ARR_COMBINED_STARTUP_DEVICE ARR_COMBINED_STARTUP_INODE STARTUP_EXTRA <<EOF
$STARTUP_CONTEXT
EOF
if [ -n "$STARTUP_EXTRA" ] || [ -z "$ARR_COMBINED_STARTUP_DIR" ] || [ -z "$ARR_COMBINED_STARTUP_NONCE" ] || [ -z "$ARR_COMBINED_STARTUP_DEVICE" ] || [ -z "$ARR_COMBINED_STARTUP_INODE" ]; then
    startup_failure
fi
export ARR_COMBINED_STARTUP_DIR ARR_COMBINED_STARTUP_NONCE ARR_COMBINED_STARTUP_DEVICE ARR_COMBINED_STARTUP_INODE
STARTUP_CHANNEL_PREPARED=true

# ============================================
# Start API server (as abc user)
# ============================================

echo ""
echo "Starting API bootstrap (native validation and listen precede web startup)..."
cd /app/api

# Heap diagnostics (issue #427 follow-up).
#
# CWD = /config/heap-snapshots so V8's --heapsnapshot-signal writes land on
# the persisted volume instead of the ephemeral /app/api inside the image.
# Using the fixed provider package's absolute index.js lets us change CWD without
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
export MALLOC_ARENA_MAX
echo "  - MALLOC_ARENA_MAX: $MALLOC_ARENA_MAX (glibc arena cap — keeps RSS in check on long-running containers)"

# Let stdout/stderr flow directly to the container — Pino handles file logging
# via its pino-roll transport (writes to /config/logs/arr-dashboard.log).
# Previous approach redirected stdout to api.log, which conflicted with Pino's
# worker-thread transport and caused both log files to remain empty.
#
# API service: the selected package's dist/launcher.js (stable top-level process).
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
    sh -c 'cd /config/heap-snapshots && exec node "$1/dist/launcher.js"' sh "$API_RUNTIME_DIR" &
else
    su-exec abc sh -c 'cd /config/heap-snapshots && exec node "$1/dist/launcher.js"' sh "$API_RUNTIME_DIR" &
fi
API_PID=$!
echo "API started with PID $API_PID"

# Bind the tracked process's birth identity. Short reads keep shell traps live;
# the shared parser enforces a600-second monotonic deadline from preparation.
if ! run_as_user node "$API_RUNTIME_DIR/dist/combined-startup.js" bind "$API_PID" "$$"; then
    startup_failure
fi
while :; do
    if ! process_is_alive "$API_PID"; then startup_failure; fi
    if STARTUP_SETTINGS=$(run_as_user node "$API_RUNTIME_DIR/dist/combined-startup.js" read); then
        break
    else
        STARTUP_STATUS=$?
        if [ "$STARTUP_STATUS" -ne 2 ]; then startup_failure; fi
    fi
    sleep 1
done
IFS="$STARTUP_TAB" read -r API_PORT PORT HOST STARTUP_EXTRA <<EOF
$STARTUP_SETTINGS
EOF
if [ -n "$STARTUP_EXTRA" ] || [ -z "$API_PORT" ] || [ -z "$PORT" ] || [ -z "$HOST" ]; then startup_failure; fi
export API_PORT PORT HOST
if ! process_is_alive "$API_PID"; then startup_failure; fi
if ! run_as_user node "$API_RUNTIME_DIR/dist/combined-startup.js" consume; then startup_failure; fi
STARTUP_CHANNEL_PREPARED=false
echo "  - Listen Address: $HOST"
echo "  - API Port: $API_PORT"
echo "  - Web Port: $PORT"
if ! run_as_user node /app/runtime-health.cjs publish "$PORT"; then startup_failure; fi
if ! process_is_alive "$API_PID"; then startup_failure; fi

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
    sh -c "API_HOST=http://localhost:$API_PORT PORT=$PORT HOSTNAME=$HOST HOST=$HOST exec node server.js" &
else
    su-exec abc sh -c "API_HOST=http://localhost:$API_PORT PORT=$PORT HOSTNAME=$HOST HOST=$HOST exec node server.js" &
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
