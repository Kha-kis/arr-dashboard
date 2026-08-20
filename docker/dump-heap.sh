#!/bin/sh
# dump-heap — capture a Node heap snapshot from the API process.
#
# Triggered by operators diagnosing OOM / leak issues (see issue #427).
# Sends SIGUSR2 to the running API node process; V8 then writes a
# .heapsnapshot file to CWD (start-combined.sh sets CWD to
# /config/heap-snapshots/, so snapshots land there persistently).
#
# Usage: docker exec <container> dump-heap
#
# Self-contained — walks /proc to find the API process, no procps/pgrep
# required. Polls the snapshot directory for up to POLL_TIMEOUT_SEC
# seconds so operators get clear pass/fail feedback instead of having to
# `ls` repeatedly and guess whether V8 silently failed.

set -eu

# --select-only: print the selected inner API PID and exit without signalling.
# Used by the supervision/dump-heap test suite to exercise PID selection
# deterministically (and by operators as a dry-run).
SELECT_ONLY=false
if [ "${1:-}" = "--select-only" ]; then
	SELECT_ONLY=true
fi

SNAPSHOT_DIR="${HEAP_SNAPSHOT_DIR:-/config/heap-snapshots}"
POLL_TIMEOUT_SEC=120
POLL_INTERVAL_SEC=2

# --- find the inner API server process ---
# The combined container runs the API under a launcher:
#
#   start.sh
#     -> node /app/api/dist/launcher.js        (top-level, supervised)
#          -> node --enable-source-maps /app/api/dist/index.js   (inner API)
#
# A heap snapshot must target the inner API server (index.js), never the
# launcher. The launcher inherits NODE_OPTIONS (including
# --heapsnapshot-signal=SIGUSR2), so signalling it would appear to succeed
# while producing a snapshot of the wrong process. Match the exact API entry
# and exclude the launcher explicitly.
api_pid=""
api_count=0
for proc in /proc/[0-9]*; do
	[ -r "$proc/comm" ] || continue
	if [ "$(cat "$proc/comm" 2>/dev/null)" = "node" ]; then
		cmdline=$(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null || echo "")
		case "$cmdline" in
			*"/app/api/dist/index.js"*)
				# Explicitly skip the launcher (its cmdline is
				# ".../launcher.js" and never contains index.js, but
				# guard anyway in case the entry path ever changes).
				case "$cmdline" in
					*"/app/api/dist/launcher.js"*) continue ;;
				esac
				api_count=$((api_count + 1))
				api_pid="${proc##*/}"
				api_cmdline="$cmdline"
				;;
		esac
	fi
done

if [ "$api_count" -eq 0 ]; then
	echo "ERROR: could not find the inner API server process (node /app/api/dist/index.js)." >&2
	echo "  The API may currently be restarting (the launcher respawns it after a" >&2
	echo "  code-42 restart with a ~1s gap). Retry in a moment." >&2
	echo "  Refusing to fall back to the launcher process — a snapshot of the" >&2
	echo "  launcher would not capture the API application heap." >&2
	exit 1
fi

if [ "$api_count" -gt 1 ]; then
	echo "ERROR: found $api_count inner API server processes; refusing to choose one arbitrarily." >&2
	for proc in /proc/[0-9]*; do
		[ -r "$proc/comm" ] || continue
		if [ "$(cat "$proc/comm" 2>/dev/null)" = "node" ]; then
			cmdline=$(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null || echo "")
			case "$cmdline" in
				*"/app/api/dist/index.js"*)
					echo "  candidate PID ${proc##*/}: $cmdline" >&2
					;;
			esac
		fi
	done
	exit 1
fi

pid="$api_pid"
echo "Found inner API server process: PID $pid"
echo "  cmdline: $api_cmdline"

if [ "$SELECT_ONLY" = true ]; then
	echo "SELECTED_PID=$pid"
	exit 0
fi

# --- verify the snapshot will land in the persistent directory ---
# start-combined.sh launches the inner API with CWD=/config/heap-snapshots so
# V8's --heapsnapshot-signal writes land on the persisted volume. Confirm the
# selected process still has that CWD; if not, warn (the snapshot may land
# elsewhere) but do not abort — the operator may have a custom layout.
proc_cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || echo "")
if [ -n "$proc_cwd" ] && [ "$proc_cwd" != "$SNAPSHOT_DIR" ]; then
	echo "WARNING: API process CWD is '$proc_cwd', not '$SNAPSHOT_DIR'." >&2
	echo "  The snapshot will be written to the process CWD, not the configured" >&2
	echo "  snapshot directory. Verify HEAP_SNAPSHOT_DIR / the launch CWD." >&2
fi

# --- verify NODE_OPTIONS has --heapsnapshot-signal=SIGUSR2 ---
# Without this flag, SIGUSR2 will be sent but Node will not write a
# snapshot. Catches the case where an operator overrode NODE_OPTIONS in
# their compose file (issue #427).
if [ -r "/proc/$pid/environ" ]; then
	node_options=$(tr '\0' '\n' < "/proc/$pid/environ" | grep '^NODE_OPTIONS=' | head -1 || true)
	case "$node_options" in
		*heapsnapshot-signal=SIGUSR2*)
			# Good — flag is set.
			;;
		"")
			echo "WARNING: NODE_OPTIONS not visible (cannot verify --heapsnapshot-signal)" >&2
			;;
		*)
			echo "ERROR: NODE_OPTIONS is set but does not include --heapsnapshot-signal=SIGUSR2" >&2
			echo "  Current: $node_options" >&2
			echo "  V8 will NOT write a snapshot on SIGUSR2. Restore the default Dockerfile NODE_OPTIONS or add the flag." >&2
			exit 1
			;;
	esac
fi

# --- snapshot the dir state BEFORE sending the signal ---
mkdir -p "$SNAPSHOT_DIR" 2>/dev/null || true
before_count=$(find "$SNAPSHOT_DIR" -maxdepth 1 -name '*.heapsnapshot' 2>/dev/null | wc -l | tr -d ' ')

echo "Snapshot dir: $SNAPSHOT_DIR (currently holds $before_count file(s))"
echo "Sending SIGUSR2..."
if ! kill -USR2 "$pid"; then
	echo "ERROR: kill -USR2 $pid failed — process may have exited" >&2
	exit 1
fi

# --- poll for new file ---
echo "Waiting up to ${POLL_TIMEOUT_SEC}s for V8 to finish writing snapshot..."
elapsed=0
while [ "$elapsed" -lt "$POLL_TIMEOUT_SEC" ]; do
	sleep "$POLL_INTERVAL_SEC"
	elapsed=$((elapsed + POLL_INTERVAL_SEC))
	after_count=$(find "$SNAPSHOT_DIR" -maxdepth 1 -name '*.heapsnapshot' 2>/dev/null | wc -l | tr -d ' ')
	if [ "$after_count" -gt "$before_count" ]; then
		# Find the newest matching file by mtime (BusyBox-portable).
		newest=""
		newest_mtime=0
		for f in "$SNAPSHOT_DIR"/*.heapsnapshot; do
			[ -f "$f" ] || continue
			# Use ls timestamps via stat fallback chain.
			mtime=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)
			if [ "$mtime" -gt "$newest_mtime" ]; then
				newest_mtime=$mtime
				newest=$f
			fi
		done
		size_bytes=$(wc -c < "$newest" 2>/dev/null || echo 0)
		size_mb=$((size_bytes / 1024 / 1024))
		echo ""
		echo "Snapshot captured (${elapsed}s):"
		echo "  Path: $newest"
		echo "  Size: ${size_mb} MB"
		echo ""
		echo "Retrieve from host:"
		basename=$(basename "$newest")
		echo "  docker cp <container>:$newest ./"
		echo "  # then gzip it before sharing: gzip $basename"
		exit 0
	fi
done

# --- timeout — surface diagnostics so the operator knows what to check ---
echo "" >&2
echo "TIMEOUT: no .heapsnapshot file appeared in ${POLL_TIMEOUT_SEC}s." >&2
echo "" >&2
echo "Diagnostics:" >&2
echo "  Snapshot dir:       $SNAPSHOT_DIR" >&2
echo "  Dir listing:        $(ls -ld "$SNAPSHOT_DIR" 2>&1 || echo 'unable to stat')" >&2
echo "  Process CWD:        $(readlink "/proc/$pid/cwd" 2>/dev/null || echo 'unable to read /proc/$pid/cwd')" >&2
echo "  Process still alive: $([ -d "/proc/$pid" ] && echo yes || echo NO — process exited)" >&2
if [ -r "/proc/$pid/environ" ]; then
	echo "  NODE_OPTIONS:       $(tr '\0' '\n' < /proc/$pid/environ | grep '^NODE_OPTIONS=' | head -1 || echo '(not set)')" >&2
fi
echo "" >&2
echo "If the process exited, set HEAP_AUTO_SNAPSHOT_AT_WARN=1 (default) and let heap-monitor auto-capture next time heap crosses 90%." >&2
exit 1
