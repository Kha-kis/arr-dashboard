import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rawObservationImportAllowlist = new Set([
	path.normalize("src/lib/plex/plex-authority-service.ts"),
	path.normalize("src/lib/plex/plex-persisted-observation-repository.ts"),
]);
const directMetadataMutationAllowlist = new Set([
	path.normalize("src/lib/plex/plex-authority-service.ts"),
]);
const directTargetLedgerAccessAllowlist = new Set([
	path.normalize("src/lib/plex/plex-authority-service.ts"),
	path.normalize("src/lib/plex/plex-generation-target-ledger.ts"),
]);
const positiveV4ConsumerAllowlist = new Set([
	path.normalize("src/lib/plex/plex-authority-service.ts"),
]);
const fixedPointMutationConsumers = [
	path.normalize("src/lib/label-sync/dest-writers/plex-writer.ts"),
	path.normalize("src/routes/plex/collection-routes.ts"),
];

async function productionTypeScriptFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (
				["__tests__", "fixtures", "generated", "node_modules", "dist", ".next"].includes(entry.name)
			) {
				continue;
			}
			files.push(...(await productionTypeScriptFiles(absolute)));
			continue;
		}
		if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
		files.push(absolute);
	}
	return files;
}

function findPlexAuthorityViolations(relative: string, source: string): string[] {
	const normalized = path.normalize(relative);
	const violations: string[] = [];
	if (
		/from\s+["'][^"']*plex-evidence-repository\.js["']/.test(source) &&
		!rawObservationImportAllowlist.has(normalized)
	) {
		violations.push("imports the raw persisted-observation repository");
	}
	if (
		/import\s*\{[^}]*\bloadPositiveEpisode(?:Parent)?Evidence\b[^}]*\}\s*from\s+["'][^"']*plex-evidence-repository\.js["']/.test(
			source,
		) &&
		!positiveV4ConsumerAllowlist.has(normalized)
	) {
		violations.push("bypasses the explicit positive V4 authority reader");
	}
	if (
		/\.updateMetadataTags\s*\(/.test(source) &&
		!directMetadataMutationAllowlist.has(normalized)
	) {
		violations.push("performs a direct Plex metadata mutation");
	}
	if (
		/\.plexGenerationTarget\s*\./.test(source) &&
		!directTargetLedgerAccessAllowlist.has(normalized)
	) {
		violations.push(
			"reads or writes the Plex generation target ledger outside its authority boundary",
		);
	}
	if (
		fixedPointMutationConsumers.includes(normalized) &&
		!/\.mutateMetadataTag\s*\(/.test(source)
	) {
		violations.push("bypasses PlexAuthorityService.mutateMetadataTag");
	}
	return violations;
}

describe("Plex authority architecture", () => {
	it("keeps raw observations and upstream metadata writes behind approved boundaries", async () => {
		const sourceRoot = path.resolve(process.cwd(), "src");
		const violations: string[] = [];
		for (const file of await productionTypeScriptFiles(sourceRoot)) {
			const relative = path.normalize(path.relative(process.cwd(), file));
			const source = await readFile(file, "utf8");
			for (const violation of findPlexAuthorityViolations(relative, source)) {
				violations.push(`${relative}: ${violation}`);
			}
		}
		expect(violations, violations.join("\n")).toEqual([]);
	});

	it("detects representative raw-read, direct-write, and fixed-point bypass violations", () => {
		expect(
			findPlexAuthorityViolations(
				"src/routes/plex/example.ts",
				'import { loadInstanceEvidence } from "../../lib/plex/plex-evidence-repository.js";',
			),
		).toContain("imports the raw persisted-observation repository");
		expect(
			findPlexAuthorityViolations(
				"src/lib/library-cleanup/example.ts",
				'import { loadPositiveEpisodeParentEvidence } from "../plex/plex-evidence-repository.js";',
			),
		).toContain("bypasses the explicit positive V4 authority reader");
		expect(
			findPlexAuthorityViolations(
				"src/lib/library-cleanup/example.ts",
				'import { loadPositiveEpisodeEvidence } from "../plex/plex-evidence-repository.js";',
			),
		).toContain("bypasses the explicit positive V4 authority reader");
		expect(
			findPlexAuthorityViolations(
				"src/routes/plex/example.ts",
				"await plexClient.updateMetadataTags(key, type, action, name);",
			),
		).toContain("performs a direct Plex metadata mutation");
		expect(
			findPlexAuthorityViolations(
				"src/routes/plex/example.ts",
				"await prisma.plexGenerationTarget.findMany({ where: {} });",
			),
		).toContain("reads or writes the Plex generation target ledger outside its authority boundary");
		expect(
			findPlexAuthorityViolations(
				"src/lib/label-sync/dest-writers/plex-writer.ts",
				"await plexClient.request('/library/metadata/1');",
			),
		).toContain("bypasses PlexAuthorityService.mutateMetadataTag");
	});
});
