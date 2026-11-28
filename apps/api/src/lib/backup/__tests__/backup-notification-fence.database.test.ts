import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Client } from "pg";
import { expect, it } from "vitest";
import { Encryptor } from "../../auth/encryption.js";
import { createNotificationOutboxNativeFixture } from "../../notifications/__tests__/notification-outbox-native-fixture.js";
import type { Prisma } from "../../prisma.js";
import { encryptBackupData } from "../backup-crypto.js";
import { exportDatabase, restorePreparedDatabase } from "../backup-database.js";
import { prepareRestoreData } from "../backup-restore-preparation.js";
import {
	getRestoreRuntimeClientContext,
	getRestoreRuntimeReplacementClientContext,
	withRestoreRuntimeReplacement,
} from "../restore-runtime-admission.js";
import { createRuntimeReplacementPrismaClient } from "../restore-runtime-client.js";

it("a failed actual positive commit marker conserves notifications and never reopens admission", async () => {
	const fixture = await createNotificationOutboxNativeFixture();
	// This one-case owned fixture is intentionally left restore-pending on failure.
	// Close its actual runtime; the owning PG runner disposes the whole container.
	// Never reset its journal or try to reopen it merely to clean up a test user.
	try {
		const databaseUrl = getRestoreRuntimeClientContext(fixture.runtime).databaseUrl;
		if (fixture.engine === "sqlite")
			expect(databaseUrl).toMatch(/^file:\/tmp\/arr-outbox-worker-[A-Za-z0-9_-]+\/owned\.db$/);
		else {
			const url = new URL(databaseUrl);
			expect(url.hostname).toBe("127.0.0.1");
			expect(url.username).toMatch(/^arr_native_[a-f0-9]{32}_test$/);
			expect(url.pathname).toBe(`/${url.username}`);
		}
		const tables = [
			"User",
			"notification_channels",
			"NotificationOutboxEvent",
			"NotificationOutboxDelivery",
		];
		async function witness() {
			if (fixture.engine === "sqlite") {
				const db = new Database(fileURLToPath(databaseUrl), {
					readonly: true,
					fileMustExist: true,
				});
				try {
					return Object.fromEntries(
						tables.map((table) => [
							table,
							db.prepare(`SELECT * FROM "${table}" ORDER BY "id"`).all(),
						]),
					);
				} finally {
					db.close();
				}
			}
			const db = new Client({ connectionString: databaseUrl });
			db.on("error", () => {});
			try {
				await db.connect();
				const result: Record<string, unknown[]> = {};
				for (const table of tables)
					result[table] = (await db.query(`SELECT * FROM "${table}" ORDER BY "id"`)).rows;
				return result;
			} finally {
				await db.end();
			}
		}
		async function journal() {
			const sql =
				'SELECT phase, "lastCommittedRestoreId", "lastCommittedAt" FROM "RestoreRuntimeControl"';
			if (fixture.engine === "sqlite") {
				const db = new Database(fileURLToPath(databaseUrl), {
					readonly: true,
					fileMustExist: true,
				});
				try {
					return db.prepare(sql).all();
				} finally {
					db.close();
				}
			}
			const db = new Client({ connectionString: databaseUrl });
			db.on("error", () => {});
			try {
				await db.connect();
				return (await db.query(sql)).rows;
			} finally {
				await db.end();
			}
		}
		const data = await fixture.run(async () => {
			const repository = fixture.repository();
			for (const state of ["deferred", "submitting", "uncertain"] as const) {
				const { eventId } = await repository.admit({
					...fixture.input(),
					payload: { ...fixture.payload, title: `Synthetic fenced ${state}` },
					policy:
						state === "deferred"
							? { stage: "deferred", dueAt: new Date(fixture.now.getTime() + 60000) }
							: { stage: "ready" },
				});
				if (state === "deferred") continue;
				const delivery = await fixture.prisma.notificationOutboxDelivery.findFirstOrThrow({
					where: { eventId, userId: fixture.userId },
				});
				const attempt = await repository.beginAttempt(delivery.id);
				expect(attempt).not.toBeNull();
				if (!attempt) throw new Error("Actual owned marker missing");
				if (state === "uncertain")
					expect(await repository.finishAttempt(attempt, { outcome: "uncertain" })).toBe(true);
			}
			for (const title of ["Synthetic fenced member one", "Synthetic fenced member two"])
				await repository.admit({
					...fixture.input(),
					payload: { ...fixture.payload, title },
					policy: { stage: "aggregating", windowSeconds: 60, maxBatchSize: 2 },
				});
			expect(await repository.groupDue()).toHaveLength(1);
			const exported = await exportDatabase(fixture.prisma, { excludeOperationalHistory: true });
			if (fixture.engine === "postgresql") {
				await fixture.prisma.$executeRawUnsafe(
					'CREATE FUNCTION "SyntheticOutboxCommitFailureFn"() RETURNS trigger AS $$ BEGIN IF NEW."lastCommittedRestoreId" IS NOT NULL THEN RAISE EXCEPTION \'synthetic commit marker failure\'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql',
				);
				await fixture.prisma.$executeRawUnsafe(
					'CREATE TRIGGER "SyntheticOutboxCommitFailure" BEFORE UPDATE ON "RestoreRuntimeControl" FOR EACH ROW EXECUTE FUNCTION "SyntheticOutboxCommitFailureFn"()',
				);
			} else
				await fixture.prisma.$executeRawUnsafe(
					'CREATE TRIGGER "SyntheticOutboxCommitFailure" BEFORE UPDATE ON "RestoreRuntimeControl" WHEN NEW."lastCommittedRestoreId" IS NOT NULL BEGIN SELECT RAISE(ABORT, \'synthetic commit marker failure\'); END',
				);
			return exported;
		});
		expect(data.notificationOutboxEvents).toHaveLength(6);
		expect(data.notificationOutboxDeliveries).toHaveLength(6);
		const prepared = await prepareRestoreData({
			envelope: await encryptBackupData(
				JSON.stringify({
					version: "1.5",
					appVersion: "synthetic",
					timestamp: fixture.now.toISOString(),
					data,
					secrets: { encryptionKey: "9".repeat(64), sessionCookieSecret: "synthetic-cookie" },
				}),
				"synthetic-password",
			),
			password: "synthetic-password",
			destination: {
				encryptor: new Encryptor("a".repeat(64)),
				installationId: "synthetic-notification-outbox-destination",
				stableForRestart: true,
			},
		});
		const before = await witness();
		let actualMarkerAttempted = false;
		await withRestoreRuntimeReplacement(fixture.runtime, prepared, async (scope) => {
			const context = getRestoreRuntimeReplacementClientContext(scope);
			const writer = createRuntimeReplacementPrismaClient(scope);
			const observed = new Proxy(writer.prisma, {
				get(client, property) {
					if (property !== "$transaction") return Reflect.get(client, property, client);
					return (...args: unknown[]) => {
						const operation = args[0];
						if (typeof operation !== "function")
							throw new Error("Actual interactive transaction required");
						args[0] = (tx: Prisma.TransactionClient) =>
							operation(
								new Proxy(tx, {
									get(transaction, field) {
										if (field !== "restoreRuntimeControl")
											return Reflect.get(transaction, field, transaction);
										return new Proxy(transaction.restoreRuntimeControl, {
											get(delegate, method) {
												if (method !== "updateMany") return Reflect.get(delegate, method, delegate);
												return (...parameters: Parameters<typeof delegate.updateMany>) => {
													if (parameters[0]?.data?.lastCommittedRestoreId === context.restoreId)
														actualMarkerAttempted = true;
													return Reflect.apply(delegate.updateMany, delegate, parameters);
												};
											},
										});
									},
								}),
							);
						return Reflect.apply(client.$transaction, client, args);
					};
				},
			});
			try {
				await expect(
					restorePreparedDatabase(
						observed,
						prepared,
						context.destinationInstallationId,
						context.commitRequest,
					),
				).rejects.toThrow();
			} finally {
				await writer.close();
			}
			expect(await context.readClosedPublicationOutcome()).toBe("not-committed");
		});
		expect(actualMarkerAttempted).toBe(true);
		expect(await witness()).toEqual(before);
		expect(await journal()).toEqual([
			{ phase: "restore-pending", lastCommittedRestoreId: null, lastCommittedAt: null },
		]);
		await expect(fixture.runtime.runOperation(() => "must remain closed")).rejects.toThrow();
	} finally {
		await fixture.runtime.close();
	}
}, 30000);
