import type {
	ProwlarrIndexer,
	ProwlarrIndexerDetails,
	SearchGrabRequest,
	SearchRequest,
	SearchResult,
} from "@arr/shared";
import { prowlarrIndexerDetailsSchema } from "@arr/shared";
import type { ServiceInstance } from "@prisma/client";
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
 * Fetches detailed indexer information from Prowlarr including stats.
 */
export const fetchProwlarrIndexerDetails = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	instance: ServiceInstance,
	indexerId: number,
): Promise<ProwlarrIndexerDetails | null> => {
	const [detailResponse, statsResponse] = await Promise.all([
		fetcher(`/api/v1/indexer/${indexerId}`),
		fetcher(`/api/v1/indexer/${indexerId}/stats`).catch(() => null),
	]);

	const detailPayload = await detailResponse.json().catch(() => null);
	const statsPayload = statsResponse ? await statsResponse.json().catch(() => null) : null;

	return normalizeIndexerDetails(detailPayload, statsPayload, instance, indexerId);
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
 * Fetches all indexers from a Prowlarr instance.
 */
export const fetchProwlarrIndexers = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,

	instance: ServiceInstance,
): Promise<ProwlarrIndexer[]> => {
	const response = await fetcher("/api/v1/indexer");

	const payload = await response.json().catch(() => []);

	const records = Array.isArray(payload)
		? payload
		: Array.isArray(payload?.indexers)
			? payload.indexers
			: [];

	const items: ProwlarrIndexer[] = [];

	for (const record of records) {
		const normalized = normalizeIndexer(record, instance.id, instance.label, instance.baseUrl);

		if (normalized) {
			items.push(normalized);
		}
	}

	return items;
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

/**
 * Performs a manual search query in Prowlarr and returns normalized results.
 */
export const performProwlarrSearch = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,

	instance: ServiceInstance,

	options: ManualSearchOptions,
): Promise<SearchResult[]> => {
	const params = new URLSearchParams();

	const trimmedQuery = options.query.trim();

	if (trimmedQuery.length > 0) {
		params.set("query", trimmedQuery);
	}

	if (options.type && options.type !== "all") {
		params.set("type", options.type);
	}

	const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 200)) : 100;

	params.set("limit", String(limit));

	if (Array.isArray(options.indexerIds) && options.indexerIds.length > 0) {
		for (const id of options.indexerIds) {
			if (typeof id === "number" && Number.isFinite(id) && id > 0) {
				params.append("indexerIds", String(id));
			}
		}
	}

	if (Array.isArray(options.categories) && options.categories.length > 0) {
		for (const category of options.categories) {
			if (typeof category === "number" && Number.isFinite(category) && category > 0) {
				params.append("categories", String(category));
			}
		}
	}

	const response = await fetcher(`/api/v1/search?${params.toString()}`);

	const payload = await response.json().catch(() => []);

	const records = Array.isArray(payload)
		? payload
		: Array.isArray(payload?.results)
			? payload.results
			: [];

	const results: SearchResult[] = [];

	for (const record of records) {
		const normalized = normalizeSearchResult(record as Record<string, unknown>, instance);

		if (normalized) {
			results.push(normalized);
		}
	}

	return results;
};

/**
 * Tests a Prowlarr indexer configuration.
 */
export const testProwlarrIndexer = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	indexerId: number,
): Promise<void> => {
	const definitionResponse = await fetcher(`/api/v1/indexer/${indexerId}`);
	const definition = await definitionResponse.json();

	await fetcher("/api/v1/indexer/test", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ...definition, id: indexerId }),
	});
};

/**
 * Grabs a release from Prowlarr and sends it to the appropriate download client.
 */
export const grabProwlarrRelease = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,

	release: SearchGrabRequest["result"],
): Promise<void> => {
	const releaseRecord = release as Record<string, unknown>;
	const guid = toStringValue(releaseRecord.guid) ?? toStringValue(releaseRecord.id);

	const indexerId = toNumber(releaseRecord.indexerId);

	if (typeof indexerId !== "number" || !guid) {
		throw new Error("Release is missing required identifier information");
	}

	const normalizedPayload: Record<string, unknown> = {
		...(release as Record<string, unknown>),

		guid,

		indexerId,
	};

	if (typeof normalizedPayload.id === "string") {
		normalizedPayload.id = undefined;
	}

	if (normalizedPayload.downloadClientId === null) {
		normalizedPayload.downloadClientId = undefined;
	}

	await fetcher("/api/v1/search", {
		method: "POST",

		headers: { "Content-Type": "application/json" },

		body: JSON.stringify(normalizedPayload),
	});
};
