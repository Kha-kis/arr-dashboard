/**
 * Tracearr analytics routes (C2a): GET /tracearr/stats + /tracearr/activity.
 *
 * These back the Statistics "Tracearr" tab. Unlike the live-session aggregate,
 * they target a SINGLE instance via resolveTracearrInstance (caller-specified
 * or first enabled). Covers the stats bundle, the activity period passthrough,
 * the 404 when no instance exists, and instanceId forwarding.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveTracearrInstance } = vi.hoisted(() => ({
	mockResolveTracearrInstance: vi.fn(),
}));

vi.mock("../../lib/tracearr/instance-helpers.js", () => ({
	resolveTracearrInstance: (...args: unknown[]) => mockResolveTracearrInstance(...args),
	requireTracearrInstance: vi.fn(),
	listTracearrInstances: vi.fn().mockResolvedValue([]),
}));

const { mockGetStats, mockGetStatsToday, mockGetActivity } = vi.hoisted(() => ({
	mockGetStats: vi.fn(),
	mockGetStatsToday: vi.fn(),
	mockGetActivity: vi.fn(),
}));

vi.mock("../../lib/tracearr/client-factory.js", () => ({
	createTracearrClient: vi.fn(() => ({
		getStats: mockGetStats,
		getStatsToday: mockGetStatsToday,
		getActivity: mockGetActivity,
	})),
}));

import Fastify, { type FastifyInstance } from "fastify";
import { InstanceNotFoundError } from "../../lib/errors.js";
import { registerTracearrRoutes } from "../tracearr.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

function makeInstance(overrides: Record<string, unknown> = {}) {
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

let app: FastifyInstance;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

beforeEach(async () => {
	vi.clearAllMocks();
	mockResolveTracearrInstance.mockResolvedValue(makeInstance());
	mockGetStats.mockResolvedValue({
		activeStreams: 1,
		totalUsers: 5,
		totalSessions: 200,
		recentViolations: 2,
		timestamp: "2026-07-02T00:00:00.000Z",
	});
	mockGetStatsToday.mockResolvedValue({
		activeStreams: 1,
		todayPlays: 12,
		watchTimeHours: 8,
		alertsLast24h: 0,
		activeUsersToday: 3,
	});
	mockGetActivity.mockResolvedValue({
		period: "month",
		range: { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" },
		plays: [],
		concurrent: [],
		byDayOfWeek: [],
		byHourOfDay: [],
		platforms: [],
		quality: {
			directPlay: 0,
			directStream: 0,
			transcode: 0,
			total: 0,
			directPlayPercent: 0,
			directStreamPercent: 0,
			transcodePercent: 0,
		},
	});

	app = Fastify();
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

describe("GET /tracearr/stats", () => {
	it("bundles the all-time + today counters with the source instance", async () => {
		const res = await injectAuthenticated("GET", "/tracearr/stats");
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.instanceId).toBe("trr-1");
		expect(body.instanceLabel).toBe("Dev Tracearr");
		expect(body.stats.totalUsers).toBe(5);
		expect(body.today.todayPlays).toBe(12);
		expect(mockGetStats).toHaveBeenCalledTimes(1);
		expect(mockGetStatsToday).toHaveBeenCalledTimes(1);
	});

	it("returns 404 when the user has no Tracearr instance", async () => {
		mockResolveTracearrInstance.mockRejectedValue(new InstanceNotFoundError("tracearr"));
		const res = await injectAuthenticated("GET", "/tracearr/stats");
		expect(res.statusCode).toBe(404);
		expect(mockGetStats).not.toHaveBeenCalled();
	});

	it("forwards a caller-specified instanceId to the resolver", async () => {
		await injectAuthenticated("GET", "/tracearr/stats?instanceId=trr-2");
		expect(mockResolveTracearrInstance).toHaveBeenCalledWith(expect.anything(), "user-1", "trr-2");
	});
});

describe("GET /tracearr/activity", () => {
	it("returns the time-series for the requested period", async () => {
		const res = await injectAuthenticated("GET", "/tracearr/activity?period=week");
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.instanceId).toBe("trr-1");
		expect(body.activity).toBeDefined();
		expect(mockGetActivity).toHaveBeenCalledWith({ period: "week", timezone: undefined });
	});

	it("rejects an invalid period", async () => {
		const res = await injectAuthenticated("GET", "/tracearr/activity?period=decade");
		expect(res.statusCode).toBe(400);
		expect(mockGetActivity).not.toHaveBeenCalled();
	});
});
