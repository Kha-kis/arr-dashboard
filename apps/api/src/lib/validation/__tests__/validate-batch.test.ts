import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { validateAndCollect } from "../validate-batch.js";

const log = { warn: vi.fn(), error: vi.fn() };

const itemSchema = z.looseObject({
	id: z.number(),
	name: z.string(),
});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("validateAndCollect", () => {
	it("returns all items when all are valid", () => {
		const items = [
			{ id: 1, name: "a" },
			{ id: 2, name: "b" },
		];
		const { items: result, stats } = validateAndCollect(items, itemSchema, "test.json", log);
		expect(result).toHaveLength(2);
		expect(stats).toEqual({ total: 2, validated: 2, rejected: 0 });
		expect(log.warn).not.toHaveBeenCalled();
		expect(log.error).not.toHaveBeenCalled();
	});

	it("skips invalid items and returns valid subset", () => {
		const items = [
			{ id: 1, name: "valid" },
			{ id: "not-a-number", name: "invalid-id" },
			{ id: 3, name: "also-valid" },
		];
		const { items: result, stats } = validateAndCollect(items, itemSchema, "mixed.json", log);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ id: 1, name: "valid" });
		expect(result[1]).toEqual({ id: 3, name: "also-valid" });
		expect(stats.rejected).toBe(1);
		expect(log.warn).toHaveBeenCalledTimes(1);
	});

	it("returns empty array and logs error when all items fail", () => {
		const items = [
			{ id: "bad" },
			{ name: 123 },
		];
		const { items: result, stats } = validateAndCollect(items, itemSchema, "all-bad.json", log);
		expect(result).toHaveLength(0);
		expect(stats).toEqual({ total: 2, validated: 0, rejected: 2 });
		expect(log.error).toHaveBeenCalledTimes(1);
		expect(log.error).toHaveBeenCalledWith(
			expect.stringContaining("All 2 items failed validation"),
		);
	});

	it("wraps a single non-array item into an array", () => {
		const single = { id: 1, name: "single" };
		const { items: result, stats } = validateAndCollect(single, itemSchema, "single.json", log);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ id: 1, name: "single" });
		expect(stats.total).toBe(1);
	});

	it("returns empty result for empty input", () => {
		const { items: result, stats } = validateAndCollect([], itemSchema, "empty.json", log);
		expect(result).toHaveLength(0);
		expect(stats).toEqual({ total: 0, validated: 0, rejected: 0 });
		expect(log.warn).not.toHaveBeenCalled();
		expect(log.error).not.toHaveBeenCalled();
	});

	it("logs high rejection rate warning when >50% items fail", () => {
		const items = [
			{ id: 1, name: "ok" },
			{ id: "bad" },
			{ name: 123 },
			{ what: "nope" },
		];
		const { items: result, stats } = validateAndCollect(items, itemSchema, "high-reject.json", log);
		expect(result).toHaveLength(1);
		expect(stats.rejected).toBe(3);
		// Warn about per-item rejections (3 times) + high rejection rate (1 time)
		expect(log.warn).toHaveBeenCalled();
		const lastWarnCall = log.warn.mock.calls[log.warn.mock.calls.length - 1]![0];
		expect(lastWarnCall).toContain("High rejection rate");
	});

	it("preserves extra fields with looseObject schema", () => {
		const items = [{ id: 1, name: "test", extraField: "preserved" }];
		const { items: result } = validateAndCollect(items, itemSchema, "extra.json", log);
		expect(result[0]).toHaveProperty("extraField", "preserved");
	});
});
