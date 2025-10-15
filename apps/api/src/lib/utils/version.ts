import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | null = null;

/**
 * Get the application version from the root package.json
 * Caches the version after first read for performance
 * Falls back to APP_VERSION environment variable or "unknown"
 */
export function getAppVersion(): string {
	if (cachedVersion) {
		return cachedVersion;
	}

	try {
		// Start from current file's directory
		let currentDir = path.dirname(fileURLToPath(import.meta.url));
		let packageJsonPath = path.join(currentDir, "package.json");

		// Search upward for package.json
		while (!fs.existsSync(packageJsonPath) && currentDir !== path.parse(currentDir).root) {
			currentDir = path.dirname(currentDir);
			packageJsonPath = path.join(currentDir, "package.json");
		}

		if (!fs.existsSync(packageJsonPath)) {
			throw new Error("Could not locate root package.json");
		}

		const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
		const version = packageJson.version as string;

		if (version) {
			cachedVersion = version;
			return version;
		}
	} catch (error) {
		console.warn("Failed to read version from package.json:", error);
	}

	// Fallback to environment variable or unknown
	cachedVersion = process.env.APP_VERSION || "unknown";
	return cachedVersion;
}
