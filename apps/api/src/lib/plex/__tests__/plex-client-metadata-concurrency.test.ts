import { setImmediate as turn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlexClient } from "../plex-client.js";

// Synthetic inventory and a real Response body; no providers or DB involved.
function response(MediaContainer: Record<string, unknown>) {
	return new Response(JSON.stringify({ MediaContainer }), {
		headers: { "Content-Type": "application/json" },
	});
}

type BatchFailure =
	| "incomplete"
	| "duplicate"
	| "unexpected"
	| "http"
	| "transport"
	| "invalid-key";

function controlledHydration(failure?: BatchFailure) {
	const items = Array.from({ length: 151 }, (_, index) => ({
		ratingKey: failure === "invalid-key" && index === 50 ? "\ud800" : `item-${index + 1}`,
		title: `Synthetic ${index + 1}`,
		type: "movie",
	}));
	const batches: string[][] = [];
	const gates = new Map<number, () => void>();
	let active = 0;
	let maximumActive = 0;
	let allReleased = false;
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname.includes("/library/sections/")) {
			return response({ offset: 0, size: items.length, totalSize: items.length, Metadata: items });
		}
		const keys = url.pathname.replace("/library/metadata/", "").split(",");
		const ordinal = batches.length;
		batches.push(keys);
		active++;
		maximumActive = Math.max(maximumActive, active);
		try {
			if (!allReleased) {
				await new Promise<void>((resolve) => gates.set(ordinal, resolve));
			}
			let returnedKeys = keys;
			if (ordinal === 1) {
				if (failure === "transport") throw new Error("synthetic-private-provider-failure");
				if (failure === "http") return new Response(null, { status: 503 });
				if (failure === "incomplete") returnedKeys = keys.slice(1);
				if (failure === "duplicate")
					returnedKeys = keys.map((key, index) => (index === 1 ? keys[0]! : key));
				if (failure === "unexpected") returnedKeys = ["item-1", ...keys.slice(1)];
			}
			return response({
				size: returnedKeys.length,
				Metadata: returnedKeys.map((ratingKey) => ({
					ratingKey,
					Label: [{ tag: `label-${ratingKey}` }],
					Collection: [{ tag: "synthetic-collection" }],
				})),
			});
		} finally {
			active--;
		}
	});
	const client = new PlexClient("http://synthetic.invalid", "synthetic-token", {
		warn: vi.fn(),
	} as never);
	return {
		client,
		batches,
		maximumActive: () => maximumActive,
		active: () => active,
		release(ordinal: number) {
			const release = gates.get(ordinal);
			expect(release).toBeDefined();
			release!();
		},
		releaseAll() {
			allReleased = true;
			for (const release of gates.values()) release();
		},
	};
}

describe("Plex complete metadata hydration concurrency", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("drains a held peer and dispatches no later batch after rating-key encoding fails", async () => {
		const fixture = controlledHydration("invalid-key");
		let settled = false;
		const reading = fixture.client
			.getLibraryItemsWithCoverage("synthetic-library")
			.then((value) => {
				settled = true;
				return value;
			});
		try {
			await turn();
			expect(settled).toBe(false);
			expect(fixture.batches).toHaveLength(1);
			expect(fixture.active()).toBe(1);
			fixture.release(0);
			await expect(reading).resolves.toMatchObject({
				items: [],
				rawObserved: 151,
				reason: "page-failure",
			});
			expect(fixture.batches).toHaveLength(1);
			expect(fixture.active()).toBe(0);
		} finally {
			fixture.releaseAll();
			await reading;
			await turn();
		}
	});

	it("overlaps two batches, never a third, and preserves row/tag identity after out-of-order reads", async () => {
		const fixture = controlledHydration();
		const reading = fixture.client.getLibraryItemsWithCoverage("synthetic-library");
		try {
			await turn();
			expect(fixture.batches.map((keys) => keys[0])).toEqual(["item-1", "item-51"]);
			expect(fixture.active()).toBe(2);
			fixture.release(1);
			await turn();
			expect(fixture.batches.map((keys) => keys[0])).toEqual(["item-1", "item-51", "item-101"]);
			expect(fixture.active()).toBe(2);
			fixture.releaseAll();
			const result = await reading;
			expect(result.reason).toBeNull();
			expect(result.items).toHaveLength(151);
			expect(result.items[0]).toMatchObject({
				ratingKey: "item-1",
				Label: [{ tag: "label-item-1" }],
				Collection: [{ tag: "synthetic-collection" }],
			});
			expect(result.items[150]).toMatchObject({
				ratingKey: "item-151",
				Label: [{ tag: "label-item-151" }],
			});
			expect(fixture.batches.map((keys) => keys.length)).toEqual([50, 50, 50, 1]);
			expect(fixture.maximumActive()).toBe(2);
			expect(fixture.active()).toBe(0);
		} finally {
			fixture.releaseAll();
			await reading;
		}
	});

	it.each<BatchFailure>(["incomplete", "duplicate", "unexpected", "http", "transport"])(
		"stops dispatch after a %s batch and drains the other read before returning no partial rows",
		async (failure) => {
			const fixture = controlledHydration(failure);
			let settled = false;
			const reading = fixture.client
				.getLibraryItemsWithCoverage("synthetic-library")
				.then((value) => {
					settled = true;
					return value;
				});
			try {
				await turn();
				expect(fixture.batches).toHaveLength(2);
				fixture.release(1);
				await turn();
				expect(settled).toBe(false);
				expect(fixture.batches).toHaveLength(2);
				expect(fixture.active()).toBe(1);
				fixture.release(0);
				const result = await reading;
				expect(result).toEqual({
					items: [],
					expectedRawCount: 151,
					pagesAttempted: 1,
					pagesCompleted: 1,
					rawObserved: 151,
					reason: "page-failure",
				});
				expect(JSON.stringify(result)).not.toMatch(/Synthetic|item-|token|http|label/i);
				expect(JSON.stringify(result)).not.toContain("synthetic-private-provider-failure");
				expect(fixture.batches).toHaveLength(2);
				expect(fixture.active()).toBe(0);
			} finally {
				fixture.releaseAll();
				await reading;
			}
		},
	);
});
