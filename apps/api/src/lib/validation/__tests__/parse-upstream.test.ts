import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { integrationHealth } from "../integration-health.js";
import {
	UpstreamValidationError,
	parseUpstream,
	parseUpstreamOrThrow,
} from "../parse-upstream.js";

const schema = z.looseObject({
	id: z.number(),
	title: z.string(),
});

const source = { integration: "test-api", category: "getItems" };

describe("parseUpstream", () => {
	beforeEach(() => {
		integrationHealth.reset();
	});

	it("returns success with parsed data for valid input", () => {
		const raw = { id: 1, title: "Movie", extra: "ignored" };

		const result = parseUpstream(raw, schema, source);

		expect(result.success).toBe(true);
		expect(result.success && result.data).toEqual({ id: 1, title: "Movie", extra: "ignored" });
	});

	it("records health success on valid input", () => {
		parseUpstream({ id: 1, title: "ok" }, schema, source);

		const health = integrationHealth.getByIntegration("test-api");
		expect(health!.categories.getItems).toEqual({ total: 1, validated: 1, rejected: 0 });
	});

	it("returns failure with UpstreamValidationError on invalid input", () => {
		const raw = { id: "not-a-number", title: 42 };

		const result = parseUpstream(raw, schema, source);

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toBeInstanceOf(UpstreamValidationError);
			expect(result.error.integration).toBe("test-api");
			expect(result.error.category).toBe("getItems");
			expect(result.error.issues.length).toBeGreaterThan(0);
		}
	});

	it("records health failure on invalid input", () => {
		parseUpstream({ id: "bad" }, schema, source);

		const health = integrationHealth.getByIntegration("test-api");
		expect(health!.categories.getItems).toEqual({ total: 1, validated: 0, rejected: 1 });
	});

	it("never throws — always returns a result", () => {
		expect(() => parseUpstream(null, schema, source)).not.toThrow();
		expect(() => parseUpstream(undefined, schema, source)).not.toThrow();
		expect(() => parseUpstream("garbage", schema, source)).not.toThrow();
	});

	it("accumulates health stats across calls", () => {
		parseUpstream({ id: 1, title: "a" }, schema, source);
		parseUpstream({ id: 2, title: "b" }, schema, source);
		parseUpstream({ id: "bad" }, schema, source);

		const health = integrationHealth.getByIntegration("test-api");
		expect(health!.categories.getItems).toEqual({ total: 3, validated: 2, rejected: 1 });
	});

	it("includes path info in issue strings", () => {
		const result = parseUpstream({ id: "wrong" }, schema, source);

		if (!result.success) {
			const idIssue = result.error.issues.find((i) => i.startsWith("id:"));
			expect(idIssue).toBeDefined();
		}
	});

	it("includes integration/category in error message", () => {
		const result = parseUpstream({}, schema, source);

		if (!result.success) {
			expect(result.error.message).toContain("test-api");
			expect(result.error.message).toContain("getItems");
		}
	});
});

describe("parseUpstreamOrThrow", () => {
	beforeEach(() => {
		integrationHealth.reset();
	});

	it("returns parsed data on valid input", () => {
		const data = parseUpstreamOrThrow({ id: 1, title: "ok" }, schema, source);

		expect(data).toEqual({ id: 1, title: "ok" });
	});

	it("throws UpstreamValidationError on invalid input", () => {
		expect(() => parseUpstreamOrThrow({ id: "bad" }, schema, source)).toThrow(
			UpstreamValidationError,
		);
	});

	it("never throws raw ZodError", () => {
		try {
			parseUpstreamOrThrow({ id: "bad" }, schema, source);
		} catch (err) {
			expect(err).toBeInstanceOf(UpstreamValidationError);
			expect(err).not.toBeInstanceOf(z.ZodError);
		}
	});

	it("records health on both success and failure paths", () => {
		parseUpstreamOrThrow({ id: 1, title: "ok" }, schema, source);
		try {
			parseUpstreamOrThrow({ bad: true }, schema, source);
		} catch {
			/* expected */
		}

		const health = integrationHealth.getByIntegration("test-api");
		expect(health!.totals).toEqual({ total: 2, validated: 1, rejected: 1 });
	});
});

describe("UpstreamValidationError", () => {
	it("has correct name property", () => {
		const err = new UpstreamValidationError("msg", "plex", "/sections", ["issue1"]);
		expect(err.name).toBe("UpstreamValidationError");
	});

	it("is instanceof Error", () => {
		const err = new UpstreamValidationError("msg", "plex", "/sections", []);
		expect(err).toBeInstanceOf(Error);
	});

	it("carries structured metadata", () => {
		const err = new UpstreamValidationError("msg", "seerr", "getStatus", ["a", "b"]);
		expect(err.integration).toBe("seerr");
		expect(err.category).toBe("getStatus");
		expect(err.issues).toEqual(["a", "b"]);
	});
});
