import { describe, expect, it, beforeEach } from "vitest";
import { z } from "zod";
import {
	validateAndCollect,
	setValidationMode,
	getValidationMode,
	getAllValidationModes,
	resetValidationModes,
	ValidationError,
} from "../validate-batch.js";
import { schemaFingerprints } from "../schema-fingerprint.js";

const schema = z.object({ name: z.string(), score: z.number() });

const mockLog = {
	warn: () => {},
	error: () => {},
};

describe("Validation Modes", () => {
	beforeEach(() => {
		resetValidationModes();
		schemaFingerprints.reset();
	});

	describe("tolerant (default)", () => {
		it("skips invalid items and returns valid ones", () => {
			const data = [
				{ name: "valid", score: 10 },
				{ name: "invalid" }, // missing score
				{ name: "also-valid", score: 20 },
			];

			const result = validateAndCollect(data, schema, "test", mockLog);

			expect(result.items).toHaveLength(2);
			expect(result.stats.rejected).toBe(1);
		});
	});

	describe("strict", () => {
		it("throws ValidationError on first invalid item", () => {
			const data = [
				{ name: "valid", score: 10 },
				{ name: "invalid" }, // missing score
			];

			expect(() =>
				validateAndCollect(data, schema, "test", mockLog, { mode: "strict" }),
			).toThrow(ValidationError);
		});

		it("returns all items when all are valid", () => {
			const data = [
				{ name: "a", score: 1 },
				{ name: "b", score: 2 },
			];

			const result = validateAndCollect(data, schema, "test", mockLog, { mode: "strict" });

			expect(result.items).toHaveLength(2);
			expect(result.stats.rejected).toBe(0);
		});
	});

	describe("log-only", () => {
		it("passes all items through but logs validation issues", () => {
			const warnings: string[] = [];
			const log = { warn: (msg: string | object) => { warnings.push(String(msg)); }, error: () => {} };

			const data = [
				{ name: "valid", score: 10 },
				{ name: "invalid" }, // missing score
			];

			const result = validateAndCollect(data, schema, "test", log, { mode: "log-only" });

			expect(result.items).toHaveLength(2); // Both pass through
			expect(result.stats.rejected).toBe(0);
			expect(warnings.length).toBeGreaterThan(0);
			expect(warnings[0]).toContain("log-only mode");
		});
	});

	describe("disabled", () => {
		it("returns all items without validation", () => {
			const data = [
				"not-an-object",
				42,
				null,
			];

			const result = validateAndCollect(data, schema, "test", mockLog, { mode: "disabled" });

			expect(result.items).toHaveLength(3);
			expect(result.stats.validated).toBe(0); // disabled mode: nothing was actually validated
			expect(result.stats.rejected).toBe(0);
		});
	});

	describe("per-integration mode registry", () => {
		it("defaults to tolerant", () => {
			expect(getValidationMode("unknown-integration")).toBe("tolerant");
		});

		it("setValidationMode overrides for specific integration", () => {
			setValidationMode("plex", "strict");

			expect(getValidationMode("plex")).toBe("strict");
			expect(getValidationMode("tautulli")).toBe("tolerant");
		});

		it("setting to tolerant removes the override", () => {
			setValidationMode("plex", "strict");
			setValidationMode("plex", "tolerant");

			expect(getAllValidationModes()).not.toHaveProperty("plex");
		});

		it("getAllValidationModes returns all overrides", () => {
			setValidationMode("plex", "strict");
			setValidationMode("seerr", "log-only");

			const modes = getAllValidationModes();

			expect(modes).toEqual({ plex: "strict", seerr: "log-only" });
		});

		it("integration mode is picked up when options.integration matches", () => {
			setValidationMode("plex", "disabled");

			const data = [{ garbage: true }];
			const result = validateAndCollect(data, schema, "test", mockLog, {
				integration: "plex",
				category: "sessions",
			});

			// disabled mode → all items pass
			expect(result.items).toHaveLength(1);
			expect(result.stats.rejected).toBe(0);
		});

		it("explicit mode in options overrides integration mode", () => {
			setValidationMode("plex", "disabled");

			const data = [{ name: "invalid" }]; // missing score

			expect(() =>
				validateAndCollect(data, schema, "test", mockLog, {
					integration: "plex",
					category: "sessions",
					mode: "strict", // Explicit override
				}),
			).toThrow(ValidationError);
		});
	});

	describe("PUT /system/validation-modes endpoint logic", () => {
		it("setValidationMode + getAllValidationModes round-trips correctly", () => {
			// This simulates what the PUT endpoint does
			setValidationMode("trash-guides", "strict");

			const modes = getAllValidationModes();
			expect(modes).toEqual({ "trash-guides": "strict" });
		});

		it("setting mode to tolerant removes the override (returns to default)", () => {
			setValidationMode("plex", "strict");
			setValidationMode("plex", "tolerant");

			const modes = getAllValidationModes();
			expect(modes).not.toHaveProperty("plex");
		});

		it("supports all four valid modes", () => {
			const validModes = ["strict", "tolerant", "log-only", "disabled"] as const;
			for (const mode of validModes) {
				setValidationMode("test-integration", mode);
				const effectiveMode = getValidationMode("test-integration");
				if (mode === "tolerant") {
					// tolerant removes the override, so it falls back to default (also tolerant)
					expect(effectiveMode).toBe("tolerant");
				} else {
					expect(effectiveMode).toBe(mode);
				}
			}
		});

		it("multiple integrations can have different modes", () => {
			setValidationMode("plex", "strict");
			setValidationMode("seerr", "log-only");
			setValidationMode("tautulli", "disabled");

			const modes = getAllValidationModes();
			expect(modes).toEqual({
				plex: "strict",
				seerr: "log-only",
				tautulli: "disabled",
			});
		});

		it("resetValidationModes clears all overrides", () => {
			setValidationMode("plex", "strict");
			setValidationMode("seerr", "disabled");

			resetValidationModes();

			const modes = getAllValidationModes();
			expect(Object.keys(modes)).toHaveLength(0);
			expect(getValidationMode("plex")).toBe("tolerant");
		});
	});

	describe("fingerprinting integration", () => {
		it("records fingerprint when integration and category are provided", () => {
			const data = [{ name: "foo", score: 10 }];

			validateAndCollect(data, schema, "test", mockLog, {
				integration: "test-int",
				category: "test-cat",
			});

			const fp = schemaFingerprints.get("test-int", "test-cat");
			expect(fp).toBeDefined();
			expect(fp!.baseline.fields).toEqual(["name", "score"]);
		});

		it("does not record fingerprint without integration/category", () => {
			const data = [{ name: "foo", score: 10 }];

			validateAndCollect(data, schema, "test", mockLog);

			const all = schemaFingerprints.getAll();
			expect(Object.keys(all)).toHaveLength(0);
		});

		it("does not record fingerprint when all items are rejected", () => {
			const data = [{ invalid: true }];

			validateAndCollect(data, schema, "test", mockLog, {
				integration: "test-int",
				category: "test-cat",
			});

			const fp = schemaFingerprints.get("test-int", "test-cat");
			expect(fp).toBeUndefined();
		});
	});
});
