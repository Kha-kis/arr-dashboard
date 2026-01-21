import type {
	ProwlarrIndexer,
	ProwlarrIndexerDetails,
	SearchGrabRequest,
	SearchRequest,
	SearchResult,
} from "@arr/shared";
import { prowlarrIndexerDetailsSchema } from "@arr/shared";
import type { ServiceInstance } from "../../lib/prisma.js";
import type { ProwlarrClient } from "arr-sdk/prowlarr";
import { normalizeIndexer, normalizeIndexerDetails, normalizeSearchResult } from "./normalizers.js";

/**
 * Converts a value to a string if possible, otherwise returns undefined.
 */
const toStringValue = (value: unknown): string | undefined => {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}

	if (typeof value === "number" && Number.isFinite(value)) {
		return value.toString();
	}

	return undefined;
};

/**
 * Converts a value to a number if possible, otherwise returns undefined.
 */
const toNumber = (value: unknown): number | undefined => {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === "string") {
		const parsed = Number(value);

		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}

	return undefined;
};

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
	const rawIndexers = await client.indexer.getAll();

	const items: ProwlarrIndexer[] = [];

	for (const record of rawIndexers) {
		const normalized = normalizeIndexer(
			record as Record<string, unknown>,
			instance.id,
			instance.label,
			instance.baseUrl,
		);

		if (normalized) {
			items.push(normalized);
		}
	}

	return items;
};

/**
 * Fetches detailed indexer information from Prowlarr using the SDK.
 * Note: Per-indexer stats are not directly available in SDK, so we fetch global stats.
 */
export const fetchProwlarrIndexerDetailsWithSdk = async (
	client: ProwlarrClient,
	instance: ServiceInstance,
	indexerId: number,
): Promise<ProwlarrIndexerDetails | null> => {
	try {
		const [indexer, stats] = await Promise.all([
			client.indexer.getById(indexerId),
			client.indexerStats.get({ indexers: [indexerId] }).catch(() => null),
		]);

		// Find stats for this specific indexer if available
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
		console.warn(
			`[Prowlarr] Failed to fetch indexer details for ID ${indexerId} from ${instance.label}:`,
			error,
		);
		return null;
	}
};

/**
 * Updates an indexer configuration in Prowlarr using the SDK.
 */
export const updateProwlarrIndexerWithSdk = async (
	client: ProwlarrClient,
	indexerId: number,
	// biome-ignore lint/suspicious/noExplicitAny: SDK type compatibility
	indexerData: any,
): Promise<unknown> => {
	return client.indexer.update(indexerId, { ...indexerData, id: indexerId });
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
): Promise<SearchResult[]> => {
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

	return results;
};

/**
 * Grabs a release from Prowlarr using the SDK.
 */
export const grabProwlarrReleaseWithSdk = async (
	client: ProwlarrClient,
	release: SearchGrabRequest["result"],
): Promise<void> => {
	const releaseRecord = release as Record<string, unknown>;
	const guid = toStringValue(releaseRecord.guid) ?? toStringValue(releaseRecord.id);
	const indexerId = toNumber(releaseRecord.indexerId);

	if (typeof indexerId !== "number" || !guid) {
		throw new Error("Release is missing required identifier information");
	}

	await client.search.grab({ guid, indexerId });
};
