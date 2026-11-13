import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { JellyfinClient } from "../jellyfin-client.js";

const log = pino({ enabled: false });
describe("Jellyfin explicit read signal", () => {
	it("prevents a later read without affecting a concurrent unsignaled client", async () => {
		let requests = 0;
		const server = createServer((_request, reply) => {
			requests++;
			reply.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
			reply.end("[]");
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw Error("loopback required");
		const url = `http://127.0.0.1:${address.port}`,
			controller = new AbortController();
		const client = new JellyfinClient(
				url,
				"synthetic",
				log,
				undefined,
				undefined,
				undefined,
				controller.signal,
			),
			ordinary = new JellyfinClient(url, "synthetic", log);
		try {
			await expect(client.getUsers()).resolves.toEqual([]);
			controller.abort(new Error("private reason"));
			const canceled = expect(client.getUsers()).rejects.toThrow();
			await expect(ordinary.getUsers()).resolves.toEqual([]);
			await canceled;
			expect(requests).toBe(2);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
	it("does not wait out retry sleep or dispatch a retry after cancellation", async () => {
		let requests = 0,
			seen!: () => void;
		const accepted = new Promise<void>((resolve) => {
			seen = resolve;
		});
		const server = createServer((_request, reply) => {
			requests++;
			reply.writeHead(503, { "Content-Type": "application/json", Connection: "close" });
			reply.end("{}");
			seen();
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw Error("loopback required");
		const controller = new AbortController(),
			client = new JellyfinClient(
				`http://127.0.0.1:${address.port}`,
				"synthetic",
				log,
				undefined,
				undefined,
				undefined,
				controller.signal,
			);
		let settled = false;
		const running = client.getNativeEpisodeItemsWithCoverage("library").then(
			(value) => {
				settled = true;
				return value;
			},
			() => {
				settled = true;
				return undefined;
			},
		);
		try {
			await accepted;
			await delay(25);
			const started = performance.now();
			controller.abort();
			for (let i = 0; i < 100 && !settled; i++) await delay(10);
			expect(settled).toBe(true);
			expect(performance.now() - started).toBeLessThan(1200);
			await running;
			expect(requests).toBe(1);
		} finally {
			controller.abort();
			await running;
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
