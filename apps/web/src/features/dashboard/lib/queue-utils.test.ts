/**
 * Unit tests for queue-utils.ts
 *
 * Tests the core utility functions for queue management including:
 * - Problematic item detection (analyzeQueueItem)
 * - Status message collection and summarization
 * - Progress calculation
 * - Key generation and grouping
 */

import { describe, it, expect } from "vitest";
import type { QueueItem } from "@arr/shared";
import {
	buildKey,
	getGroupKey,
	deriveTitle,
	sumNumbers,
	resolveMessageTone,
	looksLikeReleaseName,
	collectStatusLines,
	summarizeLines,
	summarizeIssueCounts,
	computeProgressValue,
	formatSizeGB,
	analyzeQueueItem,
	filterProblematicItems,
	getProblematicCounts,
	getProblematicCount,
	ISSUE_TYPE_LABELS,
} from "./queue-utils";

// Helper to create minimal QueueItem for testing
const createQueueItem = (overrides: Partial<QueueItem> = {}): QueueItem => ({
	id: 1,
	service: "sonarr",
	instanceId: "instance-1",
	instanceName: "Sonarr 1",
	title: "Test Item",
	status: "downloading",
	size: 1000000000,
	sizeleft: 500000000,
	...overrides,
});

// =============================================================================
// buildKey
// =============================================================================
describe("buildKey", () => {
	it("should create unique key from service, instanceId, and id", () => {
		const item = createQueueItem({
			service: "sonarr",
			instanceId: "inst-1",
			id: 123,
		});
		expect(buildKey(item)).toBe("sonarr:inst-1:123");
	});

	it("should handle radarr service", () => {
		const item = createQueueItem({
			service: "radarr",
			instanceId: "radarr-2",
			id: 456,
		});
		expect(buildKey(item)).toBe("radarr:radarr-2:456");
	});
});

// =============================================================================
// getGroupKey
// =============================================================================
describe("getGroupKey", () => {
	it("should return download-based key when downloadId exists", () => {
		const item = createQueueItem({
			service: "sonarr",
			instanceId: "inst-1",
			downloadId: "dl-abc-123",
		});
		expect(getGroupKey(item)).toBe("sonarr:inst-1:download:dl-abc-123");
	});

	it("should return series-based key for sonarr with seriesId", () => {
		const item = createQueueItem({
			service: "sonarr",
			instanceId: "inst-1",
			seriesId: 42,
			protocol: "torrent",
			downloadClient: "qBittorrent",
		});
		expect(getGroupKey(item)).toBe("sonarr:inst-1:series:42:torrent:qBittorrent");
	});

	it("should return null for radarr without downloadId", () => {
		const item = createQueueItem({
			service: "radarr",
			instanceId: "inst-1",
			downloadId: undefined,
		});
		expect(getGroupKey(item)).toBeNull();
	});

	it("should handle missing protocol gracefully", () => {
		const item = createQueueItem({
			service: "sonarr",
			instanceId: "inst-1",
			seriesId: 42,
			protocol: undefined,
			downloadProtocol: undefined,
			downloadClient: undefined,
		});
		expect(getGroupKey(item)).toBe("sonarr:inst-1:series:42:unknown:unknown");
	});
});

// =============================================================================
// deriveTitle
// =============================================================================
describe("deriveTitle", () => {
	it("should return series title when available", () => {
		const items = [createQueueItem({ series: { title: "Breaking Bad" } })];
		expect(deriveTitle(items)).toBe("Breaking Bad");
	});

	it("should return movie title when available", () => {
		const items = [createQueueItem({ movie: { title: "Inception" } })];
		expect(deriveTitle(items)).toBe("Inception");
	});

	it("should fall back to item title", () => {
		const items = [createQueueItem({ title: "Generic Title" })];
		expect(deriveTitle(items)).toBe("Generic Title");
	});

	it("should fall back to instanceName", () => {
		const items = [createQueueItem({ title: undefined, instanceName: "Sonarr 1" })];
		expect(deriveTitle(items)).toBe("Sonarr 1");
	});

	it("should return 'Queue group' for empty array", () => {
		expect(deriveTitle([])).toBe("Queue group");
	});
});

// =============================================================================
// sumNumbers
// =============================================================================
describe("sumNumbers", () => {
	it("should sum valid numbers", () => {
		expect(sumNumbers([1, 2, 3, 4, 5])).toBe(15);
	});

	it("should filter out undefined values", () => {
		expect(sumNumbers([1, undefined, 3, undefined, 5])).toBe(9);
	});

	it("should filter out NaN and Infinity", () => {
		expect(sumNumbers([1, Number.NaN, 3, Number.POSITIVE_INFINITY, 5])).toBe(9);
	});

	it("should return 0 for empty array", () => {
		expect(sumNumbers([])).toBe(0);
	});
});

// =============================================================================
// resolveMessageTone
// =============================================================================
describe("resolveMessageTone", () => {
	it("should return 'error' for error keywords", () => {
		expect(resolveMessageTone("Download failed")).toBe("error");
		expect(resolveMessageTone("Error: connection refused")).toBe("error");
		expect(resolveMessageTone("Access denied")).toBe("error");
		expect(resolveMessageTone("Invalid response")).toBe("error");
		expect(resolveMessageTone("Unauthorized access")).toBe("error");
	});

	it("should return 'warning' for warning keywords", () => {
		expect(resolveMessageTone("Download stalled")).toBe("warning");
		expect(resolveMessageTone("Will retry later")).toBe("warning");
		expect(resolveMessageTone("File missing")).toBe("warning");
		expect(resolveMessageTone("Connection timeout")).toBe("warning");
		expect(resolveMessageTone("Pending verification")).toBe("warning");
	});

	it("should return 'info' for neutral messages", () => {
		expect(resolveMessageTone("Downloading at 5MB/s")).toBe("info");
		expect(resolveMessageTone("Completed successfully")).toBe("info");
		expect(resolveMessageTone("Seeding to 10 peers")).toBe("info");
	});

	it("should be case-insensitive", () => {
		expect(resolveMessageTone("ERROR: something went wrong")).toBe("error");
		expect(resolveMessageTone("WARNING: low disk space")).toBe("warning");
	});
});

// =============================================================================
// looksLikeReleaseName
// =============================================================================
describe("looksLikeReleaseName", () => {
	it("should detect TV episode patterns", () => {
		expect(looksLikeReleaseName("Show.Name.S01E05.720p.WEB-DL.x264")).toBe(true);
		expect(looksLikeReleaseName("Series.S12E100.1080p.AMZN.WEB.DL")).toBe(true);
	});

	it("should detect movie quality patterns", () => {
		expect(looksLikeReleaseName("Movie.2024.2160p.BluRay.x265")).toBe(true);
		expect(looksLikeReleaseName("Film.1080p.WEBRip.x264")).toBe(true);
	});

	it("should reject non-release strings", () => {
		expect(looksLikeReleaseName("Download failed")).toBe(false);
		expect(looksLikeReleaseName("Error message")).toBe(false);
		expect(looksLikeReleaseName("")).toBe(false);
	});

	it("should require enough segments OR no spaces for release names", () => {
		// Short but valid (no spaces + has tokens)
		expect(looksLikeReleaseName("S01E01.720p")).toBe(true);
		// Longer release name
		expect(looksLikeReleaseName("Show.S01E01.720p.WEB")).toBe(true);
		// Has tokens but includes spaces - need 4+ segments
		expect(looksLikeReleaseName("Show Name S01E01 720p")).toBe(false);
	});
});

// =============================================================================
// collectStatusLines
// =============================================================================
describe("collectStatusLines", () => {
	it("should collect status message titles", () => {
		const item = createQueueItem({
			statusMessages: [{ title: "Download Warning", messages: [] }],
		});
		const lines = collectStatusLines(item);
		expect(lines).toHaveLength(1);
		expect(lines[0]?.text).toBe("Download Warning");
	});

	it("should collect status message details", () => {
		const item = createQueueItem({
			statusMessages: [
				{
					title: "Import Problem",
					messages: ["No files found", "Unable to match"],
				},
			],
		});
		const lines = collectStatusLines(item);
		expect(lines).toHaveLength(3);
		expect(lines.map((l) => l.text)).toEqual(["Import Problem", "No files found", "Unable to match"]);
	});

	it("should collect error messages", () => {
		const item = createQueueItem({
			errorMessage: "Connection refused",
		});
		const lines = collectStatusLines(item);
		expect(lines).toHaveLength(1);
		expect(lines[0]?.text).toBe("Connection refused");
		expect(lines[0]?.tone).toBe("error");
	});

	it("should handle empty statusMessages", () => {
		const item = createQueueItem({ statusMessages: [] });
		expect(collectStatusLines(item)).toEqual([]);
	});
});

// =============================================================================
// summarizeLines
// =============================================================================
describe("summarizeLines", () => {
	it("should count duplicate messages", () => {
		const lines = [
			{ key: "1", text: "No files found", tone: "warning" as const },
			{ key: "2", text: "No files found", tone: "warning" as const },
			{ key: "3", text: "No files found", tone: "warning" as const },
		];
		const summary = summarizeLines(lines);
		expect(summary).toHaveLength(1);
		expect(summary[0]?.count).toBe(3);
	});

	it("should filter out release names", () => {
		const lines = [
			{ key: "1", text: "Download failed", tone: "error" as const },
			{ key: "2", text: "Show.S01E05.720p.WEB-DL.x264", tone: "info" as const },
		];
		const summary = summarizeLines(lines);
		expect(summary).toHaveLength(1);
		expect(summary[0]?.text).toBe("Download failed");
	});

	it("should filter out file extensions", () => {
		const lines = [
			{ key: "1", text: "video.mkv", tone: "info" as const },
			{ key: "2", text: "archive.rar", tone: "info" as const },
			{ key: "3", text: "Actual message", tone: "warning" as const },
		];
		const summary = summarizeLines(lines);
		expect(summary).toHaveLength(1);
		expect(summary[0]?.text).toBe("Actual message");
	});

	it("should escalate tone when duplicates have different tones", () => {
		const lines = [
			{ key: "1", text: "Connection issue", tone: "info" as const },
			{ key: "2", text: "Connection issue", tone: "warning" as const },
			{ key: "3", text: "Connection issue", tone: "error" as const },
		];
		const summary = summarizeLines(lines);
		expect(summary[0]?.tone).toBe("error");
	});
});

// =============================================================================
// summarizeIssueCounts
// =============================================================================
describe("summarizeIssueCounts", () => {
	it("should count issues by tone", () => {
		const lines = [
			{ key: "1", text: "Error one", tone: "error" as const },
			{ key: "2", text: "Error two", tone: "error" as const },
			{ key: "3", text: "Warning", tone: "warning" as const },
			{ key: "4", text: "Info", tone: "info" as const },
		];
		const counts = summarizeIssueCounts(lines);
		expect(counts).toContainEqual({ tone: "error", count: 2 });
		expect(counts).toContainEqual({ tone: "warning", count: 1 });
		expect(counts).toContainEqual({ tone: "info", count: 1 });
	});
});

// =============================================================================
// computeProgressValue
// =============================================================================
describe("computeProgressValue", () => {
	it("should calculate progress percentage", () => {
		const items = [createQueueItem({ size: 1000, sizeleft: 250 })];
		expect(computeProgressValue(items)).toBe(75);
	});

	it("should handle multiple items", () => {
		const items = [
			createQueueItem({ size: 1000, sizeleft: 500 }),
			createQueueItem({ size: 1000, sizeleft: 0 }),
		];
		// Total size: 2000, Total left: 500, Completed: 1500 = 75%
		expect(computeProgressValue(items)).toBe(75);
	});

	it("should return undefined for zero total size", () => {
		const items = [createQueueItem({ size: 0, sizeleft: 0 })];
		expect(computeProgressValue(items)).toBeUndefined();
	});

	it("should handle completed downloads", () => {
		const items = [createQueueItem({ size: 1000, sizeleft: 0 })];
		expect(computeProgressValue(items)).toBe(100);
	});
});

// =============================================================================
// formatSizeGB
// =============================================================================
describe("formatSizeGB", () => {
	it("should format bytes to GB", () => {
		expect(formatSizeGB(1073741824)).toBe("1.00 GB"); // 1 GB
		expect(formatSizeGB(5368709120)).toBe("5.00 GB"); // 5 GB
	});

	it("should return null for undefined", () => {
		expect(formatSizeGB(undefined)).toBeNull();
	});

	it("should handle small sizes", () => {
		expect(formatSizeGB(536870912)).toBe("0.50 GB"); // 0.5 GB
	});
});

// =============================================================================
// analyzeQueueItem - CRITICAL FUNCTION FOR BULK CLEAR
// =============================================================================
describe("analyzeQueueItem", () => {
	describe("stalled detection", () => {
		it("should detect stalled status", () => {
			const item = createQueueItem({ status: "Stalled" });
			const analysis = analyzeQueueItem(item);
			expect(analysis.isProblematic).toBe(true);
			expect(analysis.issueTypes).toContain("stalled");
			expect(analysis.canRetry).toBe(true);
		});

		it("should detect stalled keywords in messages", () => {
			const item = createQueueItem({
				statusMessages: [{ title: "Download has stalled", messages: [] }],
			});
			const analysis = analyzeQueueItem(item);
			expect(analysis.issueTypes).toContain("stalled");
		});
	});

	describe("failed import detection", () => {
		it("should detect importPending state", () => {
			const item = createQueueItem({
				trackedDownloadState: "importPending",
				downloadId: "dl-123",
			});
			const analysis = analyzeQueueItem(item);
			expect(analysis.isProblematic).toBe(true);
			expect(analysis.issueTypes).toContain("failed_import");
			expect(analysis.canManualImport).toBe(true);
		});

		it("should detect manual import keywords", () => {
			const item = createQueueItem({
				statusMessages: [
					{ title: "Manual import required", messages: ["Cannot be imported automatically"] },
				],
				downloadId: "dl-456",
			});
			const analysis = analyzeQueueItem(item);
			expect(analysis.issueTypes).toContain("failed_import");
		});
	});

	describe("download error detection", () => {
		it("should detect error in trackedDownloadStatus", () => {
			const item = createQueueItem({
				trackedDownloadStatus: "Error",
			});
			const analysis = analyzeQueueItem(item);
			expect(analysis.isProblematic).toBe(true);
			expect(analysis.issueTypes).toContain("download_error");
			expect(analysis.severity).toBe("error");
		});

		it("should detect failed status", () => {
			const item = createQueueItem({ status: "Failed" });
			const analysis = analyzeQueueItem(item);
			expect(analysis.issueTypes).toContain("download_error");
		});
	});

	describe("timeout detection", () => {
		it("should detect timeout keywords", () => {
			const item = createQueueItem({
				statusMessages: [{ title: "Connection timed out", messages: [] }],
			});
			const analysis = analyzeQueueItem(item);
			expect(analysis.issueTypes).toContain("timeout");
			expect(analysis.canRetry).toBe(true);
		});
	});

	describe("import error detection", () => {
		it("should detect import error", () => {
			const item = createQueueItem({
				statusMessages: [{ title: "Import failed: file corrupted", messages: [] }],
			});
			const analysis = analyzeQueueItem(item);
			expect(analysis.issueTypes).toContain("import_error");
			expect(analysis.severity).toBe("error");
		});
	});

	describe("missing files detection", () => {
		it("should detect no files found", () => {
			const item = createQueueItem({
				statusMessages: [{ title: "No files were found", messages: [] }],
			});
			const analysis = analyzeQueueItem(item);
			expect(analysis.issueTypes).toContain("missing_files");
		});
	});

	describe("severity levels", () => {
		it("should set error severity for errorMessage", () => {
			const item = createQueueItem({ errorMessage: "Critical failure" });
			const analysis = analyzeQueueItem(item);
			expect(analysis.severity).toBe("error");
		});

		it("should set warning severity for stalled", () => {
			const item = createQueueItem({ status: "Stalled" });
			const analysis = analyzeQueueItem(item);
			expect(analysis.severity).toBe("warning");
		});

		it("should stay info for non-problematic items", () => {
			const item = createQueueItem({ status: "Downloading" });
			const analysis = analyzeQueueItem(item);
			expect(analysis.severity).toBe("info");
			expect(analysis.isProblematic).toBe(false);
		});
	});

	describe("recommended actions", () => {
		it("should recommend manual_import for failed imports", () => {
			const item = createQueueItem({
				trackedDownloadState: "importPending",
				downloadId: "dl-123",
			});
			const analysis = analyzeQueueItem(item);
			expect(analysis.recommendedAction).toBe("manual_import");
		});

		it("should recommend retry for stalled downloads", () => {
			const item = createQueueItem({ status: "Stalled" });
			const analysis = analyzeQueueItem(item);
			expect(analysis.recommendedAction).toBe("retry");
		});

		it("should recommend blocklist for errors with missing files", () => {
			const item = createQueueItem({
				statusMessages: [{ title: "No files found on disk", messages: [] }],
			});
			const analysis = analyzeQueueItem(item);
			expect(analysis.recommendedAction).toBe("blocklist");
		});

		it("should return null for non-problematic items", () => {
			const item = createQueueItem({ status: "Downloading" });
			const analysis = analyzeQueueItem(item);
			expect(analysis.recommendedAction).toBeNull();
		});
	});
});

// =============================================================================
// filterProblematicItems
// =============================================================================
describe("filterProblematicItems", () => {
	it("should filter to only problematic items", () => {
		const items = [
			createQueueItem({ id: 1, status: "Downloading" }),
			createQueueItem({ id: 2, status: "Stalled" }),
			createQueueItem({ id: 3, status: "Failed" }),
			createQueueItem({ id: 4, status: "Completed" }),
		];
		const problematic = filterProblematicItems(items);
		expect(problematic).toHaveLength(2);
		expect(problematic.map((i) => i.id)).toEqual([2, 3]);
	});

	it("should return empty array when no problematic items", () => {
		const items = [
			createQueueItem({ status: "Downloading" }),
			createQueueItem({ status: "Completed" }),
		];
		expect(filterProblematicItems(items)).toEqual([]);
	});
});

// =============================================================================
// getProblematicCounts
// =============================================================================
describe("getProblematicCounts", () => {
	it("should count issues by type", () => {
		const items = [
			createQueueItem({ status: "Stalled" }),
			createQueueItem({ status: "Stalled" }),
			createQueueItem({ status: "Failed" }),
			createQueueItem({ trackedDownloadState: "importPending", downloadId: "dl-1" }),
		];
		const counts = getProblematicCounts(items);
		expect(counts.stalled).toBe(2);
		expect(counts.download_error).toBe(1);
		expect(counts.failed_import).toBe(1);
	});
});

// =============================================================================
// getProblematicCount
// =============================================================================
describe("getProblematicCount", () => {
	it("should count total problematic items", () => {
		const items = [
			createQueueItem({ status: "Downloading" }),
			createQueueItem({ status: "Stalled" }),
			createQueueItem({ status: "Failed" }),
		];
		expect(getProblematicCount(items)).toBe(2);
	});
});

// =============================================================================
// ISSUE_TYPE_LABELS
// =============================================================================
describe("ISSUE_TYPE_LABELS", () => {
	it("should have human-readable labels for all issue types", () => {
		expect(ISSUE_TYPE_LABELS.failed_import).toBe("Failed Import");
		expect(ISSUE_TYPE_LABELS.stalled).toBe("Stalled");
		expect(ISSUE_TYPE_LABELS.download_error).toBe("Download Error");
		expect(ISSUE_TYPE_LABELS.import_error).toBe("Import Error");
		expect(ISSUE_TYPE_LABELS.warning).toBe("Warning");
		expect(ISSUE_TYPE_LABELS.timeout).toBe("Timeout");
		expect(ISSUE_TYPE_LABELS.missing_files).toBe("Missing Files");
	});
});
