#!/bin/sh
# Stop-timeout and process-state timing tests.
#
# Proves the internal SHUTDOWN_GRACE default leaves margin below Docker's
# 10-second Linux stop timeout, and that unexpected service death is detected
# promptly (not via the full grace + SIGKILL path).
#
# Cases:
#   red-collision   SHUTDOWN_GRACE=10 + stubborn child + docker stop --time 10
#                   -> demonstrates the internal deadline collides with Docker's
#   green-stubborn  default grace + stubborn child + docker stop --time 10
#                   -> internal SIGKILL, exit 0, elapsed <= 9s (5 runs)
#   default-normal  default grace + normal children + docker stop (rootful/rootless)
#   docker-restart  default grace + stubborn child + docker restart --time 10
#   prompt-exit     api/web death detection timing (rootful/rootless)
#
# Usage: docker/test-stop-timing.sh [image] [--case NAME]

set -eu

IMAGE="${1:-arr-dashboard:smoke}"
CASE=""
QUICK=false
if [ "${2:-}" = "--case" ]; then
    CASE="$3"
fi
if [ "${2:-}" = "--quick" ] || [ "${4:-}" = "--quick" ]; then
    QUICK=true
fi

WORK=/tmp/test-stop-timing-$$
CONFIG_DIR="$WORK/config"
SHIM_DIR="$WORK/shim"

PASS=0
FAIL=0

cleanup() {
    for c in "${WORK##*/}-"*; do
        docker rm -f "$c" >/dev/null 2>&1 || true
    done
    rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$CONFIG_DIR" "$SHIM_DIR"

ok() { echo "  PASS: $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $*" >&2; FAIL=$((FAIL + 1)); }

HOST_API_PORT=33140
HOST_WEB_PORT=33141

# Stubborn web shim (ignores SIGTERM).
cat > "$SHIM_DIR/server.js" <<'EOF'
console.log("[stubborn-web] started, ignoring SIGTERM");
process.on("SIGTERM", () => { console.log("[stubborn-web] ignoring SIGTERM"); });
setInterval(() => {}, 1000);
EOF

wait_api_health() {
    ctr=$1
    timeout=${2:-120}
    elapsed=0
    while [ "$elapsed" -lt "$timeout" ]; do
        a=$(curl -sf "http://localhost:$HOST_API_PORT/health" 2>/dev/null || echo '')
        [ -n "$a" ] && return 0
        sleep 1
        elapsed=$((elapsed + 1))
    done
    return 1
}

wait_health() {
    ctr=$1
    timeout=${2:-120}
    elapsed=0
    while [ "$elapsed" -lt "$timeout" ]; do
        a=$(curl -sf "http://localhost:$HOST_API_PORT/health" 2>/dev/null || echo '')
        w=$(curl -sf "http://localhost:$HOST_WEB_PORT/health" 2>/dev/null || echo '')
        if [ -n "$a" ] && [ -n "$w" ]; then
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    return 1
}

# Run a stubborn-child container. $1=name, $2=extra env (e.g. SHUTDOWN_GRACE=10), $3=rootless flag
start_stubborn() {
    name=$1
    extra_env=$2
    rootless=$3
    docker rm -f "$name" >/dev/null 2>&1 || true
    if [ "$rootless" = "rootless" ]; then
        chown -R 1000:1000 "$CONFIG_DIR" 2>/dev/null || true
        chmod 700 "$CONFIG_DIR" 2>/dev/null || true
        docker run -d --name "$name" --user 1000:1000 \
            -v "$CONFIG_DIR":/config \
            -v "$SHIM_DIR/server.js":/app/web/server.js:ro \
            $extra_env \
            -p "$HOST_API_PORT":3001 -p "$HOST_WEB_PORT":3000 \
            "$IMAGE" >/dev/null
    else
        docker run -d --name "$name" \
            -v "$CONFIG_DIR":/config \
            -e PUID=1000 -e PGID=1000 \
            -v "$SHIM_DIR/server.js":/app/web/server.js:ro \
            $extra_env \
            -p "$HOST_API_PORT":3001 -p "$HOST_WEB_PORT":3000 \
            "$IMAGE" >/dev/null
    fi
}

# Wait for the stubborn shim to register its SIGTERM handler.
wait_stubborn_ready() {
    ctr=$1
    elapsed=0
    while [ "$elapsed" -lt 60 ]; do
        if docker logs "$ctr" 2>&1 | grep -q "stubborn-web.*started"; then
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    return 1
}

# ---------------------------------------------------------------------------
# RED: SHUTDOWN_GRACE=10 collides with docker stop --time 10
# ---------------------------------------------------------------------------
case_red_collision() {
    echo ""
    echo "=== [red-collision] SHUTDOWN_GRACE=10 vs docker stop --time 10 ==="
    ctr="${WORK##*/}-red"
    start_stubborn "$ctr" "-e SHUTDOWN_GRACE=10" rootful
    wait_api_health "$ctr" 60 || bad "API did not become healthy"
    wait_stubborn_ready "$ctr" || bad "stubborn shim not ready"
    start=$(date +%s)
    docker stop --time 10 "$ctr" >/dev/null 2>&1 || true
    end=$(date +%s)
    elapsed=$((end - start))
    code=$(docker inspect "$ctr" --format '{{.State.ExitCode}}' 2>/dev/null || echo '?')
    logs=$(docker logs "$ctr" 2>&1 || true)
    echo "  elapsed=${elapsed}s exit=$code"
    echo "  internal SIGKILL logged: $(echo "$logs" | grep -c 'sending SIGKILL' || true)"
    echo "  graceful completion logged: $(echo "$logs" | grep -c 'Services stopped gracefully' || true)"
    # With grace=10 and docker timeout=10, the internal deadline collides with
    # Docker's; the container may be force-killed before start.sh finishes.
    if [ "$elapsed" -ge 9 ]; then
        ok "demonstrated collision: elapsed ${elapsed}s (no margin below 10s)"
    else
        bad "unexpectedly fast (${elapsed}s) — collision not demonstrated"
    fi
    docker rm -f "$ctr" >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# GREEN: default grace + stubborn child + docker stop --time 10 (5 runs)
# ---------------------------------------------------------------------------
run_green_stubborn_once() {
    ctr=$1
    rootless=$2
    start_stubborn "$ctr" "" "$rootless"
    wait_api_health "$ctr" 60 || { echo "  (API not healthy)"; return 1; }
    wait_stubborn_ready "$ctr" || { echo "  (shim not ready)"; return 1; }
    start=$(date +%s)
    docker stop --time 10 "$ctr" >/dev/null 2>&1 || true
    end=$(date +%s)
    elapsed=$((end - start))
    code=$(docker inspect "$ctr" --format '{{.State.ExitCode}}' 2>/dev/null || echo '?')
    oom=$(docker inspect "$ctr" --format '{{.State.OOMKilled}}' 2>/dev/null || echo '?')
    state=$(docker inspect "$ctr" --format '{{.State.Status}}' 2>/dev/null || echo '?')
    logs=$(docker logs "$ctr" 2>&1 || true)
    sigkill=$(echo "$logs" | grep -c 'sending SIGKILL' || true)
    graceful=$(echo "$logs" | grep -c 'Services stopped gracefully' || true)
    echo "  run: elapsed=${elapsed}s exit=$code oom=$oom state=$state internal_sigkill=$sigkill graceful=$graceful"
    docker rm -f "$ctr" >/dev/null 2>&1 || true
    # Structured result: elapsed|exit|oom|sigkill|graceful|state
    echo "${elapsed}|${code}|${oom}|${sigkill}|${graceful}|${state}"
}

case_green_stubborn() {
    echo ""
    echo "=== [green-stubborn] default grace + stubborn child + docker stop --time 10 (5 runs) ==="
    for mode in rootful rootless; do
        echo "  --- $mode ---"
        total=0
        min=999
        max=0
        allpass=1
        runs=5
        if [ "$QUICK" = true ]; then
            runs=1
        fi
        i=1
        while [ "$i" -le "$runs" ]; do
            ctr="${WORK##*/}-green-${mode}-${i}"
            raw=$(run_green_stubborn_once "$ctr" "$mode")
            result=$(echo "$raw" | tail -1)
            case "$result" in
                ''|*[!0-9|]*) allpass=0; i=$((i+1)); continue ;;
            esac
            e=$(echo "$result" | cut -d'|' -f1)
            rc=$(echo "$result" | cut -d'|' -f2)
            ok_=$(echo "$result" | cut -d'|' -f3)
            sk=$(echo "$result" | cut -d'|' -f4)
            gc=$(echo "$result" | cut -d'|' -f5)
            st=$(echo "$result" | cut -d'|' -f6)
            # Assert every field, not just elapsed.
            if [ "$e" -gt 9 ]; then
                echo "  run $i FAIL: elapsed ${e}s > 9s"; allpass=0
            fi
            if [ "$rc" != "0" ]; then
                echo "  run $i FAIL: exit code $rc (expected 0)"; allpass=0
            fi
            if [ "$ok_" != "false" ]; then
                echo "  run $i FAIL: OOMKilled=$ok_ (expected false)"; allpass=0
            fi
            if [ "$sk" -lt 1 ]; then
                echo "  run $i FAIL: no internal SIGKILL log"; allpass=0
            fi
            if [ "$gc" -lt 1 ]; then
                echo "  run $i FAIL: no graceful-completion log"; allpass=0
            fi
            if [ "$st" != "exited" ]; then
                echo "  run $i FAIL: state $st (expected exited)"; allpass=0
            fi
            total=$((total + e))
            [ "$e" -lt "$min" ] && min=$e
            [ "$e" -gt "$max" ] && max=$e
            i=$((i+1))
        done
        avg=$((total / runs))
        echo "  $mode: min=${min}s max=${max}s avg=${avg}s (runs=$runs)"
        if [ "$allpass" = "1" ] && [ "$max" -le 9 ]; then
            ok "$mode stubborn stop: all fields pass (max ${max}s)"
        else
            bad "$mode stubborn stop: one or more assertions failed (max ${max}s)"
        fi
    done
}

# ---------------------------------------------------------------------------
# Default normal stop (rootful + rootless)
# ---------------------------------------------------------------------------
case_default_normal() {
    echo ""
    echo "=== [default-normal] default grace + normal children + docker stop ==="
    for mode in rootful rootless; do
        ctr="${WORK##*/}-normal-${mode}"
        docker rm -f "$ctr" >/dev/null 2>&1 || true
        if [ "$mode" = "rootless" ]; then
            chown -R 1000:1000 "$CONFIG_DIR" 2>/dev/null || true
            chmod 700 "$CONFIG_DIR" 2>/dev/null || true
            docker run -d --name "$ctr" --user 1000:1000 \
                -v "$CONFIG_DIR":/config \
                -p "$HOST_API_PORT":3001 -p "$HOST_WEB_PORT":3000 \
                "$IMAGE" >/dev/null
        else
            docker run -d --name "$ctr" \
                -v "$CONFIG_DIR":/config -e PUID=1000 -e PGID=1000 \
                -p "$HOST_API_PORT":3001 -p "$HOST_WEB_PORT":3000 \
                "$IMAGE" >/dev/null
        fi
        wait_health "$ctr" 60 || bad "$mode services not healthy"
        start=$(date +%s)
        docker stop --time 10 "$ctr" >/dev/null 2>&1 || true
        end=$(date +%s)
        elapsed=$((end - start))
        code=$(docker inspect "$ctr" --format '{{.State.ExitCode}}' 2>/dev/null || echo '?')
        echo "  $mode: elapsed=${elapsed}s exit=$code"
        if [ "$code" = "0" ]; then
            ok "$mode normal stop exit 0 (${elapsed}s)"
        else
            bad "$mode normal stop exit $code"
        fi
        docker rm -f "$ctr" >/dev/null 2>&1 || true
    done
}

# ---------------------------------------------------------------------------
# docker restart with stubborn child
# ---------------------------------------------------------------------------
case_docker_restart() {
    echo ""
    echo "=== [docker-restart] default grace + stubborn child + docker restart --time 10 ==="
    ctr="${WORK##*/}-restart"
    start_stubborn "$ctr" "" rootful
    wait_api_health "$ctr" 60 || bad "API not healthy before restart"
    wait_stubborn_ready "$ctr" || bad "shim not ready"
    start=$(date +%s)
    docker restart --time 10 "$ctr" >/dev/null 2>&1 || true
    end=$(date +%s)
    restart_elapsed=$((end - start))
    echo "  restart elapsed=${restart_elapsed}s"
    # after restart, wait for API health (web is a stubborn shim with no /health)
    if wait_api_health "$ctr" 120; then
        ok "container restarted and API became healthy"
    else
        bad "API did not become healthy after restart"
    fi
    # the stop phase of restart must have used start.sh's internal SIGKILL
    logs=$(docker logs "$ctr" 2>&1 || true)
    if echo "$logs" | grep -q "sending SIGKILL"; then
        ok "start.sh performed internal SIGKILL during restart stop phase"
    else
        bad "no internal SIGKILL during restart stop phase"
    fi
    if [ "$restart_elapsed" -lt 10 ]; then
        ok "restart completed within Docker's 10s window (${restart_elapsed}s)"
    else
        bad "restart took ${restart_elapsed}s (>=10s)"
    fi
    docker rm -f "$ctr" >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# Prompt exit detection (api/web death) — rootful + rootless
# ---------------------------------------------------------------------------
prompt_exit_once() {
    ctr=$1
    service=$2
    rootless=$3
    rm -f "$CONFIG_DIR/.launcher-ctl" "$CONFIG_DIR/.mock-pid" \
          "$CONFIG_DIR/.shim-api-control" "$CONFIG_DIR/.shim-web-control" 2>/dev/null || true
    docker rm -f "$ctr" >/dev/null 2>&1 || true
    if [ "$rootless" = "rootless" ]; then
        chown -R 1000:1000 "$CONFIG_DIR" 2>/dev/null || true
        chmod 700 "$CONFIG_DIR" 2>/dev/null || true
        docker run -d --name "$ctr" --user 1000:1000 \
            -v "$CONFIG_DIR":/config \
            -p "$HOST_API_PORT":3001 -p "$HOST_WEB_PORT":3000 \
            "$IMAGE" >/dev/null
    else
        docker run -d --name "$ctr" \
            -v "$CONFIG_DIR":/config -e PUID=1000 -e PGID=1000 \
            -p "$HOST_API_PORT":3001 -p "$HOST_WEB_PORT":3000 \
            "$IMAGE" >/dev/null
    fi
    wait_health "$ctr" 60 || { echo "  (not healthy)"; return 1; }
    pid=$(docker logs "$ctr" 2>&1 | sed -n "s/.*$service started with PID \([0-9][0-9]*\).*/\1/p" | tail -1)
    [ -n "$pid" ] || { echo "  (no tracked pid)"; return 1; }
    start=$(date +%s)
    docker exec "$ctr" sh -c "kill -KILL $pid 2>/dev/null || true"
    # wait for container exit
    pe_elapsed=0
    while [ "$pe_elapsed" -lt 30 ]; do
        state=$(docker inspect "$ctr" --format '{{.State.Status}}' 2>/dev/null || echo missing)
        [ "$state" != "running" ] && break
        sleep 1
        pe_elapsed=$((pe_elapsed + 1))
    done
    end=$(date +%s)
    wall=$((end - start))
    code=$(docker inspect "$ctr" --format '{{.State.ExitCode}}' 2>/dev/null || echo '?')
    oom=$(docker inspect "$ctr" --format '{{.State.OOMKilled}}' 2>/dev/null || echo '?')
    logs=$(docker logs "$ctr" 2>&1 || true)
    fatal_log=$(echo "$logs" | grep -c "$service service exited unexpectedly" || true)
    term_log=$(echo "$logs" | grep -c "Terminating" || true)
    # Check no matching service process remains alive.
    case "$service" in
        API)   match="launcher.js" ;;
        Web)   match="server.js" ;;
    esac
    survivors=$(docker exec "$ctr" sh -c "for p in /proc/[0-9]*; do c=\$(tr '\0' ' ' < \"\$p/cmdline\" 2>/dev/null); case \"\$c\" in *\"$match\"*) echo found;; esac; done" 2>/dev/null | grep -c found || true)
    echo "  $rootless $service death: wall=${wall}s exit=$code oom=$oom fatal_log=$fatal_log term_log=$term_log survivors=$survivors"
    docker rm -f "$ctr" >/dev/null 2>&1 || true
    # Structured result: wall|exit|oom|fatal_log|term_log|survivors
    echo "${wall}|${code}|${oom}|${fatal_log}|${term_log}|${survivors}"
}

case_prompt_exit() {
    echo ""
    echo "=== [prompt-exit] api/web death detection timing (<=4s) ==="
    for mode in rootful rootless; do
        for svc in API Web; do
            ctr="${WORK##*/}-prompt-${mode}-${svc}"
            raw=$(prompt_exit_once "$ctr" "$svc" "$mode")
            result=$(echo "$raw" | tail -1)
            case "$result" in
                ''|*[!0-9|]*) bad "$mode $svc death: no result"; continue ;;
            esac
            w=$(echo "$result" | cut -d'|' -f1)
            rc=$(echo "$result" | cut -d'|' -f2)
            ok_=$(echo "$result" | cut -d'|' -f3)
            fl=$(echo "$result" | cut -d'|' -f4)
            tl=$(echo "$result" | cut -d'|' -f5)
            sv=$(echo "$result" | cut -d'|' -f6)
            pass=1
            if [ "$w" -gt 4 ]; then echo "  FAIL: ${w}s > 4s"; pass=0; fi
            if [ "$rc" = "0" ]; then echo "  FAIL: exit code 0 (expected nonzero)"; pass=0; fi
            if [ "$ok_" != "false" ]; then echo "  FAIL: OOMKilled=$ok_"; pass=0; fi
            if [ "$fl" -lt 1 ]; then echo "  FAIL: no fatal service exit log"; pass=0; fi
            if [ "$tl" -lt 1 ]; then echo "  FAIL: no sibling termination log"; pass=0; fi
            if [ "$sv" != "0" ]; then echo "  FAIL: $sv matching service process(es) survived"; pass=0; fi
            if [ "$pass" = "1" ]; then
                ok "$mode $svc death: all assertions pass (${w}s)"
            else
                bad "$mode $svc death: one or more assertions failed"
            fi
        done
    done
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
    echo "########## CASE: $name ##########"
    $fn
}

run_case red-collision case_red_collision
run_case green-stubborn case_green_stubborn
run_case default-normal case_default_normal
run_case docker-restart case_docker_restart
run_case prompt-exit case_prompt_exit

echo ""
echo "=========================================="
echo "stop-timing results: PASS=$PASS FAIL=$FAIL"
echo "=========================================="
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0