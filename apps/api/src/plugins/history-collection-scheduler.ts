import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import {
	collectHistoryObservationsForOwner,
	type HistoryCollectorRunResult,
} from "../lib/history/history-collector.js";
import { HISTORY_SERVICE_TYPES } from "../lib/history/history-source-contract.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";

export const HISTORY_COLLECTION_STARTUP_DELAY_MS = 3 * 60 * 1000;
export const HISTORY_COLLECTION_INTERVAL_MS = 5 * 60 * 1000;
export const HISTORY_SCHEDULER_MAX_TELEMETRY_VALUE = 10_000;
export const HISTORY_SCHEDULER_MAX_DURATION_MS = 15 * 60 * 1000;
export const HISTORY_SCHEDULER_FAILURE_MESSAGE = "History observation scheduler failed";

const HISTORY_OUTCOMES = ["completed", "lease-unavailable", "superseded", "failed"] as const;
const HISTORY_LIMIT_REASONS = ["request-limit", "row-limit", "turn-limit", "time-limit"] as const;
const RESULT_COUNTERS = [
	"candidateSourceCount",
	"sourceTurnCount",
	"providerRequestCount",
	"rawRecordCount",
	"publishedTurnCount",
	"preservedTurnCount",
	"supersededTurnCount",
	"failedTurnCount",
] as const;

type HistoryOutcome = (typeof HISTORY_OUTCOMES)[number];
type HistoryLimitReason = (typeof HISTORY_LIMIT_REASONS)[number];

type OwnerRow = { userId: string };

type Aggregate = {
	ownerCount: number;
	completedOwnerCount: number;
	leaseUnavailableOwnerCount: number;
	supersededOwnerCount: number;
	failedOwnerCount: number;
	collectorCount: number;
	candidateSourceCount: number;
	sourceTurnCount: number;
	providerRequestCount: number;
	rawRecordCount: number;
	publishedTurnCount: number;
	preservedTurnCount: number;
	supersededTurnCount: number;
	failedTurnCount: number;
	limitReason: HistoryLimitReason | null;
	stopped: boolean;
};

const emptyAggregate = (): Aggregate => ({
	ownerCount: 0,
	completedOwnerCount: 0,
	leaseUnavailableOwnerCount: 0,
	supersededOwnerCount: 0,
	failedOwnerCount: 0,
	collectorCount: 0,
	candidateSourceCount: 0,
	sourceTurnCount: 0,
	providerRequestCount: 0,
	rawRecordCount: 0,
	publishedTurnCount: 0,
	preservedTurnCount: 0,
	supersededTurnCount: 0,
	failedTurnCount: 0,
	limitReason: null,
	stopped: false,
});

function boundedCount(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	return Math.min(HISTORY_SCHEDULER_MAX_TELEMETRY_VALUE, Math.floor(value));
}

function addBounded(current: number, value: unknown): number {
	return Math.min(HISTORY_SCHEDULER_MAX_TELEMETRY_VALUE, current + boundedCount(value));
}

function boundedDuration(startedAt: number): number {
	const elapsed = Date.now() - startedAt;
	if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
	return Math.min(HISTORY_SCHEDULER_MAX_DURATION_MS, Math.floor(elapsed));
}

function isValidOwnerId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		[...value].every((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return !(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f));
		}) &&
		Buffer.byteLength(value, "utf8") <= 256
	);
}

function isOwnerRows(value: unknown): value is OwnerRow[] {
	return (
		Array.isArray(value) &&
		value.every(
			(row) =>
				row !== null &&
				typeof row === "object" &&
				Object.keys(row).length === 1 &&
				"userId" in row &&
				isValidOwnerId(row.userId),
		)
	);
}

function isCollectorResult(value: unknown): value is HistoryCollectorRunResult {
	if (value === null || typeof value !== "object") return false;
	const result = value as Record<string, unknown>;
	if (!HISTORY_OUTCOMES.includes(result.status as HistoryOutcome)) return false;
	if (
		result.limitReason !== null &&
		!HISTORY_LIMIT_REASONS.includes(result.limitReason as HistoryLimitReason)
	) {
		return false;
	}
	if (typeof result.sourceSetTruncated !== "boolean" || typeof result.leaseReleased !== "boolean") {
		return false;
	}
	return (
		RESULT_COUNTERS.every(
			(key) =>
				typeof result[key] === "number" &&
				Number.isFinite(result[key]) &&
				Number.isInteger(result[key]) &&
				(result[key] as number) >= 0,
		) &&
		typeof result.durationMs === "number" &&
		Number.isFinite(result.durationMs) &&
		Number.isInteger(result.durationMs) &&
		result.durationMs >= 0
	);
}

function addResult(aggregate: Aggregate, result: HistoryCollectorRunResult): void {
	aggregate.collectorCount = addBounded(aggregate.collectorCount, 1);
	for (const key of RESULT_COUNTERS) {
		aggregate[key] = addBounded(aggregate[key], result[key]);
	}
	if (result.limitReason !== null) aggregate.limitReason = result.limitReason;
	switch (result.status) {
		case "completed":
			aggregate.completedOwnerCount = addBounded(aggregate.completedOwnerCount, 1);
			break;
		case "lease-unavailable":
			aggregate.leaseUnavailableOwnerCount = addBounded(aggregate.leaseUnavailableOwnerCount, 1);
			break;
		case "superseded":
			aggregate.supersededOwnerCount = addBounded(aggregate.supersededOwnerCount, 1);
			break;
		case "failed":
			aggregate.failedOwnerCount = addBounded(aggregate.failedOwnerCount, 1);
			break;
	}
}

const historyCollectionSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		let intervalHandle: ReturnType<typeof setInterval> | null = null;
		let stopping = false;
		let isRunning = false;

		const runTick = async (): Promise<void> => {
			const startedAt = Date.now();
			const aggregate = emptyAggregate();
			let tickFailed = false;
			let owners: string[];
			try {
				const rows: unknown = await app.prisma.serviceInstance.findMany({
					where: { enabled: true, service: { in: [...HISTORY_SERVICE_TYPES] } },
					select: { userId: true },
					orderBy: { userId: "asc" },
					distinct: ["userId"],
				});
				if (!isOwnerRows(rows)) throw new Error("invalid owner selection");
				owners = [...new Set(rows.map((row) => row.userId))].sort();
				aggregate.ownerCount = boundedCount(owners.length);
			} catch {
				tickFailed = true;
				owners = [];
			}

			for (const ownerId of owners) {
				if (stopping) {
					aggregate.stopped = true;
					break;
				}
				try {
					const value: unknown = await collectHistoryObservationsForOwner(
						{ prisma: app.prisma, clientFactory: app.arrClientFactory },
						ownerId,
					);
					if (!isCollectorResult(value)) {
						tickFailed = true;
						aggregate.failedOwnerCount = addBounded(aggregate.failedOwnerCount, 1);
						continue;
					}
					addResult(aggregate, value);
					if (value.status === "failed") tickFailed = true;
				} catch {
					tickFailed = true;
					aggregate.failedOwnerCount = addBounded(aggregate.failedOwnerCount, 1);
				}
			}

			if (stopping) aggregate.stopped = true;
			app.log.info(
				{
					provider: "history",
					outcome: tickFailed ? "failed" : "completed",
					reasonCode: tickFailed ? "owner_failure" : aggregate.stopped ? "stopped" : "none",
					ownerCount: aggregate.ownerCount,
					completedOwnerCount: aggregate.completedOwnerCount,
					leaseUnavailableOwnerCount: aggregate.leaseUnavailableOwnerCount,
					supersededOwnerCount: aggregate.supersededOwnerCount,
					failedOwnerCount: aggregate.failedOwnerCount,
					collectorCount: aggregate.collectorCount,
					candidateSourceCount: aggregate.candidateSourceCount,
					sourceTurnCount: aggregate.sourceTurnCount,
					providerRequestCount: aggregate.providerRequestCount,
					rawRecordCount: aggregate.rawRecordCount,
					publishedTurnCount: aggregate.publishedTurnCount,
					preservedTurnCount: aggregate.preservedTurnCount,
					supersededTurnCount: aggregate.supersededTurnCount,
					failedTurnCount: aggregate.failedTurnCount,
					limitReason: aggregate.limitReason,
					stopped: aggregate.stopped,
					durationMs: boundedDuration(startedAt),
				},
				"History observation scheduler tick completed",
			);
			if (tickFailed) throw new Error(HISTORY_SCHEDULER_FAILURE_MESSAGE);
		};

		const scheduleTick = (): void => {
			if (stopping) return;
			if (isRunning) {
				app.log.warn(
					{ provider: "history", reasonCode: "overlap_skip" },
					"History observation scheduler tick skipped",
				);
				return;
			}
			isRunning = true;
			void app.schedulerRegistry
				.track(JOB_ID.historyCollection, runTick)
				.catch(() => undefined)
				.finally(() => {
					isRunning = false;
				});
		};

		app.addHook("onReady", async () => {
			app.log.info(
				{
					provider: "history",
					intervalMs: HISTORY_COLLECTION_INTERVAL_MS,
					startupDelayMs: HISTORY_COLLECTION_STARTUP_DELAY_MS,
				},
				"History observation scheduler initialized",
			);
			timeoutHandle = setTimeout(() => {
				if (stopping) return;
				timeoutHandle = null;
				scheduleTick();
				if (!stopping && intervalHandle === null) {
					intervalHandle = setInterval(scheduleTick, HISTORY_COLLECTION_INTERVAL_MS);
				}
			}, HISTORY_COLLECTION_STARTUP_DELAY_MS);
		});

		app.addHook("onClose", async () => {
			stopping = true;
			if (timeoutHandle !== null) clearTimeout(timeoutHandle);
			if (intervalHandle !== null) clearInterval(intervalHandle);
			timeoutHandle = null;
			intervalHandle = null;
			app.log.info(
				{ provider: "history", reasonCode: "stopped" },
				"History observation scheduler stopped",
			);
		});
	},
	{
		name: "history-collection-scheduler",
		dependencies: ["prisma", "security", "arr-client", "scheduler-registry"],
	},
);

export default historyCollectionSchedulerPlugin;
