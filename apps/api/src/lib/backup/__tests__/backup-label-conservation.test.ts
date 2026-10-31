import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BackupData } from "@arr/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { Encryptor } from "../../auth/encryption.js";
import { BackupCompatibilityError } from "../../errors.js";
import {
	JellyfinMutationRepository,
	recoverLabelSyncMutationAttempts,
	type MutationClaimInput,
} from "../../label-sync/jellyfin-mutation-repository.js";
import { parseLabelSyncMutationAttempt } from "../../label-sync/jellyfin-mutation-state.js";
import type { PrismaClient } from "../../prisma.js";
import { encryptBackupData } from "../backup-crypto.js";
import {
	assertRestoreCompatibility,
	exportDatabase,
	restoreDatabase,
	restorePreparedDatabase,
} from "../backup-database.js";
import { prepareRestoreData } from "../backup-restore-preparation.js";
import { validateBackup } from "../backup-validation.js";

const key = "11".repeat(32),
	sourceEncryptor = new Encryptor(key),
	destination = new Encryptor("22".repeat(32));
const now = new Date("2026-10-07T01:00:00.000Z");
const input: MutationClaimInput = {
	userId: "owner",
	ruleId: "rule",
	destinationInstanceId: "destination",
	provider: "jellyfin",
	mediaType: "movie",
	tmdbId: 123,
	connectionGeneration: 0,
	identityGeneration: 0,
	targetItemId: "item",
	libraryId: "library",
	intentFingerprint: "intent",
	ruleFingerprint: "rule-fingerprint",
	destinationTag: "tag",
};

const configuredPg =
	process.env.INTEGRATION_TESTS === "true" ? process.env.TEST_DATABASE_URL : undefined;
describe(`prepared label conservation on a populated ${configuredPg ? "PostgreSQL" : "SQLite"} database`, {
	timeout: 30_000,
}, () => {
	let directory: string, source: PrismaClient, target: PrismaClient;
	let postgresCleanup: (() => Promise<void>) | undefined;
	let repository: JellyfinMutationRepository;
	let claim: Extract<
		Awaited<ReturnType<JellyfinMutationRepository["claim"]>>,
		{ kind: "acquired" }
	>;
	let backup: BackupData;
	beforeAll(async () => {
		directory = mkdtempSync(join(tmpdir(), "backup-held-conservation-"));
		const api = resolve(import.meta.dirname, "../../../..");
		if (configuredPg) {
			const url = new URL(configuredPg);
			if (
				!["postgres:", "postgresql:"].includes(url.protocol) ||
				!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
				!/^\/[A-Za-z_][A-Za-z0-9_]*_test$/.test(url.pathname) ||
				url.search ||
				url.hash
			)
				throw new Error("Explicit plain loopback disposable PostgreSQL URL required");
			const { Pool } = await import("pg"),
				{ PrismaPg } = await import("@prisma/adapter-pg");
			const admin = new Pool({ connectionString: configuredPg });
			const suffix = randomUUID().replaceAll("-", "");
			const schemas = [`backup_held_source_${suffix}`, `backup_held_target_${suffix}`];
			const pools: InstanceType<typeof Pool>[] = [],
				clients: PrismaClient[] = [];
			postgresCleanup = async () => {
				await Promise.allSettled(clients.map((client) => client.$disconnect()));
				await Promise.allSettled(pools.map((pool) => pool.end()));
				try {
					for (const schema of schemas)
						await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
				} finally {
					await admin.end();
				}
			};
			const schemaFile = join(directory, "schema.prisma");
			writeFileSync(
				schemaFile,
				readFileSync(join(api, "prisma/schema.prisma"), "utf8")
					.replace(
						/generator client \{[\s\S]*?\}\n\n/,
						'generator client {\n  provider = "prisma-client"\n  output = "./generated"\n}\n\n',
					)
					.replace('provider = "sqlite"', 'provider = "postgresql"'),
				{ mode: 0o600 },
			);
			symlinkSync(join(api, "node_modules"), join(directory, "node_modules"), "dir");
			execFileSync(
				process.execPath,
				[join(api, "node_modules/prisma/build/index.js"), "generate", "--schema", schemaFile],
				{
					cwd: directory,
					env: { PATH: process.env.PATH, DATABASE_URL: configuredPg },
					stdio: "pipe",
				},
			);
			const generated = await import(
				/* @vite-ignore */ pathToFileURL(join(directory, "generated/client.ts")).href
			);
			const Native = (generated.default ?? generated).PrismaClient as new (options: {
				adapter: InstanceType<typeof PrismaPg>;
			}) => PrismaClient;
			for (const schema of schemas) {
				await admin.query(`CREATE SCHEMA "${schema}"`);
				const selected = new URL(configuredPg);
				selected.searchParams.set("schema", schema);
				execFileSync(
					process.execPath,
					[
						join(api, "node_modules/prisma/build/index.js"),
						"db",
						"push",
						"--schema",
						schemaFile,
						"--url",
						selected.toString(),
					],
					{
						cwd: directory,
						env: { PATH: process.env.PATH, DATABASE_URL: selected.toString() },
						stdio: "pipe",
					},
				);
				const pool = new Pool({
					connectionString: configuredPg,
					options: `-c search_path=${schema}`,
				});
				pools.push(pool);
				clients.push(new Native({ adapter: new PrismaPg(pool, { schema }) }));
			}
			[source, target] = clients as [PrismaClient, PrismaClient];
			return;
		}
		for (const name of ["source.db", "target.db"]) {
			const url = `file:${join(directory, name)}`;
			execFileSync(
				process.execPath,
				[
					join(api, "node_modules/prisma/build/index.js"),
					"db",
					"push",
					"--schema",
					join(api, "prisma/schema.prisma"),
					"--url",
					url,
				],
				{ cwd: directory, env: { PATH: process.env.PATH, DATABASE_URL: url }, stdio: "pipe" },
			);
		}
		source = createTestPrismaClient(join(directory, "source.db"));
		target = createTestPrismaClient(join(directory, "target.db"));
	}, 60_000);
	afterAll(async () => {
		await source?.$disconnect();
		await target?.$disconnect();
		await postgresCleanup?.();
		if (directory) rmSync(directory, { recursive: true, force: false });
	});
	beforeEach(async () => {
		for (const db of [source, target]) {
			await db.labelSyncMutationAttempt.deleteMany();
			await db.labelSyncRule.deleteMany();
			await db.serviceInstance.deleteMany();
			await db.session.deleteMany();
			await db.user.deleteMany();
		}
		await source.user.create({
			data: { id: "owner", username: "synthetic", createdAt: now, updatedAt: now },
		});
		const apiKey = sourceEncryptor.encrypt("synthetic-key");
		await source.serviceInstance.create({
			data: {
				id: "destination",
				userId: "owner",
				service: "JELLYFIN",
				label: "synthetic",
				baseUrl: "http://synthetic.invalid",
				encryptedApiKey: apiKey.value,
				encryptionIv: apiKey.iv,
				identityStatus: "VERIFIED",
				expectedIdentity: "synthetic-server",
				identityKind: "JELLYFIN_SERVER_ID",
				createdAt: now,
				updatedAt: now,
			},
		});
		await source.labelSyncRule.create({
			data: {
				id: "rule",
				userId: "owner",
				name: "synthetic",
				sourceService: "radarr",
				sourceTagName: "source",
				destService: "jellyfin",
				destInstanceId: "destination",
				destTagName: "tag",
				createdAt: now,
				updatedAt: now,
			},
		});
		repository = new JellyfinMutationRepository(source, {
			databaseProvider: configuredPg ? "postgresql" : "sqlite",
			clock: () => now,
			tokenFactory: () => "source-worker",
		});
		const result = await repository.claim(input);
		if (result.kind !== "acquired") throw new Error("Synthetic source claim not acquired");
		claim = result;
		backup = await capture();
	});
	async function capture(): Promise<BackupData> {
		return JSON.parse(
			JSON.stringify({
				version: "1.4",
				appVersion: "2.24.2",
				timestamp: now,
				data: await exportDatabase(source),
				secrets: { encryptionKey: key, sessionCookieSecret: "synthetic-cookie" },
			}),
		);
	}
	async function prepare(value = backup) {
		return prepareRestoreData({
			envelope: await encryptBackupData(JSON.stringify(value), "synthetic-password"),
			password: "synthetic-password",
			destination: {
				encryptor: destination,
				installationId: "destination-installation",
				stableForRestart: true,
			},
		});
	}
	function handle() {
		return {
			id: claim.id,
			userId: input.userId,
			ruleId: input.ruleId,
			destinationInstanceId: input.destinationInstanceId,
			activeOperationKey: claim.activeOperationKey,
			claimToken: claim.claimToken,
		};
	}
	async function seedTarget() {
		for (const row of await source.user.findMany()) await target.user.create({ data: row });
		for (const row of await source.serviceInstance.findMany())
			await target.serviceInstance.create({ data: row });
		for (const row of await source.labelSyncRule.findMany())
			await target.labelSyncRule.create({ data: row });
		for (const row of await source.labelSyncMutationAttempt.findMany())
			await target.labelSyncMutationAttempt.create({ data: row });
		await target.session.create({
			data: {
				id: "target-session",
				userId: "owner",
				expiresAt: new Date("2026-10-08T00:00:00.000Z"),
			},
		});
	}
	async function state(db = target) {
		return {
			users: await db.user.findMany(),
			instances: await db.serviceInstance.findMany(),
			rules: await db.labelSyncRule.findMany(),
			attempts: await db.labelSyncMutationAttempt.findMany(),
			sessions: await db.session.findMany(),
		};
	}

	it("exports explicit nullable evidence without losing historical format readability", async () => {
		expect(backup.data.labelSyncMutationAttempts?.[0]).toHaveProperty("restoreEvidence", null);
		expect(() => validateBackup(backup)).not.toThrow();
	});
	it("restores a snapshot captured before the original send as held through two startups", async () => {
		await repository.markSending({ ...handle(), sendAttemptCount: 0 });
		const originalAdvanced = await state(source);
		await restorePreparedDatabase(target, await prepare(), "destination-installation");
		await recoverLabelSyncMutationAttempts(target);
		await recoverLabelSyncMutationAttempts(target);
		const restored = parseLabelSyncMutationAttempt(
			(await target.labelSyncMutationAttempt.findMany())[0]!,
		);
		expect(restored).toMatchObject({
			status: "restored-held",
			reasonCode: "restore_uncertain",
			claimToken: null,
			sendAttemptCount: 0,
			requestStartedAt: null,
			activeOperationKey: claim.activeOperationKey,
		});
		expect(JSON.parse(restored.restoreEvidence!)).toMatchObject({
			originalStatus: "claimed",
			originalSendAttemptCount: 0,
			originalRequestStartedAt: null,
		});
		const targetRepository = new JellyfinMutationRepository(target, {
			databaseProvider: configuredPg ? "postgresql" : "sqlite",
		});
		expect(await targetRepository.claim(input)).toMatchObject({ kind: "existing-held" });
		expect(await state(source)).toEqual(originalAdvanced);
		expect(
			destination.decrypt({
				value: (await target.serviceInstance.findMany())[0]!.encryptedApiKey,
				iv: (await target.serviceInstance.findMany())[0]!.encryptionIv,
			}),
		).toBe("synthetic-key");
		const exported = JSON.parse(JSON.stringify(await exportDatabase(target))) as BackupData["data"];
		expect(exported.labelSyncMutationAttempts?.[0]).toHaveProperty(
			"restoreEvidence",
			restored.restoreEvidence,
		);
	});
	it.each(["claimed", "sending", "unknown"] as const)(
		"conserves exact live %s evidence instead of blanket-rejecting prepared restore",
		async (status) => {
			if (status !== "claimed") await repository.markSending({ ...handle(), sendAttemptCount: 0 });
			if (status === "unknown")
				await repository.completeSend({ ...handle(), sendAttemptCount: 1, status: "unknown" });
			backup = await capture();
			await seedTarget();
			await restorePreparedDatabase(target, await prepare(), "destination-installation");
			expect((await target.labelSyncMutationAttempt.findMany())[0]).toMatchObject({
				status: "restored-held",
				claimToken: null,
				sendAttemptCount: status === "claimed" ? 0 : 1,
			});
			expect(await target.session.count()).toBe(0);
		},
	);
	it("retains plain Restore's unresolved-state refusal", async () => {
		await seedTarget();
		const before = await state();
		await expect(assertRestoreCompatibility(target, backup.data)).rejects.toBeInstanceOf(
			BackupCompatibilityError,
		);
		await expect(restoreDatabase(target, backup.data)).rejects.toBeInstanceOf(
			BackupCompatibilityError,
		);
		expect(await state()).toEqual(before);
	});
	it("accepts native 1.3 provenance omission without downgrading safety coverage", async () => {
		backup.version = "1.3";
		delete (backup.data.labelSyncMutationAttempts![0] as Record<string, unknown>).restoreEvidence;
		await seedTarget();
		await restorePreparedDatabase(target, await prepare(), "destination-installation");
		expect((await target.labelSyncMutationAttempt.findMany())[0]).toMatchObject({
			status: "restored-held",
			claimToken: null,
		});
	});
	it("preserves re-restored held proof and counts but discards only the acquired observation token", async () => {
		await restorePreparedDatabase(target, await prepare(), "destination-installation");
		const held = (await target.labelSyncMutationAttempt.findMany())[0]!;
		await target.labelSyncMutationAttempt.update({
			where: { id: held.id },
			data: { claimToken: "read-worker", reconcileAttemptCount: 1 },
		});
		backup.data = JSON.parse(JSON.stringify(await exportDatabase(target)));
		backup.secrets.encryptionKey = "22".repeat(32);
		const before = (await target.labelSyncMutationAttempt.findMany())[0]!;
		await restorePreparedDatabase(target, await prepare(), "destination-installation");
		expect((await target.labelSyncMutationAttempt.findMany())[0]).toEqual({
			...before,
			claimToken: null,
		});
	});
	it("does not confuse changed presentation or run summaries with changed execution authority", async () => {
		await seedTarget();
		await target.labelSyncRule.update({
			where: { id: "rule" },
			data: { name: "renamed", lastRunAt: now, lastRunStatus: "success" },
		});
		await target.serviceInstance.update({
			where: { id: "destination" },
			data: { label: "renamed" },
		});
		await restorePreparedDatabase(target, await prepare(), "destination-installation");
		expect((await target.labelSyncMutationAttempt.findMany())[0]).toMatchObject({
			status: "restored-held",
		});
	});
	it("rejects lost owner authority without substituting a similarly named account", async () => {
		await seedTarget();
		await target.user.create({ data: { id: "other-owner", username: "other-synthetic" } });
		await target.serviceInstance.update({
			where: { id: "destination" },
			data: { userId: "other-owner" },
		});
		const before = await state();
		await expect(
			restorePreparedDatabase(target, await prepare(), "destination-installation"),
		).rejects.toBeInstanceOf(BackupCompatibilityError);
		expect(await state()).toEqual(before);
	});
	it("conserves terminal positive observations, not just unresolved rows", async () => {
		await repository.markSending({ ...handle(), sendAttemptCount: 0 });
		await repository.completeSend({
			...handle(),
			sendAttemptCount: 1,
			status: "verified",
			lastObservedAt: now,
		});
		backup = await capture();
		await seedTarget();
		await target.labelSyncMutationAttempt.update({
			where: { id: claim.id },
			data: { destinationTag: "different" },
		});
		const before = await state();
		await expect(
			restorePreparedDatabase(target, await prepare(), "destination-installation"),
		).rejects.toBeInstanceOf(BackupCompatibilityError);
		expect(await state()).toEqual(before);
	});
	it("rejects changed authority on the rule's explicitly bound source connection", async () => {
		await source.serviceInstance.create({
			data: {
				id: "source",
				userId: "owner",
				service: "RADARR",
				label: "synthetic",
				baseUrl: "http://source.invalid",
				...(() => {
					const encrypted = sourceEncryptor.encrypt("source-key");
					return { encryptedApiKey: encrypted.value, encryptionIv: encrypted.iv };
				})(),
			},
		});
		await source.labelSyncRule.update({
			where: { id: "rule" },
			data: { sourceInstanceId: "source" },
		});
		backup = await capture();
		await seedTarget();
		await target.serviceInstance.update({
			where: { id: "source" },
			data: { connectionGeneration: 1 },
		});
		const before = await state();
		await expect(
			restorePreparedDatabase(target, await prepare(), "destination-installation"),
		).rejects.toBeInstanceOf(BackupCompatibilityError);
		expect(await state()).toEqual(before);
	});
	it.each([
		["omitted attempt", "attempt", { omit: true }],
		["changed claim", "attempt", { claimToken: "different-worker" }],
		["changed intent", "attempt", { destinationTag: "other" }],
		["changed target", "attempt", { targetItemId: "other" }],
		["changed provenance", "attempt", { restoreEvidence: "malformed" }],
		["changed rule", "rule", { destTagName: "other" }],
		["changed source rule", "rule", { sourceTagName: "other" }],
		["disabled rule", "rule", { enabled: false }],
		["changed identity", "instance", { expectedIdentity: "different" }],
		["changed generation", "instance", { connectionGeneration: 1 }],
		["changed identity generation", "instance", { identityGeneration: 1 }],
		["changed endpoint", "instance", { baseUrl: "http://different.invalid" }],
		["disabled destination", "instance", { enabled: false }],
		["changed key", "instance", { encryptedApiKey: "different-ciphertext" }],
	] as const)("rejects %s before rows or sessions are replaced", async (_name, model, change) => {
		await seedTarget();
		const prepared = await prepare();
		if (model === "attempt") {
			if ("omit" in change) backup.data.labelSyncMutationAttempts = [];
			else await target.labelSyncMutationAttempt.update({ where: { id: claim.id }, data: change });
		} else if (model === "rule")
			await target.labelSyncRule.update({ where: { id: "rule" }, data: change });
		else await target.serviceInstance.update({ where: { id: "destination" }, data: change });
		const before = await state();
		await expect(
			restorePreparedDatabase(
				target,
				"omit" in change ? await prepare() : prepared,
				"destination-installation",
			),
		).rejects.toBeInstanceOf(BackupCompatibilityError);
		expect(await state()).toEqual(before);
	});
	it("rejects a new live attempt missing from the authenticated witness", async () => {
		await seedTarget();
		const row = (await target.labelSyncMutationAttempt.findMany())[0]!;
		await target.labelSyncMutationAttempt.create({
			data: { ...row, id: "new-attempt", activeOperationKey: "new-hold", tmdbId: 456 },
		});
		const before = await state();
		await expect(
			restorePreparedDatabase(target, await prepare(), "destination-installation"),
		).rejects.toBeInstanceOf(BackupCompatibilityError);
		expect(await state()).toEqual(before);
	});
	it("rechecks an advancing claim inside the transaction, before any destructive write", async () => {
		await seedTarget();
		const before = await state(),
			prepared = await prepare();
		const raced = new Proxy(target, {
			get(db, property) {
				if (property === "$transaction")
					return (callback: (tx: PrismaClient) => Promise<void>, options: unknown) =>
						db.$transaction(async (tx) => {
							await tx.labelSyncMutationAttempt.update({
								where: { id: claim.id },
								data: { claimToken: "racing-worker" },
							});
							return callback(tx as PrismaClient);
						}, options as never);
				const value = Reflect.get(db, property);
				return typeof value === "function" ? value.bind(db) : value;
			},
		});
		await expect(
			restorePreparedDatabase(raced, prepared, "destination-installation"),
		).rejects.toBeInstanceOf(BackupCompatibilityError);
		expect(await state()).toEqual(before);
	});
	it("rolls back a post-insertion failure without losing uncertain evidence or sessions", async () => {
		await seedTarget();
		const before = await state(),
			prepared = await prepare();
		let inserted = false;
		const failing = new Proxy(target, {
			get(db, property) {
				if (property === "$transaction")
					return (callback: (tx: PrismaClient) => Promise<void>, options: unknown) =>
						db.$transaction(
							async (tx) =>
								callback(
									new Proxy(tx, {
										get(client, field) {
											if (field === "labelSyncMutationAttempt")
												return {
													...client.labelSyncMutationAttempt,
													createMany: async (
														args: Parameters<typeof client.labelSyncMutationAttempt.createMany>[0],
													) => {
														await client.labelSyncMutationAttempt.createMany(args);
														inserted = true;
														throw new Error("Synthetic post-insert failure");
													},
												};
											return Reflect.get(client, field);
										},
									}) as PrismaClient,
								),
							options as never,
						);
				const value = Reflect.get(db, property);
				return typeof value === "function" ? value.bind(db) : value;
			},
		});
		await expect(
			restorePreparedDatabase(failing, prepared, "destination-installation"),
		).rejects.toBeInstanceOf(BackupCompatibilityError);
		expect(inserted).toBe(true);
		expect(await state()).toEqual(before);
	});
});
