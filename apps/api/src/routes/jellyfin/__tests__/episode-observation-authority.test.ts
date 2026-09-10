import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInjectAuthenticated, setupAuthInjection } from "../../__tests__/test-helpers.js";
import { registerAnalyticsRoutes } from "../analytics-routes.js";
import { registerEpisodeRoutes } from "../episode-routes.js";
import { registerSeriesProgressRoutes } from "../series-progress-routes.js";

const mocks = vi.hoisted(() => ({ readEpisodes: vi.fn() }));

vi.mock("../../../lib/jellyfin/jellyfin-display-evidence.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../lib/jellyfin/jellyfin-display-evidence.js")>()),
	readOwnedJellyfinEpisodeDisplaySources: mocks.readEpisodes,
}));

const now = new Date("2026-09-03T12:00:00.000Z");
const primary = { id: "jellyfin-1", label: "Primary", service: "JELLYFIN" as const };
const secondary = { id: "emby-1", label: "Secondary", service: "EMBY" as const };
type Instance = typeof primary | typeof secondary;
type SourceAvailability = "current" | "last-known" | "partial" | "unavailable";
type SourceEvidence = "complete" | "partial" | "positive-only" | "unknown";
type Topology =
	| "current"
	| "last-known"
	| "mixed"
	| "mixed-unavailable"
	| "partial"
	| "unavailable"
	| "positive-only"
	| "unknown";

function sourceStatus(
	instance: Instance,
	availability: SourceAvailability,
	evidence: SourceEvidence,
) {
	return {
		instanceId: instance.id,
		service: instance.service === "EMBY" ? ("emby" as const) : ("jellyfin" as const),
		cacheType: "jellyfin_episode" as const,
		status: {
			availability,
			evidence,
			observedAt: availability === "unavailable" ? null : now.toISOString(),
			ageSeconds: availability === "unavailable" ? null : 0,
			latestAttempt: availability === "unavailable" ? ("idle" as const) : ("successful" as const),
			reasonCodes:
				availability === "unavailable"
					? (["unknown-failure"] as const)
					: evidence === "partial"
						? (["coverage-incomplete"] as const)
						: evidence === "positive-only"
							? (["positive-only"] as const)
							: [],
		},
	};
}

function evidenceFor(
	instances: readonly Instance[],
	state: Topology = "current",
	rowsByInstance: Record<string, Array<Record<string, unknown>>> = {},
) {
	const sources = instances.map((instance, index) => {
		const availability: SourceAvailability =
			state === "last-known"
				? "last-known"
				: state === "unavailable"
					? "unavailable"
					: state === "mixed"
						? index === 0
							? "current"
							: "last-known"
						: state === "mixed-unavailable"
							? index === 0
								? "current"
								: "unavailable"
							: state === "partial" || state === "positive-only"
								? "partial"
								: state === "unknown"
									? "unavailable"
									: "current";
		const evidence: SourceEvidence =
			state === "partial"
				? "partial"
				: state === "positive-only"
					? "positive-only"
					: state === "unknown" || state === "unavailable" || availability === "unavailable"
						? "unknown"
						: "complete";
		const source = sourceStatus(instance, availability, evidence);
		const admittedRows =
			availability === "current" || availability === "last-known"
				? (rowsByInstance[instance.id] ?? [])
				: [];
		return {
			instanceId: instance.id,
			instanceName: instance.label,
			rows: admittedRows,
			status: source,
		};
	});
	const availability =
		state === "current"
			? "current"
			: state === "last-known"
				? "last-known"
				: state === "unavailable"
					? "unavailable"
					: "partial";
	return {
		sources: sources.map(({ instanceId, instanceName, rows }) => ({
			instanceId,
			instanceName,
			rows,
		})),
		providerStatus: { availability, sources: sources.map(({ status }) => status) },
	};
}

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "episode-1",
		instanceId: "jellyfin-1",
		showTmdbId: 42,
		seasonNumber: 1,
		episodeNumber: 1,
		title: "Pilot",
		watched: true,
		watchedByUsers: '["alice"]',
		lastWatchedAt: now,
		...overrides,
	};
}

describe("Jellyfin episode observation routes", () => {
	let app: FastifyInstance;
	let configuredInstances: Instance[];
	let findFirst: ReturnType<typeof vi.fn>;
	let findMany: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		configuredInstances = [primary];
		mocks.readEpisodes.mockResolvedValue(
			evidenceFor(configuredInstances, "current", { [primary.id]: [row()] }),
		);
		findFirst = vi.fn(async () => primary);
		findMany = vi.fn(async () => configuredInstances);
		app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.decorate("prisma", {
			serviceInstance: { findFirst, findMany },
			jellyfinEpisodeCache: {
				findMany: vi.fn(async () => {
					throw new Error("direct cache read is forbidden");
				}),
			},
		} as never);
		await app.register(registerEpisodeRoutes, { prefix: "/api/jellyfin/episodes" });
		await app.register(registerSeriesProgressRoutes, { prefix: "/api/jellyfin/series-progress" });
		await app.register(registerAnalyticsRoutes, { prefix: "/api/jellyfin/analytics" });
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		vi.clearAllMocks();
	});

	it("shows complete last-known episodes in stable coordinate and row-ID order", async () => {
		mocks.readEpisodes.mockResolvedValue(
			evidenceFor([primary], "last-known", {
				[primary.id]: [
					row({ id: "episode-z", seasonNumber: 2, episodeNumber: 1, title: "Two" }),
					row({ id: "episode-b", seasonNumber: 1, episodeNumber: 2, title: "One-B" }),
					row({
						id: "episode-a",
						seasonNumber: 1,
						episodeNumber: 2,
						title: "One-A",
						watched: false,
						watchedByUsers: '["bob"]',
						lastWatchedAt: null,
					}),
				],
			}),
		);
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/jellyfin/episodes?instanceId=jellyfin-1&showTmdbId=42",
		);
		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(body.showTmdbId).toBe(42);
		expect(body.episodes).toEqual([
			{
				seasonNumber: 1,
				episodeNumber: 2,
				title: "One-A",
				watched: false,
				watchedByUsers: ["bob"],
				lastWatchedAt: null,
			},
			{
				seasonNumber: 1,
				episodeNumber: 2,
				title: "One-B",
				watched: true,
				watchedByUsers: ["alice"],
				lastWatchedAt: now.toISOString(),
			},
			{
				seasonNumber: 2,
				episodeNumber: 1,
				title: "Two",
				watched: true,
				watchedByUsers: ["alice"],
				lastWatchedAt: now.toISOString(),
			},
		]);
		expect(body.providerStatus).toMatchObject({
			availability: "last-known",
		});
		expect(findFirst).toHaveBeenCalledWith({
			where: {
				id: "jellyfin-1",
				userId: "user-1",
				service: { in: ["JELLYFIN", "EMBY"] },
				enabled: true,
			},
			select: { id: true, label: true, service: true },
		});
		expect(mocks.readEpisodes).toHaveBeenCalledWith({
			prisma: app.prisma,
			userId: "user-1",
			instances: [primary],
		});
	});

	it.each(["partial", "unavailable"] as const)(
		"returns an empty 200 response with %s status for exact episodes",
		async (state) => {
			mocks.readEpisodes.mockResolvedValue(
				evidenceFor([primary], state, { [primary.id]: [row()] }),
			);
			const response = await createInjectAuthenticated(app)(
				"GET",
				"/api/jellyfin/episodes?instanceId=jellyfin-1&showTmdbId=42",
			);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({
				showTmdbId: 42,
				episodes: [],
				providerStatus: evidenceFor([primary], state).providerStatus,
			});
		},
	);

	it("distinguishes a strict current empty publication from unavailable", async () => {
		mocks.readEpisodes.mockResolvedValue(evidenceFor([primary], "current"));
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/jellyfin/episodes?instanceId=jellyfin-1&showTmdbId=42",
		);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			showTmdbId: 42,
			episodes: [],
			providerStatus: evidenceFor([primary], "current").providerStatus,
		});
	});

	it.each(["missing", "foreign", "disabled"] as const)(
		"preserves 404 semantics for a %s requested instance",
		async (kind) => {
			findFirst.mockResolvedValue(null);
			const response = await createInjectAuthenticated(app)(
				"GET",
				`/api/jellyfin/episodes?instanceId=${kind}&showTmdbId=42`,
			);
			expect(response.statusCode).toBe(404);
			expect(mocks.readEpisodes).not.toHaveBeenCalled();
		},
	);

	it("filters unrequested exact-episode rows and excludes private fields", async () => {
		mocks.readEpisodes.mockResolvedValue(
			evidenceFor([primary], "current", {
				[primary.id]: [
					row({
						metadata: "private",
						authority: "private",
						generationId: "private",
						title: "Shown",
					}),
					row({ id: "other", showTmdbId: 99, title: "Other" }),
				],
			}),
		);
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/jellyfin/episodes?instanceId=jellyfin-1&showTmdbId=42",
		);
		const encoded = JSON.stringify(response.json());
		expect(response.json().episodes).toHaveLength(1);
		expect(encoded).not.toMatch(
			/metadata|authority|receipt|generation|fingerprint|scopeKey|credential|https?:|raw error|Primary/,
		);
	});

	it("returns positive-only episode details while withholding totals from the same populated evidence", async () => {
		const partial = evidenceFor([primary], "positive-only");
		partial.sources[0]!.rows = [row()];
		mocks.readEpisodes.mockResolvedValue(partial);
		const request = createInjectAuthenticated(app);
		const details = await request(
			"GET",
			"/api/jellyfin/episodes?instanceId=jellyfin-1&showTmdbId=42",
		);
		expect(details.statusCode).toBe(200);
		expect(details.json()).toMatchObject({
			episodes: [{ seasonNumber: 1, episodeNumber: 1, watched: true }],
			providerStatus: { availability: "partial" },
		});
		const progress = await request("GET", "/api/jellyfin/series-progress?tmdbIds=42");
		expect(progress.statusCode).toBe(200);
		expect(progress.json().progress).toEqual({});
		const completion = await request(
			"GET",
			"/api/jellyfin/analytics/episode-completion?tmdbIds=42",
		);
		expect(completion.statusCode).toBe(200);
		expect(completion.json().shows).toEqual([]);
		expect(JSON.stringify(details.json())).not.toMatch(
			/catalogProvenance|parentLibrary|generation|fingerprint/,
		);
	});

	describe("series progress", () => {
		it.each(["current", "last-known"] as const)(
			"computes totals for uniform %s-complete sources across instances",
			async (state) => {
				configuredInstances = [primary, secondary];
				findMany.mockResolvedValue(configuredInstances);
				mocks.readEpisodes.mockResolvedValue(
					evidenceFor(configuredInstances, state, {
						[primary.id]: [row({ id: "primary-42", watched: true })],
						[secondary.id]: [
							row({ id: "secondary-42", instanceId: secondary.id, watched: false }),
							row({ id: "secondary-99", instanceId: secondary.id, showTmdbId: 99, watched: true }),
						],
					}),
				);
				const response = await createInjectAuthenticated(app)(
					"GET",
					"/api/jellyfin/series-progress?tmdbIds=99,42,42",
				);
				expect(response.statusCode).toBe(200);
				expect(response.json()).toMatchObject({
					progress: {
						42: { total: 2, watched: 1, percent: 50 },
						99: { total: 1, watched: 1, percent: 100 },
					},
					providerStatus: { availability: state },
				});
			},
		);

		it.each([
			"mixed",
			"mixed-unavailable",
			"partial",
			"unavailable",
			"positive-only",
			"unknown",
		] as const)("suppresses arithmetic for %s source topology", async (state) => {
			configuredInstances = [primary, secondary];
			findMany.mockResolvedValue(configuredInstances);
			mocks.readEpisodes.mockResolvedValue(evidenceFor(configuredInstances, state));
			const response = await createInjectAuthenticated(app)(
				"GET",
				"/api/jellyfin/series-progress?tmdbIds=42",
			);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({
				progress: {},
				providerStatus: evidenceFor(configuredInstances, state).providerStatus,
			});
		});

		it("omits status and helper calls when no instances are configured", async () => {
			configuredInstances = [];
			findMany.mockResolvedValue([]);
			const response = await createInjectAuthenticated(app)(
				"GET",
				"/api/jellyfin/series-progress?tmdbIds=42",
			);
			expect(response.json()).toEqual({ progress: {} });
			expect(mocks.readEpisodes).not.toHaveBeenCalled();
		});

		it.each(["abc", Array.from({ length: 201 }, (_, index) => String(index + 1)).join(",")])(
			"preserves parsed-input short-circuit for %s",
			async (tmdbIds) => {
				const response = await createInjectAuthenticated(app)(
					"GET",
					`/api/jellyfin/series-progress?tmdbIds=${tmdbIds}`,
				);
				expect(response.statusCode).toBe(tmdbIds === "abc" ? 200 : 400);
				expect(response.json()).toEqual(
					tmdbIds === "abc" ? { progress: {} } : { error: "Max 200 items per request" },
				);
				expect(mocks.readEpisodes).not.toHaveBeenCalled();
			},
		);
	});

	describe("user episode completion", () => {
		it.each(["current", "last-known"] as const)(
			"computes completion for uniform %s-complete sources and sorts output",
			async (state) => {
				configuredInstances = [primary, secondary];
				findMany.mockResolvedValue(configuredInstances);
				mocks.readEpisodes.mockResolvedValue(
					evidenceFor(configuredInstances, state, {
						[primary.id]: [
							row({ id: "primary-42-a", watchedByUsers: '["zeta", "alice"]' }),
							row({ id: "primary-42-b", watchedByUsers: '["alice", "zeta"]' }),
						],
						[secondary.id]: [
							row({
								id: "secondary-7",
								instanceId: secondary.id,
								showTmdbId: 7,
								watchedByUsers: '["bob"]',
							}),
							row({
								id: "secondary-99",
								instanceId: secondary.id,
								showTmdbId: 99,
								watchedByUsers: '["nobody"]',
							}),
						],
					}),
				);
				const response = await createInjectAuthenticated(app)(
					"GET",
					"/api/jellyfin/analytics/episode-completion?tmdbIds=42,7,42",
				);
				expect(response.statusCode).toBe(200);
				expect(response.json()).toMatchObject({
					shows: [
						{ tmdbId: 7, users: [{ username: "bob", percent: 100 }] },
						{
							tmdbId: 42,
							users: [
								{ username: "alice", percent: 100 },
								{ username: "zeta", percent: 100 },
							],
						},
					],
					providerStatus: { availability: state },
				});
			},
		);

		it.each([
			"mixed",
			"mixed-unavailable",
			"partial",
			"unavailable",
			"positive-only",
			"unknown",
		] as const)("suppresses completion for %s source topology", async (state) => {
			configuredInstances = [primary, secondary];
			findMany.mockResolvedValue(configuredInstances);
			mocks.readEpisodes.mockResolvedValue(evidenceFor(configuredInstances, state));
			const response = await createInjectAuthenticated(app)(
				"GET",
				"/api/jellyfin/analytics/episode-completion?tmdbIds=42",
			);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({
				shows: [],
				providerStatus: evidenceFor(configuredInstances, state).providerStatus,
			});
		});

		it("omits status and helper calls when no instances are configured", async () => {
			configuredInstances = [];
			findMany.mockResolvedValue([]);
			const response = await createInjectAuthenticated(app)(
				"GET",
				"/api/jellyfin/analytics/episode-completion?tmdbIds=42",
			);
			expect(response.json()).toEqual({ shows: [] });
			expect(mocks.readEpisodes).not.toHaveBeenCalled();
		});

		it.each(["abc", Array.from({ length: 201 }, (_, index) => String(index + 1)).join(",")])(
			"preserves parsed-input short-circuit for %s",
			async (tmdbIds) => {
				const response = await createInjectAuthenticated(app)(
					"GET",
					`/api/jellyfin/analytics/episode-completion?tmdbIds=${tmdbIds}`,
				);
				expect(response.statusCode).toBe(200);
				expect(response.json()).toEqual({ shows: [] });
				expect(mocks.readEpisodes).not.toHaveBeenCalled();
			},
		);
	});
});
