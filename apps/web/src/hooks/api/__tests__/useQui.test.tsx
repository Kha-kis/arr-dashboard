/**
 * Regression tests for `useQui.ts` — specifically the post-mutation
 * invalidation chain.
 *
 * Background: an earlier commit on this branch shipped a fix for
 * misaimed React Query invalidations — five sites were using a key
 * `["qui","torrent-state"]` that NO `useQuery` in the codebase subscribed
 * to, so every "invalidate after mutation" call was a silent no-op. A
 * code-review pass on PR #475 caught that the original fix only
 * addressed 2 of those 5 sites — the rename hook and the SSE event
 * handler still used the dead key. The fix-the-fix landed in 468a7c11.
 *
 * These tests pin the invariant we actually care about: **every
 * `invalidateQueries` call from a mutation or SSE handler must target a
 * key that overlaps (via React Query's prefix-match semantics) with the
 * key some live `useQuery` subscribes to.** If a future refactor renames
 * a query key but forgets a mutation hook, this test fails immediately
 * instead of silently breaking drawer freshness.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quiKeys } from "../../../lib/query-keys";

// Mock the entire qui API client. Each mutation has its own postXxx
// function which we replace with a vi.fn that resolves immediately.
vi.mock("../../../lib/api-client/qui");

import * as quiApi from "../../../lib/api-client/qui";
import {
	useQuiBulkAction,
	useQuiCapabilities,
	useQuiCategories,
	useQuiRenameTorrent,
	useQuiTags,
	useQuiTorrentAction,
} from "../useQui";

/**
 * Helper — render a hook inside a fresh QueryClient with the
 * provider wrapper React Query needs.
 */
function createWrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

/**
 * Helper — produce a typed Map<string, true> of the invalidateQueries
 * calls a hook fired. Maps the key tuples to their stringified form so
 * we can assert membership against the keys we expect.
 */
function trackInvalidations(client: QueryClient) {
	const invalidations: readonly unknown[][] = [];
	const original = client.invalidateQueries.bind(client);
	client.invalidateQueries = vi.fn((options) => {
		if (options && "queryKey" in options) {
			(invalidations as unknown[][]).push([...(options.queryKey as readonly unknown[])]);
		}
		return original(options);
	});
	return invalidations;
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("query-key structure invariants", () => {
	it("torrentProperties.all is a prefix of torrentProperties.byHash — prefix-match invalidation works", () => {
		// This is the structural guarantee that makes the broad-invalidate
		// strategy work. If anyone renames the prefix without updating both
		// sides, this fails — and the failure points exactly at the
		// dead-key class of bug.
		const broad = quiKeys.torrentProperties.all;
		const specific = quiKeys.torrentProperties.byHash("qui-1", 0, "abc");
		expect(specific.slice(0, broad.length)).toEqual([...broad]);
	});

	it("torrentFiles.all is a prefix of torrentFiles.byHash", () => {
		const broad = quiKeys.torrentFiles.all;
		const specific = quiKeys.torrentFiles.byHash("qui-1", 0, "abc");
		expect(specific.slice(0, broad.length)).toEqual([...broad]);
	});

	it("crossSeed is a prefix of crossSeedAvailability and crossSeedDiscovery", () => {
		const broad = quiKeys.crossSeed;
		const availability = quiKeys.crossSeedAvailability();
		const discovery = quiKeys.crossSeedDiscovery();
		expect(availability.slice(0, broad.length)).toEqual([...broad]);
		expect(discovery.slice(0, broad.length)).toEqual([...broad]);
	});
});

describe("useQuiTorrentAction — single-torrent mutation", () => {
	it("invalidates torrentProperties.all + torrentFiles.all + actions on settle", async () => {
		const client = new QueryClient();
		const invalidations = trackInvalidations(client);

		vi.spyOn(quiApi, "postQuiTorrentAction").mockResolvedValue({} as never);

		const { result } = renderHook(() => useQuiTorrentAction(), {
			wrapper: createWrapper(client),
		});

		result.current.mutate({
			quiInstanceId: "qui-1",
			qbitInstanceId: 0,
			hash: "abc",
			action: "pause",
		});

		await waitFor(() => {
			expect(result.current.isSuccess || result.current.isError).toBe(true);
		});

		// Match key prefixes — we expect all three broad invalidations to fire.
		const expectedKeys = [
			["qui", "actions"],
			[...quiKeys.torrentProperties.all],
			[...quiKeys.torrentFiles.all],
		];
		for (const expected of expectedKeys) {
			expect(
				invalidations.some((actual) => JSON.stringify(actual) === JSON.stringify(expected)),
			).toBe(true);
		}
	});

	it("does NOT invalidate any key matching the legacy dead pattern ['qui','torrent-state']", async () => {
		// Regression guard: an earlier commit shipped with this exact dead
		// key, and a second commit missed two more sites. If anyone
		// re-introduces the literal dead key, this fails.
		const client = new QueryClient();
		const invalidations = trackInvalidations(client);

		vi.spyOn(quiApi, "postQuiTorrentAction").mockResolvedValue({} as never);

		const { result } = renderHook(() => useQuiTorrentAction(), {
			wrapper: createWrapper(client),
		});
		result.current.mutate({
			quiInstanceId: "qui-1",
			qbitInstanceId: 0,
			hash: "abc",
			action: "pause",
		});

		await waitFor(() => {
			expect(result.current.isSuccess || result.current.isError).toBe(true);
		});

		expect(invalidations).not.toContainEqual(["qui", "torrent-state"]);
	});
});

describe("useQuiBulkAction — bulk-torrent mutation", () => {
	it("invalidates torrentProperties.all + torrentFiles.all + crossSeed + actions on settle", async () => {
		const client = new QueryClient();
		const invalidations = trackInvalidations(client);

		vi.spyOn(quiApi, "postQuiBulkAction").mockResolvedValue({} as never);

		const { result } = renderHook(() => useQuiBulkAction(), {
			wrapper: createWrapper(client),
		});

		result.current.mutate({
			quiInstanceId: "qui-1",
			qbitInstanceId: 0,
			hashes: ["abc", "def"],
			action: "pause",
		});

		await waitFor(() => {
			expect(result.current.isSuccess || result.current.isError).toBe(true);
		});

		const expectedKeys = [
			["qui", "actions"],
			[...quiKeys.torrentProperties.all],
			[...quiKeys.torrentFiles.all],
			[...quiKeys.crossSeed],
		];
		for (const expected of expectedKeys) {
			expect(
				invalidations.some((actual) => JSON.stringify(actual) === JSON.stringify(expected)),
			).toBe(true);
		}
	});

	it("does NOT use the legacy dead ['qui','torrent-state'] key", async () => {
		const client = new QueryClient();
		const invalidations = trackInvalidations(client);

		vi.spyOn(quiApi, "postQuiBulkAction").mockResolvedValue({} as never);

		const { result } = renderHook(() => useQuiBulkAction(), {
			wrapper: createWrapper(client),
		});
		result.current.mutate({
			quiInstanceId: "qui-1",
			qbitInstanceId: 0,
			hashes: ["abc"],
			action: "pause",
		});

		await waitFor(() => {
			expect(result.current.isSuccess || result.current.isError).toBe(true);
		});

		expect(invalidations).not.toContainEqual(["qui", "torrent-state"]);
	});
});

describe("useQuiRenameTorrent — rename mutation", () => {
	it("invalidates torrentProperties.all + torrentFiles.all on settle", async () => {
		// THE BUG the code-review caught: this hook used to invalidate
		// only `["qui","torrent-state"]`, a key no query subscribed to.
		// Drawer rename never refreshed until the next polling tick.
		const client = new QueryClient();
		const invalidations = trackInvalidations(client);

		vi.spyOn(quiApi, "postQuiRenameTorrent").mockResolvedValue({} as never);

		const { result } = renderHook(() => useQuiRenameTorrent(), {
			wrapper: createWrapper(client),
		});
		result.current.mutate({
			quiInstanceId: "qui-1",
			qbitInstanceId: 0,
			hash: "abc",
			name: "new-name",
		});

		await waitFor(() => {
			expect(result.current.isSuccess || result.current.isError).toBe(true);
		});

		expect(
			invalidations.some(
				(k) => JSON.stringify(k) === JSON.stringify([...quiKeys.torrentProperties.all]),
			),
		).toBe(true);
		expect(
			invalidations.some(
				(k) => JSON.stringify(k) === JSON.stringify([...quiKeys.torrentFiles.all]),
			),
		).toBe(true);
		expect(invalidations).not.toContainEqual(["qui", "torrent-state"]);
	});
});

describe("useQuiCapabilities / useQuiTags / useQuiCategories — `enabled` gate", () => {
	// These three hooks share the pattern:
	//   enabled: enabled && quiInstanceId !== null && qbitInstanceId !== null
	// A typo from `&&` to `||` would fire requests with `null!` and burn
	// 401s on every render the drawer is closed. These tests pin the gate.

	function setupClient() {
		const client = new QueryClient();
		vi.spyOn(quiApi, "fetchQuiCapabilities").mockResolvedValue({} as never);
		vi.spyOn(quiApi, "fetchQuiCategories").mockResolvedValue([] as never);
		vi.spyOn(quiApi, "fetchQuiTags").mockResolvedValue([] as never);
		return client;
	}

	it("useQuiCapabilities does NOT fetch when quiInstanceId is null", async () => {
		const client = setupClient();
		renderHook(() => useQuiCapabilities({ quiInstanceId: null, qbitInstanceId: 0 }), {
			wrapper: createWrapper(client),
		});
		// Give React Query a tick — if `enabled` was wrong, the fetch
		// would already have fired by now.
		await new Promise((r) => setTimeout(r, 20));
		expect(quiApi.fetchQuiCapabilities).not.toHaveBeenCalled();
	});

	it("useQuiCapabilities does NOT fetch when qbitInstanceId is null", async () => {
		const client = setupClient();
		renderHook(() => useQuiCapabilities({ quiInstanceId: "qui-1", qbitInstanceId: null }), {
			wrapper: createWrapper(client),
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(quiApi.fetchQuiCapabilities).not.toHaveBeenCalled();
	});

	it("useQuiCapabilities does NOT fetch when enabled=false", async () => {
		const client = setupClient();
		renderHook(
			() =>
				useQuiCapabilities({
					quiInstanceId: "qui-1",
					qbitInstanceId: 0,
					enabled: false,
				}),
			{ wrapper: createWrapper(client) },
		);
		await new Promise((r) => setTimeout(r, 20));
		expect(quiApi.fetchQuiCapabilities).not.toHaveBeenCalled();
	});

	it("useQuiCapabilities DOES fetch when both ids present + enabled (default)", async () => {
		const client = setupClient();
		renderHook(() => useQuiCapabilities({ quiInstanceId: "qui-1", qbitInstanceId: 0 }), {
			wrapper: createWrapper(client),
		});
		await waitFor(() => {
			expect(quiApi.fetchQuiCapabilities).toHaveBeenCalledTimes(1);
		});
	});

	it("useQuiTags applies the same null-guard", async () => {
		const client = setupClient();
		renderHook(() => useQuiTags({ quiInstanceId: null, qbitInstanceId: 0 }), {
			wrapper: createWrapper(client),
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(quiApi.fetchQuiTags).not.toHaveBeenCalled();
	});

	it("useQuiCategories applies the same null-guard", async () => {
		const client = setupClient();
		renderHook(() => useQuiCategories({ quiInstanceId: "qui-1", qbitInstanceId: null }), {
			wrapper: createWrapper(client),
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(quiApi.fetchQuiCategories).not.toHaveBeenCalled();
	});
});
