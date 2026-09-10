import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const proxyServer = fileURLToPath(new URL("./proxy-server.mjs", import.meta.url));

function listen(server) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(server.address().port));
	});
}

function waitForProxy(child) {
	return new Promise((resolve, reject) => {
		let output = "";
		const timer = setTimeout(() => reject(new Error("fixture proxy did not become ready")), 5000);
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`fixture proxy exited before readiness with code ${code}`));
		});
		child.stdout.on("data", (chunk) => {
			output += chunk;
			const match = output.match(/fixture-proxy-ready:(\d+)/);
			if (match) {
				clearTimeout(timer);
				resolve(Number(match[1]));
			}
		});
	});
}

describe("Jellyfin authority HTTP proxy", () => {
	let proxy;
	let proxyBase;
	let upstream;
	const upstreamRequests = [];
	const upstreamEncodings = [];

	before(async () => {
		upstream = http.createServer((request, response) => {
			upstreamRequests.push(request.url);
			upstreamEncodings.push(request.headers["accept-encoding"]);
			if (request.url === "/System/Info/Public") {
				const body = Buffer.from(JSON.stringify({ Version: "10.11.11" }));
				if (request.headers["accept-encoding"] !== "identity") {
					const compressed = gzipSync(body);
					response.writeHead(200, {
						"content-encoding": "gzip",
						"content-type": "application/json",
					});
					response.end(compressed);
					return;
				}
				response.writeHead(200, { "content-type": "application/json" });
				response.end(body);
				return;
			}
			if (request.url.startsWith("/Users/user-1/Items")) {
				const body = JSON.stringify({
					Items: [{ Id: "movie-1", Name: "Synthetic Movie", Type: "Movie" }],
					StartIndex: 0,
					TotalRecordCount: 1,
				});
				response.writeHead(200, { "content-type": "application/json" });
				response.end(body);
				return;
			}
			response.writeHead(204);
			response.end();
		});
		const upstreamPort = await listen(upstream);
		proxy = spawn(process.execPath, [proxyServer], {
			env: {
				...process.env,
				JELLYFIN_PROXY_HOST: "127.0.0.1",
				JELLYFIN_PROXY_PORT: "0",
				JELLYFIN_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		const proxyPort = await waitForProxy(proxy);
		proxyBase = `http://127.0.0.1:${proxyPort}`;
	});

	after(async () => {
		proxy?.kill("SIGTERM");
		await new Promise((resolve) => upstream?.close(resolve));
	});

	it("forwards ordinary requests without changing status", async () => {
		const response = await fetch(`${proxyBase}/System/Info`);

		assert.equal(response.status, 204);
		assert.equal(upstreamRequests.at(-1), "/System/Info");
	});

	it("requests identity encoding before transforming real Jellyfin JSON", async () => {
		const response = await fetch(`${proxyBase}/System/Info/Public`);

		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { Version: "10.11.11" });
		assert.equal(upstreamEncodings.at(-1), "identity");
	});

	it("applies the selected pagination policy to real HTTP requests", async () => {
		const control = await fetch(`${proxyBase}/__fixture/mode`, {
			body: JSON.stringify({ mode: "paginate" }),
			headers: { "content-type": "application/json" },
			method: "PUT",
		});
		assert.equal(control.status, 204);

		const response = await fetch(
			`${proxyBase}/Users/user-1/Items?ParentId=library-1&StartIndex=0&Limit=1000`,
		);
		assert.equal(response.status, 200);
		assert.equal(
			upstreamRequests.at(-1),
			"/Users/user-1/Items?ParentId=library-1&StartIndex=0&Limit=1",
		);
	});

	it("reports only sanitized counters for the selected observation window", async () => {
		const response = await fetch(`${proxyBase}/__fixture/status`);

		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			itemInventoryRequests: 1,
			mode: "paginate",
			upstreamRequests: 1,
		});
	});

	it("applies response fault modes to the forwarded Jellyfin envelope", async () => {
		await fetch(`${proxyBase}/__fixture/mode`, {
			body: JSON.stringify({ mode: "unknown-type" }),
			headers: { "content-type": "application/json" },
			method: "PUT",
		});

		const response = await fetch(
			`${proxyBase}/Users/user-1/Items?ParentId=library-1&StartIndex=0&Limit=1000`,
		);
		const body = await response.json();
		assert.equal(body.Items.at(-1).Type, "MusicVideo");
		assert.equal(body.TotalRecordCount, 2);
	});

	it("short-circuits unavailable mode without reaching the real server", async () => {
		await fetch(`${proxyBase}/__fixture/mode`, {
			body: JSON.stringify({ mode: "unavailable" }),
			headers: { "content-type": "application/json" },
			method: "PUT",
		});
		const requestsBefore = upstreamRequests.length;

		const response = await fetch(`${proxyBase}/System/Info`);

		assert.equal(response.status, 503);
		assert.equal(upstreamRequests.length, requestsBefore);
		assert.deepEqual(await response.json(), { error: "fixture_unavailable" });
	});

	it("keeps fixture health independent from the selected provider failure mode", async () => {
		const response = await fetch(`${proxyBase}/__fixture/health`);

		assert.equal(response.status, 204);
	});
});
