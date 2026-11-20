import { AsyncResource } from "node:async_hooks";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRestoreRuntimeClientContext } from "../../lib/backup/restore-runtime-admission.js";
import { JellyfinClient, type JellyfinSession } from "../../lib/jellyfin/jellyfin-client.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { NotificationDispatcher } from "../../lib/notifications/notification-dispatcher.js";
import { NotificationService } from "../../lib/notifications/notification-service.js";
import { RuleEngine } from "../../lib/notifications/rule-engine.js";
import { PlexClient } from "../../lib/plex/plex-client.js";
import schedulerRegistryPlugin from "../scheduler-registry.js";
import sessionSnapshotSchedulerPlugin from "../session-snapshot-scheduler.js";

const MINUTE = 60_000;
const realDate = Date;
const realTimeout = setTimeout;
const realInterval = setInterval;
type Native = Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
type HistoryRow = Pick<
	Awaited<ReturnType<Native["prisma"]["sessionSnapshot"]["findMany"]>>[number],
	"id" | "sessionsJson"
>;
type HistoryRead = (
	...args: Parameters<Native["prisma"]["sessionSnapshot"]["findMany"]>
) => PromiseLike<HistoryRow[]>;
let native: Native;
let app: FastifyInstance | undefined;
let service: NotificationService;
let now: number;
let startup: (() => void) | undefined;
let interval: (() => void) | undefined;
const ticks: Promise<unknown>[] = [];
const releases: Array<() => void> = [];
let sessions: JellyfinSession[];
let instanceId: string;

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	releases.push(resolve);
	return { promise, resolve };
}

// Keep native owner heartbeats, worker deadlines and database I/O on real time.
function schedulerCallsite() {
	return (
		new Error().stack
			?.split("\n")
			.find((line) => line.includes("/src/") && !line.includes("/__tests__/"))
			?.includes("/plugins/session-snapshot-scheduler.ts") === true
	);
}

async function boot() {
	startup = undefined;
	interval = undefined;
	app = Fastify({ logger: false });
	app.decorate("restoreRuntime", native.runtime);
	await app.register(
		fp(
			async (server) => {
				server.decorate("prisma", native.prisma);
			},
			{ name: "prisma" },
		),
	);
	await app.register(
		fp(
			async (server) => {
				server.decorate("encryptor", native.encryptor);
			},
			{ name: "security" },
		),
	);
	await app.register(
		fp(
			async (server) => {
				const dispatcher = new NotificationDispatcher();
				// Only the physical sender is synthetic; rules, selection and outbox are real.
				dispatcher.registerSender("DISCORD", {
					send: async () => ({ success: true, retryable: false }),
					test: async () => {
						throw new Error("No connectivity tests allowed");
					},
				});
				service = new NotificationService(
					native.prisma,
					native.encryptor,
					dispatcher,
					server.log,
					undefined,
					undefined,
					"https://synthetic.invalid",
					new RuleEngine(),
					undefined,
					{ runtime: native.runtime, clock: native.clock },
				);
				server.decorate("notificationService", service);
				server.addHook("preClose", async () => {
					service.closeAdmission();
				});
				server.addHook("onClose", async () => {
					await service.shutdown();
				});
			},
			{ name: "notification-service" },
		),
	);
	await app.register(schedulerRegistryPlugin);
	const track = app.schedulerRegistry.track.bind(app.schedulerRegistry);
	vi.spyOn(app.schedulerRegistry, "track").mockImplementation((...args) => {
		const task = track(...args);
		ticks.push(task);
		return task;
	});
	await app.register(sessionSnapshotSchedulerPlugin);
	await app.ready();
}

async function tick(minutes = 0) {
	now += minutes * MINUTE;
	native.now = new realDate(now);
	const offset = ticks.length;
	const callback = interval ?? startup;
	expect(callback).toBeTypeOf("function");
	callback!();
	expect(ticks.length).toBe(offset + 1);
	await ticks[offset];
	await service.drain();
}

async function events() {
	return native.run(() =>
		native.prisma.notificationOutboxEvent.findMany({
			where: { userId: native.userId },
			orderBy: { acceptedAt: "asc" },
		}),
	);
}

async function history(sessionsJson: string) {
	return native.run(() =>
		native.prisma.sessionSnapshot.create({
			data: {
				instanceId,
				sessionsJson,
				concurrentStreams: 1,
				capturedAt: new realDate(now - MINUTE),
			},
		}),
	);
}

beforeEach(async () => {
	now = realDate.now();
	const scopedDate = function (this: unknown, ...args: unknown[]) {
		if (!new.target) return Reflect.apply(realDate, undefined, []);
		return Reflect.construct(
			realDate,
			args.length ? args : [schedulerCallsite() ? now : realDate.now()],
		);
	} as unknown as DateConstructor;
	Object.defineProperty(scopedDate, "prototype", { value: realDate.prototype });
	scopedDate.now = () => (schedulerCallsite() ? now : realDate.now());
	scopedDate.parse = realDate.parse;
	scopedDate.UTC = realDate.UTC;
	vi.stubGlobal("Date", scopedDate);
	vi.stubGlobal("setTimeout", ((callback: () => void, delay?: number, ...args: unknown[]) => {
		if (!schedulerCallsite())
			return Reflect.apply(realTimeout, globalThis, [callback, delay, ...args]);
		expect(delay).toBe(MINUTE);
		startup = AsyncResource.bind(callback);
		return realTimeout(() => undefined, 2 ** 30).unref();
	}) as typeof setTimeout);
	vi.stubGlobal("setInterval", ((callback: () => void, delay?: number, ...args: unknown[]) => {
		if (!schedulerCallsite())
			return Reflect.apply(realInterval, globalThis, [callback, delay, ...args]);
		expect([5 * MINUTE, 24 * 60 * MINUTE]).toContain(delay);
		if (delay === 5 * MINUTE) interval = AsyncResource.bind(callback);
		return realInterval(() => undefined, 2 ** 30).unref();
	}) as typeof setInterval);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Fixture forbids network"));
	vi.spyOn(PlexClient.prototype, "getSessions").mockResolvedValue([]);
	sessions = [
		{
			id: "synthetic-session",
			client: "Wholphin",
			deviceName: "Synthetic device",
			isPaused: false,
			playMethod: "DirectPlay",
			positionMs: 0,
			durationMs: 1000,
		},
	];
	vi.spyOn(JellyfinClient.prototype, "getSessions").mockImplementation(async () => sessions);
	native = await createNotificationOutboxNativeFixture();
	native.now = new realDate(now);
	await native.run(async () => {
		for (const eventType of [
			"JELLYFIN_NEW_DEVICE",
			"JELLYFIN_CONCURRENT_PEAK",
			"JELLYFIN_TRANSCODE_HEAVY",
			"PLEX_NEW_DEVICE",
		] as const)
			await native.prisma.notificationSubscription.create({
				data: { channelId: native.channelId, eventType },
			});
		const key = native.encryptor.encrypt("synthetic-provider-key");
		const instance = await native.prisma.serviceInstance.create({
			data: {
				userId: native.userId,
				service: "JELLYFIN",
				label: "Synthetic server",
				baseUrl: "https://example.invalid/synthetic-provider",
				encryptedApiKey: key.value,
				encryptionIv: key.iv,
				enabled: true,
			},
		});
		instanceId = instance.id;
	});
}, 90_000);

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.allSettled(ticks.splice(0));
	await app?.close();
	app = undefined;
	if (native) {
		const url = getRestoreRuntimeClientContext(native.runtime).databaseUrl;
		await native.close();
		if (native.engine === "sqlite") {
			expect(url).toMatch(/^file:\/tmp\/arr-outbox-worker-[^/]+\/owned\.db$/);
			await rm(dirname(url.slice(5)), { recursive: true });
		}
	}
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
}, 90_000);

describe("actual scheduler new-device baseline and native outbox", () => {
	it("accepts a genuine first Jellyfin-only observation but no repeat at +5 minutes", async () => {
		await boot();
		await tick();
		expect((await events()).map((event) => event.eventType)).toEqual(["JELLYFIN_NEW_DEVICE"]);
		await tick(5); // Real outbox content dedup expires; producer must suppress the duplicate.
		expect((await events()).map((event) => event.eventType)).toEqual(["JELLYFIN_NEW_DEVICE"]);
		expect(
			await native.run(() => native.prisma.sessionSnapshot.count({ where: { instanceId } })),
		).toBe(2);
	});
	it("loads existing history before capture and retains it across a native restart", async () => {
		await history(JSON.stringify([{ platform: "Wholphin" }]));
		await boot();
		await tick();
		expect(await events()).toEqual([]);
		await app!.close();
		app = undefined;
		await native.restart();
		await boot();
		await tick(5);
		expect(await events()).toEqual([]);
		sessions = [{ ...sessions[0]!, client: "New synthetic client" }];
		await tick(5);
		expect((await events()).map((event) => event.eventType)).toEqual(["JELLYFIN_NEW_DEVICE"]);
	});
	it("shares a complete empty historical baseline across mixed Plex and Jellyfin captures", async () => {
		await history("[]");
		await native.run(async () => {
			const key = native.encryptor.encrypt("synthetic-plex-key");
			await native.prisma.serviceInstance.create({
				data: {
					userId: native.userId,
					service: "PLEX",
					label: "Synthetic Plex",
					baseUrl: "https://example.invalid/synthetic-plex",
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
					enabled: true,
				},
			});
		});
		vi.mocked(PlexClient.prototype.getSessions).mockResolvedValue([
			{
				sessionKey: "plex-session",
				ratingKey: "plex-item",
				title: "Synthetic item",
				type: "movie",
				user: { id: "synthetic-user", title: "Synthetic viewer" },
				player: {
					title: "Synthetic player",
					platform: "Plex synthetic client",
					product: "Synthetic",
					state: "playing",
				},
				state: "playing",
				viewOffset: 0,
				duration: 1000,
				videoDecision: "direct play",
				audioDecision: "direct play",
				bandwidth: 100,
			},
		]);
		await boot();
		const notify = vi.spyOn(service, "notify");
		await tick();
		await tick(5);
		expect((await events()).map((event) => event.eventType).sort()).toEqual([
			"JELLYFIN_NEW_DEVICE",
			"PLEX_NEW_DEVICE",
		]);
		expect(
			notify.mock.calls.filter(([payload]) => payload.eventType.endsWith("NEW_DEVICE")),
		).toHaveLength(2);
	});
	it("rebuilds at the existing six-hour TTL before recording a genuinely new platform", async () => {
		const read = vi.spyOn(native.prisma.sessionSnapshot, "findMany");
		await boot();
		await tick();
		await tick(5);
		expect(read).toHaveBeenCalledTimes(1);
		sessions = [{ ...sessions[0]!, client: "New synthetic client" }];
		await tick(6 * 60 + 1);
		expect(read).toHaveBeenCalledTimes(2);
		expect(read.mock.calls[1]![0]).toEqual({
			where: { capturedAt: { gte: new realDate(now - 30 * 24 * 60 * MINUTE) } },
			select: { id: true, sessionsJson: true },
			orderBy: { id: "asc" },
			take: 500,
		});
		expect((await events()).map((event) => event.eventType)).toEqual([
			"JELLYFIN_NEW_DEVICE",
			"JELLYFIN_NEW_DEVICE",
		]);
	});
	it("does not treat history outside the existing 30-day lookback as current knowledge", async () => {
		const row = await history(JSON.stringify([{ platform: "Wholphin" }]));
		await native.run(() =>
			native.prisma.sessionSnapshot.update({
				where: { id: row.id },
				data: { capturedAt: new realDate(now - 31 * 24 * 60 * MINUTE) },
			}),
		);
		await boot();
		await tick();
		expect((await events()).map((event) => event.eventType)).toEqual(["JELLYFIN_NEW_DEVICE"]);
	});
	it.each(["broken JSON", "{}", "[null]", '[{"platform":7}]', '[{"platform":""}]', "[{}]"])(
		"suppresses novelty from malformed or unknown history %s while still capturing",
		async (invalid) => {
			await history(invalid);
			await boot();
			await tick();
			expect(await events()).toEqual([]);
			expect(
				await native.run(() => native.prisma.sessionSnapshot.count({ where: { instanceId } })),
			).toBe(2);
		},
	);
	it("keeps other alerts and snapshots when the history read fails, and retries without claiming observed clients", async () => {
		const read = vi
			.spyOn(native.prisma.sessionSnapshot, "findMany")
			.mockRejectedValueOnce(new Error("Synthetic history unavailable"));
		sessions = Array.from({ length: 5 }, (_, index) => ({
			...sessions[0]!,
			id: `session-${index}`,
			playMethod: "Transcode",
			transcodingInfo: { isVideoDirect: false, isAudioDirect: false },
		}));
		await boot();
		await tick();
		expect((await events()).map((event) => event.eventType).sort()).toEqual([
			"JELLYFIN_CONCURRENT_PEAK",
			"JELLYFIN_TRANSCODE_HEAVY",
		]);
		await tick(5);
		expect(read).toHaveBeenCalledTimes(2);
		expect((await events()).filter((event) => event.eventType === "JELLYFIN_NEW_DEVICE")).toEqual(
			[],
		);
		expect(
			await native.run(() => native.prisma.sessionSnapshot.count({ where: { instanceId } })),
		).toBe(2);
	});
	it("treats twenty full history batches as incomplete without exceeding the existing cap", async () => {
		let page = 0;
		const historyReads: { findMany: HistoryRead } = native.prisma.sessionSnapshot;
		const read = vi.spyOn(historyReads, "findMany").mockImplementation(async () =>
			Array.from({ length: 500 }, (_, index) => ({
				id: `synthetic-${page++}-${index}`,
				sessionsJson: '[{"platform":"Known synthetic client"}]',
			})),
		);
		await boot();
		await tick();
		expect(read).toHaveBeenCalledTimes(20);
		expect(read.mock.calls[1]![0]).toMatchObject({
			take: 500,
			skip: 1,
			cursor: { id: "synthetic-499-499" },
		});
		expect(await events()).toEqual([]);
		expect(
			await native.run(() => native.prisma.sessionSnapshot.count({ where: { instanceId } })),
		).toBe(1);
	});
	it("coalesces concurrent baseline reads before either provider capture and claims novelty once", async () => {
		const entered = deferred();
		const release = deferred();
		const findMany = native.prisma.sessionSnapshot.findMany.bind(native.prisma.sessionSnapshot);
		const historyReads: { findMany: HistoryRead } = native.prisma.sessionSnapshot;
		const read = vi.spyOn(historyReads, "findMany").mockImplementation(async (...args) => {
			entered.resolve();
			await release.promise;
			return findMany(...args);
		});
		await boot();
		const notify = vi.spyOn(service, "notify");
		const first = tick();
		await entered.promise;
		const second = tick();
		await new Promise<void>((done) => setImmediate(done));
		expect(read).toHaveBeenCalledTimes(1);
		expect(JellyfinClient.prototype.getSessions).not.toHaveBeenCalled();
		expect(PlexClient.prototype.getSessions).not.toHaveBeenCalled();
		expect(
			await native.run(() => native.prisma.sessionSnapshot.count({ where: { instanceId } })),
		).toBe(0);
		release.resolve();
		await Promise.all([first, second]);
		expect(
			notify.mock.calls.filter(([payload]) => payload.eventType === "JELLYFIN_NEW_DEVICE"),
		).toHaveLength(1);
		expect((await events()).map((event) => event.eventType)).toEqual(["JELLYFIN_NEW_DEVICE"]);
	});
	it("keeps all first-seen claims when threshold alerts await, then suppresses the next tick", async () => {
		sessions = Array.from({ length: 5 }, (_, index) => ({
			...sessions[0]!,
			id: `session-${index}`,
			client: index ? "Other synthetic client" : "Wholphin",
			playMethod: "Transcode",
			transcodingInfo: { isVideoDirect: false, isAudioDirect: false },
		}));
		await boot();
		const notify = vi.spyOn(service, "notify");
		await tick();
		expect((await events()).map((event) => event.eventType).sort()).toEqual([
			"JELLYFIN_CONCURRENT_PEAK",
			"JELLYFIN_NEW_DEVICE",
			"JELLYFIN_NEW_DEVICE",
			"JELLYFIN_TRANSCODE_HEAVY",
		]);
		await tick(5);
		expect(
			notify.mock.calls.filter(([payload]) => payload.eventType === "JELLYFIN_NEW_DEVICE"),
		).toHaveLength(2);
	});
});
