/**
 * Shared metadata formatting utilities for notification channel senders.
 *
 * Converts the generic `metadata` Record from NotificationPayload into
 * human-readable label/value pairs that each sender can render natively.
 */

/** A single displayable key-value pair */
export interface MetadataField {
	label: string;
	value: string;
}

/** Pretty-print labels for known metadata keys */
const LABEL_MAP: Record<string, string> = {
	// System
	version: "Version",
	nodeVersion: "Node",
	database: "Database",
	host: "Host",
	port: "Port",

	// Hunting
	instance: "Instance",
	service: "Service",
	huntType: "Hunt Type",
	itemsSearched: "Searched",
	itemsGrabbed: "Grabbed",
	apiCalls: "API Calls",
	durationMs: "Duration",
	grabbedItems: "Grabbed Items",

	// Queue cleaner
	itemsCleaned: "Cleaned",
	itemsSkipped: "Skipped",
	itemsWarned: "Warned",
	cleanedItems: "Cleaned Items",
	warnedItems: "Warned Items",

	// Backup
	nextRunAt: "Next Run",
	intervalType: "Interval",
	retentionCount: "Retention",

	// TRaSH Guides
	templatesAutoSynced: "Auto-Synced",
	templatesNeedingAttention: "Need Attention",
	qualitySizeAutoSynced: "Size Auto-Synced",

	// Library Cleanup
	itemsRemoved: "Removed",
	itemsUnmonitored: "Unmonitored",
	itemsFilesDeleted: "Files Deleted",
	itemsFlagged: "Flagged",

	// Security
	username: "Username",
	ip: "IP Address",
	failedAttempts: "Failed Attempts",
	maxAttempts: "Max Attempts",
	lockedMinutes: "Locked For (min)",

	// Services
	baseUrl: "Base URL",

	// Library New Content
	itemCount: "Items",
	items: "Titles",

	// TRaSH Deployment
	templateId: "Template",
	totalInstances: "Total Instances",
	failedInstances: "Failed",
};

/**
 * Convert a metadata record into displayable fields.
 * Skips null/undefined values and formats arrays as comma-separated lists.
 */
export function extractMetadataFields(metadata?: Record<string, unknown>): MetadataField[] {
	if (!metadata) return [];

	const fields: MetadataField[] = [];

	for (const [key, value] of Object.entries(metadata)) {
		if (value === null || value === undefined) continue;

		const label = LABEL_MAP[key] ?? humanizeKey(key);
		const formatted = formatValue(key, value);
		if (formatted) {
			fields.push({ label, value: formatted });
		}
	}

	return fields;
}

/** Format a metadata value into a display string */
function formatValue(key: string, value: unknown): string {
	if (key === "durationMs" && typeof value === "number") {
		return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
	}

	if (Array.isArray(value)) {
		if (value.length === 0) return "";
		// Handle arrays of objects with title/rule shape
		if (typeof value[0] === "object" && value[0] !== null) {
			return value
				.map((item) => {
					const obj = item as Record<string, unknown>;
					if (obj.title && obj.rule) return `${obj.title} (${obj.rule})`;
					if (obj.title) return String(obj.title);
					return JSON.stringify(obj);
				})
				.join(", ");
		}
		return value.join(", ");
	}

	if (typeof value === "object" && value !== null) {
		return JSON.stringify(value);
	}

	return String(value);
}

/** Convert camelCase key to Title Case label */
function humanizeKey(key: string): string {
	return key
		.replace(/([A-Z])/g, " $1")
		.replace(/^./, (c) => c.toUpperCase())
		.trim();
}
