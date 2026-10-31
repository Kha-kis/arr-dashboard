import { AsyncResource } from "node:async_hooks";
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
import { MAX_HUNT_DURATION_MS } from "../../lib/hunting/constants.js";
import { getHuntingScheduler } from "../../lib/hunting/scheduler.js";
import { withCleanupMaintenanceGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { NotificationDispatcher } from "../../lib/notifications/notification-dispatcher.js";
import type { NotificationPayload } from "../../lib/notifications/types.js";
import huntingPlugin from "../hunting-scheduler.js";
import notificationPlugin from "../notification-service.js";
import registryPlugin from "../scheduler-registry.js";

// Native SQL, runtime, bootstrap, producer, outbox and crypto are real.
// Only ARR execution and outbound notification transport are synthetic.
const executor = vi.hoisted(() => vi.fn());
vi.mock("../../lib/hunting/hunt-executor.js", () => ({ executeHuntWithSdk: executor }));
type Origin = "manual" | "scheduled";
type Phase =
	| "lookup"
	| "executor"
	| "result"
	| "subscription"
	| "send"
	| "log"
	| "channel"
	| "bookkeeping";
type Outcome = "completed" | "found" | "error" | "throw" | "skipped";
type AwaitOnly<T> = T extends (...args: infer A) => unknown
	? (...args: A) => PromiseLike<unknown>
	: never;
const apps: FastifyInstance[] = [],
	releases: Array<() => void> = [];
const fixtures: Array<{ dispose: () => Promise<void> }> = [];
const realTimeout = globalThis.setTimeout,
	realClearTimeout = globalThis.clearTimeout,
	realInterval = globalThis.setInterval,
	realClearInterval = globalThis.clearInterval,
	realDate = Date;
type Timer = {
	kind: "timeout" | "interval";
	delay: number;
	dueAt: number;
	callback: () => void;
	handle: ReturnType<typeof setTimeout>;
};
const installed: Timer[] = [],
	activeTimers = new Map<ReturnType<typeof setTimeout>, Timer>();
let virtualNow = () => realDate.now();
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
async function waitForNative(condition: () => boolean) {
	const deadline = performance.now() + 4_000;
	while (!condition()) {
		if (performance.now() >= deadline) return false;
		await settle();
	}
	return true;
}
async function boot(
	options: {
		origin?: Origin;
		type?: "missing" | "upgrade";
		outcome?: Outcome;
		hold?: { phase: Phase; gate: Promise<void>; reject?: boolean };
	} = {},
) {
	const native = await createNotificationOutboxNativeFixture();
	let normalDispose: (() => Promise<void>) | undefined;
	fixtures.push({ dispose: () => (normalDispose ? normalDispose() : native.close()) });
	// Capture native lineage before admission, independently of the outbox graph.
	const expectedRestoreBinding = await native.run(() =>
		native.prisma.restoreRuntimeControl.findUniqueOrThrow({
			where: { id: 1 },
			select: { lastCommittedRestoreId: true },
		}),
	);
	const owners = [
		{ userId: native.userId, channelId: native.channelId },
		await native.createOwner(),
	];
	const destinations = [
		"https://example.invalid/synthetic-hunt/selected",
		"https://example.invalid/synthetic-hunt/foreign",
	];
	const type = options.type ?? "missing",
		outcome = options.outcome ?? "completed";
	const allowedEvents = ["HUNT_COMPLETED", "HUNT_CONTENT_FOUND", "HUNT_FAILED"] as const;
	const seeded = await native.run(async () => {
		for (const [index, owner] of owners.entries()) {
			const encrypted = native.encryptor.encrypt(
				JSON.stringify({
					webhookUrl: destinations[index],
				}),
			);
			await native.prisma.notificationChannel.update({
				where: { id: owner.channelId, userId: owner.userId },
				data: { encryptedConfig: encrypted.value, configIv: encrypted.iv },
			});
			for (const eventType of ["HUNT_CONTENT_FOUND", "HUNT_FAILED"] as const)
				await native.prisma.notificationSubscription.create({
					data: { channelId: owner.channelId, eventType },
				});
		}
		const rows = [];
		for (const [index, owner] of owners.entries()) {
			const key = native.encryptor.encrypt("synthetic-hunting-key");
			const instance = await native.prisma.serviceInstance.create({
				data: {
					userId: owner.userId,
					service: "RADARR",
					label: "Same synthetic label",
					baseUrl: "https://example.invalid/synthetic-hunt",
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
				},
			});
			rows.push(
				await native.prisma.huntConfig.create({
					data: {
						instanceId: instance.id,
						huntMissingEnabled: index === 0 && options.origin === "scheduled" && type === "missing",
						huntUpgradesEnabled:
							index === 0 && options.origin === "scheduled" && type === "upgrade",
						missingIntervalMins: 15,
						upgradeIntervalMins: 30,
						apiCallsThisHour: index === 0 ? 0 : 7,
						hourlyApiCap: 100,
						apiCallsResetAt: new Date(virtualNow() + 3_600_000),
					},
					include: { instance: true },
				}),
			);
		}
		return {
			configs: rows,
			channels: await native.prisma.notificationChannel.findMany({
				where: { userId: { in: owners.map((owner) => owner.userId) } },
			}),
		};
	});
	const config = seeded.configs[0]!,
		sibling = seeded.configs[1]!;
	await native.restart(false);
	const client = createRuntimePrismaClient(native.runtime),
		prisma = client.prisma;
	const counts: Record<Phase, number> = {
		lookup: 0,
		executor: 0,
		result: 0,
		subscription: 0,
		send: 0,
		log: 0,
		channel: 0,
		bookkeeping: 0,
	};
	const state = { pending: 0, disconnected: false, afterTeardown: 0, held: false };
	let recovering = false;
	const boundaryErrors: unknown[] = [];
	function protect<A extends unknown[], R>(fn: (...args: A) => PromiseLike<R> | R) {
		return (...args: A): Promise<R> =>
			Promise.resolve()
				.then(() => fn(...args))
				.catch((error) => {
					if (
						!(
							error instanceof Error &&
							["Synthetic boundary unavailable", "Synthetic hunt unavailable"].includes(
								error.message,
							)
						)
					)
						boundaryErrors.push(error);
					throw error;
				});
	}
	const observe = async <T>(phase: Phase, work: () => PromiseLike<T> | T): Promise<T> => {
		const call = ++counts[phase];
		if (state.disconnected && !(recovering && phase === "send")) state.afterTeardown++;
		state.pending++;
		try {
			if (options.hold?.phase === phase && call === 1) {
				state.held = true;
				await options.hold.gate;
				state.held = false;
				if (options.hold.reject) throw new Error("Synthetic boundary unavailable");
			}
			return await work();
		} finally {
			if (state.disconnected && !(recovering && phase === "send")) state.afterTeardown++;
			state.pending--;
		}
	};
	const expectedPayloads: NotificationPayload[] = [],
		resultRows: Array<{ id: string; status: string; durationMs: number; message: string }> = [];
	const sent: Array<{ eventType: string; owner: string }> = [],
		logs: string[] = [],
		outcomes: string[] = [];
	const lookupTimes: number[] = [];
	const wantPayload = (durationMs: number, failed = false): NotificationPayload => ({
		eventType:
			failed || outcome === "error"
				? "HUNT_FAILED"
				: outcome === "found"
					? "HUNT_CONTENT_FOUND"
					: "HUNT_COMPLETED",
		title:
			outcome === "found" && !failed
				? "Hunt found 1 item(s) on Same synthetic label"
				: failed || outcome === "error"
					? "Hunt failed on Same synthetic label"
					: "Hunt completed on Same synthetic label",
		body: failed
			? outcome === "throw"
				? "Synthetic hunt unavailable"
				: "Hunt timed out after 600 seconds"
			: "Synthetic outcome",
		url: "https://synthetic.invalid/hunting",
		metadata: {
			instance: "Same synthetic label",
			service: "RADARR",
			huntType: type,
			durationMs,
			...(!failed
				? {
						itemsSearched: 1,
						itemsGrabbed: outcome === "found" ? 1 : 0,
						apiCalls: 1,
						grabbedItems: [],
					}
				: {}),
		},
	});
	vi.spyOn(NotificationDispatcher.prototype, "send").mockImplementation(
		protect(async (channelType, recipient, payload) => {
			expect(channelType).toBe("DISCORD");
			expect(recipient).toEqual({ webhookUrl: destinations[0] });
			expect(payload).toEqual(expectedPayloads[sent.length]);
			return observe("send", () => {
				sent.push({ eventType: payload.eventType, owner: owners[0]!.userId });
				return { success: true, retryable: false };
			});
		}),
	);
	const lookup = prisma.huntConfig.findUnique.bind(prisma.huntConfig);
	const configDelegate: {
		findUnique: AwaitOnly<typeof prisma.huntConfig.findUnique>;
		update: AwaitOnly<typeof prisma.huntConfig.update>;
	} = prisma.huntConfig;
	vi.spyOn(configDelegate, "findUnique").mockImplementation(
		protect((args) => {
			expect(args).toEqual({
				where: { instanceId: config.instanceId },
				include: { instance: true },
			});
			lookupTimes.push(virtualNow());
			return observe("lookup", async () => {
				const row = await lookup({ ...args, include: { instance: true } });
				expect(row).toMatchObject({
					instanceId: config.instanceId,
					instance: config.instance,
					missingIntervalMins: 15,
					upgradeIntervalMins: 30,
					hourlyApiCap: 100,
				});
				return row;
			});
		}),
	);
	const bookkeeping = prisma.huntConfig.update.bind(prisma.huntConfig);
	vi.spyOn(configDelegate, "update").mockImplementation(
		protect((args) => {
			expect(args!.where).toEqual({ id: config.id });
			expect(args!.data).toEqual({
				apiCallsThisHour: { increment: 1 },
				[type === "upgrade" ? "lastUpgradeHunt" : "lastMissingHunt"]: new Date(virtualNow()),
			});
			return observe("bookkeeping", () => bookkeeping(args));
		}),
	);
	const count = prisma.huntConfig.count.bind(prisma.huntConfig);
	const countDelegate: { count: AwaitOnly<typeof prisma.huntConfig.count> } = prisma.huntConfig;
	vi.spyOn(countDelegate, "count").mockImplementation(
		protect(async (args) => {
			expect(args).toEqual({
				where: { OR: [{ huntMissingEnabled: true }, { huntUpgradesEnabled: true }] },
			});
			const result = await count(args);
			expect(result).toBe(options.origin === "scheduled" ? 1 : 0);
			return result;
		}),
	);
	const findConfigs = prisma.huntConfig.findMany.bind(prisma.huntConfig);
	const manyDelegate: { findMany: AwaitOnly<typeof prisma.huntConfig.findMany> } =
		prisma.huntConfig;
	vi.spyOn(manyDelegate, "findMany").mockImplementation(
		protect(async (args) => {
			const now = new Date(virtualNow());
			expect(args).toEqual(
				args?.select
					? {
							where: {
								OR: [{ huntMissingEnabled: true }, { huntUpgradesEnabled: true }],
								apiCallsResetAt: { lt: now },
							},
							select: { id: true, apiCallsResetAt: true },
						}
					: {
							where: { OR: [{ huntMissingEnabled: true }, { huntUpgradesEnabled: true }] },
							include: { instance: true },
						},
			);
			return findConfigs({ ...args, ...(args?.include ? { include: { instance: true } } : {}) });
		}),
	);
	const startupRead = prisma.huntLog.findMany.bind(prisma.huntLog);
	let startupCompleted = false;
	const huntLogs: {
		findMany: AwaitOnly<typeof prisma.huntLog.findMany>;
		create: AwaitOnly<typeof prisma.huntLog.create>;
		update: AwaitOnly<typeof prisma.huntLog.update>;
	} = prisma.huntLog;
	vi.spyOn(huntLogs, "findMany").mockImplementation(
		protect(async (args) => {
			expect(args).toEqual({ where: { status: "running" } });
			const result = await startupRead(args);
			expect(result).toEqual([]);
			startupCompleted = true;
			return result;
		}),
	);
	const createLog = prisma.huntLog.create.bind(prisma.huntLog);
	vi.spyOn(huntLogs, "create").mockImplementation(
		protect((args) => {
			expect(args.data).toEqual({
				instanceId: config.instanceId,
				huntType: type,
				status: "running",
				itemsSearched: 0,
				itemsFound: 0,
			});
			return createLog(args);
		}),
	);
	const updateLog = prisma.huntLog.update.bind(prisma.huntLog);
	vi.spyOn(huntLogs, "update").mockImplementation(
		protect((args) => {
			const duration = virtualNow() - lookupTimes[counts.lookup - 1]!;
			const failed = outcome === "throw" || (state.held && options.hold?.phase === "executor");
			const status =
				failed || outcome === "error" ? "error" : outcome === "skipped" ? "skipped" : "completed";
			const message = failed
				? outcome === "throw"
					? "Synthetic hunt unavailable"
					: "Hunt timed out after 600 seconds"
				: "Synthetic outcome";
			expect(args.data).toEqual({
				status,
				message,
				durationMs: duration,
				completedAt: new Date(virtualNow()),
				...(!failed
					? {
							itemsSearched: 1,
							itemsFound: outcome === "found" ? 1 : 0,
							searchedItems: null,
							foundItems: null,
						}
					: {}),
			});
			return observe("result", async () => {
				const row = await updateLog(args);
				expect(row.instanceId).toBe(config.instanceId);
				resultRows.push({ id: row.id, status, durationMs: duration, message });
				outcomes.push(status);
				if (
					outcome !== "skipped" &&
					!(options.hold?.phase === "subscription" && options.hold.reject && counts.result === 1)
				)
					expectedPayloads.push(wantPayload(duration, failed));
				return row;
			});
		}),
	);
	const subscriptions = prisma.notificationSubscription.findMany.bind(
		prisma.notificationSubscription,
	);
	const subscriptionDelegate: {
		findMany: AwaitOnly<typeof prisma.notificationSubscription.findMany>;
	} = prisma.notificationSubscription;
	vi.spyOn(subscriptionDelegate, "findMany").mockImplementation(
		protect((args) => {
			expect(allowedEvents).toContain(args?.where?.eventType);
			expect(args).toEqual({
				where: { eventType: args?.where?.eventType, channel: { userId: owners[0]!.userId } },
				include: { channel: true },
			});
			return observe("subscription", async () => {
				const rows = await subscriptions({ ...args, include: { channel: true } });
				expect(
					rows.map((row) => ({ channelId: row.channelId, userId: row.channel.userId })),
				).toEqual([{ channelId: owners[0]!.channelId, userId: owners[0]!.userId }]);
				return rows;
			});
		}),
	);
	const transaction = prisma.$transaction.bind(prisma);
	vi.spyOn(prisma, "$transaction").mockImplementation(
		protect((operation, transactionOptions) =>
			transaction(async (tx) => {
				const historyWrite = tx.notificationLog.create.bind(tx.notificationLog);
				const historyDelegate: { create: AwaitOnly<typeof tx.notificationLog.create> } =
					tx.notificationLog;
				vi.spyOn(historyDelegate, "create").mockImplementation(
					protect((args) => {
						expect(args.data.channelId).toBe(owners[0]!.channelId);
						expect(args.data.status).toBe("sent");
						return observe("log", () => historyWrite(args));
					}),
				);
				const channelWrite = tx.notificationChannel.updateMany.bind(tx.notificationChannel);
				const channelDelegate: { updateMany: AwaitOnly<typeof tx.notificationChannel.updateMany> } =
					tx.notificationChannel;
				vi.spyOn(channelDelegate, "updateMany").mockImplementation(
					protect((args) => {
						const selected = seeded.channels.find((row) => row.id === args?.where?.id)!;
						expect(selected?.userId).toBe(owners[0]!.userId);
						if (args.data.id !== undefined) {
							expect(args).toEqual({
								where: { id: selected.id, userId: selected.userId },
								data: { id: selected.id },
							});
							return channelWrite(args);
						}
						expect(args.where).toEqual({
							id: selected.id,
							userId: selected.userId,
							type: selected.type,
							encryptedConfig: selected.encryptedConfig,
							configIv: selected.configIv,
						});
						expect(args.data.lastSentAt).toBeInstanceOf(Date);
						expect(args.data.lastSendResult).toBe("success");
						return observe("channel", () => channelWrite(args));
					}),
				);
				return operation(tx);
			}, transactionOptions),
		),
	);
	executor.mockImplementation(
		protect(async (_app, instance, selectedConfig, selectedType) => {
			expect(_app.restoreRuntime === native.runtime).toBe(true);
			expect(_app.prisma === prisma).toBe(true);
			expect(_app.encryptor === native.encryptor).toBe(true);
			expect(_app.notificationService === app.notificationService).toBe(true);
			expect(instance).toEqual(config.instance);
			const {
				instance: _instance,
				updatedAt: _updated,
				lastMissingHunt: _missing,
				lastUpgradeHunt: _upgrade,
				...plainConfig
			} = config;
			expect(selectedConfig).toMatchObject({
				...plainConfig,
				apiCallsThisHour: counts.bookkeeping,
			});
			expect(selectedType).toBe(type);
			return observe("executor", () => {
				if (outcome === "throw") throw new Error("Synthetic hunt unavailable");
				return {
					itemsSearched: 1,
					itemsGrabbed: outcome === "found" ? 1 : 0,
					searchedItems: [],
					grabbedItems: [],
					message: "Synthetic outcome",
					status: outcome === "error" ? "error" : outcome === "skipped" ? "skipped" : "completed",
					apiCallsMade: 1,
				};
			});
		}),
	);
	const app = Fastify({ logger: false });
	apps.push(app);
	app.decorate("restoreRuntime", native.runtime);
	await app.register(
		fp(
			async (server) => {
				server.decorate("prisma", prisma);
				server.decorate("dbProvider", native.engine as "sqlite" | "postgresql");
				server.addHook("onClose", async () => {
					expect(state.pending).toBe(0);
					await client.close();
					state.disconnected = true;
				});
			},
			{ name: "prisma" },
		),
	);
	await app.register(
		fp(
			async (server) => {
				server.decorate("config", { APP_URL: "https://synthetic.invalid" } as never);
				server.decorate("encryptor", native.encryptor);
			},
			{ name: "security" },
		),
	);
	registerRestoreBootstrapPlugin(app, notificationPlugin);
	registerRestoreBootstrapPlugin(app, registryPlugin);
	await app.after();
	const register = app.register.bind(app);
	let selected = 0;
	const interception = vi
		.spyOn(app, "register")
		.mockImplementation((plugin: unknown, ...args: unknown[]) => {
			if (
				typeof plugin === "function" &&
				Reflect.get(plugin, Symbol.for("fastify.display-name")) ===
					Reflect.get(huntingPlugin, Symbol.for("fastify.display-name"))
			) {
				expect(plugin).not.toBe(huntingPlugin);
				expect(Reflect.get(plugin, Symbol.for("plugin-meta"))).toEqual(
					Reflect.get(huntingPlugin, Symbol.for("plugin-meta")),
				);
				selected++;
				return Reflect.apply(register, app, [plugin, ...args]);
			}
			return app;
		});
	try {
		registerSchedulers(app);
		expect(selected).toBe(1);
	} finally {
		interception.mockRestore();
	}
	await app.after();
	registerRestoreRuntimeActivation(app);
	const preClosed = deferred();
	app.addHook("preClose", async () => preClosed.resolve());
	await app.ready();
	expect(await waitForNative(() => startupCompleted)).toBe(true);
	await native.runtime.drain();
	const scheduler = getHuntingScheduler();
	const idle = async () => {
		await app.notificationService.drain();
		await native.runtime.drain();
		expect(await waitForNative(() => state.pending === 0)).toBe(true);
	};
	const waitPhase = async (phase: Phase, call = 1) => {
		expect(await waitForNative(() => counts[phase] >= call && state.pending > 0)).toBe(true);
	};
	const advance = async (ms: number) => {
		const target = virtualNow() + ms;
		do {
			const due = Math.min(...[...activeTimers.values()].map((row) => row.dueAt));
			await vi.advanceTimersByTimeAsync(Math.max(0, Math.min(target, due) - virtualNow()));
			let drained = false;
			const drain = native.runtime.drain().then(() => {
				drained = true;
			});
			expect(await waitForNative(() => drained || (state.held && state.pending > 0))).toBe(true);
			if (drained) {
				await drain;
				await idle();
			}
		} while (virtualNow() < target);
	};
	const graph = () =>
		native.run(async () => ({
			events: await native.prisma.notificationOutboxEvent.findMany({
				where: { userId: { in: owners.map((owner) => owner.userId) } },
				orderBy: { acceptedAt: "asc" },
			}),
			deliveries: await native.prisma.notificationOutboxDelivery.findMany({
				where: { userId: { in: owners.map((owner) => owner.userId) } },
			}),
			history: await native.prisma.notificationLog.findMany({
				where: { channelId: { in: owners.map((owner) => owner.channelId) } },
				orderBy: { sentAt: "asc" },
			}),
			channels: await native.prisma.notificationChannel.findMany({
				where: { userId: { in: owners.map((owner) => owner.userId) } },
			}),
		}));
	const assertGraph = async (states: Array<"ready" | "sent">) => {
		const result = await graph();
		expect(result.events).toHaveLength(states.length);
		expect(result.deliveries).toHaveLength(states.length);
		expect(result.history).toHaveLength(states.filter((value) => value === "sent").length);
		for (const [index, status] of states.entries()) {
			const payload = expectedPayloads[index]!,
				event = result.events[index]!;
			expect(event).toMatchObject({
				userId: owners[0]!.userId,
				eventType: payload.eventType,
				stage: status === "sent" ? "terminal" : "ready",
				destinationInstallationId: "synthetic-notification-outbox-destination",
				restoreCommitId: expectedRestoreBinding.lastCommittedRestoreId,
				aggregationWindowSeconds: null,
				maxBatchSize: null,
				aggregateParentId: null,
			});
			expect(event.dueAt).toEqual(event.acceptedAt);
			expect(event.encryptedPayload).not.toContain("Synthetic");
			expect(
				JSON.parse(
					native.encryptor.decrypt({ value: event.encryptedPayload, iv: event.payloadIv }),
				),
			).toEqual({
				purpose: "arr-dashboard:notification-outbox-event",
				version: 1,
				eventId: event.id,
				userId: owners[0]!.userId,
				payload,
				recipients: [
					{
						channelId: owners[0]!.channelId,
						channelType: "DISCORD",
						subscriptionEventType: payload.eventType,
					},
				],
				fallbackEventTypes: [],
				policy: { stage: "ready" },
				acceptedAt: event.acceptedAt.toISOString(),
				dueAt: event.dueAt.toISOString(),
				destinationInstallationId: "synthetic-notification-outbox-destination",
				restoreCommitId: expectedRestoreBinding.lastCommittedRestoreId,
			});
			const delivery = result.deliveries.find((row) => row.eventId === event.id)!;
			expect(delivery).toMatchObject({
				userId: owners[0]!.userId,
				channelId: owners[0]!.channelId,
				channelType: "DISCORD",
				subscriptionEventType: payload.eventType,
				state: status,
				attemptOrdinal: 0,
				nextAttemptAt: event.dueAt,
			});
			expect(delivery).toMatchObject(
				status === "ready"
					? {
							attemptToken: null,
							workerEpoch: null,
							attemptConfigFingerprint: null,
							dispatchedAt: null,
							completedAt: null,
							outcomeCategory: null,
						}
					: {
							attemptToken: expect.any(String),
							workerEpoch: expect.any(String),
							attemptConfigFingerprint: expect.any(String),
							dispatchedAt: expect.any(Date),
							completedAt: expect.any(Date),
							outcomeCategory: "acknowledged",
						},
			);
			if (status === "sent")
				expect(
					result.history.filter(
						(row) => row.channelId === owners[0]!.channelId && row.eventType === payload.eventType,
					)[index],
				).toMatchObject({
					channelId: owners[0]!.channelId,
					channelType: "DISCORD",
					eventType: payload.eventType,
					title: payload.title,
					body: payload.body,
					status: "sent",
					retryCount: 0,
					error: null,
				});
		}
		for (const [index, owner] of owners.entries())
			expect(result.channels.find((row) => row.id === owner.channelId)).toMatchObject({
				userId: owner.userId,
				lastSentAt: index === 0 && states.includes("sent") ? expect.any(Date) : null,
				lastSendResult: index === 0 && states.includes("sent") ? "success" : null,
			});
		logs.splice(0, logs.length, ...result.history.map((row) => row.status));
		return result;
	};
	const assertPersisted = () =>
		native.run(async () => {
			const rows = await native.prisma.huntLog.findMany({
				where: { instanceId: config.instanceId },
				orderBy: { startedAt: "asc" },
			});
			expect(rows).toHaveLength(resultRows.length);
			for (const expected of resultRows) {
				expect(rows.find((row) => row.id === expected.id)).toMatchObject({
					...expected,
					instanceId: config.instanceId,
					huntType: type,
					itemsSearched: outcome === "throw" || expected.message.includes("timed out") ? 0 : 1,
					itemsFound: outcome === "found" ? 1 : 0,
					searchedItems: null,
					foundItems: null,
					completedAt: expect.any(Date),
				});
			}
			expect(
				await native.prisma.huntConfig.findUnique({
					where: { id: sibling.id },
					include: { instance: true },
				}),
			).toEqual(sibling);
			expect(await native.prisma.huntLog.count({ where: { instanceId: sibling.instanceId } })).toBe(
				0,
			);
			const updated = await native.prisma.huntConfig.findUnique({ where: { id: config.id } });
			expect(updated).toMatchObject({
				instanceId: config.instanceId,
				apiCallsThisHour: counts.bookkeeping,
				lastMissingHunt: type === "missing" && counts.bookkeeping ? expect.any(Date) : null,
				lastUpgradeHunt: type === "upgrade" && counts.bookkeeping ? expect.any(Date) : null,
				apiCallsResetAt: config.apiCallsResetAt,
				hourlyApiCap: 100,
				missingIntervalMins: 15,
				upgradeIntervalMins: 30,
			});
		});
	const completeAccepted = async (expectedCount = expectedPayloads.length) => {
		await native.runtime.drain();
		const before = await graph();
		expect(before.events).toHaveLength(expectedCount);
		const states = before.events.map((event, index) => {
			const delivery = before.deliveries.find((row) => row.eventId === event.id)!;
			// This helper is called only after every actual producer/worker has physically joined.
			const expectedState = index < sent.length ? "sent" : "ready";
			expect(delivery.state).toBe(expectedState);
			return expectedState;
		});
		await assertGraph(states);
		if (states.includes("ready")) {
			expect(state.disconnected).toBe(true);
			const readyRecipients = states.filter((value) => value === "ready").length,
				previousSends = sent.length;
			const ids = before.events.map((row) => row.id).sort(),
				deliveryIds = before.deliveries.map((row) => row.id).sort();
			await native.restart(false);
			recovering = true;
			const recoveryClient = createRuntimePrismaClient(native.runtime),
				recoveryApp = Fastify({ logger: false });
			apps.push(recoveryApp);
			recoveryApp.decorate("restoreRuntime", native.runtime);
			await recoveryApp.register(
				fp(
					async (server) => {
						server.decorate("prisma", recoveryClient.prisma);
						server.decorate("dbProvider", native.engine as "sqlite" | "postgresql");
						server.addHook("onClose", async () => recoveryClient.close());
					},
					{ name: "prisma" },
				),
			);
			await recoveryApp.register(
				fp(
					async (server) => {
						server.decorate("config", { APP_URL: "https://synthetic.invalid" } as never);
						server.decorate("encryptor", native.encryptor);
					},
					{ name: "security" },
				),
			);
			registerRestoreBootstrapPlugin(recoveryApp, notificationPlugin);
			registerRestoreRuntimeActivation(recoveryApp);
			await recoveryApp.ready();
			await recoveryApp.notificationService.drain();
			await native.runtime.drain();
			expect(await waitForNative(() => sent.length === previousSends + readyRecipients)).toBe(true);
			let persisted = false;
			const deadline = performance.now() + 4_000;
			while (!persisted && performance.now() < deadline) {
				const current = await graph();
				persisted =
					current.deliveries.every((row) => row.state === "sent") &&
					current.history.length === expectedCount;
				if (!persisted) await settle();
			}
			expect(persisted && performance.now() <= deadline).toBe(true);
			await recoveryApp.notificationService.drain();
			await native.runtime.drain();
			const after = await assertGraph(states.map(() => "sent"));
			expect(after.events.map((row) => row.id).sort()).toEqual(ids);
			expect(after.deliveries.map((row) => row.id).sort()).toEqual(deliveryIds);
			await recoveryApp.notificationService.drain();
			expect(sent).toHaveLength(previousSends + readyRecipients);
			await recoveryApp.close();
			recovering = false;
		}
		await assertPersisted();
		return assertGraph(states.map(() => "sent"));
	};
	let disposed = false;
	const dispose = async () => {
		if (disposed) return;
		disposed = true;
		const errors: unknown[] = [];
		try {
			await app.close();
			await native.runtime.drain();
			await assertPersisted();
		} catch (error) {
			errors.push(error);
		}
		try {
			await native.run(async () => {
				const ids = seeded.configs.map((row) => row.instanceId),
					userIds = owners.map((owner) => owner.userId);
				expect(
					(
						await native.prisma.serviceInstance.deleteMany({
							where: { id: { in: ids }, userId: { in: userIds } },
						})
					).count,
				).toBe(2);
				expect(await native.prisma.serviceInstance.count({ where: { id: { in: ids } } })).toBe(0);
				expect(await native.prisma.huntConfig.count({ where: { instanceId: { in: ids } } })).toBe(
					0,
				);
				expect(await native.prisma.huntLog.count({ where: { instanceId: { in: ids } } })).toBe(0);
				expect(
					(await native.prisma.user.deleteMany({ where: { id: { in: userIds } } })).count,
				).toBe(2);
				expect(await native.prisma.user.count({ where: { id: { in: userIds } } })).toBe(0);
				expect(
					await native.prisma.notificationOutboxEvent.count({ where: { userId: { in: userIds } } }),
				).toBe(0);
				expect(
					await native.prisma.notificationOutboxDelivery.count({
						where: { userId: { in: userIds } },
					}),
				).toBe(0);
				expect(
					await native.prisma.notificationChannel.count({ where: { userId: { in: userIds } } }),
				).toBe(0);
			});
			expect(state.pending).toBe(0);
			expect(state.afterTeardown).toBe(0);
		} catch (error) {
			errors.push(error);
		} finally {
			try {
				await native.close();
			} catch (error) {
				errors.push(error);
			}
		}
		errors.push(...boundaryErrors);
		if (errors.length) throw new AggregateError(errors, "Native Hunting fixture teardown failed");
	};
	normalDispose = dispose;
	return {
		app,
		native,
		scheduler,
		config,
		configModel: prisma.huntConfig,
		logModel: prisma.huntLog,
		counts,
		state,
		sent,
		logs,
		outcomes,
		idle,
		waitPhase,
		advance,
		completeAccepted,
		assertGraph,
		assertPersisted,
		dispose,
		start() {
			if (options.origin === "scheduled") {
				const timer = installed.find((row) => row.kind === "interval" && row.delay === 60_000);
				if (!timer) throw new Error("Hunting timer missing");
				timer.callback();
			} else
				return native.run(async () => {
					// Match lifecycle's request entry; the scheduler separately retains the producer.
					expect(scheduler.triggerManualHunt(config.instanceId, type).queued).toBe(true);
				});
		},
		async closePending() {
			let closed = false;
			const promise = app.close().then(() => {
				closed = true;
			});
			await preClosed.promise;
			return { promise, settled: () => closed };
		},
	};
}
beforeEach(() => {
	installed.length = 0;
	activeTimers.clear();
	vi.useFakeTimers({
		toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	});
	vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
	const virtualDate = Date;
	virtualNow = () => virtualDate.now();
	const fakeTimeout = globalThis.setTimeout,
		fakeClearTimeout = globalThis.clearTimeout,
		fakeInterval = globalThis.setInterval,
		fakeClearInterval = globalThis.clearInterval;
	const schedulerCallsite = () =>
		new Error().stack
			?.split("\n")
			.find((line) => line.includes("/src/") && !line.includes("/__tests__/"))
			?.includes("/lib/hunting/scheduler.ts") === true;
	const timeoutCallsite = () =>
		schedulerCallsite() ||
		(new Error().stack?.includes("/src/lib/utils/delay.ts") === true &&
			new Error().stack?.includes("/src/lib/hunting/scheduler.ts") === true);
	// Virtual scheduler deadlines only; outbox/native clocks and transport safety timers remain real.
	const scopedDate = function (this: unknown, ...args: unknown[]) {
		if (!new.target) return Reflect.apply(realDate, undefined, []);
		return Reflect.construct(
			realDate,
			args.length ? args : [schedulerCallsite() ? virtualNow() : realDate.now()],
		);
	} as unknown as DateConstructor;
	Object.defineProperty(scopedDate, "prototype", { value: realDate.prototype });
	scopedDate.now = () => (schedulerCallsite() ? virtualNow() : realDate.now());
	scopedDate.parse = realDate.parse;
	scopedDate.UTC = realDate.UTC;
	vi.stubGlobal("Date", scopedDate);
	vi.stubGlobal("setTimeout", ((callback: () => void, delay?: number, ...args: unknown[]) => {
		if (!timeoutCallsite())
			return Reflect.apply(realTimeout, globalThis, [callback, delay, ...args]);
		const invoke = AsyncResource.bind(() => Reflect.apply(callback, globalThis, args));
		let handle: ReturnType<typeof setTimeout>;
		handle = Reflect.apply(fakeTimeout, globalThis, [
			() => {
				activeTimers.delete(handle);
				invoke();
			},
			delay,
		]);
		const row: Timer = {
			kind: "timeout",
			delay: delay ?? 0,
			dueAt: virtualNow() + (delay ?? 0),
			callback: invoke,
			handle,
		};
		installed.push(row);
		activeTimers.set(handle, row);
		return handle;
	}) as typeof setTimeout);
	vi.stubGlobal("clearTimeout", ((handle: Parameters<typeof clearTimeout>[0]) => {
		if (installed.some((row) => row.kind === "timeout" && row.handle === handle)) {
			activeTimers.delete(handle as ReturnType<typeof setTimeout>);
			return fakeClearTimeout(handle);
		}
		return realClearTimeout(handle);
	}) as typeof clearTimeout);
	vi.stubGlobal("setInterval", ((callback: () => void, delay?: number, ...args: unknown[]) => {
		if (!schedulerCallsite())
			return Reflect.apply(realInterval, globalThis, [callback, delay, ...args]);
		const invoke = AsyncResource.bind(() => Reflect.apply(callback, globalThis, args));
		let row: Timer;
		const handle = Reflect.apply(fakeInterval, globalThis, [
			() => {
				row.dueAt += row.delay;
				invoke();
			},
			delay,
		]);
		row = {
			kind: "interval",
			delay: delay ?? 0,
			dueAt: virtualNow() + (delay ?? 0),
			callback: invoke,
			handle,
		};
		installed.push(row);
		activeTimers.set(handle, row);
		return handle;
	}) as typeof setInterval);
	vi.stubGlobal("clearInterval", ((handle: Parameters<typeof clearInterval>[0]) => {
		if (installed.some((row) => row.kind === "interval" && row.handle === handle)) {
			activeTimers.delete(handle as ReturnType<typeof setTimeout>);
			return fakeClearInterval(handle);
		}
		return realClearInterval(handle);
	}) as typeof clearInterval);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Fixture forbids network"));
	executor.mockReset();
});
afterEach(async () => {
	const errors: unknown[] = [];
	try {
		for (const release of releases.splice(0)) release();
		for (const result of await Promise.allSettled(apps.splice(0).map((app) => app.close())))
			if (result.status === "rejected") errors.push(result.reason);
		for (const fixture of fixtures.splice(0))
			try {
				await fixture.dispose();
			} catch (error) {
				errors.push(error);
			}
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	}
	if (errors.length) throw new AggregateError(errors, "Native Hunting teardown failed");
});
describe("Hunting accepted notification handoff", () => {
	for (const origin of ["manual", "scheduled"] as const) {
		for (const type of ["missing", "upgrade"] as const) {
			for (const outcome of ["completed", "found", "error", "throw"] as const) {
				it(`preserves ${origin} ${type} ${outcome} notification after admission closes`, async () => {
					const gate = deferred();
					const f = await boot({
						origin,
						type,
						outcome,
						hold: { phase: "lookup", gate: gate.promise },
					});
					await f.start();
					await f.waitPhase("lookup");
					expect(f.counts.lookup).toBe(1);
					const closing = await f.closePending();
					expect(closing.settled()).toBe(false);
					expect(f.state.disconnected).toBe(false);
					expect(f.scheduler.triggerManualHunt("new-after-close", type).queued).toBe(false);
					await expect(
						f.app.notificationService.notify(
							{ eventType: "HUNT_COMPLETED", title: "Synthetic", body: "Synthetic" },
							{ userId: f.config.instance.userId },
						),
					).rejects.toThrow(/shutting down/);
					gate.resolve();
					await closing.promise;
					await f.completeAccepted(1);
					const eventType =
						outcome === "found"
							? "HUNT_CONTENT_FOUND"
							: outcome === "completed"
								? "HUNT_COMPLETED"
								: "HUNT_FAILED";
					expect(f.sent).toEqual([{ eventType, owner: f.config.instance.userId }]);
					expect(f.logs).toEqual(["sent"]);
					expect(f.outcomes).toEqual([
						outcome === "throw" ? "error" : outcome === "found" ? "completed" : outcome,
					]);
					expect(f.counts.executor).toBe(1);
					expect(f.state.afterTeardown).toBe(0);
				});
			}
		}
		for (const phase of [
			"executor",
			"result",
			"subscription",
			"send",
			"log",
			"channel",
			"bookkeeping",
		] as const) {
			it(`drains ${origin} ${phase} before database teardown`, async () => {
				const gate = deferred();
				const f = await boot({ origin, hold: { phase, gate: gate.promise } });
				await f.start();
				await f.waitPhase(phase);
				expect(f.counts[phase]).toBe(1);
				const closing = await f.closePending();
				expect(closing.settled()).toBe(false);
				expect(f.state.disconnected).toBe(false);
				gate.resolve();
				await closing.promise;
				await f.completeAccepted(1);
				expect(f.sent).toHaveLength(1);
				expect(f.logs).toEqual(["sent"]);
				expect(f.counts.bookkeeping).toBe(1);
				expect(f.state.afterTeardown).toBe(0);
			});
		}
	}
	it("keeps a stopped timer manual-capable and honors cooldown after notification failure", async () => {
		const gate = deferred();
		gate.resolve();
		const f = await boot({ hold: { phase: "subscription", gate: gate.promise, reject: true } });
		f.scheduler.stop();
		await f.start();
		await f.idle();
		expect(f.outcomes).toEqual(["completed"]);
		expect(f.counts.bookkeeping).toBe(1);
		expect(f.sent).toHaveLength(0);
		expect(f.scheduler.triggerManualHunt(f.config.instanceId, "missing").queued).toBe(false);
		vi.setSystemTime(new Date(virtualNow() + 5 * 60_000 + 1));
		await f.start();
		await f.idle();
		await f.completeAccepted(1);
		expect(f.counts.executor).toBe(2);
		expect(f.sent).toHaveLength(1);
		await f.app.close();
		expect(f.state.afterTeardown).toBe(0);
	});
	it("retains raw executor ownership after timeout and hands off failure during drain", async () => {
		const gate = deferred();
		const f = await boot({ hold: { phase: "executor", gate: gate.promise } });
		await f.start();
		await f.waitPhase("executor");
		expect(f.counts.executor).toBe(1);
		const closing = await f.closePending();
		await f.advance(MAX_HUNT_DURATION_MS - 1);
		expect(f.outcomes).toEqual([]);
		await f.advance(1);
		expect(await waitForNative(() => f.counts.subscription === 1 && f.outcomes.length === 1)).toBe(
			true,
		);
		await f.app.notificationService.drain();
		await f.assertGraph(["ready"]);
		expect(f.sent).toEqual([]);
		expect(f.outcomes).toEqual(["error"]);
		expect(closing.settled()).toBe(false);
		expect(() => f.scheduler.initialize(f.app)).toThrow(/shutting down/);
		gate.resolve();
		await closing.promise;
		await f.completeAccepted(1);
		expect(f.sent).toEqual([{ eventType: "HUNT_FAILED", owner: f.config.instance.userId }]);
		expect(f.counts.executor).toBe(1);
		expect(f.state.afterTeardown).toBe(0);
	});
	it("does not turn skipped work into completion alerts or API bookkeeping", async () => {
		const f = await boot({ outcome: "skipped" });
		await f.start();
		await f.idle();
		await f.app.close();
		await f.completeAccepted(0);
		expect(f.outcomes).toEqual(["skipped"]);
		expect(f.sent).toEqual([]);
		expect(f.counts.subscription).toBe(0);
		expect(f.counts.bookkeeping).toBe(0);
	});
	it("retains the maintenance barrier through accepted handoff, then releases it", async () => {
		const gate = deferred();
		const f = await boot({ hold: { phase: "subscription", gate: gate.promise } });
		await f.start();
		await f.waitPhase("subscription");
		expect(f.counts.subscription).toBe(1);
		const closing = await f.closePending();
		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
			statusCode: 409,
		});
		gate.resolve();
		await closing.promise;
		await expect(withCleanupMaintenanceGuard(async () => "released")).resolves.toBe("released");
	});
	it("does not admit a hunt through database maintenance", async () => {
		const f = await boot();
		await withCleanupMaintenanceGuard(async () => {
			await f.start();
			await f.idle();
		});
		expect(f.counts.lookup).toBe(0);
		expect(f.counts.executor).toBe(0);
		expect(f.counts.subscription).toBe(0);
		await f.app.close();
	});
	it("contains rejected accepted notification work without losing result bookkeeping", async () => {
		const gate = deferred();
		const f = await boot({ hold: { phase: "subscription", gate: gate.promise, reject: true } });
		await f.start();
		await f.waitPhase("subscription");
		expect(f.counts.subscription).toBe(1);
		const closing = await f.closePending();
		gate.resolve();
		await closing.promise;
		await f.completeAccepted(0);
		expect(f.sent).toEqual([]);
		expect(f.outcomes).toEqual(["completed"]);
		expect(f.counts.bookkeeping).toBe(1);
		expect(f.state.afterTeardown).toBe(0);
	});
	it("wires the new app's producer after a completed lifecycle", async () => {
		const previous = await boot();
		await previous.start();
		await previous.idle();
		await previous.app.close();
		await previous.completeAccepted(1);
		await previous.dispose();
		const gate = deferred();
		const next = await boot({ hold: { phase: "lookup", gate: gate.promise } });
		await next.start();
		await next.waitPhase("lookup");
		const closing = await next.closePending();
		gate.resolve();
		await closing.promise;
		await next.completeAccepted(1);
		expect(next.sent).toEqual([
			{ eventType: "HUNT_COMPLETED", owner: next.config.instance.userId },
		]);
		expect(previous.state.afterTeardown).toBe(0);
		expect(next.state.afterTeardown).toBe(0);
	});
	it("naturally schedules at 60 seconds without overlapping and waits for the next eligible hunt", async () => {
		// Added native cadence control; the original 37 named controls remain intact.
		const gate = deferred();
		const f = await boot({ origin: "scheduled", hold: { phase: "executor", gate: gate.promise } });
		expect(f.counts.lookup).toBe(0);
		expect(f.counts.executor).toBe(0);
		await f.advance(59_999);
		expect(f.counts.lookup).toBe(0);
		await f.advance(1);
		await f.waitPhase("executor");
		expect(f.counts.lookup).toBe(1);
		expect(f.counts.executor).toBe(1);
		await f.advance(60_000);
		expect(f.counts.lookup).toBe(1);
		expect(f.counts.executor).toBe(1);
		expect(f.state.pending).toBe(1);
		gate.resolve();
		await f.idle();
		expect(f.counts.bookkeeping).toBe(1);
		await f.advance(15 * 60_000 - 1);
		expect(f.counts.executor).toBe(1);
		await f.advance(1);
		await f.idle();
		expect(f.counts.lookup).toBe(2);
		expect(f.counts.executor).toBe(2);
		expect(f.counts.bookkeeping).toBe(2);
		await f.app.close();
		// Only the Hunting clock advances: identical outcomes remain within real outbox dedup TTL.
		// Both native hunt results/API increments survive, but only the first alert is accepted.
		await f.completeAccepted(1);
		expect(f.sent).toEqual([{ eventType: "HUNT_COMPLETED", owner: f.config.instance.userId }]);
		expect(f.outcomes).toEqual(["completed", "completed"]);
		expect(f.logs).toEqual(["sent"]);
		expect(f.state.afterTeardown).toBe(0);
	});
});
