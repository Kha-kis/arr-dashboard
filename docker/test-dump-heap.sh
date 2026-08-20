#!/bin/sh
# dump-heap contract tests against the real image.
#
# Proves the dump-heap helper targets the inner API server (index.js) and
# never the launcher, and that it fails closed when the API is absent or
# ambiguous. Cases:
#   A. normal startup      -> selects inner index.js PID, not launcher
#   B. after code-42 restart -> selects the new inner PID (launcher constant)
#   C. restart window      -> no index.js child -> fails clearly, no launcher signal
#   D. multiple API servers -> refuses to choose arbitrarily
#   E. actual snapshot smoke -> real dump-heap writes a snapshot, services stay up
#   F. rootless            -> selection + snapshot in rootless mode
#
# Usage: docker/test-dump-heap.sh [image]

set -eu

IMAGE="${1:-arr-dashboard:smoke}"
WORK=/tmp/test-dump-heap-$$
CTR="${WORK##*/}-ctr"
CONFIG_DIR="$WORK/config"
COOKIE="$WORK/cookies.txt"

PASS=0
FAIL=0

cleanup() {
    docker rm -f "$CTR" >/dev/null 2>&1 || true
    rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$CONFIG_DIR"

HOST_API_PORT=33120
HOST_WEB_PORT=33121

ok() { echo "  PASS: $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $*" >&2; FAIL=$((FAIL + 1)); }

# --- helpers (BusyBox-portable /proc walk, no pgrep) ---
inner_pid() {
    docker exec "$CTR" sh -c 'for p in /proc/[0-9]*; do c=$(tr "\0" " " < "$p/cmdline" 2>/dev/null); case "$c" in *"/app/api/dist/index.js"*) echo "${p##*/}";; esac; done' 2>/dev/null | head -1
}
launcher_pid() {
    docker exec "$CTR" sh -c 'for p in /proc/[0-9]*; do c=$(tr "\0" " " < "$p/cmdline" 2>/dev/null); case "$c" in *"/app/api/dist/launcher.js"*) echo "${p##*/}";; esac; done' 2>/dev/null | head -1
}
select_pid() {
    # returns the SELECTED_PID printed by dump-heap --select-only, or empty
    docker exec "$CTR" dump-heap --select-only 2>&1 | sed -n 's/.*SELECTED_PID=\([0-9][0-9]*\).*/\1/p' | head -1
}

start_real() {
    # $1 = extra docker run args (e.g. rootless)
    docker rm -f "$CTR" >/dev/null 2>&1 || true
    docker run -d --name "$CTR" \
        -v "$CONFIG_DIR":/config \
        -e PUID=1000 -e PGID=1000 \
        -p "$HOST_API_PORT":3001 -p "$HOST_WEB_PORT":3000 \
        "$@" "$IMAGE" >/dev/null
}

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

echo "########## DUMP-HEAP CONTRACT TESTS (image: $IMAGE) ##########"

# --- A. normal startup ---
echo ""
echo "=== [A] normal startup: selects inner index.js, not launcher ==="
start_real
if ! wait_health; then
    bad "services did not become healthy"
    docker logs "$CTR" 2>&1 | tail -20 >&2
else
    ok "services healthy"
fi
lp=$(launcher_pid)
ip=$(inner_pid)
sp=$(select_pid)
echo "  launcher=$lp inner=$ip selected=$sp"
if [ -n "$sp" ] && [ "$sp" = "$ip" ]; then
    ok "selected PID equals inner index.js PID ($ip)"
else
    bad "selected PID ($sp) != inner PID ($ip)"
fi
if [ -n "$sp" ] && [ "$sp" != "$lp" ]; then
    ok "selected PID is not the launcher ($lp)"
else
    bad "selected PID equals launcher PID ($lp)"
fi

# --- B. after code-42 restart ---
echo ""
echo "=== [B] after code-42 restart: selects the new inner PID ==="
# register + login to trigger a real app restart
curl -sf -X POST "http://localhost:$HOST_API_PORT/auth/register" \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"TestPassw0rd!","rememberMe":false}' \
    -c "$COOKIE" >/dev/null 2>&1 || true
curl -sf -X POST "http://localhost:$HOST_API_PORT/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"TestPassw0rd!"}' \
    -b "$COOKIE" -c "$COOKIE" >/dev/null 2>&1 || true

lp_before=$(launcher_pid)
ip_before=$(inner_pid)
curl -sf -X POST "http://localhost:$HOST_API_PORT/api/system/restart" -b "$COOKIE" >/dev/null 2>&1 || true

# wait for inner PID to change (launcher restarts after ~1s)
ip_after=""
elapsed=0
while [ "$elapsed" -lt 30 ]; do
    ip_after=$(inner_pid)
    [ -n "$ip_after" ] && [ "$ip_after" != "$ip_before" ] && break
    sleep 1
    elapsed=$((elapsed + 1))
done
lp_after=$(launcher_pid)
echo "  launcher before=$lp_before after=$lp_after; inner before=$ip_before after=$ip_after"
if [ "$lp_after" = "$lp_before" ]; then
    ok "launcher PID constant across restart"
else
    bad "launcher PID changed ($lp_before -> $lp_after)"
fi
if [ -n "$ip_after" ] && [ "$ip_after" != "$ip_before" ]; then
    ok "inner PID changed across restart ($ip_before -> $ip_after)"
else
    bad "inner PID did not change"
fi
# Wait for the API to be healthy again before running dump-heap (the new inner
# server needs a moment to boot; dump-heap targets a live, healthy API).
if ! wait_health 60; then
    bad "API did not recover after restart"
else
    ok "API recovered after restart"
fi
# The contract: dump-heap selects the CURRENT inner index.js PID, never the
# launcher. Re-read the inner PID at selection time (the API may restart more
# than once during recovery).
ip_now=$(inner_pid)
sp=$(select_pid)
echo "  current inner=$ip_now selected=$sp launcher=$lp_after"
if [ -n "$sp" ] && [ "$sp" = "$ip_now" ]; then
    ok "selected PID equals current inner PID ($ip_now)"
else
    bad "selected PID ($sp) != current inner PID ($ip_now)"
fi
if [ -n "$sp" ] && [ "$sp" != "$lp_after" ]; then
    ok "selected PID is not the launcher ($lp_after)"
else
    bad "selected PID equals launcher PID ($lp_after)"
fi

# --- C. restart window (no index.js child) ---
echo ""
echo "=== [C] no inner API server: fails clearly, no launcher fallback ==="
# Replace the launcher with a mock that idles WITHOUT spawning index.js, so the
# container has a launcher but no inner API server (the code-42 restart gap).
docker rm -f "$CTR" >/dev/null 2>&1 || true
MOCK_LAUNCHER="$WORK/mock-launcher.js"
cat > "$MOCK_LAUNCHER" <<'EOF'
console.log("[mock-launcher] idling without spawning index.js");
setInterval(() => {}, 1000);
EOF
docker run -d --name "$CTR" \
    -v "$CONFIG_DIR":/config \
    -e PUID=1000 -e PGID=1000 \
    -v "$MOCK_LAUNCHER":/app/api/dist/launcher.js:ro \
    "$IMAGE" >/dev/null
sleep 5
out=$(docker exec "$CTR" dump-heap --select-only 2>&1 || true)
echo "  dump-heap output: $(echo "$out" | tr '\n' ' ')"
if echo "$out" | grep -q "could not find the inner API server"; then
    ok "helper failed with an actionable message"
else
    bad "helper did not report the missing inner API server"
fi
if echo "$out" | grep -q "restarting"; then
    ok "helper mentioned the API may be restarting"
else
    bad "helper did not mention the restart possibility"
fi
if echo "$out" | grep -q "SELECTED_PID="; then
    bad "helper selected a PID when no inner API server exists"
else
    ok "helper did not fall back to the launcher"
fi

# --- D. multiple API server processes ---
echo ""
echo "=== [D] multiple inner API servers: refuses to choose ==="
docker rm -f "$CTR" >/dev/null 2>&1 || true
MOCK_INDEX="$WORK/mock-index.js"
cat > "$MOCK_INDEX" <<'EOF'
console.log("[mock-index] idling");
setInterval(() => {}, 1000);
EOF
docker run -d --name "$CTR" \
    -v "$CONFIG_DIR":/config \
    -e PUID=1000 -e PGID=1000 \
    -v "$MOCK_INDEX":/app/api/dist/index.js:ro \
    "$IMAGE" >/dev/null
sleep 5
# Spawn a second matching index.js process so two exist.
docker exec -d "$CTR" node /app/api/dist/index.js >/dev/null 2>&1 || true
sleep 2
count=$(docker exec "$CTR" sh -c 'n=0; for p in /proc/[0-9]*; do c=$(tr "\0" " " < "$p/cmdline" 2>/dev/null); case "$c" in *"/app/api/dist/index.js"*) n=$((n+1));; esac; done; echo $n' 2>/dev/null)
echo "  matching index.js processes: $count"
out=$(docker exec "$CTR" dump-heap --select-only 2>&1 || true)
if echo "$out" | grep -q "refusing to choose one arbitrarily"; then
    ok "helper refused to choose among multiple API servers"
else
    bad "helper did not refuse multiple API servers: $(echo "$out" | tr '\n' ' ')"
fi
if echo "$out" | grep -q "candidate PID"; then
    ok "helper listed candidate PIDs"
else
    bad "helper did not list candidate PIDs"
fi

# --- E. actual snapshot smoke ---
echo ""
echo "=== [E] real dump-heap writes a snapshot; services stay up ==="
docker rm -f "$CTR" >/dev/null 2>&1 || true
# Cap the heap small so the snapshot is not multi-gigabyte.
docker run -d --name "$CTR" \
    -v "$CONFIG_DIR":/config \
    -e PUID=1000 -e PGID=1000 \
    -e NODE_OPTIONS="--max-old-space-size=256 --dns-result-order=ipv4first --heapsnapshot-signal=SIGUSR2" \
    -p "$HOST_API_PORT":3001 -p "$HOST_WEB_PORT":3000 \
    "$IMAGE" >/dev/null
if ! wait_health; then
    bad "services did not become healthy"
else
    ok "services healthy"
fi
lp=$(launcher_pid)
ip=$(inner_pid)
before=$(docker exec "$CTR" sh -c 'ls /config/heap-snapshots/*.heapsnapshot 2>/dev/null | wc -l' 2>/dev/null | tr -d ' ')
echo "  snapshots before: $before"
docker exec "$CTR" dump-heap 2>&1 | tail -8
after=$(docker exec "$CTR" sh -c 'ls /config/heap-snapshots/*.heapsnapshot 2>/dev/null | wc -l' 2>/dev/null | tr -d ' ')
echo "  snapshots after: $after"
if [ "$after" -gt "$before" ]; then
    ok "a new snapshot appeared"
else
    bad "no new snapshot appeared"
fi
# verify services still alive
if [ "$(launcher_pid)" = "$lp" ] && [ "$(inner_pid)" = "$ip" ]; then
    ok "launcher and inner API still alive after snapshot"
else
    bad "launcher/inner API changed after snapshot"
fi
if curl -sf "http://localhost:$HOST_API_PORT/health" >/dev/null 2>&1; then
    ok "API healthy after snapshot"
else
    bad "API unhealthy after snapshot"
fi
# clean up the snapshot artifact
docker exec "$CTR" sh -c 'rm -f /config/heap-snapshots/*.heapsnapshot' 2>/dev/null || true
ok "snapshot artifact cleaned up"

# --- F. rootless ---
echo ""
echo "=== [F] rootless: selection + snapshot ==="
docker rm -f "$CTR" >/dev/null 2>&1 || true
chown -R 1000:1000 "$CONFIG_DIR" 2>/dev/null || true
chmod 700 "$CONFIG_DIR"
docker run -d --name "$CTR" --user 1000:1000 \
    -v "$CONFIG_DIR":/config \
    -e NODE_OPTIONS="--max-old-space-size=256 --dns-result-order=ipv4first --heapsnapshot-signal=SIGUSR2" \
    -p "$HOST_API_PORT":3001 -p "$HOST_WEB_PORT":3000 \
    "$IMAGE" >/dev/null
if ! wait_health; then
    bad "rootless services did not become healthy"
else
    ok "rootless services healthy"
fi
lp=$(launcher_pid)
ip=$(inner_pid)
sp=$(select_pid)
echo "  launcher=$lp inner=$ip selected=$sp"
if [ -n "$sp" ] && [ "$sp" = "$ip" ] && [ "$sp" != "$lp" ]; then
    ok "rootless selection targets inner index.js"
else
    bad "rootless selection wrong (selected=$sp inner=$ip launcher=$lp)"
fi
before=$(docker exec "$CTR" sh -c 'ls /config/heap-snapshots/*.heapsnapshot 2>/dev/null | wc -l' 2>/dev/null | tr -d ' ')
docker exec "$CTR" dump-heap >/dev/null 2>&1 || true
after=$(docker exec "$CTR" sh -c 'ls /config/heap-snapshots/*.heapsnapshot 2>/dev/null | wc -l' 2>/dev/null | tr -d ' ')
if [ "$after" -gt "$before" ]; then
    ok "rootless snapshot written"
else
    bad "rootless snapshot not written"
fi
docker exec "$CTR" sh -c 'rm -f /config/heap-snapshots/*.heapsnapshot' 2>/dev/null || true

echo ""
echo "=========================================="
echo "dump-heap contract results: PASS=$PASS FAIL=$FAIL"
echo "=========================================="
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0