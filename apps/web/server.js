/**
 * Custom Next.js server wrapper that enables runtime API_HOST configuration.
 *
 * The standard Next.js standalone server bakes rewrite destinations at build time.
 * This wrapper patches the config at runtime to use the API_HOST environment variable.
 */

const path = require("node:path");
const vm = require("node:vm");

// In Docker, this file is at /app/web/server.js
// The Next.js app is at /app/web/apps/web/
const nextDir = path.join(__dirname, "apps", "web");

process.env.NODE_ENV = "production";
process.chdir(nextDir);

const currentPort = Number.parseInt(process.env.PORT, 10) || 3000;
const hostname = process.env.HOSTNAME || process.env.HOST || "0.0.0.0";
const apiHost = process.env.API_HOST || "http://localhost:3001";

let keepAliveTimeout = Number.parseInt(process.env.KEEP_ALIVE_TIMEOUT, 10);

// Load the baked config from standalone server
const standaloneServerPath = path.join(nextDir, "server.js");
const standaloneContent = require("node:fs").readFileSync(standaloneServerPath, "utf8");

// Extract the nextConfig from the standalone server
const configMatch = standaloneContent.match(/const nextConfig = (\{.*\})\s*[\r\n]/);
if (!configMatch) {
	console.error("Failed to extract nextConfig from standalone server");
	process.exit(1);
}

let nextConfig;
try {
	// Use vm.runInNewContext instead of eval for security
	// This runs in an isolated context without access to local scope
	nextConfig = vm.runInNewContext(`(${configMatch[1]})`, Object.create(null));
} catch (e) {
	console.error("Failed to parse nextConfig:", e);
	process.exit(1);
}

// Patch rewrites to use runtime API_HOST
if (nextConfig._originalRewrites) {
	const patchRewrites = (rewrites) => {
		if (!rewrites) return rewrites;
		return rewrites.map((rewrite) => {
			if (rewrite.destination?.includes("localhost:3001")) {
				return {
					...rewrite,
					destination: rewrite.destination.replace("http://localhost:3001", apiHost),
				};
			}
			return rewrite;
		});
	};

	nextConfig._originalRewrites.beforeFiles = patchRewrites(nextConfig._originalRewrites.beforeFiles);
	nextConfig._originalRewrites.afterFiles = patchRewrites(nextConfig._originalRewrites.afterFiles);
	nextConfig._originalRewrites.fallback = patchRewrites(nextConfig._originalRewrites.fallback);
}

// Remove any basePath from config - app always runs at "/"
nextConfig.basePath = undefined;

console.log(`Starting Next.js with API_HOST: ${apiHost}`);

process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);

require("next");
const { startServer } = require("next/dist/server/lib/start-server");

if (Number.isNaN(keepAliveTimeout) || !Number.isFinite(keepAliveTimeout) || keepAliveTimeout < 0) {
	keepAliveTimeout = undefined;
}

startServer({
	dir: nextDir,
	isDev: false,
	config: nextConfig,
	hostname,
	port: currentPort,
	allowRetry: false,
	keepAliveTimeout,
}).catch((err) => {
	console.error(err);
	process.exit(1);
});
