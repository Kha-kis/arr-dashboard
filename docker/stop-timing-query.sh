#!/bin/sh

# Test-only fail-closed Docker query boundary for stop-timing evidence.

stop_timing_query_error() {
    printf '%s\n' QUERY_ERROR
    return 2
}

stop_timing_container_state() {
    name=$1
    case "$name" in
        ''|*[!A-Za-z0-9_.-]*) stop_timing_query_error; return 2 ;;
    esac
    if ! names=$(docker ps -a --format '{{.Names}}'); then
        stop_timing_query_error
        return 2
    fi
    if ! classification=$(printf '%s' "$names" | awk -v target="$name" '
        BEGIN { found = 0; valid = 1 }
        NF == 0 { next }
        $0 !~ /^[A-Za-z0-9][A-Za-z0-9_.-]*$/ { valid = 0; next }
        $0 == target { found++ }
        END {
            if (!valid || found > 1) exit 2
            if (found == 1) print "PRESENT"
            else print "ABSENT"
        }
    '); then
        stop_timing_query_error
        return 2
    fi
    printf '%s\n' "$classification"
}

stop_timing_require_present() {
    classification=$(stop_timing_container_state "$1") || return 2
    [ "$classification" = PRESENT ] || return 1
}

stop_timing_runtime_state() {
    name=$1
    stop_timing_require_present "$name" || { stop_timing_query_error; return 2; }
    state=$(docker inspect --type container --format '{{.State.Status}}' "$name") || {
        stop_timing_query_error
        return 2
    }
    case "$state" in
        created|running|paused|restarting|removing|exited|dead) printf '%s\n' "$state" ;;
        *) stop_timing_query_error; return 2 ;;
    esac
}

stop_timing_exit_code() {
    name=$1
    stop_timing_require_present "$name" || { stop_timing_query_error; return 2; }
    code=$(docker inspect --type container --format '{{.State.ExitCode}}' "$name") || {
        stop_timing_query_error
        return 2
    }
    case "$code" in
        ''|*[!0-9]*) stop_timing_query_error; return 2 ;;
        *) printf '%s\n' "$code" ;;
    esac
}

stop_timing_oom_killed() {
    name=$1
    stop_timing_require_present "$name" || { stop_timing_query_error; return 2; }
    oom=$(docker inspect --type container --format '{{.State.OOMKilled}}' "$name") || {
        stop_timing_query_error
        return 2
    }
    case "$oom" in
        true|false) printf '%s\n' "$oom" ;;
        *) stop_timing_query_error; return 2 ;;
    esac
}

stop_timing_remove_container() {
    name=$1
    classification=$(stop_timing_container_state "$name") || return 2
    if [ "$classification" = PRESENT ]; then
        docker rm -f "$name" >/dev/null || return 2
    fi
    classification=$(stop_timing_container_state "$name") || return 2
    [ "$classification" = ABSENT ] || return 1
}

stop_timing_owned_names() {
    prefix=$1
    names=$(docker ps -a --format '{{.Names}}') || { stop_timing_query_error; return 2; }
    if ! owned=$(printf '%s' "$names" | awk -v prefix="$prefix" '
        NF == 0 { next }
        $0 !~ /^[A-Za-z0-9][A-Za-z0-9_.-]*$/ { invalid = 1; next }
        index($0, prefix) == 1 { print }
        END { if (invalid) exit 2 }
    '); then
        stop_timing_query_error
        return 2
    fi
    printf '%s\n' "$owned"
}

stop_timing_active_ports() {
    ledger=$1
    [ -e "$ledger" ] || return 0
    [ -f "$ledger" ] || { stop_timing_query_error; return 2; }
    if ! active=$(awk -F'|' '
        NF == 0 { next }
        NF != 4 || $1 !~ /^[A-Za-z0-9_.-]+$/ || $2 !~ /^[A-Za-z0-9_.-]+$/ || $3 !~ /^[0-9]+$/ || $4 !~ /^[0-9]+$/ {
            invalid = 1
            next
        }
        {
            if (($1 in owner_names) && owner_names[$1] != $2) invalid = 1
            owner_names[$1] = $2
            owner_key = $1 "|" $2 "|" $3
            if (++owner_keys[owner_key] > 1 || ++host_ports[$4] > 1) invalid = 1
            print
        }
        END { if (invalid) exit 2 }
    ' "$ledger"); then
        stop_timing_query_error
        return 2
    fi
    [ -z "$active" ] || printf '%s\n' "$active"
}

stop_timing_record_port() {
    ledger=$1
    owner=$2
    name=$3
    container_port=$4
    host_port=$5
    case "$owner" in
        ''|*[!A-Za-z0-9_.-]*) stop_timing_query_error; return 2 ;;
    esac
    case "$name" in
        ''|*[!A-Za-z0-9_.-]*) stop_timing_query_error; return 2 ;;
    esac
    case "$container_port" in
        ''|*[!0-9]*) stop_timing_query_error; return 2 ;;
    esac
    case "$host_port" in
        ''|*[!0-9]*) stop_timing_query_error; return 2 ;;
    esac
    if [ ! -e "$ledger" ]; then
        : > "$ledger" || { stop_timing_query_error; return 2; }
    fi
    if ! active=$(stop_timing_active_ports "$ledger"); then
        stop_timing_query_error
        return 2
    fi
    if decision=$(printf '%s\n' "$active" | awk -F'|' -v owner="$owner" -v name="$name" -v container_port="$container_port" -v host_port="$host_port" '
        NF == 0 { next }
        $1 == owner && $2 == name && $3 == container_port && $4 == host_port { exact = 1 }
        $1 == owner && $2 != name { conflict = 1 }
        $1 == owner && $2 == name && $3 == container_port && $4 != host_port { conflict = 1 }
        $4 == host_port && ($1 != owner || $2 != name || $3 != container_port) { conflict = 1 }
        END {
            if (conflict) exit 1
            if (exact) print "EXISTING"
            else print "NEW"
        }
    '); then
        :
    else
        decision_status=$?
        [ "$decision_status" -eq 1 ] && return 1
        stop_timing_query_error
        return 2
    fi
    if [ "$decision" = NEW ]; then
        printf '%s|%s|%s|%s\n' "$owner" "$name" "$container_port" "$host_port" >> "$ledger" || {
            stop_timing_query_error
            return 2
        }
    fi
    printf '%s\n' "$host_port"
}

stop_timing_release_ports() {
    ledger=$1
    owner=$2
    name=$3
    expected_state=$4
    case "$owner" in
        ''|*[!A-Za-z0-9_.-]*) stop_timing_query_error; return 2 ;;
    esac
    case "$name" in
        ''|*[!A-Za-z0-9_.-]*) stop_timing_query_error; return 2 ;;
    esac
    case "$expected_state" in
        absent|running) ;;
        *) stop_timing_query_error; return 2 ;;
    esac
    if ! active=$(stop_timing_active_ports "$ledger"); then
        stop_timing_query_error
        return 2
    fi
    if ! printf '%s\n' "$active" | awk -F'|' -v owner="$owner" -v name="$name" '
        $1 == owner && $2 == name { found = 1 }
        END { exit(found ? 0 : 1) }
    '; then
        return 1
    fi
    case "$expected_state" in
        absent)
            if ! classification=$(stop_timing_container_state "$name"); then
                stop_timing_query_error
                return 2
            fi
            [ "$classification" = ABSENT ] || return 1
            ;;
        running)
            if ! runtime_state=$(stop_timing_runtime_state "$name"); then
                stop_timing_query_error
                return 2
            fi
            [ "$runtime_state" = running ] || return 1
            ;;
    esac
    temporary_ledger=$(mktemp "${ledger}.tmp.XXXXXX") || {
        stop_timing_query_error
        return 2
    }
    if ! printf '%s\n' "$active" | awk -F'|' -v owner="$owner" -v name="$name" 'NF != 0 && ($1 != owner || $2 != name) { print }' > "$temporary_ledger"; then
        rm -f "$temporary_ledger"
        stop_timing_query_error
        return 2
    fi
    if ! mv "$temporary_ledger" "$ledger"; then
        rm -f "$temporary_ledger"
        stop_timing_query_error
        return 2
    fi
}

stop_timing_trigger_exit() {
    name=$1
    pid=$2
    case "$pid" in
        ''|*[!0-9]*) stop_timing_query_error; return 2 ;;
    esac
    state=$(stop_timing_runtime_state "$name") || return 2
    [ "$state" = running ] || { stop_timing_query_error; return 2; }
    docker exec "$name" kill -KILL "$pid" >/dev/null || {
        stop_timing_query_error
        return 2
    }
    checks=0
    while [ "$checks" -lt 600 ]; do
        state=$(stop_timing_runtime_state "$name") || return 2
        case "$state" in
            exited|dead) return 0 ;;
            running) ;;
            *) stop_timing_query_error; return 2 ;;
        esac
        sleep 0.05
        checks=$((checks + 1))
    done
    return 1
}

if [ "${0##*/}" = stop-timing-query.sh ]; then
    command=${1:-}
    [ "$#" -gt 0 ] && shift
    case "$command" in
        container-state) [ "$#" -eq 1 ] || exit 64; stop_timing_container_state "$1" ;;
        runtime-state) [ "$#" -eq 1 ] || exit 64; stop_timing_runtime_state "$1" ;;
        remove-container) [ "$#" -eq 1 ] || exit 64; stop_timing_remove_container "$1" ;;
        owned-names) [ "$#" -eq 1 ] || exit 64; stop_timing_owned_names "$1" ;;
        active-ports) [ "$#" -eq 1 ] || exit 64; stop_timing_active_ports "$1" ;;
        record-port) [ "$#" -eq 5 ] || exit 64; stop_timing_record_port "$1" "$2" "$3" "$4" "$5" ;;
        release-ports) [ "$#" -eq 4 ] || exit 64; stop_timing_release_ports "$1" "$2" "$3" "$4" ;;
        trigger-exit) [ "$#" -eq 2 ] || exit 64; stop_timing_trigger_exit "$1" "$2" ;;
        *) printf '%s\n' 'unknown stop-timing query command' >&2; exit 64 ;;
    esac
fi
