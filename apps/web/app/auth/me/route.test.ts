// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

const originalApiHost = process.env.API_HOST;
const servers: Server[] = [];
async function backend(handler: (request: IncomingMessage, response: ServerResponse) => void) {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	process.env.API_HOST = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return server;
}
function request(cookie = "arr_session=synthetic-a", signal?: AbortSignal) {
	return new Request("https://synthetic-untrusted.invalid/auth/me?check=%2F", {
		headers: { Cookie: cookie, "User-Agent": "synthetic-browser" },
		signal,
	});
}
afterEach(async () => {
	if (originalApiHost === undefined) delete process.env.API_HOST;
	else process.env.API_HOST = originalApiHost;
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});

describe("auth recovery read transport", () => {
	it("retains the existing default when the optional API host is empty", async () => {
		process.env.API_HOST = "";
		const controller = new AbortController();
		controller.abort();
		// No request can reach an uncontrolled default-port service in this test.
		await expect(GET(request(undefined, controller.signal))).resolves.toMatchObject({
			status: 503,
		});
	});

	it("reports a refused API connection as unavailable without clearing the session", async () => {
		const server = await backend((_request, response) => response.end());
		await new Promise<void>((resolve) => server.close(() => resolve()));
		servers.splice(servers.indexOf(server), 1);
		const response = await GET(request());
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "API temporarily unavailable",
			category: "api-unavailable",
		});
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(response.headers.get("cache-control")).toContain("no-store");
	});

	it.each([200, 401, 403, 429, 500, 503])(
		"preserves real API HTTP %i and does not retry it",
		async (status) => {
			let calls = 0;
			await backend((_request, response) => {
				calls++;
				response.writeHead(status, { "Content-Type": "application/json", "Retry-After": "2" });
				response.end('{"category":"synthetic-upstream"}');
			});
			const response = await GET(request());
			expect(response.status).toBe(status);
			expect(await response.json()).toEqual({ category: "synthetic-upstream" });
			expect(response.headers.get("retry-after")).toBe("2");
			expect(calls).toBe(1);
		},
	);

	it("forwards each request to the configured origin with its own session and unchanged query", async () => {
		const received: Array<{ url?: string; method?: string; cookie?: string; userAgent?: string }> =
			[];
		await backend((incoming, response) => {
			received.push({
				url: incoming.url,
				method: incoming.method,
				cookie: incoming.headers.cookie,
				userAgent: incoming.headers["user-agent"],
			});
			response.writeHead(200, {
				"Content-Type": "application/json",
				"Cache-Control": "public, max-age=3600",
			});
			response.end(received.length === 1 ? '{"user":"synthetic-a"}' : '{"user":"synthetic-b"}');
		});
		const first = await GET(request());
		const second = await GET(request("arr_session=synthetic-b"));
		expect(await first.json()).toEqual({ user: "synthetic-a" });
		expect(await second.json()).toEqual({ user: "synthetic-b" });
		expect(received).toEqual([
			{
				url: "/auth/me?check=%2F",
				method: "GET",
				cookie: "arr_session=synthetic-a",
				userAgent: "synthetic-browser",
			},
			{
				url: "/auth/me?check=%2F",
				method: "GET",
				cookie: "arr_session=synthetic-b",
				userAgent: "synthetic-browser",
			},
		]);
		expect(first.headers.get("cache-control")).toContain("no-store");
		expect(second.headers.get("cache-control")).toContain("no-store");
	});

	it("preserves an operator-configured API path prefix", async () => {
		let path: string | undefined;
		await backend((incoming, response) => {
			path = incoming.url;
			response.end("synthetic");
		});
		process.env.API_HOST += "/synthetic-prefix/";
		await GET(request());
		expect(path).toBe("/synthetic-prefix/auth/me?check=%2F");
	});

	it("retains distinct API cookie renewals without joining their values", async () => {
		await backend((_incoming, response) => {
			response.setHeader("Set-Cookie", [
				"arr_session=synthetic-renewed; HttpOnly; Path=/; SameSite=Lax",
				"synthetic_second=next; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/",
			]);
			response.end("synthetic");
		});
		const response = await GET(request());
		expect(response.headers.getSetCookie()).toEqual([
			"arr_session=synthetic-renewed; HttpOnly; Path=/; SameSite=Lax",
			"synthetic_second=next; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/",
		]);
	});

	it("strips connection-only headers and stale compressed lengths while retaining decoded bytes", async () => {
		const compressed = gzipSync('{"user":"synthetic"}');
		let requestHop: string | string[] | undefined;
		await backend((incoming, response) => {
			requestHop = incoming.headers["x-synthetic-request-hop"];
			response.writeHead(200, {
				"Content-Type": "application/json",
				"Content-Encoding": "gzip",
				"Content-Length": String(compressed.length),
				Connection: "x-synthetic-response-hop",
				"x-synthetic-response-hop": "remove",
			});
			response.end(compressed);
		});
		const incoming = request();
		incoming.headers.set("Connection", "x-synthetic-request-hop");
		incoming.headers.set("x-synthetic-request-hop", "remove");
		const response = await GET(incoming);
		expect(await response.json()).toEqual({ user: "synthetic" });
		expect(requestHop).toBeUndefined();
		for (const name of [
			"connection",
			"x-synthetic-response-hop",
			"content-length",
			"content-encoding",
			"transfer-encoding",
		]) {
			expect(response.headers.get(name)).toBeNull();
		}
	});

	it("never publishes a successful auth body after a partial-response disconnect and does not retry", async () => {
		let calls = 0;
		await backend((_incoming, response) => {
			calls++;
			response.writeHead(200, { "Content-Length": "100" });
			response.write("synthetic-partial");
			setImmediate(() => response.destroy());
		});
		const response = await GET(request());
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "API temporarily unavailable",
			category: "api-unavailable",
		});
		expect(calls).toBe(1);
	});

	it("bounds a stalled API response and permits a later independent read to recover", async () => {
		let calls = 0;
		await backend((_incoming, response) => {
			calls++;
			if (calls > 1) response.end('{"user":"synthetic-recovered"}');
		});
		const started = performance.now();
		const unavailable = await GET(request());
		expect(unavailable.status).toBe(503);
		expect(performance.now() - started).toBeLessThan(4500);
		expect(calls).toBe(1);
		const recovered = await GET(request());
		expect(recovered.status).toBe(200);
		expect(await recovered.json()).toEqual({ user: "synthetic-recovered" });
		expect(calls).toBe(2);
	}, 6000);

	it("cancels the provider read when its caller aborts without retrying or clearing cookies", async () => {
		let admitted!: () => void;
		const received = new Promise<void>((resolve) => {
			admitted = resolve;
		});
		let calls = 0;
		await backend(() => {
			calls++;
			admitted();
		});
		const controller = new AbortController();
		const pending = GET(request(undefined, controller.signal));
		await received;
		controller.abort();
		const response = await pending;
		expect(response.status).toBe(503);
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(calls).toBe(1);
	});
});
