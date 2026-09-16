import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInjectAuthenticated, setupAuthInjection } from "../../__tests__/test-helpers.js";

const mocks = vi.hoisted(() => ({ exact: vi.fn(), positive: vi.fn(), jellyfin: vi.fn() }));
vi.mock("../../../lib/plex/plex-authority-service.js", async (original) => ({
	...(await original<typeof import("../../../lib/plex/plex-authority-service.js")>()),
	PlexAuthorityService: class {
		readInstanceSelectedEpisodes(input: unknown) {
			return mocks.exact(input);
		}
		readPositiveEpisodeDisplayEvidence(input: unknown) {
			return mocks.positive(input);
		}
	},
}));
vi.mock("../../../lib/jellyfin/jellyfin-display-evidence.js", async (original) => ({
	...(await original<typeof import("../../../lib/jellyfin/jellyfin-display-evidence.js")>()),
	readOwnedJellyfinEpisodeDisplaySources: mocks.jellyfin,
}));

import { registerSeriesProgressRoutes as registerPlex } from "../series-progress-routes.js";
import { registerSeriesProgressRoutes as registerJellyfin } from "../../jellyfin/series-progress-routes.js";

const partialEvidence = {
	availability: "last-known",
	authority: "unavailable",
	attemptState: "partial",
	publicationLevel: "positive-only",
	completeness: "partial",
	reasonCodes: ["latest_attempt_partial"],
} as const;
const exactEvidence = {
	availability: "current",
	authority: "authoritative",
	attemptState: "idle",
	publicationLevel: "authoritative",
	completeness: "complete",
	reasonCodes: [],
} as const;
const unavailable = { available: false, evidence: partialEvidence };
const unknown = {
	status: "unknown",
	total: null,
	watched: null,
	percent: null,
	watchedSemantics: "unknown",
};
const lowerBound = (watched: number) => ({
	status: "partial",
	total: null,
	watched,
	percent: null,
	watchedSemantics: "lower-bound",
});
const episode = (episodeNumber: number, watched = true) => ({
	showTmdbId: 42,
	seasonNumber: 1,
	episodeNumber,
	watched,
	title: "Episode",
	ratingKey: `item-${episodeNumber}`,
	watchedByUsers: "[]",
	lastWatchedAt: null,
});

describe("read-only series progress evidence", () => {
	let app: FastifyInstance;
	let instances: Array<{ id: string; label: string; service: string }>;
	beforeEach(async () => {
		vi.resetAllMocks();
		instances = [{ id: "provider-one", label: "Provider", service: "PLEX" }];
		mocks.exact.mockResolvedValue(unavailable);
		mocks.positive.mockResolvedValue({
			available: true,
			evidence: partialEvidence,
			rows: [episode(1), episode(1), episode(2, false)],
		});
		mocks.jellyfin.mockResolvedValue({ sources: [], providerStatus: undefined });
		app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.decorate("prisma", {
			serviceInstance: {
				findMany: vi.fn(async ({ where }) => {
					expect(where).toMatchObject({ userId: "user-1", enabled: true });
					return instances;
				}),
			},
		} as never);
		await app.register(registerPlex, { prefix: "/plex" });
		await app.register(registerJellyfin, { prefix: "/jellyfin" });
		await app.ready();
	});
	afterEach(async () => {
		await app.close();
	});

	it("returns positive lower bounds and explicit unknowns instead of a Plex503", async () => {
		const response = await createInjectAuthenticated(app)("GET", "/plex?tmdbIds=42,43");
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			configured: true,
			progress: { 42: lowerBound(1), 43: unknown },
		});
	});

	it("retains unknowns when no eligible episode evidence is available", async () => {
		mocks.positive.mockResolvedValue(unavailable);
		const response = await createInjectAuthenticated(app)("GET", "/plex?tmdbIds=42");
		expect(response.statusCode).toBe(200);
		expect(response.json().progress).toEqual({ 42: unknown });
	});

	it("deduplicates exact episode coordinates across provider aliases", async () => {
		instances.push({ id: "provider-two", label: "Alias", service: "PLEX" });
		mocks.exact.mockImplementation(async ({ instanceId }) => ({
			available: true,
			evidence: exactEvidence,
			rows: [episode(1, instanceId === "provider-one"), episode(2, instanceId === "provider-two")],
		}));
		const response = await createInjectAuthenticated(app)("GET", "/plex?tmdbIds=42,43");
		expect(response.statusCode).toBe(200);
		expect(response.json().progress).toEqual({
			42: { status: "exact", total: 2, watched: 2, percent: 100, watchedSemantics: "exact" },
			43: unknown,
		});
	});

	it("does not promote a healthy peer to complete progress when another instance is unavailable", async () => {
		instances.push({ id: "provider-two", label: "Other", service: "PLEX" });
		mocks.exact.mockImplementation(async ({ instanceId }) =>
			instanceId === "provider-one"
				? { available: true, evidence: exactEvidence, rows: [episode(1), episode(2, false)] }
				: unavailable,
		);
		mocks.positive.mockResolvedValue(unavailable);
		const response = await createInjectAuthenticated(app)("GET", "/plex?tmdbIds=42");
		expect(response.statusCode).toBe(200);
		expect(response.json().progress).toEqual({ 42: lowerBound(1) });
	});

	it("retains positive Jellyfin observations without inventing a denominator", async () => {
		instances = [{ id: "jf-one", label: "Jellyfin", service: "JELLYFIN" }];
		mocks.jellyfin.mockResolvedValue({
			sources: [{ instanceId: "jf-one", rows: [episode(1), episode(1), episode(2, false)] }],
			providerStatus: {
				availability: "partial",
				sources: [
					{
						instanceId: "jf-one",
						service: "jellyfin",
						cacheType: "jellyfin_episode",
						status: {
							availability: "partial",
							evidence: "positive-only",
							observedAt: "2026-09-15T00:00:00.000Z",
							ageSeconds: 0,
							latestAttempt: "successful",
							reasonCodes: [],
						},
					},
				],
			},
		});
		const response = await createInjectAuthenticated(app)("GET", "/jellyfin?tmdbIds=42,43");
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			configured: true,
			progress: { 42: lowerBound(1), 43: unknown },
		});
	});

	it.each(["plex", "jellyfin"])(
		"distinguishes unconfigured %s from unknown configured evidence",
		async (provider) => {
			instances = [];
			const response = await createInjectAuthenticated(app)("GET", `/${provider}?tmdbIds=42`);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({ configured: false, progress: {} });
		},
	);
});
