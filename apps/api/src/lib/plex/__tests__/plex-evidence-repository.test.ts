import { describe, expect, it, vi } from "vitest";
import { verifiedIdentityData } from "../../services/service-identity-lifecycle.js";
import { createPositivePlexEpisodeDigest } from "../plex-episode-live-collector.js";
import {
	decodePlexEpisodeGenerationMetadata,
	getPublishedEpisodeGenerationObservation,
	loadInstanceEpisodeEvidence,
	loadInstanceEvidence,
	loadInstanceMutationEvidence,
	loadInstanceSelectedEvidence,
	loadPositiveEpisodeDisplayEvidence,
	loadPositiveEpisodeEvidence,
	loadPositiveEpisodeParentEvidence,
	loadTargetScopedPlexWatchCountMutationEvidence,
	loadTargetScopedPlexWatchCountMutationEvidenceBatch,
	loadUserEvidence,
	scanInstanceEpisodeParentPolicyEvidence,
	scanInstancePolicyEvidence,
	scanMutationPolicyEvidenceForOwnedInstances,
	scanUserPolicyEvidence,
} from "../plex-evidence-repository.js";
import { createPlexTargetLedgerBinding } from "../plex-generation-target-ledger.js";
import { encodePlexPositiveEpisodeGenerationMetadata } from "../plex-positive-episode-generation-metadata.js";

const now = new Date("2026-08-20T14:00:00.000Z");
const sections = [
	{
		key: "movies",
		uuid: "movies-uuid",
		title: "Movies",
		type: "movie" as const,
		refreshing: false,
		scannedAt: 1_777_000_000,
		updatedAt: 1_777_000_100,
	},
];

function v5Metadata(itemCount = 1, observedAt = new Date("2026-08-20T12:00:00.000Z")) {
	const attemptStartedAt = new Date(observedAt.getTime() - 60_000).toISOString();
	return JSON.stringify({
		version: 5,
		publicationLevel: "authoritative",
		completeness: "complete",
		itemCount,
		canonicalizationVersion: 1,
		sections,
		roots: [{ sectionKey: "movies", domain: "membership", digest: "a".repeat(64) }],
		targetLedgerVersion: 1,
		targetCount: itemCount,
		targetDigest: "b".repeat(64),
		partialReasons: [],
		coverageReceipt: {
			version: 1,
			provider: "plex",
			attemptStartedAt,
			observedAt: observedAt.toISOString(),
			evidence: "complete",
			units: [
				{
					scopeKey: "section:movies",
					expectedRawCount: itemCount,
					pagesAttempted: 1,
					pagesCompleted: 1,
					rawObserved: itemCount,
					sourceBindings: itemCount,
					canonicalEntities: itemCount,
					acceptedSkips: [],
					fatalCount: 0,
				},
			],
		},
	});
}

function v4Metadata(itemCount = 1) {
	return JSON.stringify({
		version: 4,
		publicationLevel: "positive-only",
		completeness: "partial",
		itemCount,
		canonicalizationVersion: 1,
		sections: [
			{
				key: "shows",
				uuid: "shows-uuid",
				title: "Shows",
				type: "show",
				refreshing: false,
				scannedAt: 1_777_000_000,
				updatedAt: 1_777_000_100,
			},
		],
		observedRoots: [{ sectionKey: "shows", domain: "episode-parents", digest: "a".repeat(64) }],
		capabilities: [
			{
				domain: "episode-parents",
				field: "membership",
				semantics: "observed-targets-only",
				operators: [],
			},
		],
		targetLedgerVersion: 1,
		targetCount: 1,
		targetDigest: "b".repeat(64),
		partialReasons: [{ code: "currentItemsWithoutTmdbMetadata", count: 1 }],
	});
}

function v5PositiveMetadata(itemCount = 1) {
	return JSON.stringify({
		version: 5,
		publicationLevel: "positive-only",
		completeness: "partial",
		itemCount,
		canonicalizationVersion: 1,
		sections: [
			{
				key: "shows",
				uuid: "shows-uuid",
				title: "Shows",
				type: "show",
				refreshing: false,
				scannedAt: 1_777_000_000,
				updatedAt: 1_777_000_100,
			},
		],
		observedRoots: [{ sectionKey: "shows", domain: "episode-parents", digest: "a".repeat(64) }],
		capabilities: [
			{
				domain: "episode-parents",
				field: "membership",
				semantics: "observed-targets-only",
				operators: [],
			},
		],
		targetLedgerVersion: 1,
		targetCount: itemCount,
		targetDigest: "b".repeat(64),
		partialReasons: [{ code: "currentItemsWithoutTmdbMetadata", count: 1 }],
		coverageReceipt: {
			version: 1,
			provider: "plex",
			attemptStartedAt: "2026-08-20T11:59:00.000Z",
			observedAt: "2026-08-20T12:00:00.000Z",
			evidence: "positive-only",
			units: [
				{
					scopeKey: "section:shows",
					expectedRawCount: itemCount,
					pagesAttempted: 1,
					pagesCompleted: 1,
					rawObserved: itemCount,
					sourceBindings: itemCount,
					canonicalEntities: itemCount,
					acceptedSkips: [],
					fatalCount: 0,
				},
			],
		},
	});
}

function v6Metadata(publicationLevel: "authoritative" | "positive-only", itemCount = 2) {
	const observedAt = "2026-08-20T12:00:00.000Z";
	const unit = (scopeKey: string) => ({
		scopeKey,
		expectedRawCount: itemCount,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: itemCount,
		sourceBindings: itemCount,
		canonicalEntities: itemCount,
		acceptedSkips: [],
		fatalCount: 0,
	});
	const receipt = {
		version: 2,
		provider: "plex",
		attemptStartedAt: "2026-08-20T11:59:00.000Z",
		observedAt,
		evidence: publicationLevel === "authoritative" ? "complete" : "positive-only",
		units: [unit("plex:aggregate")],
		publishedCanonicalEntities: itemCount,
		domains: ["library-inventory", "mapping", "watch-count", "watch-attribution", "on-deck"].map(
			(domain) => ({
				domain,
				evidence: "complete",
				valueSemantics: "exact",
				units: [unit(`plex:${domain}`)],
				...(domain === "mapping" || domain === "watch-count"
					? { publishedCanonicalEntities: itemCount }
					: {}),
			}),
		),
	};
	return JSON.stringify({
		version: 6,
		publicationLevel,
		completeness: publicationLevel === "authoritative" ? "complete" : "partial",
		itemCount,
		canonicalizationVersion: 1,
		sections: [
			{
				key: "shows",
				uuid: "shows-uuid",
				title: "Shows",
				type: "show",
				refreshing: false,
				scannedAt: 1_777_000_000,
				updatedAt: 1_777_000_100,
			},
		],
		...(publicationLevel === "authoritative"
			? { roots: [{ sectionKey: "shows", domain: "membership", digest: "a".repeat(64) }] }
			: {
					observedRoots: [
						{ sectionKey: "shows", domain: "episode-parents", digest: "a".repeat(64) },
					],
					capabilities: [
						{
							domain: "episode-parents",
							field: "membership",
							semantics: "observed-targets-only",
							operators: [],
						},
					],
				}),
		targetLedgerVersion: 1,
		targetCount: itemCount,
		targetDigest: "b".repeat(64),
		partialReasons:
			publicationLevel === "authoritative"
				? []
				: [{ code: "currentItemsWithoutTmdbMetadata", count: 1 }],
		coverageReceipt: receipt,
	});
}

function v3Metadata(itemCount = 1) {
	return JSON.stringify({
		version: 3,
		publicationLevel: "authoritative",
		completeness: "complete",
		itemCount,
		canonicalizationVersion: 1,
		sections,
		roots: [{ sectionKey: "movies", domain: "membership", digest: "a".repeat(64) }],
		targetLedgerVersion: 1,
		targetCount: itemCount,
		targetDigest: "b".repeat(64),
	});
}

function instance(overrides: Record<string, unknown> = {}) {
	return {
		id: "plex-1",
		userId: "user-1",
		service: "PLEX",
		enabled: true,
		label: "Primary Plex",
		connectionGeneration: 4,
		identityGeneration: 9,
		identityStatus: "VERIFIED",
		expectedIdentity: "machine-1",
		identityKind: "plex-machine-identifier",
		identityVerifiedAt: new Date("2026-08-20T10:00:00.000Z"),
		updatedAt: new Date("2026-08-20T10:00:00.000Z"),
		...overrides,
	};
}

function status(overrides: Record<string, unknown> = {}) {
	const itemCount = typeof overrides.itemCount === "number" ? overrides.itemCount : 1;
	const lastRefreshedAt =
		overrides.lastRefreshedAt instanceof Date
			? overrides.lastRefreshedAt
			: new Date("2026-08-20T12:00:00.000Z");
	return {
		id: "status-1",
		instanceId: "plex-1",
		cacheType: "plex",
		lastRefreshedAt,
		lastResult: "success",
		lastErrorMessage: null,
		itemCount,
		generationId: "generation-1",
		generationMetadata: v5Metadata(itemCount, lastRefreshedAt),
		lastAttemptAt: new Date("2026-08-20T12:00:00.000Z"),
		lastAttemptResult: "success",
		lastAttemptErrorMessage: null,
		connectionGeneration: 4,
		identityGeneration: 9,
		...overrides,
	};
}

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "row-1",
		instanceId: "plex-1",
		tmdbId: 42,
		mediaType: "movie",
		sectionId: "movies",
		sectionTitle: "Movies",
		title: "Example",
		ratingKey: "rating-42",
		lastWatchedAt: null,
		watchCount: 0,
		watchedByUsers: "[]",
		onDeck: false,
		userRating: null,
		collections: "[]",
		labels: "[]",
		addedAt: null,
		thumb: null,
		connectionGeneration: 4,
		identityGeneration: 9,
		...overrides,
	};
}

function episodeStatus(overrides: Record<string, unknown> = {}) {
	return {
		...status(),
		id: "episode-status-1",
		cacheType: "plex_episode",
		generationId: "episode-generation-1",
		generationMetadata: JSON.stringify({
			version: 3,
			parentPlexGenerationId: "generation-1",
			parentPublicationLevel: "authoritative",
			parentMetadataVersion: 5,
			canonicalizationVersion: 1,
			episodeDigest: "b".repeat(64),
			connectionGeneration: 4,
			identityGeneration: 9,
		}),
		...overrides,
	};
}

function episodeRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "episode-row-1",
		instanceId: "plex-1",
		showTmdbId: 42,
		seasonNumber: 1,
		episodeNumber: 1,
		ratingKey: "episode-1",
		title: "Pilot",
		watched: false,
		watchedByUsers: "[]",
		lastWatchedAt: null,
		watchCount: 0,
		refreshedAt: new Date("2026-08-20T12:00:00.000Z"),
		sourceFingerprint: "source-1",
		connectionGeneration: 4,
		identityGeneration: 9,
		...overrides,
	};
}

function positiveEpisodeMetadata(rows: ReturnType<typeof episodeRow>[]) {
	const episodeDigest = createPositivePlexEpisodeDigest(
		[
			{
				instanceId: "plex-1",
				generationId: "generation-v4",
				showTmdbId: 42,
				sectionId: "shows",
				sectionUuid: "shows-uuid",
				mediaType: "series",
				tvdbId: null,
				ratingKey: "show-42",
			},
		],
		rows,
	);
	return JSON.stringify({
		version: 3,
		publicationLevel: "positive-only",
		completeness: "partial",
		itemCount: rows.length,
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
		parentTargetDigest: "b".repeat(64),
		episodeDigest,
		partialReasons: [{ code: "currentItemsWithoutTmdbMetadata", count: 1 }],
		connectionGeneration: 4,
		identityGeneration: 9,
	});
}

function positiveEpisodeMetadataV4(
	rows: ReturnType<typeof episodeRow>[],
	parentGenerationId = "generation-v5",
) {
	const episodeDigest = createPositivePlexEpisodeDigest(
		[
			{
				instanceId: "plex-1",
				generationId: parentGenerationId,
				showTmdbId: 42,
				sectionId: "shows",
				sectionUuid: "shows-uuid",
				mediaType: "series",
				tvdbId: null,
				ratingKey: "show-42",
			},
		],
		rows,
	);
	return JSON.stringify({
		version: 4,
		publicationLevel: "positive-only",
		completeness: "partial",
		itemCount: rows.length,
		canonicalizationVersion: 1,
		capability: {
			domain: "episodes",
			field: "watchCount",
			semantics: "lower-bound",
			operator: "greater_than",
		},
		parentPlexGenerationId: parentGenerationId,
		parentMetadataVersion: 5,
		parentPublicationLevel: "positive-only",
		parentTargetDigest: "b".repeat(64),
		episodeDigest,
		partialReasons: [{ code: "currentItemsWithoutTmdbMetadata", count: 1 }],
		connectionGeneration: 4,
		identityGeneration: 9,
	});
}

function positiveEpisodeMetadataV5(
	rows: ReturnType<typeof episodeRow>[],
	parentGenerationId = "generation-v6",
) {
	const episodeDigest = createPositivePlexEpisodeDigest(
		[
			{
				instanceId: "plex-1",
				generationId: parentGenerationId,
				showTmdbId: 42,
				sectionId: "shows",
				sectionUuid: "shows-uuid",
				mediaType: "series",
				tvdbId: null,
				ratingKey: "show-42",
			},
		],
		rows,
	);
	const unit = {
		scopeKey: "plex-episode-unit:0",
		expectedRawCount: null,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: rows.length,
		sourceBindings: rows.length,
		canonicalEntities: rows.length,
		acceptedSkips: [],
		fatalCount: 0,
	};
	return encodePlexPositiveEpisodeGenerationMetadata({
		version: 5,
		publicationLevel: "positive-only",
		completeness: "partial",
		itemCount: rows.length,
		canonicalizationVersion: 1,
		capability: {
			domain: "episodes",
			field: "watchCount",
			semantics: "lower-bound",
			operator: "greater_than",
		},
		parentPlexGenerationId: parentGenerationId,
		parentMetadataVersion: 6,
		parentPublicationLevel: "authoritative",
		parentTargetDigest: "b".repeat(64),
		episodeDigest,
		partialReasons: [],
		coverageReceipt: {
			version: 2,
			provider: "plex_episode",
			attemptStartedAt: "2026-08-20T11:59:00.000Z",
			observedAt: "2026-08-20T12:00:00.000Z",
			evidence: "positive-only",
			units: [unit],
			publishedCanonicalEntities: rows.length,
			domains: [
				{
					domain: "episode-inventory",
					evidence: "positive-only",
					valueSemantics: "lower-bound",
					units: [unit],
					publishedCanonicalEntities: rows.length,
				},
				{
					domain: "watch-count",
					evidence: "positive-only",
					valueSemantics: "lower-bound",
					units: [unit],
					publishedCanonicalEntities: rows.length,
				},
			],
		},
		connectionGeneration: 4,
		identityGeneration: 9,
	});
}

function fixture(
	options: {
		instance?: ReturnType<typeof instance> | null;
		statuses?: Array<ReturnType<typeof status> | null>;
		rows?: ReturnType<typeof row>[];
		targets?: Array<{
			id: string;
			instanceId: string;
			generationId: string;
			sectionId: string;
			sectionUuid: string;
			mediaType: "movie" | "series";
			tmdbId: number;
			tvdbId: number | null;
			ratingKey: string;
		}>;
		rowError?: Error;
	} = {},
) {
	const events: string[] = [];
	const statuses = [...(options.statuses ?? [status(), status()])];
	const findFirst = vi.fn(async (_args: unknown) => {
		events.push("instance");
		return options.instance === undefined ? instance() : options.instance;
	});
	const findManyStatus = vi.fn(async () => {
		events.push("status");
		const next = statuses.shift() ?? null;
		return next ? [next] : [];
	});
	const findMany = vi.fn(async () => {
		events.push("rows");
		if (options.rowError) throw options.rowError;
		return options.rows ?? [row()];
	});
	const count = vi.fn(async () => (options.rows ?? [row()]).length);
	const findManyTargets = vi.fn(async () => options.targets ?? []);
	return {
		events,
		findFirst,
		prisma: {
			serviceInstance: { findFirst, findMany: vi.fn().mockResolvedValue([]) },
			cacheRefreshStatus: { findMany: findManyStatus },
			plexCache: { findMany, count },
			plexGenerationTarget: { findMany: findManyTargets },
		},
	};
}

async function load(testFixture: ReturnType<typeof fixture>) {
	return loadInstanceEvidence(testFixture.prisma as never, {
		userId: "user-1",
		instanceId: "plex-1",
		now,
		maxAgeMs: 3 * 60 * 60 * 1000,
	});
}

async function loadMutation(testFixture: ReturnType<typeof fixture>) {
	return loadInstanceMutationEvidence(testFixture.prisma as never, {
		userId: "user-1",
		instanceId: "plex-1",
		now,
		maxAgeMs: 3 * 60 * 60 * 1000,
	});
}

async function loadTargetScopedWatchCount(testFixture: ReturnType<typeof fixture>) {
	return loadTargetScopedPlexWatchCountMutationEvidence(testFixture.prisma as never, {
		userId: "user-1",
		instanceId: "plex-1",
		mediaType: "series",
		tmdbId: 42,
		operator: "greater_than",
		threshold: 0,
		now,
		maxAgeMs: 3 * 60 * 60 * 1000,
	});
}

describe("Plex evidence repository", () => {
	it("bounds 500 V6 target selections while verifying one complete ledger", async () => {
		const targets = Array.from({ length: 500 }, (_, index) => ({
			id: `target-${index + 1}`,
			instanceId: "plex-1",
			generationId: "generation-1",
			sectionId: "shows",
			sectionUuid: "shows-uuid",
			mediaType: "series" as const,
			tmdbId: index + 1,
			tvdbId: null,
			ratingKey: `show-${index + 1}`,
		}));
		const targetLedger = createPlexTargetLedgerBinding({
			instanceId: "plex-1",
			generationId: "generation-1",
			connectionGeneration: 4,
			identityGeneration: 9,
			targets,
		});
		const metadata = JSON.parse(v6Metadata("positive-only", targets.length)) as Record<
			string,
			unknown
		>;
		Object.assign(metadata, targetLedger);
		const current = status({
			itemCount: targets.length,
			generationMetadata: JSON.stringify(metadata),
		});
		const rows = targets.map((target) =>
			row({
				id: `row-${target.tmdbId}`,
				mediaType: target.mediaType,
				tmdbId: target.tmdbId,
				sectionId: target.sectionId,
				ratingKey: target.ratingKey,
				watchCount: 1,
			}),
		);
		const testFixture = fixture({ statuses: [current, current], rows, targets });
		type Selection = { mediaType: "movie" | "series"; tmdbId: number };
		const ledgerFindMany = vi.fn(
			async ({ where, cursor }: { where: { OR?: Selection[] }; cursor?: unknown }) => {
				if (cursor) return [];
				if (!where.OR) return targets;
				const selectedIds = new Set(
					where.OR.map((target) => `${target.mediaType}:${target.tmdbId}`),
				);
				return targets.filter((target) => selectedIds.has(`${target.mediaType}:${target.tmdbId}`));
			},
		);
		const cacheFindMany = vi.fn(
			async ({ where, cursor }: { where: { OR?: Selection[] }; cursor?: unknown }) => {
				if (cursor) return [];
				if (!where.OR) throw new Error("target reader must not scan all Plex cache rows");
				const selectedIds = new Set(
					where.OR.map((target) => `${target.mediaType}:${target.tmdbId}`),
				);
				return rows.filter((candidate) =>
					selectedIds.has(`${candidate.mediaType}:${candidate.tmdbId}`),
				);
			},
		);
		testFixture.prisma.plexGenerationTarget.findMany = ledgerFindMany as never;
		testFixture.prisma.plexCache.findMany = cacheFindMany as never;

		const result = await loadTargetScopedPlexWatchCountMutationEvidenceBatch(
			testFixture.prisma as never,
			{
				userId: "user-1",
				instanceId: "plex-1",
				targets: targets.map(({ mediaType, tmdbId }) => ({ mediaType, tmdbId })),
				now,
				maxAgeMs: 3 * 60 * 60 * 1000,
			},
		);
		expect(result).toMatchObject({ available: true });
		if (result.available)
			expect(result.targets).toContainEqual(expect.objectContaining({ tmdbId: 500 }));
		for (const call of [...ledgerFindMany.mock.calls, ...cacheFindMany.mock.calls]) {
			const selected = (call[0] as { where: { OR?: Selection[] } }).where.OR;
			if (selected) expect(selected.length).toBeLessThanOrEqual(250);
		}
		expect(ledgerFindMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: expect.objectContaining({ instanceId: "plex-1" }) }),
		);
	});

	it("keeps generic aggregate-partial mutation closed while exposing one V6 exact target proof", async () => {
		const target = {
			id: "target-42",
			instanceId: "plex-1",
			generationId: "generation-1",
			sectionId: "shows",
			sectionUuid: "shows-uuid",
			mediaType: "series" as const,
			tmdbId: 42,
			tvdbId: null,
			ratingKey: "show-42",
		};
		const targetLedger = createPlexTargetLedgerBinding({
			instanceId: target.instanceId,
			generationId: target.generationId,
			connectionGeneration: 4,
			identityGeneration: 9,
			targets: [target],
		});
		const metadata = JSON.parse(v6Metadata("positive-only", 1)) as Record<string, unknown>;
		Object.assign(metadata, targetLedger);
		const current = status({ itemCount: 1, generationMetadata: JSON.stringify(metadata) });
		const options = {
			statuses: [current, current],
			rows: [
				row({
					mediaType: "series",
					tmdbId: 42,
					sectionId: "shows",
					ratingKey: "show-42",
					watchCount: 3,
				}),
			],
			targets: [target],
		};

		expect(await loadMutation(fixture(options))).toMatchObject({ available: false });
		const targetScoped = await loadTargetScopedWatchCount(fixture(options));
		expect(targetScoped).toMatchObject({
			available: true,
			generationId: "generation-1",
			targetKey: "series:42",
			coordinate: "shows:show-42",
			observedValue: 3,
			evidence: { reasonCodes: [] },
		});
	});

	it("keeps an exact zero batch fact known while the legacy mutation reader remains unavailable", async () => {
		const target = {
			id: "target-42",
			instanceId: "plex-1",
			generationId: "generation-1",
			sectionId: "shows",
			sectionUuid: "shows-uuid",
			mediaType: "series" as const,
			tmdbId: 42,
			tvdbId: null,
			ratingKey: "show-42",
		};
		const targetLedger = createPlexTargetLedgerBinding({
			instanceId: target.instanceId,
			generationId: target.generationId,
			connectionGeneration: 4,
			identityGeneration: 9,
			targets: [target],
		});
		const metadata = JSON.parse(v6Metadata("positive-only", 1)) as Record<string, unknown>;
		Object.assign(metadata, targetLedger);
		const current = status({ itemCount: 1, generationMetadata: JSON.stringify(metadata) });
		const options = {
			statuses: [current, current],
			rows: [
				row({
					mediaType: "series",
					tmdbId: 42,
					sectionId: "shows",
					ratingKey: "show-42",
					watchCount: 0,
				}),
			],
			targets: [target],
		};
		const batch = await loadTargetScopedPlexWatchCountMutationEvidenceBatch(
			fixture(options).prisma as never,
			{
				userId: "user-1",
				instanceId: "plex-1",
				targets: [{ mediaType: "series", tmdbId: 42 }],
				now,
				maxAgeMs: 3 * 60 * 60 * 1000,
			},
		);
		expect(batch).toMatchObject({ available: true, targets: [{ observedValue: 0 }] });
		expect(await loadTargetScopedWatchCount(fixture(options))).toMatchObject({ available: false });
	});

	it("rejects a selected row that is not owned by the verified Plex instance", async () => {
		const target = {
			id: "target-42",
			instanceId: "plex-1",
			generationId: "generation-1",
			sectionId: "shows",
			sectionUuid: "shows-uuid",
			mediaType: "series" as const,
			tmdbId: 42,
			tvdbId: null,
			ratingKey: "show-42",
		};
		const targetLedger = createPlexTargetLedgerBinding({
			instanceId: target.instanceId,
			generationId: target.generationId,
			connectionGeneration: 4,
			identityGeneration: 9,
			targets: [target],
		});
		const metadata = JSON.parse(v6Metadata("positive-only", 1)) as Record<string, unknown>;
		Object.assign(metadata, targetLedger);
		const current = status({ itemCount: 1, generationMetadata: JSON.stringify(metadata) });
		const testFixture = fixture({
			statuses: [current, current],
			rows: [
				row({
					instanceId: "plex-foreign",
					mediaType: "series",
					tmdbId: 42,
					sectionId: "shows",
					ratingKey: "show-42",
					watchCount: 3,
				}),
			],
			targets: [target],
		});
		expect(await loadTargetScopedWatchCount(testFixture)).toMatchObject({ available: false });
	});

	it.each(["movie", "series"] as const)(
		"fails closed when V6 target-scoped %s watch-count evidence has duplicate same-TMDB targets",
		async (mediaType) => {
			const sectionId = mediaType === "movie" ? "movies" : "shows";
			const sectionUuid = `${sectionId}-uuid`;
			const targets = [
				{
					id: "target-42-a",
					instanceId: "plex-1",
					generationId: "generation-1",
					sectionId,
					sectionUuid,
					mediaType,
					tmdbId: 42,
					tvdbId: null,
					ratingKey: "show-42-a",
				},
				{
					id: "target-42-b",
					instanceId: "plex-1",
					generationId: "generation-1",
					sectionId,
					sectionUuid,
					mediaType,
					tmdbId: 42,
					tvdbId: null,
					ratingKey: "show-42-b",
				},
			];
			const targetLedger = createPlexTargetLedgerBinding({
				instanceId: "plex-1",
				generationId: "generation-1",
				connectionGeneration: 4,
				identityGeneration: 9,
				targets,
			});
			const metadata = JSON.parse(v6Metadata("positive-only", 2)) as Record<string, unknown>;
			metadata.sections = [
				{
					key: sectionId,
					uuid: sectionUuid,
					title: mediaType === "movie" ? "Movies" : "Shows",
					type: mediaType === "movie" ? "movie" : "show",
					refreshing: false,
					scannedAt: 1_777_000_000,
					updatedAt: 1_777_000_100,
				},
			];
			Object.assign(metadata, targetLedger);
			const current = status({ itemCount: 2, generationMetadata: JSON.stringify(metadata) });
			const testFixture = fixture({
				statuses: [current, current],
				rows: [
					row({
						id: "row-42-a",
						mediaType,
						tmdbId: 42,
						sectionId,
						ratingKey: "show-42-a",
						watchCount: 3,
					}),
					row({
						id: "row-42-b",
						mediaType,
						tmdbId: 42,
						sectionId,
						ratingKey: "show-42-b",
						watchCount: 3,
					}),
				],
				targets,
			});

			expect(await loadTargetScopedWatchCount(testFixture)).toMatchObject({ available: false });
		},
	);

	it("reads a target-scoped exact watch-count proof from authoritative V6 evidence", async () => {
		const target = {
			id: "target-42",
			instanceId: "plex-1",
			generationId: "generation-1",
			sectionId: "shows",
			sectionUuid: "shows-uuid",
			mediaType: "series" as const,
			tmdbId: 42,
			tvdbId: null,
			ratingKey: "show-42",
		};
		const targetLedger = createPlexTargetLedgerBinding({
			instanceId: target.instanceId,
			generationId: target.generationId,
			connectionGeneration: 4,
			identityGeneration: 9,
			targets: [target],
		});
		const metadata = JSON.parse(v6Metadata("authoritative", 1)) as Record<string, unknown>;
		Object.assign(metadata, targetLedger);
		const current = status({ itemCount: 1, generationMetadata: JSON.stringify(metadata) });

		expect(
			await loadTargetScopedWatchCount(
				fixture({
					statuses: [current, current],
					rows: [
						row({
							mediaType: "series",
							tmdbId: 42,
							sectionId: "shows",
							ratingKey: "show-42",
							watchCount: 3,
						}),
					],
					targets: [target],
				}),
			),
		).toMatchObject({ available: true, observedValue: 3 });
	});

	it("reads status before and after rows and returns source-bound authoritative evidence", async () => {
		const testFixture = fixture();

		const result = await load(testFixture);

		expect(testFixture.events).toEqual(["instance", "status", "rows", "status"]);
		expect(result).toMatchObject({
			available: true,
			instanceId: "plex-1",
			generationId: "generation-1",
			connectionGeneration: 4,
			identityGeneration: 9,
			rows: [{ id: "row-1", tmdbId: 42 }],
			evidence: {
				publicationLevel: "authoritative",
				completeness: "complete",
				reasonCodes: [],
			},
		});
	});

	it("retains V4 rows as display-only last-known evidence", async () => {
		const positiveStatus = status({
			generationMetadata: v4Metadata(),
			lastAttemptResult: "partial",
		});

		const result = await load(
			fixture({
				statuses: [positiveStatus, { ...positiveStatus }],
				rows: [
					row({
						mediaType: "series",
						sectionId: "shows",
						sectionTitle: "Shows",
					}),
				],
			}),
		);

		expect(result).toMatchObject({
			available: true,
			rows: [{ id: "row-1" }],
			providerStatus: { availability: "last-known" },
			evidence: { availability: "last-known", publicationLevel: "unavailable" },
		});
	});

	it("streams V4 rows through display policy scans without mutation authority", async () => {
		const positiveStatus = status({
			generationMetadata: v4Metadata(),
			lastAttemptResult: "partial",
		});
		const testFixture = fixture({
			statuses: [positiveStatus, { ...positiveStatus }],
			rows: [row({ mediaType: "series", sectionId: "shows", sectionTitle: "Shows" })],
		});

		const result = await scanInstancePolicyEvidence(testFixture.prisma as never, {
			userId: "user-1",
			instanceId: "plex-1",
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});

		expect(result).toMatchObject({
			available: true,
			providerStatus: { availability: "last-known" },
			evidence: { availability: "last-known", publicationLevel: "unavailable" },
		});
		expect(testFixture.events).toEqual(["instance", "status", "rows", "status"]);
	});

	it("streams generation-bound policy rows without materializing them in the result", async () => {
		const testFixture = fixture();
		const received: Array<{ instanceId: string; rowIds: string[] }> = [];

		const result = await scanInstancePolicyEvidence(testFixture.prisma as never, {
			userId: "user-1",
			instanceId: "plex-1",
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
			onBatch: ({ instance, rows }) => {
				received.push({ instanceId: instance.instanceId, rowIds: rows.map((value) => value.id) });
			},
		});

		expect(testFixture.events).toEqual(["instance", "status", "rows", "status"]);
		expect(received).toEqual([{ instanceId: "plex-1", rowIds: ["row-1"] }]);
		expect(result).toMatchObject({
			available: true,
			instanceId: "plex-1",
			rowCount: 1,
			rowFingerprint: expect.any(String),
		});
		expect(result).not.toHaveProperty("rows");
	});

	it("does not deliver a mutation batch when the scanner sees a retained failed publication", async () => {
		const failed = status({
			lastAttemptAt: new Date("2026-08-20T13:00:00.000Z"),
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "private failure marker",
		});
		const testFixture = fixture({ statuses: [failed] });
		const batches: string[] = [];

		const result = await scanMutationPolicyEvidenceForOwnedInstances(testFixture.prisma as never, {
			instances: [instance()],
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
			onBatch: ({ rows }) => {
				batches.push(...rows.map((value) => value.id));
			},
		});

		expect(batches).toEqual([]);
		expect(result).toMatchObject([
			{
				available: false,
				providerStatus: { availability: "last-known", latestAttempt: "failed" },
			},
		]);
		expect(JSON.stringify(result)).not.toContain("private failure marker");
	});

	it("marks an earlier mutation scan unusable when its generation changes during a later instance scan", async () => {
		const first = instance();
		const second = instance({ id: "plex-2", label: "Secondary Plex" });
		const firstStatus = status();
		const secondStatus = status({ instanceId: "plex-2", generationId: "generation-2" });
		const changedFirst = status({ generationId: "generation-1-replaced" });
		const statuses = [
			firstStatus,
			{ ...firstStatus },
			{ ...firstStatus },
			secondStatus,
			{ ...secondStatus },
			{ ...secondStatus },
			changedFirst,
			{ ...secondStatus },
		];
		const repository = {
			cacheRefreshStatus: {
				findMany: vi.fn(async () => {
					const next = statuses.shift();
					return next ? [next] : [];
				}),
			},
			plexCache: {
				findMany: vi.fn(async ({ where }: { where: { instanceId: string } }) => [
					row({ id: `row-${where.instanceId}`, instanceId: where.instanceId }),
				]),
			},
		};

		const result = await scanMutationPolicyEvidenceForOwnedInstances(repository as never, {
			instances: [second, first],
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});

		expect(result).toMatchObject([
			{
				available: false,
				instanceId: "plex-1",
				providerStatus: { reasonCodes: ["rows-inconsistent"] },
			},
			{ available: true, instanceId: "plex-2" },
		]);
	});

	it("fails closed when a policy scan query fails", async () => {
		const result = await scanInstancePolicyEvidence(
			fixture({ rowError: new Error("database unavailable") }).prisma as never,
			{ userId: "user-1", instanceId: "plex-1", now, maxAgeMs: 3 * 60 * 60 * 1000 },
		);

		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["query_failed"] },
		});
	});

	it("reports an invalid policy-row generation as a provenance failure", async () => {
		const result = await scanInstancePolicyEvidence(
			fixture({ rows: [row({ identityGeneration: 10 })] }).prisma as never,
			{ userId: "user-1", instanceId: "plex-1", now, maxAgeMs: 3 * 60 * 60 * 1000 },
		);

		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["identity_generation_mismatch"] },
		});
	});

	it("streams only generation-bound watched-series rows for episode-parent policy evidence", async () => {
		const testFixture = fixture();
		const count = vi.fn().mockResolvedValue(1);
		(
			testFixture.prisma.plexCache as unknown as {
				count: typeof count;
			}
		).count = count;
		const received: string[] = [];

		const result = await scanInstanceEpisodeParentPolicyEvidence(testFixture.prisma as never, {
			userId: "user-1",
			instanceId: "plex-1",
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
			onBatch: ({ rows }) => {
				for (const value of rows) {
					if (value.ratingKey) received.push(value.ratingKey);
				}
			},
		});

		expect(received).toEqual(["rating-42"]);
		expect(count).toHaveBeenNthCalledWith(1, { where: { instanceId: "plex-1" } });
		expect(count).toHaveBeenNthCalledWith(2, {
			where: { instanceId: "plex-1", connectionGeneration: 4, identityGeneration: 9 },
		});
		expect(result).toMatchObject({ available: true, rowCount: 1 });
		expect(result).not.toHaveProperty("rows");
	});

	it.each([
		["authoritative V6", "authoritative" as const],
		["positive V6", "positive-only" as const],
	])("reads only series parents from %s metadata", async (_label, publicationLevel) => {
		const metadata = v6Metadata(publicationLevel);
		const testFixture = fixture({
			statuses: [
				status({ itemCount: 2, generationMetadata: metadata }),
				status({ itemCount: 2, generationMetadata: metadata }),
			],
			rows: [
				row({ mediaType: "movie", sectionId: "shows", id: "movie-row" }),
				row({ mediaType: "series", sectionId: "shows", id: "series-row" }),
			],
		});
		(testFixture.prisma.plexCache as unknown as { count: ReturnType<typeof vi.fn> }).count = vi
			.fn()
			.mockResolvedValue(2);

		const result = await loadPositiveEpisodeParentEvidence(testFixture.prisma as never, {
			userId: "user-1",
			instanceId: "plex-1",
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});

		expect(result).toMatchObject({ available: true, rows: [{ id: "series-row" }] });
	});

	it("does not deliver an episode-parent mutation batch after its strict status reread fails", async () => {
		const failed = status({
			lastAttemptAt: new Date("2026-08-20T13:00:00.000Z"),
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "private episode failure marker",
		});
		const testFixture = fixture({ statuses: [status(), failed], rows: [row()] });
		(testFixture.prisma.plexCache as unknown as { count: ReturnType<typeof vi.fn> }).count = vi
			.fn()
			.mockResolvedValue(1);
		const received: string[] = [];

		const result = await scanInstanceEpisodeParentPolicyEvidence(testFixture.prisma as never, {
			userId: "user-1",
			instanceId: "plex-1",
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
			mutation: true,
			onBatch: ({ rows }) => {
				received.push(...rows.map((value) => value.id));
			},
		});

		expect(received).toEqual([]);
		expect(result).toMatchObject({
			available: false,
			providerStatus: { availability: "last-known", latestAttempt: "failed" },
		});
		expect(JSON.stringify(result)).not.toContain("private episode failure marker");
	});

	it.each([
		["label-only edit", { label: "Renamed Plex" }],
		["default selection edit", { isDefault: true }],
		["tag edit", { tags: [{ tagId: "tag-1" }] }],
		["external URL edit", { externalUrl: "https://plex.example.test" }],
		["other non-authority metadata edit", { storageGroupId: "storage-1" }],
		["same-identity reverification", {}],
		["same identity restored after a temporary mismatch", {}],
	] as const)(
		"keeps an explicitly generation-bound publication authoritative after a %s",
		async (_change, metadata) => {
			const publication = new Date("2026-08-20T12:00:00.000Z");
			const laterServiceState = new Date("2026-08-20T13:00:00.000Z");
			const currentInstance = instance({
				...metadata,
				updatedAt: laterServiceState,
				identityVerifiedAt: laterServiceState,
			});
			const published = status({
				lastRefreshedAt: publication,
				lastAttemptAt: publication,
			});

			const result = await load(
				fixture({ instance: currentInstance, statuses: [published, { ...published }] }),
			);
			const mutation = await loadMutation(
				fixture({ instance: currentInstance, statuses: [published, { ...published }] }),
			);

			expect(result).toMatchObject({
				available: true,
				connectionGeneration: 4,
				identityGeneration: 9,
				evidence: { publicationLevel: "authoritative", reasonCodes: [] },
			});
			expect(mutation).toMatchObject({
				available: true,
				evidence: { publicationLevel: "authoritative", reasonCodes: [] },
			});
		},
	);

	it("projects distinct generic provider identity reasons", async () => {
		const mismatched = await load(fixture({ instance: instance({ identityStatus: "MISMATCH" }) }));
		const unverified = await load(
			fixture({
				instance: instance({
					identityStatus: "UNVERIFIED",
					expectedIdentity: null,
					identityVerifiedAt: null,
				}),
			}),
		);

		expect(mismatched).toMatchObject({ providerStatus: { reasonCodes: ["identity-changed"] } });
		expect(unverified).toMatchObject({ providerStatus: { reasonCodes: ["identity-unverified"] } });
	});

	it.each([
		["generation change", status({ generationId: "generation-2" }), "generation_changed"],
		[
			"published timestamp change",
			status({ lastRefreshedAt: new Date("2026-08-20T12:01:00.000Z") }),
			"published_timestamp_changed",
		],
	])("fails closed for a %s during the read", async (_name, after, reasonCode) => {
		const result = await load(fixture({ statuses: [status(), after] }));
		expect(result).toMatchObject({
			available: false,
			providerStatus: { reasonCodes: ["rows-inconsistent"] },
			evidence: { reasonCodes: [reasonCode] },
		});
	});

	it("fails closed when the status item count does not match rows", async () => {
		const result = await load(
			fixture({ statuses: [status({ itemCount: 2 }), status({ itemCount: 2 })] }),
		);
		expect(result).toMatchObject({
			available: false,
			providerStatus: { reasonCodes: ["rows-inconsistent"] },
			evidence: { reasonCodes: ["row_count_mismatch"] },
		});
	});

	it.each([
		["row connection", row({ connectionGeneration: 5 }), "connection_generation_mismatch"],
		["row identity", row({ identityGeneration: 10 }), "identity_generation_mismatch"],
	])("fails closed for a %s mismatch", async (_name, changedRow, reasonCode) => {
		const result = await load(fixture({ rows: [changedRow] }));
		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: [reasonCode] },
		});
	});

	it.each([
		[
			"null status connection",
			status({ connectionGeneration: null }),
			"connection_generation_mismatch",
		],
		["status connection", status({ connectionGeneration: 5 }), "connection_generation_mismatch"],
		["null status identity", status({ identityGeneration: null }), "identity_generation_mismatch"],
		["status identity", status({ identityGeneration: 10 }), "identity_generation_mismatch"],
	])("fails closed for a %s mismatch", async (_name, changedStatus, reasonCode) => {
		const result = await load(fixture({ statuses: [changedStatus] }));
		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: [reasonCode] },
		});
	});

	it.each([
		["missing status", null, "missing_status"],
		["missing generation id", status({ generationId: null }), "missing_generation_id"],
		["null metadata", status({ generationMetadata: null }), "missing_metadata"],
		["malformed metadata", status({ generationMetadata: "{" }), "malformed_metadata"],
		[
			"unknown metadata",
			status({ generationMetadata: JSON.stringify({ version: 99, sections }) }),
			"unknown_metadata_version",
		],
	])("fails closed for %s", async (_name, before, reasonCode) => {
		const result = await load(fixture({ statuses: [before] }));
		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: [reasonCode] },
		});
	});

	it.each([
		[
			"V2",
			JSON.stringify({
				version: 2,
				publicationLevel: "authoritative",
				completeness: "complete",
				itemCount: 1,
				sections,
			}),
		],
		["V3", v3Metadata()],
		["V4", v4Metadata(), "partial"],
	] as const)(
		"keeps identity-matching %s metadata displayable but mutation-unavailable",
		async (_version, generationMetadata, lastAttemptResult: "success" | "partial" = "success") => {
			const legacyStatus = status({ generationMetadata, lastAttemptResult });
			const display = await load(fixture({ statuses: [legacyStatus, { ...legacyStatus }] }));
			const mutation = await loadMutation(
				fixture({ statuses: [legacyStatus, { ...legacyStatus }] }),
			);

			expect(display).toMatchObject({
				available: true,
				rows: [{ id: "row-1" }],
				providerStatus: { availability: "last-known" },
				evidence: { availability: "last-known", authority: "unavailable" },
			});
			expect(mutation).toMatchObject({
				available: false,
				providerStatus: { availability: "last-known" },
			});
		},
	);

	it("retains an earlier authoritative generation after the latest attempt fails", async () => {
		const failedAttempt = {
			lastAttemptAt: new Date("2026-08-20T13:00:00.000Z"),
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "offline",
		};
		const result = await load(
			fixture({ statuses: [status(failedAttempt), status(failedAttempt)] }),
		);
		expect(result).toMatchObject({
			available: true,
			evidence: {
				availability: "last-known",
				authority: "unavailable",
				attemptState: "error",
				publicationLevel: "unavailable",
				completeness: "unknown",
				reasonCodes: ["latest_attempt_failed"],
				publishedGeneration: { publicationLevel: "authoritative" },
			},
		});
		const mutation = await loadMutation(
			fixture({ statuses: [status(failedAttempt), status(failedAttempt)] }),
		);
		expect(mutation).toMatchObject({
			available: false,
			evidence: {
				availability: "last-known",
				authority: "unavailable",
				attemptState: "error",
				reasonCodes: ["latest_attempt_failed"],
				publishedGeneration: { publicationLevel: "authoritative" },
			},
		});
	});

	it("projects a retained V5 publication as last-known without authorizing mutation", async () => {
		const failedAttempt = {
			lastAttemptAt: new Date("2026-08-20T13:00:00.000Z"),
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "offline",
		};

		const display = await load(
			fixture({ statuses: [status(failedAttempt), status(failedAttempt)] }),
		);
		const mutation = await loadMutation(
			fixture({ statuses: [status(failedAttempt), status(failedAttempt)] }),
		);

		expect(display).toMatchObject({
			available: true,
			rows: [{ id: "row-1" }],
			providerStatus: {
				availability: "last-known",
				latestAttempt: "failed",
			},
		});
		expect(mutation).toMatchObject({ available: false });
	});

	it("preserves the normalized in-progress reason when mutation authority is withheld", async () => {
		const inProgress = { lastAttemptResult: "in_progress:opaque-token" };
		const mutation = await loadMutation(
			fixture({ statuses: [status(inProgress), status(inProgress)] }),
		);

		expect(mutation).toMatchObject({
			available: false,
			evidence: {
				availability: "last-known",
				authority: "unavailable",
				attemptState: "in_progress",
				reasonCodes: ["latest_attempt_in_progress"],
				publishedGeneration: { publicationLevel: "authoritative" },
			},
		});
		expect(JSON.stringify(mutation)).not.toContain("opaque-token");
	});

	it.each([
		["valid authoritative / success / fresh", status(), true, "current", "authoritative", true],
		[
			"valid authoritative / missing attempt result / fresh",
			status({ lastAttemptResult: null }),
			true,
			"last-known",
			"unavailable",
			false,
		],
		[
			"valid authoritative / missing attempt timestamp / fresh",
			status({ lastAttemptAt: null }),
			true,
			"last-known",
			"unavailable",
			false,
		],
		[
			"valid authoritative / future attempt timestamp / fresh",
			status({ lastAttemptAt: new Date("2026-08-20T14:00:01.000Z") }),
			true,
			"last-known",
			"unavailable",
			false,
		],
		[
			"valid authoritative / error / fresh",
			status({ lastAttemptResult: "error", lastAttemptErrorMessage: "inventory changed" }),
			true,
			"last-known",
			"unavailable",
			false,
		],
		[
			"valid authoritative / error message / fresh",
			status({ lastAttemptResult: "success", lastAttemptErrorMessage: "inventory changed" }),
			true,
			"last-known",
			"unavailable",
			false,
		],
		[
			"valid authoritative / unknown result / fresh",
			status({ lastAttemptResult: "unknown" }),
			true,
			"last-known",
			"unavailable",
			false,
		],
		[
			"valid authoritative / future partial / fresh",
			status({ lastAttemptResult: "partial" }),
			true,
			"last-known",
			"unavailable",
			false,
		],
		[
			"valid authoritative / success / stale",
			status({ lastRefreshedAt: new Date("2026-08-20T08:00:00.000Z") }),
			true,
			"last-known",
			"unavailable",
			false,
		],
		[
			"valid authoritative / success / future-dated",
			status({ lastRefreshedAt: new Date("2026-08-20T14:00:01.000Z") }),
			false,
			"unavailable",
			"unavailable",
			false,
		],
		[
			"missing generation / success / fresh",
			status({ generationId: null }),
			false,
			"unavailable",
			"unavailable",
			false,
		],
		[
			"malformed metadata / success / fresh",
			status({ generationMetadata: "{" }),
			false,
			"unavailable",
			"unavailable",
			false,
		],
		[
			"subsequent authoritative refresh / success / fresh",
			status(),
			true,
			"current",
			"authoritative",
			true,
		],
	] as const)(
		"applies the latest-attempt matrix for %s",
		async (_caseName, matrixStatus, observationAvailable, availability, authority, mutationAvailable) => {
			const observation = await load(
				fixture({ statuses: [{ ...matrixStatus }, { ...matrixStatus }] }),
			);
			const mutation = await loadMutation(
				fixture({ statuses: [{ ...matrixStatus }, { ...matrixStatus }] }),
			);

			expect(observation.available).toBe(observationAvailable);
			expect(observation.evidence).toMatchObject({ availability, authority });
			if (observation.available) {
				expect(observation.providerStatus.availability).toBe(
					availability === "current" ? "current" : "last-known",
				);
			}
			expect(mutation.available).toBe(mutationAvailable);
		},
	);

	it("maps an invalid V5 receipt to the generic receipt-invalid display reason", async () => {
		const invalidReceipt = status({
			generationMetadata: v5Metadata().replace('"provider":"plex"', '"provider":"other"'),
		});
		const result = await load(fixture({ statuses: [invalidReceipt] }));

		expect(result).toMatchObject({
			available: false,
			providerStatus: { reasonCodes: ["receipt-invalid"] },
			evidence: { reasonCodes: ["metadata_invalid"] },
		});
	});

	it("retains a stale published generation for display without mutation authority", async () => {
		const stale = { lastRefreshedAt: new Date("2026-08-20T08:00:00.000Z") };
		const display = await load(fixture({ statuses: [status(stale), status(stale)] }));
		const mutation = await loadMutation(fixture({ statuses: [status(stale), status(stale)] }));
		expect(display).toMatchObject({
			available: true,
			rows: [{ id: "row-1" }],
			providerStatus: { availability: "last-known", reasonCodes: ["publication-stale"] },
			evidence: { availability: "last-known", reasonCodes: ["published_generation_stale"] },
		});
		expect(mutation).toMatchObject({ available: false });
	});

	it("applies the default freshness bound when the caller omits maxAgeMs", async () => {
		const stale = { lastRefreshedAt: new Date("2026-08-18T08:00:00.000Z") };
		const repository = fixture({ statuses: [status(stale), status(stale)] });
		const result = await loadInstanceEvidence(repository.prisma as never, {
			userId: "user-1",
			instanceId: "plex-1",
			now,
		});
		expect(result).toMatchObject({
			available: true,
			providerStatus: { availability: "last-known", reasonCodes: ["publication-stale"] },
			evidence: { availability: "last-known", reasonCodes: ["published_generation_stale"] },
		});
	});

	it("loads only target-selected rows while validating the full generation count", async () => {
		const findMany = vi.fn(async () => [row()]);
		const repository = {
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance()) },
			cacheRefreshStatus: { findMany: vi.fn().mockResolvedValue([status()]) },
			plexCache: {
				findMany,
				count: vi.fn().mockResolvedValue(1),
			},
		};
		const result = await loadInstanceSelectedEvidence(repository as never, {
			userId: "user-1",
			instanceId: "plex-1",
			selection: { kind: "targets", targets: [{ tmdbId: 42, mediaType: "movie" }] },
			now,
		});

		expect(result).toMatchObject({ available: true, itemCount: 1, rows: [{ tmdbId: 42 }] });
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					instanceId: "plex-1",
					OR: [{ tmdbId: 42, mediaType: "movie" }],
				},
			}),
		);
	});

	it("fails closed for a disabled instance", async () => {
		const result = await load(fixture({ instance: instance({ enabled: false }) }));
		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["disabled_instance"] },
		});
	});

	it.each([
		["mismatched", instance({ identityStatus: "MISMATCH" })],
		[
			"unverified",
			instance({ identityStatus: "UNVERIFIED", expectedIdentity: null, identityVerifiedAt: null }),
		],
	])(
		"keeps cache evidence unavailable while the identity is %s",
		async (_state, currentInstance) => {
			const result = await load(fixture({ instance: currentInstance }));

			expect(result).toMatchObject({
				available: false,
				evidence: { reasonCodes: ["identity_generation_mismatch"] },
			});
		},
	);

	it("keeps evidence unavailable during a mismatch and restores its enrolled generation after reverification", async () => {
		const mismatchedInstance = instance({ identityStatus: "MISMATCH" });
		const unavailable = await load(fixture({ instance: mismatchedInstance }));
		expect(unavailable).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["identity_generation_mismatch"] },
		});

		const restoredIdentity = verifiedIdentityData(
			{
				service: "PLEX",
				expectedIdentity: mismatchedInstance.expectedIdentity,
				identityStatus: mismatchedInstance.identityStatus,
				identityGeneration: mismatchedInstance.identityGeneration,
			},
			{
				service: "PLEX",
				identityKind: "plex-machine-identifier",
				rawIdentity: "machine-1",
				confirmationDigest: "digest",
				fingerprint: "fingerprint",
			},
			new Date("2026-08-20T13:00:00.000Z"),
		);
		const restored = await load(
			fixture({
				instance: instance({
					...restoredIdentity,
					updatedAt: new Date("2026-08-20T13:00:00.000Z"),
				}),
			}),
		);

		expect(restored).toMatchObject({
			available: true,
			identityGeneration: 9,
			evidence: { publicationLevel: "authoritative", reasonCodes: [] },
		});
	});

	it("keeps an authoritative empty generation distinct from unavailable", async () => {
		const emptyStatus = status({ itemCount: 0 });
		const result = await load(fixture({ rows: [], statuses: [emptyStatus, { ...emptyStatus }] }));
		expect(result).toMatchObject({ available: true, rows: [], itemCount: 0 });
	});

	it("maps a post-status row query failure to unknown provider state without leaking the error", async () => {
		const result = await load(fixture({ rowError: new Error("private failure marker") }));
		expect(result).toMatchObject({
			available: false,
			providerStatus: {
				availability: "unavailable",
				evidence: "unknown",
				observedAt: null,
				ageSeconds: null,
				latestAttempt: "successful",
				reasonCodes: ["unknown-failure"],
			},
			evidence: {
				availability: "unavailable",
				authority: "unavailable",
				attemptState: "unknown",
				publicationLevel: "unavailable",
				completeness: "unknown",
				reasonCodes: ["query_failed"],
			},
		});
		expect(JSON.stringify(result)).not.toContain("private failure marker");
	});

	it("keeps the user ownership predicate in the instance query", async () => {
		const testFixture = fixture();
		await load(testFixture);
		expect(testFixture.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "plex-1", userId: "user-1", service: "PLEX" },
			}),
		);
	});

	it("returns separately source-bound evidence for multiple user instances", async () => {
		const first = instance();
		const second = instance({
			id: "plex-2",
			label: "Secondary Plex",
			connectionGeneration: 7,
			identityGeneration: 12,
		});
		const repository = {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([first, second]),
				findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
					where.id === "plex-1" ? first : second,
				),
			},
			cacheRefreshStatus: {
				findMany: vi.fn(async ({ where }: { where: { instanceId: string } }) => {
					const instanceId = where.instanceId;
					return [
						status({
							instanceId,
							generationId: `generation-${instanceId}`,
							connectionGeneration: instanceId === "plex-1" ? 4 : 7,
							identityGeneration: instanceId === "plex-1" ? 9 : 12,
						}),
					];
				}),
			},
			plexCache: {
				findMany: vi.fn(async ({ where }: { where: { instanceId: string } }) => [
					row({
						id: `row-${where.instanceId}`,
						instanceId: where.instanceId,
						connectionGeneration: where.instanceId === "plex-1" ? 4 : 7,
						identityGeneration: where.instanceId === "plex-1" ? 9 : 12,
					}),
				]),
			},
		};

		const result = await loadUserEvidence(repository as never, {
			userId: "user-1",
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});

		expect(result.every((entry) => entry.available)).toBe(true);
		expect(result.flatMap((entry) => (entry.available ? [entry.instanceId] : []))).toEqual([
			"plex-1",
			"plex-2",
		]);
	});

	it("binds each streamed policy batch to its source instance in stable order", async () => {
		const first = instance();
		const second = instance({
			id: "plex-2",
			label: "Secondary Plex",
			connectionGeneration: 7,
			identityGeneration: 12,
		});
		const repository = {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([second, first]),
				findFirst: vi.fn(),
			},
			cacheRefreshStatus: {
				findMany: vi.fn(async ({ where }: { where: { instanceId: string } }) => [
					status({
						instanceId: where.instanceId,
						generationId: `generation-${where.instanceId}`,
						connectionGeneration: where.instanceId === "plex-1" ? 4 : 7,
						identityGeneration: where.instanceId === "plex-1" ? 9 : 12,
					}),
				]),
			},
			plexCache: {
				findMany: vi.fn(async ({ where }: { where: { instanceId: string } }) => [
					row({
						id: `row-${where.instanceId}`,
						instanceId: where.instanceId,
						connectionGeneration: where.instanceId === "plex-1" ? 4 : 7,
						identityGeneration: where.instanceId === "plex-1" ? 9 : 12,
					}),
				]),
			},
		};
		const batches: Array<{ instanceId: string; rowId: string }> = [];

		const result = await scanUserPolicyEvidence(repository as never, {
			userId: "user-1",
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
			onBatch: ({ instance, rows }) => {
				batches.push({ instanceId: instance.instanceId, rowId: rows[0]!.id });
			},
		});

		expect(result.flatMap((entry) => (entry.available ? [entry.instanceId] : []))).toEqual([
			"plex-1",
			"plex-2",
		]);
		expect(batches).toEqual([
			{ instanceId: "plex-1", rowId: "row-plex-1" },
			{ instanceId: "plex-2", rowId: "row-plex-2" },
		]);
	});

	it.each([
		["successful latest authoritative attempt", true, fixture()],
		[
			"failed latest attempt",
			false,
			fixture({
				statuses: [
					status({ lastAttemptResult: "error", lastAttemptErrorMessage: "failed" }),
					status({ lastAttemptResult: "error", lastAttemptErrorMessage: "failed" }),
				],
			}),
		],
		[
			"stale generation",
			false,
			fixture({
				statuses: [
					status({ lastRefreshedAt: new Date("2026-08-20T08:00:00.000Z") }),
					status({ lastRefreshedAt: new Date("2026-08-20T08:00:00.000Z") }),
				],
			}),
		],
		[
			"malformed metadata",
			false,
			fixture({
				statuses: [status({ generationMetadata: "{" }), status({ generationMetadata: "{" })],
			}),
		],
		["missing status", false, fixture({ statuses: [null] })],
		[
			"row-count mismatch",
			false,
			fixture({ statuses: [status({ itemCount: 2 }), status({ itemCount: 2 })] }),
		],
		["identity-generation mismatch", false, fixture({ rows: [row({ identityGeneration: 10 })] })],
		[
			"connection-generation mismatch",
			false,
			fixture({ rows: [row({ connectionGeneration: 5 })] }),
		],
	] as const)(
		"does not broaden current-main mutation authority for %s",
		async (_caseName, currentMainAuthorizes, repository) => {
			const result = await loadMutation(repository);
			const pr1Authorizes = result.available;

			expect(pr1Authorizes).toBe(currentMainAuthorizes);
			expect(pr1Authorizes && !currentMainAuthorizes).toBe(false);
		},
	);
});

describe("Plex episode evidence repository", () => {
	it("keeps the historical V2 exact episode envelope decodable", () => {
		expect(
			decodePlexEpisodeGenerationMetadata(
				JSON.stringify({
					version: 2,
					parentPlexGenerationId: "generation-1",
					parentPublicationLevel: "authoritative",
					parentMetadataVersion: 3,
					canonicalizationVersion: 1,
					episodeDigest: "b".repeat(64),
					connectionGeneration: 4,
					identityGeneration: 9,
				}),
			),
		).toMatchObject({ ok: true, version: 2, parentMetadataVersion: 3 });
	});

	it.each([
		[2, 5],
		[3, 3],
	] as const)(
		"rejects an exact episode envelope with mismatched version %s and parent version %s",
		(version, parentMetadataVersion) => {
			const metadata = JSON.stringify({
				version,
				parentPlexGenerationId: "generation-1",
				parentPublicationLevel: "authoritative",
				parentMetadataVersion,
				canonicalizationVersion: 1,
				episodeDigest: "b".repeat(64),
				connectionGeneration: 4,
				identityGeneration: 9,
			});

			expect(decodePlexEpisodeGenerationMetadata(metadata)).toEqual({ ok: false });
		},
	);

	function episodeFixture(
		input: {
			parentStatus?: ReturnType<typeof status>;
			episode?: ReturnType<typeof episodeStatus>;
			parentCount?: number;
			episodeRows?: ReturnType<typeof episodeRow>[];
		} = {},
	) {
		const parent = input.parentStatus ?? status();
		const episode = input.episode ?? episodeStatus();
		return {
			serviceInstance: { findFirst: vi.fn(), findMany: vi.fn() },
			cacheRefreshStatus: {
				findMany: vi.fn(async ({ where }: { where: { cacheType: string } }) => [
					where.cacheType === "plex" ? parent : episode,
				]),
			},
			plexCache: {
				count: vi.fn().mockResolvedValue(input.parentCount ?? 1),
				findMany: vi.fn(),
			},
			plexEpisodeCache: {
				count: vi.fn().mockResolvedValue(input.episodeRows?.length ?? 1),
				findMany: vi.fn().mockResolvedValue(input.episodeRows ?? [episodeRow()]),
			},
		};
	}

	async function loadEpisode(repository: ReturnType<typeof episodeFixture>) {
		return loadInstanceEpisodeEvidence(repository as never, {
			userId: "user-1",
			instanceId: "plex-1",
			instance: instance(),
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});
	}

	async function loadSelectedEpisode(
		repository: ReturnType<typeof episodeFixture>,
		showTmdbIds: number[],
	) {
		const repositoryModule = (await import("../plex-evidence-repository.js")) as Record<
			string,
			unknown
		>;
		const loadSelected = repositoryModule.loadInstanceSelectedEpisodeEvidence as (
			prisma: unknown,
			input: {
				userId: string;
				instanceId: string;
				instance: ReturnType<typeof instance>;
				showTmdbIds: number[];
				now: Date;
				maxAgeMs: number;
			},
		) => Promise<unknown>;
		return loadSelected(repository, {
			userId: "user-1",
			instanceId: "plex-1",
			instance: instance(),
			showTmdbIds,
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});
	}

	it("reads a V3 positive episode generation only when it is bound to the current V4 parent", async () => {
		const rows = [episodeRow({ watchCount: 3, watched: true })];
		const repository = episodeFixture({
			parentStatus: status({
				generationId: "generation-v4",
				generationMetadata: v4Metadata(),
				lastAttemptResult: "partial",
			}),
			episode: episodeStatus({
				generationMetadata: positiveEpisodeMetadata(rows),
				lastAttemptResult: "partial",
			}),
			episodeRows: rows,
		});

		const result = await loadPositiveEpisodeEvidence(repository as never, {
			userId: "user-1",
			instanceId: "plex-1",
			instance: instance(),
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});

		expect(result).toMatchObject({
			available: true,
			generationId: "episode-generation-1",
			parentGenerationId: "generation-v4",
			metadata: {
				capability: {
					domain: "episodes",
					field: "watchCount",
					semantics: "lower-bound",
					operator: "greater_than",
				},
			},
			rows: [expect.objectContaining({ id: "episode-row-1", watchCount: 3 })],
		});

		const display = await loadPositiveEpisodeDisplayEvidence(repository as never, {
			userId: "user-1",
			instanceId: "plex-1",
			instance: instance(),
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});
		expect(display).toMatchObject({
			available: true,
			evidence: {
				availability: "current",
				authority: "positive-only",
				attemptState: "partial",
				publicationLevel: "positive-only",
			},
		});
	});

	it("keeps a fresh published V3 snapshot displayable while the latest attempt failed", async () => {
		const rows = [episodeRow({ watchCount: 3, watched: true })];
		const repository = episodeFixture({
			parentStatus: status({
				generationId: "generation-v4",
				generationMetadata: v4Metadata(),
				lastAttemptResult: "partial",
			}),
			episode: episodeStatus({
				generationMetadata: positiveEpisodeMetadata(rows),
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "provider unavailable",
			}),
			episodeRows: rows,
		});

		const display = await loadPositiveEpisodeDisplayEvidence(repository as never, {
			userId: "user-1",
			instanceId: "plex-1",
			instance: instance(),
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});
		const strict = await loadPositiveEpisodeEvidence(repository as never, {
			userId: "user-1",
			instanceId: "plex-1",
			instance: instance(),
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});
		expect(display).toMatchObject({
			available: true,
			rows: [{ id: "episode-row-1", watchCount: 3 }],
			evidence: {
				availability: "last-known",
				authority: "unavailable",
				attemptState: "error",
				publicationLevel: "positive-only",
			},
		});
		expect(strict).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["latest_attempt_failed"] },
		});

		const runningRepository = episodeFixture({
			parentStatus: status({
				generationId: "generation-v4",
				generationMetadata: v4Metadata(),
				lastAttemptResult: "partial",
			}),
			episode: episodeStatus({
				generationMetadata: positiveEpisodeMetadata(rows),
				lastAttemptResult: "in_progress:opaque-attempt",
				lastAttemptErrorMessage: null,
			}),
			episodeRows: rows,
		});
		const runningDisplay = await loadPositiveEpisodeDisplayEvidence(runningRepository as never, {
			userId: "user-1",
			instanceId: "plex-1",
			instance: instance(),
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});
		expect(runningDisplay).toMatchObject({
			available: true,
			evidence: {
				availability: "last-known",
				authority: "unavailable",
				attemptState: "in_progress",
				reasonCodes: expect.arrayContaining([
					"latest_attempt_in_progress",
					"latest_attempt_partial",
				]),
			},
		});
	});

	it("reads a V4 positive episode generation only when it is bound to the current V5 parent", async () => {
		const rows = [episodeRow({ watchCount: 3, watched: true })];
		const repository = episodeFixture({
			parentStatus: status({
				generationId: "generation-v5",
				generationMetadata: v5PositiveMetadata(),
				lastAttemptResult: "success",
			}),
			episode: episodeStatus({
				generationMetadata: positiveEpisodeMetadataV4(rows),
				lastAttemptResult: "partial",
			}),
			episodeRows: rows,
		});

		const result = await loadPositiveEpisodeEvidence(repository as never, {
			userId: "user-1",
			instanceId: "plex-1",
			instance: instance(),
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});

		expect(result).toMatchObject({
			available: true,
			parentGenerationId: "generation-v5",
			metadata: { version: 4, parentMetadataVersion: 5 },
			parentMetadata: { version: 5, publicationLevel: "positive-only" },
		});
	});

	it("keeps a published V4 episode snapshot displayable while its V5 parent attempt is in progress", async () => {
		const rows = [episodeRow({ watchCount: 3, watched: true })];
		const repository = episodeFixture({
			parentStatus: status({
				generationId: "generation-v5",
				generationMetadata: v5PositiveMetadata(),
				lastAttemptResult: "in_progress:opaque-parent-attempt",
			}),
			episode: episodeStatus({
				generationMetadata: positiveEpisodeMetadataV4(rows),
				lastAttemptResult: "partial",
			}),
			episodeRows: rows,
		});

		const display = await loadPositiveEpisodeDisplayEvidence(repository as never, {
			userId: "user-1",
			instanceId: "plex-1",
			instance: instance(),
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});

		expect(display).toMatchObject({
			available: true,
			rows: [{ id: "episode-row-1", watchCount: 3 }],
			evidence: {
				availability: "last-known",
				authority: "unavailable",
				attemptState: "in_progress",
				publicationLevel: "positive-only",
				reasonCodes: expect.arrayContaining([
					"latest_attempt_in_progress",
					"latest_attempt_partial",
				]),
			},
		});
	});

	it("rejects a last-known episode display when its published parent is expired", async () => {
		const rows = [episodeRow({ watchCount: 3, watched: true })];
		const repository = episodeFixture({
			parentStatus: status({
				generationId: "generation-v4",
				generationMetadata: v4Metadata(),
				lastRefreshedAt: new Date("2026-08-20T08:00:00.000Z"),
				lastAttemptAt: new Date("2026-08-20T08:00:00.000Z"),
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "provider unavailable",
			}),
			episode: episodeStatus({
				generationMetadata: positiveEpisodeMetadata(rows),
				lastAttemptResult: "partial",
			}),
			episodeRows: rows,
		});

		const display = await loadPositiveEpisodeDisplayEvidence(repository as never, {
			userId: "user-1",
			instanceId: "plex-1",
			instance: instance(),
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});
		expect(display).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["published_generation_stale"] },
		});
	});

	it("reports a failed parent attempt when the episode snapshot itself is still partial", async () => {
		const rows = [episodeRow({ watchCount: 3, watched: true })];
		const repository = episodeFixture({
			parentStatus: status({
				generationId: "generation-v5",
				generationMetadata: v5PositiveMetadata(),
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "provider unavailable",
			}),
			episode: episodeStatus({
				generationMetadata: positiveEpisodeMetadataV4(rows),
				lastAttemptResult: "partial",
			}),
			episodeRows: rows,
		});

		const display = await loadPositiveEpisodeDisplayEvidence(repository as never, {
			userId: "user-1",
			instanceId: "plex-1",
			instance: instance(),
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});
		expect(display).toMatchObject({
			available: true,
			evidence: {
				availability: "last-known",
				authority: "unavailable",
				attemptState: "error",
				reasonCodes: expect.arrayContaining(["latest_attempt_failed", "latest_attempt_partial"]),
			},
		});
	});

	it.each([
		["failed", "error", "latest_attempt_failed"],
		["running", "in_progress:opaque-parent-attempt", "latest_attempt_in_progress"],
	] as const)(
		"retains positive display rows for a V6 authoritative parent whose latest attempt is %s",
		async (_label, lastAttemptResult, reasonCode) => {
			const rows = [episodeRow({ watchCount: 3, watched: true })];
			const repository = episodeFixture({
				parentStatus: status({
					generationId: "generation-v6",
					generationMetadata: v6Metadata("authoritative", 1),
					lastAttemptResult,
					...(lastAttemptResult.startsWith("error")
						? { lastAttemptErrorMessage: "provider unavailable" }
						: {}),
				}),
				episode: episodeStatus({
					generationMetadata: positiveEpisodeMetadataV5(rows, "generation-v6"),
					lastAttemptResult: "partial",
				}),
				episodeRows: rows,
			});

			const display = await loadPositiveEpisodeDisplayEvidence(repository as never, {
				userId: "user-1",
				instanceId: "plex-1",
				instance: instance(),
				now,
				maxAgeMs: 3 * 60 * 60 * 1000,
			});
			const strict = await loadPositiveEpisodeEvidence(repository as never, {
				userId: "user-1",
				instanceId: "plex-1",
				instance: instance(),
				now,
				maxAgeMs: 3 * 60 * 60 * 1000,
			});

			expect(display).toMatchObject({
				available: true,
				rows: [{ id: "episode-row-1", watchCount: 3 }],
				evidence: {
					availability: "last-known",
					authority: "unavailable",
					attemptState: lastAttemptResult.startsWith("error") ? "error" : "in_progress",
					publicationLevel: "positive-only",
					reasonCodes: expect.arrayContaining([reasonCode, "latest_attempt_partial"]),
				},
			});
			expect(strict).toMatchObject({
				available: false,
				evidence: { reasonCodes: [reasonCode] },
			});
		},
	);

	it.each([
		["stale", { lastRefreshedAt: new Date("2026-08-20T08:00:00.000Z") }],
		["failed", { lastAttemptResult: "error", lastAttemptErrorMessage: "private failure marker" }],
		[
			"invalid",
			{
				generationMetadata: v5PositiveMetadata().replace('"provider":"plex"', '"provider":"other"'),
			},
		],
	] as const)(
		"does not read V4 positive episodes from a V5 parent when it is %s",
		async (_state, parentOverrides) => {
			const rows = [episodeRow({ watchCount: 3, watched: true })];
			const repository = episodeFixture({
				parentStatus: status({
					generationId: "generation-v5",
					generationMetadata: v5PositiveMetadata(),
					lastAttemptResult: "success",
					...parentOverrides,
				}),
				episode: episodeStatus({
					generationMetadata: positiveEpisodeMetadataV4(rows),
					lastAttemptResult: "partial",
				}),
				episodeRows: rows,
			});

			const result = await loadPositiveEpisodeEvidence(repository as never, {
				userId: "user-1",
				instanceId: "plex-1",
				instance: instance(),
				now,
				maxAgeMs: 3 * 60 * 60 * 1000,
			});

			expect(result).toMatchObject({ available: false });
			expect(JSON.stringify(result)).not.toContain("private failure marker");
		},
	);

	it("rejects positive episode evidence when its parent target digest is not current", async () => {
		const rows = [episodeRow({ watchCount: 3, watched: true })];
		const metadata = JSON.parse(positiveEpisodeMetadata(rows)) as Record<string, unknown>;
		metadata.parentTargetDigest = "c".repeat(64);
		const repository = episodeFixture({
			parentStatus: status({
				generationId: "generation-v4",
				generationMetadata: v4Metadata(),
				lastAttemptResult: "partial",
			}),
			episode: episodeStatus({
				generationMetadata: JSON.stringify(metadata),
				lastAttemptResult: "partial",
			}),
			episodeRows: rows,
		});

		const result = await loadPositiveEpisodeEvidence(repository as never, {
			userId: "user-1",
			instanceId: "plex-1",
			instance: instance(),
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});

		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["target_digest_mismatch"] },
		});
	});

	it("keeps the exact episode reader V2-only when a positive V3 episode generation exists", async () => {
		const rows = [episodeRow({ watchCount: 3, watched: true })];
		const result = await loadEpisode(
			episodeFixture({
				parentStatus: status({ generationId: "generation-v4" }),
				episode: episodeStatus({
					generationMetadata: positiveEpisodeMetadata(rows),
					lastAttemptResult: "success",
				}),
				episodeRows: rows,
			}),
		);

		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["malformed_metadata"] },
		});
	});

	it("reads selected episode rows while rejecting a full-generation bound-count mismatch", async () => {
		const repositoryModule = (await import("../plex-evidence-repository.js")) as Record<
			string,
			unknown
		>;
		const loadSelected = repositoryModule.loadInstanceSelectedEpisodeEvidence as
			| ((
					prisma: unknown,
					input: {
						userId: string;
						instanceId: string;
						instance: ReturnType<typeof instance>;
						showTmdbIds: number[];
						now: Date;
						maxAgeMs: number;
					},
			  ) => Promise<unknown>)
			| undefined;
		expect(loadSelected).toBeTypeOf("function");

		const selected = episodeRow({ id: "selected", showTmdbId: 42 });
		const unrelated = episodeRow({ id: "unrelated", showTmdbId: 99 });
		const repository = episodeFixture({
			episode: episodeStatus({ itemCount: 2 }),
			episodeRows: [selected, unrelated],
		});
		repository.plexEpisodeCache.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
		repository.plexEpisodeCache.findMany.mockImplementation(
			async ({ where }: { where: { showTmdbId?: { in: number[] } } }) =>
				where.showTmdbId ? [selected] : [selected, unrelated],
		);

		const result = await loadSelected!(repository, {
			userId: "user-1",
			instanceId: "plex-1",
			instance: instance(),
			showTmdbIds: [42, 42],
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});

		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["row_count_mismatch"] },
		});
		expect(repository.plexEpisodeCache.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ showTmdbId: { in: [42] } }),
			}),
		);
	});

	it("returns an authoritative empty selected result without loading all episode rows", async () => {
		const emptyParent = status({ itemCount: 0 });
		const emptyEpisode = episodeStatus({ itemCount: 0 });
		const repository = episodeFixture({
			parentStatus: emptyParent,
			episode: emptyEpisode,
			parentCount: 0,
			episodeRows: [],
		});

		const result = await loadSelectedEpisode(repository, [42, 42]);

		expect(result).toMatchObject({ available: true, rows: [] });
		expect(repository.plexEpisodeCache.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ showTmdbId: { in: [42] } }),
			}),
		);
	});

	it("withholds selected rows when the full cache count disagrees with the publication", async () => {
		const repository = episodeFixture({ episode: episodeStatus({ itemCount: 2 }) });
		repository.plexEpisodeCache.count.mockResolvedValueOnce(3).mockResolvedValueOnce(3);

		const result = await loadSelectedEpisode(repository, [42]);

		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["row_count_mismatch"] },
		});
	});

	it("returns only selected rows at production-shaped scale while keeping full count validation", async () => {
		const selected = [
			episodeRow({ id: "selected-42", showTmdbId: 42 }),
			episodeRow({ id: "selected-84", showTmdbId: 84 }),
		];
		const unrelated = Array.from({ length: 5_000 }, (_, index) =>
			episodeRow({ id: `unrelated-${index}`, showTmdbId: 1_000 + index }),
		);
		const total = selected.length + unrelated.length;
		const repository = episodeFixture({ episode: episodeStatus({ itemCount: total }) });
		repository.plexEpisodeCache.count.mockResolvedValue(total);
		const expectedWhere = {
			instanceId: "plex-1",
			connectionGeneration: 4,
			identityGeneration: 9,
			showTmdbId: { in: [84, 42] },
		};
		repository.plexEpisodeCache.findMany.mockImplementation(
			async ({ where }: { where: typeof expectedWhere }) => {
				expect(where).toEqual(expectedWhere);
				return [...selected, ...unrelated].filter((row) =>
					where.showTmdbId.in.includes(row.showTmdbId),
				);
			},
		);

		const result = await loadSelectedEpisode(repository, [84, 42, 42]);

		expect(result).toMatchObject({
			available: true,
			rows: [{ id: "selected-42" }, { id: "selected-84" }],
		});
		expect((result as { rows: unknown[] }).rows).toHaveLength(2);
		expect(repository.plexEpisodeCache.findMany).toHaveBeenCalledTimes(1);
		expect(repository.plexEpisodeCache.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: expectedWhere }),
		);
	});

	it("fails closed when the episode status changes during selected reads", async () => {
		for (let attempt = 0; attempt < 25; attempt++) {
			const before = episodeStatus();
			const after = episodeStatus({
				lastAttemptAt: new Date(`2026-08-20T12:${String(attempt).padStart(2, "0")}:30.000Z`),
			});
			const parent = status();
			const episodeStatuses = [before, after];
			const repository = episodeFixture({ parentStatus: parent });
			repository.cacheRefreshStatus.findMany.mockImplementation(
				async ({ where }: { where: { cacheType: string } }) => [
					where.cacheType === "plex" ? parent : episodeStatuses.shift()!,
				],
			);

			const result = await loadSelectedEpisode(repository, [42]);

			expect(result).toMatchObject({
				available: false,
				evidence: { reasonCodes: ["generation_changed"] },
			});
		}
	});

	it("fails closed when the parent generation changes after selected rows are read", async () => {
		const parentStatuses = [
			status(),
			status(),
			status({ generationId: "generation-2" }),
			status({ generationId: "generation-2" }),
		];
		const episode = episodeStatus();
		const repository = episodeFixture();
		repository.cacheRefreshStatus.findMany.mockImplementation(
			async ({ where }: { where: { cacheType: string } }) => [
				where.cacheType === "plex" ? parentStatuses.shift()! : episode,
			],
		);

		const result = await loadSelectedEpisode(repository, [42]);

		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["parent_generation_unavailable"] },
		});
	});

	it("loads rows only when the episode generation is bound to the authoritative parent", async () => {
		const result = await loadEpisode(episodeFixture());

		expect(result).toMatchObject({
			available: true,
			generationId: "episode-generation-1",
			parentGenerationId: "generation-1",
			rows: [{ id: "episode-row-1" }],
			evidence: { publicationLevel: "authoritative", completeness: "complete" },
		});
	});

	it("reads an exact V3 episode generation bound to the current authoritative V5 parent", async () => {
		const result = await loadEpisode(
			episodeFixture({
				episode: episodeStatus({
					generationMetadata: JSON.stringify({
						version: 3,
						parentPlexGenerationId: "generation-1",
						parentPublicationLevel: "authoritative",
						parentMetadataVersion: 5,
						canonicalizationVersion: 1,
						episodeDigest: "b".repeat(64),
						connectionGeneration: 4,
						identityGeneration: 9,
					}),
				}),
			}),
		);

		expect(result).toMatchObject({
			available: true,
			parentGenerationId: "generation-1",
			evidence: { publicationLevel: "authoritative", completeness: "complete" },
		});
	});

	it("fails closed when episode metadata names a different parent generation", async () => {
		const result = await loadEpisode(
			episodeFixture({
				episode: episodeStatus({
					generationMetadata: JSON.stringify({
						version: 2,
						parentPlexGenerationId: "other-parent",
						parentPublicationLevel: "authoritative",
						parentMetadataVersion: 3,
						canonicalizationVersion: 1,
						episodeDigest: "b".repeat(64),
						connectionGeneration: 4,
						identityGeneration: 9,
					}),
				}),
			}),
		);

		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["parent_generation_unavailable"] },
		});
	});

	it("keeps a genuinely authoritative empty parent and empty episode generation distinct", async () => {
		const emptyParent = status({ itemCount: 0 });
		const emptyEpisode = episodeStatus({ itemCount: 0 });
		const result = await loadEpisode(
			episodeFixture({
				parentStatus: emptyParent,
				episode: emptyEpisode,
				parentCount: 0,
				episodeRows: [],
			}),
		);

		expect(result).toMatchObject({ available: true, rows: [] });
	});

	it("preserves the parent publication but reports a later failed episode attempt", async () => {
		const failedAttempt = {
			lastAttemptAt: new Date("2026-08-20T13:00:00.000Z"),
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "offline",
		};
		const result = await loadEpisode(episodeFixture({ episode: episodeStatus(failedAttempt) }));

		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["latest_attempt_failed"] },
		});
	});

	it("preserves admitted parent provider status for episode row and query failures", async () => {
		const mismatchedRows = episodeFixture({ episode: episodeStatus({ itemCount: 2 }) });
		const mismatch = await getPublishedEpisodeGenerationObservation(mismatchedRows as never, {
			userId: "user-1",
			instanceId: "plex-1",
			instance: instance(),
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});

		expect(mismatch).toMatchObject({
			available: false,
			providerStatus: { availability: "unavailable", reasonCodes: ["rows-inconsistent"] },
		});

		const queryFailure = episodeFixture();
		queryFailure.plexEpisodeCache.count.mockRejectedValue(
			new Error("private episode query marker"),
		);
		const failed = await getPublishedEpisodeGenerationObservation(queryFailure as never, {
			userId: "user-1",
			instanceId: "plex-1",
			instance: instance(),
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});

		expect(failed).toMatchObject({
			available: false,
			providerStatus: { availability: "unavailable", reasonCodes: ["unknown-failure"] },
		});
		expect(JSON.stringify(failed)).not.toContain("private episode query marker");
	});

	it("retains the later failed parent provider projection after episode observation", async () => {
		const initial = status();
		const failed = status({
			lastAttemptAt: new Date("2026-08-20T13:00:00.000Z"),
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "private parent reread marker",
		});
		const parentStatuses = [initial, { ...initial }, failed, { ...failed }];
		const repository = episodeFixture();
		repository.cacheRefreshStatus.findMany.mockImplementation(
			async ({ where }: { where: { cacheType: string } }) => [
				where.cacheType === "plex" ? parentStatuses.shift()! : episodeStatus(),
			],
		);

		const result = await getPublishedEpisodeGenerationObservation(repository as never, {
			userId: "user-1",
			instanceId: "plex-1",
			instance: instance(),
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});

		expect(result).toMatchObject({
			available: false,
			providerStatus: { availability: "last-known", reasonCodes: ["refresh-failed"] },
		});
		expect(JSON.stringify(result)).not.toContain("private parent reread marker");
	});

	it("reports a valid positive episode V3 publication as partial observation", async () => {
		const rows = [episodeRow({ watchCount: 3, watched: true })];
		const repository = episodeFixture({
			parentStatus: status({
				generationId: "generation-v4",
				generationMetadata: v4Metadata(),
				lastAttemptResult: "partial",
			}),
			episode: episodeStatus({
				generationMetadata: positiveEpisodeMetadata(rows),
				lastAttemptResult: "partial",
			}),
			episodeRows: rows,
		});

		const result = await getPublishedEpisodeGenerationObservation(repository as never, {
			userId: "user-1",
			instanceId: "plex-1",
			instance: instance(),
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});

		expect(result).toMatchObject({
			available: true,
			itemCount: 1,
			evidence: {
				availability: "current",
				authority: "positive-only",
				attemptState: "partial",
				publicationLevel: "positive-only",
				completeness: "partial",
			},
		});
	});

	it.each([
		["error", "error", "latest_attempt_failed"],
		["in_progress:opaque-token", "in_progress", "latest_attempt_in_progress"],
	] as const)(
		"keeps a historical episode publication separate from a %s latest attempt",
		async (lastAttemptResult, attemptState, reasonCode) => {
			const repository = episodeFixture({
				episode: episodeStatus({
					lastAttemptAt: new Date("2026-08-20T13:00:00.000Z"),
					lastAttemptResult,
					lastAttemptErrorMessage: lastAttemptResult === "error" ? "offline" : null,
				}),
			});
			const result = await getPublishedEpisodeGenerationObservation(repository as never, {
				userId: "user-1",
				instanceId: "plex-1",
				instance: instance(),
				now,
				maxAgeMs: 3 * 60 * 60 * 1000,
			});

			expect(result).toMatchObject({
				available: true,
				evidence: {
					availability: "last-known",
					authority: "unavailable",
					attemptState,
					publicationLevel: "unavailable",
					completeness: "unknown",
					reasonCodes: [reasonCode],
					publishedGeneration: { publicationLevel: "authoritative" },
				},
			});
			expect(JSON.stringify(result.evidence)).not.toContain("opaque-token");
		},
	);

	it("withholds episode evidence when the parent latest attempt failed", async () => {
		const failedAttempt = {
			lastAttemptAt: new Date("2026-08-20T13:00:00.000Z"),
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "parent refresh failed",
		};
		const result = await loadEpisode(episodeFixture({ parentStatus: status(failedAttempt) }));

		expect(result).toMatchObject({
			available: false,
			evidence: {
				availability: "last-known",
				authority: "unavailable",
				attemptState: "error",
				reasonCodes: ["latest_attempt_failed"],
			},
		});
	});
});
