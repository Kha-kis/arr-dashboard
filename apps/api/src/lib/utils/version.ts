import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | null = null;

/**
 * Get the application version from the root package.json
 * Caches the version after first read for performance
 * Falls back to "2.2.0" if unable to read the version
 */
export function getAppVersion(): string {
	if (cachedVersion) {
		return cachedVersion;
	}

	try {
		// In production, __dirname might not be available in ESM
		// Try to resolve relative to this file's location
		const currentDir = path.dirname(fileURLToPath(import.meta.url));

		// Navigate up to the monorepo root: api/src/lib/utils -> api/src/lib -> api/src -> api -> root
		const rootDir = path.resolve(currentDir, "../../../../../");
		const packageJsonPath = path.join(rootDir, "package.json");

		const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
		const version = packageJson.version as string;

		if (version) {
			cachedVersion = version;
			return version;
		}
	} catch (error) {
		console.warn("Failed to read version from package.json:", error);
	}

	// Fallback to current known version
	cachedVersion = "2.2.0";
	return cachedVersion;
}
