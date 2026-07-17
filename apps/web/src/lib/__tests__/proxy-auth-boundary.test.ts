import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "../../../proxy";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("frontend proxy authentication boundary", () => {
	it("validates authenticated RSC navigation before allowing it", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const request = new NextRequest("http://localhost/dashboard", {
			headers: { cookie: "arr_session=signed-session", RSC: "1" },
		});

		const response = await proxy(request);

		expect(response.status).toBe(200);
		expect(response.headers.get("x-middleware-next")).toBe("1");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects an invalid cookie during RSC navigation and clears it", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
		vi.stubGlobal("fetch", fetchMock);
		const request = new NextRequest("http://localhost/console", {
			headers: { cookie: "arr_session=revoked-session", RSC: "1" },
		});

		const response = await proxy(request);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe("http://localhost/login?redirectTo=%2Fconsole");
		expect(response.headers.get("set-cookie")).toContain("arr_session=");
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

	it("redirects unauthenticated RSC navigation through Next's middleware adapter", async () => {
		const response = await proxy(
			new NextRequest("http://localhost/console", { headers: { RSC: "1" } }),
		);

		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe("http://localhost/login?redirectTo=%2Fconsole");
	});
});
