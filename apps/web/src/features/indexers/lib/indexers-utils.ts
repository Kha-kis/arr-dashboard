import type { ProwlarrIndexer, ProwlarrIndexerField } from "@arr/shared";

/**
 * Number formatter for displaying counts
 */
export const numberFormatter = new Intl.NumberFormat();

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
	healthy: number;
	degraded: number;
	failing: number;
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

	// Health classification from inline health data
	let healthy = 0;
	let degraded = 0;
	let failing = 0;
	for (const indexer of enabled) {
		const rate = indexer.health?.successRate;
		if (rate === undefined) continue;
		const normalized = rate > 1 ? rate / 100 : rate;
		if (normalized >= 0.9) healthy++;
		else if (normalized >= 0.5) degraded++;
		else failing++;
	}

	return {
		total: indexers.length,
		enabled: enabled.length,
		disabled: indexers.length - enabled.length,
		torrent: torrent.length,
		usenet: usenet.length,
		search: enabled.filter((indexer) => indexer.supportsSearch).length,
		rss: enabled.filter((indexer) => indexer.supportsRss).length,
		healthy,
		degraded,
		failing,
	};
};

/**
 * Returns a human-readable label for the protocol type
 * @param protocol - Protocol type (torrent or usenet)
 * @returns Label string
 */
export const protocolLabel = (protocol: ProwlarrIndexer["protocol"]): string => {
	switch (protocol) {
		case "torrent":
			return "Torrent";
		case "usenet":
			return "Usenet";
		default:
			return "Unknown";
	}
};

/** Prowlarr field types that indicate sensitive/non-displayable content */
const SENSITIVE_FIELD_TYPES = new Set(["password", "hidden"]);

/** Field name patterns that indicate credentials or private tracker identifiers */
const SENSITIVE_NAME_PATTERNS = [
	"apikey",
	"api_key",
	"passkey",
	"cookie",
	"password",
	"secret",
	"token",
] as const;

/** Exact field names that are credentials (private tracker IDs, user secrets, etc.) */
const SENSITIVE_FIELD_NAMES = new Set(["mamId", "pid", "rsskey", "uid", "userId", "userPasskey"]);

/**
 * Determines if a field contains sensitive data (API keys, credentials,
 * private tracker identifiers) that should not be displayed by default.
 * @param field - Indexer field object
 * @returns True if field is sensitive
 */
export const isSensitiveField = (field: ProwlarrIndexerField): boolean => {
	const name = (field.name ?? "").toLowerCase();
	const label = (field.label ?? "").toLowerCase();
	const type = (field.type ?? "").toLowerCase();

	// Type-based: Prowlarr marks sensitive fields as password/hidden
	if (SENSITIVE_FIELD_TYPES.has(type)) return true;

	// Exact name match (case-insensitive via the Set check on original casing)
	if (SENSITIVE_FIELD_NAMES.has(field.name)) return true;

	// Pattern match on name or label
	for (const pattern of SENSITIVE_NAME_PATTERNS) {
		if (name.includes(pattern) || label.includes(pattern)) return true;
	}

	// "about api" info fields
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
export const formatFieldValue = (_name: string, value: unknown): string => {
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
				typeof entry === "string" || typeof entry === "number" ? entry.toString() : undefined,
			)
			.filter(Boolean)
			.join(", ");
	}

	return String(value);
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
