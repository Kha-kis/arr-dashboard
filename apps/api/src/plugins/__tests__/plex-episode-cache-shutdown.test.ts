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
import {
	withCleanupMaintenanceGuard,
	withCleanupOperationGuard,
} from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { NotificationDispatcher } from "../../lib/notifications/notification-dispatcher.js";
import type { ServiceInstance } from "../../lib/prisma.js";
import { buildObservationAuthorityKey } from "../../lib/provider-observation/observation-run-types.js";

import {
	type EpisodeRefreshRetryResult,
	type EpisodeRefreshSchedulerBridge,
	ensureEpisodeRefreshScheduler,
} from "../../lib/services/episode-refresh-scheduler-bridge.js";
import notificationPlugin from "../notification-service.js";
import cachePlugin from "../plex-episode-cache-scheduler.js";
import registryPlugin from "../scheduler-registry.js";

const boundaries = vi.hoisted(() => ({ refresh: vi.fn(), evidence: vi.fn() }));
vi.mock("../../lib/plex/plex-refresh-orchestration.js", () => ({
	refreshOwnedPlexEpisodeCache: boundaries.refresh,
}));
vi.mock("../../lib/plex/plex-persisted-observation-repository.js", () => ({
	getPublishedEpisodeGenerationObservation: boundaries.evidence,
}));
const STARTUP_MS = 300_000,
	INTERVAL_MS = 6 * 60 * 60_000;
type Origin = "startup" | "interval" | "continuation" | "manual";
type Phase =
	| "round"
	| "owner"
	| "page"
	| "retryState"
	| "stale"
	| "evidence"
	| "subscription"
	| "send"
	| "log"
	| "channel";
type Native = Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
type AwaitOnly<T> = T extends (...args: infer Args) => unknown
	? (...args: Args) => PromiseLike<unknown>
	: never;
const apps: FastifyInstance[] = [],
	releases: Array<() => void> = [],
	tasks: Promise<unknown>[] = [];
const fixtures = new Map<
	Native,
	{
		instances: Array<{ id: string; userId: string }>;
		statuses: string[];
		runs: string[];
		owners: Array<{ userId: string; channelId: string }>;
	}
>();
const realTimeout = globalThis.setTimeout,
	realClearTimeout = globalThis.clearTimeout;
const realInterval = globalThis.setInterval,
	realClearInterval = globalThis.clearInterval;
type TimerRecord = {
	kind: "timeout" | "interval";
	delay: number;
	dueAt: number;
	callback: () => void;
	handle: ReturnType<typeof setTimeout>;
};
const installed: TimerRecord[] = [],
	activeTimers = new Map<ReturnType<typeof setTimeout>, TimerRecord>();
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
const wantPayload = {
	eventType: "CACHE_REFRESH_STALE",
	title: "Plex episode cache data is stale",
	body: "Episode cache has not refreshed in over 12 hours for: Same synthetic label",
	url: "https://example.invalid/settings",
};
async function cleanup(native: Native) {
	const owned = fixtures.get(native)!;
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
			await native.prisma.cacheRefreshStatus.count({ where: { id: { in: owned.statuses } } }),
		).toBe(0);
		expect(
			await native.prisma.providerObservationRun.count({ where: { id: { in: owned.runs } } }),
		).toBe(0);
		const where = {
			OR: owned.owners.map((row) => ({
				channelId: row.channelId,
				eventType: "CACHE_REFRESH_STALE",
				channel: { userId: row.userId },
			})),
		};
		expect((await native.prisma.notificationSubscription.deleteMany({ where })).count).toBe(
			owned.owners.length,
		);
		expect(await native.prisma.notificationSubscription.count({ where })).toBe(0);
		const channels = owned.owners.map((row) => ({ id: row.channelId, userId: row.userId }));
		expect(
			(await native.prisma.notificationChannel.deleteMany({ where: { OR: channels } })).count,
		).toBe(channels.length);
		expect(
			await native.prisma.notificationChannel.count({
				where: { id: { in: channels.map((row) => row.id) } },
			}),
		).toBe(0);
	});
	await native.close();
	fixtures.delete(native);
}
// Native runtime/SQL/owners/crypto. Only provider refresh, explicitly simulated
// persisted observation, and outbound transport are synthetic, not publication proof.
async function boot(
	options: {
		origin?: Origin;
		hold?: { phase: Phase; gate: Promise<void>; reject?: boolean; call?: number };
		failure?: "exception" | "dependency" | "parent" | "superseded" | "unavailable";
		overdue?: boolean;
		stale?: boolean;
		empty?: boolean;
		instances?: number;
		preCloseGate?: Promise<void>;
	} = {},
) {
	const native = await createNotificationOutboxNativeFixture();
	const ownerRows = [
		{ userId: native.userId, channelId: native.channelId },
		await native.createOwner(),
	];
	const owned = {
		instances: [] as Array<{ id: string; userId: string }>,
		statuses: [] as string[],
		runs: [] as string[],
		owners: ownerRows,
	};
	fixtures.set(native, owned);
	await native.run(async () => {
		for (const [index, owner] of ownerRows.entries()) {
			const encrypted = native.encryptor.encrypt(
				JSON.stringify({ webhookUrl: `https://example.invalid/synthetic-worker/${owner.userId}` }),
			);
			expect(
				(
					await native.prisma.notificationChannel.updateMany({
						where: { id: owner.channelId, userId: owner.userId },
						data: {
							name: "Same synthetic channel",
							encryptedConfig: encrypted.value,
							configIv: encrypted.iv,
						},
					})
				).count,
			).toBe(1);
			await native.prisma.notificationSubscription.create({
				data: { channelId: owner.channelId, eventType: "CACHE_REFRESH_STALE" },
			});
			const key = native.encryptor.encrypt("synthetic-provider-key");
			const row = await native.prisma.serviceInstance.create({
				data: {
					userId: owner.userId,
					service: "PLEX",
					label: "Same synthetic label",
					baseUrl: "https://example.invalid/synthetic-provider",
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
					enabled: !options.empty && (index === 0 || options.instances === 2),
					connectionGeneration: 7,
					expectedIdentity: `synthetic-identity-${index}`,
					identityGeneration: 3,
					identityStatus: "VERIFIED",
				},
			});
			owned.instances.push({ id: row.id, userId: row.userId });
			const status = await native.prisma.cacheRefreshStatus.create({
				data: {
					instanceId: row.id,
					cacheType: "plex_episode",
					lastRefreshedAt: new Date(
						Date.now() - (options.stale && index === 0 ? 13 * 60 * 60_000 : 0),
					),
					lastResult: "success",
					lastAttemptAt: new Date(0),
					lastAttemptResult: "in_progress:00000000-0000-0000-0000-000000000001",
				},
			});
			owned.statuses.push(status.id);
		}
		if (options.overdue) {
			const authority = {
				instanceId: owned.instances[0]!.id,
				provider: "plex_episode" as const,
				cacheType: "plex_episode" as const,
				parentGenerationId: null,
				targetDigest: "a".repeat(64),
				connectionGeneration: 7,
				identityGeneration: 3,
			};
			const row = await native.prisma.providerObservationRun.create({
				data: {
					...authority,
					authorityKey: buildObservationAuthorityKey(authority),
					targetCount: 1,
					state: "failed",
					totalUnits: 1,
					totalWork: 1,
					nextAttemptAt: new Date(),
					completedAt: new Date(),
					lastReasonCode: "provider-unavailable",
				},
			});
			owned.runs.push(row.id);
		}
	});
	const instances = await native.run(() =>
		native.prisma.serviceInstance.findMany({ where: { OR: owned.instances } }),
	);
	await native.restart(false);
	const client = createRuntimePrismaClient(native.runtime),
		prisma = client.prisma;
	const counts: Record<Phase, number> = {
		round: 0,
		owner: 0,
		page: 0,
		retryState: 0,
		stale: 0,
		evidence: 0,
		subscription: 0,
		send: 0,
		log: 0,
		channel: 0,
	};
	const pageInputs: Array<{ id: string; userId: string; resume: boolean; attempt: unknown }> = [];
	const attempt = {
		attemptedAt: new Date(),
		resultMarker: "in_progress:00000000-0000-0000-0000-000000000001",
	};
	let pageActive = 0,
		maxPages = 0;
	const state = {
		pending: 0,
		teardown: false,
		pendingAtTeardown: -1,
		afterTeardown: 0,
		forbidden: 0,
		network: 0,
	};
	let held = false,
		active = 0;
	const entered = deferred(),
		preClosed = deferred();
	const pause = async (phase: Phase) => {
		const count = ++counts[phase];
		if (state.teardown) state.afterTeardown++;
		state.pending++;
		try {
			if (options.hold?.phase === phase && count === (options.hold.call ?? 1)) {
				held = true;
				entered.resolve();
				await options.hold.gate;
				if (options.hold.reject) throw new Error("Synthetic boundary unavailable");
			}
		} finally {
			if (state.teardown) state.afterTeardown++;
			state.pending--;
		}
	};
	const refuse = () => {
		state.forbidden++;
		throw new Error("Unexpected provider access");
	};
	vi.stubGlobal("fetch", () => {
		state.network++;
		return refuse();
	});
	const lookup = prisma.serviceInstance.findMany.bind(prisma.serviceInstance);
	const reads: { findMany: AwaitOnly<typeof prisma.serviceInstance.findMany> } =
		prisma.serviceInstance;
	vi.spyOn(reads, "findMany").mockImplementation(async (args) => {
		expect(args).toEqual({ where: { service: "PLEX", enabled: true } });
		await pause("round");
		const rows = await lookup(args);
		for (const row of rows) expect(instances).toContainEqual(row);
		return rows;
	});
	const current = prisma.serviceInstance.findFirst.bind(prisma.serviceInstance);
	const currentReads: { findFirst: AwaitOnly<typeof prisma.serviceInstance.findFirst> } =
		prisma.serviceInstance;
	vi.spyOn(currentReads, "findFirst").mockImplementation(async (args) => {
		expect(args).toEqual({
			where: {
				id: expect.any(String),
				userId: expect.any(String),
				service: "PLEX",
				enabled: true,
			},
		});
		await pause("owner");
		const row = await current(args);
		if (row) expect(instances).toContainEqual(row);
		return row;
	});
	const retryRead = prisma.providerObservationRun.findFirst.bind(prisma.providerObservationRun);
	const retryReads: { findFirst: AwaitOnly<typeof prisma.providerObservationRun.findFirst> } =
		prisma.providerObservationRun;
	vi.spyOn(retryReads, "findFirst").mockImplementation(async (args) => {
		expect(args).toEqual({
			where: {
				instanceId: expect.any(String),
				provider: "plex_episode",
				cacheType: "plex_episode",
				state: "failed",
			},
			select: { nextAttemptAt: true },
		});
		expect(instances.some((row) => row.id === args?.where?.instanceId)).toBe(true);
		await pause("retryState");
		return retryRead({ ...args, select: { nextAttemptAt: true } });
	});
	const stale = prisma.cacheRefreshStatus.findMany.bind(prisma.cacheRefreshStatus);
	const statusReads: { findMany: AwaitOnly<typeof prisma.cacheRefreshStatus.findMany> } =
		prisma.cacheRefreshStatus;
	vi.spyOn(statusReads, "findMany").mockImplementation(async (args) => {
		expect(args).toEqual({
			where: { cacheType: "plex_episode", instance: { enabled: true } },
			include: { instance: true },
		});
		await pause("stale");
		const rows = await stale({ ...args, include: { instance: true } });
		for (const row of rows) {
			expect(owned.statuses).toContain(row.id);
			expect(instances).toContainEqual(row.instance);
		}
		return rows;
	});
	const subscription = prisma.notificationSubscription.findMany.bind(
		prisma.notificationSubscription,
	);
	const subscriptions: { findMany: AwaitOnly<typeof prisma.notificationSubscription.findMany> } =
		prisma.notificationSubscription;
	let acceptedAt: Date | undefined;
	vi.spyOn(subscriptions, "findMany").mockImplementation(async (args) => {
		acceptedAt = new Date();
		expect(args).toEqual({
			where: { eventType: "CACHE_REFRESH_STALE" },
			include: { channel: true },
		});
		await pause("subscription");
		const rows = await subscription({ ...args, include: { channel: true } });
		expect(rows).toHaveLength(2);
		expect(
			rows
				.map((row) => ({ userId: row.channel.userId, channelId: row.channelId }))
				.sort((a, b) => a.userId.localeCompare(b.userId)),
		).toEqual([...ownerRows].sort((a, b) => a.userId.localeCompare(b.userId)));
		return rows;
	});
	const transaction = prisma.$transaction.bind(prisma);
	const sent: string[] = [],
		deliveries: string[] = [],
		sendOwners: string[] = [];
	vi.spyOn(prisma, "$transaction").mockImplementation(async (operation, transactionOptions) =>
		transaction(async (tx) => {
			const historyWrite = tx.notificationLog.create.bind(tx.notificationLog);
			const history: { create: AwaitOnly<typeof tx.notificationLog.create> } = tx.notificationLog;
			vi.spyOn(history, "create").mockImplementation(async (args) => {
				expect(ownerRows.map((row) => row.channelId)).toContain(args.data.channelId);
				expect(args.data).toMatchObject({
					eventType: "CACHE_REFRESH_STALE",
					title: wantPayload.title,
					body: wantPayload.body,
				});
				await pause("log");
				const row = await historyWrite(args);
				deliveries.push(row.status);
				return row;
			});
			const channelWrite = tx.notificationChannel.updateMany.bind(tx.notificationChannel);
			const channels: { updateMany: AwaitOnly<typeof tx.notificationChannel.updateMany> } =
				tx.notificationChannel;
			vi.spyOn(channels, "updateMany").mockImplementation(async (args) => {
				const owner = ownerRows.find((row) => row.channelId === args.where?.id);
				expect(owner).toBeDefined();
				expect(args.where?.userId).toBe(owner!.userId);
				if (args.data.lastSendResult !== undefined) await pause("channel");
				return channelWrite(args);
			});
			return operation(tx);
		}, transactionOptions),
	);
	const app = Fastify({ logger: false });
	apps.push(app);
	boundaries.refresh.mockImplementation(
		async (
			context: {
				prisma: unknown;
				signal: AbortSignal;
				encryptor: unknown;
				instance: ServiceInstance;
				log: unknown;
				resumeFailed: boolean;
			},
			retained: unknown,
		) => {
			expect(context).toEqual({
				prisma,
				signal: expect.any(AbortSignal),
				encryptor: native.encryptor,
				instance: expect.anything(),
				log: app.log,
				resumeFailed: expect.any(Boolean),
				diagnostics: { stage: "not-started" },
			});
			expect(instances).toContainEqual(context.instance);
			expect(
				native.encryptor.decrypt({
					value: context.instance.encryptedApiKey,
					iv: context.instance.encryptionIv,
				}),
			).toBe("synthetic-provider-key");
			pageInputs.push({
				id: context.instance.id,
				userId: context.instance.userId,
				resume: context.resumeFailed,
				attempt: retained,
			});
			pageActive++;
			maxPages = Math.max(maxPages, pageActive);
			try {
				await pause("page");
				if (options.failure === "exception")
					throw Object.assign(new Error("Synthetic provider failure"), { code: "DB_BUSY" });
				const partial = options.origin === "continuation" && counts.page === 1;
				const unavailable = options.overdue || options.failure === "unavailable";
				return {
					complete: !partial && !options.failure && !options.overdue,
					errors: unavailable || (!partial && options.hold?.phase === "retryState") ? 1 : 0,
					errorMessages: [],
					upserted: unavailable ? 0 : 1,
					eligibleShows: 1,
					refreshedShows: unavailable ? 0 : 1,
					coverageIncomplete: partial || Boolean(options.failure) || Boolean(options.overdue),
					capacityDegraded: false,
					...(partial || options.failure === "parent" ? { continuationAttempt: attempt } : {}),
					...(options.failure === "dependency" ? { retryCategory: "identity-unavailable" } : {}),
					...(options.failure === "parent" ? { retryCategory: "parent-refresh-in-progress" } : {}),
					...(options.failure === "superseded" ? { superseded: true } : {}),
				};
			} finally {
				pageActive--;
			}
		},
	);
	boundaries.evidence.mockImplementation(
		async (
			observationClient: unknown,
			input: { userId: string; instanceId: string; instance: ServiceInstance; maxAgeMs: number },
		) => {
			expect(observationClient).toBe(prisma);
			expect(input).toEqual({
				userId: input.instance.userId,
				instanceId: input.instance.id,
				instance: expect.anything(),
				maxAgeMs: 12 * 60 * 60_000,
			});
			expect(instances).toContainEqual(input.instance);
			await pause("evidence");
			return {
				available: true,
				evidence: { publicationLevel: "authoritative", completeness: "complete", reasonCodes: [] },
			};
		},
	);
	vi.spyOn(NotificationDispatcher.prototype, "send").mockImplementation(
		async (type, config, payload) => {
			expect(type).toBe("DISCORD");
			expect(
				ownerRows.some(
					(row) => config.webhookUrl === `https://example.invalid/synthetic-worker/${row.userId}`,
				),
			).toBe(true);
			expect(payload).toEqual(wantPayload);
			sendOwners.push(
				ownerRows.find(
					(row) => config.webhookUrl === `https://example.invalid/synthetic-worker/${row.userId}`,
				)!.userId,
			);
			await pause("send");
			sent.push(payload.eventType);
			return { success: true, retryable: false };
		},
	);
	app.decorate("restoreRuntime", native.runtime);
	app.decorate("prisma", prisma);
	app.decorate("encryptor", native.encryptor);
	app.decorate("config", { APP_URL: "https://example.invalid" } as never);
	app.decorate("arrClientFactory", { create: refuse } as never);
	await app.register(
		fp(
			async (server) => {
				server.addHook("onClose", async () => {
					state.pendingAtTeardown = state.pending;
					expect(state.pending).toBe(0);
					expect(state.forbidden).toBe(0);
					expect(state.network).toBe(0);
					expect(active).toBe(0);
					await client.close();
					state.teardown = true;
				});
			},
			{ name: "prisma" },
		),
	);
	await app.register(fp(async () => {}, { name: "security" }));
	registerRestoreBootstrapPlugin(app, notificationPlugin);
	registerRestoreBootstrapPlugin(app, registryPlugin);
	await app.after();
	const track = app.schedulerRegistry.track.bind(app.schedulerRegistry);
	vi.spyOn(app.schedulerRegistry, "track").mockImplementation((...args) => {
		active++;
		const task = track(...args).finally(() => {
			active--;
		});
		tasks.push(task.catch(() => undefined));
		return task;
	});
	const bridge = ensureEpisodeRefreshScheduler(app).episodeRefreshScheduler;
	let retained!: Parameters<EpisodeRefreshSchedulerBridge["register"]>[1];
	const registerHandler = bridge.register.bind(bridge);
	vi.spyOn(bridge, "register").mockImplementation((provider, handler) => {
		retained = handler;
		return registerHandler(provider, handler);
	});
	const register = app.register.bind(app),
		displayName = Symbol.for("fastify.display-name");
	let selectedRegistrations = 0;
	const registration = vi.spyOn(app, "register").mockImplementation(((
		plugin: unknown,
		...args: unknown[]
	) => {
		if (
			typeof plugin === "function" &&
			Reflect.get(plugin, displayName) === Reflect.get(cachePlugin, displayName)
		) {
			expect(plugin).not.toBe(cachePlugin);
			expect(Reflect.get(plugin, Symbol.for("plugin-meta"))).toBe(
				Reflect.get(cachePlugin, Symbol.for("plugin-meta")),
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
	app.addHook("preClose", async () => {
		preClosed.resolve();
		if (options.preCloseGate) await options.preCloseGate;
	});
	await app.ready();
	expect(
		await native.run(() => native.prisma.serviceInstance.count({ where: { OR: owned.instances } })),
	).toBe(2);
	const request = { userId: ownerRows[0]!.userId, instanceId: owned.instances[0]!.id };
	const retry = (input = request) => {
		const task = app.restoreRuntime.runOperation(() => bridge.retry("plex_episode", input));
		tasks.push(
			task.then((result) => (result.status === "accepted" ? result.backgroundTask : undefined)),
		);
		return task;
	};
	let manual: Promise<EpisodeRefreshRetryResult> | undefined;
	const idle = async () => {
		await native.runtime.drain();
		expect(await waitForNative(() => active === 0 && state.pending === 0)).toBe(true);
		await app.notificationService.drain();
		await settle();
	};
	const callback = (kind: "startup" | "interval" | "continuation") => {
		const timers = installed.filter((row) =>
			kind === "interval" ? row.kind === "interval" : row.kind === "timeout",
		);
		const row = kind === "startup" ? timers.find((row) => row.delay === STARTUP_MS) : timers.at(-1);
		if (!row) throw new Error("No scheduler callback");
		return row.callback;
	};
	const advance = async (ms: number) => {
		const target = Date.now() + ms;
		do {
			const due = Math.min(...[...activeTimers.values()].map((timer) => timer.dueAt));
			// Fire actual virtual timers at each recorded deadline; real native I/O
			// must settle there before the clock crosses another scheduler boundary.
			await vi.advanceTimersByTimeAsync(Math.max(0, Math.min(target, due) - Date.now()));
			let drained = false;
			const joining = native.runtime.drain().then(() => {
				drained = true;
			});
			tasks.push(joining);
			expect(await waitForNative(() => drained || (held && state.pending > 0))).toBe(true);
			if (!(held && state.pending > 0)) await idle();
		} while (Date.now() < target);
		expect(Date.now()).toBe(target);
	};
	const start = async (origin: Origin) => {
		if (origin === "manual") {
			manual = retry();
			expect(await waitForNative(() => held || counts.page > 0)).toBe(true);
			return;
		}
		if (origin !== "startup") await advance(STARTUP_MS);
		const delay =
			origin === "interval" ? INTERVAL_MS : origin === "continuation" ? 30_000 : STARTUP_MS;
		await advance(delay - 1);
		await advance(1);
	};
	const closePending = async () => {
		let closed = false;
		const promise = app.close().then(() => {
			closed = true;
		});
		await preClosed.promise;
		await settle();
		return { promise, settled: () => closed };
	};
	const outcome = () =>
		native.run(async () => ({
			events: await native.prisma.notificationOutboxEvent.findMany({
				where: { userId: { in: ownerRows.map((row) => row.userId) } },
			}),
			deliveries: await native.prisma.notificationOutboxDelivery.findMany({
				where: { userId: { in: ownerRows.map((row) => row.userId) } },
			}),
			history: await native.prisma.notificationLog.findMany({
				where: { channelId: { in: ownerRows.map((row) => row.channelId) } },
			}),
			channels: await native.prisma.notificationChannel.findMany({
				where: { OR: ownerRows.map((row) => ({ id: row.channelId, userId: row.userId })) },
			}),
		}));
	const dispose = async () => {
		await app.close();
		await cleanup(native);
		apps.splice(apps.indexOf(app), 1);
	};
	return {
		app,
		native,
		prisma,
		ownerRows,
		instances: instances.filter((row) => row.enabled),
		counts,
		state,
		pageInputs,
		attempt,
		maxPages: () => maxPages,
		sent,
		sendOwners,
		acceptedAt: () => acceptedAt!,
		deliveries,
		bridge,
		request,
		retry,
		manual: () => manual,
		retained: (input = request) => retained(input),
		start,
		advance,
		idle,
		callback,
		closePending,
		outcome,
		dispose,
		waitUntilHeld: () => waitForNative(() => held),
		retryDelay: () => [...activeTimers.values()].find((row) => row.kind === "timeout")?.delay,
		timerCount: () => activeTimers.size,
		get timeouts() {
			return {
				mock: {
					calls: installed
						.filter((row) => row.kind === "timeout")
						.map((row) => [row.callback, row.delay]),
				},
			};
		},
		get intervals() {
			return {
				mock: {
					calls: installed
						.filter((row) => row.kind === "interval")
						.map((row) => [row.callback, row.delay]),
				},
			};
		},
	};
}
beforeEach(() => {
	installed.length = 0;
	activeTimers.clear();
	vi.useFakeTimers({
		toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	});
	vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
	const virtualTimeout = globalThis.setTimeout,
		virtualClear = globalThis.clearTimeout;
	const virtualInterval = globalThis.setInterval,
		virtualClearInterval = globalThis.clearInterval;
	// Route by the actual installing callsite, not coincident delay values:
	// PostgreSQL safety timers and unrelated outbox deadlines stay real.
	const schedulerCallsite = () =>
		new Error().stack
			?.split("\n")
			.find((line) => line.includes("/src/") && !line.includes("/__tests__/"))
			?.includes("/plugins/plex-episode-cache-scheduler.ts") === true;
	vi.stubGlobal("setTimeout", ((callback: () => void, delay?: number, ...args: unknown[]) => {
		if (!schedulerCallsite())
			return Reflect.apply(realTimeout, globalThis, [callback, delay, ...args]);
		let handle: ReturnType<typeof setTimeout>;
		const forward = () => {
			activeTimers.delete(handle);
			Reflect.apply(callback, globalThis, args);
		};
		handle = Reflect.apply(virtualTimeout, globalThis, [forward, delay]);
		const record: TimerRecord = {
			kind: "timeout",
			delay: delay ?? 0,
			dueAt: Date.now() + Math.max(0, delay ?? 0),
			callback: () => Reflect.apply(callback, globalThis, args),
			handle,
		};
		installed.push(record);
		activeTimers.set(handle, record);
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
		let record: TimerRecord;
		const forward = () => {
			record.dueAt += record.delay;
			Reflect.apply(callback, globalThis, args);
		};
		const handle = Reflect.apply(virtualInterval, globalThis, [forward, delay]);
		record = {
			kind: "interval",
			delay: delay ?? 0,
			dueAt: Date.now() + Math.max(0, delay ?? 0),
			callback: () => Reflect.apply(callback, globalThis, args),
			handle,
		};
		installed.push(record);
		activeTimers.set(handle, record);
		return handle;
	}) as typeof setInterval);
	vi.stubGlobal("clearInterval", ((handle: Parameters<typeof clearInterval>[0]) => {
		if (installed.some((row) => row.handle === handle && row.kind === "interval")) {
			activeTimers.delete(handle as ReturnType<typeof setTimeout>);
			return virtualClearInterval(handle);
		}
		return realClearInterval(handle);
	}) as typeof clearInterval);
	boundaries.refresh.mockReset();
	boundaries.evidence.mockReset();
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(tasks.splice(0));
	for (const app of apps.splice(0)) await app.close();
	vi.restoreAllMocks();
	for (const native of [...fixtures.keys()]) await cleanup(native);
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
async function assertGraphs(
	f: Awaited<ReturnType<typeof boot>>,
	states: Array<"ready" | "sent" | "uncertain" | "submitting">,
) {
	const snapshot = await f.outcome();
	expect(snapshot.events).toHaveLength(states.length);
	expect(snapshot.deliveries).toHaveLength(states.length);
	for (const [index, state] of states.entries()) {
		const owner = f.ownerRows[index]!,
			event = snapshot.events.find((row) => row.userId === owner.userId)!,
			delivery = snapshot.deliveries.find((row) => row.userId === owner.userId)!;
		expect(event).toMatchObject({
			userId: owner.userId,
			eventType: "CACHE_REFRESH_STALE",
			stage: ["sent", "uncertain"].includes(state) ? "terminal" : "ready",
			acceptedAt: f.acceptedAt(),
			dueAt: f.acceptedAt(),
		});
		expect(event.encryptedPayload).not.toContain(wantPayload.title);
		expect(
			JSON.parse(
				f.native.encryptor.decrypt({ value: event.encryptedPayload, iv: event.payloadIv }),
			),
		).toMatchObject({
			purpose: "arr-dashboard:notification-outbox-event",
			eventId: event.id,
			userId: owner.userId,
			acceptedAt: event.acceptedAt.toISOString(),
			dueAt: event.dueAt!.toISOString(),
			policy: { stage: "ready" },
			payload: wantPayload,
			recipients: [
				{
					channelId: owner.channelId,
					channelType: "DISCORD",
					subscriptionEventType: "CACHE_REFRESH_STALE",
				},
			],
		});
		expect(delivery).toMatchObject({
			userId: owner.userId,
			eventId: event.id,
			channelId: owner.channelId,
			channelType: "DISCORD",
			subscriptionEventType: "CACHE_REFRESH_STALE",
			state,
			attemptOrdinal: 0,
			nextAttemptAt: event.dueAt,
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
			expect(delivery.dispatchedAt).toEqual(f.acceptedAt());
			expect(delivery.completedAt).toEqual(state === "submitting" ? null : f.acceptedAt());
		}
		const history = snapshot.history.filter((row) => row.channelId === owner.channelId);
		if (state === "sent") {
			expect(history).toHaveLength(1);
			expect(history[0]).toMatchObject({
				channelId: owner.channelId,
				eventType: "CACHE_REFRESH_STALE",
				title: wantPayload.title,
				body: wantPayload.body,
				status: "sent",
				retryCount: 0,
			});
			expect(snapshot.channels.find((row) => row.id === owner.channelId)).toMatchObject({
				lastSendResult: "success",
			});
		} else expect(history).toHaveLength(0);
	}
	return snapshot;
}
describe("Plex episode scheduler accepted lifetimes", () => {
	for (const origin of ["startup", "interval", "continuation", "manual"] as const) {
		const phases: Phase[] =
			origin === "manual"
				? ["owner", "page", "retryState"]
				: origin === "continuation"
					? ["page", "retryState"]
					: ["round", "page", "retryState", "stale", "evidence"];
		for (const phase of phases)
			for (const reject of [false, true]) {
				it(`drains ${origin} ${phase} ${reject ? "failure" : "completion"} before database teardown`, async () => {
					const gate = deferred();
					const f = await boot({
						origin,
						stale: true,
						hold: {
							phase,
							gate: gate.promise,
							reject,
							call:
								origin === "interval" || (origin === "continuation" && phase === "page") ? 2 : 1,
						},
					});
					await f.start(origin);
					expect(await f.waitUntilHeld()).toBe(true);
					expect(f.state.pending).toBe(1);
					const closing = await f.closePending();
					expect(closing.settled()).toBe(false);
					expect(f.state.teardown).toBe(false);
					gate.resolve();
					await closing.promise;
					await f.manual();
					expect(f.state.pendingAtTeardown).toBe(0);
					expect(f.state.afterTeardown).toBe(0);
					const before = { ...f.counts };
					await f.advance(24 * 60 * 60_000);
					expect(f.counts).toEqual(before);
				});
			}
	}
	for (const phase of ["stale", "evidence", "subscription", "send", "log", "channel"] as const) {
		for (const reject of [false, true]) {
			it(`retains stale-alert delivery through held ${phase} ${reject ? "failure" : "completion"}`, async () => {
				const gate = deferred();
				const f = await boot({ stale: true, hold: { phase, gate: gate.promise, reject } });
				await f.start("startup");
				expect(await f.waitUntilHeld()).toBe(true);
				expect(f.state.pending).toBe(1);
				const closing = await f.closePending();
				expect(closing.settled()).toBe(false);
				gate.resolve();
				await closing.promise;
				expect(f.state.afterTeardown).toBe(0);
				expect(f.state.pendingAtTeardown).toBe(0);
				if (["send", "log", "channel"].includes(phase)) {
					expect(f.sendOwners).toHaveLength(1);
					const issued = f.sendOwners[0]!;
					const states = f.ownerRows.map((owner) =>
						owner.userId !== issued
							? ("ready" as const)
							: !reject
								? ("sent" as const)
								: phase === "send"
									? ("uncertain" as const)
									: ("submitting" as const),
					);
					await assertGraphs(f, states);
					expect(f.sent).toEqual(phase === "send" && reject ? [] : ["CACHE_REFRESH_STALE"]);
					expect(f.deliveries).toEqual(
						reject && (phase === "send" || phase === "log") ? [] : ["sent"],
					);
				} else {
					if (!reject) await assertGraphs(f, ["ready", "ready"]);
					else {
						const graph = await f.outcome();
						expect(graph.events).toHaveLength(0);
						expect(graph.deliveries).toHaveLength(0);
					}
					expect(f.sent).toEqual([]);
					expect(f.deliveries).toEqual([]);
				}
			});
		}
	}
	it("closes admission during preClose before sibling hooks wait", async () => {
		const gate = deferred(),
			f = await boot({ preCloseGate: gate.promise });
		const closing = await f.closePending();
		f.callback("startup")();
		await expect(f.retained()).resolves.toEqual({ status: "unavailable" });
		await settle();
		expect(f.counts.round).toBe(0);
		expect(f.counts.owner).toBe(0);
		gate.resolve();
		await closing.promise;
	});
	it("never reopens retired startup, interval, continuation or manual callbacks", async () => {
		const f = await boot({ origin: "continuation" });
		await f.start("startup");
		await f.idle();
		const startup = f.callback("startup"),
			interval = f.callback("interval"),
			continuation = f.callback("continuation");
		await f.app.close();
		const before = { ...f.counts },
			installed = f.intervals.mock.calls.length;
		startup();
		interval();
		continuation();
		await expect(f.retained()).resolves.toEqual({ status: "unavailable" });
		await expect(f.retry()).resolves.toEqual({
			status: "unavailable",
		});
		await f.advance(24 * 60 * 60_000);
		expect(f.counts).toEqual(before);
		expect(f.intervals.mock.calls.length).toBe(installed);
	});
	it("joins duplicate close calls while the initial lookup is pending", async () => {
		const gate = deferred(),
			f = await boot({ hold: { phase: "round", gate: gate.promise } });
		await f.start("startup");
		expect(await f.waitUntilHeld()).toBe(true);
		const closing = await f.closePending();
		let secondSettled = false;
		const second = f.app.close().then(() => {
			secondSettled = true;
		});
		await settle();
		expect(closing.settled()).toBe(false);
		expect(secondSettled).toBe(false);
		gate.resolve();
		await Promise.all([closing.promise, second]);
		expect(f.state.afterTeardown).toBe(0);
	});
	it("rejects a held owner admission after close without starting a page", async () => {
		const gate = deferred(),
			f = await boot({ hold: { phase: "owner", gate: gate.promise } });
		await f.start("manual");
		expect(await f.waitUntilHeld()).toBe(true);
		const closing = await f.closePending();
		expect(closing.settled()).toBe(false);
		gate.resolve();
		await expect(f.manual()).resolves.toEqual({ status: "unavailable" });
		await closing.promise;
		expect(f.counts.page).toBe(0);
		expect(f.state.afterTeardown).toBe(0);
	});
	for (const phase of ["round", "owner", "page", "retryState", "stale", "evidence"] as const) {
		it(`blocks maintenance throughout accepted ${phase}`, async () => {
			const gate = deferred(),
				origin = phase === "owner" ? "manual" : "startup";
			const f = await boot({ origin, stale: true, hold: { phase, gate: gate.promise } });
			await f.start(origin);
			expect(await f.waitUntilHeld()).toBe(true);
			expect(f.state.pending).toBe(1);
			await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
				statusCode: 409,
			});
			gate.resolve();
			await f.manual();
			await settle();
			await f.app.close();
			await expect(withCleanupMaintenanceGuard(async () => "released")).resolves.toBe("released");
		});
	}
	it("retains a detached manual page guard after its parent request returns", async () => {
		const gate = deferred(),
			f = await boot({ hold: { phase: "page", gate: gate.promise } });
		const admission = await f.app.restoreRuntime.runOperation(() =>
			withCleanupOperationGuard(() => f.retry()),
		);
		expect(admission.status).toBe("accepted");
		expect(await f.waitUntilHeld()).toBe(true);
		expect(f.state.pending).toBe(1);
		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
			statusCode: 409,
		});
		gate.resolve();
		if (admission.status !== "accepted") throw new Error("Synthetic page not admitted");
		await admission.backgroundTask;
		await f.app.close();
		await expect(withCleanupMaintenanceGuard(async () => "released")).resolves.toBe("released");
	});
	it("rejects manual admission during maintenance without querying an owner", async () => {
		const f = await boot();
		await withCleanupMaintenanceGuard(async () => {
			await expect(f.retry()).resolves.toEqual({
				status: "unavailable",
			});
			expect(f.counts.owner).toBe(0);
			expect(f.counts.page).toBe(0);
		});
		await expect(f.retry()).resolves.toMatchObject({
			status: "accepted",
		});
		await f.idle();
		expect(f.counts.page).toBe(1);
	});
	for (const failure of ["exception", "dependency"] as const)
		for (const rung of [0, 1, 2]) {
			it(`defers maintenance-denied ${failure} rung ${rung} without spending its retry budget`, async () => {
				const f = await boot({ failure });
				const admission = await f.retry();
				if (admission.status !== "accepted") throw new Error("Synthetic page not admitted");
				await admission.backgroundTask;
				const delays = [30_000, 120_000, 600_000];
				for (let i = 0; i < rung; i++) await f.advance(delays[i]!);
				expect(f.counts.page).toBe(rung + 1);
				const before = f.counts.page;
				await withCleanupMaintenanceGuard(async () => {
					await f.advance(delays[rung]!);
					expect(f.counts.page).toBe(before);
					expect(f.timeouts.mock.calls.at(-1)?.[1]).toBe(delays[rung]);
				});
				await f.advance(delays[rung]! - 1);
				expect(f.counts.page).toBe(before);
				await f.advance(1);
				expect(f.counts.page).toBe(before + 1);
				for (let i = rung + 1; i < 3; i++) await f.advance(delays[i]!);
				await f.advance(600_000);
				expect(f.counts.page).toBe(4);
			});
		}
	it("uses a positive delay when maintenance denies an already-due persisted retry", async () => {
		const f = await boot({ overdue: true });
		const first = await f.retry();
		if (first.status !== "accepted") throw new Error("Synthetic page not admitted");
		await first.backgroundTask;
		expect(f.counts.page).toBe(1);
		expect(f.timeouts.mock.calls.at(-1)?.[1]).toBe(0);
		await withCleanupMaintenanceGuard(async () => {
			await f.advance(0);
			expect(f.counts.page).toBe(1);
			expect(boundaries.refresh).toHaveBeenCalledOnce();
			expect(f.timeouts.mock.calls.at(-1)?.[1]).toBe(30_000);
		});
	});
	it("retains a parent-wait attempt and resume flag across a maintenance pause", async () => {
		const f = await boot({ failure: "parent" });
		const first = await f.retry();
		if (first.status !== "accepted") throw new Error("Synthetic page not admitted");
		await first.backgroundTask;
		await withCleanupMaintenanceGuard(async () => {
			await f.advance(30_000);
		});
		expect(f.counts.page).toBe(1);
		await f.advance(30_000);
		expect(f.pageInputs[1]).toEqual({
			id: f.request.instanceId,
			userId: f.request.userId,
			resume: false,
			attempt: f.attempt,
		});
		for (let i = 0; i < 4; i++) await f.advance(30_000);
		expect(f.counts.page).toBe(6);
		expect(
			f.pageInputs.slice(1).every((input) => input.attempt === f.attempt && input.resume === false),
		).toBe(true);
		boundaries.refresh.mockResolvedValue({
			complete: false,
			errors: 0,
			errorMessages: [],
			upserted: 0,
			eligibleShows: 1,
			refreshedShows: 0,
			coverageIncomplete: true,
			capacityDegraded: false,
			superseded: true,
		});
		await f.advance(30_000);
		const pages = f.counts.page;
		await f.advance(30_000);
		expect(f.counts.page).toBe(pages);
		expect(f.retryDelay()).toBe(STARTUP_MS);
		boundaries.refresh.mockResolvedValue({
			complete: false,
			errors: 1,
			errorMessages: [],
			upserted: 0,
			eligibleShows: 1,
			refreshedShows: 0,
			coverageIncomplete: true,
			capacityDegraded: false,
		});
		const unavailable = await f.retry();
		if (unavailable.status !== "accepted") throw new Error("Synthetic page not admitted");
		await unavailable.backgroundTask;
		expect(f.retryDelay()).toBe(STARTUP_MS);
	});
	it("preserves current owner selection and independent simultaneous instances", async () => {
		const gate = deferred(),
			f = await boot({ instances: 2, hold: { phase: "page", gate: gate.promise } });
		await expect(f.retry({ ...f.request, userId: f.ownerRows[1]!.userId })).resolves.toEqual({
			status: "ineligible",
		});
		await expect(f.retry({ ...f.request, instanceId: "synthetic-missing" })).resolves.toEqual({
			status: "ineligible",
		});
		await f.native.run(() =>
			f.native.prisma.serviceInstance.update({
				where: { id: f.request.instanceId, userId: f.request.userId },
				data: { enabled: false },
			}),
		);
		await expect(f.retry()).resolves.toEqual({ status: "ineligible" });
		await f.native.run(() =>
			f.native.prisma.serviceInstance.update({
				where: { id: f.request.instanceId, userId: f.request.userId },
				data: { enabled: true },
			}),
		);
		await f.start("startup");
		expect(await waitForNative(() => f.pageInputs.length === 2)).toBe(true);
		expect(f.maxPages()).toBe(2);
		expect(
			f.pageInputs
				.map(({ id, userId, resume }) => ({ id, userId, resume }))
				.sort((a, b) => a.id.localeCompare(b.id)),
		).toEqual(
			f.instances
				.map((row) => ({ id: row.id, userId: row.userId, resume: true }))
				.sort((a, b) => a.id.localeCompare(b.id)),
		);
		gate.resolve();
		await f.idle();
	});
	it("suppresses overlapping rounds and permits a later interval after lookup rejection", async () => {
		const gate = deferred(),
			f = await boot({ hold: { phase: "round", gate: gate.promise, reject: true } });
		await f.start("startup");
		expect(await f.waitUntilHeld()).toBe(true);
		await f.advance(INTERVAL_MS);
		expect(f.counts.round).toBe(1);
		gate.resolve();
		await f.idle();
		await f.advance(INTERVAL_MS - 1);
		expect(f.counts.round).toBe(1);
		await f.advance(1);
		expect(f.counts.round).toBe(2);
		expect(f.counts.page).toBe(1);
	});
});
