import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerNowPlayingRoutes as registerJellyfinNowPlayingRoutes } from "../jellyfin/now-playing-routes.js";
import { registerNowPlayingRoutes as registerPlexNowPlayingRoutes } from "../plex/now-playing-routes.js";
import { registerActivityRoutes as registerTautulliActivityRoutes } from "../tautulli/activity-routes.js";

const mocks = vi.hoisted(() => ({
	createJellyfinClient: vi.fn(),
	createPlexClient: vi.fn(),
	createTautulliClient: vi.fn(),
}));

vi.mock("../../lib/jellyfin/jellyfin-client.js", () => ({
	createJellyfinClient: mocks.createJellyfinClient,
}));
vi.mock("../../lib/plex/plex-client.js", () => ({
	createPlexClient: mocks.createPlexClient,
}));
vi.mock("../../lib/tautulli/tautulli-client.js", () => ({
	createTautulliClient: mocks.createTautulliClient,
}));

type Source = {
	id: string;
	userId: string;
	service: string;
	enabled: boolean;
	label: string;
	baseUrl: string;
	encryptedApiKey: string;
	encryptionIv: string;
	identityStatus: string;
	expectedIdentity: string | null;
	identityKind: string;
	connectionGeneration: number;
	identityGeneration: number;
};

function source(id: string, service: string, overrides: Partial<Source> = {}): Source {
	return {
		id,
		userId: "owner",
		service,
		enabled: true,
		label: `Source ${id}`,
		baseUrl: `http://${id}.invalid`,
		encryptedApiKey: "encrypted",
		encryptionIv: "iv",
		identityStatus: "VERIFIED",
		expectedIdentity: `${service}-${id}`,
		identityKind: `${service}_IDENTIFIER`,
		connectionGeneration: 0,
		identityGeneration: 0,
		...overrides,
	};
}

function matches(sourceItem: Source, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, value]) => {
		if (typeof value === "object" && value !== null) {
			if ("in" in value && Array.isArray(value.in)) {
				return value.in.includes(sourceItem[key as keyof Source]);
			}
			if ("not" in value) return sourceItem[key as keyof Source] !== value.not;
		}
		return sourceItem[key as keyof Source] === value;
	});
}

function createPrisma(sources: Source[]) {
	return {
		serviceInstance: {
			findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
				sources.filter((item) => matches(item, where)),
			),
			findFirst: vi.fn(
				async ({ where }: { where: Record<string, unknown> }) =>
					sources.find((item) => matches(item, where)) ?? null,
			),
		},
	};
}

async function buildApp(
	register: FastifyPluginAsync,
	sources: Source[],
	onReady?: (prisma: ReturnType<typeof createPrisma>) => void,
): Promise<FastifyInstance> {
	const app = Fastify({ logger: false });
	const prisma = createPrisma(sources);
	app.decorate("prisma", prisma as never);
	app.decorate("encryptor", {} as never);
	app.addHook("preHandler", async (request) => {
		request.currentUser = { id: "owner" } as never;
	});
	await app.register(register);
	await app.ready();
	onReady?.(prisma);
	return app;
}

const plexSession = {
	sessionKey: "session-1",
	ratingKey: "rating-1",
	title: "Synthetic Movie",
	grandparentTitle: undefined,
	type: "movie",
	user: { id: 1, title: "viewer" },
	player: { title: "Player", platform: "Web", product: "Browser", state: "playing" },
	state: "playing" as const,
	viewOffset: 100,
	duration: 200,
	videoDecision: "directplay",
	audioDecision: "directplay",
	bandwidth: 500,
	thumb: undefined,
};

const jellyfinSession = {
	id: "session-1",
	userName: "viewer",
	client: "Browser",
	deviceName: "Laptop",
	isPaused: false,
	positionMs: 100,
	durationMs: 200,
	playMethod: "DirectPlay",
	nowPlayingItem: { id: "item-1", name: "Synthetic Movie", type: "Movie", imageTags: {} },
};

const tautulliActivity = {
	stream_count: "1",
	total_bandwidth: 500,
	lan_bandwidth: 500,
	wan_bandwidth: 0,
	sessions: [
		{
			session_key: "session-1",
			rating_key: "rating-1",
			title: "Synthetic Movie",
			grandparent_title: "",
			media_type: "movie",
			friendly_name: "viewer",
			user: "viewer",
			player: "Browser",
			platform: "Web",
			product: "Browser",
			state: "playing",
			progress_percent: "50",
			transcode_decision: "direct play",
			stream_video_decision: "direct play",
			stream_audio_decision: "direct play",
			video_resolution: "1080",
			audio_codec: "aac",
			video_codec: "h264",
			bandwidth: "500",
			location: "lan",
			thumb: undefined,
		},
	],
};

describe("now-playing availability", () => {
	let apps: FastifyInstance[] = [];

	beforeEach(() => {
		mocks.createJellyfinClient.mockReset();
		mocks.createPlexClient.mockReset();
		mocks.createTautulliClient.mockReset();
	});

	afterEach(async () => {
		await Promise.all(apps.map((app) => app.close()));
		apps = [];
	});

	it.each([
		["Plex", registerPlexNowPlayingRoutes, "PLEX", "Plex now-playing is unavailable"],
		[
			"Jellyfin",
			registerJellyfinNowPlayingRoutes,
			"JELLYFIN",
			"Jellyfin now-playing is unavailable",
		],
	] as const)(
		"returns generic 503 when every %s source read fails",
		async (_name, register, service, error) => {
			const sources = [source("one", service), source("two", service)];
			const method = service === "PLEX" ? "getSessions" : "getSessions";
			const factory = service === "PLEX" ? mocks.createPlexClient : mocks.createJellyfinClient;
			factory.mockImplementation(() => ({
				[method]: vi.fn().mockRejectedValue(new Error("secret")),
			}));
			const app = await buildApp(register, sources);
			apps.push(app);

			const response = await app.inject({ method: "GET", url: "/" });

			expect(response.statusCode).toBe(503);
			expect(response.json()).toEqual({
				error,
				availability: { status: "unavailable", configuredSources: 2, availableSources: 0 },
			});
			expect(response.body).not.toContain("secret");
		},
	);

	it("keeps successful Plex sessions and reports partial coverage", async () => {
		const sources = [source("one", "PLEX"), source("two", "PLEX")];
		mocks.createPlexClient.mockImplementation((_encryptor, instance: Source) => ({
			getSessions:
				instance.id === "one"
					? vi.fn().mockResolvedValue([plexSession])
					: vi.fn().mockRejectedValue(new Error("secret")),
		}));
		const app = await buildApp(registerPlexNowPlayingRoutes, sources);
		apps.push(app);

		const response = await app.inject({ method: "GET", url: "/" });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			sessions: [expect.objectContaining({ sessionKey: "session-1" })],
			totalBandwidth: 500,
			availability: { status: "partial", configuredSources: 2, availableSources: 1 },
		});
	});

	it("distinguishes configured-empty Plex from no configured sources", async () => {
		const healthy = [source("one", "PLEX")];
		mocks.createPlexClient.mockReturnValue({ getSessions: vi.fn().mockResolvedValue([]) });
		const healthyApp = await buildApp(registerPlexNowPlayingRoutes, healthy);
		apps.push(healthyApp);
		const healthyResponse = await healthyApp.inject({ method: "GET", url: "/" });
		expect(healthyResponse.statusCode).toBe(200);
		expect(healthyResponse.json()).toMatchObject({
			sessions: [],
			availability: { status: "complete", configuredSources: 1, availableSources: 1 },
		});

		const absent = [
			source("disabled", "PLEX", { enabled: false }),
			source("foreign", "PLEX", { userId: "other" }),
		];
		const absentApp = await buildApp(registerPlexNowPlayingRoutes, absent);
		apps.push(absentApp);
		const absentResponse = await absentApp.inject({ method: "GET", url: "/" });
		expect(absentResponse.statusCode).toBe(200);
		expect(absentResponse.json()).toEqual({
			sessions: [],
			totalBandwidth: 0,
			availability: { status: "not-configured", configuredSources: 0, availableSources: 0 },
		});
	});

	it("keeps successful Jellyfin sessions and reports partial coverage", async () => {
		const sources = [source("one", "JELLYFIN"), source("two", "EMBY")];
		mocks.createJellyfinClient.mockImplementation((_encryptor, instance: Source) => ({
			getSessions:
				instance.id === "one"
					? vi.fn().mockResolvedValue([jellyfinSession])
					: vi.fn().mockRejectedValue(new Error("secret")),
		}));
		const app = await buildApp(registerJellyfinNowPlayingRoutes, sources);
		apps.push(app);

		const response = await app.inject({ method: "GET", url: "/" });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			sessions: [expect.objectContaining({ sessionId: "session-1" })],
			totalBandwidth: 0,
			availability: { status: "partial", configuredSources: 2, availableSources: 1 },
		});
	});

	it("reports no configured Jellyfin/Emby sources without calling a client", async () => {
		const sources = [
			source("disabled", "JELLYFIN", { enabled: false }),
			source("foreign", "EMBY", { userId: "other" }),
		];
		const app = await buildApp(registerJellyfinNowPlayingRoutes, sources);
		apps.push(app);

		const response = await app.inject({ method: "GET", url: "/" });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			sessions: [],
			availability: { status: "not-configured", configuredSources: 0, availableSources: 0 },
		});
		expect(mocks.createJellyfinClient).not.toHaveBeenCalled();
	});

	it("distinguishes configured-empty Jellyfin from no configured sources", async () => {
		mocks.createJellyfinClient.mockReturnValue({ getSessions: vi.fn().mockResolvedValue([]) });
		const healthyApp = await buildApp(registerJellyfinNowPlayingRoutes, [
			source("one", "JELLYFIN"),
		]);
		apps.push(healthyApp);
		const healthyResponse = await healthyApp.inject({ method: "GET", url: "/" });

		expect(healthyResponse.statusCode).toBe(200);
		expect(healthyResponse.json()).toMatchObject({
			sessions: [],
			availability: { status: "complete", configuredSources: 1, availableSources: 1 },
		});
	});

	it("reports Tautulli partial coverage while excluding enabled unverified sources", async () => {
		const sources = [
			source("verified", "TAUTULLI"),
			source("unverified", "TAUTULLI", { identityStatus: "UNVERIFIED", expectedIdentity: null }),
		];
		mocks.createTautulliClient.mockReturnValue({
			getActivity: vi.fn().mockResolvedValue(tautulliActivity),
		});
		const app = await buildApp(registerTautulliActivityRoutes, sources);
		apps.push(app);

		const response = await app.inject({ method: "GET", url: "/" });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			sessions: [expect.objectContaining({ sessionKey: "session-1" })],
			streamCount: 1,
			availability: { status: "partial", configuredSources: 2, availableSources: 1 },
		});
	});

	it("returns generic 503 when every Tautulli source read fails", async () => {
		const sources = [source("one", "TAUTULLI"), source("two", "TAUTULLI")];
		mocks.createTautulliClient.mockReturnValue({
			getActivity: vi.fn().mockRejectedValue(new Error("secret")),
		});
		const app = await buildApp(registerTautulliActivityRoutes, sources);
		apps.push(app);

		const response = await app.inject({ method: "GET", url: "/" });

		expect(response.statusCode).toBe(503);
		expect(response.json()).toEqual({
			error: "Tautulli activity is unavailable",
			availability: { status: "unavailable", configuredSources: 2, availableSources: 0 },
		});
		expect(response.body).not.toContain("secret");
	});

	it("returns unavailable for Tautulli when post-read identity changes", async () => {
		const sources = [source("one", "TAUTULLI")];
		mocks.createTautulliClient.mockReturnValue({
			getActivity: vi.fn().mockImplementation(async () => {
				sources[0] = { ...sources[0]!, connectionGeneration: 1 };
				return tautulliActivity;
			}),
		});
		const app = await buildApp(registerTautulliActivityRoutes, sources);
		apps.push(app);

		const response = await app.inject({ method: "GET", url: "/" });

		expect(response.statusCode).toBe(503);
		expect(response.json()).toEqual({
			error: "Tautulli activity is unavailable",
			availability: { status: "unavailable", configuredSources: 1, availableSources: 0 },
		});
	});

	it("aggregates only sources captured as configured at the start of the read", async () => {
		const sources = [source("one", "TAUTULLI")];
		mocks.createTautulliClient.mockImplementation((_encryptor, instance: Source) => ({
			getActivity: vi.fn().mockResolvedValue({
				...tautulliActivity,
				sessions: tautulliActivity.sessions.map((session) => ({
					...session,
					title: `Synthetic ${instance.id}`,
				})),
			}),
		}));
		const app = await buildApp(registerTautulliActivityRoutes, sources, (prisma) => {
			const findMany = prisma.serviceInstance.findMany;
			const lookup = findMany.getMockImplementation()!;
			let calls = 0;
			findMany.mockImplementation(async (args) => {
				calls += 1;
				if (calls === 2) sources.push(source("added", "TAUTULLI"));
				return lookup(args);
			});
		});
		apps.push(app);

		const response = await app.inject({ method: "GET", url: "/" });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			sessions: [expect.objectContaining({ title: "Synthetic one" })],
			availability: { status: "complete", configuredSources: 1, availableSources: 1 },
		});
		expect(response.json().sessions).toHaveLength(1);
	});

	it("returns complete healthy-empty Tautulli and not-configured separately", async () => {
		const healthy = [source("one", "TAUTULLI")];
		mocks.createTautulliClient.mockReturnValue({
			getActivity: vi
				.fn()
				.mockResolvedValue({ ...tautulliActivity, stream_count: "0", sessions: [] }),
		});
		const healthyApp = await buildApp(registerTautulliActivityRoutes, healthy);
		apps.push(healthyApp);
		const healthyResponse = await healthyApp.inject({ method: "GET", url: "/" });
		expect(healthyResponse.statusCode).toBe(200);
		expect(healthyResponse.json()).toMatchObject({
			sessions: [],
			availability: { status: "complete", configuredSources: 1, availableSources: 1 },
		});

		const absentApp = await buildApp(registerTautulliActivityRoutes, []);
		apps.push(absentApp);
		const absentResponse = await absentApp.inject({ method: "GET", url: "/" });
		expect(absentResponse.statusCode).toBe(200);
		expect(absentResponse.json()).toMatchObject({
			sessions: [],
			availability: { status: "not-configured", configuredSources: 0, availableSources: 0 },
		});
	});
});
