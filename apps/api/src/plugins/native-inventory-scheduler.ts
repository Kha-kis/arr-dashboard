import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import {
	NATIVE_INVENTORY_REFRESH_INTERVAL_MS,
	runDueNativeInventoryWork,
	schedulePeriodicNativeInventoryWork,
} from "../lib/provider-observation/native-inventory-job-orchestration.js";
import {
	pruneNativeInventoryRetentionSlice,
	type NativeInventoryRetentionCursor,
	type NativeInventoryRetentionSlice,
} from "../lib/provider-observation/native-inventory-retention.js";
import { runNativeInventoryRetentionWorker } from "../lib/provider-observation/native-inventory-retention-worker-transport.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";

const STARTUP_DELAY_MS = 30_000;
const INTERVAL_MS = 30_000;
const RETENTION_INTERVAL_MS = 5_000;
const RETENTION_AGE_MS = 24 * 60 * 60_000;
type RetentionState = { cursor: NativeInventoryRetentionCursor | null };
const CADENCE = {
	maxInstances: 8,
	refreshIntervalMs: NATIVE_INVENTORY_REFRESH_INTERVAL_MS,
	retryCooldownMs: 5 * 60_000,
} as const;
const WORK_BUDGET = {
	maxRuns: 4,
	maxConcurrent: 2,
	maxPagesPerRun: 20,
	pageSize: 500,
	maxDurationMs: 60_000,
	retryDelayMs: 30_000,
} as const;

export async function runNativeInventorySchedulerTick(
	app: Pick<FastifyInstance, "prisma" | "encryptor" | "log">,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	if (options.signal?.aborted) return;
	try {
		await schedulePeriodicNativeInventoryWork(app.prisma, new Date(), CADENCE, options);
	} catch {
		app.log.error(
			{ category: "native-inventory-admission-failed" },
			"Native inventory periodic admission failed",
		);
	}
	if (options.signal?.aborted) return;
	try {
		const result = await runDueNativeInventoryWork(app, WORK_BUDGET, options);
		app.log.info(
			{ category: "native-inventory-work", ...result },
			"Native inventory work tick completed",
		);
	} catch {
		app.log.error(
			{ category: "native-inventory-work-failed" },
			"Native inventory work tick failed",
		);
	}
}

export async function runNativeInventoryRetentionTick(
	app: Pick<FastifyInstance, "prisma" | "log" | "config">,
	options: { signal?: AbortSignal; retentionState?: RetentionState } = {},
): Promise<void> {
	if (options.signal?.aborted) return;
	const state = options.retentionState ?? { cursor: null };
	const cutoff = new Date(Date.now() - RETENTION_AGE_MS);
	const started = performance.now();
	let deletedRows = 0,
		deletedRuns = 0,
		scannedRuns = 0;
	try {
		// Bound admission, not database latency: an already-started transaction
		// must commit/roll back before another slice or shutdown can proceed.
		for (let batch = 0; batch < 200 && performance.now() - started < 2_000; batch++) {
			if (options.signal?.aborted) break;
			const slice = {
				rowLimit: 500,
				scanLimit: 10,
				cursor: state.cursor,
			};
			let result: NativeInventoryRetentionSlice;
			if (/^postgres(ql)?:\/\//i.test(app.config.DATABASE_URL!)) {
				result = await pruneNativeInventoryRetentionSlice(app.prisma, cutoff, {
					...slice,
					signal: options.signal,
				});
			} else {
				const workerResult = await runNativeInventoryRetentionWorker(
					{ databaseUrl: app.config.DATABASE_URL!, cutoff, ...slice },
					{ signal: options.signal },
				);
				if (workerResult.status === "cancelled") break;
				result = workerResult;
			}
			state.cursor = result.nextCursor;
			deletedRows += result.deletedRows;
			deletedRuns += result.deletedRuns;
			scannedRuns += result.scannedRuns;
			if (!result.hasMore) break;
			await yieldToEventLoop();
		}
		app.log.info(
			{ category: "native-inventory-retention", deletedRows, deletedRuns, scannedRuns },
			"Native inventory retention completed",
		);
	} catch {
		app.log.error(
			{ category: "native-inventory-retention-failed" },
			"Native inventory retention failed",
		);
		// The registry exposes error messages in job status. Retain an honest
		// failure without publishing database/provider details or an error cause.
		throw new Error("Native inventory retention failed");
	}
}

const nativeInventorySchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		let intervalHandle: ReturnType<typeof setInterval> | null = null;
		let retentionIntervalHandle: ReturnType<typeof setInterval> | null = null;
		let startupHandle: ReturnType<typeof setTimeout> | null = null;
		let running: Promise<void> | null = null;
		let retentionRunning: Promise<void> | null = null;
		let closing = false;
		const shutdown = new AbortController();
		const retentionState: RetentionState = { cursor: null };

		async function tick(): Promise<void> {
			if (closing || running) return;
			running = app.schedulerRegistry
				.track(
					JOB_ID.nativeInventory,
					async () => await runNativeInventorySchedulerTick(app, { signal: shutdown.signal }),
				)
				.catch(() => {
					// Registry admission can reject before the tick body runs. Timer
					// callers must observe that rejection without inventing success.
					app.log.error(
						{ category: "native-inventory-scheduler-tick-failed" },
						"Native inventory scheduler tick failed",
					);
				})
				.finally(() => {
					running = null;
				});
			await running;
		}

		async function retentionTick(): Promise<void> {
			if (closing || retentionRunning) return;
			retentionRunning = app.schedulerRegistry
				.track(JOB_ID.nativeInventoryRetention, async () =>
					runNativeInventoryRetentionTick(app, { signal: shutdown.signal, retentionState }),
				)
				.catch(() => {
					app.log.error(
						{ category: "native-inventory-retention-tick-failed" },
						"Native inventory retention tick failed",
					);
				})
				.finally(() => {
					retentionRunning = null;
				});
			await retentionRunning;
		}

		app.addHook("onReady", async () => {
			if (closing) return;
			startupHandle = setTimeout(() => {
				if (closing) return;
				void tick();
				void retentionTick();
				if (closing) return;
				intervalHandle = setInterval(() => void tick(), INTERVAL_MS);
				retentionIntervalHandle = setInterval(() => void retentionTick(), RETENTION_INTERVAL_MS);
			}, STARTUP_DELAY_MS);
		});
		function closeAdmission() {
			if (closing) return;
			closing = true;
			shutdown.abort();
			if (startupHandle) clearTimeout(startupHandle);
			if (intervalHandle) clearInterval(intervalHandle);
			if (retentionIntervalHandle) clearInterval(retentionIntervalHandle);
			startupHandle = null;
			intervalHandle = null;
			retentionIntervalHandle = null;
		}
		app.addHook("preClose", async () => closeAdmission());
		app.addHook("onClose", async () => {
			closeAdmission();
			await Promise.all([running, retentionRunning]);
		});
	},
	{
		name: "native-inventory-scheduler",
		dependencies: ["prisma", "security", "scheduler-registry"],
	},
);

export default nativeInventorySchedulerPlugin;
