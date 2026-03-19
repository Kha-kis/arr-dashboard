/**
 * Queue Cleaner Rule Evaluator Tests
 *
 * Tests for evaluateQueueItem and related rule evaluation functions.
 * Focuses on import blocked/pending detection edge cases (issue #129).
 *
 * Run with: npx vitest run rule-evaluators.test.ts
 */

import { describe, it, expect } from "vitest";
import {
	evaluateQueueItem,
	evaluateImportBlockState,
	matchesCustomImportBlockPatterns,
} from "./rule-evaluators.js";
import { collectStatusTexts, type RawQueueItem } from "./queue-item-utils.js";
import { calculateQueueSummary } from "./cleaner-formatters.js";
import type { QueueCleanerConfig } from "../prisma.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal config with all rules disabled — enable only what each test needs. */
function baseConfig(overrides: Partial<QueueCleanerConfig> = {}): QueueCleanerConfig {
	return {
		id: "test-config",
		instanceId: "test-instance",
		enabled: true,
		dryRunMode: false,
		intervalMins: 15,
		minQueueAgeMins: 0,
		maxRemovalsPerRun: 50,
		stalledEnabled: false,
		stalledThresholdMins: 60,
		failedEnabled: false,
		slowEnabled: false,
		slowSpeedThreshold: 10,
		slowGracePeriodMins: 30,
		errorPatternsEnabled: false,
		errorPatterns: null,
		seedingTimeoutEnabled: false,
		seedingTimeoutHours: 24,
		estimatedCompletionEnabled: false,
		estimatedCompletionMultiplier: 2.0,
		whitelistEnabled: false,
		whitelistPatterns: null,
		removeFromClient: true,
		addToBlocklist: false,
		searchAfterRemoval: true,
		changeCategoryEnabled: false,
		strikeSystemEnabled: false,
		maxStrikes: 3,
		strikeDecayHours: 24,
		importPendingThresholdMins: 60,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	} as QueueCleanerConfig;
}

/** Create a raw queue item with sensible defaults. */
function makeQueueItem(overrides: Partial<RawQueueItem> = {}): RawQueueItem {
	return {
		id: 1,
		title: "Test.Movie.2024.1080p.BluRay",
		added: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
		size: 5_000_000_000,
		sizeleft: 0, // download complete
		estimatedCompletionTime: null,
		trackedDownloadStatus: "warning",
		trackedDownloadState: "importBlocked",
		statusMessages: [],
		errorMessage: null,
		indexer: "TestIndexer",
		protocol: "torrent",
		downloadClient: "qBittorrent",
		downloadId: "abc123",
		tags: [],
		...overrides,
	};
}

const now = new Date();

// ---------------------------------------------------------------------------
// Tests: Import Blocked Detection (Issue #129 — Primary Bug)
// ---------------------------------------------------------------------------

describe("evaluateQueueItem: importBlocked detection", () => {
	const importConfig = baseConfig({ importPendingEnabled: true } as Partial<QueueCleanerConfig>);

	it("catches importBlocked items with safe keyword (already existed)", () => {
		const item = makeQueueItem({
			trackedDownloadState: "importBlocked",
			statusMessages: [{ title: "Already exists in library", messages: [] }],
		});
		const result = evaluateQueueItem(item, importConfig, now);
		expect(result).not.toBeNull();
		expect(result!.rule).toBe("import_blocked");
		expect(result!.reason).toContain("safe to remove");
	});

	it("catches importBlocked items with UNRECOGNIZED status messages at safe level", () => {
		// This was the primary bug: unrecognized messages caused silent drop
		const item = makeQueueItem({
			trackedDownloadState: "importBlocked",
			statusMessages: [
				{
					title: "Some completely unexpected Radarr error",
					messages: ["Unable to process import for unknown reason"],
				},
			],
		});
		const config = baseConfig({
			importPendingEnabled: true,
			importBlockCleanupLevel: "safe",
		} as Partial<QueueCleanerConfig>);
		const result = evaluateQueueItem(item, config, now);
		expect(result).not.toBeNull();
		expect(result!.rule).toBe("import_blocked");
		expect(result!.reason).toContain("Import blocked");
	});

	it("catches importBlocked items with NO status messages at all", () => {
		const item = makeQueueItem({
			trackedDownloadState: "importBlocked",
			statusMessages: [],
			errorMessage: null,
		});
		const result = evaluateQueueItem(item, importConfig, now);
		expect(result).not.toBeNull();
		expect(result!.rule).toBe("import_blocked");
		expect(result!.reason).toContain("requires manual intervention");
	});

	it("catches importBlocked with review keyword at moderate level", () => {
		const item = makeQueueItem({
			trackedDownloadState: "importBlocked",
			statusMessages: [{ title: "Automatic import is not possible", messages: [] }],
		});
		const config = baseConfig({
			importPendingEnabled: true,
			importBlockCleanupLevel: "moderate",
		} as Partial<QueueCleanerConfig>);
		const result = evaluateQueueItem(item, config, now);
		expect(result).not.toBeNull();
		expect(result!.rule).toBe("import_blocked");
		expect(result!.reason).toContain("needs review");
	});

	it("catches importBlocked with technical keyword at aggressive level", () => {
		const item = makeQueueItem({
			trackedDownloadState: "importBlocked",
			statusMessages: [{ title: "Unpack required", messages: [] }],
		});
		const config = baseConfig({
			importPendingEnabled: true,
			importBlockCleanupLevel: "aggressive",
		} as Partial<QueueCleanerConfig>);
		const result = evaluateQueueItem(item, config, now);
		expect(result).not.toBeNull();
		expect(result!.rule).toBe("import_blocked");
		expect(result!.reason).toContain("technical");
	});

	it("does NOT catch importBlocked when importPendingEnabled is false", () => {
		const item = makeQueueItem({
			trackedDownloadState: "importBlocked",
			statusMessages: [{ title: "Already exists", messages: [] }],
		});
		const config = baseConfig({
			importPendingEnabled: false,
		} as Partial<QueueCleanerConfig>);
		const result = evaluateQueueItem(item, config, now);
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Tests: failedPending Detection (Issue #129 — Secondary Bug)
// ---------------------------------------------------------------------------

describe("evaluateQueueItem: failedPending detection", () => {
	it("catches failedPending items when importPendingEnabled is true and failedEnabled is false", () => {
		const item = makeQueueItem({
			trackedDownloadState: "failedPending",
			trackedDownloadStatus: "warning",
			statusMessages: [{ title: "Import failed, will retry", messages: [] }],
		});
		const config = baseConfig({
			failedEnabled: false,
			importPendingEnabled: true,
		} as Partial<QueueCleanerConfig>);
		const result = evaluateQueueItem(item, config, now);
		expect(result).not.toBeNull();
		expect(result!.rule).toBe("import_blocked");
		expect(result!.reason).toContain("pending retry");
	});

	it("catches failedPending by the failed rule when failedEnabled is true", () => {
		const item = makeQueueItem({
			trackedDownloadState: "failedPending",
			trackedDownloadStatus: "error",
		});
		const config = baseConfig({ failedEnabled: true });
		const result = evaluateQueueItem(item, config, now);
		expect(result).not.toBeNull();
		// failedEnabled catches it first via trackedState.includes("failed")
		expect(result!.rule).toBe("failed");
	});

	it("catches failedPending with no status messages via fallback", () => {
		const item = makeQueueItem({
			trackedDownloadState: "failedPending",
			trackedDownloadStatus: "warning",
			statusMessages: [],
			errorMessage: null,
		});
		const config = baseConfig({
			failedEnabled: false,
			importPendingEnabled: true,
		} as Partial<QueueCleanerConfig>);
		const result = evaluateQueueItem(item, config, now);
		expect(result).not.toBeNull();
		expect(result!.rule).toBe("import_blocked");
		expect(result!.reason).toContain("import failed, pending retry");
	});
});

// ---------------------------------------------------------------------------
// Tests: Import Pending Detection
// ---------------------------------------------------------------------------

describe("evaluateQueueItem: importPending detection", () => {
	it("skips recoverable importPending items (extracting/processing)", () => {
		const item = makeQueueItem({
			trackedDownloadState: "importPending",
			statusMessages: [{ title: "Extracting archive", messages: [] }],
		});
		const config = baseConfig({
			importPendingEnabled: true,
		} as Partial<QueueCleanerConfig>);
		const result = evaluateQueueItem(item, config, now);
		expect(result).toBeNull();
	});

	it("catches old importPending items via time threshold", () => {
		const item = makeQueueItem({
			trackedDownloadState: "importPending",
			added: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
			statusMessages: [{ title: "Some unfamiliar status", messages: [] }],
		});
		const config = baseConfig({
			importPendingEnabled: true,
			importPendingThresholdMins: 60,
		} as Partial<QueueCleanerConfig>);
		const result = evaluateQueueItem(item, config, now);
		expect(result).not.toBeNull();
		expect(result!.rule).toBe("import_pending");
	});

	it("does NOT catch recent importPending items without matching keywords", () => {
		const item = makeQueueItem({
			trackedDownloadState: "importPending",
			added: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 mins ago
			statusMessages: [{ title: "Some status", messages: [] }],
		});
		const config = baseConfig({
			importPendingEnabled: true,
			importPendingThresholdMins: 60,
			importBlockCleanupLevel: "safe",
		} as Partial<QueueCleanerConfig>);
		const result = evaluateQueueItem(item, config, now);
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Tests: Normal downloading items (should NOT be flagged)
// ---------------------------------------------------------------------------

describe("evaluateQueueItem: healthy items not flagged", () => {
	it("does NOT flag a normal downloading item", () => {
		const item = makeQueueItem({
			trackedDownloadState: "downloading",
			trackedDownloadStatus: "ok",
			sizeleft: 2_500_000_000,
		});
		const config = baseConfig({ importPendingEnabled: true } as Partial<QueueCleanerConfig>);
		const result = evaluateQueueItem(item, config, now);
		expect(result).toBeNull();
	});

	it("does NOT flag a successfully imported item", () => {
		const item = makeQueueItem({
			trackedDownloadState: "imported",
			trackedDownloadStatus: "ok",
		});
		const config = baseConfig({
			importPendingEnabled: true,
			failedEnabled: true,
			stalledEnabled: true,
		} as Partial<QueueCleanerConfig>);
		const result = evaluateQueueItem(item, config, now);
		expect(result).toBeNull();
	});

	it("does NOT flag an item currently importing", () => {
		const item = makeQueueItem({
			trackedDownloadState: "importing",
			trackedDownloadStatus: "ok",
		});
		const config = baseConfig({ importPendingEnabled: true } as Partial<QueueCleanerConfig>);
		const result = evaluateQueueItem(item, config, now);
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Tests: Failed rule (trackedDownloadState variations)
// ---------------------------------------------------------------------------

describe("evaluateQueueItem: failed rule", () => {
	it("catches items with trackedDownloadState 'failed'", () => {
		const item = makeQueueItem({
			trackedDownloadState: "failed",
			trackedDownloadStatus: "error",
		});
		const config = baseConfig({ failedEnabled: true });
		const result = evaluateQueueItem(item, config, now);
		expect(result).not.toBeNull();
		expect(result!.rule).toBe("failed");
	});

	it("catches items with trackedDownloadStatus 'error'", () => {
		const item = makeQueueItem({
			trackedDownloadState: "downloading",
			trackedDownloadStatus: "error",
		});
		const config = baseConfig({ failedEnabled: true });
		const result = evaluateQueueItem(item, config, now);
		expect(result).not.toBeNull();
		expect(result!.rule).toBe("failed");
	});

	it("catches items with failure keywords in statusMessages", () => {
		const item = makeQueueItem({
			trackedDownloadState: "downloading",
			trackedDownloadStatus: "warning",
			statusMessages: [{ title: "Download cannot be imported", messages: [] }],
		});
		const config = baseConfig({ failedEnabled: true });
		const result = evaluateQueueItem(item, config, now);
		expect(result).not.toBeNull();
		expect(result!.rule).toBe("failed");
	});
});

// ---------------------------------------------------------------------------
// Tests: evaluateImportBlockState directly
// ---------------------------------------------------------------------------

describe("evaluateImportBlockState", () => {
	it("returns null for safe level with review keywords", () => {
		const result = evaluateImportBlockState(
			["Automatic import is not possible"],
			baseConfig({ importBlockCleanupLevel: "safe" } as Partial<QueueCleanerConfig>),
			"blocked",
		);
		expect(result).toBeNull();
	});

	it("returns match for moderate level with review keywords", () => {
		const result = evaluateImportBlockState(
			["Automatic import is not possible"],
			baseConfig({ importBlockCleanupLevel: "moderate" } as Partial<QueueCleanerConfig>),
			"blocked",
		);
		expect(result).not.toBeNull();
		expect(result!.reason).toContain("needs review");
	});

	it("returns null for safe level with technical keywords", () => {
		const result = evaluateImportBlockState(
			["Unpack required"],
			baseConfig({ importBlockCleanupLevel: "safe" } as Partial<QueueCleanerConfig>),
			"blocked",
		);
		expect(result).toBeNull();
	});

	it("returns match for aggressive level with technical keywords", () => {
		const result = evaluateImportBlockState(
			["Unpack required"],
			baseConfig({ importBlockCleanupLevel: "aggressive" } as Partial<QueueCleanerConfig>),
			"blocked",
		);
		expect(result).not.toBeNull();
		expect(result!.reason).toContain("technical");
	});

	it("returns generic match for moderate level with unrecognized text", () => {
		const result = evaluateImportBlockState(
			["Some completely unknown error"],
			baseConfig({ importBlockCleanupLevel: "moderate" } as Partial<QueueCleanerConfig>),
			"blocked",
		);
		expect(result).not.toBeNull();
		expect(result!.reason).toContain("Some completely unknown error");
	});

	it("returns null for safe level with unrecognized text (no fallback in this function)", () => {
		const result = evaluateImportBlockState(
			["Some completely unknown error"],
			baseConfig({ importBlockCleanupLevel: "safe" } as Partial<QueueCleanerConfig>),
			"blocked",
		);
		// evaluateImportBlockState itself returns null; the caller (evaluateQueueItem) provides the fallback
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Tests: Custom import block patterns
// ---------------------------------------------------------------------------

describe("matchesCustomImportBlockPatterns", () => {
	it("matches case-insensitively", () => {
		const result = matchesCustomImportBlockPatterns(
			["File Is Already In Library"],
			["already in library"],
		);
		expect(result.matched).toBe(true);
	});

	it("returns false when no patterns match", () => {
		const result = matchesCustomImportBlockPatterns(["Some status text"], ["completely different"]);
		expect(result.matched).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Tests: calculateQueueSummary (importBlocked counting)
// ---------------------------------------------------------------------------

describe("calculateQueueSummary", () => {
	it("counts importBlocked items under importPending", () => {
		const records: RawQueueItem[] = [
			makeQueueItem({
				id: 1,
				trackedDownloadState: "importBlocked",
				trackedDownloadStatus: "warning",
			}),
			makeQueueItem({ id: 2, trackedDownloadState: "importPending", trackedDownloadStatus: "ok" }),
			makeQueueItem({
				id: 3,
				trackedDownloadState: "downloading",
				trackedDownloadStatus: "ok",
				sizeleft: 1000,
			}),
		];
		const summary = calculateQueueSummary(records);
		expect(summary.totalItems).toBe(3);
		expect(summary.importPending).toBe(2); // importBlocked + importPending
		expect(summary.downloading).toBe(1);
	});

	it("counts failedPending items under failed", () => {
		const records: RawQueueItem[] = [
			makeQueueItem({
				id: 1,
				trackedDownloadState: "failedPending",
				trackedDownloadStatus: "warning",
			}),
			makeQueueItem({ id: 2, trackedDownloadState: "failed", trackedDownloadStatus: "error" }),
		];
		const summary = calculateQueueSummary(records);
		expect(summary.failed).toBe(2); // both contain "failed"
	});

	it("handles empty queue", () => {
		const summary = calculateQueueSummary([]);
		expect(summary.totalItems).toBe(0);
		expect(summary.downloading).toBe(0);
		expect(summary.importPending).toBe(0);
		expect(summary.failed).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Tests: collectStatusTexts
// ---------------------------------------------------------------------------

describe("collectStatusTexts", () => {
	it("collects title and messages from statusMessages", () => {
		const item = makeQueueItem({
			statusMessages: [
				{ title: "Error Title", messages: ["Detail 1", "Detail 2"] },
				{ title: "Another Error", messages: [] },
			],
			errorMessage: "Global error",
		});
		const texts = collectStatusTexts(item);
		expect(texts).toEqual(["Error Title", "Detail 1", "Detail 2", "Another Error", "Global error"]);
	});

	it("handles missing/empty fields gracefully", () => {
		const item = makeQueueItem({
			statusMessages: [],
			errorMessage: null,
		});
		const texts = collectStatusTexts(item);
		expect(texts).toEqual([]);
	});

	it("handles malformed statusMessages entries", () => {
		const item = makeQueueItem({
			statusMessages: [null, undefined, { title: "Valid", messages: [123, null, "Valid msg"] }],
		});
		const texts = collectStatusTexts(item);
		expect(texts).toEqual(["Valid", "Valid msg"]);
	});
});

// ---------------------------------------------------------------------------
// Tests: Real-world Radarr scenarios
// ---------------------------------------------------------------------------

describe("real-world Radarr queue scenarios", () => {
	it("Radarr: movie with import error — 'no video files found'", () => {
		const item = makeQueueItem({
			trackedDownloadState: "importBlocked",
			trackedDownloadStatus: "warning",
			statusMessages: [
				{
					title:
						"No video files were found. If using a download client, ensure the download completed.",
					messages: ["No video files found in '/downloads/completed/Test.Movie.2024.1080p'"],
				},
			],
		});
		const config = baseConfig({
			importPendingEnabled: true,
			importBlockCleanupLevel: "safe",
		} as Partial<QueueCleanerConfig>);
		const result = evaluateQueueItem(item, config, now);
		expect(result).not.toBeNull();
		expect(result!.rule).toBe("import_blocked");
		// "no video files" is a safe keyword
		expect(result!.reason).toContain("safe to remove");
	});

	it("Radarr: movie with 'not an upgrade' import block", () => {
		const item = makeQueueItem({
			trackedDownloadState: "importBlocked",
			trackedDownloadStatus: "warning",
			statusMessages: [
				{
					title: "Not an upgrade for existing movie file(s)",
					messages: ["Existing file quality: Bluray-1080p - Score: 1250"],
				},
			],
		});
		const config = baseConfig({
			importPendingEnabled: true,
			importBlockCleanupLevel: "safe",
		} as Partial<QueueCleanerConfig>);
		const result = evaluateQueueItem(item, config, now);
		expect(result).not.toBeNull();
		expect(result!.rule).toBe("import_blocked");
		expect(result!.reason).toContain("safe to remove");
	});

	it("Radarr: movie with unknown import error (the actual #129 scenario)", () => {
		// This represents the user's exact scenario — import error with a message
		// we haven't anticipated, at the default "safe" cleanup level
		const item = makeQueueItem({
			trackedDownloadState: "importBlocked",
			trackedDownloadStatus: "warning",
			statusMessages: [
				{
					title: "Couldn't import movie",
					messages: ["Movie match is not close enough"],
				},
			],
		});
		const config = baseConfig({
			importPendingEnabled: true,
			importBlockCleanupLevel: "safe",
		} as Partial<QueueCleanerConfig>);
		const result = evaluateQueueItem(item, config, now);
		// Before fix: result would be null (silent drop!)
		// After fix: caught by the importBlocked state fallback
		expect(result).not.toBeNull();
		expect(result!.rule).toBe("import_blocked");
		expect(result!.reason).toContain("Import blocked");
	});

	it("Radarr: completed download seeding normally — NOT flagged", () => {
		const item = makeQueueItem({
			trackedDownloadState: "importing",
			trackedDownloadStatus: "ok",
			sizeleft: 0,
		});
		const config = baseConfig({
			importPendingEnabled: true,
			failedEnabled: true,
		} as Partial<QueueCleanerConfig>);
		const result = evaluateQueueItem(item, config, now);
		expect(result).toBeNull();
	});
});
