/**
 * Port Configuration Reader
 *
 * Reads port configuration at startup before Prisma is initialized.
 * Priority: Environment variable > Database setting > Default
 */
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

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
}

const DEFAULT_API_PORT = 3001;
const DEFAULT_WEB_PORT = 3000;

/**
 * Get the database file path based on environment
 */
function getDatabasePath(): string {
	const databaseUrl = process.env.DATABASE_URL;

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

	// Default paths
	const isDocker =
		process.env.NODE_ENV === "production" || process.cwd().startsWith("/app");
	return isDocker ? "/app/data/prod.db" : resolve(process.cwd(), "dev.db");
}

/**
 * Read port settings from the database
 */
function readPortsFromDatabase(): DbSettings | null {
	const dbPath = getDatabasePath();

	if (!existsSync(dbPath)) {
		return null;
	}

	try {
		const db = new Database(dbPath, { readonly: true });

		// Check if SystemSettings table exists
		const tableExists = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='SystemSettings'"
			)
			.get();

		if (!tableExists) {
			db.close();
			return null;
		}

		// Read the singleton settings row
		const row = db
			.prepare("SELECT apiPort, webPort FROM SystemSettings WHERE id = 1")
			.get() as DbSettings | undefined;

		db.close();

		if (row) {
			return {
				apiPort: row.apiPort,
				webPort: row.webPort,
			};
		}

		return null;
	} catch (error) {
		// Database might not exist yet or be corrupted
		console.warn("[port-config] Could not read from database:", error);
		return null;
	}
}

/**
 * Get the port configuration for the application.
 * Priority: Environment variable > Database setting > Default
 */
export function getPortConfig(): PortConfig {
	const envApiPort = process.env.API_PORT
		? Number.parseInt(process.env.API_PORT, 10)
		: null;
	const envWebPort = process.env.PORT
		? Number.parseInt(process.env.PORT, 10)
		: null;

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
	const dbSettings = readPortsFromDatabase();

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
 * Log the port configuration for debugging
 */
export function logPortConfig(config: PortConfig): void {
	console.log(
		`[port-config] API Port: ${config.apiPort} (source: ${config.source.apiPort})`
	);
	console.log(
		`[port-config] Web Port: ${config.webPort} (source: ${config.source.webPort})`
	);
}
