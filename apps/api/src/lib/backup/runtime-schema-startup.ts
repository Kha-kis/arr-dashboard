import { isIP } from "node:net";

export type RuntimeSchemaStartupSettings = Readonly<{
	apiPort: number | null;
	webPort: number | null;
	listenAddress: string | null;
}>;

export class RuntimeSchemaStartupError extends Error {
	constructor(
		readonly category:
			| "startup-unavailable"
			| "commit-unknown"
			| "format-migration-required"
			| "closure-unverified" = "startup-unavailable",
	) {
		super("Database schema startup is unavailable.");
		this.name = "RuntimeSchemaStartupError";
	}
}

/** Pre-launch provider dispatch; never infer SQLite from an unknown URL scheme. */
export async function synchronizeRuntimeSchema(
	databaseUrl: string,
): Promise<RuntimeSchemaStartupSettings> {
	if (typeof databaseUrl !== "string") throw new RuntimeSchemaStartupError();
	if (/^postgres(ql)?:\/\//i.test(databaseUrl))
		return (await import("./runtime-schema-postgres.js")).synchronizePostgresRuntimeSchema(
			databaseUrl,
		);
	if (databaseUrl.startsWith("file:"))
		return (await import("./runtime-schema-sqlite.js")).synchronizeSqliteRuntimeSchema(databaseUrl);
	throw new RuntimeSchemaStartupError();
}

/** Missing singleton is not a failed read. The caller must successfully read all rows. */
export function parseRuntimeSchemaStartupSettings(
	rows: readonly Record<string, unknown>[],
): RuntimeSchemaStartupSettings {
	if (rows.length === 0)
		return Object.freeze({ apiPort: null, webPort: null, listenAddress: null });
	if (rows.length !== 1) throw new RuntimeSchemaStartupError();
	const row = rows[0]!;
	if (
		row.id !== 1 ||
		[row.apiPort, row.webPort].some(
			(value) =>
				typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 65535,
		)
	)
		throw new RuntimeSchemaStartupError();
	const address = row.listenAddress;
	if (
		typeof address !== "string" ||
		address.length > 253 ||
		!(
			isIP(address) ||
			address.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
		)
	)
		throw new RuntimeSchemaStartupError();
	return Object.freeze({
		apiPort: row.apiPort as number,
		webPort: row.webPort as number,
		listenAddress: address,
	});
}
