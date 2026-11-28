import { createServer, type Server } from "node:http";
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { Encryptor } from "../../lib/auth/encryption.js";
import { registerNowPlayingRoutes as registerJellyfinNowPlayingRoutes } from "../jellyfin/now-playing-routes.js";
import { registerNowPlayingRoutes as registerPlexNowPlayingRoutes } from "../plex/now-playing-routes.js";

type Provider = "plex" | "jellyfin";

type TestInstance = {
	id: string;
	userId: string;
	service: "PLEX" | "JELLYFIN";
	enabled: true;
	label: string;
	baseUrl: string;
	encryptedApiKey: string;
	encryptionIv: string;
	encryptedHttpAuthCredentials: null;
	httpAuthEncryptionIv: null;
	identityStatus: "VERIFIED";
	expectedIdentity: string;
	identityKind: string;
	connectionGeneration: 0;
	identityGeneration: 0;
};

function createInstance(provider: Provider, baseUrl: string, encryptor: Encryptor): TestInstance {
	const service = provider === "plex" ? "PLEX" : "JELLYFIN";
	const encrypted = encryptor.encrypt("synthetic-token");
	return {
		id: `${provider}-loopback`,
		userId: "owner",
		service,
		enabled: true,
		label: `${provider} loopback`,
		baseUrl,
		encryptedApiKey: encrypted.value,
		encryptionIv: encrypted.iv,
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		identityStatus: "VERIFIED",
		expectedIdentity: `${provider}-loopback-identity`,
		identityKind: `${service}_IDENTIFIER`,
		connectionGeneration: 0,
		identityGeneration: 0,
	};
}

async function startLoopbackServer(provider: Provider, payload?: unknown) {
	let requestCount = 0;
	const server = createServer((_request, response) => {
		requestCount += 1;
		if (requestCount === 1) {
			response.statusCode = 503;
			response.end("synthetic upstream outage");
			return;
		}

		response.statusCode = 200;
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify(
				payload ?? (provider === "plex" ? { MediaContainer: { size: 0, Metadata: [] } } : []),
			),
		);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") {
		await closeServer(server);
		throw new Error("Loopback server did not expose a TCP address");
	}

	return {
		server,
		get requestCount() {
			return requestCount;
		},
		baseUrl: `http://127.0.0.1:${address.port}`,
	};
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
}

async function buildApp(
	provider: Provider,
	baseUrl: string,
	encryptor: Encryptor,
	register: FastifyPluginAsync,
): Promise<FastifyInstance> {
	const instance = createInstance(provider, baseUrl, encryptor);
	const app = Fastify({ logger: false });
	app.decorate("prisma", {
		serviceInstance: {
			findMany: async () => [instance],
			findFirst: async () => instance,
		},
	} as never);
	app.decorate("encryptor", encryptor as never);
	app.addHook("preHandler", async (request) => {
		request.currentUser = { id: "owner" } as never;
	});
	await app.register(register);
	await app.ready();
	return app;
}

describe("now-playing loopback transport recovery", () => {
	const servers: Server[] = [];
	const apps: FastifyInstance[] = [];

	afterEach(async () => {
		await Promise.all(apps.map((app) => app.close()));
		await Promise.all(servers.map((server) => closeServer(server)));
		apps.length = 0;
		servers.length = 0;
	});

	it("preserves native Plex quality and separates known zero from missing stream rates", async () => {
		const row = {
			sessionKey: "synthetic-session",
			ratingKey: "synthetic-item",
			title: "Synthetic movie",
			type: "movie",
			User: { id: 1, title: "Synthetic viewer", thumb: "" },
			Player: { title: "Synthetic player", state: "playing" },
			Media: [
				{
					selected: 1,
					videoCodec: "h264",
					audioCodec: "aac",
					videoResolution: "1080",
					Part: [{ selected: 1, decision: "directplay" }],
				},
			],
		};
		const loopback = await startLoopbackServer("plex", {
			MediaContainer: {
				size: 2,
				Metadata: [
					{ ...row, Session: { id: "synthetic-native-session", bandwidth: 0 } },
					{ ...row, sessionKey: "synthetic-two" },
				],
			},
		});
		servers.push(loopback.server);
		const app = await buildApp(
			"plex",
			loopback.baseUrl,
			new Encryptor("a".repeat(32)),
			registerPlexNowPlayingRoutes,
		);
		apps.push(app);
		await app.inject({ method: "GET", url: "/" });
		const result = await app.inject({ method: "GET", url: "/" });
		expect(result.statusCode).toBe(200);
		expect(result.json()).toMatchObject({
			availability: { status: "complete" },
			bandwidthBasis: "provider-reported",
			bandwidthCoverage: {
				status: "partial",
				observedSessions: 2,
				measuredSessions: 1,
				knownTotalKbps: 0,
			},
			sessions: [
				{
					bandwidth: 0,
					videoDecision: "direct play",
					videoCodec: "h264",
					audioCodec: "aac",
					videoResolution: "1080",
				},
				{ videoDecision: "direct play" },
			],
		});
		expect(result.json().sessions[1]).not.toHaveProperty("bandwidth");
	});

	it("does not fabricate Jellyfin decisions from missing flags or discard an explicit zero bitrate", async () => {
		const item = { Id: "synthetic-item", Name: "Synthetic movie", Type: "Movie" };
		const loopback = await startLoopbackServer("jellyfin", [
			{ Id: "synthetic-one", NowPlayingItem: item },
			{ Id: "synthetic-two", NowPlayingItem: item, TranscodingInfo: { Bitrate: 0 } },
			{
				Id: "synthetic-three",
				NowPlayingItem: item,
				PlayState: { PlayMethod: "DirectStream" },
				TranscodingInfo: {
					IsVideoDirect: true,
					IsAudioDirect: false,
					Bitrate: 1234500,
					Width: 1920,
					Height: 1080,
					AudioCodec: "aac",
				},
			},
		]);
		servers.push(loopback.server);
		const app = await buildApp(
			"jellyfin",
			loopback.baseUrl,
			new Encryptor("a".repeat(32)),
			registerJellyfinNowPlayingRoutes,
		);
		apps.push(app);
		await app.inject({ method: "GET", url: "/" });
		const result = await app.inject({ method: "GET", url: "/" });
		expect(result.statusCode).toBe(200);
		expect(result.json()).toMatchObject({
			availability: { status: "complete" },
			bandwidthBasis: "encoding-estimate",
			bandwidthCoverage: {
				status: "partial",
				observedSessions: 3,
				measuredSessions: 2,
				knownTotalKbps: 1234.5,
			},
			sessions: [
				{ videoDecision: "unknown", audioDecision: "unknown" },
				{ videoDecision: "unknown", audioDecision: "unknown", bandwidth: 0 },
				{
					videoDecision: "copy",
					audioDecision: "transcode",
					bandwidth: 1234.5,
					videoResolution: "1920x1080",
				},
			],
		});
		expect(result.json().sessions[0]).not.toHaveProperty("bandwidth");
	});

	it.each([
		["plex", "Plex now-playing is unavailable", registerPlexNowPlayingRoutes],
		["jellyfin", "Jellyfin now-playing is unavailable", registerJellyfinNowPlayingRoutes],
	] as const)(
		"maps a loopback 503 to unavailable, then recovers to a complete healthy-empty read",
		async (provider, error, register) => {
			const encryptor = new Encryptor("a".repeat(32));
			const loopback = await startLoopbackServer(provider);
			servers.push(loopback.server);
			const app = await buildApp(provider, loopback.baseUrl, encryptor, register);
			apps.push(app);

			const failed = await app.inject({ method: "GET", url: "/" });
			expect(failed.statusCode).toBe(503);
			expect(failed.json()).toEqual({
				error,
				availability: { status: "unavailable", configuredSources: 1, availableSources: 0 },
			});
			expect(failed.body).not.toContain("synthetic upstream outage");

			const recovered = await app.inject({ method: "GET", url: "/" });
			expect(recovered.statusCode).toBe(200);
			expect(recovered.json()).toMatchObject({
				sessions: [],
				availability: { status: "complete", configuredSources: 1, availableSources: 1 },
			});
			expect(loopback.requestCount).toBe(2);
		},
	);
});
