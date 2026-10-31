import type {
	ProwlarrIndexer,
	ProwlarrIndexerDetails,
	ProwlarrIndexerHealth,
	SearchCoverage,
	SearchIndexerUpdateChanges,
	SearchRequest,
	SearchResult,
} from "@arr/shared";
import { isSensitiveProwlarrField, prowlarrIndexerDetailsSchema } from "@arr/shared";
import { ArrError } from "arr-sdk";
import type { ProwlarrClient } from "arr-sdk/prowlarr";
import type { ServiceInstance } from "../../lib/prisma.js";
import { AppValidationError, ConflictError } from "../errors.js";
import { loggers } from "../logger.js";
import { type SearchGrabTarget, searchGrabTargetSchema } from "./grab-selector.js";
import {
	normalizeIndexer,
	normalizeIndexerDetails,
	normalizeIndexerField,
	normalizeSearchResult,
} from "./normalizers.js";

const log = loggers.api;

/**
 * Builds a fallback indexer details object when the real data cannot be fetched.
 */
export const buildIndexerDetailsFallback = (
	instanceId: string,
	instanceName: string,
	instanceUrl: string | undefined,
	indexerId: number,
): ProwlarrIndexerDetails => {
	const parsed = prowlarrIndexerDetailsSchema.safeParse({
		id: indexerId,
		name: `Indexer ${indexerId}`,
		instanceId,
		instanceName,
		instanceUrl,
	});
	return parsed.success
		? parsed.data
		: ({
				id: indexerId,
				name: `Indexer ${indexerId}`,
				instanceId,
				instanceName,
				instanceUrl,
			} as ProwlarrIndexerDetails);
};

/**
 * Options for performing a manual search in Prowlarr.
 */
export type ManualSearchOptions = {
	query: string;

	type: SearchRequest["type"];

	limit: number;

	indexerIds?: number[];

	categories?: number[];
};

// ============================================================================
// SDK-based functions (arr-sdk 0.3.0)
// ============================================================================

/**
 * Fetches all indexers from a Prowlarr instance using the SDK.
 */
export const fetchProwlarrIndexersWithSdk = async (
	client: ProwlarrClient,
	instance: ServiceInstance,
): Promise<ProwlarrIndexer[]> => {
	// Fetch indexers and stats in parallel for inline health indicators
	const [rawIndexers, allStats] = await Promise.all([
		client.indexer.getAll(),
		client.indexerStats.get({}).catch(() => null),
	]);

	// Build a map of indexerId → stats for efficient joining
	const statsMap = new Map<number, Record<string, unknown>>();
	if (allStats?.indexers && Array.isArray(allStats.indexers)) {
		for (const stat of allStats.indexers) {
			const record = stat as Record<string, unknown>;
			const indexerId = typeof record.indexerId === "number" ? record.indexerId : undefined;
			if (typeof indexerId === "number") {
				statsMap.set(indexerId, record);
			}
		}
	}

	const items: ProwlarrIndexer[] = [];

	for (const record of rawIndexers) {
		const raw = record as Record<string, unknown>;
		const id = typeof raw.id === "number" ? raw.id : undefined;
		const stat = typeof id === "number" ? statsMap.get(id) : undefined;

		const normalized = normalizeIndexer(
			raw,
			instance.id,
			instance.label,
			instance.baseUrl,
			stat ?? null,
		);

		if (normalized) {
			items.push(normalized);
		}
	}

	return items;
};

/**
 * Fetches detailed indexer information from Prowlarr using the SDK.
 *
 * When `prefetchedHealth` is provided (from the list endpoint), the redundant
 * indexerStats API call is skipped — only the indexer config/fields are fetched.
 * This cuts the Prowlarr round-trips from 2 to 1 when expanding details.
 */
export const fetchProwlarrIndexerDetailsWithSdk = async (
	client: ProwlarrClient,
	instance: ServiceInstance,
	indexerId: number,
	prefetchedHealth?: ProwlarrIndexerHealth | null,
): Promise<ProwlarrIndexerDetails | null> => {
	try {
		if (prefetchedHealth) {
			// Fast path: stats already available from list endpoint, only fetch config
			const indexer = await client.indexer.getById(indexerId);
			return normalizeIndexerDetails(
				indexer as Record<string, unknown>,
				null,
				instance,
				indexerId,
				prefetchedHealth,
			);
		}

		// Fallback path: fetch both config and stats in parallel
		const [indexer, stats] = await Promise.all([
			client.indexer.getById(indexerId),
			client.indexerStats.get({ indexers: [indexerId] }).catch(() => null),
		]);

		const indexerStats = stats?.indexers?.find(
			(s: Record<string, unknown>) => s.indexerId === indexerId,
		);

		return normalizeIndexerDetails(
			indexer as Record<string, unknown>,
			indexerStats ?? null,
			instance,
			indexerId,
		);
	} catch (error) {
		log.warn(
			{ err: error, indexerId, instanceLabel: instance.label, instanceId: instance.id },
			"Failed to fetch indexer details from Prowlarr",
		);
		return null;
	}
};

/**
 * Updates an indexer configuration in Prowlarr using the SDK.
 */
export class IndexerUpdateDispatchError extends Error {
	constructor(cause: unknown) {
		super("Indexer update outcome is unknown", { cause });
		this.name = "IndexerUpdateDispatchError";
	}
}

export class IndexerUpdateRejectedError extends Error {
	readonly statusCode: number;

	constructor(providerStatus: number) {
		super("Prowlarr rejected the indexer update");
		this.name = "IndexerUpdateRejectedError";
		this.statusCode =
			providerStatus === 400 ? 400 : providerStatus === 404 || providerStatus === 409 ? 409 : 502;
	}
}

/** A verified result requires every requested edit to survive provider readback. */
export const indexerUpdateReadbackMatchesChanges = (
	readback: ProwlarrIndexerDetails,
	changes: SearchIndexerUpdateChanges,
): boolean => {
	if (changes.enable !== undefined && readback.enable !== changes.enable) return false;
	if (changes.priority !== undefined && readback.priority !== changes.priority) return false;
	for (const changed of changes.fields ?? []) {
		const matching = readback.fields?.filter((field) => field.name === changed.name) ?? [];
		if (matching.length !== 1 || matching[0]?.value !== changed.value) return false;
	}
	return true;
};

export const updateProwlarrIndexerWithSdk = async (
	client: ProwlarrClient,
	indexerId: number,
	changes: SearchIndexerUpdateChanges,
): Promise<unknown> => {
	const fetched = await client.indexer.getById(indexerId);
	if (!fetched || typeof fetched !== "object" || Array.isArray(fetched)) {
		throw new ConflictError("Indexer identity could not be verified before update");
	}
	const current = fetched as Record<string, unknown>;
	if (current.id !== indexerId) {
		throw new ConflictError("Indexer identity changed before update");
	}

	const update = { ...fetched, id: indexerId };
	const editable = update as Record<string, unknown>;
	if (changes.enable !== undefined) editable.enable = changes.enable;
	if (changes.priority !== undefined) editable.priority = changes.priority;

	if (changes.fields?.length) {
		if (!Array.isArray(current.fields)) {
			throw new ConflictError("Indexer fields could not be verified before update");
		}
		const currentByName = new Map<string, Record<string, unknown>>();
		for (const value of current.fields) {
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				throw new ConflictError("Indexer fields could not be verified before update");
			}
			const field = value as Record<string, unknown>;
			const normalized = normalizeIndexerField(field);
			if (!normalized || currentByName.has(normalized.name)) {
				throw new ConflictError("Indexer field identity is ambiguous");
			}
			currentByName.set(normalized.name, field);
		}
		const changedByName = new Map<
			string,
			NonNullable<SearchIndexerUpdateChanges["fields"]>[number]
		>();
		for (const field of changes.fields) {
			if (changedByName.has(field.name)) {
				throw new AppValidationError("Duplicate indexer field change");
			}
			const original = currentByName.get(field.name);
			const normalized = original ? normalizeIndexerField(original) : null;
			if (!normalized) throw new AppValidationError("Unknown indexer field change");
			const nonEditableType = ["info", "password", "hidden"].includes(
				(normalized.type ?? "").toLowerCase(),
			);
			const nonEditableName = ["baseurl", "basesettings", "definitionfile"].includes(
				normalized.name.toLowerCase(),
			);
			if (nonEditableType || nonEditableName || isSensitiveProwlarrField(normalized)) {
				throw new AppValidationError("Indexer field is not editable");
			}
			changedByName.set(field.name, field);
		}
		editable.fields = current.fields.map((value) => {
			const original = value as Record<string, unknown>;
			const changed = changedByName.get(String(original.name));
			return changed ? { ...original, value: changed.value } : original;
		});
	}

	try {
		return await client.indexer.update(indexerId, update);
	} catch (error) {
		if (
			error instanceof ArrError &&
			error.statusCode >= 400 &&
			error.statusCode < 500 &&
			error.statusCode !== 408 &&
			error.statusCode !== 429
		) {
			throw new IndexerUpdateRejectedError(error.statusCode);
		}
		// A lost response cannot establish whether Prowlarr applied the single PUT.
		throw new IndexerUpdateDispatchError(error);
	}
};

/**
 * Tests a Prowlarr indexer configuration using the SDK.
 */
export const testProwlarrIndexerWithSdk = async (
	client: ProwlarrClient,
	indexerId: number,
): Promise<void> => {
	// First fetch the indexer definition
	const indexer = await client.indexer.getById(indexerId);
	// Then test with the full definition
	await client.indexer.test({ ...indexer, id: indexerId });
};

/**
 * Performs a manual search query in Prowlarr using the SDK.
 */
export const performProwlarrSearchWithSdk = async (
	client: ProwlarrClient,
	instance: ServiceInstance,
	options: ManualSearchOptions,
): Promise<{ results: SearchResult[]; coverage: SearchCoverage }> => {
	const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 200)) : 100;

	// Map search type to SDK format (SDK uses "tvsearch" instead of "tv")
	const mapSearchType = (
		type: ManualSearchOptions["type"],
	): "search" | "tvsearch" | "movie" | "music" | "book" | undefined => {
		if (!type || type === "all") return undefined;
		if (type === "tv") return "tvsearch";
		return type as "movie" | "music" | "book";
	};

	const rawReleases = await client.search.query({
		query: options.query.trim() || undefined,
		type: mapSearchType(options.type),
		limit,
		indexerIds: options.indexerIds,
		categories: options.categories,
	});

	const results: SearchResult[] = [];

	for (const record of rawReleases) {
		const normalized = normalizeSearchResult(record as Record<string, unknown>, instance);

		if (normalized) {
			results.push(normalized);
		}
	}

	return {
		results,
		coverage: {
			receivedCount: rawReleases.length,
			acceptedCount: results.length,
			rejectedCount: rawReleases.length - results.length,
			metadataIncompleteCount: results.filter((result) => result.metadataIncomplete === true)
				.length,
		},
	};
};

/** Dispatch only the minimal tuple already authorized by the durable submission service. */
export const grabVerifiedProwlarrTargetWithSdk = async (
	client: ProwlarrClient,
	target: Pick<SearchGrabTarget, "guid" | "indexerId">,
): Promise<void> => {
	const { guid, indexerId } = searchGrabTargetSchema
		.pick({ guid: true, indexerId: true })
		.parse(target);

	const unknownOutcome =
		"Grab outcome is unknown. Check Prowlarr and the download client before retrying.";
	let acknowledgement: unknown;
	try {
		acknowledgement = await client.search.grab({ guid, indexerId });
	} catch (error) {
		if (
			error instanceof ArrError &&
			error.statusCode >= 400 &&
			error.statusCode < 500 &&
			error.statusCode !== 408 &&
			error.statusCode !== 429
		) {
			throw error;
		}
		// A failed transport or response parser cannot prove the single POST failed.
		throw new ArrError(unknownOutcome, 502);
	}
	if (
		!acknowledgement ||
		typeof acknowledgement !== "object" ||
		Array.isArray(acknowledgement) ||
		!("guid" in acknowledgement) ||
		acknowledgement.guid !== guid ||
		!("indexerId" in acknowledgement) ||
		acknowledgement.indexerId !== indexerId
	) {
		// The dispatch may have succeeded: an invalid reply is not safe retry authority.
		throw new ArrError(unknownOutcome, 502);
	}
};
