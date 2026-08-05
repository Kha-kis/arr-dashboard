import { describe, expect, it, vi } from "vitest";
import {
	fetchCompleteSeerrRequestMap,
	prefetchSeerrRequests,
	SEERR_PREFETCH_MAX_PAGES,
	SEERR_PREFETCH_PAGE_SIZE,
} from "../cleanup-executor.js";

function makeRequest(id: number, tmdbId = id) {
	return {
		id,
		type: "movie",
		status: 2,
		media: { tmdbId },
		requestedBy: { id, displayName: `user-${id}` },
		modifiedBy: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		is4k: false,
	};
}

function stableInventory(requests: ReturnType<typeof makeRequest>[]) {
	const pages = requests.length === 0 ? 0 : Math.ceil(requests.length / SEERR_PREFETCH_PAGE_SIZE);
	return vi.fn().mockImplementation(({ skip }: { skip: number }) => ({
		pageInfo: {
			pages,
			pageSize: SEERR_PREFETCH_PAGE_SIZE,
			results: requests.length,
			page: skip / SEERR_PREFETCH_PAGE_SIZE + 1,
		},
		results: requests.slice(skip, skip + SEERR_PREFETCH_PAGE_SIZE),
	}));
}

function makeInstance(id: string, enabled = true) {
	return {
		id,
		userId: "user-1",
		service: "SEERR",
		enabled,
		label: id,
		baseUrl: `http://${id}`,
		encryptedApiKey: "encrypted",
		encryptionIv: "iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
	};
}

describe("fetchCompleteSeerrRequestMap", () => {
	it("returns a complete empty map as known zero requests", async () => {
		const getRequests = stableInventory([]);

		await expect(fetchCompleteSeerrRequestMap({ getRequests } as never)).resolves.toEqual(
			new Map(),
		);
		expect(getRequests).toHaveBeenCalledTimes(2);
	});

	it("accepts an inventory exactly at the bounded page limit", async () => {
		const total = SEERR_PREFETCH_MAX_PAGES * SEERR_PREFETCH_PAGE_SIZE;
		const getRequests = vi.fn().mockImplementation(({ skip }: { skip: number }) => ({
			pageInfo: {
				pages: SEERR_PREFETCH_MAX_PAGES,
				pageSize: SEERR_PREFETCH_PAGE_SIZE,
				results: total,
				page: skip / SEERR_PREFETCH_PAGE_SIZE + 1,
			},
			results: Array.from({ length: SEERR_PREFETCH_PAGE_SIZE }, (_, index) =>
				makeRequest(skip + index + 1),
			),
		}));

		const result = await fetchCompleteSeerrRequestMap({ getRequests } as never);
		expect(result.size).toBe(total);
		expect(getRequests).toHaveBeenCalledTimes(SEERR_PREFETCH_MAX_PAGES * 2);
	});

	it("requires two identical complete inventories before returning known evidence", async () => {
		const getRequests = stableInventory([makeRequest(2), makeRequest(1)]);

		const result = await fetchCompleteSeerrRequestMap({ getRequests } as never);

		expect(result.size).toBe(2);
		expect(getRequests).toHaveBeenCalledTimes(2);
	});

	it("fails closed before using an inventory beyond the bounded page limit", async () => {
		const getRequests = vi.fn().mockResolvedValue({
			pageInfo: {
				pages: SEERR_PREFETCH_MAX_PAGES + 1,
				pageSize: SEERR_PREFETCH_PAGE_SIZE,
				results: SEERR_PREFETCH_MAX_PAGES * SEERR_PREFETCH_PAGE_SIZE + 1,
				page: 1,
			},
			results: Array.from({ length: SEERR_PREFETCH_PAGE_SIZE }, (_, index) =>
				makeRequest(index + 1),
			),
		});

		await expect(fetchCompleteSeerrRequestMap({ getRequests } as never)).rejects.toThrow(
			"exceeds the safe",
		);
		expect(getRequests).toHaveBeenCalledTimes(1);
	});

	it("fails closed when the final page is partial relative to the advertised total", async () => {
		const getRequests = vi
			.fn()
			.mockResolvedValueOnce({
				pageInfo: { pages: 2, pageSize: 50, results: 75, page: 1 },
				results: Array.from({ length: 50 }, (_, index) => makeRequest(index + 1)),
			})
			.mockResolvedValueOnce({
				pageInfo: { pages: 2, pageSize: 50, results: 75, page: 2 },
				results: Array.from({ length: 24 }, (_, index) => makeRequest(index + 51)),
			});

		await expect(fetchCompleteSeerrRequestMap({ getRequests } as never)).rejects.toThrow(
			"fetched 74 of 75",
		);
	});

	it("fails closed when pagination metadata changes between pages", async () => {
		const getRequests = vi
			.fn()
			.mockResolvedValueOnce({
				pageInfo: { pages: 2, pageSize: 50, results: 75, page: 1 },
				results: Array.from({ length: 50 }, (_, index) => makeRequest(index + 1)),
			})
			.mockResolvedValueOnce({
				pageInfo: { pages: 3, pageSize: 50, results: 75, page: 2 },
				results: Array.from({ length: 25 }, (_, index) => makeRequest(index + 51)),
			});

		await expect(fetchCompleteSeerrRequestMap({ getRequests } as never)).rejects.toThrow(
			"changed during pagination",
		);
	});

	it("fails closed when a same-count offset shift omits one request", async () => {
		const firstPageBeforeShift = Array.from({ length: 50 }, (_, index) => makeRequest(index + 1));
		const secondPageAfterShift = Array.from({ length: 50 }, (_, index) => makeRequest(index + 52));
		const stableSecondPass = Array.from({ length: 100 }, (_, index) => makeRequest(index + 2));
		const getRequests = vi.fn().mockImplementation(({ skip }: { skip: number }) => {
			const results =
				getRequests.mock.calls.length === 1
					? firstPageBeforeShift
					: getRequests.mock.calls.length === 2
						? secondPageAfterShift
						: stableSecondPass.slice(skip, skip + SEERR_PREFETCH_PAGE_SIZE);
			return {
				pageInfo: {
					pages: 2,
					pageSize: SEERR_PREFETCH_PAGE_SIZE,
					results: 100,
					page: skip / SEERR_PREFETCH_PAGE_SIZE + 1,
				},
				results,
			};
		});

		await expect(fetchCompleteSeerrRequestMap({ getRequests } as never)).rejects.toThrow(
			"changed between verification passes",
		);
		expect(getRequests).toHaveBeenCalledTimes(4);
	});

	it("fails closed on a duplicate request ID within an instance inventory", async () => {
		const duplicate = makeRequest(1, 2);
		const getRequests = vi.fn().mockResolvedValue({
			pageInfo: { pages: 1, pageSize: 50, results: 2, page: 1 },
			results: [makeRequest(1, 1), duplicate],
		});

		await expect(fetchCompleteSeerrRequestMap({ getRequests } as never)).rejects.toThrow(
			"duplicate request",
		);
		expect(getRequests).toHaveBeenCalledTimes(1);
	});

	it("propagates page errors so the caller marks Seerr evidence unavailable", async () => {
		const getRequests = vi.fn().mockRejectedValue(new Error("upstream unavailable"));
		await expect(fetchCompleteSeerrRequestMap({ getRequests } as never)).rejects.toThrow(
			"upstream unavailable",
		);
	});

	it("marks capped inventory unavailable instead of exposing partial negative evidence", async () => {
		const getRequests = vi.fn().mockResolvedValue({
			pageInfo: {
				pages: SEERR_PREFETCH_MAX_PAGES + 1,
				pageSize: SEERR_PREFETCH_PAGE_SIZE,
				results: SEERR_PREFETCH_MAX_PAGES * SEERR_PREFETCH_PAGE_SIZE + 1,
				page: 1,
			},
			results: Array.from({ length: SEERR_PREFETCH_PAGE_SIZE }, (_, index) =>
				makeRequest(index + 1),
			),
		});
		const warn = vi.fn();
		const result = await prefetchSeerrRequests(
			{
				prisma: {
					serviceInstance: {
						findMany: vi.fn().mockResolvedValue([makeInstance("seerr-1")]),
					},
				},
				arrClientFactory: {},
				log: { info: vi.fn(), warn },
			} as never,
			"user-1",
			() => ({ getRequests }) as never,
		);

		expect(result).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ err: expect.any(Error) }),
			expect.stringContaining("Seerr rules will be skipped"),
		);
	});
});

describe("prefetchSeerrRequests", () => {
	it("merges every enabled instance and retains instance-scoped duplicate IDs", async () => {
		const findMany = vi.fn().mockResolvedValue([makeInstance("seerr-b"), makeInstance("seerr-a")]);
		const clients = new Map([
			["seerr-a", stableInventory([makeRequest(1, 100), makeRequest(2, 200)])],
			["seerr-b", stableInventory([makeRequest(1, 100), makeRequest(3, 300)])],
		]);

		const result = await prefetchSeerrRequests(
			{
				prisma: { serviceInstance: { findMany } },
				arrClientFactory: {},
				log: { info: vi.fn(), warn: vi.fn() },
			} as never,
			"user-1",
			(instance) => ({ getRequests: clients.get(instance.id)! }) as never,
		);

		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { userId: "user-1", service: "SEERR", enabled: true },
				orderBy: { id: "asc" },
			}),
		);
		expect(result?.get("movie:100")?.map((request) => request.requestId)).toEqual([1, 1]);
		expect(result?.has("movie:200")).toBe(true);
		expect(result?.has("movie:300")).toBe(true);
		expect(result?.has("movie:999")).toBe(false);
		expect(clients.get("seerr-a")).toHaveBeenCalledTimes(2);
		expect(clients.get("seerr-b")).toHaveBeenCalledTimes(2);
	});

	it("returns known empty evidence only when every enabled instance is complete and empty", async () => {
		const result = await prefetchSeerrRequests(
			{
				prisma: {
					serviceInstance: {
						findMany: vi.fn().mockResolvedValue([makeInstance("seerr-a"), makeInstance("seerr-b")]),
					},
				},
				arrClientFactory: {},
				log: { info: vi.fn(), warn: vi.fn() },
			} as never,
			"user-1",
			() => ({ getRequests: stableInventory([]) }) as never,
		);

		expect(result).toEqual(new Map());
	});

	it("ignores disabled instances through the database query", async () => {
		const findMany = vi
			.fn()
			.mockImplementation(({ where }: { where: { enabled: boolean } }) =>
				where.enabled ? [makeInstance("enabled")] : [makeInstance("disabled", false)],
			);
		const clientFactory = vi.fn((_instance: { id: string }) => ({
			getRequests: stableInventory([makeRequest(1)]),
		}));

		const result = await prefetchSeerrRequests(
			{
				prisma: { serviceInstance: { findMany } },
				arrClientFactory: {},
				log: { info: vi.fn(), warn: vi.fn() },
			} as never,
			"user-1",
			clientFactory as never,
		);

		expect(result?.has("movie:1")).toBe(true);
		expect(clientFactory).toHaveBeenCalledOnce();
		expect(clientFactory.mock.calls[0]?.[0]).toMatchObject({ id: "enabled" });
	});

	it("marks all Seerr evidence unavailable when any enabled instance fails", async () => {
		const warn = vi.fn();
		const result = await prefetchSeerrRequests(
			{
				prisma: {
					serviceInstance: {
						findMany: vi.fn().mockResolvedValue([makeInstance("seerr-a"), makeInstance("seerr-b")]),
					},
				},
				arrClientFactory: {},
				log: { info: vi.fn(), warn },
			} as never,
			"user-1",
			(instance) =>
				({
					getRequests:
						instance.id === "seerr-a"
							? stableInventory([makeRequest(1)])
							: vi.fn().mockRejectedValue(new Error("seerr-b unavailable")),
				}) as never,
		);

		expect(result).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ err: expect.any(Error) }),
			expect.stringContaining("Seerr rules will be skipped"),
		);
	});
});
