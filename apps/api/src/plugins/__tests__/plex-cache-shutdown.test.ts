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
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { NotificationDispatcher } from "../../lib/notifications/notification-dispatcher.js";
import type { ServiceInstance } from "../../lib/prisma.js";
import { evaluateProviderCoverageReceipt } from "../../lib/provider-observation/coverage-receipt.js";
import {
	claimProviderCacheRefreshAttempt,
	finishProviderCacheRefreshAttemptFailure,
	type ProviderCacheRefreshAttempt,
} from "../../lib/services/provider-cache-status.js";
import { createProviderPublicationAuthority } from "../../lib/services/provider-identity-guard.js";
import {
	ensureLibraryRefreshRecovery,
	type LibraryRefreshRecoveryRequest,
	type LibraryRefreshRecoveryResult,
} from "../../lib/services/library-refresh-recovery.js";
import notificationPlugin from "../notification-service.js";
import cachePlugin from "../plex-cache-scheduler.js";
import registryPlugin from "../scheduler-registry.js";

const boundaries = vi.hoisted(() => ({ refresh: vi.fn(), observation: vi.fn() }));
vi.mock("../../lib/plex/plex-refresh-orchestration.js", () => ({
	refreshOwnedPlexCacheWithAttempt: boundaries.refresh,
}));
vi.mock("../../lib/plex/plex-persisted-observation-repository.js", () => ({
	loadGenerationObservationsForOwnedInstances: boundaries.observation,
}));
const STARTUP_MS = 30_000,
	INTERVAL_MS = 6 * 60 * 60_000;
type Origin = "startup" | "interval" | "retry" | "arm";
type Phase =
	| "roundLookup"
	| "currentLookup"
	| "refresh"
	| "observation"
	| "staleLookup"
	| "staleObservation"
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
	title: "Plex provider observation is stale",
	body: "Plex provider observation is stale for 1 enabled instance(s).",
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
function syntheticReceipt(evidence = "complete") {
	return {
		version: 1,
		provider: "plex",
		attemptStartedAt: new Date().toISOString(),
		observedAt: new Date().toISOString(),
		evidence,
		units: [
			{
				scopeKey: "section:synthetic",
				expectedRawCount: 2,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: 2,
				sourceBindings: 2,
				canonicalEntities: 1,
				acceptedSkips: [],
				fatalCount: 0,
			},
		],
	};
}
// Native runtime/SQL/owners/crypto. Only provider refresh, explicitly simulated
// persisted observation, and outbound transport are synthetic, not publication proof.
async function boot(
	options: {
		origin?: Origin;
		hold?: { phase: Phase; gate: Promise<void>; reject?: boolean; call?: number };
		firstRefreshFailed?: boolean;
		alwaysRetryable?: boolean;
		superseded?: boolean;
		positiveOnly?: boolean;
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
		owners: ownerRows,
	};
	fixtures.set(native, owned);
	// Seed only the synthetic pre-launch graph atomically; tested runtime work stays real.
	await native.run(() =>
		native.prisma.$transaction(async (seed) => {
			for (const [index, owner] of ownerRows.entries()) {
				const encrypted = native.encryptor.encrypt(
					JSON.stringify({
						webhookUrl: `https://example.invalid/synthetic-worker/${owner.userId}`,
					}),
				);
				expect(
					(
						await seed.notificationChannel.updateMany({
							where: { id: owner.channelId, userId: owner.userId },
							data: {
								name: "Same synthetic channel",
								encryptedConfig: encrypted.value,
								configIv: encrypted.iv,
							},
						})
					).count,
				).toBe(1);
				await seed.notificationSubscription.create({
					data: { channelId: owner.channelId, eventType: "CACHE_REFRESH_STALE" },
				});
				const key = native.encryptor.encrypt("synthetic-provider-key");
				const row = await seed.serviceInstance.create({
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
				const status = await seed.cacheRefreshStatus.create({
					data: {
						instanceId: row.id,
						cacheType: "plex",
						lastRefreshedAt: new Date(Date.now() - (options.stale ? 13 * 60 * 60_000 : 0)),
						lastResult: "success",
						lastAttemptAt: new Date(),
						lastAttemptResult: "error",
						connectionGeneration: 7,
						identityGeneration: 3,
					},
				});
				owned.statuses.push(status.id);
			}
		}),
	);
	const instances = await native.run(() =>
		native.prisma.serviceInstance.findMany({ where: { OR: owned.instances } }),
	);
	await native.restart(false);
	const client = createRuntimePrismaClient(native.runtime),
		prisma = client.prisma;
	const counts: Record<Phase, number> = {
		roundLookup: 0,
		currentLookup: 0,
		refresh: 0,
		observation: 0,
		staleLookup: 0,
		staleObservation: 0,
		subscription: 0,
		send: 0,
		log: 0,
		channel: 0,
	};
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
		expect(args).toMatchObject({ where: { service: "PLEX", enabled: true } });
		expect(Object.keys(args?.where ?? {}).sort()).toEqual(
			args?.where?.id ? ["enabled", "id", "service"] : ["enabled", "service"],
		);
		await pause("roundLookup");
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
				identityStatus: "VERIFIED",
				expectedIdentity: { not: null },
			},
		});
		await pause("currentLookup");
		const row = await current(args);
		if (row) expect(instances).toContainEqual(row);
		return row;
	});
	const stale = prisma.cacheRefreshStatus.findMany.bind(prisma.cacheRefreshStatus);
	const statusReads: { findMany: AwaitOnly<typeof prisma.cacheRefreshStatus.findMany> } =
		prisma.cacheRefreshStatus;
	vi.spyOn(statusReads, "findMany").mockImplementation(async (args) => {
		expect(args).toEqual({
			where: { cacheType: "plex", instance: { enabled: true } },
			include: { instance: true },
		});
		await pause("staleLookup");
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
		selected: string[] = [],
		entries: string[] = [],
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
	const telemetry = [
		vi.spyOn(app.log, "info"),
		vi.spyOn(app.log, "warn"),
		vi.spyOn(app.log, "error"),
	];
	apps.push(app);
	boundaries.refresh.mockImplementation(
		async (
			input: {
				prisma: unknown;
				encryptor: unknown;
				instance: ServiceInstance;
				log: unknown;
			},
			attempt: ProviderCacheRefreshAttempt,
		) => {
			expect(input).toEqual({
				prisma,
				encryptor: native.encryptor,
				instance: expect.anything(),
				log: app.log,
				signal: expect.any(AbortSignal),
			});
			expect(instances).toContainEqual(input.instance);
			expect(
				native.encryptor.decrypt({
					value: input.instance.encryptedApiKey,
					iv: input.instance.encryptionIv,
				}),
			).toBe("synthetic-provider-key");
			entries.push(input.instance.id);
			await pause("refresh");
			selected.push(input.instance.id);
			// Synthetic provider results are lifecycle proof, not publication proof.
			await finishProviderCacheRefreshAttemptFailure(
				prisma,
				"plex",
				"provider-unavailable",
				createProviderPublicationAuthority(input.instance),
				attempt,
				app.log,
			);
			if (input.instance.id === request.instanceId) request.attempt = attempt;
			if (options.superseded)
				return { superseded: true, complete: false, nativeInventoryStatus: "superseded" };
			if (options.alwaysRetryable || (options.firstRefreshFailed && counts.refresh === 1))
				return { complete: options.alwaysRetryable === true, nativeInventoryStatus: "failed" };
			expect(
				evaluateProviderCoverageReceipt(
					syntheticReceipt(options.positiveOnly ? "positive-only" : "complete"),
				),
			).toMatchObject({
				valid: true,
				evidence: options.positiveOnly ? "positive-only" : "complete",
			});
			return {
				complete: true,
				nativeInventoryStatus: "published",
				receipt: syntheticReceipt(options.positiveOnly ? "positive-only" : "complete"),
			};
		},
	);
	boundaries.observation.mockImplementation(
		async (
			observationClient: unknown,
			input: { instances: ServiceInstance[]; maxAgeMs: number },
		) => {
			expect(observationClient).toBe(prisma);
			expect(input.maxAgeMs).toBe(12 * 60 * 60_000);
			expect(input.instances).toHaveLength(1);
			expect(instances).toContainEqual(input.instances[0]);
			await pause(counts.observation < counts.refresh ? "observation" : "staleObservation");
			return [
				{
					available: true,
					evidence: {
						publicationLevel: "authoritative",
						completeness: "complete",
						reasonCodes: [],
					},
					providerStatus: {
						availability: "current",
						evidence: "complete",
						observedAt: new Date().toISOString(),
						ageSeconds: 0,
						latestAttempt: "successful",
						reasonCodes: [],
					},
				},
			];
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
					for (const spy of telemetry)
						for (const args of spy.mock.calls)
							for (const instance of instances) {
								const message = JSON.stringify(args);
								for (const privateValue of [
									instance.label,
									instance.id,
									instance.baseUrl,
									instance.encryptedApiKey,
									instance.expectedIdentity,
								])
									if (privateValue) expect(message).not.toContain(privateValue);
							}
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
	const bridge = ensureLibraryRefreshRecovery(app).libraryRefreshRecovery;
	let retained: (request: LibraryRefreshRecoveryRequest) => Promise<LibraryRefreshRecoveryResult> =
		async () => ({ status: "unavailable" });
	const registerHandler = bridge.register.bind(bridge);
	vi.spyOn(bridge, "register").mockImplementation((provider, handler) => {
		retained = (request) => handler(request);
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
	const initialAuthority = createProviderPublicationAuthority(
		instances.find((row) => row.id === owned.instances[0]!.id)!,
	);
	const initialClaim = options.empty
		? undefined
		: await native.run(() =>
				claimProviderCacheRefreshAttempt(native.prisma, "plex", initialAuthority),
			);
	if (initialClaim && initialClaim.status !== "acquired")
		throw new Error("missing initial owned test claim");
	if (initialClaim?.status === "acquired")
		await native.run(() =>
			finishProviderCacheRefreshAttemptFailure(
				native.prisma,
				"plex",
				"provider-unavailable",
				initialAuthority,
				initialClaim.attempt,
				app.log,
			),
		);
	const request: LibraryRefreshRecoveryRequest = {
		provider: "plex",
		userId: ownerRows[0]!.userId,
		instanceId: owned.instances[0]!.id,
		authority: initialAuthority,
		// Empty fixtures exercise retained shutdown callbacks, never admission.
		attempt:
			initialClaim?.status === "acquired"
				? initialClaim.attempt
				: {
						attemptedAt: new Date(),
						resultMarker: "in_progress:00000000-0000-4000-8000-000000000001",
					},
	};
	bridge.admit(request);
	const arm = (input = request) => {
		const task = app.restoreRuntime.runOperation(() => bridge.arm(input));
		tasks.push(task.catch(() => undefined));
		return task;
	};
	const idle = async () => {
		await native.runtime.drain();
		expect(await waitForNative(() => active === 0 && state.pending === 0)).toBe(true);
		await app.notificationService.drain();
		await settle();
	};
	const callback = (kind: "startup" | "interval" | "retry") => {
		const timers = installed.filter((row) =>
			kind === "interval" ? row.kind === "interval" : row.kind === "timeout",
		);
		const row = kind === "startup" ? timers.find((row) => row.delay === STARTUP_MS) : timers.at(-1);
		if (!row) throw new Error("No scheduler callback");
		return row.callback;
	};
	const advance = async (ms: number) => {
		await vi.advanceTimersByTimeAsync(ms);
		let drained = false;
		const joining = native.runtime.drain().then(() => {
			drained = true;
		});
		tasks.push(joining);
		expect(await waitForNative(() => drained || (held && state.pending > 0))).toBe(true);
		if (!(held && state.pending > 0)) await idle();
	};
	const start = async (origin: Origin) => {
		if (origin === "arm") return arm();
		if (origin !== "startup") {
			await advance(STARTUP_MS);
			if (origin === "retry") await arm();
		}
		await advance(origin === "interval" ? INTERVAL_MS : STARTUP_MS);
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
	const changeInstance = async (data: {
		userId?: string;
		enabled?: boolean;
		identityStatus?: "VERIFIED" | "UNVERIFIED";
		expectedIdentity?: string | null;
	}) => {
		const target = owned.instances.find((row) => row.id === request.instanceId)!;
		const row = await native.run(() =>
			native.prisma.serviceInstance.update({
				where: { id: target.id, userId: target.userId },
				data,
			}),
		);
		expect(row.id).toBe(target.id);
		expect(ownerRows.map((owner) => owner.userId)).toContain(row.userId);
		target.userId = row.userId;
		instances[instances.findIndex((instance) => instance.id === row.id)] = row;
		return row;
	};
	return {
		app,
		native,
		prisma,
		ownerRows,
		instances,
		counts,
		state,
		selected,
		entries,
		sent,
		sendOwners,
		acceptedAt: () => acceptedAt!,
		deliveries,
		bridge,
		request,
		arm,
		retained: () => retained(request),
		start,
		advance,
		idle,
		callback,
		closePending,
		outcome,
		dispose,
		changeInstance,
		waitUntilHeld: () => waitForNative(() => held),
		retryDelay: () => [...activeTimers.values()].find((row) => row.kind === "timeout")?.delay,
		timerCount: () => activeTimers.size,
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
			?.includes("/plugins/plex-cache-scheduler.ts") === true;
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
		const handle = Reflect.apply(virtualInterval, globalThis, [callback, delay, ...args]);
		const record: TimerRecord = {
			kind: "interval",
			delay: delay ?? 0,
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
	boundaries.observation.mockReset();
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
describe("Plex canonical cache scheduler lifetime", () => {
	for (const origin of ["startup", "interval", "retry"] as const) {
		const phases: Phase[] = [
			"roundLookup",
			"refresh",
			"observation",
			...(origin === "retry"
				? ["currentLookup" as const]
				: (["staleLookup", "staleObservation"] as const)),
		];
		for (const phase of phases)
			for (const reject of [false, true]) {
				it(`drains accepted ${origin} ${phase} ${reject ? "failure" : "completion"} before teardown`, async () => {
					const gate = deferred();
					const f = await boot({
						origin,
						stale: true,
						firstRefreshFailed: origin === "retry",
						hold: {
							phase,
							gate: gate.promise,
							reject,
							call: origin === "startup" || phase === "currentLookup" ? 1 : 2,
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
					expect(f.state.pendingAtTeardown).toBe(0);
					expect(f.state.afterTeardown).toBe(0);
					const before = { ...f.counts };
					await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
					expect(f.counts).toEqual(before);
				});
			}
	}
	for (const phase of [
		"staleLookup",
		"staleObservation",
		"subscription",
		"send",
		"log",
		"channel",
	] as const) {
		for (const reject of [false, true]) {
			it(`retains accepted stale-alert producer through held ${phase} ${reject ? "failure" : "completion"}`, async () => {
				const gate = deferred(),
					f = await boot({ stale: true, hold: { phase, gate: gate.promise, reject } });
				await f.start("startup");
				expect(await f.waitUntilHeld()).toBe(true);
				expect(f.state.pending).toBeGreaterThan(0);
				const closing = await f.closePending();
				expect(closing.settled()).toBe(false);
				gate.resolve();
				await closing.promise;
				expect(f.state.afterTeardown).toBe(0);
				expect(f.state.pendingAtTeardown).toBe(0);
				if (["staleLookup", "staleObservation", "subscription"].includes(phase)) {
					if (reject) expect((await f.outcome()).events).toHaveLength(0);
					else {
						await assertGraphs(f, ["ready", "ready"]);
						expect(f.sent).toEqual([]);
						expect(f.deliveries).toEqual([]);
					}
				} else {
					const first = f.ownerRows.findIndex((owner) => owner.userId === f.sendOwners[0]);
					expect(first).toBeGreaterThanOrEqual(0);
					const expected: Array<"ready" | "sent" | "uncertain" | "submitting"> = ["ready", "ready"];
					expected[first] = !reject ? "sent" : phase === "send" ? "uncertain" : "submitting";
					await assertGraphs(f, expected);
					expect(f.sent).toHaveLength(phase === "send" && reject ? 0 : 1);
				}
			});
		}
	}
	it("queues owner-scoped recovery without a database lookup and cancels it on close", async () => {
		const f = await boot();
		await expect(f.arm()).resolves.toEqual({ status: "accepted" });
		expect(f.counts.currentLookup).toBe(0);
		expect(f.state.pending).toBe(0);
		const closing = await f.closePending();
		await closing.promise;
		await expect(f.arm()).resolves.toEqual({ status: "unavailable" });
		expect(f.counts.refresh).toBe(0);
		expect(f.state.afterTeardown).toBe(0);
	});
	it("permanently rejects retired callbacks and never reinstalls timers", async () => {
		const f = await boot({ firstRefreshFailed: true });
		await f.start("startup");
		await settle();
		const startup = f.callback("startup"),
			interval = f.callback("interval"),
			retry = f.callback("retry");
		await f.app.close();
		const before = { ...f.counts },
			installed = f.intervals.mock.calls.length;
		startup();
		interval();
		retry();
		await settle();
		await expect(f.retained()).resolves.toEqual({ status: "unavailable" });
		await expect(f.bridge.arm(f.request)).resolves.toEqual({ status: "unavailable" });
		await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
		expect(f.counts).toEqual(before);
		expect(f.intervals.mock.calls.length).toBe(installed);
	});
	it("closes admission before another preClose hook waits", async () => {
		const gate = deferred(),
			f = await boot({ empty: true, preCloseGate: gate.promise });
		const closing = await f.closePending();
		expect(closing.settled()).toBe(false);
		await f.start("startup");
		await settle();
		expect(f.counts.roundLookup).toBe(0);
		await expect(f.retained()).resolves.toEqual({ status: "unavailable" });
		gate.resolve();
		await closing.promise;
	});
	it("joins duplicate close calls with a refresh pending", async () => {
		const gate = deferred(),
			f = await boot({ hold: { phase: "refresh", gate: gate.promise } });
		await f.start("startup");
		await settle();
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
	it("suppresses overlapping rounds and recovers after a rejected initial lookup", async () => {
		const gate = deferred(),
			f = await boot({ hold: { phase: "roundLookup", gate: gate.promise, reject: true } });
		await f.start("startup");
		await settle();
		await f.advance(INTERVAL_MS);
		await settle();
		expect(f.counts.roundLookup).toBe(1);
		gate.resolve();
		await f.idle();
		await f.advance(INTERVAL_MS);
		await settle();
		expect(f.counts.roundLookup).toBe(2);
		expect(f.counts.refresh).toBe(1);
	});
	it("keeps existing stop-between-instances behavior without mixing owner identities", async () => {
		const gate = deferred(),
			f = await boot({ instances: 2, hold: { phase: "refresh", gate: gate.promise } });
		await f.start("startup");
		expect(await f.waitUntilHeld()).toBe(true);
		const closing = await f.closePending();
		expect(closing.settled()).toBe(false);
		gate.resolve();
		await closing.promise;
		expect(f.entries).toHaveLength(1);
		expect(f.selected).toEqual(f.entries);
		expect(f.instances.filter((row) => row.enabled).map((row) => row.id)).toContain(f.selected[0]);
		expect(f.counts.observation).toBe(1);
		expect(f.state.afterTeardown).toBe(0);
	});
	it("retains finite real-failure retries", async () => {
		const f = await boot({ alwaysRetryable: true });
		await f.advance(STARTUP_MS - 1);
		expect(f.counts.refresh).toBe(0);
		await f.advance(1);
		expect(f.counts.refresh).toBe(1);
		for (const [index, delay] of [30_000, 120_000, 600_000].entries()) {
			await f.advance(delay - 1);
			expect(f.counts.refresh).toBe(index + 1);
			await f.advance(1);
			expect(f.counts.refresh).toBe(index + 2);
		}
		expect(f.counts.refresh).toBe(4);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(f.counts.refresh).toBe(4);
		await f.dispose();
	});
	it("does not retry a superseded refresh result", async () => {
		const superseded = await boot({ superseded: true });
		await superseded.advance(STARTUP_MS);
		await superseded.advance(20 * 60_000);
		expect(superseded.counts.refresh).toBe(1);
		await superseded.dispose();
	});
	it("does not retry a positive-only refresh result", async () => {
		const positive = await boot({ positiveOnly: true });
		await positive.advance(STARTUP_MS);
		await positive.advance(20 * 60_000);
		expect(positive.counts.refresh).toBe(1);
		expect(positive.retryDelay()).toBeUndefined();
	});
	it("does not authorize a recovery lookup for another owner", async () => {
		const f = await boot(),
			wrong = { ...f.request, userId: f.ownerRows[1]!.userId };
		f.bridge.admit(wrong);
		await expect(f.arm(wrong)).resolves.toEqual({ status: "ineligible" });
		await vi.advanceTimersByTimeAsync(29_999);
		expect(f.counts.refresh).toBe(0);
		await f.advance(1);
		expect(f.counts.refresh).toBe(1);
		await expect(f.arm()).resolves.toEqual({ status: "accepted" });
		await f.changeInstance({ userId: wrong.userId });
		await f.advance(29_999);
		expect(f.counts.refresh).toBe(1);
		await f.advance(1);
		expect(f.counts.currentLookup).toBe(1);
		expect(f.counts.refresh).toBe(1);
		// Changing the request's owner cannot change its originating authority.
		await expect(f.arm(wrong)).resolves.toEqual({ status: "ineligible" });
		await f.advance(30_000);
		expect(f.counts.refresh).toBe(1);
		expect(f.retryDelay()).toBeUndefined();
	});
	for (const origin of ["startup", "retry"] as const) {
		it(`holds maintenance exclusion throughout accepted ${origin} lookup`, async () => {
			const gate = deferred(),
				phase = "roundLookup" as const;
			const f = await boot({
				origin,
				firstRefreshFailed: origin === "retry",
				hold: { phase, gate: gate.promise, call: origin === "retry" ? 2 : 1 },
			});
			const task = f.start(origin);
			expect(await f.waitUntilHeld()).toBe(true);
			expect(f.state.pending).toBe(1);
			await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
				statusCode: 409,
			});
			gate.resolve();
			await task;
			await settle();
			await f.app.close();
			await expect(withCleanupMaintenanceGuard(async () => "released")).resolves.toBe("released");
		});
	}
	for (const deniedRung of [0, 1, 2]) {
		it(`preserves retry rung ${deniedRung + 1} across prolonged maintenance without a busy loop`, async () => {
			const delays = [30_000, 120_000, 600_000],
				f = await boot({ alwaysRetryable: true });
			await f.advance(STARTUP_MS);
			for (let rung = 0; rung < deniedRung; rung++) await f.advance(delays[rung]!);
			const before = { ...f.counts },
				callsBefore = f.timerCount();
			const errors = vi.spyOn(f.app.log, "error");
			await withCleanupMaintenanceGuard(async () => {
				await f.advance(delays[deniedRung]!);
				expect(f.retryDelay()).toBe(delays[deniedRung]);
				for (let elapsed = 0; elapsed < 20 * 60_000; elapsed += delays[deniedRung]!)
					await f.advance(delays[deniedRung]!);
				expect(f.counts).toEqual(before);
				expect(errors).not.toHaveBeenCalled();
				expect(f.timerCount()).toBe(callsBefore);
			});
			await f.advance(delays[deniedRung]!);
			expect(f.counts.refresh).toBe(before.refresh + 1);
			for (let rung = deniedRung + 1; rung < delays.length; rung++) await f.advance(delays[rung]!);
			expect(f.counts.refresh).toBe(4);
		});
	}
	it("keeps maintenance-skipped rounds neutral while queuing recovery without database access", async () => {
		const f = await boot(),
			errors = vi.spyOn(f.app.log, "error");
		await withCleanupMaintenanceGuard(async () => {
			await f.start("startup");
			await settle();
			await f.advance(INTERVAL_MS);
			await settle();
			await expect(f.arm()).resolves.toEqual({ status: "accepted" });
		});
		expect(f.counts.roundLookup).toBe(0);
		expect(f.counts.currentLookup).toBe(0);
		expect(errors).not.toHaveBeenCalled();
		await f.advance(30_000 - 1);
		expect(f.counts.refresh).toBe(0);
		await f.advance(1);
		expect(f.counts.refresh).toBe(1);
	});
	it("recovers normal notification admission after a failed stale-alert lookup", async () => {
		const gate = deferred(),
			f = await boot({
				stale: true,
				hold: { phase: "subscription", gate: gate.promise, reject: true },
			});
		await f.start("startup");
		await settle();
		gate.resolve();
		await f.idle();
		await f.advance(INTERVAL_MS);
		await settle();
		expect(f.sent).toEqual(["CACHE_REFRESH_STALE", "CACHE_REFRESH_STALE"]);
		expect(f.deliveries).toEqual(["sent", "sent"]);
		await assertGraphs(f, ["sent", "sent"]);
	});
});
