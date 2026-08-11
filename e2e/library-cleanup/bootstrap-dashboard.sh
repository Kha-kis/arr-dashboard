#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -z "${COMPOSE_PROJECT_NAME:-}" ] && [ -f "$SCRIPT_DIR/.env" ]; then
	COMPOSE_PROJECT_NAME=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$SCRIPT_DIR/.env" | tail -n 1)
	export COMPOSE_PROJECT_NAME
fi
PROJECT_NAME=${COMPOSE_PROJECT_NAME:?Set the unique live COMPOSE_PROJECT_NAME}
if [ -z "${ARR_DOCKER_BIN:-}" ]; then
	DOCKER_CONFIG=${DOCKER_CONFIG:-/tmp/lc-e2e-docker-config}
	export DOCKER_CONFIG
fi
. "$SCRIPT_DIR/compose-command.sh"
. "$SCRIPT_DIR/live-project-guard.sh"
DASHBOARD_SERVICE=${LC_E2E_DASHBOARD_SERVICE:-dashboard-sqlite}
case "$DASHBOARD_SERVICE" in
	dashboard-sqlite | dashboard-postgres) ;;
	*)
		echo "Unsupported disposable dashboard service: $DASHBOARD_SERVICE" >&2
		exit 1
		;;
esac

cd "$SCRIPT_DIR"
sh ./validate-compose.sh --live-project "$PROJECT_NAME"
acquire_live_project_lock
verify_live_project

extract_api_key() {
	service=$1
	key=$(compose exec -T "$service" sh -c \
		"sed -n 's:.*<ApiKey>\\([^<]*\\)</ApiKey>.*:\\1:p' /config/config.xml" |
		tail -n 1)
	if [ -z "$key" ]; then
		echo "Could not read the disposable API key from $service." >&2
		exit 1
	fi
	printf '%s' "$key"
}

radarr_a_key=$(extract_api_key radarr-a)
radarr_b_key=$(extract_api_key radarr-b)
sonarr_a_key=$(extract_api_key sonarr-a)
sonarr_b_key=$(extract_api_key sonarr-b)

compose exec -T \
	-e RADARR_A_KEY="$radarr_a_key" \
	-e RADARR_B_KEY="$radarr_b_key" \
	-e SONARR_A_KEY="$sonarr_a_key" \
	-e SONARR_B_KEY="$sonarr_b_key" \
	-e LC_E2E_SKIP_CONNECTION_TESTS="${LC_E2E_SKIP_CONNECTION_TESTS:-0}" \
	"$DASHBOARD_SERVICE" node -e '
		const apiBase = "http://127.0.0.1:3001";
		const username = "gauntlet-admin";
		const password = "LibraryCleanupGauntlet2026!";

		const parseResponse = async (response) => {
			const text = await response.text();
			if (!response.ok) {
				throw new Error(`${response.status} ${text.slice(0, 800)}`);
			}
			return text.length === 0 ? null : JSON.parse(text);
		};

		const setup = await fetch(`${apiBase}/auth/setup-required`).then(parseResponse);
		const authResponse = await fetch(`${apiBase}/auth/${setup.required ? "register" : "login"}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username, password, rememberMe: false }),
		});
		const cookie = authResponse.headers.get("set-cookie")?.split(";")[0];
		await parseResponse(authResponse);
		if (!cookie) throw new Error("Dashboard authentication did not return a session cookie");

		const request = async (path, init = {}) =>
			await fetch(`${apiBase}${path}`, {
				...init,
				headers: {
					cookie,
					...(init.body ? { "content-type": "application/json" } : {}),
					...init.headers,
				},
			}).then(parseResponse);

		const storageGroupId = "lc-e2e-shared-media";
		const desired = [
			{
				label: "Library Cleanup Radarr HD",
				baseUrl: "http://radarr-a:7878",
				externalUrl: "http://127.0.0.1:17878",
				apiKey: process.env.RADARR_A_KEY,
				service: "radarr",
				isDefault: true,
			},
			{
				label: "Library Cleanup Radarr UHD",
				baseUrl: "http://radarr-b:7878",
				externalUrl: "http://127.0.0.1:27878",
				apiKey: process.env.RADARR_B_KEY,
				service: "radarr",
				isDefault: false,
			},
			{
				label: "Library Cleanup Sonarr HD",
				baseUrl: "http://sonarr-a:8989",
				externalUrl: "http://127.0.0.1:18989",
				apiKey: process.env.SONARR_A_KEY,
				service: "sonarr",
				isDefault: true,
			},
			{
				label: "Library Cleanup Sonarr UHD",
				baseUrl: "http://sonarr-b:8989",
				externalUrl: "http://127.0.0.1:28989",
				apiKey: process.env.SONARR_B_KEY,
				service: "sonarr",
				isDefault: false,
			},
			{
				label: "Library Cleanup Plex",
				baseUrl: "http://plex:33240",
				externalUrl: "http://127.0.0.1:32400",
				apiKey: "lc-e2e-local",
				service: "plex",
				isDefault: true,
			},
			{
				label: "Library Cleanup qUI A",
				baseUrl: "http://qui-a:7476",
				externalUrl: "http://127.0.0.1:17476",
				apiKey: "lc-e2e-qui-a-key",
				service: "qui",
				isDefault: true,
				hasLocalFilesystemAccess: true,
			},
			{
				label: "Library Cleanup qUI B",
				baseUrl: "http://qui-b:7476",
				externalUrl: "http://127.0.0.1:27476",
				apiKey: "lc-e2e-qui-b-key",
				service: "qui",
				isDefault: false,
				hasLocalFilesystemAccess: true,
			},
		].map((service) => ({
			...service,
			enabled: true,
			tags: [],
			storageGroupId,
			hasLocalFilesystemAccess: service.hasLocalFilesystemAccess ?? false,
			pathPrefix: null,
		}));

		const existing = (await request("/api/services")).services;
		const configured = [];
		for (const payload of desired) {
			const current = existing.find((service) => service.label === payload.label);
			const currentMatches =
				current &&
				current.baseUrl === payload.baseUrl &&
				current.externalUrl === payload.externalUrl &&
				String(current.service).toLowerCase() === payload.service &&
				current.isDefault === payload.isDefault &&
				current.enabled === payload.enabled &&
				current.storageGroupId === payload.storageGroupId &&
				current.hasLocalFilesystemAccess === payload.hasLocalFilesystemAccess &&
				current.pathPrefix === payload.pathPrefix;
			const response = currentMatches
				? { service: current }
				: current
					? await request(`/api/services/${current.id}`, {
						method: "PUT",
						body: JSON.stringify(payload),
						})
					: await request("/api/services", {
							method: "POST",
							body: JSON.stringify(payload),
						});
			configured.push(response.service);
		}

		if (process.env.LC_E2E_SKIP_CONNECTION_TESTS !== "1") {
			for (const service of configured) {
				const test = await request(`/api/services/${service.id}/test`, {
					method: "POST",
					body: JSON.stringify({}),
				});
				if (test.success !== true) {
					throw new Error(`${service.label} connection test failed: ${test.error ?? "unknown"}`);
				}
			}
		}

		const arrServices = configured.filter((service) =>
			["radarr", "sonarr"].includes(String(service.service).toLowerCase()),
		);
		const syncBaselines = new Map(
			(await request("/api/library/sync/status")).instances.map((status) => [
				status.instanceId,
				status.syncStatus.lastFullSync,
			]),
		);
		for (const service of arrServices) {
			await request(`/api/library/sync/${service.id}`, { method: "POST" });
		}

		for (let attempt = 0; attempt < 40; attempt += 1) {
			const statuses = (await request("/api/library/sync/status")).instances;
			const selected = statuses.filter((status) =>
				arrServices.some((service) => service.id === status.instanceId),
			);
			if (
				selected.length === arrServices.length &&
				selected.every(
					(status) =>
						status.syncStatus.syncInProgress === false &&
						status.syncStatus.lastError == null &&
						status.syncStatus.lastFullSync != null &&
						status.syncStatus.lastFullSync !== syncBaselines.get(status.instanceId),
				)
			) {
				const summary = await request("/api/qui/summary");
				if (summary.configuredInstances !== 2 || summary.totalTorrents !== 4) {
					throw new Error(
						`Expected 2 qUI instances and 4 fixture torrents, got ${summary.configuredInstances} and ${summary.totalTorrents}`,
					);
				}
				const backfill = await request("/api/qui/backfill/run-now", {
					method: "POST",
					body: JSON.stringify({}),
				});
				if (backfill.errors !== 0) {
					throw new Error(`qUI correlation backfill reported ${backfill.errors} errors`);
				}
				const plexService = configured.find(
					(service) => String(service.service).toLowerCase() === "plex",
				);
				if (!plexService) throw new Error("Disposable Plex service was not configured");
				const plexRefresh = await request(`/api/plex/cache/${plexService.id}/refresh`, {
					method: "POST",
					body: JSON.stringify({}),
				});
				if (plexRefresh.upserted < 2) {
					throw new Error(`Plex cache indexed only ${plexRefresh.upserted} fixture titles`);
				}
				console.log(
					`Dashboard bootstrap complete: ${configured.length} services ${process.env.LC_E2E_SKIP_CONNECTION_TESTS === "1" ? "configured" : "verified"}, 4 torrents visible, ${backfill.rowsHashed} rows newly correlated, ${plexRefresh.upserted} Plex titles cached`,
				);
				process.exit(0);
			}
			await new Promise((resolve) => setTimeout(resolve, 3000));
		}
		throw new Error("Dashboard library sync did not finish within the bootstrap budget");
	'

echo "Disposable dashboard account: gauntlet-admin"
echo "Dashboard bootstrap completed without exposing service credentials."
