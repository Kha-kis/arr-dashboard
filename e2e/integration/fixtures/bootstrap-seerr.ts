/**
 * Initialize Seerr through its supported authentication and settings APIs.
 *
 * Seerr 3.x does not grant an arbitrary API key first-admin authority. The
 * integration fixture therefore authenticates the real Jellyfin admin, uses
 * that session for administrative setup, and uses a local requester session
 * when creating pending requests.
 */

// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone fixture, not a cached Turbo task
const SEERR_URL = process.env.SEERR_EXTERNAL_URL ?? "http://localhost:5055";
// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone fixture, not a cached Turbo task
const RADARR_API_KEY = process.env.RADARR_API_KEY;

const JELLYFIN_ADMIN = {
	username: "e2e-admin",
	password: "E2eTestPass123!",
};

const REQUESTER = {
	email: "e2e-requester@example.invalid",
	username: "e2e-requester",
	password: "E2eRequesterPass123!",
};

const REQUEST_FIXTURES = [
	{ mediaId: 550, mediaType: "movie" as const },
	{ mediaId: 2316, mediaType: "tv" as const, seasons: [1] },
];

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): JsonRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} returned an unexpected response shape`);
	}
	return value as JsonRecord;
}

function asNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new Error(`${label} was not an integer`);
	}
	return value;
}

function asArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) {
		throw new Error(`${label} was not an array`);
	}
	return value;
}

class SeerrSession {
	private cookie = "";

	async request(path: string, init: RequestInit = {}): Promise<unknown> {
		const headers = new Headers(init.headers);
		headers.set("Accept", "application/json");
		if (init.body) headers.set("Content-Type", "application/json");
		if (this.cookie) headers.set("Cookie", this.cookie);

		const response = await fetch(`${SEERR_URL}/api/v1${path}`, {
			...init,
			headers,
		});

		const setCookie = response.headers.get("set-cookie");
		if (setCookie) this.cookie = setCookie.split(";", 1)[0];

		if (!response.ok) {
			throw new Error(`${init.method ?? "GET"} ${path} failed with HTTP ${response.status}`);
		}

		const text = await response.text();
		return text ? JSON.parse(text) : null;
	}

	post(path: string, body: JsonRecord): Promise<unknown> {
		return this.request(path, { method: "POST", body: JSON.stringify(body) });
	}
}

async function collectPaginatedResults(
	session: SeerrSession,
	path: string,
	label: string,
): Promise<unknown[]> {
	const take = 100;
	const results: unknown[] = [];
	let skip = 0;

	while (true) {
		const separator = path.includes("?") ? "&" : "?";
		const page = asRecord(
			await session.request(`${path}${separator}take=${take}&skip=${skip}`),
			label,
		);
		const batch = asArray(page.results, `${label} results`);
		const pageInfo = asRecord(page.pageInfo, `${label} page info`);
		const total = asNumber(pageInfo.results, `${label} total`);
		results.push(...batch);

		if (results.length >= total) return results;
		if (batch.length === 0) {
			throw new Error(`${label} pagination ended before all results were returned`);
		}
		skip += batch.length;
	}
}

async function authenticateAdmin(): Promise<SeerrSession> {
	const session = new SeerrSession();
	const publicSettings = asRecord(
		await session.request("/settings/public"),
		"Seerr public settings",
	);
	const initialConnection =
		publicSettings.initialized === true
			? {}
			: {
					hostname: "jellyfin",
					port: 8096,
					useSsl: false,
					urlBase: "",
					serverType: 2,
				};
	const user = asRecord(
		await session.post("/auth/jellyfin", {
			...JELLYFIN_ADMIN,
			...initialConnection,
		}),
		"Seerr Jellyfin authentication",
	);
	if (asNumber(user.id, "Seerr admin id") !== 1) {
		throw new Error("Seerr Jellyfin authentication did not establish the first admin");
	}
	return session;
}

async function ensureRadarr(admin: SeerrSession): Promise<void> {
	if (!RADARR_API_KEY) throw new Error("RADARR_API_KEY is required for Seerr bootstrap");

	const servers = asArray(await admin.request("/settings/radarr"), "Seerr Radarr settings");
	const exists = servers.some((server) => {
		const value = asRecord(server, "Seerr Radarr server");
		return value.hostname === "radarr" && value.port === 7878;
	});
	if (exists) return;

	await admin.post("/settings/radarr", {
		name: "E2E Radarr",
		hostname: "radarr",
		port: 7878,
		apiKey: RADARR_API_KEY,
		useSsl: false,
		baseUrl: "",
		activeProfileId: 1,
		activeProfileName: "Any",
		activeDirectory: "/config/media/movies",
		is4k: false,
		minimumAvailability: "released",
		isDefault: true,
	});
}

async function ensureRequester(admin: SeerrSession): Promise<number> {
	const users = await collectPaginatedResults(
		admin,
		`/user?q=${encodeURIComponent(REQUESTER.email)}`,
		"Seerr user lookup",
	);
	const existing = users.find((entry) => asRecord(entry, "Seerr user").email === REQUESTER.email);
	if (existing) return asNumber(asRecord(existing, "Seerr requester").id, "Seerr requester id");

	const created = asRecord(await admin.post("/user", REQUESTER), "Seerr requester creation");
	return asNumber(created.id, "Seerr requester id");
}

async function authenticateRequester(): Promise<SeerrSession> {
	const session = new SeerrSession();
	await session.post("/auth/local", {
		email: REQUESTER.email,
		password: REQUESTER.password,
	});
	return session;
}

function requestIdentity(request: unknown): {
	mediaId: number;
	mediaType: string;
	status: number;
	ownerId: number;
} {
	const value = asRecord(request, "Seerr request");
	const media = asRecord(value.media, "Seerr request media");
	const owner = asRecord(value.requestedBy, "Seerr request owner");
	return {
		mediaId: asNumber(media.tmdbId, "Seerr request TMDB id"),
		mediaType: String(value.type),
		status: asNumber(value.status, "Seerr request status"),
		ownerId: asNumber(owner.id, "Seerr request owner id"),
	};
}

async function ensurePendingRequests(requester: SeerrSession, requesterId: number): Promise<void> {
	let requests = await collectPaginatedResults(
		requester,
		`/request?requestedBy=${requesterId}`,
		"Seerr request lookup",
	);

	for (const fixture of REQUEST_FIXTURES) {
		const exists = requests.some((request) => {
			const identity = requestIdentity(request);
			return identity.mediaId === fixture.mediaId && identity.mediaType === fixture.mediaType;
		});
		if (!exists) {
			await requester.post("/request", fixture);
		}
	}

	requests = await collectPaginatedResults(
		requester,
		`/request?requestedBy=${requesterId}`,
		"Seerr request verification",
	);

	for (const fixture of REQUEST_FIXTURES) {
		const matching = requests
			.map(requestIdentity)
			.filter(
				(request) => request.mediaId === fixture.mediaId && request.mediaType === fixture.mediaType,
			);
		if (matching.length !== 1 || matching[0].status !== 1 || matching[0].ownerId !== requesterId) {
			throw new Error(
				`Seerr ${fixture.mediaType} fixture is not exactly one requester-owned pending request`,
			);
		}
	}
}

async function main(): Promise<void> {
	const admin = await authenticateAdmin();
	await ensureRadarr(admin);
	await admin.post("/settings/initialize", {});
	const requesterId = await ensureRequester(admin);
	const requester = await authenticateRequester();
	await ensurePendingRequests(requester, requesterId);
	process.stdout.write(
		`[bootstrap-seerr] Ready with requester ${requesterId} and two pending requests\nSEERR_TEST_USER_ID=${requesterId}\n`,
	);
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : "Unknown Seerr bootstrap error";
	process.stderr.write(`[bootstrap-seerr] ERROR: ${message}\n`);
	process.exitCode = 1;
});
