import {
	isSensitiveProwlarrField,
	type ProwlarrIndexer,
	type ProwlarrIndexerField,
} from "@arr/shared";

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

export const isSensitiveField = (field: ProwlarrIndexerField): boolean =>
	isSensitiveProwlarrField(field);

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
