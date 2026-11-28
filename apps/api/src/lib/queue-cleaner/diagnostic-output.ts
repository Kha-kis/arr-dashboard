import pino, { type Logger } from "pino";

const TOOLS = ["status-patterns", "arr-integration", "lidarr-integration", "live-import"] as const;
const EVENTS = [
	"started",
	"queue-summary",
	"pattern-summary",
	"eligibility-summary",
	"preview-summary",
	"manual-import-api",
	"configuration-missing",
	"provider-failed",
	"preview-requested",
	"import-preview",
	"import-started",
	"command-queued",
	"command-pending",
	"command-completed",
	"command-failed",
	"command-timeout",
	"command-status",
	"no-eligible-items",
	"no-valid-items",
	"partial-import-warning",
	"complete",
] as const;
const COUNT_FIELDS = [
	"totalItems",
	"pendingItems",
	"blockedItems",
	"failedItems",
	"downloadingItems",
	"otherItems",
	"eligibleItems",
	"ineligibleItems",
	"importItems",
	"wouldRemoveItems",
	"wouldWarnItems",
	"instances",
	"successfulInstances",
	"patterns",
	"messageOccurrences",
	"files",
	"validFiles",
	"rejectedFiles",
	"attempts",
] as const;

type DiagnosticFields = Partial<Record<(typeof COUNT_FIELDS)[number], number>> & {
	provider?: "sonarr" | "radarr" | "lidarr" | "readarr";
	success?: boolean;
	available?: boolean;
	status?: "queued" | "started" | "completed" | "failed" | "unknown";
};

// Read only own data properties. Getters, toJSON and arbitrary provider keys
// must never run while constructing an output record.
function ownValue(input: unknown, key: string): unknown {
	if (typeof input !== "object" || input === null) return undefined;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

export function createDiagnosticReporter(logger: Pick<Logger, "info">) {
	return (
		tool: (typeof TOOLS)[number],
		event: (typeof EVENTS)[number],
		fields?: DiagnosticFields,
	) => {
		const record: Record<string, string | number | boolean> = {
			category: "queue-cleaner-diagnostic",
			tool: TOOLS.find((value) => value === tool) ?? "unknown",
			event: EVENTS.find((value) => value === event) ?? "invalid-event",
		};
		for (const key of COUNT_FIELDS) {
			const value = ownValue(fields, key);
			if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
				record[key] = value;
		}
		for (const key of ["success", "available"] as const) {
			const value = ownValue(fields, key);
			if (typeof value === "boolean") record[key] = value;
		}
		const provider = ownValue(fields, "provider");
		if (
			provider === "sonarr" ||
			provider === "radarr" ||
			provider === "lidarr" ||
			provider === "readarr"
		) {
			record.provider = provider;
		}
		const status = ownValue(fields, "status");
		if (
			status === "queued" ||
			status === "started" ||
			status === "completed" ||
			status === "failed" ||
			status === "unknown"
		) {
			record.status = status;
		}
		try {
			logger.info(record, "Queue cleaner diagnostic");
		} catch {
			// Reporting must not interrupt provider selection, requests or polling.
		}
	};
}

export const reportDiagnostic = createDiagnosticReporter(pino({ base: null }));
