import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { collectJellyfinCacheLiveEvidence } from "../../jellyfin/jellyfin-cache-refresher.js";
import type { LibraryCleanupRule } from "../../prisma.js";
import {
	buildEvalContextWithHealth,
	jellyfinSnapshotToWatchMap,
	providerCacheTypesForEvidence,
} from "../cleanup-executor.js";
import {
	evaluateItemPolicyState,
	evaluateRuleState,
	ruleUsesUnavailableData,
} from "../rule-evaluators.js";
import type {
	CacheItemForEval,
	EvalContext,
	JellyfinWatchInfo,
	PlexWatchInfo,
	SeerrRequestInfo,
} from "../types.js";

type WatchSourceFamily = "plex" | "jellyfin";
type RequesterContext = EvalContext & {
	requesterWatchSourceFamilies: Set<WatchSourceFamily>;
};

const NOW = new Date("2026-09-05T12:00:00.000Z");

function item(overrides: Partial<CacheItemForEval> = {}): CacheItemForEval {
	return {
		id: "cache-1",
		instanceId: "arr-1",
		arrItemId: 42,
		itemType: "movie",
		title: "Reporter Fixture",
		year: 2026,
		monitored: true,
		hasFile: true,
		status: "released",
		qualityProfileId: 1,
		qualityProfileName: "HD",
		sizeOnDisk: 1n,
		arrAddedAt: new Date("2026-01-01T00:00:00.000Z"),
		data: JSON.stringify({ service: "radarr", remoteIds: { tmdbId: 42 } }),
		...overrides,
	};
}

function rule(overrides: Partial<LibraryCleanupRule> = {}): LibraryCleanupRule {
	return {
		id: "rule-1",
		name: "Reporter rule",
		enabled: true,
		priority: 1,
		ruleType: "seerr_requester_watched",
		parameters: "{}",
		serviceFilter: null,
		instanceFilter: null,
		excludeTags: null,
		excludeTitles: null,
		plexLibraryFilter: null,
		action: "delete",
		operator: null,
		conditions: null,
		configId: "config-1",
		retentionMode: false,
		scanMediaServerAfterDelete: false,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	} as LibraryCleanupRule;
}

function request(requestedBy: string): SeerrRequestInfo {
	return {
		requestId: 1,
		status: 5,
		requestedBy,
		requestedByUserId: 7,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		modifiedBy: null,
		is4k: false,
	};
}

function jellyfinWatch(overrides: Partial<JellyfinWatchInfo> = {}): JellyfinWatchInfo {
	return {
		lastWatchedAt: new Date("2026-08-01T00:00:00.000Z"),
		watchCount: 1,
		watchedByUsers: ["Alice"],
		onDeck: false,
		userRating: 9.7,
		addedAt: new Date("2026-01-01T00:00:00.000Z"),
		...overrides,
	};
}

function plexWatch(overrides: Partial<PlexWatchInfo> = {}): PlexWatchInfo {
	return {
		...jellyfinWatch(),
		collections: [],
		labels: [],
		sections: [],
		...overrides,
	};
}

function requesterContext(
	families: WatchSourceFamily[],
	overrides: Partial<EvalContext> = {},
): RequesterContext {
	return {
		now: NOW,
		requesterWatchSourceFamilies: new Set(families),
		...overrides,
	} as RequesterContext;
}

describe("#844 Jellyfin cleanup reporter proof", () => {
	it("does not classify Jellyfin-only requester retention as Plex-unavailable", () => {
		const retention = rule({
			retentionMode: true,
			ruleType: "seerr_requester_watched",
		});

		expect(ruleUsesUnavailableData(retention, new Set(["plex"]), new Set(["jellyfin"]))).toBe(
			false,
		);
		expect(ruleUsesUnavailableData(retention, new Set(["jellyfin"]), new Set(["jellyfin"]))).toBe(
			true,
		);
	});

	it("protects a high Jellyfin rating and treats missing retention evidence as unknown", () => {
		const retention = rule({
			retentionMode: true,
			ruleType: "jellyfin_user_rating",
			parameters: JSON.stringify({ operator: "greater_than", rating: 9.5 }),
		});
		const complete = evaluateItemPolicyState(
			item(),
			[retention],
			"RADARR",
			requesterContext([], { jellyfinMap: new Map([["movie:42", jellyfinWatch()]]) }),
		);
		expect(complete).toMatchObject({ kind: "retained", evidence: "true" });

		const missing = evaluateItemPolicyState(
			item(),
			[retention],
			"RADARR",
			requesterContext([], {}),
		);
		expect(missing).toMatchObject({ kind: "retained", evidence: "unknown" });
	});

	it("carries Movie and Series rows past BoxSet skips into cleanup evaluation", async () => {
		const libraries = [
			{ id: "movies", name: "Movies", collectionType: "movies" },
			{ id: "series", name: "Series", collectionType: "tvshows" },
		];
		const movie = {
			id: "movie-42",
			name: "Reporter Movie",
			type: "Movie",
			tmdbId: 42,
			played: true,
			playCount: 1,
			lastPlayedDate: "2026-08-01T00:00:00.000Z",
			isFavorite: false,
			imageTags: {},
		};
		const series = {
			...movie,
			id: "series-84",
			name: "Reporter Series",
			type: "Series",
			tmdbId: 84,
		};
		const boxSet = {
			...movie,
			id: "boxset-1",
			name: "Reporter Collection",
			type: "BoxSet",
			tmdbId: undefined,
			played: false,
			playCount: 0,
			lastPlayedDate: null,
		};
		const client = {
			getUsers: vi.fn().mockResolvedValue([{ id: "user-1", name: "Alice" }]),
			getLibraries: vi.fn().mockResolvedValue(libraries),
			getLibraryItemsWithCoverage: vi.fn(async (_userId: string, libraryId: string) => {
				const items = libraryId === "movies" ? [movie, boxSet] : [series, boxSet];
				return {
					items,
					expectedRawCount: items.length,
					pagesAttempted: 1,
					pagesCompleted: 1,
					rawObserved: items.length,
					reason: null,
				};
			}),
			getResumeItems: vi.fn().mockResolvedValue([]),
			getNextUp: vi.fn().mockResolvedValue([]),
		};
		const collected = await collectJellyfinCacheLiveEvidence(
			client as never,
			"jellyfin-1",
			{ warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
			{ observedAt: NOW },
		);

		expect(collected).toMatchObject({ complete: true, errors: 0 });
		expect(collected.snapshot?.rows).toHaveLength(2);
		expect(collected.receipt?.units).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ acceptedSkips: [{ reason: "known-container", count: 1 }] }),
			]),
		);
		const jellyfinMap = jellyfinSnapshotToWatchMap(collected.snapshot?.rows as never);
		const watchRule = rule({
			ruleType: "jellyfin_watch_count",
			parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
		});
		for (const candidate of [
			item(),
			item({
				id: "cache-2",
				arrItemId: 84,
				itemType: "series",
				data: JSON.stringify({ service: "sonarr", remoteIds: { tmdbId: 84 } }),
			}),
		]) {
			expect(
				evaluateRuleState(
					candidate,
					watchRule,
					candidate.itemType === "movie" ? "RADARR" : "SONARR",
					requesterContext([], { jellyfinMap }),
				).state,
			).toBe("true");
		}
	});

	it("matches one exact Jellyfin watched-by user case-insensitively", () => {
		const watched = evaluateRuleState(
			item(),
			rule({
				ruleType: "jellyfin_watched_by",
				parameters: JSON.stringify({ operator: "includes_any", userNames: ["aLiCe"] }),
			}),
			"RADARR",
			requesterContext([], { jellyfinMap: new Map([["movie:42", jellyfinWatch()]]) }),
		);
		expect(watched.state).toBe("true");
	});

	it("uses Jellyfin for requester-watched without fetching or binding Plex", () => {
		const evaluated = evaluateRuleState(
			item(),
			rule(),
			"RADARR",
			requesterContext(["jellyfin"], {
				seerrMap: new Map([["movie:42", [request("ALICE"), request("alice")]]]),
				jellyfinMap: new Map([["movie:42", jellyfinWatch()]]),
			}),
		);
		expect(evaluated.state).toBe("true");
		expect(evaluated.evidenceConditions[0]).toMatchObject({
			providerFamilies: ["jellyfin"],
		});
		expect(providerCacheTypesForEvidence(rule(), evaluated.evidenceConditions)).toEqual(
			new Set(["jellyfin"]),
		);
	});

	it("accepts a positive surviving source but fails closed for a mixed-family absence", () => {
		const watchedRule = rule();
		const positive = evaluateRuleState(
			item(),
			watchedRule,
			"RADARR",
			requesterContext(["plex", "jellyfin"], {
				seerrMap: new Map([["movie:42", [request("Alice")]]]),
				jellyfinMap: new Map([["movie:42", jellyfinWatch()]]),
			}),
			new Set(["plex"]),
		);
		expect(positive.state).toBe("true");
		expect(positive.evidenceConditions[0]).toMatchObject({ providerFamilies: ["jellyfin"] });

		const noMatch = evaluateRuleState(
			item(),
			rule({ ruleType: "seerr_requester_not_watched" }),
			"RADARR",
			requesterContext(["plex", "jellyfin"], {
				seerrMap: new Map([["movie:42", [request("Bob")]]]),
				jellyfinMap: new Map([["movie:42", jellyfinWatch({ watchedByUsers: [] })]]),
			}),
			new Set(["plex"]),
		);
		expect(noMatch.state).toBe("unknown");

		const watchedNoMatch = evaluateRuleState(
			item(),
			watchedRule,
			"RADARR",
			requesterContext(["plex", "jellyfin"], {
				seerrMap: new Map([["movie:42", [request("Bob")]]]),
				jellyfinMap: new Map([["movie:42", jellyfinWatch({ watchedByUsers: [] })]]),
			}),
			new Set(["plex"]),
		);
		expect(watchedNoMatch.state).toBe("unknown");

		const notWatchedPositive = evaluateRuleState(
			item(),
			rule({ ruleType: "seerr_requester_not_watched" }),
			"RADARR",
			requesterContext(["plex", "jellyfin"], {
				seerrMap: new Map([["movie:42", [request("Alice")]]]),
				jellyfinMap: new Map([["movie:42", jellyfinWatch()]]),
			}),
			new Set(["plex"]),
		);
		expect(notWatchedPositive.state).toBe("false");
	});

	it("requires every configured family for requester-not-watched and binds all complete sources", () => {
		const evaluated = evaluateRuleState(
			item(),
			rule({ ruleType: "seerr_requester_not_watched" }),
			"RADARR",
			requesterContext(["plex", "jellyfin"], {
				seerrMap: new Map([["movie:42", [request("Bob")]]]),
				plexMap: new Map([["movie:42", plexWatch({ watchedByUsers: [] })]]),
				jellyfinMap: new Map([["movie:42", jellyfinWatch({ watchedByUsers: [] })]]),
			}),
		);
		expect(evaluated.state).toBe("true");
		expect(evaluated.evidenceConditions[0]).toMatchObject({
			providerFamilies: ["plex", "jellyfin"],
		});
		expect(
			providerCacheTypesForEvidence(
				rule({ ruleType: "seerr_requester_not_watched" }),
				evaluated.evidenceConditions,
			),
		).toEqual(new Set(["plex", "jellyfin"]));
	});

	it("discovers Jellyfin-only requester sources without scheduling a Plex read", async () => {
		const calls: string[][] = [];
		const jellyfinInstance = {
			id: "jellyfin-1",
			userId: "user-1",
			service: "JELLYFIN",
			enabled: true,
		};
		const findMany = vi.fn(async (input: { where: { service?: { in?: string[] } | string } }) => {
			const service = input.where.service;
			const services =
				typeof service === "object" && service !== null && Array.isArray(service.in)
					? service.in
					: typeof service === "string"
						? [service]
						: [];
			calls.push(services);
			if (services.join(",") === "PLEX,JELLYFIN,EMBY") return [jellyfinInstance];
			return [];
		});
		const result = await buildEvalContextWithHealth(
			{
				prisma: { serviceInstance: { findMany } },
				arrClientFactory: {},
				log: { warn: vi.fn() },
			} as never,
			"user-1",
			[{ enabled: true, ruleType: "seerr_requester_watched", conditions: null }],
		);
		expect(result.ctx.requesterWatchSourceFamilies).toEqual(new Set(["jellyfin"]));
		expect(result.failedSources).toEqual(new Set(["seerr", "jellyfin"]));
		expect(calls).not.toContainEqual(["PLEX"]);
	});

	it("serializes requester-source discovery failure without provider canaries", async () => {
		const canaries = [
			"https://private.invalid/Title?token=secret",
			"Private Instance Label",
			"private-instance-id",
			"private-section-id",
		];
		const lines: string[] = [];
		const log = pino(
			{ level: "trace", base: null, timestamp: false },
			{ write: (line: string) => lines.push(line) },
		);

		const result = await buildEvalContextWithHealth(
			{
				prisma: {
					serviceInstance: {
						findMany: vi.fn(async (input: { where?: { service?: { in?: string[] } } }) => {
							if (input.where?.service?.in?.join(",") === "PLEX,JELLYFIN,EMBY") {
								throw new Error(canaries.join(" "));
							}
							return [];
						}),
					},
				},
				arrClientFactory: {},
				log,
			} as never,
			"user-1",
			[{ enabled: true, ruleType: "seerr_requester_watched", conditions: null }],
		);

		expect(result.ctx.requesterWatchSourceFamilies).toEqual(new Set());
		expect(lines.join("")).toContain("requester-watch-source-discovery-failed");
		for (const canary of canaries) expect(lines.join("")).not.toContain(canary);
	});

	it("does not treat an unrelated complete map as current item evidence", () => {
		const evaluated = evaluateRuleState(
			item(),
			rule(),
			"RADARR",
			requesterContext(["jellyfin"], {
				seerrMap: new Map([["movie:42", [request("Alice")]]]),
				jellyfinMap: new Map(),
			}),
		);
		expect(evaluated.state).toBe("unknown");
	});

	it("keeps requester rules unknown when no watch family is configured", () => {
		const evaluated = evaluateRuleState(
			item(),
			rule({ ruleType: "seerr_requester_not_watched" }),
			"RADARR",
			requesterContext([], { seerrMap: new Map([["movie:42", [request("Alice")]]]) }),
		);
		expect(evaluated.state).toBe("unknown");
	});
});
