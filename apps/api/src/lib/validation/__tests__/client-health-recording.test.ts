/**
 * Tests for the parse-and-record pattern used by Plex, Tautulli, and Seerr clients.
 *
 * All three clients follow the same pattern:
 * - On successful schema.parse() → integrationHealth.record(integration, category, { total: 1, validated: 1, rejected: 0 })
 * - On failed schema.parse()     → integrationHealth.record(integration, category, { total: 1, validated: 0, rejected: 1 })
 *
 * This test validates that the pattern works end-to-end with real Zod schemas
 * and the singleton integrationHealth registry.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { integrationHealth } from "../integration-health.js";

// Simulates the exact pattern used in plex-client.ts and tautulli-client.ts
function parseWithHealthRecording<T>(
	raw: unknown,
	schema: z.ZodType<T>,
	integration: string,
	category: string,
): T {
	try {
		const parsed = schema.parse(raw);
		integrationHealth.record(integration, category, { total: 1, validated: 1, rejected: 0 });
		return parsed;
	} catch (err) {
		integrationHealth.record(integration, category, { total: 1, validated: 0, rejected: 1 });
		throw err;
	}
}

// Simulates the SeerrClient.parseAndRecord() method (same logic, explicit T return)
function parseAndRecord<T>(
	raw: unknown,
	schema: z.ZodType,
	integration: string,
	category: string,
): T {
	try {
		const parsed = schema.parse(raw);
		integrationHealth.record(integration, category, { total: 1, validated: 1, rejected: 0 });
		return parsed as T;
	} catch (err) {
		integrationHealth.record(integration, category, { total: 1, validated: 0, rejected: 1 });
		throw err;
	}
}

// Realistic schemas matching what clients validate
const plexSectionsSchema = z.looseObject({
	MediaContainer: z.looseObject({
		Directory: z.array(z.looseObject({ key: z.string(), title: z.string() })).optional(),
	}),
});

const tautulliHistorySchema = z.looseObject({
	recordsFiltered: z.number(),
	data: z.array(z.looseObject({ title: z.string() })),
});

const seerrStatusSchema = z.looseObject({
	version: z.string(),
	commitTag: z.string(),
});

describe("Client health recording pattern", () => {
	beforeEach(() => {
		integrationHealth.reset();
	});

	describe("Plex client pattern", () => {
		it("records success on valid Plex response", () => {
			const raw = { MediaContainer: { Directory: [{ key: "1", title: "Movies" }] } };

			parseWithHealthRecording(raw, plexSectionsSchema, "plex", "/library/sections");

			const health = integrationHealth.getByIntegration("plex");
			expect(health).toBeDefined();
			expect(health!.categories["/library/sections"]).toEqual({ total: 1, validated: 1, rejected: 0 });
		});

		it("records failure on invalid Plex response", () => {
			const raw = { unexpected: "structure" };

			expect(() =>
				parseWithHealthRecording(raw, plexSectionsSchema, "plex", "/library/sections"),
			).toThrow();

			const health = integrationHealth.getByIntegration("plex");
			expect(health!.categories["/library/sections"]).toEqual({ total: 1, validated: 0, rejected: 1 });
		});
	});

	describe("Tautulli client pattern", () => {
		it("records success on valid Tautulli response", () => {
			const raw = { recordsFiltered: 5, data: [{ title: "Movie A" }] };

			parseWithHealthRecording(raw, tautulliHistorySchema, "tautulli", "get_history");

			const health = integrationHealth.getByIntegration("tautulli");
			expect(health!.categories.get_history).toEqual({ total: 1, validated: 1, rejected: 0 });
		});

		it("records failure when Tautulli response has wrong types", () => {
			const raw = { recordsFiltered: "not-a-number", data: "not-an-array" };

			expect(() =>
				parseWithHealthRecording(raw, tautulliHistorySchema, "tautulli", "get_history"),
			).toThrow();

			const health = integrationHealth.getByIntegration("tautulli");
			expect(health!.categories.get_history).toEqual({ total: 1, validated: 0, rejected: 1 });
		});
	});

	describe("Seerr client parseAndRecord pattern", () => {
		it("records success and returns typed result", () => {
			const raw = { version: "2.0.0", commitTag: "abc123" };

			const result = parseAndRecord<{ version: string; commitTag: string }>(
				raw, seerrStatusSchema, "seerr", "getStatus",
			);

			expect(result.version).toBe("2.0.0");

			const health = integrationHealth.getByIntegration("seerr");
			expect(health!.categories.getStatus).toEqual({ total: 1, validated: 1, rejected: 0 });
		});

		it("records failure when schema validation fails", () => {
			const raw = { version: 123 }; // version should be string

			expect(() =>
				parseAndRecord<{ version: string }>(raw, seerrStatusSchema, "seerr", "getStatus"),
			).toThrow();

			const health = integrationHealth.getByIntegration("seerr");
			expect(health!.categories.getStatus).toEqual({ total: 1, validated: 0, rejected: 1 });
		});

		it("accumulates stats across multiple calls", () => {
			const valid = { version: "2.0.0", commitTag: "abc" };
			const invalid = { version: 123 };

			parseAndRecord(valid, seerrStatusSchema, "seerr", "getStatus");
			parseAndRecord(valid, seerrStatusSchema, "seerr", "getStatus");
			try { parseAndRecord(invalid, seerrStatusSchema, "seerr", "getStatus"); } catch { /* expected */ }

			const health = integrationHealth.getByIntegration("seerr");
			expect(health!.categories.getStatus).toEqual({ total: 3, validated: 2, rejected: 1 });
			expect(health!.totals).toEqual({ total: 3, validated: 2, rejected: 1 });
		});
	});

	describe("Cross-integration aggregation", () => {
		it("getAll() aggregates health from all three clients", () => {
			// Simulate typical operation: all three clients reporting health
			integrationHealth.record("plex", "/library/sections", { total: 1, validated: 1, rejected: 0 });
			integrationHealth.record("tautulli", "get_history", { total: 5, validated: 5, rejected: 0 });
			integrationHealth.record("seerr", "getRequests", { total: 3, validated: 2, rejected: 1 });

			const all = integrationHealth.getAll();
			expect(Object.keys(all.integrations)).toEqual(
				expect.arrayContaining(["plex", "tautulli", "seerr"]),
			);
			expect(all.overallTotals).toEqual({ total: 9, validated: 8, rejected: 1 });
		});
	});
});
