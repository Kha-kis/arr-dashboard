import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { readProviderIdentity } from "../service-identity.js";

const log = pino({ enabled: false });
describe("actual provider identity cancellation", () => {
	for (const service of ["PLEX", "JELLYFIN", "EMBY", "TAUTULLI"] as const) {
		for (const phase of ["headers", "body", "unsignaled"] as const) {
			it(`${service}: ${phase}`, async () => {
				const sockets = new Set<Socket>();
				let response: ServerResponse | undefined,
					accepted!: () => void,
					requests = 0;
				const ready = new Promise<void>((resolve) => {
					accepted = resolve;
				});
				const body = JSON.stringify(
					service === "PLEX"
						? { MediaContainer: { machineIdentifier: "synthetic", version: "1" } }
						: service === "TAUTULLI"
							? {
									response: {
										result: "success",
										message: null,
										data: { pms_identifier: "synthetic", pms_name: "Synthetic" },
									},
								}
							: { Id: "synthetic", ServerName: "Synthetic", Version: "1" },
				);
				const server = createServer((_request, reply) => {
					requests++;
					response = reply;
					reply.once("close", () => {});
					if (phase === "body") {
						reply.writeHead(200, { "Content-Type": "application/json" });
						reply.write(body.slice(0, 1));
					}
					if (phase === "unsignaled") {
						reply.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
						reply.end(body);
					}
					accepted();
				});
				server.on("connection", (socket) => {
					sockets.add(socket);
					socket.once("close", () => sockets.delete(socket));
				});
				server.listen(0, "127.0.0.1");
				await once(server, "listening");
				const address = server.address();
				if (!address || typeof address === "string") throw Error("loopback required");
				const controller = new AbortController();
				let done = false;
				const running = readProviderIdentity(
					{ service, baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "synthetic" },
					log,
					phase === "unsignaled" ? undefined : controller.signal,
				).then(
					(value) => {
						done = true;
						return { value, error: undefined };
					},
					(error: unknown) => {
						done = true;
						return { value: undefined, error };
					},
				);
				try {
					await ready;
					if (phase !== "unsignaled") {
						controller.abort(new Error("private abort reason"));
						for (let i = 0; i < 150 && !done; i++) await delay(10);
						expect(done, "real identity read must settle on cancellation").toBe(true);
					}
					const result = await running;
					if (phase === "unsignaled") expect(result.value?.rawIdentity).toBe("synthetic");
					else {
						expect(result.error).toBeInstanceOf(Error);
						expect(String(result.error)).not.toContain("private abort reason");
					}
					expect(requests).toBe(1);
				} finally {
					response?.destroy();
					await running;
					for (const socket of sockets) socket.destroy();
					await new Promise<void>((resolve) => server.close(() => resolve()));
				}
			}, 20_000);
		}
	}
	it("does not dispatch a pre-canceled identity request", async () => {
		const controller = new AbortController();
		controller.abort(new Error("private abort reason"));
		let requests = 0;
		const server = createServer((_request, reply) => {
			requests++;
			reply.end("{}");
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw Error("loopback required");
		try {
			for (const service of ["PLEX", "JELLYFIN", "EMBY", "TAUTULLI"] as const)
				await expect(
					readProviderIdentity(
						{ service, baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "synthetic" },
						log,
						controller.signal,
					),
				).rejects.not.toThrow("private abort reason");
			expect(requests).toBe(0);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
