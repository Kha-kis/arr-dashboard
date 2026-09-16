/**
 * Jellyfin Cache Refresher
 *
 * Fetches library items with watch data from Jellyfin and upserts into JellyfinCache.
 * Unlike Plex (which has a separate history endpoint), Jellyfin embeds UserData
 * directly on each item response per-user, so we iterate all users to aggregate.
 *
 * Strategy:
 * 1. Get users → iterate each user for watch data
 * 2. Get libraries (views) → filter to movie/tvshow libraries
 * 3. For each library: get items with ProviderIds + UserData
 * 4. Aggregate watch data across all users
 * 5. Get resume items → mark as onDeck
 * 6. Upsert into JellyfinCache
 */

import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Encryptor } from "../auth/encryption.js";
import type { Prisma, PrismaClient, ServiceInstance } from "../prisma.js";
import {
	type ProviderObservationAttemptInput,
	type ProviderObservationAttemptPublication,
	ProviderObservationCoordinatorError,
	runClaimedProviderObservationAttempt,
	runProviderObservationAttempt,
} from "../provider-observation/coordinator.js";
import type {
	ProviderCoverageReceiptV1,
	ProviderCoverageReceiptV2,
	ProviderCoverageUnitV1,
} from "../provider-observation/coverage-receipt.js";
import { refreshNativeInventory } from "../provider-observation/native-inventory-refresh.js";
import { getStoredHttpAuthHeaders } from "../services/http-auth.js";
import type { ProviderCacheRefreshAttempt } from "../services/provider-cache-status.js";
import {
	createProviderPublicationAuthority,
	type OwnedProviderPublicationSnapshot,
	ProviderIdentityGuardError,
	withGuardedProviderPublication,
} from "../services/provider-identity-guard.js";
import { JellyfinClient, type JellyfinLibrary, type JellyfinUser } from "./jellyfin-client.js";
import {
	encodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
	type JellyfinLibraryGenerationMetadataV1,
} from "./jellyfin-generation-metadata.js";
import { collectJellyfinNativeEpisodeInventory } from "./jellyfin-native-episode-inventory.js";
import { collectJellyfinNativeLibraryInventory } from "./jellyfin-native-inventory.js";

export const JELLYFIN_STALE_EVICTION_CHUNK_SIZE = 500;
/** Bound Prisma's cached createMany query plans for production-sized libraries. */
export const JELLYFIN_CACHE_PUBLICATION_CHUNK_SIZE = 100;
/** Allow bounded publication batches to complete on higher-latency databases. */
export const JELLYFIN_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS = 60_000;

// ============================================================================
// Aggregation Types
// ============================================================================

interface ItemAggregation {
	tmdbId: number;
	mediaType: "movie" | "series";
	libraryId: string;
	libraryName: string;
	title: string;
	jellyfinId: string;
	lastWatchedAt: Date | null;
	watchCount: number;
	watchedByUsers: Set<string>;
	onDeck: boolean;
	userRating: number | null;
	collections: string[];
	addedAt: Date | null;
	thumb: string | null;
	sourceIds: Set<string>;
}

function isValidWatchCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validWatchDate(value: unknown): Date | null {
	if (typeof value !== "string" || value.trim() === "") return null;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date : null;
}

export interface JellyfinCacheSnapshotRow {
	instanceId: string;
	tmdbId: number;
	mediaType: "movie" | "series";
	libraryId: string;
	libraryName: string;
	title: string;
	jellyfinId: string;
	lastWatchedAt: Date | null;
	watchCount: number;
	watchedByUsers: string;
	onDeck: boolean;
	userRating: number | null;
	collections: string;
	addedAt: Date | null;
	thumb: string | null;
}

export interface JellyfinCacheSnapshot {
	rows: JellyfinCacheSnapshotRow[];
	users: Array<{ id: string; name: string }>;
	libraries: Array<{
		userId: string;
		libraryId: string;
		libraryName: string;
		collectionType: string;
	}>;
}

export interface JellyfinPublicationContext {
	prisma: PrismaClient;
	instance: OwnedProviderPublicationSnapshot;
	log: FastifyBaseLogger;
	cleanupRunClaimToken?: string;
}

export interface JellyfinCacheRefreshResult {
	nativeInventoryStatus?: "published" | "failed" | "superseded";
	upserted: number;
	errors: number;
	errorMessages: string[];
	complete: boolean;
	completedAt?: Date;
	superseded?: boolean;
	snapshot?: JellyfinCacheSnapshot;
	receipt?: ProviderCoverageReceiptV1 | ProviderCoverageReceiptV2;
}

export type JellyfinCacheCollectionResult = JellyfinCacheRefreshResult & {
	receipt: ProviderCoverageReceiptV1 | ProviderCoverageReceiptV2;
};

// ============================================================================
// Main Refresh Function
// ============================================================================

export function createOwnedJellyfinPublicationSnapshot(
	encryptor: Pick<Encryptor, "decrypt">,
	instance: ServiceInstance,
): OwnedProviderPublicationSnapshot {
	if (instance.service !== "JELLYFIN" && instance.service !== "EMBY") {
		throw new Error("Jellyfin publication requires a Jellyfin or Emby service instance");
	}
	return {
		...createProviderPublicationAuthority(instance),
		label: instance.label,
		apiKey: encryptor.decrypt({ value: instance.encryptedApiKey, iv: instance.encryptionIv }),
		httpAuthHeaders: getStoredHttpAuthHeaders(encryptor, instance),
	};
}

function jellyfinClientForSnapshot(
	instance: OwnedProviderPublicationSnapshot,
	log: FastifyBaseLogger,
): JellyfinClient {
	return new JellyfinClient(
		instance.baseUrl,
		instance.apiKey,
		log,
		undefined,
		instance.httpAuthHeaders,
	);
}

export async function refreshJellyfinCache(
	context: JellyfinPublicationContext,
): Promise<JellyfinCacheRefreshResult> {
	const { prisma, instance, log } = context;
	try {
		return await withGuardedProviderPublication(
			prisma,
			instance,
			log,
			async () =>
				await collectJellyfinCacheLiveEvidence(
					jellyfinClientForSnapshot(instance, log),
					instance.id,
					log,
					{
						provider: instance.service === "EMBY" ? "emby" : "jellyfin",
					},
				),
			async (tx, collected) => await publishJellyfinCache(tx, instance, collected),
			{
				cleanupRunClaimToken: context.cleanupRunClaimToken,
				timeout: JELLYFIN_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS,
			},
		);
	} catch (error) {
		log.error({ category: "publication-rejected" }, "Jellyfin cache publication rejected");
		if (error instanceof ProviderIdentityGuardError && error.code === "PUBLICATION_SUPERSEDED") {
			return { upserted: 0, errors: 0, errorMessages: [], complete: false, superseded: true };
		}
		return {
			upserted: 0,
			errors: 1,
			errorMessages: [
				error instanceof ProviderIdentityGuardError
					? "provider-publication-rejected"
					: "Atomic cache publication failed",
			],
			complete: false,
		};
	}
}

/**
 * Refresh and publish a Jellyfin/Emby library generation under the durable
 * provider-observation coordinator. The legacy refresh above remains the
 * compatibility entry point for callers that have not adopted attempts.
 */
export async function refreshOwnedJellyfinCache(context: {
	prisma: PrismaClient;
	encryptor: Pick<Encryptor, "decrypt">;
	instance: ServiceInstance;
	log: FastifyBaseLogger;
	cleanupRunClaimToken?: string;
}): Promise<JellyfinCacheRefreshResult> {
	return await runOwnedJellyfinCacheAttempt(context);
}

/** Continue a Jellyfin/Emby refresh with the caller's exact durable claim. */
export async function refreshOwnedJellyfinCacheWithAttempt(
	context: {
		prisma: PrismaClient;
		encryptor: Pick<Encryptor, "decrypt">;
		instance: ServiceInstance;
		log: FastifyBaseLogger;
		cleanupRunClaimToken?: string;
	},
	attempt: ProviderCacheRefreshAttempt,
): Promise<JellyfinCacheRefreshResult> {
	return await runOwnedJellyfinCacheAttempt(context, attempt);
}

async function runOwnedJellyfinCacheAttempt(
	context: {
		prisma: PrismaClient;
		encryptor: Pick<Encryptor, "decrypt">;
		instance: ServiceInstance;
		log: FastifyBaseLogger;
		cleanupRunClaimToken?: string;
	},
	claimedAttempt?: ProviderCacheRefreshAttempt,
): Promise<JellyfinCacheRefreshResult> {
	let nativeInventoryStatus: JellyfinCacheRefreshResult["nativeInventoryStatus"];
	try {
		const authority = createProviderPublicationAuthority(context.instance);
		const provider = authority.service === "EMBY" ? "emby" : "jellyfin";
		const input: ProviderObservationAttemptInput<
			OwnedProviderPublicationSnapshot,
			JellyfinCacheCollectionResult,
			JellyfinCacheRefreshResult
		> = {
			prisma: context.prisma,
			authority,
			cacheType: "jellyfin",
			log: context.log,
			prepare: () => createOwnedJellyfinPublicationSnapshot(context.encryptor, context.instance),
			collect: async (prepared, attempt) => {
				const nativeResults = [];
				for (const [domain, collect] of [
					["library", collectJellyfinNativeLibraryInventory],
					["episode", collectJellyfinNativeEpisodeInventory],
				] as const) {
					const result = await refreshNativeInventory({
						prisma: context.prisma,
						instance: prepared,
						log: context.log,
						cacheType: "jellyfin",
						attempt,
						domains: [domain],
						cleanupRunClaimToken: context.cleanupRunClaimToken,
						collect: async (instance) =>
							await collect(jellyfinClientForSnapshot(instance, context.log)),
					});
					nativeResults.push(result.status);
				}
				nativeInventoryStatus = nativeResults.includes("failed")
					? "failed"
					: nativeResults.includes("superseded")
						? "superseded"
						: "published";
				const collected = await collectJellyfinCacheLiveEvidence(
					jellyfinClientForSnapshot(prepared, context.log),
					prepared.id,
					context.log,
					{ provider, attemptStartedAt: attempt.attemptedAt },
				);
				if (
					!collected.completedAt ||
					!collected.snapshot ||
					!collected.receipt ||
					(!collected.complete && collected.snapshot.rows.length === 0)
				) {
					throw new ProviderObservationCoordinatorError("provider-unavailable");
				}
				return collected;
			},
			publish: async (
				tx,
				collected,
			): Promise<ProviderObservationAttemptPublication<JellyfinCacheRefreshResult>> => {
				if (
					!collected.completedAt ||
					!collected.snapshot ||
					!collected.receipt ||
					(!collected.complete && collected.snapshot.rows.length === 0)
				) {
					throw new ProviderObservationCoordinatorError("receipt-invalid");
				}
				const rows = collected.snapshot.rows;
				const generationId = randomUUID();
				let generationMetadata: string;
				try {
					const metadata: JellyfinLibraryGenerationMetadataV1 = collected.complete
						? {
								version: 1,
								provider,
								cacheType: "jellyfin",
								publicationLevel: "authoritative",
								completeness: "complete",
								canonicalizationVersion: 1,
								itemCount: rows.length,
								connectionGeneration: authority.connectionGeneration,
								identityGeneration: authority.identityGeneration,
								contentFingerprint: fingerprintJellyfinLibraryRows(rows),
								coverageReceipt: collected.receipt,
							}
						: {
								version: 1,
								provider,
								cacheType: "jellyfin",
								publicationLevel: "positive-only",
								completeness: "partial",
								canonicalizationVersion: 1,
								itemCount: rows.length,
								connectionGeneration: authority.connectionGeneration,
								identityGeneration: authority.identityGeneration,
								contentFingerprint: fingerprintJellyfinLibraryRows(rows),
								coverageReceipt: collected.receipt,
							};
					generationMetadata = encodeJellyfinLibraryGenerationMetadata(metadata);
				} catch {
					throw new ProviderObservationCoordinatorError("receipt-invalid");
				}
				await replaceJellyfinCacheRows(tx, authority, rows);
				return {
					result: { ...collected, upserted: rows.length },
					publication: {
						receipt: collected.receipt as ProviderCoverageReceiptV1,
						observedAt: collected.completedAt,
						itemCount: rows.length,
						generationId,
						generationMetadata,
					},
				};
			},
			failureReason: (error) =>
				error instanceof ProviderIdentityGuardError && error.code === "PUBLICATION_SUPERSEDED"
					? "publication-superseded"
					: "provider-unavailable",
			options: {
				cleanupRunClaimToken: context.cleanupRunClaimToken,
				timeout: JELLYFIN_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS,
			},
		};
		const result = claimedAttempt
			? await runClaimedProviderObservationAttempt(input, claimedAttempt)
			: await runProviderObservationAttempt(input);
		return { ...result, ...(nativeInventoryStatus ? { nativeInventoryStatus } : {}) };
	} catch (error) {
		context.log.error({ category: "publication-rejected" }, "Jellyfin cache publication rejected");
		if (
			error instanceof ProviderObservationCoordinatorError &&
			error.code === "publication-superseded"
		) {
			return { upserted: 0, errors: 0, errorMessages: [], complete: false, superseded: true };
		}
		return {
			...(nativeInventoryStatus ? { nativeInventoryStatus } : {}),
			upserted: 0,
			errors: 1,
			errorMessages: [
				error instanceof ProviderObservationCoordinatorError && error.code === "receipt-invalid"
					? "receipt-invalid"
					: "provider-unavailable",
			],
			complete: false,
		};
	}
}

async function publishJellyfinCache(
	tx: Prisma.TransactionClient,
	instance: OwnedProviderPublicationSnapshot,
	collected: JellyfinCacheRefreshResult,
): Promise<JellyfinCacheRefreshResult> {
	if (!collected.complete || !collected.completedAt || !collected.snapshot) return collected;
	const rows = collected.snapshot.rows;
	await replaceJellyfinCacheRows(tx, instance, rows);
	await tx.cacheRefreshStatus.upsert({
		where: { instanceId_cacheType: { instanceId: instance.id, cacheType: "jellyfin" } },
		create: {
			instanceId: instance.id,
			cacheType: "jellyfin",
			lastRefreshedAt: collected.completedAt,
			lastResult: "success",
			itemCount: rows.length,
			lastAttemptAt: collected.completedAt,
			lastAttemptResult: "success",
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
		},
		update: {
			lastRefreshedAt: collected.completedAt,
			lastResult: "success",
			lastErrorMessage: null,
			itemCount: rows.length,
			lastAttemptAt: collected.completedAt,
			lastAttemptResult: "success",
			lastAttemptErrorMessage: null,
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
		},
	});
	return { ...collected, upserted: rows.length };
}

async function replaceJellyfinCacheRows(
	tx: Prisma.TransactionClient,
	instance: Pick<
		OwnedProviderPublicationSnapshot,
		"id" | "connectionGeneration" | "identityGeneration"
	>,
	rows: JellyfinCacheSnapshotRow[],
): Promise<void> {
	await tx.jellyfinCache.deleteMany({ where: { instanceId: instance.id } });
	for (let start = 0; start < rows.length; start += JELLYFIN_CACHE_PUBLICATION_CHUNK_SIZE) {
		await tx.jellyfinCache.createMany({
			data: rows.slice(start, start + JELLYFIN_CACHE_PUBLICATION_CHUNK_SIZE).map((row) => ({
				...row,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
			})),
		});
	}
}

interface JellyfinCollectionOptions {
	provider?: "jellyfin" | "emby";
	attemptStartedAt?: Date;
	observedAt?: Date;
}

function createCoverageReceipt(
	provider: "jellyfin" | "emby",
	attemptStartedAt: Date,
	observedAt: Date,
	evidence: ProviderCoverageReceiptV1["evidence"],
	units: ProviderCoverageUnitV1[],
	publishedCanonicalEntities?: number,
): ProviderCoverageReceiptV1 {
	return {
		version: 1,
		provider,
		attemptStartedAt: attemptStartedAt.toISOString(),
		observedAt: observedAt.toISOString(),
		evidence,
		units,
		...(publishedCanonicalEntities === undefined ? {} : { publishedCanonicalEntities }),
	};
}

function createCoverageReceiptV2(
	provider: "jellyfin" | "emby",
	attemptStartedAt: Date,
	observedAt: Date,
	evidence: ProviderCoverageReceiptV2["evidence"],
	units: ProviderCoverageUnitV1[],
	domains: ProviderCoverageReceiptV2["domains"],
	publishedCanonicalEntities?: number,
): ProviderCoverageReceiptV2 {
	return {
		version: 2,
		provider,
		attemptStartedAt: attemptStartedAt.toISOString(),
		observedAt: observedAt.toISOString(),
		evidence,
		units,
		...(publishedCanonicalEntities === undefined ? {} : { publishedCanonicalEntities }),
		domains,
	};
}

function createCoverageUnit(
	scopeKey: string,
	pageResult: Pick<
		{
			expectedRawCount: number | null;
			pagesAttempted: number;
			pagesCompleted: number;
			rawObserved: number;
		},
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

function addCoverageSkip(
	unit: ProviderCoverageUnitV1,
	reason: ProviderCoverageUnitV1["acceptedSkips"][number]["reason"],
	count = 1,
): void {
	const existing = unit.acceptedSkips.find((skip) => skip.reason === reason);
	if (existing) existing.count += count;
	else unit.acceptedSkips.push({ reason, count });
}

export async function collectJellyfinCacheLiveEvidence(
	client: JellyfinClient,
	instanceId: string,
	log: FastifyBaseLogger,
	options: JellyfinCollectionOptions = {},
): Promise<JellyfinCacheCollectionResult> {
	const provider = options.provider ?? "jellyfin";
	const attemptStartedAt = options.attemptStartedAt ?? new Date();
	const observedAt = options.observedAt ?? new Date();
	const coverageUnits: ProviderCoverageUnitV1[] = [];
	const libraryInventoryUnits: ProviderCoverageUnitV1[] = [];
	const mappingUnits: ProviderCoverageUnitV1[] = [];
	const unknown = (input: {
		errors: number;
		errorMessages: string[];
		units?: ProviderCoverageUnitV1[];
	}): JellyfinCacheCollectionResult => ({
		upserted: 0,
		errors: input.errors,
		errorMessages: input.errorMessages,
		complete: false,
		receipt: createCoverageReceipt(
			provider,
			attemptStartedAt,
			observedAt,
			"unknown",
			input.units ?? coverageUnits,
		),
	});

	let errors = 0;
	let complete = true;
	let mappingGap = false;
	const errorMessages: string[] = [];
	const librariesByUser: Array<{ user: JellyfinUser; libraries: JellyfinLibrary[] }> = [];
	const aggregations = new Map<string, ItemAggregation>();
	const sourceIdentity = new Map<string, string>();

	try {
		let users: JellyfinUser[];
		try {
			users = await client.getUsers();
		} catch {
			log.error({ category: "user-discovery-failed" }, "Jellyfin user discovery failed");
			return unknown({ errors: 1, errorMessages: ["user-discovery-failed"], units: [] });
		}
		if (users.length === 0) {
			log.warn({ category: "no-users" }, "Jellyfin cache refresh found no users");
			return unknown({ errors: 1, errorMessages: ["Jellyfin returned no users"], units: [] });
		}
		const userIds = new Set<string>();
		for (const user of users) {
			if (!user.id.trim() || userIds.has(user.id)) {
				log.warn(
					{ category: "invalid-user-identity" },
					"Jellyfin user identity inventory is invalid",
				);
				return unknown({ errors: 1, errorMessages: ["invalid-user-identity"], units: [] });
			}
			userIds.add(user.id);
		}

		for (const user of users) {
			try {
				const libraries = await client.getLibraries(user.id);
				const libraryIds = new Set<string>();
				if (
					libraries.some(
						(library) =>
							!library.id.trim() || libraryIds.has(library.id) || !libraryIds.add(library.id),
					)
				) {
					complete = false;
					errors++;
					errorMessages.push("invalid-library-identity");
					log.warn(
						{ category: "invalid-library-identity" },
						"Jellyfin library identity inventory is invalid",
					);
					continue;
				}
				librariesByUser.push({
					user,
					libraries: libraries.filter(
						(lib) =>
							lib.collectionType === "movies" ||
							lib.collectionType === "tvshows" ||
							lib.collectionType === "CollectionFolder",
					),
				});
			} catch {
				complete = false;
				errors++;
				errorMessages.push("library-discovery-failed");
				log.warn({ category: "library-discovery-failed" }, "Jellyfin library discovery failed");
			}
		}

		if (librariesByUser.every(({ libraries }) => libraries.length === 0)) {
			return unknown({
				errors: Math.max(errors, 1),
				errorMessages:
					errorMessages.length > 0 ? errorMessages : ["Jellyfin returned no movie or TV libraries"],
			});
		}

		for (const { user, libraries } of librariesByUser) {
			for (const library of libraries) {
				const includeItemTypes =
					library.collectionType === "movies"
						? "Movie"
						: library.collectionType === "tvshows"
							? "Series"
							: "Movie,Series";
				const scopeKey = `user:${user.id}/library:${library.id}`;
				let pageResult: Awaited<ReturnType<JellyfinClient["getLibraryItemsWithCoverage"]>>;
				try {
					pageResult = await client.getLibraryItemsWithCoverage(user.id, library.id, {
						includeItemTypes,
					});
				} catch {
					complete = false;
					errors++;
					const unit = createCoverageUnit(scopeKey, {
						expectedRawCount: null,
						pagesAttempted: 1,
						pagesCompleted: 0,
						rawObserved: 0,
					});
					unit.fatalCount = 1;
					coverageUnits.push(unit);
					libraryInventoryUnits.push({ ...unit, scopeKey: `${scopeKey}/inventory` });
					mappingUnits.push({ ...unit, scopeKey: `${scopeKey}/mapping` });
					errorMessages.push("library-page-failed");
					log.warn({ category: "library-page-failed" }, "Jellyfin library page failed");
					continue;
				}

				const unit = createCoverageUnit(scopeKey, pageResult);
				coverageUnits.push(unit);
				const libraryUnit = createCoverageUnit(`${scopeKey}/inventory`, pageResult);
				const mappingUnit = createCoverageUnit(`${scopeKey}/mapping`, {
					expectedRawCount: pageResult.expectedRawCount,
					pagesAttempted: pageResult.pagesAttempted,
					pagesCompleted: pageResult.pagesCompleted,
					rawObserved: 0,
				});
				libraryInventoryUnits.push(libraryUnit);
				mappingUnits.push(mappingUnit);
				if (
					pageResult.reason !== null ||
					pageResult.expectedRawCount !== pageResult.rawObserved ||
					pageResult.pagesAttempted !== pageResult.pagesCompleted
				) {
					complete = false;
					errors++;
					unit.fatalCount = 1;
					libraryUnit.fatalCount = 1;
					mappingUnit.fatalCount = 1;
					log.warn(
						{ category: "library-coverage-incomplete" },
						"Jellyfin library coverage incomplete",
					);
					continue;
				}

				const unitCanonicalKeys = new Set<string>();
				for (const item of pageResult.items) {
					if (item.type === "BoxSet") {
						addCoverageSkip(unit, "known-container");
						addCoverageSkip(libraryUnit, "known-container");
						continue;
					}
					if (item.type !== "Movie" && item.type !== "Series") {
						complete = false;
						addCoverageSkip(unit, "unsupported-provider-object");
						addCoverageSkip(libraryUnit, "unsupported-provider-object");
						libraryUnit.fatalCount++;
						continue;
					}
					libraryUnit.sourceBindings++;
					mappingUnit.rawObserved++;
					if (!item.id.trim()) {
						complete = false;
						addCoverageSkip(unit, "missing-stable-key");
						addCoverageSkip(mappingUnit, "missing-stable-key");
						continue;
					}
					const tmdbId = item.tmdbId;
					if (typeof tmdbId !== "number" || !Number.isSafeInteger(tmdbId) || tmdbId <= 0) {
						complete = false;
						mappingGap = true;
						addCoverageSkip(unit, "missing-supported-mapping");
						addCoverageSkip(mappingUnit, "missing-supported-mapping");
						continue;
					}

					const mediaType = item.type === "Movie" ? "movie" : "series";
					const key = `${tmdbId}:${mediaType}:${library.id}`;
					const priorIdentity = sourceIdentity.get(item.id);
					if (priorIdentity && priorIdentity !== key) {
						complete = false;
						errors++;
						unit.fatalCount++;
						errorMessages.push("source-identity-conflict");
						log.warn(
							{ category: "source-identity-conflict" },
							"Jellyfin source identity conflict blocked publication",
						);
						continue;
					}
					sourceIdentity.set(item.id, key);
					unit.sourceBindings++;
					mappingUnit.sourceBindings++;
					unitCanonicalKeys.add(key);

					let agg = aggregations.get(key);
					if (!agg) {
						const newAggregation: ItemAggregation = {
							tmdbId,
							mediaType,
							libraryId: library.id,
							libraryName: library.name,
							title: item.name,
							jellyfinId: item.id,
							lastWatchedAt: null,
							watchCount: 0,
							watchedByUsers: new Set(),
							onDeck: false,
							userRating: null,
							collections: [],
							addedAt: item.dateCreated ? new Date(item.dateCreated) : null,
							thumb: item.imageTags?.Primary ? `/Items/${item.id}/Images/Primary` : null,
							sourceIds: new Set([item.id]),
						};
						agg = newAggregation;
						aggregations.set(key, newAggregation);
					} else {
						agg.sourceIds.add(item.id);
						if (library.name.localeCompare(agg.libraryName) < 0) {
							agg.libraryName = library.name;
						}
						if (item.id.localeCompare(agg.jellyfinId) < 0) {
							agg.title = item.name;
							agg.jellyfinId = item.id;
							agg.addedAt = item.dateCreated ? new Date(item.dateCreated) : null;
							agg.thumb = item.imageTags?.Primary ? `/Items/${item.id}/Images/Primary` : null;
						}
					}

					const watchCount = isValidWatchCount(item.playCount) ? item.playCount : 0;
					if (item.played === true && watchCount > 0) {
						agg.watchedByUsers.add(user.name);
						agg.watchCount = Math.max(agg.watchCount, watchCount);
					}
					const playDate = validWatchDate(item.lastPlayedDate);
					if (playDate) {
						if (!agg.lastWatchedAt || playDate > agg.lastWatchedAt) agg.lastWatchedAt = playDate;
					}
					if (item.isFavorite) agg.userRating = 10.0;
				}
				unit.canonicalEntities = unitCanonicalKeys.size;
				libraryUnit.canonicalEntities = unitCanonicalKeys.size;
				mappingUnit.canonicalEntities = unitCanonicalKeys.size;
				mappingUnit.expectedRawCount = mappingUnit.rawObserved;
			}
		}

		for (const user of users) {
			const onDeckUnit = createCoverageUnit(`user:${user.id}/on-deck`, {
				expectedRawCount: null,
				pagesAttempted: 1,
				pagesCompleted: 0,
				rawObserved: 0,
			});
			try {
				const [resumeItems, nextUp] = await Promise.all([
					client.getResumeItems(user.id),
					client.getNextUp(user.id),
				]);
				onDeckUnit.pagesCompleted = 1;
				const onDeckCanonicalKeys = new Set<string>();
				for (const item of [...resumeItems, ...nextUp]) {
					onDeckUnit.rawObserved++;
					if (item.type !== "Movie" && item.type !== "Series" && item.type !== "Episode") {
						complete = false;
						addCoverageSkip(onDeckUnit, "unsupported-provider-object");
						continue;
					}
					const jellyfinId =
						item.type === "Movie" || item.type === "Series" ? item.id : item.seriesId;
					if (!jellyfinId?.trim()) {
						complete = false;
						addCoverageSkip(onDeckUnit, "missing-stable-key");
						continue;
					}
					let matched = false;
					for (const agg of aggregations.values()) {
						if (agg.sourceIds.has(jellyfinId)) {
							agg.onDeck = true;
							matched = true;
							onDeckUnit.sourceBindings++;
							const canonicalKey = `${agg.mediaType}:${agg.tmdbId}:${agg.libraryId}`;
							onDeckCanonicalKeys.add(canonicalKey);
						}
					}
					if (!matched) {
						complete = false;
						addCoverageSkip(onDeckUnit, "missing-supported-mapping");
					}
				}
				onDeckUnit.canonicalEntities = onDeckCanonicalKeys.size;
				coverageUnits.push(onDeckUnit);
			} catch {
				complete = false;
				onDeckUnit.fatalCount = 1;
				errorMessages.push("on-deck-fetch-failed");
				coverageUnits.push(onDeckUnit);
				log.warn({ category: "on-deck-fetch-failed" }, "Jellyfin on-deck fetch failed");
			}
		}

		const rows: JellyfinCacheSnapshotRow[] = [...aggregations.values()].map((agg) => ({
			instanceId,
			tmdbId: agg.tmdbId,
			mediaType: agg.mediaType,
			libraryId: agg.libraryId,
			libraryName: agg.libraryName,
			title: agg.title,
			jellyfinId: agg.jellyfinId,
			lastWatchedAt: agg.lastWatchedAt,
			watchCount: agg.watchCount,
			watchedByUsers: JSON.stringify([...agg.watchedByUsers].sort()),
			onDeck: agg.onDeck,
			userRating: agg.userRating,
			collections: JSON.stringify([...agg.collections].sort()),
			addedAt: agg.addedAt,
			thumb: agg.thumb,
		}));

		const hasHardFailure =
			errors > 0 ||
			coverageUnits.some((unit) => unit.fatalCount > 0 && !unit.scopeKey.endsWith("/on-deck"));
		if (hasHardFailure) {
			log.warn(
				{ category: "incomplete-refresh", errors },
				"Skipping cache publication due to incomplete refresh",
			);
			return unknown({ errors, errorMessages });
		}
		const completedAt = options.observedAt ?? new Date();
		if (!complete && rows.length === 0) {
			log.warn({ category: "partial-empty" }, "Skipping empty positive-only Jellyfin publication");
			return unknown({ errors: 0, errorMessages });
		}
		const watchCountRows = rows.filter((row) => row.watchCount > 0);
		const watchCountUnit = createCoverageUnit("jellyfin:watch-count", {
			expectedRawCount: null,
			pagesAttempted: 1,
			pagesCompleted: 1,
			rawObserved: watchCountRows.length,
		});
		watchCountUnit.sourceBindings = watchCountRows.length;
		watchCountUnit.canonicalEntities = watchCountRows.length;
		const watchAttributionRows = rows.filter((row) => row.watchedByUsers !== "[]");
		const watchAttributionUnit = createCoverageUnit("jellyfin:watch-attribution", {
			expectedRawCount: null,
			pagesAttempted: 1,
			pagesCompleted: 1,
			rawObserved: watchAttributionRows.length,
		});
		watchAttributionUnit.sourceBindings = watchAttributionRows.length;
		watchAttributionUnit.canonicalEntities = watchAttributionRows.length;
		const mappedRows = rows.length;
		const libraryInventoryComplete =
			libraryInventoryUnits.length > 0 &&
			libraryInventoryUnits.every(
				(unit) =>
					unit.pagesAttempted === unit.pagesCompleted &&
					unit.fatalCount === 0 &&
					(unit.expectedRawCount === null || unit.expectedRawCount === unit.rawObserved),
			);
		const onDeckGap = coverageUnits.some(
			(unit) =>
				unit.scopeKey.endsWith("/on-deck") &&
				(unit.fatalCount > 0 ||
					unit.acceptedSkips.some((skip) => skip.reason !== "known-container")),
		);
		const onDeckMapped = coverageUnits
			.filter((unit) => unit.scopeKey.endsWith("/on-deck"))
			.reduce((total, unit) => total + unit.sourceBindings, 0);
		const domains: ProviderCoverageReceiptV2["domains"] = [
			{
				domain: "library-inventory",
				evidence: libraryInventoryComplete ? "complete" : "unknown",
				valueSemantics: libraryInventoryComplete ? "exact" : "unknown",
				units: libraryInventoryUnits,
			},
			{
				domain: "mapping",
				evidence: mappingGap ? (mappedRows > 0 ? "positive-only" : "unknown") : "complete",
				valueSemantics: mappingGap ? (mappedRows > 0 ? "lower-bound" : "unknown") : "exact",
				units: mappingUnits,
				publishedCanonicalEntities: mappedRows,
			},
			{
				domain: "watch-count",
				evidence: watchCountRows.length > 0 ? "positive-only" : "unknown",
				valueSemantics: watchCountRows.length > 0 ? "lower-bound" : "unknown",
				units: [watchCountUnit],
			},
			{
				domain: "watch-attribution",
				evidence: watchAttributionRows.length > 0 ? "positive-only" : "unknown",
				valueSemantics: watchAttributionRows.length > 0 ? "lower-bound" : "unknown",
				units: [watchAttributionUnit],
			},
			{
				domain: "on-deck",
				evidence: onDeckGap ? (onDeckMapped > 0 ? "positive-only" : "unknown") : "complete",
				valueSemantics: onDeckGap ? (onDeckMapped > 0 ? "lower-bound" : "unknown") : "exact",
				units: coverageUnits.filter((unit) => unit.scopeKey.endsWith("/on-deck")),
			},
		];
		const receipt = createCoverageReceiptV2(
			provider,
			attemptStartedAt,
			completedAt,
			complete ? "complete" : "positive-only",
			coverageUnits,
			domains,
			rows.length,
		);
		return {
			upserted: 0,
			errors: 0,
			errorMessages: [],
			complete,
			completedAt,
			receipt,
			snapshot: {
				rows,
				users: users
					.map((user) => ({ id: user.id, name: user.name }))
					.sort((left, right) => left.id.localeCompare(right.id)),
				libraries: librariesByUser
					.flatMap(({ user, libraries }) =>
						libraries.map((library) => ({
							userId: user.id,
							libraryId: library.id,
							libraryName: library.name,
							collectionType: library.collectionType,
						})),
					)
					.sort(
						(left, right) =>
							left.userId.localeCompare(right.userId) ||
							left.libraryId.localeCompare(right.libraryId),
					),
			},
		};
	} catch {
		errorMessages.push("refresh-failed");
		log.error({ category: "refresh-failed" }, "Jellyfin cache refresh failed");
		return unknown({ errors: errors + 1, errorMessages });
	}
}
