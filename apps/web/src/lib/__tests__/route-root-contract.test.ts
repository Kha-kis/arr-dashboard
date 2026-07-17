import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Next.js route-root contract", () => {
	it("keeps one authoritative App Router tree", () => {
		expect(existsSync(resolve(process.cwd(), "app"))).toBe(true);
		expect(existsSync(resolve(process.cwd(), "src/app"))).toBe(false);
	});
});
