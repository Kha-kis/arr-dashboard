import type {
	JellyfinClient,
	JellyfinNativeInventoryPageResult,
	JellyfinNativeLibraryItem,
	JellyfinNativeEpisodeItem,
} from "./jellyfin-client.js";

/** One server-scoped native inventory GET. Never a caller-selected operation. */
export type JellyfinNativePageWorkerInput = Parameters<
	JellyfinClient["readNativeInventoryPage"]
>[0] & {
	baseUrl: string;
	apiKey: string;
	httpAuthHeaders?: Record<string, string>;
};
export type JellyfinNativePageWorkerRequest = JellyfinNativePageWorkerInput & {
	version: 1;
	httpAuthHeaders: Record<string, string>;
	requestTimeoutMs: number;
};
export type JellyfinNativePageWorkerResult =
	| JellyfinNativeInventoryPageResult
	| {
			status: "failed";
			category: "invalid-request" | "provider-unavailable";
	  };

// Validate descriptors, never getters, coercion, or provider error formatters.
function record(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null) return null;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return null;
	const keys = Reflect.ownKeys(value);
	if (required.some((key) => !keys.includes(key))) return null;
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))
			return null;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor)) return null;
		result[key] = descriptor.value;
	}
	return result;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
function nativeId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
function rows(value: unknown, limit: number): unknown[] | null {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
	const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (!integer(length, limit) || Reflect.ownKeys(value).length !== length + 1) return null;
	const result: unknown[] = [];
	for (let i = 0; i < length; i++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
		if (!descriptor || !("value" in descriptor)) return null;
		result.push(descriptor.value);
	}
	return result;
}

export function parseJellyfinNativePageWorkerRequest(
	value: unknown,
): JellyfinNativePageWorkerRequest | null {
	try {
		const input = record(
			value,
			[
				"version",
				"baseUrl",
				"apiKey",
				"httpAuthHeaders",
				"domain",
				"libraryId",
				"startIndex",
				"limit",
				"deadlineAt",
				"requestTimeoutMs",
			],
			["includeItemTypes"],
		);
		if (
			input?.version !== 1 ||
			typeof input.baseUrl !== "string" ||
			!nativeId(input.apiKey) ||
			(input.domain !== "library" && input.domain !== "episode") ||
			!nativeId(input.libraryId) ||
			input.libraryId.length > 1024 ||
			input.libraryId.includes("\0") ||
			!integer(input.startIndex, 100_000) ||
			!integer(input.limit, 2_000) ||
			input.limit < 1 ||
			typeof input.deadlineAt !== "number" ||
			!Number.isFinite(input.deadlineAt) ||
			!integer(input.requestTimeoutMs, 15_000) ||
			input.requestTimeoutMs < 1 ||
			(input.includeItemTypes !== undefined &&
				!["Movie", "Series", "Movie,Series"].includes(input.includeItemTypes as string))
		)
			return null;
		if (!["http:", "https:"].includes(new URL(input.baseUrl).protocol)) return null;
		const headerKeys =
			typeof input.httpAuthHeaders === "object" && input.httpAuthHeaders !== null
				? Reflect.ownKeys(input.httpAuthHeaders)
				: [];
		if (headerKeys.some((key) => typeof key !== "string")) return null;
		const headers = record(input.httpAuthHeaders, headerKeys as string[]);
		if (!headers || Object.values(headers).some((header) => typeof header !== "string"))
			return null;
		return { ...input, httpAuthHeaders: { ...headers } } as JellyfinNativePageWorkerRequest;
	} catch {
		return null;
	}
}

export function parseJellyfinNativePageWorkerResult(
	value: unknown,
	coordinates: Pick<JellyfinNativePageWorkerInput, "domain" | "startIndex" | "limit">,
): JellyfinNativePageWorkerResult | null {
	try {
		const envelope = record(
			value,
			["status"],
			["category", "reason", "domain", "startIndex", "totalRecordCount", "items"],
		);
		if (!envelope) return null;
		if (envelope.status === "failed") {
			if (
				!record(value, ["status", "category"]) ||
				(envelope.category !== "invalid-request" && envelope.category !== "provider-unavailable")
			)
				return null;
			return { status: "failed", category: envelope.category };
		}
		if (envelope.status === "unavailable") {
			if (
				!record(value, ["status", "reason"]) ||
				(envelope.reason !== "deadline-exceeded" &&
					envelope.reason !== "provider-unavailable" &&
					envelope.reason !== "coverage-incomplete")
			)
				return null;
			return { status: "unavailable", reason: envelope.reason };
		}
		if (
			envelope.status !== "page" ||
			!record(value, ["status", "domain", "startIndex", "totalRecordCount", "items"]) ||
			envelope.domain !== coordinates.domain ||
			!integer(envelope.startIndex, 100_000) ||
			envelope.startIndex !== coordinates.startIndex ||
			!integer(envelope.totalRecordCount, 100_000) ||
			envelope.startIndex > envelope.totalRecordCount ||
			!integer(coordinates.limit, 2_000) ||
			coordinates.limit < 1
		)
			return null;
		const raw = rows(envelope.items, coordinates.limit);
		if (
			!raw ||
			envelope.startIndex + raw.length > envelope.totalRecordCount ||
			(raw.length === 0 && envelope.startIndex < envelope.totalRecordCount)
		)
			return null;
		const ids = new Set<string>();
		const libraryItems: JellyfinNativeLibraryItem[] = [];
		const episodeItems: JellyfinNativeEpisodeItem[] = [];
		for (const entry of raw) {
			const row = record(
				entry,
				["id", "type", "name"],
				coordinates.domain === "library"
					? ["externalIds"]
					: ["seriesId", "seasonNumber", "episodeNumber"],
			);
			if (!row || !nativeId(row.id) || ids.has(row.id) || typeof row.name !== "string") return null;
			ids.add(row.id);
			if (coordinates.domain === "library") {
				if (row.type !== "Movie" && row.type !== "Series" && row.type !== "BoxSet") return null;
				let externalIds: JellyfinNativeLibraryItem["externalIds"];
				if ("externalIds" in row) {
					const external = record(row.externalIds, [], ["tmdb", "tvdb"]);
					if (!external) return null;
					const normalized: Record<string, number[]> = {};
					for (const key of Object.keys(external)) {
						const list = rows(external[key], 100_000);
						if (!list || list.length === 0 || list.some((id) => !integer(id) || id < 1))
							return null;
						normalized[key] = list as number[];
					}
					externalIds = normalized;
				}
				libraryItems.push({
					id: row.id,
					name: row.name,
					type: row.type,
					...(externalIds ? { externalIds } : {}),
				});
			} else {
				if (
					row.type !== "Episode" ||
					("seriesId" in row && !nativeId(row.seriesId)) ||
					("seasonNumber" in row && !integer(row.seasonNumber)) ||
					("episodeNumber" in row && !integer(row.episodeNumber))
				)
					return null;
				episodeItems.push({
					id: row.id,
					name: row.name,
					type: "Episode",
					...(typeof row.seriesId === "string" ? { seriesId: row.seriesId } : {}),
					...(typeof row.seasonNumber === "number" ? { seasonNumber: row.seasonNumber } : {}),
					...(typeof row.episodeNumber === "number" ? { episodeNumber: row.episodeNumber } : {}),
				});
			}
		}
		return coordinates.domain === "library"
			? {
					status: "page",
					domain: "library",
					startIndex: envelope.startIndex,
					totalRecordCount: envelope.totalRecordCount,
					items: libraryItems,
				}
			: {
					status: "page",
					domain: "episode",
					startIndex: envelope.startIndex,
					totalRecordCount: envelope.totalRecordCount,
					items: episodeItems,
				};
	} catch {
		return null;
	}
}
