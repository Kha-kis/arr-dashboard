/**
 * Plex Cache Refresher
 *
 * Fetches watch history, on-deck status, and user ratings from Plex
 * and upserts into the PlexCache table. This provides a materialized
 * view of Plex data for cleanup rule evaluation.
 *
 * Strategy:
 * 1. Get accounts → build accountId→username map
 * 2. Get library sections → filter movie/show sections
 * 3. For each section: get library items → extract TMDB GUIDs and ratings
 * 4. Get history → group by ratingKey, map accountId→username
 * 5. Get on-deck → set of ratingKeys currently on-deck
 * 6. Upsert into PlexCache
 */

import { randomUUID } from "node:crypto";
import type {
	PlexCanonicalDomain,
	PlexGenerationDomainRoot,
	PlexGenerationSectionV3,
	PlexPartialReason,
	PlexPartialReasonCode,
} from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Encryptor } from "../auth/encryption.js";
import type { Prisma, PrismaClient, ServiceInstance } from "../prisma.js";
import type {
	ProviderCoverageReceiptV1,
	ProviderCoverageReceiptV2,
	ProviderCoverageUnitV1,
} from "../provider-observation/coverage-receipt.js";
import { getStoredHttpAuthHeaders } from "../services/http-auth.js";
import {
	beginPlexCacheRefreshAttempt,
	finishPlexCacheRefreshAttemptFailure,
	type PlexCacheRefreshAttempt,
} from "../services/provider-cache-status.js";
import {
	createProviderPublicationAuthority,
	type OwnedProviderPublicationSnapshot,
	ProviderIdentityGuardError,
	withGuardedProviderPublication,
} from "../services/provider-identity-guard.js";
import { getErrorMessage } from "../utils/error-message.js";
import { UpstreamValidationError } from "../validation/parse-upstream.js";
import {
	PLEX_CACHE_WRITE_CHUNK_SIZE,
	PlexRefreshAttemptSupersededError,
	publishAuthoritativePlexCacheGeneration,
	publishPositivePlexCacheGeneration,
} from "./plex-cache-storage.js";
import {
	createPlexSelectionProjection,
	PLEX_CANONICALIZATION_VERSION,
} from "./plex-canonical-projection.js";
import {
	PlexClient,
	type PlexCompletePageResult,
	type PlexLibraryItem,
	type PlexReadContext,
	type PlexSettlementLibrary,
} from "./plex-client.js";
import { collectWithinPlexBudget } from "./plex-collection-budget.js";
import {
	classifyPlexCatalogChanges,
	classifyPlexHistoryFailure,
	logPlexCollectionRejection,
	type PlexCatalogChange,
} from "./plex-collection-diagnostics.js";
import {
	encodeAuthoritativePlexGenerationMetadata,
	encodePositivePlexGenerationMetadata,
} from "./plex-generation-metadata.js";
import {
	createPlexTargetLedgerBinding,
	normalizePlexGenerationTargets,
	type PlexGenerationTarget,
	type PlexTargetLedgerBinding,
} from "./plex-generation-target-ledger.js";
import { classifyPlexInventoryDrift } from "./plex-inventory-drift.js";
import { evaluatePlexLiveSettlement } from "./plex-live-settlement.js";

/** Bound Prisma's cached createMany query plans for production-sized libraries. */
export const PLEX_CACHE_PUBLICATION_CHUNK_SIZE = PLEX_CACHE_WRITE_CHUNK_SIZE;
/** Allow bounded publication batches to complete on higher-latency databases. */
export const PLEX_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS = 60_000;

// ============================================================================
// GUID Parsing
// ============================================================================

/**
 * Parse TMDB ID from Plex's Guid array.
 * Plex stores GUIDs like: [{id: "tmdb://12345"}, {id: "imdb://tt1234567"}]
 */
function parsePlexTmdbId(guids: Array<{ id: string }> | undefined): number | null {
	if (!guids) return null;

	for (const guid of guids) {
		const match = guid.id.match(/^tmdb:\/\/(\d+)$/);
		if (match?.[1]) {
			return Number.parseInt(match[1], 10);
		}
	}

	return null;
}

function parsePlexTvdbId(guids: Array<{ id: string }> | undefined): number | null {
	if (!guids) return null;

	for (const guid of guids) {
		const match = guid.id.match(/^tvdb:\/\/(\d+)$/);
		if (match?.[1]) {
			return Number.parseInt(match[1], 10);
		}
	}

	return null;
}

function normalizePlexViewCount(value: unknown): number | null {
	return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

// ============================================================================
// Library Classification
// ============================================================================

/**
 * Plex agents that never produce TMDB/TVDB GUIDs. A section using one of these
 * (e.g. an "Other Videos" / "Personal Media" library) cannot participate in
 * ARR/Plex cleanup correlation, so it is excluded from the authority domain
 * rather than treated as incomplete supported evidence.
 *
 * This is deliberately a closed allowlist of "no metadata" agents. A section
 * with a metadata agent (or a missing/unknown agent) is still treated as
 * supported media and fails closed when its items lack the required identity.
 *
 * `com.plexapp.agents.none` is Plex's Personal Media primary agent. Local Media
 * Assets (`com.plexapp.agents.localmedia`) is NOT included: it is an asset
 * source, not a section-level primary agent, and is not equivalent to a
 * Personal Media library.
 */
const PERSONAL_MEDIA_AGENTS = new Set(["com.plexapp.agents.none", "tv.plex.agents.none"]);

export function isPersonalMediaSection(section: { type: string; agent?: string }): boolean {
	return section.agent !== undefined && PERSONAL_MEDIA_AGENTS.has(section.agent);
}

// ============================================================================
// Aggregation Types
// ============================================================================

interface ItemAggregation {
	tmdbId: number;
	mediaType: "movie" | "series";
	sectionId: string;
	sectionTitle: string;
	title: string;
	ratingKey: string | null;
	lastWatchedAt: Date | null;
	watchCount: number;
	watchedByUsers: Set<string>;
	onDeck: boolean;
	userRating: number | null;
	collections: string[];
	labels: string[];
	addedAt: Date | null;
	thumb: string | null;
}

export interface PlexCacheSnapshotRow {
	instanceId: string;
	tmdbId: number;
	mediaType: "movie" | "series";
	sectionId: string;
	sectionTitle: string;
	title: string;
	ratingKey: string | null;
	lastWatchedAt: Date | null;
	watchCount: number;
	watchedByUsers: string;
	onDeck: boolean;
	userRating: number | null;
	collections: string;
	labels: string;
	addedAt: Date | null;
	thumb: string | null;
}

export interface PlexCacheSnapshot {
	rows: PlexCacheSnapshotRow[];
	sections: Array<{ key: string; title: string; type: "movie" | "show" }>;
}

export type PlexPositiveCapability = {
	domain: "episode-parents";
	field: "membership";
	semantics: "observed-targets-only";
	operators: readonly [];
};

export type PlexPublicationBlock = {
	reasons: readonly string[];
};

export interface PlexInventoryTarget {
	sectionId: string;
	sectionUuid?: string;
	mediaType: "movie" | "series";
	tmdbId: number;
	tvdbId?: number;
	ratingKey: string;
}

export interface PlexCachePositiveObservation {
	rows: PlexCacheSnapshotRow[];
	observedTargets: PlexInventoryTarget[];
	capabilities: readonly [PlexPositiveCapability];
	observedRoots: PlexGenerationDomainRoot[];
	partialReasons: readonly PlexPartialReason[];
	settlement?: {
		sections: PlexGenerationSectionV3[];
		roots: PlexGenerationDomainRoot[];
	};
}

export interface PlexPublicationContext {
	prisma: PrismaClient;
	instance: OwnedProviderPublicationSnapshot;
	log: FastifyBaseLogger;
	cleanupRunClaimToken?: string;
}

export interface PlexCacheRefreshResult {
	/** Collection-local only: watch values did not reach a fixed point. */
	unsettledWatch?: boolean;
	nativeInventoryStatus?: "published" | "failed" | "superseded";
	upserted: number;
	errors: number;
	errorMessages: string[];
	complete: boolean;
	completedAt?: Date;
	superseded?: boolean;
	generationId?: string;
	snapshot?: PlexCacheSnapshot;
	inventoryTargets?: PlexInventoryTarget[];
	targetLedger?: PlexTargetLedgerBinding;
	settlement?: {
		sections: PlexGenerationSectionV3[];
		roots: PlexGenerationDomainRoot[];
	};
	kind?: "authoritative-snapshot" | "positive-observation" | "unpublished";
	observation?: PlexCachePositiveObservation;
	block?: PlexPublicationBlock;
	receipt?: ProviderCoverageReceiptV1 | ProviderCoverageReceiptV2;
}

export type PlexCacheCollectionResult =
	| (PlexCacheRefreshResult & {
			kind: "authoritative-snapshot";
			complete: true;
			snapshot: PlexCacheSnapshot;
			inventoryTargets: PlexInventoryTarget[];
			receipt: ProviderCoverageReceiptV2;
	  })
	| (PlexCacheRefreshResult & {
			kind: "positive-observation";
			complete: false;
			observation: PlexCachePositiveObservation;
			receipt: ProviderCoverageReceiptV2;
			snapshot?: never;
			inventoryTargets?: never;
	  })
	| (PlexCacheRefreshResult & {
			kind: "unpublished";
			complete: false;
			block: PlexPublicationBlock;
			receipt: ProviderCoverageReceiptV2;
			snapshot?: never;
			inventoryTargets?: never;
			observation?: never;
	  });

const POSITIVE_OBSERVATION_REASON_CODES = new Set<PlexPartialReasonCode>([
	"currentItemsWithoutTmdbMetadata",
	"currentLibraryItemsWithoutRatingKeys",
	"historyItemsWithoutUsableMediaKey",
	"currentHistoryItemsWithoutMappedMetadata",
	"historyItemsWithUnknownAccounts",
	"onDeckItemsWithoutMappedMetadata",
	"onDeckFetchFailures",
]);

export function canPublishPositivePlexObservation(
	incompleteReasons: Readonly<Record<string, number>>,
): boolean {
	const entries = Object.entries(incompleteReasons);
	return (
		entries.length > 0 &&
		entries.length <= POSITIVE_OBSERVATION_REASON_CODES.size &&
		entries.every(
			([reason, count]) =>
				POSITIVE_OBSERVATION_REASON_CODES.has(reason as PlexPartialReasonCode) &&
				Number.isSafeInteger(count) &&
				count > 0,
		)
	);
}

function sortedPartialReasons(
	incompleteReasons: Readonly<Record<string, number>>,
): PlexPartialReason[] {
	return Object.entries(incompleteReasons)
		.map(([code, count]) => ({ code: code as PlexPartialReasonCode, count }))
		.sort((left, right) => left.code.localeCompare(right.code));
}

function unpublishedCollection(input: {
	errors: number;
	errorMessages: string[];
	reasons: readonly string[];
	superseded?: boolean;
	receipt?: ProviderCoverageReceiptV2;
	attemptStartedAt?: Date;
}): PlexCacheCollectionResult {
	const observedAt = new Date();
	return {
		kind: "unpublished",
		upserted: 0,
		errors: input.errors,
		errorMessages: input.errorMessages,
		complete: false,
		...(input.superseded ? { superseded: true } : {}),
		block: { reasons: [...input.reasons].sort((left, right) => left.localeCompare(right)) },
		receipt:
			input.receipt ??
			createCoverageReceipt({
				attemptStartedAt: input.attemptStartedAt ?? observedAt,
				observedAt,
				evidence: "unknown",
				units: [],
			}),
	};
}

function createCoverageReceipt(input: {
	attemptStartedAt: Date;
	observedAt: Date;
	evidence: ProviderCoverageReceiptV2["evidence"];
	units: ProviderCoverageUnitV1[];
	domains?: ProviderCoverageReceiptV2["domains"];
	publishedCanonicalEntities?: number;
}): ProviderCoverageReceiptV2 {
	return {
		version: 2,
		provider: "plex",
		attemptStartedAt: input.attemptStartedAt.toISOString(),
		observedAt: input.observedAt.toISOString(),
		evidence: input.evidence,
		units: input.units,
		...(input.publishedCanonicalEntities === undefined
			? {}
			: { publishedCanonicalEntities: input.publishedCanonicalEntities }),
		domains: input.domains ?? [],
	};
}

function createDomainUnit(input: {
	scopeKey: string;
	rawObserved: number;
	sourceBindings: number;
	canonicalEntities: number;
	acceptedSkips?: ProviderCoverageUnitV1["acceptedSkips"];
	expectedRawCount?: number | null;
}): ProviderCoverageUnitV1 {
	return {
		scopeKey: input.scopeKey,
		expectedRawCount: input.expectedRawCount ?? input.rawObserved,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: input.rawObserved,
		sourceBindings: input.sourceBindings,
		canonicalEntities: input.canonicalEntities,
		acceptedSkips: input.acceptedSkips ?? [],
		fatalCount: 0,
	};
}

function onDeckItemsMissingForDomain(
	gap: boolean,
	rawObserved: number,
	sourceBindings: number,
): ProviderCoverageUnitV1["acceptedSkips"] {
	if (!gap || rawObserved <= sourceBindings) return [];
	return [{ reason: "missing-supported-mapping", count: rawObserved - sourceBindings }];
}

function createCoverageUnit(
	scopeKey: string,
	pageResult: Pick<
		PlexCompletePageResult<unknown>,
		"expectedRawCount" | "pagesAttempted" | "pagesCompleted" | "rawObserved"
	>,
): ProviderCoverageUnitV1 {
	return {
		scopeKey,
		expectedRawCount: pageResult.expectedRawCount,
		pagesAttempted: pageResult.pagesAttempted,
		pagesCompleted: pageResult.pagesCompleted,
		rawObserved: pageResult.rawObserved,
		sourceBindings: 0,
		canonicalEntities: 0,
		acceptedSkips: [],
		fatalCount: 0,
	};
}

function acceptCoverageSkip(
	unit: ProviderCoverageUnitV1,
	reason: ProviderCoverageUnitV1["acceptedSkips"][number]["reason"],
	count = 1,
): void {
	const existing = unit.acceptedSkips.find((skip) => skip.reason === reason);
	if (existing) existing.count += count;
	else unit.acceptedSkips.push({ reason, count });
}

const PLEX_CACHE_CANONICAL_DOMAINS = [
	"membership",
	"display",
	"labels",
	"collections",
	"watch",
	"on-deck",
] as const satisfies readonly PlexCanonicalDomain[];

function onDeckSignature(items: Awaited<ReturnType<PlexClient["getOnDeck"]>>): string[] {
	return items
		.map((item) =>
			JSON.stringify([
				item.type,
				item.ratingKey,
				item.parentRatingKey ?? null,
				item.grandparentRatingKey ?? null,
			]),
		)
		.sort();
}

function mediaLibrarySignature(
	sections: Awaited<ReturnType<PlexClient["getLibrarySections"]>>,
): string[] {
	return sections
		.map((section) => JSON.stringify([section.key, section.title, section.type]))
		.sort();
}

function libraryInventoryItemSignature(
	section: { key: string; type: string },
	item: Awaited<ReturnType<PlexClient["getLibraryItems"]>>[number],
): string {
	return JSON.stringify([
		section.key,
		section.type,
		item.ratingKey,
		item.type,
		item.title,
		item.userRating ?? null,
		item.addedAt ?? null,
		normalizePlexViewCount(item.viewCount),
		item.lastViewedAt ?? null,
		item.thumb ?? null,
		(item.Guid ?? []).map((guid) => guid.id).sort(),
		(item.Collection ?? []).map((collection) => collection.tag).sort(),
		(item.Label ?? []).map((label) => label.tag).sort(),
	]);
}

const incompleteReasonLabels: Record<string, string> = {
	currentLibraryItemsWithoutRatingKeys: "current library item(s) without a usable rating key",
	currentItemsWithoutTmdbMetadata: "current library item(s) without TMDB metadata",
	historyItemsWithoutUsableMediaKey: "history item(s) without a usable media key",
	currentHistoryItemsWithoutMappedMetadata: "current history item(s) without mapped TMDB metadata",
	historyItemsWithUnknownAccounts: "history item(s) with unknown accounts",
	onDeckItemsWithoutMappedMetadata: "on-deck item(s) without mapped TMDB metadata",
};

function appendIncompleteReasonMessages(
	errorMessages: string[],
	incompleteReasons: Record<string, number>,
): void {
	for (const [reason, count] of Object.entries(incompleteReasons)) {
		const label = incompleteReasonLabels[reason];
		if (label) errorMessages.push(`Plex cache incomplete: ${count} ${label}`);
	}
}

/** Build the only production publication context from an owned database row. */
export function createOwnedPlexPublicationSnapshot(
	encryptor: Pick<Encryptor, "decrypt">,
	instance: ServiceInstance,
): OwnedProviderPublicationSnapshot {
	if (instance.service !== "PLEX") {
		throw new Error("Plex publication requires a Plex service instance");
	}
	return {
		...createProviderPublicationAuthority(instance),
		label: instance.label,
		apiKey: encryptor.decrypt({
			value: instance.encryptedApiKey,
			iv: instance.encryptionIv,
		}),
		httpAuthHeaders: getStoredHttpAuthHeaders(encryptor, instance),
	};
}

function plexClientForSnapshot(
	instance: OwnedProviderPublicationSnapshot,
	log: FastifyBaseLogger,
	readContext: PlexReadContext,
): PlexClient {
	return new PlexClient(
		instance.baseUrl,
		instance.apiKey,
		log,
		undefined,
		instance.httpAuthHeaders,
		readContext,
	);
}

function unpublishedResult(error: unknown, attemptStartedAt?: Date): PlexCacheRefreshResult {
	if (
		(error instanceof ProviderIdentityGuardError && error.code === "PUBLICATION_SUPERSEDED") ||
		error instanceof PlexRefreshAttemptSupersededError
	) {
		return unpublishedCollection({
			errors: 0,
			errorMessages: [],
			reasons: ["superseded"],
			superseded: true,
			attemptStartedAt,
		});
	}
	return unpublishedCollection({
		errors: 1,
		errorMessages: [
			error instanceof ProviderIdentityGuardError
				? error.message
				: `Atomic Plex cache publication failed: ${getErrorMessage(error)}`,
		],
		reasons: ["publication-error"],
		attemptStartedAt,
	});
}

/**
 * Collect and publish Plex cache data through the shared identity authority.
 * The data client is always constructed from the exact snapshot observed by
 * both identity reads; callers cannot provide a separate Plex connection.
 */
export async function refreshPlexCache(
	context: PlexPublicationContext,
): Promise<PlexCacheRefreshResult> {
	const { prisma, instance, log } = context;
	let attempt: PlexCacheRefreshAttempt | null = null;
	try {
		attempt = await beginPlexCacheRefreshAttempt(prisma, "plex", instance, {
			cleanupRunClaimToken: context.cleanupRunClaimToken,
		});
		if (!attempt) return unpublishedResult(new PlexRefreshAttemptSupersededError());
		return await refreshPlexCacheWithAttempt(context, attempt);
	} catch (error) {
		const result = unpublishedResult(error, attempt?.attemptedAt);
		log.error({ category: "plex-cache-publication-rejected" }, "Plex cache publication rejected");
		return result;
	}
}

/**
 * Continue a Plex refresh with an attempt already acquired by the production
 * pre-decryption boundary. The public refresher above remains the safe path
 * for internal callers that begin from an already decrypted snapshot.
 */
export async function refreshPlexCacheWithAttempt(
	context: PlexPublicationContext,
	attempt: PlexCacheRefreshAttempt,
): Promise<PlexCacheRefreshResult> {
	const { prisma, instance, log } = context;
	try {
		const result = await withGuardedProviderPublication(
			prisma,
			instance,
			log,
			async () =>
				await collectWithinPlexBudget(
					log,
					async (readContext) =>
						await collectSettledPlexCacheLiveEvidence(
							plexClientForSnapshot(instance, log, readContext),
							instance.id,
							log,
							{ attemptStartedAt: attempt.attemptedAt },
						),
				),
			async (tx, collected) => await publishPlexCacheSnapshot(tx, instance, attempt!, collected),
			{
				cleanupRunClaimToken: context.cleanupRunClaimToken,
				timeout: PLEX_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS,
			},
		);
		if (result.kind === "unpublished" || !result.completedAt) {
			const finished = await finishPlexCacheRefreshAttemptFailure(
				prisma,
				"plex",
				result.errorMessages.slice(0, 3).join("; ").slice(0, 500) ||
					"Plex refresh did not publish a generation",
				instance,
				attempt,
				log,
				{ cleanupRunClaimToken: context.cleanupRunClaimToken },
			);
			if (finished === "superseded") {
				return unpublishedResult(new PlexRefreshAttemptSupersededError(), attempt.attemptedAt);
			}
		}
		return result;
	} catch (error) {
		let publicationError = error;
		if (
			!(error instanceof PlexRefreshAttemptSupersededError) &&
			!(error instanceof ProviderIdentityGuardError && error.code === "PUBLICATION_SUPERSEDED")
		) {
			const finished = await finishPlexCacheRefreshAttemptFailure(
				prisma,
				"plex",
				getErrorMessage(error, "Unknown Plex cache refresh failure"),
				instance,
				attempt,
				log,
				{ cleanupRunClaimToken: context.cleanupRunClaimToken },
			);
			if (!(error instanceof ProviderIdentityGuardError) && finished === "superseded") {
				publicationError = new PlexRefreshAttemptSupersededError();
			}
		}
		const result = unpublishedResult(publicationError, attempt.attemptedAt);
		log.error({ category: "plex-cache-publication-rejected" }, "Plex cache publication rejected");
		return result;
	}
}

async function publishPlexCacheSnapshot(
	tx: Prisma.TransactionClient,
	instance: OwnedProviderPublicationSnapshot,
	attempt: PlexCacheRefreshAttempt,
	collected: PlexCacheCollectionResult,
): Promise<PlexCacheCollectionResult> {
	if (collected.kind === "unpublished" || !collected.completedAt) {
		return collected;
	}

	const positiveOnly = collected.kind === "positive-observation";
	const rows = positiveOnly ? collected.observation.rows : collected.snapshot.rows;
	const inventoryTargets = positiveOnly
		? collected.observation.observedTargets
		: collected.inventoryTargets;
	const settlement = positiveOnly ? collected.observation.settlement : collected.settlement;
	if (!inventoryTargets || !settlement) {
		throw new Error("Plex settled collection lacked exact inventory targets");
	}
	const generationId = randomUUID();
	const targets: PlexGenerationTarget[] = normalizePlexGenerationTargets(
		inventoryTargets.map((target) => {
			if (!target.sectionUuid) {
				throw new Error("Plex settled inventory target lacked its section UUID");
			}
			return {
				instanceId: instance.id,
				generationId,
				sectionId: target.sectionId,
				sectionUuid: target.sectionUuid,
				mediaType: target.mediaType,
				tmdbId: target.tmdbId,
				tvdbId: target.tvdbId ?? null,
				ratingKey: target.ratingKey,
			};
		}),
		{ instanceId: instance.id, generationId },
	);
	const targetLedger = createPlexTargetLedgerBinding({
		instanceId: instance.id,
		generationId,
		connectionGeneration: instance.connectionGeneration,
		identityGeneration: instance.identityGeneration,
		targets,
	});
	const storedRows = rows.map((row) => ({
		...row,
		connectionGeneration: instance.connectionGeneration,
		identityGeneration: instance.identityGeneration,
	}));
	if (positiveOnly) {
		const generationMetadata = encodePositivePlexGenerationMetadata({
			sections: settlement.sections,
			itemCount: rows.length,
			canonicalizationVersion: PLEX_CANONICALIZATION_VERSION,
			observedRoots: collected.observation.observedRoots,
			targetLedger,
			partialReasons: collected.observation.partialReasons,
			coverageReceipt: collected.receipt,
		});
		await publishPositivePlexCacheGeneration(tx, {
			instance,
			rows: storedRows,
			completedAt: collected.completedAt,
			generationId,
			generationMetadata,
			targets,
			attempt,
		});
	} else {
		const generationMetadata = encodeAuthoritativePlexGenerationMetadata({
			sections: settlement.sections,
			itemCount: rows.length,
			canonicalizationVersion: PLEX_CANONICALIZATION_VERSION,
			roots: settlement.roots,
			targetLedger,
			partialReasons: [],
			coverageReceipt: collected.receipt,
		});
		await publishAuthoritativePlexCacheGeneration(tx, {
			instance,
			rows: storedRows,
			completedAt: collected.completedAt,
			generationId,
			generationMetadata,
			targets,
			attempt,
		});
	}
	return {
		...collected,
		upserted: rows.length,
		generationId,
		targetLedger,
	};
}

function supportedSettlementSections(
	sections: Awaited<ReturnType<PlexClient["getLibrarySettlementSections"]>>,
): PlexGenerationSectionV3[] {
	return sections
		.filter(
			(section) =>
				(section.type === "movie" || section.type === "show") && !isPersonalMediaSection(section),
		)
		.map((section) => {
			if (section.refreshing) throw new Error("Plex supported library scan is in progress");
			if (section.scannedAt === null)
				throw new Error("Plex supported library revision is not initialized");
			return {
				key: section.key,
				uuid: section.uuid,
				title: section.title,
				type: section.type as "movie" | "show",
				refreshing: false as const,
				scannedAt: section.scannedAt,
				updatedAt: section.updatedAt,
			};
		})
		.sort(
			(left, right) =>
				left.key.localeCompare(right.key) ||
				left.uuid.localeCompare(right.uuid) ||
				left.type.localeCompare(right.type) ||
				left.title.localeCompare(right.title),
		);
}

function settlementSectionIdentity(
	sections: readonly Pick<
		PlexGenerationSectionV3,
		"key" | "uuid" | "type" | "title" | "scannedAt" | "updatedAt"
	>[],
): string {
	return JSON.stringify(
		sections.map((section) => [
			section.key,
			section.uuid,
			section.type,
			section.title,
			section.scannedAt,
			section.updatedAt,
		]),
	);
}

function snapshotProjection(snapshot: PlexCacheSnapshot) {
	return createPlexSelectionProjection({
		rows: snapshot.rows,
		selection: { kind: "all" },
		domains: PLEX_CACHE_CANONICAL_DOMAINS,
	});
}

function snapshotRoots(
	snapshot: PlexCacheSnapshot,
	sections: readonly PlexGenerationSectionV3[],
): PlexGenerationDomainRoot[] {
	const roots: PlexGenerationDomainRoot[] = [];
	for (const section of sections) {
		const rows = snapshot.rows.filter((row) => row.sectionId === section.key);
		const projection = createPlexSelectionProjection({
			rows,
			selection: { kind: "all" },
			domains: PLEX_CACHE_CANONICAL_DOMAINS,
		});
		for (const domain of PLEX_CACHE_CANONICAL_DOMAINS) {
			const digest = projection.domains[domain];
			if (!digest) throw new Error(`Missing Plex canonical ${domain} root`);
			roots.push({ sectionKey: section.key, domain, digest });
		}
	}
	return roots;
}

function positiveObservationRoots(
	rows: readonly PlexCacheSnapshotRow[],
	sections: readonly PlexGenerationSectionV3[],
): PlexGenerationDomainRoot[] {
	return sections.map((section) => {
		const projection = createPlexSelectionProjection({
			rows: rows.filter((row) => row.sectionId === section.key),
			selection: { kind: "all" },
			domains: ["episode-parents"],
		});
		const digest = projection.domains["episode-parents"];
		if (!digest) throw new Error("Missing Plex canonical episode-parent root");
		return { sectionKey: section.key, domain: "episode-parents", digest };
	});
}

function positiveObservationSignature(observation: PlexCachePositiveObservation): string {
	const projection = createPlexSelectionProjection({
		rows: observation.rows,
		selection: { kind: "all" },
		domains: PLEX_CACHE_CANONICAL_DOMAINS,
	});
	return JSON.stringify({
		rows: projection.domains,
		targets: observation.observedTargets.map((target) => [
			target.sectionId,
			target.mediaType,
			target.tmdbId,
			target.tvdbId ?? null,
			target.ratingKey,
		]),
		reasons: observation.partialReasons,
	});
}

type CollectedPlexEvidence = Exclude<PlexCacheCollectionResult, { kind: "unpublished" }>;

function collectionRows(result: CollectedPlexEvidence): PlexCacheSnapshotRow[] {
	return result.kind === "authoritative-snapshot" ? result.snapshot.rows : result.observation.rows;
}

/** Never promote a moving playback observation into exact watch or mutation authority. */
function withoutWatchAuthority(result: CollectedPlexEvidence): CollectedPlexEvidence {
	const { snapshot: _snapshot, inventoryTargets: _targets, ...rest } = result;
	return {
		...rest,
		kind: "positive-observation",
		complete: false,
		unsettledWatch: true,
		receipt: {
			...result.receipt,
			evidence: "positive-only",
			domains: result.receipt.domains.map((domain) =>
				domain.domain === "watch-count" || domain.domain === "watch-attribution"
					? { ...domain, evidence: "unknown", valueSemantics: "unknown" }
					: domain,
			),
		},
		observation:
			result.kind === "positive-observation"
				? result.observation
				: {
						rows: result.snapshot.rows,
						observedTargets: result.inventoryTargets,
						capabilities: [
							{
								domain: "episode-parents",
								field: "membership",
								semantics: "observed-targets-only",
								operators: [],
							},
						],
						observedRoots: [],
						partialReasons: [],
					},
	};
}

/** Compare every unaffected domain and target; watch drift is not a general bypass. */
function stableNonWatchSignature(result: CollectedPlexEvidence): string {
	return JSON.stringify({
		projection: createPlexSelectionProjection({
			rows: collectionRows(result),
			selection: { kind: "all" },
			domains: PLEX_CACHE_CANONICAL_DOMAINS.filter((domain) => domain !== "watch"),
		}).digest,
		targets:
			result.kind === "authoritative-snapshot"
				? result.inventoryTargets
				: result.observation.observedTargets,
		reasons: result.kind === "authoritative-snapshot" ? [] : result.observation.partialReasons,
		domains: result.receipt.domains.filter(
			(domain) => domain.domain !== "watch-count" && domain.domain !== "watch-attribution",
		),
	});
}

type CanonicalCollectionStage =
	| "start-probe"
	| "preliminary-collection"
	| "end-probe"
	| "final-probe"
	| "terminal-probe"
	| "terminal-collection"
	| "collection-comparison"
	| "terminal-post-probe"
	| "target-binding";

type CanonicalCollectionRejectionReason =
	| ReturnType<typeof evaluatePlexLiveSettlement>["reasonCodes"][number]
	| "activity-read-failed"
	| "section-read-failed"
	| "activity-schema-invalid"
	| "section-schema-invalid"
	| "catalog-changed"
	| "collection-kind-changed"
	| "projection-changed"
	| "observed-targets-changed"
	| "target-section-missing"
	| "inventory-targets-missing"
	| "collection-incomplete"
	| "settlement-unavailable";

/** Internal fixed categories only; never retain an upstream error or payload. */
class CanonicalCollectionRejected extends Error {
	constructor(
		readonly reason: CanonicalCollectionRejectionReason,
		readonly catalogChanges?: readonly PlexCatalogChange[],
	) {
		super("Plex canonical collection rejected");
	}
}

async function loadPublicationSettlementProbe(client: PlexClient): Promise<{
	all: PlexSettlementLibrary[];
	supported: PlexGenerationSectionV3[];
}> {
	const [activities, sections] = await Promise.all([
		client.getActivities({ uncached: true }).catch((error) => {
			throw new CanonicalCollectionRejected(
				error instanceof UpstreamValidationError
					? "activity-schema-invalid"
					: "activity-read-failed",
			);
		}),
		client.getLibrarySettlementSections({ uncached: true }).catch((error) => {
			throw new CanonicalCollectionRejected(
				error instanceof UpstreamValidationError ? "section-schema-invalid" : "section-read-failed",
			);
		}),
	]);
	const supportedSectionKeys = sections
		.filter(
			(section) =>
				(section.type === "movie" || section.type === "show") && !isPersonalMediaSection(section),
		)
		.map((section) => section.key);
	const settlement = evaluatePlexLiveSettlement({
		activities,
		sections,
		selectedSectionKeys: supportedSectionKeys,
	});
	if (!settlement.settled) {
		throw new CanonicalCollectionRejected(settlement.reasonCodes[0] ?? "settlement-unavailable");
	}
	return { all: sections, supported: supportedSettlementSections(sections) };
}

/**
 * Bracket complete collection with uncached settlement probes, then perform a
 * post-end complete canonical pass before allowing publication. The terminal
 * row collection is bracketed by an exact section observation before and after
 * the collection; no row collection follows the post-collection observation.
 * Plex exposes no read lock or atomic snapshot, so a new change may still begin
 * after that matched pair; callers only claim authority for the fixed point
 * that was actually observed.
 */
export async function collectSettledPlexCacheLiveEvidence(
	client: PlexClient,
	instanceId: string,
	log: FastifyBaseLogger,
	options: { attemptStartedAt?: Date } = {},
): Promise<PlexCacheCollectionResult> {
	const attemptStartedAt = options.attemptStartedAt ?? new Date();
	let stage: CanonicalCollectionStage = "start-probe";
	const reportRejection = (
		reason: CanonicalCollectionRejectionReason,
		catalogChanges?: readonly PlexCatalogChange[],
	) => {
		logPlexCollectionRejection(log, {
			category: "plex-canonical-collection-rejected",
			stage,
			reason,
			...(catalogChanges ? { catalogChanges } : {}),
		});
	};
	try {
		const collectionOptions = { ...options, attemptStartedAt };
		const startObservation = await loadPublicationSettlementProbe(client);
		stage = "preliminary-collection";
		const preliminary = await collectPlexCacheLiveEvidence(
			client,
			instanceId,
			log,
			collectionOptions,
		);
		if (preliminary.kind === "unpublished") {
			reportRejection("collection-incomplete");
			return preliminary;
		}

		stage = "end-probe";
		const endObservation = await loadPublicationSettlementProbe(client);
		if (
			settlementSectionIdentity(endObservation.supported) !==
			settlementSectionIdentity(startObservation.supported)
		) {
			throw new CanonicalCollectionRejected(
				"catalog-changed",
				classifyPlexCatalogChanges(startObservation.supported, endObservation.supported),
			);
		}

		stage = "final-probe";
		const finalObservation = await loadPublicationSettlementProbe(client);
		if (
			settlementSectionIdentity(finalObservation.supported) !==
			settlementSectionIdentity(endObservation.supported)
		) {
			throw new CanonicalCollectionRejected(
				"catalog-changed",
				classifyPlexCatalogChanges(endObservation.supported, finalObservation.supported),
			);
		}
		stage = "terminal-probe";
		const terminalObservation = await loadPublicationSettlementProbe(client);
		if (
			settlementSectionIdentity(terminalObservation.supported) !==
			settlementSectionIdentity(finalObservation.supported)
		) {
			throw new CanonicalCollectionRejected(
				"catalog-changed",
				classifyPlexCatalogChanges(finalObservation.supported, terminalObservation.supported),
			);
		}
		stage = "terminal-collection";
		let final = await collectPlexCacheLiveEvidence(client, instanceId, log, {
			...collectionOptions,
			settlementSections: terminalObservation.all,
		});
		if (final.kind === "unpublished") {
			reportRejection("collection-incomplete");
			return final;
		}
		stage = "collection-comparison";
		const watchProjection = (result: CollectedPlexEvidence) =>
			createPlexSelectionProjection({
				rows: collectionRows(result),
				selection: { kind: "all" },
				domains: ["watch"],
			}).digest;
		const watchChanged =
			preliminary.unsettledWatch ||
			final.unsettledWatch ||
			watchProjection(preliminary) !== watchProjection(final);
		if (watchChanged) {
			if (stableNonWatchSignature(preliminary) !== stableNonWatchSignature(final)) {
				throw new CanonicalCollectionRejected("projection-changed");
			}
			final = withoutWatchAuthority(final);
		} else if (final.kind !== preliminary.kind) {
			throw new CanonicalCollectionRejected("collection-kind-changed");
		}
		if (
			!watchChanged &&
			final.kind === "authoritative-snapshot" &&
			preliminary.kind === "authoritative-snapshot" &&
			snapshotProjection(final.snapshot).digest !== snapshotProjection(preliminary.snapshot).digest
		) {
			throw new CanonicalCollectionRejected("projection-changed");
		}
		if (
			!watchChanged &&
			final.kind === "positive-observation" &&
			preliminary.kind === "positive-observation" &&
			positiveObservationSignature(final.observation) !==
				positiveObservationSignature(preliminary.observation)
		) {
			throw new CanonicalCollectionRejected("observed-targets-changed");
		}

		stage = "terminal-post-probe";
		const terminalPostObservation = await loadPublicationSettlementProbe(client);
		if (
			settlementSectionIdentity(terminalPostObservation.supported) !==
			settlementSectionIdentity(terminalObservation.supported)
		) {
			throw new CanonicalCollectionRejected(
				"catalog-changed",
				classifyPlexCatalogChanges(
					terminalObservation.supported,
					terminalPostObservation.supported,
				),
			);
		}

		stage = "target-binding";
		const finalSections = terminalPostObservation.supported;
		const sectionUuids = new Map(finalSections.map((section) => [section.key, section.uuid]));
		if (final.kind === "positive-observation") {
			const positiveSections = finalSections.filter((section) => section.type === "show");
			const roots = positiveObservationRoots(final.observation.rows, positiveSections);
			const observedTargets = final.observation.observedTargets.map((target) => {
				const sectionUuid = sectionUuids.get(target.sectionId);
				if (!sectionUuid) {
					throw new CanonicalCollectionRejected("target-section-missing");
				}
				return { ...target, sectionUuid };
			});
			const completedAt = new Date();
			return {
				...final,
				completedAt,
				receipt: { ...final.receipt, observedAt: completedAt.toISOString() },
				observation: {
					...final.observation,
					observedTargets,
					observedRoots: roots,
					settlement: { sections: finalSections, roots },
				},
			};
		}
		const inventoryTargets = final.inventoryTargets?.map((target) => {
			const sectionUuid = sectionUuids.get(target.sectionId);
			if (!sectionUuid) {
				throw new CanonicalCollectionRejected("target-section-missing");
			}
			return { ...target, sectionUuid };
		});
		if (!inventoryTargets) throw new CanonicalCollectionRejected("inventory-targets-missing");

		const completedAt = final.completedAt ?? new Date();
		return {
			...final,
			completedAt,
			receipt: { ...final.receipt, observedAt: completedAt.toISOString() },
			inventoryTargets,
			settlement: {
				sections: finalSections,
				roots: snapshotRoots(final.snapshot, finalSections),
			},
		};
	} catch (error) {
		reportRejection(
			error instanceof CanonicalCollectionRejected ? error.reason : "settlement-unavailable",
			error instanceof CanonicalCollectionRejected ? error.catalogChanges : undefined,
		);
		const observedAt = new Date();
		return unpublishedCollection({
			errors: 1,
			errorMessages: [],
			reasons: ["settlement-unavailable"],
			receipt: createCoverageReceipt({
				attemptStartedAt,
				observedAt,
				evidence: "unknown",
				units: [],
			}),
		});
	}
}

// ============================================================================
// Refresher
// ============================================================================

/**
 * Refresh the PlexCache for a given instance.
 */
export async function collectPlexCacheLiveEvidence(
	client: PlexClient,
	instanceId: string,
	log: FastifyBaseLogger,
	options: {
		preserveProviderDuplicates?: boolean;
		attemptStartedAt?: Date;
		settlementSections?: PlexSettlementLibrary[];
	} = {},
): Promise<PlexCacheCollectionResult> {
	const upserted = 0;
	let errors = 0;
	let complete = true;
	let completedAt: Date | undefined;
	const errorMessages: string[] = [];
	const incompleteReasons: Record<string, number> = {};
	const coverageUnits: ProviderCoverageUnitV1[] = [];
	const mappingUnits: ProviderCoverageUnitV1[] = [];
	const libraryInventoryUnits: ProviderCoverageUnitV1[] = [];
	const attemptStartedAt = options.attemptStartedAt ?? new Date();
	let coverageFailure = false;
	let totalLibraryItems = 0;
	let mappedLibraryItems = 0;
	let ignoredHistoricalItems = 0;
	let providerWatchCountsComplete = true;
	let positiveWatchEvidence = 0;
	let positiveAttributionEvidence = 0;
	let historyAttributionGap = false;
	let onDeckFetchComplete = true;
	let onDeckMembershipGap = false;
	let onDeckRelevantItems = 0;
	let onDeckMappedItems = 0;
	let onDeckUnsupportedItems = 0;
	let attributionRawHistory = 0;
	let attributionResolvedHistory = 0;
	let attributionUnresolvedHistory = 0;
	let unsettledWatch = false;
	const markIncomplete = (reason: string) => {
		complete = false;
		incompleteReasons[reason] = (incompleteReasons[reason] ?? 0) + 1;
	};
	const currentObservedAt = () => new Date();

	try {
		// 1. Build accountId → username map
		let accounts: Awaited<ReturnType<PlexClient["getAccounts"]>> = [];
		let accountsAvailable = true;
		try {
			accounts = await client.getAccounts();
		} catch {
			accountsAvailable = false;
			historyAttributionGap = true;
			log.warn(
				{ category: "plex-cache-accounts-unavailable" },
				"Plex cache refresh: accounts unavailable",
			);
		}
		if (accountsAvailable && accounts.length === 0) {
			markIncomplete("noUserAccounts");
			errors++;
			errorMessages.push("Plex returned no user accounts");
			log.warn(
				{ category: "plex-cache-no-user-accounts" },
				"Plex cache refresh: no user accounts discovered",
			);
		}
		const accountMap = new Map<number, string>();
		for (const account of accounts) {
			accountMap.set(account.id, account.name);
		}

		// 2. Get library sections (movie and show only). Personal Media / Other
		// Videos sections report a movie/show type but use a "no metadata" agent,
		// so they are excluded from the cleanup-authority domain rather than
		// poisoning completeness for supported media.
		const sections = options.settlementSections ?? (await client.getLibrarySections());
		const mediaLibs = sections.filter(
			(s) => (s.type === "movie" || s.type === "show") && !isPersonalMediaSection(s),
		);
		const inventorySections = sections.filter((s) => s.type === "movie" || s.type === "show");
		// Retain the Personal Media section IDs so history rows can be attributed
		// to an unsupported section even when they lack a usable media key.
		// Unknown/missing section IDs are never treated as safe.
		const personalMediaSectionIds = new Set<string>();
		for (const section of sections) {
			if (section.type !== "movie" && section.type !== "show") continue;
			if (isPersonalMediaSection(section)) {
				personalMediaSectionIds.add(section.key);
			}
		}
		const initialMediaLibrarySignature = mediaLibrarySignature(mediaLibs);
		if (mediaLibs.length === 0) {
			markIncomplete("noMediaLibraries");
			errors++;
			errorMessages.push("Plex returned no movie or show libraries");
			log.warn(
				{ category: "plex-cache-no-media-libraries" },
				"Plex cache refresh: no movie or show libraries discovered",
			);
		}

		// 3. Build ratingKey → item data (TMDB ID, media type, rating, section)
		const ratingKeyMap = new Map<
			string,
			{
				tmdbId: number;
				mediaType: "movie" | "series";
				ratingKey: string;
				title: string;
				userRating: number | null;
				sectionId: string;
				sectionTitle: string;
				collections: string[];
				labels: string[];
				addedAt: number | null;
				viewCount: number | null;
				lastViewedAt: number | null;
				thumb: string | null;
			}
		>();
		const currentLibraryRatingKeys = new Set<string>();
		const initialLibraryInventorySignature: string[] = [];
		const inventoryTargets: PlexInventoryTarget[] = [];

		for (const lib of inventorySections) {
			let pageResult: PlexCompletePageResult<PlexLibraryItem>;
			try {
				pageResult = await client.getLibraryItemsWithCoverage(lib.key);
				const unit = createCoverageUnit(`section:${lib.key}`, pageResult);
				coverageUnits.push(unit);
				if (pageResult.reason !== null) {
					unit.fatalCount = 1;
					coverageFailure = true;
					markIncomplete("librarySnapshotFetchFailures");
					errors++;
					log.warn(
						{
							pagesAttempted: pageResult.pagesAttempted,
							pagesCompleted: pageResult.pagesCompleted,
							rawObserved: pageResult.rawObserved,
							expectedRawCount: pageResult.expectedRawCount,
						},
						"Plex cache refresh: library section coverage incomplete",
					);
					continue;
				}
				const items = pageResult.items;
				const mappingUnit = createDomainUnit({
					scopeKey: `section:${lib.key}:mapping`,
					rawObserved: 0,
					sourceBindings: 0,
					canonicalEntities: 0,
				});
				const libraryUnit = createDomainUnit({
					scopeKey: `section:${lib.key}:inventory`,
					rawObserved: items.length,
					sourceBindings: 0,
					canonicalEntities: 0,
					expectedRawCount: pageResult.expectedRawCount,
				});
				if (isPersonalMediaSection(lib)) {
					if (pageResult.rawObserved > 0) {
						acceptCoverageSkip(unit, "unsupported-personal-media", pageResult.rawObserved);
					}
					continue;
				}
				for (const item of items) {
					initialLibraryInventorySignature.push(libraryInventoryItemSignature(lib, item));
				}
				unit.rawObserved = items.length;
				for (const item of items) {
					const viewCount = normalizePlexViewCount(item.viewCount);
					totalLibraryItems++;
					if (item.type === "collection") {
						acceptCoverageSkip(unit, "known-container");
						acceptCoverageSkip(libraryUnit, "known-container");
						continue;
					}
					if (item.type !== "movie" && item.type !== "show") {
						acceptCoverageSkip(unit, "unsupported-provider-object");
						acceptCoverageSkip(libraryUnit, "unsupported-provider-object");
						continue;
					}
					libraryUnit.sourceBindings++;
					mappingUnit.rawObserved++;
					if (!item.ratingKey.trim()) {
						acceptCoverageSkip(unit, "missing-stable-key");
						acceptCoverageSkip(mappingUnit, "missing-stable-key");
						markIncomplete("currentLibraryItemsWithoutRatingKeys");
						continue;
					}
					currentLibraryRatingKeys.add(item.ratingKey);
					const tmdbId = parsePlexTmdbId(item.Guid);
					if (!tmdbId) {
						acceptCoverageSkip(unit, "missing-supported-mapping");
						acceptCoverageSkip(mappingUnit, "missing-supported-mapping");
						markIncomplete("currentItemsWithoutTmdbMetadata");
						continue;
					}
					unit.sourceBindings++;
					mappingUnit.sourceBindings++;
					if (viewCount === null) {
						providerWatchCountsComplete = false;
					} else if (viewCount > 0) {
						positiveWatchEvidence = Math.max(positiveWatchEvidence, viewCount);
					}

					const mediaType: "movie" | "series" = item.type === "movie" ? "movie" : "series";
					const tvdbId = mediaType === "series" ? parsePlexTvdbId(item.Guid) : null;
					inventoryTargets.push({
						sectionId: lib.key,
						mediaType,
						tmdbId,
						...(tvdbId ? { tvdbId } : {}),
						ratingKey: item.ratingKey,
					});
					ratingKeyMap.set(item.ratingKey, {
						tmdbId,
						mediaType,
						ratingKey: item.ratingKey,
						title: item.title,
						userRating: item.userRating ?? null,
						sectionId: lib.key,
						sectionTitle: lib.title,
						collections: item.Collection?.map((c) => c.tag) ?? [],
						labels: item.Label?.map((l) => l.tag) ?? [],
						addedAt: item.addedAt ?? null,
						viewCount,
						lastViewedAt: item.lastViewedAt ?? null,
						thumb: item.thumb ?? null,
					});
				}
				const sectionCanonicalKeys = new Set(
					[...ratingKeyMap.values()]
						.filter((item) => item.sectionId === lib.key)
						.map((item) => `${item.mediaType}:${item.tmdbId}`),
				);
				mappingUnit.canonicalEntities = sectionCanonicalKeys.size;
				mappingUnit.expectedRawCount = mappingUnit.rawObserved;
				libraryUnit.canonicalEntities = sectionCanonicalKeys.size;
				mappingUnits.push(mappingUnit);
				libraryInventoryUnits.push(libraryUnit);
			} catch {
				markIncomplete("librarySnapshotFetchFailures");
				coverageFailure = true;
				coverageUnits.push({
					scopeKey: `section:${lib.key}`,
					expectedRawCount: null,
					pagesAttempted: 1,
					pagesCompleted: 0,
					rawObserved: 0,
					sourceBindings: 0,
					canonicalEntities: 0,
					acceptedSkips: [],
					fatalCount: 1,
				});
				log.warn(
					{ category: "plex-cache-library-section-unobserved" },
					"Plex cache refresh: library section could not be observed",
				);
				errors++;
			}
		}
		initialLibraryInventorySignature.sort();
		inventoryTargets.sort(
			(left, right) =>
				left.mediaType.localeCompare(right.mediaType) ||
				left.tmdbId - right.tmdbId ||
				(left.tvdbId ?? 0) - (right.tvdbId ?? 0) ||
				left.ratingKey.localeCompare(right.ratingKey),
		);
		mappedLibraryItems = ratingKeyMap.size;

		// 4. Get history and aggregate (per-section: key includes sectionId)
		let history: Awaited<ReturnType<PlexClient["getHistory"]>> = [];
		let historyAvailable = true;
		try {
			history = await client.getHistory({ maxResults: 100_000, requireComplete: true });
		} catch {
			historyAvailable = false;
			historyAttributionGap = true;
			log.warn(
				{ category: "plex-cache-history-unavailable" },
				"Plex cache refresh: history unavailable",
			);
		}
		const historyCount = history.length;
		const aggregations = new Map<string, ItemAggregation>();

		for (const entry of history) {
			const isRelevantHistory = entry.type === "movie" || entry.type === "episode";
			const itemRatingKey = entry.type === "episode" ? entry.grandparentRatingKey : entry.ratingKey;
			if (!itemRatingKey?.trim()) {
				if (isRelevantHistory) {
					// A movie/episode history row without a usable media key is only
					// safe to ignore when it belongs to a known Personal Media
					// section. Supported sections and unknown/missing section IDs
					// must fail closed.
					if (entry.librarySectionID && personalMediaSectionIds.has(entry.librarySectionID)) {
						continue;
					}
					attributionRawHistory++;
					attributionUnresolvedHistory++;
					historyAttributionGap = true;
					markIncomplete("historyItemsWithoutUsableMediaKey");
				}
				continue;
			}
			if (!isRelevantHistory) continue;

			const username = accountMap.get(entry.accountID);
			if (isRelevantHistory) {
				if (!currentLibraryRatingKeys.has(itemRatingKey)) {
					ignoredHistoricalItems++;
					continue;
				}
				if (!username) {
					attributionRawHistory++;
					attributionUnresolvedHistory++;
					historyAttributionGap = true;
					markIncomplete("historyItemsWithUnknownAccounts");
					continue;
				}
			}

			const itemData = ratingKeyMap.get(itemRatingKey);
			if (!itemData) {
				if (isRelevantHistory) {
					attributionRawHistory++;
					attributionUnresolvedHistory++;
					historyAttributionGap = true;
					markIncomplete("currentHistoryItemsWithoutMappedMetadata");
				}
				continue;
			}

			const aggKey = `${itemData.mediaType}:${itemData.tmdbId}:${itemData.sectionId}${
				options.preserveProviderDuplicates ? `:${itemData.ratingKey}` : ""
			}`;
			if (!username) {
				attributionRawHistory++;
				attributionUnresolvedHistory++;
				historyAttributionGap = true;
				markIncomplete("historyItemsWithUnknownAccounts");
				continue;
			}

			const existing = aggregations.get(aggKey);
			attributionRawHistory++;
			attributionResolvedHistory++;
			if (existing) {
				existing.watchCount++;
				positiveAttributionEvidence++;
				existing.watchedByUsers.add(username);
				const watchedAt = new Date(entry.viewedAt * 1000);
				if (!existing.lastWatchedAt || watchedAt > existing.lastWatchedAt) {
					existing.lastWatchedAt = watchedAt;
				}
			} else {
				positiveAttributionEvidence++;
				aggregations.set(aggKey, {
					tmdbId: itemData.tmdbId,
					mediaType: itemData.mediaType,
					sectionId: itemData.sectionId,
					sectionTitle: itemData.sectionTitle,
					title: itemData.title,
					ratingKey: itemData.ratingKey,
					lastWatchedAt: new Date(entry.viewedAt * 1000),
					watchCount: 1,
					watchedByUsers: new Set([username]),
					onDeck: false,
					userRating: itemData.userRating,
					collections: itemData.collections,
					labels: itemData.labels,
					addedAt: itemData.addedAt ? new Date(itemData.addedAt * 1000) : null,
					thumb: itemData.thumb,
				});
			}
		}

		// Ensure all library items are in aggregations (even if unwatched)
		for (const [_ratingKey, itemData] of ratingKeyMap) {
			const aggKey = `${itemData.mediaType}:${itemData.tmdbId}:${itemData.sectionId}${
				options.preserveProviderDuplicates ? `:${itemData.ratingKey}` : ""
			}`;
			const itemLastWatchedAt =
				itemData.lastViewedAt === null ? null : new Date(itemData.lastViewedAt * 1000);
			const existing = aggregations.get(aggKey);
			if (existing) {
				if (itemData.viewCount !== null) {
					existing.watchCount = Math.max(existing.watchCount, itemData.viewCount);
				}
				if (itemData.viewCount === null || existing.watchCount > itemData.viewCount) {
					providerWatchCountsComplete = false;
				}
				positiveWatchEvidence = Math.max(positiveWatchEvidence, existing.watchCount);
				if (
					itemLastWatchedAt &&
					(!existing.lastWatchedAt || itemLastWatchedAt > existing.lastWatchedAt)
				) {
					existing.lastWatchedAt = itemLastWatchedAt;
				}
			} else {
				if (itemData.viewCount !== null && itemData.viewCount > 0) {
					positiveWatchEvidence = Math.max(positiveWatchEvidence, itemData.viewCount);
				}
				aggregations.set(aggKey, {
					tmdbId: itemData.tmdbId,
					mediaType: itemData.mediaType,
					sectionId: itemData.sectionId,
					sectionTitle: itemData.sectionTitle,
					title: itemData.title,
					ratingKey: itemData.ratingKey,
					lastWatchedAt: itemLastWatchedAt,
					watchCount: itemData.viewCount ?? 0,
					watchedByUsers: new Set(),
					onDeck: false,
					userRating: itemData.userRating,
					collections: itemData.collections,
					labels: itemData.labels,
					addedAt: itemData.addedAt ? new Date(itemData.addedAt * 1000) : null,
					thumb: itemData.thumb,
				});
			}
		}

		// 5. Get on-deck items and mark
		let verifiedOnDeckSignature: string[] = [];
		try {
			const onDeckItems = await client.getOnDeck();
			verifiedOnDeckSignature = onDeckSignature(onDeckItems);
			for (const deckItem of onDeckItems) {
				onDeckRelevantItems++;
				if (deckItem.type !== "movie" && deckItem.type !== "episode") {
					onDeckUnsupportedItems++;
					continue;
				}
				// For episodes, use the show's ratingKey
				const itemRatingKey =
					deckItem.type === "episode"
						? (deckItem.grandparentRatingKey ?? deckItem.ratingKey)
						: deckItem.ratingKey;

				const itemData = ratingKeyMap.get(itemRatingKey);
				if (!itemData) {
					onDeckMembershipGap = true;
					if (deckItem.type === "movie" || deckItem.type === "episode") {
						markIncomplete("onDeckItemsWithoutMappedMetadata");
					}
					continue;
				}

				const aggKey = `${itemData.mediaType}:${itemData.tmdbId}:${itemData.sectionId}${
					options.preserveProviderDuplicates ? `:${itemData.ratingKey}` : ""
				}`;
				const agg = aggregations.get(aggKey);
				if (agg) {
					agg.onDeck = true;
					onDeckMappedItems++;
				}
			}
		} catch {
			onDeckFetchComplete = false;
			markIncomplete("onDeckFetchFailures");
			errors++;
			errorMessages.push("Failed to fetch Plex on-deck items");
			log.warn(
				{ category: "plex-cache-on-deck-unavailable" },
				"Plex cache refresh: on-deck unavailable",
			);
		}

		// Release ratingKeyMap — all data now lives in aggregations (#239)
		ratingKeyMap.clear();

		// 6. Publish one complete generation atomically. Until every upstream
		// dependency has been verified, the previously published evidence remains
		// untouched and continues to describe the last successful inventory.
		const aggregationsArray = [...aggregations.values()];
		// Release Map hash table — aggregationsArray now owns all references (#239)
		aggregations.clear();
		const rows: PlexCacheSnapshotRow[] = aggregationsArray.map((agg) => ({
			instanceId,
			tmdbId: agg.tmdbId,
			mediaType: agg.mediaType,
			sectionId: agg.sectionId,
			sectionTitle: agg.sectionTitle,
			title: agg.title,
			ratingKey: agg.ratingKey,
			lastWatchedAt: agg.lastWatchedAt,
			watchCount: agg.watchCount,
			watchedByUsers: JSON.stringify([...agg.watchedByUsers].sort()),
			onDeck: agg.onDeck,
			userRating: agg.userRating,
			collections: JSON.stringify([...agg.collections].sort()),
			labels: JSON.stringify([...agg.labels].sort()),
			addedAt: agg.addedAt,
			thumb: agg.thumb,
		}));
		const mappingGap = mappingUnits.some((unit) => unit.acceptedSkips.length > 0);
		const domainUnit = createDomainUnit({
			scopeKey: "plex:watch-count",
			rawObserved: rows.length,
			sourceBindings: rows.length,
			canonicalEntities: rows.length,
		});
		const attributionUnit = createDomainUnit({
			scopeKey: "plex:watch-attribution",
			rawObserved: attributionRawHistory,
			sourceBindings: attributionResolvedHistory,
			canonicalEntities: attributionResolvedHistory,
			acceptedSkips:
				attributionUnresolvedHistory > 0
					? [{ reason: "missing-supported-mapping", count: attributionUnresolvedHistory }]
					: [],
		});
		const onDeckUnit = createDomainUnit({
			scopeKey: "plex:on-deck",
			rawObserved: onDeckRelevantItems,
			sourceBindings: onDeckMappedItems,
			canonicalEntities: onDeckMappedItems,
			acceptedSkips: onDeckItemsMissingForDomain(
				onDeckMembershipGap,
				onDeckRelevantItems,
				onDeckMappedItems,
			),
		});
		if (onDeckUnsupportedItems > 0) {
			const existing = onDeckUnit.acceptedSkips.find(
				(skip) => skip.reason === "unsupported-provider-object",
			);
			if (existing) existing.count += onDeckUnsupportedItems;
			else
				onDeckUnit.acceptedSkips.push({
					reason: "unsupported-provider-object",
					count: onDeckUnsupportedItems,
				});
		}
		const domains: ProviderCoverageReceiptV2["domains"] = [
			{
				domain: "library-inventory",
				evidence:
					coverageFailure || libraryInventoryUnits.length !== mediaLibs.length
						? "unknown"
						: "complete",
				valueSemantics:
					coverageFailure || libraryInventoryUnits.length !== mediaLibs.length
						? "unknown"
						: "exact",
				units: libraryInventoryUnits,
			},
			{
				domain: "mapping",
				evidence: mappingGap ? (mappedLibraryItems > 0 ? "positive-only" : "unknown") : "complete",
				valueSemantics: mappingGap ? (mappedLibraryItems > 0 ? "lower-bound" : "unknown") : "exact",
				units: mappingUnits,
				publishedCanonicalEntities: rows.length,
			},
			{
				domain: "watch-count",
				evidence: providerWatchCountsComplete
					? "complete"
					: positiveWatchEvidence > 0
						? "positive-only"
						: "unknown",
				valueSemantics: providerWatchCountsComplete
					? "exact"
					: positiveWatchEvidence > 0
						? "lower-bound"
						: "unknown",
				units: [domainUnit],
				publishedCanonicalEntities: rows.length,
			},
			{
				domain: "watch-attribution",
				evidence: historyAttributionGap
					? positiveAttributionEvidence > 0
						? "positive-only"
						: "unknown"
					: "complete",
				valueSemantics: historyAttributionGap
					? positiveAttributionEvidence > 0
						? "lower-bound"
						: "unknown"
					: "exact",
				units: [attributionUnit],
			},
			{
				domain: "on-deck",
				evidence:
					!onDeckFetchComplete || onDeckMembershipGap
						? onDeckMappedItems > 0
							? "positive-only"
							: "unknown"
						: "complete",
				valueSemantics:
					!onDeckFetchComplete || onDeckMembershipGap
						? onDeckMappedItems > 0
							? "lower-bound"
							: "unknown"
						: "exact",
				units: [onDeckUnit],
			},
		];
		let receiptOnlyPartial = domains.some(
			(domain) => domain.evidence !== "complete" || domain.valueSemantics !== "exact",
		);
		if (receiptOnlyPartial) complete = false;
		const withdrawWatchAuthority = () => {
			unsettledWatch = true;
			complete = false;
			receiptOnlyPartial = true;
			for (const domain of domains) {
				if (domain.domain === "watch-count" || domain.domain === "watch-attribution") {
					domain.evidence = "unknown";
					domain.valueSemantics = "unknown";
				}
			}
		};
		const verifyCollectedHistory = async () => {
			if (!historyAvailable) return;
			try {
				await client.verifyHistorySnapshot(history);
			} catch (error) {
				// A moving history invalidates watch authority, not independently
				// verified catalog evidence. Unexpected failures still fail closed.
				if (classifyPlexHistoryFailure(error) === "unclassified") throw error;
				historyAvailable = false;
				withdrawWatchAuthority();
			}
		};
		for (const unit of coverageUnits) {
			unit.canonicalEntities = rows.filter(
				(row) => row.sectionId === unit.scopeKey.slice("section:".length),
			).length;
		}
		const snapshotSections = mediaLibs
			.map((section) => ({
				key: section.key,
				title: section.title,
				type: section.type as "movie" | "show",
			}))
			.sort(
				(left, right) =>
					left.key.localeCompare(right.key) ||
					left.title.localeCompare(right.title) ||
					left.type.localeCompare(right.type),
			);
		const logCompletion = () => {
			log.info(
				{
					totalLibraryItems,
					mappedLibraryItems,
					ignoredHistoricalItems,
					incompleteReasons,
					totalHistory: historyCount,
					uniqueItems: aggregationsArray.length,
					upserted,
					errors,
				},
				"Plex cache refresh complete",
			);
		};

		if (errors === 0 || incompleteReasons.onDeckFetchFailures !== undefined) {
			const latestSections = await client.getLibrarySections();
			const latestMediaLibs = latestSections.filter(
				(section) =>
					(section.type === "movie" || section.type === "show") && !isPersonalMediaSection(section),
			);
			if (
				JSON.stringify(mediaLibrarySignature(latestMediaLibs)) !==
				JSON.stringify(initialMediaLibrarySignature)
			) {
				throw new Error("Plex library sections changed before cache publication");
			}
			const latestLibraryInventorySignature: string[] = [];
			for (const lib of latestMediaLibs) {
				const pageResult = await client.getLibraryItemsWithCoverage(lib.key);
				if (pageResult.reason !== null) {
					throw new Error("Plex library coverage changed before cache publication");
				}
				for (const item of pageResult.items) {
					latestLibraryInventorySignature.push(libraryInventoryItemSignature(lib, item));
				}
			}
			latestLibraryInventorySignature.sort();
			if (
				JSON.stringify(latestLibraryInventorySignature) !==
				JSON.stringify(initialLibraryInventorySignature)
			) {
				const driftDomains = classifyPlexInventoryDrift(
					initialLibraryInventorySignature,
					latestLibraryInventorySignature,
				);
				log.warn(
					{
						category: "plex-inventory-drift",
						domains: driftDomains,
					},
					"Plex inventory changed during observation",
				);
				if (driftDomains.length !== 1 || driftDomains[0] !== "watch") {
					throw new Error("Plex library inventory changed before cache publication");
				}
				withdrawWatchAuthority();
			}
			await verifyCollectedHistory();
			try {
				const latestOnDeckSignature = onDeckSignature(await client.getOnDeck());
				if (
					incompleteReasons.onDeckFetchFailures === undefined &&
					JSON.stringify(latestOnDeckSignature) !== JSON.stringify(verifiedOnDeckSignature)
				) {
					throw new Error("Plex on-deck state changed before cache publication");
				}
			} catch (error) {
				if (incompleteReasons.onDeckFetchFailures === undefined) throw error;
			}
		}

		if (errors === 0 && complete) {
			completedAt = new Date();
			logCompletion();
			return {
				kind: "authoritative-snapshot",
				upserted: 0,
				errors: 0,
				errorMessages: [],
				complete: true,
				completedAt,
				receipt: createCoverageReceipt({
					attemptStartedAt,
					observedAt: completedAt,
					evidence: "complete",
					units: coverageUnits,
					domains,
					publishedCanonicalEntities: rows.length,
				}),
				inventoryTargets,
				snapshot: { rows, sections: snapshotSections },
			};
		}
		log.warn(
			{
				aggregationSize: aggregationsArray.length,
				totalLibraryItems,
				mappedLibraryItems,
				ignoredHistoricalItems,
				incompleteReasons,
				errors,
			},
			"Plex cache: skipping eviction because the refreshed inventory was incomplete",
		);

		if (
			canPublishPositivePlexObservation(incompleteReasons) ||
			(receiptOnlyPartial && errors === 0)
		) {
			appendIncompleteReasonMessages(errorMessages, incompleteReasons);
			const positiveRows = rows;
			const positiveCoverageUnits = coverageUnits.map((unit) => ({
				...unit,
				canonicalEntities: positiveRows.filter(
					(row) => row.sectionId === unit.scopeKey.slice("section:".length),
				).length,
			}));
			try {
				await verifyCollectedHistory();
			} catch (error) {
				errorMessages.push(
					`Plex positive observation verification failed: ${getErrorMessage(error)}`,
				);
				return unpublishedCollection({
					errors: errors + 1,
					errorMessages,
					reasons: [...Object.keys(incompleteReasons), "verification-exception"],
					attemptStartedAt,
				});
			}
			logCompletion();
			return {
				kind: "positive-observation",
				...(unsettledWatch ? { unsettledWatch: true } : {}),
				upserted: 0,
				errors,
				errorMessages,
				complete: false,
				receipt: createCoverageReceipt({
					attemptStartedAt,
					observedAt: currentObservedAt(),
					evidence: "positive-only",
					units: positiveCoverageUnits,
					domains,
					publishedCanonicalEntities: positiveRows.length,
				}),
				observation: {
					rows: positiveRows,
					observedTargets: inventoryTargets,
					capabilities: [
						{
							domain: "episode-parents",
							field: "membership",
							semantics: "observed-targets-only",
							operators: [],
						},
					],
					observedRoots: [],
					partialReasons: sortedPartialReasons(incompleteReasons),
				},
			};
		}
		logCompletion();
	} catch (error) {
		complete = false;
		const msg = `Plex cache refresh failed: ${getErrorMessage(error)}`;
		log.error(
			{ category: "plex-cache-refresh-failed", reason: classifyPlexHistoryFailure(error) },
			"Plex cache refresh failed",
		);
		errors++;
		errorMessages.push(msg);
	}

	appendIncompleteReasonMessages(errorMessages, incompleteReasons);

	return unpublishedCollection({
		errors,
		errorMessages,
		reasons: coverageFailure ? ["coverage-incomplete"] : Object.keys(incompleteReasons),
		receipt: createCoverageReceipt({
			attemptStartedAt,
			observedAt: currentObservedAt(),
			evidence: "unknown",
			units: coverageUnits,
		}),
	});
}
