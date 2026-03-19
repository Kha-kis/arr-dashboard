/**
 * Unit tests for runWithConcurrency.
 */

import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "../lib/enrichment-helpers.js";

describe("runWithConcurrency", () => {
	it("preserves result order", async () => {
		// Tasks that complete in reverse order but should preserve input order
		const tasks = [
			() => new Promise<number>((r) => setTimeout(() => r(1), 30)),
			() => new Promise<number>((r) => setTimeout(() => r(2), 10)),
			() => new Promise<number>((r) => setTimeout(() => r(3), 20)),
		];

		const results = await runWithConcurrency(tasks, 3);
		expect(results.map((r) => (r as PromiseFulfilledResult<number>).value)).toEqual([1, 2, 3]);
	});

	it("isolates rejections from other tasks", async () => {
		const tasks = [
			() => Promise.resolve("a"),
			() => Promise.reject(new Error("fail")),
			() => Promise.resolve("c"),
		];

		const results = await runWithConcurrency(tasks, 3);
		expect(results[0]!.status).toBe("fulfilled");
		expect(results[1]!.status).toBe("rejected");
		expect(results[2]!.status).toBe("fulfilled");
	});

	it("respects concurrency limit", async () => {
		let concurrent = 0;
		let maxConcurrent = 0;

		const tasks = Array.from({ length: 10 }, () => async () => {
			concurrent++;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			await new Promise((r) => setTimeout(r, 10));
			concurrent--;
			return "done";
		});

		await runWithConcurrency(tasks, 3);
		expect(maxConcurrent).toBeLessThanOrEqual(3);
	});

	it("handles empty array", async () => {
		const results = await runWithConcurrency([], 5);
		expect(results).toEqual([]);
	});

	it("handles single task", async () => {
		const results = await runWithConcurrency([() => Promise.resolve(42)], 5);
		expect(results).toHaveLength(1);
		expect((results[0] as PromiseFulfilledResult<number>).value).toBe(42);
	});
});
