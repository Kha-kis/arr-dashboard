import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "../proxy";

const makeRequest = (
	cookie?: string,
	additionalHeaders: Record<string, string> = {},
): NextRequest => {
	const headers = new Headers(additionalHeaders);
	if (cookie) headers.set("Cookie", `arr_session=${cookie}`);
	return new NextRequest("http://localhost/dashboard", { headers });
};

describe("proxy session validation during Next prefetch", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("coalesces concurrent speculative RSC validations for one session", async () => {
		const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchSpy);
		const prefetchHeaders = {
			RSC: "1",
			"Next-Router-Prefetch": "1",
			"Next-Router-State-Tree": "%5B%22dashboard%22%5D",
		};

		const responses = await Promise.all(
			Array.from({ length: 21 }, () => proxy(makeRequest("session-a", prefetchHeaders))),
		);

		expect(responses.every((response) => response.status === 200)).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("keeps separate session validation isolated", async () => {
		const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchSpy);

		await Promise.all([
			proxy(makeRequest("session-a", { RSC: "1", "Next-Router-Prefetch": "1" })),
			proxy(makeRequest("session-b", { RSC: "1", "Next-Router-Prefetch": "1" })),
		]);

		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("revalidates after a completed validation instead of caching authorization", async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 200 }))
			.mockResolvedValueOnce(new Response(null, { status: 401 }));
		vi.stubGlobal("fetch", fetchSpy);

		const first = await proxy(makeRequest("session-a", { RSC: "1" }));
		const second = await proxy(makeRequest("session-a", { RSC: "1" }));

		expect(first.status).toBe(200);
		expect(second.status).toBe(401);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("does not trust speculative headers without a valid session", async () => {
		const fetchSpy = vi.fn(async () => new Response(null, { status: 401 }));
		vi.stubGlobal("fetch", fetchSpy);

		const rscResponse = await proxy(
			makeRequest(undefined, { RSC: "1", "Next-Router-Prefetch": "1" }),
		);
		const invalidRscResponse = await proxy(
			makeRequest("invalid", { RSC: "1", "Next-Router-Prefetch": "1" }),
		);
		const documentResponse = await proxy(makeRequest("invalid"));

		expect(rscResponse.status).toBe(401);
		expect(invalidRscResponse.status).toBe(401);
		expect(documentResponse.status).toBe(307);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});
});
