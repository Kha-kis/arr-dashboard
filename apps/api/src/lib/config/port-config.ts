/**
 * Pure startup settings resolution.
 *
 * Database settings must be read through the owned runtime before calling.
 * Priority: Environment variable > Database setting > Default
 */
import type { FastifyBaseLogger } from "fastify";

interface PortConfig {
	apiPort: number;
	webPort: number;
	source: {
		apiPort: "env" | "database" | "default";
		webPort: "env" | "database" | "default";
	};
}

export interface StartupSettings {
	apiPort: number | null;
	webPort: number | null;
	trustProxy: boolean | number | null;
	secureCookies: boolean | number | null;
}

type StartupEnvironment = Readonly<Record<string, string | undefined>>;

const DEFAULT_API_PORT = 3001;
const DEFAULT_WEB_PORT = 3000;

/**
 * Parse a string environment variable as a boolean.
 * Accepts "true", "1", "yes" (case-insensitive) as truthy; everything else is falsy.
 * Returns undefined if the value is undefined (not set).
 */
export function parseBooleanEnv(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	return ["true", "1", "yes"].includes(value.toLowerCase());
}

/**
 * Get the port configuration for the application.
 * Priority: Environment variable > Database setting > Default
 */
export function getPortConfig(
	dbSettings: Readonly<StartupSettings> | null = null,
	env: StartupEnvironment = process.env,
): PortConfig {
	const envApiPort = env.API_PORT ? Number.parseInt(env.API_PORT, 10) : null;
	const envWebPort = env.PORT ? Number.parseInt(env.PORT, 10) : null;

	// If both env vars are set, use them directly
	if (envApiPort !== null && envWebPort !== null) {
		return {
			apiPort: envApiPort,
			webPort: envWebPort,
			source: {
				apiPort: "env",
				webPort: "env",
			},
		};
	}

	let apiPort: number;
	let apiSource: "env" | "database" | "default";
	if (envApiPort !== null) {
		apiPort = envApiPort;
		apiSource = "env";
	} else if (dbSettings?.apiPort !== null && dbSettings?.apiPort !== undefined) {
		apiPort = dbSettings.apiPort;
		apiSource = "database";
	} else {
		apiPort = DEFAULT_API_PORT;
		apiSource = "default";
	}

	let webPort: number;
	let webSource: "env" | "database" | "default";
	if (envWebPort !== null) {
		webPort = envWebPort;
		webSource = "env";
	} else if (dbSettings?.webPort !== null && dbSettings?.webPort !== undefined) {
		webPort = dbSettings.webPort;
		webSource = "database";
	} else {
		webPort = DEFAULT_WEB_PORT;
		webSource = "default";
	}

	return {
		apiPort,
		webPort,
		source: {
			apiPort: apiSource,
			webPort: webSource,
		},
	};
}

/**
 * Security configuration resolved at startup (before Fastify construction).
 * Priority: Environment variable > Database setting > Default
 */
export interface SecurityConfig {
	trustProxy: boolean;
	secureCookies: boolean | undefined; // undefined = auto-detect from trustProxy
	source: {
		trustProxy: "env" | "database" | "default";
		secureCookies: "env" | "database" | "default";
	};
}

/**
 * Get the security configuration for the application.
 * Priority: Environment variable > Database setting > Default
 */
export function getSecurityConfig(
	dbSettings: Readonly<StartupSettings> | null = null,
	env: StartupEnvironment = process.env,
): SecurityConfig {
	const envTrustProxy = env.TRUST_PROXY;
	const envCookieSecure = env.COOKIE_SECURE;

	// Resolve trustProxy
	let trustProxy: boolean;
	let trustProxySource: "env" | "database" | "default";
	if (envTrustProxy !== undefined) {
		trustProxy = parseBooleanEnv(envTrustProxy) ?? false;
		trustProxySource = "env";
	} else if (dbSettings?.trustProxy !== null && dbSettings?.trustProxy !== undefined) {
		trustProxy = dbSettings.trustProxy === 1 || dbSettings.trustProxy === true;
		trustProxySource = "database";
	} else {
		trustProxy = false;
		trustProxySource = "default";
	}

	// Resolve secureCookies
	let secureCookies: boolean | undefined;
	let secureCookiesSource: "env" | "database" | "default";
	if (envCookieSecure !== undefined) {
		secureCookies = parseBooleanEnv(envCookieSecure) ?? false;
		secureCookiesSource = "env";
	} else if (dbSettings?.secureCookies !== null && dbSettings?.secureCookies !== undefined) {
		secureCookies = dbSettings.secureCookies === 1 || dbSettings.secureCookies === true;
		secureCookiesSource = "database";
	} else {
		secureCookies = undefined; // Auto-detect from trustProxy
		secureCookiesSource = "default";
	}

	return {
		trustProxy,
		secureCookies,
		source: {
			trustProxy: trustProxySource,
			secureCookies: secureCookiesSource,
		},
	};
}

/**
 * Log the port configuration for debugging
 */
export function logPortConfig(config: PortConfig, log?: Pick<FastifyBaseLogger, "info">): void {
	log?.info(
		{
			apiPort: config.apiPort,
			apiSource: config.source.apiPort,
			webPort: config.webPort,
			webSource: config.source.webPort,
		},
		"Port configuration loaded",
	);
}

/**
 * Log the security configuration for debugging
 */
export function logSecurityConfig(
	config: SecurityConfig,
	log?: Pick<FastifyBaseLogger, "info">,
): void {
	log?.info(
		{
			trustProxy: config.trustProxy,
			trustProxySource: config.source.trustProxy,
			secureCookies: config.secureCookies ?? `auto (${config.trustProxy})`,
			secureCookiesSource: config.source.secureCookies,
		},
		"Security configuration loaded",
	);
}
