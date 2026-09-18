import { afterEach, describe, expect, it, vi } from "vitest";
import { TautulliClient } from "../tautulli-client.js";

const log = { warn: vi.fn(), error: vi.fn() } as never;

function success(data: unknown): Response {
	return new Response(JSON.stringify({ response: { result: "success", message: null, data } }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function row(userId: number | string, overrides: Record<string, unknown> = {}) {
	return {
		user_id: userId,
		user: `user-${userId}`,
		friendly_name: `User ${userId}`,
		total_plays: 1,
		total_duration: 2,
		...overrides,
	};
}

function stat(rows: unknown[], statId = "top_users"): Response {
	return success({ stat_id: statId, stat_title: "Top Users", rows });
}

describe("TautulliClient user statistics", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("reads top_users through the paged get_home_stats object response", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			success({
				stat_id: "top_users",
				stat_title: "Top Users",
				rows: [
					{
						user_id: "7",
						user: "deleted-user",
						friendly_name: null,
						total_plays: 3,
						total_duration: 120,
						private_token: "must-not-escape",
					},
				],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await new TautulliClient("http://tautulli.test", "api-key", log).getUserStats(
			30,
		);

		expect(result).toEqual([
			{
				user_id: 7,
				friendly_name: "deleted-user",
				total_plays: 3,
				total_duration: 120,
			},
		]);
		const requestedUrl = new URL(fetchMock.mock.calls[0]![0] as string);
		expect(requestedUrl.searchParams.get("cmd")).toBe("get_home_stats");
		expect(requestedUrl.searchParams.get("time_range")).toBe("30");
		expect(requestedUrl.searchParams.get("stat_id")).toBe("top_users");
		expect(requestedUrl.searchParams.get("stats_type")).toBe("plays");
		expect(requestedUrl.searchParams.get("stats_count")).toBe("100");
		expect(requestedUrl.searchParams.get("stats_start")).toBe("0");
	});

	it("reads all users in pages of 100 and requires a terminal short page", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(stat(Array.from({ length: 100 }, (_, i) => row(i))));
		fetchMock.mockResolvedValueOnce(stat([row(100)]));
		vi.stubGlobal("fetch", fetchMock);

		const result = await new TautulliClient("http://tautulli.test", "api-key", log).getUserStats(
			14,
		);

		expect(result).toHaveLength(101);
		expect(new URL(fetchMock.mock.calls[1]![0] as string).searchParams.get("stats_start")).toBe(
			"100",
		);
		expect(new URL(fetchMock.mock.calls[1]![0] as string).searchParams.get("time_range")).toBe(
			"14",
		);
		expect(new URL(fetchMock.mock.calls[1]![0] as string).searchParams.get("stats_type")).toBe(
			"plays",
		);
	});

	it("accepts an empty terminal page after a full first page", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(stat(Array.from({ length: 100 }, (_, i) => row(i))))
			.mockResolvedValueOnce(stat([]));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			new TautulliClient("http://tautulli.test", "api-key", log).getUserStats(),
		).resolves.toHaveLength(100);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("rejects a page larger than the requested page size", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockImplementation(() =>
					Promise.resolve(stat(Array.from({ length: 101 }, (_, i) => row(i)))),
				),
		);

		await expect(
			new TautulliClient("http://tautulli.test", "api-key", log).getUserStats(),
		).rejects.toThrow("page size");
	});

	it("rejects duplicate user IDs across pages", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(stat(Array.from({ length: 100 }, (_, i) => row(i))))
			.mockResolvedValueOnce(stat([row(99)]));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			new TautulliClient("http://tautulli.test", "api-key", log).getUserStats(),
		).rejects.toThrow("duplicate user statistics");
	});

	it.each([
		["null user ID", row(null as never)],
		["boolean user ID", row(true as never)],
		["blank user ID", row("   ")],
		["negative user ID", row(-1)],
		["unsafe user ID", row("9007199254740992")],
		["negative plays", row(1, { total_plays: -1 })],
		["null plays", row(1, { total_plays: null })],
		["missing duration", row(1, { total_duration: undefined })],
		["infinite duration", row(1, { total_duration: Number.POSITIVE_INFINITY })],
	])("rejects %s", async (_label, invalidRow) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stat([invalidRow])));

		await expect(
			new TautulliClient("http://tautulli.test", "api-key", log).getUserStats(),
		).rejects.toThrow();
	});

	it.each([
		["missing rows", { stat_id: "top_users", stat_title: "Top Users" }],
		["wrong stat ID", { stat_id: "top_movies", stat_title: "Top Movies", rows: [] }],
	])("rejects %s", async (_label, invalidStat) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(success(invalidStat)));

		await expect(
			new TautulliClient("http://tautulli.test", "api-key", log).getUserStats(),
		).rejects.toThrow();
	});

	it("uses the upstream user or a static fallback when friendly_name is missing", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					stat([
						row(1, { friendly_name: null, user: "upstream-user" }),
						row(2, { friendly_name: null, user: null }),
					]),
				),
		);

		await expect(
			new TautulliClient("http://tautulli.test", "api-key", log).getUserStats(),
		).resolves.toEqual([
			expect.objectContaining({ user_id: 1, friendly_name: "upstream-user" }),
			expect.objectContaining({ user_id: 2, friendly_name: "Unknown user" }),
		]);
	});

	it("uses one abort deadline across pages", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(stat(Array.from({ length: 100 }, (_, i) => row(i))))
			.mockImplementationOnce(
				(_url: string, init?: RequestInit) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
							once: true,
						});
					}),
			);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			new TautulliClient("http://tautulli.test", "api-key", log, 10).getUserStats(),
		).rejects.toThrow(/connection error|aborted|timeout/i);
		expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
		expect(fetchMock.mock.calls[1]![1]?.signal?.aborted).toBe(true);
	});

	it("does not restart the operation deadline for a later page", async () => {
		vi.useFakeTimers();
		vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(new Error("synthetic timeout")), milliseconds);
			return controller.signal;
		});
		let page = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init: RequestInit) =>
					new Promise((resolve, reject) => {
						const index = page++;
						const abort = () => {
							clearTimeout(timer);
							reject(init.signal?.reason);
						};
						const timer = setTimeout(() => {
							init.signal?.removeEventListener("abort", abort);
							resolve(stat(index === 0 ? Array.from({ length: 100 }, (_, i) => row(i)) : []));
						}, 8);
						init.signal?.addEventListener("abort", abort, { once: true });
					}),
			),
		);
		const result = expect(
			new TautulliClient("http://tautulli.test", "api-key", log, 12).getUserStats(),
		).rejects.toThrow("timeout");
		await vi.advanceTimersByTimeAsync(12);
		await result;
		expect(page).toBe(2);
	});

	it("rejects instead of silently truncating at the pagination cap", async () => {
		const fetchMock = vi.fn().mockImplementation((url: string) => {
			const start = Number(new URL(url).searchParams.get("stats_start"));
			return Promise.resolve(stat(Array.from({ length: 100 }, (_, i) => row(start + i))));
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			new TautulliClient("http://tautulli.test", "api-key", log).getUserStats(),
		).rejects.toThrow("pagination cap");
		expect(fetchMock).toHaveBeenCalledTimes(100);
	});

	it("rejects a page-level upstream error", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					new Response("upstream failure", { status: 502, statusText: "Bad Gateway" }),
				),
		);

		await expect(
			new TautulliClient("http://tautulli.test", "api-key", log).getUserStats(),
		).rejects.toThrow("HTTP 502");
	});
});
