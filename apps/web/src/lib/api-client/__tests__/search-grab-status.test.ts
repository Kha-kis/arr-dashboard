import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "../base";

const intentId = "770ecb14-0000-4000-8000-000000000001";
const status = {
	attemptId: "770ecb14-0000-4000-8000-000000000002",
	intentId,
	state: "acknowledged",
	requestedAt: "2026-10-10T01:00:00.000Z",
	dispatchedAt: "2026-10-10T01:00:01.000Z",
	completedAt: "2026-10-10T01:00:02.000Z",
	outcomeCategory: null,
	nextAction: "none",
};
afterEach(() => vi.unstubAllGlobals());
describe("Search durable status actual API client", () => {
	it("reads one matching strict status through an authenticated GET without a selector", async () => {
		const { fetchSearchGrabStatus } = await import("../search");
		const calls: Array<{ url: string; options: RequestInit }> = [];
		vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
			calls.push({ url, options });
			return new Response(JSON.stringify(status), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		expect(await fetchSearchGrabStatus(intentId)).toEqual(status);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`/api/search/grab/intents/${intentId}`);
		expect(calls[0]?.options).toMatchObject({ method: "GET", credentials: "include" });
		expect(calls[0]?.options.body).toBeUndefined();
	});
	it.each([
		{ ...status, intentId: "770ecb14-0000-4000-8000-000000000003" },
		{ ...status, guid: "SYNTHETIC_PRIVATE_DIAGNOSTIC" },
		{ ...status, state: "accepted" },
		{ ...status, completedAt: null },
		{ ...status, outcomeCategory: "SYNTHETIC_PRIVATE_DIAGNOSTIC" },
	])("never accepts an unrelated or malformed successful status %#", async (value) => {
		const { fetchSearchGrabStatus } = await import("../search");
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(JSON.stringify(value), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		await expect(fetchSearchGrabStatus(intentId)).rejects.toThrow(/unavailable/i);
		await expect(fetchSearchGrabStatus(intentId)).rejects.not.toThrow(
			/SYNTHETIC_PRIVATE_DIAGNOSTIC/,
		);
	});
	it.each([404, 503])(
		"keeps HTTP %i unreadable rather than returning missing/empty success",
		async (code) => {
			const { fetchSearchGrabStatus } = await import("../search");
			vi.stubGlobal(
				"fetch",
				async () =>
					new Response(JSON.stringify({ message: "SYNTHETIC_PRIVATE_DIAGNOSTIC" }), {
						status: code,
						headers: { "content-type": "application/json" },
					}),
			);
			await expect(fetchSearchGrabStatus(intentId)).rejects.toThrow(/unavailable/i);
		},
	);
	it("preserves unauthorized session recovery without claiming an action outcome", async () => {
		const { fetchSearchGrabStatus } = await import("../search");
		vi.stubGlobal("fetch", async () => new Response(null, { status: 401 }));
		await expect(fetchSearchGrabStatus(intentId)).rejects.toBeInstanceOf(UnauthorizedError);
	});
});
