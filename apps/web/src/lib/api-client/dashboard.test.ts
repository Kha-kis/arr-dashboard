import { historyResponseV2Schema } from "@arr/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, UnauthorizedError } from "./base";
import { fetchMultiInstanceHistory } from "./dashboard";

const response = {
	version: 2 as const,
	items: [],
	sources: [],
	pageInfo: { nextCursor: null, hasNextPage: false, matchingObservedCount: 0 },
};

describe("fetchMultiInstanceHistory", () => {
	beforeEach(() => vi.restoreAllMocks());

	it("uses the public route and serializes every request field, including false", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(response), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await fetchMultiInstanceHistory({
			limit: 7,
			cursor: "opaque cursor/token",
			startDate: "2026-09-01T00:00:00.000Z",
			endDate: "2026-09-01T23:59:59.999Z",
			search: "private title",
			service: "sonarr",
			instanceId: "instance-1",
			eventType: "grabbed",
			hideProwlarrRss: false,
		});
		const url = vi.mocked(fetch).mock.calls[0]?.[0];
		expect(String(url)).toBe(
			"/api/dashboard/history?limit=7&cursor=opaque+cursor%2Ftoken&startDate=2026-09-01T00%3A00%3A00.000Z&endDate=2026-09-01T23%3A59%3A59.999Z&search=private+title&service=sonarr&instanceId=instance-1&eventType=grabbed&hideProwlarrRss=false",
		);
	});

	it("omits null optionals while sending limit, false, and later cursor explicitly", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(response), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await fetchMultiInstanceHistory({ limit: 1, cursor: null, hideProwlarrRss: false });
		expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe(
			"/api/dashboard/history?limit=1&hideProwlarrRss=false",
		);
	});

	it("validates success with the strict v2 schema and sanitizes malformed content", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ version: 2, secret: "private" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await expect(fetchMultiInstanceHistory({ limit: 25, hideProwlarrRss: true })).rejects.toThrow(
			"History response was invalid",
		);
		expect(historyResponseV2Schema.safeParse(response).success).toBe(true);
	});

	it("keeps 401 as an authentication error rather than an empty result", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
		await expect(
			fetchMultiInstanceHistory({ limit: 25, hideProwlarrRss: true }),
		).rejects.toBeInstanceOf(UnauthorizedError);
	});

	it("surfaces non-auth failures without exposing response details", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ error: "cursor-secret" }), {
				status: 503,
				headers: { "content-type": "application/json" },
			}),
		);
		await expect(fetchMultiInstanceHistory({ limit: 25, hideProwlarrRss: true })).rejects.toSatisfy(
			(error: unknown) => error instanceof ApiError && !String(error).includes("cursor-secret"),
		);
	});
});
