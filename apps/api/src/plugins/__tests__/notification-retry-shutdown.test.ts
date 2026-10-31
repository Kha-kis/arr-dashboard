import { afterEach, describe, expect, it, vi } from "vitest";
import { withCleanupMaintenanceGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { NotificationDispatcher } from "../../lib/notifications/notification-dispatcher.js";
import { bootNotificationNativeApp } from "./fixtures/notification-native-app.js";

type Fixture = Awaited<ReturnType<typeof bootNotificationNativeApp>>;
type Phase = "resolution" | "send" | "log" | "channel";
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
function track<T>(promise: Promise<T>) {
	const observed = promise.then(
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
		timing?: "elapsed" | "future" | "soon";
		ordinal?: number;
		items?: number;
		seed?: boolean;
		hold?: { phase: Phase; gate: Promise<void>; entered: () => void; reject?: boolean };
		result?: "success" | "retryable" | "permanent" | "throw";
		recipient?: "revoked" | "failure";
		replaceConfig?: boolean;
		beforeClose?: Promise<void>;
	} = {},
) {
	const timing = options.timing ?? "elapsed";
	const counts = { transactions: 0, resolution: 0, send: 0, log: 0, channel: 0, initialSends: 0 };
	const initial: {
		eventId: string;
		deliveryId: string;
		dueAt: Date;
		ordinal: number;
		acceptedAt: Date;
	}[] = [];
	let initialStatus: { lastSentAt: Date | null; lastSendResult: string | null } = {
		lastSentAt: null,
		lastSendResult: null,
	};
	let order: string[] = [];
	let nativeObserver: Fixture["native"] | undefined;
	let active = 0;
	const wakeups: Array<() => void> = [];
	const nativeTimeout = globalThis.setTimeout;
	vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
		const timer = nativeTimeout(callback, delay, ...args);
		// Correlate the actual scheduling call site; the native deadline/outcome is asserted below.
		if (new Error().stack?.includes("/outbox-worker.ts:")) wakeups.push(() => callback(...args));
		return timer;
	});
	async function pause(phase: Phase) {
		counts[phase]++;
		active++;
		order.push(`${phase}-enter`);
		try {
			if (options.hold?.phase === phase) {
				options.hold.entered();
				await options.hold.gate;
				if (options.hold.reject) throw new Error("Synthetic retry dependency failure");
			}
		} finally {
			active--;
			order.push(`${phase}-settled`);
		}
	}
	const fixture = await bootNotificationNativeApp({
		beforeClose: options.beforeClose,
		awaitStartup: !options.hold && timing !== "soon",
		async prepare(native) {
			const setupDispatcher = new NotificationDispatcher();
			setupDispatcher.registerSender("DISCORD", {
				async send(config, payload) {
					expect(config.webhookUrl).toBe("https://example.invalid/synthetic-worker");
					const marker = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
						where: {
							userId: native.userId,
							channelId: native.channelId,
							state: "submitting",
						},
					});
					expect(marker.attemptToken).not.toBeNull();
					expect(payload.title).toMatch(/^Synthetic retry [12]$/);
					counts.initialSends++;
					return {
						success: false,
						retryable: true,
						failureCategory: "provider-unavailable",
						retryAfterMs: timing === "future" ? 60_000 : timing === "soon" ? 3000 : 1000,
					};
				},
				async test() {
					throw new Error("Synthetic setup refuses channel testing");
				},
			});
			const admittedAt = new Date(Date.now() - (timing === "elapsed" ? 300_000 : 0));
			if (options.seed !== false) {
				for (let item = 1; item <= (options.items ?? 1); item++) {
					native.now = admittedAt;
					const repository = native.repository();
					const admitted = await repository.admit({
						...native.input(),
						payload: { ...native.payload, title: `Synthetic retry ${item}` },
					});
					const delivery = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
						where: { userId: native.userId, eventId: admitted.eventId },
					});
					for (let attempt = 0; attempt < (options.ordinal ?? 1); attempt++) {
						const grant = await repository.beginAttempt(delivery.id);
						if (!grant) throw new Error("Actual setup attempt grant missing");
						const result = await setupDispatcher.send(
							"DISCORD",
							grant.recipient.config,
							grant.payload,
						);
						expect(await repository.finishAttempt(grant, result)).toBe(true);
						const row = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
							where: { id: delivery.id, userId: native.userId },
						});
						if (attempt + 1 < (options.ordinal ?? 1)) native.now = row.nextAttemptAt;
					}
					const row = await native.prisma.notificationOutboxDelivery.findFirstOrThrow({
						where: { id: delivery.id, userId: native.userId },
					});
					initial.push({
						eventId: admitted.eventId,
						deliveryId: row.id,
						dueAt: row.nextAttemptAt,
						ordinal: row.attemptOrdinal,
						acceptedAt: admittedAt,
					});
				}
			}
			if (options.replaceConfig) {
				const encrypted = native.encryptor.encrypt(
					JSON.stringify({ webhookUrl: "https://example.invalid/synthetic-worker" }),
				);
				await native.prisma.notificationChannel.update({
					where: { id: native.channelId, userId: native.userId },
					data: {
						encryptedConfig: encrypted.value,
						configIv: encrypted.iv,
						lastSentAt: null,
						lastSendResult: null,
					},
				});
			}
			if (options.recipient === "revoked")
				expect(
					(
						await native.prisma.notificationSubscription.deleteMany({
							where: { channelId: native.channelId, eventType: "HUNT_COMPLETED" },
						})
					).count,
				).toBe(1);
			const channel = await native.prisma.notificationChannel.findFirstOrThrow({
				where: { id: native.channelId, userId: native.userId },
			});
			initialStatus = { lastSentAt: channel.lastSentAt, lastSendResult: channel.lastSendResult };
		},
		instrument(prisma, native, recordedOrder) {
			nativeObserver = native;
			order = recordedOrder;
			const transaction = prisma.$transaction.bind(prisma);
			vi.spyOn(prisma, "$transaction").mockImplementation(async (operation) => {
				counts.transactions++;
				return transaction(async (tx) => {
					const channel = tx.notificationChannel.findFirst.bind(tx.notificationChannel);
					const reads: { findFirst: AwaitOnly<typeof tx.notificationChannel.findFirst> } =
						tx.notificationChannel;
					vi.spyOn(reads, "findFirst").mockImplementation(async (args) => {
						const row = await channel(args);
						if (!args?.select && args?.where?.enabled === true) {
							expect(args.where?.id).toBe(native.channelId);
							expect(args.where?.userId).toBe(native.userId);
							await pause("resolution");
							if (options.recipient === "failure")
								throw new Error("Synthetic current recipient lookup failure");
						}
						return row;
					});
					const log = tx.notificationLog.create.bind(tx.notificationLog);
					const historyWrites: { create: AwaitOnly<typeof tx.notificationLog.create> } =
						tx.notificationLog;
					vi.spyOn(historyWrites, "create").mockImplementation(async (args) => {
						expect(args.data.channelId).toBe(native.channelId);
						const row = await log(args);
						await pause("log");
						return row;
					});
					const status = tx.notificationChannel.updateMany.bind(tx.notificationChannel);
					const statusWrites: { updateMany: AwaitOnly<typeof tx.notificationChannel.updateMany> } =
						tx.notificationChannel;
					vi.spyOn(statusWrites, "updateMany").mockImplementation(async (args) => {
						const row = await status(args);
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
		async transport(payload) {
			const row = await fixtureNativeMarker(payload.title);
			expect(row.state).toBe("submitting");
			expect(row.attemptToken).not.toBeNull();
			expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
			await pause("send");
			if (options.result === "throw")
				throw new Error("Synthetic issued retry has unknown acceptance");
			return options.result === "retryable"
				? {
						success: false,
						retryable: true,
						failureCategory: "provider-unavailable",
						retryAfterMs: 60_000,
					}
				: options.result === "permanent"
					? { success: false, retryable: false, failureCategory: "provider-unavailable" }
					: { success: true, retryable: false };
		},
	});
	// Startup may issue before boot returns. The marker reader is bound during instrumentation.
	async function fixtureNativeMarker(title: string) {
		const observer = nativeObserver;
		if (!observer) throw new Error("Actual native observer was not initialized");
		return observer.run(async () => {
			const rows = await observer.prisma.notificationOutboxDelivery.findMany({
				where: { userId: observer.userId, channelId: observer.channelId, state: "submitting" },
			});
			for (const row of rows) {
				const event = await observer.repository().readEvent(row.eventId);
				if (event?.payload.title === title) return row;
			}
			throw new Error("Expected committed synthetic native attempt marker missing");
		});
	}
	fixtures.push(fixture);
	return {
		...fixture,
		counts,
		initial,
		initialStatus,
		wakeups,
		close: () => track(fixture.app.close()),
		admit: () =>
			track(fixture.notify({ ...fixture.native.payload, title: "Synthetic retry live" })),
		assertClosed() {
			expect(active).toBe(0);
			expect(fixture.state.physicalClientClosed).toBe(true);
			expect(fixture.state.databaseCloseCount).toBe(1);
			expect(fixture.state.pendingAtDatabaseClose).toBe(0);
			const end = order.indexOf("database-close-start");
			for (const [index, event] of order.entries())
				if (event.endsWith("-enter") || event.endsWith("-settled")) expect(index).toBeLessThan(end);
		},
		graph: () =>
			fixture.native.run(async () => ({
				deliveries: await fixture.native.prisma.notificationOutboxDelivery.findMany({
					where: { userId: fixture.native.userId, channelId: fixture.native.channelId },
					orderBy: { id: "asc" },
				}),
				events: await fixture.native.prisma.notificationOutboxEvent.findMany({
					where: { userId: fixture.native.userId },
					orderBy: { id: "asc" },
				}),
				history: await fixture.native.prisma.notificationLog.findMany({
					where: { channelId: fixture.native.channelId },
					orderBy: { retryCount: "asc" },
				}),
				channel: await fixture.native.prisma.notificationChannel.findFirstOrThrow({
					where: { id: fixture.native.channelId, userId: fixture.native.userId },
				}),
			})),
	};
}

type RetryFixture = Awaited<ReturnType<typeof boot>>;
async function assertOutcome(
	fixture: RetryFixture,
	state: string,
	ordinal: number,
	history: Array<[string, number]>,
) {
	const graph = await fixture.graph();
	expect(graph.deliveries.length).toBe(1);
	const row = graph.deliveries[0]!;
	expect(row.state).toBe(state);
	expect(row.attemptOrdinal).toBe(ordinal);
	expect(row.userId).toBe(fixture.native.userId);
	expect(row.channelId).toBe(fixture.native.channelId);
	expect(graph.history.map((log) => [log.status, log.retryCount])).toEqual(history);
	if (state === "sent" || state === "rejected")
		expect(graph.channel.lastSendResult).toBe(state === "sent" ? "success" : "failed");
	else {
		expect(graph.channel.lastSendResult).toBe(fixture.initialStatus.lastSendResult);
		expect(graph.channel.lastSentAt).toEqual(fixture.initialStatus.lastSentAt);
	}
	return row;
}

describe("actual native retry shutdown", () => {
	it("conserves a future retry without claiming replacement settings were attempted", async () => {
		const fixture = await boot({ timing: "future", replaceConfig: true });
		await fixture.close();
		fixture.assertClosed();
		const row = await assertOutcome(fixture, "retry-waiting", 1, [["failed", 0]]);
		expect(row.nextAttemptAt).toEqual(fixture.initial[0]!.dueAt);
		expect(fixture.payloads).toEqual([]);
		expect(fixture.counts.initialSends).toBe(1);
	});

	it.each([
		{ phase: "resolution", reject: false },
		{ phase: "resolution", reject: true },
		{ phase: "send", reject: false },
		{ phase: "send", reject: true },
		{ phase: "log", reject: false },
		{ phase: "log", reject: true },
		{ phase: "channel", reject: false },
		{ phase: "channel", reject: true },
	] as const)(
		"joins active $phase before physical closure (reject=$reject)",
		async ({ phase, reject }) => {
			const gate = deferred(),
				entered = deferred();
			const fixture = await boot({
				hold: { phase, gate: gate.promise, entered: entered.resolve, reject },
			});
			await entered.promise;
			const close = fixture.close();
			await fixture.preClosed;
			expect(fixture.state.physicalClientClosed).toBe(false);
			gate.resolve();
			expect((await close).status).toBe("fulfilled");
			fixture.assertClosed();
			const state = !reject
				? "sent"
				: phase === "resolution"
					? "retry-waiting"
					: phase === "send"
						? "uncertain"
						: "submitting";
			const row = await assertOutcome(
				fixture,
				state,
				1,
				!reject
					? [
							["failed", 0],
							["sent", 1],
						]
					: [["failed", 0]],
			);
			expect(fixture.payloads.length).toBe(phase === "resolution" && reject ? 0 : 1);
			if (phase === "resolution" && reject)
				expect(row.nextAttemptAt).toEqual(fixture.initial[0]!.dueAt);
		},
	);

	it.each(["retryable", "permanent", "throw"] as const)(
		"settles an active %s outcome without inventing shutdown abandonment",
		async (result) => {
			const gate = deferred(),
				entered = deferred();
			const fixture = await boot({
				result,
				hold: { phase: "send", gate: gate.promise, entered: entered.resolve },
			});
			await entered.promise;
			const close = fixture.close();
			await fixture.preClosed;
			const before = Date.now();
			gate.resolve();
			await close;
			const after = Date.now();
			fixture.assertClosed();
			const row = await assertOutcome(
				fixture,
				result === "retryable"
					? "retry-waiting"
					: result === "permanent"
						? "rejected"
						: "uncertain",
				result === "retryable" ? 2 : 1,
				result === "permanent"
					? [
							["failed", 0],
							["dead_letter", 1],
						]
					: [["failed", 0]],
			);
			if (result === "retryable") {
				expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
				expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(after + 60_000);
				expect(row.attemptToken).toBeNull();
			}
			expect(fixture.payloads.length).toBe(1);
		},
	);

	it.each(["revoked", "failure"] as const)(
		"refuses current %s recipient without another provider attempt",
		async (recipient) => {
			const fixture = await boot({ recipient });
			await fixture.close();
			fixture.assertClosed();
			const row = await assertOutcome(
				fixture,
				recipient === "revoked" ? "canceled" : "retry-waiting",
				1,
				[["failed", 0]],
			);
			expect(row.nextAttemptAt).toEqual(fixture.initial[0]!.dueAt);
			expect(row.attemptToken).toBeNull();
			if (recipient === "revoked") expect(row.outcomeCategory).toBe("recipient-unavailable");
			expect(fixture.payloads).toEqual([]);
		},
	);

	it("joins maximum-ordinal dead-letter logging through actual settlement", async () => {
		const gate = deferred(),
			entered = deferred();
		const fixture = await boot({
			ordinal: 3,
			result: "retryable",
			hold: { phase: "log", gate: gate.promise, entered: entered.resolve },
		});
		await entered.promise;
		const close = fixture.close();
		await fixture.preClosed;
		expect(fixture.state.physicalClientClosed).toBe(false);
		gate.resolve();
		await close;
		fixture.assertClosed();
		await assertOutcome(fixture, "rejected", 3, [
			["failed", 0],
			["dead_letter", 3],
		]);
		expect(fixture.counts.initialSends).toBe(3);
		expect(fixture.payloads.length).toBe(1);
	});

	it("rolls back both completion writes when held channel status fails", async () => {
		const gate = deferred(),
			entered = deferred();
		const fixture = await boot({
			hold: { phase: "channel", gate: gate.promise, entered: entered.resolve, reject: true },
		});
		await entered.promise;
		const close = fixture.close();
		await fixture.preClosed;
		gate.resolve();
		await close;
		fixture.assertClosed();
		await assertOutcome(fixture, "submitting", 1, [["failed", 0]]);
		expect(fixture.payloads.length).toBe(1);
	});

	it("joins a successful issued retry once across duplicate close and shutdown", async () => {
		const gate = deferred(),
			entered = deferred();
		const fixture = await boot({
			hold: { phase: "send", gate: gate.promise, entered: entered.resolve },
		});
		await entered.promise;
		const close = fixture.close(),
			duplicate = fixture.close(),
			shutdown = track(fixture.app.notificationService.shutdown());
		await fixture.preClosed;
		gate.resolve();
		await Promise.all([close, duplicate, shutdown]);
		fixture.assertClosed();
		await assertOutcome(fixture, "sent", 1, [
			["failed", 0],
			["sent", 1],
		]);
		expect(fixture.payloads.length).toBe(1);
	});

	it("refuses a retired real retry wakeup during sibling close and after teardown", async () => {
		const sibling = deferred();
		const fixture = await boot({ timing: "future", beforeClose: sibling.promise });
		const before = await fixture.graph(),
			counts = { ...fixture.counts };
		const callback = fixture.wakeups[0];
		if (!callback) throw new Error("Actual retry wakeup missing");
		const close = fixture.close();
		await fixture.preClosed;
		callback();
		await fixture.app.notificationService.drain();
		expect(fixture.counts).toEqual(counts);
		sibling.resolve();
		await close;
		callback();
		await fixture.app.notificationService.drain();
		expect(fixture.counts).toEqual(counts);
		fixture.assertClosed();
		expect(await fixture.graph()).toEqual(before);
		expect(fixture.payloads).toEqual([]);
	});

	it.each(["resolution", "log"] as const)(
		"shares an already-running drain through held %s",
		async (phase) => {
			const gate = deferred(),
				entered = deferred();
			const fixture = await boot({ hold: { phase, gate: gate.promise, entered: entered.resolve } });
			await entered.promise;
			const drain = track(fixture.app.notificationService.drain()),
				duplicateDrain = track(fixture.app.notificationService.drain()),
				close = fixture.close();
			await fixture.preClosed;
			expect(fixture.state.physicalClientClosed).toBe(false);
			gate.resolve();
			await Promise.all([drain, duplicateDrain, close]);
			fixture.assertClosed();
			await assertOutcome(fixture, "sent", 1, [
				["failed", 0],
				["sent", 1],
			]);
			expect(fixture.payloads.length).toBe(1);
		},
	);

	it("coalesces duplicate wakeups during a naturally scheduled issued retry", async () => {
		const gate = deferred(),
			entered = deferred();
		const fixture = await boot({
			timing: "soon",
			hold: { phase: "send", gate: gate.promise, entered: entered.resolve },
		});
		await fixture.app.notificationService.drain();
		const callback = fixture.wakeups[0];
		if (!callback) throw new Error("Actual short retry timer missing");
		await entered.promise;
		callback();
		callback();
		expect(fixture.payloads.length).toBe(1);
		gate.resolve();
		await fixture.app.notificationService.drain();
		await fixture.close();
		fixture.assertClosed();
		await assertOutcome(fixture, "sent", 1, [
			["failed", 0],
			["sent", 1],
		]);
		expect(fixture.payloads.length).toBe(1);
	}, 15_000);

	it("does not consume a persisted successor retry before its deadline through a stale wakeup", async () => {
		const fixture = await boot({ result: "retryable" });
		const before = await fixture.graph();
		const callback = fixture.wakeups[0];
		if (!callback) throw new Error("Actual successor retry wakeup missing");
		callback();
		await fixture.app.notificationService.drain();
		expect(await fixture.graph()).toEqual(before);
		await fixture.close();
		fixture.assertClosed();
		await assertOutcome(fixture, "retry-waiting", 2, [["failed", 0]]);
		expect(fixture.payloads.length).toBe(1);
	});

	it("persists a first-attempt retry produced during close without another send", async () => {
		const gate = deferred(),
			entered = deferred();
		const fixture = await boot({
			seed: false,
			result: "retryable",
			hold: { phase: "send", gate: gate.promise, entered: entered.resolve },
		});
		const notification = fixture.admit();
		await entered.promise;
		const close = fixture.close();
		await fixture.preClosed;
		const before = Date.now();
		gate.resolve();
		expect((await notification).status).toBe("fulfilled");
		await close;
		fixture.assertClosed();
		const graph = await fixture.graph(),
			row = graph.deliveries[0]!;
		expect(row.state).toBe("retry-waiting");
		expect(row.attemptOrdinal).toBe(1);
		expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
		expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
		expect(graph.history.map((log) => [log.status, log.retryCount])).toEqual([["failed", 0]]);
		expect(fixture.payloads.length).toBe(1);
	});

	it("retains distinct same-time future retries with equal deadlines", async () => {
		const fixture = await boot({ timing: "future", items: 2 });
		const before = await fixture.graph();
		expect(before.events.length).toBe(2);
		expect(before.events[0]!.acceptedAt).toEqual(before.events[1]!.acceptedAt);
		expect(before.deliveries.map((row) => row.state)).toEqual(["retry-waiting", "retry-waiting"]);
		expect(before.deliveries[0]!.nextAttemptAt).toEqual(before.deliveries[1]!.nextAttemptAt);
		await fixture.close();
		fixture.assertClosed();
		expect(await fixture.graph()).toEqual(before);
		expect(fixture.payloads).toEqual([]);
	});

	it("joins the issued same-channel retry and conserves its unissued sibling", async () => {
		const gate = deferred(),
			entered = deferred();
		const fixture = await boot({
			items: 2,
			hold: { phase: "send", gate: gate.promise, entered: entered.resolve },
		});
		await entered.promise;
		const close = fixture.close();
		await fixture.preClosed;
		gate.resolve();
		await close;
		fixture.assertClosed();
		const graph = await fixture.graph();
		expect(graph.deliveries.map((row) => row.state).sort()).toEqual(["retry-waiting", "sent"]);
		expect(graph.deliveries.every((row) => row.attemptOrdinal === 1)).toBe(true);
		expect(graph.history.map((log) => log.status).sort()).toEqual(["failed", "failed", "sent"]);
		const titles = await fixture.native.run(async () => {
			const payloads = await Promise.all(
				graph.events.map(async (event) => {
					const work = await fixture.native.repository().readEvent(event.id);
					if (!work) throw new Error("Conserved native event could not be read");
					return work.payload.title;
				}),
			);
			return payloads.sort();
		});
		expect(titles).toEqual(["Synthetic retry 1", "Synthetic retry 2"]);
		expect(fixture.payloads.length).toBe(1);
	});

	it("rejects late real admission without a hidden retry or database operation", async () => {
		const fixture = await boot({ timing: "future" });
		const before = await fixture.graph(),
			counts = { ...fixture.counts };
		await fixture.close();
		expect((await fixture.admit()).status).toBe("rejected");
		expect(fixture.counts).toEqual(counts);
		fixture.assertClosed();
		expect(await fixture.graph()).toEqual(before);
		expect(fixture.payloads).toEqual([]);
	});

	it("preserves future retry state while database maintenance prevents dispatch", async () => {
		const fixture = await boot({ timing: "future" });
		const before = await fixture.graph(),
			counts = { ...fixture.counts };
		const callback = fixture.wakeups[0];
		if (!callback) throw new Error("Actual retry wakeup missing");
		await withCleanupMaintenanceGuard(async () => {
			callback();
			expect((await fixture.admit()).status).toBe("rejected");
			await fixture.app.notificationService.drain();
			await fixture.close();
		});
		fixture.assertClosed();
		expect(fixture.counts).toEqual(counts);
		expect(await fixture.graph()).toEqual(before);
		expect(fixture.payloads).toEqual([]);
	});
});
