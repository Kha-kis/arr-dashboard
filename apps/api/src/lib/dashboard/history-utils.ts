import { createHash } from "node:crypto";
import { type HistoryItem, historyItemSchema } from "@arr/shared";
import { z } from "zod";
import { toNumber, toStringValue } from "../data/values.js";

/** Service types that support history functionality */
export type HistoryService = "sonarr" | "radarr" | "prowlarr" | "lidarr" | "readarr";

export type HistorySortDirection = "ascending" | "descending";

/** The complete upstream-record allowance for one HTTP request, across every provider. */
export const MAX_HISTORY_REQUEST_RECORDS = 10_000;

/** Maximum enabled providers that one request may seed concurrently. */
export const MAX_HISTORY_PROVIDERS = 200;

/** Fixed provider-call cap: one seed per supported provider plus one progress reserve. */
export const MAX_HISTORY_UPSTREAM_REQUESTS = MAX_HISTORY_PROVIDERS + 1;

/** Normal provider page size; response page size must not amplify upstream call count. */
export const HISTORY_UPSTREAM_SCAN_WINDOW = 100;

export interface HistoryPageOptions {
	pageSize: number;
	sortDirection: HistorySortDirection;
	startDate?: string;
	endDate?: string;
	service?: HistoryService;
	instanceId?: string;
	status?: string;
	searchTerm?: string;
	hideProwlarrRss?: boolean;
}

export interface HistoryProviderPageResponse {
	records?: unknown[] | null;
	totalRecords?: number;
}

export interface HistoryProviderStream {
	instanceId: string;
	instanceName: string;
	service: HistoryService;
	fetchPage: (request: { page: number; pageSize: number }) => Promise<HistoryProviderPageResponse>;
	normalize: (record: unknown) => HistoryItem;
}

export interface HistoryProviderCursor {
	page: number;
	offset: number;
	windowSize: number;
	fingerprint: string | null;
	totalRecords: number | null;
	matchedRecords: number;
	rejectedRecords: number;
	exhausted: boolean;
	partial: boolean;
	blocked: boolean;
	pageIsFinal: boolean;
	error: boolean;
}

export interface HistoryCursor {
	version: 1;
	providers: Record<string, HistoryProviderCursor>;
}

const historyProviderCursorSchema = z.object({
	page: z.number().int().positive(),
	offset: z.number().int().nonnegative(),
	windowSize: z.number().int().positive(),
	fingerprint: z.string().nullable(),
	totalRecords: z.number().int().nonnegative().nullable(),
	matchedRecords: z.number().int().nonnegative(),
	rejectedRecords: z.number().int().nonnegative(),
	exhausted: z.boolean(),
	partial: z.boolean(),
	blocked: z.boolean(),
	pageIsFinal: z.boolean(),
	error: z.boolean(),
});

export const historyCursorSchema: z.ZodType<HistoryCursor> = z.object({
	version: z.literal(1),
	providers: z.record(z.string(), historyProviderCursorSchema),
});

export interface HistoryProviderSummary {
	instanceId: string;
	instanceName: string;
	service: HistoryService;
	data: [];
	status: "ok" | "partial" | "error";
	totalRecords: number | null;
	totalRecordsExact: boolean;
	rejectedRecords: number;
	error?: string;
}

export interface PaginatedHistoryStreams {
	providers: HistoryProviderSummary[];
	items: HistoryItem[];
	totalCount: number | null;
	incomplete: boolean;
	nextCursor: HistoryCursor | null;
	budgetUsed: number;
}

export class HistoryCursorStaleError extends Error {
	constructor(message = "History cursor is stale") {
		super(message);
		this.name = "HistoryCursorStaleError";
	}
}

export class HistoryProviderLimitError extends Error {
	constructor(message = "Too many History providers for one request") {
		super(message);
		this.name = "HistoryProviderLimitError";
	}
}

class HistoryRequestBudget {
	used = 0;
	requests = 0;
	private readonly maxRequests: number;

	constructor(maxRequests = MAX_HISTORY_UPSTREAM_REQUESTS) {
		this.maxRequests = maxRequests;
	}

	canClaim(requested: number): boolean {
		return this.requests < this.maxRequests && MAX_HISTORY_REQUEST_RECORDS - this.used >= requested;
	}

	claim(requested: number): number {
		if (!this.canClaim(requested)) return 0;
		this.used += requested;
		this.requests += 1;
		return requested;
	}
}

interface BufferedHistoryItem {
	item: HistoryItem;
	rawIndex: number;
	ordinal: number;
}

interface HistoryProviderRuntime {
	stream: HistoryProviderStream;
	state: HistoryProviderCursor;
	buffer: BufferedHistoryItem[];
	loadedPage: number | null;
	pageLength: number;
	budgetBlocked: boolean;
}

const cursorKey = (stream: HistoryProviderStream): string =>
	`${stream.service}:${stream.instanceId}`;

const fingerprintRecords = (records: unknown[]): string =>
	createHash("sha256").update(JSON.stringify(records)).digest("base64url");

const normalizedFilterValue = (value?: string): string | undefined => {
	const normalized = value?.trim().toLowerCase();
	return normalized && normalized !== "all" ? normalized : undefined;
};

const historyItemMatches = (item: HistoryItem, options: HistoryPageOptions): boolean => {
	if (options.startDate || options.endDate) {
		const itemDate = item.date ? Date.parse(item.date) : Number.NaN;
		if (!Number.isFinite(itemDate)) return false;
		if (options.startDate) {
			const start = Date.parse(
				/^\d{4}-\d{2}-\d{2}$/.test(options.startDate)
					? `${options.startDate}T00:00:00.000Z`
					: options.startDate,
			);
			if (Number.isFinite(start) && itemDate < start) return false;
		}
		if (options.endDate) {
			const end = Date.parse(
				/^\d{4}-\d{2}-\d{2}$/.test(options.endDate)
					? `${options.endDate}T23:59:59.999Z`
					: options.endDate,
			);
			if (Number.isFinite(end) && itemDate > end) return false;
		}
	}
	if (options.service && item.service !== options.service) return false;
	if (options.instanceId && item.instanceId !== options.instanceId) return false;

	const status = normalizedFilterValue(options.status);
	if (status) {
		const itemStatus = (item.status ?? item.eventType ?? "unknown").toLowerCase();
		if (itemStatus !== status) return false;
	}

	if (
		options.hideProwlarrRss &&
		item.service === "prowlarr" &&
		(item.eventType ?? "").toLowerCase().includes("rss")
	) {
		return false;
	}

	const searchTerm = options.searchTerm?.trim().toLowerCase();
	if (searchTerm) {
		const haystack = [item.title, item.sourceTitle, item.downloadClient, item.indexer, item.reason]
			.filter((value): value is string => Boolean(value))
			.map((value) => value.toLowerCase());
		if (!haystack.some((value) => value.includes(searchTerm))) return false;
	}

	return true;
};

const compareBufferedHistory = (
	left: BufferedHistoryItem,
	right: BufferedHistoryItem,
	direction: HistorySortDirection,
): number => {
	const leftDate = left.item.date ? Date.parse(left.item.date) : 0;
	const rightDate = right.item.date ? Date.parse(right.item.date) : 0;
	const safeLeftDate = Number.isFinite(leftDate) ? leftDate : 0;
	const safeRightDate = Number.isFinite(rightDate) ? rightDate : 0;
	if (safeLeftDate !== safeRightDate) {
		return direction === "descending" ? safeRightDate - safeLeftDate : safeLeftDate - safeRightDate;
	}
	if (left.item.instanceId !== right.item.instanceId) {
		return left.item.instanceId < right.item.instanceId ? -1 : 1;
	}
	if (left.item.service !== right.item.service) {
		return left.item.service < right.item.service ? -1 : 1;
	}
	return left.ordinal - right.ordinal;
};

const cloneCursorState = (state: HistoryProviderCursor): HistoryProviderCursor => ({ ...state });

const createInitialCursor = (windowSize: number): HistoryProviderCursor => ({
	page: 1,
	offset: 0,
	windowSize,
	fingerprint: null,
	totalRecords: null,
	matchedRecords: 0,
	rejectedRecords: 0,
	exhausted: false,
	partial: false,
	blocked: false,
	pageIsFinal: false,
	error: false,
});

const parseProviderTotal = (
	value: number | undefined,
): { value: number | null; invalid: boolean } => {
	if (value === undefined) return { value: null, invalid: false };
	if (!Number.isSafeInteger(value) || value < 0) return { value: null, invalid: true };
	return { value, invalid: false };
};

const loadProviderPage = async (
	runtime: HistoryProviderRuntime,
	budget: HistoryRequestBudget,
	options: HistoryPageOptions,
): Promise<void> => {
	if (
		runtime.loadedPage === runtime.state.page ||
		runtime.state.exhausted ||
		runtime.state.blocked
	) {
		return;
	}

	const requested = budget.claim(runtime.state.windowSize);
	if (requested <= 0) {
		runtime.budgetBlocked = true;
		return;
	}

	let result: HistoryProviderPageResponse;
	try {
		result = await runtime.stream.fetchPage({ page: runtime.state.page, pageSize: requested });
	} catch {
		runtime.state.partial = true;
		runtime.state.blocked = true;
		runtime.state.error = true;
		runtime.loadedPage = runtime.state.page;
		runtime.pageLength = 0;
		return;
	}
	if (!Array.isArray(result.records)) {
		runtime.state.partial = true;
		runtime.state.blocked = true;
		runtime.loadedPage = runtime.state.page;
		runtime.pageLength = 0;
		return;
	}

	const providerReturnedTooMany = result.records.length > requested;
	const records = result.records.slice(0, requested);
	const fingerprint = fingerprintRecords(records);
	if (runtime.state.fingerprint !== null && runtime.state.fingerprint !== fingerprint) {
		throw new HistoryCursorStaleError(`History window changed for ${runtime.stream.instanceId}`);
	}
	if (runtime.state.offset > records.length) {
		throw new HistoryCursorStaleError(
			`History cursor offset is no longer valid for ${runtime.stream.instanceId}`,
		);
	}

	runtime.state.fingerprint = fingerprint;
	runtime.loadedPage = runtime.state.page;
	runtime.pageLength = records.length;
	runtime.buffer = [];

	const parsedTotal = parseProviderTotal(result.totalRecords);
	if (parsedTotal.invalid || providerReturnedTooMany) {
		runtime.state.partial = true;
		runtime.state.blocked = true;
	}
	if (parsedTotal.value !== null) {
		if (runtime.state.totalRecords !== null && runtime.state.totalRecords !== parsedTotal.value) {
			throw new HistoryCursorStaleError(`History total changed for ${runtime.stream.instanceId}`);
		}
		runtime.state.totalRecords = parsedTotal.value;
	}

	const rawStart = (runtime.state.page - 1) * runtime.state.windowSize;
	const rawEnd = rawStart + records.length;
	if (runtime.state.totalRecords !== null) {
		if (rawEnd >= runtime.state.totalRecords) {
			runtime.state.pageIsFinal = true;
		} else if (records.length < requested) {
			runtime.state.partial = true;
			runtime.state.blocked = true;
		}
	} else if (records.length < requested) {
		// A short page without an authoritative total cannot prove exhaustion.
		runtime.state.partial = true;
		runtime.state.blocked = true;
	}

	for (let rawIndex = runtime.state.offset; rawIndex < records.length; rawIndex += 1) {
		let candidate: HistoryItem;
		try {
			candidate = runtime.stream.normalize(records[rawIndex]);
		} catch {
			runtime.state.rejectedRecords += 1;
			runtime.state.partial = true;
			continue;
		}
		const parsed = historyItemSchema.safeParse(candidate);
		if (!parsed.success) {
			runtime.state.rejectedRecords += 1;
			runtime.state.partial = true;
			continue;
		}
		if (!parsed.data.date || !Number.isFinite(Date.parse(parsed.data.date))) {
			runtime.state.rejectedRecords += 1;
			runtime.state.partial = true;
			continue;
		}
		if (!historyItemMatches(parsed.data, options)) continue;
		runtime.buffer.push({
			item: parsed.data,
			rawIndex,
			ordinal: rawStart + rawIndex,
		});
	}

	runtime.state.offset = runtime.buffer[0]?.rawIndex ?? records.length;
	if (runtime.state.pageIsFinal && runtime.buffer.length === 0) {
		runtime.state.exhausted = true;
	}
};

const ensureProviderHead = async (
	runtime: HistoryProviderRuntime,
	budget: HistoryRequestBudget,
	options: HistoryPageOptions,
): Promise<boolean> => {
	while (runtime.buffer.length === 0 && !runtime.state.exhausted && !runtime.state.blocked) {
		await loadProviderPage(runtime, budget, options);
		if (runtime.buffer.length > 0 || runtime.state.blocked || runtime.budgetBlocked) break;
		if (runtime.state.offset >= runtime.pageLength) {
			if (!budget.canClaim(runtime.state.windowSize)) {
				runtime.budgetBlocked = true;
				break;
			}
			runtime.state.page += 1;
			runtime.state.offset = 0;
			runtime.state.fingerprint = null;
			runtime.loadedPage = null;
			runtime.pageLength = 0;
		}
	}
	return runtime.buffer.length > 0;
};

const consumeProviderHead = (runtime: HistoryProviderRuntime): BufferedHistoryItem => {
	const next = runtime.buffer.shift();
	if (!next) throw new Error("History provider head is unavailable");
	runtime.state.matchedRecords += 1;
	runtime.state.offset = runtime.buffer[0]?.rawIndex ?? runtime.pageLength;
	if (runtime.state.pageIsFinal && runtime.buffer.length === 0) {
		runtime.state.exhausted = true;
	}
	return next;
};

/**
 * Build one cursor page with a deterministic k-way merge. Every provider page
 * claim is charged to the same request budget before the upstream call starts.
 */
export const paginateHistoryStreams = async ({
	streams,
	options,
	cursor,
}: {
	streams: HistoryProviderStream[];
	options: HistoryPageOptions;
	cursor?: HistoryCursor | null;
}): Promise<PaginatedHistoryStreams> => {
	if (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100) {
		throw new Error("History page size must be an integer between 1 and 100");
	}

	const orderedStreams = [...streams].sort((left, right) => {
		const leftKey = cursorKey(left);
		const rightKey = cursorKey(right);
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});
	if (orderedStreams.length > MAX_HISTORY_PROVIDERS) {
		throw new HistoryProviderLimitError();
	}

	const streamKeys = orderedStreams.map(cursorKey);
	if (cursor) {
		if (cursor.version !== 1) throw new HistoryCursorStaleError("Unsupported History cursor");
		const cursorKeys = Object.keys(cursor.providers).sort();
		if (
			cursorKeys.length !== streamKeys.length ||
			cursorKeys.some((key, index) => key !== streamKeys[index])
		) {
			throw new HistoryCursorStaleError("History provider set changed");
		}
	}

	const defaultWindowSize = Math.max(
		1,
		Math.min(
			HISTORY_UPSTREAM_SCAN_WINDOW,
			Math.floor(MAX_HISTORY_REQUEST_RECORDS / Math.max(1, orderedStreams.length + 1)),
		),
	);
	const runtimes: HistoryProviderRuntime[] = orderedStreams.map((providerStream) => {
		const key = cursorKey(providerStream);
		const cursorState = cursor?.providers[key];
		return {
			stream: providerStream,
			state: cursorState ? cloneCursorState(cursorState) : createInitialCursor(defaultWindowSize),
			buffer: [],
			loadedPage: null,
			pageLength: 0,
			budgetBlocked: false,
		};
	});
	const budget = new HistoryRequestBudget();

	// Seed every provider before selecting a global head. Claims are synchronous,
	// so concurrent network completion cannot overrun the shared allowance.
	await Promise.all(runtimes.map((runtime) => ensureProviderHead(runtime, budget, options)));

	const items: HistoryItem[] = [];
	while (items.length < options.pageSize) {
		const unknownProvider = runtimes.find(
			(runtime) =>
				runtime.buffer.length === 0 &&
				!runtime.state.exhausted &&
				(runtime.state.blocked || runtime.budgetBlocked),
		);
		if (unknownProvider) break;

		const candidates = runtimes
			.map((runtime) => ({ runtime, head: runtime.buffer[0] }))
			.filter(
				(entry): entry is { runtime: HistoryProviderRuntime; head: BufferedHistoryItem } =>
					entry.head !== undefined,
			)
			.sort((left, right) => compareBufferedHistory(left.head, right.head, options.sortDirection));
		const selectedCandidate = candidates[0];
		if (!selectedCandidate) break;

		const selected = selectedCandidate.runtime;
		items.push(consumeProviderHead(selected).item);
		if (selected.buffer.length === 0 && !selected.state.exhausted && !selected.state.blocked) {
			await ensureProviderHead(selected, budget, options);
		}
	}

	let hasMore = runtimes.some((runtime) => runtime.buffer.length > 0);
	if (!hasMore && items.length === options.pageSize) {
		for (const runtime of runtimes) {
			if (await ensureProviderHead(runtime, budget, options)) {
				hasMore = true;
				break;
			}
		}
	}
	const blockedByPartial = runtimes.some(
		(runtime) => runtime.state.blocked && runtime.buffer.length === 0 && !runtime.state.exhausted,
	);
	const budgetContinuation = runtimes.some(
		(runtime) => runtime.budgetBlocked && !runtime.state.exhausted && !runtime.state.blocked,
	);
	const allExhausted = runtimes.every(
		(runtime) => runtime.state.exhausted && runtime.buffer.length === 0,
	);
	const incomplete = runtimes.some((runtime) => runtime.state.partial || runtime.budgetBlocked);
	const totalCount =
		allExhausted && !incomplete
			? runtimes.reduce((total, runtime) => total + runtime.state.matchedRecords, 0)
			: null;
	const canContinue = !blockedByPartial && (hasMore || budgetContinuation || !allExhausted);
	const nextCursor: HistoryCursor | null = canContinue
		? {
				version: 1,
				providers: Object.fromEntries(
					runtimes.map((runtime) => [cursorKey(runtime.stream), cloneCursorState(runtime.state)]),
				),
			}
		: null;

	return {
		providers: runtimes.map((runtime) => ({
			instanceId: runtime.stream.instanceId,
			instanceName: runtime.stream.instanceName,
			service: runtime.stream.service,
			data: [],
			status: runtime.state.error ? "error" : runtime.state.partial ? "partial" : "ok",
			totalRecords: runtime.state.totalRecords,
			totalRecordsExact: runtime.state.totalRecords !== null && !runtime.state.partial,
			rejectedRecords: runtime.state.rejectedRecords,
			...(runtime.state.error ? { error: "Provider unavailable" } : {}),
		})),
		items,
		totalCount,
		incomplete,
		nextCursor,
		budgetUsed: budget.used,
	};
};

/**
 * Type alias for dynamic API responses. Uses `any` to allow flexible property access
 * while safety is enforced through helper functions (toStringValue, toNumber, etc.)
 */
// biome-ignore lint/suspicious/noExplicitAny: Runtime safety enforced via helper functions
type UnknownRecord = Record<string, any>;

/**
 * Normalizes a raw history item from the ARR API into a consistent format
 * Supports Sonarr (episodes), Radarr (movies), Prowlarr (indexer), Lidarr (albums/tracks), and Readarr (books)
 */
export const normalizeHistoryItem = (item: unknown, service: HistoryService): HistoryItem => {
	const anyItem = item as UnknownRecord;
	const rawId =
		anyItem.id ??
		anyItem.eventId ??
		anyItem.downloadId ??
		anyItem.sourceId ??
		anyItem.historyId ??
		anyItem.guid;
	if (typeof rawId !== "number" && typeof rawId !== "string") {
		throw new Error("History record is missing a stable identifier");
	}
	const normalizedId = rawId;

	const downloadId =
		toStringValue(anyItem.downloadId) ??
		toStringValue(anyItem.sourceId) ??
		toStringValue(anyItem.eventId) ??
		toStringValue(anyItem.guid) ??
		(typeof normalizedId === "number" || typeof normalizedId === "string"
			? String(normalizedId)
			: undefined);

	// For Prowlarr, extract more info from data field
	const isProwlarr = service === "prowlarr";
	const dataObj = typeof anyItem.data === "object" ? anyItem.data : {};

	// Prowlarr specific: extract query, release title, or other useful info
	// Try multiple possible field names from Prowlarr's response
	const prowlarrTitle = isProwlarr
		? (toStringValue(anyItem.sourceTitle) ??
			toStringValue(dataObj.releaseTitle) ??
			toStringValue(dataObj.title) ??
			toStringValue(dataObj.query) ??
			toStringValue(dataObj.searchTerm) ??
			toStringValue(dataObj.searchString) ??
			toStringValue(anyItem.title))
		: undefined;

	const prowlarrSource = isProwlarr
		? (toStringValue(dataObj.indexer) ??
			toStringValue(dataObj.indexerName) ??
			toStringValue(dataObj.host))
		: undefined;

	// Extract title based on service type
	const extractedTitle =
		prowlarrTitle ??
		toStringValue(anyItem.title) ??
		toStringValue(anyItem.sourceTitle) ??
		toStringValue(anyItem.series?.title) ??
		toStringValue(anyItem.movie?.title) ??
		toStringValue(anyItem.artist?.artistName) ??
		toStringValue(anyItem.album?.title) ??
		toStringValue(anyItem.author?.authorName) ??
		toStringValue(anyItem.book?.title) ??
		"Untitled";

	return {
		id: normalizedId,
		downloadId,
		title: extractedTitle,
		size: toNumber(anyItem.size ?? dataObj.size),
		quality: anyItem.quality ?? dataObj.quality,
		status: toStringValue(anyItem.status ?? anyItem.eventType ?? anyItem.event),
		downloadClient: toStringValue(
			anyItem.downloadClient ?? dataObj.downloadClient ?? dataObj.downloadClientName,
		),
		indexer:
			prowlarrSource ?? toStringValue(anyItem.indexer ?? dataObj.indexer ?? dataObj.indexerName),
		protocol: toStringValue(anyItem.protocol ?? anyItem.downloadProtocol ?? dataObj.protocol),
		date: toStringValue(
			anyItem.date ??
				anyItem.eventDate ??
				anyItem.eventDateUtc ??
				anyItem.created ??
				anyItem.timestamp,
		),
		reason: toStringValue(
			anyItem.reason ?? dataObj.reason ?? anyItem.error ?? dataObj.message ?? dataObj.statusMessage,
		),
		eventType: toStringValue(anyItem.eventType ?? anyItem.event),
		sourceTitle: toStringValue(anyItem.sourceTitle ?? dataObj.source),
		// Sonarr fields
		seriesId: toNumber(anyItem.seriesId ?? anyItem.series?.id),
		seriesSlug: toStringValue(anyItem.series?.titleSlug ?? anyItem.seriesSlug),
		episodeId: toNumber(anyItem.episodeId ?? anyItem.episode?.id),
		// Radarr fields
		movieId: toNumber(anyItem.movieId ?? anyItem.movie?.id),
		movieSlug: toStringValue(anyItem.movie?.titleSlug ?? anyItem.movieSlug),
		// Lidarr fields
		artistId: toNumber(anyItem.artistId ?? anyItem.artist?.id),
		albumId: toNumber(anyItem.albumId ?? anyItem.album?.id),
		trackId: toNumber(anyItem.trackId ?? anyItem.track?.id),
		// Readarr fields
		authorId: toNumber(anyItem.authorId ?? anyItem.author?.id),
		bookId: toNumber(anyItem.bookId ?? anyItem.book?.id),
		data: typeof anyItem.data === "object" ? anyItem.data : undefined,
		customFormats: Array.isArray(anyItem.customFormats)
			? anyItem.customFormats
					.filter((cf: unknown) => cf && typeof cf === "object" && "id" in cf && "name" in cf)
					.map((cf: UnknownRecord) => ({ id: Number(cf.id), name: String(cf.name) }))
			: undefined,
		customFormatScore: toNumber(anyItem.customFormatScore),
		instanceId: "",
		instanceName: "",
		service,
	};
};
