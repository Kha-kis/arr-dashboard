import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { MessageChannel, Worker } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
	createPlexNativePageWorker,
	plexNativePageWorkerUrl,
	runPlexNativePageWorker,
} from "../plex-native-page-worker-transport.js";
import type { PlexNativePageWorkerRequest } from "../plex-native-page-worker-protocol.js";

function fixture() {
	const workers = new Map<Worker, { exited: boolean; exit: Promise<void> }>();
	const sockets = new Set<Socket>();
	const servers: ReturnType<typeof createServer>[] = [];
	const output: string[] = [];
	function track(worker: Worker) {
		worker.stdout?.on("data", (chunk) => output.push(String(chunk)));
		worker.stderr?.on("data", (chunk) => output.push(String(chunk)));
		const state = {
			exited: false,
			exit: new Promise<void>((resolve) =>
				worker.once("exit", () => {
					state.exited = true;
					resolve();
				}),
			),
		};
		workers.set(worker, state);
		return worker;
	}
	onTestFinished(async () => {
		for (const [worker, state] of workers) {
			if (!state.exited) await worker.terminate();
			await state.exit;
		}
		for (const socket of sockets) socket.destroy();
		await Promise.all(
			servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
		);
		expect(output.join("")).not.toContain("SENTINEL");
	});
	return {
		track,
		createWorker: (url: URL, data: PlexNativePageWorkerRequest) =>
			track(createPlexNativePageWorker(url, data)),
		async server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
			const server = createServer(handler);
			servers.push(server);
			server.on("connection", (socket) => {
				sockets.add(socket);
				socket.once("close", () => sockets.delete(socket));
			});
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Synthetic fixture unavailable");
			return `http://127.0.0.1:${address.port}/proxy`;
		},
	};
}
const input = {
	baseUrl: "http://synthetic.invalid",
	apiKey: "KEY_SENTINEL",
	domain: "library" as const,
	sectionId: "owned/1",
	startIndex: 0,
	limit: 2,
};

describe("real Plex native page worker", () => {
	it("joins a stalled real body immediately on shutdown abort", async () => {
		const owned = fixture();
		const shutdown = new AbortController();
		let exited = false;
		let closed: Promise<void> | undefined;
		const baseUrl = await owned.server((request, response) => {
			closed = new Promise<void>((resolve) => request.socket.once("close", resolve));
			response.writeHead(200, { "Content-Type": "application/json" });
			response.write('{"MediaContainer":');
			shutdown.abort();
		});
		const pending = runPlexNativePageWorker({ ...input, baseUrl, deadlineAt: Date.now() + 5_000 }, {
			signal: shutdown.signal,
			timeoutMs: 1_500,
			createWorker: (url, data) => {
				const worker = owned.createWorker(url, data);
				worker.once("exit", () => {
					exited = true;
				});
				return worker;
			},
		} as Parameters<typeof runPlexNativePageWorker>[1]);
		await expect(pending).rejects.toMatchObject({ category: "cancelled" });
		expect(exited).toBe(true);
		expect(closed).toBeDefined();
		await closed;
	});
	it.each(["library", "episode"] as const)(
		"preserves the validated %s GET, proxy prefix and header credentials",
		async (domain) => {
			const owned = fixture();
			const requests: { method?: string; url?: string; token?: string; authorization?: string }[] =
				[];
			const baseUrl = await owned.server((request, response) => {
				requests.push({
					method: request.method,
					url: request.url,
					token: request.headers["x-plex-token"] as string,
					authorization: request.headers.authorization,
				});
				response.setHeader("Content-Type", "application/json");
				response.end(
					JSON.stringify({
						MediaContainer: {
							offset: 0,
							size: 1,
							totalSize: 1,
							Metadata:
								domain === "library"
									? [{ ratingKey: "m1", type: "movie", title: null, Guid: [{ id: "tmdb://101" }] }]
									: [
											{
												ratingKey: "e1",
												type: "episode",
												title: null,
												grandparentRatingKey: "s1",
												parentIndex: "0",
												index: "1",
											},
										],
						},
					}),
				);
			});
			const result = await runPlexNativePageWorker(
				{
					...input,
					domain,
					baseUrl,
					httpAuthHeaders: { Authorization: "Basic AUTH_SENTINEL" },
					deadlineAt: Date.now() + 5_000,
				},
				{ createWorker: owned.createWorker },
			);
			expect(result).toEqual({
				status: "page",
				domain,
				startIndex: 0,
				totalRecordCount: 1,
				items:
					domain === "library"
						? [{ ratingKey: "m1", type: "movie", title: "", externalIds: { tmdb: [101] } }]
						: [
								{
									ratingKey: "e1",
									type: "episode",
									title: "",
									grandparentRatingKey: "s1",
									seasonNumber: 0,
									episodeNumber: 1,
								},
							],
			});
			expect(requests).toHaveLength(1);
			expect(requests[0]?.method).toBe("GET");
			expect(
				requests[0]?.token === "KEY_SENTINEL" &&
					requests[0]?.authorization === "Basic AUTH_SENTINEL",
			).toBe(true);
			const url = new URL(requests[0]!.url!, baseUrl);
			expect(url.pathname).toBe("/proxy/library/sections/owned%2F1/all");
			expect(url.searchParams.get("X-Plex-Container-Start")).toBe("0");
			expect(url.searchParams.get("X-Plex-Container-Size")).toBe("2");
			expect(url.searchParams.get(domain === "library" ? "includeGuids" : "type")).toBe(
				domain === "library" ? "1" : "4",
			);
			expect(url.href).not.toContain("SENTINEL");
		},
	);
	it("retains coverage failures and sanitized provider errors", async () => {
		const owned = fixture();
		let calls = 0;
		const baseUrl = await owned.server((_request, response) => {
			response.setHeader("Content-Type", "application/json");
			if (calls++ === 0)
				response.end(JSON.stringify({ MediaContainer: { offset: 1, size: 0, totalSize: 0 } }));
			else {
				response.statusCode = 500;
				response.end("SECRET_SENTINEL");
			}
		});
		for (const reason of ["coverage-incomplete", "provider-unavailable"]) {
			const result = await runPlexNativePageWorker(
				{ ...input, baseUrl, deadlineAt: Date.now() + 5_000 },
				{ createWorker: owned.createWorker },
			);
			expect(result).toEqual({ status: "unavailable", reason });
		}
	});
	it("terminates and joins an actual abort-insensitive Response.json stream read", async () => {
		const owned = fixture();
		const marker = new SharedArrayBuffer(4);
		let exited = false;
		const pending = runPlexNativePageWorker(
			{ ...input, deadlineAt: Date.now() + 5_000 },
			{
				timeoutMs: 1_500,
				requestTimeoutMs: 50,
				createWorker: (url, data) => {
					const worker = owned.track(
						new Worker(
							`
const { workerData } = require("node:worker_threads");
const marker = workerData.marker; delete workerData.marker;
setInterval(() => {}, 100);
globalThis.fetch = async () => new Response(new ReadableStream({ pull() { Atomics.store(new Int32Array(marker), 0, 1); } }), { headers: { "Content-Type": "application/json" } });
(async () => { const { register } = await import("tsx/esm/api"); register(); await import(${JSON.stringify(url.href)}); })();
`,
							{
								eval: true,
								workerData: { ...data, marker },
								env: {},
								execArgv: [],
								stdout: true,
								stderr: true,
							},
						),
					);
					worker.once("exit", () => {
						exited = true;
					});
					return worker;
				},
			},
		);
		await expect(pending).rejects.toMatchObject({
			category: "worker-timeout",
			name: "TimeoutError",
		});
		expect(Atomics.load(new Int32Array(marker), 0)).toBe(1);
		expect(exited).toBe(true);
	});
	it.each(["headers", "body"])(
		"physically joins an uncancellable %s GET and closes its provider socket",
		async (phase) => {
			const owned = fixture();
			let closed: Promise<void> | undefined;
			let arrived!: () => void;
			const requestArrived = new Promise<void>((resolve) => {
				arrived = resolve;
			});
			let exited = false;
			const baseUrl = await owned.server((request, response) => {
				closed = new Promise<void>((resolve) => request.socket.once("close", () => resolve()));
				if (phase === "body") {
					response.writeHead(200, { "Content-Type": "application/json" });
					response.write('{"MediaContainer":');
				}
				arrived();
			});
			const bodyChannel = phase === "body" ? new MessageChannel() : undefined;
			const ready = bodyChannel
				? Promise.all([requestArrived, once(bodyChannel.port1, "message")])
				: requestArrived;
			const arrivalDeadline = new AbortController();
			// Advance only the parent timer after the real request reaches the intended phase.
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const pending = runPlexNativePageWorker(
					{ ...input, baseUrl, deadlineAt: Date.now() + 5_000 },
					{
						timeoutMs: 1_000,
						requestTimeoutMs: 50,
						createWorker: (url, data) => {
							const worker = owned.track(
								new Worker(
									`AbortSignal.timeout = () => new AbortController().signal;
const { workerData } = require("node:worker_threads");
const { bodyPort } = workerData;
delete workerData.bodyPort;
if (bodyPort) {
	const fetch = globalThis.fetch;
	globalThis.fetch = async (...args) => {
		const response = await fetch(...args);
		const target = response;
		const read = target.json;
		target.json = function (...readArgs) {
			const result = read.apply(this, readArgs);
			bodyPort.postMessage("reading");
			return result;
		};
		return response;
	};
}
(async () => { const { register } = await import("tsx/esm/api"); register(); await import(${JSON.stringify(url.href)}); })();`,
									{
										eval: true,
										workerData: { ...data, bodyPort: bodyChannel?.port2 },
										transferList: bodyChannel ? [bodyChannel.port2] : [],
										env: {},
										execArgv: [],
										stdout: true,
										stderr: true,
									},
								),
							);
							worker.once("exit", () => {
								exited = true;
							});
							return worker;
						},
					},
				);
				const outcome = pending.catch((error: unknown) => error);
				const phaseEntered = await Promise.race([
					ready.then(() => true),
					outcome.then(() => false),
					delay(4_000, false, { signal: arrivalDeadline.signal }),
				]);
				expect(phaseEntered, "Worker did not reach the requested HTTP phase").toBe(true);
				expect(closed).toBeDefined();
				await vi.advanceTimersByTimeAsync(1_000);
				expect(await outcome).toMatchObject({ category: "worker-timeout" });
			} finally {
				arrivalDeadline.abort();
				bodyChannel?.port1.close();
				bodyChannel?.port2.close();
				vi.useRealTimers();
			}
			expect(exited).toBe(true);
			await closed;
		},
	);
	it("rejects a provisional result when its real worker subsequently fails", async () => {
		const owned = fixture();
		let exited = false;
		await expect(
			runPlexNativePageWorker(
				{ ...input, deadlineAt: Date.now() + 5_000 },
				{
					createWorker: () => {
						const worker = owned.track(
							new Worker(
								'const { parentPort } = require("node:worker_threads"); parentPort.postMessage({ status: "page", domain: "library", startIndex: 0, totalRecordCount: 0, items: [] }); throw new Error("SECRET_SENTINEL");',
								{ eval: true, env: {}, execArgv: [], stdout: true, stderr: true },
							),
						);
						worker.once("exit", () => {
							exited = true;
						});
						return worker;
					},
				},
			),
		).rejects.toMatchObject({
			category: "worker-failed",
			message: "Plex native inventory page unavailable",
		});
		expect(exited).toBe(true);
	});
	it("creates workers with empty environment and exec arguments", async () => {
		const owned = fixture();
		const url = new URL(
			'data:text/javascript,import { parentPort } from "node:worker_threads"; parentPort.postMessage({ env: Object.keys(process.env), argv: process.execArgv }); parentPort.close();',
		);
		const worker = owned.track(
			createPlexNativePageWorker(url, {
				...input,
				version: 1,
				httpAuthHeaders: {},
				deadlineAt: Date.now() + 5_000,
				requestTimeoutMs: 1_000,
			}),
		);
		const [message] = await once(worker, "message");
		expect(message).toEqual({ env: [], argv: [] });
	});
	it("resolves the source and bundled entry and includes the runtime entry in the API build", async () => {
		expect(
			plexNativePageWorkerUrl("file:///synthetic/src/lib/plex/plex-native-page-worker-transport.ts")
				.href,
		).toBe("file:///synthetic/src/lib/plex/plex-native-page-worker.ts");
		expect(plexNativePageWorkerUrl("file:///synthetic/dist/index.js").href).toBe(
			"file:///synthetic/dist/lib/plex/plex-native-page-worker.js",
		);
		const pkg = JSON.parse(
			await readFile(new URL("../../../../package.json", import.meta.url), "utf8"),
		);
		expect(pkg.scripts.build.split(" ")).toContain("src/lib/plex/plex-native-page-worker.ts");
	});
});
