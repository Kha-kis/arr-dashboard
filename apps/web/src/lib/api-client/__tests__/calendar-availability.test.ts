import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, UnauthorizedError } from "../base";
import { fetchMultiInstanceCalendar } from "../dashboard";

const valid = { instances: [], aggregated: [], totalCount: 0, availability: "not-configured" };
const response = (payload: unknown, status = 200) =>
	new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
afterEach(() => vi.restoreAllMocks());
describe("Calendar client verification", () => {
	it.each([
		{},
		{ instances: [], aggregated: [], totalCount: 0 },
		{ ...valid, availability: "available" },
		{ ...valid, totalCount: 1 },
	])("rejects unverifiable envelopes generically %#", async (payload) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(response(payload));
		await expect(fetchMultiInstanceCalendar()).rejects.toThrow(
			"Calendar response could not be verified",
		);
	});
	it("keeps authorization failures as 401", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
		await expect(fetchMultiInstanceCalendar()).rejects.toBeInstanceOf(UnauthorizedError);
	});
	it("sanitizes provider diagnostics on unsuccessful reads", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			response({ error: "synthetic-private-diagnostic" }, 503),
		);
		await expect(fetchMultiInstanceCalendar()).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof ApiError &&
				error.status === 503 &&
				error.message === "Calendar request failed" &&
				error.payload === undefined,
		);
	});
	it("recovers via the public GET route and preserves false options", async () => {
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(response({}))
			.mockResolvedValueOnce(response(valid));
		await expect(fetchMultiInstanceCalendar()).rejects.toThrow(
			"Calendar response could not be verified",
		);
		expect(
			await fetchMultiInstanceCalendar({
				start: "2026-10-01",
				end: "2026-10-31",
				unmonitored: false,
			}),
		).toEqual(valid);
		expect(fetcher.mock.calls[1]?.[0]).toBe(
			"/api/dashboard/calendar?start=2026-10-01&end=2026-10-31&unmonitored=false",
		);
		expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "GET", credentials: "include" });
	});
});
