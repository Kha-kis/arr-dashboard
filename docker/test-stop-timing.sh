#!/bin/sh
# Binding-faithful stop-timing and tracked-child reaping tests.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/stop-timing-query.sh"

IMAGE="${1:-arr-dashboard:smoke}"
CASE=""
QUICK=false
shift || true
while [ "$#" -gt 0 ]; do
    case "$1" in
        --case)
            [ "$#" -ge 2 ] || { echo "--case requires a value" >&2; exit 64; }
            CASE=$2
            shift 2
            ;;
        --quick) QUICK=true; shift ;;
        *) echo "unknown argument: $1" >&2; exit 64 ;;
    esac
done

WORK="/tmp/test-stop-timing-$$"
PREFIX="test-stop-timing-$$-"
SHIM_DIR="$WORK/shim"
PORT_LEDGER="$WORK/ports"
PASS=0
FAIL=0

cleanup() {
    owned=$(stop_timing_owned_names "$PREFIX" 2>/dev/null) || owned=""
    if [ -n "$owned" ]; then
        printf '%s\n' "$owned" | while IFS= read -r container_name; do
            docker rm -f "$container_name" >/dev/null 2>&1 || true
        done
    fi
    rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$SHIM_DIR"
: > "$PORT_LEDGER"

ok() { echo "  PASS: $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $*" >&2; FAIL=$((FAIL + 1)); }

cat > "$SHIM_DIR/server.js" <<'EOF'
console.log("[stubborn-web] started, ignoring SIGTERM");
process.on("SIGTERM", () => { console.log("[stubborn-web] ignoring SIGTERM"); });
setInterval(() => {}, 1000);
EOF

new_config_dir() {
    config_dir="$WORK/config-$1"
    mkdir -p "$config_dir"
    chmod 0777 "$config_dir"
    printf '%s\n' "$config_dir"
}

published_port() {
    container_name=$1
    port_owner=$2
    container_port=$3
    mapping=$(docker port "$container_name" "$container_port/tcp") || return 1
    port=$(printf '%s\n' "$mapping" | awk -F: '
        NF == 2 && $2 ~ /^[0-9]+$/ { count++; port = $2 }
        END { if (count != 1) exit 1; print port }
    ') || return 1
    if ! recorded_port=$(stop_timing_record_port "$PORT_LEDGER" "$port_owner" "$container_name" "$container_port" "$port"); then
        echo "Docker reused suite port $port across distinct owners" >&2
        return 1
    fi
    printf '%s\n' "$recorded_port"
}

start_container() {
    container_name=$1
    mode=$2
    stubborn=$3
    grace=${4:-}
    port_owner=${5:-$container_name}
    config_dir=$(new_config_dir "$container_name")
    set -- docker run -d --name "$container_name" \
        -v "$config_dir:/config" \
        -p 127.0.0.1::3001 -p 127.0.0.1::3000
    if [ "$mode" = rootless ]; then
        set -- "$@" --user 1000:1000
    else
        set -- "$@" -e PUID=1000 -e PGID=1000
    fi
    if [ "$stubborn" = stubborn ]; then
        set -- "$@" -v "$SHIM_DIR/server.js:/app/web/server.js:ro"
    fi
    if [ -n "$grace" ]; then
        set -- "$@" -e "SHUTDOWN_GRACE=$grace"
    fi
    set -- "$@" "$IMAGE"
    "$@" >/dev/null
    API_PORT=$(published_port "$container_name" "$port_owner" 3001) || return 1
    WEB_PORT=$(published_port "$container_name" "$port_owner" 3000) || return 1
}

wait_health() {
    api_only=$1
    elapsed=0
    while [ "$elapsed" -lt 120 ]; do
        if curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
            if [ "$api_only" = true ] || curl -sf "http://127.0.0.1:$WEB_PORT/health" >/dev/null 2>&1; then
                return 0
            fi
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    return 1
}

container_logs() {
    stop_timing_require_present "$1" || return 1
    docker logs "$1" 2>&1
}

wait_stubborn_ready() {
    container_name=$1
    elapsed=0
    while [ "$elapsed" -lt 60 ]; do
        logs=$(container_logs "$container_name") || return 1
        if printf '%s\n' "$logs" | grep -q '^\[stubborn-web\] started, ignoring SIGTERM$'; then
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    return 1
}

capture_supervisor_epoch() {
    API_PID=invalid
    WEB_PID=invalid
    LOG_CURSOR=invalid
    logs=$(container_logs "$1") || return 1
    API_PID=$(printf '%s\n' "$logs" | sed -n 's/.*API started with PID \([0-9][0-9]*\).*/\1/p' | tail -1)
    WEB_PID=$(printf '%s\n' "$logs" | sed -n 's/.*Web started with PID \([0-9][0-9]*\).*/\1/p' | tail -1)
    case "$API_PID:$WEB_PID" in
        *[!0-9:]*|:*) return 1 ;;
    esac
    [ "$API_PID" != "$WEB_PID" ] || return 1
    LOG_CURSOR=$(printf '%s\n' "$logs" | awk 'END { print NR }')
}

appended_logs() {
    logs=$(container_logs "$1") || return 1
    printf '%s\n' "$logs" | awk -v cursor="$2" 'NR > cursor'
}

wait_event() {
    segment=$1
    tracked_pid=$2
    event=$(printf '%s\n' "$segment" | awk -v pid="$tracked_pid" '
        $0 ~ ("^SUPERVISOR_WAIT_COMPLETED pid=" pid " status=[0-9]+$") {
            count++
            line = NR
            sub(/^.* status=/, "", $0)
            status = $0
        }
        END { if (count != 1) exit 1; print line "|" status }
    ') || return 1
    WAIT_LINE=${event%%|*}
    WAIT_STATUS=${event#*|}
    [ "$WAIT_STATUS" != 127 ] || return 1
}

assert_epoch_reaped() {
    segment=$1
    terminal=${2:-}
    API_WAIT_STATUS=missing
    WEB_WAIT_STATUS=missing
    wait_event "$segment" "$API_PID" || return 1
    api_line=$WAIT_LINE
    API_WAIT_STATUS=$WAIT_STATUS
    wait_event "$segment" "$WEB_PID" || return 1
    web_line=$WAIT_LINE
    WEB_WAIT_STATUS=$WAIT_STATUS
    if [ -n "$terminal" ]; then
        terminal_line=$(printf '%s\n' "$segment" | awk -v text="$terminal" 'index($0, text) { line = NR } END { if (!line) exit 1; print line }') || return 1
        [ "$api_line" -lt "$terminal_line" ] && [ "$web_line" -lt "$terminal_line" ] || return 1
    fi
}

measure() {
    gate=$1
    shift
    measure_unchecked "$@" || return 1
    node "$SCRIPT_DIR/stop-timing-clock.cjs" check "$gate" "$ELAPSED_MS"
}

measure_unchecked() {
    if ! ELAPSED_MS=$(node "$SCRIPT_DIR/stop-timing-clock.cjs" measure "$@"); then
        return 1
    fi
}

strict_remove() {
    container_name=$1
    port_owner=$2
    stop_timing_remove_container "$container_name" || return 1
    active_ports=$(stop_timing_active_ports "$PORT_LEDGER") || return 2
    if printf '%s\n' "$active_ports" | awk -F'|' -v owner="$port_owner" '
        $1 == owner { found = 1 }
        END { exit(found ? 0 : 1) }
    '; then
        stop_timing_release_ports "$PORT_LEDGER" "$port_owner" "$container_name" absent || return 1
    fi
    config_dir="$WORK/config-$container_name"
    case "$config_dir" in
        "$WORK"/config-*) ;;
        *) return 2 ;;
    esac
    if [ -e "$config_dir" ]; then
        rm -rf "$config_dir" || return 1
    fi
    [ ! -e "$config_dir" ]
}

case_red_collision() {
    echo ""
    echo "=== [red-collision] SHUTDOWN_GRACE=10 vs docker stop --time 10 ==="
    ctr="${PREFIX}red"
    owner=$ctr
    start_container "$ctr" rootful stubborn 10 "$owner" || { bad "red container failed to start"; strict_remove "$ctr" "$owner" || true; return; }
    wait_health true && wait_stubborn_ready "$ctr" || { bad "red services did not become ready"; strict_remove "$ctr" "$owner" || true; return; }
    if measure collision docker stop --time 10 "$ctr"; then
        state=$(stop_timing_runtime_state "$ctr") || { bad "red state query failed"; return; }
        oom=$(stop_timing_oom_killed "$ctr") || { bad "red OOM query failed"; return; }
        logs=$(container_logs "$ctr") || { bad "red log query failed"; return; }
        graceful=$(printf '%s\n' "$logs" | awk '/Services stopped gracefully/ { count++ } END { print count + 0 }')
        if [ "$state" = exited ] && [ "$oom" = false ] && [ "$graceful" -eq 0 ]; then
            ok "collision reproduced at ${ELAPSED_MS}ms without graceful completion"
        else
            bad "collision evidence unexpected: state=$state oom=$oom graceful=$graceful"
        fi
    else
        bad "collision was not observed at ${ELAPSED_MS:-unknown}ms"
    fi
    strict_remove "$ctr" "$owner" || bad "red container removal was not proven"
}

case_green_stubborn() {
    echo ""
    echo "=== [green-stubborn] bounded stubborn-child stop ==="
    runs=5
    [ "$QUICK" = false ] || runs=1
    for mode in rootful rootless; do
        all_pass=true
        max_ms=0
        i=1
        while [ "$i" -le "$runs" ]; do
            ctr="${PREFIX}green-$mode-$i"
            owner=$ctr
            if ! start_container "$ctr" "$mode" stubborn "" "$owner"; then
                all_pass=false
                strict_remove "$ctr" "$owner" || true
                break
            fi
            if ! wait_health true || ! wait_stubborn_ready "$ctr" || ! capture_supervisor_epoch "$ctr"; then
                all_pass=false
                strict_remove "$ctr" "$owner" || true
                break
            fi
            if ! measure stubborn docker stop --time 10 "$ctr"; then all_pass=false; fi
            [ "${ELAPSED_MS:-999999}" -gt "$max_ms" ] && max_ms=${ELAPSED_MS:-999999}
            code=$(stop_timing_exit_code "$ctr") || all_pass=false
            oom=$(stop_timing_oom_killed "$ctr") || all_pass=false
            state=$(stop_timing_runtime_state "$ctr") || all_pass=false
            segment=$(appended_logs "$ctr" "$LOG_CURSOR") || all_pass=false
            if ! assert_epoch_reaped "$segment" "Services stopped gracefully"; then all_pass=false; fi
            sigkill=$(printf '%s\n' "$segment" | awk '/sending SIGKILL/ { count++ } END { print count + 0 }')
            [ "$code" = 0 ] && [ "$oom" = false ] && [ "$state" = exited ] && [ "$sigkill" -ge 1 ] || all_pass=false
            echo "  $mode run $i: ${ELAPSED_MS}ms exit=$code oom=$oom state=$state api_wait=$API_WAIT_STATUS web_wait=$WEB_WAIT_STATUS"
            strict_remove "$ctr" "$owner" || all_pass=false
            i=$((i + 1))
        done
        if [ "$all_pass" = true ]; then
            ok "$mode stubborn stop: $runs/$runs runs, max ${max_ms}ms, exact old PIDs reaped"
        else
            bad "$mode stubborn stop failed binding-faithful assertions"
            strict_remove "${ctr:-missing}" "${owner:-missing}" >/dev/null 2>&1 || true
        fi
    done
}

case_default_normal() {
    echo ""
    echo "=== [default-normal] normal-child stop ==="
    for mode in rootful rootless; do
        ctr="${PREFIX}normal-$mode"
        owner=$ctr
        pass=true
        start_container "$ctr" "$mode" normal "" "$owner" || pass=false
        if [ "$pass" = true ]; then wait_health false && capture_supervisor_epoch "$ctr" || pass=false; fi
        if [ "$pass" = true ]; then measure_unchecked docker stop --time 10 "$ctr" || pass=false; fi
        if [ "$pass" = true ]; then
            code=$(stop_timing_exit_code "$ctr") || pass=false
            oom=$(stop_timing_oom_killed "$ctr") || pass=false
            state=$(stop_timing_runtime_state "$ctr") || pass=false
            segment=$(appended_logs "$ctr" "$LOG_CURSOR") || pass=false
            assert_epoch_reaped "$segment" "Services stopped gracefully" || pass=false
        fi
        if [ "$pass" = true ] && [ "$code" = 0 ] && [ "$oom" = false ] && [ "$state" = exited ]; then
            ok "$mode normal stop: ${ELAPSED_MS}ms, exact old PIDs reaped"
        else
            bad "$mode normal stop failed binding-faithful assertions"
        fi
        strict_remove "$ctr" "$owner" || bad "$mode normal container removal was not proven"
    done
}

case_docker_restart() {
    echo ""
    echo "=== [docker-restart] old supervisor epoch is isolated from restart ==="
    ctr="${PREFIX}restart"
    old_owner="${ctr}-generation-1"
    new_owner="${ctr}-generation-2"
    cleanup_owner=$old_owner
    start_container "$ctr" rootful stubborn "" "$old_owner" || {
        bad "restart container failed to start"
        strict_remove "$ctr" "$old_owner" || true
        return
    }
    wait_health true && wait_stubborn_ready "$ctr" && capture_supervisor_epoch "$ctr" || {
        bad "restart preconditions failed"
        strict_remove "$ctr" "$old_owner" || true
        return
    }
    old_api=$API_PID
    old_web=$WEB_PID
    old_cursor=$LOG_CURSOR
    if measure restart docker restart --time 10 "$ctr"; then
        ok "restart completed within Docker's 10s window (${ELAPSED_MS}ms)"
    else
        bad "restart exceeded Docker's 10s window (${ELAPSED_MS:-unknown}ms)"
    fi
    appended=$(appended_logs "$ctr" "$old_cursor") || appended=""
    old_segment=$(printf '%s\n' "$appended" | awk '/API started with PID [0-9]+/ { exit } { print }')
    API_PID=$old_api
    WEB_PID=$old_web
    old_epoch_reaped=false
    if assert_epoch_reaped "$old_segment" "Services stopped gracefully" && printf '%s\n' "$old_segment" | grep -q 'sending SIGKILL'; then
        old_epoch_reaped=true
        ok "old restart PIDs were reaped inside the old log epoch"
    else
        bad "old restart PIDs lack bounded old-epoch reaping evidence"
    fi
    restart_healthy=false
    if [ "$old_epoch_reaped" = true ] && stop_timing_release_ports "$PORT_LEDGER" "$old_owner" "$ctr" running; then
        cleanup_owner=$new_owner
        API_PORT=$(published_port "$ctr" "$new_owner" 3001) || { bad "restarted API port query failed"; API_PORT=invalid; }
        WEB_PORT=$(published_port "$ctr" "$new_owner" 3000) || { bad "restarted Web port query failed"; WEB_PORT=invalid; }
        if wait_health true; then restart_healthy=true; fi
    fi
    if [ "$restart_healthy" = true ] && capture_supervisor_epoch "$ctr" && [ "$LOG_CURSOR" -gt "$old_cursor" ]; then
        ok "new supervisor epoch became healthy after the shutdown boundary"
    else
        bad "new supervisor epoch was not isolated and healthy"
    fi
    strict_remove "$ctr" "$cleanup_owner" || bad "restart container removal was not proven"
}

case_prompt_exit() {
    echo ""
    echo "=== [prompt-exit] unexpected API/web death is detected within 4000ms ==="
    for mode in rootful rootless; do
        for service in API Web; do
            ctr="${PREFIX}prompt-$mode-$service"
            owner=$ctr
            pass=true
            start_container "$ctr" "$mode" normal "" "$owner" || pass=false
            if [ "$pass" = true ]; then wait_health false && capture_supervisor_epoch "$ctr" || pass=false; fi
            if [ "$pass" = true ]; then
                case "$service" in API) target_pid=$API_PID ;; Web) target_pid=$WEB_PID ;; esac
                measure prompt "$SCRIPT_DIR/stop-timing-query.sh" trigger-exit "$ctr" "$target_pid" || pass=false
            fi
            if [ "$pass" = true ]; then
                code=$(stop_timing_exit_code "$ctr") || pass=false
                oom=$(stop_timing_oom_killed "$ctr") || pass=false
                state=$(stop_timing_runtime_state "$ctr") || pass=false
                segment=$(appended_logs "$ctr" "$LOG_CURSOR") || pass=false
                assert_epoch_reaped "$segment" || pass=false
                fatal_count=$(printf '%s\n' "$segment" | awk -v service="$service" 'index($0, "ERROR: " service " service exited unexpectedly") { count++ } END { print count + 0 }')
                term_count=$(printf '%s\n' "$segment" | awk '/Terminating (API|Web) service/ { count++ } END { print count + 0 }')
            fi
            if [ "$pass" = true ] && [ "$code" -ne 0 ] && [ "$oom" = false ] && [ "$state" = exited ] && [ "$fatal_count" -eq 1 ] && [ "$term_count" -eq 1 ]; then
                ok "$mode $service death: ${ELAPSED_MS}ms, nonzero exit, both old PIDs reaped"
            else
                bad "$mode $service death failed binding-faithful assertions"
            fi
            strict_remove "$ctr" "$owner" || bad "$mode $service container removal was not proven"
        done
    done
}

case_negative_control() {
    echo ""
    echo "=== [negative-control] no supervisor wait event without start-combined.sh ==="
    ctr="${PREFIX}negative"
    owner=$ctr
    docker run --name "$ctr" --entrypoint sh "$IMAGE" -c 'echo negative-control; exit 0' >/dev/null
    logs=$(container_logs "$ctr") || { bad "negative-control log query failed"; return; }
    count=$(printf '%s\n' "$logs" | awk '/^SUPERVISOR_WAIT_COMPLETED pid=[0-9]+ status=[0-9]+$/ { count++ } END { print count + 0 }')
    if [ "$count" -ne 0 ]; then
        bad "negative control emitted $count supervisor wait event(s)"
    else
        echo "  PROOF: negative control emitted no supervisor wait event"
    fi
    strict_remove "$ctr" "$owner" || bad "negative-control removal was not proven"
}

run_case() {
    name=$1
    fn=$2
    if [ -z "$CASE" ] || [ "$CASE" = "$name" ]; then
        echo "########## CASE: $name ##########"
        "$fn"
    fi
}

run_case red-collision case_red_collision
run_case green-stubborn case_green_stubborn
run_case default-normal case_default_normal
run_case docker-restart case_docker_restart
run_case prompt-exit case_prompt_exit
run_case negative-control case_negative_control

owned=$(stop_timing_owned_names "$PREFIX") || { echo "QUERY_ERROR while proving suite cleanup" >&2; exit 1; }
if [ -n "$owned" ]; then
    echo "owned containers remain: $owned" >&2
    exit 1
fi
active_ports=$(stop_timing_active_ports "$PORT_LEDGER") || { echo "QUERY_ERROR while proving port cleanup" >&2; exit 1; }
if [ -n "$active_ports" ]; then
    echo "active port owners remain: $active_ports" >&2
    exit 1
fi
if ! rm -rf "$WORK" || [ -e "$WORK" ]; then
    echo "suite work directory cleanup was not proven: $WORK" >&2
    exit 1
fi
trap - EXIT

echo ""
echo "=========================================="
echo "stop-timing results: PASS=$PASS FAIL=$FAIL"
echo "=========================================="
[ "$FAIL" -eq 0 ]
