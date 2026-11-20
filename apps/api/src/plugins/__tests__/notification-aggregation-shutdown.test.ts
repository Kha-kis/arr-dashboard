import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotificationOutboxRepository } from "../../lib/notifications/outbox-repository.js";
import type { SendResult } from "../../lib/notifications/types.js";
import { bootNotificationNativeApp } from "./fixtures/notification-native-app.js";

type Fixture = Awaited<ReturnType<typeof bootNotificationNativeApp>>;
type Phase = "resolution" | "claim" | "send" | "log";
type AwaitOnly<T> = T extends (...args: infer Args) => unknown
	? (...args: Args) => PromiseLike<unknown>
	: never;
type Owner = { userId: string; channelId: string };
const fixtures: Fixture[] = [];
const releases: Array<() => void> = [];
const pending: Promise<unknown>[] = [];
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
	pending.push(observed);
	return observed;
}
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(pending.splice(0));
	for (const fixture of fixtures.splice(0)) await fixture.dispose();
	vi.restoreAllMocks();
});

async function boot(
	options: {
		mode?: "elapsed" | "threshold" | "future";
		hold?: { phase: Phase; gate: Promise<void>; entered: () => void; reject?: boolean };
		result?: SendResult;
		twoOwners?: boolean;
		ownerGates?: ReturnType<typeof deferred>[];
		ownerEntered?: ReturnType<typeof deferred>[];
		ownerFinished?: ReturnType<typeof deferred>[];
		beforeClose?: Promise<void>;
		disabled?: boolean;
	} = {},
) {
	const mode = options.mode ?? "elapsed";
	const owners: Owner[] = [];
	const counts = { transactions: 0, resolution: 0, claim: 0, send: 0, log: 0 };
	const memberIds = new Map<string, string[]>();
	let order: string[] = [];
	let active = 0;
	async function pause(phase: Phase) {
		counts[phase]++;
		active++;
		order.push(`${phase}-enter`);
		try {
			if (options.hold?.phase === phase) {
				options.hold.entered();
				await options.hold.gate;
				if (options.hold.reject) throw new Error("Synthetic aggregation dependency failure");
			}
		} finally {
			active--;
			order.push(`${phase}-settled`);
		}
	}
	const fixture = await bootNotificationNativeApp({
		beforeClose: options.beforeClose,
		awaitStartup: !options.hold && !options.twoOwners,
		async prepare(native) {
			owners.push({ userId: native.userId, channelId: native.channelId });
			if (options.twoOwners) owners.push(await native.createOwner());
			native.now = new Date(Date.now() - (mode === "elapsed" ? 90_000 : 0));
			for (const [index, owner] of owners.entries()) {
				await native.prisma.notificationAggregationConfig.create({
					data: {
						userId: owner.userId,
						eventType: "HUNT_COMPLETED",
						enabled: true,
						windowSeconds: mode === "future" ? 3600 : 60,
						maxBatchSize: mode === "future" ? 10 : 2,
					},
				});
				if (mode !== "threshold") {
					const repository = createNotificationOutboxRepository(
						native.prisma,
						native.runtime,
						native.encryptor,
						owner.userId,
						{ clock: native.clock },
					);
					const ids: string[] = [];
					for (let item = 1; item <= 2; item++) {
						const admitted = await repository.admit({
							payload: {
								...native.payload,
								title: `Synthetic aggregate ${index}-${item}`,
								metadata: { ownerIndex: index },
							},
							recipients: [
								{
									channelId: owner.channelId,
									channelType: "DISCORD",
									subscriptionEventType: "HUNT_COMPLETED",
								},
							],
							policy: {
								stage: "aggregating",
								windowSeconds: mode === "future" ? 3600 : 60,
								maxBatchSize: mode === "future" ? 10 : 2,
							},
						});
						ids.push(admitted.eventId);
					}
					memberIds.set(owner.userId, ids);
				}
				if (options.disabled)
					await native.prisma.notificationChannel.update({
						where: { id: owner.channelId, userId: owner.userId },
						data: { enabled: false },
					});
			}
		},
		instrument(prisma, _native, recordedOrder) {
			order = recordedOrder;
			const transaction = prisma.$transaction.bind(prisma);
			vi.spyOn(prisma, "$transaction").mockImplementation(async (operation) => {
				counts.transactions++;
				let finishedOwner = -1;
				const result = await transaction(async (tx) => {
					const channel = tx.notificationChannel.findFirst.bind(tx.notificationChannel);
					const reads: { findFirst: AwaitOnly<typeof tx.notificationChannel.findFirst> } =
						tx.notificationChannel;
					vi.spyOn(reads, "findFirst").mockImplementation(async (args) => {
						const value = await channel(args);
						// Admission selects only id. Actual attempt resolution requires the full channel.
						if (!args?.select && args?.where?.enabled === true) {
							expect(
								owners.some(
									(owner) =>
										owner.userId === args.where?.userId && owner.channelId === args.where?.id,
								),
							).toBe(true);
							await pause("resolution");
						}
						return value;
					});
					const updateDelivery = tx.notificationOutboxDelivery.updateMany.bind(
						tx.notificationOutboxDelivery,
					);
					const deliveries: {
						updateMany: AwaitOnly<typeof tx.notificationOutboxDelivery.updateMany>;
					} = tx.notificationOutboxDelivery;
					vi.spyOn(deliveries, "updateMany").mockImplementation(async (args) => {
						const value = await updateDelivery(args);
						if (args?.data.state === "submitting") await pause("claim");
						return value;
					});
					const log = tx.notificationLog.create.bind(tx.notificationLog);
					const logs: { create: AwaitOnly<typeof tx.notificationLog.create> } = tx.notificationLog;
					vi.spyOn(logs, "create").mockImplementation(async (args) => {
						const value = await log(args);
						await pause("log");
						return value;
					});
					const status = tx.notificationChannel.updateMany.bind(tx.notificationChannel);
					const statuses: { updateMany: AwaitOnly<typeof tx.notificationChannel.updateMany> } =
						tx.notificationChannel;
					vi.spyOn(statuses, "updateMany").mockImplementation(async (args) => {
						const value = await status(args);
						if (args?.data.lastSendResult !== undefined)
							finishedOwner = owners.findIndex(
								(owner) =>
									owner.userId === args.where?.userId && owner.channelId === args.where?.id,
							);
						return value;
					});
					return operation(tx);
				});
				if (finishedOwner >= 0) options.ownerFinished?.[finishedOwner]?.resolve();
				return result;
			});
		},
		async transport(payload) {
			expect(payload.metadata?.aggregated).toBe(true);
			expect(payload.metadata?.count).toBe(2);
			const items = payload.metadata?.items;
			if (!Array.isArray(items) || items.length !== 2)
				throw new Error("Expected two synthetic digest members");
			// Owner-specific original titles are visible only in this synthetic payload.
			const index = owners.findIndex((_, ownerIndex) =>
				items.every(
					(item) =>
						typeof item === "object" &&
						item !== null &&
						"title" in item &&
						typeof item.title === "string" &&
						item.title.startsWith(`Synthetic aggregate ${ownerIndex}-`),
				),
			);
			if (index < 0) throw new Error("Synthetic digest mixed owners");
			if (options.ownerGates) {
				options.ownerEntered?.[index]?.resolve();
				await options.ownerGates[index]!.promise;
			}
			await pause("send");
			return options.result ?? { success: true, retryable: false };
		},
	});
	fixtures.push(fixture);
	let item = 0;
	return {
		...fixture,
		owners,
		counts,
		memberIds,
		admit: () =>
			track(
				fixture.notify({
					...fixture.native.payload,
					title: `Synthetic aggregate 0-${++item}`,
					metadata: { ownerIndex: 0 },
				}),
			),
		close: () => track(fixture.app.close()),
		assertClosed() {
			expect(active).toBe(0);
			expect(fixture.state.physicalClientClosed).toBe(true);
			expect(fixture.state.databaseCloseCount).toBe(1);
			expect(fixture.state.pendingAtDatabaseClose).toBe(0);
			const end = order.indexOf("database-close-start");
			for (const [index, event] of order.entries())
				if (event.endsWith("-enter") || event.endsWith("-settled")) expect(index).toBeLessThan(end);
		},
		async graph(owner = owners[0]!) {
			return fixture.native.run(async () => {
				const events = await fixture.native.prisma.notificationOutboxEvent.findMany({
					where: { userId: owner.userId },
					orderBy: { id: "asc" },
				});
				const deliveries = await fixture.native.prisma.notificationOutboxDelivery.findMany({
					where: { userId: owner.userId },
					orderBy: { id: "asc" },
				});
				const history = await fixture.native.prisma.notificationLog.findMany({
					where: { channelId: owner.channelId },
				});
				const channel = await fixture.native.prisma.notificationChannel.findFirstOrThrow({
					where: { id: owner.channelId, userId: owner.userId },
				});
				return { events, deliveries, history, channel };
			});
		},
	};
}

type AggregateFixture = Awaited<ReturnType<typeof boot>>;
async function assertDigest(
	fixture: AggregateFixture,
	state: string,
	history: string[],
	owner = fixture.owners[0]!,
) {
	const graph = await fixture.graph(owner);
	expect(graph.events.length).toBe(3);
	const members = graph.events.filter((event) => event.stage === "grouped");
	expect(members.length).toBe(2);
	const parentIds = [...new Set(members.map((event) => event.aggregateParentId))];
	expect(parentIds.length).toBe(1);
	expect(parentIds[0]).not.toBeNull();
	const digest = graph.events.find((event) => event.id === parentIds[0]);
	if (!digest) throw new Error("Committed native digest missing");
	expect(digest.userId).toBe(owner.userId);
	expect(digest.aggregateParentId).toBeNull();
	expect(graph.deliveries.length).toBe(3);
	const retired = graph.deliveries.filter((row) =>
		members.some((member) => member.id === row.eventId),
	);
	expect(retired.length).toBe(2);
	for (const row of retired) {
		expect(row.state).toBe("canceled");
		expect(row.outcomeCategory).toBe("aggregated");
		expect(row.attemptOrdinal).toBe(0);
		expect(row.channelId).toBe(owner.channelId);
	}
	const delivery = graph.deliveries.find((row) => row.eventId === digest.id);
	if (!delivery) throw new Error("Committed digest recipient missing");
	expect(delivery.state).toBe(state);
	expect(delivery.userId).toBe(owner.userId);
	expect(delivery.channelId).toBe(owner.channelId);
	expect(graph.history.map((row) => row.status)).toEqual(history);
	expect(graph.channel.lastSendResult).toBe(
		state === "sent"
			? "success"
			: state === "rejected" || state === "retry-waiting"
				? "failed"
				: null,
	);
	const work = await fixture.native.run(() =>
		createNotificationOutboxRepository(
			fixture.native.prisma,
			fixture.native.runtime,
			fixture.native.encryptor,
			owner.userId,
		).readEvent(digest.id),
	);
	if (!work) throw new Error("Native digest payload missing");
	expect(work.recipients).toEqual([
		{ channelId: owner.channelId, channelType: "DISCORD", subscriptionEventType: "HUNT_COMPLETED" },
	]);
	expect(work.payload.metadata?.count).toBe(2);
	return delivery;
}

describe("native aggregation shutdown", () => {
	// Real resolution and marker rollback, not obsolete memory-buffer flush origins.
	it.each([
		{ mode: "elapsed", phase: "resolution", reject: false },
		{ mode: "elapsed", phase: "resolution", reject: true },
		{ mode: "elapsed", phase: "claim", reject: false },
		{ mode: "elapsed", phase: "claim", reject: true },
		{ mode: "threshold", phase: "resolution", reject: false },
		{ mode: "threshold", phase: "resolution", reject: true },
		{ mode: "threshold", phase: "claim", reject: false },
		{ mode: "threshold", phase: "claim", reject: true },
	] as const)(
		"joins $mode $phase through physical close (reject=$reject)",
		async ({ mode, phase, reject }) => {
			const gate = deferred(),
				entered = deferred();
			const fixture = await boot({
				mode,
				hold: { phase, gate: gate.promise, entered: entered.resolve, reject },
			});
			let notification: ReturnType<AggregateFixture["admit"]> | undefined;
			if (mode === "threshold") {
				expect((await fixture.admit()).status).toBe("fulfilled");
				notification = fixture.admit();
			}
			await entered.promise;
			const close = fixture.close();
			await fixture.preClosed;
			expect(fixture.state.physicalClientClosed).toBe(false);
			gate.resolve();
			if (notification) expect((await notification).status).toBe("fulfilled");
			expect((await close).status).toBe("fulfilled");
			fixture.assertClosed();
			await assertDigest(fixture, reject ? "ready" : "sent", reject ? [] : ["sent"]);
			expect(fixture.payloads.length).toBe(reject ? 0 : 1);
		},
	);

	it.each([
		{ phase: "send", reject: false },
		{ phase: "send", reject: true },
		{ phase: "log", reject: false },
		{ phase: "log", reject: true },
	] as const)(
		"joins issued digest $phase with honest outcome (reject=$reject)",
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
			await close;
			fixture.assertClosed();
			await assertDigest(
				fixture,
				!reject ? "sent" : phase === "send" ? "uncertain" : "submitting",
				reject ? [] : ["sent"],
			);
			expect(fixture.payloads.length).toBe(1);
		},
	);

	it("joins each owner independently across duplicate close without mixing digest recipients", async () => {
		const gates = [deferred(), deferred()],
			entered = [deferred(), deferred()],
			finished = [deferred(), deferred()];
		const fixture = await boot({
			twoOwners: true,
			ownerGates: gates,
			ownerEntered: entered,
			ownerFinished: finished,
		});
		await Promise.all(entered.map((signal) => signal.promise));
		const close = fixture.close(),
			duplicate = fixture.close();
		await fixture.preClosed;
		gates[0]!.resolve();
		await finished[0]!.promise;
		await assertDigest(fixture, "sent", ["sent"], fixture.owners[0]);
		expect(fixture.state.physicalClientClosed).toBe(false);
		gates[1]!.resolve();
		await Promise.all([close, duplicate]);
		fixture.assertClosed();
		await assertDigest(fixture, "sent", ["sent"], fixture.owners[1]);
		expect(fixture.payloads.length).toBe(2);
	});

	it("refuses retired wakeups and late aggregation during sibling close and after teardown", async () => {
		const sibling = deferred();
		const timer = vi.spyOn(globalThis, "setTimeout");
		const fixture = await boot({ mode: "future", beforeClose: sibling.promise });
		const calls = timer.mock.calls.filter(([, delay]) => delay === 60_000);
		expect(calls.length).toBe(1);
		const callback = calls[0]![0];
		if (typeof callback !== "function") throw new Error("Actual worker wakeup missing");
		const before = await fixture.graph();
		const counts = { ...fixture.counts };
		const close = fixture.close();
		await fixture.preClosed;
		callback();
		expect((await fixture.admit()).status).toBe("rejected");
		await fixture.app.notificationService.drain();
		expect(fixture.counts).toEqual(counts);
		sibling.resolve();
		await close;
		callback();
		expect((await fixture.admit()).status).toBe("rejected");
		await fixture.app.notificationService.drain();
		expect(fixture.counts).toEqual(counts);
		fixture.assertClosed();
		expect(await fixture.graph()).toEqual(before);
		expect(fixture.payloads).toEqual([]);
	});

	it("conserves future members on close rather than forcing delivery or cancellation", async () => {
		const fixture = await boot({ mode: "future" });
		const before = await fixture.graph();
		expect(before.events.map((event) => event.stage)).toEqual(["aggregating", "aggregating"]);
		expect(before.deliveries.map((row) => row.state)).toEqual(["waiting", "waiting"]);
		await fixture.close();
		fixture.assertClosed();
		expect(await fixture.graph()).toEqual(before);
		expect(fixture.payloads).toEqual([]);
	});

	it("records only an actually attempted permanent digest rejection", async () => {
		const fixture = await boot({
			result: { success: false, retryable: false, failureCategory: "provider-unavailable" },
		});
		await fixture.close();
		fixture.assertClosed();
		const row = await assertDigest(fixture, "rejected", ["failed"]);
		expect(row.attemptOrdinal).toBe(0);
		expect(row.outcomeCategory).toBe("provider-unavailable");
		expect(fixture.payloads.length).toBe(1);
	});

	it("preserves a known digest retry deadline and remaining budget without shutdown dead-letter", async () => {
		const before = Date.now();
		const fixture = await boot({
			result: {
				success: false,
				retryable: true,
				failureCategory: "provider-unavailable",
				retryAfterMs: 60_000,
			},
		});
		const after = Date.now();
		await fixture.close();
		fixture.assertClosed();
		const row = await assertDigest(fixture, "retry-waiting", ["failed"]);
		expect(row.attemptOrdinal).toBe(1);
		expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
		expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(after + 60_000);
		expect(row.attemptToken).toBeNull();
		expect(fixture.payloads.length).toBe(1);
	});

	it("cancels a due digest with a disabled current recipient without a provider attempt", async () => {
		const fixture = await boot({ disabled: true });
		await fixture.close();
		fixture.assertClosed();
		const row = await assertDigest(fixture, "canceled", []);
		expect(row.attemptOrdinal).toBe(0);
		expect(row.outcomeCategory).toBe("recipient-unavailable");
		expect(row.attemptToken).toBeNull();
		expect(fixture.payloads).toEqual([]);
	});
});
