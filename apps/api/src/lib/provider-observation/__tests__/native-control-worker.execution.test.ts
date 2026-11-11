import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Worker } from "node:worker_threads";
import { describe, expect, it, onTestFinished } from "vitest";
import {
	createNativeControlWorker,
	runNativeControlWorker,
} from "../native-control-worker-transport.js";
import type {
	NativeControlWorkerInput,
	NativeControlWorkerRequest,
} from "../native-control-worker-protocol.js";

const ignoreHttpAbortBootstrap = `const { workerData } = require("node:worker_threads");
const { fixtureModuleUrl } = workerData;
delete workerData.fixtureModuleUrl;
AbortSignal.timeout = () => new AbortController().signal;
(async () => {
	const { register } = await import("tsx/esm/api");
	register();
	await import(fixtureModuleUrl);
})();`;

function fixture() {
	const workers: Worker[] = [],
		sockets = new Set<Socket>();
	const output: string[] = [];
	const server = createServer();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	onTestFinished(async () => {
		await Promise.all(workers.map((worker) => worker.terminate()));
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		expect(output.join("")).not.toContain("SENTINEL");
	});
	const track = (worker: Worker) => {
		workers.push(worker);
		worker.stdout?.on("data", (chunk) => output.push(String(chunk)));
		worker.stderr?.on("data", (chunk) => output.push(String(chunk)));
		return worker;
	};
	return {
		track,
		createWorker: (url: URL, data: NativeControlWorkerRequest) =>
			track(createNativeControlWorker(url, data)),
		async server(handler: (req: IncomingMessage, res: ServerResponse) => void) {
			server.on("request", handler);
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Fixture unavailable");
			return `http://127.0.0.1:${address.port}/proxy`;
		},
	};
}
const connection = {
	apiKey: "KEY_SENTINEL",
	httpAuthHeaders: { Authorization: "Basic AUTH_SENTINEL" },
};
const plexScope = {
	domain: "library",
	sectionKey: "1",
	sectionUuid: "uuid-1",
	sectionType: "show",
	scopeKey: '["1","uuid-1","show"]',
};

describe("real native control worker", () => {
	it("retains closed HTTP failure and already-expired deadline behavior", async () => {
		const owned = fixture();
		let calls = 0;
		const baseUrl = await owned.server((_request, response) => {
			calls++;
			response.statusCode = 500;
			response.end("PRIVATE_SENTINEL");
		});
		const input = {
			...connection,
			baseUrl,
			provider: "plex" as const,
			workKey: "paired" as const,
			operation: "identity" as const,
			deadlineAt: Date.now() + 5_000,
		};
		await expect(
			runNativeControlWorker(input, { createWorker: owned.createWorker }),
		).rejects.toMatchObject({ category: "provider-unavailable" });
		expect(
			await runNativeControlWorker(
				{ ...input, deadlineAt: Date.now() - 1 },
				{ createWorker: owned.createWorker },
			),
		).toEqual({ status: "unavailable", reason: "deadline-exceeded" });
		expect(calls).toBe(1);
	});
	it("physically times out and joins a control worker that ignores HTTP abort", async () => {
		const owned = fixture();
		let exited = false,
			closed: Promise<void> | undefined;
		const baseUrl = await owned.server((request, response) => {
			closed = new Promise<void>((resolve) => request.socket.once("close", resolve));
			response.writeHead(200, { "Content-Type": "application/json" });
			response.write('{"unfinished":');
		});
		await expect(
			runNativeControlWorker(
				{
					...connection,
					baseUrl,
					provider: "plex",
					workKey: "paired",
					operation: "identity",
					deadlineAt: Date.now() + 5_000,
				},
				{
					timeoutMs: 1_000,
					requestTimeoutMs: 50,
					createWorker: (url, data) => {
						const worker = owned.track(
							new Worker(ignoreHttpAbortBootstrap, {
								eval: true,
								workerData: { ...data, fixtureModuleUrl: url.href },
								env: {},
								execArgv: [],
								stdout: true,
								stderr: true,
							}),
						);
						worker.once("exit", () => {
							exited = true;
						});
						return worker;
					},
				},
			),
		).rejects.toMatchObject({ category: "worker-timeout" });
		expect(exited).toBe(true);
		expect(closed).toBeDefined();
		await closed;
	});
	it.each(["plex", "jellyfin"] as const)(
		"uses the existing authenticated %s identity contract",
		async (provider) => {
			const owned = fixture();
			const requests: { method?: string; path: string; authenticated: boolean }[] = [];
			const baseUrl = await owned.server((request, response) => {
				requests.push({
					method: request.method,
					path: request.url!,
					authenticated:
						request.headers[provider === "plex" ? "x-plex-token" : "x-emby-token"] ===
							connection.apiKey &&
						request.headers.authorization === connection.httpAuthHeaders.Authorization,
				});
				response.setHeader("Content-Type", "application/json");
				response.end(
					JSON.stringify(
						provider === "plex"
							? { MediaContainer: { machineIdentifier: "synthetic-id", version: "1" } }
							: { Id: "synthetic-id", ServerName: "Synthetic", Version: "1" },
					),
				);
			});
			const input = {
				...connection,
				baseUrl,
				operation: "identity" as const,
				deadlineAt: Date.now() + 5_000,
				...(provider === "plex"
					? { provider, workKey: "paired" as const }
					: { provider, workKey: "library" as const }),
			};
			expect(await runNativeControlWorker(input, { createWorker: owned.createWorker })).toEqual({
				status: "identity",
				identity: "synthetic-id",
			});
			expect(requests).toEqual([
				{
					method: "GET",
					path: provider === "plex" ? "/proxy/identity" : "/proxy/System/Info",
					authenticated: true,
				},
			]);
		},
	);
	it.each([false, true])(
		"retains Plex settled catalog and paired scope normalization (refreshing=%s)",
		async (refreshing) => {
			const owned = fixture();
			const paths: string[] = [];
			const baseUrl = await owned.server((request, response) => {
				paths.push(request.url!);
				response.setHeader("Content-Type", "application/json");
				response.end(
					JSON.stringify({
						MediaContainer: request.url!.endsWith("/activities")
							? { size: 0, Activity: [] }
							: {
									size: 1,
									Directory: [
										{
											key: "1",
											uuid: "uuid-1",
											type: "show",
											title: "Synthetic",
											refreshing,
											scannedAt: 10,
											updatedAt: 10,
										},
									],
								},
					}),
				);
			});
			const result = await runNativeControlWorker(
				{
					...connection,
					baseUrl,
					provider: "plex",
					workKey: "paired",
					operation: "discovery",
					deadlineAt: Date.now() + 5_000,
				},
				{ createWorker: owned.createWorker },
			);
			expect(result).toEqual(
				refreshing
					? { status: "unavailable", reason: "coverage-incomplete" }
					: {
							status: "ready",
							catalogIdentity: '[["1","uuid-1","show",10,10]]',
							scopes: [plexScope, { ...plexScope, domain: "episode" }],
						},
			);
			expect(paths.sort()).toEqual(["/proxy/activities", "/proxy/library/sections"]);
		},
	);
	it.each(["library", "episode"] as const)(
		"retains Jellyfin %s folder normalization and playlist exclusion",
		async (workKey) => {
			const owned = fixture();
			const baseUrl = await owned.server((request, response) => {
				expect(request.method).toBe("GET");
				expect(request.url).toBe("/proxy/Library/MediaFolders");
				response.setHeader("Content-Type", "application/json");
				response.end(
					JSON.stringify({
						TotalRecordCount: 3,
						Items: [
							{ Id: "b", Name: "Synthetic", Type: "Folder" },
							{ Id: "a", Name: "Synthetic", Type: "CollectionFolder", CollectionType: "" },
							{
								Id: "playlist",
								Name: "Synthetic",
								Type: "CollectionFolder",
								CollectionType: "playlists",
							},
						],
					}),
				);
			});
			expect(
				await runNativeControlWorker(
					{
						...connection,
						baseUrl,
						provider: "jellyfin",
						workKey,
						operation: "discovery",
						deadlineAt: Date.now() + 5_000,
					},
					{ createWorker: owned.createWorker },
				),
			).toEqual({
				status: "ready",
				catalogIdentity: '[["library:a","CollectionFolder"],["library:b","Folder"]]',
				scopes: [
					{ libraryId: "a", collectionType: "CollectionFolder", scopeKey: "library:a" },
					{ libraryId: "b", collectionType: "Folder", scopeKey: "library:b" },
				],
			});
		},
	);
	for (const provider of ["plex", "jellyfin"] as const)
		for (const operation of ["identity", "discovery"] as const)
			for (const phase of ["headers", "body"] as const) {
				it(`${provider} ${operation} abort joins an abort-insensitive ${phase} read and closes sockets`, async () => {
					const owned = fixture(),
						shutdown = new AbortController();
					const closed: Promise<void>[] = [];
					let exited = false,
						abortedAt = 0;
					const baseUrl = await owned.server((request, response) => {
						closed.push(new Promise<void>((resolve) => request.socket.once("close", resolve)));
						if (phase === "body") {
							response.writeHead(200, { "Content-Type": "application/json" });
							response.write('{"unfinished":');
						}
						abortedAt = performance.now();
						shutdown.abort();
					});
					const input: NativeControlWorkerInput = {
						...connection,
						baseUrl,
						operation,
						deadlineAt: Date.now() + 5_000,
						...(provider === "plex"
							? { provider, workKey: "paired" }
							: { provider, workKey: "episode" }),
					};
					await expect(
						runNativeControlWorker(input, {
							signal: shutdown.signal,
							timeoutMs: 2_000,
							requestTimeoutMs: 50,
							createWorker: (url, data) => {
								const worker = owned.track(
									new Worker(ignoreHttpAbortBootstrap, {
										eval: true,
										workerData: { ...data, fixtureModuleUrl: url.href },
										env: {},
										execArgv: [],
										stdout: true,
										stderr: true,
									}),
								);
								worker.once("exit", () => {
									exited = true;
								});
								return worker;
							},
						}),
					).rejects.toMatchObject({ category: "cancelled" });
					expect(exited).toBe(true);
					expect(closed.length).toBeGreaterThan(0);
					await Promise.all(closed);
					expect(performance.now() - abortedAt).toBeLessThan(1_000);
				});
			}
	it("contains an actual abort-insensitive Response.json stream", async () => {
		const owned = fixture(),
			marker = new SharedArrayBuffer(4),
			shutdown = new AbortController();
		let exited = false;
		const pending = runNativeControlWorker(
			{
				...connection,
				baseUrl: "http://synthetic.invalid",
				provider: "jellyfin",
				workKey: "episode",
				operation: "identity",
				deadlineAt: Date.now() + 5_000,
			},
			{
				signal: shutdown.signal,
				timeoutMs: 2_000,
				requestTimeoutMs: 50,
				createWorker: (url, data) => {
					const worker = owned.track(
						new Worker(
							`const { workerData, parentPort } = require("node:worker_threads");
const { marker, fixtureModuleUrl } = workerData;
delete workerData.marker;
delete workerData.fixtureModuleUrl;
setInterval(() => {}, 100);
globalThis.fetch = async () => new Response(new ReadableStream({ pull() { Atomics.store(new Int32Array(marker), 0, 1); parentPort.postMessage("body-entered"); } }), { headers: { "Content-Type": "application/json" } });
(async () => { const { register } = await import("tsx/esm/api"); register(); await import(fixtureModuleUrl); })();`,
							{
								eval: true,
								workerData: { ...data, marker, fixtureModuleUrl: url.href },
								env: {},
								execArgv: [],
								stdout: true,
								stderr: true,
							},
						),
					);
					// Intercept the fixture-only marker before the transport sees it.
					worker.prependListener("message", () => shutdown.abort());
					worker.once("exit", () => {
						exited = true;
					});
					return worker;
				},
			},
		);
		await expect(pending).rejects.toMatchObject({ category: "cancelled" });
		expect(Atomics.load(new Int32Array(marker), 0)).toBe(1);
		expect(exited).toBe(true);
	});
	it("uses an empty environment and exec arguments", async () => {
		const owned = fixture();
		const worker = owned.track(
			createNativeControlWorker(
				new URL(
					'data:text/javascript,import { parentPort } from "node:worker_threads"; parentPort.postMessage({ env: Object.keys(process.env), argv: process.execArgv }); parentPort.close();',
				),
				{} as NativeControlWorkerRequest,
			),
		);
		const [message] = await once(worker, "message");
		expect(message).toEqual({ env: [], argv: [] });
		await once(worker, "exit");
	});
});
