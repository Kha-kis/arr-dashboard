import path from "node:path";

/**
 * Resolve the secrets.json file path based on DATABASE_URL
 *
 * For SQLite databases (file:), the secrets file is stored in the same directory
 * as the database file. For other databases (PostgreSQL, MySQL), it uses a default path.
 *
 * @param databaseUrl - The DATABASE_URL from config/env
 * @returns Absolute path to secrets.json file
 */
export function resolveSecretsPath(databaseUrl: string): string {
	let secretsPath: string;

	if (databaseUrl.startsWith("file:")) {
		// Extract directory from SQLite database path
		const dbPath = databaseUrl.replace("file:", "");
		const dbDir = path.dirname(dbPath);
		secretsPath = path.join(dbDir, "secrets.json");
	} else {
		// For non-SQLite databases (PostgreSQL, MySQL), use default path
		secretsPath = "./data/secrets.json";
	}

	// Resolve to absolute path to avoid issues with relative paths
	return path.resolve(secretsPath);
}
