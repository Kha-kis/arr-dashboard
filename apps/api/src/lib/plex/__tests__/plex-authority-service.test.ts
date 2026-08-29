import { describe, expect, it, vi } from "vitest";
import type { PlexCanonicalObservation } from "../plex-canonical-projection.js";
import { createPositivePlexEpisodeDigest } from "../plex-episode-live-collector.js";

const repositoryMocks = vi.hoisted(() => ({
	loadInstanceSelectedEvidence: vi.fn(),
	loadPositiveEpisodeEvidence: vi.fn(),
	loadPositiveEpisodeParentEvidence: vi.fn(),
	scanInstanceEpisodeParentPolicyEvidence: vi.fn(),
}));

vi.mock("../plex-evidence-repository.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../plex-evidence-repository.js")>();
	return {
		...actual,
		loadInstanceSelectedEvidence: repositoryMocks.loadInstanceSelectedEvidence,
		loadPositiveEpisodeEvidence: repositoryMocks.loadPositiveEpisodeEvidence,
		loadPositiveEpisodeParentEvidence: repositoryMocks.loadPositiveEpisodeParentEvidence,
		scanInstanceEpisodeParentPolicyEvidence:
			repositoryMocks.scanInstanceEpisodeParentPolicyEvidence,
	};
});

import {
	PlexAuthorityService,
	PlexAuthorityUnavailableError,
	type PlexPersistedSelectionObservation,
	plexEpisodeParentAuthorityChanged,
	settlePlexAuthorityWindow,
} from "../plex-authority-service.js";
import { createPlexTargetLedgerBinding } from "../plex-generation-target-ledger.js";

const section = {
	key: "movies",
	uuid: "movies-uuid",
	title: "Movies",
	type: "movie" as const,
	refreshing: false as const,
	scannedAt: 1_777_000_000,
	updatedAt: 1_777_000_100,
};
const musicSection = {
	key: "music",
	uuid: "music-uuid",
	title: "Music",
	type: "artist",
	refreshing: false,
	scannedAt: 1_777_000_000,
	updatedAt: 1_777_000_100,
};
const secondMovieSection = {
	...section,
	key: "movies-b",
	uuid: "movies-b-uuid",
	title: "Movies B",
};
const firstShowSection = {
	...section,
	key: "shows-a",
	uuid: "shows-a-uuid",
	title: "Shows A",
	type: "show" as const,
};
const secondShowSection = {
	...firstShowSection,
	key: "shows-b",
	uuid: "shows-b-uuid",
	title: "Shows B",
};
const rowA: PlexCanonicalObservation = {
	sectionId: "movies",
	sectionTitle: "Movies",
	mediaType: "movie",
	tmdbId: 1,
	ratingKey: "101",
	title: "A",
	labels: ["Keep"],
	collections: [],
	watchCount: 1,
	watchedByUsers: ["admin"],
	lastWatchedAt: "2026-08-20T12:00:00.000Z",
	onDeck: false,
	userRating: null,
	addedAt: null,
	thumb: null,
};
const rowB: PlexCanonicalObservation = {
	...rowA,
	tmdbId: 2,
	ratingKey: "102",
	title: "B",
	labels: ["Other"],
	watchCount: 0,
	watchedByUsers: [],
	lastWatchedAt: null,
};

function persisted(
	overrides: Partial<PlexPersistedSelectionObservation> = {},
): PlexPersistedSelectionObservation {
	return {
		generationId: "generation-1",
		connectionGeneration: 4,
		identityGeneration: 9,
		providerIdentity: "plex-machine-a",
		metadata: {
			version: 3,
			publicationLevel: "authoritative",
			completeness: "complete",
			itemCount: 2,
			canonicalizationVersion: 1,
			sections: [section],
			roots: [{ sectionKey: "movies", domain: "membership", digest: "a".repeat(64) }],
		},
		rows: [rowA, rowB],
		...overrides,
	};
}

function probe(overrides: Record<string, unknown> = {}) {
	return {
		activities: [],
		sections: [section, musicSection],
		...overrides,
	};
}

async function settle(
	input: {
		persisted?: PlexPersistedSelectionObservation;
		probes?: Array<ReturnType<typeof probe> | Error>;
		fresh?: PlexCanonicalObservation[][];
		reread?: PlexPersistedSelectionObservation;
		selection?:
			| { kind: "all" }
			| { kind: "targets"; targets: Array<{ mediaType: string; tmdbId: number }> };
		domains?: Array<"membership" | "labels" | "watch">;
		mutation?: boolean;
	} = {},
) {
	const before = input.persisted ?? persisted();
	const probes = [...(input.probes ?? [probe(), probe(), probe()])];
	const fresh = [
		...(input.fresh ?? [
			[rowA, rowB],
			[rowA, rowB],
		]),
	];
	return await settlePlexAuthorityWindow({
		persisted: before,
		selection: input.selection ?? { kind: "all" },
		domains: input.domains ?? ["membership", "labels", "watch"],
		mutation: input.mutation ?? false,
		loadProbe: vi.fn(async () => {
			const value = probes.shift();
			if (value instanceof Error) throw value;
			return value ?? probe();
		}),
		loadFreshRows: vi.fn(async () => fresh.shift() ?? [rowA, rowB]),
		rereadPersisted: vi.fn(async () => input.reread ?? before),
	});
}

async function mutateWithLedgerEvidence(input: {
	metadata?: PlexPersistedSelectionObservation["metadata"];
	reread?: Partial<{
		connectionGeneration: number;
		identityGeneration: number;
	}>;
	ledgerRows?: unknown[];
	ledgerRatingKeys?: string[];
	liveRatingKeys?: string[];
	liveCollectionFailure?: "timeout" | "settlement_probe" | "positive_only";
	withBinding?: boolean;
	updateError?: Error;
}) {
	const targetRow = { ...rowA, thumb: "/library/metadata/101/thumb/1" };
	const ledgerTarget = {
		id: "target-1",
		instanceId: "plex-1",
		generationId: "generation-1",
		sectionId: "movies",
		sectionUuid: "movies-uuid",
		mediaType: "movie" as const,
		tmdbId: 1,
		tvdbId: null,
		ratingKey: "101",
	};
	const ledgerTargets = (input.ledgerRatingKeys ?? ["101"]).map((ratingKey) => ({
		...ledgerTarget,
		id: `target-${ratingKey}`,
		ratingKey,
	}));
	const metadata =
		input.metadata ??
		(input.withBinding
			? {
					...persisted().metadata,
					itemCount: 1,
					...createPlexTargetLedgerBinding({
						instanceId: "plex-1",
						generationId: "generation-1",
						connectionGeneration: 4,
						identityGeneration: 9,
						targets: ledgerTargets,
					}),
				}
			: { ...persisted().metadata, itemCount: 1 });
	const evidence = {
		available: true,
		instanceId: "plex-1",
		instanceName: "Plex",
		generationId: "generation-1",
		publishedAt: new Date("2026-08-20T12:00:00.000Z"),
		itemCount: 1,
		connectionGeneration: 4,
		identityGeneration: 9,
		metadata,
		generationStatus: {},
		sections: metadata.sections,
		rows: [targetRow],
		evidence: {
			availability: "current" as const,
			authority: "authoritative" as const,
			attemptState: "success" as const,
			publicationLevel: "authoritative" as const,
			completeness: "complete" as const,
			reasonCodes: [],
		},
	};
	const reread = { ...evidence, ...input.reread };
	repositoryMocks.loadInstanceSelectedEvidence.mockReset();
	repositoryMocks.loadInstanceSelectedEvidence
		.mockResolvedValueOnce(evidence)
		.mockResolvedValueOnce(reread)
		.mockResolvedValue(evidence);
	const updateMetadataTags = input.updateError
		? vi.fn().mockRejectedValue(input.updateError)
		: vi.fn().mockResolvedValue(undefined);
	const plexGenerationTarget = {
		findMany: vi
			.fn()
			.mockResolvedValue(input.ledgerRows ?? (input.withBinding ? ledgerTargets : [])),
	};
	const plexCache = {
		findMany: vi.fn(() => {
			throw new Error("synthetic cache backfill");
		}),
	};
	const getActivities = vi.fn().mockResolvedValue([]);
	const getLibrarySettlementSections = vi.fn().mockResolvedValue([section, musicSection]);
	if (input.liveCollectionFailure === "timeout") {
		getActivities
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockRejectedValue(new DOMException("CANARY_LIVE_TIMEOUT_787", "TimeoutError"));
	}
	if (input.liveCollectionFailure === "settlement_probe") {
		getLibrarySettlementSections
			.mockResolvedValueOnce([section, musicSection])
			.mockResolvedValueOnce([section, musicSection])
			.mockResolvedValueOnce([section, musicSection])
			.mockRejectedValue(new Error("CANARY_SETTLEMENT_PROBE_787"));
	}
	const positiveOnlySection = {
		...section,
		key: "shows",
		uuid: "shows-uuid",
		title: "Shows",
		type: "show" as const,
	};
	if (input.liveCollectionFailure === "positive_only") {
		getLibrarySettlementSections
			.mockResolvedValueOnce([section, musicSection])
			.mockResolvedValueOnce([section, musicSection])
			.mockResolvedValueOnce([section, musicSection])
			.mockResolvedValue([positiveOnlySection, musicSection]);
	}
	const service = new PlexAuthorityService({
		prisma: {
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue({
					id: "plex-1",
					userId: "user-1",
					service: "PLEX",
					enabled: true,
					expectedIdentity: "plex-machine-a",
					connectionGeneration: 4,
					identityGeneration: 9,
				}),
			},
			plexGenerationTarget,
			plexCache,
		} as never,
		log: {} as never,
		createClient: () =>
			({
				getActivities,
				getLibrarySettlementSections,
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "admin" }]),
				getLibrarySections: vi
					.fn()
					.mockResolvedValue(
						input.liveCollectionFailure === "positive_only"
							? [{ key: "shows", title: "Shows", type: "show" }]
							: [{ key: "movies", title: "Movies", type: "movie" }],
					),
				getLibraryItems: vi.fn().mockResolvedValue(
					input.liveCollectionFailure === "positive_only"
						? [
								{
									ratingKey: "show-1",
									title: "Mapped Show",
									type: "show",
									Guid: [{ id: "tmdb://1" }, { id: "tvdb://1" }],
								},
								{
									ratingKey: "legacy-show",
									title: "Legacy Show",
									type: "show",
									Guid: [],
								},
							]
						: (input.liveRatingKeys ?? ["101"]).map((ratingKey) => ({
								ratingKey,
								title: "A",
								type: "movie",
								Guid: [{ id: "tmdb://1" }],
							})),
				),
				getHistory: vi.fn().mockResolvedValue([]),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
				getOnDeck: vi.fn().mockResolvedValue([]),
				updateMetadataTags,
			}) as never,
	});
	vi.spyOn(
		service as unknown as { freshRows: () => Promise<readonly PlexCanonicalObservation[]> },
		"freshRows",
	).mockResolvedValue([targetRow]);
	const result = await service.mutateMetadataTag({
		userId: "user-1",
		instanceId: "plex-1",
		target: { mediaType: "movie", tmdbId: 1 },
		expectedRatingKey: "101",
		type: "label",
		action: "add",
		name: "Keep",
	});
	return { result, updateMetadataTags, plexGenerationTarget, plexCache };
}

describe("PlexAuthorityService settlement window", () => {
	it("exposes ledger-bound positive episode rows as lower bounds", async () => {
		const target = {
			id: "target-episode",
			instanceId: "plex-1",
			generationId: "generation-v4",
			sectionId: "shows-a",
			sectionUuid: "shows-a-uuid",
			mediaType: "series" as const,
			tmdbId: 42,
			tvdbId: 84,
			ratingKey: "show-42",
		};
		const targetBinding = createPlexTargetLedgerBinding({
			instanceId: target.instanceId,
			generationId: target.generationId,
			connectionGeneration: 4,
			identityGeneration: 9,
			targets: [target],
		});
		const positiveEpisodeRow = {
			id: "episode-1",
			instanceId: "plex-1",
			showTmdbId: 42,
			seasonNumber: 1,
			episodeNumber: 1,
			ratingKey: "episode-1",
			title: "Pilot",
			watched: true,
			watchedByUsers: "[]",
			lastWatchedAt: null,
			watchCount: 3,
			refreshedAt: new Date("2026-08-20T12:00:00.000Z"),
			sourceFingerprint: "source-1",
			connectionGeneration: 4,
			identityGeneration: 9,
		};
		const episodeDigest = createPositivePlexEpisodeDigest(
			[
				{
					instanceId: target.instanceId,
					generationId: target.generationId,
					showTmdbId: target.tmdbId,
					sectionId: target.sectionId,
					sectionUuid: target.sectionUuid,
					mediaType: "series",
					tvdbId: target.tvdbId,
					ratingKey: target.ratingKey,
				},
			],
			[positiveEpisodeRow],
		);
		const observed = {
			available: true,
			instanceId: "plex-1",
			generationId: "episode-generation-v3",
			parentGenerationId: "generation-v4",
			publishedAt: new Date("2026-08-20T12:00:00.000Z"),
			connectionGeneration: 4,
			identityGeneration: 9,
			metadata: {
				version: 3,
				publicationLevel: "positive-only",
				completeness: "partial",
				itemCount: 1,
				canonicalizationVersion: 1,
				capability: {
					domain: "episodes",
					field: "watchCount",
					semantics: "lower-bound",
					operator: "greater_than",
				},
				parentPlexGenerationId: "generation-v4",
				parentMetadataVersion: 4,
				parentPublicationLevel: "positive-only",
				parentTargetDigest: targetBinding.targetDigest,
				episodeDigest,
				partialReasons: [{ code: "currentItemsWithoutTmdbMetadata", count: 1 }],
				connectionGeneration: 4,
				identityGeneration: 9,
			},
			parentMetadata: {
				version: 4,
				publicationLevel: "positive-only",
				completeness: "partial",
				itemCount: 1,
				canonicalizationVersion: 1,
				sections: [firstShowSection],
				observedRoots: [
					{ sectionKey: firstShowSection.key, domain: "episode-parents", digest: "a".repeat(64) },
				],
				capabilities: [
					{
						domain: "episode-parents",
						field: "membership",
						semantics: "observed-targets-only",
						operators: [],
					},
				],
				...targetBinding,
				partialReasons: [{ code: "currentItemsWithoutTmdbMetadata", count: 1 }],
			},
			rows: [positiveEpisodeRow],
			evidence: {
				availability: "current",
				authority: "positive-only",
				attemptState: "partial",
				publicationLevel: "positive-only",
				completeness: "partial",
				reasonCodes: ["latest_attempt_partial"],
			},
		};
		repositoryMocks.loadPositiveEpisodeEvidence.mockResolvedValue(observed);
		const service = new PlexAuthorityService({
			prisma: {
				plexGenerationTarget: { findMany: vi.fn().mockResolvedValue([target]) },
			} as never,
			log: {} as never,
		});

		const result = await service.readPositiveEpisodeEvidence({
			userId: "user-1",
			instanceId: "plex-1",
		});

		expect(result).toMatchObject({
			available: true,
			capability: {
				domain: "episodes",
				field: "watchCount",
				semantics: "lower-bound",
				operator: "greater_than",
			},
			provenance: {
				parentPlexGenerationId: "generation-v4",
				parentTargetDigest: targetBinding.targetDigest,
			},
			rows: [
				{
					showTmdbId: 42,
					seasonNumber: 1,
					episodeNumber: 1,
					ratingKey: "episode-1",
					lowerBound: 3,
					sourceFingerprint: "source-1",
					soleParentTarget: expect.objectContaining({
						generationId: "generation-v4",
						sectionId: "shows-a",
						ratingKey: "show-42",
					}),
				},
			],
		});
		if (result.available) expect(result.rows[0]).not.toHaveProperty("watchCount");

		repositoryMocks.loadPositiveEpisodeEvidence.mockResolvedValueOnce({
			...observed,
			metadata: { ...observed.metadata, episodeDigest: "d".repeat(64) },
		});
		const tampered = await service.readPositiveEpisodeEvidence({
			userId: "user-1",
			instanceId: "plex-1",
		});
		expect(tampered).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["plex_content_digest_changed"] },
		});
	});

	it("omits positive episode rows for duplicate parent targets", async () => {
		const targets = [
			{
				id: "target-42-a",
				instanceId: "plex-1",
				generationId: "generation-v4-duplicate",
				sectionId: "shows-a",
				sectionUuid: "shows-a-uuid",
				mediaType: "series" as const,
				tmdbId: 42,
				tvdbId: 84,
				ratingKey: "show-42-a",
			},
			{
				id: "target-42-b",
				instanceId: "plex-1",
				generationId: "generation-v4-duplicate",
				sectionId: "shows-b",
				sectionUuid: "shows-b-uuid",
				mediaType: "series" as const,
				tmdbId: 42,
				tvdbId: 84,
				ratingKey: "show-42-b",
			},
		];
		const targetBinding = createPlexTargetLedgerBinding({
			instanceId: "plex-1",
			generationId: "generation-v4-duplicate",
			connectionGeneration: 4,
			identityGeneration: 9,
			targets,
		});
		repositoryMocks.loadPositiveEpisodeEvidence.mockResolvedValue({
			available: true,
			instanceId: "plex-1",
			generationId: "episode-generation-v3-duplicate",
			parentGenerationId: "generation-v4-duplicate",
			publishedAt: new Date("2026-08-20T12:00:00.000Z"),
			connectionGeneration: 4,
			identityGeneration: 9,
			metadata: {
				version: 3,
				publicationLevel: "positive-only",
				completeness: "partial",
				itemCount: 0,
				canonicalizationVersion: 1,
				capability: {
					domain: "episodes",
					field: "watchCount",
					semantics: "lower-bound",
					operator: "greater_than",
				},
				parentPlexGenerationId: "generation-v4-duplicate",
				parentMetadataVersion: 4,
				parentPublicationLevel: "positive-only",
				parentTargetDigest: targetBinding.targetDigest,
				episodeDigest: createPositivePlexEpisodeDigest([], []),
				partialReasons: [{ code: "ambiguous_episode_parent_targets", count: 2 }],
				connectionGeneration: 4,
				identityGeneration: 9,
			},
			parentMetadata: {
				version: 4,
				publicationLevel: "positive-only",
				completeness: "partial",
				itemCount: 2,
				canonicalizationVersion: 1,
				sections: [firstShowSection, secondShowSection],
				observedRoots: [
					{ sectionKey: firstShowSection.key, domain: "episode-parents", digest: "a".repeat(64) },
				],
				capabilities: [
					{
						domain: "episode-parents",
						field: "membership",
						semantics: "observed-targets-only",
						operators: [],
					},
				],
				...targetBinding,
				partialReasons: [{ code: "currentItemsWithoutTmdbMetadata", count: 1 }],
			},
			rows: [],
			evidence: {
				availability: "current",
				authority: "positive-only",
				attemptState: "partial",
				publicationLevel: "positive-only",
				completeness: "partial",
				reasonCodes: ["latest_attempt_partial"],
			},
		});
		const service = new PlexAuthorityService({
			prisma: {
				plexGenerationTarget: { findMany: vi.fn().mockResolvedValue(targets) },
			} as never,
			log: {} as never,
		});

		const result = await service.readPositiveEpisodeEvidence({
			userId: "user-1",
			instanceId: "plex-1",
		});

		expect(result).toMatchObject({ available: true, rows: [] });
	});

	it("reads only ledger-verified observed Show parents from a positive V4 generation", async () => {
		const target = {
			id: "target-1",
			instanceId: "plex-1",
			generationId: "generation-v4",
			sectionId: "shows-a",
			sectionUuid: "shows-a-uuid",
			mediaType: "series" as const,
			tmdbId: 42,
			tvdbId: 84,
			ratingKey: "show-42",
		};
		const duplicateTarget = {
			...target,
			id: "target-42-copy",
			sectionId: "shows-b",
			sectionUuid: "shows-b-uuid",
			ratingKey: "show-42-copy",
		};
		const sameSectionDuplicateTarget = {
			...target,
			id: "target-42-same-section-copy",
			ratingKey: "show-42-same-section-copy",
		};
		const otherTarget = {
			...duplicateTarget,
			id: "target-99",
			tmdbId: 99,
			tvdbId: 198,
			ratingKey: "show-99",
		};
		const targetBinding = createPlexTargetLedgerBinding({
			instanceId: target.instanceId,
			generationId: target.generationId,
			connectionGeneration: 4,
			identityGeneration: 9,
			targets: [target, sameSectionDuplicateTarget, duplicateTarget, otherTarget],
		});
		repositoryMocks.loadPositiveEpisodeParentEvidence.mockResolvedValue({
			available: true,
			instanceId: "plex-1",
			generationId: "generation-v4",
			connectionGeneration: 4,
			identityGeneration: 9,
			metadata: {
				version: 4,
				publicationLevel: "positive-only",
				completeness: "partial",
				itemCount: 2,
				canonicalizationVersion: 1,
				sections: [firstShowSection, secondShowSection],
				observedRoots: [
					{ sectionKey: firstShowSection.key, domain: "episode-parents", digest: "a".repeat(64) },
				],
				capabilities: [
					{
						domain: "episode-parents",
						field: "membership",
						semantics: "observed-targets-only",
						operators: [],
					},
				],
				...targetBinding,
				partialReasons: [{ code: "currentItemsWithoutTmdbMetadata", count: 1 }],
			},
			rows: [
				{
					...rowA,
					instanceId: "plex-1",
					mediaType: "series",
					tmdbId: 42,
					sectionId: "shows-a",
					ratingKey: "show-42",
					connectionGeneration: 4,
					identityGeneration: 9,
				},
				{
					...rowA,
					instanceId: "plex-1",
					mediaType: "series",
					tmdbId: 99,
					sectionId: "shows-b",
					ratingKey: "show-99",
					connectionGeneration: 4,
					identityGeneration: 9,
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
		});
		const service = new PlexAuthorityService({
			prisma: {
				serviceInstance: {
					findFirst: vi.fn().mockResolvedValue({
						id: "plex-1",
						userId: "user-1",
						service: "PLEX",
						enabled: true,
					}),
				},
				plexGenerationTarget: {
					findMany: vi
						.fn()
						.mockResolvedValue([target, sameSectionDuplicateTarget, duplicateTarget, otherTarget]),
				},
			} as never,
			log: {} as never,
		});

		const result = await service.readPositiveEpisodeParents({
			userId: "user-1",
			instanceId: "plex-1",
			showTmdbIds: [42, 99, 999],
		});
		expect(result.available).toBe(true);
		if (!result.available) return;
		expect(result).toMatchObject({
			available: true,
			capability: {
				domain: "episode-parents",
				field: "membership",
				semantics: "observed-targets-only",
			},
			rows: expect.arrayContaining([
				expect.objectContaining({ tmdbId: 42, sectionId: "shows-a", ratingKey: "show-42" }),
				expect.objectContaining({ tmdbId: 99, sectionId: "shows-b", ratingKey: "show-99" }),
			]),
			targets: expect.arrayContaining([
				expect.objectContaining({ tmdbId: 42, ratingKey: "show-42" }),
				expect.objectContaining({
					tmdbId: 42,
					sectionId: "shows-a",
					ratingKey: "show-42-same-section-copy",
				}),
				expect.objectContaining({ tmdbId: 99, ratingKey: "show-99" }),
			]),
		});
		expect(result.targets).toHaveLength(3);
		expect(result.targets).not.toContainEqual(
			expect.objectContaining({ ratingKey: "show-42-copy" }),
		);
		expect(result).not.toMatchObject({
			rows: [expect.objectContaining({ watchCount: expect.anything() })],
		});
	});

	it("uses an authoritative V3 generation through the positive parent reader", async () => {
		const target = {
			id: "target-v3",
			instanceId: "plex-1",
			generationId: "generation-v3",
			sectionId: "shows-a",
			sectionUuid: "shows-a-uuid",
			mediaType: "series" as const,
			tmdbId: 42,
			tvdbId: 84,
			ratingKey: "show-42",
		};
		const targetBinding = createPlexTargetLedgerBinding({
			instanceId: target.instanceId,
			generationId: target.generationId,
			connectionGeneration: 4,
			identityGeneration: 9,
			targets: [target],
		});
		repositoryMocks.loadPositiveEpisodeParentEvidence.mockResolvedValue({
			available: true,
			instanceId: "plex-1",
			generationId: "generation-v3",
			connectionGeneration: 4,
			identityGeneration: 9,
			metadata: {
				version: 3,
				publicationLevel: "authoritative",
				completeness: "complete",
				itemCount: 1,
				canonicalizationVersion: 1,
				sections: [firstShowSection],
				roots: [{ sectionKey: "shows-a", domain: "episode-parents", digest: "a".repeat(64) }],
				...targetBinding,
			},
			rows: [
				{
					...rowA,
					instanceId: "plex-1",
					mediaType: "series",
					tmdbId: 42,
					sectionId: "shows-a",
					ratingKey: "show-42",
					connectionGeneration: 4,
					identityGeneration: 9,
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
		});
		const service = new PlexAuthorityService({
			prisma: {
				plexGenerationTarget: { findMany: vi.fn().mockResolvedValue([target]) },
			} as never,
			log: {} as never,
		});

		const result = await service.readPositiveEpisodeParents({
			userId: "user-1",
			instanceId: "plex-1",
			showTmdbIds: [42],
		});

		expect(result).toMatchObject({
			available: true,
			provenance: { publicationLevel: "authoritative", completeness: "complete" },
			partialReasons: [],
			rows: [{ tmdbId: 42, ratingKey: "show-42" }],
		});
	});
	it.each([
		[
			1,
			{
				version: 1,
				publicationLevel: "authoritative",
				completeness: "complete",
				itemCount: null,
				sections: [{ key: "movies", title: "Movies", type: "movie" }],
			},
		],
		[
			2,
			{
				version: 2,
				publicationLevel: "authoritative",
				completeness: "complete",
				itemCount: 2,
				sections: [{ key: "movies", title: "Movies", type: "movie" }],
			},
		],
	] as const)("%s. legacy metadata cannot authorize exact evidence", async (_case, metadata) => {
		await expect(
			settle({ persisted: persisted({ metadata: structuredClone(metadata) as never }) }),
		).resolves.toMatchObject({
			ok: false,
			reasonCode: "plex_settlement_metadata_missing",
		});
	});

	it("3. settled unchanged V3 becomes authoritative", async () => {
		await expect(settle()).resolves.toMatchObject({
			ok: true,
			persisted: { generationId: "generation-1" },
		});
	});

	it("4. a relevant section scan is unavailable", async () => {
		await expect(
			settle({
				probes: [
					probe({
						activities: [
							{ type: "library.update.section", Context: { librarySectionID: "movies" } },
						],
					}),
				],
			}),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_library_scan_in_progress" });
	});

	it("5. a refreshing selected section is unavailable", async () => {
		await expect(
			settle({ probes: [probe({ sections: [{ ...section, refreshing: true }, musicSection] })] }),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_library_scan_in_progress" });
	});

	it("6. unattributable metadata activity blocks the instance", async () => {
		await expect(
			settle({ probes: [probe({ activities: [{ type: "library.update.item.metadata" }] })] }),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_metadata_refresh_in_progress" });
	});

	it("7. an attributed music scan does not invalidate Movie authority", async () => {
		await expect(
			settle({
				probes: [
					probe({
						activities: [
							{ type: "library.update.section", Context: { librarySectionID: "music" } },
						],
					}),
					probe(),
					probe(),
				],
			}),
		).resolves.toMatchObject({ ok: true });
	});

	it("8. activities failure is unavailable", async () => {
		await expect(
			settle({ probes: [new PlexAuthorityUnavailableError("plex_activity_unavailable")] }),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_activity_unavailable" });
	});

	it("9. section-state failure is unavailable", async () => {
		await expect(
			settle({ probes: [new PlexAuthorityUnavailableError("plex_section_state_unavailable")] }),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_section_state_unavailable" });
	});

	it("10. section UUID change is unavailable", async () => {
		await expect(
			settle({
				probes: [probe(), probe({ sections: [{ ...section, uuid: "changed" }, musicSection] })],
			}),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_library_revision_changed" });
	});

	it("11. a scan that starts after publication is unavailable", async () => {
		await expect(
			settle({
				probes: [
					probe({
						activities: [
							{ type: "library.update.section", Context: { librarySectionID: "movies" } },
						],
					}),
				],
			}),
		).resolves.toMatchObject({ ok: false });
	});

	it("12. a missed completed scan with changed content is unavailable", async () => {
		await expect(settle({ fresh: [[rowA], [rowA]] })).resolves.toMatchObject({
			ok: false,
			reasonCode: "plex_content_digest_changed",
		});
	});

	it("13. same-second scannedAt cannot hide deletion", async () => {
		await expect(
			settle({ probes: [probe(), probe(), probe()], fresh: [[rowA], [rowA]] }),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_content_digest_changed" });
	});

	it("14. a completed no-op scan may regain authority", async () => {
		await expect(
			settle({
				probes: [
					probe({ sections: [{ ...section, scannedAt: section.scannedAt + 1 }, musicSection] }),
					probe({ sections: [{ ...section, scannedAt: section.scannedAt + 1 }, musicSection] }),
					probe({ sections: [{ ...section, scannedAt: section.scannedAt + 1 }, musicSection] }),
				],
			}),
		).resolves.toMatchObject({ ok: true });
	});

	it("15. an addition invalidates the old generation", async () => {
		const added = { ...rowA, tmdbId: 3, ratingKey: "103", title: "Added" };
		await expect(
			settle({
				fresh: [
					[rowA, rowB, added],
					[rowA, rowB, added],
				],
			}),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_content_digest_changed" });
	});

	it("16. a legitimate deletion invalidates the old generation until refresh", async () => {
		await expect(settle({ fresh: [[rowA], [rowA]] })).resolves.toMatchObject({ ok: false });
	});

	it("17. provider identity change during the window is unavailable", async () => {
		await expect(
			settle({ reread: persisted({ providerIdentity: "plex-machine-b" }) }),
		).resolves.toMatchObject({ ok: false, reasonCode: "identity_generation_mismatch" });
	});

	it("18. connection generation change during the window is unavailable", async () => {
		await expect(settle({ reread: persisted({ connectionGeneration: 5 }) })).resolves.toMatchObject(
			{ ok: false, reasonCode: "connection_generation_mismatch" },
		);
	});

	it("19. persisted generation change during the window is unavailable", async () => {
		await expect(
			settle({ reread: persisted({ generationId: "generation-2" }) }),
		).resolves.toMatchObject({ ok: false, reasonCode: "generation_changed" });
	});

	it("20. preliminary and final live projections must match", async () => {
		await expect(
			settle({
				fresh: [
					[rowA, rowB],
					[{ ...rowA, labels: ["Changed"] }, rowB],
				],
			}),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_content_digest_changed" });
	});

	it("21. final live projection must equal the persisted selection", async () => {
		await expect(settle({ fresh: [[rowA], [rowA]] })).resolves.toMatchObject({
			ok: false,
			reasonCode: "plex_content_digest_changed",
		});
	});

	it("22. unrelated target label changes preserve selected target authority", async () => {
		await expect(
			settle({
				selection: { kind: "targets", targets: [{ mediaType: "movie", tmdbId: 1 }] },
				domains: ["membership", "labels"],
				fresh: [
					[rowA, { ...rowB, labels: ["Changed"] }],
					[rowA, { ...rowB, labels: ["Changed"] }],
				],
			}),
		).resolves.toMatchObject({ ok: true });
	});

	it("23. unrelated watch-domain changes preserve selected label authority", async () => {
		await expect(
			settle({
				selection: { kind: "targets", targets: [{ mediaType: "movie", tmdbId: 1 }] },
				domains: ["membership", "labels"],
				fresh: [
					[rowA, { ...rowB, watchCount: 99 }],
					[rowA, { ...rowB, watchCount: 99 }],
				],
			}),
		).resolves.toMatchObject({ ok: true });
	});

	it.each([1, 2] as const)("24. V%s cannot authorize a mutation", async (version) => {
		const metadata =
			version === 1
				? {
						version: 1 as const,
						publicationLevel: "authoritative" as const,
						completeness: "complete" as const,
						itemCount: null,
						sections: [{ key: "movies", title: "Movies", type: "movie" as const }],
					}
				: {
						version: 2 as const,
						publicationLevel: "authoritative" as const,
						completeness: "complete" as const,
						itemCount: 2,
						sections: [{ key: "movies", title: "Movies", type: "movie" as const }],
					};
		await expect(
			settle({ persisted: persisted({ metadata }), mutation: true }),
		).resolves.toMatchObject({ ok: false });
	});

	it("25. mutation cannot proceed while live settlement is unavailable", async () => {
		await expect(
			settle({
				mutation: true,
				probes: [probe({ activities: [{ type: "library.update.item.metadata" }] })],
			}),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_metadata_refresh_in_progress" });
	});

	it("26. makes the final live projection the terminal upstream observation", async () => {
		const events: string[] = [];
		const before = persisted();
		const result = await settlePlexAuthorityWindow({
			persisted: before,
			selection: { kind: "all" },
			domains: ["membership"],
			mutation: true,
			loadProbe: vi.fn(async () => {
				events.push("probe");
				return probe();
			}),
			loadFreshRows: vi.fn(async () => {
				events.push("fresh");
				return [rowA, rowB];
			}),
			rereadPersisted: vi.fn(async () => {
				events.push("reread");
				return before;
			}),
		});

		expect(result).toMatchObject({ ok: true });
		expect(events).toEqual(["probe", "fresh", "probe", "probe", "fresh", "reread"]);
	});

	it("27. full section-catalog authority rejects a newly scanning supported section", async () => {
		const addedSection = {
			...section,
			key: "new-movies",
			uuid: "new-movies-uuid",
			title: "New Movies",
		};
		await expect(
			settle({
				probes: [
					probe({
						activities: [
							{
								type: "library.update.section",
								Context: { librarySectionID: "new-movies" },
							},
						],
						sections: [section, addedSection, musicSection],
					}),
				],
			}),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_library_scan_in_progress" });
	});

	it("28. full section-catalog authority rejects a newly idle supported section", async () => {
		const addedSection = {
			...section,
			key: "new-movies",
			uuid: "new-movies-uuid",
			title: "New Movies",
		};
		await expect(
			settle({
				probes: [probe({ sections: [section, addedSection, musicSection] })],
			}),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_library_revision_changed" });
	});

	it("29. episode parent comparison detects a changed live parent fixed point", () => {
		const after = {
			...persisted(),
			rows: [{ ...rowA, ratingKey: "changed-parent" }, rowB],
		};
		expect(
			plexEpisodeParentAuthorityChanged(persisted(), after, [{ tmdbId: 1, mediaType: "movie" }]),
		).toBe("plex_content_digest_changed");
	});

	it("30. a selected target with multiple live provider identities fails closed", async () => {
		const edition = { ...rowA, ratingKey: "edition-2" };
		await expect(
			settle({
				selection: { kind: "targets", targets: [{ mediaType: "movie", tmdbId: 1 }] },
				domains: ["membership"],
				fresh: [
					[rowA, edition, rowB],
					[rowA, edition, rowB],
				],
			}),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_content_digest_changed" });
	});

	it("31. the all-episodes path rejects a show added after its initial parent fixed point", async () => {
		const initialParent = {
			available: true,
			instanceId: "plex-1",
			instanceName: "Plex",
			generationId: "parent-1",
			publishedAt: new Date("2026-08-20T12:00:00.000Z"),
			itemCount: 1,
			connectionGeneration: 4,
			identityGeneration: 9,
			metadata: persisted().metadata,
			generationStatus: {},
			sections: [section],
			rows: [{ ...rowA, mediaType: "series" }],
			evidence: {
				availability: "current",
				authority: "current",
				attemptState: "success",
				publicationLevel: "authoritative",
				completeness: "complete",
				reasonCodes: [],
			},
		};
		const changedParent = {
			...initialParent,
			generationId: "parent-2",
			itemCount: 2,
			rows: [...initialParent.rows, { ...rowB, mediaType: "series", tmdbId: 3, ratingKey: "103" }],
		};
		const episodeEvidence = {
			...initialParent,
			generationId: "episode-1",
			parentGenerationId: "parent-1",
			rows: [],
		};
		const findFirst = vi.fn().mockResolvedValue({
			id: "plex-1",
			expectedIdentity: "plex-machine-a",
		});
		const service = new PlexAuthorityService({
			prisma: { serviceInstance: { findFirst } } as never,
			log: {} as never,
		});
		const readParent = vi
			.spyOn(service, "readInstance")
			.mockResolvedValueOnce(initialParent as never)
			.mockResolvedValueOnce(changedParent as never);
		vi.spyOn(service, "readInstanceSelectedEpisodes").mockResolvedValue(episodeEvidence as never);

		const result = await service.readInstanceEpisodes({
			userId: "user-1",
			instanceId: "plex-1",
		});

		expect(readParent).toHaveBeenCalledTimes(2);
		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["generation_changed"] },
		});
	});

	it("32. selected target authority rejects a scan in another persisted supported section", async () => {
		const before = persisted({
			metadata: {
				...persisted().metadata,
				itemCount: 1,
				sections: [section, secondMovieSection],
			},
			rows: [rowA],
		});
		const scanningProbe = probe({
			activities: [
				{
					type: "library.update.section",
					Context: { librarySectionID: secondMovieSection.key },
				},
			],
			sections: [section, secondMovieSection, musicSection],
		});

		await expect(
			settle({
				persisted: before,
				selection: { kind: "targets", targets: [{ mediaType: "movie", tmdbId: 1 }] },
				domains: ["membership"],
				probes: [scanningProbe, scanningProbe, scanningProbe],
				fresh: [[rowA], [rowA]],
			}),
		).resolves.toMatchObject({
			ok: false,
			reasonCode: "plex_library_scan_in_progress",
		});
	});

	it("33. selected target authority accepts the complete unchanged supported catalog", async () => {
		const before = persisted({
			metadata: {
				...persisted().metadata,
				itemCount: 1,
				sections: [section, secondMovieSection],
			},
			rows: [rowA],
		});
		const settledProbe = probe({ sections: [section, secondMovieSection, musicSection] });

		await expect(
			settle({
				persisted: before,
				selection: { kind: "targets", targets: [{ mediaType: "movie", tmdbId: 1 }] },
				domains: ["membership"],
				probes: [settledProbe, settledProbe, settledProbe],
				fresh: [[rowA], [rowA]],
			}),
		).resolves.toMatchObject({ ok: true });
	});

	it("34. selected target authority rejects an idle supported section absent from V3", async () => {
		const expandedProbe = probe({ sections: [section, secondMovieSection, musicSection] });

		await expect(
			settle({
				persisted: persisted({ rows: [rowA] }),
				selection: { kind: "targets", targets: [{ mediaType: "movie", tmdbId: 1 }] },
				domains: ["membership"],
				probes: [expandedProbe, expandedProbe, expandedProbe],
				fresh: [[rowA], [rowA]],
			}),
		).resolves.toMatchObject({
			ok: false,
			reasonCode: "plex_library_revision_changed",
		});
	});

	it("35. full exact authority rejects an active newly added supported section", async () => {
		const expandedScanningProbe = probe({
			activities: [
				{
					type: "library.update.section",
					Context: { librarySectionID: secondMovieSection.key },
				},
			],
			sections: [section, secondMovieSection, musicSection],
		});

		await expect(
			settle({
				probes: [expandedScanningProbe, expandedScanningProbe, expandedScanningProbe],
			}),
		).resolves.toMatchObject({
			ok: false,
			reasonCode: "plex_library_scan_in_progress",
		});
	});

	it("36. selected episode parent authority rejects a scan in another supported Show section", async () => {
		const showRow = {
			...rowA,
			sectionId: firstShowSection.key,
			sectionTitle: firstShowSection.title,
			mediaType: "series",
		};
		const before = persisted({
			metadata: {
				...persisted().metadata,
				itemCount: 1,
				sections: [firstShowSection, secondShowSection],
			},
			rows: [showRow],
		});
		const scanningProbe = probe({
			activities: [
				{
					type: "library.update.section",
					Context: { librarySectionID: secondShowSection.key },
				},
			],
			sections: [firstShowSection, secondShowSection, musicSection],
		});

		await expect(
			settle({
				persisted: before,
				selection: { kind: "targets", targets: [{ mediaType: "series", tmdbId: 1 }] },
				domains: ["membership"],
				probes: [scanningProbe, scanningProbe, scanningProbe],
				fresh: [[showRow], [showRow]],
			}),
		).resolves.toMatchObject({
			ok: false,
			reasonCode: "plex_library_scan_in_progress",
		});
	});

	it("37. target mutation does not reach Plex while another supported section scans", async () => {
		const targetRow = {
			...rowA,
			thumb: "/library/metadata/101/thumb/1",
		};
		const metadata = {
			...persisted().metadata,
			itemCount: 1,
			sections: [section, secondMovieSection],
		};
		const evidence = {
			available: true,
			instanceId: "plex-1",
			instanceName: "Plex",
			generationId: "generation-1",
			publishedAt: new Date("2026-08-20T12:00:00.000Z"),
			itemCount: 1,
			connectionGeneration: 4,
			identityGeneration: 9,
			metadata,
			generationStatus: {},
			sections: metadata.sections,
			rows: [targetRow],
			evidence: {
				availability: "current",
				authority: "authoritative",
				attemptState: "success",
				publicationLevel: "authoritative",
				completeness: "complete",
				reasonCodes: [],
			},
		};
		repositoryMocks.loadInstanceSelectedEvidence.mockResolvedValue(evidence);
		const updateMetadataTags = vi.fn().mockResolvedValue(undefined);
		const client = {
			getActivities: vi.fn().mockResolvedValue([
				{
					type: "library.update.section",
					Context: { librarySectionID: secondMovieSection.key },
				},
			]),
			getLibrarySettlementSections: vi
				.fn()
				.mockResolvedValue([section, secondMovieSection, musicSection]),
			updateMetadataTags,
		};
		const service = new PlexAuthorityService({
			prisma: {
				serviceInstance: {
					findFirst: vi.fn().mockResolvedValue({
						id: "plex-1",
						userId: "user-1",
						service: "PLEX",
						enabled: true,
						expectedIdentity: "plex-machine-a",
					}),
				},
			} as never,
			log: {} as never,
			createClient: () => client as never,
		});
		vi.spyOn(
			service as unknown as {
				freshRows: (...args: unknown[]) => Promise<readonly PlexCanonicalObservation[]>;
			},
			"freshRows",
		).mockResolvedValue([targetRow]);
		const result = await service.mutateMetadataTag({
			userId: "user-1",
			instanceId: "plex-1",
			target: { mediaType: "movie", tmdbId: 1 },
			expectedRatingKey: "101",
			type: "label",
			action: "add",
			name: "Keep",
		});

		expect(updateMetadataTags).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			ok: false,
			evidence: { reasonCodes: ["plex_library_scan_in_progress"] },
		});
	});

	it("13/16/29. ledger-dependent mutation denies an old V3 binding without reading PlexCache to synthesize targets", async () => {
		const { result, updateMetadataTags, plexGenerationTarget, plexCache } =
			await mutateWithLedgerEvidence({
				metadata: { ...persisted().metadata, itemCount: 1 },
				ledgerRows: [],
			});

		expect(result).toMatchObject({
			ok: false,
			evidence: { reasonCodes: ["target_ledger_binding_missing"] },
		});
		expect(updateMetadataTags).not.toHaveBeenCalled();
		expect(plexGenerationTarget.findMany).not.toHaveBeenCalled();
		expect(plexCache.findMany).not.toHaveBeenCalled();
	});

	it("15. ordinary policy observation preserves an authoritative old V3 generation", async () => {
		const now = new Date();
		const metadata = persisted().metadata;
		const status = {
			instanceId: "plex-1",
			lastRefreshedAt: now,
			lastResult: "success",
			lastErrorMessage: null,
			lastAttemptAt: now,
			lastAttemptResult: "success",
			lastAttemptErrorMessage: null,
			itemCount: 1,
			connectionGeneration: 4,
			identityGeneration: 9,
			generationId: "generation-1",
			generationMetadata: JSON.stringify({ ...metadata, itemCount: 1 }),
		};
		const instance = {
			id: "plex-1",
			userId: "user-1",
			service: "PLEX",
			enabled: true,
			label: "Plex",
			expectedIdentity: "plex-machine-a",
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityStatus: "VERIFIED",
			identityVerifiedAt: now,
			connectionGeneration: 4,
			identityGeneration: 9,
		};
		const cacheRow = {
			id: "cache-1",
			instanceId: "plex-1",
			tmdbId: 1,
			mediaType: "movie",
			sectionId: "movies",
			sectionTitle: "Movies",
			lastWatchedAt: null,
			watchCount: 0,
			watchedByUsers: "[]",
			onDeck: false,
			userRating: null,
			collections: "[]",
			labels: "[]",
			addedAt: null,
			connectionGeneration: 4,
			identityGeneration: 9,
		};
		const service = new PlexAuthorityService({
			prisma: {
				serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
				cacheRefreshStatus: { findMany: vi.fn().mockResolvedValue([status]) },
				plexCache: { findMany: vi.fn().mockResolvedValue([cacheRow]) },
			} as never,
			log: {} as never,
		});
		vi.spyOn(service, "readInstance").mockResolvedValue({
			available: true,
			instanceId: "plex-1",
			instanceName: "Plex",
			generationId: "generation-1",
			publishedAt: now,
			itemCount: 1,
			connectionGeneration: 4,
			identityGeneration: 9,
			metadata: { ...metadata, itemCount: 1 },
			generationStatus: status,
			sections: metadata.sections,
			rows: [rowA],
			evidence: {
				availability: "current",
				authority: "authoritative",
				attemptState: "success",
				publicationLevel: "authoritative",
				completeness: "complete",
				reasonCodes: [],
			},
		} as never);

		await expect(
			service.scanInstancePolicy({
				userId: "user-1",
				instanceId: "plex-1",
				domains: ["membership"],
			}),
		).resolves.toMatchObject({ available: true, generationId: "generation-1", rowCount: 1 });
	});

	it("38. episode parent scans send every selected duplicate Show rating key from the verified ledger", async () => {
		const showRow = {
			...rowA,
			sectionId: "shows-a",
			sectionTitle: "Shows A",
			mediaType: "series" as const,
			tmdbId: 7,
			ratingKey: "show-a",
		};
		const targets = ["show-a", "show-b"].map((ratingKey) => ({
			id: `target-${ratingKey}`,
			instanceId: "plex-1",
			generationId: "generation-1",
			sectionId: "shows-a",
			sectionUuid: "shows-a-uuid",
			mediaType: "series" as const,
			tmdbId: 7,
			tvdbId: 70,
			ratingKey,
		}));
		const metadata = {
			...persisted().metadata,
			itemCount: 1,
			sections: [firstShowSection],
			...createPlexTargetLedgerBinding({
				instanceId: "plex-1",
				generationId: "generation-1",
				connectionGeneration: 4,
				identityGeneration: 9,
				targets,
			}),
		};
		const current = {
			available: true,
			instanceId: "plex-1",
			instanceName: "Plex",
			generationId: "generation-1",
			connectionGeneration: 4,
			identityGeneration: 9,
			metadata,
			rows: [showRow],
			evidence: persisted().metadata,
		};
		repositoryMocks.scanInstanceEpisodeParentPolicyEvidence.mockImplementation(
			async (
				_prisma: unknown,
				input: { onBatch?: (batch: { rows: (typeof showRow)[] }) => Promise<void> },
			) => {
				await input.onBatch?.({ rows: [showRow] });
				return current;
			},
		);
		const service = new PlexAuthorityService({
			prisma: {
				plexGenerationTarget: { findMany: vi.fn().mockResolvedValue(targets) },
			} as never,
			log: {} as never,
		});
		vi.spyOn(service, "readInstance").mockResolvedValue(current as never);
		const received: string[] = [];

		await expect(
			service.scanInstanceEpisodeParentPolicy({
				userId: "user-1",
				instanceId: "plex-1",
				domains: ["membership", "episode-parents", "watch"],
				onTargets: (selected) => {
					received.push(...selected.map((target) => target.ratingKey));
				},
			}),
		).resolves.toMatchObject({ available: true });

		expect(received.sort()).toEqual(["show-a", "show-b"]);
	});

	it("24. ledger-dependent mutation denies connection generation that changes during verification", async () => {
		const { result, updateMetadataTags, plexGenerationTarget } = await mutateWithLedgerEvidence({
			reread: { connectionGeneration: 5 },
			withBinding: true,
		});

		expect(result).toMatchObject({
			ok: false,
			evidence: { reasonCodes: ["connection_generation_mismatch"] },
		});
		expect(updateMetadataTags).not.toHaveBeenCalled();
		expect(plexGenerationTarget.findMany).not.toHaveBeenCalled();
	});

	it("25. ledger-dependent mutation denies identity generation that changes during verification", async () => {
		const { result, updateMetadataTags, plexGenerationTarget } = await mutateWithLedgerEvidence({
			reread: { identityGeneration: 10 },
			withBinding: true,
		});

		expect(result).toMatchObject({
			ok: false,
			evidence: { reasonCodes: ["identity_generation_mismatch"] },
		});
		expect(updateMetadataTags).not.toHaveBeenCalled();
		expect(plexGenerationTarget.findMany).not.toHaveBeenCalled();
	});

	it.each([
		["connection generation", { connectionGeneration: 5 }, "provider_connection_changed"],
		["identity generation", { identityGeneration: 10 }, "provider_identity_changed"],
	] as const)(
		"adds a bounded diagnostic when %s changes without authorizing a write",
		async (_name, reread, reasonCode) => {
			const { result, updateMetadataTags } = await mutateWithLedgerEvidence({
				reread,
				withBinding: true,
			});

			expect(result).toMatchObject({ ok: false, reasonCode });
			expect(updateMetadataTags).not.toHaveBeenCalled();
		},
	);

	it.each([
		["missing", [], ["101"], "live_target_missing"],
		["ambiguous", ["101", "102"], ["101", "102"], "live_target_ambiguous"],
		["changed or reused", ["102"], ["101"], "live_target_changed"],
	] as const)(
		"classifies a %s live target without changing the fail-closed result",
		async (_name, liveRatingKeys, ledgerRatingKeys, reasonCode) => {
			const { result, updateMetadataTags } = await mutateWithLedgerEvidence({
				withBinding: true,
				liveRatingKeys: [...liveRatingKeys],
				ledgerRatingKeys: [...ledgerRatingKeys],
			});

			expect(result).toMatchObject({ ok: false, reasonCode });
			expect(updateMetadataTags).not.toHaveBeenCalled();
		},
	);

	it.each([
		["a live request timeout", "timeout"],
		["a settlement probe failure", "settlement_probe"],
		["a positive-only live catalog", "positive_only"],
	] as const)(
		"classifies %s as unavailable evidence without reporting target drift",
		async (_name, liveCollectionFailure) => {
			const { result, updateMetadataTags } = await mutateWithLedgerEvidence({
				withBinding: true,
				liveCollectionFailure,
			});

			expect(result).toMatchObject({
				ok: false,
				reasonCode: "live_evidence_unavailable",
			});
			expect(result).not.toMatchObject({ reasonCode: "live_target_changed" });
			expect(updateMetadataTags).not.toHaveBeenCalled();
		},
	);

	it.each([
		{
			name: "connection generation change",
			reread: { connectionGeneration: 5 },
			expectedReason: "provider_connection_changed",
			expectedDecision: { available: false, targetRatingKeys: [], writeCount: 0 },
		},
		{
			name: "identity generation change",
			reread: { identityGeneration: 10 },
			expectedReason: "provider_identity_changed",
			expectedDecision: { available: false, targetRatingKeys: [], writeCount: 0 },
		},
		{
			name: "missing live target",
			liveRatingKeys: [],
			ledgerRatingKeys: ["101"],
			expectedReason: "live_target_missing",
			expectedDecision: { available: false, targetRatingKeys: [], writeCount: 0 },
		},
		{
			name: "ambiguous live target",
			liveRatingKeys: ["101", "102"],
			ledgerRatingKeys: ["101", "102"],
			expectedReason: "live_target_ambiguous",
			expectedDecision: { available: false, targetRatingKeys: [], writeCount: 0 },
		},
		{
			name: "changed live target",
			liveRatingKeys: ["102"],
			ledgerRatingKeys: ["101"],
			expectedReason: "live_target_changed",
			expectedDecision: { available: false, targetRatingKeys: [], writeCount: 0 },
		},
		{
			name: "authorized target",
			expectedDecision: { available: true, targetRatingKeys: ["101"], writeCount: 1 },
		},
	] as const)(
		"keeps the authority decision and selected write targets unchanged when annotating $name",
		async (testCase) => {
			const input: Parameters<typeof mutateWithLedgerEvidence>[0] = { withBinding: true };
			if ("reread" in testCase) input.reread = testCase.reread;
			if ("liveRatingKeys" in testCase && testCase.liveRatingKeys) {
				input.liveRatingKeys = [...testCase.liveRatingKeys];
			}
			if ("ledgerRatingKeys" in testCase && testCase.ledgerRatingKeys) {
				input.ledgerRatingKeys = [...testCase.ledgerRatingKeys];
			}

			const { result, updateMetadataTags } = await mutateWithLedgerEvidence(input);
			const decisionWithoutReasonProjection = {
				available: result.ok,
				targetRatingKeys: updateMetadataTags.mock.calls.map((call) => call[0]),
				writeCount: updateMetadataTags.mock.calls.length,
			};
			const decisionWithReasonProjection = result.ok
				? decisionWithoutReasonProjection
				: { ...decisionWithoutReasonProjection, reasonCode: result.reasonCode };
			const { reasonCode: _reasonCode, ...decisionIgnoringReason } =
				"reasonCode" in decisionWithReasonProjection
					? decisionWithReasonProjection
					: { ...decisionWithReasonProjection, reasonCode: undefined };

			expect(decisionIgnoringReason).toEqual(testCase.expectedDecision);
			if ("expectedReason" in testCase) {
				expect(decisionWithReasonProjection).toMatchObject({ reasonCode: testCase.expectedReason });
			}
		},
	);

	it("keeps an authorized mutation result and single-write accounting unchanged", async () => {
		const { result, updateMetadataTags } = await mutateWithLedgerEvidence({ withBinding: true });

		expect(result).toEqual({ ok: true });
		expect(updateMetadataTags).toHaveBeenCalledOnce();
	});

	it("wraps an upstream write exception without retaining provider content", async () => {
		const canaries = [
			"CANARY_WRITE_ERROR_787",
			"https://CANARY_WRITE_HOST_787.invalid/private",
			"CANARY_WRITE_TOKEN_787",
			"CANARY_WRITE_RESPONSE_787",
		];
		let thrown: unknown;
		try {
			await mutateWithLedgerEvidence({
				withBinding: true,
				updateError: new Error(canaries.join(" ")),
			});
		} catch (error) {
			thrown = error;
		}
		const loggerSerialization = vi.fn();
		loggerSerialization({ err: thrown });
		const inspection =
			thrown instanceof Error
				? Object.fromEntries(
						Object.getOwnPropertyNames(thrown).map((key) => [
							key,
							(thrown as unknown as Record<string, unknown>)[key],
						]),
					)
				: thrown;
		const serialized = JSON.stringify({ thrown, inspection, logs: loggerSerialization.mock.calls });
		expect(thrown).toMatchObject({
			name: "PlexMetadataTagWriteError",
			code: "upstream_write_failed",
			responseCategory: "unavailable",
			message: "Plex metadata tag write failed",
		});
		expect(thrown).not.toHaveProperty("cause");
		expect(thrown).not.toHaveProperty("stack");
		for (const canary of canaries) expect(serialized).not.toContain(canary);
	});
});
