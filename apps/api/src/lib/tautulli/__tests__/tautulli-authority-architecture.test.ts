import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const persistedReaderAllowlist = new Set([
	path.normalize("src/lib/tautulli/tautulli-evidence-repository.ts"),
	path.normalize("src/routes/tautulli/cache-routes.ts"),
]);
const aggregateWriteAllowlist = new Set([
	path.normalize("src/lib/tautulli/tautulli-cache-storage.ts"),
	path.normalize("src/lib/services/service-identity-lifecycle.ts"),
]);

async function productionTypeScriptFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (
				["__tests__", "fixtures", "generated", "node_modules", "dist", ".next"].includes(entry.name)
			)
				continue;
			files.push(...(await productionTypeScriptFiles(absolute)));
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			files.push(absolute);
		}
	}
	return files;
}

function findTautulliAuthorityViolations(relative: string, source: string): string[] {
	const normalized = path.normalize(relative);
	const violations: string[] = [];
	if (
		/from\s+["'][^"']*tautulli-evidence-repository\.js["']/.test(source) &&
		!persistedReaderAllowlist.has(normalized)
	) {
		violations.push("imports exact Tautulli observations outside the read-only status boundary");
	}
	if (
		/\.tautulliCache\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/.test(
			source,
		) &&
		!aggregateWriteAllowlist.has(normalized)
	) {
		violations.push("mutates aggregate Tautulli rows outside atomic publication storage");
	}
	if (
		normalized.includes(path.normalize("src/lib/library-cleanup/")) &&
		/(?:tautulliGenerationObservation|tautulliCache)\.(?:findMany|findFirst|findUnique)\s*\(/.test(
			source,
		)
	) {
		violations.push("reads Tautulli persistence directly from cleanup mutation code");
	}
	return violations;
}

describe("Tautulli T1 authority architecture", () => {
	it("keeps exact reads status-only and aggregate writes publication-only", async () => {
		const sourceRoot = path.resolve(process.cwd(), "src");
		const violations: string[] = [];
		for (const file of await productionTypeScriptFiles(sourceRoot)) {
			const relative = path.normalize(path.relative(process.cwd(), file));
			const source = await readFile(file, "utf8");
			for (const violation of findTautulliAuthorityViolations(relative, source)) {
				violations.push(`${relative}: ${violation}`);
			}
		}
		expect(violations, violations.join("\n")).toEqual([]);
	});

	it("detects representative cleanup reads, external writes, and raw-reader imports", () => {
		expect(
			findTautulliAuthorityViolations(
				"src/lib/library-cleanup/example.ts",
				"await prisma.tautulliCache.findMany({});",
			),
		).toContain("reads Tautulli persistence directly from cleanup mutation code");
		expect(
			findTautulliAuthorityViolations(
				"src/routes/example.ts",
				"await prisma.tautulliCache.deleteMany({});",
			),
		).toContain("mutates aggregate Tautulli rows outside atomic publication storage");
		expect(
			findTautulliAuthorityViolations(
				"src/lib/example.ts",
				'import { loadPersistedTautulliGeneration } from "./tautulli-evidence-repository.js";',
			),
		).toContain("imports exact Tautulli observations outside the read-only status boundary");
	});
});
