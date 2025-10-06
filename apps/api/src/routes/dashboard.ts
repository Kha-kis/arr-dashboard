import {
	calendarItemSchema,
	dashboardStatisticsResponseSchema,
	historyItemSchema,
	queueActionRequestSchema,
	queueBulkActionRequestSchema,
	queueItemSchema,
} from "@arr/shared";
import type {
	CalendarItem,
	DashboardStatisticsResponse,
	HistoryItem,
	QueueActionCapabilities,
	QueueItem,
} from "@arr/shared";
import type { ServiceInstance } from "@prisma/client";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { createInstanceFetcher } from "../lib/arr/arr-fetcher.js";
import { toBoolean, toNumber, toStringArray, toStringValue } from "../lib/data/values.js";
import {
	aggregateProwlarrStatistics,
	aggregateRadarrStatistics,
	aggregateSonarrStatistics,
	emptyProwlarrStatistics,
	emptyRadarrStatistics,
	emptySonarrStatistics,
	fetchProwlarrStatistics,
	fetchRadarrStatistics,
	fetchSonarrStatistics,
} from "./dashboard-statistics.js";
import { ManualImportError, autoImportByDownloadId } from "./manual-import-utils.js";

const queueApiPath = (service: "sonarr" | "radarr") => "/api/v3/queue";
const historyApiPath = (service: "sonarr" | "radarr" | "prowlarr") =>
	service === "prowlarr" ? "/api/v1/history" : "/api/v3/history";
const calendarApiPath = (service: "sonarr" | "radarr") => "/api/v3/calendar";

const historyQuerySchema = z.object({
	page: z.coerce.number().min(1).optional().default(1),
	pageSize: z.coerce.number().min(1).max(500).optional().default(100),
	startDate: z.string().optional(),
	endDate: z.string().optional(),
});

const calendarQuerySchema = z.object({
	start: z.string().optional(),
	end: z.string().optional(),
	unmonitored: z.coerce.boolean().optional(),
});

const formatDateOnly = (date: Date): string =>
	date.toISOString().split("T")[0] ?? date.toISOString();

const triggerQueueSearch = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	service: "sonarr" | "radarr",
	payload?: { seriesId?: number; episodeIds?: number[]; movieId?: number },
) => {
	if (!payload) {
		return;
	}

	if (service === "sonarr") {
		const commandPayload: Record<string, unknown> = {};
		if (Array.isArray(payload.episodeIds) && payload.episodeIds.length > 0) {
			commandPayload.name = "EpisodeSearch";
			commandPayload.episodeIds = Array.from(new Set(payload.episodeIds));
		} else if (typeof payload.seriesId === "number") {
			commandPayload.name = "SeriesSearch";
			commandPayload.seriesId = payload.seriesId;
		} else {
			return;
		}

		const response = await fetcher("/api/v3/command", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(commandPayload),
		});
		if (!response.ok) {
			const message = await response.text().catch(() => response.statusText);
			throw new Error(`Sonarr search command failed: ${message}`);
		}
		return;
	}

	if (typeof payload.movieId !== "number") {
		return;
	}

	const response = await fetcher("/api/v3/command", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ name: "MoviesSearch", movieIds: [payload.movieId] }),
	});
	if (!response.ok) {
		const message = await response.text().catch(() => response.statusText);
		throw new Error(`Radarr search command failed: ${message}`);
	}
};

const manualImportKeywords = [
	"manual import",
	"manual intervention",
	"requires manual",
	"manually import",
	"cannot be imported",
	"could not be imported",
	"no files were found",
	"no matching series",
	"not a valid",
	"stuck pending",
	"import pending",
];

const retryKeywords = [
	"retry",
	"failed",
	"failure",
	"timed out",
	"timeout",
	"temporarily unavailable",
	"unavailable",
	"disconnected",
	"unauthorized",
	"unauthorised",
	"forbidden",
	"stalled",
	"connection",
	"ioexception",
	"i/o",
];

const toLowerCase = (value: unknown): string => {
	if (typeof value === "string") {
		return value.trim().toLowerCase();
	}
	return "";
};

const collectStatusTexts = (item: any): string[] => {
	const results: string[] = [];
	if (Array.isArray(item?.statusMessages)) {
		for (const entry of item.statusMessages) {
			if (entry && typeof entry === "object") {
				if (typeof entry.title === "string" && entry.title.trim()) {
					results.push(entry.title.trim());
				}
				if (Array.isArray(entry.messages)) {
					for (const message of entry.messages) {
						if (typeof message === "string" && message.trim()) {
							results.push(message.trim());
						}
					}
				}
			}
		}
	}

	if (typeof item?.errorMessage === "string" && item.errorMessage.trim()) {
		results.push(item.errorMessage.trim());
	}

	if (typeof item?.error === "string" && item.error.trim()) {
		results.push(item.error.trim());
	}

	return results;
};

const pickMatchingMessage = (messages: string[], keywords: string[]): string | undefined => {
	for (const message of messages) {
		const lower = message.toLowerCase();
		if (keywords.some((keyword) => lower.includes(keyword))) {
			return message;
		}
	}
	return undefined;
};

const deriveQueueActions = (item: any): QueueActionCapabilities => {
	const status = toLowerCase(item?.status);
	const trackedState = toLowerCase(item?.trackedDownloadState);
	const trackedStatus = toLowerCase(item?.trackedDownloadStatus);
	const messages = collectStatusTexts(item);
	const downloadId = toStringValue(
		item?.downloadId ?? item?.guid ?? item?.sourceId ?? item?.data?.downloadId,
	);
	const hasDownloadId = Boolean(downloadId);

	const manualImportReason = pickMatchingMessage(messages, manualImportKeywords);
	const retryReason = pickMatchingMessage(messages, retryKeywords);

	const isPendingState = trackedState.includes("pending");
	const appearsCompleted =
		status.includes("completed") || status.includes("downloadclientunavailable");

	const canManualImport = Boolean(
		hasDownloadId &&
			(manualImportReason ||
				trackedState.includes("importpending") ||
				(isPendingState && appearsCompleted) ||
				(trackedStatus.includes("pending") && appearsCompleted)),
	);

	const canRetry = Boolean(
		retryReason ||
			trackedStatus.includes("error") ||
			trackedStatus.includes("warning") ||
			status.includes("failed") ||
			status.includes("stalled") ||
			status.includes("retry") ||
			status.includes("warning"),
	);

	const recommendedAction = canManualImport ? "manualImport" : canRetry ? "retry" : undefined;

	return {
		canRetry,
		canManualImport,
		canRemove: true,
		canChangeCategory: Boolean(toStringValue(item?.downloadClient)),
		recommendedAction,
		manualImportReason,
		retryReason,
	};
};

const parseQueueId = (value: string | number): number | null => {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) {
			return null;
		}
		const parsed = Number.parseInt(trimmed, 10);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return null;
};

const normalizeQueueItem = (
	item: any,
	service: "sonarr" | "radarr",
): Omit<QueueItem, "instanceId" | "instanceName"> => {
	const rawId =
		item.id ?? item.queueId ?? item.queueItemId ?? item.downloadId ?? Math.random().toString(36);
	const id =
		typeof rawId === "number" || typeof rawId === "string" ? rawId : Math.random().toString(36);

	const downloadId = toStringValue(item.downloadId ?? item.guid ?? item.sourceId);
	const title =
		toStringValue(item.title) ??
		toStringValue(item.series?.title) ??
		toStringValue(item.movie?.title) ??
		"Untitled";

	const normalized: Omit<QueueItem, "instanceId" | "instanceName"> = {
		id,
		queueItemId: toStringValue(item.queueItemId ?? item.queueId ?? item.id),
		downloadId,
		title,
		seriesId: toNumber(item.seriesId ?? item.series?.id),
		episodeId: toNumber(item.episodeId ?? item.episode?.id),
		movieId: toNumber(item.movieId ?? item.movie?.id),
		series:
			item.series && typeof item.series === "object"
				? {
						id: toNumber(item.series.id),
						title: toStringValue(item.series.title) ?? undefined,
					}
				: undefined,
		movie:
			item.movie && typeof item.movie === "object"
				? {
						id: toNumber(item.movie.id),
						title: toStringValue(item.movie.title) ?? undefined,
					}
				: undefined,
		size: toNumber(item.size ?? item.sizebytes),
		sizeleft: toNumber(item.sizeleft ?? item.sizeLeft ?? item.sizeRemaining),
		status: toStringValue(item.status),
		protocol: toStringValue(item.protocol ?? item.downloadProtocol),
		downloadProtocol: toStringValue(item.downloadProtocol ?? item.protocol),
		indexer: toStringValue(item.indexer ?? item.data?.indexer ?? item.data?.indexerName),
		downloadClient: toStringValue(
			item.downloadClient ?? item.downloadClientName ?? item.data?.downloadClient,
		),
		trackedDownloadState: toStringValue(item.trackedDownloadState),
		trackedDownloadStatus: toStringValue(item.trackedDownloadStatus),
		statusMessages: Array.isArray(item.statusMessages)
			? item.statusMessages
					.map((entry: any) => {
						const title = toStringValue(entry?.title ?? entry?.type ?? entry?.source);
						const messages: string[] = [];
						if (Array.isArray(entry?.messages)) {
							for (const raw of entry.messages) {
								const text = toStringValue(raw);
								if (text) {
									messages.push(text);
								}
							}
						}
						return {
							title,
							messages: messages.length > 0 ? messages : undefined,
						};
					})
					.filter((entry: any) => entry.title || (entry.messages && entry.messages.length > 0))
			: undefined,
		errorMessage: toStringValue(item.errorMessage ?? item.error),
		service,
	};

	normalized.actions = deriveQueueActions(item);

	return normalized;
};

const normalizeHistoryItem = (
	item: any,
	service: "sonarr" | "radarr" | "prowlarr",
): HistoryItem => {
	const rawId =
		item.id ??
		item.eventId ??
		item.downloadId ??
		item.sourceId ??
		item.historyId ??
		item.guid ??
		Math.random().toString(36);
	const normalizedId =
		typeof rawId === "number" || typeof rawId === "string" ? rawId : Math.random().toString(36);

	const downloadId =
		toStringValue(item.downloadId) ??
		toStringValue(item.sourceId) ??
		toStringValue(item.eventId) ??
		toStringValue(item.guid) ??
		(typeof normalizedId === "number" || typeof normalizedId === "string"
			? String(normalizedId)
			: undefined);

	// For Prowlarr, extract more info from data field
	const isProwlarr = service === "prowlarr";
	const dataObj = typeof item.data === "object" ? item.data : {};

	// Prowlarr specific: extract query, release title, or other useful info
	// Try multiple possible field names from Prowlarr's response
	const prowlarrTitle = isProwlarr
		? (toStringValue(item.sourceTitle) ??
			toStringValue(dataObj.releaseTitle) ??
			toStringValue(dataObj.title) ??
			toStringValue(dataObj.query) ??
			toStringValue(dataObj.searchTerm) ??
			toStringValue(dataObj.searchString) ??
			toStringValue(item.title))
		: undefined;

	const prowlarrSource = isProwlarr
		? (toStringValue(dataObj.indexer) ??
			toStringValue(dataObj.indexerName) ??
			toStringValue(dataObj.host))
		: undefined;

	return {
		id: normalizedId,
		downloadId,
		title:
			prowlarrTitle ??
			toStringValue(item.title) ??
			toStringValue(item.sourceTitle) ??
			toStringValue(item.series?.title) ??
			toStringValue(item.movie?.title) ??
			"Untitled",
		size: toNumber(item.size ?? dataObj.size),
		quality: item.quality ?? dataObj.quality,
		status: toStringValue(item.status ?? item.eventType ?? item.event),
		downloadClient: toStringValue(
			item.downloadClient ?? dataObj.downloadClient ?? dataObj.downloadClientName,
		),
		indexer:
			prowlarrSource ?? toStringValue(item.indexer ?? dataObj.indexer ?? dataObj.indexerName),
		protocol: toStringValue(item.protocol ?? item.downloadProtocol ?? dataObj.protocol),
		date: toStringValue(
			item.date ?? item.eventDate ?? item.eventDateUtc ?? item.created ?? item.timestamp,
		),
		reason: toStringValue(
			item.reason ?? dataObj.reason ?? item.error ?? dataObj.message ?? dataObj.statusMessage,
		),
		eventType: toStringValue(item.eventType ?? item.event),
		sourceTitle: toStringValue(item.sourceTitle ?? dataObj.source),
		seriesId: toNumber(item.seriesId ?? item.series?.id),
		seriesSlug: toStringValue(item.series?.titleSlug ?? item.seriesSlug),
		episodeId: toNumber(item.episodeId ?? item.episode?.id),
		movieId: toNumber(item.movieId ?? item.movie?.id),
		movieSlug: toStringValue(item.movie?.titleSlug ?? item.movieSlug),
		data: typeof item.data === "object" ? item.data : undefined,
		instanceId: "",
		instanceName: "",
		service,
	};
};

const selectCalendarDates = (item: any, service: "sonarr" | "radarr") => {
	if (service === "sonarr") {
		return {
			local: toStringValue(item.airDate),
			utc: toStringValue(item.airDateUtc),
		};
	}
	const primary =
		toStringValue(item.inCinemas) ??
		toStringValue(item.digitalRelease) ??
		toStringValue(item.physicalRelease) ??
		toStringValue(item.releaseDate);
	return {
		local: primary,
		utc: primary,
	};
};

const normalizeCalendarItem = (item: any, service: "sonarr" | "radarr"): CalendarItem => {
	const rawId =
		item.id ??
		item.eventId ??
		item.episodeId ??
		item.movieId ??
		item.sourceId ??
		Math.random().toString(36);
	const normalizedId =
		typeof rawId === "number" || typeof rawId === "string" ? rawId : Math.random().toString(36);

	const { local: airDate, utc: airDateUtc } = selectCalendarDates(item, service);

	const seriesTitle =
		service === "sonarr"
			? (toStringValue(item.series?.title) ??
				toStringValue(item.seriesTitle) ??
				toStringValue(item.title))
			: undefined;
	const episodeTitle =
		service === "sonarr"
			? (toStringValue(item.title) ??
				(typeof item.episodeNumber !== "undefined" ? `Episode ${item.episodeNumber}` : undefined))
			: undefined;
	const movieTitle =
		service === "radarr"
			? (toStringValue(item.title) ?? toStringValue(item.originalTitle))
			: undefined;

	const seriesId = service === "sonarr" ? toNumber(item.seriesId ?? item.series?.id) : undefined;
	const seriesSlug =
		service === "sonarr"
			? toStringValue(item.series?.titleSlug ?? item.titleSlug ?? item.series?.path)
			: undefined;
	const episodeId = service === "sonarr" ? toNumber(item.episodeId ?? item.id) : undefined;
	const movieId = service === "radarr" ? toNumber(item.movieId ?? item.id) : undefined;
	const movieSlug =
		service === "radarr"
			? toStringValue(item.movie?.titleSlug ?? item.titleSlug ?? item.movie?.path)
			: undefined;
	const tmdbId = toNumber(item.tmdbId ?? item.tmdbid ?? item.movie?.tmdbId ?? item.series?.tmdbId);
	const imdbId = toStringValue(
		item.imdbId ?? item.imdbid ?? item.movie?.imdbId ?? item.series?.imdbId,
	);
	const seriesStatus = service === "sonarr" ? toStringValue(item.series?.status) : undefined;
	const status = toStringValue(item.status ?? item.movie?.status ?? item.series?.status);

	const title =
		toStringValue(item.title) ?? episodeTitle ?? movieTitle ?? seriesTitle ?? "Untitled";

	return {
		id: normalizedId,
		title,
		service,
		type: service === "sonarr" ? "episode" : "movie",
		seriesTitle,
		episodeTitle,
		movieTitle,
		seriesId,
		seriesSlug,
		episodeId,
		movieId,
		movieSlug,
		tmdbId,
		imdbId,
		seriesStatus,
		status,
		seasonNumber: service === "sonarr" ? toNumber(item.seasonNumber) : undefined,
		episodeNumber: service === "sonarr" ? toNumber(item.episodeNumber) : undefined,
		airDate,
		airDateUtc,
		runtime: toNumber(item.runtime ?? item.series?.runtime),
		network: toStringValue(item.series?.network ?? item.network),
		studio: toStringValue(item.studio),
		overview: toStringValue(item.overview ?? item.series?.overview),
		genres: toStringArray(item.genres) ?? toStringArray(item.series?.genres),
		monitored: toBoolean(item.monitored),
		hasFile: toBoolean(item.hasFile),
		instanceId: "",
		instanceName: "",
	};
};

const compareCalendarItems = (a: CalendarItem, b: CalendarItem): number => {
	const timeA = new Date(a.airDateUtc ?? a.airDate ?? 0).getTime();
	const timeB = new Date(b.airDateUtc ?? b.airDate ?? 0).getTime();
	if (timeA !== timeB) {
		return timeA - timeB;
	}
	const titleA = toStringValue(a.title) ?? "";
	const titleB = toStringValue(b.title) ?? "";
	return titleA.localeCompare(titleB);
};

const fetchQueueItems = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	service: "sonarr" | "radarr",
): Promise<Omit<QueueItem, "instanceId" | "instanceName">[]> => {
	const query =
		service === "sonarr" ? "?pageSize=1000&includeUnknownSeriesItems=true" : "?pageSize=1000";
	const response = await fetcher(`${queueApiPath(service)}${query}`);
	const payload = await response.json();
	const items = Array.isArray(payload) ? payload : (payload.records ?? []);
	return items.map((raw: any) => normalizeQueueItem(raw, service));
};

const fetchHistoryItems = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	service: "sonarr" | "radarr" | "prowlarr",
	page: number,
	pageSize: number,
	startDate?: string,
	endDate?: string,
): Promise<{ items: HistoryItem[]; totalRecords: number }> => {
	const params = new URLSearchParams({
		page: String(page),
		pageSize: String(pageSize),
		sortKey: "date",
		sortDirection: "descending",
	});

	// Add date filtering if provided
	if (startDate) {
		params.append("since", startDate);
	}
	if (endDate) {
		params.append("until", endDate);
	}

	const response = await fetcher(`${historyApiPath(service)}?${params.toString()}`);
	const payload = await response.json();
	const records = Array.isArray(payload)
		? payload
		: Array.isArray(payload?.records)
			? payload.records
			: Array.isArray(payload?.results)
				? payload.results
				: Array.isArray(payload?.history)
					? payload.history
					: [];

	const totalRecords =
		payload &&
		typeof payload === "object" &&
		!Array.isArray(payload) &&
		typeof payload.totalRecords === "number"
			? payload.totalRecords
			: payload &&
					typeof payload === "object" &&
					!Array.isArray(payload) &&
					typeof payload.total === "number"
				? payload.total
				: records.length;

	const items = records.map((raw: any) => normalizeHistoryItem(raw, service));
	return { items, totalRecords };
};

const fetchCalendarItems = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	service: "sonarr" | "radarr",
	options: { start: string; end: string; unmonitored?: boolean },
): Promise<CalendarItem[]> => {
	const params = new URLSearchParams({
		start: options.start,
		end: options.end,
	});
	if (typeof options.unmonitored === "boolean") {
		params.set("unmonitored", String(options.unmonitored));
	}
	if (service === "sonarr") {
		params.set("includeSeries", "true");
		params.set("includeEpisodeFile", "true");
	} else {
		params.set("includeUnmonitored", "true");
	}
	const response = await fetcher(`${calendarApiPath(service)}?${params.toString()}`);
	const payload = await response.json();
	const records = Array.isArray(payload)
		? payload
		: Array.isArray(payload?.records)
			? payload.records
			: [];
	const normalized = records.map((raw: any) => normalizeCalendarItem(raw, service));
	normalized.sort(compareCalendarItems);
	return normalized;
};

const dashboardRoute: FastifyPluginCallback = (app, _opts, done) => {
	app.get("/dashboard/queue", async (request, reply) => {
		if (!request.currentUser) {
			reply.status(401);
			return { instances: [], aggregated: [], totalCount: 0 };
		}

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId: request.currentUser.id, enabled: true },
		});

		const results: Array<{
			instanceId: string;
			instanceName: string;
			service: "sonarr" | "radarr";
			data: QueueItem[];
		}> = [];
		const aggregated: QueueItem[] = [];

		for (const instance of instances) {
			const service = instance.service.toLowerCase();
			if (service !== "sonarr" && service !== "radarr") {
				continue;
			}

			try {
				const fetcher = createInstanceFetcher(app, instance as ServiceInstance);
				const items = await fetchQueueItems(fetcher, service);
				const enriched = items.map((item) => ({
					...item,
					instanceId: instance.id,
					instanceName: instance.label,
				}));
				results.push({
					instanceId: instance.id,
					instanceName: instance.label,
					service,
					data: enriched.map((item) => queueItemSchema.parse(item)),
				});
				aggregated.push(...enriched.map((item) => queueItemSchema.parse(item)));
			} catch (error) {
				request.log.error({ err: error, instance: instance.id }, "queue fetch failed");
				results.push({
					instanceId: instance.id,
					instanceName: instance.label,
					service,
					data: [],
				});
			}
		}

		return reply.send({
			instances: results,
			aggregated,
			totalCount: aggregated.length,
		});
	});

	app.post("/dashboard/queue/action", async (request, reply) => {
		if (!request.currentUser) {
			reply.status(401);
			return { success: false };
		}

		const body = queueActionRequestSchema.parse(request.body);
		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id: body.instanceId, userId: request.currentUser.id },
		});

		if (!instance || instance.service.toLowerCase() !== body.service) {
			reply.status(404);
			return { success: false, message: "Instance not found" };
		}

		const fetcher = createInstanceFetcher(app, instance as ServiceInstance);

		const queueId = parseQueueId(body.itemId);

		if (queueId === null) {
			reply.status(400);
			return { success: false, message: "Invalid queue identifier" };
		}

		if (body.action === "manualImport") {
			const downloadId = typeof body.downloadId === "string" ? body.downloadId.trim() : "";

			if (!downloadId) {
				reply.status(400);
				return {
					success: false,
					message: "Manual import requires a download identifier.",
				};
			}

			try {
				await autoImportByDownloadId(fetcher, body.service, downloadId);
			} catch (error) {
				const status =
					typeof (error as any)?.statusCode === "number"
						? (error as any).statusCode
						: error instanceof ManualImportError
							? error.statusCode
							: 502;

				const message =
					error instanceof Error && error.message ? error.message : "ARR manual import failed.";

				reply.status(status);
				return { success: false, message };
			}
		} else if (body.action === "retry") {
			// Retry by removing from queue without blocklisting, allowing ARR to retry automatically
			const search = new URLSearchParams({
				removeFromClient: String(body.removeFromClient ?? true),
				blocklist: "false",
				changeCategory: "false",
			});
			await fetcher(`${queueApiPath(body.service)}/${queueId}?${search.toString()}`, {
				method: "DELETE",
			});
		} else {
			const search = new URLSearchParams({
				removeFromClient: String(body.removeFromClient),
				blocklist: String(body.blocklist),
				changeCategory: String(body.changeCategory),
			});
			await fetcher(`${queueApiPath(body.service)}/${queueId}?${search.toString()}`, {
				method: "DELETE",
			});
			if (body.search) {
				try {
					await triggerQueueSearch(fetcher, body.service, body.searchPayload);
				} catch (error) {
					request.log.error(
						{ err: error, queueId, service: body.service },
						"queue search trigger failed",
					);
				}
			}
		}

		return reply.status(204).send();
	});

	app.post("/dashboard/queue/bulk", async (request, reply) => {
		if (!request.currentUser) {
			reply.status(401);
			return { success: false };
		}

		const body = queueBulkActionRequestSchema.parse(request.body);
		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id: body.instanceId, userId: request.currentUser.id },
		});

		if (!instance || instance.service.toLowerCase() !== body.service) {
			reply.status(404);
			return { success: false, message: "Instance not found" };
		}

		const fetcher = createInstanceFetcher(app, instance as ServiceInstance);

		const queueIds: number[] = [];
		for (const id of body.ids) {
			const parsed = parseQueueId(id);
			if (parsed === null) {
				reply.status(400);
				return { success: false, message: "Invalid queue identifier" };
			}
			queueIds.push(parsed);
		}

		if (body.action === "manualImport") {
			reply.status(400);
			return {
				success: false,
				message: "Manual import cannot be processed as a bulk action.",
			};
		}

		if (body.action === "retry") {
			// Retry by removing from queue without blocklisting, allowing ARR to retry automatically
			await fetcher(`${queueApiPath(body.service)}/bulk`, {
				method: "DELETE",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					ids: queueIds,
					removeFromClient: body.removeFromClient ?? true,
					blocklist: false,
					changeCategory: false,
				}),
			});
		} else {
			await fetcher(`${queueApiPath(body.service)}/bulk`, {
				method: "DELETE",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					ids: queueIds,
					removeFromClient: body.removeFromClient,
					blocklist: body.blocklist,
					changeCategory: body.changeCategory,
				}),
			});
		}

		return reply.status(204).send();
	});

	app.get("/dashboard/history", async (request, reply) => {
		if (!request.currentUser) {
			reply.status(401);
			return { instances: [], aggregated: [], totalCount: 0 };
		}

		const { startDate, endDate } = historyQuerySchema.parse(request.query ?? {});

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId: request.currentUser.id, enabled: true },
		});

		const results: Array<{
			instanceId: string;
			instanceName: string;
			service: "sonarr" | "radarr" | "prowlarr";
			data: HistoryItem[];
			totalRecords: number;
		}> = [];
		const allItems: HistoryItem[] = [];

		// Fetch all available records from each instance
		for (const instance of instances) {
			const service = instance.service.toLowerCase();
			if (service !== "sonarr" && service !== "radarr" && service !== "prowlarr") {
				continue;
			}

			try {
				const fetcher = createInstanceFetcher(app, instance as ServiceInstance);
				// Fetch all records (no pagination) - let client handle pagination
				const { items, totalRecords } = await fetchHistoryItems(
					fetcher,
					service,
					1,
					10000,
					startDate,
					endDate,
				);
				const enriched = items.map((item) => ({
					...item,
					instanceId: instance.id,
					instanceName: instance.label,
				}));
				const validated = enriched.map((entry) => historyItemSchema.parse(entry));
				results.push({
					instanceId: instance.id,
					instanceName: instance.label,
					service,
					data: validated,
					totalRecords,
				});
				allItems.push(...validated);
			} catch (error) {
				request.log.error({ err: error, instance: instance.id }, "history fetch failed");
				results.push({
					instanceId: instance.id,
					instanceName: instance.label,
					service,
					data: [],
					totalRecords: 0,
				});
			}
		}

		// Sort all items by date descending
		allItems.sort((a, b) => {
			const dateA = a.date ? new Date(a.date).getTime() : 0;
			const dateB = b.date ? new Date(b.date).getTime() : 0;
			return dateB - dateA;
		});

		return reply.send({
			instances: results,
			aggregated: allItems,
			totalCount: allItems.length,
		});
	});

	app.get("/dashboard/calendar", async (request, reply) => {
		if (!request.currentUser) {
			reply.status(401);
			return { instances: [], aggregated: [], totalCount: 0 };
		}

		const { start, end, unmonitored } = calendarQuerySchema.parse(request.query ?? {});
		const now = new Date();
		const defaultStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

		const ensureDate = (value: string | undefined, fallback: Date): Date => {
			if (!value) {
				return new Date(fallback);
			}
			const parsed = new Date(value);
			return Number.isNaN(parsed.getTime()) ? new Date(fallback) : parsed;
		};

		const startDate = ensureDate(start, defaultStart);
		const defaultEnd = new Date(
			Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 1, 0),
		);
		const endDate = ensureDate(end, defaultEnd);
		if (endDate.getTime() < startDate.getTime()) {
			endDate.setTime(startDate.getTime());
		}

		const startIso = formatDateOnly(startDate);
		const endIso = formatDateOnly(endDate);

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId: request.currentUser.id, enabled: true },
		});

		const results: Array<{
			instanceId: string;
			instanceName: string;
			service: "sonarr" | "radarr";
			data: CalendarItem[];
		}> = [];
		const aggregated: CalendarItem[] = [];

		for (const instance of instances) {
			const service = instance.service.toLowerCase();
			if (service !== "sonarr" && service !== "radarr") {
				continue;
			}

			try {
				const fetcher = createInstanceFetcher(app, instance as ServiceInstance);
				const items = await fetchCalendarItems(fetcher, service, {
					start: startIso,
					end: endIso,
					unmonitored,
				});
				const validated = items
					.map((item) => ({
						...item,
						instanceId: instance.id,
						instanceName: instance.label,
					}))
					.map((item) => calendarItemSchema.parse(item));
				results.push({
					instanceId: instance.id,
					instanceName: instance.label,
					service,
					data: validated,
				});
				aggregated.push(...validated);
			} catch (error) {
				request.log.error({ err: error, instance: instance.id }, "calendar fetch failed");
				results.push({
					instanceId: instance.id,
					instanceName: instance.label,
					service,
					data: [],
				});
			}
		}

		return reply.send({
			instances: results,
			aggregated,
			totalCount: aggregated.length,
		});
	});

	app.get("/dashboard/statistics", async (request, reply) => {
		if (!request.currentUser) {
			reply.status(401);
			return dashboardStatisticsResponseSchema.parse({
				sonarr: { instances: [], aggregate: emptySonarrStatistics },
				radarr: { instances: [], aggregate: emptyRadarrStatistics },
				prowlarr: { instances: [], aggregate: emptyProwlarrStatistics },
			});
		}

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId: request.currentUser.id, enabled: true },
		});

		const sonarrInstances: Array<{
			instanceId: string;
			instanceName: string;
			data: any;
		}> = [];
		const radarrInstances: Array<{
			instanceId: string;
			instanceName: string;
			data: any;
		}> = [];
		const prowlarrInstances: Array<{
			instanceId: string;
			instanceName: string;
			data: any;
		}> = [];

		for (const instance of instances) {
			const service = instance.service.toLowerCase();
			const fetcher = createInstanceFetcher(app, instance as ServiceInstance);

			if (service === "sonarr") {
				try {
					const data = await fetchSonarrStatistics(fetcher);
					sonarrInstances.push({
						instanceId: instance.id,
						instanceName: instance.label,
						data,
					});
				} catch (error) {
					request.log.error(
						{ err: error, instance: instance.id },
						"sonarr statistics fetch failed",
					);
					sonarrInstances.push({
						instanceId: instance.id,
						instanceName: instance.label,
						data: emptySonarrStatistics,
					});
				}
				continue;
			}

			if (service === "radarr") {
				try {
					const data = await fetchRadarrStatistics(fetcher);
					radarrInstances.push({
						instanceId: instance.id,
						instanceName: instance.label,
						data,
					});
				} catch (error) {
					request.log.error(
						{ err: error, instance: instance.id },
						"radarr statistics fetch failed",
					);
					radarrInstances.push({
						instanceId: instance.id,
						instanceName: instance.label,
						data: emptyRadarrStatistics,
					});
				}
				continue;
			}

			try {
				const data = await fetchProwlarrStatistics(fetcher);
				prowlarrInstances.push({
					instanceId: instance.id,
					instanceName: instance.label,
					data,
				});
			} catch (error) {
				request.log.error(
					{ err: error, instance: instance.id },
					"prowlarr statistics fetch failed",
				);
				prowlarrInstances.push({
					instanceId: instance.id,
					instanceName: instance.label,
					data: emptyProwlarrStatistics,
				});
			}
		}

		const payload: DashboardStatisticsResponse = {
			sonarr: {
				instances: sonarrInstances,
				aggregate: aggregateSonarrStatistics(sonarrInstances),
			},
			radarr: {
				instances: radarrInstances,
				aggregate: aggregateRadarrStatistics(radarrInstances),
			},
			prowlarr: {
				instances: prowlarrInstances,
				aggregate: aggregateProwlarrStatistics(prowlarrInstances),
			},
		};

		return reply.send(dashboardStatisticsResponseSchema.parse(payload));
	});

	done();
};

export const registerDashboardRoutes = dashboardRoute;
