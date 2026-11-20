import { afterEach, describe, expect, it, vi } from "vitest";
import { withCleanupMaintenanceGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import type { NotificationPayload } from "../../lib/notifications/types.js";
import { bootNotificationNativeApp } from "./fixtures/notification-native-app.js";

type Fixture = Awaited<ReturnType<typeof bootNotificationNativeApp>>;
type NativeFixture = Fixture["native"];
type Phase = "subscription" | "rules" | "aggregation" | "send" | "log" | "channel";
type AwaitOnly<T> = T extends (...args: infer Args) => unknown
	? (...args: Args) => PromiseLike<unknown>
	: never;
const fixtures: Fixture[] = [];
const releases: Array<() => void> = [];
const tasks: Promise<unknown>[] = [];

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((release) => {
		resolve = release;
	});
	releases.push(resolve);
	return { promise, resolve };
}

function track<T>(task: Promise<T>) {
	const observed = task.then(
		(value) => ({ status: "fulfilled" as const, value }),
		() => ({ status: "rejected" as const }),
	);
	tasks.push(observed);
	return observed;
}

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(tasks.splice(0));
	for (const fixture of fixtures.splice(0)) await fixture.dispose();
	vi.restoreAllMocks();
});

async function boot(
	options: {
		holds?: Array<{
			phase: Phase;
			call?: number;
			gate: Promise<void>;
			entered: () => void;
			reject?: boolean;
		}>;
		aggregate?: boolean;
		maxBatchSize?: number;
		noRecipients?: boolean;
		beforeClose?: Promise<void>;
		prepare?: (native: NativeFixture) => Promise<void>;
		awaitStartup?: boolean;
	} = {},
) {
	const counts = {
		subscription: 0,
		rules: 0,
		aggregation: 0,
		send: 0,
		log: 0,
		channel: 0,
		transactions: 0,
	};
	let pending = 0;
	let order: string[] = [];
	async function pause(phase: Phase) {
		const call = ++counts[phase];
		pending++;
		order.push(`${phase}-${call}-enter`);
		try {
			const hold = options.holds?.find((item) => item.phase === phase && (item.call ?? 1) === call);
			if (hold) {
				hold.entered();
				await hold.gate;
				if (hold.reject) throw new Error("Synthetic incoming dependency failure");
			}
		} finally {
			pending--;
			order.push(`${phase}-${call}-settled`);
		}
	}
	const fixture = await bootNotificationNativeApp({
		beforeClose: options.beforeClose,
		awaitStartup: options.awaitStartup,
		async prepare(native) {
			if (options.noRecipients)
				await native.prisma.notificationSubscription.deleteMany({
					where: { channelId: native.channelId },
				});
			if (options.aggregate)
				await native.prisma.notificationAggregationConfig.create({
					data: {
						userId: native.userId,
						eventType: "HUNT_COMPLETED",
						enabled: true,
						windowSeconds: 60,
						maxBatchSize: options.maxBatchSize ?? 10,
					},
				});
			await options.prepare?.(native);
		},
		instrument(prisma, native, recordedOrder) {
			order = recordedOrder;
			const subscriptions = prisma.notificationSubscription.findMany.bind(
				prisma.notificationSubscription,
			);
			const subscriptionReads: {
				findMany: AwaitOnly<typeof prisma.notificationSubscription.findMany>;
			} = prisma.notificationSubscription;
			vi.spyOn(subscriptionReads, "findMany").mockImplementation(async (args) => {
				expect(args?.where?.channel).toEqual({ userId: native.userId });
				const rows = await subscriptions(args);
				await pause("subscription");
				return rows;
			});
			const rules = prisma.notificationRule.findMany.bind(prisma.notificationRule);
			const ruleReads: { findMany: AwaitOnly<typeof prisma.notificationRule.findMany> } =
				prisma.notificationRule;
			vi.spyOn(ruleReads, "findMany").mockImplementation(async (args) => {
				expect(args?.where).toEqual({ userId: native.userId, enabled: true });
				const rows = await rules(args);
				await pause("rules");
				return rows;
			});
			const aggregation = prisma.notificationAggregationConfig.findMany.bind(
				prisma.notificationAggregationConfig,
			);
			const aggregationReads: {
				findMany: AwaitOnly<typeof prisma.notificationAggregationConfig.findMany>;
			} = prisma.notificationAggregationConfig;
			vi.spyOn(aggregationReads, "findMany").mockImplementation(async (args) => {
				expect(args?.where).toEqual({ userId: native.userId, enabled: true });
				const rows = await aggregation(args);
				await pause("aggregation");
				return rows;
			});
			const transaction = prisma.$transaction.bind(prisma);
			vi.spyOn(prisma, "$transaction").mockImplementation(async (operation) => {
				counts.transactions++;
				return transaction(async (tx) => {
					const createLog = tx.notificationLog.create.bind(tx.notificationLog);
					const historyWrites: { create: AwaitOnly<typeof tx.notificationLog.create> } =
						tx.notificationLog;
					vi.spyOn(historyWrites, "create").mockImplementation(async (args) => {
						expect(args.data.channelId).toBe(native.channelId);
						const row = await createLog(args);
						await pause("log");
						return row;
					});
					const updateStatus = tx.notificationChannel.updateMany.bind(tx.notificationChannel);
					const statusWrites: { updateMany: AwaitOnly<typeof tx.notificationChannel.updateMany> } =
						tx.notificationChannel;
					vi.spyOn(statusWrites, "updateMany").mockImplementation(async (args) => {
						const row = await updateStatus(args);
						if (args?.data.lastSendResult !== undefined) {
							expect(args.where?.id).toBe(native.channelId);
							expect(args.where?.userId).toBe(native.userId);
							await pause("channel");
						}
						return row;
					});
					return operation(tx);
				});
			});
		},
		async transport() {
			await pause("send");
			return { success: true, retryable: false };
		},
	});
	fixtures.push(fixture);
	let sequence = 0;
	return {
		...fixture,
		counts,
		notify(extra?: Partial<NotificationPayload>, skipRules = false) {
			return track(
				fixture.notify(
					{ ...fixture.native.payload, title: `Synthetic incoming ${++sequence}`, ...extra },
					{ skipRules },
				),
			);
		},
		close: () => track(fixture.app.close()),
		assertClosed() {
			expect(pending).toBe(0);
			expect(fixture.state.pendingAtDatabaseClose).toBe(0);
			expect(fixture.state.physicalClientClosed).toBe(true);
			expect(fixture.state.databaseCloseCount).toBe(1);
			const closeIndex = order.indexOf("database-close-start");
			expect(closeIndex).toBeGreaterThanOrEqual(0);
			for (const [index, event] of order.entries())
				if (event.endsWith("-enter") || event.endsWith("-settled"))
					expect(index).toBeLessThan(closeIndex);
		},
	};
}

async function readWork(fixture: Pick<Fixture, "native">, eventId: string) {
	const work = await fixture.native.run(() => fixture.native.repository().readEvent(eventId));
	if (!work) throw new Error("Expected accepted native event missing");
	return work;
}

async function outcome(
	fixture: Pick<Fixture, "native" | "deliveries" | "history">,
	state: string | null,
	history: string[],
) {
	const rows = await fixture.deliveries();
	expect(rows.map((row) => row.state)).toEqual(state ? [state] : []);
	for (const row of rows) {
		expect(row.userId).toBe(fixture.native.userId);
		expect(row.channelId).toBe(fixture.native.channelId);
		expect(row.attemptOrdinal).toBe(0);
	}
	expect((await fixture.history()).map((row) => row.status)).toEqual(history);
	const channel = await fixture.native.run(() =>
		fixture.native.prisma.notificationChannel.findFirstOrThrow({
			where: { id: fixture.native.channelId, userId: fixture.native.userId },
		}),
	);
	expect(channel.lastSendResult).toBe(state === "sent" ? "success" : null);
	return rows;
}

describe("incoming notification native shutdown", () => {
	// Removing incoming tracking or worker drain allows premature physical closure.
	it.each(["subscription", "rules", "aggregation", "send", "log", "channel"] as const)(
		"retains accepted %s work until native settlement",
		async (phase) => {
			const gate = deferred(),
				entered = deferred();
			const fixture = await boot({
				holds: [{ phase, gate: gate.promise, entered: entered.resolve }],
			});
			const notification = fixture.notify();
			await entered.promise;
			const close = fixture.close();
			await fixture.preClosed;
			expect(fixture.state.physicalClientClosed).toBe(false);
			gate.resolve();
			expect((await notification).status).toBe("fulfilled");
			expect((await close).status).toBe("fulfilled");
			fixture.assertClosed();
			const preAdmission = phase === "subscription" || phase === "rules" || phase === "aggregation";
			const rows = await outcome(
				fixture,
				preAdmission ? "ready" : "sent",
				preAdmission ? [] : ["sent"],
			);
			expect(fixture.payloads).toEqual(
				preAdmission ? [] : [{ ...fixture.native.payload, title: "Synthetic incoming 1" }],
			);
			if (preAdmission) {
				const work = await readWork(fixture, rows[0]!.eventId);
				expect(work.payload).toEqual({ ...fixture.native.payload, title: "Synthetic incoming 1" });
			}
		},
	);

	it.each(["subscription", "rules", "aggregation", "send", "log", "channel"] as const)(
		"settles rejected %s work without invented delivery",
		async (phase) => {
			const gate = deferred(),
				entered = deferred();
			const fixture = await boot({
				holds: [{ phase, gate: gate.promise, entered: entered.resolve, reject: true }],
			});
			const notification = fixture.notify();
			await entered.promise;
			const close = fixture.close();
			await fixture.preClosed;
			expect(fixture.state.physicalClientClosed).toBe(false);
			gate.resolve();
			const preAdmission = phase === "subscription" || phase === "rules" || phase === "aggregation";
			expect((await notification).status).toBe(preAdmission ? "rejected" : "fulfilled");
			expect((await close).status).toBe("fulfilled");
			fixture.assertClosed();
			await outcome(
				fixture,
				preAdmission ? null : phase === "send" ? "uncertain" : "submitting",
				[],
			);
			expect(fixture.payloads.length).toBe(preAdmission ? 0 : 1);
		},
	);

	it("joins a real subscription read with no recipients and accepts no event", async () => {
		const gate = deferred(),
			entered = deferred();
		const fixture = await boot({
			noRecipients: true,
			holds: [{ phase: "subscription", gate: gate.promise, entered: entered.resolve }],
		});
		const notification = fixture.notify();
		await entered.promise;
		const close = fixture.close();
		await fixture.preClosed;
		expect(fixture.state.physicalClientClosed).toBe(false);
		gate.resolve();
		expect((await notification).status).toBe("fulfilled");
		await close;
		fixture.assertClosed();
		await outcome(fixture, null, []);
		expect(fixture.payloads).toEqual([]);
		expect(
			await fixture.native.run(() =>
				fixture.native.prisma.notificationOutboxEvent.count({
					where: { userId: fixture.native.userId },
				}),
			),
		).toBe(0);
	});

	it.each(["subscription", "rules", "aggregation"] as const)(
		"commits accepted %s aggregation without forcing a shutdown digest",
		async (phase) => {
			const gate = deferred(),
				entered = deferred();
			const fixture = await boot({
				aggregate: true,
				holds: [{ phase, gate: gate.promise, entered: entered.resolve }],
			});
			const notification = fixture.notify();
			await entered.promise;
			const close = fixture.close();
			await fixture.preClosed;
			gate.resolve();
			expect((await notification).status).toBe("fulfilled");
			await close;
			fixture.assertClosed();
			const rows = await outcome(fixture, "waiting", []);
			const work = await readWork(fixture, rows[0]!.eventId);
			expect(work.policy).toEqual({ stage: "aggregating", windowSeconds: 60, maxBatchSize: 10 });
			expect(work.payload.title).toBe("Synthetic incoming 1");
			expect(work.recipients).toEqual([
				{
					channelId: fixture.native.channelId,
					channelType: "DISCORD",
					subscriptionEventType: "HUNT_COMPLETED",
				},
			]);
			expect(fixture.payloads).toEqual([]);
		},
	);

	it("preserves the valid two-event threshold without sending during close", async () => {
		const gate = deferred(),
			entered = deferred();
		const fixture = await boot({
			aggregate: true,
			maxBatchSize: 2,
			holds: [{ phase: "subscription", gate: gate.promise, entered: entered.resolve }],
			async prepare(native) {
				native.now = new Date();
				await native.repository().admit({
					...native.input(),
					policy: { stage: "aggregating", windowSeconds: 60, maxBatchSize: 2 },
				});
			},
		});
		const notification = fixture.notify();
		await entered.promise;
		const close = fixture.close();
		await fixture.preClosed;
		gate.resolve();
		expect((await notification).status).toBe("fulfilled");
		await close;
		fixture.assertClosed();
		const rows = await fixture.deliveries();
		expect(rows.map((row) => row.state)).toEqual(["waiting", "waiting"]);
		const work = await Promise.all(rows.map((row) => readWork(fixture, row.eventId)));
		expect(work.map((event) => event.payload.title).sort()).toEqual([
			"Synthetic incoming 1",
			"Synthetic worker event",
		]);
		for (const event of work)
			expect(event.policy).toEqual({ stage: "aggregating", windowSeconds: 60, maxBatchSize: 2 });
		expect(await fixture.history()).toEqual([]);
		expect(fixture.payloads).toEqual([]);
	});

	it("retains two overlapping accepted payloads across duplicate close", async () => {
		const first = deferred(),
			second = deferred(),
			enteredFirst = deferred(),
			enteredSecond = deferred();
		const fixture = await boot({
			holds: [
				{ phase: "subscription", call: 1, gate: first.promise, entered: enteredFirst.resolve },
				{ phase: "subscription", call: 2, gate: second.promise, entered: enteredSecond.resolve },
			],
		});
		const firstNotification = fixture.notify();
		await enteredFirst.promise;
		// Keep both parents pending, but bind each hold to the intended notification.
		// Concurrent native reads need not finish in invocation order on PostgreSQL.
		const secondNotification = fixture.notify();
		await enteredSecond.promise;
		const close = fixture.close(),
			duplicate = fixture.close();
		await fixture.preClosed;
		first.resolve();
		expect((await firstNotification).status).toBe("fulfilled");
		expect((await fixture.deliveries()).map((row) => row.state)).toEqual(["ready"]);
		expect(fixture.state.physicalClientClosed).toBe(false);
		second.resolve();
		expect((await secondNotification).status).toBe("fulfilled");
		expect((await close).status).toBe("fulfilled");
		expect((await duplicate).status).toBe("fulfilled");
		fixture.assertClosed();
		const rows = await fixture.deliveries();
		expect(rows.length).toBe(2);
		expect(
			rows.every(
				(row) =>
					row.state === "ready" && row.attemptOrdinal === 0 && row.userId === fixture.native.userId,
			),
		).toBe(true);
		const titles = await Promise.all(
			rows.map(async (row) => (await readWork(fixture, row.eventId)).payload.title),
		);
		expect(titles.sort()).toEqual(["Synthetic incoming 1", "Synthetic incoming 2"]);
		expect(await fixture.history()).toEqual([]);
		expect(fixture.payloads).toEqual([]);
	});

	it.each(["ordinary", "skip-rules", "claimed-digest"] as const)(
		"rejects late %s admission before native dependency work",
		async (kind) => {
			const sibling = deferred();
			const fixture = await boot({ beforeClose: sibling.promise });
			const before = { ...fixture.counts };
			const close = fixture.close();
			await fixture.preClosed;
			expect(
				(
					await fixture.notify(
						kind === "claimed-digest" ? { metadata: { aggregated: true } } : undefined,
						kind !== "ordinary",
					)
				).status,
			).toBe("rejected");
			expect(fixture.counts).toEqual(before);
			sibling.resolve();
			await close;
			expect((await fixture.notify()).status).toBe("rejected");
			expect(fixture.counts).toEqual(before);
			fixture.assertClosed();
			await outcome(fixture, null, []);
			expect(fixture.payloads).toEqual([]);
		},
	);

	it.each(["log", "channel"] as const)(
		"joins held %s finalization and rolls back both native outcome writes",
		async (phase) => {
			const gate = deferred(),
				entered = deferred();
			const fixture = await boot({
				holds: [{ phase, gate: gate.promise, entered: entered.resolve, reject: true }],
			});
			const notification = fixture.notify();
			await entered.promise;
			const close = fixture.close();
			await fixture.preClosed;
			expect(fixture.state.physicalClientClosed).toBe(false);
			gate.resolve();
			expect((await notification).status).toBe("fulfilled");
			await close;
			fixture.assertClosed();
			const rows = await outcome(fixture, "submitting", []);
			expect(rows[0]!.attemptToken).not.toBeNull();
			expect(fixture.payloads).toEqual([
				{ ...fixture.native.payload, title: "Synthetic incoming 1" },
			]);
		},
	);

	it("joins real startup recovery of elapsed deferred work within its recorded recipient scope", async () => {
		const gate = deferred(),
			entered = deferred();
		const fixture = await boot({
			awaitStartup: false,
			holds: [{ phase: "send", gate: gate.promise, entered: entered.resolve }],
			async prepare(native) {
				await native.createOwner();
				await native.repository().admit({
					...native.input(),
					policy: { stage: "deferred", dueAt: new Date(Date.now() - 1000) },
				});
			},
		});
		await entered.promise;
		const close = fixture.close();
		await fixture.preClosed;
		expect(fixture.state.physicalClientClosed).toBe(false);
		gate.resolve();
		expect((await close).status).toBe("fulfilled");
		fixture.assertClosed();
		await outcome(fixture, "sent", ["sent"]);
		expect(fixture.payloads).toEqual([fixture.native.payload]);
		expect(
			await fixture.native.run(() =>
				fixture.native.prisma.notificationOutboxDelivery.count({
					where: { userId: { not: fixture.native.userId } },
				}),
			),
		).toBe(0);
	});

	it("ignores a captured retired worker wakeup during and after native close", async () => {
		const sibling = deferred();
		const timeout = vi.spyOn(globalThis, "setTimeout");
		const fixture = await boot({
			beforeClose: sibling.promise,
			async prepare(native) {
				await native.repository().admit({
					...native.input(),
					policy: { stage: "deferred", dueAt: new Date("2099-01-01T00:00:00.000Z") },
				});
			},
		});
		const wakeups = timeout.mock.calls.filter(([, delay]) => delay === 60_000);
		expect(wakeups.length).toBe(1);
		const callback = wakeups[0]![0];
		if (typeof callback !== "function") throw new Error("Actual worker wakeup missing");
		const before = { ...fixture.counts };
		const close = fixture.close();
		await fixture.preClosed;
		callback();
		await fixture.app.notificationService.drain();
		expect(fixture.counts).toEqual(before);
		sibling.resolve();
		await close;
		callback();
		await fixture.app.notificationService.drain();
		expect(fixture.counts).toEqual(before);
		fixture.assertClosed();
		const rows = await outcome(fixture, "waiting", []);
		expect(rows[0]!.nextAttemptAt.toISOString()).toBe("2099-01-01T00:00:00.000Z");
		expect(fixture.payloads).toEqual([]);
	});

	it("conserves future deferred deadlines and attempts without shutdown delivery", async () => {
		const fixture = await boot({
			async prepare(native) {
				await native.repository().admit({
					...native.input(),
					policy: { stage: "deferred", dueAt: new Date("2099-01-01T00:00:00.000Z") },
				});
			},
		});
		await fixture.close();
		fixture.assertClosed();
		const rows = await outcome(fixture, "waiting", []);
		expect(rows[0]!.nextAttemptAt.toISOString()).toBe("2099-01-01T00:00:00.000Z");
		expect(rows[0]!.attemptToken).toBeNull();
		expect(fixture.payloads).toEqual([]);
	});

	it("rejects cleanup maintenance before dependency work without leaking admission", async () => {
		const fixture = await boot();
		const before = { ...fixture.counts };
		await withCleanupMaintenanceGuard(async () => {
			expect((await fixture.notify()).status).toBe("rejected");
		});
		expect(fixture.counts).toEqual(before);
		await fixture.close();
		fixture.assertClosed();
		await outcome(fixture, null, []);
		expect(fixture.payloads).toEqual([]);
	});
});
