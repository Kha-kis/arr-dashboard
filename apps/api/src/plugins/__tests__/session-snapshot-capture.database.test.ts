import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import { synchronizeSqliteRuntimeSchema } from "../../lib/backup/runtime-schema-sqlite.js";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../../lib/backup/restore-runtime-bootstrap.js";
import { Encryptor } from "../../lib/auth/encryption.js";
import { JellyfinClient, type JellyfinSession } from "../../lib/jellyfin/jellyfin-client.js";
import { PlexClient, type PlexSessionItem } from "../../lib/plex/plex-client.js";
import type { PrismaClient, ServiceType } from "../../lib/prisma.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import { TautulliClient } from "../../lib/tautulli/tautulli-client.js";
import { aggregateCodecAnalytics } from "../../routes/plex/lib/codec-analytics-helpers.js";
import { aggregateDeviceAnalytics } from "../../routes/plex/lib/device-analytics-helpers.js";
import { computeQualityScore } from "../../routes/plex/lib/quality-score-helpers.js";
import { aggregateUserAnalytics } from "../../routes/plex/lib/user-analytics-helpers.js";
import { parseSessionSnapshotMeasurement } from "../lib/session-snapshot-measurements.js";
import notificationServicePlugin from "../notification-service.js";
import { prismaPlugin } from "../prisma.js";
import schedulerRegistryPlugin from "../scheduler-registry.js";
import sessionSnapshotSchedulerPlugin from "../session-snapshot-scheduler.js";

const resources: Array<{
	directory: string;
	prisma: PrismaClient;
	app: FastifyInstance;
	db: Database.Database;
}> = [];
const encryptor = new Encryptor(Buffer.alloc(32, 23).toString("base64"));
const sources = [
	{ id: "plex-a", service: "PLEX", userId: "owner-a", enabled: true },
	{ id: "plex-b", service: "PLEX", userId: "owner-b", enabled: true },
	{ id: "jellyfin", service: "JELLYFIN", userId: "owner-a", enabled: true },
	{ id: "emby", service: "EMBY", userId: "owner-b", enabled: true },
	{ id: "disabled", service: "PLEX", userId: "owner-a", enabled: false },
	{ id: "tautulli", service: "TAUTULLI", userId: "owner-b", enabled: true },
] satisfies Array<{ id: string; service: ServiceType; userId: string; enabled: boolean }>;
const nativeSources = sources.filter((source) => source.enabled && source.service !== "TAUTULLI");

function plexSessions(): PlexSessionItem[] {
	const base: PlexSessionItem = {
		sessionKey: "shared-session",
		ratingKey: "shared-item",
		title: "Same synthetic title",
		type: "movie",
		user: { id: "7", title: "Same synthetic viewer" },
		player: {
			title: "Synthetic device",
			platform: "Synthetic platform",
			product: "Synthetic",
			state: "playing",
		},
		state: "playing",
		viewOffset: 12_345,
		duration: 90_000,
		videoDecision: "unknown",
		audioDecision: "unknown",
	};
	return [
		base,
		{
			...base,
			sessionKey: "zero-session",
			ratingKey: "zero-item",
			bandwidth: 0,
			videoDecision: "direct play",
			audioDecision: "direct play",
			videoCodec: "h264",
			audioCodec: "aac",
			videoResolution: "1920x1080",
		},
		{
			...base,
			sessionKey: "fraction-session",
			ratingKey: "fraction-item",
			bandwidth: 0.5,
			videoDecision: "copy",
			audioDecision: "transcode",
			videoCodec: "hevc",
			audioCodec: "aac",
			videoResolution: "3840x2160",
		},
	];
}

function jellyfinSessions(): JellyfinSession[] {
	const base: JellyfinSession = {
		id: "shared-session",
		userId: "7",
		userName: "Same synthetic viewer",
		client: "Synthetic platform",
		deviceName: "Synthetic device",
		isPaused: false,
		positionMs: 12_345,
		durationMs: 90_000,
		nowPlayingItem: {
			id: "shared-item",
			name: "Same synthetic title",
			type: "Movie",
			played: false,
			playCount: 0,
			lastPlayedDate: null,
			isFavorite: false,
		},
	};
	return [
		base,
		{
			...base,
			id: "zero-session",
			playMethod: "DirectPlay",
			transcodingInfo: {
				bitrate: 0,
				isVideoDirect: true,
				isAudioDirect: true,
				videoCodec: "h264",
				audioCodec: "aac",
				width: 1920,
				height: 1080,
			},
		},
		{
			...base,
			id: "fraction-session",
			playMethod: "Transcode",
			transcodingInfo: {
				bitrate: 500,
				isVideoDirect: true,
				isAudioDirect: false,
				videoCodec: "hevc",
				audioCodec: "aac",
				width: 3840,
				height: 2160,
			},
		},
	];
}

type Mode = "active" | "idle" | "failed";
async function boot(
	plexRows?: PlexSessionItem[],
	jellyfinRows?: JellyfinSession[],
	onRead?: (sourceId: string) => Promise<void>,
) {
	const directory = mkdtempSync(join(tmpdir(), "session-snapshot-capture-"));
	chmodSync(directory, 0o700);
	const dbPath = join(directory, "capture.db");
	let prisma = createTestPrismaClient(dbPath);
	const app = Fastify({ logger: false });
	const warnings = vi.spyOn(app.log, "warn");
	let db = new Database(dbPath);
	chmodSync(dbPath, 0o600);
	const resource = { directory, prisma, app, db };
	resources.push(resource);
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "pipe",
	});
	await prisma.user.createMany({
		data: [
			{ id: "owner-a", username: "synthetic-a" },
			{ id: "owner-b", username: "synthetic-b" },
		],
	});
	for (const source of sources) {
		const key = encryptor.encrypt(`synthetic-key-${source.id}`);
		const auth = encryptor.encrypt(
			JSON.stringify({ v: 1, username: "synthetic", password: `synthetic-${source.id}` }),
		);
		await prisma.serviceInstance.create({
			data: {
				...source,
				label: "Same synthetic label",
				baseUrl: `https://synthetic.invalid/${source.id}`,
				encryptedApiKey: key.value,
				encryptionIv: key.iv,
				// Jellyfin's modern Authorization header requires a proxy bypass.
				encryptedHttpAuthCredentials: source.service === "JELLYFIN" ? null : auth.value,
				httpAuthEncryptionIv: source.service === "JELLYFIN" ? null : auth.iv,
			},
		});
	}
	const legacy = await prisma.sessionSnapshot.create({
		data: {
			id: "legacy",
			instanceId: "plex-a",
			concurrentStreams: 1,
			totalBandwidth: 91,
			directPlayCount: 1,
			sessionsJson: ' [ { "title": "Same synthetic title", "bandwidth": 0 } ] ',
		},
	});
	const modes = new Map(nativeSources.map((source) => [source.id, "active" as Mode]));
	const reads: string[] = [];
	function read(sourceClient: object) {
		const url: unknown = Reflect.get(sourceClient, "baseUrl");
		const source = sources.find((item) => url === `https://synthetic.invalid/${item.id}`);
		if (!source?.enabled || source.service === "TAUTULLI")
			throw new Error("Forbidden native source");
		reads.push(source.id);
		const mode = modes.get(source.id);
		if (mode === "failed") throw new Error("Synthetic native provider unavailable");
		return mode;
	}
	vi.spyOn(PlexClient.prototype, "getSessions").mockImplementation(async function (
		this: PlexClient,
	) {
		if (onRead) await onRead(new URL(Reflect.get(this, "baseUrl")).pathname.slice(1));
		return read(this) === "idle" ? [] : (plexRows ?? plexSessions());
	});
	vi.spyOn(JellyfinClient.prototype, "getSessions").mockImplementation(async function (
		this: JellyfinClient,
	) {
		if (onRead) await onRead(new URL(Reflect.get(this, "baseUrl")).pathname.slice(1));
		return read(this) === "idle" ? [] : (jellyfinRows ?? jellyfinSessions());
	});
	const tautulli = vi
		.spyOn(TautulliClient.prototype, "getActivity")
		.mockRejectedValue(new Error("Forbidden optional enrichment"));
	// Close fixture seeding/inspection handles before the actual cold writer.
	await prisma.$disconnect();
	db.close();
	await synchronizeSqliteRuntimeSchema(`file:${dbPath}`);
	db = new Database(dbPath);
	resource.db = db;
	app.decorate("config", {
		DATABASE_URL: `file:${dbPath}`,
		SQLITE_JOURNAL_MODE: "preserve",
		APP_URL: "https://synthetic.invalid",
	} as never);
	await app.register(prismaPlugin);
	prisma = app.prisma;
	resource.prisma = prisma;
	registerRestoreBootstrapPlugin(
		app,
		fp(
			async (server) => {
				server.decorate("encryptor", encryptor);
				await server.restoreRuntime.bindDestination("synthetic-session-capture");
			},
			{ name: "security" },
		),
	);
	registerRestoreBootstrapPlugin(app, notificationServicePlugin);
	registerRestoreBootstrapPlugin(app, schedulerRegistryPlugin);
	await app.after();
	// Observe, but do not replace, registry execution. Await the actual tracked
	// promise rather than hoping a sleep or a fake-timer advance drains SQLite.
	const track = app.schedulerRegistry.track.bind(app.schedulerRegistry);
	const ticks: Promise<unknown>[] = [];
	vi.spyOn(app.schedulerRegistry, "track").mockImplementation((...args) => {
		const task = track(...args);
		if (args[0] === JOB_ID.sessionSnapshot) ticks.push(task);
		return task;
	});
	const timeouts = vi.spyOn(globalThis, "setTimeout");
	const intervals = vi.spyOn(globalThis, "setInterval");
	registerRestoreBootstrapPlugin(app, sessionSnapshotSchedulerPlugin);
	registerRestoreRuntimeActivation(app);
	await app.ready();
	const run = <T>(operation: () => T | Promise<T>) => app.restoreRuntime.runOperation(operation);
	let first = true;
	async function tick(outcome: "success" | "failure" = "success") {
		const before = new Set(
			(await run(() => prisma.sessionSnapshot.findMany({ select: { id: true } }))).map(
				(row) => row.id,
			),
		);
		const calls = first ? timeouts.mock.calls : intervals.mock.calls;
		const timer = calls.findIndex(([, delay]) => delay === (first ? 60_000 : 300_000));
		const callback = calls[timer]?.[0];
		if (typeof callback !== "function") throw new Error("Actual session snapshot timer missing");
		if (first) clearTimeout(timeouts.mock.results[timer]?.value);
		const previousTicks = ticks.length;
		callback();
		expect(ticks).toHaveLength(previousTicks + 1);
		if (outcome === "failure")
			await expect(ticks[previousTicks]).rejects.toBeInstanceOf(AggregateError);
		else await ticks[previousTicks];
		first = false;
		return (
			await run(() =>
				prisma.sessionSnapshot.findMany({
					include: { instance: { select: { userId: true, service: true } } },
				}),
			)
		).filter((row) => !before.has(row.id));
	}
	return { app, prisma, db, legacy, modes, reads, tautulli, tick, warnings, run };
}

beforeEach(() => {
	vi.useFakeTimers({
		toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	});
	vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Fixture forbids network"));
});
afterEach(async () => {
	for (const resource of resources.splice(0)) {
		await resource.app.close();
		await resource.prisma.$disconnect();
		resource.db.close();
		rmSync(resource.directory, { recursive: true, force: true });
	}
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("actual SessionSnapshot scheduler persistence on populated disposable SQLite", () => {
	it("retains original rows and separates reused actor IDs after persisted source replacement", async () => {
		const fixture = await boot([plexSessions()[1]!], [jellyfinSessions()[1]!]);
		const original = await fixture.tick();
		for (const row of original) {
			expect(JSON.parse(row.measurementJson!).sourceScope).toEqual({
				connectionGeneration: 0,
				identityGeneration: 0,
			});
		}
		await fixture.run(() =>
			fixture.prisma.serviceInstance.updateMany({
				where: { id: { in: nativeSources.map((source) => source.id) } },
				data: { connectionGeneration: 1, identityGeneration: 1 },
			}),
		);
		const replaced = await fixture.tick();
		for (const row of replaced) {
			expect(JSON.parse(row.measurementJson!).sourceScope).toEqual({
				connectionGeneration: 1,
				identityGeneration: 1,
			});
		}
		const snapshots = [...original, ...replaced];
		expect(aggregateUserAnalytics(snapshots).users).toHaveLength(8);
		expect(computeQualityScore(snapshots).perUser).toHaveLength(8);
		for (const row of original) {
			expect(
				await fixture.run(() =>
					fixture.prisma.sessionSnapshot.findUniqueOrThrow({ where: { id: row.id } }),
				),
			).toMatchObject({ measurementJson: row.measurementJson, sessionsJson: row.sessionsJson });
		}
		expect(
			await fixture.run(() =>
				fixture.prisma.sessionSnapshot.findUniqueOrThrow({ where: { id: "legacy" } }),
			),
		).toEqual(fixture.legacy);
	}, 60_000);
	it.each(["success", "failure"] as const)(
		"keeps captured generations when sources change during a pending %s provider read",
		async (outcome) => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let entered!: () => void;
			const pending = new Promise<void>((resolve) => {
				entered = resolve;
			});
			let reads = 0;
			const fixture = await boot(undefined, undefined, async (sourceId) => {
				if (sourceId !== "plex-a" && sourceId !== "jellyfin") return;
				if (++reads === 2) entered();
				await gate;
			});
			if (outcome === "failure") {
				fixture.modes.set("plex-a", "failed");
				fixture.modes.set("jellyfin", "failed");
			}
			const capture = fixture.tick(outcome);
			await pending;
			try {
				await fixture.run(() =>
					fixture.prisma.serviceInstance.updateMany({
						where: { id: { in: ["plex-a", "jellyfin"] } },
						data: { connectionGeneration: 2, identityGeneration: 3 },
					}),
				);
			} finally {
				release();
			}
			const captured = (await capture).filter((row) =>
				["plex-a", "jellyfin"].includes(row.instanceId),
			);
			expect(captured).toHaveLength(2);
			for (const row of captured) {
				expect(JSON.parse(row.measurementJson!)).toMatchObject({
					status: outcome === "failure" ? "failed" : "active",
					sourceScope: { connectionGeneration: 0, identityGeneration: 0 },
				});
			}
		},
		60_000,
	);
	it("persists device labels independently when Jellyfin and Emby have no client app label", async () => {
		const base = jellyfinSessions()[0]!;
		const fixture = await boot(undefined, [
			{ ...base, client: undefined, deviceName: "Named device" },
		]);
		const captured = (await fixture.tick()).filter((row) =>
			["JELLYFIN", "EMBY"].includes(row.instance.service),
		);
		expect(captured).toHaveLength(2);
		for (const row of captured) {
			expect(JSON.parse(row.sessionsJson)).toMatchObject([
				{ platform: null, player: "Named device" },
			]);
			expect(JSON.parse(row.measurementJson!)).toMatchObject({ deviceLabelAxis: "client" });
		}
		expect(aggregateDeviceAnalytics(captured)).toMatchObject({
			totalSessions: 2,
			platforms: [{ platform: "unknown", sessions: 2, percent: 100 }],
			players: [{ player: "Named device", platform: "unknown", sessions: 2 }],
			measurement: {
				status: "partial",
				observedSessions: 2,
				platformMeasuredSessions: 0,
				playerMeasuredSessions: 2,
				platformAxis: "client",
				unverifiedPlatformSnapshots: 0,
			},
		});
		expect(
			await fixture.run(() =>
				fixture.prisma.sessionSnapshot.findUniqueOrThrow({ where: { id: "legacy" } }),
			),
		).toEqual(fixture.legacy);
	}, 60_000);
	it("persists Direct Play source quality for Jellyfin and Emby without manufacturing a rate", async () => {
		const base = jellyfinSessions()[0]!;
		const fixture = await boot(undefined, [
			{
				...base,
				playMethod: "DirectPlay",
				sourceQuality: { videoCodec: "hevc", audioCodec: "eac3", width: 3840, height: 2160 },
			},
		]);
		const captured = (await fixture.tick()).filter((row) =>
			["JELLYFIN", "EMBY"].includes(row.instance.service),
		);
		expect(captured).toHaveLength(2);
		for (const row of captured) {
			expect(JSON.parse(row.sessionsJson)).toEqual([
				expect.objectContaining({
					provider: row.instance.service,
					videoCodec: "hevc",
					audioCodec: "eac3",
					videoResolution: "3840x2160",
					videoDecision: "direct play",
					audioDecision: "direct play",
					bandwidth: null,
				}),
			]);
			expect(JSON.parse(row.measurementJson!)).toMatchObject({
				bandwidth: {
					status: "unavailable",
					measuredSessions: 0,
					observedSessions: 1,
					knownTotalKbps: null,
				},
			});
		}
		expect(computeQualityScore(captured)).toMatchObject({
			overallScore: 100,
			measurement: { observedSessions: 2, scoredSessions: 2 },
		});
		expect(aggregateCodecAnalytics(captured)).toMatchObject({
			totalSessions: 2,
			videoCodecs: [{ codec: "hevc", count: 2, percent: 100 }],
			audioCodecs: [{ codec: "eac3", count: 2, percent: 100 }],
			resolutions: [{ resolution: "2160", count: 2, percent: 100 }],
			measurement: {
				status: "complete",
				observedSessions: 2,
				videoCodecMeasuredSessions: 2,
				audioCodecMeasuredSessions: 2,
				resolutionMeasuredSessions: 2,
			},
		});
		expect(
			await fixture.run(() =>
				fixture.prisma.sessionSnapshot.findUniqueOrThrow({ where: { id: "legacy" } }),
			),
		).toEqual(fixture.legacy);
	}, 60_000);
	it("keeps exact and unknown native Plex identities distinct after actual scheduler/database capture", async () => {
		const base = plexSessions()[1]!;
		const ids = ["007", "7", "9007199254740992", "9007199254740993", null];
		const fixture = await boot(
			ids.map((id, index) => ({
				...base,
				sessionKey: String(index),
				user: { id, title: "Same synthetic viewer" },
			})),
		);
		const captured = (await fixture.tick()).filter((row) => row.instance.service === "PLEX");
		expect(captured).toHaveLength(2);
		for (const row of captured) {
			expect(
				JSON.parse(row.sessionsJson).map((entry: { userId: unknown }) => entry.userId),
			).toEqual(ids);
			expect(JSON.parse(row.measurementJson!).userIdentity).toBe("provider-native");
		}
		const users = aggregateUserAnalytics(captured);
		expect(users.users).toHaveLength(8);
		expect(new Set(users.users.map((user) => user.key)).size).toBe(8);
		expect(users.users.every((user) => user.totalSessions === 1 && user.avgBandwidth === 0)).toBe(
			true,
		);
		expect(users.measurement).toMatchObject({
			observedSessions: 10,
			attributedSessions: 8,
			unattributedSessions: 2,
			status: "partial",
		});
		const quality = computeQualityScore(captured);
		expect(quality.overallScore).toBe(93);
		expect(quality.perUser).toHaveLength(8);
		expect(quality.measurement).toMatchObject({
			observedSessions: 10,
			scoredSessions: 10,
			unattributedSessions: 2,
		});
		expect(
			await fixture.run(() =>
				fixture.prisma.sessionSnapshot.findUniqueOrThrow({ where: { id: "legacy" } }),
			),
		).toEqual(fixture.legacy);
	}, 60_000);
	it("persists native active, idle, failed and recovered observations with instance-local measurements", async () => {
		const fixture = await boot();
		const active = await fixture.tick();
		expect(aggregateCodecAnalytics(active)).toMatchObject({
			totalSessions: 12,
			videoCodecs: [
				{ codec: "unknown", count: 4, percent: 33.3 },
				{ codec: "h264", count: 4, percent: 33.3 },
				{ codec: "hevc", count: 4, percent: 33.3 },
			],
			audioCodecs: [
				{ codec: "aac", count: 8, percent: 66.7 },
				{ codec: "unknown", count: 4, percent: 33.3 },
			],
			resolutions: [
				{ resolution: "unknown", count: 4, percent: 33.3 },
				{ resolution: "1080", count: 4, percent: 33.3 },
				{ resolution: "2160", count: 4, percent: 33.3 },
			],
			measurement: {
				status: "partial",
				observedSessions: 12,
				videoCodecMeasuredSessions: 8,
				audioCodecMeasuredSessions: 8,
				resolutionMeasuredSessions: 8,
				collection: { activeSnapshots: 4 },
			},
		});
		expect(
			active.map((row) => row.instanceId).sort(),
			JSON.stringify(
				fixture.warnings.mock.calls.map(([entry]) => {
					const error = (entry as { err?: Error }).err;
					return error?.message;
				}),
			),
		).toEqual(["emby", "jellyfin", "plex-a", "plex-b"]);
		for (const row of active) {
			const provider = row.instance.service;
			expect(aggregateDeviceAnalytics([row])).toMatchObject({
				totalSessions: 3,
				platforms: [{ platform: "Synthetic platform", sessions: 3, percent: 100 }],
				players: [{ player: "Synthetic device", platform: "Synthetic platform", sessions: 3 }],
				measurement: {
					status: "complete",
					platformMeasuredSessions: 3,
					playerMeasuredSessions: 3,
					platformAxis: provider === "PLEX" ? "platform" : "client",
				},
			});
			const measurement = parseSessionSnapshotMeasurement(row.measurementJson);
			expect(measurement).toEqual({
				status: "verified",
				measurement: {
					version: 1,
					provider,
					methodAxis: "video",
					sourceScope: { connectionGeneration: 0, identityGeneration: 0 },
					userIdentity: "provider-native",
					deviceLabelAxis: provider === "PLEX" ? "platform" : "client",
					status: "active",
					bandwidthBasis: provider === "PLEX" ? "provider-reported" : "encoding-estimate",
					observedSessions: 3,
					bandwidth: {
						status: "partial",
						observedSessions: 3,
						measuredSessions: 2,
						knownTotalKbps: 0.5,
					},
					methods: {
						directPlayCount: 1,
						directStreamCount: 1,
						transcodeCount: 0,
						unknownDecisionCount: 1,
					},
					network: { status: "unavailable", lanKbps: null, wanKbps: null },
				},
			});
			expect(row).toMatchObject({
				concurrentStreams: 3,
				totalBandwidth: 1,
				directPlayCount: 1,
				lanBandwidth: 0,
				wanBandwidth: 0,
			});
			const sessions = JSON.parse(row.sessionsJson);
			expect(sessions).toHaveLength(3);
			expect(sessions[0]).toMatchObject({
				provider,
				sessionId: "shared-session",
				itemId: "shared-item",
				userId: "7",
				positionMs: 12_345,
				durationMs: 90_000,
				bandwidth: null,
				videoDecision: "unknown",
				audioDecision: "unknown",
				videoCodec: null,
				audioCodec: null,
				videoResolution: null,
			});
			expect(sessions[1]).toMatchObject({
				bandwidth: 0,
				videoDecision: "direct play",
				audioDecision: "direct play",
				videoCodec: "h264",
				audioCodec: "aac",
				videoResolution: "1920x1080",
			});
			expect(sessions[2]).toMatchObject({
				bandwidth: 0.5,
				videoDecision: "copy",
				audioDecision: "transcode",
				videoCodec: "hevc",
				audioCodec: "aac",
				videoResolution: "3840x2160",
			});
			expect(row.instance.userId).toBe(
				sources.find((source) => source.id === row.instanceId)?.userId,
			);
		}
		expect(
			new Set(active.map((row) => `${row.instanceId}:${JSON.parse(row.sessionsJson)[0].sessionId}`))
				.size,
		).toBe(4);
		for (const source of nativeSources) fixture.modes.set(source.id, "idle");
		const idle = await fixture.tick();
		expect(idle).toHaveLength(4);
		for (const row of idle) {
			expect(parseSessionSnapshotMeasurement(row.measurementJson)).toMatchObject({
				status: "verified",
				measurement: {
					status: "idle",
					provider: row.instance.service,
					bandwidthBasis:
						row.instance.service === "PLEX" ? "provider-reported" : "encoding-estimate",
					observedSessions: 0,
					bandwidth: {
						status: "complete",
						knownTotalKbps: 0,
						observedSessions: 0,
						measuredSessions: 0,
					},
					methods: {
						directPlayCount: 0,
						transcodeCount: 0,
						directStreamCount: 0,
						unknownDecisionCount: 0,
					},
					network: { status: "complete", lanKbps: 0, wanKbps: 0 },
				},
			});
			expect(row).toMatchObject({ concurrentStreams: 0, totalBandwidth: 0, sessionsJson: "[]" });
		}
		for (const source of nativeSources) fixture.modes.set(source.id, "failed");
		const failed = await fixture.tick("failure");
		expect(failed).toHaveLength(4);
		for (const row of failed) {
			expect(parseSessionSnapshotMeasurement(row.measurementJson)).toMatchObject({
				status: "verified",
				measurement: {
					provider: row.instance.service,
					status: "failed",
					observedSessions: null,
					bandwidth: null,
					methods: null,
					network: { status: "unavailable", lanKbps: null, wanKbps: null },
				},
			});
			expect(row.sessionsJson).toBe("[]");
		}
		for (const source of nativeSources) {
			expect(fixture.warnings.mock.calls.map(([entry]) => entry)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ instanceId: source.id, category: "provider-unavailable" }),
				]),
			);
		}
		expect(fixture.app.schedulerRegistry.getStatus(JOB_ID.sessionSnapshot)).toMatchObject({
			state: "idle",
			totalRuns: 3,
			totalFailures: 1,
			consecutiveFailures: 1,
			lastError: expect.any(String),
		});
		for (const source of nativeSources) fixture.modes.set(source.id, "active");
		const recovered = await fixture.tick();
		expect(recovered).toHaveLength(4);
		for (const row of recovered)
			expect(parseSessionSnapshotMeasurement(row.measurementJson)).toMatchObject({
				status: "verified",
				measurement: { status: "active", observedSessions: 3 },
			});
		expect(
			await fixture.run(() =>
				fixture.prisma.sessionSnapshot.findUniqueOrThrow({ where: { id: "legacy" } }),
			),
		).toEqual(fixture.legacy);
		expect(fixture.legacy.measurementJson).toBeNull();
		expect(fixture.reads.filter((source) => source === "disabled")).toEqual([]);
		for (const source of nativeSources)
			expect(fixture.reads.filter((id) => id === source.id)).toHaveLength(4);
		expect(fixture.tautulli).not.toHaveBeenCalled();
		expect(fixture.app.schedulerRegistry.getStatus(JOB_ID.sessionSnapshot)).toMatchObject({
			state: "idle",
			totalRuns: 4,
			totalFailures: 1,
			consecutiveFailures: 0,
			lastError: null,
		});
	}, 60_000);

	it("does not persist a fabricated provider outage when a real SQLite write fails and recovers next tick", async () => {
		const fixture = await boot();
		// Only active/idle writes fail. A mistaken fallback failed-provider write
		// would succeed, making that conflation observable in the persisted rows.
		fixture.db.exec(`CREATE TRIGGER reject_snapshot_write BEFORE INSERT ON session_snapshots
			WHEN NEW.instanceId = 'plex-a' AND json_extract(NEW.measurementJson, '$.status') != 'failed'
			BEGIN SELECT RAISE(ABORT, 'Synthetic SQLite persistence failure'); END;`);
		const partial = await fixture.tick("failure");
		expect(
			fixture.warnings.mock.calls
				.map(([entry]) => entry)
				.filter(
					(entry) =>
						typeof entry === "object" &&
						entry !== null &&
						"instanceId" in entry &&
						entry.instanceId === "plex-a",
				),
		).toEqual([expect.objectContaining({ instanceId: "plex-a", category: "persistence-failed" })]);
		expect(partial.map((row) => row.instanceId).sort()).toEqual(["emby", "jellyfin", "plex-b"]);
		expect(fixture.reads.filter((source) => source === "plex-a")).toHaveLength(1);
		for (const row of partial)
			expect(parseSessionSnapshotMeasurement(row.measurementJson)).toMatchObject({
				status: "verified",
				measurement: { status: "active" },
			});
		expect(
			await fixture.run(() =>
				fixture.prisma.sessionSnapshot.count({
					where: { instanceId: "plex-a", id: { not: "legacy" } },
				}),
			),
		).toBe(0);
		expect(fixture.app.schedulerRegistry.getStatus(JOB_ID.sessionSnapshot)).toMatchObject({
			state: "idle",
			totalRuns: 1,
			totalFailures: 1,
			consecutiveFailures: 1,
			lastError: expect.any(String),
		});
		fixture.db.exec("DROP TRIGGER reject_snapshot_write");
		const recovery = await fixture.tick();
		expect(recovery).toHaveLength(4);
		expect(
			parseSessionSnapshotMeasurement(
				recovery.find((row) => row.instanceId === "plex-a")?.measurementJson,
			),
		).toMatchObject({ status: "verified", measurement: { status: "active" } });
		expect(
			await fixture.run(() =>
				fixture.prisma.sessionSnapshot.findUniqueOrThrow({ where: { id: "legacy" } }),
			),
		).toEqual(fixture.legacy);
		expect(fixture.tautulli).not.toHaveBeenCalled();
		expect(fixture.app.schedulerRegistry.getStatus(JOB_ID.sessionSnapshot)).toMatchObject({
			state: "idle",
			totalRuns: 2,
			totalFailures: 1,
			consecutiveFailures: 0,
			lastError: null,
		});
	}, 60_000);
});
