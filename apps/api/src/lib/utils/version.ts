import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loggers } from "../logger.js";

const log = loggers.api;

export interface AppVersionInfo {
	version: string;
	commitSha: string;
}

let cached: AppVersionInfo | null = null;

/**
 * Get the application version and commit SHA.
 *
 * Resolution order:
 *   1. version.json (written at Docker build time — includes commitSha from CI)
 *   2. Root package.json + `git rev-parse --short HEAD` (dev mode)
 *   3. APP_VERSION env var / "unknown"
 */
export function getAppVersionInfo(): AppVersionInfo {
	if (cached) {
		return cached;
	}

	try {
		// Priority 1: version.json from Docker build
		const versionJsonPaths = ["/app/api/version.json", path.join(process.cwd(), "version.json")];

		for (const versionPath of versionJsonPaths) {
			if (fs.existsSync(versionPath)) {
				const versionJson = JSON.parse(fs.readFileSync(versionPath, "utf-8"));
				if (versionJson.version) {
					cached = {
						version: versionJson.version as string,
						commitSha: (versionJson.commitSha as string) || "unknown",
					};
					return cached;
				}
			}
		}

		// Priority 2: Walk up to monorepo root package.json (dev mode)
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

		const rootPackageJsonPath = path.join(rootDir, "package.json");
		if (fs.existsSync(rootPackageJsonPath)) {
			lastFoundPackageJsonPath = rootPackageJsonPath;
		}

		if (lastFoundPackageJsonPath) {
			const packageJson = JSON.parse(fs.readFileSync(lastFoundPackageJsonPath, "utf-8"));
			const version = packageJson.version as string;

			if (version) {
				let commitSha = "dev";
				try {
					commitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
						encoding: "utf-8",
					}).trim();
				} catch {
					// Not a git repo or git not available — fine in dev
				}
				cached = { version, commitSha };
				return cached;
			}
		}
	} catch (error) {
		log.warn({ err: error }, "Failed to read version");
	}

	cached = {
		version: process.env.APP_VERSION || "unknown",
		commitSha: "unknown",
	};
	return cached;
}

/** Convenience: returns just the version string (backwards-compatible) */
export function getAppVersion(): string {
	return getAppVersionInfo().version;
}
