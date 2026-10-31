import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MessageChannel, Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import {
	attachRestoreRuntimeWorker,
	getRestoreRuntimeClientContext,
	openRestoreRuntime,
} from "../../backup/restore-runtime-admission.js";
import { synchronizeRuntimeSchema } from "../../backup/runtime-schema-startup.js";
import { createNotificationOutboxNativeFixture } from "../../notifications/__tests__/notification-outbox-native-fixture.js";
import { prepareNativeWatchGeneration } from "../jellyfin-native-watch-repository.js";

it.each(["pre-aborted", "row-chunk", "verification", "diagnostic-only"] as const)(
	"native watch cancellation checkpoint preserves joined work and last-good pointers: %s",
	async (mode) => {
		const native = await createNotificationOutboxNativeFixture();
		const fileUrl = new URL(getRestoreRuntimeClientContext(native.runtime).databaseUrl);
		if (fileUrl.protocol !== "file:") throw Error("Owned synthetic SQLite fixture required");
		const file = fileURLToPath(fileUrl),
			directory = dirname(file);
		const assertTarget = () => {
			if (
				basename(file) !== "owned.db" ||
				dirname(directory) !== realpathSync(tmpdir()) ||
				!/^arr-outbox-worker-[A-Za-z0-9]+$/.test(basename(directory)) ||
				!lstatSync(directory).isDirectory() ||
				lstatSync(directory).isSymbolicLink() ||
				realpathSync(directory) !== directory
			)
				throw Error("Owned synthetic SQLite fixture required");
		};
		assertTarget();
		const channel = new MessageChannel(),
			controller = new AbortController(),
			cancelled = new Error("Synthetic native preparation cancelled");
		let messageSent = false,
			messageDelivered = false,
			resolveDelivery!: () => void;
		const delivered = new Promise<void>((resolve) => {
			resolveDelivery = resolve;
		});
		channel.port2.once("message", () => {
			messageDelivered = true;
			controller.abort();
			resolveDelivery();
		});
		const sendCancellation = () => {
			if (!messageSent) {
				messageSent = true;
				channel.port1.postMessage("cancel");
			}
		};
		try {
			await native.run(async () => {
				const encrypted = native.encryptor.encrypt("synthetic-token"),
					now = new Date();
				const instance = await native.prisma.serviceInstance.create({
					data: {
						userId: native.userId,
						service: "JELLYFIN",
						label: "Synthetic",
						baseUrl: "http://synthetic.invalid",
						enabled: true,
						encryptedApiKey: encrypted.value,
						encryptionIv: encrypted.iv,
						identityStatus: "VERIFIED",
						expectedIdentity: "synthetic-id",
						connectionGeneration: 1,
						identityGeneration: 1,
					},
				});
				const run = await native.prisma.providerObservationRun.create({
					data: {
						instanceId: instance.id,
						provider: "jellyfin_episode",
						cacheType: "jellyfin_episode",
						authorityKey: "synthetic-authority",
						targetDigest: "synthetic-target",
						targetCount: 1,
						connectionGeneration: 1,
						identityGeneration: 1,
						state: "running",
						activeSlotKey: "synthetic-current",
						totalUnits: 1,
						completedUnits: 1,
						totalWork: 1,
						completedWork: 1,
					},
				});
				const unit = await native.prisma.providerObservationUnit.create({
					data: {
						runId: run.id,
						ordinal: 0,
						scopeKey: "synthetic-scope",
						scopeDigest: "synthetic-scope",
						phase: "collect",
						expectedTargets: 1,
						state: "complete",
						cursor: 250,
						observedRawCount: 250,
						completedPages: 3,
						attemptCount: 2,
					},
				});
				await native.prisma.jellyfinEpisodePreparation.create({
					data: {
						runId: run.id,
						instanceId: instance.id,
						generationId: run.id,
						token: "synthetic-token",
						state: "verified",
						leaseExpiresAt: new Date(Date.now() + 300_000),
					},
				});
				const pointer = await native.prisma.jellyfinNativeWatchPublication.create({
					data: {
						instanceId: instance.id,
						activeRunId: "last-good-run",
						activeCacheGenerationId: "last-good",
						activeObservedAt: now,
						activeExpectedScopeCount: 1,
						connectionGeneration: 1,
						identityGeneration: 1,
					},
				});
				const status = await native.prisma.cacheRefreshStatus.create({
					data: {
						instanceId: instance.id,
						cacheType: "jellyfin_episode",
						generationId: "last-good",
						generationMetadata: "last-good-metadata",
						lastResult: "success",
						lastRefreshedAt: now,
						lastAttemptAt: now,
						lastAttemptResult: "success",
						connectionGeneration: 1,
						identityGeneration: 1,
					},
				});
				const count = mode === "verification" ? 750 : 250;
				const input = {
					userId: native.userId,
					instanceId: instance.id,
					runId: run.id,
					cacheGenerationId: run.id,
					preparationToken: "synthetic-token",
					connectionGeneration: 1,
					identityGeneration: 1,
					observedAt: now,
					expectedScopeCount: 1,
					candidates: Array.from({ length: count }, (_, index) => ({
						userKeyDigest: "synthetic-user",
						libraryId: "synthetic-library",
						jellyfinId: `episode-${String(index).padStart(5, "0")}`,
						seriesId: "synthetic-series",
						seasonNumber: 1,
						episodeNumber: index + 1,
						played: false,
						playCount: 0,
						lastPlayedAt: null,
					})),
					receipts: [
						{
							userKeyDigest: "synthetic-user",
							libraryId: "synthetic-library",
							expectedRawCount: count,
							observedRawCount: count,
							exact: true,
							contentFingerprint: "a".repeat(64),
						},
					],
				};
				let rowChunks = 0,
					rowRequests = 0,
					verificationPages = 0,
					checkpointCalls = 0;
				if (mode === "pre-aborted") controller.abort();
				const outcome = await prepareNativeWatchGeneration(
					native.prisma,
					input,
					(event) => {
						if (mode === "diagnostic-only") throw cancelled;
						if (
							event.stage === "row-verification" &&
							++verificationPages === 2 &&
							mode === "verification"
						)
							sendCancellation();
					},
					(event) => {
						if (event.kind === "row-chunk" && event.phase === "requested") rowRequests++;
						if (event.kind === "row-chunk" && event.phase === "succeeded") {
							rowChunks++;
							if (mode === "row-chunk" && rowChunks === 1) sendCancellation();
						}
					},
					async () => {
						checkpointCalls++;
						await new Promise<void>((resolve) => setImmediate(resolve));
						if (messageSent) await delivered;
						if (controller.signal.aborted) throw cancelled;
					},
				).then(
					() => false,
					(error) => error === cancelled,
				);
				const staged = await native.prisma.jellyfinNativeWatchRow.count({
					where: { runId: run.id },
				});
				expect.soft(outcome).toBe(mode !== "diagnostic-only");
				if (mode === "pre-aborted") {
					expect.soft(rowRequests).toBe(0);
					expect.soft(staged).toBe(0);
				}
				if (mode === "row-chunk") {
					expect.soft(rowChunks).toBe(1);
					expect.soft(rowRequests).toBe(1);
					expect.soft(staged).toBe(100);
					expect.soft(messageDelivered).toBe(true);
				}
				if (mode === "verification") {
					expect.soft(verificationPages).toBe(2);
					expect.soft(staged).toBe(750);
					expect.soft(messageDelivered).toBe(true);
				}
				if (mode === "diagnostic-only") expect(staged).toBe(250);
				expect.soft(checkpointCalls).toBeGreaterThan(0);
				expect(
					await native.prisma.jellyfinNativeWatchPublication.findUniqueOrThrow({
						where: { instanceId: instance.id },
					}),
				).toEqual(pointer);
				expect(
					await native.prisma.cacheRefreshStatus.findUniqueOrThrow({ where: { id: status.id } }),
				).toEqual(status);
				expect(
					await native.prisma.providerObservationUnit.findUniqueOrThrow({ where: { id: unit.id } }),
				).toEqual(unit);
				await prepareNativeWatchGeneration(native.prisma, input);
				expect(await native.prisma.jellyfinNativeWatchRow.count({ where: { runId: run.id } })).toBe(
					count,
				);
				expect(
					await native.prisma.jellyfinNativeWatchScopeReceipt.count({ where: { runId: run.id } }),
				).toBe(1);
				expect(
					await native.prisma.jellyfinNativeWatchPublication.findUniqueOrThrow({
						where: { instanceId: instance.id },
					}),
				).toEqual(pointer);
				expect(
					await native.prisma.cacheRefreshStatus.findUniqueOrThrow({ where: { id: status.id } }),
				).toEqual(status);
				process.stdout.write(
					`${JSON.stringify({ category: "native-watch-cancellation-checkpoint", mode, rowChunks, rowRequests, staged, checkpointCalls, messageDelivered, retriedRows: count, pointerRetained: true, retryAllowanceRetained: true })}\n`,
				);
			});
		} finally {
			channel.port1.close();
			channel.port2.close();
			await native.close();
			assertTarget();
			rmSync(directory, { recursive: true });
		}
	},
	20_000,
);

it("fully verifies loaded native row staging within unchanged transaction defaults and rolls back a later failed chunk", async () => {
	const directory = mkdtempSync(join(tmpdir(), "jellyfin-native-watch-budget-"));
	chmodSync(directory, 0o700);
	const databaseUrl = `file:${join(directory, "owned.sqlite")}`;
	const database = new Database(databaseUrl.slice(5));
	database.pragma("journal_mode=WAL");
	database.close();
	chmodSync(databaseUrl.slice(5), 0o600);
	const losses: string[] = [];
	let runtime: Awaited<ReturnType<typeof openRestoreRuntime>> | undefined;
	let worker: Worker | undefined;
	let joined: Promise<number> | undefined;
	let exited = false;
	let workerError = false;
	let bridgeClosed = false;
	let parentClosed = false;
	let report: unknown;
	let exitCode: number | undefined;
	try {
		await synchronizeRuntimeSchema(databaseUrl);
		runtime = await openRestoreRuntime({
			databaseUrl,
			onUnavailable: (event) => losses.push(event.reason),
		});
		await runtime.bindDestination("synthetic-native-watch");
		await runtime.activate();
		await runtime.runOperation(async () => {
			const bridge = await attachRestoreRuntimeWorker(databaseUrl);
			try {
				// Register the installed TS loader in the actual isolate; no admission,
				// client, repository or transaction is mocked or bundled away.
				const require = createRequire(import.meta.url);
				worker = new Worker(
					`(async () => {
					const { workerData } = require("node:worker_threads");
					const { register } = await import(workerData.tsx); register();
					await import(workerData.fixture);
				})().catch(error => { console.error(error); process.exitCode = 1; });`,
					{
						eval: true,
						execArgv: [],
						workerData: {
							databaseUrl,
							binding: bridge.binding,
							tsx: pathToFileURL(require.resolve("tsx/esm/api")).href,
							fixture: new URL("./fixtures/jellyfin-native-watch-budget-worker.ts", import.meta.url)
								.href,
						},
						transferList: [bridge.binding.port],
						env: {
							PATH: process.env.PATH,
							LANG: "C.UTF-8",
							TZ: "UTC",
							NODE_ENV: "test",
							DOTENV_CONFIG_PATH: "/dev/null",
						},
					},
				);
				joined = new Promise<number>((resolve) =>
					worker!.once("exit", (code) => {
						exited = true;
						resolve(code);
					}),
				);
				worker.on("error", () => {
					workerError = true;
				});
				worker.on("message", (message: unknown) => {
					report = message;
				});
				exitCode = await joined;
			} finally {
				await bridge.close();
				bridgeClosed = true;
			}
		});
	} finally {
		if (worker && !exited) {
			await worker.terminate();
			await joined;
		}
		await runtime?.close();
		parentClosed = true;
		// Never dispose a database tree while its physical native actor is live.
		if (!worker || exited) rmSync(directory, { recursive: true, force: true });
	}
	expect({ exitCode, exited, workerError, bridgeClosed, parentClosed, losses }).toEqual({
		exitCode: 0,
		exited: true,
		workerError: false,
		bridgeClosed: true,
		parentClosed: true,
		losses: [],
	});
	expect(report).toEqual({
		clientClosed: true,
		runtimeClosed: true,
		result: {
			failure: null,
			loaded: { rows: 500, receipts: 1, pointers: 0 },
			rejectedWrite: true,
			rejectedVerification: true,
			rejected: { rows: 100, receipts: 0, pointers: 0 },
			recovered: { rows: 250, receipts: 1, pointers: 0 },
		},
	});
	// Only this synthetic SQL-cost fixture gets a larger test budget (~7.2s row
	// cost plus real schema/admission/cleanup); production defaults are untouched.
}, 30_000);
