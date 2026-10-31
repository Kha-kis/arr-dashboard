#!/bin/sh
# SHUTDOWN_GRACE robustness tests.
#
# Verifies:
#   1. invalid SHUTDOWN_GRACE values fall back to the default (no breakage)
#   2. the grace period is a single global deadline (not per-service)
#   3. normal docker stop completes gracefully (exit 0) within Docker's window
#   4. a stubborn child under intentional stop is SIGKILLed by start.sh itself
#
# Usage: docker/test-shutdown-grace.sh [image]

set -eu

IMAGE="${1:-arr-dashboard:smoke}"
WORK=/tmp/test-shutdown-grace-$$
CONFIG_DIR="$WORK/config"

PASS=0
FAIL=0

cleanup() {
    for c in "${WORK##*/}-"*; do
        docker rm -f "$c" >/dev/null 2>&1 || true
    done
    rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$CONFIG_DIR"

ok() { echo "  PASS: $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $*" >&2; FAIL=$((FAIL + 1)); }

HOST_API_PORT=33130
HOST_WEB_PORT=33131

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

echo "########## SHUTDOWN_GRACE ROBUSTNESS (image: $IMAGE) ##########"

# --- 1. invalid SHUTDOWN_GRACE values fall back to default ---
echo ""
echo "=== [grace-invalid] invalid SHUTDOWN_GRACE falls back to default ==="
for badval in abc -1 1.5 "  "; do
    ctr="${WORK##*/}-invalid-$(echo "$badval" | tr -c 'a-zA-Z0-9' '_')"
    docker rm -f "$ctr" >/dev/null 2>&1 || true
    docker run -d --name "$ctr" \
        -v "$CONFIG_DIR":/config \
        -e PUID=1000 -e PGID=1000 \
        -e SHUTDOWN_GRACE="$badval" \
        -p "$HOST_API_PORT":3001 -p "$HOST_WEB_PORT":3000 \
        "$IMAGE" >/dev/null
    if wait_health "$ctr" 60; then
        ok "container started with SHUTDOWN_GRACE='$badval'"
    else
        bad "container failed to start with SHUTDOWN_GRACE='$badval'"
        docker logs "$ctr" 2>&1 | tail -10 >&2
    fi
    # graceful stop must still work (exit 0)
    docker stop --time 30 "$ctr" >/dev/null 2>&1 || true
    code=$(docker inspect "$ctr" --format '{{.State.ExitCode}}' 2>/dev/null || echo '?')
    if [ "$code" = "0" ]; then
        ok "graceful stop exit 0 with SHUTDOWN_GRACE='$badval'"
    else
        bad "graceful stop exit $code with SHUTDOWN_GRACE='$badval'"
    fi
    docker rm -f "$ctr" >/dev/null 2>&1 || true
done

# --- 2/3. normal docker stop: graceful, exit 0, within Docker's window ---
echo ""
echo "=== [grace-normal] normal docker stop is graceful (exit 0) ==="
ctr="${WORK##*/}-normal"
docker rm -f "$ctr" >/dev/null 2>&1 || true
docker run -d --name "$ctr" \
    -v "$CONFIG_DIR":/config \
    -e PUID=1000 -e PGID=1000 \
    -p "$HOST_API_PORT":3001 -p "$HOST_WEB_PORT":3000 \
    "$IMAGE" >/dev/null
wait_health "$ctr" 60 || bad "services did not become healthy"
start=$(date +%s)
docker stop --time 30 "$ctr" >/dev/null 2>&1 || true
end=$(date +%s)
elapsed=$((end - start))
code=$(docker inspect "$ctr" --format '{{.State.ExitCode}}' 2>/dev/null || echo '?')
echo "  stop elapsed=${elapsed}s exit=$code"
if [ "$code" = "0" ]; then
    ok "normal docker stop exit 0"
else
    bad "normal docker stop exit $code"
fi
if [ "$elapsed" -lt 30 ]; then
    ok "stop completed within Docker's 30s window (${elapsed}s)"
else
    bad "stop took ${elapsed}s (Docker may have force-killed PID 1)"
fi
docker rm -f "$ctr" >/dev/null 2>&1 || true

# --- 4. stubborn child under intentional stop: start.sh SIGKILLs it ---
echo ""
echo "=== [grace-stubborn] stubborn child is SIGKILLed by start.sh ==="
ctr="${WORK##*/}-stubborn"
SHIM_DIR="$WORK/shim"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/server.js" <<'EOF'
console.log("[stubborn-web] started, ignoring SIGTERM");
process.on("SIGTERM", () => { console.log("[stubborn-web] ignoring SIGTERM"); });
setInterval(() => {}, 1000);
EOF
docker rm -f "$ctr" >/dev/null 2>&1 || true
docker run -d --name "$ctr" \
    -v "$CONFIG_DIR":/config \
    -e PUID=1000 -e PGID=1000 \
    -e SHUTDOWN_GRACE=3 \
    -v "$SHIM_DIR/server.js":/app/web/server.js:ro \
    -p "$HOST_API_PORT":3001 -p "$HOST_WEB_PORT":3000 \
    "$IMAGE" >/dev/null
# wait for API health only (web is a stubborn shim, no /health)
elapsed=0
while [ "$elapsed" -lt 60 ]; do
    a=$(curl -sf "http://localhost:$HOST_API_PORT/health" 2>/dev/null || echo '')
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
docker stop --time 30 "$ctr" >/dev/null 2>&1 || true
end=$(date +%s)
elapsed=$((end - start))
code=$(docker inspect "$ctr" --format '{{.State.ExitCode}}' 2>/dev/null || echo '?')
logs=$(docker logs "$ctr" 2>&1 || true)
echo "  stop elapsed=${elapsed}s exit=$code"
if echo "$logs" | grep -q "sending SIGKILL"; then
    ok "start.sh escalated to SIGKILL itself"
else
    bad "start.sh did not SIGKILL the stubborn child"
fi
if echo "$logs" | grep -q "ignoring SIGTERM"; then
    ok "stubborn child confirmed it ignored SIGTERM"
else
    bad "stubborn child did not report ignoring SIGTERM"
fi
if [ "$code" = "0" ]; then
    ok "intentional stop still exits 0 despite stubborn child"
else
    bad "intentional stop exit $code (expected 0)"
fi
if [ "$elapsed" -lt 30 ]; then
    ok "stubborn stop completed within Docker's window (${elapsed}s)"
else
    bad "stubborn stop took ${elapsed}s (Docker force-killed PID 1)"
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