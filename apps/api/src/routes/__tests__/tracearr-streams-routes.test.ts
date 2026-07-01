/**
 * Tracearr live-sessions aggregate route (Tracearr-2).
 *
 * Covers GET /api/tracearr/streams: the service-gated empty case, a single
 * reachable instance (summary passthrough incl. the formatted totalBitrate
 * string), graceful per-instance degradation when an instance is unreachable
 * (must NOT error the whole request or fake a zero), and multi-instance
 * aggregation (counts sum; totalBitrate drops to null when >1 reachable
 * because pre-formatted strings can't be summed).
 *
 * Same Fastify-inject harness as qui-routes.test.ts — real route plugin,
 * mocked instance-helpers + client.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockListTracearrInstances } = vi.hoisted(() => ({
	mockListTracearrInstances: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../lib/tracearr/instance-helpers.js", () => ({
	listTracearrInstances: (...args: unknown[]) => mockListTracearrInstances(...args),
	requireTracearrInstance: vi.fn(),
}));

const mockGetStreams = vi.hoisted(() => vi.fn());

vi.mock("../../lib/tracearr/client-factory.js", () => ({
	createTracearrClient: vi.fn(() => ({ getStreams: mockGetStreams })),
}));

import Fastify, { type FastifyInstance } from "fastify";
import { registerTracearrRoutes } from "../tracearr.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

function makeTracearrInstance(overrides: Record<string, unknown> = {}) {
	return {
		id: "trr-1",
		userId: "user-1",
		service: "TRACEARR",
		label: "Dev Tracearr",
		baseUrl: "http://tracearr.test",
		encryptedApiKey: "enc",
		encryptionIv: "iv",
		externalUrl: null,
		isDefault: false,
		enabled: true,
		storageGroupId: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

function summary(overrides: Record<string, unknown> = {}) {
	return {
		data: [],
		summary: {
			total: 0,
			transcodes: 0,
			directStreams: 0,
			directPlays: 0,
			totalBitrate: "—",
			byServer: [],
			...overrides,
		},
	};
}

let app: FastifyInstance;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

beforeEach(async () => {
	vi.clearAllMocks();
	mockListTracearrInstances.mockResolvedValue([]);

	app = Fastify();
	// The route resolves instances + builds the client through mocked helpers
	// (see vi.mock above), so it never touches prisma or the encryptor — a
	// bare prisma stub is enough and no encryptor decoration is needed.
	app.decorate("prisma", {} as never);
	setupAuthInjection(app);
	registerTestErrorHandler(app);

	await app.register(registerTracearrRoutes);
	await app.ready();

	injectAuthenticated = createInjectAuthenticated(app);
});

afterAll(async () => {
	await app?.close();
});

describe("GET /tracearr/streams", () => {
	it("reports not-configured when the user has no Tracearr instance", async () => {
		mockListTracearrInstances.mockResolvedValue([]);
		const res = await injectAuthenticated("GET", "/tracearr/streams");
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload)).toEqual({
			configured: false,
			instances: [],
			summary: null,
			sessions: [],
		});
		expect(mockGetStreams).not.toHaveBeenCalled();
	});

	it("passes through a single reachable instance's summary (incl. formatted bitrate)", async () => {
		mockListTracearrInstances.mockResolvedValue([makeTracearrInstance()]);
		mockGetStreams.mockResolvedValue(
			summary({
				total: 3,
				transcodes: 1,
				directStreams: 1,
				directPlays: 1,
				totalBitrate: "42.0 Mbps",
			}),
		);

		const res = await injectAuthenticated("GET", "/tracearr/streams");
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.configured).toBe(true);
		expect(body.instances).toEqual([{ id: "trr-1", label: "Dev Tracearr", reachable: true }]);
		expect(body.summary).toEqual({
			total: 3,
			transcodes: 1,
			directStreams: 1,
			directPlays: 1,
			totalBitrate: "42.0 Mbps",
		});
	});

	it("degrades gracefully when the only instance is unreachable (null summary, not a fake zero)", async () => {
		mockListTracearrInstances.mockResolvedValue([makeTracearrInstance()]);
		mockGetStreams.mockRejectedValue(new Error("ECONNREFUSED"));

		const res = await injectAuthenticated("GET", "/tracearr/streams");
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.configured).toBe(true);
		expect(body.summary).toBeNull();
		expect(body.instances).toEqual([{ id: "trr-1", label: "Dev Tracearr", reachable: false }]);
	});

	it("sums counts across two reachable instances and nulls the un-summable bitrate", async () => {
		mockListTracearrInstances.mockResolvedValue([
			makeTracearrInstance({ id: "trr-1", label: "A" }),
			makeTracearrInstance({ id: "trr-2", label: "B" }),
		]);
		mockGetStreams
			.mockResolvedValueOnce(
				summary({
					total: 2,
					transcodes: 1,
					directStreams: 1,
					directPlays: 0,
					totalBitrate: "10 Mbps",
				}),
			)
			.mockResolvedValueOnce(
				summary({
					total: 1,
					transcodes: 0,
					directStreams: 0,
					directPlays: 1,
					totalBitrate: "5 Mbps",
				}),
			);

		const res = await injectAuthenticated("GET", "/tracearr/streams");
		const body = JSON.parse(res.payload);
		expect(body.summary).toEqual({
			total: 3,
			transcodes: 1,
			directStreams: 1,
			directPlays: 1,
			// >1 reachable: formatted bitrate strings can't be summed → null.
			totalBitrate: null,
		});
		expect(body.instances).toHaveLength(2);
		expect(body.instances.every((i: { reachable: boolean }) => i.reachable)).toBe(true);
	});

	it("aggregates only the reachable instance when one of two is down", async () => {
		mockListTracearrInstances.mockResolvedValue([
			makeTracearrInstance({ id: "trr-1", label: "A" }),
			makeTracearrInstance({ id: "trr-2", label: "B" }),
		]);
		mockGetStreams
			.mockResolvedValueOnce(
				summary({
					total: 4,
					transcodes: 2,
					directStreams: 1,
					directPlays: 1,
					totalBitrate: "20 Mbps",
				}),
			)
			.mockRejectedValueOnce(new Error("timeout"));

		const res = await injectAuthenticated("GET", "/tracearr/streams");
		const body = JSON.parse(res.payload);
		// Exactly one reachable → its counts + its formatted bitrate pass through.
		expect(body.summary).toEqual({
			total: 4,
			transcodes: 2,
			directStreams: 1,
			directPlays: 1,
			totalBitrate: "20 Mbps",
		});
		expect(body.instances).toEqual([
			{ id: "trr-1", label: "A", reachable: true },
			{ id: "trr-2", label: "B", reachable: false },
		]);
	});

	it("flattens per-session rows tagged with their owning instance", async () => {
		mockListTracearrInstances.mockResolvedValue([
			makeTracearrInstance({ id: "trr-1", label: "A" }),
		]);
		mockGetStreams.mockResolvedValue({
			data: [
				{ id: "sess-1", username: "alice", mediaTitle: "Movie A", state: "playing" },
				{ id: "sess-2", username: "bob", mediaTitle: "Movie B", state: "paused" },
			],
			summary: {
				total: 2,
				transcodes: 0,
				directStreams: 2,
				directPlays: 0,
				totalBitrate: "—",
				byServer: [],
			},
		});

		const res = await injectAuthenticated("GET", "/tracearr/streams");
		const body = JSON.parse(res.payload);
		expect(body.sessions).toHaveLength(2);
		expect(body.sessions[0]).toMatchObject({
			id: "sess-1",
			instanceId: "trr-1",
			instanceLabel: "A",
			username: "alice",
			mediaTitle: "Movie A",
		});
		// A session from a dropped/unreachable instance never appears here.
		expect(body.sessions.every((s: { instanceId: string }) => s.instanceId === "trr-1")).toBe(true);
	});
});
