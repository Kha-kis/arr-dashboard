/**
 * Actual service orchestration on owned native databases.
 * Only external transport and explicitly held/failing dependencies are controlled.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CleanupMaintenanceConflictError,
	withCleanupMaintenanceGuard,
	withCleanupOperationGuard,
} from "../../library-cleanup/cleanup-maintenance-gate.js";
import type { PrismaClientInstance } from "../../prisma.js";
import { NotificationDispatcher } from "../notification-dispatcher.js";
import { NotificationService } from "../notification-service.js";
import { RuleEngine } from "../rule-engine.js";
import type { NotificationPayload, SendResult } from "../types.js";
import { createNotificationOutboxNativeFixture } from "./notification-outbox-native-fixture.js";

type NativeFixture = Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
type AwaitOnly<T> = T extends (...args: infer Args) => unknown
	? (...args: Args) => PromiseLike<unknown>
	: never;
type Attempt = {
	channelId: string;
	userId: string;
	url: string;
	payload: NotificationPayload;
};

let fixture: NativeFixture;
let prisma: PrismaClientInstance;
let service: NotificationService;
let services: NotificationService[];
let dispatcher: NotificationDispatcher;
let channels: Map<string, { userId: string; url: string }>;
let attempts: Attempt[];
let results: Map<string, SendResult>;
let transport: (attempt: Attempt) => Promise<SendResult>;
let releases: (() => void)[];
let pending: Promise<unknown>[];
let diagnostics: unknown[];
const success: SendResult = { success: true, retryable: false };
const logger = {
	info(...args: unknown[]) {
		diagnostics.push(args);
	},
	debug(...args: unknown[]) {
		diagnostics.push(args);
	},
	warn(...args: unknown[]) {
		diagnostics.push(args);
	},
	error(...args: unknown[]) {
		diagnostics.push(args);
	},
};

function makePayload(overrides?: Partial<NotificationPayload>): NotificationPayload {
	return {
		eventType: "HUNT_COMPLETED",
		title: "Synthetic orchestrator event",
		body: "Synthetic orchestrator body",
		...overrides,
	};
}
function deferred<T>(fallback: T) {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	releases.push(() => resolve(fallback));
	return { promise, resolve };
}
function track<T>(promise: Promise<T>) {
	pending.push(
		promise.then(
			() => undefined,
			() => undefined,
		),
	);
	return promise;
}
function createService() {
	const current = new NotificationService(
		prisma,
		fixture.encryptor,
		dispatcher,
		logger,
		undefined,
		undefined,
		"https://synthetic.invalid",
		new RuleEngine(),
		undefined,
		{ runtime: fixture.runtime, clock: fixture.clock },
	);
	services.push(current);
	return current;
}
async function configure(channelId: string, userId: string, suffix = channelId) {
	const url = `https://synthetic.invalid/channel/${suffix}`;
	const encrypted = fixture.encryptor.encrypt(JSON.stringify({ webhookUrl: url }));
	await prisma.notificationChannel.update({
		where: { id: channelId, userId },
		data: { encryptedConfig: encrypted.value, configIv: encrypted.iv },
	});
	channels.set(channelId, { userId, url });
	return url;
}
async function extraChannel(
	userId = fixture.userId,
	eventTypes: NotificationPayload["eventType"][] = ["HUNT_COMPLETED"],
) {
	const id = randomUUID();
	const url = `https://synthetic.invalid/channel/${id}`;
	const encrypted = fixture.encryptor.encrypt(JSON.stringify({ webhookUrl: url }));
	await prisma.notificationChannel.create({
		data: {
			id,
			userId,
			name: "Synthetic scoped channel",
			type: "DISCORD",
			encryptedConfig: encrypted.value,
			configIv: encrypted.iv,
			subscriptions: { create: eventTypes.map((eventType) => ({ eventType })) },
		},
	});
	channels.set(id, { userId, url });
	return id;
}
async function otherOwner() {
	const owner = await fixture.createOwner();
	await configure(owner.channelId, owner.userId);
	return owner;
}
async function rule(userId: string, action: "suppress" | "route", targets?: string[]) {
	return prisma.notificationRule.create({
		data: {
			userId,
			name: "Synthetic scoped rule",
			action,
			conditions: "[]",
			targetChannelIds: targets === undefined ? null : JSON.stringify(targets),
		},
	});
}
async function aggregate(userId: string) {
	await prisma.notificationAggregationConfig.create({
		data: {
			userId,
			eventType: "HUNT_COMPLETED",
			enabled: true,
			windowSeconds: 60,
			maxBatchSize: 10,
		},
	});
}
async function history(channelId = fixture.channelId) {
	return prisma.notificationLog.findMany({
		where: { channelId },
		orderBy: { retryCount: "asc" },
	});
}
async function delivery(channelId = fixture.channelId, userId = fixture.userId) {
	return prisma.notificationOutboxDelivery.findFirstOrThrow({ where: { channelId, userId } });
}
async function resume(current = service) {
	await current.start();
	await current.drain();
}

beforeEach(async () => {
	fixture = await createNotificationOutboxNativeFixture();
	prisma = fixture.prisma;
	services = [];
	channels = new Map();
	attempts = [];
	results = new Map();
	releases = [];
	pending = [];
	diagnostics = [];
	await fixture.run(() => configure(fixture.channelId, fixture.userId));
	transport = async (attempt) => results.get(attempt.channelId) ?? success;
	dispatcher = new NotificationDispatcher();
	dispatcher.registerSender("DISCORD", {
		async send(config, payload) {
			expect(Object.keys(config)).toEqual(["webhookUrl"]);
			const found = [...channels].find(([, channel]) => channel.url === config.webhookUrl);
			if (!found) throw new Error("Unexpected synthetic transport destination.");
			const [channelId, channel] = found;
			const attempt = { channelId, userId: channel.userId, url: channel.url, payload };
			attempts.push(attempt);
			return transport(attempt);
		},
		async test() {
			throw new Error("No external Test in this fixture.");
		},
	});
	service = createService();
});
afterEach(async () => {
	for (const release of releases ?? []) release();
	try {
		await Promise.all(pending ?? []);
		for (const current of services ?? []) await current.shutdown();
	} finally {
		vi.restoreAllMocks();
		await fixture?.close();
	}
});

describe("native NotificationService orchestration", () => {
	it("resolves current channel config before a scheduled retry is sent", async () =>
		fixture.run(async () => {
			results.set(fixture.channelId, { success: false, retryable: true });
			await service.notify(makePayload(), { userId: fixture.userId });
			const queued = await delivery();
			expect(queued).toMatchObject({ state: "retry-waiting", attemptOrdinal: 1 });
			expect(queued.nextAttemptAt).toEqual(new Date(fixture.now.getTime() + 30_000));
			const nextUrl = await configure(fixture.channelId, fixture.userId, "fresh-retry");
			results.set(fixture.channelId, success);
			fixture.now = queued.nextAttemptAt;
			await resume();
			expect(attempts.map((attempt) => attempt.url)).toEqual([
				`https://synthetic.invalid/channel/${fixture.channelId}`,
				nextUrl,
			]);
			expect(await history()).toMatchObject([
				{ status: "failed", retryCount: 0 },
				{ status: "sent", retryCount: 1 },
			]);
		}));

	it.each(["history", "status"] as const)(
		"joins the actual %s finalization before shutdown even when it rolls back",
		async (phase) =>
			fixture.run(async () => {
				const entered = deferred<void>(undefined);
				const finish = deferred<void>(undefined);
				const transaction = prisma.$transaction.bind(prisma);
				vi.spyOn(prisma, "$transaction").mockImplementation((operation) =>
					transaction(async (tx) => {
						if (phase === "history") {
							const write = tx.notificationLog.create.bind(tx.notificationLog);
							const writes: { create: AwaitOnly<typeof tx.notificationLog.create> } =
								tx.notificationLog;
							vi.spyOn(writes, "create").mockImplementation(async (args) => {
								await write(args);
								entered.resolve();
								await finish.promise;
								throw new Error("Synthetic history rollback");
							});
						} else {
							const write = tx.notificationChannel.updateMany.bind(tx.notificationChannel);
							const writes: { updateMany: AwaitOnly<typeof tx.notificationChannel.updateMany> } =
								tx.notificationChannel;
							vi.spyOn(writes, "updateMany").mockImplementation(async (args) => {
								const result = await write(args);
								if (args.data.lastSendResult !== undefined) {
									entered.resolve();
									await finish.promise;
									throw new Error("Synthetic status rollback");
								}
								return result;
							});
						}
						return operation(tx);
					}),
				);
				const notifying = track(service.notify(makePayload(), { userId: fixture.userId }));
				await entered.promise;
				let closed = false;
				const closing = service.shutdown().then(() => {
					closed = true;
				});
				await Promise.resolve();
				expect(closed).toBe(false);
				finish.resolve();
				await notifying;
				await closing;
				expect(closed).toBe(true);
				expect(attempts).toHaveLength(1);
				expect(await history()).toEqual([]);
				expect(await delivery()).toMatchObject({ state: "submitting", attemptOrdinal: 0 });
				expect(
					(await prisma.notificationChannel.findUniqueOrThrow({ where: { id: fixture.channelId } }))
						.lastSentAt,
				).toBeNull();
			}),
	);

	it.each([
		"disabled",
		"deleted",
		"unsubscribed",
		"owner changed",
		"type changed",
		"subscription event changed",
	] as const)("cancels a scheduled retry when its original recipient is %s", async (change) =>
		fixture.run(async () => {
			results.set(fixture.channelId, { success: false, retryable: true });
			await service.notify(makePayload(), { userId: fixture.userId });
			const queued = await delivery();
			switch (change) {
				case "disabled":
					await prisma.notificationChannel.update({
						where: { id: fixture.channelId },
						data: { enabled: false },
					});
					break;
				case "deleted":
					await prisma.notificationChannel.delete({ where: { id: fixture.channelId } });
					break;
				case "unsubscribed":
					await prisma.notificationSubscription.deleteMany({
						where: { channelId: fixture.channelId },
					});
					break;
				case "owner changed": {
					const next = await otherOwner();
					await prisma.notificationChannel.update({
						where: { id: fixture.channelId },
						data: { userId: next.userId },
					});
					break;
				}
				case "type changed":
					await prisma.notificationChannel.update({
						where: { id: fixture.channelId },
						data: { type: "TELEGRAM" },
					});
					break;
				case "subscription event changed":
					await prisma.notificationSubscription.update({
						where: {
							channelId_eventType: { channelId: fixture.channelId, eventType: "HUNT_COMPLETED" },
						},
						data: { eventType: "SYSTEM_ERROR" },
					});
					break;
			}
			fixture.now = queued.nextAttemptAt;
			await resume();
			expect(attempts).toHaveLength(1);
			expect(await delivery()).toMatchObject({
				state: "canceled",
				outcomeCategory: "recipient-unavailable",
				attemptOrdinal: 1,
				attemptToken: null,
			});
			expect(await history()).toMatchObject([{ status: "failed", retryCount: 0 }]);
			expect(
				await prisma.notificationLog.count({
					where: { channelId: fixture.channelId, status: "dead_letter" },
				}),
			).toBe(0);
		}),
	);

	it("keeps a database-unavailable retry pending and recovers without spending a phantom attempt", async () =>
		fixture.run(async () => {
			results.set(fixture.channelId, { success: false, retryable: true });
			await service.notify(makePayload(), { userId: fixture.userId });
			const queued = await delivery();
			fixture.now = queued.nextAttemptAt;
			await prisma.$executeRawUnsafe(
				'ALTER TABLE "notification_subscriptions" RENAME TO "synthetic_notification_subscription_fault"',
			);
			try {
				await resume();
				expect(attempts).toHaveLength(1);
				expect(await delivery()).toMatchObject({
					state: "retry-waiting",
					attemptOrdinal: 1,
					nextAttemptAt: queued.nextAttemptAt,
					attemptToken: null,
				});
				expect(await history()).toMatchObject([{ status: "failed", retryCount: 0 }]);
			} finally {
				await prisma.$executeRawUnsafe(
					'ALTER TABLE "synthetic_notification_subscription_fault" RENAME TO "notification_subscriptions"',
				);
			}
			await service.shutdown();
			service = createService();
			results.set(fixture.channelId, success);
			await resume();
			expect(attempts).toHaveLength(2);
			expect(await history()).toMatchObject([
				{ status: "failed", retryCount: 0 },
				{ status: "sent", retryCount: 1 },
			]);
			expect(await delivery()).toMatchObject({ state: "sent", attemptOrdinal: 1 });
			expect(JSON.stringify(diagnostics)).not.toContain(
				"synthetic_notification_subscription_fault",
			);
		}));

	it("cancels a retry with undecryptable configuration without inventing a send", async () =>
		fixture.run(async () => {
			results.set(fixture.channelId, { success: false, retryable: true });
			await service.notify(makePayload(), { userId: fixture.userId });
			const queued = await delivery();
			await prisma.notificationChannel.update({
				where: { id: fixture.channelId, userId: fixture.userId },
				data: { encryptedConfig: "synthetic-corrupted-ciphertext" },
			});
			fixture.now = queued.nextAttemptAt;
			await resume();
			expect(attempts).toHaveLength(1);
			expect(await delivery()).toMatchObject({
				state: "canceled",
				outcomeCategory: "configuration",
				attemptOrdinal: 1,
			});
			expect(await history()).toMatchObject([{ status: "failed", retryCount: 0 }]);
			await configure(fixture.channelId, fixture.userId);
			await service.shutdown();
			service = createService();
			await resume();
			expect(attempts).toHaveLength(1);
			results.set(fixture.channelId, success);
			await service.notify(makePayload({ title: "Synthetic new event after repair" }), {
				userId: fixture.userId,
			});
			expect(attempts).toHaveLength(2);
			expect(JSON.stringify(diagnostics)).not.toContain("synthetic-corrupted-ciphertext");
		}));

	it("does not broaden deferred delivery after its captured recipient is revoked", async () =>
		fixture.run(async () => {
			await extraChannel();
			const dueAt = new Date(fixture.now.getTime() + 60_000);
			await fixture.repository().admit({
				...fixture.input(),
				payload: makePayload(),
				policy: { stage: "deferred", dueAt },
			});
			await prisma.notificationChannel.update({
				where: { id: fixture.channelId },
				data: { enabled: false },
			});
			fixture.now = dueAt;
			await resume();
			expect(attempts).toEqual([]);
			expect(await delivery()).toMatchObject({
				state: "canceled",
				outcomeCategory: "recipient-unavailable",
			});
			expect(
				await prisma.notificationOutboxDelivery.count({ where: { userId: fixture.userId } }),
			).toBe(1);
			expect(await history()).toEqual([]);
		}));

	it("dispatches actual subscribed encrypted configuration and commits sent history", async () =>
		fixture.run(async () => {
			const payload = makePayload();
			await service.notify(payload, { userId: fixture.userId });
			expect(attempts).toEqual([
				{
					channelId: fixture.channelId,
					userId: fixture.userId,
					url: `https://synthetic.invalid/channel/${fixture.channelId}`,
					payload,
				},
			]);
			expect(await history()).toMatchObject([
				{ channelId: fixture.channelId, channelType: "DISCORD", status: "sent", retryCount: 0 },
			]);
			expect(await delivery()).toMatchObject({ state: "sent", attemptOrdinal: 0 });
		}));

	it("route rules fail closed for absent, empty, unmatched, disabled or cross-owner targets", async () =>
		fixture.run(async () => {
			const disabled = await extraChannel();
			await prisma.notificationChannel.update({
				where: { id: disabled },
				data: { enabled: false },
			});
			const foreign = await otherOwner();
			const saved = await rule(fixture.userId, "route");
			for (const [index, targets] of [
				undefined,
				[],
				["missing"],
				[disabled, foreign.channelId],
			].entries()) {
				await prisma.notificationRule.update({
					where: { id: saved.id, userId: fixture.userId },
					data: { targetChannelIds: targets === undefined ? null : JSON.stringify(targets) },
				});
				await service.notify(makePayload({ title: `Synthetic route case ${index}` }), {
					userId: fixture.userId,
				});
			}
			expect(attempts).toEqual([]);
			expect(
				await prisma.notificationOutboxEvent.count({ where: { userId: fixture.userId } }),
			).toBe(0);
			expect(
				await prisma.notificationOutboxEvent.count({ where: { userId: foreign.userId } }),
			).toBe(0);
		}));

	it("evaluates unscoped rules independently for each actual subscription owner", async () =>
		fixture.run(async () => {
			const foreign = await otherOwner();
			const selected = await extraChannel(foreign.userId);
			await rule(fixture.userId, "suppress");
			await rule(foreign.userId, "route", [selected, fixture.channelId]);
			await service.notify(makePayload());
			expect(attempts.map(({ channelId, userId }) => ({ channelId, userId }))).toEqual([
				{ channelId: selected, userId: foreign.userId },
			]);
			expect(
				await prisma.notificationOutboxEvent.count({ where: { userId: fixture.userId } }),
			).toBe(0);
			expect(await history(selected)).toMatchObject([{ status: "sent" }]);
		}));

	it("keeps scoped identical events and committed dedup independent by owner", async () =>
		fixture.run(async () => {
			const foreign = await otherOwner();
			const payload = makePayload();
			await service.notify(payload, { userId: fixture.userId });
			await service.notify(payload, { userId: foreign.userId });
			expect(attempts.map((attempt) => attempt.userId)).toEqual([fixture.userId, foreign.userId]);
			expect(await history()).toHaveLength(1);
			expect(await history(foreign.channelId)).toHaveLength(1);
		}));

	it("rejects a foreign subscription even if the actual lookup dependency supplies it", async () =>
		fixture.run(async () => {
			const foreign = await otherOwner();
			const rows = await prisma.notificationSubscription.findMany({
				where: { channel: { userId: foreign.userId } },
				include: { channel: true },
			});
			vi.spyOn(prisma.notificationSubscription, "findMany").mockResolvedValueOnce(rows);
			await service.notify(makePayload(), { userId: fixture.userId });
			expect(attempts).toEqual([]);
			expect(
				await prisma.notificationOutboxEvent.count({ where: { userId: fixture.userId } }),
			).toBe(0);
			expect(
				await prisma.notificationOutboxEvent.count({ where: { userId: foreign.userId } }),
			).toBe(0);
		}));

	it("recovers owner and routed digests only for their restricted channels", async () =>
		fixture.run(async () => {
			const extra = await extraChannel();
			const foreign = await otherOwner();
			await rule(fixture.userId, "route", [fixture.channelId]);
			await rule(foreign.userId, "route", [foreign.channelId]);
			await aggregate(fixture.userId);
			await aggregate(foreign.userId);
			await service.notify(makePayload({ title: "Synthetic owner A content" }), {
				userId: fixture.userId,
			});
			await service.notify(makePayload({ title: "Synthetic owner B content" }), {
				userId: foreign.userId,
			});
			expect(attempts).toEqual([]);
			fixture.now = new Date(fixture.now.getTime() + 60_000);
			await resume();
			expect(attempts).toHaveLength(2);
			const firstDigest = attempts.find(
				(attempt) => attempt.channelId === fixture.channelId,
			)?.payload;
			const otherDigest = attempts.find(
				(attempt) => attempt.channelId === foreign.channelId,
			)?.payload;
			expect(firstDigest?.title).toBe("[1x] Synthetic owner A content");
			expect(otherDigest?.title).toBe("[1x] Synthetic owner B content");
			expect(firstDigest?.metadata?.items).toEqual([
				{ title: "Synthetic owner A content", body: "Synthetic orchestrator body" },
			]);
			expect(otherDigest?.metadata?.items).toEqual([
				{ title: "Synthetic owner B content", body: "Synthetic orchestrator body" },
			]);
			expect(attempts.every((attempt) => attempt.payload.metadata?.aggregated === true)).toBe(true);
			expect(await history(extra)).toEqual([]);
		}));

	it("revalidates enabled subscriptions when a routed digest becomes due", async () =>
		fixture.run(async () => {
			await rule(fixture.userId, "route", [fixture.channelId]);
			await aggregate(fixture.userId);
			await service.notify(makePayload(), { userId: fixture.userId });
			await prisma.notificationChannel.update({
				where: { id: fixture.channelId },
				data: { enabled: false },
			});
			fixture.now = new Date(fixture.now.getTime() + 60_000);
			await resume();
			expect(attempts).toEqual([]);
			expect(await history()).toEqual([]);
			expect(
				await prisma.notificationOutboxDelivery.count({
					where: {
						userId: fixture.userId,
						state: { in: ["ready", "submitting", "retry-waiting"] },
					},
				}),
			).toBe(0);
		}));

	it("holds maintenance exclusion for the complete actual transport lifetime", async () =>
		fixture.run(async () => {
			const entered = deferred<void>(undefined);
			const finish = deferred<SendResult>(success);
			transport = async () => {
				entered.resolve();
				return finish.promise;
			};
			const work = track(service.notify(makePayload(), { userId: fixture.userId }));
			await entered.promise;
			await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toBeInstanceOf(
				CleanupMaintenanceConflictError,
			);
			finish.resolve(success);
			await work;
			await expect(withCleanupMaintenanceGuard(async () => "available")).resolves.toBe("available");
		}));

	it("retains an independent lease when its guarded caller stops awaiting", async () =>
		fixture.run(async () => {
			const entered = deferred<void>(undefined);
			const finish = deferred<SendResult>(success);
			transport = async () => {
				entered.resolve();
				return finish.promise;
			};
			let work!: Promise<void>;
			await withCleanupOperationGuard(async () => {
				work = track(service.notify(makePayload(), { userId: fixture.userId }));
				await entered.promise;
			});
			await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toBeInstanceOf(
				CleanupMaintenanceConflictError,
			);
			finish.resolve(success);
			await work;
			await expect(withCleanupMaintenanceGuard(async () => "available")).resolves.toBe("available");
		}));

	it("rejects new notification dispatch while maintenance is held", async () =>
		fixture.run(async () => {
			await withCleanupMaintenanceGuard(async () => {
				await expect(
					service.notify(makePayload(), { userId: fixture.userId }),
				).rejects.toBeInstanceOf(CleanupMaintenanceConflictError);
			});
			expect(attempts).toEqual([]);
			expect(
				await prisma.notificationOutboxEvent.count({ where: { userId: fixture.userId } }),
			).toBe(0);
		}));

	it("preserves a due deferred event while maintenance blocks recovery and resumes afterward", async () =>
		fixture.run(async () => {
			const dueAt = new Date(fixture.now.getTime() + 60_000);
			await fixture.repository().admit({
				...fixture.input(),
				payload: makePayload(),
				policy: { stage: "deferred", dueAt },
			});
			fixture.now = dueAt;
			await withCleanupMaintenanceGuard(async () => {
				await resume();
				expect(attempts).toEqual([]);
				expect(await delivery()).toMatchObject({ state: "waiting", attemptOrdinal: 0 });
			});
			await resume();
			expect(attempts).toHaveLength(1);
			expect(await history()).toMatchObject([{ status: "sent" }]);
		}));

	it("routes one logical event to explicit and fallback subscriptions once per channel", async () =>
		fixture.run(async () => {
			await prisma.notificationChannel.update({
				where: { id: fixture.channelId, userId: fixture.userId },
				data: {
					subscriptions: {
						create: [{ eventType: "TRASH_DEPLOY_UNCERTAIN" }, { eventType: "TRASH_DEPLOY_FAILED" }],
					},
				},
			});
			const legacy = await extraChannel(fixture.userId, ["TRASH_DEPLOY_FAILED"]);
			await service.notify(makePayload({ eventType: "TRASH_DEPLOY_UNCERTAIN" }), {
				userId: fixture.userId,
				fallbackEventTypes: ["TRASH_DEPLOY_FAILED"],
			});
			expect(attempts.map((attempt) => attempt.channelId).sort()).toEqual(
				[fixture.channelId, legacy].sort(),
			);
			expect(await history()).toMatchObject([
				{ eventType: "TRASH_DEPLOY_UNCERTAIN", status: "sent" },
			]);
			expect(await history(legacy)).toMatchObject([
				{ eventType: "TRASH_DEPLOY_UNCERTAIN", status: "sent" },
			]);
		}));

	it("uses the updated normalized base URL in subsequent actual notification payloads", async () =>
		fixture.run(async () => {
			service.setBaseUrl("  https://synthetic.invalid/updated/  ");
			await service.notify(makePayload({ url: "/settings" }), { userId: fixture.userId });
			expect(attempts).toHaveLength(1);
			expect(attempts[0]?.payload.url).toBe("https://synthetic.invalid/updated/settings");
		}));

	it("committed content dedup prevents a second physical send and history row", async () =>
		fixture.run(async () => {
			await service.notify(makePayload(), { userId: fixture.userId });
			await service.notify(makePayload(), { userId: fixture.userId });
			expect(attempts).toHaveLength(1);
			expect(await history()).toHaveLength(1);
			expect(
				await prisma.notificationOutboxEvent.count({ where: { userId: fixture.userId } }),
			).toBe(1);
		}));

	it("persists a retryable recipient independently while another recipient succeeds", async () =>
		fixture.run(async () => {
			const other = await extraChannel();
			results.set(fixture.channelId, {
				success: false,
				retryable: true,
				retryAfterMs: 5000,
				failureCategory: "rate-limited",
			});
			await service.notify(makePayload(), { userId: fixture.userId });
			expect(attempts.map((attempt) => attempt.channelId).sort()).toEqual(
				[fixture.channelId, other].sort(),
			);
			expect(await delivery()).toMatchObject({
				state: "retry-waiting",
				attemptOrdinal: 1,
				nextAttemptAt: new Date(fixture.now.getTime() + 5000),
			});
			expect(await delivery(other)).toMatchObject({ state: "sent", attemptOrdinal: 0 });
			expect(await history()).toMatchObject([{ status: "failed", retryCount: 0 }]);
			expect(await history(other)).toMatchObject([{ status: "sent", retryCount: 0 }]);
		}));

	it("retains safe nonretryable failure evidence without scheduling a retry", async () =>
		fixture.run(async () => {
			const marker = "synthetic-private-provider-diagnostic";
			results.set(fixture.channelId, {
				success: false,
				retryable: false,
				error: marker,
				failureCategory: "authentication",
			});
			await service.notify(makePayload(), { userId: fixture.userId });
			expect(attempts).toHaveLength(1);
			expect(await delivery()).toMatchObject({
				state: "rejected",
				outcomeCategory: "authentication",
				attemptOrdinal: 0,
			});
			const rows = await history();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe("failed");
			expect(rows[0]?.error).toMatch(/credentials|permissions/i);
			expect(rows[0]?.error).not.toContain(marker);
			expect(JSON.stringify(diagnostics)).not.toContain(marker);
		}));

	it("returns without accepted work or a transport call when no subscriptions exist", async () =>
		fixture.run(async () => {
			await prisma.notificationSubscription.deleteMany({ where: { channelId: fixture.channelId } });
			await service.notify(makePayload(), { userId: fixture.userId });
			expect(attempts).toEqual([]);
			expect(await history()).toEqual([]);
			expect(
				await prisma.notificationOutboxEvent.count({ where: { userId: fixture.userId } }),
			).toBe(0);
		}));

	it("retains configuration cancellation and still delivers to a valid peer recipient", async () =>
		fixture.run(async () => {
			const other = await extraChannel();
			await prisma.notificationChannel.update({
				where: { id: fixture.channelId, userId: fixture.userId },
				data: { encryptedConfig: "synthetic-corrupted-ciphertext" },
			});
			await service.notify(makePayload(), { userId: fixture.userId });
			expect(attempts.map((attempt) => attempt.channelId)).toEqual([other]);
			expect(await delivery()).toMatchObject({
				state: "canceled",
				outcomeCategory: "configuration",
				attemptOrdinal: 0,
				dispatchedAt: null,
			});
			expect(await history()).toEqual([]);
			expect(await history(other)).toMatchObject([{ status: "sent" }]);
			expect(
				(await prisma.notificationChannel.findUniqueOrThrow({ where: { id: fixture.channelId } }))
					.lastSendResult,
			).toBeNull();
		}));
});
