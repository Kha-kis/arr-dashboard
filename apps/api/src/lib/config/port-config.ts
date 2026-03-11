import { existsSync } from "node:fs";
import { resolve } from "node:path";
/**
 * Port Configuration Reader
 *
 * Reads port configuration at startup before Prisma is initialized.
 * Priority: Environment variable > Database setting > Default
 *
 * Note: Direct database reading only works with SQLite. For PostgreSQL,
 * settings are read via Prisma in docker/read-base-path.cjs at container startup.
 */
import Database from "better-sqlite3";
import { loggers } from "../logger.js";

const log = loggers.api;

interface PortConfig {
	apiPort: number;
	webPort: number;
	source: {
		apiPort: "env" | "database" | "default";
		webPort: "env" | "database" | "default";
	};
}

interface DbSettings {
	apiPort: number | null;
	webPort: number | null;
	trustProxy: number | null; // SQLite stores booleans as 0/1
	secureCookies: number | null;
}

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
 * Check if DATABASE_URL is PostgreSQL
 */
function isPostgresDatabase(): boolean {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) return false;
	return databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
}

/**
 * Get the SQLite database file path based on environment.
 * Returns null if DATABASE_URL is not SQLite.
 */
function getSqliteDatabasePath(): string | null {
	const databaseUrl = process.env.DATABASE_URL;

	// Not SQLite if PostgreSQL
	if (isPostgresDatabase()) {
		return null;
	}

	if (databaseUrl) {
		// Extract path from file: URL (e.g., "file:/config/prod.db" or "file:./dev.db")
		const match = databaseUrl.match(/^file:(.+)$/);
		const path = match?.[1];
		if (path) {
			// Handle absolute and relative paths
			if (path.startsWith("/")) {
				return path;
			}
			return resolve(process.cwd(), path);
		}
	}

	// Default paths for SQLite
	const isDocker = process.env.NODE_ENV === "production" || process.cwd().startsWith("/app");
	return isDocker ? "/app/data/prod.db" : resolve(process.cwd(), "dev.db");
}

// Cache the database read result so getPortConfig() and getSecurityConfig()
// don't open the same SQLite file twice at startup
let cachedDbSettings: DbSettings | null | undefined;

/**
 * Read settings from the database (cached after first call).
 * Only works with SQLite - PostgreSQL users must use env vars or Docker's read-base-path.cjs
 */
function readSettingsFromDatabase(): DbSettings | null {
	if (cachedDbSettings !== undefined) {
		return cachedDbSettings;
	}
	cachedDbSettings = readSettingsFromDatabaseUncached();
	return cachedDbSettings;
}

function readSettingsFromDatabaseUncached(): DbSettings | null {
	// Skip direct DB access for PostgreSQL - it's handled by read-base-path.cjs in Docker
	if (isPostgresDatabase()) {
		return null;
	}

	const dbPath = getSqliteDatabasePath();

	if (!dbPath || !existsSync(dbPath)) {
		return null;
	}

	try {
		const db = new Database(dbPath, { readonly: true });

		// Check if system_settings table exists (@@map name; SQLite is case-insensitive)
		const tableExists = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='system_settings'")
			.get();

		if (!tableExists) {
			db.close();
			return null;
		}

		// Read the singleton settings row
		// New columns (trustProxy, secureCookies) may not exist on older schemas — use SELECT *
		// and access fields with fallback to handle missing columns gracefully
		const row = db.prepare("SELECT * FROM system_settings WHERE id = 1").get() as
			| Record<string, unknown>
			| undefined;

		db.close();

		if (row) {
			return {
				apiPort: typeof row.apiPort === "number" ? row.apiPort : null,
				webPort: typeof row.webPort === "number" ? row.webPort : null,
				trustProxy: typeof row.trustProxy === "number" ? row.trustProxy : null,
				secureCookies: typeof row.secureCookies === "number" ? row.secureCookies : null,
			};
		}

		return null;
	} catch (error) {
		// Distinguish first-boot (no DB) from unexpected read failure
		const dbPath = getSqliteDatabasePath();
		if (dbPath && existsSync(dbPath)) {
			log.error(
				{ err: error, dbPath },
				"Database file exists but could not be read — port and security settings falling back to defaults",
			);
		} else {
			log.warn(
				{ err: error },
				"Could not read settings from database (first boot or missing file)",
			);
		}
		return null;
	}
}

/**
 * Get the port configuration for the application.
 * Priority: Environment variable > Database setting > Default
 */
export function getPortConfig(): PortConfig {
	const envApiPort = process.env.API_PORT ? Number.parseInt(process.env.API_PORT, 10) : null;
	const envWebPort = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : null;

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

	// Try to read from database for any missing values
	const dbSettings = readSettingsFromDatabase();

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
export function getSecurityConfig(): SecurityConfig {
	const envTrustProxy = process.env.TRUST_PROXY;
	const envCookieSecure = process.env.COOKIE_SECURE;

	// Try to read from database for any missing values
	const dbSettings = readSettingsFromDatabase();

	// Resolve trustProxy
	let trustProxy: boolean;
	let trustProxySource: "env" | "database" | "default";
	if (envTrustProxy !== undefined) {
		trustProxy = parseBooleanEnv(envTrustProxy) ?? false;
		trustProxySource = "env";
	} else if (dbSettings?.trustProxy !== null && dbSettings?.trustProxy !== undefined) {
		trustProxy = dbSettings.trustProxy === 1;
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
		secureCookies = dbSettings.secureCookies === 1;
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
export function logPortConfig(config: PortConfig): void {
	log.info(
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
export function logSecurityConfig(config: SecurityConfig): void {
	log.info(
		{
			trustProxy: config.trustProxy,
			trustProxySource: config.source.trustProxy,
			secureCookies: config.secureCookies ?? `auto (${config.trustProxy})`,
			secureCookiesSource: config.source.secureCookies,
		},
		"Security configuration loaded",
	);
}
