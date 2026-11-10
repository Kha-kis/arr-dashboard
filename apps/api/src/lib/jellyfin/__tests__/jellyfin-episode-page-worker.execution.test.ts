import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";
import { describe, expect, it, onTestFinished } from "vitest";
import type { JellyfinEpisodePageWorkerRequest } from "../jellyfin-episode-page-worker-protocol.js";
import {
	createJellyfinEpisodePageWorker,
	jellyfinEpisodePageWorkerUrl,
	runJellyfinEpisodePageWorker,
} from "../jellyfin-episode-page-worker-transport.js";

type CompilerResult = { code: number | null; signal: NodeJS.Signals | null; failed: boolean };
type ControlledCompiler = {
	directory: string;
	started: Promise<void>;
	closed: Promise<CompilerResult>;
	release(): void;
};

function createPageFixture() {
	let closing = false;
	let closePromise: Promise<void> | undefined;
	const listening = new Set<Promise<unknown>>();
	const workers = new Set<Worker>();
	const exits = new Set<Promise<unknown>>();
	const servers = new Set<Server>();
	const sockets = new Set<Socket>();
	type BuiltFixture = {
		directory: string;
		identity: { dev: bigint; ino: bigint; uid: bigint };
		compilerClose: Promise<CompilerResult>;
		outputs?: Record<string, string>;
		artifactSha256?: string;
		entrySourceSha256: string;
	};
	const builds: BuiltFixture[] = [];
	const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

	function assertOpen() {
		if (closing) throw new Error("Synthetic page-worker fixture is closing");
	}

	function assertOwnedBuild(build: BuiltFixture) {
		const current = lstatSync(build.directory, { bigint: true });
		if (
			!current.isDirectory() ||
			current.dev !== build.identity.dev ||
			current.ino !== build.identity.ino ||
			current.uid !== build.identity.uid ||
			realpathSync(build.directory) !== build.directory
		)
			throw new Error("Synthetic worker build directory identity changed");
	}

	function outputHashes(directory: string, current = directory): Record<string, string> {
		const files: Record<string, string> = {};
		for (const name of readdirSync(current).sort()) {
			const path = join(current, name);
			const stat = lstatSync(path);
			if (stat.isDirectory()) {
				chmodSync(path, 0o700);
				Object.assign(files, outputHashes(directory, path));
			} else {
				if (!stat.isFile()) throw new Error("Synthetic worker build output unavailable");
				chmodSync(path, 0o600);
				files[relative(directory, path)] = hash(readFileSync(path));
			}
		}
		return files;
	}

	async function prepareBuiltPageWorker(
		options: { holdCompiler?: (control: ControlledCompiler) => void } = {},
	): Promise<URL> {
		assertOpen();
		const apiRoot = realpathSync(fileURLToPath(new URL("../../../..", import.meta.url)));
		const require = createRequire(join(apiRoot, "package.json"));
		const tsupPackage = require.resolve("tsup/package.json");
		const cli = resolve(
			dirname(tsupPackage),
			JSON.parse(readFileSync(tsupPackage, "utf8")).bin.tsup,
		);
		const entry = join(apiRoot, "src/lib/jellyfin/jellyfin-episode-page-worker.ts");
		const entrySourceSha256 = hash(readFileSync(entry));
		const directory = mkdtempSync(join(realpathSync(tmpdir()), "arr-episode-page-worker-"));
		chmodSync(directory, 0o700);
		const build: BuiltFixture = {
			directory,
			identity: lstatSync(directory, { bigint: true }),
			compilerClose: Promise.resolve({ code: null, signal: null, failed: false }),
			entrySourceSha256,
		};
		builds.push(build);
		const config = join(directory, "tsup.config.mjs");
		writeFileSync(config, "export default { metafile: true };\n", { flag: "wx", mode: 0o600 });
		writeFileSync(join(directory, "package.json"), '{"type":"module"}\n', {
			flag: "wx",
			mode: 0o600,
		});
		symlinkSync(join(apiRoot, "node_modules"), join(directory, "node_modules"), "dir");
		const outDir = join(directory, "dist/lib/jellyfin");
		const args = [
			cli,
			entry,
			"--format",
			"esm",
			"--out-dir",
			outDir,
			"--config",
			config,
			"--tsconfig",
			join(apiRoot, "tsconfig.json"),
		];
		const environment = {
			PATH: process.env.PATH ?? dirname(process.execPath),
			LANG: "C.UTF-8",
			TZ: "UTC",
			NODE_ENV: "test",
			CI: "true",
			DOTENV_CONFIG_PATH: "/dev/null",
		};
		// The controlled case holds a real, already-admitted compiler process on
		// stdin, then invokes the same installed CLI and joins its actual close.
		const launchedArgs = options.holdCompiler
			? [
					"-e",
					`process.argv = ${JSON.stringify([process.execPath, ...args])}; process.stdin.once("end", () => require(${JSON.stringify(cli)})); process.stdin.resume();`,
				]
			: args;
		const compiler = spawn(process.execPath, launchedArgs, {
			cwd: apiRoot,
			env: environment,
			stdio: [options.holdCompiler ? "pipe" : "ignore", "pipe", "pipe"],
		});
		build.compilerClose = new Promise<CompilerResult>((resolveClose) => {
			let failed = false;
			compiler.once("error", () => {
				failed = true;
			});
			compiler.stdout!.resume();
			compiler.stderr!.resume();
			// close joins both independent process exit and drained stdio. A test
			// timeout never authorizes deleting an executing compiler's directory.
			compiler.once("close", (code, signal) => resolveClose({ code, signal, failed }));
		});
		if (options.holdCompiler) {
			let released = false;
			const started = new Promise<void>((resolveStarted) => {
				compiler.once("spawn", resolveStarted);
				compiler.once("error", () => resolveStarted());
			});
			options.holdCompiler({
				directory,
				started,
				closed: build.compilerClose,
				release() {
					if (!released) {
						released = true;
						compiler.stdin!.end();
					}
				},
			});
		}
		const result = await build.compilerClose;
		// The test timeout does not cancel this continuation. Closing is terminal
		// for this exact invocation even if a later test has started a new one.
		assertOpen();
		expect(result).toEqual({ code: 0, signal: null, failed: false });
		assertOwnedBuild(build);
		expect(hash(readFileSync(entry))).toBe(entrySourceSha256);
		const metadata = JSON.parse(readFileSync(join(outDir, "metafile-esm.json"), "utf8")) as {
			inputs: Record<string, unknown>;
		};
		const inputs = Object.fromEntries(
			Object.keys(metadata.inputs)
				.sort()
				.map((path) => [path, hash(readFileSync(resolve(apiRoot, path)))]),
		);
		build.outputs = outputHashes(join(directory, "dist"));
		const worker = jellyfinEpisodePageWorkerUrl(
			pathToFileURL(join(directory, "dist/index.js")).href,
		);
		build.artifactSha256 = hash(readFileSync(worker));
		process.stdout.write(
			`${JSON.stringify({ category: "test-page-worker-build", entrySourceSha256, inputs, outputs: build.outputs, artifactSha256: build.artifactSha256, compiler: { command: [process.execPath, ...launchedArgs], cwd: apiRoot, environment, ...result, closeJoined: true, pipesDrained: true } })}\n`,
		);
		return worker;
	}

	function trackedWorker(url: URL, payload: JellyfinEpisodePageWorkerRequest) {
		assertOpen();
		const worker = createJellyfinEpisodePageWorker(url, payload);
		workers.add(worker);
		const exit = new Promise<void>((resolve) =>
			worker.once("exit", () => {
				workers.delete(worker);
				resolve();
			}),
		);
		exits.add(exit);
		return worker;
	}

	async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
		assertOpen();
		const server = createServer(handler);
		servers.add(server);
		server.on("connection", (socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			if (closing) socket.destroy();
		});
		const ready = once(server, "listening");
		listening.add(ready);
		server.listen(0, "127.0.0.1");
		try {
			await ready;
		} finally {
			listening.delete(ready);
		}
		assertOpen();
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Synthetic loopback fixture unavailable");
		return {
			baseUrl: `http://127.0.0.1:${address.port}/SYNTHETIC_URL`,
			apiKey: "SECRET_SENTINEL",
			httpAuthHeaders: { Authorization: "AUTH_SENTINEL" },
			userId: "USER_SENTINEL",
			libraryId: "LIBRARY_SENTINEL",
			startIndex: 0,
			limit: 2000,
		};
	}

	async function joined<T>(operation: Promise<T>): Promise<T> {
		// Fixture-only watchdog: it can only fail, and joins actors before rejection.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const watchdog = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				void Promise.all([...workers].map((worker) => worker.terminate())).then(async () => {
					await Promise.all(exits);
					reject(new Error("Synthetic page-worker fixture watchdog expired"));
				});
			}, 10000);
		});
		try {
			return await Promise.race([operation, watchdog]);
		} finally {
			clearTimeout(timer);
		}
	}

	async function closedConnections() {
		await joined(
			Promise.all(
				[...sockets].map(
					(socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())),
				),
			),
		);
		expect(sockets.size).toBe(0);
		expect(workers.size).toBe(0);
	}

	async function drainActors() {
		await Promise.all([...workers].map((worker) => worker.terminate()));
		await Promise.all(exits);
		exits.clear();
		for (const server of servers) {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		servers.clear();
		expect(workers.size).toBe(0);
		expect(sockets.size).toBe(0);
	}

	function close(): Promise<void> {
		if (closePromise) return closePromise;
		// Close admission synchronously, before any await or actor-set snapshot.
		closing = true;
		closePromise = (async () => {
			await Promise.allSettled(listening);
			await drainActors();
			for (const build of builds.splice(0)) {
				const compiler = await build.compilerClose;
				assertOwnedBuild(build);
				if (compiler.code === 0 && compiler.signal === null && !compiler.failed) {
					const outputs = outputHashes(join(build.directory, "dist"));
					if (build.outputs) expect(outputs).toEqual(build.outputs);
					build.outputs = outputs;
					build.artifactSha256 ??= outputs["lib/jellyfin/jellyfin-episode-page-worker.js"];
				}
				// The exact mkdtemp-owned inode is removed only after compiler, worker,
				// and socket joins. rm unlinks the dependency symlink without traversal.
				rmSync(build.directory, { recursive: true });
				process.stdout.write(
					`${JSON.stringify({ category: "test-page-worker-cleanup", entrySourceSha256: build.entrySourceSha256, outputs: build.outputs, artifactSha256: build.artifactSha256 ?? null, compiler, compilerCloseJoined: true, workersExited: true, socketsClosed: true, ownedIdentityConfirmed: true, removed: true, admissionClosed: closing })}\n`,
				);
			}
		})();
		return closePromise;
	}

	onTestFinished(close);
	return {
		workers,
		sockets,
		servers,
		prepareBuiltPageWorker,
		trackedWorker,
		fixture,
		joined,
		closedConnections,
		close,
		drainActors,
	};
}

describe("real one-page GET worker", () => {
	it.each(["headers", "body"] as const)(
		"cancels a real held %s read and joins worker and socket before retry",
		async (phase) => {
			const fixture = createPageFixture(),
				controller = new AbortController();
			let response: ServerResponse | undefined, admitted!: () => void;
			const accepted = new Promise<void>((resolve) => {
				admitted = resolve;
			});
			const input = await fixture.fixture((_req, res) => {
				response = res;
				if (phase === "body") {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.write('{"');
				}
				admitted();
			});
			const pending = runJellyfinEpisodePageWorker(input, {
				signal: controller.signal,
				createWorker: fixture.trackedWorker,
			}).catch((error) => error);
			await fixture.joined(accepted);
			controller.abort(new Error("SECRET_SENTINEL"));
			let timer: ReturnType<typeof setTimeout> | undefined;
			const result = await Promise.race([
				pending,
				new Promise<"expired">((resolve) => {
					timer = setTimeout(() => resolve("expired"), 1500);
				}),
			]);
			clearTimeout(timer);
			const workerCount = fixture.workers.size;
			try {
				expect(result).not.toBe("expired");
				expect(result).toMatchObject({ category: "cancelled" });
				expect(workerCount).toBe(0);
				await fixture.closedConnections();
			} finally {
				if (response && !response.destroyed)
					response.end(phase === "body" ? 'unfinished":true}' : "{}");
				await pending;
				await fixture.close();
			}
		},
	);
	it("runs the emitted build entry against a real synthetic provider", async () => {
		const { prepareBuiltPageWorker, fixture, joined, trackedWorker, closedConnections } =
			createPageFixture();
		const builtWorker = await prepareBuiltPageWorker();
		const input = await fixture((_req, res) => {
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ StartIndex: 0, TotalRecordCount: 0, Items: [] }));
		});
		expect(
			await joined(
				runJellyfinEpisodePageWorker(input, {
					createWorker: (_url, payload) => trackedWorker(builtWorker, payload),
				}),
			),
		).toEqual({ startIndex: 0, totalRecordCount: 0, items: [] });
		await closedConnections();
		const uncountedInput = await fixture((req, res) => {
			expect(
				new URL(req.url!, "http://synthetic.invalid").searchParams.get("EnableTotalRecordCount"),
			).toBe("false");
			res.setHeader("Content-Type", "application/json");
			res.end(
				JSON.stringify({
					StartIndex: 2,
					TotalRecordCount: 1,
					Items: [
						{
							Id: "excluded",
							Type: "Episode",
							Name: null,
							UserData: { Played: false },
						},
					],
				}),
			);
		});
		expect(
			await joined(
				runJellyfinEpisodePageWorker(
					{ ...uncountedInput, startIndex: 2, uncounted: true },
					{
						createWorker: (_url, payload) => trackedWorker(builtWorker, payload),
					},
				),
			),
		).toEqual({
			startIndex: 2,
			totalRecordCount: null,
			countMode: "uncounted",
			items: [{ id: "excluded", type: "Episode", excludedReason: "missing-episode-metadata" }],
		});
		await closedConnections();
	});

	it("returns only a generic failure and no output for private malformed provider data", async () => {
		const { fixture, joined, trackedWorker, closedConnections } = createPageFixture();
		const input = await fixture((_req, res) => {
			res.setHeader("Content-Type", "application/json");
			res.end(
				JSON.stringify({
					StartIndex: 0,
					TotalRecordCount: 1,
					Items: [{ Id: "TITLE_SENTINEL", UserData: { Played: "SECRET_SENTINEL" } }],
				}),
			);
		});
		const output: string[] = [];
		const result = await joined(
			runJellyfinEpisodePageWorker(input, {
				createWorker: (url, payload) => {
					const worker = trackedWorker(url, payload);
					worker.stdout!.on("data", (chunk) => output.push(String(chunk)));
					worker.stderr!.on("data", (chunk) => output.push(String(chunk)));
					return worker;
				},
			}).catch((error: unknown) => error),
		);
		expect(result).toMatchObject({
			category: "provider-unavailable",
			message: "Jellyfin episode page unavailable",
		});
		expect(JSON.stringify(result)).not.toContain("SENTINEL");
		expect(output).toEqual([]);
		await closedConnections();
	});

	// Catches reimplementing/weakening the existing client normalization.
	it.each([false, true])(
		"preserves populated and excluded data through the source loader with uncounted=%s",
		async (uncounted) => {
			const { fixture, joined, trackedWorker, closedConnections } = createPageFixture();
			const requests: string[] = [];
			const input = await fixture((req, res) => {
				requests.push(req.url!);
				expect(req.method).toBe("GET");
				expect(req.headers["x-emby-token"]).toBe("SECRET_SENTINEL");
				expect(req.headers.authorization).toBe("AUTH_SENTINEL");
				res.setHeader("Content-Type", "application/json");
				res.end(
					JSON.stringify({
						StartIndex: uncounted ? 2 : 0,
						TotalRecordCount: 3,
						Items: [
							{
								Id: "episode-1",
								Name: "TITLE_SENTINEL",
								Type: "Episode",
								SeriesId: "series-1",
								IndexNumber: 1,
								ParentIndexNumber: 0,
								UserData: { Played: false },
								UnusedMetadata: null,
							},
							{
								Id: "excluded-2",
								Name: null,
								Type: "Episode",
								SeriesId: null,
								IndexNumber: null,
								UserData: { Played: true, PlayCount: 2 },
							},
							{
								Id: "episode-3",
								Name: null,
								Type: "Episode",
								SeriesId: "series-1",
								IndexNumber: 3,
								ParentIndexNumber: 1,
								UserData: { Played: true, PlayCount: 7, LastPlayedDate: "2026-09-01T00:00:00Z" },
							},
						],
					}),
				);
			});
			const output: string[] = [];
			const result = await joined(
				runJellyfinEpisodePageWorker(
					{ ...input, ...(uncounted ? { startIndex: 2, uncounted: true } : {}) },
					{
						createWorker: (url, payload) => {
							const worker = trackedWorker(url, payload);
							worker.stdout!.on("data", (chunk) => output.push(String(chunk)));
							worker.stderr!.on("data", (chunk) => output.push(String(chunk)));
							return worker;
						},
					},
				),
			);
			expect(result).toEqual({
				startIndex: uncounted ? 2 : 0,
				totalRecordCount: uncounted ? null : 3,
				...(uncounted ? { countMode: "uncounted" } : {}),
				items: [
					{
						id: "episode-1",
						name: "TITLE_SENTINEL",
						type: "Episode",
						seriesId: "series-1",
						episodeNumber: 1,
						seasonNumber: 0,
						played: false,
						playCount: null,
						lastPlayedDate: null,
					},
					{ id: "excluded-2", type: "Episode", excludedReason: "missing-episode-metadata" },
					{
						id: "episode-3",
						name: "",
						type: "Episode",
						seriesId: "series-1",
						episodeNumber: 3,
						seasonNumber: 1,
						played: true,
						playCount: 7,
						lastPlayedDate: "2026-09-01T00:00:00Z",
					},
				],
			});
			expect(requests).toHaveLength(1);
			const request = new URL(requests[0]!, input.baseUrl);
			expect(request.pathname).toBe("/SYNTHETIC_URL/Users/USER_SENTINEL/Items");
			expect(request.searchParams.get("ParentId")).toBe("LIBRARY_SENTINEL");
			expect(request.searchParams.get("StartIndex")).toBe(uncounted ? "2" : "0");
			expect(request.searchParams.get("EnableTotalRecordCount")).toBe(uncounted ? "false" : null);
			expect(request.searchParams.get("Limit")).toBe("2000");
			expect(output).toEqual([]);
			await closedConnections();
		},
	);

	it.each(["headers", "body"] as const)(
		"joins the real client after stalled %s and closes its server socket before retry",
		async (stall) => {
			const { fixture, joined, trackedWorker, closedConnections } = createPageFixture();
			let requests = 0;
			const input = await fixture((_req, res) => {
				requests++;
				res.setHeader("Content-Type", "application/json");
				if (requests > 1)
					return res.end(JSON.stringify({ StartIndex: 0, TotalRecordCount: 0, Items: [] }));
				if (stall === "body") {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.write('{"Items":[');
				}
			});
			const failure = await joined(
				runJellyfinEpisodePageWorker(input, {
					createWorker: trackedWorker,
					requestTimeoutMs: 100,
					timeoutMs: 5000,
				}).catch((error: unknown) => error),
			);
			expect(failure).toMatchObject({ category: "provider-unavailable" });
			expect(JSON.stringify(failure)).not.toContain("SENTINEL");
			expect(requests).toBe(1);
			await closedConnections();
			expect(
				await joined(runJellyfinEpisodePageWorker(input, { createWorker: trackedWorker })),
			).toEqual({ startIndex: 0, totalRecordCount: 0, items: [] });
			expect(requests).toBe(2);
			await closedConnections();
		},
	);

	it("physically joins an actor that never settles", async () => {
		const { workers, fixture, joined, trackedWorker } = createPageFixture();
		const input = await fixture(() => {
			throw new Error("Synthetic actor must not make requests");
		});
		const result = await joined(
			runJellyfinEpisodePageWorker(input, {
				timeoutMs: 150,
				createWorker: (_url, payload) =>
					trackedWorker(
						new URL("./fixtures/jellyfin-episode-page-worker-never.mjs", import.meta.url),
						payload,
					),
			}).catch((error: unknown) => error),
		);
		expect(result).toMatchObject({ category: "worker-timeout" });
		expect(workers.size).toBe(0);
	});

	it.each(["headers", "body"] as const)(
		"independently stops an uncancellable %s read and closes its socket before retry",
		async (stall) => {
			const { fixture, joined, trackedWorker, closedConnections } = createPageFixture();
			let requests = 0;
			const input = await fixture((_req, res) => {
				requests++;
				res.setHeader("Content-Type", "application/json");
				if (requests > 1)
					return res.end(JSON.stringify({ StartIndex: 0, TotalRecordCount: 0, Items: [] }));
				if (stall === "body") {
					res.writeHead(200);
					res.write('{"Items":[');
				}
			});
			const failure = await joined(
				runJellyfinEpisodePageWorker(input, {
					timeoutMs: 1000,
					createWorker: (_url, payload) =>
						trackedWorker(
							new URL("./fixtures/jellyfin-episode-page-worker-stalled.mjs", import.meta.url),
							payload,
						),
				}).catch((error: unknown) => error),
			);
			expect(failure).toMatchObject({ category: "worker-timeout" });
			expect(requests).toBe(1);
			await closedConnections();
			expect(
				await joined(runJellyfinEpisodePageWorker(input, { createWorker: trackedWorker })),
			).toEqual({ startIndex: 0, totalRecordCount: 0, items: [] });
			expect(requests).toBe(2);
			await closedConnections();
		},
	);

	it("waits for a delayed real exit with empty environment and execArgv", async () => {
		const { workers, fixture, joined, trackedWorker } = createPageFixture();
		const input = await fixture(() => {
			throw new Error("Synthetic actor must not make requests");
		});
		let received!: () => void;
		const message = new Promise<void>((resolve) => {
			received = resolve;
		});
		let settled = false;
		const pending = runJellyfinEpisodePageWorker(input, {
			createWorker: (_url, payload) => {
				const worker = trackedWorker(
					new URL("./fixtures/jellyfin-episode-page-worker-delayed.mjs", import.meta.url),
					payload,
				);
				worker.once("message", received);
				return worker;
			},
		}).then((value) => {
			settled = true;
			return value;
		});
		await joined(message);
		expect(settled).toBe(false);
		expect(workers.size).toBe(1);
		expect(await joined(pending)).toEqual({
			startIndex: 0,
			totalRecordCount: 1,
			items: [{ id: "excluded", type: "Episode", excludedReason: "missing-episode-metadata" }],
		});
		expect(workers.size).toBe(0);
	});
});

describe("page fixture closing admission", () => {
	it.each(["compiler-pending", "pre-provider", "pre-worker"] as const)(
		"blocks a late %s continuation without touching the next lifetime",
		async (phase) => {
			const old = createPageFixture();
			const next = createPageFixture();
			let control!: ControlledCompiler;
			let compilerEntered!: () => void;
			const compilerReady = new Promise<void>((resolveReady) => {
				compilerEntered = resolveReady;
			});
			let continueAdmission!: () => void;
			const admission = new Promise<void>((resolveAdmission) => {
				continueAdmission = resolveAdmission;
			});
			let providerReady!: () => void;
			const providerEntered = new Promise<void>((resolveProvider) => {
				providerReady = resolveProvider;
			});
			let providerAdmissions = 0;
			let workerAdmissions = 0;
			let compilerPhysicallyClosed = false;
			const preparing = old.prepareBuiltPageWorker(
				phase === "compiler-pending"
					? {
							holdCompiler(value) {
								control = value;
								void value.closed.then(() => {
									compilerPhysicallyClosed = true;
								});
								compilerEntered();
							},
						}
					: {},
			);
			const lateTask = (async () => {
				const built = await preparing;
				if (phase !== "pre-worker") await admission;
				const input = await old.fixture((_req, res) => {
					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify({ StartIndex: 0, TotalRecordCount: 0, Items: [] }));
				});
				providerAdmissions++;
				providerReady();
				if (phase === "pre-worker") await admission;
				return await old.joined(
					runJellyfinEpisodePageWorker(input, {
						createWorker: (_url, payload) => {
							const worker = old.trackedWorker(built, payload);
							workerAdmissions++;
							return worker;
						},
					}),
				);
			})().catch((error: unknown) => error);
			let closing: Promise<void> | undefined;
			let outcome: unknown;
			let lateServers = -1;
			try {
				if (phase === "compiler-pending") {
					await compilerReady;
					await control.started;
				} else if (phase === "pre-provider") await preparing;
				else await providerEntered;
				const nextInput = await next.fixture((_req, res) => {
					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify({ StartIndex: 0, TotalRecordCount: 0, Items: [] }));
				});
				closing = old.close();
				if (phase === "compiler-pending") {
					let closed = false;
					void closing.then(() => {
						closed = true;
					});
					await Promise.resolve();
					expect(compilerPhysicallyClosed).toBe(false);
					expect(closed).toBe(false);
					expect(lstatSync(control.directory).isDirectory()).toBe(true);
					control.release();
				}
				await closing;
				continueAdmission();
				outcome = await lateTask;
				lateServers = old.servers.size;
				expect(
					await next.joined(
						runJellyfinEpisodePageWorker(nextInput, { createWorker: next.trackedWorker }),
					),
				).toEqual({ startIndex: 0, totalRecordCount: 0, items: [] });
				await next.closedConnections();
			} finally {
				control?.release();
				continueAdmission();
				await closing;
				await lateTask;
				await old.drainActors();
				await old.close();
				await next.close();
			}
			process.stdout.write(
				`${JSON.stringify({ category: "test-page-worker-closing", phase, providerAdmissions, workerAdmissions, lateServers, compilerPhysicallyClosed: phase === "compiler-pending" ? compilerPhysicallyClosed : null, nextLifetimeHealthy: true })}\n`,
			);
			expect(providerAdmissions).toBe(phase === "pre-worker" ? 1 : 0);
			expect(workerAdmissions).toBe(0);
			expect(lateServers).toBe(0);
			expect(outcome).toBeInstanceOf(Error);
		},
	);
});
