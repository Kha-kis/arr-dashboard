const DEFAULT_PORTS = Object.freeze({
	PLEX_PORT: 32400,
	TAUTULLI_PORT: 38181,
	TRACEARR_PORT: 33000,
	DASHBOARD_PORT: 33030,
	DASHBOARD_API_PORT: 33031,
});

/** @param {string} name @param {Record<string, string | undefined>} environment */
function resolvePort(name, environment) {
	const raw = environment[name] ?? String(DEFAULT_PORTS[name]);
	if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a numeric TCP port`);
	const port = Number(raw);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
		throw new Error(`${name} must be between 1 and 65535`);
	}
	return port;
}

/** @param {Record<string, string | undefined>} [environment] */
export function resolveHarnessEndpoints(environment = process.env) {
	return {
		plexUrl: `http://127.0.0.1:${resolvePort("PLEX_PORT", environment)}`,
		tautulliUrl: `http://127.0.0.1:${resolvePort("TAUTULLI_PORT", environment)}`,
		tracearrUrl: `http://127.0.0.1:${resolvePort("TRACEARR_PORT", environment)}`,
		dashboardUrl: `http://127.0.0.1:${resolvePort("DASHBOARD_PORT", environment)}`,
		dashboardApiUrl: `http://127.0.0.1:${resolvePort("DASHBOARD_API_PORT", environment)}`,
	};
}
