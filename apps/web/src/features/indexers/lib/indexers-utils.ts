import type { ProwlarrIndexer, ProwlarrIndexerField } from "@arr/shared";

/**
 * Number formatter for displaying counts
 */
export const numberFormatter = new Intl.NumberFormat();

/**
 * Percentage formatter with one decimal place
 */
export const percentFormatter = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});

/**
 * Statistics computed from indexer data
 */
export interface IndexerStats {
  total: number;
  enabled: number;
  disabled: number;
  torrent: number;
  usenet: number;
  search: number;
  rss: number;
}

/**
 * Computes aggregate statistics from a list of indexers
 * @param indexers - Array of Prowlarr indexers
 * @returns Computed statistics object
 */
export const computeStats = (indexers: ProwlarrIndexer[]): IndexerStats => {
  const enabled = indexers.filter((indexer) => indexer.enable);
  const torrent = enabled.filter((indexer) => indexer.protocol === "torrent");
  const usenet = enabled.filter((indexer) => indexer.protocol === "usenet");
  return {
    total: indexers.length,
    enabled: enabled.length,
    disabled: indexers.length - enabled.length,
    torrent: torrent.length,
    usenet: usenet.length,
    search: enabled.filter((indexer) => indexer.supportsSearch).length,
    rss: enabled.filter((indexer) => indexer.supportsRss).length,
  };
};

/**
 * Returns a human-readable label for the protocol type
 * @param protocol - Protocol type (torrent or usenet)
 * @returns Label string
 */
export const protocolLabel = (
  protocol: ProwlarrIndexer["protocol"],
): string => {
  switch (protocol) {
    case "torrent":
      return "Torrent";
    case "usenet":
      return "Usenet";
    default:
      return "Unknown";
  }
};

/**
 * Determines if a field is related to API key configuration
 * @param field - Indexer field object
 * @returns True if field is API key related
 */
export const isApiKeyRelatedField = (field: ProwlarrIndexerField): boolean => {
  const name = (field.name ?? "").toLowerCase();
  const label = (field.label ?? "").toLowerCase();

  if (name.includes("apikey") || name.includes("api_key")) {
    return true;
  }

  if (label.includes("api key")) {
    return true;
  }

  if (
    (name.includes("about") && name.includes("api")) ||
    (label.includes("about") && label.includes("api"))
  ) {
    return true;
  }

  return false;
};

/**
 * Formats a field value for display
 * @param name - Field name
 * @param value - Field value (any type)
 * @returns Formatted string
 */
export const formatFieldValue = (name: string, value: unknown): string => {
  if (value === null || typeof value === "undefined") {
    return "Not configured";
  }

  if (typeof value === "boolean") {
    return value ? "Enabled" : "Disabled";
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : typeof entry === "number"
            ? entry.toString()
            : undefined,
      )
      .filter(Boolean)
      .join(", ");
  }

  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map((entry) =>
        typeof entry === "string" || typeof entry === "number"
          ? entry.toString()
          : undefined,
      )
      .filter(Boolean)
      .join(", ");
  }

  return String(value);
};

/**
 * Formats a success rate as a percentage
 * @param value - Success rate (0-1 or 0-100)
 * @returns Formatted percentage string
 */
export const formatSuccessRate = (value?: number): string => {
  if (typeof value !== "number") {
    return "–";
  }
  const normalized = value > 1 ? value / 100 : value;
  return percentFormatter.format(Math.max(0, Math.min(1, normalized)));
};

/**
 * Formats a response time in milliseconds or seconds
 * @param value - Response time in milliseconds
 * @returns Formatted time string
 */
export const formatResponseTime = (value?: number): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "–";
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)} s`;
  }
  return `${Math.round(value)} ms`;
};

/**
 * Formats a date/time string for display
 * @param value - ISO date string
 * @returns Formatted date string
 */
export const formatDateTime = (value?: string): string => {
  if (!value) {
    return "–";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
};
