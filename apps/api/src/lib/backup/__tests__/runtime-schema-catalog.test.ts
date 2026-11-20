import { describe, expect, it } from "vitest";
import {
	planRuntimeSchema,
	type RuntimeSchemaCatalog,
	type RuntimeSchemaColumn,
	type RuntimeSchemaForeignKey,
	type RuntimeSchemaIndex,
	RuntimeSchemaPlanError,
	type RuntimeSchemaRegistry,
	type RuntimeSchemaTable,
} from "../runtime-schema-catalog.js";

const ID: RuntimeSchemaColumn = { name: "id", type: "TEXT", nullable: false, defaultValue: null };
const PARENT_ID: RuntimeSchemaColumn = {
	name: "parentId",
	type: "TEXT",
	nullable: true,
	defaultValue: null,
};
const FK: RuntimeSchemaForeignKey = {
	columns: ["parentId"],
	targetTable: "Parent",
	targetColumns: ["id"],
	onDelete: "CASCADE",
	onUpdate: "CASCADE",
};
const FK_KEY = '[["parentId"],"Parent",["id"],"CASCADE","CASCADE"]';
const INDEX: RuntimeSchemaIndex = {
	name: "Child_parentId_idx",
	unique: false,
	columns: ["parentId"],
	predicate: null,
	valid: true,
};
function table(name: string, patch: Partial<RuntimeSchemaTable> = {}): RuntimeSchemaTable {
	return {
		name,
		columns: [{ ...ID }],
		primaryKey: ["id"],
		indexes: [],
		foreignKeys: [],
		rowCount: 2,
		...patch,
	};
}
function fixtures(provider: "sqlite" | "postgresql" = "sqlite") {
	const catalog: { provider: "sqlite" | "postgresql"; tables: RuntimeSchemaTable[] } = {
		provider,
		tables: [table("Parent"), table("Child")],
	};
	const registry: {
		provider: "sqlite" | "postgresql";
		version: 1;
		targetDigest: string;
		tables: RuntimeSchemaRegistry["tables"][number][];
		orderedAtomIds: string[];
	} = {
		provider,
		version: 1,
		targetDigest: "a".repeat(64),
		tables: ["Parent", "Child"].map((name) => ({
			target: table(name),
			createAtom: `create-${name.toLowerCase()}`,
			addColumnAtoms: {},
			addIndexAtoms: {},
			addForeignKeyAtoms: {},
		})),
		orderedAtomIds: [
			"create-parent",
			"create-child",
			"add-parent-id",
			"add-pages",
			"add-owner",
			"add-child-index",
			"add-child-fk",
		],
	};
	return { catalog, registry };
}
function targetColumn(
	column: RuntimeSchemaColumn,
	atom: string,
	provider: "sqlite" | "postgresql" = "sqlite",
) {
	const f = fixtures(provider);
	f.registry.tables = [
		f.registry.tables[0]!,
		{
			...f.registry.tables[1]!,
			target: table("Child", { columns: [{ ...ID }, column] }),
			addColumnAtoms: { [column.name]: atom },
		},
	];
	return f;
}
function refused(
	catalog: RuntimeSchemaCatalog,
	registry: RuntimeSchemaRegistry,
	category = "incompatible-schema",
) {
	expect(() => planRuntimeSchema(catalog, registry)).toThrow(RuntimeSchemaPlanError);
	try {
		planRuntimeSchema(catalog, registry);
	} catch (error) {
		expect(error).toMatchObject({ category, message: "Database schema upgrade is unavailable." });
		expect(error).not.toHaveProperty("cause");
		expect(error).not.toHaveProperty("catalog");
	}
}

function predecessorFixture() {
	const f = fixtures();
	const predecessor: RuntimeSchemaIndex = {
		name: "Child_old_identity_key",
		unique: true,
		columns: ["id"],
		predicate: null,
		valid: true,
	};
	const replacement: RuntimeSchemaIndex = {
		name: "Child_new_identity_key",
		unique: true,
		columns: ["id", "parentId"],
		predicate: null,
		valid: true,
	};
	const columns = [{ ...ID }, { ...PARENT_ID }];
	f.catalog.tables = [table("Parent"), table("Child", { columns, indexes: [predecessor] })];
	const registry = {
		...f.registry,
		tables: [
			f.registry.tables[0]!,
			{
				...f.registry.tables[1]!,
				target: table("Child", { columns, indexes: [replacement] }),
				addIndexAtoms: { [replacement.name]: "add-child-index" },
			},
		],
		orderedAtomIds: [...f.registry.orderedAtomIds, "drop-old-child-index"],
		predecessorIndexes: [
			{
				tableName: "Child",
				expected: predecessor,
				replacementIndexName: replacement.name,
				dropAtom: "drop-old-child-index",
			},
		],
	};
	return { catalog: f.catalog, registry, predecessor, replacement, columns };
}

describe("native runtime schema planning", () => {
	it("returns a ready plan without inventing migration work", () => {
		const f = fixtures();
		expect(planRuntimeSchema(f.catalog, f.registry)).toEqual({
			provider: "sqlite",
			version: 1,
			targetDigest: "a".repeat(64),
			atomIds: [],
			preservedExtraObjects: 0,
			result: "ready",
		});
	});
	it("creates missing tables in registry order, not catalog order", () => {
		const f = fixtures();
		f.catalog.tables = [];
		f.registry.tables = [...f.registry.tables].reverse();
		expect(planRuntimeSchema(f.catalog, f.registry).atomIds).toEqual([
			"create-parent",
			"create-child",
		]);
	});
	it("selects a registered nullable addition on populated data", () => {
		const f = targetColumn(PARENT_ID, "add-parent-id");
		expect(planRuntimeSchema(f.catalog, f.registry)).toMatchObject({
			result: "upgrade",
			atomIds: ["add-parent-id"],
		});
	});
	it("selects a registered non-null default addition on populated data", () => {
		const f = targetColumn(
			{ name: "completedPages", type: "INTEGER", nullable: false, defaultValue: "0" },
			"add-pages",
		);
		expect(planRuntimeSchema(f.catalog, f.registry).atomIds).toEqual(["add-pages"]);
	});
	it("refuses a required owner column instead of inventing ownership", () => {
		const f = targetColumn(
			{ name: "userId", type: "TEXT", nullable: false, defaultValue: null },
			"add-owner",
		);
		f.catalog.tables = [table("Parent"), table("ServiceInstance")];
		f.registry.tables = [
			f.registry.tables[0]!,
			{
				...f.registry.tables[1]!,
				target: table("ServiceInstance", {
					columns: [
						{ ...ID },
						{ name: "userId", type: "TEXT", nullable: false, defaultValue: null },
					],
				}),
			},
		];
		refused(f.catalog, f.registry, "required-owner-migration");
	});
	it("does not use a literal default to invent ownership for populated connections", () => {
		const column = {
			name: "userId",
			type: "TEXT",
			nullable: false,
			defaultValue: "'guessed-owner'",
		};
		const f = targetColumn(column, "add-owner");
		f.catalog.tables = [table("Parent"), table("ServiceInstance")];
		f.registry.tables = [
			f.registry.tables[0]!,
			{
				...f.registry.tables[1]!,
				target: table("ServiceInstance", { columns: [{ ...ID }, column] }),
			},
		];
		refused(f.catalog, f.registry, "required-owner-migration");
	});
	it("refuses a required addition on other populated tables", () => {
		const f = targetColumn(
			{ name: "userId", type: "TEXT", nullable: false, defaultValue: null },
			"add-owner",
		);
		refused(f.catalog, f.registry);
	});
	it("allows a registered required addition on an actually empty table", () => {
		const f = targetColumn(
			{ name: "userId", type: "TEXT", nullable: false, defaultValue: null },
			"add-owner",
		);
		f.catalog.tables = [table("Parent"), table("Child", { rowCount: 0 })];
		expect(planRuntimeSchema(f.catalog, f.registry).atomIds).toEqual(["add-owner"]);
	});
	it.each(["NULL", "(NULL)", "CURRENT_TIMESTAMP", "random()"])(
		"does not treat %s as a registered safe literal default",
		(defaultValue) => {
			const f = targetColumn(
				{ name: "completedPages", type: "INTEGER", nullable: false, defaultValue },
				"add-pages",
			);
			refused(f.catalog, f.registry);
		},
	);
	it.each([
		{ ...ID, type: "INTEGER" },
		{ ...ID, nullable: true },
		{ ...ID, defaultValue: "'guessed'" },
	])("refuses changed existing column semantics", (column) => {
		const f = fixtures();
		f.catalog.tables = [table("Parent"), table("Child", { columns: [column] })];
		refused(f.catalog, f.registry);
	});
	it("refuses a different existing primary key", () => {
		const f = fixtures();
		f.catalog.tables = [table("Parent"), table("Child", { primaryKey: [] })];
		refused(f.catalog, f.registry);
	});
	it("preserves compatible extras without turning their names into operations", () => {
		const f = fixtures();
		f.catalog.tables = [
			table("Parent"),
			table("Child", {
				columns: [
					{ ...ID },
					{
						name: 'owner_note"; DROP TABLE Child;--',
						type: "TEXT",
						nullable: true,
						defaultValue: null,
					},
				],
				indexes: [
					{ name: "owner_index", unique: false, columns: ["id"], predicate: null, valid: true },
				],
			}),
			table("OwnerExtra"),
		];
		expect(planRuntimeSchema(f.catalog, f.registry)).toMatchObject({
			atomIds: [],
			preservedExtraObjects: 3,
			result: "ready",
		});
	});
	it("adds a registered index on an existing table", () => {
		const f = fixtures();
		f.catalog.tables = [
			table("Parent"),
			table("Child", { columns: [{ ...ID }, { ...PARENT_ID }] }),
		];
		f.registry.tables = [
			f.registry.tables[0]!,
			{
				...f.registry.tables[1]!,
				target: table("Child", { columns: [{ ...ID }, { ...PARENT_ID }], indexes: [INDEX] }),
				addIndexAtoms: { [INDEX.name]: "add-child-index" },
			},
		];
		expect(planRuntimeSchema(f.catalog, f.registry).atomIds).toEqual(["add-child-index"]);
	});
	it("refuses an existing index with different columns rather than hiding a collision", () => {
		const f = fixtures();
		f.catalog.tables = [
			table("Parent"),
			table("Child", {
				columns: [{ ...ID }, { ...PARENT_ID }],
				indexes: [{ ...INDEX, columns: ["id"] }],
			}),
		];
		f.registry.tables = [
			f.registry.tables[0]!,
			{
				...f.registry.tables[1]!,
				target: table("Child", { columns: [{ ...ID }, { ...PARENT_ID }], indexes: [INDEX] }),
				addIndexAtoms: { [INDEX.name]: "add-child-index" },
			},
		];
		refused(f.catalog, f.registry);
	});
	it("covers a SQLite new-column FK only with its registered addition", () => {
		const f = targetColumn(PARENT_ID, "add-parent-id");
		f.registry.tables = [
			f.registry.tables[0]!,
			{
				...f.registry.tables[1]!,
				target: table("Child", { columns: [{ ...ID }, { ...PARENT_ID }], foreignKeys: [FK] }),
			},
		];
		expect(planRuntimeSchema(f.catalog, f.registry).atomIds).toEqual(["add-parent-id"]);
	});
	it("refuses a missing existing-column FK without a constraint atom", () => {
		const f = targetColumn(PARENT_ID, "add-parent-id");
		f.catalog.tables = [
			table("Parent"),
			table("Child", { columns: [{ ...ID }, { ...PARENT_ID }] }),
		];
		f.registry.tables = [
			f.registry.tables[0]!,
			{
				...f.registry.tables[1]!,
				target: table("Child", { columns: [{ ...ID }, { ...PARENT_ID }], foreignKeys: [FK] }),
			},
		];
		refused(f.catalog, f.registry, "constraint-migration-required");
	});
	it("selects PostgreSQL new-column and separate FK atoms in registered order", () => {
		const f = targetColumn(PARENT_ID, "add-parent-id", "postgresql");
		f.registry.tables = [
			f.registry.tables[0]!,
			{
				...f.registry.tables[1]!,
				target: table("Child", { columns: [{ ...ID }, { ...PARENT_ID }], foreignKeys: [FK] }),
				addForeignKeyAtoms: { [FK_KEY]: "add-child-fk" },
			},
		];
		expect(planRuntimeSchema(f.catalog, f.registry).atomIds).toEqual([
			"add-parent-id",
			"add-child-fk",
		]);
	});
	it("refuses a conflicting FK action instead of adding a second contradictory constraint", () => {
		const f = targetColumn(PARENT_ID, "add-parent-id");
		f.catalog.tables = [
			table("Parent"),
			table("Child", {
				columns: [{ ...ID }, { ...PARENT_ID }],
				foreignKeys: [{ ...FK, onDelete: "SET NULL" }],
			}),
		];
		f.registry.tables = [
			f.registry.tables[0]!,
			{
				...f.registry.tables[1]!,
				target: table("Child", { columns: [{ ...ID }, { ...PARENT_ID }], foreignKeys: [FK] }),
				addForeignKeyAtoms: { [FK_KEY]: "add-child-fk" },
			},
		];
		refused(f.catalog, f.registry);
	});
	it("deduplicates a shared registered atom", () => {
		const f = targetColumn(PARENT_ID, "add-parent-id");
		f.registry.tables = [
			f.registry.tables[0]!,
			{
				...f.registry.tables[1]!,
				target: table("Child", { columns: [{ ...ID }, { ...PARENT_ID }], indexes: [INDEX] }),
				addIndexAtoms: { [INDEX.name]: "add-parent-id" },
			},
		];
		expect(planRuntimeSchema(f.catalog, f.registry).atomIds).toEqual(["add-parent-id"]);
	});
	it("refuses an unregistered atom instead of returning executable destination text", () => {
		const f = targetColumn(PARENT_ID, 'DROP TABLE "Child";');
		refused(f.catalog, f.registry, "unknown-schema-state");
	});
	it("refuses duplicate registered atom IDs", () => {
		const f = fixtures();
		f.registry.orderedAtomIds = [...f.registry.orderedAtomIds, "create-child"];
		refused(f.catalog, f.registry, "unknown-schema-state");
	});
	it("refuses duplicate target descriptors", () => {
		const f = fixtures();
		f.registry.tables = [...f.registry.tables, f.registry.tables[0]!];
		refused(f.catalog, f.registry, "unknown-schema-state");
	});
	it("refuses duplicate catalog tables", () => {
		const f = fixtures();
		f.catalog.tables = [...f.catalog.tables, table("Child")];
		refused(f.catalog, f.registry, "unknown-schema-state");
	});
	it("refuses duplicate column metadata", () => {
		const f = fixtures();
		f.catalog.tables = [table("Parent"), table("Child", { columns: [{ ...ID }, { ...ID }] })];
		refused(f.catalog, f.registry, "unknown-schema-state");
	});
	it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		"does not infer empty data from row count %s",
		(rowCount) => {
			const f = fixtures();
			f.catalog.tables = [table("Parent"), table("Child", { rowCount })];
			refused(f.catalog, f.registry, "unknown-schema-state");
		},
	);
	it("refuses an invalid native index", () => {
		const f = fixtures();
		f.catalog.tables = [
			table("Parent"),
			table("Child", { indexes: [{ ...INDEX, columns: ["id"], valid: false }] }),
		];
		refused(f.catalog, f.registry, "unknown-schema-state");
	});
	it("refuses indexes referencing absent columns", () => {
		const f = fixtures();
		f.catalog.tables = [table("Parent"), table("Child", { indexes: [INDEX] })];
		refused(f.catalog, f.registry, "unknown-schema-state");
	});
	it("refuses a provider mismatch", () => {
		const f = fixtures();
		f.catalog.provider = "postgresql";
		refused(f.catalog, f.registry, "unknown-schema-state");
	});
	it("creates a reviewed broader identity index before dropping its exact predecessor", () => {
		const f = predecessorFixture();
		expect(planRuntimeSchema(f.catalog, f.registry)).toMatchObject({
			atomIds: ["add-child-index", "drop-old-child-index"],
			preservedExtraObjects: 0,
		});
	});
	it("drops a validated predecessor without recreating an already valid replacement", () => {
		const f = predecessorFixture();
		f.catalog.tables = [
			table("Parent"),
			table("Child", { columns: f.columns, indexes: [f.predecessor, f.replacement] }),
		];
		expect(planRuntimeSchema(f.catalog, f.registry).atomIds).toEqual(["drop-old-child-index"]);
	});
	it("does not drop an owner index that merely shares the predecessor name", () => {
		const f = predecessorFixture();
		f.catalog.tables = [
			table("Parent"),
			table("Child", { columns: f.columns, indexes: [{ ...f.predecessor, unique: false }] }),
		];
		refused(f.catalog, f.registry);
	});
	it("preserves unrelated owner indexes while planning the reviewed replacement", () => {
		const f = predecessorFixture();
		f.catalog.tables = [
			table("Parent"),
			table("Child", {
				columns: f.columns,
				indexes: [
					f.predecessor,
					{ name: "owner_index", unique: false, columns: ["id"], predicate: null, valid: true },
				],
			}),
		];
		expect(planRuntimeSchema(f.catalog, f.registry)).toMatchObject({
			atomIds: ["add-child-index", "drop-old-child-index"],
			preservedExtraObjects: 1,
		});
	});
	it("refuses a registry that would drop the predecessor before creating the replacement", () => {
		const f = predecessorFixture();
		f.registry.orderedAtomIds = [
			"drop-old-child-index",
			...f.registry.orderedAtomIds.filter((id) => id !== "drop-old-child-index"),
		];
		refused(f.catalog, f.registry, "unknown-schema-state");
	});
	it("does not invent predecessor work after the reviewed upgrade is complete", () => {
		const f = predecessorFixture();
		f.catalog.tables = [
			table("Parent"),
			table("Child", { columns: f.columns, indexes: [f.replacement] }),
		];
		expect(planRuntimeSchema(f.catalog, f.registry)).toMatchObject({
			result: "ready",
			atomIds: [],
		});
	});
	it("returns a frozen plan detached from mutable registry inputs", () => {
		const f = targetColumn(PARENT_ID, "add-parent-id"),
			plan = planRuntimeSchema(f.catalog, f.registry);
		Reflect.set(f.registry.orderedAtomIds, "3", "changed-after-plan");
		expect(plan.atomIds).toEqual(["add-parent-id"]);
		expect(Object.isFrozen(plan)).toBe(true);
		expect(Object.isFrozen(plan.atomIds)).toBe(true);
		expect(() => Reflect.set(plan.atomIds, "0", "changed")).not.toThrow();
		expect(Reflect.set(plan.atomIds, "0", "changed")).toBe(false);
	});
});
