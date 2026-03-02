/**
 * Tests for LOG_LEVEL resolution logic
 *
 * Validates that the logger correctly reads and normalizes LOG_LEVEL from
 * environment variables, matching the logic in logger.ts.
 * Covers the fix for GitHub issue #133.
 */

import { describe, it, expect } from "vitest";

// Replicate the exact logic from logger.ts lines 32-34 as a pure function
// so we can test it without side effects (Pino transport creation, fs access)
const VALID_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace"]);

function resolveLogLevel(envValue: string | undefined, isDev: boolean): string {
	const rawLevel = envValue?.toLowerCase();
	return rawLevel && VALID_LEVELS.has(rawLevel) ? rawLevel : isDev ? "debug" : "info";
}

describe("LOG_LEVEL resolution", () => {
	it("uses LOG_LEVEL when set to a valid level", () => {
		expect(resolveLogLevel("debug", false)).toBe("debug");
		expect(resolveLogLevel("info", false)).toBe("info");
		expect(resolveLogLevel("warn", true)).toBe("warn");
		expect(resolveLogLevel("error", false)).toBe("error");
		expect(resolveLogLevel("fatal", false)).toBe("fatal");
		expect(resolveLogLevel("trace", true)).toBe("trace");
	});

	it("normalizes case (case-insensitive)", () => {
		expect(resolveLogLevel("DEBUG", false)).toBe("debug");
		expect(resolveLogLevel("Info", false)).toBe("info");
		expect(resolveLogLevel("WARN", true)).toBe("warn");
		expect(resolveLogLevel("Error", false)).toBe("error");
		expect(resolveLogLevel("TRACE", false)).toBe("trace");
	});

	it("defaults to 'info' in production when LOG_LEVEL is unset", () => {
		expect(resolveLogLevel(undefined, false)).toBe("info");
		expect(resolveLogLevel("", false)).toBe("info");
	});

	it("defaults to 'debug' in development when LOG_LEVEL is unset", () => {
		expect(resolveLogLevel(undefined, true)).toBe("debug");
		expect(resolveLogLevel("", true)).toBe("debug");
	});

	it("rejects invalid levels and falls back to default", () => {
		expect(resolveLogLevel("verbose", false)).toBe("info");
		expect(resolveLogLevel("warning", false)).toBe("info");
		expect(resolveLogLevel("nonsense", true)).toBe("debug");
		expect(resolveLogLevel("0", false)).toBe("info");
	});
});

describe("Pino logger wiring (smoke test)", () => {
	it("exports a logger with the correct level", async () => {
		// Import the actual logger to verify it was created successfully
		const { LOG_LEVEL, logger } = await import("../logger.js");

		expect(logger).toBeDefined();
		expect(typeof logger.info).toBe("function");
		expect(typeof logger.debug).toBe("function");
		expect(typeof logger.error).toBe("function");
		// The logger's level should match the resolved LOG_LEVEL
		expect(logger.level).toBe(LOG_LEVEL);
	});
});
