import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuiClient } from "../client-factory.js";
import {
	__torrentListCacheState,
	getCachedAllTorrents,
	invalidateTorrentListCache,
	TORRENT_LIST_CACHE_TTL_MS,
} from "../torrent-list-cache.js";

// Each test starts from a clean cache — module state is process-global.
afterEach(() => {
	invalidateTorrentListCache();
});

/** Minimal QuiClient stub — only listAllTorrents is exercised here. */
function makeClient(listAllTorrents: QuiClient["listAllTorrents"]): QuiClient {
	return { listAllTorrents } as unknown as QuiClient;
}

const torrent = (hash: string) => ({ hash }) as never;

describe("getCachedAllTorrents", () => {
	it("fetches from the client on a cold cache", async () => {
		const listAllTorrents = vi.fn().mockResolvedValue([torrent("a")]);
		const result = await getCachedAllTorrents("qui-1", makeClient(listAllTorrents));
		expect(result).toEqual([torrent("a")]);
		expect(listAllTorrents).toHaveBeenCalledTimes(1);
	});

	it("serves a second call from cache without re-fetching (within TTL)", async () => {
		const listAllTorrents = vi.fn().mockResolvedValue([torrent("a")]);
		const client = makeClient(listAllTorrents);
		let clock = 1_000_000;
		await getCachedAllTorrents("qui-1", client, () => clock);
		clock += TORRENT_LIST_CACHE_TTL_MS - 1; // still inside the window
		await getCachedAllTorrents("qui-1", client, () => clock);
		expect(listAllTorrents).toHaveBeenCalledTimes(1);
	});

	it("re-fetches once the TTL has elapsed", async () => {
		const listAllTorrents = vi.fn().mockResolvedValue([torrent("a")]);
		const client = makeClient(listAllTorrents);
		let clock = 1_000_000;
		await getCachedAllTorrents("qui-1", client, () => clock);
		clock += TORRENT_LIST_CACHE_TTL_MS + 1; // past the window
		await getCachedAllTorrents("qui-1", client, () => clock);
		expect(listAllTorrents).toHaveBeenCalledTimes(2);
	});

	it("dedups concurrent callers onto ONE in-flight fetch", async () => {
		// This is the summary+attention case: both routes call into the
		// cache near-simultaneously on a cold cache. Only one paginated
		// walk should happen.
		let resolveFetch: (v: never[]) => void = () => {};
		const listAllTorrents = vi.fn().mockImplementation(
			() =>
				new Promise<never[]>((resolve) => {
					resolveFetch = resolve;
				}),
		);
		const client = makeClient(listAllTorrents);

		const p1 = getCachedAllTorrents("qui-1", client);
		const p2 = getCachedAllTorrents("qui-1", client);
		// Both callers are now waiting; the fetch ran exactly once.
		expect(listAllTorrents).toHaveBeenCalledTimes(1);
		expect(__torrentListCacheState().pending).toBe(1);

		resolveFetch([torrent("a")] as never[]);
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1).toEqual([torrent("a")]);
		expect(r2).toEqual([torrent("a")]);
		// In-flight slot cleared after resolution.
		expect(__torrentListCacheState().pending).toBe(0);
	});

	it("keys the cache per qui instance — separate instances fetch separately", async () => {
		const listA = vi.fn().mockResolvedValue([torrent("a")]);
		const listB = vi.fn().mockResolvedValue([torrent("b")]);
		const a = await getCachedAllTorrents("qui-A", makeClient(listA));
		const b = await getCachedAllTorrents("qui-B", makeClient(listB));
		expect(a).toEqual([torrent("a")]);
		expect(b).toEqual([torrent("b")]);
		expect(listA).toHaveBeenCalledTimes(1);
		expect(listB).toHaveBeenCalledTimes(1);
	});

	it("does NOT cache a failed fetch — the next call retries", async () => {
		const listAllTorrents = vi
			.fn()
			.mockRejectedValueOnce(new Error("qui unreachable"))
			.mockResolvedValueOnce([torrent("a")]);
		const client = makeClient(listAllTorrents);

		await expect(getCachedAllTorrents("qui-1", client)).rejects.toThrow("qui unreachable");
		// In-flight slot must be cleared after the rejection so the retry
		// isn't permanently wedged.
		expect(__torrentListCacheState().pending).toBe(0);

		const result = await getCachedAllTorrents("qui-1", client);
		expect(result).toEqual([torrent("a")]);
		expect(listAllTorrents).toHaveBeenCalledTimes(2);
	});

	it("invalidateTorrentListCache clears a single instance", async () => {
		const listAllTorrents = vi.fn().mockResolvedValue([torrent("a")]);
		const client = makeClient(listAllTorrents);
		await getCachedAllTorrents("qui-1", client);
		invalidateTorrentListCache("qui-1");
		await getCachedAllTorrents("qui-1", client);
		expect(listAllTorrents).toHaveBeenCalledTimes(2);
	});
});
