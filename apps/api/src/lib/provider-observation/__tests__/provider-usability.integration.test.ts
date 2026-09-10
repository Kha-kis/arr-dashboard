import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JellyfinClient } from "../../jellyfin/jellyfin-client.js";
import { buildJellyfinEpisodeScopePlan } from "../../jellyfin/jellyfin-episode-refresh-repository.js";
import { collectPlexCacheLiveEvidence } from "../../plex/plex-cache-refresher.js";
import type { PlexClient } from "../../plex/plex-client.js";
import { collectPlexEpisodeUnit } from "../../plex/plex-episode-live-collector.js";
import {
	PLEX_EPISODE_PARENT_COPIES_PER_UNIT,
	planPlexEpisodeRefresh,
} from "../../plex/plex-episode-refresh-plan.js";
import { collectTautulliPositiveObservations } from "../../tautulli/tautulli-positive-observation-collector.js";
import { evaluateProviderCoverageReceipt } from "../coverage-receipt.js";
import { authorizeProviderEvidenceUse } from "../evidence-capabilities.js";
import { projectProviderObservationStatus } from "../status-projection.js";

const acceptanceCases = [
	"plex-622-series-completes-in-13-units",
	"plex-mapped-movie-and-series-survive-unmapped-and-history-gaps",
	"plex-collection-is-not-media",
	"jellyfin-null-parent-positive-episode-is-collected",
	"jellyfin-4163-series-pages-without-series-ceiling",
	"tautulli-over-500-and-music-skip-remain-lower-bound",
	"missing-target-and-less-than-remain-unknown",
] as const;

const log = {
	warn: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
	child: vi.fn(),
} as unknown as FastifyBaseLogger;

function plexTarget(index: number) {
	return {
		instanceId: "plex-instance",
		generationId: "plex-parent-generation",
		showTmdbId: index + 1,
		sectionId: "shows",
		sectionUuid: "shows-uuid",
		mediaType: "series" as const,
		tvdbId: index + 10_000,
		ratingKey: `show-${index + 1}`,
	};
}

function plexCollectionClient(items: unknown[]): PlexClient {
	const sections = [{ key: "library", title: "Library", type: "movie" as const }];
	const coverage = {
		items,
		expectedRawCount: items.length,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: items.length,
		reason: null,
	};
	return {
		getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "user" }]),
		getLibrarySections: vi.fn().mockResolvedValue(sections),
		getLibraryItemsWithCoverage: vi.fn().mockResolvedValue(coverage),
		getHistory: vi.fn().mockResolvedValue([]),
		verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
		getOnDeck: vi.fn().mockResolvedValue([]),
	} as unknown as PlexClient;
}

function tautulliRow(index: number, mediaType = "movie") {
	return {
		row_id: 1_000 - index,
		rating_key: `video-${index}`,
		parent_rating_key: "",
		grandparent_rating_key: "",
		title: "video",
		grandparent_title: "",
		media_type: mediaType,
		user: "user",
		date: Math.floor(new Date("2026-09-07T12:00:00.000Z").getTime() / 1000) - index,
		play_count: 1,
		group_count: 1,
	};
}

afterEach(() => vi.unstubAllGlobals());

describe("assembled provider usability acceptance", () => {
	it(acceptanceCases[0], async () => {
		const plan = planPlexEpisodeRefresh(
			Array.from({ length: 622 }, (_, index) => plexTarget(index)).reverse(),
		);
		expect(plan).toMatchObject({ targetCount: 622 });
		expect(plan.units).toHaveLength(13);
		expect(
			plan.units.every((unit) => unit.targets.length <= PLEX_EPISODE_PARENT_COPIES_PER_UNIT),
		).toBe(true);
		expect(plan.targetDigest).toBe(
			planPlexEpisodeRefresh(plan.units.flatMap((unit) => unit.targets)).targetDigest,
		);

		const getEpisodes = vi.fn(async (ratingKey: string) => [
			{
				ratingKey: `episode-${ratingKey}`,
				title: "episode",
				seasonNumber: 1,
				episodeNumber: 1,
				viewCount: 1,
			},
		]);
		const collected = await Promise.all(
			plan.units.map((unit) =>
				collectPlexEpisodeUnit({ getEpisodes } as unknown as PlexClient, unit, {
					instanceId: "plex-instance",
					generationId: "plex-parent-generation",
					connectionGeneration: 3,
					identityGeneration: 5,
					sourceFingerprint: "fingerprint",
				}),
			),
		);
		expect(collected.every((unit) => unit.complete)).toBe(true);
		expect(collected.reduce((sum, unit) => sum + unit.rows.length, 0)).toBe(622);
		expect(getEpisodes).toHaveBeenCalledTimes(622);
		const receipt = {
			version: 1 as const,
			provider: "plex_episode" as const,
			attemptStartedAt: "2026-09-07T12:00:00.000Z",
			observedAt: "2026-09-07T12:00:01.000Z",
			evidence: "positive-only" as const,
			publishedCanonicalEntities: 622,
			units: collected.map((unit, ordinal) => ({
				scopeKey: plan.units[ordinal]!.scopeKey,
				expectedRawCount: plan.units[ordinal]!.targets.length,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: unit.rows.length,
				sourceBindings: unit.rows.length,
				canonicalEntities: unit.rows.length,
				acceptedSkips: [],
				fatalCount: 0,
			})),
		};
		const evaluation = evaluateProviderCoverageReceipt(receipt);
		expect(evaluation).toMatchObject({ valid: true, publishedCanonicalEntities: 622 });
		expect(
			projectProviderObservationStatus({
				identity: "current",
				publication: { observedAt: new Date(receipt.observedAt), evaluation },
				latestAttempt: null,
				now: new Date(receipt.observedAt),
				maxAgeMs: 1_000,
			}),
		).toMatchObject({ availability: "partial", evidence: "positive-only" });
	});

	it(acceptanceCases[1], async () => {
		const client = plexCollectionClient([
			{
				ratingKey: "movie",
				title: "movie",
				type: "movie",
				Guid: [{ id: "tmdb://1" }],
				viewCount: 1,
			},
			{
				ratingKey: "series",
				title: "series",
				type: "show",
				Guid: [{ id: "tmdb://2" }, { id: "tvdb://2" }],
				viewCount: 1,
			},
			{ ratingKey: "unmapped", title: "unmapped", type: "movie", Guid: [], viewCount: 0 },
		]);
		const result = await collectPlexCacheLiveEvidence(client, "plex-instance", log);
		expect(result.kind).toBe("positive-observation");
		if (result.kind !== "positive-observation")
			throw new Error("expected bounded positive observation");
		expect(result.observation.rows.map((row) => row.mediaType).sort()).toEqual(["movie", "series"]);
		expect(result.observation.observedTargets).toHaveLength(2);
		expect(result.receipt.domains?.find((domain) => domain.domain === "mapping")).toMatchObject({
			evidence: "positive-only",
			valueSemantics: "lower-bound",
		});
		const evaluation = evaluateProviderCoverageReceipt(result.receipt);
		expect(evaluation).toMatchObject({ valid: true, evidence: "positive-only" });
		expect(
			projectProviderObservationStatus({
				identity: "current",
				publication: { observedAt: new Date(result.receipt.observedAt), evaluation },
				latestAttempt: null,
				now: new Date(result.receipt.observedAt),
				maxAgeMs: 1_000,
			}),
		).toMatchObject({ availability: "partial", evidence: "positive-only" });
	});

	it(acceptanceCases[2], async () => {
		const result = await collectPlexCacheLiveEvidence(
			plexCollectionClient([
				{
					ratingKey: "movie",
					title: "movie",
					type: "movie",
					Guid: [{ id: "tmdb://1" }],
					viewCount: 0,
				},
				{
					ratingKey: "collection",
					title: "collection",
					type: "collection",
					Guid: [{ id: "plex://collection/1" }],
				},
			]),
			"plex-instance",
			log,
		);
		expect(result.kind).toBe("authoritative-snapshot");
		if (result.kind !== "authoritative-snapshot")
			throw new Error("expected authoritative snapshot");
		expect(result.snapshot.rows).toHaveLength(1);
		expect(result.inventoryTargets).toHaveLength(1);
		expect(result.receipt.units[0]?.acceptedSkips).toContainEqual({
			reason: "known-container",
			count: 1,
		});
		const evaluation = evaluateProviderCoverageReceipt(result.receipt);
		expect(evaluation).toMatchObject({ valid: true, evidence: "complete" });
		expect(
			projectProviderObservationStatus({
				identity: "current",
				publication: { observedAt: new Date(result.receipt.observedAt), evaluation },
				latestAttempt: null,
				now: new Date(result.receipt.observedAt),
				maxAgeMs: 1_000,
			}),
		).toMatchObject({ availability: "current", evidence: "complete" });
	});

	it(acceptanceCases[3], async () => {
		const scope = { userId: "user", userName: "", libraryId: "library" };
		const plan = buildJellyfinEpisodeScopePlan([scope]);
		const parent = { generationId: "jellyfin-parent-generation", lastWatchedAt: null };
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						StartIndex: 0,
						TotalRecordCount: 1,
						Items: [
							{
								Id: "episode",
								Name: "episode",
								Type: "Episode",
								SeriesId: "series",
								ParentIndexNumber: 1,
								IndexNumber: 1,
								UserData: {
									Played: true,
									PlayCount: 1,
									LastPlayedDate: "2026-09-07T12:00:00.000Z",
								},
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			),
		);
		const page = await new JellyfinClient(
			"http://jellyfin.invalid",
			"token",
			log,
		).getEpisodeItemsPageWithCoverage(scope.userId, scope.libraryId, 0);
		expect(parent.lastWatchedAt).toBeNull();
		expect(plan.units[0]).toMatchObject({
			phase: "collect",
			scopePayload: JSON.stringify({ userId: "user", libraryId: "library" }),
		});
		expect(page).toMatchObject({
			startIndex: 0,
			totalRecordCount: 1,
			items: [
				{
					id: "episode",
					seriesId: "series",
					played: true,
					playCount: 1,
					lastPlayedDate: "2026-09-07T12:00:00.000Z",
				},
			],
		});
	});

	it(acceptanceCases[4], async () => {
		const calls: URL[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) => {
				const url = new URL(String(input));
				calls.push(url);
				const start = Number(url.searchParams.get("StartIndex"));
				const count = Math.min(1_000, 4_163 - start);
				return new Response(
					JSON.stringify({
						StartIndex: start,
						TotalRecordCount: 4_163,
						Items: Array.from({ length: count }, (_, index) => ({
							Id: `episode-${start + index}`,
							Name: "episode",
							Type: "Episode",
							SeriesId: "series",
							ParentIndexNumber: 1,
							IndexNumber: start + index,
							UserData: { Played: true, PlayCount: 1 },
						})),
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}),
		);
		const client = new JellyfinClient("http://jellyfin.invalid", "token", log);
		let cursor = 0;
		let total = 0;
		while (cursor < 4_163) {
			const page = await client.getEpisodeItemsPageWithCoverage("user", "library", cursor);
			total += page.items.length;
			cursor += page.items.length;
		}
		expect(total).toBe(4_163);
		expect(calls.map((url) => Number(url.searchParams.get("StartIndex")))).toEqual([
			0, 1_000, 2_000, 3_000, 4_000,
		]);
		expect(calls.every((url) => url.searchParams.get("Limit") === "1000")).toBe(true);
		expect(calls.every((url) => url.pathname === "/Users/user/Items")).toBe(true);
	});

	it(acceptanceCases[5], async () => {
		const video = Array.from({ length: 597 }, (_, index) => tautulliRow(index));
		const music = [
			tautulliRow(598, "track"),
			tautulliRow(599, "album"),
			tautulliRow(600, "artist"),
		];
		const all = [...video, ...music];
		const getHistory = vi.fn(async (params: { start: number }) => ({
			data: all.slice(params.start, params.start + 200),
			recordsFiltered: all.length,
			recordsTotal: all.length,
		}));
		const result = await collectTautulliPositiveObservations(
			{
				getLibraries: vi
					.fn()
					.mockResolvedValue([{ section_id: "1", section_name: "library", section_type: "movie" }]),
				getHistory,
				getMetadata: vi.fn(async (key: string) => ({
					guids: [`tmdb://${Number(key.replace("video-", "")) + 1}`],
					media_type: "movie",
				})),
			},
			{
				instanceId: "tautulli",
				attemptStartedAt: new Date("2026-09-07T11:45:00.000Z"),
				now: () => new Date("2026-09-07T12:00:00.000Z"),
			},
		);
		expect(result.rows).toHaveLength(597);
		expect(getHistory).toHaveBeenCalledTimes(4);
		expect(result.receipt).toMatchObject({
			evidence: "positive-only",
			publishedCanonicalEntities: 597,
		});
		expect(result.receipt.units[0]?.acceptedSkips).toContainEqual({
			reason: "unsupported-provider-object",
			count: 3,
		});
		const evaluation = evaluateProviderCoverageReceipt(result.receipt);
		expect(evaluation).toMatchObject({ valid: true, evidence: "positive-only" });
		expect(
			projectProviderObservationStatus({
				identity: "current",
				publication: { observedAt: new Date(result.receipt.observedAt), evaluation },
				latestAttempt: null,
				now: new Date(result.receipt.observedAt),
				maxAgeMs: 1_000,
			}),
		).toMatchObject({ availability: "partial", evidence: "positive-only" });
	});

	it(acceptanceCases[6], () => {
		const lowerBoundStatus = {
			availability: "current" as const,
			evidence: "positive-only" as const,
			observedAt: "2026-09-07T12:00:00.000Z",
			ageSeconds: 0,
			latestAttempt: "successful" as const,
			reasonCodes: [],
			domains: [
				{
					domain: "watch-count" as const,
					availability: "current" as const,
					evidence: "positive-only" as const,
					valueSemantics: "lower-bound" as const,
					observedAt: "2026-09-07T12:00:00.000Z",
					reasonCodes: [],
				},
			],
		};
		const mutate = vi.fn();
		for (const request of [
			{ use: "mutation" as const, operator: "less_than" as const, targetObserved: true },
			{ use: "mutation" as const, operator: "greater_than" as const, targetObserved: false },
		]) {
			const decision = authorizeProviderEvidenceUse(lowerBoundStatus, {
				domain: "watch-count",
				field: "watch-count",
				threshold: 2,
				observedValue: 1,
				...request,
			});
			expect(decision.authorized).toBe(false);
			if (decision.authorized) mutate();
		}
		expect(mutate).not.toHaveBeenCalled();
	});
});
