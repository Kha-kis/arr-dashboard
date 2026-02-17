import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loggers } from "../logger.js";

const log = loggers.api;

let cachedVersion: string | null = null;

/**
 * Get the application version from version.json (Docker) or root package.json (dev)
 * Caches the version after first read for performance
 * Falls back to APP_VERSION environment variable or "unknown"
 */
export function getAppVersion(): string {
	if (cachedVersion) {
		return cachedVersion;
	}

	try {
		// Priority 1: Check for version.json (created at Docker build time)
		// This contains the monorepo root version extracted during docker build
		const versionJsonPaths = ["/app/api/version.json", path.join(process.cwd(), "version.json")];

		for (const versionPath of versionJsonPaths) {
			if (fs.existsSync(versionPath)) {
				const versionJson = JSON.parse(fs.readFileSync(versionPath, "utf-8"));
				if (versionJson.version) {
					cachedVersion = versionJson.version as string;
					return cachedVersion;
				}
			}
		}

		// Priority 2: Walk up from current file to find monorepo root package.json (dev mode)
		let currentDir = path.dirname(fileURLToPath(import.meta.url));
		const rootDir = path.parse(currentDir).root;
		let lastFoundPackageJsonPath: string | null = null;

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

		if (lastFoundPackageJsonPath) {
			const packageJson = JSON.parse(fs.readFileSync(lastFoundPackageJsonPath, "utf-8"));
			const version = packageJson.version as string;

			if (version) {
				cachedVersion = version;
				return version;
			}
		}
	} catch (error) {
		log.warn({ err: error }, "Failed to read version");
	}

	// Fallback to environment variable or unknown
	cachedVersion = process.env.APP_VERSION || "unknown";
	return cachedVersion;
}
