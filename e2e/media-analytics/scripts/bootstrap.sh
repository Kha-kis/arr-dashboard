#!/usr/bin/env bash

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${SCRIPT_DIR}/common.sh"
source "${SCRIPT_DIR}/wait-for-services.sh"

STATE_DIR="${HARNESS_DIR}/.state"
RUNTIME_ENV="${STATE_DIR}/runtime.env"
BOOTSTRAP_JSON="${STATE_DIR}/bootstrap.json"
TRACEARR_COOKIE_JAR="${STATE_DIR}/tracearr-cookie.jar"
DASHBOARD_COOKIE_JAR="${STATE_DIR}/dashboard-cookie.jar"

local_plex_instruction() {
	cat >&2 <<'EOF'
Local Plex mode cannot complete the real provider connection flow with this
upstream version. Re-run once with invocation-only PLEX_CLAIM=claim-... and
PLEX_TOKEN=... values: PLEX_CLAIM=claim-... PLEX_TOKEN=... pnpm
e2e:media-analytics:reset; neither value is persisted.
EOF
}

load_runtime_env() {
	local mode owner
	if [[ ! -f "$RUNTIME_ENV" ]]; then
		echo "runtime state was not generated" >&2
		return 1
	fi
	mode="$(stat -c '%a' "$RUNTIME_ENV")"
	owner="$(stat -c '%u' "$RUNTIME_ENV")"
	if [[ "$mode" != "600" || "$owner" != "$(id -u)" ]]; then
		echo "refusing unsafe runtime state file permissions" >&2
		return 1
	fi
	# The generator writes only fixed shell assignments with hexadecimal values.
	# shellcheck disable=SC1090
	source "$RUNTIME_ENV"
	export TRACEARR_JWT_SECRET TRACEARR_COOKIE_SECRET TRACEARR_DB_PASSWORD TAUTULLI_API_KEY
}

curl_json() {
	curl -fsS -H 'Accept: application/json' "$@"
}

require_json() {
	local expression="$1"
	local payload="$2"
	jq -e "$expression" >/dev/null <<< "$payload"
}

read_plex_machine_identifier() {
	local plex_url="$1"
	local attempts="${PLEX_IDENTITY_ATTEMPTS:-30}"
	local interval_seconds="${PLEX_IDENTITY_INTERVAL_SECONDS:-2}"
	local attempt plex_identity plex_machine_identifier

	for ((attempt = 1; attempt <= attempts; attempt++)); do
		plex_identity="$(curl_json "${plex_url}/identity" 2>/dev/null || true)"
		plex_machine_identifier="$(jq -er '.MediaContainer.machineIdentifier // empty' <<< "$plex_identity" 2>/dev/null || true)"
		if [[ -n "$plex_machine_identifier" ]]; then
			printf '%s' "$plex_machine_identifier"
			return 0
		fi
		if ((attempt < attempts)); then
			sleep "$interval_seconds"
		fi
	done

	echo "Plex identity did not include a machine identifier after $attempts attempts" >&2
	return 1
}

discover_plex_library_agent() {
	local plex_url="$1"
	local plex_token="$2"
	local agents agent

	agents="$(curl -fsS -H "X-Plex-Token: ${plex_token}" "${plex_url}/system/agents?mediaType=1")"
	agent="$(sed -n 's/.*identifier="\([^"]*\)".*/\1/p' <<< "$agents" | head -n 1)"
	if [[ -z "$agent" ]]; then
		echo "Plex did not report a supported movie library agent" >&2
		return 1
	fi
	printf '%s' "$agent"
}

create_dashboard_service() {
	local dashboard_api_url="$1"
	local service="$2"
	local label="$3"
	local base_url="$4"
	local api_key="$5"
	local response service_id

	response="$(curl_json -b "$DASHBOARD_COOKIE_JAR" -X POST "${dashboard_api_url}/api/services" \
		-H 'Content-Type: application/json' \
		--data "$(jq -cn --arg label "$label" --arg baseUrl "$base_url" --arg apiKey "$api_key" --arg service "$service" '{label:$label,baseUrl:$baseUrl,apiKey:$apiKey,service:$service}')")"
	service_id="$(jq -er '.service.id' <<< "$response")"
	printf '%s' "$service_id"
}

assert_dashboard_connection() {
	local dashboard_api_url="$1"
	local service_name="$2"
	local service_id="$3"
	local response

	if ! response="$(curl_json -b "$DASHBOARD_COOKIE_JAR" -X POST "${dashboard_api_url}/api/services/${service_id}/test" -H 'Content-Type: application/json' --data '{}')"; then
		echo "arr-dashboard connection test request failed for ${service_name}" >&2
		return 1
	fi
	if ! require_json '.success == true' "$response"; then
		echo "arr-dashboard connection test failed for ${service_name}" >&2
		return 1
	fi
}

"${SCRIPT_DIR}/generate-secrets.sh"
load_runtime_env
rm -f "$BOOTSTRAP_JSON" "$TRACEARR_COOKIE_JAR" "$DASHBOARD_COOKIE_JAR"
trap 'rm -f "$TRACEARR_COOKIE_JAR" "$DASHBOARD_COOKIE_JAR"' EXIT

mode="local"
plex_client_token="$PLEX_LOCAL_TOKEN"
if [[ -n "${PLEX_CLAIM:-}" ]]; then
	if [[ -z "${PLEX_TOKEN:-}" ]]; then
		echo "claimed Plex mode requires invocation-only PLEX_TOKEN" >&2
		exit 1
	fi
	mode="claimed"
	plex_client_token="$PLEX_TOKEN"
elif [[ -n "${PLEX_TOKEN:-}" ]]; then
	echo "PLEX_TOKEN requires invocation-only PLEX_CLAIM" >&2
	exit 1
fi

export PLEX_CLAIM
export TAUTULLI_FIRST_RUN_COMPLETE=1
export TAUTULLI_PMS_TOKEN="$plex_client_token"
export TAUTULLI_PMS_IDENTIFIER=""
export TAUTULLI_PMS_IP=plex
export TAUTULLI_PMS_PORT=32400
export TAUTULLI_PMS_URL_MANUAL=1
export TAUTULLI_PMS_SSL=0
export TAUTULLI_API_ENABLED=1
export TAUTULLI_API_KEY

plex_url="http://127.0.0.1:${PLEX_PORT:-32400}"
tautulli_url="http://127.0.0.1:${TAUTULLI_PORT:-38181}"
tracearr_url="http://127.0.0.1:${TRACEARR_PORT:-33000}"
dashboard_url="http://127.0.0.1:${DASHBOARD_PORT:-33030}"
dashboard_api_url="http://127.0.0.1:${DASHBOARD_API_PORT:-33031}"

compose up -d plex
wait_for_http "Plex" "${plex_url}/identity" 200 "${READINESS_ATTEMPTS:-30}" "${READINESS_INTERVAL_SECONDS:-2}"
plex_machine_identifier="$(read_plex_machine_identifier "$plex_url")"
export TAUTULLI_PMS_IDENTIFIER="$plex_machine_identifier"

if [[ "$mode" == "claimed" ]]; then
	plex_library_agent="$(discover_plex_library_agent "$plex_url" "$plex_client_token")"
	if ! curl -fsS -G -X POST "${plex_url}/library/sections" \
		-H "X-Plex-Token: ${plex_client_token}" \
		--data-urlencode 'name=Synthetic Test' \
		--data-urlencode 'type=1' \
		--data-urlencode "agent=${plex_library_agent}" \
		--data-urlencode 'language=en-US' \
		--data-urlencode 'locations=/data' >/dev/null; then
		echo "Plex authenticated library setup failed" >&2
		exit 1
	fi
fi

compose up -d tautulli tracearr tracearr-db tracearr-redis arr-dashboard
wait_for_media_analytics_services

tautulli_status="$(curl_json "${tautulli_url}/api/v2?apikey=${TAUTULLI_API_KEY}&cmd=server_status")"
if ! require_json '.response.data.connected == true' "$tautulli_status"; then
	if [[ "$mode" == "local" ]]; then
		local_plex_instruction
	fi
	echo "Tautulli did not report a connected Plex server" >&2
	exit 1
fi

tracearr_setup="$(curl_json "${tracearr_url}/api/v1/setup/status")"
if ! require_json '.needsSetup == true and .requiresClaimCode == false' "$tracearr_setup"; then
	echo "Tracearr did not report the expected initial setup state" >&2
	exit 1
fi

curl_json -c "$TRACEARR_COOKIE_JAR" -X POST "${tracearr_url}/api/v1/auth/sign-up/email" \
	-H 'Content-Type: application/json' \
	--data "$(jq -cn --arg password "$DASHBOARD_ADMIN_PASSWORD" '{username:"media-analytics",email:"media-analytics@example.test",name:"Media Analytics",password:$password}')" >/dev/null
chmod 0600 "$TRACEARR_COOKIE_JAR"

if ! curl_json -b "$TRACEARR_COOKIE_JAR" -X POST "${tracearr_url}/api/v1/servers" \
	-H 'Content-Type: application/json' \
	--data "$(jq -cn --arg token "$plex_client_token" '{type:"plex",name:"E2E Plex",url:"http://plex:32400",token:$token}')" >/dev/null; then
	if [[ "$mode" == "local" ]]; then
		local_plex_instruction
	fi
	echo "Tracearr Plex server setup failed" >&2
	exit 1
fi

tracearr_key_response="$(curl_json -b "$TRACEARR_COOKIE_JAR" -X POST "${tracearr_url}/api/v1/settings/api-key/regenerate")"
tracearr_api_key="$(jq -er '.token | select(startswith("trr_pub_"))' <<< "$tracearr_key_response")"
curl_json "${tracearr_url}/api/v2/public/docs" -H "Authorization: Bearer ${tracearr_api_key}" >/dev/null

curl_json -c "$DASHBOARD_COOKIE_JAR" -X POST "${dashboard_api_url}/auth/register" \
	-H 'Content-Type: application/json' \
	--data "$(jq -cn --arg password "$DASHBOARD_ADMIN_PASSWORD" '{username:"media-analytics",password:$password,rememberMe:false}')" >/dev/null
curl_json -b "$DASHBOARD_COOKIE_JAR" -c "$DASHBOARD_COOKIE_JAR" -X POST "${dashboard_api_url}/auth/login" \
	-H 'Content-Type: application/json' \
	--data "$(jq -cn --arg password "$DASHBOARD_ADMIN_PASSWORD" '{username:"media-analytics",password:$password,rememberMe:false}')" >/dev/null
chmod 0600 "$DASHBOARD_COOKIE_JAR"

plex_service_id="$(create_dashboard_service "$dashboard_api_url" plex 'E2E Plex' 'http://plex:32400' "$plex_client_token")"
tautulli_service_id="$(create_dashboard_service "$dashboard_api_url" tautulli 'E2E Tautulli' 'http://tautulli:8181' "$TAUTULLI_API_KEY")"
tracearr_service_id="$(create_dashboard_service "$dashboard_api_url" tracearr 'E2E Tracearr' 'http://tracearr:3000' "$tracearr_api_key")"

if ! assert_dashboard_connection "$dashboard_api_url" Plex "$plex_service_id"; then
	if [[ "$mode" == "local" ]]; then
		local_plex_instruction
	fi
	exit 1
fi
assert_dashboard_connection "$dashboard_api_url" Tautulli "$tautulli_service_id"
assert_dashboard_connection "$dashboard_api_url" Tracearr "$tracearr_service_id"

cat > "$BOOTSTRAP_JSON" <<EOF
{"schemaVersion":1,"serviceMode":"${mode}","plexIdentityObserved":true,"tautulliConnected":true,"tracearrConnected":true,"arrDashboardConnectionsVerified":true}
EOF
chmod 0600 "$BOOTSTRAP_JSON"
