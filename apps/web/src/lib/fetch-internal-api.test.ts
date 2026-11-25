import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { fetchInternalApi } from "./fetch-internal-api";

afterEach(() => vi.unstubAllEnvs());

it("keeps the configured IPv6 origin and preserves the request path, cookies and redirect", async () => {
	const server = createServer((req, res) => {
		if (req.url === "/auth/me?probe=1") {
			res.writeHead(307, { location: "/auth/fixture" });
			res.end();
		} else {
			res.setHeader("set-cookie", ["one=1; Path=/", "two=2; Path=/"]);
			res.end(req.headers.cookie ?? "");
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "::1", () => resolve());
	});
	try {
		const origin = `http://[::1]:${(server.address() as AddressInfo).port}`;
		vi.stubEnv("API_HOST", origin);
		vi.stubEnv("ARR_INTERNAL_API_SOCKET", "::1");
		const redirect = await fetchInternalApi(`${origin}/auth/me?probe=1`, { redirect: "manual" });
		expect(redirect.status).toBe(307);
		expect(redirect.headers.get("location")).toBe("/auth/fixture");
		await redirect.body?.cancel();
		const forwarded = await fetchInternalApi(`${origin}/auth/me?probe=1`, {
			headers: { cookie: "session=disposable" },
		});
		expect(forwarded.status).toBe(200);
		expect(await forwarded.text()).toBe("session=disposable");
		expect(forwarded.headers.getSetCookie()).toEqual(["one=1; Path=/", "two=2; Path=/"]);
		expect(() => fetchInternalApi("http://127.0.0.1:38081/auth/me")).toThrow(
			/Unexpected internal API origin/,
		);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
