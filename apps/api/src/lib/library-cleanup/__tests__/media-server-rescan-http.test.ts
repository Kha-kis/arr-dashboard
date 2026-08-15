import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JellyfinClient } from "../../jellyfin/jellyfin-client.js";
import { PlexClient } from "../../plex/plex-client.js";
import {
	type OwnedProviderPublicationSnapshot,
	ProviderIdentityGuardError,
	withGuardedProviderPublication,
} from "../../services/provider-identity-guard.js";
import {
	type DecryptedOwnedServiceSnapshot,
	readProviderIdentity,
} from "../../services/service-identity.js";

const PLEX_TOKEN = "fixture-plex-token";
const JELLYFIN_TOKEN = "fixture-jellyfin-token";
const EMBY_TOKEN = "fixture-emby-token";
const TAUTULLI_TOKEN = "fixture-tautulli-token";
const PROXY_AUTH = `Basic ${Buffer.from("fixture-user:fixture-password").toString("base64")}`;

const log = {
	warn: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
} as never;

type TestServer = ReturnType<typeof createServer>;
type Route = "plex" | "jellyfin" | "emby" | "tautulli";
type Backend = "plexA" | "plexB" | "jellyfin" | "emby" | "tautulli";

type RecordedRequest = {
	backend: Backend;
	method: string;
	path: string;
	headers: IncomingHttpHeaders;
};

describe("media-server rescan HTTP contracts", () => {
	const servers: TestServer[] = [];

	afterEach(async () => {
		vi.unstubAllEnvs();
		await Promise.all(
			servers.splice(0).map(
				(server) =>
					new Promise<void>((resolve, reject) => {
						server.closeAllConnections();
						server.close((error) => (error ? reject(error) : resolve()));
					}),
			),
		);
	});

	it("uses production-compatible Plex and Jellyfin/Emby scan endpoints and authentication", async () => {
		const requests: IncomingMessage[] = [];
		const server = createServer((request, response) => {
			requests.push(request);
			if (request.method === "GET" && request.url === "/library/sections") {
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({
						MediaContainer: {
							offset: 0,
							size: 1,
							totalSize: 1,
							Directory: [{ key: "7", title: "Movies", type: "movie" }],
						},
					}),
				);
				return;
			}
			if (
				request.method === "POST" &&
				(request.url === "/library/sections/7/refresh" || request.url === "/Library/Refresh")
			) {
				response.statusCode = 204;
				response.end();
				return;
			}
			response.statusCode = 404;
			response.end();
		});
		const baseUrl = await listen(servers, server);

		const plex = new PlexClient(baseUrl, "plex-token", log);
		const jellyfin = new JellyfinClient(baseUrl, "jellyfin-token", log);
		const [section] = await plex.getLibrarySections();
		await plex.refreshSection(section!.key);
		await jellyfin.refreshLibrary();

		expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
			"GET /library/sections",
			"POST /library/sections/7/refresh",
			"POST /Library/Refresh",
		]);
		expect(requests[0]!.headers["x-plex-token"]).toBe("plex-token");
		expect(requests[1]!.headers["x-plex-token"]).toBe("plex-token");
		expect(requests[2]!.headers.authorization).toContain('Token="jellyfin-token"');
	});

	it("reads all provider identities through the proxy with their production auth contracts", async () => {
		const fixture = await createIdentityFixture(servers);
		const observations = [];
		for (const service of ["PLEX", "JELLYFIN", "EMBY", "TAUTULLI"] as const) {
			observations.push(
				await readProviderIdentity(identitySnapshot(service, fixture.urlFor(service)), log),
			);
		}

		expect(observations.map(({ service, rawIdentity }) => [service, rawIdentity])).toEqual([
			["PLEX", "plex-machine-a"],
			["JELLYFIN", "jellyfin-server-a"],
			["EMBY", "emby-server-a"],
			["TAUTULLI", "tautulli-pms-a"],
		]);
		expect(fixture.requests.map(({ backend, method, path }) => [backend, method, path])).toEqual([
			["plexA", "GET", "/identity"],
			["jellyfin", "GET", "/System/Info"],
			["emby", "GET", "/System/Info"],
			["tautulli", "GET", "/api/v2?apikey=fixture-tautulli-token&cmd=get_server_info"],
		]);
		expect(fixture.requests[0]!.headers).toMatchObject({
			authorization: PROXY_AUTH,
			"x-plex-token": PLEX_TOKEN,
		});
		expect(fixture.requests[1]!.headers.authorization).toContain(
			`MediaBrowser Token="${JELLYFIN_TOKEN}"`,
		);
		expect(fixture.requests[2]!.headers).toMatchObject({
			authorization: PROXY_AUTH,
			"x-emby-token": EMBY_TOKEN,
		});
		expect(fixture.requests[2]!.headers["x-emby-authorization"]).toContain(`Token="${EMBY_TOKEN}"`);
		expect(fixture.requests[3]!.headers.authorization).toBe(PROXY_AUTH);
	});

	it("rejects a stable Plex wrong-server route without changing enrollment or publishing", async () => {
		const fixture = await createIdentityFixture(servers);
		fixture.routeTo("plex", "plexB");
		const authority = publicationSnapshot(fixture.urlFor("PLEX"));
		const state = publicationState(authority);
		let collected = false;

		const failure = await captureFailure(() =>
			withGuardedProviderPublication(
				state.prisma,
				authority,
				log,
				async () => {
					collected = true;
					return { rows: ["must-not-publish"] };
				},
				async (_tx, snapshot) => {
					state.published.push(snapshot);
					return snapshot;
				},
			),
		);

		expect(failure).toMatchObject({ code: "IDENTITY_MISMATCH" });
		expect(collected).toBe(false);
		expect(state.published).toEqual([]);
		expect(fixture.requests.map(({ backend }) => backend)).toEqual(["plexB"]);
		expect(state.row).toMatchObject({
			expectedIdentity: "plex-machine-a",
			identityStatus: "MISMATCH",
		});
		expectSanitizedFailure(failure);
	});

	it("rejects a Plex route switch between identity reads without publishing the snapshot", async () => {
		const fixture = await createIdentityFixture(servers);
		fixture.switchRoute("plex", ["plexA", "plexB"]);
		const authority = publicationSnapshot(fixture.urlFor("PLEX"));
		const state = publicationState(authority);
		const collected = { rows: ["collected-under-plex-a"] };
		let collectionCount = 0;

		const failure = await captureFailure(() =>
			withGuardedProviderPublication(
				state.prisma,
				authority,
				log,
				async () => {
					collectionCount += 1;
					return collected;
				},
				async (_tx, snapshot) => {
					state.published.push(snapshot);
					return snapshot;
				},
			),
		);

		expect(
			fixture.requests
				.filter(({ backend }) => backend.startsWith("plex"))
				.map(({ backend }) => backend),
		).toEqual(["plexA", "plexB"]);
		expect(failure).toMatchObject({ code: "IDENTITY_MISMATCH" });
		expect(collectionCount).toBe(1);
		expect(state.published).toEqual([]);
		expect(state.row).toMatchObject({
			expectedIdentity: "plex-machine-a",
			identityStatus: "MISMATCH",
		});
		expectSanitizedFailure(failure);
	});
});

async function listen(servers: TestServer[], server: TestServer): Promise<string> {
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
}

async function createIdentityFixture(servers: TestServer[]) {
	const requests: RecordedRequest[] = [];
	const backendUrls = {} as Record<Backend, string>;
	for (const backend of ["plexA", "plexB", "jellyfin", "emby", "tautulli"] as const) {
		backendUrls[backend] = await listen(
			servers,
			createServer((request, response) =>
				handleProviderRequest(backend, request, response, requests),
			),
		);
	}

	const normalRoutes: Record<Route, Backend> = {
		plex: "plexA",
		jellyfin: "jellyfin",
		emby: "emby",
		tautulli: "tautulli",
	};
	const routeOverrides = new Map<Route, Backend>();
	const routeSwitches = new Map<Route, Backend[]>();
	const proxyUrl = await listen(
		servers,
		createServer(async (request, response) => {
			const incomingUrl = new URL(request.url ?? "/", "http://proxy.invalid");
			const [, routePart, ...pathParts] = incomingUrl.pathname.split("/");
			if (!isRoute(routePart)) return respond(response, 404, { error: "unknown route" });
			if (routePart !== "jellyfin" && request.headers.authorization !== PROXY_AUTH) {
				return respond(response, 401, { error: "proxy auth required" });
			}

			const switchedBackend = routeSwitches.get(routePart)?.shift();
			const backend = switchedBackend ?? routeOverrides.get(routePart) ?? normalRoutes[routePart];
			const upstreamPath = `/${pathParts.join("/")}${incomingUrl.search}`;
			const upstream = await fetch(`${backendUrls[backend]}${upstreamPath}`, {
				method: request.method,
				headers: forwardHeaders(request.headers),
			});
			response.statusCode = upstream.status;
			const contentType = upstream.headers.get("content-type");
			if (contentType) response.setHeader("content-type", contentType);
			response.end(await upstream.text());
		}),
	);

	return {
		requests,
		urlFor(service: DecryptedOwnedServiceSnapshot["service"]) {
			return `${proxyUrl}/${service.toLowerCase()}`;
		},
		routeTo(route: Route, backend: Backend) {
			routeOverrides.set(route, backend);
		},
		switchRoute(route: Route, backends: Backend[]) {
			routeSwitches.set(route, [...backends]);
		},
	};
}

function handleProviderRequest(
	backend: Backend,
	request: IncomingMessage,
	response: ServerResponse,
	requests: RecordedRequest[],
) {
	requests.push({
		backend,
		method: request.method ?? "GET",
		path: request.url ?? "/",
		headers: request.headers,
	});
	const url = new URL(request.url ?? "/", "http://backend.invalid");
	if (backend === "plexA" || backend === "plexB") {
		if (
			url.pathname !== "/identity" ||
			request.headers.authorization !== PROXY_AUTH ||
			request.headers["x-plex-token"] !== PLEX_TOKEN
		) {
			return respond(response, 401, { error: "unauthorized" });
		}
		return respond(response, 200, {
			MediaContainer: {
				machineIdentifier: backend === "plexA" ? "plex-machine-a" : "plex-machine-b",
				version: "1.41.0",
			},
		});
	}
	if (backend === "jellyfin") {
		if (
			url.pathname !== "/System/Info" ||
			!request.headers.authorization?.includes(`Token="${JELLYFIN_TOKEN}"`)
		) {
			return respond(response, 401, { error: "unauthorized" });
		}
		return respond(response, 200, {
			Id: "jellyfin-server-a",
			ServerName: "Fixture Jellyfin",
			Version: "10.10.0",
			OperatingSystem: "Linux",
		});
	}
	if (backend === "emby") {
		if (
			url.pathname !== "/System/Info" ||
			request.headers.authorization !== PROXY_AUTH ||
			request.headers["x-emby-token"] !== EMBY_TOKEN ||
			!request.headers["x-emby-authorization"]?.includes(`Token="${EMBY_TOKEN}"`)
		) {
			return respond(response, 401, { error: "unauthorized" });
		}
		return respond(response, 200, {
			Id: "emby-server-a",
			ServerName: "Fixture Emby",
			Version: "4.8.0",
			OperatingSystem: "Linux",
		});
	}
	if (
		url.pathname !== "/api/v2" ||
		url.searchParams.get("apikey") !== TAUTULLI_TOKEN ||
		url.searchParams.get("cmd") !== "get_server_info" ||
		request.headers.authorization !== PROXY_AUTH
	) {
		return respond(response, 401, { error: "unauthorized" });
	}
	return respond(response, 200, {
		response: {
			result: "success",
			message: null,
			data: { pms_identifier: "tautulli-pms-a", pms_name: "Fixture Tautulli" },
		},
	});
}

function respond(response: ServerResponse, status: number, body: unknown) {
	response.statusCode = status;
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify(body));
}

function forwardHeaders(headers: IncomingHttpHeaders): Record<string, string> {
	const forwarded: Record<string, string> = {};
	for (const name of [
		"accept",
		"authorization",
		"x-plex-token",
		"x-emby-token",
		"x-emby-authorization",
	]) {
		const value = headers[name];
		if (typeof value === "string") forwarded[name] = value;
	}
	return forwarded;
}

function isRoute(value: string | undefined): value is Route {
	return value === "plex" || value === "jellyfin" || value === "emby" || value === "tautulli";
}

function identitySnapshot(
	service: DecryptedOwnedServiceSnapshot["service"],
	baseUrl: string,
): DecryptedOwnedServiceSnapshot {
	const apiKeys = {
		PLEX: PLEX_TOKEN,
		JELLYFIN: JELLYFIN_TOKEN,
		EMBY: EMBY_TOKEN,
		TAUTULLI: TAUTULLI_TOKEN,
	};
	return {
		service,
		baseUrl,
		apiKey: apiKeys[service],
		label: `Fixture ${service}`,
		...(service === "JELLYFIN" ? {} : { httpAuthHeaders: { Authorization: PROXY_AUTH } }),
	};
}

function publicationSnapshot(baseUrl: string): OwnedProviderPublicationSnapshot {
	return {
		...identitySnapshot("PLEX", baseUrl),
		id: "plex-fixture",
		userId: "fixture-user",
		service: "PLEX",
		enabled: true,
		encryptedApiKey: "fixture-encrypted-key",
		encryptionIv: "fixture-key-iv",
		encryptedHttpAuthCredentials: "fixture-encrypted-proxy-auth",
		httpAuthEncryptionIv: "fixture-proxy-iv",
		expectedIdentity: "plex-machine-a",
		identityStatus: "VERIFIED",
		connectionGeneration: 3,
		identityGeneration: 5,
	};
}

function publicationState(authority: OwnedProviderPublicationSnapshot) {
	const row = { ...authority };
	const published: unknown[] = [];
	const matches = (where: Record<string, unknown>) =>
		Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value);
	const tx = {
		libraryCleanupConfig: {
			upsert: async () => ({ id: "cleanup-fixture" }),
			findUnique: async () => ({ id: "cleanup-fixture", runClaimToken: null }),
		},
		serviceInstance: {
			findFirst: async ({ where }: { where: Record<string, unknown> }) =>
				matches(where) ? { ...row } : null,
			updateMany: async ({
				where,
				data,
			}: {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				if (!matches(where)) return { count: 0 };
				Object.assign(row, data);
				return { count: 1 };
			},
		},
	};
	return {
		row,
		published,
		prisma: {
			$transaction: async (action: (transaction: typeof tx) => Promise<unknown>) =>
				await action(tx),
		} as never,
	};
}

async function captureFailure(action: () => Promise<unknown>): Promise<ProviderIdentityGuardError> {
	try {
		await action();
	} catch (error) {
		expect(error).toBeInstanceOf(ProviderIdentityGuardError);
		return error as ProviderIdentityGuardError;
	}
	throw new Error("Expected provider publication to fail closed");
}

function expectSanitizedFailure(error: ProviderIdentityGuardError) {
	for (const sensitiveValue of [
		"plex-machine-a",
		"plex-machine-b",
		PLEX_TOKEN,
		PROXY_AUTH,
		"fixture-user",
		"fixture-password",
	]) {
		expect(error.message).not.toContain(sensitiveValue);
	}
}
