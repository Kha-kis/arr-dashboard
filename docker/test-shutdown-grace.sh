#!/bin/sh
# SHUTDOWN_GRACE robustness tests.
#
# Verifies:
#   1. invalid SHUTDOWN_GRACE values fall back to the default (no breakage)
#   2. the grace period is a single global deadline (not per-service)
#   3. normal docker stop completes gracefully (exit 0) within Docker's window
#   4. start.sh SIGKILLs and reaps a stubborn child and reports failure (exit 1)
#
# Usage: docker/test-shutdown-grace.sh [image]

set -eu

IMAGE="${1:-arr-dashboard:smoke}"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/test-shutdown-grace-XXXXXXXX")
CONFIG_DIR="$WORK/config"

PASS=0
FAIL=0

FIXTURE_IDS=
cleanup() {
    for c in $FIXTURE_IDS; do
        docker rm -f "$c" >/dev/null 2>&1 || true
    done
    rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$CONFIG_DIR"

ok() { echo "  PASS: $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $*" >&2; FAIL=$((FAIL + 1)); }

fixture_exit_code() {
    if exit_code=$(timeout -k 1s 5s docker inspect "$1" --format '{{.State.ExitCode}}' 2>/dev/null); then
        case "$exit_code" in
            [0-9]|[0-9][0-9]|[0-9][0-9][0-9])
                if [ "$exit_code" -le 255 ]; then
                    printf '%s\n' "$exit_code"
                    return
                fi
                ;;
        esac
    fi
    printf '?\n'
}

report_shutdown_failure() {
    diagnostic_oom=$(timeout -k 1s 5s docker inspect "$1" --format '{{.State.OOMKilled}}' 2>/dev/null) || diagnostic_oom=?
    case "$diagnostic_oom" in
        true|false) ;;
        *) diagnostic_oom=? ;;
    esac
    printf '  shutdown diagnostic elapsed=%ss exit=%s oom=%s\n' "$2" "$3" "$diagnostic_oom" >&2
    if [ "$3" = '?' ]; then
        echo '  shutdown diagnostic unavailable: exit status' >&2
    fi
    if [ "$diagnostic_oom" = '?' ]; then
        echo '  shutdown diagnostic unavailable: OOM status' >&2
    fi

    # Count exact launcher and supervisor markers without forwarding raw lines.
    # A failed Docker read may contain partial output that cannot be summarized.
    if diagnostic_logs=$(timeout -k 1s 5s docker logs --tail 120 "$1" 2>&1) &&
        printf '%s\n' "$diagnostic_logs" | awk '
            $0 == "Shutting down services..." { shutdown++ }
            $0 == "Services stopped gracefully" { graceful++ }
            $0 == "ERROR: Services required forced or failed termination" { failed++ }
            /^  Web did not stop within [0-9]+s - sending SIGKILL$/ { web_kill++ }
            /^  API did not stop within [0-9]+s - sending SIGKILL$/ { api_kill++ }
            /^SUPERVISOR_WAIT_COMPLETED pid=[0-9]+ status=[0-9]+$/ {
                if ($3 == "status=0") wait_ok++
                else if ($3 == "status=143") wait_term++
                else if ($3 == "status=137") wait_kill++
                else wait_other++
            }
            /^\[Launcher\] Received (SIGTERM|SIGINT), shutting down\.\.\.$/ { launcher_shutdown++ }
            $0 == "{\"category\":\"launcher-shutdown-failure\",\"reason\":\"forced-child-termination\"}" { launcher_kill++ }
            $0 == "{\"category\":\"launcher-shutdown-failure\",\"reason\":\"handoff-revocation-failed\"}" { launcher_revoke++ }
            $0 == "{\"category\":\"launcher-shutdown-failure\",\"reason\":\"combined-handoff-rejected\"}" { launcher_reject++ }
            END {
                printf "  shutdown diagnostic markers supervisor_shutdown=%d supervisor_graceful=%d supervisor_failed=%d",
                    shutdown, graceful, failed
                printf " supervisor_web_sigkill=%d supervisor_api_sigkill=%d", web_kill, api_kill
                printf " supervisor_wait_ok=%d supervisor_wait_sigterm=%d supervisor_wait_sigkill=%d supervisor_wait_other=%d",
                    wait_ok, wait_term, wait_kill, wait_other
                printf " launcher_shutdown=%d launcher_forced_child=%d launcher_handoff_revocation_failed=%d launcher_handoff_rejected=%d\n",
                    launcher_shutdown, launcher_kill, launcher_revoke, launcher_reject
            }
        ' >&2; then
        return
    fi
    echo '  shutdown diagnostic unavailable: shutdown log' >&2
}

fixture_port() {
    mapping=$(docker port "$1" "$2/tcp") || return 1
    printf '%s\n' "$mapping" | awk -F: '
        NF == 2 && $1 == "127.0.0.1" && $2 ~ /^[0-9]+$/ && $2 > 0 && $2 <= 65535 { port = $2 }
        END { if (NR != 1 || !port) exit 1; print port }
    '
}

start_fixture() {
    fixture_name=$1
    shift
    FIXTURE_ID=$(docker create --name "$fixture_name" \
        -v "$CONFIG_DIR":/config \
        -e PUID=1000 -e PGID=1000 \
        -p 127.0.0.1::3001 -p 127.0.0.1::3000 \
        "$@" "$IMAGE")
    FIXTURE_IDS="$FIXTURE_IDS $FIXTURE_ID"
    docker start "$FIXTURE_ID" >/dev/null
    HOST_API_PORT=$(fixture_port "$FIXTURE_ID" 3001)
    HOST_WEB_PORT=$(fixture_port "$FIXTURE_ID" 3000)
}

wait_health() {
    timeout=${1:-120}
    elapsed=0
    while [ "$elapsed" -lt "$timeout" ]; do
        a=$(curl -sf "http://127.0.0.1:$HOST_API_PORT/health" 2>/dev/null || echo '')
        w=$(curl -sf "http://127.0.0.1:$HOST_WEB_PORT/health" 2>/dev/null || echo '')
        if [ -n "$a" ] && [ -n "$w" ]; then
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    return 1
}

echo "########## SHUTDOWN_GRACE ROBUSTNESS (image: $IMAGE) ##########"

# --- 1. invalid SHUTDOWN_GRACE values fall back to default ---
echo ""
echo "=== [grace-invalid] invalid SHUTDOWN_GRACE falls back to default ==="
for badval in abc -1 1.5 "  "; do
    fixture_failures=$FAIL
    ctr="${WORK##*/}-invalid-$(echo "$badval" | tr -c 'a-zA-Z0-9' '_')"
    start_fixture "$ctr" -e "SHUTDOWN_GRACE=$badval"
    ctr=$FIXTURE_ID
    if wait_health 60; then
        ok "container started with SHUTDOWN_GRACE='$badval'"
    else
        bad "container failed to start with SHUTDOWN_GRACE='$badval'"
    fi
    # graceful stop must still work (exit 0)
    start=$(date +%s)
    docker stop --time 120 "$ctr" >/dev/null 2>&1 || bad "Docker stop failed with SHUTDOWN_GRACE='$badval'"
    end=$(date +%s)
    elapsed=$((end - start))
    code=$(fixture_exit_code "$ctr")
    if [ "$code" = "0" ]; then
        ok "graceful stop exit 0 with SHUTDOWN_GRACE='$badval'"
    else
        bad "graceful stop exit $code with SHUTDOWN_GRACE='$badval'"
    fi
    if [ "$FAIL" -gt "$fixture_failures" ]; then
        report_shutdown_failure "$ctr" "$elapsed" "$code"
    fi
    docker rm -f "$ctr" >/dev/null 2>&1 || true
done

# --- 2/3. normal docker stop: graceful, exit 0, within Docker's window ---
echo ""
echo "=== [grace-normal] normal docker stop is graceful (exit 0) ==="
fixture_failures=$FAIL
ctr="${WORK##*/}-normal"
start_fixture "$ctr"
ctr=$FIXTURE_ID
wait_health 60 || bad "services did not become healthy"
start=$(date +%s)
docker stop --time 120 "$ctr" >/dev/null 2>&1 || bad "Docker stop failed"
end=$(date +%s)
elapsed=$((end - start))
code=$(fixture_exit_code "$ctr")
echo "  stop elapsed=${elapsed}s exit=$code"
if [ "$code" = "0" ]; then
    ok "normal docker stop exit 0"
else
    bad "normal docker stop exit $code"
fi
if [ "$elapsed" -lt 120 ]; then
    ok "stop completed within Docker's 120s window (${elapsed}s)"
else
    bad "stop took ${elapsed}s (Docker may have force-killed PID 1)"
fi
if [ "$FAIL" -gt "$fixture_failures" ]; then
    report_shutdown_failure "$ctr" "$elapsed" "$code"
fi
docker rm -f "$ctr" >/dev/null 2>&1 || true

# --- 4. stubborn child under intentional stop: start.sh SIGKILLs it ---
echo ""
echo "=== [grace-stubborn] stubborn child is SIGKILLed by start.sh ==="
fixture_failures=$FAIL
ctr="${WORK##*/}-stubborn"
SHIM_DIR="$WORK/shim"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/server.js" <<'EOF'
console.log("[stubborn-web] started, ignoring SIGTERM");
process.on("SIGTERM", () => { console.log("[stubborn-web] ignoring SIGTERM"); });
setInterval(() => {}, 1000);
EOF
start_fixture "$ctr" -e SHUTDOWN_GRACE=3 -v "$SHIM_DIR/server.js":/app/web/server.js:ro
ctr=$FIXTURE_ID
# wait for API health only (web is a stubborn shim, no /health)
elapsed=0
while [ "$elapsed" -lt 60 ]; do
    a=$(curl -sf "http://127.0.0.1:$HOST_API_PORT/health" 2>/dev/null || echo '')
    [ -n "$a" ] && break
    sleep 1
    elapsed=$((elapsed + 1))
done
[ -n "$a" ] || bad "API did not become healthy"
# Wait for the stubborn web shim to register its SIGTERM handler before
# stopping, otherwise it may exit on the default SIGTERM path.
elapsed=0
while [ "$elapsed" -lt 30 ]; do
    if docker logs "$ctr" 2>&1 | grep -q "stubborn-web.*started"; then
        break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
done
if docker logs "$ctr" 2>&1 | grep -q "stubborn-web.*started"; then
    ok "stubborn web shim started"
else
    bad "stubborn web shim did not start"
fi
start=$(date +%s)
docker stop --time 30 "$ctr" >/dev/null 2>&1 || bad "Docker stop failed for the stubborn fixture"
end=$(date +%s)
elapsed=$((end - start))
code=$(fixture_exit_code "$ctr")
logs=$(docker logs "$ctr" 2>&1 || true)
echo "  stop elapsed=${elapsed}s exit=$code"
if echo "$logs" | grep -q "sending SIGKILL"; then
    ok "start.sh escalated to SIGKILL itself"
else
    bad "start.sh did not SIGKILL the stubborn child"
fi
if printf '%s\n' "$logs" | grep -Fxq '[stubborn-web] ignoring SIGTERM'; then
    ok "stubborn child confirmed it ignored SIGTERM"
else
    bad "stubborn child did not report ignoring SIGTERM"
fi
web_pid=$(printf '%s\n' "$logs" | sed -n 's/^Web started with PID \([0-9][0-9]*\)$/\1/p' | tail -1)
if [ -n "$web_pid" ] && printf '%s\n' "$logs" | grep -Fxq "SUPERVISOR_WAIT_COMPLETED pid=$web_pid status=137"; then
    ok "start.sh reaped the SIGKILLed web child"
else
    bad "missing SIGKILL wait status for the tracked web child"
fi
if [ "$code" = "1" ] && printf '%s\n' "$logs" | grep -Fxq 'ERROR: Services required forced or failed termination'; then
    ok "intentional stop reported forced termination and exited 1"
else
    bad "expected a forced-termination report and exit 1, got exit $code"
fi
if [ "$elapsed" -lt 30 ]; then
    ok "stubborn stop completed within Docker's window (${elapsed}s)"
else
    bad "stubborn stop took ${elapsed}s (Docker force-killed PID 1)"
fi
if [ "$FAIL" -gt "$fixture_failures" ]; then
    report_shutdown_failure "$ctr" "$elapsed" "$code"
fi
docker rm -f "$ctr" >/dev/null 2>&1 || true

echo ""
echo "=========================================="
echo "shutdown-grace results: PASS=$PASS FAIL=$FAIL"
echo "=========================================="
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
