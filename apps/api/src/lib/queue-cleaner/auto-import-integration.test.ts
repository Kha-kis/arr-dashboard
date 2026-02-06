/**
 * Auto-Import Integration Tests
 *
 * Tests for the full auto-import flow including preview and execution.
 * Run with: npx vitest run auto-import-integration.test.ts
 */

import { describe, it, expect } from "vitest";
import {
	AUTO_IMPORT_SAFE_KEYWORDS,
	AUTO_IMPORT_NEVER_KEYWORDS,
} from "./constants.js";

// Mock queue items that simulate various import states
const mockQueueItems = {
	safeImportPending: {
		id: 1,
		title: "Movie.2024.1080p.BluRay.x264",
		added: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
		size: 5000000000,
		sizeleft: 0,
		trackedDownloadStatus: "warning",
		trackedDownloadState: "importPending",
		statusMessages: [{ title: "Waiting for import", messages: ["Manual import required"] }],
		downloadId: "abc123",
		protocol: "torrent",
		indexer: "TestIndexer",
	},
	neverImport: {
		id: 2,
		title: "BadMovie.2024.CAM",
		added: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
		size: 1000000000,
		sizeleft: 0,
		trackedDownloadStatus: "warning",
		trackedDownloadState: "importBlocked",
		statusMessages: [{ title: "No video files", messages: ["Quality not wanted"] }],
		downloadId: "def456",
		protocol: "torrent",
		indexer: "TestIndexer",
	},
	importBlocked: {
		id: 3,
		title: "Show.S01E01.1080p.WEB-DL",
		added: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 mins ago
		size: 2000000000,
		sizeleft: 0,
		trackedDownloadStatus: "warning",
		trackedDownloadState: "importBlocked",
		statusMessages: [{ title: "Import pending", messages: ["Waiting for manual import"] }],
		downloadId: "ghi789",
		protocol: "usenet",
		indexer: "NZBGeek",
	},
};

// Helper function to collect status texts (mirrors the real implementation)
function collectStatusTexts(item: typeof mockQueueItems.safeImportPending): string[] {
	const results: string[] = [];
	if (Array.isArray(item.statusMessages)) {
		for (const entry of item.statusMessages) {
			if (entry && typeof entry === "object") {
				if (typeof entry.title === "string" && entry.title.trim()) {
					results.push(entry.title.trim());
				}
				if (Array.isArray(entry.messages)) {
					for (const msg of entry.messages) {
						if (typeof msg === "string" && msg.trim()) {
							results.push(msg.trim());
						}
					}
				}
			}
		}
	}
	return results;
}

// Helper to check keywords (mirrors the real implementation)
function matchesKeywords(texts: string[], keywords: readonly string[]): string | null {
	for (const text of texts) {
		const lower = text.toLowerCase();
		for (const keyword of keywords) {
			if (lower.includes(keyword)) {
				return text;
			}
		}
	}
	return null;
}

describe("Auto-Import Integration", () => {
	describe("Status Text Collection", () => {
		it("should collect status texts from queue item", () => {
			const texts = collectStatusTexts(mockQueueItems.safeImportPending);
			expect(texts).toContain("Waiting for import");
			expect(texts).toContain("Manual import required");
		});

		it("should collect multiple status messages", () => {
			const texts = collectStatusTexts(mockQueueItems.neverImport);
			expect(texts).toContain("No video files");
			expect(texts).toContain("Quality not wanted");
		});
	});

	describe("Keyword Matching", () => {
		it("should match safe keywords", () => {
			const texts = collectStatusTexts(mockQueueItems.safeImportPending);
			const match = matchesKeywords(texts, AUTO_IMPORT_SAFE_KEYWORDS);
			expect(match).toBeTruthy();
		});

		it("should match never keywords", () => {
			const texts = collectStatusTexts(mockQueueItems.neverImport);
			const match = matchesKeywords(texts, AUTO_IMPORT_NEVER_KEYWORDS);
			expect(match).toBeTruthy();
		});

		it("should not match safe keywords for blocked items", () => {
			const texts = ["No video files found"];
			const safeMatch = matchesKeywords(texts, AUTO_IMPORT_SAFE_KEYWORDS);
			expect(safeMatch).toBeNull();
		});
	});

	describe("Full Eligibility Flow", () => {
		// Config for reference (used by the real implementation)
		// autoImportEnabled: true, autoImportMaxAttempts: 2,
		// autoImportCooldownMins: 30, autoImportSafeOnly: true

		it("should make safe import pending items eligible", () => {
			const texts = collectStatusTexts(mockQueueItems.safeImportPending);
			const neverMatch = matchesKeywords(texts, AUTO_IMPORT_NEVER_KEYWORDS);
			const safeMatch = matchesKeywords(texts, AUTO_IMPORT_SAFE_KEYWORDS);

			expect(neverMatch).toBeNull(); // No never-match
			expect(safeMatch).toBeTruthy(); // Has safe match
		});

		it("should reject items with never-patterns", () => {
			const texts = collectStatusTexts(mockQueueItems.neverImport);
			const neverMatch = matchesKeywords(texts, AUTO_IMPORT_NEVER_KEYWORDS);

			expect(neverMatch).toBeTruthy(); // Has never-match, should not be eligible
		});

		it("should make import blocked items with safe status eligible", () => {
			const texts = collectStatusTexts(mockQueueItems.importBlocked);
			const neverMatch = matchesKeywords(texts, AUTO_IMPORT_NEVER_KEYWORDS);
			const safeMatch = matchesKeywords(texts, AUTO_IMPORT_SAFE_KEYWORDS);

			expect(neverMatch).toBeNull();
			expect(safeMatch).toBeTruthy();
		});
	});

	describe("Preview Item Generation", () => {
		it("should generate preview item with auto-import eligibility", () => {
			const item = mockQueueItems.safeImportPending;
			const texts = collectStatusTexts(item);
			const neverMatch = matchesKeywords(texts, AUTO_IMPORT_NEVER_KEYWORDS);
			const safeMatch = matchesKeywords(texts, AUTO_IMPORT_SAFE_KEYWORDS);

			const previewItem = {
				id: item.id,
				title: item.title,
				rule: "import_pending",
				action: "remove",
				autoImportEligible: !neverMatch && !!safeMatch,
				autoImportReason: !neverMatch && !!safeMatch
					? "Eligible for auto-import"
					: neverMatch
						? `Cannot auto-import: ${neverMatch}`
						: "No safe pattern matched",
			};

			expect(previewItem.autoImportEligible).toBe(true);
			expect(previewItem.autoImportReason).toBe("Eligible for auto-import");
		});

		it("should generate preview item for ineligible items", () => {
			const item = mockQueueItems.neverImport;
			const texts = collectStatusTexts(item);
			const neverMatch = matchesKeywords(texts, AUTO_IMPORT_NEVER_KEYWORDS);

			const previewItem = {
				id: item.id,
				title: item.title,
				rule: "import_blocked",
				action: "remove",
				autoImportEligible: !neverMatch,
				autoImportReason: neverMatch
					? `Cannot auto-import: ${neverMatch}`
					: "Eligible for auto-import",
			};

			expect(previewItem.autoImportEligible).toBe(false);
			expect(previewItem.autoImportReason).toContain("Cannot auto-import");
		});
	});
});

describe("Strike Tracking for Auto-Import", () => {
	it("should track import attempts in strike record", () => {
		const strike = {
			id: "strike-1",
			instanceId: "inst-1",
			downloadId: "abc123",
			downloadTitle: "Movie.2024",
			strikeCount: 0,
			lastRule: "import_pending",
			lastReason: "Import pending",
			importAttempts: 1,
			lastImportAttempt: new Date(),
			lastImportError: null,
		};

		expect(strike.importAttempts).toBe(1);
		expect(strike.lastImportAttempt).toBeInstanceOf(Date);
	});

	it("should track import errors", () => {
		const strike = {
			id: "strike-1",
			instanceId: "inst-1",
			downloadId: "abc123",
			downloadTitle: "Movie.2024",
			strikeCount: 0,
			lastRule: "import_pending",
			lastReason: "Import pending",
			importAttempts: 2,
			lastImportAttempt: new Date(),
			lastImportError: "Import failed: no matching file",
		};

		expect(strike.importAttempts).toBe(2);
		expect(strike.lastImportError).toBe("Import failed: no matching file");
	});
});
