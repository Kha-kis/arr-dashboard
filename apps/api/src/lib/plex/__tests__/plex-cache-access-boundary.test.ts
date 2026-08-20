import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const allowedProductionReader = path.normalize("src/lib/plex/plex-cache-storage.ts");

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

describe("Plex cache access boundary", () => {
	it("keeps every production Prisma Plex cache delegate access in storage", async () => {
		const sourceRoot = path.resolve(process.cwd(), "src");
		const bypasses: string[] = [];
		for (const file of await productionTypeScriptFiles(sourceRoot)) {
			const relative = path.normalize(path.relative(process.cwd(), file));
			if (relative === allowedProductionReader) continue;
			const source = await readFile(file, "utf8");
			for (const [index, line] of source.split("\n").entries()) {
				if (/\.(?:plexCache|plexEpisodeCache)\s*(?:\?\.|\.)/.test(line)) {
					bypasses.push(`${relative}:${index + 1}: ${line.trim()}`);
				}
			}
		}

		expect(bypasses, `Direct production Plex cache access:\n${bypasses.join("\n")}`).toEqual([]);
	});
});
