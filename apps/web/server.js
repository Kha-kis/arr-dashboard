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

const { dockerIPv6ApiSocket, localSocketTarget } = require("./docker-socket-target.cjs");
const apiSocket = dockerIPv6ApiSocket(process.env.ARR_INTERNAL_API_SOCKET, apiHost);
let apiRewriteOrigin = apiHost;
if (apiSocket) {
	// Next treats IPv6 colons as rewrite parameters. Use a non-routable
	// placeholder for the two owned rewrites and restore the socket at dial time.
	const placeholder = new URL(`http://arr-dashboard-api.invalid:${apiSocket.port}`);
	apiRewriteOrigin = placeholder.origin;
	const httpxyModule = require.resolve("next/dist/compiled/httpxy");
	const httpxy = require(httpxyModule);
	class DockerApiProxy extends httpxy.ProxyServer {
		constructor(options) {
			const target = options?.target;
			if (target instanceof URL && target.origin === placeholder.origin) {
				if (!/^\/(?:api|auth)(?:\/|$)/.test(target.pathname))
					throw new Error("Unexpected internal API rewrite");
				super({
					...options,
					target: {
						hostname: localSocketTarget(apiSocket.hostname),
						host: apiSocket.origin.host,
						protocol: "http:",
						port: apiSocket.port,
						pathname: target.pathname + target.search,
					},
				});
			} else {
				super(options);
			}
		}
	}
	require.cache[httpxyModule].exports = { ...httpxy, ProxyServer: DockerApiProxy };
}

if (hostname.includes("%") && require("node:net").isIPv6(hostname)) {
	// A zone belongs to the listened socket, not to a WHATWG URL authority.
	// Next still passes the original hostname to listen().
	const originModule = require.resolve("next/dist/server/lib/format-hostname");
	const formatter = require(originModule);
	require.cache[originModule].exports = {
		formatHostname(value) {
			return formatter.formatHostname(value === hostname ? value.split("%")[0] : value);
		},
	};
}

// Keep Next's compiled route matchers and proxy implementation. Only replace
// the two application-owned destinations, leaving other rewrites untouched.
function patchBackendRewrites(groups) {
	const expected = new Map([
		["/api/:path*", "http://localhost:3001/api/:path*"],
		["/auth/:path*", "http://localhost:3001/auth/:path*"],
	]);
	const patched = {};
	for (const key of ["beforeFiles", "afterFiles", "fallback"]) {
		patched[key] = groups[key].map((route) => {
			if (expected.get(route.source) !== route.destination) return route;
			expected.delete(route.source);
			return {
				...route,
				destination: apiRewriteOrigin + route.destination.slice("http://localhost:3001".length),
			};
		});
	}
	if (expected.size !== 0) throw new Error("Packaged API or authentication rewrite is unavailable");
	return patched;
}

if (nextConfig._originalRewrites) {
	nextConfig._originalRewrites = patchBackendRewrites(nextConfig._originalRewrites);
}

// In the pinned Next.js production server, the request router uses the
// packaged routes manifest, independently of the standalone configuration.
const routerModule = require.resolve("next/dist/server/lib/router-utils/filesystem");
const router = require(routerModule);
require.cache[routerModule].exports = {
	...router,
	async setupFsCheck(options) {
		const filesystem = await router.setupFsCheck(options);
		return { ...filesystem, rewrites: patchBackendRewrites(filesystem.rewrites) };
	},
};

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
