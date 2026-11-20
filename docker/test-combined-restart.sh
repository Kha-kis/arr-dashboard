#!/bin/sh
# Live combined-container restart test.
#
# Proves that an application-requested restart (POST /api/system/restart, the
# same code-42 path used by backup restore) restarts the API under the real
# combined supervisor WITHOUT killing the container: the launcher consumes the
# code-42 exit and respawns the inner server, while start.sh never sees the
# top-level API process exit.
#
# Uses the real image, real services, and a fresh SQLite config volume:
#   register initial admin -> login -> record tracked API PID -> trigger
#   restart -> assert container still running, launcher logged the restart,
#   tracked API PID changed, web PID unchanged, readiness recovered.
#
# Usage: docker/test-combined-restart.sh [image] [--rootless]

set -eu

IMAGE="${1:-arr-dashboard:smoke}"
ROOTLESS=false
if [ "${2:-}" = "--rootless" ]; then
    ROOTLESS=true
fi
WORK=/tmp/test-combined-restart-$$
CTR="${WORK##*/}-restart"
CONFIG_DIR="$WORK/config"
COOKIE="$WORK/cookies.txt"

PASS=0
FAIL=0

report_failure() {
    if fixture_state=$(docker inspect "$CTR" --format \
        'restart-fixture state={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}' 2>/dev/null); then
        printf '%s\n' "$fixture_state" >&2
    else
        printf '%s\n' 'restart-fixture state unavailable' >&2
    fi
    if ! failure_logs=$(docker logs --tail 200 "$CTR" 2>&1); then
        printf '%s\n' 'restart-fixture phases unavailable' >&2
        return
    fi
    printf '%s\n' "$failure_logs" | awk '
        /"msg":"Manual restart requested"/ { manual++ }
        /"msg":"Initiating application restart"/ { scheduled++ }
        /"msg":"Closing server connections gracefully"/ { closing++ }
        /"msg":"Stopping TRaSH Guides update scheduler"/ { trash++ }
        /"msg":"TRaSH Guides update scheduler stopped"/ { trash_timer_stop++ }
        /"msg":"Exiting current process"/ { exit_requested++ }
        /Restart requested [(]count:/ { handoff++ }
        /"msg":"Error (closing Fastify server|during restart)"/ { errors++ }
        END {
            printf "restart-fixture phases manual=%d scheduled=%d close=%d trash=%d trash_timer_stop=%d exit_requested=%d handoff=%d errors=%d\n", manual, scheduled, closing, trash, trash_timer_stop, exit_requested, handoff, errors
        }
    ' >&2
}

cleanup() {
    result=$?
    trap - EXIT
    if [ "$result" -ne 0 ]; then
        report_failure || true
    fi
    docker rm -f "$CTR" >/dev/null 2>&1 || true
    rm -rf "$WORK" 2>/dev/null || true
    exit "$result"
}
mkdir -m 700 "$WORK"
trap cleanup EXIT

mkdir "$CONFIG_DIR"
if [ "$ROOTLESS" = true ]; then
    chown -R 1000:1000 "$CONFIG_DIR" 2>/dev/null || true
    chmod 700 "$CONFIG_DIR" 2>/dev/null || true
fi

# Unique host ports (live e2e suites occupy 3000/3001).
HOST_API_PORT=33090
HOST_WEB_PORT=33091

if [ "$ROOTLESS" = true ]; then
    docker run -d --name "$CTR" --user 1000:1000 \
        -v "$CONFIG_DIR":/config \
        -p "127.0.0.1:$HOST_API_PORT":3001 -p "127.0.0.1:$HOST_WEB_PORT":3000 \
        "$IMAGE" >/dev/null
else
    docker run -d --name "$CTR" \
        -v "$CONFIG_DIR":/config \
        -e PUID=1000 -e PGID=1000 \
        -p "127.0.0.1:$HOST_API_PORT":3001 -p "127.0.0.1:$HOST_WEB_PORT":3000 \
        "$IMAGE" >/dev/null
fi

ok() { echo "  PASS: $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $*" >&2; FAIL=$((FAIL + 1)); }

http_status() {
    umask 077
    status=$(curl -s -o /dev/null -w '%{http_code}' "$@") || status=000
    printf '%s\n' "$status"
}

wait_health() {
    timeout=${1:-120}
    elapsed=0
    while [ "$elapsed" -lt "$timeout" ]; do
        a=$(http_status "http://127.0.0.1:$HOST_API_PORT/health")
        w=$(http_status "http://127.0.0.1:$HOST_WEB_PORT/health")
        if [ "$a" = 200 ] && [ "$w" = 200 ]; then
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    return 1
}

tracked_pid() {
    # $1 = API|Web
    docker logs "$CTR" 2>&1 | sed -n "s/.*$1 started with PID \([0-9][0-9]*\).*/\1/p" | tail -1
}

echo "########## LIVE RESTART TEST (image: $IMAGE) ##########"

if ! wait_health; then
    bad "services did not become healthy"
else
    ok "services healthy"
fi

echo "=== registering initial admin ==="
reg=$(http_status -X POST "http://127.0.0.1:$HOST_API_PORT/auth/register" \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"TestPassw0rd!","rememberMe":false}' \
    -c "$COOKIE")
if [ "$reg" = 201 ]; then
    ok "admin registered (HTTP $reg)"
else
    bad "register failed (HTTP ${reg:-000})"
fi

echo "=== logging in ==="
login=$(http_status -X POST "http://127.0.0.1:$HOST_API_PORT/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"TestPassw0rd!","rememberMe":false}' \
    -c "$COOKIE")
if [ "$login" = 200 ]; then
    ok "login succeeded (HTTP $login)"
else
    bad "login failed (HTTP ${login:-000})"
fi

api_pid_before=$(tracked_pid API)
web_pid_before=$(tracked_pid Web)
inner_pid_before=$(docker exec "$CTR" sh -c "pgrep -f '[d]ist/index[.]js' | head -1" 2>/dev/null || echo "")
echo "  tracked API (launcher) pid before restart: $api_pid_before"
echo "  tracked Web pid before restart: $web_pid_before"
echo "  inner API server pid before restart: $inner_pid_before"
if [ -z "$api_pid_before" ]; then
    bad "could not determine tracked API PID"
else
    ok "tracked API PID known ($api_pid_before)"
fi
if [ -z "$inner_pid_before" ]; then
    bad "could not determine inner API server PID"
else
    ok "inner API server PID known ($inner_pid_before)"
fi

echo "=== triggering POST /api/system/restart ==="
resp=$(http_status -X POST "http://127.0.0.1:$HOST_API_PORT/api/system/restart" -b "$COOKIE")
if [ "$resp" = 200 ]; then
    ok "restart request accepted (HTTP $resp)"
else
    bad "restart request failed (HTTP ${resp:-000})"
fi

# The inner server exits 42; the launcher restarts it after ~1s. The container
# must NEVER exit. Watch for up to 30s while the API comes back.
elapsed=0
inner_pid_after=""
while [ "$elapsed" -lt 30 ]; do
    state=$(docker inspect "$CTR" --format '{{.State.Status}}' 2>/dev/null || echo missing)
    if [ "$state" != "running" ]; then
        bad "container exited during application restart (state=$state)"
        break
    fi
    inner_pid_after=$(docker exec "$CTR" sh -c "pgrep -f '[d]ist/index[.]js' | head -1" 2>/dev/null || echo "")
    if [ -n "$inner_pid_after" ] && [ "$inner_pid_after" != "$inner_pid_before" ]; then
        break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
done

state=$(docker inspect "$CTR" --format '{{.State.Status}}' 2>/dev/null)
if [ "$state" = "running" ]; then
    ok "container kept running through the application restart"
else
    bad "container not running after restart ($state)"
fi

if [ -n "$inner_pid_after" ] && [ "$inner_pid_after" != "$inner_pid_before" ]; then
    ok "inner API server restarted (pid $inner_pid_before -> $inner_pid_after)"
else
    bad "inner API server did not restart (before=$inner_pid_before after=$inner_pid_after)"
fi

api_pid_after=$(tracked_pid API)
if [ "$api_pid_after" = "$api_pid_before" ]; then
    ok "top-level launcher (tracked PID) stayed constant through the app restart"
else
    bad "top-level launcher PID changed on an app restart (before=$api_pid_before after=$api_pid_after)"
fi

if [ -n "$web_pid_before" ] && [ "$(tracked_pid Web)" = "$web_pid_before" ]; then
    ok "web process stayed constant through the API restart"
else
    bad "web process changed during the API restart"
fi

logs=$(docker logs "$CTR" 2>&1 || true)
if echo "$logs" | grep -q "Restart requested"; then
    ok "launcher logged the application restart"
else
    bad "missing 'Restart requested' in launcher logs"
fi
if echo "$logs" | grep -q "exited unexpectedly"; then
    bad "supervisor treated the app restart as a crash"
else
    ok "supervisor did not report a crash during the app restart"
fi
if echo "$logs" | grep -q "Manual restart requested"; then
    ok "API logged the manual restart request"
else
    bad "missing 'Manual restart requested' in API logs"
fi

echo "=== web continuity check ==="
# Wait for both services to recover after the restart (the new inner server
# needs a moment to boot before /health responds).
recovered=false
elapsed=0
while [ "$elapsed" -lt 60 ]; do
    a=$(http_status "http://127.0.0.1:$HOST_API_PORT/health")
    w=$(http_status "http://127.0.0.1:$HOST_WEB_PORT/health")
    if [ "$a" = 200 ] && [ "$w" = 200 ]; then
        recovered=true
        break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
done

if [ "$recovered" = true ]; then
    ok "web readiness recovered after the API restart"
else
    bad "web did not recover after API restart (HTTP web=${w:-000} api=${a:-000})"
fi

if [ "$a" = 200 ]; then
    ok "API healthy after restart"
else
    bad "API not healthy after restart"
fi

echo ""
echo "=========================================="
echo "Live restart results: PASS=$PASS FAIL=$FAIL"
echo "=========================================="
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0