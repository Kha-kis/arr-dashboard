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
#   tracked API PID changed, web stayed healthy the whole time.
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

cleanup() {
    docker rm -f "$CTR" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$CONFIG_DIR"
if [ "$ROOTLESS" = true ]; then
    chown -R 1000:1000 "$CONFIG_DIR" 2>/dev/null || true
    chmod 700 "$CONFIG_DIR"
fi

# Unique host ports (live e2e suites occupy 3000/3001).
HOST_API_PORT=33090
HOST_WEB_PORT=33091

if [ "$ROOTLESS" = true ]; then
    docker run -d --name "$CTR" --user 1000:1000 \
        -v "$CONFIG_DIR":/config \
        -p "$HOST_API_PORT":3001 -p "$HOST_WEB_PORT":3000 \
        "$IMAGE" >/dev/null
else
    docker run -d --name "$CTR" \
        -v "$CONFIG_DIR":/config \
        -e PUID=1000 -e PGID=1000 \
        -p "$HOST_API_PORT":3001 -p "$HOST_WEB_PORT":3000 \
        "$IMAGE" >/dev/null
fi

ok() { echo "  PASS: $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $*" >&2; FAIL=$((FAIL + 1)); }

wait_health() {
    timeout=${1:-120}
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

tracked_pid() {
    # $1 = API|Web
    docker logs "$CTR" 2>&1 | sed -n "s/.*$1 started with PID \([0-9][0-9]*\).*/\1/p" | tail -1
}

echo "########## LIVE RESTART TEST (image: $IMAGE) ##########"

if ! wait_health; then
    bad "services did not become healthy"
    docker logs "$CTR" 2>&1 | tail -30 >&2
else
    ok "services healthy"
fi

echo "=== registering initial admin ==="
reg=$(curl -sf -X POST "http://localhost:$HOST_API_PORT/auth/register" \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"TestPassw0rd!","rememberMe":false}' \
    -c "$COOKIE" 2>/dev/null || echo "{}")
echo "  register response: $reg"
case "$reg" in
    *"id"*|*"success"*|*"true"*) ok "admin registered" ;;
    *) bad "register failed: $reg" ;;
esac

echo "=== logging in ==="
login=$(curl -sf -X POST "http://localhost:$HOST_API_PORT/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"TestPassw0rd!","rememberMe":false}' \
    -c "$COOKIE" 2>/dev/null || echo "")
echo "  login response: $login"
case "$login" in
    *"token"*|*"success"*|*"user"*) ok "login succeeded" ;;
    *) bad "login failed: $login" ;;
esac

api_pid_before=$(tracked_pid API)
web_pid_before=$(tracked_pid Web)
inner_pid_before=$(docker exec "$CTR" sh -c "pgrep -f 'dist/index.js' | head -1" 2>/dev/null || echo "")
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
resp=$(curl -sf -X POST "http://localhost:$HOST_API_PORT/api/system/restart" \
    -b "$COOKIE" 2>/dev/null || echo "")
echo "  restart response: $resp"
case "$resp" in
    *"success"*) ok "restart request accepted" ;;
    *) bad "restart request failed: $resp" ;;
esac

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
    inner_pid_after=$(docker exec "$CTR" sh -c "pgrep -f 'dist/index.js' | head -1" 2>/dev/null || echo "")
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
    a=$(curl -sf "http://localhost:$HOST_API_PORT/health" 2>/dev/null || echo '')
    w=$(curl -sf "http://localhost:$HOST_WEB_PORT/health" 2>/dev/null || echo '')
    if [ -n "$a" ] && [ -n "$w" ]; then
        recovered=true
        break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
done

if [ "$recovered" = true ]; then
    ok "web stayed healthy through the API restart"
else
    bad "web became unhealthy after API restart (health web='$w' api='$a')"
fi

if [ -n "$a" ]; then
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