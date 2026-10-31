import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withCleanupMaintenanceGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { createNotificationOutboxRepository } from "../../lib/notifications/outbox-repository.js";
import { integrationHealth } from "../../lib/validation/integration-health.js";
import { bootNotificationNativeApp } from "./fixtures/notification-native-app.js";

type Fixture = Awaited<ReturnType<typeof bootNotificationNativeApp>>;
type Owner = { userId: string; channelId: string };
type AwaitOnly<T> = T extends (...args: infer Args) => unknown
	? (...args: Args) => PromiseLike<unknown>
	: never;
const fixtures: Fixture[] = [];
const releases: Array<() => void> = [];
const tasks: Promise<unknown>[] = [];
const failure = { total: 1, validated: 0, rejected: 1 };
const success = { total: 1, validated: 1, rejected: 0 };

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
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

/** Only the synchronous registry throttle clock; native grants/timestamps/timers remain real. */
function record(stats = failure, at?: number) {
	const clock = at === undefined ? undefined : vi.spyOn(Date, "now").mockReturnValue(at);
	try {
		integrationHealth.record("synthetic-source", "category", stats);
	} finally {
		clock?.mockRestore();
	}
}

beforeEach(() => integrationHealth.reset());
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(tasks.splice(0));
	for (const fixture of fixtures.splice(0)) await fixture.dispose();
	integrationHealth.reset();
	vi.restoreAllMocks();
});

async function boot(
	options: {
		rejectLookup?: boolean;
		holdLookup?: { gate: Promise<void>; entered: () => void };
	} = {},
) {
	const owners: Owner[] = [];
	const counts = { reads: 0, failedReads: 0, pendingReads: 0 };
	let observer: Fixture["native"] | undefined;
	const fixture = await bootNotificationNativeApp({
		async prepare(native) {
			owners.push({ userId: native.userId, channelId: native.channelId });
			owners.push(await native.createOwner());
			for (const owner of owners) {
				await native.prisma.notificationSubscription.create({
					data: { channelId: owner.channelId, eventType: "VALIDATION_HEALTH_DEGRADED" },
				});
			}
		},
		instrument(prisma, native, order) {
			observer = native;
			const read = prisma.notificationSubscription.findMany.bind(prisma.notificationSubscription);
			const reads: { findMany: AwaitOnly<typeof prisma.notificationSubscription.findMany> } =
				prisma.notificationSubscription;
			vi.spyOn(reads, "findMany").mockImplementation(async (args) => {
				expect(args).toEqual({
					where: { eventType: "VALIDATION_HEALTH_DEGRADED" },
					include: { channel: true },
				});
				const call = ++counts.reads;
				counts.pendingReads++;
				order.push("health-read-enter");
				try {
					const rows = await read(args);
					expect(rows.map((row) => row.channelId).sort()).toEqual(
						owners.map((owner) => owner.channelId).sort(),
					);
					if (call === 1 && options.holdLookup) {
						options.holdLookup.entered();
						await options.holdLookup.gate;
					}
					if (call === 1 && options.rejectLookup) {
						counts.failedReads++;
						throw new Error("Synthetic actual subscription read failure");
					}
					return rows;
				} finally {
					counts.pendingReads--;
					order.push("health-read-settled");
				}
			});
		},
		async transport(payload) {
			const native = observer;
			if (!native) throw new Error("Native health observer not initialized");
			expect(payload.eventType).toBe("VALIDATION_HEALTH_DEGRADED");
			await native.run(async () => {
				const markers = await native.prisma.notificationOutboxDelivery.findMany({
					where: { userId: { in: owners.map((owner) => owner.userId) }, state: "submitting" },
				});
				const matching = [];
				for (const marker of markers) {
					const owner = owners.find(
						(candidate) =>
							candidate.userId === marker.userId && candidate.channelId === marker.channelId,
					);
					if (!owner) throw new Error("Unexpected native health owner/recipient");
					const repository = createNotificationOutboxRepository(
						native.prisma,
						native.runtime,
						native.encryptor,
						owner.userId,
					);
					const event = await repository.readEvent(marker.eventId);
					if (event?.payload.title === payload.title) matching.push(marker);
				}
				expect(matching.length).toBe(1);
				expect(matching[0]!.attemptToken).not.toBeNull();
				expect(matching[0]!.attemptOrdinal).toBe(0);
			});
			return { success: true, retryable: false };
		},
	});
	fixtures.push(fixture);
	return {
		...fixture,
		owners,
		counts,
		async drain() {
			await fixture.app.notificationService.drain();
			// Settle the registry's accepted/rejected continuation after the producer's actual drain.
			await Promise.resolve();
			await Promise.resolve();
		},
		graph: () =>
			fixture.native.run(async () => ({
				events: await fixture.native.prisma.notificationOutboxEvent.findMany({
					where: { userId: { in: owners.map((owner) => owner.userId) } },
				}),
				deliveries: await fixture.native.prisma.notificationOutboxDelivery.findMany({
					where: { userId: { in: owners.map((owner) => owner.userId) } },
				}),
				history: await fixture.native.prisma.notificationLog.findMany({
					where: { channelId: { in: owners.map((owner) => owner.channelId) } },
				}),
				channels: await fixture.native.prisma.notificationChannel.findMany({
					where: { userId: { in: owners.map((owner) => owner.userId) } },
				}),
			})),
		async assertGraph(state: "sent" | "ready", failureCount: string) {
			const graph = await this.graph();
			expect(graph.events.length).toBe(2);
			expect(graph.deliveries.length).toBe(2);
			expect(graph.channels.length).toBe(2);
			expect(graph.history.length).toBe(state === "sent" ? 2 : 0);
			await fixture.native.run(async () => {
				for (const owner of owners) {
					const events = graph.events.filter((event) => event.userId === owner.userId);
					expect(events.length).toBe(1);
					const delivery = graph.deliveries.filter((row) => row.userId === owner.userId);
					expect(delivery.length).toBe(1);
					expect(delivery[0]).toMatchObject({
						eventId: events[0]!.id,
						channelId: owner.channelId,
						channelType: "DISCORD",
						subscriptionEventType: "VALIDATION_HEALTH_DEGRADED",
						state,
						attemptOrdinal: 0,
					});
					const repository = createNotificationOutboxRepository(
						fixture.native.prisma,
						fixture.native.runtime,
						fixture.native.encryptor,
						owner.userId,
					);
					const work = await repository.readEvent(events[0]!.id);
					if (!work) throw new Error("Conserved health event could not be read");
					expect(work.payload).toMatchObject({
						eventType: "VALIDATION_HEALTH_DEGRADED",
						title: "Validation health degraded: synthetic-source",
						metadata: {
							integration: "synthetic-source",
							failureCount,
							affectedCategories: "category",
						},
					});
					const channel = graph.channels.find((row) => row.id === owner.channelId);
					expect(channel?.lastSendResult).toBe(state === "sent" ? "success" : null);
					if (state === "ready") expect(delivery[0]!.attemptToken).toBeNull();
					else {
						const history = graph.history.filter((row) => row.channelId === owner.channelId);
						expect(history.map((row) => [row.eventType, row.status, row.retryCount])).toEqual([
							["VALIDATION_HEALTH_DEGRADED", "sent", 0],
						]);
					}
				}
			});
			expect(fixture.payloads.length).toBe(state === "sent" ? 2 : 0);
		},
		assertClosed() {
			expect(counts.pendingReads).toBe(0);
			expect(fixture.state.physicalClientClosed).toBe(true);
			expect(fixture.state.databaseCloseCount).toBe(1);
			expect(fixture.state.pendingAtDatabaseClose).toBe(0);
			const end = fixture.state.order.indexOf("database-close-start");
			for (const [index, event] of fixture.state.order.entries())
				if (event === "health-read-enter" || event === "health-read-settled")
					expect(index).toBeLessThan(end);
		},
	};
}

describe("validation health actual native notification submission", () => {
	it.each([false, true])(
		"retries maintenance rejection without a one-hour blackout (recovery=%s)",
		async (recovery) => {
			const fixture = await boot();
			const gate = deferred();
			const maintenance = track(withCleanupMaintenanceGuard(() => gate.promise));
			record();
			await fixture.drain();
			expect(fixture.counts.reads).toBe(0);
			const empty = await fixture.graph();
			expect(empty.events).toEqual([]);
			expect(empty.deliveries).toEqual([]);
			expect(empty.history).toEqual([]);
			expect(integrationHealth.getByIntegration("synthetic-source")?.state).toBe("degraded");
			gate.resolve();
			expect((await maintenance).status).toBe("fulfilled");
			if (recovery) record(success);
			record(failure, Date.now() + 61_000);
			await fixture.drain();
			await fixture.assertGraph("sent", recovery ? "1" : "2");
			expect(fixture.counts.reads).toBe(1);
			await fixture.app.close();
			fixture.assertClosed();
		},
	);

	it("retries an actual subscription read failure while preserving provider health", async () => {
		const fixture = await boot({ rejectLookup: true });
		record();
		await fixture.drain();
		expect(fixture.counts.failedReads).toBe(1);
		expect(integrationHealth.getByIntegration("synthetic-source")?.state).toBe("degraded");
		expect((await fixture.graph()).events).toEqual([]);
		record(failure, Date.now() + 61_000);
		await fixture.drain();
		await fixture.assertGraph("sent", "2");
		expect(fixture.counts.reads).toBe(2);
		await fixture.app.close();
		fixture.assertClosed();
	});

	it("does not duplicate a held accepted native submission across recovery and degradation", async () => {
		const gate = deferred(),
			entered = deferred();
		const fixture = await boot({ holdLookup: { gate: gate.promise, entered: entered.resolve } });
		record();
		await entered.promise;
		record(success, Date.now() + 7_200_000);
		record(failure, Date.now() + 7_200_000);
		expect(fixture.counts.reads).toBe(1);
		expect(fixture.counts.pendingReads).toBe(1);
		gate.resolve();
		await fixture.drain();
		await fixture.assertGraph("sent", "1");
		record(success);
		record();
		await fixture.drain();
		expect(fixture.counts.reads).toBe(1);
		await fixture.assertGraph("sent", "1");
		await fixture.app.close();
		fixture.assertClosed();
	});

	it("joins accepted native health selection and conserves unissued work before physical close", async () => {
		const gate = deferred(),
			entered = deferred();
		const fixture = await boot({ holdLookup: { gate: gate.promise, entered: entered.resolve } });
		record();
		await entered.promise;
		const close = track(fixture.app.close());
		await fixture.preClosed;
		expect(fixture.state.physicalClientClosed).toBe(false);
		expect(fixture.counts.pendingReads).toBe(1);
		gate.resolve();
		expect((await close).status).toBe("fulfilled");
		fixture.assertClosed();
		await fixture.assertGraph("ready", "1");
	});
});
