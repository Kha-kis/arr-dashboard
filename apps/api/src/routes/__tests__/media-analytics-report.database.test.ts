import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	interceptScopedWriteCompetition,
	type ScopedWriteFixture,
} from "../../lib/__tests__/scoped-write-intent-fixture.js";
import type { JellyfinSession } from "../../lib/jellyfin/jellyfin-client.js";
import type { PlexSessionItem } from "../../lib/plex/plex-client.js";
import {
	buildFailedSessionSnapshot,
	buildJellyfinSessionSnapshot,
	buildPlexSessionSnapshot,
} from "../../plugins/lib/session-snapshot-measurements.js";
import { registerJellyfinRoutes } from "../jellyfin/index.js";
import { registerPlexRoutes } from "../plex/index.js";

afterEach(closeScopedWriteFixtures);

type Provider = "plex" | "jellyfin";
const scope = { connectionGeneration: 1, identityGeneration: 1 };
function sample(provider: "PLEX" | "JELLYFIN" | "EMBY", index: number) {
	const type = (["movie", "episode", "track"] as const)[index % 3]!;
	if (provider === "PLEX") {
		const session: PlexSessionItem = {
			sessionKey: `session-${index}`,
			ratingKey: `item-${index}`,
			title: `Synthetic item ${index}`,
			grandparentTitle: `Synthetic series ${index}`,
			type,
			user: { id: "7", title: "Synthetic viewer" },
			player: {
				title: "Synthetic player",
				platform: "Synthetic platform",
				product: "Synthetic",
				state: "playing",
			},
			state: "playing",
			viewOffset: 500,
			duration: 1_000,
			videoDecision: index % 2 ? "transcode" : "direct play",
			audioDecision: "direct play",
			bandwidth: index % 2 ? undefined : 100,
			videoCodec: "h264",
			audioCodec: "aac",
			videoResolution: "1080",
		};
		return buildPlexSessionSnapshot([session], scope);
	}
	const session: JellyfinSession = {
		id: `session-${index}`,
		userId: "7",
		userName: "Synthetic viewer",
		client: "Synthetic client",
		deviceName: "Synthetic device",
		isPaused: false,
		positionMs: 500,
		durationMs: 1_000,
		nowPlayingItem: {
			id: `item-${index}`,
			name: `Synthetic item ${index}`,
			seriesName: `Synthetic series ${index}`,
			type: type === "movie" ? "Movie" : type === "episode" ? "Episode" : "Audio",
			played: false,
			playCount: 0,
			lastPlayedDate: null,
			isFavorite: false,
		},
	};
	return buildJellyfinSessionSnapshot([session], provider, scope);
}

async function application(f: ScopedWriteFixture) {
	const app = Fastify({ logger: false });
	app.decorate("prisma", f.client.prisma);
	app.decorateRequest("currentUser", null);
	const owner = await f.plain.user.findUniqueOrThrow({ where: { id: "synthetic-user" } });
	app.addHook("preHandler", async (request) => {
		request.currentUser = owner;
	});
	await app.register(registerPlexRoutes, { prefix: "/api/plex" });
	await app.register(registerJellyfinRoutes, { prefix: "/api/jellyfin" });
	await app.ready();
	return app;
}

async function seedScope(f: ScopedWriteFixture) {
	await f.plain.user.create({ data: { id: "other-owner", username: "other-owner" } });
	for (const [id, service, userId, enabled] of [
		["second-plex", "PLEX", "synthetic-user", true],
		["synthetic-emby", "EMBY", "synthetic-user", true],
		["disabled-plex", "PLEX", "synthetic-user", false],
		["disabled-jellyfin", "JELLYFIN", "synthetic-user", false],
		["other-plex", "PLEX", "other-owner", true],
		["other-jellyfin", "JELLYFIN", "other-owner", true],
	] as const)
		await f.plain.serviceInstance.create({
			data: {
				id,
				service,
				userId,
				enabled,
				label: "Synthetic",
				baseUrl: "http://synthetic.invalid",
				encryptedApiKey: "synthetic-cipher",
				encryptionIv: "synthetic-iv",
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
	const now = Date.now();
	for (const [instanceId, provider] of [
		["synthetic-plex", "PLEX"],
		["second-plex", "PLEX"],
		["synthetic-jellyfin", "JELLYFIN"],
		["synthetic-emby", "EMBY"],
	] as const) {
		const rows = Array.from({ length: 36 }, (_, i) => ({
			id: `${instanceId}-${String(i).padStart(3, "0")}`,
			instanceId,
			capturedAt: new Date(now - 86_400_000 - i * 1_800_000),
			...sample(provider, i),
		}));
		await f.plain.sessionSnapshot.createMany({
			data: [
				...rows,
				{
					id: `${instanceId}-idle`,
					instanceId,
					capturedAt: new Date(now - 1_000),
					...(provider === "PLEX"
						? buildPlexSessionSnapshot([], scope)
						: buildJellyfinSessionSnapshot([], provider, scope)),
				},
				{
					id: `${instanceId}-failed`,
					instanceId,
					capturedAt: new Date(now - 2_000),
					...buildFailedSessionSnapshot(provider, scope),
				},
				{
					id: `${instanceId}-invalid`,
					instanceId,
					capturedAt: new Date(now - 3_000),
					...sample(provider, 0),
					measurementJson: "{",
				},
				{
					id: `${instanceId}-legacy`,
					instanceId,
					capturedAt: new Date(now - 4_000),
					...sample(provider, 0),
					measurementJson: null,
					totalBandwidth: 999_999,
				},
				{
					id: `${instanceId}-bad-detail`,
					instanceId,
					capturedAt: new Date(now - 5_000),
					...sample(provider, 0),
					sessionsJson: "{",
				},
			],
		});
	}
	for (const instanceId of ["disabled-plex", "disabled-jellyfin", "other-plex", "other-jellyfin"]) {
		await f.plain.sessionSnapshot.create({
			data: {
				id: instanceId,
				instanceId,
				capturedAt: new Date(now - 86_400_000),
				...sample(instanceId.includes("plex") ? "PLEX" : "JELLYFIN", 99),
			},
		});
	}
	await f.plain.sessionSnapshot.create({
		data: {
			id: "old",
			instanceId: "synthetic-plex",
			capturedAt: new Date(now - 100 * 86_400_000),
			...sample("PLEX", 98),
		},
	});
}

describe("consistent provider analytics report", { timeout: 20_000 }, () => {
	it.each(["plex", "jellyfin"] as const)(
		"serves all fourteen %s chart sections through one owned report request",
		async (provider) => {
			const f = await createScopedWriteFixture();
			const app = await application(f);
			try {
				const response = await f.runtime.runOperation(() =>
					app.inject({ method: "GET", url: `/api/${provider}/analytics/report?days=7` }),
				);
				expect(response.statusCode).toBe(200);
				const report = response.json();
				expect(report).toMatchObject({ version: 1, provider, days: 7 });
				expect(Object.keys(report.topMedia).sort()).toEqual(["movie", "music", "series"]);
				expect(Object.keys(report.popularMedia).sort()).toEqual(["movie", "music", "series"]);
				for (const section of [
					"transcode",
					"bandwidth",
					"userAnalytics",
					"watchHistory",
					"codec",
					"devices",
					"qualityScore",
					"forecast",
				])
					expect(report[section]).toBeDefined();
				const devices = await f.runtime.runOperation(() =>
					app.inject(`/api/${provider}/analytics/devices?days=7`),
				);
				expect(devices.statusCode).toBe(200);
				expect(report.devices).toEqual(devices.json());
			} finally {
				await app.close();
			}
		},
	);

	it.each(["plex", "jellyfin"] as const)(
		"preserves all fourteen populated %s results and owned enabled-source coverage",
		async (provider) => {
			const f = await createScopedWriteFixture();
			await seedScope(f);
			const app = await application(f);
			const get = async (path: string) => {
				const response = await f.runtime.runOperation(() =>
					app.inject(`/api/${provider}/analytics/${path}`),
				);
				expect(response.statusCode, response.body).toBe(200);
				return response.json();
			};
			try {
				const report = await get("report?days=7");
				for (const [section, path] of [
					["transcode", "transcode"],
					["bandwidth", "bandwidth"],
					["userAnalytics", "users"],
					["watchHistory", "history"],
					["codec", "codec"],
					["devices", "devices"],
					["qualityScore", "quality-score"],
					["forecast", "forecast"],
				] as const) {
					expect(report[section], section).toEqual(await get(`${path}?days=7&limit=20`));
				}
				for (const mediaType of ["movie", "series", "music"]) {
					expect(report.topMedia[mediaType]).toEqual(
						await get(`top-media?days=7&mediaType=${mediaType}&limit=10`),
					);
					expect(report.popularMedia[mediaType]).toEqual(
						await get(`popular-media?days=7&mediaType=${mediaType}&limit=10`),
					);
					expect(report.topMedia[mediaType].items).toHaveLength(10);
				}
				expect(report.watchHistory.events).toHaveLength(20);
				expect(report.bandwidth.measurement).toMatchObject({
					configuredSources: 2,
					status: provider === "plex" ? "partial" : "unavailable",
					collection: {
						activeSnapshots: 74,
						idleSnapshots: 2,
						failedSnapshots: 2,
						invalidSnapshots: 2,
						legacySnapshots: 2,
					},
				});
				// Malformed detail must not erase its independent, valid bandwidth receipt.
				if (provider === "plex") expect(report.bandwidth.measurement.measuredSessions).toBe(38);
				expect(JSON.stringify(report)).not.toMatch(
					/parseFailures|failedPreviews|999999|other-owner|other-plex|disabled-plex/,
				);
			} finally {
				await app.close();
			}
		},
	);

	it("rejects a native reverse-scan failure without a partial success, then recovers", async () => {
		const f = await createScopedWriteFixture();
		await f.plain.sessionSnapshot.create({
			data: {
				id: "active",
				instanceId: "synthetic-plex",
				capturedAt: new Date(),
				...sample("PLEX", 0),
			},
		});
		const app = await application(f);
		const prepare = Database.prototype.prepare;
		let failed = false;
		const spy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: Database.Database,
			sql,
		) {
			if (
				this.name === f.path &&
				this !== f.writer &&
				sql.includes("session_snapshots") &&
				sql.includes("DESC") &&
				!failed
			) {
				failed = true;
				throw new Error("synthetic-reverse-scan-failure");
			}
			return prepare.call(this, sql);
		});
		try {
			const response = await f.runtime.runOperation(() =>
				app.inject("/api/plex/analytics/report?days=7"),
			);
			expect(failed, response.body).toBe(true);
			expect(response.statusCode).toBe(500);
			expect(response.json()).not.toHaveProperty("transcode");
			spy.mockRestore();
			const recovered = await f.runtime.runOperation(() =>
				app.inject("/api/plex/analytics/report?days=7"),
			);
			expect(recovered.statusCode).toBe(200);
			expect(recovered.json().bandwidth.measurement.measuredSessions).toBe(1);
			expect(f.losses).toEqual([]);
		} finally {
			spy.mockRestore();
			await app.close();
		}
	});

	it("serves overlapping populated provider reports with bounded native ownership", async () => {
		const f = await createScopedWriteFixture();
		const now = Date.now();
		for (const provider of ["plex", "jellyfin"] as const) {
			const rows = Array.from({ length: 17_001 }, (_, i) => ({
				id: `${provider}-${String(i).padStart(5, "0")}`,
				instanceId: `synthetic-${provider}`,
				capturedAt: new Date(now - 1_000 - i * 20_000),
				...sample(provider === "plex" ? "PLEX" : "JELLYFIN", i % 36),
			}));
			for (let i = 0; i < rows.length; i += 500)
				await f.plain.sessionSnapshot.createMany({ data: rows.slice(i, i + 500) });
		}
		const app = await application(f);
		interceptScopedWriteCompetition(f);
		try {
			const responses = await Promise.all(
				(["plex", "jellyfin"] satisfies Provider[]).map((provider) =>
					f.runtime.runOperation(() => app.inject(`/api/${provider}/analytics/report?days=7`)),
				),
			);
			for (const response of responses) {
				expect(response.statusCode, response.body).toBe(200);
				expect(response.json().bandwidth.measurement.collection.activeSnapshots).toBe(17_001);
			}
			expect(f.applications.size).toBeLessThanOrEqual(2);
			expect(f.applications.size).toBeGreaterThan(0);
			expect(f.losses).toEqual([]);
			await f.client.close();
			expect([...f.applications].every((native) => !native.open)).toBe(true);
		} finally {
			await app.close();
		}
	});
});
