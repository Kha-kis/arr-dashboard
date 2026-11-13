import { randomUUID } from "node:crypto";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Encryptor } from "../../auth/encryption.js";
import { openRestoreRuntime, type RestoreRuntime } from "../../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../../backup/runtime-schema-startup.js";
import { Prisma } from "../../prisma.js";
import type { NotificationOutboxAttempt } from "../outbox-types.js";
import type { NotificationPayload } from "../types.js";

const engine = process.env.NOTIFICATION_OUTBOX_TEST_ENGINE ?? "sqlite";
if (engine !== "sqlite" && engine !== "postgresql")
	throw new Error("Owned outbox engine required.");

describe(`notification outbox on owned native ${engine}`, () => {
	let runtime: RestoreRuntime;
	let native: ReturnType<typeof createRuntimePrismaClient>;
	let url: string;
	let userId: string;
	let channelId: string;
	let now: Date;
	const ownedUsers: Array<{ id: string; username: string }> = [];
	let unrelatedSentinel: { id: string; username: string } | undefined;
	const encryptor = new Encryptor("8".repeat(64));
	const payload: NotificationPayload = {
		eventType: "HUNT_COMPLETED",
		title: "Synthetic private title",
		body: "Synthetic private body",
		url: "https://example.invalid/private",
		metadata: { nested: { exact: [1, true, null, "value"] } },
	};
	const run = <T>(operation: () => Promise<T>) => runtime.runOperation(operation);
	async function repository(owner = userId) {
		const { createNotificationOutboxRepository } = await import("../outbox-repository.js");
		return createNotificationOutboxRepository(native.prisma, runtime, encryptor, owner, {
			clock: () => new Date(now),
		});
	}
	const input = () => ({
		payload,
		recipients: [
			{
				channelId,
				channelType: "DISCORD" as const,
				subscriptionEventType: "HUNT_COMPLETED" as const,
			},
		],
		policy: { stage: "ready" as const },
	});
	async function restart() {
		await native.close();
		await runtime.close();
		runtime = await openRestoreRuntime({ databaseUrl: url });
		await runtime.bindDestination("synthetic-notification-outbox-destination");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime);
	}
	async function createOwner() {
		const id = randomUUID();
		await native.prisma.user.create({ data: { id, username: `synthetic-${id}` } });
		ownedUsers.push({ id, username: `synthetic-${id}` });
		const config = encryptor.encrypt(
			JSON.stringify({ webhookUrl: "https://example.invalid/synthetic" }),
		);
		const channel = await native.prisma.notificationChannel.create({
			data: {
				userId: id,
				name: "Synthetic channel",
				type: "DISCORD",
				encryptedConfig: config.value,
				configIv: config.iv,
				subscriptions: { create: { eventType: "HUNT_COMPLETED" } },
			},
		});
		return { userId: id, channelId: channel.id };
	}
	beforeAll(async () => {
		if (engine === "postgresql") {
			const supplied = process.env.RESTORE_RUNTIME_TEST_PG_URL;
			if (!supplied) throw new Error("Owned outbox PostgreSQL fixture required.");
			const parsed = new URL(supplied);
			if (
				parsed.protocol !== "postgresql:" ||
				parsed.hostname !== "127.0.0.1" ||
				!parsed.port ||
				!/^arr_native_[a-f0-9]{32}_test$/.test(parsed.username) ||
				parsed.pathname !== `/${parsed.username}` ||
				!parsed.password ||
				parsed.search ||
				parsed.hash
			)
				throw new Error("Owned outbox PostgreSQL fixture required.");
			url = supplied;
		} else {
			const directory = await mkdtemp(join(tmpdir(), "arr-notification-outbox-"));
			await chmod(directory, 0o700);
			const file = join(directory, "owned.db");
			new Database(file).close();
			await chmod(file, 0o600);
			url = `file:${file}`;
		}
		await synchronizeRuntimeSchema(url);
		runtime = await openRestoreRuntime({ databaseUrl: url });
		await runtime.bindDestination("synthetic-notification-outbox-destination");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime);
		if (engine === "postgresql") {
			unrelatedSentinel = { id: randomUUID(), username: `unrelated-fixture-${randomUUID()}` };
			await run(() => native.prisma.user.create({ data: unrelatedSentinel! }));
		}
	}, 30_000);
	beforeEach(async () => {
		now = new Date("2026-10-10T12:00:00.000Z");
		({ userId, channelId } = await run(createOwner));
	});
	afterAll(async () => {
		const errors: unknown[] = [];
		try {
			if (engine === "postgresql" && native && runtime && unrelatedSentinel) {
				const sentinelIdentity = { ...unrelatedSentinel };
				await run(async () => {
					const ids = ownedUsers.map((owner) => owner.id);
					const where = { OR: ownedUsers.map((owner) => ({ ...owner })) };
					expect(ids.length).toBeGreaterThan(0);
					expect(new Set(ids).size).toBe(ids.length);
					expect(await native.prisma.user.count({ where })).toBe(ids.length);
					const sentinel = await native.prisma.user.findFirstOrThrow({
						where: sentinelIdentity,
					});
					const unrelated = { id: { notIn: [...ids, sentinel.id] } };
					const unrelatedCount = await native.prisma.user.count({ where: unrelated });
					// Only identities inserted by this suite; never sweep the shared database.
					expect((await native.prisma.user.deleteMany({ where })).count).toBe(ids.length);
					expect(await native.prisma.user.count({ where: { id: { in: ids } } })).toBe(0);
					expect(
						await native.prisma.notificationOutboxEvent.count({ where: { userId: { in: ids } } }),
					).toBe(0);
					expect(
						await native.prisma.notificationOutboxDelivery.count({
							where: { userId: { in: ids } },
						}),
					).toBe(0);
					expect(
						await native.prisma.notificationChannel.count({ where: { userId: { in: ids } } }),
					).toBe(0);
					expect(await native.prisma.user.findFirstOrThrow({ where: sentinelIdentity })).toEqual(
						sentinel,
					);
					expect(await native.prisma.user.count({ where: unrelated })).toBe(unrelatedCount);
					// Remove the separately-created sentinel only after proving it survived.
					expect((await native.prisma.user.deleteMany({ where: sentinelIdentity })).count).toBe(1);
				});
			}
		} catch (error) {
			errors.push(error);
		}
		try {
			await native?.close();
		} catch (error) {
			errors.push(error);
		}
		try {
			await runtime?.close();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length) throw new AggregateError(errors, "Owned repository fixture teardown failed");
	});
	it("creates both durable domain tables before native admission opens", async () => {
		const names = await runtime.runOperation(async () => {
			if (engine === "sqlite")
				return native.prisma.$queryRawUnsafe<{ name: string }[]>(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('NotificationOutboxEvent', 'NotificationOutboxDelivery') ORDER BY name",
				);
			return native.prisma.$queryRawUnsafe<{ name: string }[]>(
				"SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('NotificationOutboxEvent', 'NotificationOutboxDelivery') ORDER BY table_name",
			);
		});
		expect(names.map((row) => row.name)).toEqual([
			"NotificationOutboxDelivery",
			"NotificationOutboxEvent",
		]);
	});
	it("commits encrypted payload and the selected delivery before acknowledging admission", async () => {
		await run(async () => {
			const repo = await repository();
			const before = await native.prisma.user.findFirstOrThrow({ where: { id: userId } });
			const admitted = await repo.admit(input());
			expect(admitted.created).toBe(true);
			const event = await native.prisma.notificationOutboxEvent.findFirstOrThrow({
				where: { id: admitted.eventId, userId },
			});
			const deliveries = await native.prisma.notificationOutboxDelivery.findMany({
				where: { eventId: event.id, userId },
			});
			expect(event.stage).toBe("ready");
			expect(event.destinationInstallationId).toBe("synthetic-notification-outbox-destination");
			expect(event.restoreCommitId).toBeNull();
			expect(JSON.stringify(event)).not.toContain(payload.title);
			expect(JSON.stringify(event)).not.toContain(payload.body);
			expect(JSON.stringify(deliveries)).not.toContain("webhookUrl");
			expect(deliveries).toHaveLength(1);
			expect(deliveries[0]).toMatchObject({
				channelId,
				channelType: "DISCORD",
				state: "ready",
				attemptOrdinal: 0,
				attemptToken: null,
			});
			expect((await repo.readEvent(event.id))?.payload).toEqual(payload);
			expect(
				(await native.prisma.user.findFirstOrThrow({ where: { id: userId } })).updatedAt,
			).toEqual(before.updatedAt);
		});
	});
	it("reads the same encrypted event after native shutdown and reacquisition", async () => {
		const admitted = await run(async () => (await repository()).admit(input()));
		await restart();
		await run(async () => {
			const repo = await repository();
			expect((await repo.readEvent(admitted.eventId))?.payload).toEqual(payload);
			const repeated = await repo.admit(input());
			expect(repeated).toEqual({ created: false, eventId: admitted.eventId });
		});
	});
	it("serializes competing owner admissions into one committed event", async () => {
		const repo = await repository();
		const results = await Promise.all([
			run(() => repo.admit(input())),
			run(() => repo.admit(input())),
		]);
		expect(results.filter((result) => result.created)).toHaveLength(1);
		expect(results[0].eventId).toBe(results[1].eventId);
		await run(async () => {
			expect(await native.prisma.notificationOutboxEvent.count({ where: { userId } })).toBe(1);
			expect(await native.prisma.notificationOutboxDelivery.count({ where: { userId } })).toBe(1);
		});
	});
	it("admits identical content for separate owners without shared dedup or read authority", async () => {
		await run(async () => {
			const other = await createOwner();
			const first = await (await repository()).admit(input());
			const otherRepo = await repository(other.userId);
			const second = await otherRepo.admit({
				...input(),
				recipients: [{ ...input().recipients[0]!, channelId: other.channelId }],
			});
			expect(second.created).toBe(true);
			expect(second.eventId).not.toBe(first.eventId);
			expect(await otherRepo.readEvent(first.eventId)).toBeNull();
		});
	});
	it("expires committed content dedup at exactly sixty seconds, not earlier", async () => {
		await run(async () => {
			const repo = await repository();
			const first = await repo.admit(input());
			now = new Date("2026-10-10T12:00:59.999Z");
			expect(await repo.admit(input())).toEqual({ created: false, eventId: first.eventId });
			now = new Date("2026-10-10T12:01:00.000Z");
			expect((await repo.admit(input())).created).toBe(true);
		});
	});
	it("keeps the original selected recipients when a new subscription appears", async () => {
		await run(async () => {
			const repo = await repository();
			const first = await repo.admit(input());
			const other = await native.prisma.notificationChannel.create({
				data: {
					userId,
					name: "Late synthetic channel",
					type: "DISCORD",
					encryptedConfig: "not-used",
					configIv: "not-used",
					subscriptions: { create: { eventType: "HUNT_COMPLETED" } },
				},
			});
			const duplicate = await repo.admit({
				...input(),
				recipients: [...input().recipients, { ...input().recipients[0]!, channelId: other.id }],
			});
			expect(duplicate.eventId).toBe(first.eventId);
			expect(
				(await repo.readEvent(first.eventId))?.recipients.map((item) => item.channelId),
			).toEqual([channelId]);
		});
	});
	it("refuses an unowned selected recipient without poisoning a later valid admission", async () => {
		await run(async () => {
			const repo = await repository();
			const other = await createOwner();
			await expect(
				repo.admit({
					...input(),
					recipients: [{ ...input().recipients[0]!, channelId: other.channelId }],
				}),
			).rejects.toMatchObject({ category: "recipient-unavailable" });
			expect(await native.prisma.notificationOutboxEvent.count({ where: { userId } })).toBe(0);
			expect((await repo.admit(input())).created).toBe(true);
		});
	});
	it("does not accept an unsubscribed fallback event merely because the channel belongs to the owner", async () => {
		await run(async () => {
			const repo = await repository();
			await expect(
				repo.admit({
					...input(),
					recipients: [{ ...input().recipients[0]!, subscriptionEventType: "BACKUP_FAILED" }],
				}),
			).rejects.toMatchObject({ category: "recipient-unavailable" });
			expect(await native.prisma.notificationOutboxEvent.count({ where: { userId } })).toBe(0);
		});
	});
	it("rejects damaged encrypted payload with a generic category, not private content", async () => {
		await run(async () => {
			const repo = await repository();
			const admitted = await repo.admit(input());
			await native.prisma.notificationOutboxEvent.updateMany({
				where: { id: admitted.eventId, userId },
				data: { encryptedPayload: "damaged" },
			});
			await expect(repo.readEvent(admitted.eventId)).rejects.toMatchObject({
				category: "payload-unavailable",
				message: "Notification work is unavailable.",
			});
		});
	});
	it("refuses ciphertext copied from a different event even with a valid authentication tag", async () => {
		await run(async () => {
			const repo = await repository();
			const first = await repo.admit(input());
			const second = await repo.admit({
				...input(),
				payload: { ...payload, title: "Other synthetic title" },
			});
			const a = await native.prisma.notificationOutboxEvent.findFirstOrThrow({
				where: { id: first.eventId, userId },
			});
			await native.prisma.notificationOutboxEvent.updateMany({
				where: { id: second.eventId, userId },
				data: { encryptedPayload: a.encryptedPayload, payloadIv: a.payloadIv },
			});
			await expect(repo.readEvent(second.eventId)).rejects.toMatchObject({
				category: "payload-unavailable",
			});
		});
	});
	it.each([NaN, Infinity, undefined, BigInt(1)])(
		"refuses lossy JSON metadata instead of acknowledging changed content (%s)",
		async (value) => {
			await run(async () => {
				await expect(
					(await repository()).admit({ ...input(), payload: { ...payload, metadata: { value } } }),
				).rejects.toMatchObject({ category: "payload-unavailable" });
				expect(await native.prisma.notificationOutboxEvent.count({ where: { userId } })).toBe(0);
			});
		},
	);
	it("snapshots accepted payload before its producer mutates the object", async () => {
		await run(async () => {
			const repo = await repository();
			const mutable = { ...payload, metadata: { value: "original" } };
			const admitted = await repo.admit({ ...input(), payload: mutable });
			mutable.title = "Changed after acceptance";
			mutable.metadata.value = "changed";
			expect((await repo.readEvent(admitted.eventId))?.payload).toEqual({
				...payload,
				metadata: { value: "original" },
			});
		});
	});
	it("rejects an array whose extra property hides a missing index instead of silently persisting null", async () => {
		await run(async () => {
			const malformed: unknown[] = new Array(1);
			Object.defineProperty(malformed, "extra", { value: "would be lost", enumerable: true });
			await expect(
				(await repository()).admit({
					...input(),
					payload: { ...payload, metadata: { malformed } },
				}),
			).rejects.toMatchObject({ category: "payload-unavailable" });
			expect(await native.prisma.notificationOutboxEvent.count({ where: { userId } })).toBe(0);
		});
	});
	it("rejects producer metadata getters without invoking them", async () => {
		await run(async () => {
			let invoked = 0;
			const metadata = Object.defineProperty({}, "private", {
				enumerable: true,
				get: () => {
					invoked++;
					return "private value";
				},
			});
			await expect(
				(await repository()).admit({ ...input(), payload: { ...payload, metadata } }),
			).rejects.toMatchObject({ category: "payload-unavailable" });
			expect(invoked).toBe(0);
		});
	});
	it("rejects circular metadata without partially accepting its event", async () => {
		await run(async () => {
			const metadata: Record<string, unknown> = {};
			metadata.self = metadata;
			await expect(
				(await repository()).admit({ ...input(), payload: { ...payload, metadata } }),
			).rejects.toMatchObject({ category: "payload-unavailable" });
			expect(await native.prisma.notificationOutboxEvent.count({ where: { userId } })).toBe(0);
		});
	});
	it("rejects tampered stored recipient scope rather than decrypting it as authorized work", async () => {
		await run(async () => {
			const repo = await repository();
			const admitted = await repo.admit(input());
			await native.prisma.notificationOutboxDelivery.updateMany({
				where: { eventId: admitted.eventId, userId },
				data: { subscriptionEventType: "BACKUP_FAILED" },
			});
			await expect(repo.readEvent(admitted.eventId)).rejects.toMatchObject({
				category: "payload-unavailable",
			});
		});
	});
	it("preserves the exact quiet-hours deadline without making future work ready", async () => {
		await run(async () => {
			const repo = await repository();
			const admitted = await repo.admit({
				...input(),
				policy: { stage: "deferred", dueAt: new Date("2026-10-10T13:00:00.000Z") },
			});
			const event = await native.prisma.notificationOutboxEvent.findFirstOrThrow({
				where: { userId, id: admitted.eventId },
			});
			expect(event.stage).toBe("deferred");
			expect(event.dueAt.toISOString()).toBe("2026-10-10T13:00:00.000Z");
			expect(
				(
					await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
						where: { userId, eventId: event.id },
					})
				).state,
			).toBe("waiting");
		});
	});
	it("captures the aggregation policy and deadline with its committed selected scope", async () => {
		await run(async () => {
			const repo = await repository();
			const admitted = await repo.admit({
				...input(),
				policy: { stage: "aggregating", windowSeconds: 300, maxBatchSize: 10 },
			});
			const event = await native.prisma.notificationOutboxEvent.findFirstOrThrow({
				where: { userId, id: admitted.eventId },
			});
			expect(event).toMatchObject({
				stage: "aggregating",
				aggregationWindowSeconds: 300,
				maxBatchSize: 10,
			});
			expect(event.dueAt.toISOString()).toBe("2026-10-10T12:05:00.000Z");
		});
	});
	it("retains historical selected work when its owned channel is deleted", async () => {
		await run(async () => {
			const repo = await repository();
			const admitted = await repo.admit(input());
			await native.prisma.notificationChannel.deleteMany({ where: { id: channelId, userId } });
			expect(
				(await repo.readEvent(admitted.eventId))?.recipients.map((item) => item.channelId),
			).toEqual([channelId]);
			expect(
				await native.prisma.notificationOutboxDelivery.count({
					where: { userId, eventId: admitted.eventId },
				}),
			).toBe(1);
		});
	});
	it("rejects cross-owner event/delivery relations at the actual database boundary", async () => {
		await run(async () => {
			const admitted = await (await repository()).admit(input());
			const other = await createOwner();
			await expect(
				native.prisma.notificationOutboxDelivery.create({
					data: {
						userId: other.userId,
						eventId: admitted.eventId,
						channelId: other.channelId,
						channelType: "DISCORD",
						subscriptionEventType: "HUNT_COMPLETED",
						state: "ready",
						nextAttemptAt: now,
					},
				}),
			).rejects.toThrow();
			expect(
				await native.prisma.notificationOutboxDelivery.count({ where: { userId: other.userId } }),
			).toBe(0);
		});
	});
	it("rolls back the accepted event when its delivery insertion fails and allows explicit retry", async () => {
		await run(async () => {
			const repo = await repository();
			if (engine === "sqlite") {
				await native.prisma.$executeRawUnsafe(
					'CREATE TRIGGER "outbox_test_reject" BEFORE INSERT ON "NotificationOutboxDelivery" BEGIN SELECT RAISE(ABORT, \'synthetic insertion rejection\'); END',
				);
			} else {
				await native.prisma.$executeRawUnsafe(
					"CREATE FUNCTION outbox_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic insertion rejection'; END $$",
				);
				await native.prisma.$executeRawUnsafe(
					'CREATE TRIGGER outbox_test_reject BEFORE INSERT ON "NotificationOutboxDelivery" FOR EACH ROW EXECUTE FUNCTION outbox_test_reject()',
				);
			}
			try {
				await expect(repo.admit(input())).rejects.toThrow();
				expect(await native.prisma.notificationOutboxEvent.count({ where: { userId } })).toBe(0);
				expect(await native.prisma.notificationOutboxDelivery.count({ where: { userId } })).toBe(0);
			} finally {
				await native.prisma.$executeRawUnsafe(
					engine === "sqlite"
						? 'DROP TRIGGER "outbox_test_reject"'
						: 'DROP TRIGGER outbox_test_reject ON "NotificationOutboxDelivery"',
				);
				if (engine === "postgresql")
					await native.prisma.$executeRawUnsafe("DROP FUNCTION outbox_test_reject()");
			}
			expect((await repo.admit(input())).created).toBe(true);
		});
	});
	it("refuses new admission after native authority closes without persisting new work", async () => {
		const repo = await repository();
		runtime.closeAdmission();
		await expect(run(() => repo.admit(input()))).rejects.toMatchObject({ statusCode: 503 });
		await restart();
		await run(async () => {
			expect(await native.prisma.notificationOutboxEvent.count({ where: { userId } })).toBe(0);
		});
	});
	it("enumerates ready deliveries but does not activate quiet-hours or aggregation work early", async () => {
		await run(async () => {
			const repo = await repository();
			const ready = await repo.admit(input());
			await repo.admit({
				...input(),
				payload: { ...payload, title: "Deferred synthetic" },
				policy: { stage: "deferred", dueAt: new Date("2026-10-10T13:00:00.000Z") },
			});
			await repo.admit({
				...input(),
				payload: { ...payload, title: "Aggregated synthetic" },
				policy: { stage: "aggregating", windowSeconds: 300, maxBatchSize: 10 },
			});
			const delivery = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
				where: { userId, eventId: ready.eventId },
			});
			expect(await repo.listDueDeliveryIds()).toEqual([delivery.id]);
			const status = await repo.readQueueStatus();
			expect(status.events).toEqual({ ready: 1, deferred: 1, aggregating: 1 });
			expect(status.deliveries).toEqual({ ready: 1, retryWaiting: 0, submitting: 0, uncertain: 0 });
			expect(status.oldestDueAt?.toISOString()).toBe("2026-10-10T12:00:00.000Z");
		});
	});
	it("commits exactly one durable submitting marker under competing claims", async () => {
		const repo = await repository();
		const delivery = await run(async () => {
			const admitted = await repo.admit(input());
			return native.prisma.notificationOutboxDelivery.findFirstOrThrow({
				where: { userId, eventId: admitted.eventId },
			});
		});
		const claims = await Promise.all([
			run(() => repo.beginAttempt(delivery.id)),
			run(() => repo.beginAttempt(delivery.id)),
		]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		await run(async () => {
			const row = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
				where: { id: delivery.id, userId },
			});
			expect(row).toMatchObject({
				state: "submitting",
				attemptOrdinal: 0,
				attemptToken: claims.find(Boolean)!.token,
			});
			expect(row.dispatchedAt?.toISOString()).toBe("2026-10-10T12:00:00.000Z");
			expect(await native.prisma.notificationLog.count({ where: { channelId } })).toBe(0);
			expect(await repo.listDueDeliveryIds()).toEqual([]);
		});
	});
	it("atomically records acknowledged delivery once and updates only its captured channel generation", async () => {
		await run(async () => {
			const repo = await repository();
			const admitted = await repo.admit(input());
			const delivery = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
				where: { userId, eventId: admitted.eventId },
			});
			const attempt = (await repo.beginAttempt(delivery.id))!;
			expect(attempt.payload).toEqual(payload);
			expect(await repo.finishAttempt(attempt, { success: true, retryable: false })).toBe(true);
			expect(await repo.finishAttempt(attempt, { success: true, retryable: false })).toBe(false);
			expect(
				(
					await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
						where: { id: delivery.id, userId },
					})
				).state,
			).toBe("sent");
			expect(
				await native.prisma.notificationLog.findMany({
					where: { channelId },
					select: { status: true, retryCount: true },
				}),
			).toEqual([{ status: "sent", retryCount: 0 }]);
			expect(
				(
					await native.prisma.notificationChannel.findFirstOrThrow({
						where: { id: channelId, userId },
					})
				).lastSendResult,
			).toBe("success");
			expect(
				(
					await native.prisma.notificationOutboxEvent.findFirstOrThrow({
						where: { id: admitted.eventId, userId },
					})
				).stage,
			).toBe("terminal");
		});
	});
	const serializationFailure = (kind: "P2034" | "P2010" | "direct") =>
		kind === "direct"
			? Object.assign(new Error("Synthetic native rollback"), {
					name: "DriverAdapterError",
					cause: { kind: "TransactionWriteConflict", originalCode: "40001" },
				})
			: new Prisma.PrismaClientKnownRequestError("Synthetic native rollback", {
					clientVersion: Prisma.prismaVersion.client,
					code: kind,
					...(kind === "P2010"
						? {
								meta: {
									driverAdapterError: {
										cause: { kind: "TransactionWriteConflict", originalCode: "40001" },
									},
								},
							}
						: {}),
				});
	async function markedAttempt() {
		const repo = await repository();
		const admitted = await repo.admit(input());
		const delivery = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
			where: { eventId: admitted.eventId, userId },
		});
		const attempt = (await repo.beginAttempt(delivery.id))!;
		expect(attempt.payload).toEqual(payload);
		expect(attempt.ordinal).toBe(0);
		expect(attempt.recipient.config).toEqual({ webhookUrl: "https://example.invalid/synthetic" });
		expect((await repo.readEvent(admitted.eventId))?.recipients).toEqual(input().recipients);
		return { repo, attempt };
	}
	async function assertMarkedOutcome(attempt: NotificationOutboxAttempt, sent: boolean) {
		const delivery = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
			where: { id: attempt.deliveryId, eventId: attempt.eventId, userId, channelId },
		});
		expect(delivery).toMatchObject({
			state: sent ? "sent" : "submitting",
			attemptToken: attempt.token,
			workerEpoch: attempt.epoch,
			attemptOrdinal: 0,
			outcomeCategory: sent ? "acknowledged" : null,
		});
		const event = await native.prisma.notificationOutboxEvent.findFirstOrThrow({
			where: { id: attempt.eventId, userId },
		});
		expect(event.stage).toBe(sent ? "terminal" : "ready");
		expect(event.encryptedPayload).not.toContain(payload.title);
		expect(event.encryptedPayload).not.toContain(payload.body);
		expect(
			await native.prisma.notificationLog.findMany({
				where: { channelId },
				select: { status: true, retryCount: true, title: true, body: true, eventType: true },
			}),
		).toEqual(
			sent
				? [
						{
							status: "sent",
							retryCount: 0,
							title: payload.title,
							body: payload.body,
							eventType: "HUNT_COMPLETED",
						},
					]
				: [],
		);
		expect(
			await native.prisma.notificationChannel.findFirstOrThrow({
				where: { id: channelId, userId },
			}),
		).toMatchObject({ lastSentAt: sent ? now : null, lastSendResult: sent ? "success" : null });
	}
	function injectNativeRollback(
		attempt: NotificationOutboxAttempt,
		error: Error,
		site: "outcome" | "membership",
		failures = 1,
		afterFailure?: () => void,
	) {
		const originalTransaction = native.prisma.$transaction;
		let calls = 0;
		let membershipReads = 0;
		let completedWrites = 0;
		const spy = vi.spyOn(native.prisma, "$transaction").mockImplementation(async function (
			this: unknown,
			...args: unknown[]
		) {
			expect(args).toHaveLength(2);
			expect(args[1]).toEqual({ isolationLevel: "Serializable" });
			const operation = args[0] as (tx: Prisma.TransactionClient) => Promise<unknown>;
			expect(typeof operation).toBe("function");
			return Reflect.apply(originalTransaction, this, [
				async (tx: Prisma.TransactionClient) => {
					calls++;
					// Every retry sees the original committed marker, never partially committed outcome writes.
					expect(
						await tx.notificationOutboxDelivery.findFirstOrThrow({
							where: { id: attempt.deliveryId, userId },
						}),
					).toMatchObject({ state: "submitting", attemptToken: attempt.token, attemptOrdinal: 0 });
					expect(await tx.notificationLog.count({ where: { channelId } })).toBe(0);
					const originalRead = tx.notificationOutboxDelivery.findMany;
					const readSpy =
						site === "membership"
							? vi
									.spyOn(tx.notificationOutboxDelivery, "findMany")
									.mockImplementation(async function (this: unknown, ...readArgs: unknown[]) {
										const result = await Reflect.apply(originalRead, this, readArgs);
										expect(readArgs).toEqual([
											{
												where: { eventId: attempt.eventId, userId },
												select: { channelId: true, channelType: true, subscriptionEventType: true },
												orderBy: { channelId: "asc" },
											},
										]);
										expect(result).toEqual(input().recipients);
										membershipReads++;
										if (calls <= failures) {
											afterFailure?.();
											throw error;
										}
										return result;
									} as unknown as typeof originalRead)
							: undefined;
					try {
						const result = await operation(tx);
						if (site === "outcome") {
							expect(result).toBe(true);
							expect(await tx.notificationLog.count({ where: { channelId, status: "sent" } })).toBe(
								1,
							);
							expect(
								await tx.notificationChannel.findFirstOrThrow({ where: { id: channelId, userId } }),
							).toMatchObject({ lastSentAt: now, lastSendResult: "success" });
							expect(
								await tx.notificationOutboxEvent.findFirstOrThrow({
									where: { id: attempt.eventId, userId },
								}),
							).toMatchObject({ stage: "terminal" });
							completedWrites++;
							if (calls <= failures) {
								afterFailure?.();
								throw error;
							}
						}
						return result;
					} finally {
						readSpy?.mockRestore();
					}
				},
				...args.slice(1),
			]);
		} as unknown as typeof originalTransaction);
		return {
			restore: () => spy.mockRestore(),
			counts: () => ({ calls, membershipReads, completedWrites }),
		};
	}
	it("OUTBOX-SERIAL-1 retries a direct proved rollback after real acknowledged writes without duplicate outcome", async () => {
		await run(async () => {
			const { repo, attempt } = await markedAttempt();
			const injection = injectNativeRollback(attempt, serializationFailure("direct"), "outcome");
			try {
				expect(await repo.finishAttempt(attempt, { success: true, retryable: false })).toBe(true);
			} finally {
				injection.restore();
			}
			expect(injection.counts()).toEqual({ calls: 2, membershipReads: 0, completedWrites: 2 });
			await assertMarkedOutcome(attempt, true);
			expect(await repo.finishAttempt(attempt, { success: true, retryable: false })).toBe(false);
			await assertMarkedOutcome(attempt, true);
			expect((await repo.readEvent(attempt.eventId))?.payload).toEqual(payload);
		});
	});
	it.each(["P2034", "P2010", "direct"] as const)(
		"OUTBOX-SERIAL-1 preserves proved %s membership-read rollback for the bounded outer retry",
		async (kind) => {
			await run(async () => {
				const { repo, attempt } = await markedAttempt();
				const injection = injectNativeRollback(attempt, serializationFailure(kind), "membership");
				try {
					expect(await repo.finishAttempt(attempt, { success: true, retryable: false })).toBe(true);
				} finally {
					injection.restore();
				}
				expect(injection.counts()).toEqual({ calls: 2, membershipReads: 2, completedWrites: 0 });
				await assertMarkedOutcome(attempt, true);
				expect((await repo.readEvent(attempt.eventId))?.payload).toEqual(payload);
				expect((await repo.readEvent(attempt.eventId))?.recipients).toEqual(input().recipients);
			});
		},
	);
	it.each([
		[
			"wrong direct native code",
			Object.assign(new Error("Synthetic unproved rollback"), {
				name: "DriverAdapterError",
				cause: { kind: "TransactionWriteConflict", originalCode: "40002" },
			}),
		],
		[
			"missing direct native code",
			Object.assign(new Error("Synthetic unproved rollback"), {
				name: "DriverAdapterError",
				cause: { kind: "TransactionWriteConflict" },
			}),
		],
		[
			"wrong direct native kind",
			Object.assign(new Error("Synthetic unproved rollback"), {
				name: "DriverAdapterError",
				cause: { kind: "Postgres", originalCode: "40001" },
			}),
		],
		[
			"unexpected generic error",
			Object.assign(new Error("Synthetic unproved rollback"), {
				cause: { kind: "TransactionWriteConflict", originalCode: "40001" },
			}),
		],
		[
			"unproved P2010",
			new Prisma.PrismaClientKnownRequestError("Synthetic unproved rollback", {
				code: "P2010",
				clientVersion: Prisma.prismaVersion.client,
				meta: {
					driverAdapterError: {
						cause: { kind: "TransactionWriteConflict", originalCode: "40002" },
					},
				},
			}),
		],
	] as const)("OUTBOX-SERIAL-1 does not retry %s or commit false success", async (_, error) => {
		await run(async () => {
			const { repo, attempt } = await markedAttempt();
			const injection = injectNativeRollback(attempt, error, "outcome");
			try {
				await expect(
					repo.finishAttempt(attempt, { success: true, retryable: false }),
				).rejects.toMatchObject({ category: "storage-unavailable" });
			} finally {
				injection.restore();
			}
			expect(injection.counts()).toEqual({ calls: 1, membershipReads: 0, completedWrites: 1 });
			await assertMarkedOutcome(attempt, false);
		});
	});
	it.each(["P2034", "P2010", "direct"] as const)(
		"OUTBOX-SERIAL-1 exhausts only two proved %s retries and retains uncertain non-dispatchable work after restart",
		async (kind) => {
			const attempt = await run(async () => {
				const { repo, attempt } = await markedAttempt();
				const injection = injectNativeRollback(
					attempt,
					serializationFailure(kind),
					"outcome",
					Number.POSITIVE_INFINITY,
				);
				try {
					await expect(
						repo.finishAttempt(attempt, { success: true, retryable: false }),
					).rejects.toMatchObject({ category: "storage-unavailable" });
				} finally {
					injection.restore();
				}
				expect(injection.counts()).toEqual({ calls: 3, membershipReads: 0, completedWrites: 3 });
				await assertMarkedOutcome(attempt, false);
				return attempt;
			});
			await restart();
			await run(async () => {
				const repo = await repository();
				expect(await repo.recoverInterrupted()).toBe(1);
				expect(
					await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
						where: { id: attempt.deliveryId, userId },
					}),
				).toMatchObject({
					state: "uncertain",
					attemptToken: attempt.token,
					attemptOrdinal: 0,
					outcomeCategory: "unconfirmed",
				});
				expect(
					await native.prisma.notificationOutboxEvent.findFirstOrThrow({
						where: { id: attempt.eventId, userId },
					}),
				).toMatchObject({ stage: "terminal" });
				expect(await native.prisma.notificationLog.count({ where: { channelId } })).toBe(0);
				expect(
					await native.prisma.notificationChannel.findFirstOrThrow({
						where: { id: channelId, userId },
					}),
				).toMatchObject({ lastSentAt: null, lastSendResult: null });
				expect(await repo.listDueDeliveryIds()).toEqual([]);
				expect(await repo.beginAttempt(attempt.deliveryId)).toBeNull();
			});
		},
	);
	it("OUTBOX-SERIAL-1 completes an accepted rollback obligation through admission close while refusing new work", async () => {
		let attempt: NotificationOutboxAttempt | undefined;
		try {
			await run(async () => {
				const marked = await markedAttempt();
				attempt = marked.attempt;
				const injection = injectNativeRollback(
					marked.attempt,
					serializationFailure("P2034"),
					"outcome",
					1,
					() => runtime.closeAdmission(),
				);
				try {
					expect(
						await marked.repo.finishAttempt(marked.attempt, { success: true, retryable: false }),
					).toBe(true);
				} finally {
					injection.restore();
				}
				expect(injection.counts()).toEqual({ calls: 2, membershipReads: 0, completedWrites: 2 });
				await assertMarkedOutcome(marked.attempt, true);
			});
			let entered = false;
			await expect(
				run(async () => {
					entered = true;
				}),
			).rejects.toMatchObject({ name: "RestoreRuntimeAdmissionError" });
			expect(entered).toBe(false);
		} finally {
			await restart();
		}
		await run(async () => {
			expect(attempt).toBeDefined();
			await assertMarkedOutcome(attempt!, true);
			expect(await (await repository()).recoverInterrupted()).toBe(0);
			expect(await (await repository()).listDueDeliveryIds()).toEqual([]);
		});
	});
	it("rejects a cloned completion token instead of treating stored fields as send authority", async () => {
		await run(async () => {
			const repo = await repository();
			const admitted = await repo.admit(input());
			const delivery = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
				where: { userId, eventId: admitted.eventId },
			});
			const attempt = (await repo.beginAttempt(delivery.id))!;
			await expect(
				repo.finishAttempt({ ...attempt }, { success: true, retryable: false }),
			).rejects.toMatchObject({ category: "attempt-unavailable" });
			expect(
				(
					await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
						where: { id: delivery.id, userId },
					})
				).state,
			).toBe("submitting");
			expect(await native.prisma.notificationLog.count({ where: { channelId } })).toBe(0);
		});
	});
	it("cannot claim or complete another owner's selected delivery", async () => {
		await run(async () => {
			const repo = await repository();
			const admitted = await repo.admit(input());
			const delivery = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
				where: { userId, eventId: admitted.eventId },
			});
			const other = await createOwner();
			const otherRepo = await repository(other.userId);
			expect(await otherRepo.beginAttempt(delivery.id)).toBeNull();
			const attempt = (await repo.beginAttempt(delivery.id))!;
			await expect(
				otherRepo.finishAttempt(attempt, { success: true, retryable: false }),
			).rejects.toMatchObject({ category: "attempt-unavailable" });
		});
	});
	it.each(["disabled", "unsubscribed", "deleted", "type-changed"])(
		"cancels an %s recipient at execution without inventing an actual send",
		async (change) => {
			await run(async () => {
				const repo = await repository();
				const admitted = await repo.admit(input());
				const delivery = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
					where: { userId, eventId: admitted.eventId },
				});
				if (change === "disabled")
					await native.prisma.notificationChannel.updateMany({
						where: { id: channelId, userId },
						data: { enabled: false },
					});
				if (change === "deleted")
					await native.prisma.notificationChannel.deleteMany({ where: { id: channelId, userId } });
				if (change === "type-changed")
					await native.prisma.notificationChannel.updateMany({
						where: { id: channelId, userId },
						data: { type: "SLACK" },
					});
				if (change === "unsubscribed")
					await native.prisma.notificationSubscription.deleteMany({
						where: { channelId, channel: { userId } },
					});
				expect(await repo.beginAttempt(delivery.id)).toBeNull();
				expect(
					(
						await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
							where: { id: delivery.id, userId },
						})
					).state,
				).toBe("canceled");
				expect(await native.prisma.notificationLog.count({ where: { channelId } })).toBe(0);
			});
		},
	);
	it("records the actual old-generation result without overwriting replacement channel settings", async () => {
		await run(async () => {
			const repo = await repository();
			const admitted = await repo.admit(input());
			const delivery = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
				where: { userId, eventId: admitted.eventId },
			});
			const attempt = (await repo.beginAttempt(delivery.id))!;
			const replacement = encryptor.encrypt(
				JSON.stringify({ webhookUrl: "https://example.invalid/replacement" }),
			);
			await native.prisma.notificationChannel.updateMany({
				where: { id: channelId, userId },
				data: { encryptedConfig: replacement.value, configIv: replacement.iv },
			});
			expect(await repo.finishAttempt(attempt, { success: true, retryable: false })).toBe(true);
			expect(
				await native.prisma.notificationLog.count({ where: { channelId, status: "sent" } }),
			).toBe(1);
			expect(
				(
					await native.prisma.notificationChannel.findFirstOrThrow({
						where: { id: channelId, userId },
					})
				).lastSendResult,
			).toBeNull();
		});
	});
	it("retains exactly three remaining retry deadlines across native restart without resetting its budget", async () => {
		let repo = await repository();
		const id = await run(async () => {
			const admitted = await repo.admit(input());
			return (
				await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
					where: { userId, eventId: admitted.eventId },
				})
			).id;
		});
		const deadlines = [
			"2026-10-10T12:00:30.000Z",
			"2026-10-10T12:02:30.000Z",
			"2026-10-10T12:12:30.000Z",
		];
		for (let ordinal = 0; ordinal < 4; ordinal++) {
			await run(async () => {
				const attempt = (await repo.beginAttempt(id))!;
				expect(attempt.ordinal).toBe(ordinal);
				await repo.finishAttempt(attempt, {
					success: false,
					retryable: true,
					failureCategory: "provider-unavailable",
				});
				const row = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
					where: { id, userId },
				});
				if (ordinal < 3) {
					expect(row.state).toBe("retry-waiting");
					expect(row.attemptOrdinal).toBe(ordinal + 1);
					expect(row.nextAttemptAt.toISOString()).toBe(deadlines[ordinal]);
				} else expect(row.state).toBe("rejected");
			});
			await restart();
			repo = await repository();
			await run(async () => {
				await repo.recoverInterrupted();
				expect(await repo.listDueDeliveryIds()).toEqual([]);
			});
			if (ordinal < 3) now = new Date(deadlines[ordinal]!);
		}
		await run(async () => {
			expect(await repo.beginAttempt(id)).toBeNull();
			expect(
				(await native.prisma.notificationOutboxDelivery.findFirstOrThrow({ where: { id, userId } }))
					.attemptOrdinal,
			).toBe(3);
			expect(
				await native.prisma.notificationLog.count({ where: { channelId, status: "dead_letter" } }),
			).toBe(1);
		});
	});
	it("honors valid provider retryAfter without persisting a private provider error", async () => {
		await run(async () => {
			const repo = await repository();
			const admitted = await repo.admit(input());
			const delivery = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
				where: { userId, eventId: admitted.eventId },
			});
			const attempt = (await repo.beginAttempt(delivery.id))!;
			await repo.finishAttempt(attempt, {
				success: false,
				retryable: true,
				retryAfterMs: 1750,
				error: "Synthetic provider password should never persist",
				failureCategory: "rate-limited",
			});
			expect(
				(
					await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
						where: { id: delivery.id, userId },
					})
				).nextAttemptAt.toISOString(),
			).toBe("2026-10-10T12:00:01.750Z");
			expect(
				JSON.stringify(await native.prisma.notificationLog.findMany({ where: { channelId } })),
			).not.toContain("Synthetic provider password");
		});
	});
	it("never reclaims a committed submitting marker by time or native restart", async () => {
		const repo = await repository();
		const { id, attempt } = await run(async () => {
			const admitted = await repo.admit(input());
			const row = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
				where: { userId, eventId: admitted.eventId },
			});
			return { id: row.id, attempt: (await repo.beginAttempt(row.id))! };
		});
		await restart();
		const replacement = await repository();
		now = new Date("2026-10-11T12:00:00.000Z");
		await run(async () => {
			await replacement.recoverInterrupted();
			expect(await replacement.beginAttempt(id)).toBeNull();
			expect(await replacement.listDueDeliveryIds()).toEqual([]);
			expect(
				(await native.prisma.notificationOutboxDelivery.findFirstOrThrow({ where: { id, userId } }))
					.state,
			).toBe("uncertain");
			expect((await replacement.readQueueStatus()).deliveries.uncertain).toBe(1);
			expect(await replacement.recoverInterrupted()).toBe(0);
		});
		await expect(
			repo.finishAttempt(attempt, { success: true, retryable: false }),
		).rejects.toMatchObject({ statusCode: 503 });
	});
	it("activates deferred work only at its exact preserved deadline after restart", async () => {
		const repo = await repository();
		const id = await run(async () => {
			const admitted = await repo.admit({
				...input(),
				policy: { stage: "deferred", dueAt: new Date("2026-10-10T13:00:00.000Z") },
			});
			return (
				await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
					where: { userId, eventId: admitted.eventId },
				})
			).id;
		});
		await restart();
		const replacement = await repository();
		await run(async () => {
			now = new Date("2026-10-10T12:59:59.999Z");
			expect(await replacement.recoverInterrupted()).toBe(0);
			expect(await replacement.beginAttempt(id)).toBeNull();
			now = new Date("2026-10-10T13:00:00.000Z");
			expect(await replacement.recoverInterrupted()).toBe(1);
			expect(await replacement.listDueDeliveryIds()).toEqual([id]);
			expect((await replacement.beginAttempt(id))?.ordinal).toBe(0);
		});
	});
	it("retains a marked attempt as unconfirmed if its acknowledged-result log transaction fails", async () => {
		let id: string;
		await run(async () => {
			const repo = await repository();
			const admitted = await repo.admit(input());
			id = (
				await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
					where: { userId, eventId: admitted.eventId },
				})
			).id;
			const attempt = (await repo.beginAttempt(id))!;
			if (engine === "sqlite")
				await native.prisma.$executeRawUnsafe(
					'CREATE TRIGGER "outbox_log_reject" BEFORE INSERT ON "notification_logs" BEGIN SELECT RAISE(ABORT, \'synthetic result rejection\'); END',
				);
			else {
				await native.prisma.$executeRawUnsafe(
					"CREATE FUNCTION outbox_log_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic result rejection'; END $$",
				);
				await native.prisma.$executeRawUnsafe(
					'CREATE TRIGGER outbox_log_reject BEFORE INSERT ON "notification_logs" FOR EACH ROW EXECUTE FUNCTION outbox_log_reject()',
				);
			}
			try {
				await expect(
					repo.finishAttempt(attempt, { success: true, retryable: false }),
				).rejects.toMatchObject({ category: "storage-unavailable" });
				expect(
					(
						await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
							where: { id, userId },
						})
					).state,
				).toBe("submitting");
				expect(await native.prisma.notificationLog.count({ where: { channelId } })).toBe(0);
			} finally {
				await native.prisma.$executeRawUnsafe(
					engine === "sqlite"
						? 'DROP TRIGGER "outbox_log_reject"'
						: 'DROP TRIGGER outbox_log_reject ON "notification_logs"',
				);
				if (engine === "postgresql")
					await native.prisma.$executeRawUnsafe("DROP FUNCTION outbox_log_reject()");
			}
		});
		await restart();
		await run(async () => {
			const replacement = await repository();
			await replacement.recoverInterrupted();
			expect(
				(
					await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
						where: { id: id!, userId },
					})
				).state,
			).toBe("uncertain");
			expect(await replacement.listDueDeliveryIds()).toEqual([]);
		});
	});
	it("quarantines imported pending work instead of replaying it into this installation", async () => {
		await run(async () => {
			const repo = await repository();
			const admitted = await repo.admit(input());
			const event = await native.prisma.notificationOutboxEvent.findFirstOrThrow({
				where: { id: admitted.eventId, userId },
			});
			const envelope = JSON.parse(
				encryptor.decrypt({ value: event.encryptedPayload, iv: event.payloadIv }),
			);
			envelope.destinationInstallationId = "synthetic-other-installation";
			const encrypted = encryptor.encrypt(JSON.stringify(envelope));
			await native.prisma.notificationOutboxEvent.updateMany({
				where: { id: event.id, userId },
				data: {
					destinationInstallationId: envelope.destinationInstallationId,
					encryptedPayload: encrypted.value,
					payloadIv: encrypted.iv,
				},
			});
			expect(await repo.listDueDeliveryIds()).toEqual([]);
			expect(await repo.recoverInterrupted()).toBe(1);
			const delivery = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
				where: { userId, eventId: event.id },
			});
			expect(delivery).toMatchObject({
				state: "canceled",
				outcomeCategory: "restored-not-replayed",
			});
			expect(await repo.beginAttempt(delivery.id)).toBeNull();
			expect(await native.prisma.notificationLog.count({ where: { channelId } })).toBe(0);
		});
	});
	it("does not invent zero queue counts when stored progress has an unknown state", async () => {
		await run(async () => {
			const repo = await repository();
			const admitted = await repo.admit(input());
			await native.prisma.notificationOutboxDelivery.updateMany({
				where: { userId, eventId: admitted.eventId },
				data: { state: "unexpected" },
			});
			await expect(repo.readQueueStatus()).rejects.toMatchObject({ category: "state-unavailable" });
		});
	});
	it.each([
		{ state: "ready", attemptToken: "synthetic-old-marker" },
		{ state: "ready", workerEpoch: "synthetic-old-epoch" },
		{ state: "ready", attemptOrdinal: 1 },
		{ state: "retry-waiting", attemptOrdinal: 0 },
		{ state: "ready", dispatchedAt: new Date("2026-10-10T11:00:00.000Z") },
		{ state: "ready", completedAt: new Date("2026-10-10T11:00:00.000Z") },
	])(
		"does not convert inconsistent scheduled progress into a new dispatch grant: %j",
		async (data) => {
			await run(async () => {
				const repo = await repository();
				const admitted = await repo.admit(input());
				const delivery = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
					where: { userId, eventId: admitted.eventId },
				});
				await native.prisma.notificationOutboxDelivery.updateMany({
					where: { id: delivery.id, userId },
					data,
				});
				await expect(repo.beginAttempt(delivery.id)).rejects.toMatchObject({
					category: "state-unavailable",
				});
				expect(
					(
						await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
							where: { id: delivery.id, userId },
						})
					).state,
				).toBe(data.state);
				expect(await native.prisma.notificationLog.count({ where: { channelId } })).toBe(0);
			});
		},
	);
	it("does not recover or reclaim another active attempt in the same native epoch", async () => {
		await run(async () => {
			const repo = await repository();
			const admitted = await repo.admit(input());
			const delivery = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
				where: { userId, eventId: admitted.eventId },
			});
			const attempt = (await repo.beginAttempt(delivery.id))!;
			now = new Date("2026-10-11T12:00:00.000Z");
			const otherWorker = await repository();
			expect(await otherWorker.recoverInterrupted()).toBe(0);
			expect(await otherWorker.beginAttempt(delivery.id)).toBeNull();
			await expect(
				otherWorker.finishAttempt(attempt, { success: true, retryable: false }),
			).rejects.toMatchObject({ category: "attempt-unavailable" });
			expect(
				(
					await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
						where: { id: delivery.id, userId },
					})
				).state,
			).toBe("submitting");
		});
	});
	it("records unknown provider settlement as uncertain without a failed log or automatic retry", async () => {
		await run(async () => {
			const repo = await repository();
			const admitted = await repo.admit(input());
			const delivery = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
				where: { userId, eventId: admitted.eventId },
			});
			const attempt = (await repo.beginAttempt(delivery.id))!;
			expect(await repo.finishAttempt(attempt, { outcome: "uncertain" })).toBe(true);
			expect(
				(
					await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
						where: { id: delivery.id, userId },
					})
				).state,
			).toBe("uncertain");
			expect(await repo.listDueDeliveryIds()).toEqual([]);
			expect(await repo.beginAttempt(delivery.id)).toBeNull();
			expect(await native.prisma.notificationLog.count({ where: { channelId } })).toBe(0);
		});
	});
	it("rejects inconsistent outcomes while retaining the submitting marker", async () => {
		await run(async () => {
			const repo = await repository();
			const admitted = await repo.admit(input());
			const delivery = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
				where: { userId, eventId: admitted.eventId },
			});
			const attempt = (await repo.beginAttempt(delivery.id))!;
			await expect(
				repo.finishAttempt(attempt, { success: true, retryable: true }),
			).rejects.toMatchObject({ category: "outcome-unavailable" });
			expect(
				(
					await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
						where: { id: delivery.id, userId },
					})
				).state,
			).toBe("submitting");
		});
	});
	it("resolves replacement configuration at the next known retry rather than reusing the failed send", async () => {
		await run(async () => {
			const repo = await repository();
			const admitted = await repo.admit(input());
			const delivery = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
				where: { userId, eventId: admitted.eventId },
			});
			const first = (await repo.beginAttempt(delivery.id))!;
			await repo.finishAttempt(first, {
				success: false,
				retryable: true,
				failureCategory: "provider-unavailable",
			});
			const replacement = encryptor.encrypt(
				JSON.stringify({ webhookUrl: "https://example.invalid/retry-replacement" }),
			);
			await native.prisma.notificationChannel.updateMany({
				where: { id: channelId, userId },
				data: { encryptedConfig: replacement.value, configIv: replacement.iv },
			});
			now = new Date("2026-10-10T12:00:30.000Z");
			const second = (await repo.beginAttempt(delivery.id))!;
			expect(second.ordinal).toBe(1);
			expect(second.recipient.config.webhookUrl).toBe("https://example.invalid/retry-replacement");
			expect(second.configFingerprint).not.toBe(first.configFingerprint);
			expect(await repo.finishAttempt(first, { success: true, retryable: false })).toBe(false);
			expect(await repo.finishAttempt(second, { success: true, retryable: false })).toBe(true);
			expect(
				await native.prisma.notificationLog.findMany({
					where: { channelId },
					orderBy: { sentAt: "asc" },
					select: { status: true, retryCount: true },
				}),
			).toEqual([
				{ status: "failed", retryCount: 0 },
				{ status: "sent", retryCount: 1 },
			]);
		});
	});
	it("does not append an old owner's send history after channel ownership changes", async () => {
		await run(async () => {
			const repo = await repository();
			const admitted = await repo.admit(input());
			const delivery = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
				where: { userId, eventId: admitted.eventId },
			});
			const attempt = (await repo.beginAttempt(delivery.id))!;
			const other = await createOwner();
			await native.prisma.notificationChannel.updateMany({
				where: { id: channelId, userId },
				data: { userId: other.userId },
			});
			expect(await repo.finishAttempt(attempt, { success: true, retryable: false })).toBe(true);
			expect(
				(
					await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
						where: { id: delivery.id, userId },
					})
				).state,
			).toBe("sent");
			expect(await native.prisma.notificationLog.count({ where: { channelId } })).toBe(0);
			expect(
				(
					await native.prisma.notificationChannel.findFirstOrThrow({
						where: { id: channelId, userId: other.userId },
					})
				).lastSendResult,
			).toBeNull();
		});
	});
	it("does not claim delivery success when the guarded outcome update affects no row", async () => {
		await run(async () => {
			const repo = await repository();
			const admitted = await repo.admit(input());
			const delivery = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
				where: { userId, eventId: admitted.eventId },
			});
			const attempt = (await repo.beginAttempt(delivery.id))!;
			if (engine === "sqlite")
				await native.prisma.$executeRawUnsafe(
					'CREATE TRIGGER "outbox_outcome_ignore" BEFORE UPDATE ON "NotificationOutboxDelivery" BEGIN SELECT RAISE(IGNORE); END',
				);
			else {
				await native.prisma.$executeRawUnsafe(
					"CREATE FUNCTION outbox_outcome_ignore() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$",
				);
				await native.prisma.$executeRawUnsafe(
					'CREATE TRIGGER outbox_outcome_ignore BEFORE UPDATE ON "NotificationOutboxDelivery" FOR EACH ROW EXECUTE FUNCTION outbox_outcome_ignore()',
				);
			}
			try {
				await expect(
					repo.finishAttempt(attempt, { success: true, retryable: false }),
				).rejects.toMatchObject({ category: "storage-unavailable" });
				expect(
					(
						await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
							where: { id: delivery.id, userId },
						})
					).state,
				).toBe("submitting");
				expect(await native.prisma.notificationLog.count({ where: { channelId } })).toBe(0);
				expect(
					(
						await native.prisma.notificationChannel.findFirstOrThrow({
							where: { id: channelId, userId },
						})
					).lastSendResult,
				).toBeNull();
			} finally {
				await native.prisma.$executeRawUnsafe(
					engine === "sqlite"
						? 'DROP TRIGGER "outbox_outcome_ignore"'
						: 'DROP TRIGGER outbox_outcome_ignore ON "NotificationOutboxDelivery"',
				);
				if (engine === "postgresql")
					await native.prisma.$executeRawUnsafe("DROP FUNCTION outbox_outcome_ignore()");
			}
		});
	});
	it("groups the expired scoped window atomically without making originals dispatchable", async () => {
		await run(async () => {
			const repo = await repository();
			const policy = { stage: "aggregating" as const, windowSeconds: 300, maxBatchSize: 10 };
			const first = await repo.admit({
				...input(),
				payload: { ...payload, title: "First synthetic" },
				policy,
			});
			now = new Date("2026-10-10T12:01:00.000Z");
			const second = await repo.admit({
				...input(),
				payload: { ...payload, title: "Second synthetic" },
				policy,
			});
			expect(await repo.groupDue()).toEqual([]);
			now = new Date("2026-10-10T12:05:00.000Z");
			const digests = await repo.groupDue();
			expect(digests).toHaveLength(1);
			expect((await repo.readEvent(digests[0]!))?.payload).toEqual({
				eventType: "HUNT_COMPLETED",
				title: "[2x] First synthetic, Second synthetic",
				body: "Aggregated 2 HUNT_COMPLETED notifications",
				metadata: {
					aggregated: true,
					count: 2,
					items: [
						{ title: "First synthetic", body: payload.body },
						{ title: "Second synthetic", body: payload.body },
					],
				},
			});
			const members = await native.prisma.notificationOutboxEvent.findMany({
				where: { userId, id: { in: [first.eventId, second.eventId] } },
			});
			expect(members.map((row) => row.stage)).toEqual(["grouped", "grouped"]);
			expect(members.every((row) => row.aggregateParentId === digests[0])).toBe(true);
			const retired = await native.prisma.notificationOutboxDelivery.findMany({
				where: { userId, eventId: { in: [first.eventId, second.eventId] } },
			});
			expect(
				retired.every(
					(row) =>
						row.state === "canceled" &&
						row.outcomeCategory === "aggregated" &&
						row.attemptToken === null,
				),
			).toBe(true);
			const due = await repo.listDueDeliveryIds();
			expect(due).toHaveLength(1);
			expect((await repo.beginAttempt(due[0]!))?.eventId).toBe(digests[0]);
			for (const row of retired) expect(await repo.beginAttempt(row.id)).toBeNull();
			expect(await repo.groupDue()).toEqual([]);
		});
	});
	it("groups a full batch before its timer but keeps the following partial batch waiting", async () => {
		await run(async () => {
			const repo = await repository();
			const policy = { stage: "aggregating" as const, windowSeconds: 300, maxBatchSize: 2 };
			for (const title of ["First", "Second", "Third"])
				await repo.admit({ ...input(), payload: { ...payload, title }, policy });
			expect(await repo.groupDue()).toHaveLength(1);
			expect(
				await native.prisma.notificationOutboxEvent.count({
					where: { userId, stage: "aggregating" },
				}),
			).toBe(1);
			expect(await repo.groupDue()).toEqual([]);
			now = new Date("2026-10-10T12:05:00.000Z");
			expect(await repo.groupDue()).toHaveLength(1);
			expect(await repo.listDueDeliveryIds()).toHaveLength(2);
		});
	});
	it("creates one digest under competing groupers and preserves it across native restart", async () => {
		const repo = await repository();
		await run(async () => {
			for (const title of ["First", "Second"])
				await repo.admit({
					...input(),
					payload: { ...payload, title },
					policy: { stage: "aggregating", windowSeconds: 300, maxBatchSize: 2 },
				});
		});
		const results = await Promise.all([run(() => repo.groupDue()), run(() => repo.groupDue())]);
		expect(results.flat()).toHaveLength(1);
		await restart();
		await run(async () => {
			const replacement = await repository();
			expect(await replacement.groupDue()).toEqual([]);
			expect(await replacement.listDueDeliveryIds()).toHaveLength(1);
			expect(
				await native.prisma.notificationOutboxEvent.count({ where: { userId, stage: "ready" } }),
			).toBe(1);
			expect(
				await native.prisma.notificationOutboxEvent.count({ where: { userId, stage: "grouped" } }),
			).toBe(2);
		});
	});
	it("does not group different selected recipient or policy scopes together", async () => {
		await run(async () => {
			const repo = await repository();
			const config = encryptor.encrypt(
				JSON.stringify({ webhookUrl: "https://example.invalid/second" }),
			);
			const other = await native.prisma.notificationChannel.create({
				data: {
					userId,
					name: "Synthetic second",
					type: "DISCORD",
					encryptedConfig: config.value,
					configIv: config.iv,
					subscriptions: { create: { eventType: "HUNT_COMPLETED" } },
				},
			});
			await repo.admit({
				...input(),
				payload: { ...payload, title: "Original recipient" },
				policy: { stage: "aggregating", windowSeconds: 300, maxBatchSize: 10 },
			});
			await repo.admit({
				...input(),
				payload: { ...payload, title: "Other recipient" },
				recipients: [{ ...input().recipients[0]!, channelId: other.id }],
				policy: { stage: "aggregating", windowSeconds: 300, maxBatchSize: 10 },
			});
			await repo.admit({
				...input(),
				payload: { ...payload, title: "Other policy" },
				policy: { stage: "aggregating", windowSeconds: 300, maxBatchSize: 2 },
			});
			now = new Date("2026-10-10T12:05:00.000Z");
			const ids = await repo.groupDue();
			expect(ids).toHaveLength(3);
			for (const id of ids) expect((await repo.readEvent(id))?.payload.metadata?.count).toBe(1);
		});
	});
	it("does not group another owner's events or imported pending work", async () => {
		await run(async () => {
			const repo = await repository();
			const other = await createOwner();
			const foreignRepo = await repository(other.userId);
			await foreignRepo.admit({
				...input(),
				recipients: [{ ...input().recipients[0]!, channelId: other.channelId }],
				policy: { stage: "aggregating", windowSeconds: 300, maxBatchSize: 2 },
			});
			const admitted = await repo.admit({
				...input(),
				policy: { stage: "aggregating", windowSeconds: 300, maxBatchSize: 2 },
			});
			const event = await native.prisma.notificationOutboxEvent.findFirstOrThrow({
				where: { id: admitted.eventId, userId },
			});
			const envelope = JSON.parse(
				encryptor.decrypt({ value: event.encryptedPayload, iv: event.payloadIv }),
			);
			envelope.destinationInstallationId = "synthetic-other-installation";
			const encrypted = encryptor.encrypt(JSON.stringify(envelope));
			await native.prisma.notificationOutboxEvent.updateMany({
				where: { id: event.id, userId },
				data: {
					destinationInstallationId: envelope.destinationInstallationId,
					encryptedPayload: encrypted.value,
					payloadIv: encrypted.iv,
				},
			});
			now = new Date("2026-10-10T12:05:00.000Z");
			expect(await repo.groupDue()).toEqual([]);
			expect(
				await native.prisma.notificationOutboxEvent.count({
					where: { userId: other.userId, stage: "aggregating" },
				}),
			).toBe(1);
			expect(await repo.recoverInterrupted()).toBe(1);
		});
	});
	it("rolls back all digest and member changes when a digest delivery cannot be committed", async () => {
		await run(async () => {
			const repo = await repository();
			for (const title of ["First", "Second"])
				await repo.admit({
					...input(),
					payload: { ...payload, title },
					policy: { stage: "aggregating", windowSeconds: 300, maxBatchSize: 2 },
				});
			if (engine === "sqlite")
				await native.prisma.$executeRawUnsafe(
					'CREATE TRIGGER "outbox_digest_reject" BEFORE INSERT ON "NotificationOutboxDelivery" BEGIN SELECT RAISE(ABORT, \'synthetic digest rejection\'); END',
				);
			else {
				await native.prisma.$executeRawUnsafe(
					"CREATE FUNCTION outbox_digest_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic digest rejection'; END $$",
				);
				await native.prisma.$executeRawUnsafe(
					'CREATE TRIGGER outbox_digest_reject BEFORE INSERT ON "NotificationOutboxDelivery" FOR EACH ROW EXECUTE FUNCTION outbox_digest_reject()',
				);
			}
			try {
				await expect(repo.groupDue()).rejects.toMatchObject({ category: "storage-unavailable" });
				expect(
					await native.prisma.notificationOutboxEvent.count({
						where: { userId, stage: "aggregating", aggregateParentId: null },
					}),
				).toBe(2);
				expect(
					await native.prisma.notificationOutboxDelivery.count({
						where: { userId, state: "waiting" },
					}),
				).toBe(2);
				expect(
					await native.prisma.notificationOutboxEvent.count({ where: { userId, stage: "ready" } }),
				).toBe(0);
			} finally {
				await native.prisma.$executeRawUnsafe(
					engine === "sqlite"
						? 'DROP TRIGGER "outbox_digest_reject"'
						: 'DROP TRIGGER outbox_digest_reject ON "NotificationOutboxDelivery"',
				);
				if (engine === "postgresql")
					await native.prisma.$executeRawUnsafe("DROP FUNCTION outbox_digest_reject()");
			}
			expect(await repo.groupDue()).toHaveLength(1);
		});
	});
	it("refuses a corrupted aggregation envelope without retiring the accepted members", async () => {
		await run(async () => {
			const repo = await repository();
			for (const title of ["First", "Second"])
				await repo.admit({
					...input(),
					payload: { ...payload, title },
					policy: { stage: "aggregating", windowSeconds: 300, maxBatchSize: 2 },
				});
			const event = await native.prisma.notificationOutboxEvent.findFirstOrThrow({
				where: { userId },
				orderBy: { id: "asc" },
			});
			await native.prisma.notificationOutboxEvent.updateMany({
				where: { id: event.id, userId },
				data: { encryptedPayload: "synthetic-corruption" },
			});
			await expect(repo.groupDue()).rejects.toMatchObject({ category: "payload-unavailable" });
			expect(
				await native.prisma.notificationOutboxEvent.count({
					where: { userId, stage: "aggregating" },
				}),
			).toBe(2);
			expect(
				await native.prisma.notificationOutboxEvent.count({ where: { userId, stage: "ready" } }),
			).toBe(0);
		});
	});
	it("preserves separate aggregation windows when processing a delayed backlog", async () => {
		await run(async () => {
			const repo = await repository();
			const policy = { stage: "aggregating" as const, windowSeconds: 300, maxBatchSize: 10 };
			await repo.admit({ ...input(), payload: { ...payload, title: "First window" }, policy });
			now = new Date("2026-10-10T12:01:00.000Z");
			await repo.admit({ ...input(), payload: { ...payload, title: "Also first window" }, policy });
			now = new Date("2026-10-10T12:07:00.000Z");
			await repo.admit({ ...input(), payload: { ...payload, title: "Later window" }, policy });
			const digests = await repo.groupDue();
			expect(digests).toHaveLength(1);
			expect((await repo.readEvent(digests[0]!))?.payload.metadata?.count).toBe(2);
			expect(
				await native.prisma.notificationOutboxEvent.count({
					where: { userId, stage: "aggregating" },
				}),
			).toBe(1);
			expect(await repo.groupDue()).toEqual([]);
			now = new Date("2026-10-10T12:12:00.000Z");
			const later = await repo.groupDue();
			expect(later).toHaveLength(1);
			expect((await repo.readEvent(later[0]!))?.payload.metadata?.count).toBe(1);
		});
	});
	it("bounds grouping without allowing future partial scopes to hide eligible batches", async () => {
		await run(async () => {
			const repo = await repository();
			await repo.admit({
				...input(),
				payload: { ...payload, title: "Future partial scope" },
				policy: { stage: "aggregating", windowSeconds: 300, maxBatchSize: 10 },
			});
			for (const title of ["Full first", "Full second"])
				await repo.admit({
					...input(),
					payload: { ...payload, title },
					policy: { stage: "aggregating", windowSeconds: 600, maxBatchSize: 2 },
				});
			const full = await repo.groupDue(1);
			expect(full).toHaveLength(1);
			expect((await repo.readEvent(full[0]!))?.payload.metadata?.count).toBe(2);
			expect(
				await native.prisma.notificationOutboxEvent.count({
					where: { userId, stage: "aggregating" },
				}),
			).toBe(1);
		});
	});
	it("recovers valid deferred work despite an earlier malformed deferred sibling", async () => {
		await run(async () => {
			const repo = await repository();
			const malformed = await repo.admit({
				...input(),
				payload: { ...payload, title: "Synthetic malformed deferred" },
				policy: { stage: "deferred", dueAt: new Date("2026-10-10T12:00:01.000Z") },
			});
			const valid = await repo.admit({
				...input(),
				payload: { ...payload, title: "Synthetic valid deferred" },
				policy: { stage: "deferred", dueAt: new Date("2026-10-10T12:00:02.000Z") },
			});
			await native.prisma.notificationOutboxEvent.updateMany({
				where: { userId, id: malformed.eventId },
				data: { encryptedPayload: "synthetic-corruption" },
			});
			now = new Date("2026-10-10T12:01:00.000Z");
			let failure: unknown;
			try {
				await repo.recoverInterrupted();
			} catch (error) {
				failure = error;
			}
			const validEvent = await native.prisma.notificationOutboxEvent.findFirstOrThrow({
				where: { userId, id: valid.eventId },
			});
			expect(validEvent.stage).toBe("ready");
			expect(
				await native.prisma.notificationOutboxDelivery.count({
					where: { userId, eventId: valid.eventId, state: "ready", attemptOrdinal: 0 },
				}),
			).toBe(1);
			expect(await repo.listDueDeliveryIds()).toHaveLength(1);
			expect(failure).toMatchObject({ category: "payload-unavailable" });
			const badEvent = await native.prisma.notificationOutboxEvent.findFirstOrThrow({
				where: { userId, id: malformed.eventId },
			});
			expect(badEvent.stage).toBe("deferred");
			expect(badEvent.encryptedPayload).toBe("synthetic-corruption");
			expect(
				await native.prisma.notificationOutboxDelivery.count({
					where: { userId, eventId: malformed.eventId, state: "waiting", attemptOrdinal: 0 },
				}),
			).toBe(1);
			expect(await native.prisma.notificationLog.count({ where: { channelId } })).toBe(0);
		});
	});
	it("groups valid due work despite an earlier malformed aggregation scope", async () => {
		await run(async () => {
			const repo = await repository();
			const malformed = await repo.admit({
				...input(),
				payload: { ...payload, title: "Synthetic malformed aggregate" },
				policy: { stage: "aggregating", windowSeconds: 60, maxBatchSize: 2 },
			});
			const validIds: string[] = [];
			for (const title of ["Synthetic valid first", "Synthetic valid second"])
				validIds.push(
					(
						await repo.admit({
							...input(),
							payload: { ...payload, title },
							policy: { stage: "aggregating", windowSeconds: 120, maxBatchSize: 2 },
						})
					).eventId,
				);
			await native.prisma.notificationOutboxEvent.updateMany({
				where: { userId, id: malformed.eventId },
				data: { encryptedPayload: "synthetic-corruption" },
			});
			now = new Date("2026-10-10T12:03:00.000Z");
			let failure: unknown;
			try {
				await repo.groupDue();
			} catch (error) {
				failure = error;
			}
			const digests = await native.prisma.notificationOutboxEvent.findMany({
				where: { userId, stage: "ready" },
			});
			expect(digests).toHaveLength(1);
			expect((await repo.readEvent(digests[0]!.id))?.payload.metadata?.count).toBe(2);
			expect(
				await native.prisma.notificationOutboxEvent.count({
					where: {
						userId,
						id: { in: validIds },
						stage: "grouped",
						aggregateParentId: digests[0]!.id,
					},
				}),
			).toBe(2);
			expect(await repo.listDueDeliveryIds()).toHaveLength(1);
			expect(failure).toMatchObject({ category: "payload-unavailable" });
			const badEvent = await native.prisma.notificationOutboxEvent.findFirstOrThrow({
				where: { userId, id: malformed.eventId },
			});
			expect(badEvent.stage).toBe("aggregating");
			expect(badEvent.aggregateParentId).toBeNull();
			expect(badEvent.encryptedPayload).toBe("synthetic-corruption");
			expect(
				await native.prisma.notificationOutboxDelivery.count({
					where: { userId, eventId: malformed.eventId, state: "waiting", attemptOrdinal: 0 },
				}),
			).toBe(1);
			expect(await native.prisma.notificationLog.count({ where: { channelId } })).toBe(0);
		});
	});
	it.each(["deferred", "aggregating"] as const)(
		"refuses an advanced %s header that contradicts its accepted encrypted deadline",
		async (stage) => {
			await run(async () => {
				const repo = await repository();
				const admitted = await repo.admit({
					...input(),
					policy:
						stage === "deferred"
							? { stage, dueAt: new Date("2026-10-10T13:00:00.000Z") }
							: { stage, windowSeconds: 300, maxBatchSize: 10 },
				});
				const event = await native.prisma.notificationOutboxEvent.findFirstOrThrow({
					where: { id: admitted.eventId, userId },
				});
				const envelope = JSON.parse(
					encryptor.decrypt({ value: event.encryptedPayload, iv: event.payloadIv }),
				);
				envelope.dueAt = now.toISOString();
				const encrypted = encryptor.encrypt(JSON.stringify(envelope));
				await native.prisma.notificationOutboxEvent.updateMany({
					where: { id: event.id, userId },
					data: { dueAt: now, encryptedPayload: encrypted.value, payloadIv: encrypted.iv },
				});
				await expect(
					stage === "deferred" ? repo.recoverInterrupted() : repo.groupDue(),
				).rejects.toMatchObject({ category: "payload-unavailable" });
				expect(
					(
						await native.prisma.notificationOutboxEvent.findFirstOrThrow({
							where: { id: event.id, userId },
						})
					).stage,
				).toBe(stage);
				expect(await repo.listDueDeliveryIds()).toEqual([]);
			});
		},
	);
});
