import { Writable } from "node:stream";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createEpisodeFileInventoryReceipt } from "../../lib/library-sync/episode-file-coverage.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

const mocks = vi.hoisted(() => ({
	buildIndex: vi.fn(),
	getHashes: vi.fn(),
	getCachedTorrents: vi.fn(),
	getTrackers: vi.fn(),
	createClient: vi.fn(),
}));

vi.mock("../../lib/library-sync/infohash-backfill-by-inode.js", () => ({
	buildFileIdIndex: mocks.buildIndex,
	clearFileIdIndexCache: vi.fn(),
	getAllHashesForFileIdWithPathEvidence: mocks.getHashes,
}));
vi.mock("../../lib/qui/torrent-list-cache.js", () => ({
	getCachedAllTorrents: mocks.getCachedTorrents,
}));
vi.mock("../../lib/qui/client-factory.js", () => ({
	createQuiClient: (...args: unknown[]) => mocks.createClient(...args),
}));

import { registerLibraryRoutes } from "../qui/library-routes.js";

const item = { arrInstanceId: "arr-1", itemId: 1, itemType: "movie" as const };
const seriesItem = { arrInstanceId: "arr-1", itemId: 2, itemType: "series" as const };
let app: ReturnType<typeof Fastify>;
let logs: Array<Record<string, unknown>>;
let releasePendingReads: Array<() => void>;
let authenticatedUser: { id: string; username: string };
let movieRow: Mock<() => Promise<{ data: string }>>;
let seriesRows: Mock<() => Promise<unknown[]>>;
let episodeRows: Mock<() => Promise<Record<string, unknown>[]>>;
function deferredRead<T>(value: T): Promise<T> {
	return new Promise((resolve) => {
		releasePendingReads.push(() => resolve(value));
	});
}
let prisma: {
	serviceInstance: { findMany: ReturnType<typeof vi.fn> };
	libraryCache: { findMany: ReturnType<typeof vi.fn> };
	episodeFileCache: { findMany: ReturnType<typeof vi.fn> };
};

beforeEach(async () => {
	vi.clearAllMocks();
	releasePendingReads = [];
	mocks.createClient.mockImplementation(() => ({
		getTrackers: mocks.getTrackers,
		getTorrentByHash: vi.fn(),
	}));
	mocks.buildIndex.mockResolvedValue({
		byFileId: new Map(),
		inventoryComplete: true,
		skippedNoLinks: 0,
		skippedUnstatable: 0,
		incompleteDirectoryWalks: 0,
	});
	mocks.getHashes.mockResolvedValue({
		hashes: ["synthetic-hash"],
		pathVerified: true,
		correlationComplete: true,
	});
	mocks.getCachedTorrents.mockResolvedValue([{ hash: "synthetic-hash", instanceId: 3 }]);
	mocks.getTrackers.mockResolvedValue([{ url: "https://tracker.invalid/announce" }]);
	movieRow = vi.fn().mockResolvedValue({
		data: JSON.stringify({ path: "/synthetic", movieFile: { relativePath: "file" } }),
	});
	seriesRows = vi.fn().mockResolvedValue([]);
	episodeRows = vi.fn().mockResolvedValue([]);
	prisma = {
		serviceInstance: {
			findMany: vi.fn().mockResolvedValue([
				{
					id: "qui-1",
					userId: "test-user",
					service: "QUI",
					enabled: true,
					hasLocalFilesystemAccess: true,
					connectionGeneration: 0,
					identityGeneration: 0,
					pathPrefix: null,
				},
			]),
		},
		libraryCache: {
			findMany: vi.fn().mockImplementation(async ({ where }) => {
				if (where.itemType !== "movie") return seriesRows();
				return Promise.all(
					where.OR.map(async (identity: { instanceId: string; arrItemId: number }) => ({
						...identity,
						...(await movieRow()),
					})),
				);
			}),
		},
		episodeFileCache: {
			findMany: vi
				.fn()
				.mockImplementation(async ({ where }) =>
					(
						await Promise.all(
							where.OR.map(async (identity: { instanceId: string; arrSeriesId: number }) =>
								(
									await episodeRows()
								).map((row: Record<string, unknown>) => ({ ...identity, ...row })),
							),
						)
					).flat(),
				),
		},
	};
	logs = [];
	app = Fastify({
		logger: {
			level: "info",
			stream: new Writable({
				write(chunk, _encoding, callback) {
					logs.push(JSON.parse(chunk.toString()));
					callback();
				},
			}),
		},
	});
	app.decorate("prisma", prisma as never);
	authenticatedUser = { id: "user-1", username: "admin" };
	setupAuthInjection(app, authenticatedUser);
	registerTestErrorHandler(app);
	await app.register(registerLibraryRoutes);
	await app.ready();
});

afterEach(async () => {
	for (const release of releasePendingReads) release();
	await app?.close();
});

async function summary(requestedItem: typeof item | typeof seriesItem = item) {
	return createInjectAuthenticated(app)("POST", "/qui/library-seeding-summary", {
		body: { items: [requestedItem] },
	});
}

// Wait at the actual provider-list boundary before advancing the request budget.
async function boundedPoll(requestedItem: typeof item | typeof seriesItem = item) {
	let entered = () => {};
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	mocks.getCachedTorrents.mockImplementationOnce(async () => {
		entered();
		return [{ hash: "synthetic-hash", instanceId: 3 }];
	});
	const response = summary(requestedItem);
	await Promise.race([started, response.then(() => {})]);
	await vi.advanceTimersByTimeAsync(1_200);
	return response;
}

describe("qUI Library tracker summary coverage", () => {
	it("does not let an older handler adopt a newer generation's collection after file awaits", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
		const evidence = {
			hashes: ["synthetic-hash"],
			pathVerified: true,
			correlationComplete: true,
		};
		let generation = 0;
		prisma.serviceInstance.findMany.mockImplementation(async () => [
			{
				id: "qui-1",
				enabled: true,
				hasLocalFilesystemAccess: true,
				connectionGeneration: generation,
				identityGeneration: 0,
				pathPrefix: null,
			},
		]);
		let filesEntered = () => {};
		const oldFilesEntered = new Promise<void>((resolve) => {
			filesEntered = resolve;
		});
		let releaseFiles = () => {};
		const oldFiles = new Promise<typeof evidence>((resolve) => {
			releaseFiles = () => resolve(evidence);
		});
		mocks.getHashes.mockImplementationOnce(() => {
			filesEntered();
			return oldFiles;
		});
		let listEntered = () => {};
		const newerListEntered = new Promise<void>((resolve) => {
			listEntered = resolve;
		});
		const torrents = [{ hash: "synthetic-hash", instanceId: 3 }];
		let releaseList = () => {};
		const newerList = new Promise<typeof torrents>((resolve) => {
			releaseList = () => resolve(torrents);
		});
		mocks.getCachedTorrents.mockImplementationOnce(() => {
			listEntered();
			return newerList;
		});
		let oldTrackerEntered = () => {};
		const oldTrackerStarted = new Promise<void>((resolve) => {
			oldTrackerEntered = resolve;
		});
		let releaseTrackers = () => {};
		const trackers = new Promise<void>((resolve) => {
			releaseTrackers = resolve;
		});
		mocks.createClient.mockImplementation(
			(_app: unknown, instance: { connectionGeneration: number }) => ({
				getTrackers: async () => {
					if (instance.connectionGeneration === 0) oldTrackerEntered();
					await trackers;
					return [{ url: `https://gen${instance.connectionGeneration}.invalid/a` }];
				},
			}),
		);
		try {
			// A captures generation 0, then pauses after the early authority check.
			const oldRequest = summary();
			await oldFilesEntered;
			generation = 1;
			// B establishes generation 1's collection, but its list times out.
			const newerRequest = summary();
			await newerListEntered;
			await vi.advanceTimersByTimeAsync(1_200);
			expect((await newerRequest).json()).toMatchObject({ status: "building" });
			releaseFiles();
			await Promise.race([oldTrackerStarted, oldRequest.then(() => {})]);
			// C must use generation 1 even while A's old work overlaps it.
			let currentListEntered = () => {};
			const currentListed = new Promise<void>((resolve) => {
				currentListEntered = resolve;
			});
			mocks.getCachedTorrents.mockImplementationOnce(async () => {
				currentListEntered();
				return torrents;
			});
			const currentRequest = summary();
			await currentListed;
			await vi.advanceTimersByTimeAsync(0);
			releaseTrackers();
			releaseList();
			const [old, current] = await Promise.all([oldRequest, currentRequest]);
			expect(current.json()).toMatchObject({
				status: "available",
				summaries: {
					"arr-1|movie:1": { trackerCount: 1, topHosts: ["gen1.invalid"], hashCount: 1 },
				},
			});
			expect(current.json().summaries["arr-1|movie:1"].topHosts).not.toContain("gen0.invalid");
			expect(old.json()).toMatchObject({ status: "building" });
		} finally {
			releaseFiles();
			releaseList();
			releaseTrackers();
			await vi.runOnlyPendingTimersAsync();
			vi.useRealTimers();
		}
	});

	it("cannot repopulate an invalidated collection from a late read", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
		mocks.getTrackers.mockReturnValueOnce(deferredRead([{ url: "https://old.invalid/a" }]));
		try {
			expect((await boundedPoll()).json()).toMatchObject({ status: "building" });
			movieRow.mockResolvedValueOnce({
				data: JSON.stringify({ path: "/changed", movieFile: { relativePath: "file" } }),
			});
			// The replacement can join the old transport only as lower-bound work.
			expect((await boundedPoll()).json()).toMatchObject({ status: "building" });
			for (const release of releasePendingReads) release();
			await vi.advanceTimersByTimeAsync(0);
			// Returning to the original path cannot resurrect its old collection.
			expect((await summary()).json()).toMatchObject({
				status: "available",
				summaries: { "arr-1|movie:1": { topHosts: ["tracker.invalid"] } },
			});
			expect(mocks.getTrackers).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("caps admitted hash reads across pages and allows later polls after capacity frees", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
		const hashes = Array.from({ length: 40 }, (_, i) => `capacity-${i}`);
		mocks.getHashes.mockResolvedValue({ hashes, pathVerified: true, correlationComplete: true });
		mocks.getCachedTorrents.mockResolvedValue(hashes.map((hash) => ({ hash, instanceId: 3 })));
		let active = 0;
		let peak = 0;
		let entered = () => {};
		mocks.createClient.mockImplementation(() => ({
			getTrackers: async () => {
				active++;
				peak = Math.max(peak, active);
				entered();
				await deferredRead([]);
				active--;
				return [{ url: "https://tracker.invalid/a" }];
			},
		}));
		try {
			// Distinct users cannot share the per-hash transport cache.
			for (let page = 0; page < 5; page++) {
				authenticatedUser.id = `capacity-user-${page}`;
				const started = new Promise<void>((resolve) => {
					entered = resolve;
				});
				const response = summary();
				await Promise.race([started, response.then(() => {})]);
				await vi.advanceTimersByTimeAsync(1_200);
				expect((await response).json()).toMatchObject({ status: "building" });
			}
			expect(peak).toBe(128);
			for (const release of releasePendingReads) release();
			await vi.advanceTimersByTimeAsync(0);
			mocks.createClient.mockImplementation(() => ({ getTrackers: mocks.getTrackers }));
			expect((await summary()).json()).toMatchObject({
				status: "available",
				summaries: { "arr-1|movie:1": { trackerCount: 1, hashCount: 40 } },
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("drains an outstanding torrent-list timeout while admitting no tracker work after close", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
		let entered = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		mocks.getCachedTorrents.mockImplementationOnce(() => {
			entered();
			return deferredRead([{ hash: "synthetic-hash", instanceId: 3 }]);
		});
		try {
			const response = summary();
			await started;
			await vi.advanceTimersByTimeAsync(1_200);
			expect((await response).json()).toMatchObject({ status: "building" });
			let closed = false;
			const close = app.close().then(() => {
				closed = true;
			});
			await vi.advanceTimersByTimeAsync(1_000);
			expect(closed).toBe(false);
			for (const release of releasePendingReads) release();
			await close;
			expect(mocks.getTrackers).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(["later connection", "continuous polling"])(
		"advances through a %s beyond the first collection prefix",
		async (scenario) => {
			vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
			const hashes = Array.from({ length: 129 }, (_, i) => `forward-${i}`);
			let entered = () => {};
			const instances = ["qui-1", ...(scenario === "later connection" ? ["qui-2"] : [])];
			prisma.serviceInstance.findMany.mockResolvedValue(
				instances.map((id) => ({
					id,
					enabled: true,
					hasLocalFilesystemAccess: true,
					connectionGeneration: 0,
					identityGeneration: 0,
					pathPrefix: null,
				})),
			);
			mocks.getHashes.mockResolvedValue({ hashes, pathVerified: true, correlationComplete: true });
			mocks.getCachedTorrents.mockImplementation(async () => {
				entered();
				return hashes.map((hash) => ({ hash, instanceId: 3 }));
			});
			mocks.createClient.mockImplementation((_app: unknown, instance: { id: string }) => ({
				getTrackers: async (_id: number, hash: string) => {
					await new Promise((resolve) => setTimeout(resolve, 700));
					return [{ url: `https://${instance.id}-${hash}.invalid/a` }];
				},
			}));
			try {
				let final: unknown;
				for (let i = 0; i < (scenario === "later connection" ? 6 : 3); i++) {
					const listEntered = new Promise<void>((resolve) => {
						entered = resolve;
					});
					const response = summary();
					await Promise.race([listEntered, response.then(() => {})]);
					await vi.advanceTimersByTimeAsync(1_200);
					final = (await response).json();
					await vi.advanceTimersByTimeAsync(scenario === "continuous polling" ? 61_000 : 3_000);
				}
				expect(final).toMatchObject({
					status: "available",
					summaries: {
						"arr-1|movie:1": {
							trackerCount: scenario === "later connection" ? 258 : 129,
							hashCount: 129,
						},
					},
				});
			} finally {
				await vi.runOnlyPendingTimersAsync();
				vi.useRealTimers();
			}
		},
	);

	it("observes a late provider rejection and retries after the partial-result lease", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
		let rejectRead = (_error: Error) => {};
		mocks.getTrackers.mockReturnValueOnce(
			new Promise((_resolve, reject) => {
				rejectRead = reject;
			}),
		);
		try {
			expect((await boundedPoll()).json()).toMatchObject({ status: "building" });
			rejectRead(new Error("synthetic late failure"));
			await vi.advanceTimersByTimeAsync(0);
			expect((await summary()).json()).toMatchObject({ status: "partial" });
			await vi.advanceTimersByTimeAsync(60_001);
			expect((await summary()).json()).toMatchObject({
				status: "available",
				summaries: { "arr-1|movie:1": { trackerCount: 1 } },
			});
			expect(mocks.getTrackers).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not renew resumed exact observations at aggregate completion", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
		mocks.getTrackers.mockReturnValueOnce(deferredRead([{ url: "https://old.invalid/a" }]));
		try {
			const firstAt = Date.now();
			expect((await boundedPoll()).json()).toMatchObject({ status: "building" });
			for (const release of releasePendingReads) release();
			await vi.advanceTimersByTimeAsync(60_000);
			expect((await summary()).json()).toMatchObject({ status: "available" });
			vi.setSystemTime(firstAt + 600_001);
			expect((await summary()).json()).toMatchObject({
				status: "available",
				summaries: { "arr-1|movie:1": { topHosts: ["tracker.invalid"] } },
			});
			expect(mocks.getTrackers).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps overlapping-page pending evidence a lower bound and isolates another user", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
		mocks.getTrackers.mockReturnValueOnce(deferredRead([{ url: "https://first.invalid/a" }]));
		try {
			expect((await boundedPoll()).json()).toMatchObject({ status: "building" });
			const otherItem = { ...item, arrInstanceId: "arr-2" };
			expect((await boundedPoll(otherItem)).json()).toMatchObject({ status: "building" });
			for (const release of releasePendingReads) release();
			await vi.advanceTimersByTimeAsync(0);
			expect((await summary(otherItem)).json()).toMatchObject({
				status: "partial",
				summaries: { "arr-2|movie:1": { trackerCount: 1, topHosts: ["first.invalid"] } },
			});
			expect((await summary()).json()).toMatchObject({ status: "available" });
			authenticatedUser.id = "user-2";
			expect((await summary()).json()).toMatchObject({
				status: "available",
				summaries: { "arr-1|movie:1": { topHosts: ["tracker.invalid"] } },
			});
			expect(mocks.getTrackers).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		"idle eviction",
		"generation",
		"path mapping",
		"disabled",
		"movie path",
		"hashes",
		"coverage",
		"series receipt",
	])("invalidates resumable observations after changed %s", async (change) => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
		const requested = change === "series receipt" ? seriesItem : item;
		const cachedAt = new Date();
		const files = [{ arrEpisodeFileId: 10, path: "/synthetic/episode.mkv", size: 100n }];
		const row = {
			instanceId: "arr-1",
			arrItemId: 2,
			cachedAt,
			episodeFileInventoryReceipt: createEpisodeFileInventoryReceipt(cachedAt, files, {
				episodeWithFileCount: 1,
				sizeOnDisk: 100n,
			}),
		};
		seriesRows.mockResolvedValue([row]);
		episodeRows.mockResolvedValue(files);
		mocks.getTrackers.mockReturnValueOnce(deferredRead([{ url: "https://old.invalid/a" }]));
		try {
			expect((await boundedPoll(requested)).json()).toMatchObject({ status: "building" });
			for (const release of releasePendingReads) release();
			await vi.advanceTimersByTimeAsync(0);
			if (change === "idle eviction") await vi.advanceTimersByTimeAsync(120_001);
			if (change === "generation" || change === "path mapping") {
				prisma.serviceInstance.findMany.mockResolvedValue([
					{
						id: "qui-1",
						enabled: true,
						hasLocalFilesystemAccess: true,
						connectionGeneration: change === "generation" ? 1 : 0,
						identityGeneration: 0,
						pathPrefix: change === "path mapping" ? "/old>/new" : null,
					},
				]);
			}
			if (change === "disabled") {
				prisma.serviceInstance.findMany.mockResolvedValueOnce([]);
				expect((await summary()).json()).toMatchObject({ status: "not-configured" });
			}
			if (change === "movie path")
				movieRow.mockResolvedValue({
					data: JSON.stringify({ path: "/changed", movieFile: { relativePath: "file" } }),
				});
			if (change === "hashes") {
				mocks.getHashes.mockResolvedValue({
					hashes: ["new-hash"],
					pathVerified: true,
					correlationComplete: true,
				});
				mocks.getCachedTorrents.mockResolvedValue([{ hash: "new-hash", instanceId: 3 }]);
			}
			if (change === "coverage")
				mocks.getHashes.mockResolvedValue({
					hashes: ["synthetic-hash"],
					pathVerified: false,
					correlationComplete: false,
				});
			if (change === "series receipt")
				seriesRows.mockResolvedValue([
					{
						...row,
						episodeFileInventoryReceipt: null,
					},
				]);
			const response = await summary(requested);
			const partial = change === "coverage" || change === "series receipt";
			expect(response.json()).toMatchObject({ status: partial ? "partial" : "available" });
			if (!partial) {
				expect(response.json().summaries["arr-1|movie:1"].topHosts).toEqual(["tracker.invalid"]);
				expect(mocks.getTrackers).toHaveBeenCalledTimes(2);
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("drains actual admitted reads on close without starting a later batch", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
		const hashes = Array.from({ length: 40 }, (_, i) => `close-${i}`);
		mocks.getHashes.mockResolvedValue({ hashes, pathVerified: true, correlationComplete: true });
		mocks.getCachedTorrents.mockResolvedValue(hashes.map((hash) => ({ hash, instanceId: 3 })));
		mocks.getTrackers.mockImplementation(() => deferredRead([]));
		let entered = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		mocks.getTrackers.mockImplementation(() => {
			entered();
			return deferredRead([]);
		});
		try {
			const response = summary();
			await started;
			await vi.advanceTimersByTimeAsync(1_200);
			expect((await response).json()).toMatchObject({ status: "building" });
			let closed = false;
			const close = app.close().then(() => {
				closed = true;
			});
			await vi.advanceTimersByTimeAsync(10_000);
			expect(closed).toBe(false);
			expect(mocks.getTrackers).toHaveBeenCalledTimes(32);
			for (const release of releasePendingReads) release();
			await close;
			expect(closed).toBe(true);
			expect(mocks.getTrackers).toHaveBeenCalledTimes(32);
		} finally {
			vi.useRealTimers();
		}
	});

	it("shares same-page collection progress across concurrent requests", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
		const hashes = Array.from({ length: 65 }, (_, index) => `concurrent-${index}`);
		mocks.getHashes.mockResolvedValue({ hashes, pathVerified: true, correlationComplete: true });
		let entered = () => {};
		mocks.getCachedTorrents.mockImplementation(async () => {
			entered();
			return hashes.map((hash) => ({ hash, instanceId: 3 }));
		});
		mocks.getTrackers.mockImplementation(async (_id: number, hash: string) => {
			await new Promise((resolve) => setTimeout(resolve, 700));
			return [{ url: `https://${hash}.invalid/announce` }];
		});
		try {
			const listEntered = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const requests = [summary(), summary(), summary()];
			await listEntered;
			await vi.advanceTimersByTimeAsync(1_200);
			for (const response of await Promise.all(requests))
				expect(response.json()).toMatchObject({ status: "building" });
			await vi.advanceTimersByTimeAsync(3_000);
			const nextEntered = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const final = summary();
			await nextEntered;
			await vi.advanceTimersByTimeAsync(1_200);
			expect((await final).json()).toMatchObject({
				status: "available",
				summaries: { "arr-1|movie:1": { trackerCount: 65, hashCount: 65 } },
			});
			expect(mocks.getTrackers).toHaveBeenCalledTimes(65);
		} finally {
			await vi.runOnlyPendingTimersAsync();
			vi.useRealTimers();
		}
	});

	it.each([true, false])(
		"eventually visits healthy tracker hashes across bounded polls when initial coverage is %s",
		async (initiallyComplete) => {
			vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
			const hashes = Array.from({ length: 65 }, (_, index) => `polling-hash-${index}`);
			const visited = new Set<string>();
			let listEntered = () => {};
			mocks.buildIndex.mockResolvedValue({
				byFileId: new Map(),
				inventoryComplete: true,
				skippedNoLinks: 0,
				skippedUnstatable: 0,
				incompleteDirectoryWalks: initiallyComplete ? 0 : 1,
			});
			mocks.getHashes.mockResolvedValue({
				hashes,
				pathVerified: true,
				correlationComplete: true,
			});
			mocks.getCachedTorrents.mockImplementation(async () => {
				listEntered();
				return hashes.map((hash) => ({ hash, instanceId: 3 }));
			});
			mocks.getTrackers.mockImplementation(async (_instanceId: number, hash: string) => {
				visited.add(hash);
				await new Promise<void>((resolve) => setTimeout(resolve, 700));
				return [{ url: `https://tracker-${hashes.indexOf(hash)}.invalid/announce` }];
			});
			const responses: Array<{
				status: string;
				summaries: Record<string, { trackerCount: number; hashCount: number }>;
			}> = [];
			try {
				for (let poll = 0; poll < 3; poll++) {
					const entered = new Promise<void>((resolve) => {
						listEntered = resolve;
					});
					const responsePromise = summary();
					// Cache hits may settle without entering the provider-list boundary.
					await Promise.race([entered, responsePromise.then(() => {})]);
					await vi.advanceTimersByTimeAsync(1_200);
					const response = await responsePromise;
					expect(response.statusCode).toBe(200);
					responses.push(response.json());
					// Late healthy work settles before the next ordinary three-second poll.
					await vi.advanceTimersByTimeAsync(3_000);
				}
				const final = responses[2]!;
				expect({
					visitedHashes: visited.size,
					reachedLastHash: visited.has("polling-hash-64"),
					status: final.status,
					summary: final.summaries["arr-1|movie:1"],
				}).toMatchObject({
					visitedHashes: 65,
					reachedLastHash: true,
					status: initiallyComplete ? "available" : "partial",
					summary: { trackerCount: 65, hashCount: 65 },
				});
				if (!initiallyComplete)
					expect(responses.every((response) => response.status !== "available")).toBe(true);
			} finally {
				await vi.runOnlyPendingTimersAsync();
				vi.useRealTimers();
			}
		},
	);

	it("preserves the tracker allowance after slow verified file work and caches the settled summary", async () => {
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		mocks.getHashes.mockImplementation(async () => {
			await Promise.resolve();
			now += 1_500;
			return {
				hashes: ["synthetic-hash"],
				pathVerified: true,
				correlationComplete: true,
			};
		});
		try {
			const first = await summary();
			expect(first.statusCode).toBe(200);
			expect(first.json()).toMatchObject({
				status: "available",
				summaries: { "arr-1|movie:1": { trackerCount: 1, hashCount: 1 } },
			});
			const second = await summary();
			expect(second.statusCode).toBe(200);
			expect(second.json()).toEqual(first.json());
			expect(mocks.buildIndex).toHaveBeenCalledTimes(1);
			expect(mocks.getHashes).toHaveBeenCalledTimes(1);
			expect(mocks.getCachedTorrents).toHaveBeenCalledTimes(1);
			expect(mocks.getTrackers).toHaveBeenCalledTimes(1);
		} finally {
			clock.mockRestore();
		}
	});

	it("retains partial coverage after slow verified file work", async () => {
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		mocks.getHashes.mockImplementation(async () => {
			await Promise.resolve();
			now += 1_500;
			return {
				hashes: ["synthetic-hash"],
				pathVerified: true,
				correlationComplete: true,
			};
		});
		seriesRows.mockResolvedValue([
			{
				instanceId: "arr-1",
				arrItemId: 2,
				cachedAt: new Date("2026-01-01T00:00:00.000Z"),
				episodeFileInventoryReceipt: null,
			},
		]);
		episodeRows.mockResolvedValue([
			{ arrEpisodeFileId: 10, path: "/synthetic/episode.mkv", size: 100n },
		]);
		try {
			const response = await summary(seriesItem);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				status: "partial",
				summaries: { "arr-1|series:2": { trackerCount: 1 } },
			});
		} finally {
			clock.mockRestore();
		}
	});

	it.each(["tracker read", "failed torrent list"])(
		"debits %s time across connections while excluding intervening file work",
		async (firstPhase) => {
			vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
			let secondTrackerStarted = () => {};
			const started = new Promise<void>((resolve) => {
				secondTrackerStarted = resolve;
			});
			let releaseTrackers: (trackers: Array<{ url: string }>) => void = () => {};
			const pendingTrackers = new Promise<Array<{ url: string }>>((resolve) => {
				releaseTrackers = resolve;
			});
			prisma.serviceInstance.findMany.mockResolvedValue(
				["qui-1", "qui-2"].map((id) => ({
					id,
					enabled: true,
					hasLocalFilesystemAccess: true,
					connectionGeneration: 0,
					identityGeneration: 0,
					pathPrefix: null,
				})),
			);
			mocks.getHashes.mockImplementation(async () => {
				await Promise.resolve();
				vi.advanceTimersByTime(1_500);
				return {
					hashes: ["synthetic-hash"],
					pathVerified: true,
					correlationComplete: true,
				};
			});
			if (firstPhase === "failed torrent list") {
				mocks.getCachedTorrents.mockImplementationOnce(async () => {
					vi.advanceTimersByTime(800);
					throw new Error("synthetic list outage");
				});
				mocks.createClient.mockImplementation(() => ({
					getTrackers: mocks.getTrackers,
					getTorrentByHash: vi.fn().mockResolvedValue({ instanceId: 3 }),
				}));
			}
			mocks.getTrackers
				.mockImplementationOnce(async () => {
					if (firstPhase === "tracker read") vi.advanceTimersByTime(800);
					return [{ url: "https://tracker.invalid/announce" }];
				})
				.mockImplementationOnce(() => {
					secondTrackerStarted();
					return pendingTrackers;
				});
			try {
				const responsePromise = summary();
				let settled = false;
				void responsePromise.then(() => {
					settled = true;
				});
				await started;
				await vi.advanceTimersByTimeAsync(399);
				expect(settled).toBe(false);
				await vi.advanceTimersByTimeAsync(1);
				const response = await responsePromise;
				expect(response.statusCode).toBe(200);
				expect(response.json()).toMatchObject({
					status: "building",
					summaries: { "arr-1|movie:1": { trackerCount: 1 } },
				});
				expect(mocks.getHashes).toHaveBeenCalledTimes(2);
				expect(mocks.getTrackers).toHaveBeenCalledTimes(2);
				expect(logs).toContainEqual(
					expect.objectContaining({ fileEvidenceMs: 3_000, trackerEvidenceMs: 1_200 }),
				);
			} finally {
				releaseTrackers([{ url: "https://tracker.invalid/announce" }]);
				vi.useRealTimers();
			}
		},
	);

	it("shares the remaining tracker allowance across hash batches after slow file work", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
		const hashes = Array.from({ length: 65 }, (_, index) => `synthetic-hash-${index}`);
		let secondBatchStarted = () => {};
		const started = new Promise<void>((resolve) => {
			secondBatchStarted = resolve;
		});
		mocks.getHashes.mockImplementation(async () => {
			await Promise.resolve();
			vi.advanceTimersByTime(1_500);
			return { hashes, pathVerified: true, correlationComplete: true };
		});
		mocks.getCachedTorrents.mockResolvedValue(hashes.map((hash) => ({ hash, instanceId: 3 })));
		mocks.getTrackers.mockImplementation(async (_instanceId: number, hash: string) => {
			const index = hashes.indexOf(hash);
			if (index === 0) vi.advanceTimersByTime(800);
			if (index >= 32) {
				if (index === 63) secondBatchStarted();
				return deferredRead([]);
			}
			return [{ url: "https://tracker.invalid/announce" }];
		});
		try {
			const responsePromise = summary();
			await started;
			await vi.advanceTimersByTimeAsync(400);
			const response = await responsePromise;
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				status: "building",
				summaries: { "arr-1|movie:1": { trackerCount: 1, hashCount: 65 } },
			});
			expect(mocks.getTrackers).toHaveBeenCalledTimes(64);
			expect(mocks.getTrackers).not.toHaveBeenCalledWith(3, "synthetic-hash-64");
			expect(logs).toContainEqual(
				expect.objectContaining({ fileEvidenceMs: 1_500, trackerEvidenceMs: 1_200 }),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("accounts for a torrent-list timeout in aggregate tracker phase timing", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
		let listStarted = () => {};
		const started = new Promise<void>((resolve) => {
			listStarted = resolve;
		});
		mocks.getCachedTorrents.mockImplementationOnce(() => {
			listStarted();
			return deferredRead([]);
		});
		try {
			const responsePromise = summary();
			await started;
			await vi.advanceTimersByTimeAsync(1_200);
			const response = await responsePromise;
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({ status: "building" });
			expect(mocks.getTrackers).not.toHaveBeenCalled();
			expect(logs).toContainEqual(
				expect.objectContaining({ trackerEvidenceMs: 1_200, trackerEvidencePending: true }),
			);
			const second = await summary();
			expect(second.json()).toMatchObject({
				status: "available",
				summaries: { "arr-1|movie:1": { trackerCount: 1 } },
			});
			expect(mocks.getCachedTorrents).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("checks file evidence across page items concurrently before publishing exact coverage", async () => {
		const evidence = {
			hashes: ["synthetic-hash"],
			pathVerified: true,
			correlationComplete: true,
		};
		let allowFinish = false;
		const pending: Array<(value: typeof evidence) => void> = [];
		mocks.getHashes.mockImplementation(
			() =>
				new Promise<typeof evidence>((resolve) => {
					if (allowFinish) resolve(evidence);
					else pending.push(resolve);
				}),
		);
		const responsePromise = createInjectAuthenticated(app)("POST", "/qui/library-seeding-summary", {
			body: { items: [item, { ...item, itemId: 2 }] },
		});
		try {
			await vi.waitFor(() => expect(mocks.getHashes).toHaveBeenCalledTimes(2), {
				timeout: 300,
				interval: 10,
			});
		} finally {
			allowFinish = true;
			for (const resolve of pending) resolve(evidence);
		}
		const response = await responsePromise;
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ status: "available" });
	});
	it("caps simultaneous file checks across multi-file page items", async () => {
		const files = Array.from({ length: 40 }, (_, index) => ({
			arrEpisodeFileId: index + 1,
			path: `/synthetic/episode-${index + 1}.mkv`,
			size: 100n,
		}));
		episodeRows.mockResolvedValue(files);
		let active = 0;
		let peak = 0;
		mocks.getHashes.mockImplementation(async () => {
			active += 1;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active -= 1;
			return {
				hashes: ["synthetic-hash"],
				pathVerified: true,
				correlationComplete: true,
			};
		});
		const response = await createInjectAuthenticated(app)("POST", "/qui/library-seeding-summary", {
			body: { items: [seriesItem, { ...seriesItem, itemId: 3 }] },
		});
		expect(response.statusCode).toBe(200);
		expect(mocks.getHashes).toHaveBeenCalledTimes(80);
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThanOrEqual(64);
	});

	it("never calls a partially populated series file cache exact", async () => {
		seriesRows.mockResolvedValue([
			{
				instanceId: "arr-1",
				arrItemId: 2,
				cachedAt: new Date("2026-01-01T00:00:00.000Z"),
				episodeFileInventoryReceipt: null,
			},
		]);
		episodeRows.mockResolvedValue([
			{ arrEpisodeFileId: 10, path: "/synthetic/episode.mkv", size: 100n },
		]);
		const response = await summary(seriesItem);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			status: "partial",
			summaries: { "arr-1|series:2": { trackerCount: 1 } },
		});
	});

	it("calls a series exact only when its same-snapshot receipt matches every cached file", async () => {
		const cachedAt = new Date("2026-01-02T00:00:00.000Z");
		const files = [
			{ arrEpisodeFileId: 10, path: "/synthetic/episode-a.mkv", size: 100n },
			{ arrEpisodeFileId: 11, path: "/synthetic/episode-b.mkv", size: 200n },
		];
		seriesRows.mockResolvedValue([
			{
				instanceId: "arr-1",
				arrItemId: 2,
				cachedAt,
				episodeFileInventoryReceipt: createEpisodeFileInventoryReceipt(cachedAt, files, {
					episodeWithFileCount: 3,
					sizeOnDisk: 300n,
				}),
			},
		]);
		episodeRows.mockResolvedValue(files);
		const response = await summary(seriesItem);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			status: "available",
			summaries: { "arr-1|series:2": { trackerCount: 1 } },
		});
		seriesRows.mockResolvedValue([
			{
				instanceId: "arr-1",
				arrItemId: 2,
				cachedAt,
				episodeFileInventoryReceipt: null,
			},
		]);
		expect((await summary(seriesItem)).json()).toMatchObject({ status: "partial" });
	});
	it("distinguishes an unconfigured connection from a verified empty tracker result", async () => {
		prisma.serviceInstance.findMany.mockResolvedValue([]);
		const response = await summary();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ status: "not-configured", summaries: {} });
	});

	it("reports an enabled connection without filesystem access as unavailable", async () => {
		prisma.serviceInstance.findMany.mockResolvedValue([
			{ id: "qui-1", enabled: true, hasLocalFilesystemAccess: false },
		]);
		const response = await summary();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ status: "unavailable", summaries: {} });
	});

	it("shows a pending index as building instead of caching a false empty result", async () => {
		mocks.buildIndex.mockReturnValue(new Promise(() => {}));
		const response = await summary();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ status: "building", summaries: {} });
	}, 10_000);

	it("marks tracker failures partial and retries instead of caching a false zero", async () => {
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			mocks.getTrackers.mockRejectedValueOnce(new Error("synthetic outage"));
			const first = await summary();
			expect(first.statusCode).toBe(200);
			expect(first.json()).toMatchObject({ status: "partial", summaries: {} });

			const second = await summary();
			expect(second.statusCode).toBe(200);
			expect(second.json()).toMatchObject({ status: "partial" });
			expect(mocks.getTrackers).toHaveBeenCalledTimes(1);
			now += 60_001;
			const third = await summary();
			expect(third.statusCode).toBe(200);
			expect(third.json()).toMatchObject({
				status: "available",
				summaries: { "arr-1|movie:1": { trackerCount: 1 } },
			});
			expect(mocks.getTrackers).toHaveBeenCalledTimes(2);
		} finally {
			clock.mockRestore();
		}
	});

	it("reuses successful per-hash tracker evidence across partial-page retries only within its lease", async () => {
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			mocks.buildIndex.mockResolvedValue({
				byFileId: new Map(),
				inventoryComplete: true,
				skippedNoLinks: 0,
				skippedUnstatable: 0,
				incompleteDirectoryWalks: 1,
			});
			expect((await summary()).json()).toMatchObject({ status: "partial" });
			expect(mocks.getTrackers).toHaveBeenCalledTimes(1);
			now += 60_001;
			expect((await summary()).json()).toMatchObject({ status: "partial" });
			expect(mocks.getTrackers).toHaveBeenCalledTimes(1);
			now += 5 * 60_000;
			expect((await summary()).json()).toMatchObject({ status: "partial" });
			expect(mocks.getTrackers).toHaveBeenCalledTimes(2);
		} finally {
			clock.mockRestore();
		}
	});

	it("returns a bounded building state while slow partial tracker evidence warms", async () => {
		mocks.buildIndex.mockResolvedValue({
			byFileId: new Map(),
			inventoryComplete: true,
			skippedNoLinks: 0,
			skippedUnstatable: 0,
			incompleteDirectoryWalks: 1,
		});
		let releaseTrackers: (trackers: Array<{ url: string }>) => void = () => {};
		mocks.getTrackers.mockReturnValueOnce(
			new Promise<Array<{ url: string }>>((resolve) => {
				releaseTrackers = resolve;
			}),
		);

		const startedAt = performance.now();
		const first = await summary();
		expect(performance.now() - startedAt).toBeLessThan(2_500);
		expect(first.json()).toMatchObject({ status: "building", summaries: {} });
		releaseTrackers([{ url: "https://tracker.invalid/announce" }]);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const second = await summary();
		expect(second.json()).toMatchObject({
			status: "partial",
			summaries: { "arr-1|movie:1": { trackerCount: 1 } },
		});
		expect(mocks.getTrackers).toHaveBeenCalledTimes(1);
	});

	it("does not start another tracker batch while a partial batch is still pending", async () => {
		mocks.buildIndex.mockResolvedValue({
			byFileId: new Map(),
			inventoryComplete: true,
			skippedNoLinks: 0,
			skippedUnstatable: 0,
			incompleteDirectoryWalks: 1,
		});
		const hashes = Array.from({ length: 40 }, (_, index) => `synthetic-hash-${index}`);
		mocks.getHashes.mockResolvedValue({
			hashes,
			pathVerified: true,
			correlationComplete: true,
		});
		mocks.getCachedTorrents.mockResolvedValue(hashes.map((hash) => ({ hash, instanceId: 3 })));
		mocks.getTrackers.mockImplementation(() => deferredRead([]));

		const response = await summary();
		expect(response.json()).toMatchObject({ status: "building" });
		expect(mocks.getTrackers).toHaveBeenCalledTimes(32);
	});

	it.each([
		["backward", -60_000],
		["forward", 60_000],
	] as const)(
		"keeps the tracker budget when the wall clock moves %s",
		async (_direction, shiftMs) => {
			vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
			vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
			let enteredList = () => {};
			const listStarted = new Promise<void>((resolve) => {
				enteredList = resolve;
			});
			mocks.getCachedTorrents.mockImplementationOnce(async () => {
				vi.setSystemTime(Date.now() + shiftMs);
				enteredList();
				return [{ hash: "synthetic-hash", instanceId: 3 }];
			});
			mocks.getTrackers.mockReturnValueOnce(deferredRead([]));
			let settled = false;
			const pending = summary().then((response) => {
				settled = true;
				return response;
			});
			try {
				await listStarted;
				await vi.advanceTimersByTimeAsync(0);
				expect(settled).toBe(false);
				await vi.advanceTimersByTimeAsync(1_199);
				expect(settled).toBe(false);
				await vi.advanceTimersByTimeAsync(1);
				expect(settled).toBe(true);
				const response = await pending;
				expect(response.statusCode).toBe(200);
				expect(response.json()).toMatchObject({ status: "building", summaries: {} });
			} finally {
				for (const release of releasePendingReads) release();
				try {
					await vi.advanceTimersByTimeAsync(0);
					await pending;
				} finally {
					mocks.getTrackers.mockReset();
					vi.useRealTimers();
				}
			}
		},
	);

	it("bounds a slow tracker read even when inode coverage began complete", async () => {
		mocks.getTrackers.mockReturnValueOnce(deferredRead([]));
		const startedAt = performance.now();
		const response = await summary();
		expect(performance.now() - startedAt).toBeLessThan(2_500);
		expect(response.json()).toMatchObject({ status: "building", summaries: {} });
	});

	it("resumes its own timed-out tracker read as exact only after it settles", async () => {
		let releaseTrackers: (trackers: Array<{ url: string }>) => void = () => {};
		mocks.getTrackers.mockReturnValueOnce(
			new Promise<Array<{ url: string }>>((resolve) => {
				releaseTrackers = resolve;
			}),
		);

		expect((await summary()).json()).toMatchObject({ status: "building" });
		expect((await summary()).json()).toMatchObject({ status: "building" });
		expect(mocks.getTrackers).toHaveBeenCalledTimes(1);
		releaseTrackers([{ url: "https://tracker.invalid/announce" }]);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect((await summary()).json()).toMatchObject({ status: "available" });
		expect(mocks.getTrackers).toHaveBeenCalledTimes(1);
	});

	it("shares one tracker deadline across filesystem-enabled qUI connections", async () => {
		prisma.serviceInstance.findMany.mockResolvedValue([
			{
				id: "qui-1",
				enabled: true,
				hasLocalFilesystemAccess: true,
				connectionGeneration: 0,
				identityGeneration: 0,
				pathPrefix: null,
			},
			{
				id: "qui-2",
				enabled: true,
				hasLocalFilesystemAccess: true,
				connectionGeneration: 0,
				identityGeneration: 0,
				pathPrefix: null,
			},
		]);
		mocks.buildIndex.mockResolvedValue({
			byFileId: new Map(),
			inventoryComplete: true,
			skippedNoLinks: 0,
			skippedUnstatable: 0,
			incompleteDirectoryWalks: 1,
		});
		mocks.getTrackers.mockImplementation(() => deferredRead([]));

		const startedAt = performance.now();
		const response = await summary();
		expect(performance.now() - startedAt).toBeLessThan(2_500);
		expect(response.json()).toMatchObject({ status: "building" });
		expect(mocks.getTrackers).toHaveBeenCalledTimes(1);
	});

	it("invalidates per-hash tracker evidence when a qUI connection generation changes", async () => {
		expect((await summary()).json()).toMatchObject({ status: "available" });
		expect(mocks.getTrackers).toHaveBeenCalledTimes(1);
		prisma.serviceInstance.findMany.mockResolvedValue([
			{
				id: "qui-1",
				userId: "test-user",
				service: "QUI",
				enabled: true,
				hasLocalFilesystemAccess: true,
				connectionGeneration: 1,
				identityGeneration: 0,
				pathPrefix: null,
			},
		]);
		expect((await summary()).json()).toMatchObject({ status: "available" });
		expect(mocks.getTrackers).toHaveBeenCalledTimes(2);
	});

	it("fetches live tracker evidence before promoting a previously partial scope to exact", async () => {
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			mocks.buildIndex.mockResolvedValueOnce({
				byFileId: new Map(),
				inventoryComplete: true,
				skippedNoLinks: 0,
				skippedUnstatable: 0,
				incompleteDirectoryWalks: 1,
			});
			expect((await summary()).json()).toMatchObject({ status: "partial" });
			expect(mocks.getTrackers).toHaveBeenCalledTimes(1);
			now += 60_001;
			expect((await summary()).json()).toMatchObject({ status: "available" });
			expect(mocks.getTrackers).toHaveBeenCalledTimes(2);
		} finally {
			clock.mockRestore();
		}
	});

	it("keeps a verified positive as a lower bound when a sibling hash fails", async () => {
		mocks.getHashes.mockResolvedValue({
			hashes: ["synthetic-hash", "other-hash"],
			pathVerified: true,
			correlationComplete: true,
		});
		mocks.getCachedTorrents.mockResolvedValue([
			{ hash: "synthetic-hash", instanceId: 3 },
			{ hash: "other-hash", instanceId: 3 },
		]);
		mocks.getTrackers.mockImplementation(async (_instanceId: number, hash: string) => {
			if (hash === "other-hash") throw new Error("synthetic outage");
			return [{ url: "https://tracker.invalid/announce" }];
		});
		const response = await summary();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			status: "partial",
			summaries: { "arr-1|movie:1": { trackerCount: 1 } },
		});
	});

	it("does not cache exact counts from an incomplete or legacy inode index", async () => {
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			mocks.buildIndex.mockResolvedValueOnce({
				byFileId: new Map(),
				inventoryComplete: false,
				skippedNoLinks: 0,
				skippedUnstatable: 1,
				incompleteDirectoryWalks: 0,
			});
			const first = await summary();
			expect(first.json()).toMatchObject({ status: "partial" });
			now += 60_001;
			const second = await summary();
			expect(second.json()).toMatchObject({ status: "available" });
			expect(mocks.buildIndex).toHaveBeenCalledTimes(2);
		} finally {
			clock.mockRestore();
		}
	});

	it("marks an unreadable media path partial instead of a verified zero", async () => {
		mocks.getHashes.mockResolvedValue({
			hashes: [],
			pathVerified: false,
			correlationComplete: false,
		});
		expect((await summary()).json()).toMatchObject({ status: "partial" });
	});

	it("does not downgrade a correlated item for an unrelated single-link torrent", async () => {
		mocks.buildIndex.mockResolvedValue({
			byFileId: new Map(),
			inventoryComplete: true,
			skippedNoLinks: 1,
			skippedUnstatable: 0,
			incompleteDirectoryWalks: 0,
		});
		expect((await summary()).json()).toMatchObject({
			status: "available",
			summaries: { "arr-1|movie:1": { trackerCount: 1 } },
		});
	});

	it("marks an individual single-link target partial", async () => {
		mocks.getHashes.mockResolvedValue({
			hashes: [],
			pathVerified: true,
			correlationComplete: false,
		});
		expect((await summary()).json()).toMatchObject({ status: "partial" });
	});

	it("invalidates a complete server cache when qUI is disabled", async () => {
		expect((await summary()).json()).toMatchObject({ status: "available" });
		prisma.serviceInstance.findMany.mockResolvedValue([]);
		expect((await summary()).json()).toMatchObject({
			status: "not-configured",
			summaries: {},
		});
	});

	it("invalidates an exact cache if another enabled qUI connection lacks filesystem access", async () => {
		expect((await summary()).json()).toMatchObject({ status: "available" });
		prisma.serviceInstance.findMany.mockResolvedValue([
			{
				id: "qui-1",
				enabled: true,
				hasLocalFilesystemAccess: true,
				connectionGeneration: 0,
				identityGeneration: 0,
				pathPrefix: null,
			},
			{
				id: "qui-2",
				enabled: true,
				hasLocalFilesystemAccess: false,
				connectionGeneration: 0,
				identityGeneration: 0,
				pathPrefix: null,
			},
		]);
		expect((await summary()).json()).toMatchObject({ status: "partial" });
	});

	it("combines distinct tracker hosts from two filesystem-enabled qUI connections", async () => {
		prisma.serviceInstance.findMany.mockResolvedValue([
			{
				id: "qui-1",
				enabled: true,
				hasLocalFilesystemAccess: true,
				connectionGeneration: 0,
				identityGeneration: 0,
				pathPrefix: null,
			},
			{
				id: "qui-2",
				enabled: true,
				hasLocalFilesystemAccess: true,
				connectionGeneration: 0,
				identityGeneration: 0,
				pathPrefix: null,
			},
		]);
		mocks.getTrackers
			.mockResolvedValueOnce([{ url: "https://tracker-one.invalid/announce" }])
			.mockResolvedValueOnce([{ url: "https://tracker-two.invalid/announce" }]);
		const response = await summary();
		expect(response.json()).toMatchObject({
			status: "available",
			summaries: { "arr-1|movie:1": { trackerCount: 2 } },
		});
	});

	it("preserves healthy-instance positives when another qUI credential cannot decrypt", async () => {
		prisma.serviceInstance.findMany.mockResolvedValue([
			{
				id: "qui-1",
				enabled: true,
				hasLocalFilesystemAccess: true,
				connectionGeneration: 0,
				identityGeneration: 0,
				pathPrefix: null,
			},
			{
				id: "qui-2",
				enabled: true,
				hasLocalFilesystemAccess: true,
				connectionGeneration: 0,
				identityGeneration: 0,
				pathPrefix: null,
			},
		]);
		mocks.createClient.mockImplementation((_app: unknown, instance: { id: string }) => {
			if (instance.id === "qui-2") throw new Error("synthetic decrypt failure");
			return { getTrackers: mocks.getTrackers, getTorrentByHash: vi.fn() };
		});
		const response = await summary();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			status: "partial",
			summaries: { "arr-1|movie:1": { trackerCount: 1 } },
		});
	});
});
