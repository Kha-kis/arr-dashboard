/**
 * Auto-Import Feature Tests
 *
 * Tests for the auto-import eligibility checker and related functions.
 * Run with: npx vitest run auto-import.test.ts
 */

import { describe, it, expect } from "vitest";
import {
	AUTO_IMPORT_SAFE_KEYWORDS,
	AUTO_IMPORT_NEVER_KEYWORDS,
} from "./constants.js";

// Helper to simulate the eligibility check logic
function evaluateAutoImportEligibility(
	statusTexts: string[],
	config: {
		autoImportEnabled: boolean;
		autoImportMaxAttempts: number;
		autoImportCooldownMins: number;
		autoImportSafeOnly: boolean;
	},
	existingStrike: {
		importAttempts: number;
		lastImportAttempt: Date | null;
	} | null,
	now: Date,
): { eligible: boolean; reason: string } {
	// Check master toggle
	if (!config.autoImportEnabled) {
		return { eligible: false, reason: "Auto-import disabled" };
	}

	// Check max attempts
	const attempts = existingStrike?.importAttempts ?? 0;
	if (attempts >= config.autoImportMaxAttempts) {
		return { eligible: false, reason: `Max attempts reached (${attempts}/${config.autoImportMaxAttempts})` };
	}

	// Check cooldown period
	if (existingStrike?.lastImportAttempt) {
		const cooldownMs = config.autoImportCooldownMins * 60 * 1000;
		const timeSinceLastAttempt = now.getTime() - existingStrike.lastImportAttempt.getTime();
		if (timeSinceLastAttempt < cooldownMs) {
			const remainingMins = Math.ceil((cooldownMs - timeSinceLastAttempt) / 60000);
			return { eligible: false, reason: `Cooldown active (${remainingMins}m remaining)` };
		}
	}

	// Check for patterns that should NEVER be auto-imported
	const allText = statusTexts.join(" ").toLowerCase();
	for (const keyword of AUTO_IMPORT_NEVER_KEYWORDS) {
		if (allText.includes(keyword)) {
			return { eligible: false, reason: `Cannot auto-import: ${keyword}` };
		}
	}

	// If "safe only" mode, check for safe patterns
	if (config.autoImportSafeOnly) {
		let safeMatch = false;
		for (const keyword of AUTO_IMPORT_SAFE_KEYWORDS) {
			if (allText.includes(keyword)) {
				safeMatch = true;
				break;
			}
		}
		if (!safeMatch) {
			return { eligible: false, reason: "No safe pattern matched (safeOnly mode)" };
		}
	}

	return { eligible: true, reason: "Eligible for auto-import" };
}

describe("Auto-Import Eligibility", () => {
	const now = new Date("2024-01-15T12:00:00Z");

	const defaultConfig = {
		autoImportEnabled: true,
		autoImportMaxAttempts: 2,
		autoImportCooldownMins: 30,
		autoImportSafeOnly: true,
	};

	describe("Master Toggle", () => {
		it("should reject when auto-import is disabled", () => {
			const result = evaluateAutoImportEligibility(
				["waiting for import"],
				{ ...defaultConfig, autoImportEnabled: false },
				null,
				now,
			);
			expect(result.eligible).toBe(false);
			expect(result.reason).toBe("Auto-import disabled");
		});
	});

	describe("Max Attempts", () => {
		it("should reject when max attempts reached", () => {
			const result = evaluateAutoImportEligibility(
				["waiting for import"],
				defaultConfig,
				{ importAttempts: 2, lastImportAttempt: null },
				now,
			);
			expect(result.eligible).toBe(false);
			expect(result.reason).toContain("Max attempts reached");
		});

		it("should allow when attempts are below max", () => {
			const result = evaluateAutoImportEligibility(
				["waiting for import"],
				defaultConfig,
				{ importAttempts: 1, lastImportAttempt: null },
				now,
			);
			expect(result.eligible).toBe(true);
		});
	});

	describe("Cooldown Period", () => {
		it("should reject when cooldown is active", () => {
			const lastAttempt = new Date(now.getTime() - 10 * 60 * 1000); // 10 mins ago
			const result = evaluateAutoImportEligibility(
				["waiting for import"],
				defaultConfig,
				{ importAttempts: 1, lastImportAttempt: lastAttempt },
				now,
			);
			expect(result.eligible).toBe(false);
			expect(result.reason).toContain("Cooldown active");
		});

		it("should allow when cooldown has expired", () => {
			const lastAttempt = new Date(now.getTime() - 60 * 60 * 1000); // 60 mins ago
			const result = evaluateAutoImportEligibility(
				["waiting for import"],
				defaultConfig,
				{ importAttempts: 1, lastImportAttempt: lastAttempt },
				now,
			);
			expect(result.eligible).toBe(true);
		});
	});

	describe("Never Keywords", () => {
		it("should reject items with 'no video files' status", () => {
			const result = evaluateAutoImportEligibility(
				["No video files found in download"],
				defaultConfig,
				null,
				now,
			);
			expect(result.eligible).toBe(false);
			expect(result.reason).toContain("no video files");
		});

		it("should reject items with 'quality not wanted' status", () => {
			const result = evaluateAutoImportEligibility(
				["Quality not wanted"],
				defaultConfig,
				null,
				now,
			);
			expect(result.eligible).toBe(false);
			expect(result.reason).toContain("quality not wanted");
		});

		it("should reject items with 'password protected' status", () => {
			const result = evaluateAutoImportEligibility(
				["Archive is password protected"],
				defaultConfig,
				null,
				now,
			);
			expect(result.eligible).toBe(false);
			expect(result.reason).toContain("password protected");
		});
	});

	describe("Safe Patterns (safeOnly mode)", () => {
		it("should allow 'waiting for import' status", () => {
			const result = evaluateAutoImportEligibility(
				["Waiting for import"],
				defaultConfig,
				null,
				now,
			);
			expect(result.eligible).toBe(true);
		});

		it("should allow 'manual import required' status", () => {
			const result = evaluateAutoImportEligibility(
				["Manual import required"],
				defaultConfig,
				null,
				now,
			);
			expect(result.eligible).toBe(true);
		});

		it("should reject unknown status in safeOnly mode", () => {
			const result = evaluateAutoImportEligibility(
				["Some unknown status message"],
				defaultConfig,
				null,
				now,
			);
			expect(result.eligible).toBe(false);
			expect(result.reason).toContain("No safe pattern matched");
		});

		it("should allow unknown status when safeOnly is disabled", () => {
			const result = evaluateAutoImportEligibility(
				["Some unknown status message"],
				{ ...defaultConfig, autoImportSafeOnly: false },
				null,
				now,
			);
			expect(result.eligible).toBe(true);
		});
	});

	describe("Combined Scenarios", () => {
		it("should reject when both safe and never patterns match (never wins)", () => {
			const result = evaluateAutoImportEligibility(
				["Waiting for import - no video files"],
				defaultConfig,
				null,
				now,
			);
			expect(result.eligible).toBe(false);
			expect(result.reason).toContain("no video files");
		});

		it("should allow first-time import with safe pattern", () => {
			const result = evaluateAutoImportEligibility(
				["Import pending - waiting for manual import"],
				defaultConfig,
				null,
				now,
			);
			expect(result.eligible).toBe(true);
		});
	});
});

describe("Keyword Arrays", () => {
	it("should have safe keywords defined", () => {
		expect(AUTO_IMPORT_SAFE_KEYWORDS.length).toBeGreaterThan(0);
		expect(AUTO_IMPORT_SAFE_KEYWORDS).toContain("waiting for import");
		expect(AUTO_IMPORT_SAFE_KEYWORDS).toContain("manual import");
	});

	it("should have never keywords defined", () => {
		expect(AUTO_IMPORT_NEVER_KEYWORDS.length).toBeGreaterThan(0);
		expect(AUTO_IMPORT_NEVER_KEYWORDS).toContain("no video files");
		expect(AUTO_IMPORT_NEVER_KEYWORDS).toContain("quality not wanted");
		expect(AUTO_IMPORT_NEVER_KEYWORDS).toContain("password protected");
	});
});
