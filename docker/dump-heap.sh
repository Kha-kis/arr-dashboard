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
# required.

set -eu

pid=""
for proc in /proc/[0-9]*; do
	[ -r "$proc/comm" ] || continue
	if [ "$(cat "$proc/comm" 2>/dev/null)" = "node" ]; then
		# Multiple node processes may be running (web + api). Match the
		# API's entry script in cmdline to pick the right one.
		cmdline=$(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null || echo "")
		case "$cmdline" in
			*"/app/api/dist/index.js"*|*"/app/api/dist/launcher.js"*)
				pid="${proc##*/}"
				break
				;;
		esac
	fi
done

if [ -z "$pid" ]; then
	echo "ERROR: could not find API node process under /proc." >&2
	echo "Tried matching 'node /app/api/dist/{index,launcher}.js'." >&2
	echo "Is the API actually running? Try: docker exec <container> ls /proc | head" >&2
	exit 1
fi

echo "Found API process: PID $pid"
echo "Sending SIGUSR2 — V8 will write a .heapsnapshot to /config/heap-snapshots/"
kill -USR2 "$pid"
echo ""
echo "The snapshot file may take a few seconds to finish writing (heap size dependent)."
echo "Once it appears, retrieve from your host with:"
echo "  docker cp <container>:/config/heap-snapshots/<filename> ./"
echo ""
echo "To list current snapshots:"
echo "  docker exec <container> ls -la /config/heap-snapshots/"
