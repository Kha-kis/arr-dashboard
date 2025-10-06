import type { QueueActionCapabilities, QueueItem } from "@arr/shared";
import { toNumber, toStringValue } from "../data/values";

/**
 * Returns the API path for queue endpoints
 */
export const queueApiPath = (service: "sonarr" | "radarr") => "/api/v3/queue";

/**
 * Keywords that indicate manual import is required
 */
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

/**
 * Keywords that indicate a retry action should be available
 */
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

/**
 * Converts a value to lowercase string
 */
const toLowerCase = (value: unknown): string => {
  if (typeof value === "string") {
    return value.trim().toLowerCase();
  }
  return "";
};

/**
 * Collects all status texts from a queue item including statusMessages, errorMessage, and error fields
 */
const collectStatusTexts = (item: unknown): string[] => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyItem = item as any;
  const results: string[] = [];
  if (Array.isArray(anyItem?.statusMessages)) {
    for (const entry of anyItem.statusMessages) {
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

  if (
    typeof anyItem?.errorMessage === "string" &&
    anyItem.errorMessage.trim()
  ) {
    results.push(anyItem.errorMessage.trim());
  }

  if (typeof anyItem?.error === "string" && anyItem.error.trim()) {
    results.push(anyItem.error.trim());
  }

  return results;
};

/**
 * Finds the first message that contains any of the specified keywords
 */
const pickMatchingMessage = (
  messages: string[],
  keywords: string[],
): string | undefined => {
  for (const message of messages) {
    const lower = message.toLowerCase();
    if (keywords.some((keyword) => lower.includes(keyword))) {
      return message;
    }
  }
  return undefined;
};

/**
 * Derives the available actions for a queue item based on its status and error messages
 */
export const deriveQueueActions = (item: unknown): QueueActionCapabilities => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyItem = item as any;
  const status = toLowerCase(anyItem?.status);
  const trackedState = toLowerCase(anyItem?.trackedDownloadState);
  const trackedStatus = toLowerCase(anyItem?.trackedDownloadStatus);
  const messages = collectStatusTexts(item);
  const downloadId = toStringValue(
    anyItem?.downloadId ??
      anyItem?.guid ??
      anyItem?.sourceId ??
      anyItem?.data?.downloadId,
  );
  const hasDownloadId = Boolean(downloadId);

  const manualImportReason = pickMatchingMessage(
    messages,
    manualImportKeywords,
  );
  const retryReason = pickMatchingMessage(messages, retryKeywords);

  const isPendingState = trackedState.includes("pending");
  const appearsCompleted =
    status.includes("completed") ||
    status.includes("downloadclientunavailable");

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

  const recommendedAction = canManualImport
    ? "manualImport"
    : canRetry
      ? "retry"
      : undefined;

  return {
    canRetry,
    canManualImport,
    canRemove: true,
    canChangeCategory: Boolean(toStringValue(anyItem?.downloadClient)),
    recommendedAction,
    manualImportReason,
    retryReason,
  };
};

/**
 * Parses a queue ID from string or number format
 */
export const parseQueueId = (value: string | number): number | null => {
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

/**
 * Normalizes a raw queue item from the ARR API into a consistent format
 */
export const normalizeQueueItem = (
  item: unknown,
  service: "sonarr" | "radarr",
): Omit<QueueItem, "instanceId" | "instanceName"> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyItem = item as any;
  const rawId =
    anyItem.id ??
    anyItem.queueId ??
    anyItem.queueItemId ??
    anyItem.downloadId ??
    Math.random().toString(36);
  const id =
    typeof rawId === "number" || typeof rawId === "string"
      ? rawId
      : Math.random().toString(36);

  const downloadId = toStringValue(
    anyItem.downloadId ?? anyItem.guid ?? anyItem.sourceId,
  );
  const title =
    toStringValue(anyItem.title) ??
    toStringValue(anyItem.series?.title) ??
    toStringValue(anyItem.movie?.title) ??
    "Untitled";

  const normalized: Omit<QueueItem, "instanceId" | "instanceName"> = {
    id,
    queueItemId: toStringValue(
      anyItem.queueItemId ?? anyItem.queueId ?? anyItem.id,
    ),
    downloadId,
    title,
    seriesId: toNumber(anyItem.seriesId ?? anyItem.series?.id),
    episodeId: toNumber(anyItem.episodeId ?? anyItem.episode?.id),
    movieId: toNumber(anyItem.movieId ?? anyItem.movie?.id),
    series:
      anyItem.series && typeof anyItem.series === "object"
        ? {
            id: toNumber(anyItem.series.id),
            title: toStringValue(anyItem.series.title) ?? undefined,
          }
        : undefined,
    movie:
      anyItem.movie && typeof anyItem.movie === "object"
        ? {
            id: toNumber(anyItem.movie.id),
            title: toStringValue(anyItem.movie.title) ?? undefined,
          }
        : undefined,
    size: toNumber(anyItem.size ?? anyItem.sizebytes),
    sizeleft: toNumber(
      anyItem.sizeleft ?? anyItem.sizeLeft ?? anyItem.sizeRemaining,
    ),
    status: toStringValue(anyItem.status),
    protocol: toStringValue(anyItem.protocol ?? anyItem.downloadProtocol),
    downloadProtocol: toStringValue(
      anyItem.downloadProtocol ?? anyItem.protocol,
    ),
    indexer: toStringValue(
      anyItem.indexer ?? anyItem.data?.indexer ?? anyItem.data?.indexerName,
    ),
    downloadClient: toStringValue(
      anyItem.downloadClient ??
        anyItem.downloadClientName ??
        anyItem.data?.downloadClient,
    ),
    trackedDownloadState: toStringValue(anyItem.trackedDownloadState),
    trackedDownloadStatus: toStringValue(anyItem.trackedDownloadStatus),
    statusMessages: Array.isArray(anyItem.statusMessages)
      ? anyItem.statusMessages
          .map((entry: unknown) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const anyEntry = entry as any;
            const title = toStringValue(
              anyEntry?.title ?? anyEntry?.type ?? anyEntry?.source,
            );
            const messages: string[] = [];
            if (Array.isArray(anyEntry?.messages)) {
              for (const raw of anyEntry.messages) {
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
          .filter((entry: unknown) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const anyEntry = entry as any;
            return (
              anyEntry.title ||
              (anyEntry.messages && anyEntry.messages.length > 0)
            );
          })
      : undefined,
    errorMessage: toStringValue(anyItem.errorMessage ?? anyItem.error),
    service,
  };

  normalized.actions = deriveQueueActions(item);

  return normalized;
};

/**
 * Triggers a search command in Sonarr or Radarr for the specified content
 */
export const triggerQueueSearch = async (
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
