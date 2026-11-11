#!/bin/sh
# Combined-container process supervision tests.
#
# Verifies that the production combined image (tini -> start.sh -> API + web)
# terminates the container when either required top-level service exits, while
# preserving normal graceful stops and application-requested API restarts.
#
# This script runs against the ACTUAL built image and ACTUAL /app/start.sh.
# The mandatory api-death / web-death / graceful-stop cases use the real
# services. Edge cases (exit code 0, simultaneous exit, SIGTERM-resistant
# sibling) replace the API child and web server with shims while retaining
# the packaged launcher and start.sh.
#
# Usage:
#   docker/test-combined-supervision.sh [image] [--case NAME] [--rootless]
#
# image defaults to arr-dashboard:smoke. With no --case, every case runs.
# Exit status: 0 when all selected cases pass, 1 otherwise.

set -eu

IMAGE="${1:-arr-dashboard:smoke}"
CASE=""
ROOTLESS=false

while [ $# -gt 0 ]; do
    case "$1" in
        --case)
            CASE="$2"
            shift 2
            ;;
        --rootless)
            ROOTLESS=true
            shift
            ;;
        *)
            IMAGE="$1"
            shift
            ;;
    esac
done

SCRIPT_NAME=$(basename "$0")
WORK=/tmp/${SCRIPT_NAME%.sh}-$$
API_CTR="${WORK##*/}-api"
WEB_CTR="${WORK##*/}-web"
STOP_CTR="${WORK##*/}-stop"
SHIM_CTR="${WORK##*/}-shim"
STARTUP_CTR="${WORK##*/}-startup"
CONFIG_DIR="$WORK/config"
SHIM_DIR="$WORK/shim"
TOOLS_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

PASS=0
FAIL=0
CURRENT_CASE=""
REAL_FIXTURE_ID=""

log() {
    echo ""
    echo "=== [$CURRENT_CASE] $* ==="
}

ok() {
    echo "  PASS: $*"
    PASS=$((PASS + 1))
}

bad() {
    echo "  FAIL: $*" >&2
    FAIL=$((FAIL + 1))
}

remove_real_fixture() {
    [ -n "$REAL_FIXTURE_ID" ] || return 0
    docker rm -f "$REAL_FIXTURE_ID" >/dev/null || return 1
    REAL_FIXTURE_ID=""
}

cleanup() {
    remove_real_fixture 2>/dev/null || true
    for c in "$SHIM_CTR" "$STARTUP_CTR"; do
        docker rm -f "$c" >/dev/null 2>&1 || true
    done
    docker rm -f "${WORK##*/}-restart" >/dev/null 2>&1 || true
    rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$CONFIG_DIR"
if [ "$ROOTLESS" = true ]; then
    chown -R 1000:1000 "$CONFIG_DIR" 2>/dev/null || true
    chmod 700 "$CONFIG_DIR" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

fixture_port() {
    mapping=$(docker port "$1" "$2/tcp") || return 1
    printf '%s\n' "$mapping" | awk -F: '
        NF == 2 && $1 == "127.0.0.1" && $2 ~ /^[0-9]+$/ && $2 > 0 && $2 <= 65535 { port = $2 }
        END { if (NR != 1 || !port) exit 1; print port }
    '
}

start_real_fixture() {
    fixture_config="$WORK/$1-config"
    if ! mkdir -p "$fixture_config"; then
        bad "could not prepare the real-app fixture config"
        return 1
    fi

    # The real services exercise supervision without public maintenance work.
    set -- docker create --name "$1" -v "$fixture_config:/config" \
        -p 127.0.0.1::3000 -p 127.0.0.1::3001 \
        -e TRASH_UPDATE_SCHEDULER_ENABLED=false
    if [ "$ROOTLESS" = true ]; then
        chown 1000:1000 "$fixture_config" 2>/dev/null || true
        if ! chmod 700 "$fixture_config"; then
            bad "could not set real-app fixture config permissions"
            return 1
        fi
        set -- "$@" --user 1000:1000
    else
        set -- "$@" -e PUID=1000 -e PGID=1000
    fi

    # Retain the exact container ID even when starting or publishing fails.
    if ! REAL_FIXTURE_ID=$("$@" "$IMAGE"); then
        bad "Docker could not create the real-app fixture"
        return 1
    fi
    if ! docker start "$REAL_FIXTURE_ID" >/dev/null; then
        bad "Docker could not start the real-app fixture"
        return 1
    fi
    if ! HOST_API_PORT=$(fixture_port "$REAL_FIXTURE_ID" 3001) ||
        ! HOST_WEB_PORT=$(fixture_port "$REAL_FIXTURE_ID" 3000); then
        bad "could not resolve the real-app fixture loopback ports"
        return 1
    fi
}

wait_health() {
    # $1 = container, $2 = api port, $3 = web port, $4 = timeout (default 120)
    ctr=$1
    api_port=$2
    web_port=$3
    timeout=${4:-120}
    elapsed=0
    while [ "$elapsed" -lt "$timeout" ]; do
        if ! state=$(docker inspect --format '{{.State.Status}}' "$ctr") ||
            [ "$state" != running ]; then
            return 1
        fi
        a=$(curl -sf "http://127.0.0.1:$api_port/health" 2>/dev/null || echo '')
        w=$(curl -sf "http://127.0.0.1:$web_port/health" 2>/dev/null || echo '')
        if [ -n "$a" ] && [ -n "$w" ]; then
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    return 1
}

get_tracked_pid() {
    # $1 = container, $2 = "API" or "Web" (anchored so the two lines never collide)
    docker logs "$1" 2>&1 | sed -n "s/.*$2 started with PID \([0-9][0-9]*\).*/\1/p" | tail -1
}

wait_container_exit() {
    # $1 = container, $2 = timeout seconds. Returns 0 if exited; sets EXIT_CODE.
    ctr=$1
    timeout=$2
    elapsed=0
    while [ "$elapsed" -lt "$timeout" ]; do
        state=$(docker inspect "$ctr" --format '{{.State.Status}}' 2>/dev/null || echo "missing")
        if [ "$state" != "running" ]; then
            EXIT_CODE=$(docker inspect "$ctr" --format '{{.State.ExitCode}}' 2>/dev/null || echo 999)
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    EXIT_CODE=999
    return 1
}

# Kill a tracked process inside a container (read PID from start.sh logs).
kill_tracked() {
    # $1 = container, $2 = "API" or "Web"
    pid=$(get_tracked_pid "$1" "$2")
    if [ -z "$pid" ]; then
        return 1
    fi
    docker exec "$1" sh -c "kill -KILL $pid 2>/dev/null || true"
    return 0
}

# Read a process's cmdline (NUL-joined) from inside the container.
proc_cmdline() {
    # $1 = container, $2 = pid
    docker exec "$1" sh -c "tr '\0' ' ' < /proc/$2/cmdline 2>/dev/null || true"
}

# Read a process's parent PID from inside the container. /proc/<pid>/stat's
# comm field (field 2) is parenthesized and may contain spaces/parens, so split
# on the closing ")" and take the second field of the remainder (state, ppid).
proc_ppid() {
    # $1 = container, $2 = pid
    docker exec "$1" sh -c "awk -F') ' '{split(\$2,a,\" \"); print a[2]}' /proc/$2/stat 2>/dev/null || true"
}

# Read a process's comm (short name) from inside the container.
proc_comm() {
    # $1 = container, $2 = pid
    docker exec "$1" sh -c "cat /proc/$2/comm 2>/dev/null || true"
}

# Count node processes whose cmdline contains the given substring. Restricts
# to comm == "node" so the counting shell itself is never matched.
proc_count_cmdline() {
    # $1 = container, $2 = substring
    docker exec "$1" sh -c "n=0; for p in /proc/[0-9]*; do c=\$(cat \"\$p/comm\" 2>/dev/null); [ \"\$c\" = node ] || continue; cmd=\$(tr '\0' ' ' < \"\$p/cmdline\" 2>/dev/null); case \"\$cmd\" in *\"$2\"*) n=\$((n+1));; esac; done; echo \$n"
}

# Assert the tracked PIDs are the real node services (no sh/su-exec wrapper
# survives exec replacement), and that the launcher has exactly one inner
# index.js child. $1 = container.
assert_process_tree() {
    ctr=$1
    api_pid=$(get_tracked_pid "$ctr" "API")
    web_pid=$(get_tracked_pid "$ctr" "Web")

    # API_PID cmdline must identify the launcher.
    api_cmd=$(proc_cmdline "$ctr" "$api_pid")
    if echo "$api_cmd" | grep -q "launcher.js"; then
        ok "API_PID ($api_pid) cmdline identifies launcher.js"
    else
        bad "API_PID ($api_pid) cmdline is not launcher.js: '$api_cmd'"
    fi

    # WEB_PID cmdline must identify the web node server (Next.js sets
    # process.title, so comm is "next-server (v" and cmdline is rewritten).
    web_comm=$(proc_comm "$ctr" "$web_pid")
    if echo "$web_comm" | grep -q "next-server"; then
        ok "WEB_PID ($web_pid) comm identifies the web node server"
    else
        bad "WEB_PID ($web_pid) comm is not next-server: '$web_comm'"
    fi

    # Both tracked services must be direct children of start.sh (no wrapper).
    start_pid=$(docker exec "$ctr" sh -c 'for p in /proc/[0-9]*; do c=$(cat "$p/comm" 2>/dev/null); [ "$c" = "start.sh" ] && echo "${p##*/}"; done' | head -1)
    api_ppid=$(proc_ppid "$ctr" "$api_pid")
    web_ppid=$(proc_ppid "$ctr" "$web_pid")
    if [ "$api_ppid" = "$start_pid" ]; then
        ok "API launcher is a direct child of start.sh ($start_pid)"
    else
        bad "API launcher ppid ($api_ppid) != start.sh ($start_pid)"
    fi
    if [ "$web_ppid" = "$start_pid" ]; then
        ok "web server is a direct child of start.sh ($start_pid)"
    else
        bad "web server ppid ($web_ppid) != start.sh ($start_pid)"
    fi

    # The launcher must have exactly one inner index.js child.
    inner_count=$(proc_count_cmdline "$ctr" "/app/api/providers/sqlite/dist/index.js")
    if [ "$inner_count" = "1" ]; then
        ok "launcher has exactly one inner index.js child"
    else
        bad "launcher has $inner_count inner index.js children (expected 1)"
    fi
}

# ---------------------------------------------------------------------------
# Shim harness for edge cases
# ---------------------------------------------------------------------------

mkdir -p "$SHIM_DIR"

cat > "$SHIM_DIR/index.js" <<'EOF'
import fs from "node:fs";
const ctrl = "/tmp/arr-dashboard-shim-api-control";
const name = "API";
if (process.env.COMBINED_TEST_STARTUP_FAILURE === "api") {
  fs.writeSync(1, "[shim:API] exiting 3 before readiness\n");
  process.exit(3);
}
let mode = "idle";
function readCtrl() {
  try {
    const m = fs.readFileSync(ctrl, "utf8").trim();
    if (m) mode = m;
  } catch {}
}
readCtrl();
console.log(`[shim:${name}] started pid=${process.pid} mode=${mode}`);
setInterval(() => {
  const prev = mode;
  readCtrl();
  if (mode !== prev) console.log(`[shim:${name}] mode -> ${mode}`);
  if (mode === "exit0") { console.log(`[shim:${name}] exiting 0`); process.exit(0); }
  if (mode === "exit3") { console.log(`[shim:${name}] exiting 3`); process.exit(3); }
  if (mode === "exit42") { console.log(`[shim:${name}] exiting 42`); process.exit(42); }
  if (mode === "sigkill") { console.log(`[shim:${name}] self-SIGKILL`); process.kill(process.pid, "SIGKILL"); }
}, 200);
process.on("SIGTERM", () => {
  readCtrl();
  if (mode === "ignore-term") {
    console.log(`[shim:${name}] ignoring SIGTERM (stubborn)`);
    return;
  }
  fs.writeSync(1, `[shim:${name}] SIGTERM -> exit 0\n`);
  process.exit(0);
});
setInterval(() => {}, 1000);

// Exercise the launcher's authenticated readiness path with synthetic settings.
if (typeof process.send !== "function") throw new Error("API shim requires launcher IPC");
process.send({
  kind: "arr-combined-startup",
  version: 1,
  nonce: process.env.ARR_COMBINED_STARTUP_NONCE,
  apiPort: 3001,
  webPort: 3000,
  listenAddress: "0.0.0.0",
});
EOF

cat > "$SHIM_DIR/server.js" <<'EOF'
import fs from "node:fs";
const ctrl = "/tmp/arr-dashboard-shim-web-control";
const name = "WEB";
if (process.env.COMBINED_TEST_STARTUP_FAILURE === "web") {
  fs.writeSync(1, "[shim:WEB] exiting 3 during startup\n");
  process.exit(3);
}
let mode = "idle";
function readCtrl() {
  try {
    const m = fs.readFileSync(ctrl, "utf8").trim();
    if (m) mode = m;
  } catch {}
}
readCtrl();
console.log(`[shim:${name}] started pid=${process.pid} mode=${mode}`);
setInterval(() => {
  const prev = mode;
  readCtrl();
  if (mode !== prev) console.log(`[shim:${name}] mode -> ${mode}`);
  if (mode === "exit0") { console.log(`[shim:${name}] exiting 0`); process.exit(0); }
  if (mode === "exit3") { console.log(`[shim:${name}] exiting 3`); process.exit(3); }
  if (mode === "exit42") { console.log(`[shim:${name}] exiting 42`); process.exit(42); }
  if (mode === "sigkill") { console.log(`[shim:${name}] self-SIGKILL`); process.kill(process.pid, "SIGKILL"); }
}, 200);
process.on("SIGTERM", () => {
  readCtrl();
  if (mode === "ignore-term") {
    console.log(`[shim:${name}] ignoring SIGTERM (stubborn)`);
    return;
  }
  console.log(`[shim:${name}] SIGTERM -> exit 0`);
  process.exit(0);
});
setInterval(() => {}, 1000);
EOF

start_shim_container() {
    # Additional Docker options apply to this shim instance only.
    # Prepare once from the unmodified image; only this disposable shim's
    # API child hash changes. Schema/client/worker admission remains enforced.
    if [ ! -f "$SHIM_DIR/runtime-provider.json" ]; then
        docker run --rm --network none --user "$(id -u):$(id -g)" \
            -v "$TOOLS_DIR/test-provider-manifest.cjs":/fixture-tools/test-provider-manifest.cjs:ro \
            -v "$TOOLS_DIR/validate-provider-runtime.cjs":/fixture-tools/validate-provider-runtime.cjs:ro \
            -v "$SHIM_DIR":/fixture \
            "$IMAGE" node /fixture-tools/test-provider-manifest.cjs \
            /app/api/providers/sqlite sqlite /fixture/runtime-provider.json \
            dist/index.js /fixture/index.js
    fi
    docker rm -f "$SHIM_CTR" >/dev/null 2>&1 || true
    if [ "$ROOTLESS" = true ]; then
        docker run -d --name "$SHIM_CTR" --user 1000:1000 \
            -v "$CONFIG_DIR":/config \
            -v "$SHIM_DIR/index.js":/app/api/providers/sqlite/dist/index.js:ro \
            -v "$SHIM_DIR/runtime-provider.json":/app/api/providers/sqlite/runtime-provider.json:ro \
            -v "$SHIM_DIR/server.js":/app/web/server.js:ro \
            "$@" "$IMAGE" >/dev/null
    else
        docker run -d --name "$SHIM_CTR" \
            -v "$CONFIG_DIR":/config \
            -e PUID=1000 -e PGID=1000 \
            -v "$SHIM_DIR/index.js":/app/api/providers/sqlite/dist/index.js:ro \
            -v "$SHIM_DIR/runtime-provider.json":/app/api/providers/sqlite/runtime-provider.json:ro \
            -v "$SHIM_DIR/server.js":/app/web/server.js:ro \
            "$@" "$IMAGE" >/dev/null
    fi
}

set_shim_mode() {
    # $1 = API|WEB, $2 = mode
    file=/tmp/arr-dashboard-shim-api-control
    [ "$1" = "WEB" ] && file=/tmp/arr-dashboard-shim-web-control
    docker exec "$SHIM_CTR" sh -c "printf '%s' '$2' > $file"
}

wait_shim_started() {
    # The web shim can start only after the API readiness handoff is consumed.
    timeout=${1:-60}
    elapsed=0
    while [ "$elapsed" -lt "$timeout" ]; do
        if logs=$(docker logs "$SHIM_CTR" 2>&1) &&
            printf '%s\n' "$logs" | grep -q '^\[shim:API\] started pid=' &&
            printf '%s\n' "$logs" | grep -q '^\[shim:WEB\] started pid='; then
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    return 1
}

# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

case_api_death() {
    CURRENT_CASE="api-death"
    log "API top-level service exits unexpectedly (real image)"

    start_real_fixture "$API_CTR" || return 1

    if ! wait_health "$REAL_FIXTURE_ID" "$HOST_API_PORT" "$HOST_WEB_PORT"; then
        bad "services did not become healthy"
        docker logs "$REAL_FIXTURE_ID" 2>&1 | tail -30 >&2
        return 1
    fi

    assert_process_tree "$REAL_FIXTURE_ID"

    if ! kill_tracked "$REAL_FIXTURE_ID" "API"; then
        bad "could not find tracked API PID in logs"
        return 1
    fi
    log "killed tracked API process; expecting container to exit non-zero"

    if ! wait_container_exit "$REAL_FIXTURE_ID" 30; then
        bad "container still running 30s after API death"
        docker logs "$REAL_FIXTURE_ID" 2>&1 | tail -20 >&2
        return 1
    fi
    ok "container exited promptly"
    if [ "$EXIT_CODE" -ne 0 ]; then
        ok "container exit code non-zero ($EXIT_CODE)"
    else
        bad "container exit code is 0 (expected non-zero)"
    fi

    logs=$(docker logs "$REAL_FIXTURE_ID" 2>&1 || true)
    if echo "$logs" | grep -q "API service exited unexpectedly"; then
        ok "supervisor logged the fatal API exit"
    else
        bad "missing 'API service exited unexpectedly' in logs"
        echo "$logs" | tail -20 >&2
    fi
    if echo "$logs" | grep -q "Terminating Web service"; then
        ok "supervisor logged sibling termination"
    else
        bad "missing sibling-termination log line"
    fi
}

case_web_death() {
    CURRENT_CASE="web-death"
    log "Web top-level service exits unexpectedly (real image)"

    start_real_fixture "$WEB_CTR" || return 1

    if ! wait_health "$REAL_FIXTURE_ID" "$HOST_API_PORT" "$HOST_WEB_PORT"; then
        bad "services did not become healthy"
        docker logs "$REAL_FIXTURE_ID" 2>&1 | tail -30 >&2
        return 1
    fi

    assert_process_tree "$REAL_FIXTURE_ID"

    if ! kill_tracked "$REAL_FIXTURE_ID" "Web"; then
        bad "could not find tracked Web PID in logs"
        return 1
    fi
    log "killed tracked Web process; expecting container to exit non-zero"

    if ! wait_container_exit "$REAL_FIXTURE_ID" 30; then
        bad "container still running 30s after web death"
        docker logs "$REAL_FIXTURE_ID" 2>&1 | tail -20 >&2
        return 1
    fi
    ok "container exited promptly"
    if [ "$EXIT_CODE" -ne 0 ]; then
        ok "container exit code non-zero ($EXIT_CODE)"
    else
        bad "container exit code is 0 (expected non-zero)"
    fi

    logs=$(docker logs "$REAL_FIXTURE_ID" 2>&1 || true)
    if echo "$logs" | grep -q "Web service exited unexpectedly"; then
        ok "supervisor logged the fatal web exit"
    else
        bad "missing 'Web service exited unexpectedly' in logs"
        echo "$logs" | tail -20 >&2
    fi
    if echo "$logs" | grep -q "Terminating API service"; then
        ok "supervisor logged sibling termination"
    else
        bad "missing sibling-termination log line"
    fi
}

case_graceful_stop() {
    CURRENT_CASE="graceful-stop"
    log "Normal docker stop (SIGTERM) — expected graceful exit 0"

    start_real_fixture "$STOP_CTR" || return 1

    if ! wait_health "$REAL_FIXTURE_ID" "$HOST_API_PORT" "$HOST_WEB_PORT"; then
        bad "services did not become healthy"
        docker logs "$REAL_FIXTURE_ID" 2>&1 | tail -30 >&2
        return 1
    fi

    log "sending docker stop"
    if ! docker stop --time 120 "$REAL_FIXTURE_ID" >/dev/null; then
        bad "Docker could not stop the real-app fixture"
        docker logs "$REAL_FIXTURE_ID" 2>&1 | tail -20 >&2
        return 1
    fi

    state=$(docker inspect "$REAL_FIXTURE_ID" --format '{{.State.Status}}' 2>/dev/null)
    code=$(docker inspect "$REAL_FIXTURE_ID" --format '{{.State.ExitCode}}' 2>/dev/null)
    if [ "$state" = "exited" ] && [ "$code" = "0" ]; then
        ok "container exited gracefully (status exited, code 0)"
    else
        bad "expected exited/0, got $state/$code"
    fi

    logs=$(docker logs "$REAL_FIXTURE_ID" 2>&1 || true)
    if echo "$logs" | grep -q "exited unexpectedly"; then
        bad "graceful stop was reported as a crash"
    else
        ok "no fatal-child message on graceful stop"
    fi
    if echo "$logs" | grep -q "Services stopped gracefully"; then
        ok "graceful shutdown message present"
    else
        bad "missing 'Services stopped gracefully' message"
    fi
}

case_exit_zero() {
    CURRENT_CASE="exit-zero"
    log "Unexpected service exit code 0 (shim harness)"

    start_shim_container
    set_shim_mode API idle
    set_shim_mode WEB idle
    if ! wait_shim_started; then
        bad "shims did not start"
        docker logs "$SHIM_CTR" 2>&1 | tail -30 >&2
        return 1
    fi

    set_shim_mode API exit0
    log "API shim exiting 0; expecting container to exit non-zero"

    if ! wait_container_exit "$SHIM_CTR" 30; then
        bad "container still running after API exit 0"
        docker logs "$SHIM_CTR" 2>&1 | tail -20 >&2
        return 1
    fi
    ok "container exited promptly"
    if [ "$EXIT_CODE" -ne 0 ]; then
        ok "exit code 0 was treated as fatal (container exit $EXIT_CODE)"
    else
        bad "container exit code is 0 (unexpected-exit-0 must be fatal)"
    fi
    logs=$(docker logs "$SHIM_CTR" 2>&1 || true)
    if printf '%s\n' "$logs" | grep -Fxq 'ERROR: API service exited unexpectedly (status: 0).'; then
        ok "supervisor observed the launcher exit with code 0"
    else
        bad "missing unexpected API exit with code 0"
    fi
    if printf '%s\n' "$logs" | grep -q "Terminating Web service"; then
        ok "web sibling was terminated"
    else
        bad "web sibling was not terminated"
    fi
    docker rm -f "$SHIM_CTR" >/dev/null 2>&1 || true
}

case_simultaneous() {
    CURRENT_CASE="simultaneous"
    log "Near-simultaneous exit of both services (shim harness)"

    start_shim_container
    set_shim_mode API idle
    set_shim_mode WEB idle
    if ! wait_shim_started; then
        bad "shims did not start"
        docker logs "$SHIM_CTR" 2>&1 | tail -30 >&2
        return 1
    fi

    set_shim_mode API exit3
    set_shim_mode WEB exit3
    log "both shims exiting 3 simultaneously; expecting no hang, exit non-zero"

    if ! wait_container_exit "$SHIM_CTR" 30; then
        bad "container hung after simultaneous exit"
        docker logs "$SHIM_CTR" 2>&1 | tail -20 >&2
        return 1
    fi
    ok "container exited (no hang)"
    if [ "$EXIT_CODE" -ne 0 ]; then
        ok "container exit code non-zero ($EXIT_CODE)"
    else
        bad "container exit code is 0"
    fi
    docker rm -f "$SHIM_CTR" >/dev/null 2>&1 || true
}

case_stubborn() {
    CURRENT_CASE="stubborn"
    log "SIGTERM-resistant web sibling escalates to SIGKILL (shim harness)"

    start_shim_container -e SHUTDOWN_GRACE=3
    set_shim_mode API idle
    set_shim_mode WEB ignore-term
    if ! wait_shim_started; then
        bad "shims did not start"
        docker logs "$SHIM_CTR" 2>&1 | tail -30 >&2
        return 1
    fi

    # Kill the API; web ignores SIGTERM and must be SIGKILLed after grace.
    kill_tracked "$SHIM_CTR" "API" || true
    log "killed API; web ignores SIGTERM — expecting SIGKILL escalation and exit"

    if ! wait_container_exit "$SHIM_CTR" 60; then
        bad "container hung after API death with stubborn web"
        docker logs "$SHIM_CTR" 2>&1 | tail -20 >&2
        return 1
    fi
    ok "container exited within bounded grace"
    if [ "$EXIT_CODE" -ne 0 ]; then
        ok "container exit code non-zero ($EXIT_CODE)"
    else
        bad "container exit code is 0"
    fi
    logs=$(docker logs "$SHIM_CTR" 2>&1 || true)
    if echo "$logs" | grep -q "sending SIGKILL"; then
        ok "supervisor escalated to SIGKILL"
    else
        bad "missing SIGKILL escalation in logs"
        echo "$logs" | tail -20 >&2
    fi
    if echo "$logs" | grep -q "ignoring SIGTERM"; then
        ok "web shim confirmed it ignored SIGTERM"
    else
        bad "web shim did not report ignoring SIGTERM"
    fi
    docker rm -f "$SHIM_CTR" >/dev/null 2>&1 || true
}

case_startup_api_failure() {
    CURRENT_CASE="startup-api-failure"
    log "API fails during initial startup (shim harness, exits before readiness)"

    start_shim_container -e COMBINED_TEST_STARTUP_FAILURE=api

    if wait_container_exit "$SHIM_CTR" 40; then
        if [ "$EXIT_CODE" -ne 0 ]; then
            ok "container exited non-zero ($EXIT_CODE)"
        else
            bad "container exit code is 0"
        fi
    else
        bad "container still running after API startup failure"
        docker logs "$SHIM_CTR" 2>&1 | tail -20 >&2
        return 1
    fi

    if ! logs=$(docker logs "$SHIM_CTR" 2>&1); then
        bad "could not read API startup failure logs"
        return 1
    fi
    if printf '%s\n' "$logs" | grep -Fxq '[shim:API] exiting 3 before readiness' &&
        printf '%s\n' "$logs" | grep -Fxq 'ERROR: API startup handoff did not complete; web was not started'; then
        ok "startup failure was detected"
    else
        bad "missing startup-failure detection"
        echo "$logs" | tail -20 >&2
    fi
    if printf '%s\n' "$logs" | grep -Eq '^Web started with PID |^\[shim:WEB\]'; then
        bad "web started despite failed API startup"
    else
        ok "web did not start after failed API startup"
    fi
    docker rm -f "$SHIM_CTR" >/dev/null 2>&1 || true
}

case_startup_web_failure() {
    CURRENT_CASE="startup-web-failure"
    log "Web fails immediately after launch (shim harness)"

    start_shim_container -e COMBINED_TEST_STARTUP_FAILURE=web

    if wait_container_exit "$SHIM_CTR" 40; then
        if [ "$EXIT_CODE" -ne 0 ]; then
            ok "container exited non-zero ($EXIT_CODE)"
        else
            bad "container exit code is 0"
        fi
    else
        bad "container still running after web startup failure"
        docker logs "$SHIM_CTR" 2>&1 | tail -20 >&2
        return 1
    fi

    logs=$(docker logs "$SHIM_CTR" 2>&1 || true)
    if printf '%s\n' "$logs" | grep -Fxq '[shim:WEB] exiting 3 during startup' &&
        printf '%s\n' "$logs" | grep -Fxq 'ERROR: Web service exited unexpectedly (status: 3).'; then
        ok "supervisor detected the web startup exit"
    else
        bad "missing web startup failure detection"
    fi
    if printf '%s\n' "$logs" | grep -q "Terminating API service" &&
        printf '%s\n' "$logs" | grep -Fxq '[shim:API] SIGTERM -> exit 0'; then
        ok "launcher forwarded SIGTERM to the API child"
    else
        bad "missing API child termination after web startup failure"
    fi
    docker rm -f "$SHIM_CTR" >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

run_case() {
    name=$1
    fn=$2
    if [ -n "$CASE" ] && [ "$CASE" != "$name" ]; then
        return
    fi
    echo ""
    echo "########## CASE: $name ##########"
    before=$FAIL
    result=PASS
    "$fn" || result=FAIL
    if [ -n "$REAL_FIXTURE_ID" ]; then
        if ! remove_real_fixture; then
            bad "could not remove the real-app fixture before the next case"
            exit 1
        fi
        [ "$FAIL" -eq "$before" ] || result=FAIL
    fi
    if [ "$result" = PASS ]; then
        echo "########## CASE $name: PASS ##########"
    else
        echo "########## CASE $name: FAIL ##########" >&2
    fi
}

run_case api-death case_api_death
run_case web-death case_web_death
run_case graceful-stop case_graceful_stop
run_case exit-zero case_exit_zero
run_case simultaneous case_simultaneous
run_case stubborn case_stubborn
run_case startup-api-failure case_startup_api_failure
run_case startup-web-failure case_startup_web_failure

echo ""
echo "=========================================="
echo "Supervision test results: PASS=$PASS FAIL=$FAIL"
echo "=========================================="
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
