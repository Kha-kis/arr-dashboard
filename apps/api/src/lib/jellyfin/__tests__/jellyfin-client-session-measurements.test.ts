import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildJellyfinSessionSnapshot } from "../../../plugins/lib/session-snapshot-measurements.js";
import { registerNowPlayingRoutes } from "../../../routes/jellyfin/now-playing-routes.js";
import { computeQualityScore } from "../../../routes/plex/lib/quality-score-helpers.js";
import { Encryptor } from "../../auth/encryption.js";
import { JellyfinClient } from "../jellyfin-client.js";
import { projectJellyfinSessionMeasurements } from "../jellyfin-session-measurements.js";

const servers: Server[] = [];
async function clientFor(
	body: unknown,
	status = 200,
	rawBody?: string,
	provider: "JELLYFIN" | "EMBY" = "JELLYFIN",
) {
	const server = createServer((_request, response) => {
		response.writeHead(status, { "Content-Type": "application/json" });
		response.end(rawBody ?? JSON.stringify(body));
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return new JellyfinClient(
		`http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		"synthetic-token",
		{ warn: vi.fn() } as never,
		15_000,
		{},
		provider,
	);
}
function payload(extra: Record<string, unknown> = {}) {
	return [
		{
			Id: "session-1",
			UserId: "user-1",
			NowPlayingItem: {
				Id: "item-1",
				Name: "Synthetic",
				Type: "Movie",
				RunTimeTicks: 20_000,
			},
			...extra,
		},
	];
}
afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				}),
		),
	);
});

describe("Jellyfin native session measurements over HTTP", () => {
	const video = { Type: "Video", Index: 0, Codec: " hevc ", Width: 3840, Height: 2160 };
	const audio = { Type: "Audio", Index: 7, Codec: " eac3 " };
	const streams = [audio, video, { Type: "Audio", Index: 1, Codec: "aac", IsDefault: true }];
	const item = { Id: "item-1", Name: "Synthetic", Type: "Movie", MediaStreams: streams };
	const active = { Id: "active", MediaStreams: streams, Bitrate: 99_000_000, OpenToken: "PRIVATE" };
	const wrong = {
		Id: "other",
		MediaStreams: [{ ...video, Codec: "h264", Width: 640, Height: 480 }, audio],
	};
	it.each([
		{ provider: "JELLYFIN", item, state: { MediaSourceId: "alternate", AudioStreamIndex: 7 } },
		{
			provider: "JELLYFIN",
			item: { ...item, MediaSources: [wrong, active] },
			state: { MediaSourceId: "active", AudioStreamIndex: 7 },
		},
		{
			provider: "EMBY",
			item: { ...item, MediaSources: [wrong, active] },
			state: { MediaSourceId: "active", AudioStreamIndex: 7 },
		},
		{
			provider: "EMBY",
			item: { ...item, MediaStreams: wrong.MediaStreams },
			state: { MediaSourceId: "active", MediaSource: active, AudioStreamIndex: 7 },
		},
		{ provider: "EMBY", item, state: { MediaSourceId: "item-1", AudioStreamIndex: 7 } },
	] as const)(
		"retains $provider active Direct Play quality through HTTP and snapshot",
		async (c) => {
			const client = await clientFor(
				payload({ NowPlayingItem: c.item, PlayState: { PlayMethod: "DirectPlay", ...c.state } }),
				200,
				undefined,
				c.provider,
			);
			const sessions = await client.getSessions();
			expect(sessions).toHaveLength(1);
			expect(projectJellyfinSessionMeasurements(sessions[0]!)).toMatchObject({
				videoDecision: "direct play",
				audioDecision: "direct play",
				videoCodec: "hevc",
				audioCodec: "eac3",
				videoResolution: "3840x2160",
				bandwidth: undefined,
			});
			const captured = buildJellyfinSessionSnapshot(sessions, c.provider);
			expect(JSON.parse(captured.sessionsJson)[0]).toMatchObject({
				videoCodec: "hevc",
				audioCodec: "eac3",
				videoResolution: "3840x2160",
				bandwidth: null,
			});
			expect(captured.sessionsJson).not.toMatch(/OpenToken|PRIVATE|MediaStreams|MediaSources/);
			expect(
				computeQualityScore([
					{ ...captured, instanceId: "source", capturedAt: new Date("2025-01-15T10:00:00Z") },
				]),
			).toMatchObject({ overallScore: 100, measurement: { scoredSessions: 1 } });
		},
	);
	it("uses unique tracks without an audio selector, but not a default among alternatives", async () => {
		for (const [MediaStreams, audioCodec] of [
			[[video, audio], "eac3"],
			[streams, undefined],
		] as const) {
			const client = await clientFor(
				payload({
					NowPlayingItem: { ...item, MediaStreams },
					PlayState: { PlayMethod: "DirectPlay" },
				}),
			);
			const [session] = await client.getSessions();
			expect(projectJellyfinSessionMeasurements(session!)).toMatchObject({
				videoCodec: "hevc",
				videoResolution: "3840x2160",
				audioCodec,
			});
		}
	});
	it.each([null, "", "   ", 7, {}, []])(
		"keeps valid native dimensions despite invalid codec %s",
		async (Codec) => {
			const client = await clientFor(
				payload({
					NowPlayingItem: {
						...item,
						MediaStreams: [
							{ ...video, Codec },
							{ ...audio, Codec },
						],
					},
					PlayState: { PlayMethod: "DirectPlay", AudioStreamIndex: 7 },
				}),
			);
			const [session] = await client.getSessions();
			expect(projectJellyfinSessionMeasurements(session!)).toMatchObject({
				videoCodec: undefined,
				audioCodec: undefined,
				videoResolution: "3840x2160",
			});
		},
	);
	it("treats nullable selectors as absent and preserves explicit stream index zero", async () => {
		const client = await clientFor(
			payload({
				NowPlayingItem: {
					...item,
					MediaSources: null,
					MediaStreams: [
						{ ...video, Index: 9 },
						{ ...audio, Index: 0 },
					],
				},
				PlayState: {
					PlayMethod: "DirectPlay",
					MediaSource: null,
					MediaSourceId: null,
					AudioStreamIndex: 0,
				},
			}),
		);
		const [session] = await client.getSessions();
		expect(projectJellyfinSessionMeasurements(session!)).toMatchObject({
			videoCodec: "hevc",
			audioCodec: "eac3",
			videoResolution: "3840x2160",
		});
	});
	it.each([
		{
			name: "absent source selection",
			item: { ...item, MediaSources: [wrong, active] },
			state: {},
		},
		{
			name: "unmatched source",
			item: { ...item, MediaSources: [wrong] },
			state: { MediaSourceId: "active" },
		},
		{
			name: "duplicate source",
			item: { ...item, MediaSources: [active, active] },
			state: { MediaSourceId: "active" },
		},
		{
			name: "invalid source list",
			item: { ...item, MediaSources: {} },
			state: { MediaSourceId: "active" },
		},
		{
			name: "mismatched embedded source",
			item,
			state: { MediaSourceId: "active", MediaSource: wrong },
		},
		{ name: "invalid embedded source", item, state: { MediaSourceId: "active", MediaSource: [] } },
		{ name: "invalid source identity", item, state: { MediaSourceId: 7 } },
	] as const)("does not guess quality from $name or discard its session", async (c) => {
		const client = await clientFor(
			payload({ NowPlayingItem: c.item, PlayState: { PlayMethod: "DirectPlay", ...c.state } }),
		);
		const sessions = await client.getSessions();
		expect(sessions).toHaveLength(1);
		expect(projectJellyfinSessionMeasurements(sessions[0]!)).toMatchObject({
			videoCodec: undefined,
			audioCodec: undefined,
			videoResolution: undefined,
		});
	});
	it("does not apply Jellyfin's active-projection assumption to an Emby alternate item", async () => {
		const client = await clientFor(
			payload({
				NowPlayingItem: item,
				PlayState: { PlayMethod: "DirectPlay", MediaSourceId: "alternate", AudioStreamIndex: 7 },
			}),
			200,
			undefined,
			"EMBY",
		);
		const [session] = await client.getSessions();
		expect(projectJellyfinSessionMeasurements(session!)).toMatchObject({
			videoCodec: undefined,
			audioCodec: undefined,
			videoResolution: undefined,
		});
	});
	it.each([
		{
			name: "duplicate selected index",
			rows: [video, audio, { ...audio, Codec: "aac" }],
			index: 7,
		},
		{ name: "nonmatching index", rows: streams, index: 2 },
		{ name: "string index", rows: [video, audio], index: "7" },
		{ name: "negative index", rows: [video, audio], index: -1 },
		{ name: "selected video index", rows: streams, index: 0 },
	] as const)("keeps audio unknown for $name while retaining video", async (c) => {
		const client = await clientFor(
			payload({
				NowPlayingItem: { ...item, MediaStreams: c.rows },
				PlayState: { PlayMethod: "DirectPlay", AudioStreamIndex: c.index },
			}),
		);
		const [session] = await client.getSessions();
		expect(projectJellyfinSessionMeasurements(session!)).toMatchObject({
			videoCodec: "hevc",
			videoResolution: "3840x2160",
			audioCodec: undefined,
		});
	});
	it("does not choose an arbitrary video track, while retaining selected audio", async () => {
		const client = await clientFor(
			payload({
				NowPlayingItem: {
					...item,
					MediaStreams: [video, { ...video, Index: 2, Codec: "h264" }, audio],
				},
				PlayState: { PlayMethod: "DirectPlay", AudioStreamIndex: 7 },
			}),
		);
		const [session] = await client.getSessions();
		expect(projectJellyfinSessionMeasurements(session!)).toMatchObject({
			videoCodec: undefined,
			videoResolution: undefined,
			audioCodec: "eac3",
		});
	});
	it.each([undefined, null, {}, "invalid", [null], [{ Codec: "hevc" }]])(
		"retains a usable session with invalid stream evidence %s",
		async (MediaStreams) => {
			const client = await clientFor(
				payload({
					NowPlayingItem: { ...item, MediaStreams },
					PlayState: { PlayMethod: "DirectPlay" },
				}),
			);
			const sessions = await client.getSessions();
			expect(sessions).toHaveLength(1);
			expect(projectJellyfinSessionMeasurements(sessions[0]!)).toMatchObject({
				videoCodec: undefined,
				audioCodec: undefined,
				videoResolution: undefined,
			});
		},
	);
	it.each([0, -1, 1.5, "3840", null, {}])(
		"rejects invalid native dimensions %s independently from codec/audio",
		async (Width) => {
			const client = await clientFor(
				payload({
					NowPlayingItem: { ...item, MediaStreams: [{ ...video, Width }, audio] },
					PlayState: { PlayMethod: "DirectPlay", AudioStreamIndex: 7 },
				}),
			);
			const [session] = await client.getSessions();
			expect(projectJellyfinSessionMeasurements(session!)).toMatchObject({
				videoCodec: "hevc",
				audioCodec: "eac3",
				videoResolution: undefined,
			});
		},
	);
	it.each([
		{
			method: "DirectStream",
			info: { IsAudioDirect: true },
			video: "hevc",
			audio: "eac3",
			resolution: "3840x2160",
		},
		{
			method: "Transcode",
			info: { IsVideoDirect: true, IsAudioDirect: false, AudioCodec: "aac", Bitrate: 0 },
			video: "hevc",
			audio: "aac",
			resolution: "3840x2160",
		},
		{
			method: "Transcode",
			info: {
				IsVideoDirect: false,
				IsAudioDirect: true,
				VideoCodec: "h264",
				Width: 1280,
				Height: 720,
			},
			video: "h264",
			audio: "eac3",
			resolution: "1280x720",
		},
		{
			method: "Transcode",
			info: { IsVideoDirect: false, IsAudioDirect: false },
			video: undefined,
			audio: undefined,
			resolution: undefined,
		},
		{ method: "Unknown", info: {}, video: undefined, audio: undefined, resolution: undefined },
		{
			method: "DirectPlay",
			info: { IsVideoDirect: false, IsAudioDirect: false },
			video: undefined,
			audio: undefined,
			resolution: undefined,
		},
	] as const)("distinguishes source from encoded output for $method/$info", async (c) => {
		const client = await clientFor(
			payload({
				NowPlayingItem: item,
				PlayState: { PlayMethod: c.method, AudioStreamIndex: 7 },
				TranscodingInfo: c.info,
			}),
		);
		const [session] = await client.getSessions();
		expect(projectJellyfinSessionMeasurements(session!)).toMatchObject({
			videoCodec: c.video,
			audioCodec: c.audio,
			videoResolution: c.resolution,
			bandwidth: "Bitrate" in c.info ? 0 : undefined,
		});
	});
	it.each([false, true])(
		"honors provider-specific selection through the real factory (embedded source %s)",
		async (embedded) => {
			await clientFor(
				payload({
					NowPlayingItem: item,
					PlayState: {
						PlayMethod: "DirectPlay",
						AudioStreamIndex: 7,
						MediaSourceId: "active",
						...(embedded ? { MediaSource: active } : {}),
					},
				}),
			);
			const baseUrl = `http://127.0.0.1:${(servers.at(-1)!.address() as AddressInfo).port}`;
			const encryptor = new Encryptor(Buffer.alloc(32, 23).toString("base64"));
			const encrypted = encryptor.encrypt("synthetic-token");
			const app = Fastify({ logger: false });
			app.decorate("encryptor", encryptor);
			app.decorate("prisma", {
				serviceInstance: {
					findMany: async ({ where }: { where: unknown }) => {
						expect(where).toEqual({
							userId: "owner",
							service: { in: ["JELLYFIN", "EMBY"] },
							enabled: true,
						});
						return ["JELLYFIN", "EMBY"].map((service) => ({
							id: service,
							service,
							label: "Synthetic",
							baseUrl,
							encryptedApiKey: encrypted.value,
							encryptionIv: encrypted.iv,
						}));
					},
				},
			} as never);
			app.addHook("preHandler", async (request) => {
				request.currentUser = { id: "owner" } as never;
			});
			try {
				await app.register(registerNowPlayingRoutes);
				const response = await app.inject({ method: "GET", url: "/" });
				expect(response.statusCode).toBe(200);
				expect(response.json()).toMatchObject({
					sessions: [
						{
							instanceId: "JELLYFIN",
							videoCodec: "hevc",
							audioCodec: "eac3",
							videoResolution: "3840x2160",
						},
						{
							instanceId: "EMBY",
							...(embedded
								? { videoCodec: "hevc", audioCodec: "eac3", videoResolution: "3840x2160" }
								: {}),
						},
					],
					bandwidthCoverage: {
						status: "unavailable",
						measuredSessions: 0,
						observedSessions: 2,
						knownTotalKbps: null,
					},
				});
				if (!embedded) {
					const emby = response.json().sessions[1];
					expect(emby.videoCodec).toBeUndefined();
					expect(emby.audioCodec).toBeUndefined();
					expect(emby.videoResolution).toBeUndefined();
				}
			} finally {
				await app.close();
			}
		},
	);
	it.each([undefined, null, "1234", {}, -1])(
		"retains a usable session when bitrate %s is unknown",
		async (Bitrate) => {
			const client = await clientFor(
				payload({
					PlayState: { PlayMethod: "Transcode" },
					TranscodingInfo: { Bitrate, IsVideoDirect: false, IsAudioDirect: true },
				}),
			);
			const sessions = await client.getSessions();
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({
				id: "session-1",
				playMethod: "Transcode",
				transcodingInfo: { isVideoDirect: false, isAudioDirect: true },
			});
			expect(sessions[0]?.transcodingInfo?.bitrate).toBeUndefined();
		},
	);
	it("rejects nonfinite bitrate evidence while retaining its session over HTTP", async () => {
		const body = payload({ TranscodingInfo: { Bitrate: "NONFINITE", IsVideoDirect: false } });
		const client = await clientFor(body, 200, JSON.stringify(body).replace('"NONFINITE"', "1e400"));
		const sessions = await client.getSessions();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.transcodingInfo?.bitrate).toBeUndefined();
		expect(sessions[0]?.transcodingInfo?.isVideoDirect).toBe(false);
	});
	it.each([undefined, null, "invalid", [], 1])(
		"treats unusable TranscodingInfo %s as absent",
		async (TranscodingInfo) => {
			const client = await clientFor(
				payload({ PlayState: { PlayMethod: "DirectPlay" }, TranscodingInfo }),
			);
			const sessions = await client.getSessions();
			expect(sessions).toHaveLength(1);
			expect(sessions[0]?.playMethod).toBe("DirectPlay");
			expect(sessions[0]?.transcodingInfo).toBeUndefined();
		},
	);
	it.each([undefined, null, "true", 0, {}])(
		"leaves nonboolean directness %s undefined",
		async (flag) => {
			const client = await clientFor(
				payload({ TranscodingInfo: { IsVideoDirect: flag, IsAudioDirect: false, Bitrate: 0 } }),
			);
			const [session] = await client.getSessions();
			expect(session?.transcodingInfo?.isVideoDirect).toBeUndefined();
			expect(session?.transcodingInfo?.isAudioDirect).toBe(false);
			expect(session?.transcodingInfo?.bitrate).toBe(0);
		},
	);
	it.each([
		[undefined, undefined],
		[1920, undefined],
		[undefined, 1080],
		[null, 1080],
		["1920", 1080],
		[{}, 1080],
		[-1, 1080],
		[0, 1080],
		[1.5, 1080],
		[Number.MAX_SAFE_INTEGER + 1, 1080],
	])("requires a positive safe integer dimension pair (%s, %s)", async (Width, Height) => {
		const client = await clientFor(
			payload({ TranscodingInfo: { Width, Height, Bitrate: 0, IsVideoDirect: false } }),
		);
		const [session] = await client.getSessions();
		expect(session?.transcodingInfo?.width).toBeUndefined();
		expect(session?.transcodingInfo?.height).toBeUndefined();
		expect(session?.transcodingInfo?.bitrate).toBe(0);
		expect(session?.transcodingInfo?.isVideoDirect).toBe(false);
	});
	it.each([undefined, null, 1, {}, "", "   "])(
		"rejects malformed codec evidence %s independently",
		async (codec) => {
			const client = await clientFor(
				payload({
					TranscodingInfo: {
						AudioCodec: codec,
						VideoCodec: codec,
						Bitrate: 0,
						IsVideoDirect: false,
					},
				}),
			);
			const [session] = await client.getSessions();
			expect(session?.transcodingInfo?.audioCodec).toBeUndefined();
			expect(session?.transcodingInfo?.videoCodec).toBeUndefined();
			expect(session?.transcodingInfo?.bitrate).toBe(0);
			expect(session?.transcodingInfo?.isVideoDirect).toBe(false);
		},
	);
	it("preserves independently usable evidence despite malformed optional ancillary fields", async () => {
		const client = await clientFor(
			payload({
				TranscodingInfo: {
					Width: 1920,
					Height: 1080,
					Bitrate: 0,
					IsVideoDirect: false,
					AudioCodec: " aac ",
					VideoCodec: " h264 ",
					Container: {},
					CompletionPercentage: {},
				},
			}),
		);
		expect(await client.getSessions()).toEqual([
			expect.objectContaining({
				transcodingInfo: expect.objectContaining({
					width: 1920,
					height: 1080,
					bitrate: 0,
					isVideoDirect: false,
					audioCodec: "aac",
					videoCodec: "h264",
				}),
			}),
		]);
	});
	it.each([undefined, null, {}, 1])(
		"keeps malformed essential session identity %s unavailable",
		async (Id) => {
			const client = await clientFor(payload({ Id, TranscodingInfo: { Bitrate: null } }));
			await expect(client.getSessions()).rejects.toThrow(/validation failed/i);
		},
	);
	it("preserves absent directness, bitrate and playback method", async () => {
		const client = await clientFor(payload({ TranscodingInfo: {} }));
		const [session] = await client.getSessions();
		expect(session?.playMethod).toBeUndefined();
		expect(session?.transcodingInfo?.isVideoDirect).toBeUndefined();
		expect(session?.transcodingInfo?.isAudioDirect).toBeUndefined();
		expect(session?.transcodingInfo?.bitrate).toBeUndefined();
	});
	it("preserves null directness as absent", async () => {
		const client = await clientFor(
			payload({ TranscodingInfo: { IsVideoDirect: null, IsAudioDirect: null } }),
		);
		const [session] = await client.getSessions();
		expect(session?.transcodingInfo?.isVideoDirect).toBeUndefined();
		expect(session?.transcodingInfo?.isAudioDirect).toBeUndefined();
	});
	it("retains explicit false, true, zero bitrate and identity/position", async () => {
		const client = await clientFor(
			payload({
				PlayState: { PlayMethod: "Transcode", PositionTicks: 10_000, IsPaused: true },
				TranscodingInfo: { IsVideoDirect: false, IsAudioDirect: true, Bitrate: 0 },
			}),
		);
		expect(await client.getSessions()).toEqual([
			expect.objectContaining({
				id: "session-1",
				userId: "user-1",
				playMethod: "Transcode",
				positionMs: 1,
				durationMs: 2,
				isPaused: true,
				transcodingInfo: expect.objectContaining({
					isVideoDirect: false,
					isAudioDirect: true,
					bitrate: 0,
				}),
			}),
		]);
	});
	it.each([
		["provider error", payload(), 503],
		["malformed body", { Sessions: [] }, 200],
	] as const)("rejects %s instead of exposing an empty result", async (_name, body, status) => {
		const client = await clientFor(body, status);
		await expect(client.getSessions()).rejects.toThrow();
	});
});
