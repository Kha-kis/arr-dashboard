import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceInstance } from "../../prisma.js";
import { prewarmAllSequential, prewarmInstance } from "../cache-prewarm.js";
import { createQuiClient, type QuiClient, type QuiTorrentInventory } from "../client-factory.js";
import * as cache from "../torrent-list-cache.js";

const logger = { info: vi.fn(), warn: vi.fn() };
const cleanups: Array<() => void> = [];
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function settle() {
	for (let i = 0; i < 8; i++) await new Promise<void>((done) => setImmediate(done));
}
function client(read: QuiClient["listTorrentInventory"]): QuiClient {
	return { listTorrentInventory: read } as QuiClient;
}
const inventory = (): QuiTorrentInventory => ({ torrents: [], complete: true });
const warm = (id: string, provider: QuiClient, signal: AbortSignal, now?: () => number) =>
	cache.prewarmTorrentList(id, provider, signal, now);
function start(provider: QuiClient, id = "synthetic-a") {
	let timeout!: () => void;
	let finished = false;
	const work = prewarmInstance(
		{ id, label: "Synthetic" },
		{
			createClient: () => provider,
			getCachedAllTorrents: (key, supplied, signal?: AbortSignal) =>
				warm(key, supplied, signal ?? new AbortController().signal),
			timeoutMs: 60_000,
			logger,
			setTimer: (callback) => {
				timeout = callback;
				return {};
			},
			clearTimer: () => {},
		},
	).then(() => {
		finished = true;
	});
	return { work, timeout: () => timeout(), finished: () => finished };
}
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	cache.invalidateTorrentListCache();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("qUI pre-warm actual fetch lifetime", () => {
	it("does not report a timed-out wrapper finished while an abort-ignoring provider still runs", async () => {
		const held = deferred<QuiTorrentInventory>();
		cleanups.push(() => held.resolve(inventory()));
		const run = start(client(() => held.promise));
		run.timeout();
		await settle();
		try {
			expect(run.finished()).toBe(false);
			expect(cache.__torrentListCacheState().pending).toBe(1);
		} finally {
			held.resolve(inventory());
			await run.work;
		}
		expect(cache.__torrentListCacheState()).toEqual({ cached: 0, pending: 0 });
		expect(logger.info).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledOnce();
	});
	it("does not start the next instance before a timed-out underlying read settles", async () => {
		const held = deferred<QuiTorrentInventory>();
		cleanups.push(() => held.resolve(inventory()));
		let timeout!: () => void;
		const starts: string[] = [];
		const walk = prewarmAllSequential(
			[
				{ id: "a", label: "Same" },
				{ id: "b", label: "Same" },
			],
			{
				isCancelled: () => false,
				logger,
				prewarmOne: (instance) =>
					prewarmInstance(instance, {
						createClient: () =>
							client(() => {
								starts.push(instance.id);
								return instance.id === "a" ? held.promise : Promise.resolve(inventory());
							}),
						getCachedAllTorrents: (id, provider, signal?: AbortSignal) =>
							warm(id, provider, signal ?? new AbortController().signal),
						timeoutMs: 60_000,
						logger,
						setTimer: (callback) => {
							if (instance.id === "a") timeout = callback;
							return {};
						},
						clearTimer: () => {},
					}),
			},
		);
		timeout();
		await settle();
		try {
			expect(starts).toEqual(["a"]);
		} finally {
			held.resolve(inventory());
			await walk;
		}
		expect(starts).toEqual(["a", "b"]);
		expect(cache.__torrentListCacheState()).toEqual({ cached: 1, pending: 0 });
	});
	it("awaits stale revalidation while ordinary UI readers still get last-known immediately", async () => {
		let clock = 1_000_000;
		await cache.getCachedAllTorrents(
			"a",
			client(async () => inventory()),
			() => clock,
		);
		clock += 300_001;
		const held = deferred<QuiTorrentInventory>();
		cleanups.push(() => held.resolve(inventory()));
		const provider = client(() => held.promise);
		let finished = false;
		const work = warm("a", provider, new AbortController().signal, () => clock).then(() => {
			finished = true;
		});
		await settle();
		try {
			expect(await cache.getTorrentListObservation("a", provider, () => clock)).toMatchObject({
				availability: "last-known",
				fetchedAtMs: 1_000_000,
			});
			expect(finished).toBe(false);
		} finally {
			held.resolve(inventory());
			await work;
		}
		expect(await cache.getTorrentListObservation("a", provider, () => clock)).toMatchObject({
			availability: "current",
			fetchedAtMs: 1_300_001,
		});
	});
	it("does not cancel a user-started flight when a joining pre-warm times out", async () => {
		const held = deferred<QuiTorrentInventory>();
		cleanups.push(() => held.resolve(inventory()));
		const observedSignals: Array<AbortSignal | undefined> = [];
		const provider = client((options) => {
			observedSignals.push(options?.signal);
			return held.promise;
		});
		const userRead = cache.getCachedAllTorrents("synthetic-a", provider);
		const run = start(provider);
		run.timeout();
		await settle();
		try {
			expect(run.finished()).toBe(false);
			expect(observedSignals).toEqual([undefined]);
		} finally {
			held.resolve(inventory());
			await Promise.all([run.work, userRead]);
		}
		expect(cache.__torrentListCacheState()).toEqual({ cached: 1, pending: 0 });
		expect(logger.info).not.toHaveBeenCalled();
	});
	it("preserves a pre-warm-started flight when a user joins before its deadline", async () => {
		const held = deferred<QuiTorrentInventory>();
		cleanups.push(() => held.resolve(inventory()));
		const run = start(client(() => held.promise));
		const user = cache.getTorrentListObservation(
			"synthetic-a",
			client(() => {
				throw new Error("Must join the existing flight");
			}),
		);
		run.timeout();
		await settle();
		try {
			expect(run.finished()).toBe(false);
		} finally {
			held.resolve(inventory());
			await run.work;
		}
		expect(await user).toMatchObject({ availability: "current", complete: true, torrents: [] });
		expect(cache.__torrentListCacheState()).toEqual({ cached: 1, pending: 0 });
	});
	for (const accessor of ["observation", "array"] as const) {
		it(`keeps deadline cancellation when a stale ${accessor} reader returns immediately`, async () => {
			const publishedAt = Date.now() - 300_001;
			await warm(
				"synthetic-a",
				client(async () => inventory()),
				new AbortController().signal,
				() => publishedAt,
			);
			const held = deferred<QuiTorrentInventory>();
			cleanups.push(() => held.resolve(inventory()));
			let providerSignal: AbortSignal | undefined;
			const provider = client((options) => {
				providerSignal = options?.signal;
				return held.promise;
			});
			const run = start(provider);
			if (accessor === "observation")
				expect(await cache.getTorrentListObservation("synthetic-a", provider)).toMatchObject({
					availability: "last-known",
					fetchedAtMs: publishedAt,
				});
			else expect(await cache.getCachedAllTorrents("synthetic-a", provider)).toEqual([]);
			run.timeout();
			await settle();
			try {
				expect(providerSignal?.aborted).toBe(true);
			} finally {
				held.resolve(inventory());
				await run.work;
			}
			expect(cache.__torrentListCacheState()).toEqual({ cached: 1, pending: 0 });
			expect(logger.info).not.toHaveBeenCalled();
		});
	}
	it("rejects late publication only for the cancelled flight and permits a clean retry", async () => {
		const held = deferred<QuiTorrentInventory>();
		const abort = new AbortController();
		cleanups.push(() => held.resolve(inventory()));
		const cancelled = warm(
			"a",
			client(() => held.promise),
			abort.signal,
		).catch((error) => error);
		await warm(
			"b",
			client(async () => inventory()),
			new AbortController().signal,
		);
		abort.abort(new Error("Synthetic deadline"));
		held.resolve(inventory());
		expect(await cancelled).toBeInstanceOf(Error);
		expect(cache.__torrentListCacheState()).toEqual({ cached: 1, pending: 0 });
		await warm(
			"a",
			client(async () => inventory()),
			new AbortController().signal,
		);
		expect(cache.__torrentListCacheState()).toEqual({ cached: 2, pending: 0 });
	});
	it("retains populated last-known evidence, without renewing freshness, after cancelled revalidation", async () => {
		const row: QuiTorrentInventory["torrents"][number] = {
			hash: "aaaa",
			name: "Synthetic",
			state: "uploading",
			ratio: 1,
			progress: 1,
			numSeeds: 1,
			numLeechs: 0,
			tags: [],
			category: "",
			savePath: "/synthetic",
			addedOn: 0,
			completedOn: 1,
			seedingTime: 1,
			eta: 0,
			dlSpeed: 0,
			upSpeed: 0,
			priority: 0,
			size: 1,
		};
		let clock = 1_000_000;
		const provider = client(async () => ({ torrents: [row], complete: false }));
		await warm("a", provider, new AbortController().signal, () => clock);
		clock = 1_300_001;
		const held = deferred<QuiTorrentInventory>();
		cleanups.push(() => held.resolve(inventory()));
		const abort = new AbortController();
		const work = warm(
			"a",
			client(() => held.promise),
			abort.signal,
			() => clock,
		).catch((error) => error);
		abort.abort();
		held.resolve(inventory());
		expect(await work).toBeInstanceOf(Error);
		const recovery = deferred<QuiTorrentInventory>();
		cleanups.push(() => recovery.resolve(inventory()));
		expect(
			await cache.getTorrentListObservation(
				"a",
				client(() => recovery.promise),
				() => clock,
			),
		).toEqual({
			availability: "last-known",
			torrents: [row],
			fetchedAtMs: 1_000_000,
			complete: false,
		});
		recovery.resolve(inventory());
		await settle();
	});
	it("does not let a cancelled old generation erase a replacement connection's pending slot", async () => {
		const old = deferred<QuiTorrentInventory>(),
			replacement = deferred<QuiTorrentInventory>();
		cleanups.push(() => {
			old.resolve(inventory());
			replacement.resolve(inventory());
		});
		const abort = new AbortController();
		const oldWork = warm(
			"a",
			client(() => old.promise),
			abort.signal,
		).catch((error) => error);
		cache.invalidateTorrentListCache("a");
		const newWork = warm(
			"a",
			client(() => replacement.promise),
			new AbortController().signal,
		);
		abort.abort();
		old.resolve(inventory());
		expect(await oldWork).toBeInstanceOf(Error);
		expect(cache.__torrentListCacheState()).toEqual({ cached: 0, pending: 1 });
		replacement.resolve(inventory());
		await newWork;
		expect(cache.__torrentListCacheState()).toEqual({ cached: 1, pending: 0 });
	});
	it("reuses a fresh cache entry and refuses a cancelled caller without a provider read", async () => {
		await warm(
			"a",
			client(async () => inventory()),
			new AbortController().signal,
		);
		const reads = vi.fn(() => {
			throw new Error("Unnecessary provider read");
		});
		await expect(warm("a", client(reads), new AbortController().signal)).resolves.toEqual([]);
		const abort = new AbortController();
		abort.abort();
		await expect(warm("a", client(reads), abort.signal)).rejects.toThrow();
		expect(reads).not.toHaveBeenCalled();
	});

	for (const phase of ["before", "headers", "body", "between-pages"] as const) {
		it(`aborts the actual paginated client at ${phase} without starting another page`, async () => {
			const abort = new AbortController();
			const held = deferred<Response>();
			let requests = 0;
			const page = () =>
				new Response(
					JSON.stringify({
						cross_instance_torrents: [],
						total: 0,
						hasMore: false,
						partialResults: false,
					}),
					{ status: 200 },
				);
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
				requests++;
				if (phase === "headers") {
					init!.signal!.addEventListener(
						"abort",
						() => held.resolve(Promise.reject(init!.signal!.reason) as never),
						{ once: true },
					);
					return held.promise;
				}
				if (phase === "body") {
					const response = page();
					response.json = async () => {
						await held.promise;
						return { total: 0, hasMore: false, partialResults: false };
					};
					return response;
				}
				if (phase === "between-pages") {
					const response = page();
					response.json = async () => {
						abort.abort(new Error("Synthetic cancel"));
						return {
							cross_instance_torrents: [
								{
									hash: "abc",
									name: "Synthetic",
									state: "uploading",
									ratio: 1,
									progress: 1,
									num_seeds: 1,
									num_leechs: 0,
									save_path: "/synthetic",
									added_on: 0,
									completion_on: 1,
									eta: 0,
									dlspeed: 0,
									upspeed: 0,
									priority: 0,
									size: 1,
									instance_id: 1,
								},
							],
							total: 2,
							hasMore: true,
							partialResults: false,
						};
					};
					return response;
				}
				return page();
			});
			const app = {
				encryptor: { decrypt: () => "synthetic" },
				log: logger,
			} as unknown as FastifyInstance;
			const instance = {
				id: "synthetic",
				baseUrl: "https://synthetic.invalid",
				encryptedApiKey: "synthetic",
				encryptionIv: "synthetic",
				encryptedHttpAuthCredentials: null,
			} as ServiceInstance;
			if (phase === "before") abort.abort();
			const work = createQuiClient(app, instance)
				.listTorrentInventory({ signal: abort.signal })
				.then(
					() => "success",
					() => "cancelled",
				);
			await settle();
			if (phase === "headers" || phase === "body") {
				abort.abort();
				held.resolve(page());
			}
			expect(await work).toBe("cancelled");
			expect(requests).toBe(phase === "before" ? 0 : 1);
			expect(fetchSpy.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
		});
	}
});
