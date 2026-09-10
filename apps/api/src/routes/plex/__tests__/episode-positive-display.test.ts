import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInjectAuthenticated, setupAuthInjection } from "../../__tests__/test-helpers.js";

const mocks = vi.hoisted(() => ({
	readInstanceSelectedEpisodes: vi.fn(),
	readPositiveEpisodeDisplayEvidence: vi.fn(),
}));

vi.mock("../../../lib/plex/plex-authority-service.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../lib/plex/plex-authority-service.js")>();
	return {
		...actual,
		PlexAuthorityService: class {
			readInstanceSelectedEpisodes = mocks.readInstanceSelectedEpisodes;
			readPositiveEpisodeDisplayEvidence = mocks.readPositiveEpisodeDisplayEvidence;
		},
	};
});

import { registerEpisodeRoutes } from "../episode-routes.js";

const positiveEvidence = {
	available: true,
	instanceId: "plex-1",
	generationId: "episode-generation-1",
	connectionGeneration: 4,
	identityGeneration: 9,
	capability: {
		domain: "episodes",
		field: "watchCount",
		semantics: "lower-bound",
		operator: "greater_than",
	},
	partialReasons: [{ code: "coverage-incomplete", count: 1 }],
	provenance: {
		publicationLevel: "positive-only",
		completeness: "partial",
		connectionGeneration: 4,
		identityGeneration: 9,
		parentPlexGenerationId: "parent-generation-1",
		parentTargetDigest: "a".repeat(64),
		parentTargetCount: 1,
		episodeGenerationId: "episode-generation-1",
		episodeDigest: "b".repeat(64),
		publishedAt: "2026-09-08T12:00:00.000Z",
	},
	rows: [
		{
			showTmdbId: 42,
			seasonNumber: 1,
			episodeNumber: 2,
			ratingKey: "episode-2",
			title: "Observed Pilot",
			watched: true,
			watchedByUsers: '["viewer"]',
			lastWatchedAt: new Date("2026-09-07T12:00:00.000Z"),
		},
		{
			showTmdbId: 42,
			seasonNumber: 1,
			episodeNumber: 1,
			ratingKey: "episode-1",
			title: "Observed First",
			watched: true,
			watchedByUsers: "{malformed",
			lastWatchedAt: null,
		},
		{
			showTmdbId: 99,
			seasonNumber: 1,
			episodeNumber: 1,
			ratingKey: "other-show-1",
			title: "Other Show",
			watched: true,
			watchedByUsers: "[]",
			lastWatchedAt: null,
		},
	],
	evidence: {
		availability: "current",
		authority: "positive-only",
		attemptState: "partial",
		publicationLevel: "positive-only",
		completeness: "partial",
		reasonCodes: ["latest_attempt_partial"],
	},
};

const unavailableExact = {
	available: false,
	instanceId: "plex-1",
	evidence: {
		availability: "unavailable",
		authority: "unavailable",
		attemptState: "unknown",
		publicationLevel: "unavailable",
		completeness: "unknown",
		reasonCodes: ["latest_attempt_partial"],
	},
};

describe("Plex episode positive display route", () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.decorate("prisma", {} as never);
		await app.register(registerEpisodeRoutes, { prefix: "/api/plex/episodes" });
		await app.ready();
		mocks.readInstanceSelectedEpisodes.mockReset();
		mocks.readPositiveEpisodeDisplayEvidence.mockReset();
	});

	afterEach(async () => {
		await app.close();
	});

	it("returns current positive rows as read-only display data", async () => {
		mocks.readInstanceSelectedEpisodes.mockResolvedValue(unavailableExact);
		mocks.readPositiveEpisodeDisplayEvidence.mockResolvedValue(positiveEvidence);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/plex/episodes?instanceId=plex-1&showTmdbId=42",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			showTmdbId: 42,
			episodes: [
				{
					seasonNumber: 1,
					episodeNumber: 1,
					title: "Observed First",
					watched: true,
					watchedByUsers: [],
					lastWatchedAt: null,
				},
				{
					seasonNumber: 1,
					episodeNumber: 2,
					title: "Observed Pilot",
					watched: true,
					watchedByUsers: ["viewer"],
					lastWatchedAt: "2026-09-07T12:00:00.000Z",
				},
			],
			evidence: positiveEvidence.evidence,
		});
		expect(mocks.readPositiveEpisodeDisplayEvidence).toHaveBeenCalledWith({
			userId: "user-1",
			instanceId: "plex-1",
		});
	});

	it.each([
		["error", "latest_attempt_failed"],
		["in_progress", "latest_attempt_in_progress"],
	] as const)(
		"returns retained positive rows with honest %s evidence",
		async (attemptState, reasonCode) => {
			mocks.readInstanceSelectedEpisodes.mockResolvedValue(unavailableExact);
			mocks.readPositiveEpisodeDisplayEvidence.mockResolvedValue({
				...positiveEvidence,
				evidence: {
					...positiveEvidence.evidence,
					availability: "last-known",
					authority: "unavailable",
					attemptState,
					reasonCodes: [reasonCode],
				},
			});

			const response = await createInjectAuthenticated(app)(
				"GET",
				"/api/plex/episodes?instanceId=plex-1&showTmdbId=42",
			);

			expect(response.statusCode).toBe(200);
			expect(response.json().evidence).toMatchObject({
				availability: "last-known",
				authority: "unavailable",
				attemptState,
				publicationLevel: "positive-only",
			});
			expect(response.json().episodes).toEqual([
				{
					seasonNumber: 1,
					episodeNumber: 1,
					title: "Observed First",
					watched: true,
					watchedByUsers: [],
					lastWatchedAt: null,
				},
				{
					seasonNumber: 1,
					episodeNumber: 2,
					title: "Observed Pilot",
					watched: true,
					watchedByUsers: ["viewer"],
					lastWatchedAt: "2026-09-07T12:00:00.000Z",
				},
			]);
		},
	);

	it("retains the exact authoritative path without invoking positive display", async () => {
		const exact = {
			available: true,
			instanceId: "plex-1",
			rows: [
				{
					seasonNumber: 1,
					episodeNumber: 1,
					title: "Exact Episode",
					watched: true,
					watchedByUsers: '["viewer"]',
					lastWatchedAt: new Date("2026-09-07T12:00:00.000Z"),
				},
			],
			evidence: {
				availability: "current",
				authority: "authoritative",
				attemptState: "success",
				publicationLevel: "authoritative",
				completeness: "complete",
				reasonCodes: [],
			},
		};
		mocks.readInstanceSelectedEpisodes.mockResolvedValue(exact);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/plex/episodes?instanceId=plex-1&showTmdbId=42",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json().episodes).toEqual([
			{
				seasonNumber: 1,
				episodeNumber: 1,
				title: "Exact Episode",
				watched: true,
				watchedByUsers: ["viewer"],
				lastWatchedAt: "2026-09-07T12:00:00.000Z",
			},
		]);
		expect(mocks.readPositiveEpisodeDisplayEvidence).not.toHaveBeenCalled();
	});

	it("withholds values when positive evidence is unavailable", async () => {
		mocks.readInstanceSelectedEpisodes.mockResolvedValue(unavailableExact);
		mocks.readPositiveEpisodeDisplayEvidence.mockResolvedValue({
			available: false,
			instanceId: "plex-1",
			evidence: {
				availability: "unavailable",
				authority: "unavailable",
				attemptState: "unknown",
				publicationLevel: "unavailable",
				completeness: "unknown",
				reasonCodes: ["target_digest_mismatch"],
			},
		});

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/plex/episodes?instanceId=plex-1&showTmdbId=42",
		);

		expect(response.statusCode).toBe(503);
		expect(response.json()).toEqual({
			error: "Plex cache evidence is unavailable",
			evidence: expect.objectContaining({ reasonCodes: ["target_digest_mismatch"] }),
		});
	});
});
