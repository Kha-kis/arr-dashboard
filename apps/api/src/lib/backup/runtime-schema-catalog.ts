export type RuntimeSchemaColumn = Readonly<{
	name: string;
	type: string;
	nullable: boolean;
	defaultValue: string | null;
}>;
export type RuntimeSchemaIndex = Readonly<{
	name: string;
	unique: boolean;
	columns: readonly string[];
	predicate: string | null;
	valid: boolean;
}>;
export type RuntimeSchemaForeignKey = Readonly<{
	columns: readonly string[];
	targetTable: string;
	targetColumns: readonly string[];
	onDelete: string;
	onUpdate: string;
}>;
export type RuntimeSchemaTable = Readonly<{
	name: string;
	columns: readonly RuntimeSchemaColumn[];
	primaryKey: readonly string[];
	indexes: readonly RuntimeSchemaIndex[];
	foreignKeys: readonly RuntimeSchemaForeignKey[];
	rowCount: number;
}>;
export type RuntimeSchemaCatalog = Readonly<{
	provider: "sqlite" | "postgresql";
	tables: readonly RuntimeSchemaTable[];
}>;
/** Presence is sufficient for SQLite planning, but is never an exact observed count. */
export type RuntimeSchemaPlanningTable =
	| RuntimeSchemaTable
	| Readonly<
			Omit<RuntimeSchemaTable, "rowCount"> & {
				rowPresence: "empty" | "nonempty";
				rowCount?: never;
			}
	  >;
export type RuntimeSchemaPlanningCatalog = Readonly<{
	provider: "sqlite";
	tables: readonly RuntimeSchemaPlanningTable[];
}>;
export type RuntimeSchemaRegistry = Readonly<{
	provider: "sqlite" | "postgresql";
	version: 1;
	targetDigest: string;
	tables: readonly Readonly<{
		target: RuntimeSchemaTable;
		createAtom: string;
		addColumnAtoms: Readonly<Record<string, string>>;
		addIndexAtoms: Readonly<Record<string, string>>;
		addForeignKeyAtoms: Readonly<Record<string, string>>;
	}>[];
	orderedAtomIds: readonly string[];
	predecessorIndexes?: readonly Readonly<{
		tableName: string;
		expected: RuntimeSchemaIndex;
		replacementIndexName: string;
		dropAtom: string;
	}>[];
}>;
export type RuntimeSchemaPlan = Readonly<{
	provider: "sqlite" | "postgresql";
	version: 1;
	targetDigest: string;
	atomIds: readonly string[];
	preservedExtraObjects: number;
	result: "ready" | "upgrade";
}>;
type PlanErrorCategory =
	| "incompatible-schema"
	| "required-owner-migration"
	| "constraint-migration-required"
	| "unknown-schema-state";
export class RuntimeSchemaPlanError extends Error {
	constructor(readonly category: PlanErrorCategory) {
		super("Database schema upgrade is unavailable.");
		this.name = "RuntimeSchemaPlanError";
	}
}

function unknown(): never {
	throw new RuntimeSchemaPlanError("unknown-schema-state");
}

function dataObject(value: unknown): void {
	if (typeof value !== "object" || value === null) unknown();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) unknown();
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (typeof key !== "string" || !descriptor || !("value" in descriptor)) unknown();
	}
}

function array(value: unknown): void {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) unknown();
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (
			typeof key !== "string" ||
			(key !== "length" && !/^(0|[1-9]\d*)$/.test(key)) ||
			!descriptor ||
			!("value" in descriptor)
		)
			unknown();
	}
}

function name(value: unknown): void {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) unknown();
}

function names(values: readonly string[], allowEmpty = false): void {
	array(values);
	if ((!allowEmpty && values.length === 0) || new Set(values).size !== values.length) unknown();
	values.forEach(name);
}

function foreignKeyKey(foreignKey: RuntimeSchemaForeignKey): string {
	return JSON.stringify([
		foreignKey.columns,
		foreignKey.targetTable,
		foreignKey.targetColumns,
		foreignKey.onDelete,
		foreignKey.onUpdate,
	]);
}

function validateTable(table: RuntimeSchemaPlanningTable, allowPresence = false): void {
	dataObject(table);
	name(table.name);
	if (Object.hasOwn(table, "rowPresence")) {
		if (
			!allowPresence ||
			Object.hasOwn(table, "rowCount") ||
			!("rowPresence" in table) ||
			!["empty", "nonempty"].includes(table.rowPresence)
		)
			unknown();
	} else if (
		!Number.isSafeInteger(table.rowCount) ||
		table.rowCount === undefined ||
		table.rowCount < 0
	)
		unknown();
	array(table.columns);
	array(table.indexes);
	array(table.foreignKeys);
	if (table.columns.length === 0) unknown();
	const columns = new Set<string>();
	for (const column of table.columns) {
		dataObject(column);
		name(column.name);
		name(column.type);
		if (
			columns.has(column.name) ||
			typeof column.nullable !== "boolean" ||
			(column.defaultValue !== null && typeof column.defaultValue !== "string")
		)
			unknown();
		columns.add(column.name);
	}
	names(table.primaryKey, true);
	if (table.primaryKey.some((column) => !columns.has(column))) unknown();
	const indexes = new Set<string>();
	for (const index of table.indexes) {
		dataObject(index);
		name(index.name);
		names(index.columns);
		if (
			indexes.has(index.name) ||
			typeof index.unique !== "boolean" ||
			index.valid !== true ||
			(index.predicate !== null && typeof index.predicate !== "string") ||
			index.columns.some((column) => !columns.has(column))
		)
			unknown();
		indexes.add(index.name);
	}
	const foreignKeys = new Set<string>();
	for (const foreignKey of table.foreignKeys) {
		dataObject(foreignKey);
		names(foreignKey.columns);
		names(foreignKey.targetColumns);
		name(foreignKey.targetTable);
		if (
			!["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"].includes(
				foreignKey.onDelete,
			) ||
			!["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"].includes(
				foreignKey.onUpdate,
			) ||
			foreignKey.columns.length !== foreignKey.targetColumns.length ||
			foreignKey.columns.some((column) => !columns.has(column))
		)
			unknown();
		const key = JSON.stringify(foreignKey.columns);
		if (foreignKeys.has(key)) unknown();
		foreignKeys.add(key);
	}
}

function tableMap(
	tables: readonly RuntimeSchemaPlanningTable[],
	allowPresence = false,
): Map<string, RuntimeSchemaPlanningTable> {
	array(tables);
	const result = new Map<string, RuntimeSchemaPlanningTable>();
	const indexNames = new Set<string>();
	for (const table of tables) {
		validateTable(table, allowPresence);
		if (result.has(table.name)) unknown();
		result.set(table.name, table);
		for (const index of table.indexes) {
			if (indexNames.has(index.name)) unknown();
			indexNames.add(index.name);
		}
	}
	for (const table of tables) {
		for (const foreignKey of table.foreignKeys) {
			const parent = result.get(foreignKey.targetTable);
			if (
				!parent ||
				foreignKey.targetColumns.some(
					(column) => !parent.columns.some((candidate) => candidate.name === column),
				)
			)
				unknown();
		}
	}
	return result;
}

/** Validate before copying a catalog so cloning cannot erase unsafe evidence. */
export function validateRuntimeSchemaCatalog(
	catalog: RuntimeSchemaCatalog | RuntimeSchemaPlanningCatalog,
): void {
	try {
		dataObject(catalog);
		if (catalog.provider !== "sqlite" && catalog.provider !== "postgresql") unknown();
		tableMap(catalog.tables, catalog.provider === "sqlite");
	} catch {
		unknown();
	}
}

function safeLiteralDefault(value: string | null): boolean {
	return (
		value !== null && /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)|TRUE|FALSE|'(?:[^']|'')*')$/i.test(value)
	);
}

function sameColumns(left: RuntimeSchemaColumn, right: RuntimeSchemaColumn): boolean {
	return (
		left.type === right.type &&
		left.nullable === right.nullable &&
		left.defaultValue === right.defaultValue
	);
}

function sameIndex(left: RuntimeSchemaIndex, right: RuntimeSchemaIndex): boolean {
	return (
		left.unique === right.unique &&
		left.predicate === right.predicate &&
		JSON.stringify(left.columns) === JSON.stringify(right.columns)
	);
}

/** Pure preflight only. Registry IDs are not SQL or native ownership. */
export function planRuntimeSchema(
	catalog: RuntimeSchemaCatalog | RuntimeSchemaPlanningCatalog,
	registry: RuntimeSchemaRegistry,
): Readonly<RuntimeSchemaPlan> {
	try {
		dataObject(catalog);
		dataObject(registry);
		if (
			(registry.provider !== "sqlite" && registry.provider !== "postgresql") ||
			catalog.provider !== registry.provider ||
			registry.version !== 1 ||
			typeof registry.targetDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(registry.targetDigest)
		)
			unknown();
		names(registry.orderedAtomIds);
		if (registry.orderedAtomIds.some((id) => !/^[a-z0-9][a-z0-9._:-]{0,159}$/.test(id))) unknown();
		array(registry.tables);
		if (registry.tables.length === 0) unknown();
		for (const definition of registry.tables) dataObject(definition);
		const existing = tableMap(catalog.tables, catalog.provider === "sqlite");
		const targets = tableMap(registry.tables.map((definition) => definition.target));
		const registered = new Set(registry.orderedAtomIds);
		const selected = new Set<string>();
		const select = (atom: string | undefined): void => {
			if (typeof atom !== "string" || !registered.has(atom)) unknown();
			selected.add(atom);
		};
		const lookup = (record: Readonly<Record<string, string>>, key: string): string | undefined =>
			Object.hasOwn(record, key) ? record[key] : undefined;
		for (const definition of registry.tables) {
			if (!registered.has(definition.createAtom)) unknown();
			for (const [record, keys] of [
				[definition.addColumnAtoms, definition.target.columns.map((column) => column.name)],
				[definition.addIndexAtoms, definition.target.indexes.map((index) => index.name)],
				[definition.addForeignKeyAtoms, definition.target.foreignKeys.map(foreignKeyKey)],
			] as const) {
				dataObject(record);
				for (const [key, atom] of Object.entries(record)) {
					if (!keys.includes(key) || !registered.has(atom)) unknown();
				}
			}
		}
		const removedPredecessors = new Set<string>();
		const predecessorRules = registry.predecessorIndexes ?? [];
		array(predecessorRules);
		const seenPredecessors = new Set<string>();
		for (const rule of predecessorRules) {
			dataObject(rule);
			name(rule.tableName);
			name(rule.replacementIndexName);
			const definition = registry.tables.find(
				(candidate) => candidate.target.name === rule.tableName,
			);
			if (!definition) unknown();
			validateTable({ ...definition.target, indexes: [rule.expected], foreignKeys: [] });
			const replacement = definition.target.indexes.find(
				(index) => index.name === rule.replacementIndexName,
			);
			const createAtom = lookup(definition.addIndexAtoms, rule.replacementIndexName);
			const key = JSON.stringify([rule.tableName, rule.expected.name]);
			if (
				!replacement?.unique ||
				!rule.expected.unique ||
				rule.expected.name === replacement.name ||
				replacement.predicate !== rule.expected.predicate ||
				replacement.columns.length <= rule.expected.columns.length ||
				!rule.expected.columns.every((column) => replacement.columns.includes(column)) ||
				createAtom === undefined ||
				!registered.has(rule.dropAtom) ||
				registry.orderedAtomIds.indexOf(createAtom) >=
					registry.orderedAtomIds.indexOf(rule.dropAtom) ||
				seenPredecessors.has(key)
			)
				unknown();
			seenPredecessors.add(key);
			const actual = existing
				.get(rule.tableName)
				?.indexes.find((index) => index.name === rule.expected.name);
			if (!actual) continue;
			if (!sameIndex(actual, rule.expected))
				throw new RuntimeSchemaPlanError("incompatible-schema");
			select(rule.dropAtom);
			removedPredecessors.add(key);
		}
		let preservedExtraObjects = 0;
		for (const table of catalog.tables) {
			if (!targets.has(table.name)) preservedExtraObjects++;
		}
		for (const definition of registry.tables) {
			const target = definition.target;
			const actual = existing.get(target.name);
			const addedColumns = new Set<string>();
			if (!actual) {
				select(definition.createAtom);
			} else {
				if (JSON.stringify(actual.primaryKey) !== JSON.stringify(target.primaryKey))
					throw new RuntimeSchemaPlanError("incompatible-schema");
				for (const column of target.columns) {
					const present = actual.columns.find((candidate) => candidate.name === column.name);
					if (present) {
						if (!sameColumns(present, column))
							throw new RuntimeSchemaPlanError("incompatible-schema");
						continue;
					}
					const populated =
						"rowPresence" in actual ? actual.rowPresence === "nonempty" : actual.rowCount > 0;
					if (populated && target.name === "ServiceInstance" && column.name === "userId")
						throw new RuntimeSchemaPlanError("required-owner-migration");
					if (populated && !column.nullable && !safeLiteralDefault(column.defaultValue))
						throw new RuntimeSchemaPlanError("incompatible-schema");
					select(lookup(definition.addColumnAtoms, column.name));
					addedColumns.add(column.name);
				}
				preservedExtraObjects += actual.columns.filter(
					(column) => !target.columns.some((candidate) => candidate.name === column.name),
				).length;
			}
			for (const index of target.indexes) {
				const present = actual?.indexes.find((candidate) => candidate.name === index.name);
				if (present) {
					if (!sameIndex(present, index)) throw new RuntimeSchemaPlanError("incompatible-schema");
				} else select(lookup(definition.addIndexAtoms, index.name));
			}
			preservedExtraObjects +=
				actual?.indexes.filter(
					(index) =>
						!target.indexes.some((candidate) => candidate.name === index.name) &&
						!removedPredecessors.has(JSON.stringify([target.name, index.name])),
				).length ?? 0;
			for (const foreignKey of target.foreignKeys) {
				const key = foreignKeyKey(foreignKey);
				const present = actual?.foreignKeys.find((candidate) => foreignKeyKey(candidate) === key);
				if (present) continue;
				if (
					actual?.foreignKeys.some(
						(candidate) => JSON.stringify(candidate.columns) === JSON.stringify(foreignKey.columns),
					)
				)
					throw new RuntimeSchemaPlanError("incompatible-schema");
				if (
					registry.provider === "sqlite" &&
					(!actual || foreignKey.columns.every((column) => addedColumns.has(column)))
				)
					continue;
				const atom = lookup(definition.addForeignKeyAtoms, key);
				if (atom === undefined) throw new RuntimeSchemaPlanError("constraint-migration-required");
				select(atom);
			}
			preservedExtraObjects +=
				actual?.foreignKeys.filter(
					(foreignKey) =>
						!target.foreignKeys.some(
							(candidate) => foreignKeyKey(candidate) === foreignKeyKey(foreignKey),
						),
				).length ?? 0;
		}
		const atomIds = Object.freeze(registry.orderedAtomIds.filter((id) => selected.has(id)));
		return Object.freeze({
			provider: registry.provider,
			version: registry.version,
			targetDigest: registry.targetDigest,
			atomIds,
			preservedExtraObjects,
			result: atomIds.length === 0 ? "ready" : "upgrade",
		});
	} catch (error) {
		if (error instanceof RuntimeSchemaPlanError) throw error;
		return unknown();
	}
}
