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
		// Start from current file's directory and walk to filesystem root
		// Track the outermost package.json found (repository root)
		let currentDir = path.dirname(fileURLToPath(import.meta.url));
		const rootDir = path.parse(currentDir).root;
		let lastFoundPackageJsonPath: string | null = null;

		// Walk upward to filesystem root, tracking all package.json files found
		while (currentDir !== rootDir) {
			const packageJsonPath = path.join(currentDir, "package.json");
			if (fs.existsSync(packageJsonPath)) {
				lastFoundPackageJsonPath = packageJsonPath;
			}
			currentDir = path.dirname(currentDir);
		}

		// Check root directory as well
		const rootPackageJsonPath = path.join(rootDir, "package.json");
		if (fs.existsSync(rootPackageJsonPath)) {
			lastFoundPackageJsonPath = rootPackageJsonPath;
		}

		if (!lastFoundPackageJsonPath) {
			throw new Error("Could not locate root package.json");
		}

		const packageJson = JSON.parse(fs.readFileSync(lastFoundPackageJsonPath, "utf-8"));
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
