import { AsyncResource } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { QuiTorrent } from "@arr/shared";
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
import type { Prisma, ServiceInstance } from "../../lib/prisma.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import notificationPlugin from "../notification-service.js";
import scheduler from "../qui-torrent-state-scheduler.js";
import registry from "../scheduler-registry.js";

// Keep the actual sync, topology lock, publication choreography and notification service.
// Only provider construction/inventory and sender transport are synthetic.
const boundary = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("../../lib/qui/client-factory.js", () => ({ createQuiClient: boundary.client }));
const STARTUP_MS = 30_000,
	INTERVAL_MS = 600_000;
const SEEN_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	ABSENT_HASH = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
type Origin = "startup" | "interval";
type Phase =
	| "lookup"
	| "instances"
	| "provider"
	| "prior"
	| "clear"
	| "stage"
	| "absence"
	| "publish"
	| "subscription"
	| "send"
	| "log"
	| "channel"
	| "activity"
	| "trim";
const perRound: Record<Phase, number> = {
	lookup: 1,
	instances: 1,
	provider: 2,
	prior: 1,
	clear: 2,
	stage: 2,
	absence: 2,
	publish: 2,
	subscription: 1,
	send: 1,
	log: 1,
	channel: 1,
	activity: 1,
	trim: 1,
};

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
		owners: Array<{ userId: string; channelId: string }>;
		library: Array<{ id: string; instanceId: string }>;
		episode: Array<{ id: string; instanceId: string }>;
	}
>();
const realTimeout = globalThis.setTimeout,
	realClearTimeout = globalThis.clearTimeout,
	realInterval = globalThis.setInterval,
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
	const deadline = performance.now() + 4000;
	while (!observe()) {
		if (performance.now() >= deadline) return false;
		await settle();
	}
	return true;
}
type Row = {
	id: string;
	infoHash: string | null;
	torrentState: string | null;
	torrentRatio: number | null;
	torrentSyncedAt: Date | null;
};
const wantPayload = {
	eventType: "QUI_TORRENT_COMPLETED",
	title: "Torrent completed: Synthetic item",
	body: '"Synthetic item" completed in qui (Same synthetic label).',
	url: "https://synthetic.invalid/qui",
	metadata: {
		aggregate: false,
		kind: "completed",
		infoHash: SEEN_HASH,
		torrentTitle: "Synthetic item",
		instanceLabel: "Same synthetic label",
		oldState: "downloading",
		newState: "seeding",
	},
};
type GraphItem = { owner: string; state: "ready" | "sent" | "uncertain" | "submitting"; at: Date };
function roundGraph(origin: Origin, state: GraphItem["state"]): GraphItem[] {
	const startup = new Date("2026-10-02T00:00:30.000Z");
	return [
		...(origin === "interval" ? [{ owner: "owner-a", state: "sent" as const, at: startup }] : []),
		{
			owner: "owner-a",
			state,
			at: origin === "startup" ? startup : new Date("2026-10-02T00:10:30.000Z"),
		},
	];
}
async function boot(
	options: {
		hold?: { phase: Phase; gate: Promise<void>; call?: number; reject?: boolean };
		preCloseGate?: Promise<void>;
		empty?: boolean;
		multiOwner?: boolean;
		incomplete?: boolean;
	} = {},
) {
	const native = await createNotificationOutboxNativeFixture();
	const ownerRows = [
		{ userId: native.userId, channelId: native.channelId },
		await native.createOwner(),
	];
	const owners = options.multiOwner ? ["owner-a", "owner-b"] : ["owner-a"];
	const aliasFor = (id: string) =>
		["owner-a", "owner-b"][ownerRows.findIndex((row) => row.userId === id)]!;
	const ownerId = (alias: string) => ownerRows[["owner-a", "owner-b"].indexOf(alias)]!.userId;
	const owned = {
		instances: [] as Array<{ id: string; userId: string }>,
		owners: ownerRows,
		library: [] as Array<{ id: string; instanceId: string }>,
		episode: [] as Array<{ id: string; instanceId: string }>,
	};
	fixtures.set(native, owned);
	// Capture native lineage before admission, independently of the outbox graph.
	const expectedRestoreBinding = await native.run(() =>
		native.prisma.restoreRuntimeControl.findUniqueOrThrow({
			where: { id: 1 },
			select: { lastCommittedRestoreId: true },
		}),
	);
	const instances: ServiceInstance[] = [];
	await native.run(async () => {
		for (const [index, owner] of ownerRows.entries()) {
			const config = native.encryptor.encrypt(
				JSON.stringify({ webhookUrl: `https://example.invalid/synthetic-qui/${owner.userId}` }),
			);
			expect(
				(
					await native.prisma.notificationChannel.updateMany({
						where: { id: owner.channelId, userId: owner.userId },
						data: {
							name: "Same synthetic channel",
							encryptedConfig: config.value,
							configIv: config.iv,
						},
					})
				).count,
			).toBe(1);
			await native.prisma.notificationSubscription.create({
				data: { channelId: owner.channelId, eventType: "QUI_TORRENT_COMPLETED" },
			});
			for (let view = 0; view < 3; view++) {
				const key = native.encryptor.encrypt("synthetic-qui-key");
				const instance = await native.prisma.serviceInstance.create({
					data: {
						userId: owner.userId,
						service: view === 2 ? "SONARR" : "QUI",
						label: "Same synthetic label",
						baseUrl: "https://synthetic.invalid",
						encryptedApiKey: key.value,
						encryptionIv: key.iv,
						enabled: view === 2 || (!options.empty && (index === 0 || options.multiOwner === true)),
						connectionGeneration: 7,
						identityStatus: "VERIFIED",
						identityGeneration: 3,
						expectedIdentity: `synthetic-identity-${view}`,
					},
				});
				owned.instances.push({ id: instance.id, userId: instance.userId });
				if (view < 2 && instance.enabled) instances.push(instance);
				if (view === 2) {
					for (const [hashIndex, hash] of [SEEN_HASH, ABSENT_HASH].entries()) {
						const data = {
							instanceId: instance.id,
							infoHash: hash,
							torrentState: "downloading",
							torrentRatio: 0,
							torrentSyncedAt: new Date(Date.now() - 1000),
						};
						const library = await native.prisma.libraryCache.create({
							data: {
								...data,
								arrItemId: hashIndex + 1,
								itemType: "series",
								title: "Synthetic item",
								data: "{}",
							},
						});
						owned.library.push({ id: library.id, instanceId: instance.id });
						const episode = await native.prisma.episodeFileCache.create({
							data: {
								...data,
								arrEpisodeFileId: hashIndex + 1,
								arrSeriesId: hashIndex + 1,
								seasonNumber: 1,
								relativePath: "Synthetic.mkv",
								path: "/synthetic/Synthetic.mkv",
								size: 100n,
							},
						});
						owned.episode.push({ id: episode.id, instanceId: instance.id });
					}
				}
			}
		}
	});
	instances.sort(
		(left, right) =>
			owners.indexOf(aliasFor(left.userId)) - owners.indexOf(aliasFor(right.userId)) ||
			left.id.localeCompare(right.id),
	);
	await native.restart(false);
	const client = createRuntimePrismaClient(native.runtime),
		prisma = client.prisma;
	const counts = Object.fromEntries(Object.keys(perRound).map((phase) => [phase, 0])) as Record<
		Phase,
		number
	>;
	const state = { pending: 0, teardown: false, afterTeardown: 0, pendingAtTeardown: -1 };
	const selected: string[] = [],
		sent: string[] = [],
		logs: string[] = [],
		activity: string[] = [],
		ownerSequence: string[] = [];
	let held = false,
		active = 0;
	async function phase<T>(name: Phase, operation: () => PromiseLike<T> | T): Promise<T> {
		counts[name]++;
		state.pending++;
		if (state.teardown) state.afterTeardown++;
		try {
			if (options.hold?.phase === name && counts[name] === (options.hold.call ?? 1)) {
				held = true;
				await options.hold.gate;
				if (options.hold.reject) throw new Error("Synthetic boundary unavailable");
			}
			return await operation();
		} finally {
			if (state.teardown) state.afterTeardown++;
			state.pending--;
		}
	}
	const lookup = prisma.serviceInstance.findMany.bind(prisma.serviceInstance);
	const reads: { findMany: AwaitOnly<typeof prisma.serviceInstance.findMany> } =
		prisma.serviceInstance;
	vi.spyOn(reads, "findMany").mockImplementation((query) => {
		if (query?.distinct) {
			expect(query).toEqual({
				where: { service: "QUI", enabled: true },
				select: { userId: true },
				distinct: ["userId"],
			});
			return phase("lookup", async () => {
				const rows = await lookup({ ...query, select: { userId: true } });
				expect(new Set(rows.map((row) => row.userId))).toEqual(
					new Set(options.empty ? [] : owners.map(ownerId)),
				);
				ownerSequence.splice(0, ownerSequence.length, ...rows.map((row) => aliasFor(row.userId)));
				return rows;
			});
		}
		if (!query?.where) throw new Error("Missing native instance lookup");
		const id = (query.where as { userId: string }).userId;
		expect(owners).toContain(aliasFor(id));
		if (query.select) {
			// The real publication guard captures connection identity before the
			// separately held instance/provider reads. Keep that native read real.
			expect(query).toEqual({
				where: { userId: id, service: "QUI", enabled: true },
				orderBy: { id: "asc" },
				select: {
					id: true,
					userId: true,
					service: true,
					enabled: true,
					connectionGeneration: true,
					identityGeneration: true,
					baseUrl: true,
					encryptedApiKey: true,
					encryptionIv: true,
					encryptedHttpAuthCredentials: true,
					httpAuthEncryptionIv: true,
				},
			});
			return lookup(query);
		}
		expect(query).toEqual({
			where: { userId: id, service: "QUI", enabled: true },
			orderBy: { createdAt: "asc" },
		});
		return phase("instances", async () => {
			const rows = await lookup(query);
			expect(new Set(rows.map((row) => row.id))).toEqual(
				new Set(instances.filter((row) => row.userId === id).map((row) => row.id)),
			);
			for (const row of rows)
				expect(row).toEqual(instances.find((instance) => instance.id === row.id));
			return rows;
		});
	});
	type CacheArgs = {
		where: { instance: { userId: string }; infoHash?: unknown; id?: { in: string[] } };
		select?: { title?: boolean };
		data?: { torrentSyncedAt?: Date | null; torrentState?: null; torrentRatio?: null };
	};
	function instrumentCache(
		target: Pick<Prisma.TransactionClient, "libraryCache" | "episodeFileCache">,
	) {
		for (const table of ["library", "episode"] as const) {
			const delegate = table === "library" ? target.libraryCache : target.episodeFileCache;
			const methods = delegate as unknown as Record<
				string,
				(...args: unknown[]) => PromiseLike<unknown>
			>;
			for (const method of ["findMany", "updateMany"]) {
				const original = methods[method]!.bind(delegate);
				vi.spyOn(methods, method).mockImplementation(async (...args) => {
					const query = args[0] as CacheArgs,
						alias = aliasFor(query.where.instance.userId);
					expect(owners).toContain(alias);
					if (method === "findMany") {
						expect(query.where.infoHash).toEqual({ not: null });
						expect(query.select).toEqual(
							query.select?.title
								? { infoHash: true, torrentState: true, title: true }
								: { id: true, infoHash: true },
						);
						if (query.select?.title) return phase("prior", () => original(...args));
						return original(...args);
					}
					const name: Phase =
						query.data?.torrentSyncedAt instanceof Date
							? "publish"
							: query.where.id
								? "absence"
								: "clear";
					if (name === "publish") expect(query.where.infoHash).toEqual({ not: null });
					if (name === "absence") {
						const cacheRows = table === "library" ? owned.library : owned.episode;
						const arr = owned.instances.find(
							(row) =>
								row.userId === query.where.instance.userId &&
								cacheRows.some((cache) => cache.instanceId === row.id),
						)!;
						const absent = await native.run(() =>
							table === "library"
								? native.prisma.libraryCache.findMany({
										where: { instanceId: arr.id, infoHash: ABSENT_HASH },
										select: { id: true },
									})
								: native.prisma.episodeFileCache.findMany({
										where: { instanceId: arr.id, infoHash: ABSENT_HASH },
										select: { id: true },
									}),
						);
						expect(query.where.id!.in).toEqual(absent.map((row) => row.id));
					}
					return phase(name, () => original(...args));
				});
			}
		}
	}
	instrumentCache(prisma);
	function instrumentStaging(target: Prisma.TransactionClient) {
		const execute = target.$executeRaw;
		// Prisma transaction clients share their raw method with the parent.
		// Wrap only this callback's view instead of replacing that shared method.
		return new Proxy(target, {
			get(delegate, key, receiver) {
				if (key !== "$executeRaw") return Reflect.get(delegate, key, receiver);
				return (statement: unknown, ...values: unknown[]) => {
					const sql = statement as Prisma.Sql;
					if (!("strings" in sql) || !sql.strings.join("").includes("WITH staged"))
						return Reflect.apply(execute, delegate, [statement, ...values]);
					const id = String(sql.values.at(-1));
					expect(owners).toContain(aliasFor(id));
					expect(sql.values).toEqual([SEEN_HASH, "seeding", null, id]);
					const text = sql.strings.join("");
					expect(text).toContain('WHERE "userId" = ');
					expect(text).toContain('LOWER(cache."infoHash")');
					expect(
						text.includes('UPDATE "library_cache"') || text.includes('UPDATE "episode_file_cache"'),
					).toBe(true);
					return phase("stage", () => Reflect.apply(execute, delegate, [statement, ...values]));
				};
			},
		});
	}
	const subscriptions = prisma.notificationSubscription.findMany.bind(
		prisma.notificationSubscription,
	);
	const subscriptionReads: {
		findMany: AwaitOnly<typeof prisma.notificationSubscription.findMany>;
	} = prisma.notificationSubscription;
	vi.spyOn(subscriptionReads, "findMany").mockImplementation((query) => {
		if (!query?.where?.channel) throw new Error("Missing native subscription owner");
		const id = (query.where.channel as { userId: string }).userId;
		expect(owners).toContain(aliasFor(id));
		expect(query).toEqual({
			where: { eventType: "QUI_TORRENT_COMPLETED", channel: { userId: id } },
			include: { channel: true },
		});
		return phase("subscription", async () => {
			const rows = await subscriptions({ ...query, include: { channel: true } });
			expect(rows).toHaveLength(1);
			expect(rows[0]!.channel).toMatchObject({
				id: ownerRows.find((row) => row.userId === id)!.channelId,
				userId: id,
			});
			return rows;
		});
	});
	const transaction = prisma.$transaction.bind(prisma);
	vi.spyOn(prisma, "$transaction").mockImplementation(async (operation, transactionOptions) =>
		transaction(async (tx) => {
			instrumentCache(tx);
			const create = tx.notificationLog.create.bind(tx.notificationLog);
			const history: { create: AwaitOnly<typeof tx.notificationLog.create> } = tx.notificationLog;
			vi.spyOn(history, "create").mockImplementation((query) => {
				expect(ownerRows.map((row) => row.channelId)).toContain(query.data.channelId);
				return phase("log", async () => {
					const row = await create(query);
					logs.push(row.status);
					return row;
				});
			});
			const update = tx.notificationChannel.updateMany.bind(tx.notificationChannel);
			const channels: { updateMany: AwaitOnly<typeof tx.notificationChannel.updateMany> } =
				tx.notificationChannel;
			vi.spyOn(channels, "updateMany").mockImplementation((query) => {
				const owner = ownerRows.find((row) => row.channelId === query.where?.id)!;
				expect(owner).toBeDefined();
				expect(query.where?.userId).toBe(owner.userId);
				if (query.data.lastSendResult === undefined) return update(query);
				expect(query.where).toMatchObject({
					id: owner.channelId,
					userId: owner.userId,
					type: "DISCORD",
					encryptedConfig: expect.any(String),
					configIv: expect.any(String),
				});
				return phase("channel", () => update(query));
			});
			return operation(instrumentStaging(tx));
		}, transactionOptions),
	);
	const activityWrite = prisma.quiActivityLog.create.bind(prisma.quiActivityLog);
	const activityWrites: { create: AwaitOnly<typeof prisma.quiActivityLog.create> } =
		prisma.quiActivityLog;
	vi.spyOn(activityWrites, "create").mockImplementation((query) => {
		if (typeof query.data.userId !== "string") throw new Error("Missing native activity owner");
		expect(owners).toContain(aliasFor(query.data.userId));
		expect(query.data.eventType).toBe("qui_sync_complete");
		return phase("activity", async () => {
			const row = await activityWrite(query);
			activity.push(aliasFor(row.userId));
			return row;
		});
	});
	const trim = prisma.quiActivityLog.findFirst.bind(prisma.quiActivityLog);
	const trims: { findFirst: AwaitOnly<typeof prisma.quiActivityLog.findFirst> } =
		prisma.quiActivityLog;
	vi.spyOn(trims, "findFirst").mockImplementation((query) => {
		expect(owners).toContain(aliasFor(query?.where?.userId as string));
		expect(query).toMatchObject({
			where: { userId: expect.any(String), eventType: "qui_sync_complete" },
			orderBy: { createdAt: "desc" },
			skip: 200,
			select: { createdAt: true },
		});
		return phase("trim", () => trim({ ...query, select: { createdAt: true } }));
	});
	const app = Fastify({ logger: false });
	apps.push(app);
	app.decorate("restoreRuntime", native.runtime);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Fixture forbids network"));
	vi.spyOn(NotificationDispatcher.prototype, "send").mockImplementation((type, config, payload) => {
		const owner = ownerRows.find(
			(row) => config.webhookUrl === `https://example.invalid/synthetic-qui/${row.userId}`,
		)!;
		expect(owner).toBeDefined();
		expect(owners).toContain(aliasFor(owner.userId));
		expect(type).toBe("DISCORD");
		expect(payload).toEqual(wantPayload);
		return phase("send", () => {
			sent.push(aliasFor(owner.userId));
			return { success: true, retryable: false };
		});
	});
	boundary.client.mockImplementation((server, instance: ServiceInstance) => {
		expect(server.prisma).toBe(prisma);
		expect(server.encryptor).toBe(native.encryptor);
		expect(server.restoreRuntime).toBe(native.runtime);
		expect(instance).toEqual(instances.find((row) => row.id === instance.id));
		expect(
			native.encryptor.decrypt({ value: instance.encryptedApiKey, iv: instance.encryptionIv }),
		).toBe("synthetic-qui-key");
		return {
			listTorrentInventory: async (...args: unknown[]) => {
				expect(args).toEqual([]);
				selected.push(instance.id);
				return phase("provider", () => {
					const torrent: QuiTorrent = {
						hash: SEEN_HASH,
						name: "Synthetic torrent",
						state: "uploading",
						ratio: 1.5,
						progress: 1,
						numSeeds: 1,
						numLeechs: 0,
						tags: [],
						category: "",
						savePath: "/synthetic",
						addedOn: 1,
						completedOn: 2,
						seedingTime: 1,
						eta: 0,
						dlSpeed: 0,
						upSpeed: 0,
						priority: 0,
						size: 100,
					};
					return {
						torrents: [torrent],
						complete: !(options.incomplete && instance.id === instances[0]!.id),
					};
				});
			},
		};
	});
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
					state.teardown = true;
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
	registerRestoreBootstrapPlugin(app, registry);
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
	const register = app.register.bind(app),
		displayName = Symbol.for("fastify.display-name");
	let selectedRegistrations = 0;
	const registration = vi.spyOn(app, "register").mockImplementation(((
		candidate: unknown,
		...args: unknown[]
	) => {
		if (
			typeof candidate === "function" &&
			Reflect.get(candidate, displayName) === Reflect.get(scheduler, displayName)
		) {
			expect(candidate).not.toBe(scheduler);
			expect(Reflect.get(candidate, Symbol.for("plugin-meta"))).toBe(
				Reflect.get(scheduler, Symbol.for("plugin-meta")),
			);
			selectedRegistrations++;
			return Reflect.apply(register, app, [candidate, ...args]);
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
	const preClosed = deferred();
	app.addHook("preClose", async () => {
		preClosed.resolve();
		if (options.preCloseGate) await options.preCloseGate;
	});
	await app.ready();
	const idle = async () => {
		await app.notificationService.drain();
		await native.runtime.drain();
		expect(await waitForNative(() => active === 0 && state.pending === 0)).toBe(true);
		await settle();
	};
	const advance = async (ms: number) => {
		const target = Date.now() + ms;
		do {
			const due = Math.min(...[...activeTimers.values()].map((row) => row.dueAt));
			await vi.advanceTimersByTimeAsync(Math.max(0, Math.min(target, due) - Date.now()));
			let drained = false;
			const drain = native.runtime.drain().then(() => {
				drained = true;
			});
			tasks.push(drain);
			expect(await waitForNative(() => drained || (held && state.pending > 0))).toBe(true);
			if (drained) await idle();
		} while (Date.now() < target);
		expect(Date.now()).toBe(target);
	};
	const callback = (origin: Origin) => {
		const record = installed.find((row) =>
			origin === "startup"
				? row.kind === "timeout" && row.delay === STARTUP_MS
				: row.kind === "interval" && row.delay === INTERVAL_MS,
		);
		if (!record) throw new Error("qUI callback missing");
		return () => {
			if (origin === "startup") clearTimeout(record.handle);
			record.callback();
		};
	};
	async function readRows() {
		return native.run(async () => {
			const rows = { library: new Map<string, Row[]>(), episode: new Map<string, Row[]>() };
			for (const alias of owners)
				for (const table of ["library", "episode"] as const) {
					const where = { instance: { userId: ownerId(alias) }, infoHash: { not: null } };
					const actual =
						table === "library"
							? await native.prisma.libraryCache.findMany({ where, orderBy: { infoHash: "asc" } })
							: await native.prisma.episodeFileCache.findMany({
									where,
									orderBy: { infoHash: "asc" },
								});
					rows[table].set(alias, actual);
				}
			return rows;
		});
	}
	const snapshot = () =>
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
				where: { id: { in: ownerRows.map((row) => row.channelId) } },
			}),
			activity: await native.prisma.quiActivityLog.findMany({
				where: { userId: { in: ownerRows.map((row) => row.userId) } },
			}),
		}));
	async function resetPrior() {
		await native.run(async () => {
			const where = { instance: { userId: { in: owners.map(ownerId) } }, infoHash: SEEN_HASH };
			expect(
				(
					await native.prisma.libraryCache.updateMany({
						where,
						data: { torrentState: "downloading" },
					})
				).count,
			).toBe(owners.length);
			expect(
				(
					await native.prisma.episodeFileCache.updateMany({
						where,
						data: { torrentState: "downloading" },
					})
				).count,
			).toBe(owners.length);
		});
	}
	async function assertGraph(expected: GraphItem[]) {
		const graph = await snapshot();
		expect(graph.events).toHaveLength(expected.length);
		expect(graph.deliveries).toHaveLength(expected.length);
		expect(graph.history).toHaveLength(expected.filter((row) => row.state === "sent").length);
		for (const item of expected) {
			const owner = ownerRows.find((row) => row.userId === ownerId(item.owner))!;
			const event = graph.events.find(
				(row) => row.userId === owner.userId && row.acceptedAt.getTime() === item.at.getTime(),
			)!;
			expect(event).toMatchObject({
				userId: owner.userId,
				eventType: "QUI_TORRENT_COMPLETED",
				stage: item.state === "ready" || item.state === "submitting" ? "ready" : "terminal",
				acceptedAt: item.at,
				dueAt: item.at,
				destinationInstallationId: "synthetic-notification-outbox-destination",
				restoreCommitId: expectedRestoreBinding.lastCommittedRestoreId,
				aggregationWindowSeconds: null,
				maxBatchSize: null,
				aggregateParentId: null,
			});
			expect(event.encryptedPayload).not.toContain("Synthetic item");
			expect(
				JSON.parse(
					native.encryptor.decrypt({ value: event.encryptedPayload, iv: event.payloadIv }),
				),
			).toEqual({
				purpose: "arr-dashboard:notification-outbox-event",
				version: 1,
				eventId: event.id,
				userId: owner.userId,
				payload: wantPayload,
				recipients: [
					{
						channelId: owner.channelId,
						channelType: "DISCORD",
						subscriptionEventType: "QUI_TORRENT_COMPLETED",
					},
				],
				fallbackEventTypes: [],
				policy: { stage: "ready" },
				acceptedAt: item.at.toISOString(),
				dueAt: item.at.toISOString(),
				destinationInstallationId: "synthetic-notification-outbox-destination",
				restoreCommitId: expectedRestoreBinding.lastCommittedRestoreId,
			});
			const delivery = graph.deliveries.find((row) => row.eventId === event.id)!;
			expect(delivery).toMatchObject({
				userId: owner.userId,
				channelId: owner.channelId,
				channelType: "DISCORD",
				subscriptionEventType: "QUI_TORRENT_COMPLETED",
				state: item.state,
				attemptOrdinal: 0,
				nextAttemptAt: item.at,
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
		}
		for (const owner of ownerRows) {
			const sends = expected.filter(
				(row) => ownerId(row.owner) === owner.userId && row.state === "sent",
			);
			const history = graph.history.filter((row) => row.channelId === owner.channelId);
			expect(history).toHaveLength(sends.length);
			for (const row of history)
				expect(row).toMatchObject({
					channelId: owner.channelId,
					channelType: "DISCORD",
					eventType: "QUI_TORRENT_COMPLETED",
					title: wantPayload.title,
					body: wantPayload.body,
					status: "sent",
					error: null,
					retryCount: 0,
				});
			expect(graph.channels.find((row) => row.id === owner.channelId)).toMatchObject({
				userId: owner.userId,
				lastSentAt: sends.length ? expect.any(Date) : null,
				lastSendResult: sends.length ? "success" : null,
			});
		}
		return graph;
	}
	async function recover(expected: GraphItem[]) {
		// Only normal restart after the original app/provider/worker/client physically joined.
		expect(state).toMatchObject({
			pending: 0,
			pendingAtTeardown: 0,
			afterTeardown: 0,
			teardown: true,
		});
		expect(active).toBe(0);
		await Promise.all(tasks);
		await native.runtime.drain();
		const beforeCounts = { ...counts },
			beforeSelected = [...selected],
			beforeActivity = [...activity];
		const beforeRows = await readRows();
		const before = await assertGraph(expected);
		const recoverySent: string[] = [];
		vi.spyOn(NotificationDispatcher.prototype, "send").mockImplementation(
			async (type, config, payload) => {
				const owner = ownerRows.find(
					(row) => config.webhookUrl === `https://example.invalid/synthetic-qui/${row.userId}`,
				)!;
				expect(owner).toBeDefined();
				expect(type).toBe("DISCORD");
				expect(payload).toEqual(wantPayload);
				recoverySent.push(aliasFor(owner.userId));
				return { success: true, retryable: false };
			},
		);
		await native.restart(false);
		const recoveryClient = createRuntimePrismaClient(native.runtime);
		const recoveryApp = Fastify({ logger: false });
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
		registerRestoreBootstrapPlugin(recoveryApp, notificationPlugin);
		registerRestoreRuntimeActivation(recoveryApp);
		await recoveryApp.ready();
		await recoveryApp.notificationService.drain();
		await native.runtime.drain();
		expect([...recoverySent].sort()).toEqual(
			expected
				.filter((row) => row.state === "ready")
				.map((row) => row.owner)
				.sort(),
		);
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
		expect(after.activity).toEqual(before.activity);
		expect(counts).toEqual(beforeCounts);
		expect(selected).toEqual(beforeSelected);
		expect(activity).toEqual(beforeActivity);
		expect(await readRows()).toEqual(beforeRows);
		// A second drain is not another startup and must not add delivery.
		await recoveryApp.notificationService.drain();
		expect(recoverySent).toHaveLength(expected.filter((row) => row.state === "ready").length);
		await recoveryApp.close();
		await native.runtime.drain();
	}
	return {
		app,
		native,
		instances,
		owners,
		ownerRows,
		ownerId,
		counts,
		state,
		sent,
		logs,
		selected,
		activity,
		callback,
		readRows,
		snapshot,
		advance,
		idle,
		resetPrior,
		assertGraph,
		recover,
		ownerSequence,
		intervals: {
			get mock() {
				return {
					calls: installed
						.filter((row) => row.kind === "interval")
						.map((row) => [row.callback, row.delay]),
				};
			},
		},
		status: () => app.schedulerRegistry.getStatus(JOB_ID.quiTorrentStateSync)!,
		async start(origin: Origin) {
			if (origin === "interval") {
				await advance(STARTUP_MS);
				await idle();
				await resetPrior();
			}
			await advance(origin === "startup" ? STARTUP_MS : INTERVAL_MS);
			if (options.hold && counts[options.hold.phase] >= (options.hold.call ?? 1))
				expect(await waitForNative(() => held && state.pending > 0)).toBe(true);
		},
		async closePending() {
			let settled = false;
			const promise = app.close().then(() => {
				settled = true;
			});
			await preClosed.promise;
			await settle();
			return { promise, settled: () => settled };
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
			?.includes("/plugins/qui-torrent-state-scheduler.ts") === true;
	vi.stubGlobal("setTimeout", ((callback: () => void, delay?: number, ...args: unknown[]) => {
		if (!schedulerCallsite())
			return Reflect.apply(realTimeout, globalThis, [callback, delay, ...args]);
		// Real Node timers retain the installing async context. Preserve that
		// existing context only; this does not mint native runtime authority.
		const invoke = AsyncResource.bind(() => Reflect.apply(callback, globalThis, args));
		let handle: ReturnType<typeof setTimeout>;
		const forward = () => {
			activeTimers.delete(handle);
			invoke();
		};
		handle = Reflect.apply(virtualTimeout, globalThis, [forward, delay]);
		const record: TimerRecord = {
			kind: "timeout",
			delay: delay ?? 0,
			dueAt: Date.now() + Math.max(0, delay ?? 0),
			callback: invoke,
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
		const invoke = AsyncResource.bind(() => Reflect.apply(callback, globalThis, args));
		let record: TimerRecord;
		const forward = () => {
			record.dueAt += record.delay;
			invoke();
		};
		const handle = Reflect.apply(virtualInterval, globalThis, [forward, delay]);
		record = {
			kind: "interval",
			delay: delay ?? 0,
			dueAt: Date.now() + Math.max(0, delay ?? 0),
			callback: invoke,
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
	boundary.client.mockReset();
});

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(tasks.splice(0));
	await Promise.all(apps.splice(0).map((app) => app.close()));
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	for (const [native, owned] of fixtures) {
		await native.run(async () => {
			expect(
				(await native.prisma.libraryCache.deleteMany({ where: { OR: owned.library } })).count,
			).toBe(4);
			expect(
				(await native.prisma.episodeFileCache.deleteMany({ where: { OR: owned.episode } })).count,
			).toBe(4);
			expect(
				await native.prisma.libraryCache.count({
					where: { id: { in: owned.library.map((row) => row.id) } },
				}),
			).toBe(0);
			expect(
				await native.prisma.episodeFileCache.count({
					where: { id: { in: owned.episode.map((row) => row.id) } },
				}),
			).toBe(0);
			expect(
				(await native.prisma.serviceInstance.deleteMany({ where: { OR: owned.instances } })).count,
			).toBe(6);
			expect(
				await native.prisma.serviceInstance.count({
					where: { id: { in: owned.instances.map((row) => row.id) } },
				}),
			).toBe(0);
			expect(
				(
					await native.prisma.user.deleteMany({
						where: { id: { in: owned.owners.map((row) => row.userId) } },
					})
				).count,
			).toBe(2);
			expect(
				await native.prisma.user.count({
					where: { id: { in: owned.owners.map((row) => row.userId) } },
				}),
			).toBe(0);
			expect(
				await native.prisma.notificationChannel.count({
					where: { id: { in: owned.owners.map((row) => row.channelId) } },
				}),
			).toBe(0);
			expect(
				await native.prisma.notificationSubscription.count({
					where: { channelId: { in: owned.owners.map((row) => row.channelId) } },
				}),
			).toBe(0);
			expect(
				await native.prisma.notificationOutboxEvent.count({
					where: { userId: { in: owned.owners.map((row) => row.userId) } },
				}),
			).toBe(0);
			expect(
				await native.prisma.notificationOutboxDelivery.count({
					where: { userId: { in: owned.owners.map((row) => row.userId) } },
				}),
			).toBe(0);
			expect(
				await native.prisma.quiActivityLog.count({
					where: { userId: { in: owned.owners.map((row) => row.userId) } },
				}),
			).toBe(0);
		});
		await native.close();
	}
	fixtures.clear();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
describe("qUI accepted sync lifetime and notification handoff", () => {
	for (const origin of ["startup", "interval"] as const) {
		for (const phase of [
			"lookup",
			"instances",
			"provider",
			"prior",
			"clear",
			"stage",
			"absence",
			"publish",
			"subscription",
			"send",
			"log",
			"channel",
			"activity",
			"trim",
		] as const) {
			for (const reject of [false, true]) {
				it(`drains ${origin} ${phase} ${reject ? "failure" : "completion"} before dependent teardown`, async () => {
					const gate = deferred(),
						f = await boot({
							hold: {
								phase,
								gate: gate.promise,
								reject,
								call: origin === "startup" ? 1 : perRound[phase] + 1,
							},
						});
					await f.start(origin);
					expect(f.state.pending).toBeGreaterThan(0);
					// The controlled send/bookkeeping/activity gates occur after physical send entry.
					const startedSend = ["send", "log", "channel", "activity", "trim"].includes(phase);
					expect(f.counts.send).toBe((origin === "interval" ? 1 : 0) + (startedSend ? 1 : 0));
					if (phase === "stage" || phase === "publish") {
						for (const table of ["library", "episode"] as const)
							for (const row of (await f.readRows())[table].get("owner-a")!)
								expect(row.torrentSyncedAt).toBeNull();
					}
					const closing = await f.closePending();
					expect(closing.settled()).toBe(false);
					expect(f.state.teardown).toBe(false);
					gate.resolve();
					await closing.promise;
					expect(f.state).toMatchObject({
						pending: 0,
						pendingAtTeardown: 0,
						afterTeardown: 0,
						teardown: true,
					});
					expect(f.status().state).toBe("idle");
					if (!reject) {
						expect(f.sent).toEqual(
							Array.from(
								{ length: (origin === "interval" ? 1 : 0) + (startedSend ? 1 : 0) },
								() => "owner-a",
							),
						);
						const expected = roundGraph(origin, startedSend ? "sent" : "ready");
						await f.assertGraph(expected);
						if (!startedSend) await f.recover(expected);
						expect(f.activity).toEqual(origin === "startup" ? ["owner-a"] : ["owner-a", "owner-a"]);
						for (const table of ["library", "episode"] as const) {
							const seen = (await f.readRows())[table].get("owner-a")![0]!,
								absent = (await f.readRows())[table].get("owner-a")![1]!;
							expect(seen).toMatchObject({ torrentState: "seeding", torrentRatio: null });
							expect(seen.torrentSyncedAt).toBeInstanceOf(Date);
							expect(absent.torrentState).toBeNull();
							expect(absent.torrentSyncedAt).toBeInstanceOf(Date);
						}
					}
					if (reject && ["provider", "clear", "stage", "absence", "publish"].includes(phase)) {
						for (const table of ["library", "episode"] as const)
							for (const row of (await f.readRows())[table].get("owner-a")!)
								expect(row).toMatchObject({
									torrentState: null,
									torrentRatio: null,
									torrentSyncedAt: null,
								});
						expect(f.sent).toEqual(origin === "startup" ? [] : ["owner-a"]);
					}
					if (reject) {
						if (phase === "send" || phase === "log" || phase === "channel") {
							// A thrown transport is unconfirmed; failed bookkeeping retains its committed marker.
							expect(f.sent).toEqual(
								Array.from(
									{ length: (origin === "interval" ? 1 : 0) + (phase === "send" ? 0 : 1) },
									() => "owner-a",
								),
							);
							await f.recover(roundGraph(origin, phase === "send" ? "uncertain" : "submitting"));
						} else if (phase === "activity" || phase === "trim") {
							await f.assertGraph(roundGraph(origin, "sent"));
						} else {
							// Failed dependency/publication/subscription work cannot fabricate a current send.
							await f.assertGraph(origin === "startup" ? [] : roundGraph("startup", "sent"));
						}
					}
					expect(vi.getTimerCount()).toBe(0);
				});
			}
		}
		it(`preserves the future owner-scoped notification after a held ${origin} provider read`, async () => {
			const gate = deferred(),
				f = await boot({
					hold: { phase: "provider", gate: gate.promise, call: origin === "startup" ? 1 : 3 },
				});
			await f.start(origin);
			const closing = await f.closePending();
			await expect(
				f.app.notificationService.notify(
					{ eventType: "QUI_TORRENT_COMPLETED", title: "Synthetic", body: "Synthetic" },
					{ userId: f.ownerId("owner-b") },
				),
			).rejects.toThrow("shutting down");
			expect(closing.settled()).toBe(false);
			gate.resolve();
			await closing.promise;
			expect(f.sent).toEqual(origin === "startup" ? [] : ["owner-a"]);
			expect(f.logs).toEqual(origin === "startup" ? [] : ["sent"]);
			await f.recover(roundGraph(origin, "ready"));
			expect(f.state.afterTeardown).toBe(0);
		});
		it(`rejects ${origin} callbacks during a sibling preClose barrier`, async () => {
			const gate = deferred(),
				f = await boot({ preCloseGate: gate.promise, empty: true });
			if (origin === "interval") await f.start("startup");
			const invoke = f.callback(origin),
				before = { ...f.counts },
				installs = f.intervals.mock.calls.length;
			const closing = await f.closePending();
			invoke();
			await settle();
			expect(f.counts).toEqual(before);
			expect(f.intervals.mock.calls.length).toBe(installs);
			gate.resolve();
			await closing.promise;
		});
		it(`ignores retired ${origin} callbacks without timer reinstallation`, async () => {
			const f = await boot({ empty: true });
			if (origin === "interval") await f.start("startup");
			const invoke = f.callback(origin),
				before = { ...f.counts },
				installs = f.intervals.mock.calls.length;
			await f.app.close();
			invoke();
			await settle();
			await f.advance(24 * 60 * 60_000);
			expect(f.counts).toEqual(before);
			expect(f.intervals.mock.calls.length).toBe(installs);
			expect(f.state.afterTeardown).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		});
		it(`skips overlapping ${origin} ticks while retaining the accepted publication`, async () => {
			const gate = deferred(),
				f = await boot({
					hold: { phase: "stage", gate: gate.promise, call: origin === "startup" ? 1 : 3 },
				});
			await f.start(origin);
			const before = { ...f.counts };
			f.callback("interval")();
			await settle();
			expect(f.counts).toEqual(before);
			const closing = await f.closePending();
			expect(closing.settled()).toBe(false);
			gate.resolve();
			await closing.promise;
			expect(f.state.afterTeardown).toBe(0);
		});
	}
	for (const phase of ["lookup", "provider", "stage", "publish", "activity", "send"] as const)
		it(`keeps maintenance excluded through accepted ${phase} work`, async () => {
			const gate = deferred(),
				f = await boot({ hold: { phase, gate: gate.promise } });
			await f.start("startup");
			await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
				statusCode: 409,
			});
			const closing = await f.closePending();
			await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
				statusCode: 409,
			});
			gate.resolve();
			await closing.promise;
			await expect(withCleanupMaintenanceGuard(async () => "released")).resolves.toBe("released");
			expect(f.state.afterTeardown).toBe(0);
		});
	it("does not start a producer or database work during maintenance and recovers at the next interval", async () => {
		const f = await boot();
		const before = { ...f.status() };
		await withCleanupMaintenanceGuard(async () => {
			f.callback("startup")();
			await f.idle();
		});
		expect(f.counts.lookup).toBe(0);
		expect(f.status()).toEqual(before);
		f.callback("interval")();
		await f.idle();
		expect(f.sent).toEqual(["owner-a"]);
	});
	it("finishes both same-label owners and routes each completion only to that owner during shutdown", async () => {
		const gate = deferred(),
			f = await boot({
				multiOwner: true,
				hold: { phase: "provider", gate: gate.promise, call: 2 },
			});
		await f.start("startup");
		const closing = await f.closePending();
		expect(closing.settled()).toBe(false);
		gate.resolve();
		await closing.promise;
		expect(f.selected).toEqual(f.instances.map((instance) => instance.id));
		expect(f.sent).toEqual([]);
		expect(f.activity).toEqual(["owner-a", "owner-b"]);
		expect(f.state.afterTeardown).toBe(0);
		await f.recover(
			["owner-a", "owner-b"].map((owner) => ({
				owner,
				state: "ready" as const,
				at: new Date("2026-10-02T00:00:30.000Z"),
			})),
		);
	});
	it("keeps partial topology unavailable instead of publishing or notifying during drain", async () => {
		const gate = deferred(),
			f = await boot({ incomplete: true, hold: { phase: "provider", gate: gate.promise } });
		await f.start("startup");
		const closing = await f.closePending();
		expect(closing.settled()).toBe(false);
		gate.resolve();
		await closing.promise;
		expect(f.counts.stage).toBe(0);
		expect(f.counts.publish).toBe(0);
		expect(f.sent).toEqual([]);
		for (const table of ["library", "episode"] as const)
			for (const row of (await f.readRows())[table].get("owner-a")!)
				expect(row).toMatchObject({
					torrentState: null,
					torrentRatio: null,
					torrentSyncedAt: null,
				});
		expect(f.state.afterTeardown).toBe(0);
	});
	it("preserves the 30-second delay and ten-minute cadence", async () => {
		const f = await boot({ empty: true });
		await f.advance(STARTUP_MS - 1);
		expect(f.counts.lookup).toBe(0);
		await f.advance(1);
		expect(f.counts.lookup).toBe(1);
		await f.advance(INTERVAL_MS - 1);
		expect(f.counts.lookup).toBe(1);
		await f.advance(1);
		expect(f.counts.lookup).toBe(2);
	});
	it("joins duplicate close requests without cutting off a staged publication", async () => {
		const gate = deferred(),
			f = await boot({ hold: { phase: "stage", gate: gate.promise } });
		await f.start("startup");
		const closing = await f.closePending(),
			second = f.app.close();
		await settle();
		expect(f.state.teardown).toBe(false);
		gate.resolve();
		await Promise.all([closing.promise, second]);
		expect(f.state.afterTeardown).toBe(0);
	});
	it("releases a failed lookup and permits a fresh round on the next interval", async () => {
		const gate = deferred(),
			f = await boot({ hold: { phase: "lookup", gate: gate.promise, reject: true } });
		await f.start("startup");
		gate.resolve();
		await f.idle();
		expect(f.status().state).toBe("idle");
		await expect(withCleanupMaintenanceGuard(async () => undefined)).resolves.toBeUndefined();
		f.callback("interval")();
		await f.idle();
		expect(f.sent).toEqual(["owner-a"]);
	});
});
