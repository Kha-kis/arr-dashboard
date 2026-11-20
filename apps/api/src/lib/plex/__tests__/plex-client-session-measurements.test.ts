import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifySessionDecisions } from "../../../plugins/lib/session-snapshot-helpers.js";
import { buildPlexSessionSnapshot } from "../../../plugins/lib/session-snapshot-measurements.js";
import { computeQualityScore } from "../../../routes/plex/lib/quality-score-helpers.js";
import { aggregateUserAnalytics } from "../../../routes/plex/lib/user-analytics-helpers.js";
import { registerNowPlayingRoutes } from "../../../routes/plex/now-playing-routes.js";
import { Encryptor } from "../../auth/encryption.js";
import { PlexClient } from "../plex-client.js";

const servers: Server[] = [];
async function clientFor(body: unknown, status = 200, rawBody?: string) {
	const server = createServer((_request, response) => {
		response.writeHead(status, { "Content-Type": "application/json" });
		response.end(rawBody ?? JSON.stringify(body));
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return new PlexClient(
		`http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		"synthetic-token",
		{ warn: vi.fn() } as never,
	);
}
function payload(extra: Record<string, unknown> = {}) {
	return {
		MediaContainer: {
			Metadata: [{ sessionKey: "1", ratingKey: "2", title: "Synthetic", ...extra }],
		},
	};
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

describe("Plex native session measurements over HTTP", () => {
	it.each([
		["absent user", undefined],
		["null user", null],
		["nonobject user", "malformed"],
		["array user", []],
		["absent ID", { title: "Synthetic user" }],
		["null ID", { id: null, title: "Synthetic user" }],
		["empty ID", { id: "", title: "Synthetic user" }],
		["whitespace ID", { id: " \t", title: "Synthetic user" }],
		["boolean ID", { id: true, title: "Synthetic user" }],
		["object ID", { id: {}, title: "Synthetic user" }],
		["array ID", { id: [7], title: "Synthetic user" }],
		["negative number ID", { id: -1, title: "Synthetic user" }],
		["fractional number ID", { id: 1.5, title: "Synthetic user" }],
		["unsafe number ID", { id: 9_007_199_254_740_992, title: "Synthetic user" }],
	] as const)("retains measurements without fabricating identity for %s", async (_name, User) => {
		const client = await clientFor(
			payload({
				User,
				Session: { id: "native-1", bandwidth: 0 },
				Media: [{ videoResolution: "1080", Part: [{ decision: "directplay" }] }],
			}),
		);
		const sessions = await client.getSessions();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.user.id).toBeNull();
		const captured = buildPlexSessionSnapshot(sessions);
		expect(JSON.parse(captured.sessionsJson)[0]).toMatchObject({ userId: null, bandwidth: 0 });
		const rows = [
			{ ...captured, capturedAt: new Date("2025-01-15T10:00:00Z"), instanceId: "source-one" },
		];
		expect(aggregateUserAnalytics(rows)).toMatchObject({
			users: [],
			measurement: { observedSessions: 1, attributedSessions: 0, unattributedSessions: 1 },
		});
		expect(computeQualityScore(rows)).toMatchObject({
			overallScore: 93,
			perUser: [],
			measurement: { observedSessions: 1, scoredSessions: 1, unattributedSessions: 1 },
		});
	});
	it.each([
		["7", "7"],
		[7, "7"],
		[0, "0"],
		["0", "0"],
		["007", "007"],
		["9007199254740993", "9007199254740993"],
		["9007199254740992", "9007199254740992"],
		["opaque-native-id", "opaque-native-id"],
		[" native-id ", " native-id "],
	] as const)("preserves explicit native ID %s losslessly", async (id, expected) => {
		const client = await clientFor(
			payload({ User: { id, title: "Synthetic user" }, Session: { id: "native-1", bandwidth: 0 } }),
		);
		const sessions = await client.getSessions();
		expect(sessions[0]?.user.id).toBe(expected);
		const captured = buildPlexSessionSnapshot(sessions, {
			connectionGeneration: 0,
			identityGeneration: 0,
		});
		expect(JSON.parse(captured.sessionsJson)[0].userId).toBe(expected);
		expect(JSON.parse(captured.measurementJson).userIdentity).toBe("provider-native");
		expect(
			aggregateUserAnalytics([
				{ ...captured, capturedAt: new Date("2025-01-15T10:00:00Z"), instanceId: "source-one" },
			]),
		).toMatchObject({
			users: [{ username: "Synthetic user", totalSessions: 1, avgBandwidth: 0 }],
			measurement: { attributedSessions: 1, unattributedSessions: 0 },
		});
	});
	it("does not merge same-name exact IDs across HTTP capture and source-scoped analytics", async () => {
		const client = await clientFor({
			MediaContainer: {
				Metadata: ["7", "007", "9007199254740992", "9007199254740993"].map((id, index) => ({
					sessionKey: String(index),
					ratingKey: "2",
					User: { id, title: "Same label" },
					Session: { id: String(index), bandwidth: 0 },
				})),
			},
		});
		const captured = buildPlexSessionSnapshot(await client.getSessions(), {
			connectionGeneration: 0,
			identityGeneration: 0,
		});
		const result = aggregateUserAnalytics(
			["one", "two"].map((instanceId) => ({
				...captured,
				capturedAt: new Date("2025-01-15T10:00:00Z"),
				instanceId,
			})),
		);
		expect(result.users).toHaveLength(8);
		expect(new Set(result.users.map((user) => user.key)).size).toBe(8);
		expect(result.users.every((user) => user.totalSessions === 1 && user.avgBandwidth === 0)).toBe(
			true,
		);
		expect(result.measurement).toMatchObject({
			observedSessions: 8,
			attributedSessions: 8,
			unattributedSessions: 0,
		});
	});
	it("retains native IDs without attributing a snapshot whose source generations were not captured", async () => {
		const client = await clientFor(
			payload({
				User: { id: "007", title: "Synthetic user" },
				Session: { id: "native-1", bandwidth: 0 },
			}),
		);
		const captured = buildPlexSessionSnapshot(await client.getSessions());
		expect(JSON.parse(captured.sessionsJson)[0].userId).toBe("007");
		expect(JSON.parse(captured.measurementJson).userIdentity).toBe("provider-native");
		expect(JSON.parse(captured.measurementJson)).not.toHaveProperty("sourceScope");
		expect(
			aggregateUserAnalytics([
				{ ...captured, capturedAt: new Date("2025-01-15T10:00:00Z"), instanceId: "source-one" },
			]),
		).toMatchObject({
			users: [],
			measurement: { observedSessions: 1, attributedSessions: 0, unattributedSessions: 1 },
		});
	});
	it.each(["0", "7", "007", "9007199254740993"])(
		"does not certify historically coerced Plex ID %s but retains its measurements",
		async (id) => {
			const client = await clientFor(
				payload({
					User: { id, title: "Synthetic user" },
					Session: { id: "native-1", bandwidth: 0 },
					Media: [{ videoResolution: "1080", Part: [{ decision: "directplay" }] }],
				}),
			);
			const captured = buildPlexSessionSnapshot(await client.getSessions());
			const receipt = JSON.parse(captured.measurementJson);
			delete receipt.userIdentity;
			const rows = [
				{
					...captured,
					measurementJson: JSON.stringify(receipt),
					capturedAt: new Date("2025-01-15T10:00:00Z"),
					instanceId: "source-one",
				},
			];
			expect(aggregateUserAnalytics(rows)).toMatchObject({
				users: [],
				measurement: { observedSessions: 1, attributedSessions: 0, unattributedSessions: 1 },
			});
			expect(computeQualityScore(rows)).toMatchObject({
				overallScore: 93,
				perUser: [],
				measurement: { scoredSessions: 1, unattributedSessions: 1 },
			});
		},
	);
	it.each([undefined, null, 23, {}])(
		"retains a genuine ID when optional display metadata is malformed (%s)",
		async (title) => {
			const client = await clientFor(payload({ User: { id: "007", title, thumb: {} } }));
			expect((await client.getSessions())[0]?.user).toEqual({
				id: "007",
				title: "",
				thumb: undefined,
			});
		},
	);
	it("transports exact and unknown identities through the actual now-playing route and factory", async () => {
		await clientFor({
			MediaContainer: {
				Metadata: [
					{
						sessionKey: "one",
						ratingKey: "item",
						User: { id: "9007199254740993", title: "Synthetic viewer" },
						Session: { id: "one", bandwidth: 0 },
					},
					{
						sessionKey: "two",
						ratingKey: "item",
						User: { id: null, title: "Synthetic viewer" },
						Session: { id: "two", bandwidth: 0 },
					},
				],
			},
		});
		const encryptor = new Encryptor(Buffer.alloc(32, 23).toString("base64"));
		const encrypted = encryptor.encrypt("synthetic-token");
		const app = Fastify({ logger: false });
		app.decorate("encryptor", encryptor);
		app.decorate("prisma", {
			serviceInstance: {
				findMany: async ({ where }: { where: unknown }) => {
					expect(where).toEqual({ userId: "owner", service: "PLEX", enabled: true });
					return [
						{
							id: "source-one",
							label: "Synthetic source",
							baseUrl: `http://127.0.0.1:${(servers.at(-1)!.address() as AddressInfo).port}`,
							encryptedApiKey: encrypted.value,
							encryptionIv: encrypted.iv,
						},
					];
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
					{ user: { id: "9007199254740993" }, bandwidth: 0 },
					{ user: { id: null }, bandwidth: 0 },
				],
				availability: { status: "complete", configuredSources: 1, availableSources: 1 },
				bandwidthCoverage: {
					status: "complete",
					observedSessions: 2,
					measuredSessions: 2,
					knownTotalKbps: 0,
				},
			});
		} finally {
			await app.close();
		}
	});
	it.each([undefined, null, "1234", {}, -1])(
		"retains a usable session when bandwidth %s is unknown",
		async (bandwidth) => {
			const client = await clientFor(
				payload({
					Session: { id: "native-1", bandwidth },
					TranscodeSession: { videoDecision: "copy", audioDecision: "directplay" },
				}),
			);
			const sessions = await client.getSessions();
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({
				sessionKey: "1",
				videoDecision: "copy",
				audioDecision: "direct play",
			});
			expect(sessions[0]?.bandwidth).toBeUndefined();
		},
	);
	it("rejects nonfinite bandwidth evidence while retaining its session over HTTP", async () => {
		const body = payload({ Session: { id: "native-1", bandwidth: "NONFINITE" } });
		const client = await clientFor(body, 200, JSON.stringify(body).replace('"NONFINITE"', "1e400"));
		const sessions = await client.getSessions();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.bandwidth).toBeUndefined();
	});
	it.each([0, 1234, 0.5])("retains finite nonnegative bandwidth %s", async (bandwidth) => {
		const client = await clientFor(payload({ Session: { id: "native-1", bandwidth } }));
		expect(await client.getSessions()).toEqual([expect.objectContaining({ bandwidth })]);
	});
	it.each([null, "malformed"])("keeps malformed session-list row %s unavailable", async (row) => {
		const client = await clientFor({ MediaContainer: { size: 1, Metadata: [row] } });
		await expect(client.getSessions()).rejects.toThrow(/validation failed/i);
	});
	it.each([
		["positive size without Metadata", { size: 1 }],
		["unknown list without Metadata or size", {}],
		["positive size with empty Metadata", { size: 1, Metadata: [] }],
		[
			"declared size larger than array",
			{ size: 2, Metadata: [{ sessionKey: "1", ratingKey: "1" }] },
		],
		["declared zero with a session", { size: 0, Metadata: [{ sessionKey: "1", ratingKey: "1" }] }],
	] as const)("rejects unverified session-list evidence: %s", async (_name, MediaContainer) => {
		const client = await clientFor({ MediaContainer });
		await expect(client.getSessions()).rejects.toThrow(/validation failed/i);
	});
	it.each([
		["explicit empty Metadata and zero", { size: 0, Metadata: [] }],
		["explicit empty Metadata without size", { Metadata: [] }],
		["explicit zero without Metadata", { size: 0 }],
	] as const)("accepts verified empty session-list evidence: %s", async (_name, MediaContainer) => {
		const client = await clientFor({ MediaContainer });
		await expect(client.getSessions()).resolves.toEqual([]);
	});
	it("accepts a declared size matching the explicit session array", async () => {
		const client = await clientFor({
			MediaContainer: {
				size: 1,
				Metadata: [{ sessionKey: "1", ratingKey: "1" }],
			},
		});
		expect(await client.getSessions()).toEqual([
			expect.objectContaining({ sessionKey: "1", ratingKey: "1" }),
		]);
	});
	it("classifies actual native client sessions into known and unknown caller buckets", async () => {
		const client = await clientFor({
			MediaContainer: {
				Metadata: [
					{ sessionKey: "1", ratingKey: "1", Media: [{ Part: [{ decision: "directplay" }] }] },
					{ sessionKey: "2", ratingKey: "2", TranscodeSession: { videoDecision: "copy" } },
					{ sessionKey: "3", ratingKey: "3", TranscodeSession: { videoDecision: "Transcode" } },
					{ sessionKey: "4", ratingKey: "4" },
				],
			},
		});
		expect(classifySessionDecisions(await client.getSessions())).toMatchObject({
			directPlayCount: 1,
			directStreamCount: 1,
			transcodeCount: 1,
			unknownDecisionCount: 1,
		});
	});
	it("keeps absent decisions and measurements unknown", async () => {
		const client = await clientFor(payload());
		const [session] = await client.getSessions();
		expect(session).toMatchObject({ videoDecision: "unknown", audioDecision: "unknown" });
		expect(session?.bandwidth).toBeUndefined();
		expect(session?.videoCodec).toBeUndefined();
		expect(session?.videoResolution).toBeUndefined();
	});
	it("retains explicit Part DirectPlay, codecs, dimensions, identity and zero bandwidth", async () => {
		const client = await clientFor(
			payload({
				User: { id: "7", title: "Synthetic user" },
				Player: { title: "Synthetic player", state: "playing" },
				Session: { id: "native-1", bandwidth: 0 },
				Media: [
					{
						videoCodec: "h264",
						audioCodec: "aac",
						width: 1920,
						height: 1080,
						Part: [{ decision: "directplay" }],
					},
				],
			}),
		);
		expect(await client.getSessions()).toEqual([
			expect.objectContaining({
				sessionKey: "1",
				ratingKey: "2",
				bandwidth: 0,
				videoDecision: "direct play",
				audioDecision: "direct play",
				videoCodec: "h264",
				audioCodec: "aac",
				videoResolution: "1920x1080",
				user: { id: "7", title: "Synthetic user", thumb: undefined },
			}),
		]);
	});
	it("rejects malformed measurement evidence without discarding the session", async () => {
		const client = await clientFor(
			payload({
				TranscodeSession: { videoDecision: 3, audioDecision: "copy", audioCodec: {} },
				Media: { unrelated: true },
			}),
		);
		expect(await client.getSessions()).toEqual([
			expect.objectContaining({ sessionKey: "1", videoDecision: "unknown", audioDecision: "copy" }),
		]);
	});
	it.each([
		["provider error", payload(), 503],
		["malformed body", { MediaContainer: { Metadata: {} } }, 200],
	] as const)("rejects %s instead of exposing an empty result", async (_name, body, status) => {
		const client = await clientFor(body, status);
		await expect(client.getSessions()).rejects.toThrow();
	});
});
