import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "../../../proxy";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("frontend proxy authentication boundary", () => {
	it("does not add an auth API roundtrip to authenticated RSC navigation", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const request = new NextRequest("http://localhost/dashboard", {
			headers: { cookie: "arr_session=signed-session", RSC: "1" },
		});

		const response = await proxy(request);

		expect(response.status).toBe(200);
		expect(response.headers.get("x-middleware-next")).toBe("1");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("validates a protected document load and clears an invalid cookie", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
		vi.stubGlobal("fetch", fetchMock);
		const request = new NextRequest("http://localhost/dashboard", {
			headers: { cookie: "arr_session=invalid-session" },
		});

		const response = await proxy(request);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe("http://localhost/login?redirectTo=%2Fdashboard");
		expect(response.headers.get("set-cookie")).toContain("arr_session=");
	});

	it("still rejects protected document navigation without a cookie", async () => {
		const response = await proxy(new NextRequest("http://localhost/library?view=movies"));

		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(
			"http://localhost/login?redirectTo=%2Flibrary%3Fview%3Dmovies",
		);
	});

	it("still rejects unauthenticated RSC navigation without redirecting its wire format", async () => {
		const response = await proxy(
			new NextRequest("http://localhost/console", { headers: { RSC: "1" } }),
		);

		expect(response.status).toBe(401);
		expect(response.headers.get("location")).toBeNull();
	});
});
