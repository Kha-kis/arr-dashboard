import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Worker } from "node:worker_threads";
import { describe, expect, it, onTestFinished } from "vitest";
import {
	createJellyfinNativePageWorker,
	jellyfinNativePageWorkerUrl,
	runJellyfinNativePageWorker,
} from "../jellyfin-native-page-worker-transport.js";
import type { JellyfinNativePageWorkerRequest } from "../jellyfin-native-page-worker-protocol.js";

function fixture() {
	const workers = new Map<Worker, { exited: boolean; exit: Promise<unknown> }>();
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
		createWorker(url: URL, data: JellyfinNativePageWorkerRequest) {
			return track(createJellyfinNativePageWorker(url, data));
		},
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
	libraryId: "library-1",
	startIndex: 0,
	limit: 2,
};

describe("real native page workers", () => {
	it.each(["library", "episode"] as const)(
		"uses the existing validated server-scoped %s GET and modern authentication",
		async (domain) => {
			const owned = fixture();
			const requests: { method?: string; url?: string; authorization?: string; legacy?: string }[] =
				[];
			const baseUrl = await owned.server((request, response) => {
				requests.push({
					method: request.method,
					url: request.url,
					authorization: request.headers.authorization,
					legacy: request.headers["x-emby-token"] as string | undefined,
				});
				response.setHeader("Content-Type", "application/json");
				response.end(
					JSON.stringify({
						Items:
							domain === "library"
								? [{ Id: "m1", Type: "Movie", Name: null, ProviderIds: { Tmdb: "101" } }]
								: [
										{
											Id: "e1",
											Type: "Episode",
											Name: null,
											SeriesId: null,
											IndexNumber: null,
											ParentIndexNumber: null,
										},
									],
						StartIndex: 0,
						TotalRecordCount: 1,
					}),
				);
			});
			const result = await runJellyfinNativePageWorker(
				{ ...input, domain, baseUrl, deadlineAt: Date.now() + 5_000 },
				{ createWorker: owned.createWorker },
			);
			expect(result).toEqual({
				status: "page",
				domain,
				startIndex: 0,
				totalRecordCount: 1,
				items:
					domain === "library"
						? [{ id: "m1", type: "Movie", name: "", externalIds: { tmdb: [101] } }]
						: [{ id: "e1", type: "Episode", name: "" }],
			});
			expect(requests).toHaveLength(1);
			expect(requests[0]?.method).toBe("GET");
			const url = new URL(requests[0]!.url!, baseUrl);
			expect(url.pathname).toBe("/proxy/Items");
			expect(url.searchParams.get("ParentId")).toBe("library-1");
			expect(url.searchParams.get("IncludeItemTypes")).toBe(
				domain === "library" ? "Movie,Series,BoxSet" : "Episode",
			);
			expect(url.searchParams.get("EnableUserData")).toBe("false");
			expect(url.searchParams.get("Fields")).toBe(domain === "library" ? "ProviderIds" : null);
			expect(requests[0]?.authorization).toContain('MediaBrowser Token="KEY_SENTINEL"');
			expect(requests[0]?.legacy).toBeUndefined();
			expect(JSON.stringify(result)).not.toContain("SENTINEL");
		},
	);
	it("preserves Emby proxy Basic authentication and token headers without moving secrets into URLs", async () => {
		const owned = fixture();
		let authorized = false;
		const baseUrl = await owned.server((request, response) => {
			authorized =
				request.headers.authorization === "Basic AUTH_SENTINEL" &&
				request.headers["x-emby-token"] === "KEY_SENTINEL" &&
				String(request.headers["x-emby-authorization"]).includes('Token="KEY_SENTINEL"') &&
				!request.url?.includes("SENTINEL");
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify({ Items: [], StartIndex: 0, TotalRecordCount: 0 }));
		});
		await expect(
			runJellyfinNativePageWorker(
				{
					...input,
					baseUrl,
					httpAuthHeaders: { Authorization: "Basic AUTH_SENTINEL" },
					deadlineAt: Date.now() + 5_000,
				},
				{ createWorker: owned.createWorker },
			),
		).resolves.toMatchObject({ status: "page", items: [] });
		expect(authorized).toBe(true);
	});
	it("retains malformed coverage failure and sanitizes HTTP failure text", async () => {
		const owned = fixture();
		let calls = 0;
		const baseUrl = await owned.server((_request, response) => {
			response.setHeader("Content-Type", "application/json");
			if (calls++ === 0)
				response.end(
					JSON.stringify({
						Items: [{ Id: "e1", Type: "Movie" }],
						StartIndex: 0,
						TotalRecordCount: 1,
					}),
				);
			else {
				response.statusCode = 500;
				response.end("SECRET_SENTINEL");
			}
		});
		for (const reason of ["coverage-incomplete", "provider-unavailable"]) {
			const result = await runJellyfinNativePageWorker(
				{ ...input, domain: "episode", baseUrl, deadlineAt: Date.now() + 5_000 },
				{ createWorker: owned.createWorker },
			);
			expect(result).toEqual({ status: "unavailable", reason });
			expect(JSON.stringify(result)).not.toContain("SENTINEL");
		}
	});
	it("terminates and joins an uncooperative native response body that ignores its abort signal", async () => {
		const owned = fixture();
		const marker = new SharedArrayBuffer(4);
		let exited = false;
		const pending = runJellyfinNativePageWorker(
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
globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => { Atomics.store(new Int32Array(marker), 0, 1); while (true) {} } });
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
		"joins an uncancellable native %s request and closes its provider socket",
		async (phase) => {
			const owned = fixture();
			let closed: Promise<void> | undefined;
			const baseUrl = await owned.server((request, response) => {
				closed = new Promise<void>((resolve) => request.socket.once("close", () => resolve()));
				if (phase === "body") {
					response.writeHead(200, { "Content-Type": "application/json" });
					response.write('{"Items":[');
				}
			});
			await expect(
				runJellyfinNativePageWorker(
					{ ...input, baseUrl, deadlineAt: Date.now() + 5_000 },
					{
						timeoutMs: 1_000,
						requestTimeoutMs: 50,
						createWorker: (url, data) =>
							owned.track(
								new Worker(
									`
AbortSignal.timeout = () => new AbortController().signal;
(async () => { const { register } = await import("tsx/esm/api"); register(); await import(${JSON.stringify(url.href)}); })();
`,
									{
										eval: true,
										workerData: data,
										env: {},
										execArgv: [],
										stdout: true,
										stderr: true,
									},
								),
							),
					},
				),
			).rejects.toMatchObject({ category: "worker-timeout" });
			expect(closed).toBeDefined();
			await closed;
		},
	);
	it("never accepts a result whose worker subsequently fails", async () => {
		const owned = fixture();
		let exited = false;
		await expect(
			runJellyfinNativePageWorker(
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
			message: "Jellyfin native inventory page unavailable",
		});
		expect(exited).toBe(true);
	});
	it("uses the production worker layout after bundling", () => {
		expect(jellyfinNativePageWorkerUrl("file:///synthetic/dist/index.js").href).toBe(
			"file:///synthetic/dist/lib/jellyfin/jellyfin-native-page-worker.js",
		);
	});
});
