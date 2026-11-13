import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envSchema } from "../../config/env.js";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../../lib/backup/restore-runtime-bootstrap.js";
import { createRuntimePrismaClient } from "../../lib/backup/restore-runtime-client.js";
import { withCleanupMaintenanceGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { NotificationDispatcher } from "../../lib/notifications/notification-dispatcher.js";
import { NotificationService } from "../../lib/notifications/notification-service.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import insightsDigestSchedulerPlugin from "../insights-digest-scheduler.js";
import notificationServicePlugin from "../notification-service.js";
import schedulerRegistryPlugin from "../scheduler-registry.js";

const apps: FastifyInstance[] = [];
const fixtures: Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>[] = [];
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

async function settle() {
	for (let turn = 0; turn < 8; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
}

type Phase = "user" | "subscription" | "send" | "log" | "channel";

// These callers await delegates; instrumentation does not claim Prisma's fluent query methods.
type AwaitOnly<T> = T extends (...args: infer Args) => unknown
	? (...args: Args) => PromiseLike<unknown>
	: never;

async function boot(
	options: {
		holds?: Array<{ phase: Phase; gate: Promise<void>; reject?: boolean }>;
		aggregate?: boolean;
		foreignRecipient?: boolean;
	} = {},
) {
	const native = await createNotificationOutboxNativeFixture();
	fixtures.push(native);
	const owner = native.userId;
	const channelId = native.channelId;
	const events = [
		"LIBRARY_INSIGHT_REQUESTED_UNWATCHED",
		"LIBRARY_INSIGHT_WATCHED_MONITORED",
	] as const;
	const webhookUrl = "https://synthetic.invalid/producer";
	let foreign: { userId: string; channelId: string } | undefined;
	if (options.foreignRecipient) foreign = await native.createOwner();
	await native.run(async () => {
		const config = native.encryptor.encrypt(JSON.stringify({ webhookUrl }));
		await native.prisma.notificationChannel.update({
			where: { id: channelId, userId: owner },
			data: {
				encryptedConfig: config.value,
				configIv: config.iv,
				subscriptions: { deleteMany: {}, create: events.map((eventType) => ({ eventType })) },
			},
		});
		if (foreign)
			await native.prisma.notificationChannel.update({
				where: { id: foreign.channelId, userId: foreign.userId },
				data: { subscriptions: { create: events.map((eventType) => ({ eventType })) } },
			});
		if (options.aggregate)
			await native.prisma.notificationAggregationConfig.createMany({
				data: events.map((eventType) => ({
					userId: owner,
					eventType,
					enabled: true,
					windowSeconds: 60,
					maxBatchSize: 10,
				})),
			});
	});
	await native.restart(false);
	const appNative = createRuntimePrismaClient(native.runtime);
	const prisma = appNative.prisma;
	const state = {
		user: 0,
		subscription: 0,
		send: 0,
		log: 0,
		channel: 0,
		pending: 0,
		teardown: 0,
		pendingAtTeardown: -1,
		afterTeardown: 0,
	};
	const entries = new Map(options.holds?.map(({ phase }) => [phase, deferred()]));
	const sent: Array<{ owner: string; event: string; aggregated: boolean }> = [];
	const pause = async (phase: Phase) => {
		const call = ++state[phase];
		if (state.teardown) state.afterTeardown++;
		state.pending++;
		try {
			const hold = call === 1 ? options.holds?.find((entry) => entry.phase === phase) : undefined;
			if (hold) {
				entries.get(phase)!.resolve();
				await hold.gate;
				if (hold.reject) throw new Error("Synthetic producer dependency failure");
			}
		} finally {
			state.pending--;
		}
	};
	// Delegate every successful read/write to the actual native client.
	const firstUser = prisma.user.findFirst.bind(prisma.user);
	const userReads: { findFirst: AwaitOnly<typeof prisma.user.findFirst> } = prisma.user;
	vi.spyOn(userReads, "findFirst").mockImplementation(async (args) => {
		expect(args).toEqual({ select: { id: true } });
		await pause("user");
		// Explicit synthetic administrator selection; no real upstream identity is simulated.
		return firstUser({ ...args, where: { id: owner } });
	});
	const subscriptions = prisma.notificationSubscription.findMany.bind(
		prisma.notificationSubscription,
	);
	const subscriptionReads: {
		findMany: AwaitOnly<typeof prisma.notificationSubscription.findMany>;
	} = prisma.notificationSubscription;
	vi.spyOn(subscriptionReads, "findMany").mockImplementation(async (args) => {
		expect(args?.where?.channel).toEqual({ userId: owner });
		await pause("subscription");
		if (foreign)
			return subscriptions({
				...args,
				where: { ...args?.where, channel: { userId: foreign.userId } },
			});
		return subscriptions(args);
	});
	const transaction = prisma.$transaction.bind(prisma);
	vi.spyOn(prisma, "$transaction").mockImplementation(async (operation) =>
		transaction(async (tx) => {
			const log = tx.notificationLog.create.bind(tx.notificationLog);
			const historyWrites: { create: AwaitOnly<typeof tx.notificationLog.create> } =
				tx.notificationLog;
			vi.spyOn(historyWrites, "create").mockImplementation(async (args) => {
				await pause("log");
				return log(args);
			});
			const status = tx.notificationChannel.updateMany.bind(tx.notificationChannel);
			const statusWrites: { updateMany: AwaitOnly<typeof tx.notificationChannel.updateMany> } =
				tx.notificationChannel;
			vi.spyOn(statusWrites, "updateMany").mockImplementation(async (args) => {
				if (args?.data.lastSendResult !== undefined) await pause("channel");
				return status(args);
			});
			return operation(tx);
		}),
	);
	// Only external transport and controlled upstream findings are doubled.
	vi.spyOn(NotificationDispatcher.prototype, "send").mockImplementation(
		async (type, config, payload) => {
			expect(type).toBe("DISCORD");
			expect(config).toEqual({ webhookUrl });
			expect(events).toContain(payload.eventType);
			await pause("send");
			sent.push({
				owner,
				event: payload.eventType,
				aggregated: payload.metadata?.aggregated === true,
			});
			return { success: true, retryable: false };
		},
	);
	const app = Fastify({ logger: false });
	apps.push(app);
	app.decorate("restoreRuntime", native.runtime);
	app.decorate("prisma", prisma);
	app.decorate("encryptor", native.encryptor);
	app.decorate("arrClientFactory", {} as never);
	app.decorate(
		"config",
		envSchema.parse({ NODE_ENV: "test", APP_URL: "https://synthetic.invalid" }),
	);
	app.register(
		fp(
			async (server) => {
				server.addHook("onClose", async () => {
					state.pendingAtTeardown = state.pending;
					await appNative.close();
					state.teardown++;
				});
			},
			{ name: "prisma" },
		),
	);
	app.register(fp(async () => {}, { name: "security" }));
	registerRestoreBootstrapPlugin(app, notificationServicePlugin);
	app.register(schedulerRegistryPlugin);
	const timeout = vi.spyOn(globalThis, "setTimeout");
	const interval = vi.spyOn(globalThis, "setInterval");
	registerRestoreBootstrapPlugin(app, insightsDigestSchedulerPlugin);
	const closing = deferred();
	// Register after both real admission guards, not as an immediate root hook.
	app.register(
		fp(
			async (server) => {
				server.addHook("preClose", async () => closing.resolve());
			},
			{
				name: "notification-producer-shutdown-observer",
				dependencies: ["notification-service", "insights-digest-scheduler"],
			},
		),
	);
	registerRestoreRuntimeActivation(app);
	await app.ready();
	const track = app.schedulerRegistry.track.bind(app.schedulerRegistry);
	vi.spyOn(app.schedulerRegistry, "track").mockImplementation((...args) => {
		const task = track(...args);
		tasks.push(task.catch(() => undefined));
		return task;
	});
	const readers = app.insightsDigestScheduler as unknown as {
		findRequestedUnwatched: (id: string) => Promise<unknown[]>;
		findWatchedMonitored: (id: string) => Promise<unknown[]>;
	};
	vi.spyOn(readers, "findRequestedUnwatched").mockImplementation(async (id) => {
		expect(id).toBe(owner);
		return [{ title: "Synthetic finding", requestedBy: "Synthetic requester" }];
	});
	vi.spyOn(readers, "findWatchedMonitored").mockImplementation(async (id) => {
		expect(id).toBe(owner);
		return [{ title: "Synthetic finding", watchCount: 2 }];
	});
	return {
		app,
		state,
		sent,
		owner,
		closing: closing.promise,
		entered(phase: Phase) {
			const gate = entries.get(phase);
			if (!gate) throw new Error("No held phase");
			return gate.promise;
		},
		tick(origin: "startup" | "interval" = "startup") {
			const calls = origin === "startup" ? timeout.mock.calls : interval.mock.calls;
			const callback = [...calls]
				.reverse()
				.find(([, delay]) => delay === (origin === "startup" ? 5 * 60_000 : 6 * 60 * 60_000))?.[0];
			if (typeof callback !== "function") throw new Error("No digest callback");
			const acceptedBefore = tasks.length;
			callback();
			return tasks.length > acceptedBefore ? tasks[tasks.length - 1]! : Promise.resolve();
		},
		producer: app.notificationService,
		statuses: () =>
			native.run(async () =>
				(
					await native.prisma.notificationLog.findMany({
						where: { channelId },
						orderBy: { sentAt: "asc" },
					})
				).map((row) => row.status),
			),
		queue: () =>
			native.run(() =>
				native.prisma.notificationOutboxDelivery.findMany({
					where: { userId: owner },
					orderBy: { channelId: "asc" },
				}),
			),
		eventStages: () =>
			native.run(async () =>
				(await native.prisma.notificationOutboxEvent.findMany({ where: { userId: owner } })).map(
					(row) => row.stage,
				),
			),
	};
}

beforeEach(() => {
	vi.useFakeTimers({
		toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"],
	});
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await settle();
	await Promise.all(tasks.splice(0));
	await Promise.all(apps.splice(0).map((app) => app.close()));
	vi.restoreAllMocks();
	vi.useRealTimers();
	await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("accepted digest producer notification handoff", () => {
	it("preserves the admitted producer callback result", async () => {
		const fixture = await boot();
		const result = { status: "synthetic-completion" };
		expect(await fixture.producer.runProducer(async () => result)).toBe(result);
	});

	it("classifies a digest tick during maintenance as a skip without a false error", async () => {
		const fixture = await boot();
		const errors = vi.spyOn(fixture.app.log, "error");
		const before = fixture.app.schedulerRegistry.getStatus(JOB_ID.insightsDigest);
		await withCleanupMaintenanceGuard(async () => {
			await fixture.tick();
		});
		expect(errors).not.toHaveBeenCalled();
		expect(fixture.state.user).toBe(0);
		expect(fixture.state.subscription).toBe(0);
		expect(fixture.app.schedulerRegistry.getStatus(JOB_ID.insightsDigest)).toEqual(before);
	});

	for (const origin of ["startup", "interval"] as const) {
		it(`keeps ${origin} child submissions admissible after preClose without reopening ordinary work`, async () => {
			const gate = deferred();
			const fixture = await boot({ holds: [{ phase: "user", gate: gate.promise }] });
			fixture.tick(origin);
			await fixture.entered("user");
			let closed = false;
			const close = fixture.app.close().then(() => {
				closed = true;
			});
			await fixture.closing;
			await settle();
			expect(closed).toBe(false);
			await expect(
				fixture.app.notificationService.notify(
					{
						eventType: "LIBRARY_INSIGHT_REQUESTED_UNWATCHED",
						title: "Synthetic late item",
						body: "Synthetic",
						metadata: { aggregated: true },
					},
					{ userId: fixture.owner, skipRules: true },
				),
			).rejects.toThrow("shutting down");
			expect(fixture.state.subscription).toBe(0);
			gate.resolve();
			await close;
			expect(fixture.sent).toEqual([]);
			expect(await fixture.statuses()).toEqual([]);
			expect((await fixture.queue()).map((row) => row.state)).toEqual(["ready", "ready"]);
			expect(fixture.state.pendingAtTeardown).toBe(0);
			expect(fixture.state.afterTeardown).toBe(0);
			expect(fixture.app.schedulerRegistry.getStatus(JOB_ID.insightsDigest)?.state).toBe("idle");
		});
	}

	for (const reject of [false, true]) {
		it(`joins an accepted subscription ${reject ? "failure" : "completion"} without forcing a new send`, async () => {
			const parent = deferred();
			const child = deferred();
			const fixture = await boot({
				holds: [
					{ phase: "user", gate: parent.promise },
					{ phase: "subscription", gate: child.promise, reject },
				],
			});
			fixture.tick();
			await fixture.entered("user");
			let closed = false;
			const close = fixture.app.close().then(() => {
				closed = true;
			});
			await fixture.closing;
			parent.resolve();
			await fixture.entered("subscription");
			expect(closed).toBe(false);
			expect(fixture.state.teardown).toBe(0);
			child.resolve();
			await close;
			expect(fixture.sent).toEqual([]);
			expect(await fixture.statuses()).toEqual([]);
			expect((await fixture.queue()).map((row) => row.state)).toEqual(
				reject ? ["ready"] : ["ready", "ready"],
			);
			expect(fixture.state.pendingAtTeardown).toBe(0);
			expect(fixture.state.afterTeardown).toBe(0);
			expect(fixture.state.teardown).toBe(1);
		});
	}

	for (const phase of ["send", "log", "channel"] as const) {
		for (const reject of [false, true]) {
			it(`joins already-started ${phase} ${reject ? "failure" : "completion"} before actual native client close`, async () => {
				const child = deferred();
				const fixture = await boot({ holds: [{ phase, gate: child.promise, reject }] });
				fixture.tick();
				await fixture.entered(phase);
				let closed = false;
				const close = fixture.app.close().then(() => {
					closed = true;
				});
				await fixture.closing;
				await settle();
				expect(closed).toBe(false);
				expect(fixture.state.teardown).toBe(0);
				child.resolve();
				await close;
				expect(fixture.state.send).toBe(1);
				expect(await fixture.statuses()).toEqual(reject ? [] : ["sent"]);
				const states = (await fixture.queue()).map((row) => row.state).sort();
				expect(states).toEqual(
					reject
						? ["ready", phase === "send" ? "uncertain" : "submitting"].sort()
						: ["ready", "sent"],
				);
				expect(fixture.state.pendingAtTeardown).toBe(0);
				expect(fixture.state.afterTeardown).toBe(0);
				expect(fixture.state.teardown).toBe(1);
			});
		}
	}

	it("preserves aggregation created by an accepted producer after timer admission closes", async () => {
		const gate = deferred();
		const fixture = await boot({ aggregate: true, holds: [{ phase: "user", gate: gate.promise }] });
		fixture.tick();
		await fixture.entered("user");
		const close = fixture.app.close();
		await fixture.closing;
		gate.resolve();
		await close;
		expect(fixture.sent).toEqual([]);
		expect(await fixture.statuses()).toEqual([]);
		expect(await fixture.eventStages()).toEqual(["aggregating", "aggregating"]);
		expect((await fixture.queue()).map((row) => row.state)).toEqual(["waiting", "waiting"]);
		expect(fixture.state.afterTeardown).toBe(0);
	});

	it("retains owner filtering even if a dependency supplies a foreign subscription", async () => {
		const gate = deferred();
		const fixture = await boot({
			foreignRecipient: true,
			holds: [{ phase: "user", gate: gate.promise }],
		});
		fixture.tick();
		await fixture.entered("user");
		const close = fixture.app.close();
		await fixture.closing;
		gate.resolve();
		await close;
		expect(fixture.state.subscription).toBe(2);
		expect(fixture.sent).toEqual([]);
		expect(await fixture.statuses()).toEqual([]);
	});

	it("refuses new producer scopes and queued digest callbacks after closing", async () => {
		const gate = deferred();
		const fixture = await boot({ holds: [{ phase: "user", gate: gate.promise }] });
		fixture.tick();
		await fixture.entered("user");
		const close = fixture.app.close();
		await fixture.closing;
		let entered = false;
		await expect(
			fixture.producer.runProducer(async () => {
				entered = true;
			}),
		).rejects.toThrow("shutting down");
		fixture.tick();
		fixture.tick("interval");
		await settle();
		expect(entered).toBe(false);
		expect(fixture.state.user).toBe(1);
		gate.resolve();
		await close;
	});

	it("expires escaped async descendants after an admitted producer completes", async () => {
		const fixture = await boot();
		const gate = deferred();
		let descendant!: Promise<string>;
		await fixture.producer.runProducer(async () => {
			descendant = (async () => {
				await gate.promise;
				return fixture.app.notificationService
					.notify(
						{
							eventType: "LIBRARY_INSIGHT_REQUESTED_UNWATCHED",
							title: "Synthetic escaped item",
							body: "Synthetic",
						},
						{ userId: fixture.owner },
					)
					.then(
						() => "fulfilled",
						() => "rejected",
					);
			})();
		});
		await fixture.app.close();
		gate.resolve();
		expect(await descendant).toBe("rejected");
		expect(fixture.state.subscription).toBe(0);
	});

	it("checks maintenance before entering an accepted producer scope", async () => {
		const fixture = await boot();
		let entered = false;
		await withCleanupMaintenanceGuard(async () => {
			await expect(
				fixture.producer.runProducer(async () => {
					entered = true;
				}),
			).rejects.toThrow("maintenance");
		});
		expect(entered).toBe(false);
		expect(fixture.state.user).toBe(0);
		expect(fixture.state.subscription).toBe(0);
	});

	it("expires escaped descendants even when the producer rejects", async () => {
		const fixture = await boot();
		const gate = deferred();
		let descendant!: Promise<string>;
		await expect(
			fixture.producer.runProducer(async () => {
				descendant = (async () => {
					await gate.promise;
					return fixture.app.notificationService
						.notify(
							{
								eventType: "LIBRARY_INSIGHT_REQUESTED_UNWATCHED",
								title: "Synthetic escaped item",
								body: "Synthetic",
							},
							{ userId: fixture.owner },
						)
						.then(
							() => "fulfilled",
							() => "rejected",
						);
				})();
				throw new Error("Synthetic producer rejection");
			}),
		).rejects.toThrow("Synthetic producer rejection");
		await fixture.app.close();
		gate.resolve();
		expect(await descendant).toBe("rejected");
		expect(fixture.state.subscription).toBe(0);
	});

	it("does not transfer an accepted scope to another notification service", async () => {
		const fixture = await boot();
		const gate = deferred();
		const entered = deferred();
		let otherReads = 0;
		const other = new NotificationService(
			{
				notificationSubscription: {
					async findMany() {
						otherReads++;
						throw new Error("Fixture forbids another service query");
					},
				},
			} as never,
			{} as never,
			{} as never,
			{ info() {}, debug() {}, warn() {}, error() {} },
			{} as never,
			{} as never,
			"https://synthetic.invalid",
		);
		other.closeAdmission();
		const work = fixture.producer.runProducer(async () => {
			entered.resolve();
			await gate.promise;
			await expect(
				other.notify(
					{
						eventType: "LIBRARY_INSIGHT_REQUESTED_UNWATCHED",
						title: "Synthetic",
						body: "Synthetic",
					},
					{ userId: fixture.owner },
				),
			).rejects.toThrow("shutting down");
			await fixture.app.notificationService.notify(
				{ eventType: "LIBRARY_INSIGHT_REQUESTED_UNWATCHED", title: "Synthetic", body: "Synthetic" },
				{ userId: fixture.owner },
			);
		});
		try {
			await entered.promise;
			const close = fixture.app.close();
			await fixture.closing;
			gate.resolve();
			await work;
			await close;
			expect(otherReads).toBe(0);
			expect(fixture.sent).toHaveLength(0);
			expect((await fixture.queue()).map((row) => row.state)).toEqual(["ready"]);
		} finally {
			gate.resolve();
			await work;
			await other.shutdown();
		}
	});

	it("duplicate close waits one admitted producer and its actual child processing", async () => {
		const fixture = await boot();
		const gate = deferred();
		const entered = deferred();
		const work = fixture.producer.runProducer(async () => {
			entered.resolve();
			await gate.promise;
			await fixture.app.notificationService.notify(
				{ eventType: "LIBRARY_INSIGHT_REQUESTED_UNWATCHED", title: "Synthetic", body: "Synthetic" },
				{ userId: fixture.owner },
			);
		});
		await entered.promise;
		let closed = 0;
		const closes = [fixture.app.close(), fixture.app.close()].map((promise) =>
			promise.then(() => {
				closed++;
			}),
		);
		await fixture.closing;
		await settle();
		expect(closed).toBe(0);
		expect(fixture.state.teardown).toBe(0);
		gate.resolve();
		await work;
		await Promise.all(closes);
		expect(closed).toBe(2);
		expect(fixture.state.teardown).toBe(1);
		expect(await fixture.statuses()).toEqual([]);
		expect((await fixture.queue()).map((row) => row.state)).toEqual(["ready"]);
	});

	it("retains a detached accepted child after its producer callback returns", async () => {
		const gate = deferred();
		const fixture = await boot({ holds: [{ phase: "send", gate: gate.promise }] });
		let child!: Promise<void>;
		await fixture.producer.runProducer(async () => {
			child = fixture.app.notificationService.notify(
				{ eventType: "LIBRARY_INSIGHT_REQUESTED_UNWATCHED", title: "Synthetic", body: "Synthetic" },
				{ userId: fixture.owner },
			);
		});
		await fixture.entered("send");
		let closed = false;
		const close = fixture.app.close().then(() => {
			closed = true;
		});
		await fixture.closing;
		await settle();
		expect(closed).toBe(false);
		expect(fixture.state.teardown).toBe(0);
		gate.resolve();
		await child;
		await close;
		expect(await fixture.statuses()).toEqual(["sent"]);
		expect(fixture.state.pendingAtTeardown).toBe(0);
	});

	it("retains maintenance exclusion for the complete producer lifetime", async () => {
		const fixture = await boot();
		const gate = deferred();
		const entered = deferred();
		const work = fixture.producer.runProducer(async () => {
			entered.resolve();
			await gate.promise;
		});
		await entered.promise;
		let maintenance = false;
		try {
			await expect(
				withCleanupMaintenanceGuard(async () => {
					maintenance = true;
				}),
			).rejects.toThrow("maintenance");
			expect(maintenance).toBe(false);
		} finally {
			gate.resolve();
			await work;
		}
		await withCleanupMaintenanceGuard(async () => {
			maintenance = true;
		});
		expect(maintenance).toBe(true);
	});
});
