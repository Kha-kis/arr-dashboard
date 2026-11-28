import type { Client } from "pg";

export type PostgresRuntimeNamespace = Readonly<{ name: string; oid: string }>;
type NativeClient = Pick<Client, "query">;

class PostgresRuntimeNamespaceError extends Error {
	constructor() {
		super("PostgreSQL runtime namespace is unavailable.");
	}
}

/** Shared transport mapping; Prisma's schema field is not a node-pg option. */
export function parsePostgresRuntimeUrl(
	databaseUrl: string,
	options: { actorBounds?: boolean } = {},
): {
	connectionString: string;
	schema: string | null;
} {
	try {
		const parsed = new URL(databaseUrl);
		if (!["postgresql:", "postgres:"].includes(parsed.protocol))
			throw new PostgresRuntimeNamespaceError();
		const schemas = parsed.searchParams.getAll("schema");
		if (schemas.length > 1 || (schemas.length && (!schemas[0] || schemas[0].includes("\0"))))
			throw new PostgresRuntimeNamespaceError();
		// URL fields override node-pg config. Keep actor-owned transport bounds
		// under the caller's control while retaining ordinary connection options.
		parsed.searchParams.delete("schema");
		if (options.actorBounds !== false)
			for (const key of [
				"query_timeout",
				"statement_timeout",
				"lock_timeout",
				"idle_in_transaction_session_timeout",
				"connectionTimeoutMillis",
				"application_name",
				"replication",
			])
				parsed.searchParams.delete(key);
		return { connectionString: parsed.toString(), schema: schemas[0] ?? null };
	} catch {
		throw new PostgresRuntimeNamespaceError();
	}
}

async function readNamespace(client: NativeClient): Promise<PostgresRuntimeNamespace> {
	const result = await client.query<{
		name: unknown;
		namespaces: unknown;
		oid: unknown;
	}>(
		`SELECT pg_catalog.current_schema() AS name,
		pg_catalog.current_schemas(false)::text[] AS namespaces, n.oid::text AS oid
		FROM pg_catalog.pg_namespace n WHERE n.nspname=pg_catalog.current_schema()`,
	);
	const row = result.rows[0];
	if (
		result.rows.length !== 1 ||
		!row ||
		typeof row.name !== "string" ||
		!row.name ||
		!Array.isArray(row.namespaces) ||
		row.namespaces.length !== 1 ||
		row.namespaces[0] !== row.name ||
		typeof row.oid !== "string" ||
		!/^[1-9]\d*$/.test(row.oid)
	)
		throw new PostgresRuntimeNamespaceError();
	return Object.freeze({ name: row.name, oid: row.oid });
}

/** Select once, then pin every new native connection to that existing namespace. */
export async function selectPostgresRuntimeNamespace(
	client: NativeClient,
	requested: string | null,
	expected?: PostgresRuntimeNamespace,
): Promise<PostgresRuntimeNamespace> {
	const selected = requested ?? expected?.name;
	if (selected !== undefined) {
		if (!selected || selected.includes("\0")) throw new PostgresRuntimeNamespaceError();
		await client.query("SELECT pg_catalog.set_config('search_path',$1,false)", [
			`"${selected.replaceAll('"', '""')}"`,
		]);
	}
	const actual = await readNamespace(client);
	if (
		(selected !== undefined && actual.name !== selected) ||
		(expected && (actual.name !== expected.name || actual.oid !== expected.oid))
	)
		throw new PostgresRuntimeNamespaceError();
	return actual;
}

/** Never repair a loaned session's changed search_path while admitting work. */
export async function assertPostgresRuntimeNamespace(
	client: NativeClient,
	expected: PostgresRuntimeNamespace,
): Promise<void> {
	const actual = await readNamespace(client);
	if (actual.name !== expected.name || actual.oid !== expected.oid)
		throw new PostgresRuntimeNamespaceError();
}
