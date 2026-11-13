import type {
	PlexClient,
	PlexNativeInventoryPageResult,
	PlexNativeLibraryItem,
	PlexNativeEpisodeItem,
} from "./plex-client.js";

/** Exactly one stored connection's read-only native page coordinates. */
export type PlexNativePageWorkerInput = Parameters<PlexClient["readNativeInventoryPage"]>[0] & {
	baseUrl: string;
	apiKey: string;
	httpAuthHeaders?: Record<string, string>;
};
export type PlexNativePageWorkerRequest = PlexNativePageWorkerInput & {
	version: 1;
	httpAuthHeaders: Record<string, string>;
	requestTimeoutMs: number;
};
export type PlexNativePageWorkerResult =
	| PlexNativeInventoryPageResult
	| {
			status: "failed";
			category: "invalid-request" | "provider-unavailable";
	  };

// Read descriptors only; never invoke getters or provider error formatters.
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
	return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
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

export function parsePlexNativePageWorkerRequest(
	value: unknown,
): PlexNativePageWorkerRequest | null {
	try {
		const input = record(value, [
			"version",
			"baseUrl",
			"apiKey",
			"httpAuthHeaders",
			"domain",
			"sectionId",
			"startIndex",
			"limit",
			"deadlineAt",
			"requestTimeoutMs",
		]);
		if (
			input?.version !== 1 ||
			typeof input.baseUrl !== "string" ||
			!nativeId(input.apiKey) ||
			(input.domain !== "library" && input.domain !== "episode") ||
			!nativeId(input.sectionId) ||
			input.sectionId.length > 1024 ||
			!integer(input.startIndex) ||
			!integer(input.limit, 500) ||
			input.limit < 1 ||
			typeof input.deadlineAt !== "number" ||
			!Number.isFinite(input.deadlineAt) ||
			!integer(input.requestTimeoutMs, 15_000) ||
			input.requestTimeoutMs < 1
		)
			return null;
		if (!["http:", "https:"].includes(new URL(input.baseUrl).protocol)) return null;
		const keys =
			typeof input.httpAuthHeaders === "object" && input.httpAuthHeaders !== null
				? Reflect.ownKeys(input.httpAuthHeaders)
				: [];
		if (keys.some((key) => typeof key !== "string")) return null;
		const headers = record(input.httpAuthHeaders, keys as string[]);
		if (!headers || Object.values(headers).some((header) => typeof header !== "string"))
			return null;
		return { ...input, httpAuthHeaders: { ...headers } } as PlexNativePageWorkerRequest;
	} catch {
		return null;
	}
}

export function parsePlexNativePageWorkerResult(
	value: unknown,
	coordinates: Pick<PlexNativePageWorkerInput, "domain" | "startIndex" | "limit">,
): PlexNativePageWorkerResult | null {
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
			(envelope.domain !== "library" && envelope.domain !== "episode") ||
			envelope.domain !== coordinates.domain ||
			!integer(envelope.startIndex) ||
			envelope.startIndex !== coordinates.startIndex ||
			!integer(envelope.totalRecordCount, 100_000) ||
			envelope.startIndex > envelope.totalRecordCount ||
			!integer(coordinates.limit, 500) ||
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
		const libraryItems: PlexNativeLibraryItem[] = [];
		const episodeItems: PlexNativeEpisodeItem[] = [];
		for (const entry of raw) {
			const row =
				coordinates.domain === "library"
					? record(entry, ["ratingKey", "type", "title"], ["externalIds"])
					: record(entry, [
							"ratingKey",
							"type",
							"title",
							"grandparentRatingKey",
							"seasonNumber",
							"episodeNumber",
						]);
			if (
				!row ||
				!nativeId(row.ratingKey) ||
				ids.has(row.ratingKey) ||
				typeof row.title !== "string"
			)
				return null;
			ids.add(row.ratingKey);
			if (coordinates.domain === "library") {
				if (row.type !== "movie" && row.type !== "show" && row.type !== "collection") return null;
				let externalIds: PlexNativeLibraryItem["externalIds"];
				if ("externalIds" in row) {
					const external = record(row.externalIds, [], ["tmdb", "tvdb"]);
					if (!external) return null;
					const normalized: Record<string, number[]> = {};
					for (const key of Object.keys(external)) {
						const list = rows(external[key], 100_000);
						if (
							!list ||
							list.length === 0 ||
							list.some(
								(id, index) =>
									!integer(id) || id < 1 || (index > 0 && (list[index - 1] as number) >= id),
							)
						)
							return null;
						normalized[key] = list as number[];
					}
					externalIds = normalized;
				}
				libraryItems.push({
					ratingKey: row.ratingKey,
					type: row.type,
					title: row.title,
					...(externalIds ? { externalIds } : {}),
				});
			} else {
				if (
					row.type !== "episode" ||
					(row.grandparentRatingKey !== null && !nativeId(row.grandparentRatingKey)) ||
					(row.seasonNumber !== null && !integer(row.seasonNumber)) ||
					(row.episodeNumber !== null && !integer(row.episodeNumber))
				)
					return null;
				episodeItems.push({
					ratingKey: row.ratingKey,
					type: "episode",
					title: row.title,
					grandparentRatingKey: row.grandparentRatingKey as string | null,
					seasonNumber: row.seasonNumber as number | null,
					episodeNumber: row.episodeNumber as number | null,
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
