import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../../__tests__/test-prisma.js";
import {
	importConnectionFingerprint,
	queueDownloadKey,
} from "../../../queue-cleaner/import-receipt.js";
import {
	type AutomaticAttemptTracking,
	type AutomaticOperationBinding,
	assertPreparedAutomaticTracking,
	automaticImportPolicyFingerprint,
	recordAutomaticPreparation,
} from "../automatic-admission.js";

let directory: string;
let prisma: ReturnType<typeof createTestPrismaClient>;
const now = new Date("2026-10-01T12:00:00.000Z");
const rawDownloadId = "synthetic-download-source";
const sourceKey = (downloadId: string) => queueDownloadKey({ downloadId })!;
const queueFingerprint = `v1:${createHash("sha256").update("queue-item").digest("hex")}`;
const services = ["SONARR", "RADARR", "LIDARR", "READARR"] as const;
let fixtureSequence = 0;

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "arr-automatic-admission-"));
	const databasePath = join(directory, "fixture.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		stdio: "pipe",
	});
	prisma = createTestPrismaClient(`file:${databasePath}`);
}, 30_000);

beforeEach(async () => {
	fixtureSequence = 0;
	await prisma.arrImportSourceClaim.deleteMany();
	await prisma.arrImportOperation.deleteMany();
	await prisma.queueCleanerStrike.deleteMany();
	await prisma.queueCleanerConfig.deleteMany();
	await prisma.serviceInstance.deleteMany();
	await prisma.user.deleteMany();
	await prisma.user.createMany({
		data: [
			{ id: "owner", username: "synthetic-owner" },
			{ id: "other", username: "synthetic-other" },
		],
	});
});

afterAll(async () => {
	await prisma?.$disconnect();
	if (directory) rmSync(directory, { recursive: true, force: true });
});

async function createBinding(
	options: {
		service?: (typeof services)[number];
		userId?: string;
		instanceId?: string;
		config?: Record<string, unknown>;
		operation?: Record<string, unknown>;
		fileDownloadIds?: string[];
	} = {},
) {
	const userId = options.userId ?? "owner";
	const instanceId = options.instanceId ?? `instance-${++fixtureSequence}`;
	const service = options.service ?? "RADARR";
	const instance = await prisma.serviceInstance.create({
		data: {
			id: instanceId,
			userId,
			service,
			label: "Synthetic ARR",
			baseUrl: "https://fixture.invalid",
			encryptedApiKey: "synthetic-ciphertext",
			encryptionIv: "synthetic-iv",
		},
	});
	const config = await prisma.queueCleanerConfig.create({
		data: {
			instanceId,
			enabled: true,
			dryRunMode: false,
			autoImportEnabled: true,
			autoImportSafeOnly: false,
			...options.config,
		},
	});
	const fingerprint = importConnectionFingerprint(instance);
	const operation = await prisma.arrImportOperation.create({
		data: {
			userId,
			instanceId,
			originalInstanceId: instanceId,
			connectionFingerprint: fingerprint,
			service,
			origin: "queue-cleaner",
			mode: "Move",
			idempotencyKey: `automatic-${instanceId}`,
			requestFingerprint: `v1:${"1".repeat(64)}`,
			commandFingerprint: `v1:${"2".repeat(64)}`,
			encryptedSources: "synthetic-ciphertext",
			sourcesEncryptionIv: "synthetic-iv",
			state: "preparing",
			selectedFileCount: 1,
			preparationExpiresAt: new Date(now.getTime() + 60_000),
			createdAt: now,
			...options.operation,
			files: {
				create: (options.fileDownloadIds ?? [rawDownloadId]).map((downloadId, index) => ({
					fileFingerprint: `v1:${String(index + 3).repeat(64)}`,
					downloadKey: sourceKey(downloadId),
					identityJson: { pathHash: String(index + 4).repeat(64), movieId: 12 },
				})),
			},
		},
		include: { files: true },
	});
	return { userId, instance, config, operation };
}

function tracking(
	config: Awaited<ReturnType<typeof createBinding>>["config"],
	_options: Awaited<ReturnType<typeof createBinding>>["operation"],
	options: Partial<AutomaticAttemptTracking> = {},
): AutomaticAttemptTracking {
	return {
		queueId: 42,
		queueFingerprint,
		attemptOrdinal: 1,
		downloadId: rawDownloadId,
		downloadTitle: "Synthetic title",
		rule: "import_pending",
		reason: "Synthetic eligible reason",
		statusTexts: ["waiting for import"],
		configFingerprint: automaticImportPolicyFingerprint(config),
		...options,
	};
}

function binding(
	operation: Awaited<ReturnType<typeof createBinding>>["operation"],
): AutomaticOperationBinding {
	return {
		id: operation.id,
		userId: operation.userId,
		instanceId: operation.instanceId,
		originalInstanceId: operation.originalInstanceId,
		origin: operation.origin,
		service: operation.service,
		createdAt: operation.createdAt,
		files: operation.files.map((file) => ({ downloadKey: file.downloadKey })),
	};
}

async function inTransaction<T>(work: Parameters<typeof prisma.$transaction>[0]): Promise<T> {
	return prisma.$transaction(work as never) as Promise<T>;
}

describe("automatic import preparation admission", () => {
	it.each(services)(
		"atomically admits a new %s attempt and assertion does not increment it",
		async (service) => {
			const f = await createBinding({ service });
			const op = binding(f.operation);
			const attempt = tracking(f.config, f.operation);

			await inTransaction(async (tx) => recordAutomaticPreparation(tx, op, attempt));
			const strike = await prisma.queueCleanerStrike.findFirstOrThrow({
				where: { instanceId: f.instance.id, downloadId: "42" },
			});
			expect(strike).toMatchObject({
				downloadFingerprint: queueFingerprint,
				downloadHash: null,
				downloadTitle: "Synthetic title",
				importAttempts: 1,
				lastImportAttempt: now,
				lastImportError: null,
				lastRule: "import_pending",
			});
			await inTransaction(async (tx) => assertPreparedAutomaticTracking(tx, op, attempt));
			await inTransaction(async (tx) => assertPreparedAutomaticTracking(tx, op, attempt));
			expect(
				await prisma.queueCleanerStrike.findFirstOrThrow({
					where: { instanceId: f.instance.id, downloadId: "42" },
				}),
			).toMatchObject({ importAttempts: 1 });
		},
	);

	it("rolls back operation, proof and claim creation when strike persistence fails", async () => {
		const f = await createBinding();
		expect(
			await prisma.serviceInstance.findUnique({ where: { id: f.instance.id } }),
		).not.toBeNull();
		const before = {
			operations: await prisma.arrImportOperation.count(),
			proofs: await prisma.arrImportFileProof.count(),
			claims: await prisma.arrImportSourceClaim.count(),
			strikes: await prisma.queueCleanerStrike.count(),
		};
		await prisma.$executeRawUnsafe(
			"CREATE TRIGGER reject_automatic_strike BEFORE INSERT ON queue_cleaner_strikes BEGIN SELECT RAISE(ABORT, 'synthetic strike failure'); END",
		);
		try {
			await expect(
				inTransaction(async (tx) => {
					const operation = await tx.arrImportOperation.create({
						data: {
							userId: f.userId,
							instanceId: f.instance.id,
							originalInstanceId: f.instance.id,
							connectionFingerprint: importConnectionFingerprint(f.instance),
							service: f.instance.service,
							origin: "queue-cleaner",
							mode: "Move",
							idempotencyKey: "atomic-admission-failure",
							requestFingerprint: `v1:${"1".repeat(64)}`,
							commandFingerprint: `v1:${"2".repeat(64)}`,
							encryptedSources: "synthetic-ciphertext",
							sourcesEncryptionIv: "synthetic-iv",
							state: "preparing",
							selectedFileCount: 1,
							preparationExpiresAt: new Date(now.getTime() + 60_000),
							createdAt: now,
							files: {
								create: {
									fileFingerprint: `v1:${"3".repeat(64)}`,
									downloadKey: sourceKey(rawDownloadId),
									identityJson: { pathHash: "4".repeat(64), movieId: 12 },
								},
							},
						},
						include: { files: true },
					});
					await expect(
						tx.queueCleanerStrike.create({
							data: {
								instanceId: f.instance.id,
								downloadId: "98",
								downloadTitle: "trigger probe",
								lastRule: "trigger probe",
								lastReason: "trigger probe",
							},
						}),
					).rejects.toThrow(/synthetic strike failure/i);
					await tx.arrImportSourceClaim.create({
						data: {
							userId: f.userId,
							downloadKey: sourceKey(rawDownloadId),
							activeOperationId: operation.id,
						},
					});
					await recordAutomaticPreparation(tx, binding(operation), tracking(f.config, operation));
				}),
			).rejects.toThrow(/synthetic strike failure/i);
		} finally {
			await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS reject_automatic_strike");
		}
		expect(await prisma.arrImportOperation.count()).toBe(before.operations);
		expect(await prisma.arrImportFileProof.count()).toBe(before.proofs);
		expect(await prisma.arrImportSourceClaim.count()).toBe(before.claims);
		expect(await prisma.queueCleanerStrike.count()).toBe(before.strikes);
	});

	it("commits operation, proof, claim and admitted strike in one transaction", async () => {
		const f = await createBinding();
		let admittedId = "";
		await inTransaction(async (tx) => {
			const operation = await tx.arrImportOperation.create({
				data: {
					userId: f.userId,
					instanceId: f.instance.id,
					originalInstanceId: f.instance.id,
					connectionFingerprint: importConnectionFingerprint(f.instance),
					service: f.instance.service,
					origin: "queue-cleaner",
					mode: "Move",
					idempotencyKey: "atomic-admission-success",
					requestFingerprint: `v1:${"5".repeat(64)}`,
					commandFingerprint: `v1:${"6".repeat(64)}`,
					encryptedSources: "synthetic-ciphertext",
					sourcesEncryptionIv: "synthetic-iv",
					state: "preparing",
					selectedFileCount: 1,
					preparationExpiresAt: new Date(now.getTime() + 60_000),
					createdAt: now,
					files: {
						create: {
							fileFingerprint: `v1:${"7".repeat(64)}`,
							downloadKey: sourceKey(rawDownloadId),
							identityJson: { pathHash: "8".repeat(64), movieId: 12 },
						},
					},
				},
				include: { files: true },
			});
			admittedId = operation.id;
			await tx.arrImportSourceClaim.create({
				data: {
					userId: f.userId,
					downloadKey: sourceKey(rawDownloadId),
					activeOperationId: operation.id,
				},
			});
			await recordAutomaticPreparation(tx, binding(operation), tracking(f.config, operation));
		});
		expect(
			await prisma.arrImportOperation.count({ where: { id: admittedId, userId: f.userId } }),
		).toBe(1);
		expect(await prisma.arrImportFileProof.count({ where: { operationId: admittedId } })).toBe(1);
		expect(
			await prisma.arrImportSourceClaim.count({
				where: { userId: f.userId, activeOperationId: admittedId },
			}),
		).toBe(1);
		expect(
			await prisma.queueCleanerStrike.findFirstOrThrow({
				where: { instanceId: f.instance.id, downloadId: "42" },
			}),
		).toMatchObject({ importAttempts: 1, downloadFingerprint: queueFingerprint });
	});

	it("invalidates admission when policy changes but ignores observation fields", async () => {
		const f = await createBinding();
		const before = automaticImportPolicyFingerprint(f.config);
		await prisma.queueCleanerConfig.update({
			where: { id: f.config.id },
			data: {
				lastRunAt: now,
				lastRunItemsCleaned: 17,
				lastRunItemsSkipped: 23,
			},
		});
		const observed = await prisma.queueCleanerConfig.findUniqueOrThrow({
			where: { id: f.config.id },
		});
		expect(automaticImportPolicyFingerprint(observed)).toBe(before);
		await prisma.queueCleanerConfig.update({
			where: { id: f.config.id },
			data: { autoImportCooldownMins: 31 },
		});
		await expect(
			inTransaction(async (tx) =>
				recordAutomaticPreparation(tx, binding(f.operation), tracking(f.config, f.operation)),
			),
		).rejects.toMatchObject({ statusCode: 409 });
	});

	it("fails closed for disabled connection/config, dry run and malformed policy patterns", async () => {
		for (const patch of [
			{ kind: "instance", data: { enabled: false } },
			{ kind: "config", data: { enabled: false } },
			{ kind: "config", data: { dryRunMode: true } },
			{ kind: "config", data: { autoImportEnabled: false } },
			{ kind: "config", data: { autoImportNeverPatterns: "{bad-json" } },
			{ kind: "config", data: { autoImportCustomPatterns: "[1]" } },
		] as const) {
			const f = await createBinding();
			if (patch.kind === "instance")
				await prisma.serviceInstance.update({ where: { id: f.instance.id }, data: patch.data });
			else await prisma.queueCleanerConfig.update({ where: { id: f.config.id }, data: patch.data });
			const currentConfig = await prisma.queueCleanerConfig.findUniqueOrThrow({
				where: { id: f.config.id },
			});
			await expect(
				inTransaction(async (tx) =>
					recordAutomaticPreparation(
						tx,
						binding(f.operation),
						tracking(patch.kind === "config" ? currentConfig : f.config, f.operation),
					),
				),
			).rejects.toMatchObject({ statusCode: 409 });
		}
		const bounded = await createBinding();
		await expect(
			inTransaction(async (tx) =>
				recordAutomaticPreparation(
					tx,
					binding(bounded.operation),
					tracking(bounded.config, bounded.operation, { downloadId: "d".repeat(257) }),
				),
			),
		).rejects.toMatchObject({ statusCode: 409 });
	});

	it("fails closed for cooldown, maximum attempts, malformed counters and policy patterns", async () => {
		const f = await createBinding({ config: { autoImportSafeOnly: true } });
		const source = sourceKey(rawDownloadId);
		await prisma.queueCleanerStrike.create({
			data: {
				instanceId: f.instance.id,
				downloadId: "42",
				downloadTitle: "prior",
				downloadFingerprint: queueFingerprint,
				strikeCount: 1,
				lastRule: "import_pending",
				lastReason: "prior",
				importAttempts: 1,
				lastImportAttempt: now,
			},
		});
		const two = tracking(f.config, f.operation, { attemptOrdinal: 2 });
		await expect(
			inTransaction(async (tx) => recordAutomaticPreparation(tx, binding(f.operation), two)),
		).rejects.toMatchObject({ statusCode: 409 });
		await prisma.queueCleanerStrike.updateMany({
			where: { instanceId: f.instance.id, downloadId: "42" },
			data: { lastImportAttempt: new Date(now.getTime() - 60 * 60_000) },
		});
		await prisma.queueCleanerConfig.update({
			where: { id: f.config.id },
			data: { autoImportMaxAttempts: 1 },
		});
		const maxAttemptsConfig = await prisma.queueCleanerConfig.findUniqueOrThrow({
			where: { id: f.config.id },
		});
		await expect(
			inTransaction(async (tx) =>
				recordAutomaticPreparation(
					tx,
					binding(f.operation),
					tracking(maxAttemptsConfig, f.operation, { attemptOrdinal: 2 }),
				),
			),
		).rejects.toMatchObject({ statusCode: 409 });
		await prisma.queueCleanerConfig.update({
			where: { id: f.config.id },
			data: { autoImportMaxAttempts: 2 },
		});
		const restoredConfig = await prisma.queueCleanerConfig.findUniqueOrThrow({
			where: { id: f.config.id },
		});
		await prisma.queueCleanerStrike.updateMany({
			where: { instanceId: f.instance.id, downloadId: "42" },
			data: { importAttempts: -1 },
		});
		await expect(
			inTransaction(async (tx) =>
				recordAutomaticPreparation(
					tx,
					binding(f.operation),
					tracking(restoredConfig, f.operation, { attemptOrdinal: 2 }),
				),
			),
		).rejects.toMatchObject({ statusCode: 409 });
		await prisma.queueCleanerStrike.updateMany({
			where: { instanceId: f.instance.id, downloadId: "42" },
			data: { importAttempts: 1, lastImportAttempt: new Date(now.getTime() - 60 * 60_000) },
		});
		await prisma.queueCleanerConfig.update({
			where: { id: f.config.id },
			data: { autoImportSafeOnly: true, autoImportCustomPatterns: '["unrelated"]' },
		});
		const noPatternMatchConfig = await prisma.queueCleanerConfig.findUniqueOrThrow({
			where: { id: f.config.id },
		});
		await expect(
			inTransaction(async (tx) =>
				recordAutomaticPreparation(
					tx,
					binding(f.operation),
					tracking(noPatternMatchConfig, f.operation, {
						attemptOrdinal: 2,
						statusTexts: ["generic problem"],
					}),
				),
			),
		).rejects.toMatchObject({ statusCode: 409 });
		expect(source).toBe(sourceKey(rawDownloadId));
	});

	it("does not borrow a strike after queue ID reuse and resets only different-target strike authority", async () => {
		const f = await createBinding();
		const oldFirstStrikeAt = new Date(now.getTime() - 86_400_000);
		await prisma.queueCleanerStrike.create({
			data: {
				instanceId: f.instance.id,
				downloadId: "42",
				downloadTitle: "Old source title",
				downloadFingerprint: `v1:${"f".repeat(64)}`,
				strikeCount: 5,
				firstStrikeAt: oldFirstStrikeAt,
				lastRule: "stalled",
				lastReason: "old source",
				importAttempts: 2,
				lastImportAttempt: new Date(now.getTime() - 60 * 60_000),
			},
		});
		await inTransaction(async (tx) =>
			recordAutomaticPreparation(tx, binding(f.operation), tracking(f.config, f.operation)),
		);
		const strike = await prisma.queueCleanerStrike.findFirstOrThrow({
			where: { instanceId: f.instance.id, downloadId: "42" },
		});
		expect(strike).toMatchObject({
			downloadFingerprint: queueFingerprint,
			downloadTitle: "Synthetic title",
			strikeCount: 0,
			firstStrikeAt: now,
			importAttempts: 1,
		});
	});

	it("invalidates final assertion if strike identity, ordinal, timestamp, operation or config changes", async () => {
		for (const change of [
			"fingerprint",
			"ordinal",
			"time",
			"cleared",
			"operation",
			"config",
		] as const) {
			const f = await createBinding();
			const op = binding(f.operation);
			const attempt = tracking(f.config, f.operation);
			await inTransaction(async (tx) => recordAutomaticPreparation(tx, op, attempt));
			if (change === "fingerprint")
				await prisma.queueCleanerStrike.updateMany({
					where: { instanceId: f.instance.id, downloadId: "42" },
					data: { downloadFingerprint: `v1:${"e".repeat(64)}` },
				});
			if (change === "ordinal")
				await prisma.queueCleanerStrike.updateMany({
					where: { instanceId: f.instance.id, downloadId: "42" },
					data: { importAttempts: 2 },
				});
			if (change === "time")
				await prisma.queueCleanerStrike.updateMany({
					where: { instanceId: f.instance.id, downloadId: "42" },
					data: { lastImportAttempt: new Date(now.getTime() + 1) },
				});
			if (change === "cleared")
				await prisma.queueCleanerStrike.deleteMany({
					where: { instanceId: f.instance.id, downloadId: "42" },
				});
			if (change === "operation")
				await prisma.arrImportOperation.updateMany({
					where: { id: f.operation.id, userId: f.userId },
					data: { submissionStartedAt: now },
				});
			if (change === "config")
				await prisma.queueCleanerConfig.update({
					where: { id: f.config.id },
					data: { autoImportMaxAttempts: 3 },
				});
			await expect(
				inTransaction(async (tx) => assertPreparedAutomaticTracking(tx, op, attempt)),
			).rejects.toMatchObject({ statusCode: 409 });
		}
	});

	it("rejects foreign owners and any operation spanning a second hashed source", async () => {
		const foreign = await createBinding({ userId: "other", instanceId: "foreign" });
		await expect(
			inTransaction(async (tx) =>
				recordAutomaticPreparation(
					tx,
					{ ...binding(foreign.operation), userId: "owner" },
					tracking(foreign.config, foreign.operation),
				),
			),
		).rejects.toMatchObject({ statusCode: 409 });

		const split = await createBinding({
			instanceId: "split",
			fileDownloadIds: [rawDownloadId, "another-source"],
		});
		await expect(
			inTransaction(async (tx) =>
				recordAutomaticPreparation(
					tx,
					binding(split.operation),
					tracking(split.config, split.operation),
				),
			),
		).rejects.toMatchObject({ statusCode: 409 });
	});
});
