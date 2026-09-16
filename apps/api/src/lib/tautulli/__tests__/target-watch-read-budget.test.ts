import { describe, expect, it } from "vitest";
import { TargetWatchReadBudget } from "../target-watch-read-budget.js";

describe("target watch read budget", () => {
	it("shares its bound across batches and reserves multi-request identity reads atomically", () => {
		const budget = new TargetWatchReadBudget(4);
		expect(budget.tryConsume(3)).toBe(true);
		expect(budget.tryConsume(2)).toBe(false);
		expect(budget.requestsUsed).toBe(3);
		expect(budget.tryConsume()).toBe(false);
		expect(budget.exhausted).toBe(true);
		expect(budget.tryConsume(1, "validation")).toBe(true);
		expect(budget.requestsUsed).toBe(4);
		expect(budget.tryConsume(1, "validation")).toBe(false);
	});
	it("stops further requests at the elapsed deadline", () => {
		let now = 100;
		const budget = new TargetWatchReadBudget(100, 20, () => now);
		expect(budget.tryConsume()).toBe(true);
		now = 121;
		expect(budget.tryConsume()).toBe(false);
		expect(budget.exhausted).toBe(true);
	});
});
