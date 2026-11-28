import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { planRuntimeSchema } from "../runtime-schema-catalog.js";
import {
	readPostgresRuntimeSchemaCatalog,
	synchronizePostgresRuntimeSchema,
} from "../runtime-schema-postgres.js";
import { createRuntimeSchemaMigrationReceipt } from "../runtime-schema-receipt.js";
import {
	loadRuntimeSchemaRegistry,
	type RuntimeSchemaRegistryDocument,
	readRuntimeSchemaRegistryTargets,
	verifyRuntimeSchemaRegistryDocument,
} from "../runtime-schema-registry.js";

const connectionString = process.env.RUNTIME_SCHEMA_TEST_DATABASE_URL;
const priorRegistryPath = fileURLToPath(
	new URL("./fixtures/sabnzbd/registry-postgresql-v1-pre-sabnzbd.json.gz", import.meta.url),
);
const priorRegistrySha256 = "96d0c705678086f576ef0f49b1949b65efc890a49eda08bf7a48b95a4d6efa51";
const priorSchemaSourceSha256 = "a5362c90c3bf41291f6e6db4d3a3984c29ee6011a93f1af70c7b2fe1e416bb01";
const serviceTypePredecessor = [
	"SONARR",
	"RADARR",
	"PROWLARR",
	"LIDARR",
	"READARR",
	"SEERR",
	"TAUTULLI",
	"PLEX",
	"JELLYFIN",
	"EMBY",
	"QUI",
];
const typedColumns = [
	["ServiceInstance", "service"],
	["arr_import_operations", "service"],
	["standalone_cf_deployments", "serviceType"],
	["trash_cache", "serviceType"],
	["trash_templates", "serviceType"],
] as const;

describe.skipIf(!connectionString)("SABnzbd PostgreSQL predecessor upgrade", () => {
	const namespace = `sab_upgrade_${process.pid}_${randomUUID().replaceAll("-", "")}`;
	let admin: Client | undefined;

	afterEach(async () => {
		if (!admin) return;
		try {
			await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
		} finally {
			await admin.end();
			admin = undefined;
		}
	});

	it("upgrades the sealed pre-SAB application schema through native startup and conserves owned rows", async () => {
		const priorRegistryBytes = gunzipSync(readFileSync(priorRegistryPath));
		expect(createHash("sha256").update(priorRegistryBytes).digest("hex")).toBe(priorRegistrySha256);
		const priorDocument = JSON.parse(
			priorRegistryBytes.toString("utf8"),
		) as RuntimeSchemaRegistryDocument;
		const priorRegistry = verifyRuntimeSchemaRegistryDocument(
			priorDocument,
			priorSchemaSourceSha256,
		);
		expect(priorRegistry.provider).toBe("postgresql");
		admin = new Client({
			connectionString,
			connectionTimeoutMillis: 5000,
			query_timeout: 10000,
			statement_timeout: 9000,
		});
		admin.on("error", () => {});
		await admin.connect();
		await admin.query(`CREATE SCHEMA "${namespace}"`);
		await admin.query(`SET search_path TO "${namespace}"`);
		await admin.query("BEGIN");
		const priorTargets = {
			tables: priorRegistry.tables.map((definition) => definition.target.name),
			indexes: priorRegistry.tables.flatMap((definition) =>
				definition.target.indexes.map((index) => index.name),
			),
			enums: priorDocument.nativeEnums.map(({ name, values, previousValues }) => ({
				name,
				values,
				...(previousValues ? { previousValues } : {}),
			})),
		};
		const priorEmpty = await readPostgresRuntimeSchemaCatalog(
			admin,
			priorTargets.tables,
			priorTargets.enums,
			priorTargets.indexes,
		);
		const priorPlan = planRuntimeSchema(priorEmpty.catalog, priorRegistry);
		const missingEnumAtoms = priorEmpty.missingEnums.map(
			(name) => priorDocument.nativeEnums.find((candidate) => candidate.name === name)?.createAtom,
		);
		const selectedAtoms = new Set([...missingEnumAtoms, ...priorPlan.atomIds]);
		expect([...selectedAtoms].every((id): id is string => typeof id === "string")).toBe(true);
		const priorAtoms = priorDocument.atoms.filter((atom) => selectedAtoms.has(atom.id));
		expect(priorAtoms).toHaveLength(selectedAtoms.size);
		const priorAtomIds = priorAtoms.map((atom) => atom.id);
		const priorPlanDigest = createHash("sha256")
			.update(
				JSON.stringify({
					atomIds: priorAtomIds,
					provider: priorPlan.provider,
					targetDigest: priorPlan.targetDigest,
					version: priorPlan.version,
				}),
			)
			.digest("hex");
		const priorExecution = {
			...priorPlan,
			planDigest: priorPlanDigest,
			statementCount: priorAtoms.length,
			execute: async (apply: (sql: string) => void | Promise<void>) => {
				for (const atom of priorAtoms) await apply(atom.sql);
			},
		};
		await priorExecution.execute(async (sql) => {
			await admin!.query(sql);
		});
		const priorReceipt = createRuntimeSchemaMigrationReceipt(priorExecution);
		await admin.query(
			`INSERT INTO "ArrSchemaMigrationReceipt"(id,"protocolVersion","registryVersion",provider,"targetDigest","planDigest","completedAt") VALUES($1,$2,$3,$4,$5,$6,$7)`,
			[
				priorReceipt.id,
				priorReceipt.protocolVersion,
				priorReceipt.registryVersion,
				priorReceipt.provider,
				priorReceipt.targetDigest,
				priorReceipt.planDigest,
				priorReceipt.completedAt,
			],
		);
		await admin.query(
			`INSERT INTO "RestoreRuntimeControl" (id,"protocolVersion",phase,"runtimeEpoch","ownerBackendPid","activeRestoreId","lastCommittedRestoreId","lastCommittedAt","destinationInstallationId") VALUES (1,1,'idle',NULL,NULL,NULL,NULL,NULL,NULL)`,
		);
		await admin.query("COMMIT");

		const time = "TIMESTAMP '2026-11-28 12:00:00.000'";
		await admin.query(
			`INSERT INTO "User" (id,username,"updatedAt") VALUES ('owner','synthetic-owner',${time})`,
		);
		await admin.query(
			`INSERT INTO "ServiceInstance" (id,"userId",service,label,"baseUrl","encryptedApiKey","encryptionIv","updatedAt") VALUES ('instance','owner','SONARR','Synthetic Sonarr','http://sonarr.invalid','ciphertext','iv',${time})`,
		);
		await admin.query(
			`INSERT INTO "arr_import_operations" (id,"userId","instanceId","originalInstanceId","connectionFingerprint",service,origin,mode,"idempotencyKey","requestFingerprint","commandFingerprint","encryptedSources","sourcesEncryptionIv","selectedFileCount","preparationExpiresAt","updatedAt") VALUES ('operation','owner','instance','instance','fingerprint','SONARR','manual','Copy','idempotency','request','command','encrypted','iv',1,${time},${time})`,
		);
		await admin.query(
			`INSERT INTO "standalone_cf_deployments" (id,"userId","instanceId","cfTrashId","cfName","serviceType","commitHash") VALUES ('deployment','owner','instance','cf-id','Synthetic CF','SONARR','commit')`,
		);
		await admin.query(
			`INSERT INTO "trash_cache" (id,"serviceType","configType",data,"updatedAt") VALUES ('cache','RADARR','CUSTOM_FORMATS','{}',${time})`,
		);
		await admin.query(
			`INSERT INTO "trash_templates" (id,"userId",name,"serviceType","configData","updatedAt") VALUES ('template','owner','Synthetic template','RADARR','{}',${time})`,
		);

		const getProtectedRows = async () => {
			const statements = [
				`SELECT id,username,"updatedAt" FROM "User" ORDER BY id`,
				`SELECT id,"userId",service,label,"baseUrl","encryptedApiKey","encryptionIv","updatedAt" FROM "ServiceInstance" ORDER BY id`,
				`SELECT id,"userId","instanceId","originalInstanceId",service,"idempotencyKey","selectedFileCount" FROM "arr_import_operations" ORDER BY id`,
				`SELECT id,"userId","instanceId","cfTrashId","serviceType","commitHash" FROM "standalone_cf_deployments" ORDER BY id`,
				`SELECT id,"serviceType","configType",data FROM "trash_cache" ORDER BY id`,
				`SELECT id,"userId",name,"serviceType","configData" FROM "trash_templates" ORDER BY id`,
			];
			const rows = [];
			for (const sql of statements) rows.push((await admin!.query(sql)).rows);
			return rows;
		};
		const beforeRows = await getProtectedRows();
		const readTypedColumns = async () => {
			const rows = [];
			for (const [table, column] of typedColumns) {
				const result = await admin!.query<{ type_oid: string; labels: string[] }>(
					`SELECT a.atttypid::text AS type_oid,(SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] FROM pg_catalog.pg_enum e WHERE e.enumtypid=a.atttypid) AS labels FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND a.attname=$3 AND a.attnum>0 AND NOT a.attisdropped`,
					[namespace, table, column],
				);
				rows.push(result.rows[0]);
			}
			return rows;
		};
		const beforeTypes = await readTypedColumns();
		for (const value of beforeTypes) {
			expect(value?.type_oid).toBeTruthy();
			expect(value?.labels).toEqual(serviceTypePredecessor);
		}

		const candidateUrl = new URL(connectionString!);
		candidateUrl.searchParams.set("schema", namespace);
		await expect(synchronizePostgresRuntimeSchema(candidateUrl.toString())).resolves.toBeDefined();
		expect(await getProtectedRows()).toEqual(beforeRows);
		const afterTypes = await readTypedColumns();
		for (let i = 0; i < afterTypes.length; i++) {
			expect(afterTypes[i]?.type_oid).toBe(beforeTypes[i]?.type_oid);
			expect(afterTypes[i]?.labels).toEqual([...serviceTypePredecessor, "SABNZBD"]);
		}

		const receipt = await admin.query<{
			id: string;
			protocol: number;
			version: number;
			target: string;
		}>(
			`SELECT id,"protocolVersion" AS protocol,"registryVersion" AS version,"targetDigest" AS target FROM "ArrSchemaMigrationReceipt" WHERE provider='postgresql' ORDER BY id`,
		);
		expect(receipt.rows).toHaveLength(2);
		expect(receipt.rows.every((row) => row.protocol === 1 && row.version === 1)).toBe(true);
		expect(receipt.rows.map((row) => row.id)).toContain(priorReceipt.id);
		expect(receipt.rows.map((row) => row.target)).toContain(priorReceipt.targetDigest);
		const registry = loadRuntimeSchemaRegistry("postgresql");
		const targets = readRuntimeSchemaRegistryTargets(registry);
		await admin.query("BEGIN");
		const catalog = await readPostgresRuntimeSchemaCatalog(
			admin,
			registry.tables.map((d) => d.target.name),
			targets.enums,
			registry.tables.flatMap((d) => d.target.indexes.map((i) => i.name)),
		);
		expect(catalog.missingEnums).toEqual([]);
		expect(catalog.appendableEnums).toEqual([]);
		await admin.query("ROLLBACK");
		await expect(
			admin.query(
				`INSERT INTO "ServiceInstance" (id,"userId",service,label,"baseUrl","encryptedApiKey","encryptionIv","updatedAt") VALUES ('sab-instance','owner','SABNZBD','Synthetic SAB','http://sab.invalid','ciphertext','iv',${time})`,
			),
		).resolves.toMatchObject({ rowCount: 1 });
	});
});
