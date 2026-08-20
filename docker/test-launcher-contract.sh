#!/bin/sh
# Launcher (dist/launcher.js) contract tests against the real image.
#
# The combined supervisor runs /app/api/dist/launcher.js as the top-level API
# service. This script proves the launcher's contract in that configuration:
#   1. code 42  -> internal restart, launcher stays alive
#   2. code 3   -> non-42 propagated, launcher exits with the same code
#   3. SIGTERM  -> forwarded to the inner server, graceful exit 0
#   4. restart loop guard -> 10 restarts in 60s stops the launcher (exit 1)
#   5. LAUNCHER_MANAGED=true is set for the inner server
#
# A mock index.js replaces /app/api/dist/index.js (never the launcher) so the
# inner server's exit behavior is deterministic. The container runs the real
# /app/start.sh-adjacent launcher path: tini -> node launcher.js.
#
# Usage: docker/test-launcher-contract.sh [image]

set -eu

IMAGE="${1:-arr-dashboard:smoke}"
WORK=/tmp/test-launcher-contract-$$
CTR="${WORK##*/}-ctr"
CONFIG_DIR="$WORK/config"

PASS=0
FAIL=0

cleanup() {
    docker rm -f "$CTR" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$CONFIG_DIR"
chmod 777 "$CONFIG_DIR"

MOCK="$WORK/mock-index.js"
cat > "$MOCK" <<'EOF'
import fs from "node:fs";
const ctl = "/config/.launcher-ctl";
console.log(`[mock-api] started pid=${process.pid} LAUNCHER_MANAGED=${process.env.LAUNCHER_MANAGED}`);
fs.writeFileSync("/config/.mock-pid", String(process.pid));
function mode() {
  try { return fs.readFileSync(ctl, "utf8").trim(); } catch { return "idle"; }
}
setInterval(() => {
  const m = mode();
  if (m === "exit42-once") {
    // Atomically clear the control so the replacement child stays alive.
    fs.writeFileSync(ctl, "idle");
    console.log("[mock-api] exiting 42 (once)");
    process.exit(42);
  }
  if (m === "exit42") { console.log("[mock-api] exiting 42"); process.exit(42); }
  if (m === "exit3") { console.log("[mock-api] exiting 3"); process.exit(3); }
  if (m === "exit0") { console.log("[mock-api] exiting 0"); process.exit(0); }
}, 200);
process.on("SIGTERM", () => { console.log("[mock-api] SIGTERM -> exit 0"); process.exit(0); });
setInterval(() => {}, 1000);
EOF

# Remove all mock fixture state from the host config dir before each container.
reset_launcher_fixture() {
    rm -f "$CONFIG_DIR/.launcher-ctl" "$CONFIG_DIR/.mock-pid"
}

start_ctr() {
    reset_launcher_fixture
    docker rm -f "$CTR" >/dev/null 2>&1 || true
    docker run -d --name "$CTR" \
        -v "$CONFIG_DIR":/config \
        -v "$MOCK":/app/api/dist/index.js:ro \
        "$IMAGE" node --enable-source-maps /app/api/dist/launcher.js >/dev/null
}

set_mode() {
    docker exec "$CTR" sh -c "printf '%s' '$1' > /config/.launcher-ctl"
}

# Return the mock API PID, but verify it belongs to THIS container's mock
# process (not a stale file from a previous container).
inner_pid() {
    p=$(docker exec "$CTR" sh -c "cat /config/.mock-pid 2>/dev/null || true")
    [ -n "$p" ] || return 1
    # Verify the PID is a live node process in this container.
    docker exec "$CTR" sh -c "test -d /proc/$p" 2>/dev/null || return 1
    echo "$p"
}

wait_inner() {
    timeout=${1:-30}
    elapsed=0
    while [ "$elapsed" -lt "$timeout" ]; do
        p=$(inner_pid)
        if [ -n "$p" ]; then
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    return 1
}

wait_ctr_exit() {
    timeout=${1:-30}
    elapsed=0
    while [ "$elapsed" -lt "$timeout" ]; do
        state=$(docker inspect "$CTR" --format '{{.State.Status}}' 2>/dev/null || echo missing)
        if [ "$state" != "running" ]; then
            EXIT_CODE=$(docker inspect "$CTR" --format '{{.State.ExitCode}}' 2>/dev/null || echo 999)
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    EXIT_CODE=999
    return 1
}

ok() { echo "  PASS: $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $*" >&2; FAIL=$((FAIL + 1)); }

echo "########## LAUNCHER CONTRACT TESTS (image: $IMAGE) ##########"

# --- Restart on code 42 ---
echo ""
echo "=== [contract-42] code 42 -> internal restart, launcher survives ==="
start_ctr
if ! wait_inner; then
    bad "inner server never started"
    docker logs "$CTR" 2>&1 | tail -20 >&2
else
    ok "inner server started"
fi
p1=$(inner_pid)
if docker logs "$CTR" 2>&1 | grep -q "LAUNCHER_MANAGED=true"; then
    ok "LAUNCHER_MANAGED=true is set for the inner server"
else
    bad "LAUNCHER_MANAGED=true missing"
fi
set_mode exit42-once
sleep 4
p2=$(inner_pid)
state=$(docker inspect "$CTR" --format '{{.State.Status}}' 2>/dev/null)
if [ "$state" = "running" ]; then
    ok "launcher stayed alive after code 42"
else
    bad "launcher exited on code 42"
fi
if [ -n "$p1" ] && [ -n "$p2" ] && [ "$p1" != "$p2" ]; then
    ok "inner server restarted (pid $p1 -> $p2)"
else
    bad "inner server did not restart (pids: '$p1' -> '$p2')"
fi
if docker logs "$CTR" 2>&1 | grep -q "Restart requested"; then
    ok "launcher logged the restart request"
else
    bad "missing 'Restart requested' log"
fi
# Prove the replacement stays alive (not a restart loop): observe for 5s that
# the inner PID does not change again.
sleep 5
p3=$(inner_pid)
if [ "$p3" = "$p2" ]; then
    ok "replacement inner stayed alive (no restart loop)"
else
    bad "replacement inner changed (pid $p2 -> $p3) — possible restart loop"
fi
# Only one "Restart requested" log should exist for the single-restart case.
restart_count=$(docker logs "$CTR" 2>&1 | grep -c "Restart requested" || true)
if [ "$restart_count" = "1" ]; then
    ok "exactly one restart request logged"
else
    bad "expected 1 restart request, got $restart_count"
fi

# --- Non-42 propagation ---
echo ""
echo "=== [contract-3] code 3 -> launcher exits with the same code ==="
set_mode exit3
if wait_ctr_exit 20; then
    if [ "$EXIT_CODE" = "3" ]; then
        ok "launcher propagated exit code 3 (container exit $EXIT_CODE)"
    else
        bad "expected container exit 3, got $EXIT_CODE"
    fi
else
    bad "container did not exit after inner code 3"
fi
if docker logs "$CTR" 2>&1 | grep -q "Application exited with code 3"; then
    ok "launcher logged non-42 exit propagation"
else
    bad "missing non-42 exit log"
fi

# --- Graceful SIGTERM ---
echo ""
echo "=== [contract-term] SIGTERM -> forwarded, graceful exit 0 ==="
start_ctr
if ! wait_inner; then
    bad "inner server never started"
else
    ok "inner server started"
fi
docker stop --time 15 "$CTR" >/dev/null
state=$(docker inspect "$CTR" --format '{{.State.Status}}' 2>/dev/null)
code=$(docker inspect "$CTR" --format '{{.State.ExitCode}}' 2>/dev/null)
if [ "$state" = "exited" ] && [ "$code" = "0" ]; then
    ok "graceful SIGTERM exit 0"
else
    bad "expected exited/0, got $state/$code"
fi
if docker logs "$CTR" 2>&1 | grep -q "Received SIGTERM, shutting down"; then
    ok "launcher handled SIGTERM"
else
    bad "missing launcher SIGTERM log"
fi

# --- Restart loop guard ---
echo ""
echo "=== [contract-loop] continuous code 42 -> restart-loop guard stops launcher ==="
start_ctr
if ! wait_inner; then
    bad "inner server never started"
else
    ok "inner server started"
fi
set_mode exit42
if wait_ctr_exit 90; then
    if [ "$EXIT_CODE" = "1" ]; then
        ok "restart-loop guard stopped the launcher (exit 1)"
    else
        bad "expected exit 1 from loop guard, got $EXIT_CODE"
    fi
else
    bad "launcher hung in restart loop beyond 90s"
fi
if docker logs "$CTR" 2>&1 | grep -q "Too many restarts"; then
    ok "launcher logged the restart-loop guard"
else
    bad "missing 'Too many restarts' log"
fi

echo ""
echo "=========================================="
echo "Launcher contract results: PASS=$PASS FAIL=$FAIL"
echo "=========================================="
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0