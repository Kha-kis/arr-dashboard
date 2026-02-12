import type {
	ProwlarrIndexer,
	ProwlarrIndexerDetails,
	ProwlarrIndexerField,
	ProwlarrIndexerStats,
	SearchResult,
} from "@arr/shared";
import {
	prowlarrIndexerDetailsSchema,
	prowlarrIndexerSchema,
	prowlarrIndexerStatsSchema,
	searchResultSchema,
} from "@arr/shared";
import type { ServiceInstance } from "../../lib/prisma.js";

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
 * Converts a value to a trimmed string if possible, otherwise returns undefined.
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
 * Converts a value to a boolean, with a fallback default value.
 */
const toBoolean = (value: unknown, fallback = false): boolean => {
	if (typeof value === "boolean") {
		return value;
	}

	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();

		if (["true", "1", "yes", "on"].includes(normalized)) {
			return true;
		}

		if (["false", "0", "no", "off"].includes(normalized)) {
			return false;
		}
	}

	if (typeof value === "number") {
		return value !== 0;
	}

	return fallback;
};

/**
 * Parses a protocol string into a normalized protocol type.
 */
const parseProtocol = (value?: string): "torrent" | "usenet" | "unknown" => {
	if (!value) {
		return "unknown";
	}

	const normalized = value.toLowerCase();

	if (normalized === "torrent") {
		return "torrent";
	}

	if (normalized === "usenet") {
		return "usenet";
	}

	return "unknown";
};

/**
 * Normalizes capabilities from various formats into a string array.
 */
const normalizeCapabilities = (value: unknown): string[] | undefined => {
	if (Array.isArray(value)) {
		const capabilities = value

			.map((entry: unknown) => toStringValue(entry))

			.filter((entry): entry is string => Boolean(entry));

		return capabilities.length > 0 ? capabilities : undefined;
	}

	if (value && typeof value === "object") {
		const capabilities: string[] = [];

		for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
			if (toBoolean(raw, false)) {
				const name = toStringValue(key);

				if (name) {
					capabilities.push(name);
				}
			}
		}

		return capabilities.length > 0 ? capabilities : undefined;
	}

	return undefined;
};

/**
 * Parses a value into an array of numbers.
 */
const parseNumberArray = (value: unknown): number[] | undefined => {
	if (Array.isArray(value)) {
		const numbers = value
			.map((entry: unknown) => toNumber(entry))
			.filter((entry): entry is number => typeof entry === "number");
		return numbers.length > 0 ? numbers : undefined;
	}

	if (typeof value === "string") {
		const numbers = value
			.split(/[|,]/)
			.map((entry) => toNumber(entry.trim()))
			.filter((entry): entry is number => typeof entry === "number");
		return numbers.length > 0 ? numbers : undefined;
	}

	return undefined;
};

/**
 * Parses a value into an array of strings.
 */
const parseStringArray = (value: unknown): string[] | undefined => {
	if (Array.isArray(value)) {
		const items = value
			.map((entry: unknown) => toStringValue(entry))
			.filter((entry): entry is string => Boolean(entry));
		return items.length > 0 ? items : undefined;
	}

	if (typeof value === "string") {
		const items = value
			.split(/[|,]/)
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		return items.length > 0 ? items : undefined;
	}

	return undefined;
};

/**
 * Normalizes search language data into a consistent format.
 */
const normalizeSearchLanguages = (
	value: unknown,
): Array<{ id: number; name: string }> | undefined => {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const languages: Array<{ id: number; name: string }> = [];
	let fallbackId = 1000;

	for (const entry of value) {
		if (!entry) {
			continue;
		}

		if (typeof entry === "object") {
			const record = entry as Record<string, unknown>;
			const id = toNumber(record.id ?? record.languageId ?? record.value);
			const name = toStringValue(record.name ?? record.language ?? record.label ?? record.value);
			if (typeof id === "number" && name) {
				languages.push({ id, name });
				continue;
			}
			if (name) {
				languages.push({ id: fallbackId, name });
				fallbackId += 1;
				continue;
			}
		}

		if (typeof entry === "string") {
			const trimmed = entry.trim();
			if (trimmed.length > 0) {
				languages.push({ id: fallbackId, name: trimmed });
				fallbackId += 1;
			}
			continue;
		}

		if (typeof entry === "number" && Number.isFinite(entry)) {
			languages.push({ id: entry, name: `Language ${entry}` });
		}
	}

	return languages.length > 0 ? languages : undefined;
};

/**
 * Parses a date value into an ISO string.
 */
const parseDateValue = (value: unknown): string | undefined => {
	const raw = toStringValue(value);
	if (!raw) {
		return undefined;
	}

	const date = new Date(raw);
	if (Number.isNaN(date.getTime())) {
		return undefined;
	}

	return date.toISOString();
};

/**
 * Normalizes a raw search result from Prowlarr into a consistent format.
 */
export const normalizeSearchResult = (
	raw: Record<string, unknown> | null | undefined,
	instance: ServiceInstance,
): SearchResult | null => {
	if (!raw) {
		return null;
	}

	const id =
		toStringValue(raw.id) ??
		toStringValue(raw.guid) ??
		toStringValue(raw.downloadUrl ?? raw.downloadLink ?? raw.downloadURI ?? raw.link);

	const title =
		toStringValue(raw.title) ??
		toStringValue(raw.name) ??
		toStringValue(raw.originalTitle) ??
		toStringValue(raw.releaseTitle) ??
		(id ? `Result ${id}` : undefined);

	const indexerId = toNumber(raw.indexerId ?? raw.indexerID);
	const indexerName =
		toStringValue(raw.indexer) ??
		toStringValue(raw.indexerName) ??
		toStringValue(raw.indexerShort) ??
		toStringValue(raw.site) ??
		instance.label;

	if (!id || !title || typeof indexerId !== "number") {
		return null;
	}

	const magnetUrl =
		toStringValue(raw.magnetUrl) ??
		toStringValue(raw.magnetURI) ??
		toStringValue(raw.magneturi) ??
		toStringValue(raw.MagnetUri) ??
		toStringValue(raw.MagnetURI);

	const infoUrl =
		toStringValue(raw.infoUrl) ??
		toStringValue(raw.infoLink) ??
		toStringValue(raw.infoURI) ??
		toStringValue(raw.info);

	const downloadUrl =
		toStringValue(raw.downloadUrl) ??
		toStringValue(raw.downloadLink) ??
		toStringValue(raw.downloadURI) ??
		toStringValue(raw.download);

	const seeders = toNumber(raw.seeders);
	const leechers = toNumber(raw.leechers);
	const peers =
		toNumber(raw.peers) ??
		(typeof seeders === "number" || typeof leechers === "number"
			? (seeders ?? 0) + (leechers ?? 0)
			: undefined);

	const rejectionReasons = parseStringArray(
		raw.rejectionReasons ??
			raw.rejectionMessages ??
			raw.rejections ??
			raw.rejectReasons ??
			raw.reasons,
	);

	const candidate = {
		id,
		guid: toStringValue(raw.guid) ?? undefined,
		title,
		size: toNumber(raw.size) ?? undefined,
		link: toStringValue(raw.link) ?? downloadUrl ?? infoUrl ?? undefined,
		magnetUrl: magnetUrl ?? undefined,
		infoUrl: infoUrl ?? undefined,
		downloadUrl: downloadUrl ?? undefined,
		indexer: indexerName,
		indexerId,
		categories: parseNumberArray(raw.categories ?? raw.category ?? raw.categoryIds),
		seeders: seeders ?? undefined,
		leechers: leechers ?? undefined,
		peers: peers ?? undefined,
		grabs: toNumber(raw.grabs ?? raw.historyCount ?? raw.downloaded) ?? undefined,
		protocol: parseProtocol(toStringValue(raw.protocol)),
		publishDate: parseDateValue(raw.publishDate ?? raw.firstSeen ?? raw.updated) ?? undefined,
		age: toNumber(raw.age) ?? undefined,
		ageHours: toNumber(raw.ageHours) ?? undefined,
		ageDays: toNumber(raw.ageDays) ?? undefined,
		downloadClient: toStringValue(raw.downloadClient ?? raw.downloadClientName) ?? undefined,
		downloadVolumeFactor: toNumber(raw.downloadVolumeFactor) ?? undefined,
		uploadVolumeFactor: toNumber(raw.uploadVolumeFactor) ?? undefined,
		minimumRatio: toNumber(raw.minimumRatio) ?? undefined,
		minimumSeedTime: toNumber(raw.minimumSeedTime) ?? undefined,
		rejectionReasons,
		rejected:
			typeof raw.rejected === "boolean"
				? raw.rejected
				: rejectionReasons && rejectionReasons.length > 0
					? true
					: undefined,
		languages: normalizeSearchLanguages(raw.languages),
		quality: raw.quality,
		instanceId: instance.id,
		instanceName: instance.label,
		instanceUrl: instance.baseUrl,
	};

	const parsed = searchResultSchema.safeParse(candidate);
	return parsed.success ? parsed.data : null;
};

/**
 * Normalizes a raw Prowlarr indexer into a consistent format.
 */
export const normalizeIndexer = (
	indexer: Record<string, unknown> | null | undefined,
	instanceId: string,
	instanceName: string,
	instanceUrl: string,
): ProwlarrIndexer | null => {
	if (!indexer) {
		return null;
	}

	const id = toNumber(indexer.id);
	const name = toStringValue(indexer.name) ?? toStringValue(indexer.title) ?? "Indexer";
	if (typeof id !== "number") {
		return null;
	}

	const result = prowlarrIndexerSchema.safeParse({
		id,
		name,
		enable: toBoolean(indexer.enable, true),
		protocol: parseProtocol(toStringValue(indexer.protocol)),
		supportsRss:
			typeof indexer.supportsRss !== "undefined"
				? toBoolean(indexer.supportsRss, false)
				: undefined,
		supportsSearch:
			typeof indexer.supportsSearch !== "undefined"
				? toBoolean(indexer.supportsSearch, true)
				: undefined,
		supportsRedirect:
			typeof indexer.supportsRedirect !== "undefined"
				? toBoolean(indexer.supportsRedirect, false)
				: undefined,
		appProfileId: toNumber(indexer.appProfileId) ?? undefined,
		priority: toNumber(indexer.priority) ?? undefined,
		tags: parseNumberArray(indexer.tags),
		capabilities: normalizeCapabilities(indexer.capabilities ?? indexer.caps),
		instanceId,
		instanceName,
		instanceUrl,
	});

	if (!result.success) {
		return null;
	}

	return result.data;
};

/**
 * Normalizes a raw indexer field into a consistent format.
 */
export const normalizeIndexerField = (
	field: Record<string, unknown> | null | undefined,
): ProwlarrIndexerField | null => {
	if (!field) {
		return null;
	}

	const name = toStringValue(field.name);
	if (!name) {
		return null;
	}

	const rawValue =
		field.value ?? field.textValue ?? field.stringValue ?? field.valueString ?? field.text ?? null;

	let value: string | number | boolean | null | undefined;
	if (
		typeof rawValue === "string" ||
		typeof rawValue === "number" ||
		typeof rawValue === "boolean"
	) {
		value = rawValue;
	} else if (rawValue === null || typeof rawValue === "undefined") {
		value = null;
	} else if (Array.isArray(rawValue)) {
		const parts = rawValue
			.map((entry: unknown) => toStringValue(entry))
			.filter((entry): entry is string => Boolean(entry));
		value = parts.length > 0 ? parts.join(", ") : null;
	} else if (rawValue && typeof rawValue === "object") {
		const record = rawValue as Record<string, unknown>;
		value = toStringValue(record.value ?? record.name) ?? null;
	} else {
		value = undefined;
	}

	return {
		name,
		label: toStringValue(field.label) ?? undefined,
		helpText: toStringValue(field.helpText ?? field.helptext) ?? undefined,
		type: toStringValue(field.type ?? field.inputType) ?? undefined,
		value,
	};
};

/**
 * Normalizes indexer stats from Prowlarr into a consistent format.
 */
export const normalizeIndexerStats = (
	stats: Record<string, unknown> | null | undefined,
): ProwlarrIndexerStats | undefined => {
	if (!stats) {
		return undefined;
	}

	const parsed = prowlarrIndexerStatsSchema.safeParse({
		status: toStringValue(stats.status) ?? toStringValue(stats.state) ?? undefined,
		message: toStringValue(stats.message) ?? undefined,
		successRate: toNumber(stats.successRate) ?? undefined,
		averageResponseTime: toNumber(stats.averageResponseTime) ?? undefined,
		responseTime: toNumber(stats.responseTime) ?? undefined,
		grabs: toNumber(stats.grabs) ?? undefined,
		fails: toNumber(stats.fails ?? stats.failures) ?? undefined,
		lastCheck: toStringValue(stats.lastCheck) ?? toStringValue(stats.lastExecution) ?? undefined,
		lastFailure: toStringValue(stats.lastFailure) ?? undefined,
	});
	return parsed.success ? parsed.data : undefined;
};

/**
 * Normalizes detailed indexer information from Prowlarr into a consistent format.
 */
export const normalizeIndexerDetails = (
	raw: Record<string, unknown> | null | undefined,
	stats: Record<string, unknown> | null | undefined,
	instance: ServiceInstance,
	indexerId: number,
): ProwlarrIndexerDetails | null => {
	if (!raw) {
		return null;
	}

	const id = toNumber(raw.id) ?? indexerId;
	const name = toStringValue(raw.name) ?? toStringValue(raw.title) ?? `Indexer ${indexerId}`;

	const detail = {
		id,
		name,
		enable: typeof raw.enable === "boolean" ? raw.enable : undefined,
		protocol: parseProtocol(toStringValue(raw.protocol)),
		priority: toNumber(raw.priority) ?? undefined,
		appProfileId: toNumber(raw.appProfileId) ?? undefined,
		instanceId: instance.id,
		instanceName: instance.label,
		instanceUrl: instance.baseUrl,
		implementationName:
			toStringValue(raw.implementationName) ?? toStringValue(raw.implementation) ?? undefined,
		definitionName: toStringValue(raw.definitionName) ?? undefined,
		description: toStringValue(raw.description) ?? undefined,
		language: toStringValue(raw.language) ?? undefined,
		privacy: toStringValue(raw.privacy) ?? undefined,
		isPrivate: typeof raw.isPrivate === "boolean" ? raw.isPrivate : undefined,
		capabilities: normalizeCapabilities(raw.capabilities ?? raw.caps),
		tags: parseNumberArray(raw.tags),
		categories: parseNumberArray(raw.categories),
		fields: Array.isArray(raw.fields)
			? raw.fields
					.map((field) => normalizeIndexerField(field as Record<string, unknown>))
					.filter((field): field is ProwlarrIndexerField => Boolean(field))
			: undefined,
		stats: normalizeIndexerStats(stats),
	};

	const parsed = prowlarrIndexerDetailsSchema.safeParse(detail);
	return parsed.success ? parsed.data : null;
};
