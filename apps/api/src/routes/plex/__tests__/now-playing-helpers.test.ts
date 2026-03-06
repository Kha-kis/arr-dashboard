import { describe, expect, it } from "vitest";
import { computeTotalBandwidth } from "../lib/now-playing-helpers.js";

describe("computeTotalBandwidth", () => {
	it("sums bandwidth across sessions", () => {
		const sessions = [
			{ bandwidth: 5000 },
			{ bandwidth: 12000 },
			{ bandwidth: 3000 },
		];
		expect(computeTotalBandwidth(sessions)).toBe(20000);
	});

	it("treats null bandwidth as 0", () => {
		const sessions = [
			{ bandwidth: 5000 },
			{ bandwidth: null },
			{ bandwidth: 8000 },
		];
		expect(computeTotalBandwidth(sessions as any)).toBe(13000);
	});

	it("treats undefined bandwidth as 0", () => {
		const sessions = [
			{ bandwidth: undefined },
			{ bandwidth: 4000 },
		];
		expect(computeTotalBandwidth(sessions as any)).toBe(4000);
	});

	it("returns 0 for empty sessions", () => {
		expect(computeTotalBandwidth([])).toBe(0);
	});
});
