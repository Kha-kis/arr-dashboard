import type { JellyfinEpisodeCollectedPage, JellyfinEpisodeItemsPage } from "./jellyfin-client.js";

/** Internal one-GET input. No caller-selected method, path, or operation. */
export type JellyfinEpisodePageWorkerInput = {
	baseUrl: string;
	apiKey: string;
	httpAuthHeaders?: Record<string, string>;
	userId: string;
	libraryId: string;
	startIndex: number;
	limit: number;
	/** Internal full-watch-only mode; absence retains the counted contract. */
	uncounted?: true;
};

export type JellyfinEpisodePageWorkerRequest = JellyfinEpisodePageWorkerInput & {
	version: 1;
	httpAuthHeaders: Record<string, string>;
	requestTimeoutMs: number;
};

export type JellyfinEpisodePageWorkerResult =
	| { status: "page"; page: JellyfinEpisodeCollectedPage }
	| { status: "failed"; category: "provider-unavailable" | "invalid-request" };

// Read data descriptors only: even synthetic/unexpected messages cannot make
// validation invoke a getter, toJSON, coercion, or untrusted error formatter.
function record(value: unknown, keys?: readonly string[]): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null) return null;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return null;
	const own = Reflect.ownKeys(value);
	if (keys && (own.length !== keys.length || keys.some((key) => !own.includes(key)))) return null;
	const result: Record<string, unknown> = Object.create(null);
	for (const key of own) {
		if (typeof key !== "string") return null;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor)) return null;
		result[key] = descriptor.value;
	}
	return result;
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

function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function nativeId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function parseJellyfinEpisodePageWorkerRequest(
	value: unknown,
): JellyfinEpisodePageWorkerRequest | null {
	try {
		const fields = record(value);
		const request = record(value, [
			"version",
			"baseUrl",
			"apiKey",
			"httpAuthHeaders",
			"userId",
			"libraryId",
			"startIndex",
			"limit",
			"requestTimeoutMs",
			...(fields && "uncounted" in fields ? ["uncounted"] : []),
		]);
		if (
			!request ||
			("uncounted" in request && request.uncounted !== true) ||
			request.version !== 1 ||
			typeof request.baseUrl !== "string" ||
			!nativeId(request.apiKey) ||
			!nativeId(request.userId) ||
			!nativeId(request.libraryId) ||
			!integer(request.startIndex, 100_000) ||
			!integer(request.limit, 2_000) ||
			request.limit < 1 ||
			!integer(request.requestTimeoutMs, 15_000) ||
			request.requestTimeoutMs < 1
		)
			return null;
		if (!["http:", "https:"].includes(new URL(request.baseUrl).protocol)) return null;
		const headers = record(request.httpAuthHeaders);
		if (!headers || Object.values(headers).some((header) => typeof header !== "string"))
			return null;
		return {
			version: 1,
			baseUrl: request.baseUrl,
			apiKey: request.apiKey,
			httpAuthHeaders: { ...headers } as Record<string, string>,
			userId: request.userId,
			libraryId: request.libraryId,
			startIndex: request.startIndex,
			limit: request.limit,
			requestTimeoutMs: request.requestTimeoutMs,
			...(request.uncounted === true ? { uncounted: true as const } : {}),
		};
	} catch {
		return null;
	}
}

export function parseJellyfinEpisodePageWorkerResult(
	value: unknown,
	coordinates: Pick<JellyfinEpisodePageWorkerInput, "startIndex" | "limit" | "uncounted">,
): JellyfinEpisodePageWorkerResult | null {
	try {
		const envelope = record(value);
		if (!envelope) return null;
		if (envelope.status === "failed") {
			if (
				!record(value, ["status", "category"]) ||
				(envelope.category !== "provider-unavailable" && envelope.category !== "invalid-request")
			)
				return null;
			return { status: "failed", category: envelope.category };
		}
		if (envelope.status !== "page" || !record(value, ["status", "page"])) return null;
		const uncounted = coordinates.uncounted === true;
		const page = record(envelope.page, [
			"startIndex",
			"totalRecordCount",
			"items",
			...(uncounted ? ["countMode"] : []),
		]);
		if (
			!page ||
			!integer(page.startIndex, 100_000) ||
			page.startIndex !== coordinates.startIndex ||
			(uncounted
				? page.totalRecordCount !== null || page.countMode !== "uncounted"
				: !integer(page.totalRecordCount, 100_000)) ||
			!integer(coordinates.limit, 2_000) ||
			coordinates.limit < 1
		)
			return null;
		const rawRows = rows(page.items, coordinates.limit);
		if (
			!rawRows ||
			page.startIndex + rawRows.length > 100_000 ||
			(!uncounted && page.startIndex + rawRows.length > (page.totalRecordCount as number))
		)
			return null;
		const items: JellyfinEpisodeItemsPage["items"] = [];
		const ids = new Set<string>();
		for (const rawRow of rawRows) {
			const row = record(rawRow);
			if (!row || !nativeId(row.id) || row.type !== "Episode" || ids.has(row.id)) return null;
			ids.add(row.id);
			if (row.excludedReason === "missing-episode-metadata") {
				if (!record(rawRow, ["id", "type", "excludedReason"])) return null;
				items.push({ id: row.id, type: "Episode", excludedReason: "missing-episode-metadata" });
				continue;
			}
			if (
				!record(rawRow, [
					"id",
					"name",
					"type",
					"seriesId",
					"episodeNumber",
					"seasonNumber",
					"played",
					"playCount",
					"lastPlayedDate",
				]) ||
				typeof row.name !== "string" ||
				!nativeId(row.seriesId) ||
				!integer(row.episodeNumber) ||
				!integer(row.seasonNumber) ||
				typeof row.played !== "boolean" ||
				(row.playCount !== null && !integer(row.playCount)) ||
				(row.lastPlayedDate !== null &&
					(typeof row.lastPlayedDate !== "string" ||
						!Number.isFinite(Date.parse(row.lastPlayedDate))))
			)
				return null;
			items.push({
				id: row.id,
				name: row.name,
				type: "Episode",
				seriesId: row.seriesId,
				episodeNumber: row.episodeNumber,
				seasonNumber: row.seasonNumber,
				played: row.played,
				playCount: row.playCount,
				lastPlayedDate: row.lastPlayedDate,
			});
		}
		return {
			status: "page",
			page: {
				startIndex: page.startIndex,
				items,
				...(uncounted
					? { totalRecordCount: null, countMode: "uncounted" as const }
					: { totalRecordCount: page.totalRecordCount as number }),
			},
		};
	} catch {
		return null;
	}
}
