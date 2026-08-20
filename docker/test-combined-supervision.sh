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
# sibling) use a shim harness that replaces only the service binaries — never
# the supervisor — so the same start.sh supervision logic is exercised.
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

# Ports must not collide with anything else on the host; pick high unique ports.
HOST_WEB_PORT=33080
HOST_API_PORT=33081
for i in 1 2 3 4 5 6 7 8 9 10; do
    if ! (curl -s -o /dev/null --max-time 1 "http://localhost:$HOST_WEB_PORT" 2>/dev/null) && \
       ! (curl -s -o /dev/null --max-time 1 "http://localhost:$HOST_API_PORT" 2>/dev/null); then
        break
    fi
    HOST_WEB_PORT=$((HOST_WEB_PORT + 2))
    HOST_API_PORT=$((HOST_API_PORT + 2))
done

PASS=0
FAIL=0
CURRENT_CASE=""

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

cleanup() {
    for c in "$API_CTR" "$WEB_CTR" "$STOP_CTR" "$SHIM_CTR" "$STARTUP_CTR"; do
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

run_base_args() {
    # $1 = container name; remaining args passed to docker run
    ctr_name=$1
    shift
    if [ "$ROOTLESS" = true ]; then
        docker run -d --name "$ctr_name" --user 1000:1000 \
            -v "$CONFIG_DIR":/config \
            "$@"
    else
        docker run -d --name "$ctr_name" \
            -v "$CONFIG_DIR":/config \
            -e PUID=1000 -e PGID=1000 \
            "$@"
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
        a=$(curl -sf "http://localhost:$api_port/health" 2>/dev/null || echo '')
        w=$(curl -sf "http://localhost:$web_port/health" 2>/dev/null || echo '')
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
    inner_count=$(proc_count_cmdline "$ctr" "/app/api/dist/index.js")
    if [ "$inner_count" = "1" ]; then
        ok "launcher has exactly one inner index.js child"
    else
        bad "launcher has $inner_count inner index.js children (expected 1)"
    fi
}

# ---------------------------------------------------------------------------
# Shim harness for edge cases (service binaries only — supervisor is real)
# ---------------------------------------------------------------------------

mkdir -p "$SHIM_DIR"

cat > "$SHIM_DIR/launcher.js" <<'EOF'
import fs from "node:fs";
const isApi = String(process.argv[1] || "").includes("launcher");
const ctrl = isApi ? "/config/.shim-api-control" : "/config/.shim-web-control";
const name = isApi ? "API" : "WEB";
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

cat > "$SHIM_DIR/server.js" <<'EOF'
import fs from "node:fs";
const ctrl = "/config/.shim-web-control";
const name = "WEB";
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

# Remove all shim control files from the host config dir before each new
# container, so a previous case's mode (exit0/exit3/ignore-term/etc.) can
# never leak into a later case. The files may be owned by the container's
# remapped user (uid 1000); tolerate permission errors because start.sh
# re-chowns /config on the next container start.
reset_shim_fixture() {
    rm -f "$CONFIG_DIR/.shim-api-control" "$CONFIG_DIR/.shim-web-control" 2>/dev/null || true
}

start_shim_container() {
    reset_shim_fixture
    docker rm -f "$SHIM_CTR" >/dev/null 2>&1 || true
    if [ "$ROOTLESS" = true ]; then
        docker run -d --name "$SHIM_CTR" --user 1000:1000 \
            -v "$CONFIG_DIR":/config \
            -v "$SHIM_DIR/launcher.js":/app/api/dist/launcher.js \
            -v "$SHIM_DIR/server.js":/app/web/server.js \
            "$IMAGE" >/dev/null
    else
        docker run -d --name "$SHIM_CTR" \
            -v "$CONFIG_DIR":/config \
            -e PUID=1000 -e PGID=1000 \
            -v "$SHIM_DIR/launcher.js":/app/api/dist/launcher.js \
            -v "$SHIM_DIR/server.js":/app/web/server.js \
            "$IMAGE" >/dev/null
    fi
}

set_shim_mode() {
    # $1 = API|WEB, $2 = mode
    file=/config/.shim-api-control
    [ "$1" = "WEB" ] && file=/config/.shim-web-control
    docker exec "$SHIM_CTR" sh -c "printf '%s' '$2' > $file"
}

wait_shim_started() {
    # wait until both shims report started and the ready banner appeared
    timeout=${1:-60}
    elapsed=0
    while [ "$elapsed" -lt "$timeout" ]; do
        n=$(docker logs "$SHIM_CTR" 2>&1 | grep -c "\[shim:" || true)
        if [ "$n" -ge 2 ]; then
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

    run_base_args "$API_CTR" \
        -p "$HOST_WEB_PORT":3000 -p "$HOST_API_PORT":3001 \
        "$IMAGE" >/dev/null

    if ! wait_health "$API_CTR" "$HOST_API_PORT" "$HOST_WEB_PORT"; then
        bad "services did not become healthy"
        docker logs "$API_CTR" 2>&1 | tail -30 >&2
        return 1
    fi

    assert_process_tree "$API_CTR"

    if ! kill_tracked "$API_CTR" "API"; then
        bad "could not find tracked API PID in logs"
        return 1
    fi
    log "killed tracked API process; expecting container to exit non-zero"

    if ! wait_container_exit "$API_CTR" 30; then
        bad "container still running 30s after API death"
        docker logs "$API_CTR" 2>&1 | tail -20 >&2
        return 1
    fi
    ok "container exited promptly"
    if [ "$EXIT_CODE" -ne 0 ]; then
        ok "container exit code non-zero ($EXIT_CODE)"
    else
        bad "container exit code is 0 (expected non-zero)"
    fi

    logs=$(docker logs "$API_CTR" 2>&1 || true)
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
    docker rm -f "$API_CTR" >/dev/null 2>&1 || true
}

case_web_death() {
    CURRENT_CASE="web-death"
    log "Web top-level service exits unexpectedly (real image)"

    run_base_args "$WEB_CTR" \
        -p "$HOST_WEB_PORT":3000 -p "$HOST_API_PORT":3001 \
        "$IMAGE" >/dev/null

    if ! wait_health "$WEB_CTR" "$HOST_API_PORT" "$HOST_WEB_PORT"; then
        bad "services did not become healthy"
        docker logs "$WEB_CTR" 2>&1 | tail -30 >&2
        return 1
    fi

    assert_process_tree "$WEB_CTR"

    if ! kill_tracked "$WEB_CTR" "Web"; then
        bad "could not find tracked Web PID in logs"
        return 1
    fi
    log "killed tracked Web process; expecting container to exit non-zero"

    if ! wait_container_exit "$WEB_CTR" 30; then
        bad "container still running 30s after web death"
        docker logs "$WEB_CTR" 2>&1 | tail -20 >&2
        return 1
    fi
    ok "container exited promptly"
    if [ "$EXIT_CODE" -ne 0 ]; then
        ok "container exit code non-zero ($EXIT_CODE)"
    else
        bad "container exit code is 0 (expected non-zero)"
    fi

    logs=$(docker logs "$WEB_CTR" 2>&1 || true)
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
    docker rm -f "$WEB_CTR" >/dev/null 2>&1 || true
}

case_graceful_stop() {
    CURRENT_CASE="graceful-stop"
    log "Normal docker stop (SIGTERM) — expected graceful exit 0"

    run_base_args "$STOP_CTR" \
        -p "$HOST_WEB_PORT":3000 -p "$HOST_API_PORT":3001 \
        "$IMAGE" >/dev/null

    if ! wait_health "$STOP_CTR" "$HOST_API_PORT" "$HOST_WEB_PORT"; then
        bad "services did not become healthy"
        docker logs "$STOP_CTR" 2>&1 | tail -30 >&2
        return 1
    fi

    log "sending docker stop"
    docker stop --time 30 "$STOP_CTR" >/dev/null

    state=$(docker inspect "$STOP_CTR" --format '{{.State.Status}}' 2>/dev/null)
    code=$(docker inspect "$STOP_CTR" --format '{{.State.ExitCode}}' 2>/dev/null)
    if [ "$state" = "exited" ] && [ "$code" = "0" ]; then
        ok "container exited gracefully (status exited, code 0)"
    else
        bad "expected exited/0, got $state/$code"
    fi

    logs=$(docker logs "$STOP_CTR" 2>&1 || true)
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
    docker rm -f "$STOP_CTR" >/dev/null 2>&1 || true
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
    if docker logs "$SHIM_CTR" 2>&1 | grep -q "Terminating Web service"; then
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

    start_shim_container
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

    start_shim_container
    set_shim_mode API exit3
    set_shim_mode WEB idle

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

    logs=$(docker logs "$SHIM_CTR" 2>&1 || true)
    if echo "$logs" | grep -q "API process (PID.*died during startup"; then
        ok "startup failure was detected"
    else
        bad "missing startup-failure detection"
        echo "$logs" | tail -20 >&2
    fi
    docker rm -f "$SHIM_CTR" >/dev/null 2>&1 || true
}

case_startup_web_failure() {
    CURRENT_CASE="startup-web-failure"
    log "Web fails immediately after launch (shim harness)"

    start_shim_container
    set_shim_mode API idle
    set_shim_mode WEB exit3

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
    if echo "$logs" | grep -q "Terminating API service"; then
        ok "API sibling was terminated"
    else
        bad "API sibling was not terminated"
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
    if $fn; then
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