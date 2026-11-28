import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "./base";
import { fetchCrossSeedAvailability, fetchCrossSeedDiscoveryBatch } from "./qui";

const batch = {
	items: [],
	nextCursor: null,
	scannedThisBatch: 0,
	foundThisBatch: 0,
	totalScanned: 0,
	totalFound: 0,
	exhausted: true,
	quiInstanceLabel: "Synthetic qUI",
};
function respond(payload: unknown, status = 200) {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify(payload), {
					status,
					headers: { "Content-Type": "application/json" },
				}),
		),
	);
}
afterEach(() => vi.unstubAllGlobals());

describe("Cross-seed read admission through the API base", () => {
	it.each([
		{ available: true },
		{ available: false, reason: "private invalid reason" },
		{
			available: true,
			quiInstanceId: "qui-1",
			quiInstanceLabel: "Synthetic qUI",
			scanCandidates: -1,
		},
	])("rejects malformed availability with a generic error", async (payload) => {
		respond(payload);
		await expect(fetchCrossSeedAvailability()).rejects.toThrow(
			"Cross-seed availability response could not be verified. Retry availability.",
		);
	});
	it.each([
		{},
		{ ...batch, items: [{}] },
		...[
			"scannedThisBatch",
			"foundThisBatch",
			"totalScanned",
			"totalFound",
			"siblingFetchErrors",
		].map((key) => ({ ...batch, [key]: -1 })),
		{ ...batch, torrentInventoryComplete: "true" },
	])("rejects malformed discovery with a generic error", async (payload) => {
		respond(payload);
		await expect(fetchCrossSeedDiscoveryBatch()).rejects.toThrow(
			"Cross-seed discovery response could not be verified. Retry the scan.",
		);
	});
	it("retains legacy batches without claiming an inventory witness", async () => {
		respond(batch);
		const result = await fetchCrossSeedDiscoveryBatch();
		expect(result.exhausted).toBe(true);
		expect(result.torrentInventoryComplete).toBeUndefined();
	});
	it.each([true, false])(
		"admits explicit inventory evidence %s",
		async (torrentInventoryComplete) => {
			respond({ ...batch, torrentInventoryComplete });
			expect((await fetchCrossSeedDiscoveryBatch()).torrentInventoryComplete).toBe(
				torrentInventoryComplete,
			);
		},
	);
	it.each(["no_qui_instance", "no_correlated_items"])(
		"admits known unavailable state %s",
		async (reason) => {
			respond({ available: false, reason });
			expect(await fetchCrossSeedAvailability()).toEqual({ available: false, reason });
		},
	);
	it("preserves protected request authentication errors", async () => {
		respond({}, 401);
		await expect(fetchCrossSeedAvailability()).rejects.toBeInstanceOf(UnauthorizedError);
		await expect(fetchCrossSeedDiscoveryBatch()).rejects.toBeInstanceOf(UnauthorizedError);
	});
	it("keeps GET credentials and encodes the cursor through the existing API base", async () => {
		const requests: { url: string; method?: string; credentials?: RequestCredentials }[] = [];
		vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
			requests.push({ url, method: options.method, credentials: options.credentials });
			return new Response(
				JSON.stringify(
					url.includes("availability") ? { available: false, reason: "no_qui_instance" } : batch,
				),
				{ headers: { "Content-Type": "application/json" } },
			);
		});
		await fetchCrossSeedAvailability();
		await fetchCrossSeedDiscoveryBatch({ cursor: "row &2", batchSize: 100 });
		expect(requests).toEqual([
			{ url: "/api/qui/cross-seed/availability", method: "GET", credentials: "include" },
			{
				url: "/api/qui/cross-seed/discover?cursor=row+%262&batchSize=100",
				method: "GET",
				credentials: "include",
			},
		]);
	});
});
