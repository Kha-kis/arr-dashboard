import type { HistoryItem } from "@arr/shared";
import { toNumber, toStringValue } from "../data/values";

/**
 * Returns the API path for history endpoints
 */
export const historyApiPath = (service: "sonarr" | "radarr" | "prowlarr") =>
  service === "prowlarr" ? "/api/v1/history" : "/api/v3/history";

/**
 * Normalizes a raw history item from the ARR API into a consistent format
 */
export const normalizeHistoryItem = (
  item: unknown,
  service: "sonarr" | "radarr" | "prowlarr",
): HistoryItem => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyItem = item as any;
  const rawId =
    anyItem.id ??
    anyItem.eventId ??
    anyItem.downloadId ??
    anyItem.sourceId ??
    anyItem.historyId ??
    anyItem.guid ??
    Math.random().toString(36);
  const normalizedId =
    typeof rawId === "number" || typeof rawId === "string"
      ? rawId
      : Math.random().toString(36);

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

  return {
    id: normalizedId,
    downloadId,
    title:
      prowlarrTitle ??
      toStringValue(anyItem.title) ??
      toStringValue(anyItem.sourceTitle) ??
      toStringValue(anyItem.series?.title) ??
      toStringValue(anyItem.movie?.title) ??
      "Untitled",
    size: toNumber(anyItem.size ?? dataObj.size),
    quality: anyItem.quality ?? dataObj.quality,
    status: toStringValue(anyItem.status ?? anyItem.eventType ?? anyItem.event),
    downloadClient: toStringValue(
      anyItem.downloadClient ??
        dataObj.downloadClient ??
        dataObj.downloadClientName,
    ),
    indexer:
      prowlarrSource ??
      toStringValue(anyItem.indexer ?? dataObj.indexer ?? dataObj.indexerName),
    protocol: toStringValue(
      anyItem.protocol ?? anyItem.downloadProtocol ?? dataObj.protocol,
    ),
    date: toStringValue(
      anyItem.date ??
        anyItem.eventDate ??
        anyItem.eventDateUtc ??
        anyItem.created ??
        anyItem.timestamp,
    ),
    reason: toStringValue(
      anyItem.reason ??
        dataObj.reason ??
        anyItem.error ??
        dataObj.message ??
        dataObj.statusMessage,
    ),
    eventType: toStringValue(anyItem.eventType ?? anyItem.event),
    sourceTitle: toStringValue(anyItem.sourceTitle ?? dataObj.source),
    seriesId: toNumber(anyItem.seriesId ?? anyItem.series?.id),
    seriesSlug: toStringValue(anyItem.series?.titleSlug ?? anyItem.seriesSlug),
    episodeId: toNumber(anyItem.episodeId ?? anyItem.episode?.id),
    movieId: toNumber(anyItem.movieId ?? anyItem.movie?.id),
    movieSlug: toStringValue(anyItem.movie?.titleSlug ?? anyItem.movieSlug),
    data: typeof anyItem.data === "object" ? anyItem.data : undefined,
    instanceId: "",
    instanceName: "",
    service,
  };
};
