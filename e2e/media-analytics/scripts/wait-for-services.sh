#!/usr/bin/env bash

set -euo pipefail

wait_for_http() {
	local name="$1"
	local url="$2"
	local expected_status="$3"
	local attempts="$4"
	local interval_seconds="$5"
	local attempt status

	for ((attempt = 1; attempt <= attempts; attempt++)); do
		status="$(curl -sS -o /dev/null -w '%{http_code}' "$url" || true)"
		if [[ "$status" == "$expected_status" ]]; then
			return 0
		fi
		if ((attempt < attempts)); then
			sleep "$interval_seconds"
		fi
	done

	echo "$name did not become ready with HTTP $expected_status after $attempts attempts" >&2
	return 1
}

wait_for_media_analytics_services() {
	local plex_port="${PLEX_PORT:-32400}"
	local tautulli_port="${TAUTULLI_PORT:-38181}"
	local tracearr_port="${TRACEARR_PORT:-33000}"
	local dashboard_port="${DASHBOARD_PORT:-33030}"
	local attempts="${READINESS_ATTEMPTS:-30}"
	local interval_seconds="${READINESS_INTERVAL_SECONDS:-2}"

	wait_for_http "Plex" "http://127.0.0.1:${plex_port}/identity" 200 "$attempts" "$interval_seconds"
	wait_for_http "Tautulli" "http://127.0.0.1:${tautulli_port}/status" 200 "$attempts" "$interval_seconds"
	wait_for_http "Tracearr" "http://127.0.0.1:${tracearr_port}/health" 200 "$attempts" "$interval_seconds"
	wait_for_http "Tracearr setup API" "http://127.0.0.1:${tracearr_port}/api/v1/setup/status" 200 "$attempts" "$interval_seconds"
	wait_for_http "arr-dashboard" "http://127.0.0.1:${dashboard_port}/health" 200 "$attempts" "$interval_seconds"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	if [[ "$#" == "5" ]]; then
		wait_for_http "$@"
	else
		wait_for_media_analytics_services
	fi
fi
