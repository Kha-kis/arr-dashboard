import { performance } from "node:perf_hooks";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSchedulers } from "../../bootstrap/schedulers.js";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../../lib/backup/restore-runtime-bootstrap.js";
import { createRuntimePrismaClient } from "../../lib/backup/restore-runtime-client.js";
import { withCleanupMaintenanceGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import * as syncModule from "../../lib/library-sync/index.js";
import * as executor from "../../lib/library-sync/sync-executor.js";
import { LibrarySyncScheduler } from "../../lib/library-sync/sync-scheduler.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { NotificationDispatcher } from "../../lib/notifications/notification-dispatcher.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import syncPlugin from "../library-sync-scheduler.js";
import notificationPlugin from "../notification-service.js";
import registryPlugin from "../scheduler-registry.js";

const apps: FastifyInstance[] = [];
const releases: Array<() => void> = [];
const tasks: Promise<unknown>[] = [];
type NativeFixture = Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
type AwaitOnly<T> = T extends (...args: infer Args) => unknown
	? (...args: Args) => PromiseLike<unknown>
	: never;
const nativeFixtures: NativeFixture[] = [];
const nativeRows = new Map<
	NativeFixture,
	{
		instances: Array<{ id: string; userId: string }>;
		statuses: Array<{ id: string; instanceId: string; userId: string }>;
		channels: Array<{ id: string; userId: string }>;
		subscriptions: Array<{ channelId: string; userId: string }>;
	}
>();
const realTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	releases.push(resolve);
	return { promise, resolve };
}
async function settle() {
	await new Promise<void>((done) => setImmediate(done));
}
async function waitForNative(observe: () => boolean) {
	const deadline = performance.now() + 4_000;
	while (!observe()) {
		if (performance.now() >= deadline) return false;
		await settle();
	}
	return true;
}
type Origin = "startup" | "interval" | "manual";
type Phase = "lookup" | "reset" | "execute" | "subscription" | "send" | "log" | "channel";
type Mode =
	| "success"
	| "failed"
	| "empty"
	| "missing"
	| "non-library"
	| "polling-off"
	| "fresh"
	| "large"
	| "cold"
	| "two";
// Native schema/runtime/bootstrap, owned encrypted recipients and separate clients.
// Only the cache executor and outbound transport are synthetic.
async function boot(
	options: {
		origin?: Origin;
		hold?: { phase: Phase; gate: Promise<void>; reject?: boolean; count?: number };
		mode?: Mode;
		closeAdmissionAfterLookup?: boolean;
	} = {},
) {
	const origin = options.origin ?? "startup";
	const native = await createNotificationOutboxNativeFixture();
	nativeFixtures.push(native);
	const multi = ["two", "large", "cold"].includes(options.mode ?? "");
	const ownerRows = [
		{ userId: native.userId, channelId: native.channelId },
		await native.createOwner(),
	];
	if (multi) ownerRows.push(await native.createOwner());
	const owners = multi ? ["synthetic-a", "synthetic-b", "synthetic-c"] : ["synthetic-a"];
	const labels = ["synthetic-a", "synthetic-b", "synthetic-c"];
	const owned: NonNullable<ReturnType<typeof nativeRows.get>> = {
		instances: [],
		statuses: [],
		channels: [],
		subscriptions: [],
	};
	nativeRows.set(native, owned);
	await native.run(async () => {
		for (const [index, recipient] of ownerRows.entries()) {
			const encrypted = native.encryptor.encrypt(
				JSON.stringify({
					webhookUrl: `https://example.invalid/synthetic-worker/${recipient.userId}`,
				}),
			);
			expect(
				(
					await native.prisma.notificationChannel.updateMany({
						where: { id: recipient.channelId, userId: recipient.userId },
						data: {
							name: "Same synthetic channel",
							encryptedConfig: encrypted.value,
							configIv: encrypted.iv,
						},
					})
				).count,
			).toBe(1);
			owned.channels.push({ id: recipient.channelId, userId: recipient.userId });
			await native.prisma.notificationSubscription.create({
				data: { channelId: recipient.channelId, eventType: "LIBRARY_NEW_CONTENT" },
			});
			owned.subscriptions.push({ channelId: recipient.channelId, userId: recipient.userId });
			const key = native.encryptor.encrypt("synthetic-provider-key");
			const enabled = (multi || index === 0) && options.mode !== "empty";
			const row = await native.prisma.serviceInstance.create({
				data: {
					userId: recipient.userId,
					service: options.mode === "non-library" && index === 0 ? "PROWLARR" : "RADARR",
					label: "Synthetic library",
					baseUrl: "https://example.invalid/synthetic-provider",
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
					enabled,
				},
			});
			owned.instances.push({ id: row.id, userId: row.userId });
			const status = await native.prisma.librarySyncStatus.create({
				data: {
					instanceId: row.id,
					lastFullSync:
						options.mode === "cold"
							? null
							: new Date(Date.now() - (origin === "interval" ? 0 : 3_600_000)),
					itemCount: options.mode === "large" ? 10_000 : 1,
					syncInProgress: options.hold?.phase === "reset" && index === 0 && origin !== "interval",
					updatedAt: new Date(Date.now() - 7_200_000),
					pollingEnabled: enabled && options.mode !== "polling-off",
					pollingIntervalMins: options.mode === "fresh" ? 120 : 15,
				},
			});
			owned.statuses.push({ id: status.id, instanceId: row.id, userId: row.userId });
		}
	});
	const instances = await native.run(() =>
		native.prisma.serviceInstance.findMany({
			where: { id: { in: owned.instances.map((row) => row.id) } },
			include: { librarySyncStatus: true },
		}),
	);
	const instanceId = (alias: string) => owned.instances[labels.indexOf(alias)]!.id;
	const aliasFor = (userId: string) => labels[ownerRows.findIndex((row) => row.userId === userId)]!;
	await native.restart(false);
	const client = createRuntimePrismaClient(native.runtime);
	const prisma = client.prisma;
	const state = {
		lookup: 0,
		reset: 0,
		execute: 0,
		subscription: 0,
		send: 0,
		log: 0,
		channel: 0,
		pending: 0,
		teardown: 0,
		pendingAtTeardown: -1,
		afterTeardown: 0,
		forbidden: 0,
		network: 0,
	};
	let armed = origin !== "interval",
		offset = 0,
		held = false;
	const entered = deferred(),
		closing = deferred();
	const pause = async (phase: Phase) => {
		const count = ++state[phase];
		if (state.teardown) state.afterTeardown++;
		state.pending++;
		try {
			if (armed && options.hold?.phase === phase && count === offset + (options.hold.count ?? 1)) {
				held = true;
				entered.resolve();
				await options.hold.gate;
				if (options.hold.reject) throw new Error("Synthetic sync dependency failure");
			}
		} finally {
			if (state.teardown) state.afterTeardown++;
			state.pending--;
		}
	};
	const refuse = () => {
		state.forbidden++;
		throw new Error("Unexpected synthetic target or provider access");
	};
	vi.stubGlobal("fetch", () => {
		state.network++;
		return refuse();
	});
	const lookup = prisma.serviceInstance.findMany.bind(prisma.serviceInstance);
	const reads: { findMany: AwaitOnly<typeof prisma.serviceInstance.findMany> } =
		prisma.serviceInstance;
	vi.spyOn(reads, "findMany").mockImplementation(async (args) => {
		expect(args).toEqual({
			where: { enabled: true, service: { in: ["SONARR", "RADARR", "LIDARR", "READARR"] } },
			include: { librarySyncStatus: true },
		});
		await pause("lookup");
		const rows = await lookup({ ...args, include: { librarySyncStatus: true } });
		expect(rows.map((row) => row.id).sort()).toEqual(
			instances
				.filter((row) => row.enabled && row.service !== "PROWLARR")
				.map((row) => row.id)
				.sort(),
		);
		if (options.closeAdmissionAfterLookup) app.restoreRuntime.closeAdmission();
		return rows;
	});
	const unique = prisma.serviceInstance.findUnique.bind(prisma.serviceInstance);
	const uniqueReads: { findUnique: AwaitOnly<typeof prisma.serviceInstance.findUnique> } =
		prisma.serviceInstance;
	vi.spyOn(uniqueReads, "findUnique").mockImplementation(async (args) => {
		expect(args).toEqual({
			where: {
				id: options.mode === "missing" ? "synthetic-absent-instance" : instanceId("synthetic-a"),
			},
			include: { librarySyncStatus: true },
		});
		await pause("lookup");
		return unique({ ...args, include: { librarySyncStatus: true } });
	});
	const reset = prisma.librarySyncStatus.update.bind(prisma.librarySyncStatus);
	const statusWrites: { update: AwaitOnly<typeof prisma.librarySyncStatus.update> } =
		prisma.librarySyncStatus;
	vi.spyOn(statusWrites, "update").mockImplementation(async (args) => {
		expect(args).toEqual({
			where: { instanceId: instanceId("synthetic-a") },
			data: { syncInProgress: false },
		});
		await pause("reset");
		const row = await reset(args);
		expect(row.syncInProgress).toBe(false);
		return row;
	});
	const subscriptionRead = prisma.notificationSubscription.findMany.bind(
		prisma.notificationSubscription,
	);
	const subscriptionReads: {
		findMany: AwaitOnly<typeof prisma.notificationSubscription.findMany>;
	} = prisma.notificationSubscription;
	vi.spyOn(subscriptionReads, "findMany").mockImplementation(async (args) => {
		expect(args?.where?.eventType).toBe("LIBRARY_NEW_CONTENT");
		expect(args?.include).toEqual({ channel: true });
		const owner = ownerRows.find(
			(row) => row.userId === (args?.where?.channel as { userId?: string } | undefined)?.userId,
		);
		expect(owner).toBeDefined();
		expect(owners).toContain(aliasFor(owner!.userId));
		await pause("subscription");
		const rows = await subscriptionRead({ ...args, include: { channel: true } });
		expect(rows).toHaveLength(1);
		expect(rows[0]?.channel).toMatchObject({ id: owner!.channelId, userId: owner!.userId });
		return rows;
	});
	const transaction = prisma.$transaction.bind(prisma);
	vi.spyOn(prisma, "$transaction").mockImplementation(async (operation, transactionOptions) =>
		transaction(async (tx) => {
			const historyWrite = tx.notificationLog.create.bind(tx.notificationLog);
			const history: { create: AwaitOnly<typeof tx.notificationLog.create> } = tx.notificationLog;
			vi.spyOn(history, "create").mockImplementation(async (args) => {
				expect(owned.channels.map((row) => row.id)).toContain(args.data.channelId);
				await pause("log");
				const row = await historyWrite(args);
				statuses.push(row.status);
				return row;
			});
			const channelWrite = tx.notificationChannel.updateMany.bind(tx.notificationChannel);
			const channels: { updateMany: AwaitOnly<typeof tx.notificationChannel.updateMany> } =
				tx.notificationChannel;
			vi.spyOn(channels, "updateMany").mockImplementation(async (args) => {
				const selected = ownerRows.find((row) => row.channelId === args.where?.id);
				expect(selected).toBeDefined();
				expect(args.where?.userId).toBe(selected!.userId);
				if (args.data.lastSendResult !== undefined) await pause("channel");
				return channelWrite(args);
			});
			return operation(tx);
		}, transactionOptions),
	);
	const executions: string[] = [],
		executionEntries: string[] = [],
		statuses: string[] = [];
	const events: Array<{ owner: string; metadata: unknown }> = [];
	const payloads: unknown[] = [];
	vi.spyOn(executor, "syncInstance").mockImplementation(async (deps, instance) => {
		expect(deps.prisma).toBe(prisma);
		expect(deps.encryptor).toBe(native.encryptor);
		expect(deps.arrClientFactory).toBe(app.arrClientFactory);
		const selected = instances.find((row) => row.id === instance.id);
		expect(selected).toBeDefined();
		expect(owners).toContain(aliasFor(instance.userId));
		// The scheduler narrows its declared type, but passes the complete native row.
		expect(instance).toEqual({ ...selected, librarySyncStatus: expect.anything() });
		expect(
			native.encryptor.decrypt({ value: instance.encryptedApiKey, iv: instance.encryptionIv }),
		).toBe("synthetic-provider-key");
		executionEntries.push(aliasFor(instance.userId));
		await pause("execute");
		executions.push(aliasFor(instance.userId));
		return {
			instanceId: instance.id,
			instanceName: "Synthetic library",
			success: options.mode !== "failed",
			itemsProcessed: 7,
			itemsAdded: 7,
			itemsUpdated: 0,
			itemsRemoved: 0,
			durationMs: 1,
			newDownloads: [
				{ title: "Synthetic 1", itemType: "movie" },
				{ title: "Synthetic 2", itemType: "movie" },
				{ title: "Synthetic 3", itemType: "movie" },
				{ title: "Synthetic 4", itemType: "movie" },
				{ title: "Synthetic 5", itemType: "movie" },
				{ title: "Synthetic 6", itemType: "movie" },
				{ title: "Synthetic 7", itemType: "movie" },
			],
			...(options.mode === "failed" ? { error: "Synthetic cache scan failed" } : {}),
		};
	});
	vi.spyOn(NotificationDispatcher.prototype, "send").mockImplementation(
		async (type, config, payload) => {
			const selected = ownerRows.find(
				(row) => config.webhookUrl === `https://example.invalid/synthetic-worker/${row.userId}`,
			);
			if (type !== "DISCORD" || !selected || !owners.includes(aliasFor(selected.userId)))
				return refuse();
			expect(payload).toEqual(wantPayload);
			events.push({ owner: aliasFor(selected.userId), metadata: payload.metadata });
			payloads.push(payload);
			await pause("send");
			return { success: true, retryable: false };
		},
	);
	const scheduler = new LibrarySyncScheduler();
	vi.spyOn(syncModule, "getLibrarySyncScheduler").mockReturnValue(scheduler);
	const app = Fastify({ logger: false });
	apps.push(app);
	app.decorate("restoreRuntime", native.runtime);
	app.decorate("prisma", prisma);
	app.decorate("encryptor", native.encryptor);
	app.decorate("config", { APP_URL: "https://synthetic.invalid" } as never);
	app.decorate("arrClientFactory", { create: refuse } as never);
	await app.register(
		fp(
			async (server) => {
				server.addHook("onClose", async () => {
					state.pendingAtTeardown = state.pending;
					expect(state.pending).toBe(0);
					await client.close();
					state.teardown++;
				});
			},
			{ name: "prisma" },
		),
	);
	await app.register(fp(async () => {}, { name: "security" }));
	await app.register(fp(async () => {}, { name: "arr-client" }));
	registerRestoreBootstrapPlugin(app, notificationPlugin);
	registerRestoreBootstrapPlugin(app, registryPlugin);
	await app.after();
	const track = app.schedulerRegistry.track.bind(app.schedulerRegistry);
	vi.spyOn(app.schedulerRegistry, "track").mockImplementation((...args) => {
		const task = track(...args);
		tasks.push(task.catch(() => undefined));
		return task;
	});
	const timeout = vi.spyOn(globalThis, "setTimeout");
	const interval = vi.spyOn(globalThis, "setInterval");
	const register = app.register.bind(app),
		displayName = Symbol.for("fastify.display-name");
	let selectedRegistrations = 0;
	const registration = vi.spyOn(app, "register").mockImplementation(((
		plugin: unknown,
		...args: unknown[]
	) => {
		if (
			typeof plugin === "function" &&
			Reflect.get(plugin, displayName) === Reflect.get(syncPlugin, displayName)
		) {
			expect(plugin).not.toBe(syncPlugin);
			expect(Reflect.get(plugin, Symbol.for("plugin-meta"))).toBe(
				Reflect.get(syncPlugin, Symbol.for("plugin-meta")),
			);
			selectedRegistrations++;
			return Reflect.apply(register, app, [plugin, ...args]);
		}
		return app;
	}) as typeof app.register);
	try {
		registerSchedulers(app);
		expect(selectedRegistrations).toBe(1);
	} finally {
		registration.mockRestore();
	}
	await app.after();
	registerRestoreRuntimeActivation(app);
	app.addHook("preClose", async () => closing.resolve());
	await app.ready();
	expect(scheduler.isRunning()).toBe(true);
	const pending = () =>
		(scheduler as unknown as { pendingOperations: Set<Promise<void>> }).pendingOperations;
	const idle = async () => {
		expect(await waitForNative(() => pending().size === 0)).toBe(true);
		await app.notificationService.drain();
	};
	await idle();
	const initial = () => {
		const fn = [...timeout.mock.calls].reverse().find(([, delay]) => delay === 60_000)?.[0];
		if (typeof fn !== "function") throw new Error("No startup callback");
		return fn;
	};
	const periodic = () => {
		const fn = [...interval.mock.calls].reverse().find(([, delay]) => delay === 60_000)?.[0];
		if (typeof fn !== "function") throw new Error("No periodic callback");
		return fn;
	};
	if (origin === "interval") {
		await vi.advanceTimersByTimeAsync(60_000);
		await idle();
		offset = options.hold ? state[options.hold.phase] : 0;
		await native.run(() =>
			native.prisma.librarySyncStatus.updateMany({
				where: {
					instanceId: { in: owned.instances.map((row) => row.id) },
					instance: { userId: { in: ownerRows.map((row) => row.userId) } },
				},
				data: {
					lastFullSync: options.mode === "cold" ? null : new Date(Date.now() - 3_600_000),
					...(options.hold?.phase === "reset"
						? {
								syncInProgress: true,
								updatedAt: new Date(Date.now() - 7_200_000),
							}
						: {}),
				},
			}),
		);
		armed = true;
	}
	const manualSync = (id = instanceId("synthetic-a")) => {
		const task = app.restoreRuntime.runOperation(() => scheduler.triggerSync(id));
		tasks.push(task.catch(() => undefined));
		return task;
	};
	const launch = () => {
		if (origin === "manual")
			return manualSync(options.mode === "missing" ? "synthetic-absent-instance" : undefined);
		if (origin === "startup") vi.advanceTimersByTime(60_000);
		else periodic()();
		return null;
	};
	const outcome = () =>
		native.run(async () => ({
			instances: await native.prisma.serviceInstance.findMany({
				where: {
					id: { in: owned.instances.map((row) => row.id) },
					userId: { in: ownerRows.map((row) => row.userId) },
				},
			}),
			statuses: await native.prisma.librarySyncStatus.findMany({
				where: {
					instanceId: { in: owned.instances.map((row) => row.id) },
					instance: { userId: { in: ownerRows.map((row) => row.userId) } },
				},
			}),
			events: await native.prisma.notificationOutboxEvent.findMany({
				where: { userId: { in: ownerRows.map((row) => row.userId) } },
			}),
			deliveries: await native.prisma.notificationOutboxDelivery.findMany({
				where: { userId: { in: ownerRows.map((row) => row.userId) } },
			}),
			history: await native.prisma.notificationLog.findMany({
				where: { channelId: { in: owned.channels.map((row) => row.id) } },
			}),
			channels: await native.prisma.notificationChannel.findMany({ where: { OR: owned.channels } }),
		}));
	return {
		app,
		native,
		prisma,
		state,
		scheduler,
		executions,
		executionEntries,
		events,
		statuses,
		payloads,
		owners,
		ownerRows,
		instanceId,
		manualSync,
		aliasFor,
		idle,
		pending,
		outcome,
		launch,
		entered: entered.promise,
		closing: closing.promise,
		initial,
		periodic,
		waitUntilHeld: () => waitForNative(() => held),
	};
}
beforeEach(() => {
	vi.useFakeTimers({
		toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	});
	vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
	const virtualTimeout = globalThis.setTimeout,
		virtualClear = globalThis.clearTimeout;
	const schedulerHandles = new Set<ReturnType<typeof setTimeout>>();
	// Only the first scheduler wakeup is virtual. Native PostgreSQL transport and
	// outbox retry/recovery deadlines continue using their real timer handles.
	vi.stubGlobal("setTimeout", ((...args: Parameters<typeof setTimeout>) => {
		if (args[1] === 60_000) {
			const handle = Reflect.apply(virtualTimeout, globalThis, args);
			schedulerHandles.add(handle);
			return handle;
		}
		return Reflect.apply(realTimeout, globalThis, args);
	}) as typeof setTimeout);
	vi.stubGlobal("clearTimeout", ((handle: Parameters<typeof clearTimeout>[0]) => {
		if (schedulerHandles.has(handle as ReturnType<typeof setTimeout>)) {
			schedulerHandles.delete(handle as ReturnType<typeof setTimeout>);
			return virtualClear(handle);
		}
		return realClearTimeout(handle);
	}) as typeof clearTimeout);
	vi.stubEnv("GITHUB_TOKEN", "");
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(tasks.splice(0));
	for (const app of apps.splice(0)) {
		app.librarySyncScheduler?.stop();
		await app.close();
	}
	vi.restoreAllMocks();
	for (const native of nativeFixtures.splice(0)) {
		const owned = nativeRows.get(native)!;
		await native.run(async () => {
			expect(
				(await native.prisma.serviceInstance.deleteMany({ where: { OR: owned.instances } })).count,
			).toBe(owned.instances.length);
			expect(
				await native.prisma.serviceInstance.count({
					where: { id: { in: owned.instances.map((row) => row.id) } },
				}),
			).toBe(0);
			expect(
				await native.prisma.librarySyncStatus.count({
					where: { id: { in: owned.statuses.map((row) => row.id) } },
				}),
			).toBe(0);
			expect(
				(
					await native.prisma.notificationSubscription.deleteMany({
						where: {
							OR: owned.subscriptions.map((row) => ({
								channelId: row.channelId,
								eventType: "LIBRARY_NEW_CONTENT",
								channel: { userId: row.userId },
							})),
						},
					})
				).count,
			).toBe(owned.subscriptions.length);
			expect(
				await native.prisma.notificationSubscription.count({
					where: {
						OR: owned.subscriptions.map((row) => ({
							channelId: row.channelId,
							eventType: "LIBRARY_NEW_CONTENT",
							channel: { userId: row.userId },
						})),
					},
				}),
			).toBe(0);
			expect(
				(await native.prisma.notificationChannel.deleteMany({ where: { OR: owned.channels } }))
					.count,
			).toBe(owned.channels.length);
			expect(
				await native.prisma.notificationChannel.count({
					where: { id: { in: owned.channels.map((row) => row.id) } },
				}),
			).toBe(0);
		});
		await native.close();
		nativeRows.delete(native);
	}
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});
const wantMetadata = {
	instance: "Synthetic library",
	service: "RADARR",
	itemCount: 7,
	items: ["Synthetic 1", "Synthetic 2", "Synthetic 3", "Synthetic 4", "Synthetic 5"],
};
const wantPayload = {
	eventType: "LIBRARY_NEW_CONTENT",
	title: "7 new download(s) on Synthetic library",
	body: "Synthetic 1, Synthetic 2, Synthetic 3, Synthetic 4, Synthetic 5 and 2 more",
	url: "https://synthetic.invalid/library",
	metadata: wantMetadata,
};
type Fixture = Awaited<ReturnType<typeof boot>>;
type Snapshot = Awaited<ReturnType<Fixture["outcome"]>>;
function assertNativeGraph(
	f: Fixture,
	snapshot: Snapshot,
	alias: string,
	state: "ready" | "sent" | "uncertain" | "submitting",
) {
	const owner = f.ownerRows[["synthetic-a", "synthetic-b", "synthetic-c"].indexOf(alias)]!;
	const events = snapshot.events.filter((row) => row.userId === owner.userId);
	const deliveries = snapshot.deliveries.filter((row) => row.userId === owner.userId);
	const history = snapshot.history.filter((row) => row.channelId === owner.channelId);
	expect(events).toHaveLength(1);
	expect(deliveries).toHaveLength(1);
	const event = events[0]!,
		delivery = deliveries[0]!;
	expect(event).toMatchObject({
		userId: owner.userId,
		eventType: "LIBRARY_NEW_CONTENT",
		stage: ["sent", "uncertain"].includes(state) ? "terminal" : "ready",
		dueAt: new Date(),
		acceptedAt: new Date(),
	});
	expect(event.encryptedPayload).not.toContain(wantPayload.title);
	expect(
		JSON.parse(f.native.encryptor.decrypt({ value: event.encryptedPayload, iv: event.payloadIv })),
	).toMatchObject({
		purpose: "arr-dashboard:notification-outbox-event",
		eventId: event.id,
		userId: owner.userId,
		acceptedAt: new Date().toISOString(),
		dueAt: new Date().toISOString(),
		policy: { stage: "ready" },
		payload: wantPayload,
		recipients: [
			{
				channelId: owner.channelId,
				channelType: "DISCORD",
				subscriptionEventType: "LIBRARY_NEW_CONTENT",
			},
		],
	});
	expect(delivery).toMatchObject({
		userId: owner.userId,
		eventId: event.id,
		channelId: owner.channelId,
		channelType: "DISCORD",
		subscriptionEventType: "LIBRARY_NEW_CONTENT",
		state,
		attemptOrdinal: 0,
		nextAttemptAt: new Date(),
	});
	if (state === "ready")
		expect(delivery).toMatchObject({
			attemptToken: null,
			workerEpoch: null,
			dispatchedAt: null,
			completedAt: null,
		});
	else {
		expect(delivery.attemptToken).toEqual(expect.any(String));
		expect(delivery.workerEpoch).toEqual(expect.any(String));
		expect(delivery.dispatchedAt).toEqual(new Date());
		expect(delivery.completedAt).toEqual(state === "submitting" ? null : new Date());
	}
	if (state === "sent") {
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			channelId: owner.channelId,
			eventType: "LIBRARY_NEW_CONTENT",
			title: wantPayload.title,
			body: wantPayload.body,
			status: "sent",
			retryCount: 0,
		});
		expect(snapshot.channels.find((row) => row.id === owner.channelId)).toMatchObject({
			lastSentAt: new Date(),
			lastSendResult: "success",
		});
	} else {
		expect(history).toEqual([]);
		expect(snapshot.channels.find((row) => row.id === owner.channelId)).toMatchObject({
			lastSentAt: null,
			lastSendResult: null,
		});
	}
}
function assertNoOwnerWork(f: Fixture, snapshot: Snapshot, alias: string) {
	const owner = f.ownerRows[["synthetic-a", "synthetic-b", "synthetic-c"].indexOf(alias)]!;
	expect(snapshot.events.filter((row) => row.userId === owner.userId)).toEqual([]);
	expect(snapshot.deliveries.filter((row) => row.userId === owner.userId)).toEqual([]);
	expect(snapshot.history.filter((row) => row.channelId === owner.channelId)).toEqual([]);
}

describe("Library Sync accepted tick, child sync and manual drain", () => {
	for (const origin of ["startup", "interval", "manual"] as const) {
		for (const phase of [
			"lookup",
			"reset",
			"execute",
			"subscription",
			"send",
			"log",
			"channel",
		] as const) {
			if (origin === "manual" && phase === "reset") continue;
			for (const reject of [false, true]) {
				it(`drains ${origin} ${phase} ${reject ? "failure" : "completion"} before teardown`, async () => {
					const gate = deferred();
					const f = await boot({ origin, hold: { phase, gate: gate.promise, reject } });
					const manual = f.launch();
					expect(await f.waitUntilHeld()).toBe(true);
					let closed = false;
					const close = f.app.close().then(() => {
						closed = true;
					});
					await f.closing;
					await settle();
					expect(closed).toBe(false);
					expect(f.state.teardown).toBe(0);
					gate.resolve();
					await close;
					await manual?.catch(() => undefined);
					expect(f.state.pendingAtTeardown).toBe(0);
					expect(f.state.afterTeardown).toBe(0);
					expect(f.state.forbidden).toBe(0);
					expect(f.state.network).toBe(0);
					expect(f.scheduler.getActiveSyncCount()).toBe(0);
					const snapshot = await f.outcome();
					assertNoOwnerWork(f, snapshot, "synthetic-b");
					if (["lookup", "reset", "execute"].includes(phase) && reject) {
						expect(f.executions).toEqual([]);
						assertNoOwnerWork(f, snapshot, "synthetic-a");
					} else {
						expect(f.executions).toEqual(["synthetic-a"]);
						if (phase === "subscription" && reject) assertNoOwnerWork(f, snapshot, "synthetic-a");
						else
							assertNativeGraph(
								f,
								snapshot,
								"synthetic-a",
								["lookup", "reset", "execute", "subscription"].includes(phase)
									? "ready"
									: !reject
										? "sent"
										: phase === "send"
											? "uncertain"
											: "submitting",
							);
					}
					if (["send", "log", "channel"].includes(phase)) {
						expect(f.events).toEqual([{ owner: "synthetic-a", metadata: wantMetadata }]);
						expect(f.payloads).toEqual([wantPayload]);
					} else expect(f.events).toEqual([]);
					if (phase === "reset")
						expect(
							snapshot.statuses.find((row) => row.instanceId === f.instanceId("synthetic-a"))
								?.syncInProgress,
						).toBe(reject);
					expect(snapshot.history).toHaveLength(
						["send", "log", "channel"].includes(phase) && !reject ? 1 : 0,
					);
				});
			}
		}
	}
	it("refuses terminal late callbacks, restart and manual admission", async () => {
		const f = await boot({ mode: "empty" });
		const old = f.initial();
		await f.app.close();
		old();
		f.scheduler.start(f.app);
		old();
		await expect(f.manualSync()).rejects.toThrow("shutting down");
		await f.idle();
		expect(f.state.lookup).toBe(0);
		expect(f.state.afterTeardown).toBe(0);
	});
	it("keeps ordinary stop/restart but fences old startup callbacks", async () => {
		const f = await boot({ mode: "empty" });
		const old = f.initial();
		f.scheduler.stop();
		f.scheduler.start(f.app);
		old();
		await f.idle();
		expect(f.state.lookup).toBe(0);
		await vi.advanceTimersByTimeAsync(60_000);
		await f.idle();
		expect(f.state.lookup).toBe(1);
		old();
		await f.idle();
		expect(f.state.lookup).toBe(1);
		expect((await f.outcome()).events).toEqual([]);
	});
	it("preserves startup delay and minute cadence without duplicate start", async () => {
		const f = await boot({ mode: "empty" });
		f.scheduler.start(f.app);
		await vi.advanceTimersByTimeAsync(59_999);
		expect(f.state.lookup).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		await f.idle();
		expect(f.state.lookup).toBe(1);
		await vi.advanceTimersByTimeAsync(59_999);
		expect(f.state.lookup).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await f.idle();
		expect(f.state.lookup).toBe(2);
		expect((await f.outcome()).events).toEqual([]);
	});
	it("releases every reserved child when native admission closes after candidate lookup", async () => {
		const f = await boot({ mode: "two", closeAdmissionAfterLookup: true });
		f.launch();
		await f.idle();
		expect(f.state.lookup).toBe(1);
		expect(f.state.execute).toBe(0);
		expect(f.executions).toEqual([]);
		expect(f.events).toEqual([]);
		expect(f.scheduler.getActiveSyncCount()).toBe(0);
		for (const alias of ["synthetic-a", "synthetic-b", "synthetic-c"])
			expect(f.scheduler.isInstanceSyncing(f.instanceId(alias))).toBe(false);
		expect(f.app.schedulerRegistry.getStatus(JOB_ID.librarySync)?.state).toBe("idle");
		await expect(f.manualSync()).rejects.toMatchObject({ name: "RestoreRuntimeAdmissionError" });
		await withCleanupMaintenanceGuard(async () => {});
		await f.app.close();
		// Observation/cleanup never repairs closed authority. Join the old actor,
		// then use the fixture's ordinary restart to inspect the conserved database.
		await f.native.restart();
		const snapshot = await f.outcome();
		expect(snapshot.events).toEqual([]);
		expect(snapshot.deliveries).toEqual([]);
		expect(snapshot.history).toEqual([]);
	});
	it("retains both parallel child syncs and truthful registry duration until both finish", async () => {
		const gate = deferred();
		const f = await boot({ mode: "two", hold: { phase: "execute", gate: gate.promise } });
		f.launch();
		expect(await f.waitUntilHeld()).toBe(true);
		expect(
			await waitForNative(
				() =>
					f.executionEntries.length === 2 &&
					f.executions.length === 1 &&
					f.events.length === 1 &&
					f.statuses.length === 1,
			),
		).toBe(true);
		const completed = f.executions[0]!;
		const held = f.executionEntries.find((alias) => alias !== completed)!;
		expect(["synthetic-a", "synthetic-b", "synthetic-c"]).toContain(completed);
		expect(["synthetic-a", "synthetic-b", "synthetic-c"]).toContain(held);
		expect(held).not.toBe(completed);
		expect(f.state.execute).toBe(2);
		expect(f.app.schedulerRegistry.getStatus(JOB_ID.librarySync)?.state).toBe("running");
		let closed = 0;
		const closes = [f.app.close(), f.app.close()].map((p) =>
			p.then(() => {
				closed++;
			}),
		);
		await f.closing;
		await settle();
		expect(closed).toBe(0);
		await expect(withCleanupMaintenanceGuard(async () => {})).rejects.toThrow("maintenance");
		gate.resolve();
		await Promise.all(closes);
		expect(f.executions.slice().sort()).toEqual([completed, held].sort());
		expect(f.events).toEqual([{ owner: completed, metadata: wantMetadata }]);
		const snapshot = await f.outcome();
		assertNativeGraph(f, snapshot, completed, "sent");
		assertNativeGraph(f, snapshot, held, "ready");
		const excluded = ["synthetic-a", "synthetic-b", "synthetic-c"].find(
			(alias) => ![completed, held].includes(alias),
		)!;
		assertNoOwnerWork(f, snapshot, excluded);
		expect(f.state.teardown).toBe(1);
		expect(f.state.afterTeardown).toBe(0);
		await withCleanupMaintenanceGuard(async () => {});
	});
	it("retains siblings after a child rejects instead of releasing the parent producer early", async () => {
		const gate = deferred();
		const f = await boot({ mode: "two", hold: { phase: "execute", gate: gate.promise } });
		let failedOwner = "";
		vi.mocked(executor.syncInstance).mockImplementationOnce(async (deps, instance) => {
			expect(deps.prisma).toBe(f.prisma);
			failedOwner = f.aliasFor(instance.userId);
			throw new Error("Synthetic first-child failure");
		});
		f.launch();
		expect(await f.waitUntilHeld()).toBe(true);
		expect(f.executionEntries).toHaveLength(1);
		const held = f.executionEntries[0]!;
		expect(held).not.toBe(failedOwner);
		expect(["synthetic-a", "synthetic-b", "synthetic-c"]).toContain(held);
		const close = f.app.close();
		await f.closing;
		await settle();
		expect(f.state.teardown).toBe(0);
		expect(f.app.schedulerRegistry.getStatus(JOB_ID.librarySync)?.state).toBe("running");
		await expect(withCleanupMaintenanceGuard(async () => {})).rejects.toThrow("maintenance");
		gate.resolve();
		await close;
		expect(f.executions).toEqual([held]);
		expect(f.events).toEqual([]);
		const snapshot = await f.outcome();
		assertNativeGraph(f, snapshot, held, "ready");
		for (const alias of ["synthetic-a", "synthetic-b", "synthetic-c"].filter(
			(alias) => alias !== held,
		))
			assertNoOwnerWork(f, snapshot, alias);
		expect(f.state.afterTeardown).toBe(0);
	});
	it("keeps status running when a quick overlapping tick finishes before a held sync", async () => {
		const gate = deferred();
		const f = await boot({ hold: { phase: "execute", gate: gate.promise } });
		f.launch();
		expect(await f.waitUntilHeld()).toBe(true);
		f.periodic()();
		expect(await waitForNative(() => f.state.lookup === 2 && f.pending().size === 1)).toBe(true);
		expect(f.scheduler.getActiveSyncCount()).toBe(1);
		expect(f.app.schedulerRegistry.getStatus(JOB_ID.librarySync)?.state).toBe("running");
		gate.resolve();
		await f.idle();
		expect(f.scheduler.getActiveSyncCount()).toBe(0);
		expect(f.app.schedulerRegistry.getStatus(JOB_ID.librarySync)?.state).toBe("idle");
		assertNativeGraph(f, await f.outcome(), "synthetic-a", "sent");
	});
	it.each(["large", "cold"] as const)(
		"keeps %s adaptive capacity bounded while a child is held",
		async (mode) => {
			const gate = deferred();
			const f = await boot({ mode, hold: { phase: "execute", gate: gate.promise } });
			f.launch();
			expect(await f.waitUntilHeld()).toBe(true);
			expect(f.scheduler.getActiveSyncCount()).toBe(1);
			expect(f.state.execute).toBe(1);
			const selected = f.executionEntries[0]!;
			expect(["synthetic-a", "synthetic-b", "synthetic-c"]).toContain(selected);
			const before = await f.outcome();
			for (const status of before.statuses)
				if (mode === "large") expect(status.itemCount).toBe(10_000);
				else expect(status.lastFullSync).toBe(null);
			gate.resolve();
			await f.idle();
			expect(f.scheduler.getActiveSyncCount()).toBe(0);
			expect(f.executions).toEqual([selected]);
			const after = await f.outcome();
			assertNativeGraph(f, after, selected, "sent");
			for (const alias of ["synthetic-a", "synthetic-b", "synthetic-c"].filter(
				(alias) => alias !== selected,
			))
				assertNoOwnerWork(f, after, alias);
		},
	);
	it("keeps a pending manual reservation visible and rejects duplicate lookup", async () => {
		const gate = deferred();
		const f = await boot({
			origin: "manual",
			mode: "two",
			hold: { phase: "lookup", gate: gate.promise },
		});
		const manual = f.launch();
		expect(await f.waitUntilHeld()).toBe(true);
		expect(f.scheduler.isInstanceSyncing(f.instanceId("synthetic-a"))).toBe(true);
		await expect(f.manualSync()).resolves.toBeNull();
		expect(f.state.lookup).toBe(1);
		// Unknown manual size is conservatively reserved before native lookup.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(await waitForNative(() => f.state.lookup === 2 && f.pending().size === 1)).toBe(true);
		expect(f.state.execute).toBe(0);
		expect(f.scheduler.getActiveSyncCount()).toBe(1);
		await expect(withCleanupMaintenanceGuard(async () => {})).rejects.toThrow("maintenance");
		gate.resolve();
		await manual;
		await f.idle();
		expect(f.scheduler.getActiveSyncCount()).toBe(0);
		assertNativeGraph(f, await f.outcome(), "synthetic-a", "sent");
	});
	it("keeps manual lookup rejection and releases its reservation for retry", async () => {
		const gate = deferred();
		const f = await boot({
			origin: "manual",
			hold: { phase: "lookup", gate: gate.promise, reject: true },
		});
		const manual = f.launch();
		expect(await f.waitUntilHeld()).toBe(true);
		gate.resolve();
		await expect(manual).rejects.toThrow("Synthetic sync dependency failure");
		expect(f.scheduler.getActiveSyncCount()).toBe(0);
		const retry = await f.manualSync();
		expect(retry).toMatchObject({
			success: true,
			itemsProcessed: 7,
			itemsAdded: 7,
			itemsUpdated: 0,
			itemsRemoved: 0,
			durationMs: 1,
		});
		expect(f.executions).toEqual(["synthetic-a"]);
		assertNativeGraph(f, await f.outcome(), "synthetic-a", "sent");
	});
	it.each(["empty", "polling-off", "fresh"] as const)(
		"does not publish new-download success for %s scans",
		async (mode) => {
			const f = await boot({ mode });
			f.launch();
			await f.idle();
			expect(f.executions).toEqual([]);
			expect(f.events).toEqual([]);
			const snapshot = await f.outcome();
			expect(snapshot.events).toEqual([]);
			expect(snapshot.deliveries).toEqual([]);
			expect(snapshot.history).toEqual([]);
			assertNoOwnerWork(f, snapshot, "synthetic-b");
		},
	);
	it.each(["missing", "non-library"] as const)(
		"does not execute %s manual requests",
		async (mode) => {
			const f = await boot({ origin: "manual", mode });
			await expect(f.launch()).resolves.toBeNull();
			expect(f.executions).toEqual([]);
			expect(f.events).toEqual([]);
			expect((await f.outcome()).events).toEqual([]);
		},
	);
	it("keeps a returned failed result truthful without success notification", async () => {
		const f = await boot({ origin: "manual", mode: "failed" });
		const result = await f.launch();
		expect(result?.success).toBe(false);
		expect(result?.error).toBe("Synthetic cache scan failed");
		expect(f.events).toEqual([]);
		const snapshot = await f.outcome();
		expect(snapshot.events).toEqual([]);
		expect(snapshot.deliveries).toEqual([]);
		expect(snapshot.history).toEqual([]);
	});
	it("retains maintenance exclusion during accepted lookup and child execution", async () => {
		const gate = deferred();
		const f = await boot({ hold: { phase: "execute", gate: gate.promise } });
		f.launch();
		expect(await f.waitUntilHeld()).toBe(true);
		await expect(withCleanupMaintenanceGuard(async () => {})).rejects.toThrow("maintenance");
		gate.resolve();
		await f.idle();
		await withCleanupMaintenanceGuard(async () => {});
		assertNativeGraph(f, await f.outcome(), "synthetic-a", "sent");
	});
});
