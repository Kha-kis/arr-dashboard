import {
	HISTORY_CUSTOM_FORMAT_MAX_COUNT,
	HISTORY_DISPLAY_TEXT_MAX_LENGTH,
	HISTORY_IDENTIFIER_TEXT_MAX_LENGTH,
	HISTORY_NORMALIZED_JSON_MAX_BYTES,
	HISTORY_SEARCH_TEXT_MAX_LENGTH,
	type HistoryNormalizedPayloadV1,
	type HistoryService,
	historyNormalizedPayloadV1Schema,
	historyServiceSchema,
} from "@arr/shared";

export type { HistoryService } from "@arr/shared";

export interface NormalizedHistoryObservation {
	payload: HistoryNormalizedPayloadV1;
	normalizedPayload: string;
	searchText: string;
}

export type NormalizeHistoryObservationResult =
	| { ok: true; observation: NormalizedHistoryObservation }
	| { ok: false };

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const getRecord = (record: UnknownRecord, key: string): UnknownRecord | undefined => {
	const value = record[key];
	return isRecord(value) ? value : undefined;
};

const getString = (record: UnknownRecord, key: string): string | undefined => {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
};

const getNumber = (record: UnknownRecord, key: string): number | undefined => {
	const value = record[key];
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
};

const getFiniteNonnegativeNumber = (record: UnknownRecord, key: string): number | undefined => {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
};

const urlLikePattern = /(?:\b[a-z][a-z\d+.-]*:\/\/|\bwww\.|\b(?:data|mailto|magnet):)/iu;

const normalizeText = (
	value: unknown,
	maxLength: number,
	truncate: boolean,
): string | undefined => {
	if (typeof value !== "string") return undefined;
	if (
		[...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
	) {
		return undefined;
	}
	const trimmed = value.trim();
	if (!trimmed || urlLikePattern.test(trimmed)) return undefined;
	if (trimmed.length > maxLength) return truncate ? trimmed.slice(0, maxLength) : undefined;
	return trimmed;
};

const normalizeDisplay = (value: unknown): string | undefined =>
	normalizeText(value, HISTORY_DISPLAY_TEXT_MAX_LENGTH, true);
const normalizeIdentifier = (value: unknown): string | undefined =>
	normalizeText(value, HISTORY_IDENTIFIER_TEXT_MAX_LENGTH, false);

const getDisplay = (record: UnknownRecord, ...keys: string[]): string | undefined => {
	for (const key of keys) {
		const value = normalizeDisplay(record[key]);
		if (value) return value;
	}
	return undefined;
};

const getNestedDisplay = (
	record: UnknownRecord | undefined,
	...keys: string[]
): string | undefined => (record ? getDisplay(record, ...keys) : undefined);

const getNestedNumber = (
	record: UnknownRecord | undefined,
	...keys: string[]
): number | undefined => {
	if (!record) return undefined;
	for (const key of keys) {
		const value = getNumber(record, key);
		if (value !== undefined) return value;
	}
	return undefined;
};

const getQualityName = (record: UnknownRecord): string | undefined => {
	const quality = getRecord(record, "quality");
	if (!quality) return normalizeDisplay(record.qualityName);
	const nestedQuality = getRecord(quality, "quality");
	return (
		getNestedDisplay(quality, "name") ??
		getNestedDisplay(nestedQuality, "name") ??
		normalizeDisplay(record.qualityName)
	);
};

const getProwlarrData = (record: UnknownRecord): UnknownRecord | undefined =>
	getRecord(record, "data");

const buildCustomFormats = (
	record: UnknownRecord,
): Array<{ id: number; name: string }> | undefined => {
	const rawFormats = record.customFormats;
	if (!Array.isArray(rawFormats)) return undefined;

	const unique = new Map<string, { id: number; name: string }>();
	for (const format of rawFormats.slice(0, HISTORY_CUSTOM_FORMAT_MAX_COUNT)) {
		if (!isRecord(format)) continue;
		const id = getNumber(format, "id");
		const name = normalizeDisplay(format.name);
		if (id === undefined || name === undefined) continue;
		unique.set(`${id}\u0000${name}`, { id, name });
	}

	const formats = [...unique.values()].sort((left, right) => {
		if (left.id !== right.id) return left.id - right.id;
		return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
	});
	return formats.length > 0 ? formats : undefined;
};

const addIfDefined = (target: UnknownRecord, key: string, value: unknown): void => {
	if (value !== undefined) target[key] = value;
};

const buildPayload = (input: UnknownRecord, service: HistoryService): UnknownRecord | undefined => {
	const providerEventId = getNumber(input, "id");
	const rawDate = getString(input, "date");
	const rawEventType = getString(input, "eventType");
	if (providerEventId === undefined || rawDate === undefined || rawEventType === undefined)
		return undefined;
	if (
		rawDate.length > 64 ||
		[...rawDate].some(
			(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		)
	)
		return undefined;
	if (
		[...rawEventType].some(
			(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		)
	)
		return undefined;
	const date = rawDate;
	const eventType = rawEventType.trim().toLowerCase();

	const parsedDate = new Date(date);
	if (Number.isNaN(parsedDate.getTime())) return undefined;
	const normalizedEventAt = parsedDate.toISOString();
	if (eventType.length === 0) return undefined;

	const payload: UnknownRecord = {
		version: 1,
		service,
		providerEventId,
		eventAt: normalizedEventAt,
		eventType,
	};

	const data = service === "prowlarr" ? getProwlarrData(input) : undefined;
	const series = service === "sonarr" ? getRecord(input, "series") : undefined;
	const episode = service === "sonarr" ? getRecord(input, "episode") : undefined;
	const movie = service === "radarr" ? getRecord(input, "movie") : undefined;
	const artist = service === "lidarr" ? getRecord(input, "artist") : undefined;
	const album = service === "lidarr" ? getRecord(input, "album") : undefined;
	const track = service === "lidarr" ? getRecord(input, "track") : undefined;
	const author = service === "readarr" ? getRecord(input, "author") : undefined;
	const book = service === "readarr" ? getRecord(input, "book") : undefined;

	const title =
		getDisplay(input, "title") ??
		(service === "sonarr" ? getNestedDisplay(series, "title") : undefined) ??
		(service === "radarr" ? getNestedDisplay(movie, "title") : undefined) ??
		(service === "lidarr" ? getNestedDisplay(artist, "artistName") : undefined) ??
		(service === "lidarr" ? getNestedDisplay(album, "title") : undefined) ??
		(service === "readarr" ? getNestedDisplay(author, "authorName") : undefined) ??
		(service === "readarr" ? getNestedDisplay(book, "title") : undefined) ??
		(service === "prowlarr"
			? getNestedDisplay(data, "releaseTitle", "title", "query", "searchTerm", "searchString")
			: undefined);
	addIfDefined(payload, "downloadId", normalizeIdentifier(input.downloadId));
	addIfDefined(payload, "title", title);
	addIfDefined(payload, "sourceTitle", normalizeDisplay(input.sourceTitle));
	addIfDefined(
		payload,
		"size",
		getFiniteNonnegativeNumber(input, "size") ??
			(data ? getFiniteNonnegativeNumber(data, "size") : undefined),
	);
	addIfDefined(payload, "qualityName", getQualityName(input));
	addIfDefined(payload, "customFormats", buildCustomFormats(input));
	const customFormatScore = input.customFormatScore;
	if (
		typeof customFormatScore === "number" &&
		Number.isFinite(customFormatScore) &&
		Number.isSafeInteger(customFormatScore)
	) {
		payload.customFormatScore = customFormatScore;
	}
	addIfDefined(payload, "downloadClient", normalizeDisplay(input.downloadClient));
	addIfDefined(
		payload,
		"indexer",
		normalizeDisplay(input.indexer) ??
			(data ? getNestedDisplay(data, "indexer", "indexerName") : undefined),
	);
	addIfDefined(payload, "protocol", normalizeDisplay(input.protocol));

	switch (service) {
		case "sonarr":
			addIfDefined(
				payload,
				"seriesId",
				getNumber(input, "seriesId") ?? getNestedNumber(series, "id"),
			);
			addIfDefined(
				payload,
				"seriesSlug",
				normalizeIdentifier(input.seriesSlug) ?? normalizeIdentifier(series?.titleSlug),
			);
			addIfDefined(
				payload,
				"episodeId",
				getNumber(input, "episodeId") ?? getNestedNumber(episode, "id"),
			);
			break;
		case "radarr":
			addIfDefined(payload, "movieId", getNumber(input, "movieId") ?? getNestedNumber(movie, "id"));
			addIfDefined(
				payload,
				"movieSlug",
				normalizeIdentifier(input.movieSlug) ?? normalizeIdentifier(movie?.titleSlug),
			);
			break;
		case "prowlarr":
			addIfDefined(
				payload,
				"indexerId",
				getNumber(input, "indexerId") ?? (data ? getNumber(data, "indexerId") : undefined),
			);
			break;
		case "lidarr":
			addIfDefined(
				payload,
				"artistId",
				getNumber(input, "artistId") ?? getNestedNumber(artist, "id"),
			);
			addIfDefined(payload, "albumId", getNumber(input, "albumId") ?? getNestedNumber(album, "id"));
			addIfDefined(payload, "trackId", getNumber(input, "trackId") ?? getNestedNumber(track, "id"));
			break;
		case "readarr":
			addIfDefined(
				payload,
				"authorId",
				getNumber(input, "authorId") ?? getNestedNumber(author, "id"),
			);
			addIfDefined(payload, "bookId", getNumber(input, "bookId") ?? getNestedNumber(book, "id"));
			break;
	}
	return payload;
};

export const buildHistorySearchText = (payload: HistoryNormalizedPayloadV1): string => {
	const fields: string[] = [payload.eventType];
	for (const key of [
		"title",
		"sourceTitle",
		"qualityName",
		"downloadClient",
		"indexer",
		"protocol",
	] as const) {
		const value = payload[key];
		if (typeof value === "string") fields.push(value);
	}
	if (payload.service === "sonarr" && payload.seriesSlug) fields.push(payload.seriesSlug);
	if (payload.service === "radarr" && payload.movieSlug) fields.push(payload.movieSlug);
	if (payload.customFormats) fields.push(...payload.customFormats.map(({ name }) => name));
	return fields
		.join(" ")
		.toLowerCase()
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, HISTORY_SEARCH_TEXT_MAX_LENGTH);
};

export function normalizeHistoryObservation(
	input: unknown,
	service: HistoryService,
): NormalizeHistoryObservationResult {
	if (!historyServiceSchema.safeParse(service).success || !isRecord(input)) return { ok: false };
	const candidate = buildPayload(input, service);
	if (!candidate) return { ok: false };
	const parsed = historyNormalizedPayloadV1Schema.safeParse(candidate);
	if (!parsed.success) return { ok: false };
	const normalizedPayload = JSON.stringify(parsed.data);
	if (new TextEncoder().encode(normalizedPayload).byteLength > HISTORY_NORMALIZED_JSON_MAX_BYTES) {
		return { ok: false };
	}
	return {
		ok: true,
		observation: {
			payload: parsed.data,
			normalizedPayload,
			searchText: buildHistorySearchText(parsed.data),
		},
	};
}

export function decodeHistoryNormalizedPayload(
	input: string,
): { ok: true; payload: HistoryNormalizedPayloadV1 } | { ok: false } {
	if (
		typeof input !== "string" ||
		new TextEncoder().encode(input).byteLength > HISTORY_NORMALIZED_JSON_MAX_BYTES
	) {
		return { ok: false };
	}
	let parsedInput: unknown;
	try {
		parsedInput = JSON.parse(input);
	} catch {
		return { ok: false };
	}
	const parsed = historyNormalizedPayloadV1Schema.safeParse(parsedInput);
	if (!parsed.success || JSON.stringify(parsed.data) !== input) return { ok: false };
	return { ok: true, payload: parsed.data };
}
