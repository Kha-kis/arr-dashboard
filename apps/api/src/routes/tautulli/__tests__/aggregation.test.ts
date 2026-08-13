import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateTautulliClient, mockRefreshTautulliCache } = vi.hoisted(() => ({
	mockCreateTautulliClient: vi.fn(),
	mockRefreshTautulliCache: vi.fn(),
}));

vi.mock("../../../lib/tautulli/tautulli-client.js", () => ({
	createTautulliClient: (...args: unknown[]) => mockCreateTautulliClient(...args),
	MAX_TAUTULLI_HISTORY_PAGE_LENGTH: 500,
}));

vi.mock("../../../lib/tautulli/tautulli-cache-refresher.js", () => ({
	refreshTautulliCache: (...args: unknown[]) => mockRefreshTautulliCache(...args),
}));

import { providerConnectionIdentity } from "../../../lib/services/provider-connection-guard.js";
import { registerTautulliRoutes } from "../index.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";

const instanceOne = {
	id: "tautulli-one",
	userId: "user-1",
	service: "TAUTULLI",
	label: "Family Tautulli",
	baseUrl: "http://tautulli-one.test",
	encryptedApiKey: "encrypted",
	encryptionIv: "iv",
	enabled: true,
	connectionGeneration: 4,
};

const instanceTwo = { ...instanceOne, id: "tautulli-two", label: "Guest Tautulli" };

function makeClient(overrides: Record<string, unknown> = {}) {
	return {
		getActivity: vi.fn().mockResolvedValue({
			sessions: [
				{
					session_key: "session-1",
					rating_key: "42",
					title: "A Sensitive Title",
					grandparent_title: "A Sensitive Show",
					media_type: "episode",
					user: "private-user",
					friendly_name: "Private User",
					player: "Chrome",
					platform: "Web",
					product: "Plex Web",
					state: "playing",
					progress_percent: "50",
					transcode_decision: "direct play",
					stream_video_decision: "direct play",
					stream_audio_decision: "direct play",
					video_resolution: "1080",
					audio_codec: "aac",
					video_codec: "h264",
					bandwidth: "4000",
					location: "lan",
				},
			],
			stream_count: "1",
			total_bandwidth: 4000,
			lan_bandwidth: 4000,
			wan_bandwidth: 0,
		}),
		getHistory: vi.fn().mockResolvedValue({
			data: [
				{
					row_id: 2,
					rating_key: "42",
					parent_rating_key: "41",
					grandparent_rating_key: "40",
					title: "Newer Sensitive Title",
					grandparent_title: "Sensitive Show",
					media_type: "episode",
					user: "private-user",
					date: 2_000,
				},
				{
					row_id: 1,
					rating_key: "40",
					parent_rating_key: "",
					grandparent_rating_key: "",
					title: "Older Sensitive Title",
					grandparent_title: "",
					media_type: "movie",
					user: "private-user",
					date: 1_000,
				},
			],
			recordsFiltered: 2,
			recordsTotal: 2,
		}),
		getHistoryPage: vi.fn().mockResolvedValue({
			data: [
				{
					row_id: 2,
					rating_key: "42",
					parent_rating_key: "41",
					grandparent_rating_key: "40",
					title: "Newer Sensitive Title",
					grandparent_title: "Sensitive Show",
					media_type: "episode",
					user: "private-user",
					date: 2_000,
				},
				{
					row_id: 1,
					rating_key: "40",
					parent_rating_key: "",
					grandparent_rating_key: "",
					title: "Older Sensitive Title",
					grandparent_title: "",
					media_type: "movie",
					user: "private-user",
					date: 1_000,
				},
			],
			recordsFiltered: 2,
			recordsTotal: 2,
		}),
		getHistoryNewestPage: vi.fn().mockResolvedValue({
			data: [
				{
					row_id: 2,
					rating_key: "42",
					parent_rating_key: "41",
					grandparent_rating_key: "40",
					title: "Newer Sensitive Title",
					grandparent_title: "Sensitive Show",
					media_type: "episode",
					user: "private-user",
					date: 2_000,
				},
				{
					row_id: 1,
					rating_key: "40",
					parent_rating_key: "",
					grandparent_rating_key: "",
					title: "Older Sensitive Title",
					grandparent_title: "",
					media_type: "movie",
					user: "private-user",
					date: 1_000,
				},
			],
			recordsFiltered: 2,
			recordsTotal: 2,
		}),
		getHomeStats: vi.fn().mockResolvedValue([
			{
				stat_id: "top_movies",
				stat_title: "Top Movies",
				rows: [{ title: "A Sensitive Title", total_plays: 2, total_duration: 100 }],
			},
		]),
		getUsers: vi.fn().mockResolvedValue([{ user_id: "provider-user-1", username: "Private User" }]),
		getUserWatchTimeStats: vi
			.fn()
			.mockImplementation((_userId: string, timeRange: number) =>
				Promise.resolve([{ query_days: timeRange, total_plays: 2, total_time: 100 }]),
			),
		getPlaysByDate: vi.fn().mockResolvedValue({
			categories: ["2026-08-10"],
			series: [{ name: "Movies", data: [2] }],
		}),
		...overrides,
	};
}

function pagedHistory(instanceName: string, totalCount: number, firstDate: number, step = 1) {
	return vi.fn(({ start, length }: { start: number; length: number }) => ({
		data: Array.from({ length: Math.max(0, Math.min(length, totalCount - start)) }, (_, index) => {
			const row = start + index;
			return {
				row_id: row + 1,
				rating_key: `${instanceName}-${row}`,
				parent_rating_key: "",
				grandparent_rating_key: "",
				title: `${instanceName} ${row}`,
				grandparent_title: "",
				media_type: "movie",
				user: instanceName,
				date: firstDate - row * step,
			};
		}),
		recordsFiltered: totalCount,
		recordsTotal: totalCount,
	}));
}

let app: FastifyInstance;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;
let prisma: any;

beforeEach(async () => {
	vi.clearAllMocks();
	prisma = {
		serviceInstance: {
			findMany: vi.fn().mockResolvedValue([instanceOne]),
			findFirst: vi.fn().mockResolvedValue(instanceOne),
		},
		tautulliCache: { count: vi.fn().mockResolvedValue(3) },
		cacheRefreshStatus: {
			findUnique: vi.fn().mockResolvedValue({
				instanceId: instanceOne.id,
				cacheType: "tautulli",
				lastRefreshedAt: new Date("2026-08-12T00:00:00.000Z"),
				lastResult: "success",
				lastErrorMessage: null,
				itemCount: 3,
				lastAttemptAt: null,
				lastAttemptResult: null,
				lastAttemptErrorMessage: null,
			}),
			findMany: vi.fn().mockResolvedValue([]),
		},
	};
	mockCreateTautulliClient.mockImplementation((_encryptor, instance) =>
		makeClient(
			instance.id === instanceTwo.id
				? {
						getHomeStats: vi.fn().mockResolvedValue([
							{
								stat_id: "top_movies",
								stat_title: "Top Movies",
								rows: [{ title: "A Sensitive Title", total_plays: 3, total_duration: 150 }],
							},
						]),
						getUsers: vi
							.fn()
							.mockResolvedValue([{ user_id: "provider-user-2", username: "Guest User" }]),
						getUserWatchTimeStats: vi
							.fn()
							.mockImplementation((_userId: string, timeRange: number) =>
								Promise.resolve([{ query_days: timeRange, total_plays: 3, total_time: 150 }]),
							),
					}
				: {},
		),
	);
	mockRefreshTautulliCache.mockResolvedValue({
		complete: true,
		completedAt: new Date("2026-08-12T00:01:00.000Z"),
		upserted: 3,
		errors: 0,
		errorMessages: [],
	});

	app = Fastify();
	app.decorate("prisma", prisma as never);
	app.decorate("encryptor", {} as never);
	setupAuthInjection(app);
	registerTestErrorHandler(app);
	await app.register(registerTautulliRoutes, { prefix: "/api/tautulli" });
	await app.ready();
	injectAuthenticated = createInjectAuthenticated(app);
});

afterAll(async () => {
	await app?.close();
});

describe("Tautulli provider routes", () => {
	it("returns Tautulli-scoped activity with separately typed sensitive source fields", async () => {
		const response = await injectAuthenticated("GET", "/api/tautulli/activity");
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.payload);
		expect(body.provider).toBe("tautulli");
		expect(body.sources[0].sessions[0]).toMatchObject({
			title: "A Sensitive Title",
			user: "Private User",
			instanceId: "tautulli-one",
			instanceLabel: "Family Tautulli",
		});
		expect(body.sources[0]).toMatchObject({
			instanceId: "tautulli-one",
			instanceLabel: "Family Tautulli",
			reachable: true,
		});
		expect(prisma.serviceInstance.findMany).toHaveBeenCalledWith({
			where: { userId: "user-1", service: "TAUTULLI", enabled: true },
			orderBy: { label: "asc" },
		});
	});

	it("does not return activity fetched from a connection that changed before response", async () => {
		prisma.serviceInstance.findFirst.mockResolvedValue({
			...instanceOne,
			connectionGeneration: instanceOne.connectionGeneration + 1,
		});

		const response = await injectAuthenticated("GET", "/api/tautulli/activity");

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload).sources).toEqual([
			expect.objectContaining({
				instanceId: "tautulli-one",
				reachable: false,
				incompleteReason: "connection_changed",
				sessions: [],
			}),
		]);
	});

	it("keeps statistics scoped to each enabled Tautulli instance", async () => {
		prisma.serviceInstance.findMany.mockResolvedValue([instanceOne, instanceTwo]);
		const response = await injectAuthenticated("GET", "/api/tautulli/stats?timeRange=14");
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.payload);
		expect(body.provider).toBe("tautulli");
		expect(body.sources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					instanceId: "tautulli-one",
					homeStats: [
						expect.objectContaining({
							rows: [expect.objectContaining({ total_plays: 2, total_duration: 100 })],
						}),
					],
					userStats: [
						expect.objectContaining({
							userId: "provider-user-1",
							friendlyName: "Private User",
							totalPlays: 2,
						}),
					],
					userStatsComplete: true,
					failedUserCount: 0,
				}),
				expect.objectContaining({
					instanceId: "tautulli-two",
					homeStats: [
						expect.objectContaining({
							rows: [expect.objectContaining({ total_plays: 3, total_duration: 150 })],
						}),
					],
					userStats: [
						expect.objectContaining({
							userId: "provider-user-2",
							friendlyName: "Guest User",
							totalPlays: 3,
						}),
					],
				}),
			]),
		);
		expect(body).not.toHaveProperty("homeStats");
		expect(body).not.toHaveProperty("userStats");
	});

	it("preserves home rankings per source instead of claiming a truncated global aggregate", async () => {
		prisma.serviceInstance.findMany.mockResolvedValue([instanceOne, instanceTwo]);
		mockCreateTautulliClient.mockImplementation((_encryptor, instance) =>
			makeClient({
				getHomeStats: vi.fn().mockResolvedValue([
					{
						stat_id: "top_platforms",
						stat_title: "Most Active Platforms",
						rows: [
							{
								platform: instance.id === instanceOne.id ? "Chrome" : "Android",
								total_plays: instance.id === instanceOne.id ? 2 : 3,
								total_duration: 100,
							},
						],
					},
				]),
			}),
		);

		const response = await injectAuthenticated("GET", "/api/tautulli/stats?timeRange=14");
		const body = JSON.parse(response.payload);

		expect(body).not.toHaveProperty("homeStats");
		expect(body.sources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					instanceId: "tautulli-one",
					homeStats: [
						expect.objectContaining({
							rows: [expect.objectContaining({ platform: "Chrome", total_plays: 2 })],
						}),
					],
				}),
				expect.objectContaining({
					instanceId: "tautulli-two",
					homeStats: [
						expect.objectContaining({
							rows: [expect.objectContaining({ platform: "Android", total_plays: 3 })],
						}),
					],
				}),
			]),
		);
	});

	it("preserves an instance's home stats when one documented per-user watch-time request is malformed or fails", async () => {
		const client = makeClient({
			getUsers: vi.fn().mockResolvedValue([
				{ user_id: "provider-user-1", username: "Private User" },
				{ user_id: "provider-user-2", username: "Unavailable User" },
			]),
			getUserWatchTimeStats: vi.fn(async (userId: string, timeRange: number) => {
				if (userId === "provider-user-2") throw new Error("upstream user totals malformed");
				return [{ query_days: timeRange, total_plays: 2, total_time: 100 }];
			}),
		});
		mockCreateTautulliClient.mockReturnValue(client);

		const response = await injectAuthenticated("GET", "/api/tautulli/stats?timeRange=14");

		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.payload);
		expect(body.sources[0]).toMatchObject({
			instanceId: "tautulli-one",
			instanceLabel: "Family Tautulli",
			reachable: true,
			userStatsComplete: false,
			failedUserCount: 1,
			incompleteReason: "user_stats_partial",
		});
		expect(body.sources[0].homeStats).toEqual([
			expect.objectContaining({
				stat_id: "top_movies",
				rows: [expect.objectContaining({ total_plays: 2 })],
			}),
		]);
		expect(body.sources[0].userStats).toEqual([
			expect.objectContaining({
				userId: "provider-user-1",
				friendlyName: "Private User",
				totalPlays: 2,
				totalDuration: 100,
				instanceId: "tautulli-one",
			}),
		]);
		expect(client.getUserWatchTimeStats).toHaveBeenCalledWith("provider-user-1", 14);
		expect(client.getUserWatchTimeStats).toHaveBeenCalledWith("provider-user-2", 14);
	});

	it("keeps reachable home stats but marks user statistics incomplete when the user list is unavailable", async () => {
		const client = makeClient({
			getUsers: vi.fn().mockRejectedValue(new Error("private upstream detail")),
		});
		mockCreateTautulliClient.mockReturnValue(client);

		const response = await injectAuthenticated("GET", "/api/tautulli/stats?timeRange=14");

		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.payload);
		expect(body.sources[0].homeStats).toEqual([
			expect.objectContaining({
				stat_id: "top_movies",
				rows: [expect.objectContaining({ total_plays: 2 })],
			}),
		]);
		expect(body.sources[0].userStats).toEqual([]);
		expect(body.sources[0]).toMatchObject({
			instanceId: "tautulli-one",
			instanceLabel: "Family Tautulli",
			reachable: true,
			userStatsComplete: false,
			failedUserCount: 0,
			incompleteReason: "user_list_unavailable",
		});
	});

	it("bounds watch-time requests across instances while preserving source-correct users around an isolated failure", async () => {
		const pending = new Map<
			string,
			{ reject: (reason: Error) => void; resolve: (value: Array<Record<string, number>>) => void }
		>();
		let inFlight = 0;
		let maxInFlight = 0;
		const deferredWatchTime = vi.fn((userId: string) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			return new Promise((resolve, reject) => {
				pending.set(userId, {
					resolve: (value) => {
						inFlight--;
						resolve(value);
					},
					reject: (reason) => {
						inFlight--;
						reject(reason);
					},
				});
			});
		});
		const firstClient = makeClient({
			getUsers: vi.fn().mockResolvedValue(
				Array.from({ length: 3 }, (_, index) => ({
					user_id: `first-user-${index + 1}`,
					username: `First User ${index + 1}`,
				})),
			),
			getUserWatchTimeStats: deferredWatchTime,
		});
		const secondClient = makeClient({
			getUsers: vi.fn().mockResolvedValue(
				Array.from({ length: 3 }, (_, index) => ({
					user_id: `second-user-${index + 1}`,
					username: `Second User ${index + 1}`,
				})),
			),
			getUserWatchTimeStats: deferredWatchTime,
		});
		prisma.serviceInstance.findMany.mockResolvedValue([instanceOne, instanceTwo]);
		mockCreateTautulliClient.mockImplementation((_encryptor, instance) =>
			instance.id === instanceOne.id ? firstClient : secondClient,
		);

		const responsePromise = injectAuthenticated("GET", "/api/tautulli/stats?timeRange=14");

		await vi.waitFor(() => expect(deferredWatchTime).toHaveBeenCalledTimes(4));
		expect(maxInFlight).toBeLessThanOrEqual(4);
		expect(deferredWatchTime.mock.calls.map(([userId]) => userId)).toEqual([
			"first-user-1",
			"first-user-2",
			"first-user-3",
			"second-user-1",
		]);

		pending.get("first-user-1")!.resolve([{ query_days: 14, total_plays: 1, total_time: 100 }]);
		await vi.waitFor(() => expect(deferredWatchTime).toHaveBeenCalledTimes(5));
		pending.get("first-user-2")!.reject(new Error("one user failed"));
		await vi.waitFor(() => expect(deferredWatchTime).toHaveBeenCalledTimes(6));
		for (const userId of ["first-user-3", "second-user-1", "second-user-2", "second-user-3"]) {
			pending.get(userId)!.resolve([{ query_days: 14, total_plays: 1, total_time: 100 }]);
		}

		const response = await responsePromise;

		expect(response.statusCode).toBe(200);
		expect(maxInFlight).toBeLessThanOrEqual(4);
		const sources = JSON.parse(response.payload).sources;
		expect(sources.flatMap((source: { userStats: unknown[] }) => source.userStats)).toEqual([
			expect.objectContaining({
				userId: "first-user-1",
				instanceId: "tautulli-one",
				instanceLabel: "Family Tautulli",
			}),
			expect.objectContaining({
				userId: "first-user-3",
				instanceId: "tautulli-one",
				instanceLabel: "Family Tautulli",
			}),
			expect.objectContaining({
				userId: "second-user-1",
				instanceId: "tautulli-two",
				instanceLabel: "Guest Tautulli",
			}),
			expect.objectContaining({
				userId: "second-user-2",
				instanceId: "tautulli-two",
				instanceLabel: "Guest Tautulli",
			}),
			expect.objectContaining({
				userId: "second-user-3",
				instanceId: "tautulli-two",
				instanceLabel: "Guest Tautulli",
			}),
		]);
	});

	it("keeps paginated history total and completeness visible", async () => {
		const response = await injectAuthenticated("GET", "/api/tautulli/history?offset=1&limit=1");
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.payload);
		expect(body.sources[0].history).toHaveLength(1);
		expect(body.sources[0].history[0].title).toBe("Older Sensitive Title");
		expect(body.pagination).toMatchObject({ offset: 1, limit: 1, complete: true });
		expect(body.sources).toEqual([
			{
				instanceId: "tautulli-one",
				instanceLabel: "Family Tautulli",
				totalCount: 2,
				history: [expect.objectContaining({ title: "Older Sensitive Title" })],
				complete: true,
			},
		]);
	});

	it("uses the newest-first typed history page helper when the requested page exceeds Tautulli's default size", async () => {
		const client = makeClient();
		mockCreateTautulliClient.mockReturnValue(client);

		const response = await injectAuthenticated("GET", "/api/tautulli/history?offset=25&limit=1");

		expect(response.statusCode).toBe(200);
		expect(client.getHistoryNewestPage).toHaveBeenCalledWith({ start: 0, length: 26 });
		expect(client.getHistoryPage).not.toHaveBeenCalled();
		expect(client.getHistory).not.toHaveBeenCalled();
	});

	it("retrieves a single instance's requested history prefix beyond 500 records in bounded pages", async () => {
		const getHistoryNewestPage = pagedHistory("Single", 600, 2_000_000);
		const client = makeClient({ getHistoryNewestPage });
		mockCreateTautulliClient.mockReturnValue(client);

		const response = await injectAuthenticated("GET", "/api/tautulli/history?offset=500&limit=1");

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload).sources[0].history).toEqual([
			expect.objectContaining({ title: "Single 500" }),
		]);
		expect(getHistoryNewestPage).toHaveBeenNthCalledWith(1, { start: 0, length: 500 });
		expect(getHistoryNewestPage).toHaveBeenNthCalledWith(2, { start: 500, length: 1 });
	});

	it("marks a deep source page incomplete when totals drift between upstream pages", async () => {
		const getHistoryNewestPage = vi
			.fn()
			.mockResolvedValueOnce({
				data: Array.from({ length: 500 }, (_, index) => ({
					row_id: 600 - index,
					rating_key: String(index),
					parent_rating_key: "",
					grandparent_rating_key: "",
					title: `Item ${index}`,
					grandparent_title: "",
					media_type: "movie",
					user: "one",
					date: 2_000 - index,
				})),
				recordsFiltered: 600,
				recordsTotal: 600,
			})
			.mockResolvedValueOnce({ data: [], recordsFiltered: 601, recordsTotal: 601 });
		mockCreateTautulliClient.mockReturnValue(makeClient({ getHistoryNewestPage }));

		const response = await injectAuthenticated("GET", "/api/tautulli/history?offset=500&limit=1");

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload).sources[0]).toMatchObject({
			complete: false,
			incompleteReason: "upstream_total_changed",
		});
	});

	it("marks a source incomplete when a page returns more rows than its declared total", async () => {
		mockCreateTautulliClient.mockReturnValue(
			makeClient({
				getHistoryNewestPage: vi.fn().mockResolvedValue({
					data: [
						{
							row_id: 1,
							rating_key: "1",
							parent_rating_key: "",
							grandparent_rating_key: "",
							title: "Contradictory row",
							grandparent_title: "",
							media_type: "movie",
							user: "one",
							date: 2_000,
						},
					],
					recordsFiltered: 0,
					recordsTotal: 0,
				}),
			}),
		);

		const response = await injectAuthenticated("GET", "/api/tautulli/history?offset=0&limit=1");

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload).sources[0]).toMatchObject({
			complete: false,
			incompleteReason: "page_overflow",
		});
	});

	it("preserves bounded deep history pages separately for each source", async () => {
		prisma.serviceInstance.findMany.mockResolvedValue([instanceOne, instanceTwo]);
		const oneHistory = pagedHistory("One", 600, 2_000_000, 2);
		const twoHistory = pagedHistory("Two", 600, 1_999_999, 2);
		const one = makeClient({ getHistoryNewestPage: oneHistory });
		const two = makeClient({ getHistoryNewestPage: twoHistory });
		mockCreateTautulliClient.mockImplementation((_encryptor, instance) =>
			instance.id === instanceOne.id ? one : two,
		);

		const response = await injectAuthenticated("GET", "/api/tautulli/history?offset=500&limit=1");

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload).sources).toEqual([
			expect.objectContaining({
				instanceId: "tautulli-one",
				history: [expect.objectContaining({ title: "One 500" })],
			}),
			expect.objectContaining({
				instanceId: "tautulli-two",
				history: [expect.objectContaining({ title: "Two 500" })],
			}),
		]);
		for (const getHistoryNewestPage of [oneHistory, twoHistory]) {
			expect(getHistoryNewestPage).toHaveBeenNthCalledWith(1, { start: 0, length: 500 });
			expect(getHistoryNewestPage).toHaveBeenNthCalledWith(2, { start: 500, length: 1 });
		}
	});

	it("rejects history retrieval depths above the documented 5000-record maximum", async () => {
		const response = await injectAuthenticated(
			"GET",
			"/api/tautulli/history?offset=4901&limit=100",
		);

		expect(response.statusCode).toBe(400);
		expect(response.payload).toContain("5000");
	});

	it("labels an unreachable history source with a sanitized incomplete reason", async () => {
		const client = makeClient({
			getHistoryNewestPage: vi.fn().mockRejectedValue(new Error("http://secret")),
		});
		mockCreateTautulliClient.mockReturnValue(client);

		const response = await injectAuthenticated("GET", "/api/tautulli/history?offset=0&limit=1");

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload).sources).toEqual([
			expect.objectContaining({ complete: false, incompleteReason: "source_unreachable" }),
		]);
	});

	it("paginates each Tautulli source independently", async () => {
		prisma.serviceInstance.findMany.mockResolvedValue([instanceOne, instanceTwo]);
		const one = makeClient({
			getHistoryNewestPage: vi.fn().mockResolvedValue({
				data: [
					{
						row_id: 3,
						rating_key: "3",
						parent_rating_key: "",
						grandparent_rating_key: "",
						title: "One newest",
						grandparent_title: "",
						media_type: "movie",
						user: "one",
						date: 3_000,
					},
					{
						row_id: 1,
						rating_key: "1",
						parent_rating_key: "",
						grandparent_rating_key: "",
						title: "One older",
						grandparent_title: "",
						media_type: "movie",
						user: "one",
						date: 1_000,
					},
				],
				recordsFiltered: 2,
				recordsTotal: 2,
			}),
		});
		const two = makeClient({
			getHistoryNewestPage: vi.fn().mockResolvedValue({
				data: [
					{
						row_id: 4,
						rating_key: "4",
						parent_rating_key: "",
						grandparent_rating_key: "",
						title: "Two newest",
						grandparent_title: "",
						media_type: "movie",
						user: "two",
						date: 4_000,
					},
					{
						row_id: 2,
						rating_key: "2",
						parent_rating_key: "",
						grandparent_rating_key: "",
						title: "Two older",
						grandparent_title: "",
						media_type: "movie",
						user: "two",
						date: 2_000,
					},
				],
				recordsFiltered: 2,
				recordsTotal: 2,
			}),
		});
		mockCreateTautulliClient.mockImplementation((_encryptor, instance) =>
			instance.id === instanceOne.id ? one : two,
		);

		const response = await injectAuthenticated("GET", "/api/tautulli/history?offset=1&limit=2");

		expect(response.statusCode).toBe(200);
		expect(
			JSON.parse(response.payload).sources.map((source: { history: Array<{ title: string }> }) =>
				source.history.map((item) => item.title),
			),
		).toEqual([["One older"], ["Two older"]]);
		expect(one.getHistoryNewestPage).toHaveBeenCalledWith({ start: 0, length: 3 });
		expect(two.getHistoryNewestPage).toHaveBeenCalledWith({ start: 0, length: 3 });
	});

	it("returns an honest unavailable result when no enabled Tautulli instance exists", async () => {
		prisma.serviceInstance.findMany.mockResolvedValue([]);
		const response = await injectAuthenticated("GET", "/api/tautulli/activity");
		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload)).toMatchObject({
			provider: "tautulli",
			configured: false,
			sources: [],
		});
	});

	it("rejects cache status requests for an instance not owned by the current user", async () => {
		prisma.serviceInstance.findFirst.mockResolvedValue(null);
		const response = await injectAuthenticated("GET", "/api/tautulli/cache/other-user/status");
		expect(response.statusCode).toBe(404);
		expect(prisma.tautulliCache.count).not.toHaveBeenCalled();
	});

	it("returns the durable cache witness for the owned Tautulli instance", async () => {
		const response = await injectAuthenticated("GET", "/api/tautulli/cache/tautulli-one/status");
		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload)).toMatchObject({
			instanceId: "tautulli-one",
			cachedItems: 3,
			hasCacheData: true,
			status: { cacheType: "tautulli", itemCount: 3, lastResult: "success" },
		});
	});

	it.each([
		["newer", "2026-08-12T00:01:00.000Z"],
		["equal", "2026-08-12T00:00:00.000Z"],
	])(
		"reports a %s failed cache attempt as the effective health result without replacing the successful generation",
		async (_comparison, lastAttemptAt) => {
			prisma.cacheRefreshStatus.findMany.mockResolvedValue([
				{
					instanceId: instanceOne.id,
					cacheType: "tautulli",
					lastRefreshedAt: new Date("2026-08-12T00:00:00.000Z"),
					lastResult: "success",
					lastErrorMessage: null,
					itemCount: 3,
					lastAttemptAt: new Date(lastAttemptAt),
					lastAttemptResult: "error",
					lastAttemptErrorMessage: "refresh failed in /config/private.ts",
				},
			]);

			const response = await injectAuthenticated("GET", "/api/tautulli/cache/health");

			expect(response.statusCode).toBe(200);
			expect(JSON.parse(response.payload).items).toEqual([
				expect.objectContaining({
					lastRefreshedAt: "2026-08-12T00:00:00.000Z",
					lastResult: "success",
					itemCount: 3,
					lastAttemptAt,
					lastAttemptResult: "error",
					lastAttemptErrorMessage: "refresh failed in [path]",
					effectiveResult: "partial",
				}),
			]);
		},
	);

	it("reports a durable in-flight cache attempt as pending without replacing the successful generation", async () => {
		prisma.cacheRefreshStatus.findMany.mockResolvedValue([
			{
				instanceId: instanceOne.id,
				cacheType: "tautulli",
				lastRefreshedAt: new Date("2026-08-12T00:00:00.000Z"),
				lastResult: "success",
				lastErrorMessage: null,
				itemCount: 3,
				lastAttemptAt: new Date("2026-08-12T00:01:00.000Z"),
				lastAttemptResult: "pending",
				lastAttemptErrorMessage: null,
			},
		]);

		const response = await injectAuthenticated("GET", "/api/tautulli/cache/health");

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload).items).toEqual([
			expect.objectContaining({
				lastResult: "success",
				itemCount: 3,
				lastAttemptResult: "pending",
				effectiveResult: "pending",
			}),
		]);
	});

	it("reports an unsuccessful cache generation as an error rather than a partial success", async () => {
		prisma.cacheRefreshStatus.findMany.mockResolvedValue([
			{
				instanceId: instanceOne.id,
				cacheType: "tautulli",
				lastRefreshedAt: new Date("2026-08-12T00:00:00.000Z"),
				lastResult: "error",
				lastErrorMessage: "initial refresh failed",
				itemCount: 0,
				lastAttemptAt: new Date("2026-08-12T00:00:00.000Z"),
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "initial refresh failed",
			},
		]);

		const response = await injectAuthenticated("GET", "/api/tautulli/cache/health");

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload).items).toEqual([
			expect.objectContaining({
				lastResult: "error",
				itemCount: 0,
				effectiveResult: "error",
			}),
		]);
	});

	it("refreshes only an owned current Tautulli instance through the guarded refresher", async () => {
		const response = await injectAuthenticated("POST", "/api/tautulli/cache/tautulli-one/refresh");
		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload)).toMatchObject({
			success: true,
			complete: true,
			upserted: 3,
		});
		expect(mockRefreshTautulliCache).toHaveBeenCalledWith(
			expect.anything(),
			prisma,
			"tautulli-one",
			expect.anything(),
			providerConnectionIdentity(instanceOne as never),
		);
	});
});
