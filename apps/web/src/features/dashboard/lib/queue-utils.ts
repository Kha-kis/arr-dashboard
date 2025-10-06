/**
 * Utility functions and constants for queue management
 */

import type { QueueItem } from "@arr/shared";
import type { MessageTone, IssueSummary } from "../components/queue-issue-badge";

/**
 * Status line representing a single message with tone
 */
export type StatusLine = {
  key: string;
  text: string;
  tone: MessageTone;
};

/**
 * Compact line with count for duplicate messages
 */
export type CompactLine = {
  key: string;
  text: string;
  tone: MessageTone;
  count: number;
};

/**
 * Action counts for queue items
 */
export type ActionCounts = {
  manualImport: number;
  retry: number;
};

/**
 * CSS classes for message tones
 */
export const messageToneClasses: Record<MessageTone, string> = {
  info: "border-white/20 bg-white/5 text-white/80",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-50",
  error: "border-red-500/40 bg-red-500/10 text-red-100",
};

/**
 * Builds unique key for a queue item
 */
export const buildKey = (item: QueueItem): string =>
  `${item.service}:${item.instanceId}:${String(item.id)}`;

/**
 * Gets grouping key for queue items that should be grouped together
 */
export const getGroupKey = (item: QueueItem): string | null => {
  if (item.downloadId) {
    return `${item.service}:${item.instanceId}:download:${item.downloadId}`;
  }
  if (item.service === "sonarr" && item.seriesId) {
    const base = item.seriesId;
    const protocol = item.protocol ?? item.downloadProtocol ?? "unknown";
    const client = item.downloadClient ?? "unknown";
    return `${item.service}:${item.instanceId}:series:${base}:${protocol}:${client}`;
  }
  return null;
};

/**
 * Derives title from queue items (series, movie, or generic title)
 */
export const deriveTitle = (items: QueueItem[]): string => {
  const [first] = items;
  if (!first) {
    return "Queue group";
  }
  return (
    first.series?.title ||
    first.movie?.title ||
    first.title ||
    first.instanceName ||
    "Queue group"
  );
};

/**
 * Sums numeric values, filtering out undefined and invalid numbers
 */
export const sumNumbers = (values: Array<number | undefined>): number => {
  let total = 0;
  values.forEach((value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      total += value;
    }
  });
  return total;
};

/**
 * Resolves message tone based on text content
 */
export const resolveMessageTone = (text: string): MessageTone => {
  const normalized = text.toLowerCase();
  if (
    normalized.includes("error") ||
    normalized.includes("fail") ||
    normalized.includes("denied") ||
    normalized.includes("invalid") ||
    normalized.includes("unauthorised") ||
    normalized.includes("unauthorized")
  ) {
    return "error";
  }
  if (
    normalized.includes("warn") ||
    normalized.includes("retry") ||
    normalized.includes("missing") ||
    normalized.includes("stalled") ||
    normalized.includes("timeout") ||
    normalized.includes("delay") ||
    normalized.includes("pending")
  ) {
    return "warning";
  }
  return "info";
};

/**
 * Checks if text looks like a release name (contains common release tokens)
 */
export const looksLikeReleaseName = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  const tokenMatch =
    /(s\d{1,2}e\d{1,3}|\.720p|\.1080p|\.2160p|\.480p|\.web[-_.]?dl|\.webrip|\.bluray|\.h\.264|\.h\.265|\.x264|\.x265|\.dvdrip|\.proper|\.repack|\.amzn|\.nf|\.hbo|\.dsnp)/i.test(
      lower,
    );
  if (!tokenMatch) {
    return false;
  }
  const dotSegments = trimmed
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  return dotSegments.length >= 4 || !trimmed.includes(" ");
};

/**
 * Collects all status messages from a queue item
 */
export const collectStatusLines = (item: QueueItem): StatusLine[] => {
  const lines: StatusLine[] = [];

  if (Array.isArray(item.statusMessages)) {
    item.statusMessages.forEach((entry, entryIndex) => {
      const title =
        typeof entry?.title === "string" ? entry.title.trim() : undefined;
      if (title) {
        lines.push({
          key: `${buildKey(item)}:status:${entryIndex}:title`,
          text: title,
          tone: resolveMessageTone(title),
        });
      }

      if (Array.isArray(entry?.messages)) {
        entry.messages.forEach((message, messageIndex) => {
          if (typeof message !== "string") {
            return;
          }
          const trimmed = message.trim();
          if (!trimmed) {
            return;
          }
          lines.push({
            key: `${buildKey(item)}:status:${entryIndex}:message:${messageIndex}`,
            text: trimmed,
            tone: resolveMessageTone(trimmed),
          });
        });
      }
    });
  }

  if (
    typeof item.errorMessage === "string" &&
    item.errorMessage.trim().length > 0
  ) {
    const trimmed = item.errorMessage.trim();
    lines.push({
      key: `${buildKey(item)}:error`,
      text: trimmed,
      tone: "error",
    });
  }

  return lines;
};

/**
 * Summarizes status lines by removing duplicates and counting occurrences
 */
export const summarizeLines = (lines: StatusLine[]): CompactLine[] => {
  const map = new Map<string, CompactLine>();

  lines.forEach((line, index) => {
    const trimmed = line.text.trim();
    if (!trimmed) {
      return;
    }

    const normalized = trimmed.toLowerCase();
    const looksLikeFile = /\.(mkv|mp4|avi|m4v|ts|rar|zip|7z)$/i.test(
      normalized,
    );
    if (looksLikeFile || looksLikeReleaseName(trimmed)) {
      return;
    }

    const existing = map.get(normalized);
    if (existing) {
      existing.count += 1;
      if (line.tone === "error" && existing.tone !== "error") {
        existing.tone = "error";
      } else if (line.tone === "warning" && existing.tone === "info") {
        existing.tone = "warning";
      }
    } else {
      map.set(normalized, {
        key: `${line.key}:${index}`,
        text: trimmed,
        tone: line.tone,
        count: 1,
      });
    }
  });

  return Array.from(map.values());
};

/**
 * Summarizes issue counts by tone
 */
export const summarizeIssueCounts = (lines: StatusLine[]): IssueSummary[] => {
  const filtered = summarizeLines(lines);
  const map = new Map<MessageTone, number>();
  filtered.forEach((entry) => {
    map.set(entry.tone, (map.get(entry.tone) ?? 0) + entry.count);
  });
  return Array.from(map.entries()).map(([tone, count]) => ({ tone, count }));
};

/**
 * Computes progress percentage from queue items
 */
export const computeProgressValue = (items: QueueItem[]): number | undefined => {
  const totalSize = sumNumbers(items.map((item) => item.size));
  const totalLeft = sumNumbers(items.map((item) => item.sizeleft));
  if (totalSize <= 0) {
    return undefined;
  }
  const completed = Math.max(0, totalSize - totalLeft);
  return Math.round((completed / totalSize) * 100);
};

/**
 * Formats file size in gigabytes
 */
export const formatSizeGB = (bytes?: number): string | null => {
  if (typeof bytes !== "number") {
    return null;
  }
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
};
