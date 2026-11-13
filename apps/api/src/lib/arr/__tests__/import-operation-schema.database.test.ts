import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";

const apiRoot = resolve(process.cwd());
const schemaPath = join(apiRoot, "prisma/schema.prisma");
const directories: string[] = [];
const newModels = ["ArrImportOperation", "ArrImportFileProof", "ArrImportSourceClaim"];
const newTables = ["arr_import_operations", "arr_import_file_proofs", "arr_import_source_claims"];

function pushSchema(schema: string, databasePath: string) {
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", schema], {
		cwd: apiRoot,
		env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		stdio: "pipe",
	});
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("additive durable import schema", () => {
	it("preserves populated legacy receipts and connections through repeated upgrades", {
		timeout: 60_000,
	}, async () => {
		const directory = mkdtempSync(join(tmpdir(), "arr-import-upgrade-"));
		directories.push(directory);
		const databasePath = join(directory, "fixture.db");
		const legacySchemaPath = join(directory, "legacy.prisma");
		let legacySchema = readFileSync(schemaPath, "utf8");
		// Derive the immediately preceding candidate schema by removing only
		// this additive feature. Never replace or rewrite the repository schema.
		for (const model of newModels) {
			legacySchema = legacySchema.replace(
				new RegExp(`^model ${model} \\{[\\s\\S]*?^\\}`, "gm"),
				"",
			);
		}
		legacySchema = legacySchema.replace(
			/^\s*arrImport(?:Operations|SourceClaims)\s+[^\n]+\n/gm,
			"",
		);
		writeFileSync(legacySchemaPath, legacySchema, { mode: 0o600 });
		pushSchema(legacySchemaPath, databasePath);
		const prisma = createTestPrismaClient(`file:${databasePath}`);
		try {
			await prisma.user.create({ data: { id: "owner", username: "synthetic-owner" } });
			await prisma.serviceInstance.create({
				data: {
					id: "arr-instance",
					userId: "owner",
					service: "SONARR",
					label: "Fixture",
					baseUrl: "https://fixture.invalid",
					encryptedApiKey: "fixture-ciphertext",
					encryptionIv: "fixture-iv",
				},
			});
			for (const state of ["pending", "completed", "failed"]) {
				await prisma.queueCleanerImportReceipt.create({
					data: {
						id: `legacy-${state}`,
						instanceId: "arr-instance",
						downloadKey: `source-${state}`,
						queueId: 12,
						downloadTitle: "Synthetic fixture",
						connectionFingerprint: "connection-proof",
						commandFingerprint: "selection-proof",
						commandId: 41,
						state,
						lastAttemptAt: new Date("2026-09-30T00:00:00.000Z"),
					},
				});
			}
			const receiptsBefore = await prisma.queueCleanerImportReceipt.findMany({
				orderBy: { id: "asc" },
			});
			const connectionBefore = await prisma.serviceInstance.findUniqueOrThrow({
				where: { id: "arr-instance" },
			});
			await prisma.$disconnect();
			pushSchema(schemaPath, databasePath);
			pushSchema(schemaPath, databasePath);
			const database = new Database(databasePath, { readonly: true });
			try {
				const tables = database
					.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
					.all() as { name: string }[];
				expect(newTables.filter((table) => tables.some(({ name }) => name === table))).toEqual(
					newTables,
				);
			} finally {
				database.close();
			}
			expect(await prisma.queueCleanerImportReceipt.findMany({ orderBy: { id: "asc" } })).toEqual(
				receiptsBefore,
			);
			expect(
				await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "arr-instance" } }),
			).toEqual(connectionBefore);
			expect(await prisma.arrImportOperation.count()).toBe(0);
			expect(await prisma.arrImportFileProof.count()).toBe(0);
			expect(await prisma.arrImportSourceClaim.count()).toBe(0);
			const operation = await prisma.arrImportOperation.create({
				data: {
					userId: "owner",
					instanceId: "arr-instance",
					originalInstanceId: "arr-instance",
					connectionFingerprint: "connection-proof",
					service: "SONARR",
					origin: "manual",
					mode: "Move",
					idempotencyKey: "attempt-key",
					requestFingerprint: "request-proof",
					commandFingerprint: "command-proof",
					encryptedSources: "synthetic-ciphertext",
					sourcesEncryptionIv: "synthetic-iv",
					selectedFileCount: 1,
					preparationExpiresAt: new Date("2026-10-01T00:00:00.000Z"),
					files: {
						create: {
							fileFingerprint: "file-proof",
							downloadKey: "source-proof",
							identityJson: { pathHash: "synthetic-hash", seriesId: 12, episodeIds: [14] },
						},
					},
				},
			});
			await prisma.arrImportSourceClaim.create({
				data: { userId: "owner", downloadKey: "source-proof", activeOperationId: operation.id },
			});
			// Fixture-only FK check. Production deletion still requires its separate
			// queue-coverage and unresolved-import guards before reaching this point.
			await prisma.serviceInstance.delete({ where: { id: "arr-instance" } });
			const historical = await prisma.arrImportOperation.findFirstOrThrow({
				where: { id: operation.id, userId: "owner" },
				include: { files: true },
			});
			expect(historical.instanceId).toBeNull();
			expect(historical.originalInstanceId).toBe("arr-instance");
			expect(historical.connectionFingerprint).toBe("connection-proof");
			expect(historical.files).toHaveLength(1);
			expect(
				(
					await prisma.arrImportSourceClaim.findFirstOrThrow({
						where: { userId: "owner", downloadKey: "source-proof" },
					})
				).activeOperationId,
			).toBe(operation.id);
		} finally {
			await prisma.$disconnect();
		}
	});
});
