import { Client } from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "../../prisma.js";
import { openRestoreRuntime, type RestoreRuntime } from "../restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../restore-runtime-client.js";
import { createRuntimePostgresAdapter } from "../restore-runtime-postgres-client.js";
import { synchronizePostgresRuntimeSchema } from "../runtime-schema-postgres.js";

const fixtureUrl = process.env.RUNTIME_SCHEMA_TEST_DATABASE_URL;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

describe.skipIf(!fixtureUrl)("native startup and ordinary PostgreSQL namespace parity", () => {
	let fixture: Client;
	let runtime: RestoreRuntime | undefined;
	let ordinary: ReturnType<typeof createRuntimePrismaClient> | undefined;
	let url: string;
	const schemas = new Set<string>();
	beforeEach(async () => {
		url = fixtureUrl!;
		const parsed = new URL(url);
		if (parsed.hostname !== "127.0.0.1" || !parsed.pathname.endsWith("_test") || parsed.search)
			throw new Error("Owned disposable PostgreSQL fixture required");
		fixture = new Client({ connectionString: url });
		await fixture.connect();
		await synchronizePostgresRuntimeSchema(url);
		await fixture.query('DELETE FROM public."User"');
		await fixture.query(
			'INSERT INTO public."User" (id,username,"updatedAt") VALUES($1,$2,CURRENT_TIMESTAMP)',
			["public-decoy", "public-decoy"],
		);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await ordinary?.close();
		await runtime?.close();
		ordinary = undefined;
		runtime = undefined;
		if (fixture) {
			// Only the synthetic fixture role and schemas created by this suite.
			await fixture.query("ALTER ROLE CURRENT_USER RESET search_path");
			for (const schema of schemas) await fixture.query(`DROP SCHEMA ${quote(schema)} CASCADE`);
			schemas.clear();
			await fixture.end();
		}
	});
	function selected(schema: string) {
		const parsed = new URL(url);
		parsed.searchParams.set("schema", schema);
		return parsed.toString();
	}
	async function createSchema(schema: string) {
		await fixture.query(`CREATE SCHEMA ${quote(schema)}`);
		schemas.add(schema);
	}
	async function open(databaseUrl: string) {
		runtime = await openRestoreRuntime({ databaseUrl });
		ordinary = createRuntimePrismaClient(runtime);
		return runtime;
	}
	async function publicState() {
		return (
			await fixture.query(
				'SELECT row_to_json(c) AS journal,(SELECT json_agg(u ORDER BY id) FROM public."User" u) AS users FROM public."RestoreRuntimeControl" c',
			)
		).rows;
	}
	async function exercise(databaseUrl: string, namespace: string) {
		const before = await publicState();
		const actor = await open(databaseUrl);
		// The public and selected namespaces must not mint separate DB owners.
		await expect(openRestoreRuntime({ databaseUrl: url })).rejects.toThrow();
		const insertSql: string[] = [];
		const native = Client.prototype.query;
		const query = vi.spyOn(Client.prototype, "query").mockImplementation(function (
			this: Client,
			...args: unknown[]
		) {
			const statement = args[0] as string | { text?: string };
			const sql = typeof statement === "string" ? statement : statement?.text;
			if (sql?.startsWith("INSERT INTO") && sql.includes('"User"')) insertSql.push(sql);
			return Reflect.apply(native, this, args);
		} as Client["query"]);
		try {
			await actor.runStarting(() =>
				ordinary!.prisma.user.create({ data: { id: "selected-user", username: "selected-user" } }),
			);
		} finally {
			query.mockRestore();
			// Observe the actual compiler/native SQL boundary, never replace a query.
			expect(insertSql).toHaveLength(1);
			expect(insertSql[0]).toContain(`INSERT INTO ${quote(namespace)}."User"`);
		}
		await actor.bindDestination("namespace-fixture");
		await actor.activate();
		await actor.runOperation(async () => {
			expect(await ordinary!.prisma.user.count()).toBe(1);
			await ordinary!.prisma.serviceInstance.create({
				data: {
					userId: "selected-user",
					service: "PLEX",
					label: "synthetic-namespace-service",
					baseUrl: "https://synthetic.invalid",
					encryptedApiKey: "synthetic-opaque-value",
					encryptionIv: "synthetic-opaque-iv",
				},
			});
			expect(
				await ordinary!.prisma.user.findUnique({
					where: { id: "selected-user" },
					select: { serviceInstances: { select: { service: true } } },
				}),
			).toEqual({ serviceInstances: [{ service: "PLEX" }] });
			await ordinary!.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
				await tx.user.update({ where: { id: "selected-user" }, data: { username: "updated" } });
				expect(await tx.user.count()).toBe(1);
			});
		});
		expect((await fixture.query(`SELECT username FROM ${quote(namespace)}."User"`)).rows).toEqual([
			{ username: "updated" },
		]);
		expect(await publicState()).toEqual(before);
	}
	it("a retired physical backend rejoins the same custom namespace and preserves its data", async () => {
		const schema = "replacement_namespace";
		await createSchema(schema);
		await synchronizePostgresRuntimeSchema(selected(schema));
		const actor = await open(selected(schema));
		await actor.bindDestination("namespace-fixture");
		await actor.activate();
		await actor.runOperation(() =>
			ordinary!.prisma.user.create({ data: { id: "retained-user", username: "retained-user" } }),
		);
		const original = (await actor.runOperation(() =>
			ordinary!.prisma.$queryRawUnsafe("SELECT pg_backend_pid() AS pid"),
		)) as { pid: number }[];
		expect(original).toHaveLength(1);
		expect(
			(await fixture.query("SELECT pg_terminate_backend($1) AS stopped", [original[0]!.pid])).rows,
		).toEqual([{ stopped: true }]);
		let retired = false;
		for (let attempt = 0; attempt < 50; attempt++) {
			const live = await fixture.query(
				"SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid=$1) AS live",
				[original[0]!.pid],
			);
			if (live.rows[0]?.live === false) {
				retired = true;
				break;
			}
			await delay(10);
		}
		expect(retired).toBe(true);
		const before = await publicState();
		await actor.runOperation(async () => {
			expect(await ordinary!.prisma.user.count()).toBe(1);
			const replacement = (await ordinary!.prisma.$queryRawUnsafe(
				"SELECT pg_backend_pid() AS pid",
			)) as { pid: number }[];
			expect(replacement[0]!.pid).not.toBe(original[0]!.pid);
		});
		expect(await publicState()).toEqual(before);
	});
	it("namespace mapping preserves existing ordinary-pool timeout options", async () => {
		const schema = "pool_options_namespace";
		await createSchema(schema);
		const configured = new URL(selected(schema));
		configured.searchParams.set("statement_timeout", "7500");
		configured.searchParams.set("query_timeout", "8000");
		await synchronizePostgresRuntimeSchema(configured.toString());
		const actor = await open(configured.toString());
		const adapter = createRuntimePostgresAdapter(actor);
		try {
			const driver = await actor.runStarting(() => adapter.connect());
			await actor.runStarting(async () => {
				const pool = driver.underlyingDriver();
				expect(
					(await pool.query("SELECT current_setting('statement_timeout') AS timeout")).rows,
				).toEqual([{ timeout: "7500ms" }]);
				const mapped = new URL(pool.options.connectionString!);
				expect(mapped.searchParams.get("query_timeout")).toBe("8000");
				expect(mapped.searchParams.has("schema")).toBe(false);
			});
		} finally {
			await adapter.close();
		}
	});
	it.each(["selected_namespace", 'quoted " namespace', 'quoted"; DROP SCHEMA public CASCADE; --'])(
		"native writer and guarded Prisma CRUD use explicit schema %s, never public decoys",
		async (schema) => {
			await createSchema(schema);
			await synchronizePostgresRuntimeSchema(selected(schema));
			await exercise(selected(schema), schema);
		},
	);
	it("implicit single-schema role search_path selects the same native writer and Prisma namespace", async () => {
		const schema = "role_selected_namespace";
		await createSchema(schema);
		await fixture.query(`ALTER ROLE CURRENT_USER SET search_path TO ${quote(schema)}`);
		await synchronizePostgresRuntimeSchema(url);
		await exercise(url, schema);
	});
	it.each(["schema=", "schema=public&schema=missing", "schema=missing", "schema=public%00junk"])(
		"ordinary admission refuses invalid or absent selected schema (%s) without public journal writes",
		async (query) => {
			const before = await publicState();
			await expect(open(`${url}?${query}`)).rejects.toThrow();
			expect(await publicState()).toEqual(before);
		},
	);
	it("ambiguous effective namespaces refuse before changing either journal", async () => {
		const schema = "ambiguous_namespace";
		await createSchema(schema);
		await synchronizePostgresRuntimeSchema(selected(schema));
		const before = await publicState();
		const configured = new URL(url);
		configured.searchParams.set("options", `-c search_path=${schema},public`);
		await expect(open(configured.toString())).rejects.toThrow();
		expect(await publicState()).toEqual(before);
	});
	it("a changed physical session search_path fences ordinary queries instead of reading public data", async () => {
		const schema = "session_namespace";
		await createSchema(schema);
		await synchronizePostgresRuntimeSchema(selected(schema));
		const actor = await open(selected(schema));
		await actor.bindDestination("namespace-fixture");
		await actor.activate();
		const before = await publicState();
		await actor.runOperation(() => ordinary!.prisma.$executeRawUnsafe("SET search_path TO public"));
		await expect(actor.runOperation(() => ordinary!.prisma.user.count())).rejects.toThrow();
		expect(await publicState()).toEqual(before);
	});
	it("dropping and recreating the selected namespace does not inherit the old runtime's authority", async () => {
		const schema = "recreated_namespace";
		await createSchema(schema);
		await synchronizePostgresRuntimeSchema(selected(schema));
		const actor = await open(selected(schema));
		const journal = (await fixture.query(`SELECT * FROM ${quote(schema)}."RestoreRuntimeControl"`))
			.rows[0]!;
		await fixture.query(`DROP SCHEMA ${quote(schema)} CASCADE`);
		await fixture.query(`CREATE SCHEMA ${quote(schema)}`);
		await fixture.query(
			`CREATE TABLE ${quote(schema)}."RestoreRuntimeControl" (LIKE public."RestoreRuntimeControl" INCLUDING ALL)`,
		);
		const columns = Object.keys(journal);
		await fixture.query(
			`INSERT INTO ${quote(schema)}."RestoreRuntimeControl" (${columns.map(quote).join(",")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(",")})`,
			columns.map((column) => journal[column]),
		);
		const before = await publicState();
		await expect(actor.runStarting(async () => "must-not-run")).rejects.toThrow();
		expect(await publicState()).toEqual(before);
	});
});
