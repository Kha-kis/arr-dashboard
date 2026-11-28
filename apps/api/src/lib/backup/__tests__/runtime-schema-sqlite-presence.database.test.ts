import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	planRuntimeSchema,
	type RuntimeSchemaCatalog,
	type RuntimeSchemaPlanningCatalog,
	type RuntimeSchemaRegistry,
} from "../runtime-schema-catalog.js";
import {
	readSqliteRuntimeSchemaCatalog,
	readSqliteRuntimeSchemaPlanningCatalog,
} from "../runtime-schema-sqlite.js";

const id = { name: "id", type: "INTEGER;ROWID", nullable: false, defaultValue: null };
function registry(name: string, extraColumn = false): RuntimeSchemaRegistry {
	return {
		provider: "sqlite",
		version: 1,
		targetDigest: "a".repeat(64),
		orderedAtomIds: ["create-table", "add-required"],
		tables: [
			{
				target: {
					name,
					columns: [
						id,
						...(extraColumn
							? [{ name: "userId", type: "TEXT", nullable: false, defaultValue: null }]
							: []),
					],
					primaryKey: ["id"],
					indexes: [],
					foreignKeys: [],
					rowCount: 0,
				},
				createAtom: "create-table",
				addColumnAtoms: extraColumn ? { userId: "add-required" } : {},
				addIndexAtoms: {},
				addForeignKeyAtoms: {},
			},
		],
	};
}

describe("transaction-bound SQLite planning presence", () => {
	let db: Database.Database;
	beforeEach(() => {
		db = new Database(":memory:");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		if (db.open) db.close();
	});
	const seed = (name: string, count: number) => {
		db.exec(`CREATE TABLE "${name}"(id INTEGER PRIMARY KEY)`);
		const insert = db.prepare(`INSERT INTO "${name}" VALUES(?)`);
		for (let index = 0; index < count; index++) insert.run(index);
	};

	it("keeps exact 0/2/64 counts separate from bounded presence and exact three-row OIDC evidence", () => {
		seed("Empty", 0);
		seed("Pair", 2);
		seed("Many", 64);
		seed("oidc_providers", 3);
		const before = db.serialize();
		db.exec("BEGIN");
		const original = db.prepare;
		const queries: string[] = [];
		vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
			queries.push(sql);
			return original.call(db, sql);
		});
		const exact = readSqliteRuntimeSchemaCatalog(db, []);
		expect(exact.tables.map(({ name, rowCount }) => [name, rowCount])).toEqual([
			["Empty", 0],
			["Many", 64],
			["Pair", 2],
			["oidc_providers", 3],
		]);
		expect(queries.filter((sql) => sql.startsWith("SELECT COUNT"))).toHaveLength(4);
		queries.length = 0;
		const planning = readSqliteRuntimeSchemaPlanningCatalog(db, []);
		expect(
			planning.tables.map((table) => ({
				name: table.name,
				...("rowPresence" in table
					? { rowPresence: table.rowPresence }
					: { rowCount: table.rowCount }),
			})),
		).toEqual([
			{ name: "Empty", rowPresence: "empty" },
			{ name: "Many", rowPresence: "nonempty" },
			{ name: "Pair", rowPresence: "nonempty" },
			{ name: "oidc_providers", rowCount: 3 },
		]);
		for (const table of planning.tables) {
			if (table.name !== "oidc_providers") expect(table).not.toHaveProperty("rowCount");
		}
		expect(queries.filter((sql) => sql.startsWith("SELECT COUNT"))).toEqual([
			'SELECT COUNT(*) AS count FROM main."oidc_providers"',
		]);
		expect(queries.filter((sql) => sql.startsWith("SELECT 1 AS present"))).toEqual([
			'SELECT 1 AS present FROM main."Empty" LIMIT 1',
			'SELECT 1 AS present FROM main."Many" LIMIT 1',
			'SELECT 1 AS present FROM main."Pair" LIMIT 1',
		]);
		expect(db.inTransaction).toBe(true);
		expect(db.serialize()).toEqual(before);
		db.exec("ROLLBACK");
	});

	it.each([0, 2, 64])(
		"preserves native planner outcomes for %i rows without inventing ownership",
		(count) => {
			seed("ServiceInstance", count);
			db.exec("BEGIN");
			for (const catalog of [
				readSqliteRuntimeSchemaCatalog(db, []),
				readSqliteRuntimeSchemaPlanningCatalog(db, []),
			]) {
				if (count === 0)
					expect(planRuntimeSchema(catalog, registry("ServiceInstance", true)).atomIds).toEqual([
						"add-required",
					]);
				else
					expect(() => planRuntimeSchema(catalog, registry("ServiceInstance", true))).toThrow(
						expect.objectContaining({ category: "required-owner-migration" }),
					);
			}
		},
	);
	it.each([0, 2, 64])("preserves required-column safety for %i ordinary rows", (count) => {
		seed("Ordinary", count);
		db.exec("BEGIN");
		for (const catalog of [
			readSqliteRuntimeSchemaCatalog(db, []),
			readSqliteRuntimeSchemaPlanningCatalog(db, []),
		]) {
			if (count === 0)
				expect(planRuntimeSchema(catalog, registry("Ordinary", true)).atomIds).toEqual([
					"add-required",
				]);
			else
				expect(() => planRuntimeSchema(catalog, registry("Ordinary", true))).toThrow(
					expect.objectContaining({ category: "incompatible-schema" }),
				);
		}
	});
	it("preserves compatible extras and rejects incompatible native semantics in either projection", () => {
		seed("Ordinary", 2);
		seed("Extra", 64);
		db.exec("ALTER TABLE Ordinary ADD COLUMN note TEXT; BEGIN");
		for (const catalog of [
			readSqliteRuntimeSchemaCatalog(db, []),
			readSqliteRuntimeSchemaPlanningCatalog(db, []),
		]) {
			expect(planRuntimeSchema(catalog, registry("Ordinary"))).toMatchObject({
				atomIds: [],
				preservedExtraObjects: 2,
				result: "ready",
			});
			const wrong = registry("Ordinary");
			const incompatible = {
				...wrong,
				tables: [
					{
						...wrong.tables[0]!,
						target: { ...wrong.tables[0]!.target, columns: [{ ...id, type: "TEXT" }] },
					},
				],
			};
			expect(() => planRuntimeSchema(catalog, incompatible)).toThrow(
				expect.objectContaining({ category: "incompatible-schema" }),
			);
		}
	});
	it.each([
		"missing",
		"ambiguous",
		"invalid-presence",
		"negative",
		"fraction",
		"unsafe",
		"infinite",
		"nan",
		"getter",
		"prototype",
	])("refuses %s cardinality evidence without reading getters", (kind) => {
		seed("Ordinary", 2);
		db.exec("BEGIN");
		const native = readSqliteRuntimeSchemaPlanningCatalog(db, []);
		const table = { ...native.tables[0]! } as Record<string, unknown>;
		delete table.rowPresence;
		let getters = 0;
		if (kind === "ambiguous") Object.assign(table, { rowPresence: "empty", rowCount: 2 });
		if (kind === "invalid-presence") table.rowPresence = "unknown";
		if (kind === "negative") table.rowCount = -1;
		if (kind === "fraction") table.rowCount = 0.5;
		if (kind === "unsafe") table.rowCount = Number.MAX_SAFE_INTEGER + 1;
		if (kind === "infinite") table.rowCount = Infinity;
		if (kind === "nan") table.rowCount = NaN;
		if (kind === "getter")
			Object.defineProperty(table, "rowPresence", {
				get() {
					getters++;
					return "empty";
				},
			});
		if (kind === "prototype") Object.setPrototypeOf(table, { rowPresence: "empty" });
		const forged = { ...native, tables: [table] } as unknown as RuntimeSchemaPlanningCatalog;
		expect(() => planRuntimeSchema(forged, registry("Ordinary", true))).toThrow(
			expect.objectContaining({ category: "unknown-schema-state" }),
		);
		expect(getters).toBe(0);
	});
	it("does not permit presence in exact registry targets or PostgreSQL catalogs", () => {
		seed("Ordinary", 2);
		db.exec("BEGIN");
		const planning = readSqliteRuntimeSchemaPlanningCatalog(db, []);
		const target = { ...registry("Ordinary").tables[0]!, target: planning.tables[0]! };
		expect(() =>
			planRuntimeSchema(planning, {
				...registry("Ordinary"),
				tables: [target],
			} as unknown as RuntimeSchemaRegistry),
		).toThrow();
		expect(() =>
			planRuntimeSchema(
				{ ...planning, provider: "postgresql" } as unknown as RuntimeSchemaCatalog,
				{ ...registry("Ordinary"), provider: "postgresql" },
			),
		).toThrow();
	});
	it.each([
		"no-transaction",
		"closed",
		"unreadable-presence",
		"unreadable-schema",
		"temp-shadow",
		"incompatible-schema",
	])("fails closed for %s native reads", (kind) => {
		seed("Ordinary", 2);
		if (kind === "closed") db.close();
		if (kind !== "closed" && kind !== "no-transaction") db.exec("BEGIN");
		if (kind === "temp-shadow") db.exec("CREATE TEMP TABLE Ordinary(id INTEGER)");
		if (kind === "incompatible-schema") db.exec("CREATE TABLE Unsupported(id INTEGER CHECK(id>0))");
		if (kind.startsWith("unreadable")) {
			const original = db.prepare;
			vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
				if (kind === "unreadable-schema" || sql.startsWith("SELECT 1 AS present"))
					return original.call(db, "SELECT missing FROM nonexistent");
				return original.call(db, sql);
			});
		}
		expect(() => readSqliteRuntimeSchemaPlanningCatalog(db, ["Ordinary"])).toThrow(
			expect.objectContaining({ category: "unknown-schema-state" }),
		);
	});
});
