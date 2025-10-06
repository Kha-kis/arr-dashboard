import type { FastifyPluginCallback } from "fastify";

import {
	type ProwlarrIndexer,
	type ProwlarrIndexerDetails,
	type ProwlarrIndexerField,
	type ProwlarrIndexerStats,
	type SearchGrabRequest,
	type SearchIndexerTestRequest,
	type SearchIndexerTestResponse,
	type SearchIndexerUpdateRequest,
	type SearchRequest,
	type SearchResult,
	multiInstanceSearchResponseSchema,
	prowlarrIndexerDetailsSchema,
	prowlarrIndexerFieldSchema,
	prowlarrIndexerSchema,
	prowlarrIndexerStatsSchema,
	searchGrabRequestSchema,
	searchIndexerDetailsResponseSchema,
	searchIndexerTestRequestSchema,
	searchIndexerTestResponseSchema,
	searchIndexerUpdateRequestSchema,
	searchIndexersResponseSchema,
	searchRequestSchema,
	searchResultSchema,
} from "@arr/shared";

import type { ServiceInstance } from "@prisma/client";
import { createInstanceFetcher } from "../lib/arr/arr-fetcher.js";

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

const normalizeSearchResult = (
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

const normalizeIndexer = (
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

const normalizeIndexerField = (
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

const normalizeIndexerStats = (
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

const normalizeIndexerDetails = (
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

const fetchProwlarrIndexerDetails = async (
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

const buildIndexerDetailsFallback = (
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

const fetchProwlarrIndexers = async (
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

type ManualSearchOptions = {
	query: string;

	type: SearchRequest["type"];

	limit: number;

	indexerIds?: number[];

	categories?: number[];
};

const performProwlarrSearch = async (
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

const testProwlarrIndexer = async (
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

const grabProwlarrRelease = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,

	release: SearchGrabRequest["result"],
): Promise<void> => {
	const guid = toStringValue((release as any)?.guid) ?? toStringValue(release?.id);

	const indexerId = toNumber((release as any)?.indexerId);

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

export const registerSearchRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.get("/search/indexers", async (request, reply) => {
		if (!request.currentUser) {
			reply.status(401);

			return searchIndexersResponseSchema.parse({
				instances: [],

				aggregated: [],

				totalCount: 0,
			});
		}

		const userId = request.currentUser.id;

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId, enabled: true, service: "PROWLARR" },
		});

		if (instances.length === 0) {
			return searchIndexersResponseSchema.parse({
				instances: [],

				aggregated: [],

				totalCount: 0,
			});
		}

		const results: Array<{
			instanceId: string;
			instanceName: string;
			data: ProwlarrIndexer[];
		}> = [];

		const aggregated: ProwlarrIndexer[] = [];

		for (const instance of instances) {
			const fetcherInstance = createInstanceFetcher(app, instance);

			try {
				const indexers = await fetchProwlarrIndexers(fetcherInstance, instance);

				results.push({
					instanceId: instance.id,

					instanceName: instance.label,

					data: indexers,
				});

				aggregated.push(...indexers);
			} catch (error) {
				request.log.error({ err: error, instance: instance.id }, "prowlarr indexers fetch failed");

				results.push({
					instanceId: instance.id,

					instanceName: instance.label,

					data: [],
				});
			}
		}

		return searchIndexersResponseSchema.parse({
			instances: results,

			aggregated,

			totalCount: aggregated.length,
		});
	});

	app.get("/search/indexers/:instanceId/:indexerId", async (request, reply) => {
		const params = request.params as { instanceId: string; indexerId: string };
		const instanceId = params.instanceId;
		const indexerId = Number(params.indexerId);

		const fallback = buildIndexerDetailsFallback(
			instanceId,
			"",
			undefined,
			Number.isFinite(indexerId) ? indexerId : 0,
		);

		if (!request.currentUser) {
			reply.status(401);
			return searchIndexerDetailsResponseSchema.parse({ indexer: fallback });
		}

		if (!Number.isFinite(indexerId)) {
			reply.status(400);
			return searchIndexerDetailsResponseSchema.parse({ indexer: fallback });
		}

		const instance = await app.prisma.serviceInstance.findFirst({
			where: {
				userId: request.currentUser.id,
				enabled: true,
				service: "PROWLARR",
				id: instanceId,
			},
		});

		if (!instance) {
			reply.status(404);
			return searchIndexerDetailsResponseSchema.parse({
				indexer: buildIndexerDetailsFallback(instanceId, "", undefined, indexerId),
			});
		}

		const fetcherInstance = createInstanceFetcher(app, instance);

		try {
			const details = await fetchProwlarrIndexerDetails(fetcherInstance, instance, indexerId);
			if (!details) {
				reply.status(502);
				return searchIndexerDetailsResponseSchema.parse({
					indexer: buildIndexerDetailsFallback(
						instance.id,
						instance.label,
						instance.baseUrl,
						indexerId,
					),
				});
			}
			return searchIndexerDetailsResponseSchema.parse({ indexer: details });
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, indexerId },
				"prowlarr indexer details failed",
			);
			reply.status(502);
			return searchIndexerDetailsResponseSchema.parse({
				indexer: buildIndexerDetailsFallback(
					instance.id,
					instance.label,
					instance.baseUrl,
					indexerId,
				),
			});
		}
	});

	app.put("/search/indexers/:instanceId/:indexerId", async (request, reply) => {
		const params = request.params as {
			instanceId?: string;
			indexerId?: string;
		};
		const paramInstanceId = params.instanceId ?? "";
		const indexerIdValue = Number(params.indexerId);

		if (!Number.isFinite(indexerIdValue)) {
			reply.status(400);
			return searchIndexerDetailsResponseSchema.parse({
				indexer: buildIndexerDetailsFallback(paramInstanceId, "", undefined, 0),
			});
		}

		if (!request.currentUser) {
			reply.status(401);
			return searchIndexerDetailsResponseSchema.parse({
				indexer: buildIndexerDetailsFallback(paramInstanceId, "", undefined, indexerIdValue),
			});
		}

		const payload: SearchIndexerUpdateRequest = searchIndexerUpdateRequestSchema.parse(
			request.body ?? {},
		);
		const instanceId = payload.instanceId ?? paramInstanceId;

		const userId = request.currentUser.id;
		const instance = await app.prisma.serviceInstance.findFirst({
			where: { userId, enabled: true, service: "PROWLARR", id: instanceId },
		});

		if (!instance) {
			reply.status(404);
			return searchIndexerDetailsResponseSchema.parse({
				indexer: buildIndexerDetailsFallback(instanceId, "", undefined, indexerIdValue),
			});
		}

		const fetcherInstance = createInstanceFetcher(app, instance);
		const originalIndexer = payload.indexer ?? { id: indexerIdValue };
		const bodyIndexer: ProwlarrIndexerDetails = {
			...originalIndexer,
			id: typeof originalIndexer.id === "number" ? originalIndexer.id : indexerIdValue,
			instanceId: originalIndexer.instanceId ?? instance.id,
			instanceName: originalIndexer.instanceName ?? instance.label,
			instanceUrl: originalIndexer.instanceUrl ?? instance.baseUrl,
		};

		try {
			await fetcherInstance(`/api/v1/indexer/${indexerIdValue}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(bodyIndexer),
			});
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, indexerId: indexerIdValue },
				"prowlarr indexer update failed",
			);
			reply.status(502);
			return searchIndexerDetailsResponseSchema.parse({
				indexer: buildIndexerDetailsFallback(
					instance.id,
					instance.label,
					instance.baseUrl,
					indexerIdValue,
				),
			});
		}

		try {
			const updated = await fetchProwlarrIndexerDetails(fetcherInstance, instance, indexerIdValue);
			if (updated) {
				return searchIndexerDetailsResponseSchema.parse({ indexer: updated });
			}
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, indexerId: indexerIdValue },
				"prowlarr indexer fetch after update failed",
			);
		}

		return searchIndexerDetailsResponseSchema.parse({ indexer: bodyIndexer });
	});

	app.post("/search/indexers/test", async (request, reply) => {
		if (!request.currentUser) {
			reply.status(401);

			return searchIndexerTestResponseSchema.parse({
				success: false,
				message: "Unauthorized",
			});
		}

		const payload = searchIndexerTestRequestSchema.parse(request.body ?? {});

		const instance = await app.prisma.serviceInstance.findFirst({
			where: {
				userId: request.currentUser.id,
				enabled: true,
				service: "PROWLARR",
				id: payload.instanceId,
			},
		});

		if (!instance) {
			reply.status(404);

			return searchIndexerTestResponseSchema.parse({
				success: false,
				message: "Indexer instance not found",
			});
		}

		const fetcherInstance = createInstanceFetcher(app, instance);

		try {
			await testProwlarrIndexer(fetcherInstance, payload.indexerId);

			return searchIndexerTestResponseSchema.parse({ success: true });
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, indexerId: payload.indexerId },
				"prowlarr indexer test failed",
			);

			reply.status(502);

			return searchIndexerTestResponseSchema.parse({
				success: false,

				message: error instanceof Error ? error.message : "Failed to test indexer",
			});
		}
	});

	app.post("/search/query", async (request, reply) => {
		if (!request.currentUser) {
			reply.status(401);

			return multiInstanceSearchResponseSchema.parse({
				instances: [],

				aggregated: [],

				totalCount: 0,
			});
		}

		const payload = searchRequestSchema.parse(request.body ?? {});

		const userId = request.currentUser.id;

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId, enabled: true, service: "PROWLARR" },
		});

		if (instances.length === 0) {
			return multiInstanceSearchResponseSchema.parse({
				instances: [],

				aggregated: [],

				totalCount: 0,
			});
		}

		const instanceMap = new Map(instances.map((instance) => [instance.id, instance] as const));

		const filters: Array<{
			instanceId: string;
			indexerIds?: number[];
			categories?: number[];
		}> =
			payload.filters && payload.filters.length > 0
				? payload.filters
				: instances.map((instance) => ({ instanceId: instance.id }));

		const results: Array<{
			instanceId: string;
			instanceName: string;
			data: SearchResult[];
		}> = [];

		const aggregated: SearchResult[] = [];

		for (const filter of filters) {
			const instance = instanceMap.get(filter.instanceId);

			if (!instance) {
				continue;
			}

			const fetcherInstance = createInstanceFetcher(app, instance);

			try {
				const data = await performProwlarrSearch(fetcherInstance, instance, {
					query: payload.query,

					type: payload.type,

					limit: payload.limit ?? 100,

					indexerIds: filter.indexerIds,

					categories: filter.categories,
				});

				results.push({
					instanceId: instance.id,

					instanceName: instance.label,

					data,
				});

				aggregated.push(...data);
			} catch (error) {
				request.log.error({ err: error, instance: instance.id }, "prowlarr search failed");

				results.push({
					instanceId: instance.id,

					instanceName: instance.label,

					data: [],
				});
			}
		}

		return multiInstanceSearchResponseSchema.parse({
			instances: results,

			aggregated,

			totalCount: aggregated.length,
		});
	});

	app.post("/search/grab", async (request, reply) => {
		if (!request.currentUser) {
			reply.status(401);

			return { success: false };
		}

		const payload = searchGrabRequestSchema.parse(request.body ?? {});

		const userId = request.currentUser.id;

		const instance = await app.prisma.serviceInstance.findFirst({
			where: {
				userId,
				enabled: true,
				service: "PROWLARR",
				id: payload.instanceId,
			},
		});

		if (!instance) {
			reply.status(404);

			return { success: false, message: "Prowlarr instance not found" };
		}

		const fetcherInstance = createInstanceFetcher(app, instance);

		try {
			await grabProwlarrRelease(fetcherInstance, payload.result);

			reply.status(204);

			return null;
		} catch (error) {
			request.log.error({ err: error, instance: instance.id }, "prowlarr grab failed");

			reply.status(502);

			return {
				success: false,
				message: error instanceof Error ? error.message : "Failed to grab release",
			};
		}
	});

	done();
};
