#!/bin/sh
# Next.js runtime image-cache permission regression.
#
# Exercises the real combined image and the real Next image optimizer across
# image-default, LinuxServer-remapped, and arbitrary rootless users. Only the
# disposable `.next/cache` boundary may be writable by the web process.
#
# Usage: docker/test-web-cache-permissions.sh [image]

set -eu

IMAGE="${1:-arr-dashboard:smoke}"
WORK=$(mktemp -d /tmp/test-web-cache-permissions.XXXXXX)
HOST_UID=$(id -u)
HOST_GID=$(id -g)
PASS=0
FAIL=0
CURRENT_CTR=""

cleanup() {
    if [ -n "$CURRENT_CTR" ]; then
        docker rm -f "$CURRENT_CTR" >/dev/null 2>&1 || true
    fi
    for config_name in remapped-1000-config default-911-config remapped-12345-config rootless-1000-config rootless-12345-config read-only-config; do
        config_dir="$WORK/$config_name"
        if [ -d "$config_dir" ]; then
            docker run --rm --entrypoint sh \
                -v "$config_dir:/cleanup" "$IMAGE" \
                -c "chown -R $HOST_UID:$HOST_GID /cleanup" >/dev/null 2>&1 || true
        fi
    done
    rm -rf -- "${WORK:?}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

ok() {
    echo "  PASS: $*"
    PASS=$((PASS + 1))
}

bad() {
    echo "  FAIL: $*" >&2
    FAIL=$((FAIL + 1))
}

wait_health() {
    ctr=$1
    api_port=$2
    web_port=$3
    elapsed=0
    while [ "$elapsed" -lt 120 ]; do
        api_health=$(curl -fsS "http://127.0.0.1:$api_port/health" 2>/dev/null || true)
        web_health=$(curl -fsS "http://127.0.0.1:$web_port/health" 2>/dev/null || true)
        if [ -n "$api_health" ] && [ -n "$web_health" ]; then
            return 0
        fi
        state=$(docker inspect -f '{{.State.Status}}' "$ctr" 2>/dev/null || true)
        if [ "$state" != running ]; then
            return 1
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    return 1
}

process_id() {
    ctr=$1
    pid=$2
    field=$3
    docker exec "$ctr" sh -c "awk '/^$field:/ {print \$2}' /proc/$pid/status"
}

prepare_config() {
    config_dir=$1
    uid=$2
    gid=$3
    mkdir -p "$config_dir"
    docker run --rm --entrypoint sh \
        -v "$config_dir:/config" "$IMAGE" \
        -c "chown -R $uid:$gid /config && chmod 700 /config" >/dev/null
}

assert_optimizer_request() {
    ctr=$1
    web_port=$2
    case_name=$3
    headers="$WORK/$case_name.headers"
    body="$WORK/$case_name.body"

    status=$(curl -sS -D "$headers" -o "$body" -w '%{http_code}' \
        "http://127.0.0.1:$web_port/_next/image?url=%2Ficon.png&w=64&q=75")
    if [ "$status" = 200 ]; then
        ok "$case_name optimizer returned HTTP 200"
    else
        bad "$case_name optimizer returned HTTP $status"
    fi

    content_type=$(sed -n 's/^[Cc]ontent-[Tt]ype:[[:space:]]*\([^[:space:]]*\).*/\1/p' "$headers" | tr -d '\r' | tail -1)
    case "$content_type" in
        image/*) ok "$case_name optimizer returned $content_type" ;;
        *) bad "$case_name optimizer content type is '$content_type'" ;;
    esac

    if [ -s "$body" ]; then
        ok "$case_name optimizer returned a non-empty image body"
    else
        bad "$case_name optimizer returned an empty body"
    fi

    if docker exec "$ctr" sh -c "find /app/web/apps/web/.next/cache -mindepth 1 -print -quit 2>/dev/null | grep -q ."; then
        ok "$case_name optimizer created a cache artifact"
    else
        bad "$case_name optimizer created no cache artifact"
    fi
}

assert_cache_logs_clean() {
    ctr=$1
    case_name=$2
    logs=$(docker logs "$ctr" 2>&1 || true)
    if echo "$logs" | grep -Eqi "EACCES.*\.next/cache|Failed to write image to cache|image optimizer.*(error|fail)"; then
        bad "$case_name logs contain a Next image-cache failure"
        echo "$logs" | grep -Ei "EACCES|\.next/cache|Failed to write image|image optimizer" >&2 || true
    else
        ok "$case_name logs contain no Next image-cache failure"
    fi
}

assert_runtime_boundaries() {
    ctr=$1
    ids=$2
    mode=$3

    cache_stat=$(docker exec "$ctr" stat -c '%u:%g %a' /app/web/apps/web/.next/cache 2>/dev/null || true)
    if [ "$cache_stat" = "0:0 1777" ]; then
        ok "$mode cache is the only sticky world-writable runtime boundary"
    else
        bad "$mode cache ownership/mode is '$cache_stat' (expected '0:0 1777')"
    fi

    for path in /app/web /app/web/apps/web /app/web/apps/web/.next /app/web/apps/web/.next/server; do
        path_stat=$(docker exec "$ctr" stat -c '%u:%g %a' "$path" 2>/dev/null || true)
        case "$path_stat" in
            "0:0 "*) ok "$mode keeps $path root-owned ($path_stat)" ;;
            *) bad "$mode does not keep $path root-owned ($path_stat)" ;;
        esac
    done

    if docker exec -u "$ids" "$ctr" sh -c '
        probe=/app/web/apps/web/.next/cache/.permission-probe
        probe_dir=/app/web/apps/web/.next/cache/.permission-probe-dir
        mkdir "$probe_dir" &&
        printf first > "$probe" &&
        printf second >> "$probe" &&
        rm -f "$probe" &&
        rmdir "$probe_dir"
    '; then
        ok "$mode runtime user can create, update, and remove cache entries"
    else
        bad "$mode runtime user cannot update the exact cache boundary"
    fi

    for target in /app/web/server.js /app/web/apps/web/server.js; do
        if docker exec -u "$ids" "$ctr" touch "$target" 2>/dev/null; then
            bad "$mode runtime user can modify $target"
        else
            ok "$mode runtime user cannot modify $target"
        fi
    done

    immutable_probe=/app/web/apps/web/.next/server/.permission-probe
    if docker exec -u "$ids" "$ctr" touch "$immutable_probe" 2>/dev/null; then
        bad "$mode runtime user can create content under .next/server"
        docker exec "$ctr" rm -f "$immutable_probe" >/dev/null 2>&1 || true
    else
        ok "$mode runtime user cannot create content under .next/server"
    fi
}

run_case() {
    mode=$1
    uid=$2
    gid=$3
    rootless=$4
    config_dir="$WORK/$mode-config"
    prepare_config "$config_dir" "$uid" "$gid"

    CURRENT_CTR="test-web-cache-${mode}-$$"
    echo ""
    echo "========== $mode ($uid:$gid) =========="

    if [ "$rootless" = true ]; then
        docker run -d --name "$CURRENT_CTR" \
            --user "$uid:$gid" \
            -p 127.0.0.1::3000 -p 127.0.0.1::3001 \
            -v "$config_dir:/config" \
            "$IMAGE" >/dev/null
    else
        docker run -d --name "$CURRENT_CTR" \
            -e PUID="$uid" -e PGID="$gid" \
            -p 127.0.0.1::3000 -p 127.0.0.1::3001 \
            -v "$config_dir:/config" \
            "$IMAGE" >/dev/null
    fi

    web_port=$(docker port "$CURRENT_CTR" 3000/tcp | sed -n '1s/.*://p')
    api_port=$(docker port "$CURRENT_CTR" 3001/tcp | sed -n '1s/.*://p')
    if wait_health "$CURRENT_CTR" "$api_port" "$web_port"; then
        ok "$mode API and web are healthy"
    else
        bad "$mode services did not become healthy"
        docker logs "$CURRENT_CTR" 2>&1 | tail -60 >&2 || true
        docker rm -f "$CURRENT_CTR" >/dev/null 2>&1 || true
        CURRENT_CTR=""
        return
    fi

    web_pid=$(docker logs "$CURRENT_CTR" 2>&1 | sed -n 's/.*Web started with PID \([0-9][0-9]*\).*/\1/p' | tail -1)
    actual_uid=$(process_id "$CURRENT_CTR" "$web_pid" Uid)
    actual_gid=$(process_id "$CURRENT_CTR" "$web_pid" Gid)
    if [ "$actual_uid:$actual_gid" = "$uid:$gid" ]; then
        ok "$mode web process runs as $uid:$gid"
    else
        bad "$mode web process runs as $actual_uid:$actual_gid (expected $uid:$gid)"
    fi

    if docker logs "$CURRENT_CTR" 2>&1 | grep -q "Next image cache ready: /app/web/apps/web/.next/cache (UID:$uid GID:$gid)"; then
        ok "$mode startup verified the cache as the runtime user"
    else
        bad "$mode startup did not log successful runtime-user cache verification"
    fi

    assert_optimizer_request "$CURRENT_CTR" "$web_port" "$mode"
    assert_runtime_boundaries "$CURRENT_CTR" "$uid:$gid" "$mode"
    assert_cache_logs_clean "$CURRENT_CTR" "$mode"

    if docker restart --time 15 "$CURRENT_CTR" >/dev/null; then
        web_port=$(docker port "$CURRENT_CTR" 3000/tcp | sed -n '1s/.*://p')
        api_port=$(docker port "$CURRENT_CTR" 3001/tcp | sed -n '1s/.*://p')
    fi
    if [ -n "${web_port:-}" ] && [ -n "${api_port:-}" ] && wait_health "$CURRENT_CTR" "$api_port" "$web_port"; then
        ok "$mode container restart is healthy"
        assert_optimizer_request "$CURRENT_CTR" "$web_port" "$mode-restart"
        assert_cache_logs_clean "$CURRENT_CTR" "$mode-restart"
    else
        bad "$mode container restart did not recover"
        docker logs "$CURRENT_CTR" 2>&1 | tail -60 >&2 || true
    fi

    if docker stop --time 15 "$CURRENT_CTR" >/dev/null; then
        exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$CURRENT_CTR")
        if [ "$exit_code" = 0 ]; then
            ok "$mode container stopped gracefully"
        else
            bad "$mode container stopped with exit code $exit_code"
        fi
    else
        bad "$mode container did not stop gracefully"
    fi

    docker rm -f "$CURRENT_CTR" >/dev/null 2>&1 || true
    CURRENT_CTR=""
}

assert_unwritable_cache_fails_fast() {
    config_dir="$WORK/read-only-config"
    prepare_config "$config_dir" 1000 1000
    CURRENT_CTR="test-web-cache-read-only-$$"

    echo ""
    echo "========== fail-fast read-only cache =========="
    docker run -d --name "$CURRENT_CTR" \
        --read-only --user 1000:1000 \
        -v "$config_dir:/config" \
        "$IMAGE" >/dev/null

    elapsed=0
    state=running
    while [ "$elapsed" -lt 30 ]; do
        state=$(docker inspect -f '{{.State.Status}}' "$CURRENT_CTR" 2>/dev/null || true)
        [ "$state" = running ] || break
        sleep 1
        elapsed=$((elapsed + 1))
    done

    if [ "$state" = exited ]; then
        exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$CURRENT_CTR")
        if [ "$exit_code" != 0 ]; then
            ok "unwritable rootless cache stops startup with a non-zero exit"
        else
            bad "unwritable rootless cache stopped with exit code 0"
        fi
    else
        bad "unwritable rootless cache did not fail before serving traffic"
    fi

    logs=$(docker logs "$CURRENT_CTR" 2>&1 || true)
    if echo "$logs" | grep -q "ERROR: Next image cache is not writable: /app/web/apps/web/.next/cache (UID:1000 GID:1000)"; then
        ok "unwritable rootless cache reports path and runtime UID/GID"
    else
        bad "unwritable rootless cache lacks an actionable startup error"
        echo "$logs" | tail -40 >&2
    fi

    docker rm -f "$CURRENT_CTR" >/dev/null 2>&1 || true
    CURRENT_CTR=""
}

echo "########## NEXT IMAGE CACHE PERMISSIONS (image: $IMAGE) ##########"

# Lead with the exact current-main regression so RED cannot be masked by the
# image-default user owning the build-time tree.
run_case remapped-1000 1000 1000 false
run_case default-911 911 911 false
run_case remapped-12345 12345 12345 false
run_case rootless-1000 1000 1000 true
run_case rootless-12345 12345 12345 true
assert_unwritable_cache_fails_fast

echo ""
echo "=========================================="
echo "Next image cache results: PASS=$PASS FAIL=$FAIL"
echo "=========================================="

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
