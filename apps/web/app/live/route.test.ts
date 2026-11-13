import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const originalApiHost = process.env.API_HOST;

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalApiHost === undefined) delete process.env.API_HOST;
	else process.env.API_HOST = originalApiHost;
});

describe("combined container liveness", () => {
	it("returns unavailable when the API event loop cannot answer", async () => {
		process.env.API_HOST = "http://127.0.0.1:3001";
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("API stalled")));
		const response = await GET();
		expect(response.status).toBe(503);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("remains live when both web and API liveness answer", async () => {
		process.env.API_HOST = "http://127.0.0.1:3001";
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
		const response = await GET();
		expect(response.status).toBe(200);
	});

	it("returns unavailable for a non-success API liveness response", async () => {
		process.env.API_HOST = "http://127.0.0.1:3101/";
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
		const response = await GET();
		expect(response.status).toBe(503);
		expect(fetch).toHaveBeenCalledWith(
			new URL("http://127.0.0.1:3101/live"),
			expect.objectContaining({ method: "HEAD" }),
		);
	});

	it("remains live through a temporary five-second API stall", async () => {
		const server = createServer((_request, response) => {
			setTimeout(() => {
				response.writeHead(200);
				response.end();
			}, 5_250);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			process.env.API_HOST = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const response = await GET();
			expect(response.status).toBe(200);
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	}, 12_000);

	it("keeps the Docker healthcheck budget above the API probe budget", async () => {
		process.env.API_HOST = "http://127.0.0.1:3001";
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
		const signalTimeout = vi.spyOn(AbortSignal, "timeout");
		try {
			await GET();
			const apiBudgetMs = signalTimeout.mock.calls.at(-1)?.[0];
			const dockerfile = readFileSync(resolve(process.cwd(), "../../Dockerfile"), "utf8");
			const dockerBudgetSeconds = Number(
				dockerfile.match(/^HEALTHCHECK[^\n]*--timeout=(\d+)s/m)?.[1],
			);
			expect(Number.isFinite(apiBudgetMs)).toBe(true);
			expect(Number.isFinite(dockerBudgetSeconds)).toBe(true);
			expect(dockerBudgetSeconds * 1_000).toBeGreaterThan(apiBudgetMs! + 1_000);
		} finally {
			signalTimeout.mockRestore();
		}
	});
});
