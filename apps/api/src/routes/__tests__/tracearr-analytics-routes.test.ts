/**
 * Tracearr analytics routes (C2a): GET /tracearr/stats + /tracearr/activity.
 *
 * These back the Statistics "Tracearr" tab. Unlike the live-session aggregate,
 * they target a SINGLE instance via resolveTracearrInstance (caller-specified
 * or first enabled). Covers the stats bundle, the activity period passthrough,
 * the 404 when no instance exists, and instanceId forwarding.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveTracearrInstance, mockCreateCurrentTautulliClient } = vi.hoisted(() => ({
	mockResolveTracearrInstance: vi.fn(),
	mockCreateCurrentTautulliClient: vi.fn(),
}));

vi.mock("../../lib/tracearr/instance-helpers.js", () => ({
	resolveTracearrInstance: (...args: unknown[]) => mockResolveTracearrInstance(...args),
	requireTracearrInstance: vi.fn(),
	listTracearrInstances: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../lib/tautulli/current-tautulli-client.js", () => ({
	createCurrentTautulliClient: (...args: unknown[]) => mockCreateCurrentTautulliClient(...args),
	isTautulliConnectionChanged: vi.fn(),
}));

const {
	mockCreateTracearrClient,
	mockGetStats,
	mockGetStatsToday,
	mockGetActivity,
	mockGetHistory,
	mockGetUsers,
	mockGetViolations,
} = vi.hoisted(() => ({
	mockCreateTracearrClient: vi.fn(),
	mockGetStats: vi.fn(),
	mockGetStatsToday: vi.fn(),
	mockGetActivity: vi.fn(),
	mockGetHistory: vi.fn(),
	mockGetUsers: vi.fn(),
	mockGetViolations: vi.fn(),
}));

vi.mock("../../lib/tracearr/client-factory.js", () => ({
	createTracearrClient: (...args: unknown[]) => mockCreateTracearrClient(...args),
}));

const emptyPage = { data: [], meta: { total: 0, page: 1, pageSize: 25 } };

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
let selectedProvider: "tracearr" | "tautulli";

beforeEach(async () => {
	vi.clearAllMocks();
	selectedProvider = "tracearr";
	mockResolveTracearrInstance.mockResolvedValue(makeInstance());
	mockCreateCurrentTautulliClient.mockReturnValue({
		client: {},
		ensureCurrent: vi.fn(),
	});
	mockCreateTracearrClient.mockReturnValue({
		getStats: mockGetStats,
		getStatsToday: mockGetStatsToday,
		getActivity: mockGetActivity,
		getHistory: mockGetHistory,
		getUsers: mockGetUsers,
		getViolations: mockGetViolations,
	});
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
	mockGetHistory.mockResolvedValue(emptyPage);
	mockGetUsers.mockResolvedValue(emptyPage);
	mockGetViolations.mockResolvedValue(emptyPage);

	app = Fastify();
	app.decorate("prisma", {
		$transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
			callback({
				systemSettings: {
					findUnique: vi.fn().mockResolvedValue({
						analyticsProvider: selectedProvider,
						analyticsProviderSource: "explicit",
					}),
				},
				serviceInstance: { count: vi.fn().mockResolvedValue(1) },
			}),
	} as never);
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

	it.each([
		"/tracearr/stats",
		"/tracearr/activity",
		"/tracearr/history",
		"/tracearr/users",
		"/tracearr/violations",
	])("rejects %s before resolving a Tracearr client when Tautulli is selected", async (path) => {
		selectedProvider = "tautulli";

		const response = await injectAuthenticated("GET", path);

		expect(response.statusCode).toBe(409);
		expect(JSON.parse(response.payload)).toEqual({
			error: "ANALYTICS_PROVIDER_NOT_SELECTED",
			expected: "tracearr",
			actual: "tautulli",
		});
		expect(mockResolveTracearrInstance).not.toHaveBeenCalled();
		expect(mockCreateTracearrClient).not.toHaveBeenCalled();
		expect(mockCreateCurrentTautulliClient).not.toHaveBeenCalled();
	});

	it("preserves a selected Tracearr outage without resolving another provider", async () => {
		mockGetStats.mockRejectedValueOnce(new Error("Tracearr unavailable"));

		const response = await injectAuthenticated("GET", "/tracearr/stats");

		expect(response.statusCode).toBe(500);
		expect(mockResolveTracearrInstance).toHaveBeenCalledTimes(1);
		expect(mockCreateTracearrClient).toHaveBeenCalledTimes(1);
		expect(mockCreateCurrentTautulliClient).not.toHaveBeenCalled();
		expect(mockGetStatsToday).toHaveBeenCalledTimes(1);
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

describe("GET /tracearr/history", () => {
	it("wraps the paginated history with the source instance", async () => {
		const res = await injectAuthenticated("GET", "/tracearr/history?page=2");
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.instanceId).toBe("trr-1");
		expect(body.history.meta).toBeDefined();
		expect(mockGetHistory).toHaveBeenCalledWith({
			page: 2,
			pageSize: undefined,
			mediaType: undefined,
		});
	});

	it("passes pageSize + mediaType filters through", async () => {
		await injectAuthenticated("GET", "/tracearr/history?page=1&pageSize=25&mediaType=movie");
		expect(mockGetHistory).toHaveBeenCalledWith({ page: 1, pageSize: 25, mediaType: "movie" });
	});
});

describe("GET /tracearr/users", () => {
	it("wraps the paginated users with the source instance", async () => {
		const res = await injectAuthenticated("GET", "/tracearr/users");
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload).users.meta).toBeDefined();
		expect(mockGetUsers).toHaveBeenCalledTimes(1);
	});
});

describe("GET /tracearr/violations", () => {
	it("forwards severity + acknowledged filters", async () => {
		await injectAuthenticated("GET", "/tracearr/violations?severity=high&acknowledged=false");
		// acknowledged=false must parse to boolean false, NOT true.
		expect(mockGetViolations).toHaveBeenCalledWith({
			page: undefined,
			pageSize: undefined,
			severity: "high",
			acknowledged: false,
		});
	});

	it("404s when no Tracearr instance exists", async () => {
		mockResolveTracearrInstance.mockRejectedValue(new InstanceNotFoundError("tracearr"));
		const res = await injectAuthenticated("GET", "/tracearr/violations");
		expect(res.statusCode).toBe(404);
		expect(mockGetViolations).not.toHaveBeenCalled();
	});
});
