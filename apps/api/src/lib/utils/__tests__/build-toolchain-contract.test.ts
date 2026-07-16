import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Build toolchain contract", () => {
	const repositoryRoot = resolve(process.cwd(), "../..");
	const rootPackage = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as {
		packageManager: string;
	};
	const dockerfile = readFileSync(resolve(repositoryRoot, "Dockerfile"), "utf8");
	const turbo = JSON.parse(readFileSync(resolve(repositoryRoot, "turbo.json"), "utf8")) as {
		tasks: { typecheck: { dependsOn: string[] } };
	};

	it("lets Corepack select the root packageManager version in Docker", () => {
		expect(rootPackage.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
		expect(dockerfile).toContain("corepack enable");
		expect(dockerfile).not.toMatch(/corepack prepare pnpm@/);
	});

	it("builds workspace dependencies before package typechecking", () => {
		expect(turbo.tasks.typecheck.dependsOn).toContain("^build");
	});
});
