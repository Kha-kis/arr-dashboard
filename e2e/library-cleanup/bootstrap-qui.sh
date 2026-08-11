#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_NAME=${COMPOSE_PROJECT_NAME:?Set the unique live COMPOSE_PROJECT_NAME}
. "$SCRIPT_DIR/compose-command.sh"
PRIVATE_SUBNET=${HARNESS_SUBNET:-172.31.250.0/24}

cd "$SCRIPT_DIR"
sh ./validate-compose.sh --live-project "$PROJECT_NAME"

temporary_password() {
	service=$1
	password=$(compose logs --no-color "$service" |
		sed -n 's/.*temporary password is provided for this session: //p' |
		tail -n 1)
	if [ -z "$password" ]; then
		echo "Could not find the disposable qBittorrent password for $service." >&2
		exit 1
	fi
	printf '%s' "$password"
}

register_pair() {
	pair=$1
	qbit_password=$2
	upper_pair=$(printf '%s' "$pair" | tr '[:lower:]' '[:upper:]')

	compose exec -T -e QBIT_PASSWORD="$qbit_password" -e PRIVATE_SUBNET="$PRIVATE_SUBNET" dashboard-sqlite node -e '
		const [quiHost, qbitHost, name] = process.argv.slice(1);
		const login = await fetch(`${qbitHost}/api/v2/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ username: "admin", password: process.env.QBIT_PASSWORD }),
		});
		const cookie = login.headers.get("set-cookie")?.split(";")[0];
		if (![200, 204].includes(login.status) || !cookie) {
			throw new Error(`qBittorrent bootstrap login failed with HTTP ${login.status}`);
		}
		const preferences = await fetch(`${qbitHost}/api/v2/app/setPreferences`, {
			method: "POST",
			headers: {
				cookie,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				json: JSON.stringify({
					bypass_auth_subnet_whitelist_enabled: true,
					bypass_auth_subnet_whitelist: process.env.PRIVATE_SUBNET,
				}),
			}),
		});
		if (!preferences.ok) {
			throw new Error(`qBittorrent private-subnet setup failed with HTTP ${preferences.status}`);
		}
		const savedPreferences = await fetch(`${qbitHost}/api/v2/app/preferences`, {
			headers: { cookie },
		}).then((response) => response.json());
		if (
			savedPreferences.bypass_auth_subnet_whitelist_enabled !== true ||
			savedPreferences.bypass_auth_subnet_whitelist !== process.env.PRIVATE_SUBNET
		) {
			const subnetPreferences = Object.fromEntries(
				Object.entries(savedPreferences).filter(([key]) => key.includes("subnet")),
			);
			throw new Error(
				`qBittorrent did not persist the isolated subnet whitelist: ${JSON.stringify(subnetPreferences)}`,
			);
		}
		const unauthenticatedProbe = await fetch(`${qbitHost}/api/v2/app/webapiVersion`);
		if (!unauthenticatedProbe.ok) {
			throw new Error(
				`qBittorrent did not allow its isolated subnet after setup (HTTP ${unauthenticatedProbe.status})`,
			);
		}
		const request = async (path, init) => {
			const response = await fetch(`${quiHost}${path}`, init);
			const text = await response.text();
			if (!response.ok) {
				throw new Error(`${response.status} ${text.slice(0, 500)}`);
			}
			return text.length === 0 ? null : JSON.parse(text);
		};
		const instances = await request("/api/instances");
		const existing = instances.find((instance) => instance.host === qbitHost);
		const instance = await request(existing ? `/api/instances/${existing.id}` : "/api/instances", {
			method: existing ? "PUT" : "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name,
				host: qbitHost,
				username: "",
				password: "",
				tlsSkipVerify: false,
				hasLocalFilesystemAccess: true,
				useHardlinks: false,
				useReflinks: false,
				fallbackToRegularMode: false,
			}),
		});
		if (instance.hasLocalFilesystemAccess !== true) {
			throw new Error("qUI did not persist Local Filesystem Access");
		}
		let connectivity;
		for (let attempt = 0; attempt < 20; attempt += 1) {
			connectivity = await request(`/api/instances/${instance.id}/test`, { method: "POST" });
			if (connectivity.connected === true) break;
			if (!String(connectivity.error ?? "").includes("backoff period")) break;
			await new Promise((resolve) => setTimeout(resolve, 3000));
		}
		if (connectivity?.connected !== true) {
			throw new Error(`qUI connectivity test failed: ${connectivity?.error ?? "unknown error"}`);
		}
		console.log(`qUI ${name}: instance ${instance.id} is connected with local filesystem access`);
	' "http://qui-$pair:7476" "http://qbittorrent-$pair:8080" "Library Cleanup $upper_pair"
}

password_a=$(temporary_password qbittorrent-a)
password_b=$(temporary_password qbittorrent-b)

register_pair a "$password_a"
register_pair b "$password_b"

echo "qUI bootstrap completed without exposing disposable credentials."
