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
import { JellyfinClient } from "../../lib/jellyfin/jellyfin-client.js";
import { withCleanupMaintenanceGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { NotificationDispatcher } from "../../lib/notifications/notification-dispatcher.js";
import { PlexClient } from "../../lib/plex/plex-client.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import { parseSessionSnapshotMeasurement } from "../lib/session-snapshot-measurements.js";
import notificationServicePlugin from "../notification-service.js";
import schedulerRegistryPlugin from "../scheduler-registry.js";
import sessionSnapshotSchedulerPlugin from "../session-snapshot-scheduler.js";

const STARTUP_MS = 60_000,
	CAPTURE_MS = 300_000,
	CLEANUP_MS = 86_400_000;
const RETENTION_MS = 90 * CLEANUP_MS;
type Native = Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
type AwaitOnly<T> = T extends (...args: infer A) => unknown
	? (...args: A) => PromiseLike<unknown>
	: never;
const apps: FastifyInstance[] = [],
	releases: Array<() => void> = [],
	ticks: Promise<unknown>[] = [];
const fixtures: Array<{ native: Native; dispose: () => Promise<void> }> = [];
const realTimeout = globalThis.setTimeout,
	realClearTimeout = globalThis.clearTimeout,
	realInterval = globalThis.setInterval,
	realClearInterval = globalThis.clearInterval,
	realDate = Date;
type TimerRecord = {
	kind: "timeout" | "interval";
	delay: number;
	dueAt: number;
	callback: () => void;
	handle: ReturnType<typeof setTimeout>;
};
const installed: TimerRecord[] = [],
	activeTimers = new Map<ReturnType<typeof setTimeout>, TimerRecord>();
let virtualNow: () => number = () => realDate.now();
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
type Phase =
	| "plexLookup"
	| "mediaLookup"
	| "platformRead"
	| "plexProvider"
	| "mediaProvider"
	| "snapshotWrite"
	| "subscription"
	| "send"
	| "notificationLog"
	| "channel"
	| "cleanup";
type Origin = "startup" | "interval";
const allowedEvents = ["PLEX_CONCURRENT_PEAK", "JELLYFIN_CONCURRENT_PEAK"] as const;
const wantPayloads = {
	PLEX_CONCURRENT_PEAK: {
		eventType: "PLEX_CONCURRENT_PEAK",
		title: "High concurrent streams detected",
		body: "10 concurrent streams observed (threshold: 5).",
		url: "https://synthetic.invalid/statistics",
	},
	JELLYFIN_CONCURRENT_PEAK: {
		eventType: "JELLYFIN_CONCURRENT_PEAK",
		title: "High concurrent media server streams",
		body: "6 concurrent streams observed (threshold: 5).",
		url: "https://synthetic.invalid/statistics",
	},
};
async function boot(
	options: {
		hold?: {
			phase: Phase;
			gate: Promise<void>;
			reject?: boolean;
			call?: number;
			eventType?: string;
		};
		warmupEmpty?: boolean;
		empty?: boolean;
		preCloseGate?: Promise<void>;
	} = {},
) {
	const native = await createNotificationOutboxNativeFixture();
	const owners = [
		{ userId: native.userId, channelId: native.channelId },
		await native.createOwner(),
	];
	const instances = await native.run(async () => {
		for (const owner of owners) {
			const config = native.encryptor.encrypt(
				JSON.stringify({
					webhookUrl: `https://example.invalid/synthetic-snapshot/${owner.userId}`,
				}),
			);
			expect(
				(
					await native.prisma.notificationChannel.updateMany({
						where: { id: owner.channelId, userId: owner.userId },
						data: { encryptedConfig: config.value, configIv: config.iv },
					})
				).count,
			).toBe(1);
			for (const eventType of allowedEvents)
				await native.prisma.notificationSubscription.create({
					data: { channelId: owner.channelId, eventType },
				});
		}
		const result = [];
		for (const [index, service] of (["PLEX", "PLEX", "JELLYFIN", "EMBY"] as const).entries()) {
			const key = native.encryptor.encrypt(`synthetic-provider-key-${index}`);
			result.push(
				await native.prisma.serviceInstance.create({
					data: {
						userId: owners[index % 2]!.userId,
						service,
						label: "Same synthetic label",
						baseUrl: `https://example.invalid/synthetic-provider/${index}`,
						encryptedApiKey: key.value,
						encryptionIv: key.iv,
						enabled: !options.empty && !options.warmupEmpty,
						connectionGeneration: 7,
						identityGeneration: 3,
						expectedIdentity: `synthetic-identity-${index}`,
						identityStatus: "VERIFIED",
					},
				}),
			);
		}
		return result;
	});
	const instanceIds = instances.map((row) => row.id);
	const seeded = await native.run(async () => {
		const base = { instanceId: instances[0]!.id, concurrentStreams: 0, sessionsJson: "[]" };
		const history = await native.prisma.sessionSnapshot.create({
			data: {
				...base,
				capturedAt: new Date(virtualNow()),
				sessionsJson: JSON.stringify([{ platform: "Synthetic platform" }]),
			},
		});
		const cutoff = virtualNow() - RETENTION_MS;
		const retention = [];
		for (const offset of [-2, -1, 0, 1])
			retention.push(
				await native.prisma.sessionSnapshot.create({
					data: { ...base, capturedAt: new Date(cutoff + offset) },
				}),
			);
		return { history, retention };
	});
	const channels = await native.run(() =>
		native.prisma.notificationChannel.findMany({
			where: { OR: owners.map((row) => ({ id: row.channelId, userId: row.userId })) },
		}),
	);
	await native.restart(false);
	const client = createRuntimePrismaClient(native.runtime),
		prisma = client.prisma;
	const counts: Record<Phase, number> = {
		plexLookup: 0,
		mediaLookup: 0,
		platformRead: 0,
		plexProvider: 0,
		mediaProvider: 0,
		snapshotWrite: 0,
		subscription: 0,
		send: 0,
		notificationLog: 0,
		channel: 0,
		cleanup: 0,
	};
	const state = { pending: 0, teardown: 0, pendingAtTeardown: -1, afterTeardown: 0, forbidden: 0 };
	const boundaryErrors: unknown[] = [];
	// Product paths deliberately consume optional-enrichment failures. Assertion
	// failures in forwarding instrumentation must still fail this native fixture.
	const protect = <T extends (...args: never[]) => unknown>(operation: T): T => {
		const rejected = (error: unknown): never => {
			if (error instanceof Error && error.name === "AssertionError") boundaryErrors.push(error);
			throw error;
		};
		return function (this: unknown, ...args: unknown[]) {
			try {
				const result = Reflect.apply(operation, this, args);
				return result instanceof Promise ? result.catch(rejected) : result;
			} catch (error) {
				return rejected(error);
			}
		} as unknown as T;
	};
	const entered = deferred(),
		closing = deferred();
	const records: Array<{ id: string; instanceId: string; concurrentStreams: number }> = [],
		sent: string[] = [];
	const cleanupResults: Array<{ count: number; cutoff: Date }> = [];
	const sendEntries: Array<{ eventType: (typeof allowedEvents)[number]; owner: number }> = [];
	const subscriptionEntries: string[] = [];
	const providerEntries: string[] = [];
	const failedPlexPayload = {
		...wantPayloads.PLEX_CONCURRENT_PEAK,
		body: "5 concurrent streams observed (threshold: 5).",
	};
	let recoveredProviderRound = false;
	const expectedPayload = (eventType: keyof typeof wantPayloads) =>
		eventType === "PLEX_CONCURRENT_PEAK" &&
		options.hold?.phase === "plexProvider" &&
		options.hold.reject === true &&
		!recoveredProviderRound
			? failedPlexPayload
			: wantPayloads[eventType];
	let heldTarget: { eventType?: string; owner?: number } | undefined;
	let matchingHoldCalls = 0,
		held = false,
		active = 0;
	const observe = async <T>(
		phase: Phase,
		work: () => Promise<T>,
		eventType?: string,
		owner?: number,
	): Promise<T> => {
		counts[phase]++;
		if (state.teardown) state.afterTeardown++;
		state.pending++;
		try {
			const matches =
				options.hold?.phase === phase &&
				(options.hold.eventType === undefined || options.hold.eventType === eventType);
			const hold =
				matches && ++matchingHoldCalls === (options.hold?.call ?? 1) ? options.hold : undefined;
			if (hold) {
				held = true;
				heldTarget = { eventType, owner };
				entered.resolve();
				await hold.gate;
			}
			if (hold?.reject) throw new Error("Synthetic phase unavailable");
			return await work();
		} finally {
			if (state.teardown) state.afterTeardown++;
			state.pending--;
		}
	};
	// Only provider session reads are synthetic. Client construction and encrypted credentials remain real.
	vi.spyOn(PlexClient.prototype, "getSessions").mockImplementation(
		protect(function (this: PlexClient) {
			const index = instances.findIndex((row) => row.baseUrl === Reflect.get(this, "baseUrl"));
			expect(index).toBeGreaterThanOrEqual(0);
			expect(instances[index]!.service).toBe("PLEX");
			expect(Reflect.get(this, "token")).toBe(`synthetic-provider-key-${index}`);
			providerEntries.push(instances[index]!.id);
			return observe("plexProvider", async () =>
				Array.from({ length: 5 }, (_, index) => ({
					sessionKey: `session-${index}`,
					ratingKey: `item-${index}`,
					title: "Synthetic item",
					type: "movie",
					user: { id: "1", title: "Synthetic viewer" },
					player: {
						title: "Synthetic player",
						platform: "Synthetic platform",
						product: "Synthetic",
						state: "playing",
					},
					state: "playing" as const,
					viewOffset: 0,
					duration: 60_000,
					videoDecision: "direct play",
					audioDecision: "direct play",
					bandwidth: 100,
				})),
			);
		}),
	);
	vi.spyOn(JellyfinClient.prototype, "getSessions").mockImplementation(
		protect(function (this: JellyfinClient) {
			const index = instances.findIndex((row) => row.baseUrl === Reflect.get(this, "baseUrl"));
			expect(index).toBeGreaterThanOrEqual(0);
			expect(["JELLYFIN", "EMBY"]).toContain(instances[index]!.service);
			expect(Reflect.get(this, "apiKey")).toBe(`synthetic-provider-key-${index}`);
			providerEntries.push(instances[index]!.id);
			return observe("mediaProvider", async () =>
				Array.from({ length: 3 }, (_, index) => ({
					id: `session-${index}`,
					userId: "viewer",
					userName: "Synthetic viewer",
					isPaused: false,
					playMethod: "DirectPlay",
					positionMs: 0,
					durationMs: 60_000,
				})),
			);
		}),
	);
	vi.spyOn(NotificationDispatcher.prototype, "send").mockImplementation(
		protect((type, config, payload) => {
			const ownerIndex = owners.findIndex(
				(row) => config.webhookUrl === `https://example.invalid/synthetic-snapshot/${row.userId}`,
			);
			sendEntries.push({
				eventType: payload.eventType as (typeof allowedEvents)[number],
				owner: ownerIndex,
			});
			return observe(
				"send",
				async () => {
					const ownerIndex = owners.findIndex(
						(row) =>
							config.webhookUrl === `https://example.invalid/synthetic-snapshot/${row.userId}`,
					);
					expect(ownerIndex).toBeGreaterThanOrEqual(0);
					expect(type).toBe("DISCORD");
					const alias = ownerIndex === 0 ? "owner-a" : "owner-b";
					expect(config).toEqual({
						webhookUrl: `https://example.invalid/synthetic-snapshot/${owners[ownerIndex]!.userId}`,
					});
					expect(payload).toEqual(expectedPayload(payload.eventType as keyof typeof wantPayloads));
					sent.push(`${payload.eventType}:${alias}`);
					return { success: true, retryable: false };
				},
				payload.eventType,
				ownerIndex,
			);
		}),
	);
	const lookup = prisma.serviceInstance.findMany.bind(prisma.serviceInstance);
	const lookupDelegate: { findMany: AwaitOnly<typeof prisma.serviceInstance.findMany> } =
		prisma.serviceInstance;
	vi.spyOn(lookupDelegate, "findMany").mockImplementation(
		protect(async (args) => {
			const phase = args?.where?.service === "PLEX" ? "plexLookup" : "mediaLookup";
			expect(args).toEqual({
				where:
					phase === "plexLookup"
						? { service: "PLEX", enabled: true }
						: { service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			});
			return observe(phase, async () => {
				const rows = await lookup(args);
				for (const row of rows) {
					const initial = instances.find((instance) => instance.id === row.id)!;
					expect(initial).toBeDefined();
					const { enabled: _enabled, updatedAt: _updatedAt, ...immutable } = initial;
					expect(row).toMatchObject(immutable);
					expect(row.enabled).toBe(true);
					expect(row.updatedAt).toBeInstanceOf(Date);
				}
				expect(rows.map((row) => row.id).sort()).toEqual(
					options.empty || (options.warmupEmpty && counts[phase] === 1)
						? []
						: instances
								.filter((i) =>
									phase === "plexLookup" ? i.service === "PLEX" : i.service !== "PLEX",
								)
								.map((i) => i.id)
								.sort(),
				);
				return rows;
			});
		}),
	);
	const platformRead = prisma.sessionSnapshot.findMany.bind(prisma.sessionSnapshot);
	const snapshotReadDelegate: { findMany: AwaitOnly<typeof prisma.sessionSnapshot.findMany> } =
		prisma.sessionSnapshot;
	vi.spyOn(snapshotReadDelegate, "findMany").mockImplementation(
		protect((args) => {
			expect(args?.where).toEqual({
				capturedAt: { gte: new Date(virtualNow() - 30 * CLEANUP_MS) },
			});
			expect(args?.select).toEqual({ id: true, sessionsJson: true });
			expect(args?.orderBy).toEqual({ id: "asc" });
			expect(args?.take).toBe(500);
			if (args?.cursor) expect(args.skip).toBe(1);
			return observe("platformRead", () => platformRead(args));
		}),
	);
	const snapshotWrite = prisma.sessionSnapshot.create.bind(prisma.sessionSnapshot);
	const snapshotWriteDelegate: { create: AwaitOnly<typeof prisma.sessionSnapshot.create> } =
		prisma.sessionSnapshot;
	vi.spyOn(snapshotWriteDelegate, "create").mockImplementation(
		protect((args) =>
			observe("snapshotWrite", async () => {
				const instance = instances.find((row) => row.id === args.data.instanceId)!;
				expect(instance).toBeDefined();
				const receipt = parseSessionSnapshotMeasurement(args.data.measurementJson!);
				expect(receipt.status).toBe("verified");
				if (receipt.status !== "verified") throw new Error("Native measurement unavailable");
				const measurement = receipt.measurement,
					failed = measurement.status === "failed",
					count = failed ? 0 : instance.service === "PLEX" ? 5 : 3;
				expect(measurement).toMatchObject({
					version: 1,
					provider: instance.service,
					sourceScope: { connectionGeneration: 7, identityGeneration: 3 },
					methodAxis: "video",
					deviceLabelAxis: instance.service === "PLEX" ? "platform" : "client",
					bandwidthBasis: instance.service === "PLEX" ? "provider-reported" : "encoding-estimate",
					status: failed ? "failed" : "active",
					observedSessions: failed ? null : count,
					network: { status: "unavailable", lanKbps: null, wanKbps: null },
				});
				if (!failed) expect(measurement.userIdentity).toBe("provider-native");
				expect(measurement.bandwidth).toEqual(
					failed
						? null
						: {
								status: instance.service === "PLEX" ? "complete" : "unavailable",
								observedSessions: count,
								measuredSessions: instance.service === "PLEX" ? 5 : 0,
								knownTotalKbps: instance.service === "PLEX" ? 500 : null,
							},
				);
				expect(measurement.methods).toEqual(
					failed
						? null
						: {
								directPlayCount: count,
								transcodeCount: 0,
								directStreamCount: 0,
								unknownDecisionCount: 0,
							},
				);
				expect(args.data).toMatchObject({
					concurrentStreams: count,
					directPlayCount: count,
					transcodeCount: 0,
					directStreamCount: 0,
					lanBandwidth: 0,
					wanBandwidth: 0,
					totalBandwidth: !failed && instance.service === "PLEX" ? 500 : 0,
				});
				expect(JSON.parse(args.data.sessionsJson)).toHaveLength(count);
				const row = await snapshotWrite(args);
				records.push({
					id: row.id,
					instanceId: row.instanceId,
					concurrentStreams: row.concurrentStreams,
				});
				return row;
			}),
		),
	);
	const cleanupWrite = prisma.sessionSnapshot.deleteMany.bind(prisma.sessionSnapshot);
	const cleanupDelegate: { deleteMany: AwaitOnly<typeof prisma.sessionSnapshot.deleteMany> } =
		prisma.sessionSnapshot;
	vi.spyOn(cleanupDelegate, "deleteMany").mockImplementation(
		protect((args) => {
			expect(args).toEqual({
				where: { capturedAt: { lt: new Date(virtualNow() - RETENTION_MS) } },
			});
			return observe("cleanup", async () => {
				const result = await cleanupWrite(args);
				cleanupResults.push({
					count: result.count,
					cutoff: (args!.where!.capturedAt as { lt: Date }).lt,
				});
				return result;
			});
		}),
	);
	const subscriptionRead = prisma.notificationSubscription.findMany.bind(
		prisma.notificationSubscription,
	);
	const subscriptionDelegate: {
		findMany: AwaitOnly<typeof prisma.notificationSubscription.findMany>;
	} = prisma.notificationSubscription;
	vi.spyOn(subscriptionDelegate, "findMany").mockImplementation(
		protect(async (args) => {
			const eventType = String(args?.where?.eventType);
			expect(allowedEvents).toContain(eventType);
			expect(args).toEqual({ where: { eventType }, include: { channel: true } });
			// notify() has admitted and retained this branch before reaching its subscription read.
			subscriptionEntries.push(eventType);
			return observe(
				"subscription",
				async () => {
					const rows = await subscriptionRead({ ...args, include: { channel: true } });
					expect(rows).toHaveLength(2);
					expect(
						rows
							.map((row) => ({ userId: row.channel.userId, channelId: row.channelId }))
							.sort((a, b) => a.userId.localeCompare(b.userId)),
					).toEqual([...owners].sort((a, b) => a.userId.localeCompare(b.userId)));
					return rows;
				},
				eventType,
			);
		}),
	);
	const transaction = prisma.$transaction.bind(prisma);
	vi.spyOn(prisma, "$transaction").mockImplementation(
		protect((operation, transactionOptions) =>
			transaction(async (tx) => {
				let logEventType: string | undefined;
				const write = tx.notificationLog.create.bind(tx.notificationLog);
				const history: { create: AwaitOnly<typeof tx.notificationLog.create> } = tx.notificationLog;
				vi.spyOn(history, "create").mockImplementation(
					protect((args) => {
						logEventType = args.data.eventType;
						expect(owners.map((row) => row.channelId)).toContain(args.data.channelId);
						expect(allowedEvents).toContain(args.data.eventType);
						const payload = expectedPayload(args.data.eventType as keyof typeof wantPayloads);
						expect(args.data).toMatchObject({
							eventType: payload.eventType,
							title: payload.title,
							body: payload.body,
						});
						return observe(
							"notificationLog",
							() => write(args),
							args.data.eventType,
							owners.findIndex((row) => row.channelId === args.data.channelId),
						);
					}),
				);
				const channelWrite = tx.notificationChannel.updateMany.bind(tx.notificationChannel);
				const channelDelegate: { updateMany: AwaitOnly<typeof tx.notificationChannel.updateMany> } =
					tx.notificationChannel;
				vi.spyOn(channelDelegate, "updateMany").mockImplementation(
					protect((args) => {
						const selected = channels.find((row) => row.id === args?.where?.id)!;
						expect(selected).toBeDefined();
						if (args.data.id !== undefined) {
							expect(args.where).toEqual({ id: selected.id, userId: selected.userId });
							expect(args.data).toEqual({ id: selected.id });
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
						expect(["success", "failed"]).toContain(args.data.lastSendResult);
						return observe(
							"channel",
							() => channelWrite(args),
							logEventType,
							owners.findIndex((row) => row.channelId === selected.id),
						);
					}),
				);
				return operation(tx);
			}, transactionOptions),
		),
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
					state.pendingAtTeardown = state.pending;
					expect(state.pending).toBe(0);
					expect(active).toBe(0);
					await client.close();
					state.teardown++;
				});
			},
			{ name: "prisma" },
		),
	);
	await app.register(
		fp(
			async (server) => {
				server.decorate("encryptor", native.encryptor);
				server.decorate("config", { APP_URL: "https://synthetic.invalid" } as never);
			},
			{ name: "security" },
		),
	);
	registerRestoreBootstrapPlugin(app, notificationServicePlugin);
	registerRestoreBootstrapPlugin(app, schedulerRegistryPlugin);
	await app.after();
	const track = app.schedulerRegistry.track.bind(app.schedulerRegistry);
	vi.spyOn(app.schedulerRegistry, "track").mockImplementation(
		protect((...args) => {
			active++;
			const task = track(...args);
			ticks.push(
				task
					.catch(() => undefined)
					.finally(() => {
						active--;
					}),
			);
			return task;
		}),
	);
	const register = app.register.bind(app);
	let selected = 0;
	const interception = vi.spyOn(app, "register").mockImplementation(
		protect((plugin: unknown, ...args: unknown[]) => {
			if (
				typeof plugin === "function" &&
				Reflect.get(plugin, Symbol.for("fastify.display-name")) ===
					Reflect.get(sessionSnapshotSchedulerPlugin, Symbol.for("fastify.display-name"))
			) {
				expect(plugin).not.toBe(sessionSnapshotSchedulerPlugin);
				expect(Reflect.get(plugin, Symbol.for("plugin-meta"))).toEqual(
					Reflect.get(sessionSnapshotSchedulerPlugin, Symbol.for("plugin-meta")),
				);
				selected++;
				return Reflect.apply(register, app, [plugin, ...args]);
			}
			return app;
		}),
	);
	try {
		registerSchedulers(app);
		expect(selected).toBe(1);
	} finally {
		interception.mockRestore();
	}
	await app.after();
	registerRestoreRuntimeActivation(app);
	app.addHook("preClose", async () => {
		closing.resolve();
		if (options.preCloseGate) await options.preCloseGate;
	});
	await app.ready();
	const idle = async () => {
		await app.notificationService.drain();
		await native.runtime.drain();
		expect(await waitForNative(() => active === 0 && state.pending === 0)).toBe(true);
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
			ticks.push(drain);
			expect(await waitForNative(() => drained || (held && state.pending > 0))).toBe(true);
			if (drained) await idle();
		} while (virtualNow() < target);
		expect(virtualNow()).toBe(target);
	};
	const callback = (kind: "startup" | "interval" | "cleanup") => {
		const delay = kind === "startup" ? STARTUP_MS : kind === "cleanup" ? CLEANUP_MS : CAPTURE_MS;
		const row = installed.find(
			(timer) =>
				timer.delay === delay && timer.kind === (kind === "startup" ? "timeout" : "interval"),
		);
		if (!row) throw new Error("Snapshot timer callback missing");
		return () => {
			if (kind === "startup") clearTimeout(row.handle);
			row.callback();
		};
	};
	const activateSources = () =>
		native.run(async () => {
			expect(
				(
					await native.prisma.serviceInstance.updateMany({
						where: { id: { in: instanceIds }, userId: { in: owners.map((row) => row.userId) } },
						data: { enabled: true },
					})
				).count,
			).toBe(4);
		});
	const graph = () =>
		native.run(async () => ({
			events: await native.prisma.notificationOutboxEvent.findMany({
				where: { userId: { in: owners.map((row) => row.userId) } },
			}),
			deliveries: await native.prisma.notificationOutboxDelivery.findMany({
				where: { userId: { in: owners.map((row) => row.userId) } },
			}),
			history: await native.prisma.notificationLog.findMany({
				where: { channelId: { in: owners.map((row) => row.channelId) } },
			}),
			channels: await native.prisma.notificationChannel.findMany({
				where: { OR: owners.map((row) => ({ id: row.channelId, userId: row.userId })) },
			}),
		}));
	// Expected graph is supplied independently by each controlled boundary.
	const assertGraph = async (
		expected: Array<{
			eventType: (typeof allowedEvents)[number];
			owner: number;
			state: "ready" | "sent" | "uncertain" | "submitting";
			eventIndex?: number;
			payload?: (typeof wantPayloads)[keyof typeof wantPayloads];
		}>,
	) => {
		const result = await graph();
		expect(result.events).toHaveLength(expected.length);
		expect(result.deliveries).toHaveLength(expected.length);
		expect(result.history).toHaveLength(expected.filter((row) => row.state === "sent").length);
		for (const item of expected) {
			const owner = owners[item.owner]!,
				event = result.events
					.filter((row) => row.userId === owner.userId && row.eventType === item.eventType)
					.sort((a, b) => a.acceptedAt.getTime() - b.acceptedAt.getTime())[item.eventIndex ?? 0]!;
			const payload = item.payload ?? expectedPayload(item.eventType);
			expect(event).toBeDefined();
			expect(event).toMatchObject({
				stage: item.state === "sent" || item.state === "uncertain" ? "terminal" : "ready",
				destinationInstallationId: "synthetic-notification-outbox-destination",
				restoreCommitId: null,
				aggregationWindowSeconds: null,
				maxBatchSize: null,
				aggregateParentId: null,
			});
			expect(event.dueAt).toEqual(event.acceptedAt);
			expect(event.encryptedPayload).not.toContain("concurrent");
			expect(
				JSON.parse(
					native.encryptor.decrypt({ value: event.encryptedPayload, iv: event.payloadIv }),
				),
			).toEqual({
				purpose: "arr-dashboard:notification-outbox-event",
				version: 1,
				eventId: event.id,
				userId: owner.userId,
				payload,
				recipients: [
					{
						channelId: owner.channelId,
						channelType: "DISCORD",
						subscriptionEventType: item.eventType,
					},
				],
				fallbackEventTypes: [],
				policy: { stage: "ready" },
				acceptedAt: event.acceptedAt.toISOString(),
				dueAt: event.dueAt.toISOString(),
				destinationInstallationId: "synthetic-notification-outbox-destination",
				restoreCommitId: null,
			});
			const delivery = result.deliveries.find((row) => row.eventId === event.id)!;
			expect(delivery).toMatchObject({
				userId: owner.userId,
				channelId: owner.channelId,
				channelType: "DISCORD",
				subscriptionEventType: item.eventType,
				state: item.state,
				attemptOrdinal: 0,
				nextAttemptAt: event.dueAt,
			});
			if (item.state === "ready")
				expect(delivery).toMatchObject({
					attemptToken: null,
					workerEpoch: null,
					attemptConfigFingerprint: null,
					dispatchedAt: null,
					completedAt: null,
					outcomeCategory: null,
				});
			else
				expect(delivery).toMatchObject({
					attemptToken: expect.any(String),
					workerEpoch: expect.any(String),
					attemptConfigFingerprint: expect.any(String),
					dispatchedAt: expect.any(Date),
					completedAt: item.state === "submitting" ? null : expect.any(Date),
					outcomeCategory:
						item.state === "sent"
							? "acknowledged"
							: item.state === "uncertain"
								? "unconfirmed"
								: null,
				});
			if (item.state === "sent")
				expect(
					result.history
						.filter((row) => row.channelId === owner.channelId && row.eventType === item.eventType)
						.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())[item.eventIndex ?? 0],
				).toMatchObject({
					channelType: "DISCORD",
					title: payload.title,
					body: payload.body,
					status: "sent",
					retryCount: 0,
					error: null,
				});
		}
		for (const [index, owner] of owners.entries()) {
			const delivered = expected.filter((row) => row.owner === index && row.state === "sent");
			expect(result.channels.find((row) => row.id === owner.channelId)).toMatchObject({
				userId: owner.userId,
				lastSentAt: delivered.length ? expect.any(Date) : null,
				lastSendResult: delivered.length ? "success" : null,
			});
		}
		return result;
	};
	const recover = async (expected: Parameters<typeof assertGraph>[0]) => {
		expect(state).toMatchObject({
			teardown: 1,
			pending: 0,
			pendingAtTeardown: 0,
			afterTeardown: 0,
		});
		expect(active).toBe(0);
		await Promise.all(ticks);
		await native.runtime.drain();
		const before = await assertGraph(expected),
			beforeCounts = { ...counts },
			beforeRecords = [...records];
		const priorSent = [...sent];
		vi.spyOn(NotificationDispatcher.prototype, "send").mockImplementation(
			protect(async (type, config, payload) => {
				const ownerIndex = owners.findIndex(
					(row) => config.webhookUrl === `https://example.invalid/synthetic-snapshot/${row.userId}`,
				);
				expect(ownerIndex).toBeGreaterThanOrEqual(0);
				expect(type).toBe("DISCORD");
				expect(payload).toEqual(expectedPayload(payload.eventType as keyof typeof wantPayloads));
				sent.push(`${payload.eventType}:${ownerIndex === 0 ? "owner-a" : "owner-b"}`);
				return { success: true, retryable: false };
			}),
		);
		await native.restart(false);
		const recoveryClient = createRuntimePrismaClient(native.runtime),
			recoveryApp = Fastify({ logger: false });
		apps.push(recoveryApp);
		recoveryApp.decorate("restoreRuntime", native.runtime);
		await recoveryApp.register(
			fp(
				async (server) => {
					server.decorate("prisma", recoveryClient.prisma);
					server.decorate("dbProvider", native.engine as "sqlite" | "postgresql");
					server.addHook("onClose", async () => {
						await recoveryClient.close();
					});
				},
				{ name: "prisma" },
			),
		);
		await recoveryApp.register(
			fp(
				async (server) => {
					server.decorate("encryptor", native.encryptor);
					server.decorate("config", { APP_URL: "https://synthetic.invalid" } as never);
				},
				{ name: "security" },
			),
		);
		registerRestoreBootstrapPlugin(recoveryApp, notificationServicePlugin);
		registerRestoreRuntimeActivation(recoveryApp);
		await recoveryApp.ready();
		await recoveryApp.notificationService.drain();
		await native.runtime.drain();
		const readyRecipients = expected
			.filter((row) => row.state === "ready")
			.map((row) => `${row.eventType}:${row.owner === 0 ? "owner-a" : "owner-b"}`)
			.sort();
		expect(
			await waitForNative(() => {
				const newlySent = sent.slice(priorSent.length).sort();
				return (
					newlySent.length === readyRecipients.length &&
					newlySent.every((recipient, index) => recipient === readyRecipients[index])
				);
			}),
		).toBe(true);
		await recoveryApp.notificationService.drain();
		await native.runtime.drain();
		expect(sent.slice(priorSent.length).sort()).toEqual(
			expected
				.filter((row) => row.state === "ready")
				.map((row) => `${row.eventType}:${row.owner === 0 ? "owner-a" : "owner-b"}`)
				.sort(),
		);
		const recoveredExpected = expected.map((item) => ({
			...item,
			state:
				item.state === "ready" ? "sent" : item.state === "submitting" ? "uncertain" : item.state,
		}));
		const persistenceDeadline = performance.now() + 4_000;
		let persisted = false;
		do {
			// These sequential native reads join; transport acceptance is not a commit boundary.
			const observed = await graph();
			persisted =
				observed.events.length === recoveredExpected.length &&
				observed.deliveries.length === recoveredExpected.length &&
				observed.history.length ===
					recoveredExpected.filter((item) => item.state === "sent").length &&
				observed.channels.length === owners.length &&
				recoveredExpected.every((item) => {
					const owner = owners[item.owner]!;
					const event = observed.events
						.filter((row) => row.userId === owner.userId && row.eventType === item.eventType)
						.sort((a, b) => a.acceptedAt.getTime() - b.acceptedAt.getTime())[item.eventIndex ?? 0];
					const delivery = observed.deliveries.find(
						(row) =>
							row.eventId === event?.id &&
							row.userId === owner.userId &&
							row.channelId === owner.channelId,
					);
					const history = observed.history
						.filter((row) => row.channelId === owner.channelId && row.eventType === item.eventType)
						.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())[item.eventIndex ?? 0];
					return (
						delivery?.state === item.state &&
						event?.stage ===
							(item.state === "sent" || item.state === "uncertain" ? "terminal" : "ready") &&
						(item.state !== "sent" || history?.status === "sent")
					);
				});
			if (!persisted && performance.now() < persistenceDeadline) await settle();
		} while (!persisted && performance.now() < persistenceDeadline);
		expect(persisted && performance.now() <= persistenceDeadline).toBe(true);
		const after = await assertGraph(
			expected.map((row) => ({
				...row,
				state:
					row.state === "ready" ? "sent" : row.state === "submitting" ? "uncertain" : row.state,
			})),
		);
		expect(after.events.map((row) => row.id).sort()).toEqual(
			before.events.map((row) => row.id).sort(),
		);
		expect(after.deliveries.map((row) => row.id).sort()).toEqual(
			before.deliveries.map((row) => row.id).sort(),
		);
		expect(counts).toEqual(beforeCounts);
		expect(records).toEqual(beforeRecords);
		await recoveryApp.notificationService.drain();
		expect(sent).toHaveLength(
			priorSent.length + expected.filter((row) => row.state === "ready").length,
		);
		await recoveryApp.close();
	};
	const completeAccepted = async () => {
		// Started attempts must drain; unmarked accepted jobs remain READY until ordinary restart.
		const expected = allowedEvents.flatMap((eventType) =>
			owners.map((_, owner) => ({
				eventType,
				owner,
				state: sendEntries.some((row) => row.eventType === eventType && row.owner === owner)
					? ("sent" as const)
					: ("ready" as const),
			})),
		);
		await assertGraph(expected);
		if (expected.some((row) => row.state === "ready")) await recover(expected);
		return await assertGraph(expected.map((row) => ({ ...row, state: "sent" as const })));
	};
	const rejectedAccepted = async (
		phase: "subscription" | "send" | "notificationLog" | "channel",
	) => {
		expect(heldTarget).toBeDefined();
		const expected = allowedEvents
			.filter((eventType) => phase !== "subscription" || eventType !== heldTarget!.eventType)
			.flatMap((eventType) =>
				owners.map((_, owner) => {
					const failed =
						phase !== "subscription" &&
						heldTarget!.eventType === eventType &&
						heldTarget!.owner === owner;
					return {
						eventType,
						owner,
						state: failed
							? phase === "send"
								? ("uncertain" as const)
								: ("submitting" as const)
							: sendEntries.some((row) => row.eventType === eventType && row.owner === owner)
								? ("sent" as const)
								: ("ready" as const),
					};
				}),
			);
		await assertGraph(expected);
		await recover(expected);
	};
	const seedRetentionDeadline = async (at: number) =>
		native.run(async () => {
			for (const [index, row] of seeded.retention.entries()) {
				expect(
					(
						await native.prisma.sessionSnapshot.updateMany({
							where: { id: row.id, instanceId: instances[0]!.id },
							data: { capturedAt: new Date(at - RETENTION_MS + [-2, -1, 0, 1][index]!) },
						})
					).count,
				).toBe(1);
			}
		});
	const assertRetention = async (reject: boolean) =>
		native.run(async () => {
			const rows = await native.prisma.sessionSnapshot.findMany({
				where: { id: { in: seeded.retention.map((row) => row.id) }, instanceId: instances[0]!.id },
			});
			expect(rows.map((row) => row.id).sort()).toEqual(
				(reject ? seeded.retention : seeded.retention.slice(2)).map((row) => row.id).sort(),
			);
			expect(cleanupResults.map((row) => row.count)).toEqual(reject ? [] : [2]);
			expect(
				await native.prisma.sessionSnapshot.count({
					where: { id: seeded.history.id, instanceId: instances[0]!.id },
				}),
			).toBe(1);
		});
	const assertPersisted = async () =>
		native.run(async () => {
			const rows = await native.prisma.sessionSnapshot.findMany({
				where: { id: { in: records.map((row) => row.id) }, instanceId: { in: instanceIds } },
			});
			expect(
				rows
					.map((row) => ({
						id: row.id,
						instanceId: row.instanceId,
						concurrentStreams: row.concurrentStreams,
					}))
					.sort((a, b) => a.id.localeCompare(b.id)),
			).toEqual([...records].sort((a, b) => a.id.localeCompare(b.id)));
			for (const row of rows) {
				const receipt = parseSessionSnapshotMeasurement(row.measurementJson!);
				expect(receipt.status).toBe("verified");
				if (receipt.status === "verified")
					expect(receipt.measurement).toMatchObject({
						provider: instances.find((instance) => instance.id === row.instanceId)!.service,
						sourceScope: { connectionGeneration: 7, identityGeneration: 3 },
					});
			}
		});
	const dispose = async () => {
		const errors = [...boundaryErrors];
		try {
			expect(state.pendingAtTeardown).toBe(0);
			expect(state.afterTeardown).toBe(0);
			expect(state.forbidden).toBe(0);
			await assertPersisted();
		} catch (error) {
			errors.push(error);
		}
		try {
			await native.run(async () => {
				const where = { id: { in: instanceIds }, userId: { in: owners.map((row) => row.userId) } };
				expect((await native.prisma.serviceInstance.deleteMany({ where })).count).toBe(4);
				expect(await native.prisma.serviceInstance.count({ where })).toBe(0);
				expect(
					await native.prisma.sessionSnapshot.count({ where: { instanceId: { in: instanceIds } } }),
				).toBe(0);
				const users = { id: { in: owners.map((row) => row.userId) } };
				expect((await native.prisma.user.deleteMany({ where: users })).count).toBe(2);
				expect(await native.prisma.user.count({ where: users })).toBe(0);
				expect(
					await native.prisma.notificationOutboxEvent.count({ where: { userId: users.id } }),
				).toBe(0);
				expect(
					await native.prisma.notificationOutboxDelivery.count({ where: { userId: users.id } }),
				).toBe(0);
				expect(await native.prisma.notificationChannel.count({ where: { userId: users.id } })).toBe(
					0,
				);
			});
		} catch (error) {
			errors.push(error);
		}
		if (errors.length)
			throw new AggregateError(errors, "Native fixture assertions or scoped cleanup failed");
	};
	fixtures.push({ native, dispose });
	return {
		app,
		native,
		owners,
		instances,
		counts,
		state,
		records,
		sent,
		entered: entered.promise,
		closing: closing.promise,
		callback,
		idle,
		advance,
		activateSources,
		graph,
		assertGraph,
		failedPlexPayload,
		beginRecoveredProviderRound: () => {
			recoveredProviderRound = true;
		},
		recover,
		assertPersisted,
		seeded,
		cleanupResults,
		sendEntries,
		subscriptionEntries,
		completeAccepted,
		rejectedAccepted,
		providerEntries,
		seedRetentionDeadline,
		assertRetention,
	};
}
beforeEach(() => {
	installed.length = 0;
	activeTimers.clear();
	vi.useFakeTimers({
		toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	});
	vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
	const virtualDate = Date;
	virtualNow = () => virtualDate.now();
	const virtualTimeout = globalThis.setTimeout,
		virtualClear = globalThis.clearTimeout,
		virtualInterval = globalThis.setInterval,
		virtualClearInterval = globalThis.clearInterval;
	const schedulerCallsite = () =>
		new Error().stack
			?.split("\n")
			.find((line) => line.includes("/src/") && !line.includes("/__tests__/"))
			?.includes("/plugins/session-snapshot-scheduler.ts") === true;
	// Only the scheduler observes the virtual Date; native/outbox clocks and I/O timers remain real.
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
		if (!schedulerCallsite())
			return Reflect.apply(realTimeout, globalThis, [callback, delay, ...args]);
		const invoke = AsyncResource.bind(() => Reflect.apply(callback, globalThis, args));
		let handle: ReturnType<typeof setTimeout>;
		handle = Reflect.apply(virtualTimeout, globalThis, [
			() => {
				activeTimers.delete(handle);
				invoke();
			},
			delay,
		]);
		const row: TimerRecord = {
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
		if (installed.some((row) => row.handle === handle && row.kind === "timeout")) {
			activeTimers.delete(handle as ReturnType<typeof setTimeout>);
			return virtualClear(handle);
		}
		return realClearTimeout(handle);
	}) as typeof clearTimeout);
	vi.stubGlobal("setInterval", ((callback: () => void, delay?: number, ...args: unknown[]) => {
		if (!schedulerCallsite())
			return Reflect.apply(realInterval, globalThis, [callback, delay, ...args]);
		const invoke = AsyncResource.bind(() => Reflect.apply(callback, globalThis, args));
		let row: TimerRecord;
		const handle = Reflect.apply(virtualInterval, globalThis, [
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
		if (installed.some((row) => row.handle === handle && row.kind === "interval")) {
			activeTimers.delete(handle as ReturnType<typeof setTimeout>);
			return virtualClearInterval(handle);
		}
		return realClearInterval(handle);
	}) as typeof clearInterval);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Fixture forbids network"));
});
afterEach(async () => {
	const errors: unknown[] = [];
	try {
		for (const release of releases.splice(0)) release();
		for (const result of await Promise.allSettled(ticks.splice(0)))
			if (result.status === "rejected") errors.push(result.reason);
		for (const result of await Promise.allSettled(apps.splice(0).map((app) => app.close())))
			if (result.status === "rejected") errors.push(result.reason);
		try {
			expect(globalThis.fetch).not.toHaveBeenCalled();
		} catch (error) {
			errors.push(error);
		}
		vi.restoreAllMocks();
		for (const { native, dispose } of fixtures.splice(0)) {
			try {
				await native.runtime.drain();
				await dispose();
			} catch (error) {
				errors.push(error);
			} finally {
				try {
					await native.close();
				} catch (error) {
					errors.push(error);
				}
			}
		}
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	}
	if (errors.length) throw new AggregateError(errors, "Native fixture teardown failed");
});
async function start(fixture: Awaited<ReturnType<typeof boot>>, origin: Origin) {
	if (origin === "interval") {
		fixture.callback("startup")();
		await fixture.idle();
		await fixture.activateSources();
	}
	fixture.callback(origin)();
}

describe("Session snapshot scheduler lifetime", () => {
	for (const origin of ["startup", "interval"] as const) {
		for (const phase of [
			"plexLookup",
			"mediaLookup",
			"platformRead",
			"plexProvider",
			"mediaProvider",
			"snapshotWrite",
		] as const) {
			for (const reject of [false, true]) {
				it(`drains ${origin} ${phase} ${reject ? "failure" : "completion"} before database teardown`, async () => {
					const gate = deferred();
					const f = await boot({
						warmupEmpty: origin === "interval",
						hold: {
							phase,
							gate: gate.promise,
							reject,
							call:
								origin === "interval" && (phase === "plexLookup" || phase === "mediaLookup")
									? 2
									: 1,
						},
					});
					await start(f, origin);
					await f.entered;
					let closed = false;
					const close = f.app.close().then(() => {
						closed = true;
					});
					await f.closing;
					await settle();
					expect(closed).toBe(false);
					expect(f.state.teardown).toBe(0);
					const admitted = {
						plexProvider: f.counts.plexProvider,
						mediaProvider: f.counts.mediaProvider,
						platformRead: f.counts.platformRead,
						snapshotWrite: f.counts.snapshotWrite,
						subscription: f.counts.subscription,
					};
					gate.resolve();
					await close;
					expect(f.state.pendingAtTeardown).toBe(0);
					expect(f.state.afterTeardown).toBe(0);
					// A late lookup/platform page/provider result must not start more
					// reads or persistence after cancellation. Already-entered writes
					// still settle, including a real failure at the held write boundary.
					expect(f.counts).toMatchObject(admitted);
					expect(f.records).toHaveLength(
						admitted.snapshotWrite - (phase === "snapshotWrite" && reject ? 1 : 0),
					);
					expect(f.app.schedulerRegistry.getStatus(JOB_ID.sessionSnapshot)).toMatchObject({
						totalFailures: phase === "snapshotWrite" && reject ? 1 : 0,
					});
				});
			}
		}
	}
	it.each(["subscription", "send", "notificationLog", "channel"] as const)(
		"retains accepted notification %s until processing settles",
		async (phase) => {
			const gate = deferred();
			const f = await boot({ hold: { phase, gate: gate.promise } });
			f.callback("startup")();
			await f.entered;
			expect(
				await waitForNative(() =>
					allowedEvents.every((event) => f.subscriptionEntries.includes(event)),
				),
			).toBe(true);
			expect([...f.subscriptionEntries].sort()).toEqual([...allowedEvents].sort());
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
			const completed = await f.completeAccepted();
			expect(f.sent.sort()).toEqual([
				"JELLYFIN_CONCURRENT_PEAK:owner-a",
				"JELLYFIN_CONCURRENT_PEAK:owner-b",
				"PLEX_CONCURRENT_PEAK:owner-a",
				"PLEX_CONCURRENT_PEAK:owner-b",
			]);
			expect(completed.history.map((row) => row.status)).toEqual(["sent", "sent", "sent", "sent"]);
			expect(f.state.pendingAtTeardown).toBe(0);
			expect(f.state.afterTeardown).toBe(0);
		},
	);
	it.each([false, true])(
		"drains retention delete completion (reject=%s) without changing its age selector",
		async (reject) => {
			const gate = deferred();
			const f = await boot({ empty: true, hold: { phase: "cleanup", gate: gate.promise, reject } });
			f.callback("startup")();
			await f.idle();
			f.callback("cleanup")();
			await f.entered;
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
			expect(f.counts.cleanup).toBe(1);
			await f.assertRetention(reject);
			expect(f.state.pendingAtTeardown).toBe(0);
			expect(f.state.afterTeardown).toBe(0);
		},
	);
	it("preserves accepted child admission after preClose without admitting ordinary notifications", async () => {
		const gate = deferred();
		const f = await boot({
			hold: { phase: "subscription", eventType: "PLEX_CONCURRENT_PEAK", gate: gate.promise },
		});
		f.callback("startup")();
		await f.entered;
		const close = f.app.close();
		await f.closing;
		await settle();
		await expect(
			f.app.notificationService.notify({
				eventType: "PLEX_CONCURRENT_PEAK",
				title: "Synthetic",
				body: "Synthetic",
			}),
		).rejects.toThrow("shutting down");
		gate.resolve();
		await close;
		await f.completeAccepted();
		expect(f.sent.filter((s) => s.startsWith("PLEX_")).sort()).toEqual([
			"PLEX_CONCURRENT_PEAK:owner-a",
			"PLEX_CONCURRENT_PEAK:owner-b",
		]);
		expect(f.state.afterTeardown).toBe(0);
	});
	it("refuses captured startup callback during sibling preClose and after teardown", async () => {
		const gate = deferred();
		const f = await boot({ empty: true, preCloseGate: gate.promise });
		const startup = f.callback("startup"),
			timersBefore = activeTimers.size;
		const close = f.app.close();
		await f.closing;
		startup();
		await settle();
		expect(f.counts.plexLookup).toBe(0);
		expect(f.counts.mediaLookup).toBe(0);
		expect(activeTimers.size).toBeLessThan(timersBefore);
		gate.resolve();
		await close;
		startup();
		await settle();
		expect(f.counts.plexLookup).toBe(0);
		expect(f.counts.mediaLookup).toBe(0);
		expect(activeTimers.size).toBe(0);
	});
	it("refuses retired interval and cleanup callbacks without reinstalling timers", async () => {
		const f = await boot({ empty: true });
		f.callback("startup")();
		await f.idle();
		const capture = f.callback("interval"),
			cleanup = f.callback("cleanup");
		await f.app.close();
		capture();
		cleanup();
		await settle();
		expect(f.counts.plexLookup).toBe(1);
		expect(f.counts.mediaLookup).toBe(1);
		expect(f.counts.cleanup).toBe(0);
		expect(f.state.afterTeardown).toBe(0);
		expect(activeTimers.size).toBe(0);
	});
	it("closes admission without blocking sibling preClose hooks and joins duplicate closes", async () => {
		const gate = deferred();
		const f = await boot({ hold: { phase: "mediaLookup", gate: gate.promise } });
		f.callback("startup")();
		await f.entered;
		const first = f.app.close(),
			second = f.app.close();
		await f.closing;
		await settle();
		expect(f.state.teardown).toBe(0);
		gate.resolve();
		await Promise.all([first, second]);
		expect(f.state.teardown).toBe(1);
		expect(f.state.pendingAtTeardown).toBe(0);
	});
	it("retains both parallel media lookups until the final accepted read settles", async () => {
		const gate = deferred();
		const f = await boot({ empty: true, hold: { phase: "plexLookup", gate: gate.promise } });
		f.callback("startup")();
		await f.entered;
		expect(await waitForNative(() => f.counts.mediaLookup === 1 && f.state.pending === 1)).toBe(
			true,
		);
		expect(f.counts.mediaLookup).toBe(1);
		expect(f.state.pending).toBe(1);
		expect(f.app.schedulerRegistry.getStatus(JOB_ID.sessionSnapshot)?.state).toBe("running");
		const close = f.app.close();
		await f.closing;
		await settle();
		expect(f.state.teardown).toBe(0);
		gate.resolve();
		await close;
		expect(f.state.afterTeardown).toBe(0);
	});
	// This case boots native state and drains two capture rounds; keep its finite
	// fixture budget separate from the unchanged cadence and 4-second predicates.
	it("allows the next capture after a rejected provider read without changing interval cadence", async () => {
		const gate = deferred();
		const f = await boot({ hold: { phase: "plexProvider", gate: gate.promise, reject: true } });
		f.callback("startup")();
		await f.entered;
		gate.resolve();
		await f.idle();
		// Physically finish the failed round before admitting the recovery round.
		await f.app.notificationService.drain();
		await f.assertGraph(
			[0, 1].flatMap((owner) => [
				{
					owner,
					eventType: "PLEX_CONCURRENT_PEAK" as const,
					state: "sent" as const,
					payload: f.failedPlexPayload,
				},
				{
					owner,
					eventType: "JELLYFIN_CONCURRENT_PEAK" as const,
					state: "sent" as const,
					payload: wantPayloads.JELLYFIN_CONCURRENT_PEAK,
				},
			]),
		);
		expect(f.records.map((r) => r.instanceId).sort()).toEqual(
			f.instances.map((row) => row.id).sort(),
		);
		const firstPlexRead = f.providerEntries.find((id) =>
			f.instances.some((row) => row.id === id && row.service === "PLEX"),
		)!;
		expect(f.instances.slice(0, 2).map((row) => row.id)).toContain(firstPlexRead);
		expect(f.records.find((r) => r.instanceId === firstPlexRead)?.concurrentStreams).toBe(0);
		expect(f.app.schedulerRegistry.getStatus(JOB_ID.sessionSnapshot)?.consecutiveFailures).toBe(1);
		await f.advance(CAPTURE_MS - 1);
		expect(f.counts.plexLookup).toBe(1);
		f.beginRecoveredProviderRound();
		await f.advance(1);
		await f.idle();
		expect(f.counts.plexLookup).toBe(2);
		expect(f.counts.mediaLookup).toBe(2);
		expect(f.records.length).toBe(8);
		expect(f.app.schedulerRegistry.getStatus(JOB_ID.sessionSnapshot)?.consecutiveFailures).toBe(0);
		await f.app.notificationService.drain();
		await f.assertGraph(
			[0, 1].flatMap((owner) => [
				{
					owner,
					eventType: "PLEX_CONCURRENT_PEAK" as const,
					eventIndex: 0,
					state: "sent" as const,
					payload: f.failedPlexPayload,
				},
				{
					owner,
					eventType: "PLEX_CONCURRENT_PEAK" as const,
					eventIndex: 1,
					state: "sent" as const,
					payload: wantPayloads.PLEX_CONCURRENT_PEAK,
				},
				{
					owner,
					eventType: "JELLYFIN_CONCURRENT_PEAK" as const,
					state: "sent" as const,
					payload: wantPayloads.JELLYFIN_CONCURRENT_PEAK,
				},
			]),
		);
	}, 10_000);
	it("keeps accepted capture and retention excluded from maintenance until completion", async () => {
		const gate = deferred();
		const f = await boot({ empty: true, hold: { phase: "cleanup", gate: gate.promise } });
		f.callback("startup")();
		await f.idle();
		f.callback("cleanup")();
		await f.entered;
		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toThrow("maintenance");
		gate.resolve();
		await f.idle();
		await expect(withCleanupMaintenanceGuard(async () => undefined)).resolves.toBeUndefined();
	});
	it.each(["subscription", "send", "notificationLog", "channel"] as const)(
		"drains accepted notification %s rejection without stranding capture",
		async (phase) => {
			const gate = deferred();
			const f = await boot({ hold: { phase, gate: gate.promise, reject: true } });
			f.callback("startup")();
			await f.entered;
			expect(
				await waitForNative(() =>
					allowedEvents.every((event) => f.subscriptionEntries.includes(event)),
				),
			).toBe(true);
			expect([...f.subscriptionEntries].sort()).toEqual([...allowedEvents].sort());
			let closed = false;
			const close = f.app.close().then(() => {
				closed = true;
			});
			await f.closing;
			await settle();
			expect(closed).toBe(false);
			gate.resolve();
			await close;
			expect(f.records.length).toBe(4);
			await f.rejectedAccepted(phase);
			expect(f.state.pendingAtTeardown).toBe(0);
			expect(f.state.afterTeardown).toBe(0);
		},
	);

	// Include native boot and both capture rounds, like the recovery case above,
	// without extending either four-second capture predicate.
	it("continues Plex capture while the previous tick's notification processing is pending", async () => {
		const gate = deferred();
		const f = await boot({
			hold: { phase: "subscription", eventType: "PLEX_CONCURRENT_PEAK", gate: gate.promise },
		});
		f.callback("startup")();
		await f.entered;
		expect(await waitForNative(() => f.records.length === 4)).toBe(true);
		expect(f.records.length).toBe(4);
		vi.setSystemTime(new Date("2026-10-02T00:05:00Z"));
		f.callback("interval")();
		expect(await waitForNative(() => f.records.length === 8)).toBe(true);
		expect(f.counts.plexProvider).toBe(4);
		expect(f.records.length).toBe(8);
		let closed = false;
		const close = f.app.close().then(() => {
			closed = true;
		});
		await f.closing;
		await settle();
		expect(closed).toBe(false);
		gate.resolve();
		await close;
		expect(f.state.afterTeardown).toBe(0);
	}, 10_000);

	it("drains every accepted overlapping tick, not merely the most recent completion", async () => {
		const gate = deferred();
		const f = await boot({ empty: true, hold: { phase: "mediaLookup", gate: gate.promise } });
		f.callback("startup")();
		await f.entered;
		f.callback("interval")();
		expect(await waitForNative(() => f.counts.mediaLookup === 2)).toBe(true);
		expect(f.counts.mediaLookup).toBe(2);
		expect(f.app.schedulerRegistry.getStatus(JOB_ID.sessionSnapshot)?.state).toBe("running");
		let closed = false;
		const close = f.app.close().then(() => {
			closed = true;
		});
		await f.closing;
		await settle();
		expect(closed).toBe(false);
		gate.resolve();
		await close;
		expect(f.state.afterTeardown).toBe(0);
		expect(f.app.schedulerRegistry.getStatus(JOB_ID.sessionSnapshot)?.totalRuns).toBe(2);
	});

	it("retains an independent capture maintenance lease after its launch context exits", async () => {
		const gate = deferred();
		const f = await boot({ empty: true, hold: { phase: "plexLookup", gate: gate.promise } });
		f.callback("startup")();
		await f.entered;
		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toThrow("maintenance");
		gate.resolve();
		await f.idle();
		await expect(withCleanupMaintenanceGuard(async () => undefined)).resolves.toBeUndefined();
	});

	it("pauses capture and retention during maintenance, then resumes after release", async () => {
		const f = await boot({ empty: true });
		f.callback("startup")();
		await f.idle();
		const gate = deferred();
		const maintenance = withCleanupMaintenanceGuard(() => gate.promise);
		f.callback("interval")();
		f.callback("cleanup")();
		await f.idle();
		expect(f.counts.plexLookup).toBe(1);
		expect(f.counts.mediaLookup).toBe(1);
		expect(f.counts.cleanup).toBe(0);
		gate.resolve();
		await maintenance;
		f.callback("interval")();
		f.callback("cleanup")();
		await f.idle();
		expect(f.counts.plexLookup).toBe(2);
		expect(f.counts.mediaLookup).toBe(2);
		expect(f.counts.cleanup).toBe(1);
	});
	it("uses natural 60s startup, 5m capture and daily strict retention boundaries", async () => {
		// 289 sequential native DB ticks need a bounded integration-test budget.
		const f = await boot({ empty: true });
		await f.seedRetentionDeadline(virtualNow() + STARTUP_MS + CLEANUP_MS);
		await f.advance(STARTUP_MS - 1);
		expect(f.counts.plexLookup).toBe(0);
		expect(f.counts.mediaLookup).toBe(0);
		expect(f.counts.cleanup).toBe(0);
		await f.advance(1);
		expect(f.counts.plexLookup).toBe(1);
		expect(f.counts.mediaLookup).toBe(1);
		await f.advance(CAPTURE_MS - 1);
		expect(f.counts.plexLookup).toBe(1);
		await f.advance(1);
		expect(f.counts.plexLookup).toBe(2);
		expect(f.counts.mediaLookup).toBe(2);
		await f.advance(CLEANUP_MS - CAPTURE_MS - 1);
		expect(f.counts.plexLookup).toBe(288);
		expect(f.counts.mediaLookup).toBe(288);
		expect(f.counts.cleanup).toBe(0);
		expect(
			await f.native.run(() =>
				f.native.prisma.sessionSnapshot.count({
					where: { id: { in: f.seeded.retention.map((row) => row.id) } },
				}),
			),
		).toBe(4);
		await f.advance(1);
		await f.idle();
		expect(f.counts.plexLookup).toBe(289);
		expect(f.counts.mediaLookup).toBe(289);
		expect(f.counts.cleanup).toBe(1);
		await f.assertRetention(false);
		expect(f.records).toEqual([]);
		expect(await f.graph()).toMatchObject({ events: [], deliveries: [], history: [] });
		await f.app.close();
		expect(activeTimers.size).toBe(0);
	}, 30_000);
});
