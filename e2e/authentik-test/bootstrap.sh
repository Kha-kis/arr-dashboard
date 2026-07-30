#!/usr/bin/env bash
# Bootstrap a real Authentik provider for the OIDC account-linking E2E test.
#
# Run through `pnpm e2e:authentik:up`, which pins the isolated Compose
# project name before this script makes any API changes.
#
# The issuer uses Authentik's container IP so both the host-run Playwright
# browser and the arr-dashboard container can resolve the same canonical URL.
# This harness is intended for Linux hosts and Linux CI runners.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.test"

COMPOSE_PROJECT="arr-dashboard-authentik-e2e"
AUTHENTIK_CONTAINER="authentik-test-server"
AUTHENTIK_TOKEN="e2e-test-api-token"
ARR_DASHBOARD_URL="http://localhost:${DASHBOARD_PORT:-3000}"
ADMIN_USERNAME="akadmin"
ADMIN_PASSWORD="TestPassword123!"
APP_SLUG="arr-dashboard-test"
CLIENT_ID="arr-dashboard-e2e-test"
CLIENT_SECRET="e2e-test-secret-value"

log() {
	echo "[authentik-bootstrap] $*"
}

fail() {
	echo "[authentik-bootstrap] ERROR: $*" >&2
	exit 1
}

require_value() {
	local label="$1"
	local value="$2"
	[ -n "$value" ] || fail "Could not resolve ${label}"
}

urlencode() {
	jq -rn --arg value "$1" '$value | @uri'
}

CONTAINER_METADATA="$(docker inspect "$AUTHENTIK_CONTAINER")"
ACTUAL_PROJECT="$(
	jq -er '.[0].Config.Labels["com.docker.compose.project"]' <<<"$CONTAINER_METADATA"
)"
ACTUAL_SERVICE="$(
	jq -er '.[0].Config.Labels["com.docker.compose.service"]' <<<"$CONTAINER_METADATA"
)"

[ "$ACTUAL_PROJECT" = "$COMPOSE_PROJECT" ] ||
	fail "${AUTHENTIK_CONTAINER} belongs to Compose project ${ACTUAL_PROJECT}, not ${COMPOSE_PROJECT}"
[ "$ACTUAL_SERVICE" = "authentik-server" ] ||
	fail "${AUTHENTIK_CONTAINER} is service ${ACTUAL_SERVICE}, not authentik-server"

AUTHENTIK_IP="$(
	jq -er '.[0].NetworkSettings.Networks | to_entries[0].value.IPAddress' \
		<<<"$CONTAINER_METADATA"
)"
AUTHENTIK_URL="http://${AUTHENTIK_IP}:9000"

api() {
	local path="$1"
	shift
	curl -fsS \
		-H "Authorization: Bearer ${AUTHENTIK_TOKEN}" \
		-H "Content-Type: application/json" \
		"$@" \
		"${AUTHENTIK_URL}${path}"
}

log "Waiting for Authentik at ${AUTHENTIK_URL}"
for attempt in $(seq 1 60); do
	if curl -fsS "${AUTHENTIK_URL}/-/health/ready/" >/dev/null 2>&1; then
		break
	fi
	[ "$attempt" -lt 60 ] || fail "Authentik did not become ready"
	sleep 2
done

log "Waiting for arr-dashboard at ${ARR_DASHBOARD_URL}"
for attempt in $(seq 1 60); do
	if curl -fsS "${ARR_DASHBOARD_URL}/health" >/dev/null 2>&1; then
		break
	fi
	[ "$attempt" -lt 60 ] || fail "arr-dashboard did not become ready"
	sleep 2
done

log "Resolving Authentik OAuth defaults"
FLOWS="$(api "/api/v3/flows/instances/?pagination=false")"
AUTHORIZATION_FLOW="$(
	jq -er '.results[] | select(.slug == "default-provider-authorization-implicit-consent") | .pk' \
		<<<"$FLOWS"
)"
INVALIDATION_FLOW="$(
	jq -er '.results[] | select(.slug == "default-provider-invalidation-flow") | .pk' \
		<<<"$FLOWS"
)"
SIGNING_KEY="$(
	api "/api/v3/crypto/certificatekeypairs/?pagination=false" |
		jq -er '.results[0].pk'
)"
PROPERTY_MAPPINGS="$(
	api "/api/v3/propertymappings/all/?pagination=false" |
		jq -cer '
			[
				.results[]
				| select(
					.managed == "goauthentik.io/providers/oauth2/scope-openid"
					or .managed == "goauthentik.io/providers/oauth2/scope-email"
					or .managed == "goauthentik.io/providers/oauth2/scope-profile"
				)
				| .pk
			]
			| if length == 3 then . else error("missing default OIDC scope mappings") end
		'
)"

require_value "authorization flow" "$AUTHORIZATION_FLOW"
require_value "invalidation flow" "$INVALIDATION_FLOW"
require_value "signing key" "$SIGNING_KEY"
require_value "OIDC property mappings" "$PROPERTY_MAPPINGS"

log "Removing an existing test application, if present"
ENCODED_APP_SLUG="$(urlencode "$APP_SLUG")"
APPLICATIONS="$(api "/api/v3/core/applications/?slug=${ENCODED_APP_SLUG}")"
EXACT_APPLICATIONS="$(
	jq -c --arg slug "$APP_SLUG" '[.results[] | select(.slug == $slug)]' \
		<<<"$APPLICATIONS"
)"
APPLICATION_COUNT="$(jq -r 'length' <<<"$EXACT_APPLICATIONS")"
[ "$APPLICATION_COUNT" -le 1 ] ||
	fail "Found ${APPLICATION_COUNT} applications with exact slug ${APP_SLUG}"
if [ "$APPLICATION_COUNT" -eq 1 ]; then
	EXISTING_APP="$(jq -er '.[0].slug' <<<"$EXACT_APPLICATIONS")"
	api "/api/v3/core/applications/$(urlencode "$EXISTING_APP")/" -X DELETE >/dev/null
fi

PROVIDER_NAME="${APP_SLUG}-provider"
ENCODED_PROVIDER_NAME="$(urlencode "$PROVIDER_NAME")"
PROVIDERS="$(api "/api/v3/providers/oauth2/?name=${ENCODED_PROVIDER_NAME}")"
EXACT_PROVIDERS="$(
	jq -c --arg name "$PROVIDER_NAME" '[.results[] | select(.name == $name)]' \
		<<<"$PROVIDERS"
)"
PROVIDER_COUNT="$(jq -r 'length' <<<"$EXACT_PROVIDERS")"
[ "$PROVIDER_COUNT" -le 1 ] ||
	fail "Found ${PROVIDER_COUNT} providers with exact name ${PROVIDER_NAME}"
if [ "$PROVIDER_COUNT" -eq 1 ]; then
	EXISTING_PROVIDER="$(jq -er '.[0].pk' <<<"$EXACT_PROVIDERS")"
	api "/api/v3/providers/oauth2/${EXISTING_PROVIDER}/" -X DELETE >/dev/null
fi

REDIRECT_URI="${ARR_DASHBOARD_URL}/auth/oidc/callback"
PROVIDER_PAYLOAD="$(
	jq -cn \
		--arg name "$PROVIDER_NAME" \
		--arg authorization_flow "$AUTHORIZATION_FLOW" \
		--arg invalidation_flow "$INVALIDATION_FLOW" \
		--arg client_id "$CLIENT_ID" \
		--arg client_secret "$CLIENT_SECRET" \
		--arg redirect_uri "$REDIRECT_URI" \
		--arg signing_key "$SIGNING_KEY" \
		--argjson property_mappings "$PROPERTY_MAPPINGS" \
		'{
			name: $name,
			authorization_flow: $authorization_flow,
			invalidation_flow: $invalidation_flow,
			client_type: "confidential",
			grant_types: ["authorization_code", "refresh_token"],
			client_id: $client_id,
			client_secret: $client_secret,
			redirect_uris: [{matching_mode: "strict", url: $redirect_uri}],
			signing_key: $signing_key,
			property_mappings: $property_mappings,
			access_token_validity: "hours=1",
			sub_mode: "user_username",
			include_claims_in_id_token: true
		}'
)"

log "Creating OAuth2/OpenID provider"
PROVIDER="$(
	api "/api/v3/providers/oauth2/" \
		-X POST \
		--data "$PROVIDER_PAYLOAD"
)"
PROVIDER_PK="$(jq -er '.pk' <<<"$PROVIDER")"

log "Creating Authentik application"
APPLICATION_PAYLOAD="$(
	jq -cn \
		--arg name "$APP_SLUG" \
		--arg slug "$APP_SLUG" \
		--argjson provider "$PROVIDER_PK" \
		'{name: $name, slug: $slug, provider: $provider}'
)"
api "/api/v3/core/applications/" \
	-X POST \
	--data "$APPLICATION_PAYLOAD" >/dev/null

DISCOVERY_URL="${AUTHENTIK_URL}/application/o/${APP_SLUG}/.well-known/openid-configuration"
DISCOVERY="$(curl -fsS "$DISCOVERY_URL")"
ISSUER_URL="$(jq -er '.issuer' <<<"$DISCOVERY")"
EXPECTED_ISSUER="${AUTHENTIK_URL}/application/o/${APP_SLUG}/"

[ "$ISSUER_URL" = "$EXPECTED_ISSUER" ] ||
	fail "Discovery issuer ${ISSUER_URL} did not match ${EXPECTED_ISSUER}"

jq -e '
	.token_endpoint_auth_methods_supported
	| index("client_secret_basic") != null
' <<<"$DISCOVERY" >/dev/null ||
	fail "Authentik discovery does not advertise client_secret_basic"

cat >"$ENV_FILE" <<EOF
AUTHENTIK_ISSUER_URL=$ISSUER_URL
AUTHENTIK_CLIENT_ID=$CLIENT_ID
AUTHENTIK_CLIENT_SECRET=$CLIENT_SECRET
AUTHENTIK_ADMIN_USERNAME=$ADMIN_USERNAME
AUTHENTIK_ADMIN_PASSWORD=$ADMIN_PASSWORD
AUTHENTIK_URL=$AUTHENTIK_URL
ARR_DASHBOARD_URL=$ARR_DASHBOARD_URL
EOF

log "OIDC provider ready; wrote ${ENV_FILE}"
