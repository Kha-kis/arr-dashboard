import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Docker runtime version contract", () => {
	it("writes the VERSION build argument into the deployed version.json", () => {
		const dockerfile = readFileSync(resolve(process.cwd(), "../../Dockerfile"), "utf8");

		expect(dockerfile).toContain("ARG VERSION");
		expect(dockerfile).toContain("version:process.env.VERSION||p.version");
	});
});
