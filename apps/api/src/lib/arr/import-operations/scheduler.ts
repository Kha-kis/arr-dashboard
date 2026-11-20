import type { FastifyBaseLogger } from "fastify";
import { withIndependentCleanupOperationGuard } from "../../library-cleanup/cleanup-maintenance-gate.js";
import type { Prisma } from "../../prisma.js";
import {
	passthroughTickWrapper,
	type TickWrapper,
} from "../../scheduler-registry/scheduler-registry.js";
import {
	selectLegacyImportConnections,
	selectOwnedLegacyImportReceipt,
} from "./legacy-discovery.js";
import { type LegacyImportObservationContext, observeLegacyImport } from "./legacy-observation.js";
import { type ImportReconciliationContext, reconcileTrackedImport } from "./reconciliation.js";
import { cancelUnsubmittedImportAttempt } from "./repository.js";

export const IMPORT_OBSERVATION_INTERVAL_MS = 5_000;
export const IMPORT_OBSERVATION_FAILURE = "Import observation is unavailable";
const MAX_CONNECTIONS = 4;
const TICK_ADMISSION_MS = 60_000;
const LEGACY_SWEEP_RETRY_MS = 60_000;
const SUBMITTED_STATES = ["submitting", "pending", "unknown", "partial", "failed"];
type ConnectionKey = { userId: string; originalInstanceId: string };

function dueWork(now: Date): Prisma.ArrImportOperationWhereInput {
	return {
		service: { in: ["SONARR", "RADARR", "LIDARR", "READARR"] },
		OR: [
			{
				state: "preparing",
				submissionStartedAt: null,
				preparationExpiresAt: { lte: now },
			},
			{
				state: { in: SUBMITTED_STATES },
				submissionStartedAt: { not: null },
				AND: [
					{ OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }] },
					{
						OR: [
							{ reconcileToken: null, reconcileExpiresAt: null },
							{ reconcileToken: { not: null }, reconcileExpiresAt: { lte: now } },
						],
					},
				],
			},
		],
	};
}

/** Bounded observation/recovery only: importing is never a scheduler dependency. */
export class ImportOperationScheduler {
	private cursor: ConnectionKey | null = null;
	private legacyCursor: ConnectionKey | null = null;
	// One bounded key/retry pair per discovered connection, not per receipt.
	// Unvisited connections are pruned when a connection sweep wraps.
	private readonly legacyPositions = new Map<string, { floor: string | null; retryAt: number }>();
	private readonly legacySeen = new Set<string>();
	private legacyRetryAt = 0;
	private preferLegacy = false;
	private startupTimer: ReturnType<typeof setTimeout> | null = null;
	private intervalTimer: ReturnType<typeof setInterval> | null = null;
	private inFlight: Promise<void> | null = null;
	private stopping = false;
	private readonly trackTick: TickWrapper;

	constructor(
		private readonly context: ImportReconciliationContext & LegacyImportObservationContext,
		private readonly log: Pick<FastifyBaseLogger, "info" | "warn">,
		options: { trackTick?: TickWrapper } = {},
	) {
		this.trackTick = options.trackTick ?? passthroughTickWrapper;
	}

	start(): void {
		if (this.startupTimer || this.intervalTimer || this.inFlight) return;
		this.stopping = false;
		this.startupTimer = setTimeout(() => {
			this.startupTimer = null;
			if (this.stopping) return;
			this.scheduleTick();
			this.intervalTimer = setInterval(() => this.scheduleTick(), IMPORT_OBSERVATION_INTERVAL_MS);
		}, IMPORT_OBSERVATION_INTERVAL_MS);
	}

	async stop(): Promise<void> {
		this.stopping = true;
		if (this.startupTimer) clearTimeout(this.startupTimer);
		if (this.intervalTimer) clearInterval(this.intervalTimer);
		this.startupTimer = null;
		this.intervalTimer = null;
		// The database plugin must not disconnect beneath an admitted observer.
		await this.inFlight?.catch(() => undefined);
	}

	tick(): Promise<void> {
		if (this.stopping) return Promise.resolve();
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.trackTick(() =>
			withIndependentCleanupOperationGuard(() => this.runTick()),
		).finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	private scheduleTick(): void {
		if (this.stopping || this.inFlight) return;
		void this.tick().catch(() => {
			this.log.warn({ category: "import-observation-unavailable" }, IMPORT_OBSERVATION_FAILURE);
		});
	}

	private async selectConnections(now: Date): Promise<ConnectionKey[]> {
		const page = async (cursor: ConnectionKey | null) =>
			this.context.prisma.arrImportOperation.groupBy({
				by: ["userId", "originalInstanceId"],
				where: {
					AND: [
						dueWork(now),
						...(cursor
							? [
									{
										OR: [
											{ userId: { gt: cursor.userId } },
											{
												userId: cursor.userId,
												originalInstanceId: { gt: cursor.originalInstanceId },
											},
										],
									},
								]
							: []),
					],
				},
				orderBy: [{ userId: "asc" }, { originalInstanceId: "asc" }],
				take: MAX_CONNECTIONS,
			});
		// Discovery crosses owners only for keys; every operation read/write below
		// uses the discovered owner. No credentials or encrypted payload are read.
		let rows = await page(this.cursor);
		if (rows.length === 0 && this.cursor) {
			this.cursor = null;
			rows = await page(null);
		}
		return rows;
	}

	private async runTick(): Promise<void> {
		const startedAt = Date.now();
		let observedCount = 0;
		let recoveredCount = 0;
		let yieldedCount = 0;
		let unavailableCount = 0;
		let failedCount = 0;
		let legacyBoundCount = 0;
		const preferLegacy = this.preferLegacy;
		this.preferLegacy = !preferLegacy;
		try {
			const now = this.context.now ?? (() => new Date());
			let legacy = preferLegacy;
			let connections = legacy
				? await this.selectLegacyConnections(now())
				: await this.selectConnections(now());
			if (connections.length === 0) {
				legacy = !legacy;
				connections = legacy
					? await this.selectLegacyConnections(now())
					: await this.selectConnections(now());
			}
			for (const connection of connections) {
				if (this.stopping || Date.now() - startedAt >= TICK_ADMISSION_MS) break;
				// Advance even on failure/busy work so a bad connection cannot monopolize turns.
				if (legacy) this.legacyCursor = connection;
				else this.cursor = connection;
				try {
					if (legacy) {
						const key = JSON.stringify([connection.userId, connection.originalInstanceId]);
						this.legacySeen.add(key);
						const position = this.legacyPositions.get(key) ?? { floor: null, retryAt: 0 };
						const due = now().getTime() >= position.retryAt;
						const receiptId = due
							? await selectOwnedLegacyImportReceipt(
									this.context.prisma,
									connection,
									position.floor,
								)
							: null;
						if (this.stopping) continue;
						if (receiptId) {
							// Advancing even on unavailable evidence prevents one pruned receipt
							// from starving later receipts on this or any other connection.
							this.legacyPositions.set(key, { floor: receiptId, retryAt: 0 });
							const result = await observeLegacyImport(this.context, connection.userId, receiptId);
							if (result.kind === "bound") legacyBoundCount++;
							else unavailableCount++;
							continue;
						}
						if (due) {
							this.legacyPositions.set(key, {
								floor: null,
								retryAt: now().getTime() + LEGACY_SWEEP_RETRY_MS,
							});
						}
						// No legacy provider read was admitted. Use this bounded connection
						// slot for due tracked work instead of delaying it behind backoff.
					}
					const operation = await this.context.prisma.arrImportOperation.findFirst({
						where: { ...connection, AND: [dueWork(now())] },
						orderBy: [
							{ lastCheckedAt: { sort: "asc", nulls: "first" } },
							{ createdAt: "asc" },
							{ id: "asc" },
						],
						select: { id: true, state: true },
					});
					if (!operation || this.stopping) continue;
					if (operation.state === "preparing") {
						if (
							await cancelUnsubmittedImportAttempt(
								this.context.prisma,
								connection.userId,
								operation.id,
							)
						)
							recoveredCount++;
						continue;
					}
					const result = await reconcileTrackedImport(
						this.context,
						connection.userId,
						operation.id,
					);
					if (result === "observed") observedCount++;
					else if (result === "yielded") yieldedCount++;
					else if (result === "unavailable") unavailableCount++;
				} catch {
					failedCount++;
				}
			}
		} catch {
			failedCount++;
		}
		this.log.info(
			{
				category: "import-observation",
				observedCount,
				recoveredCount,
				yieldedCount,
				unavailableCount,
				failedCount,
				legacyBoundCount,
				stopped: this.stopping,
				durationMs: Math.max(0, Math.min(120_000, Date.now() - startedAt)),
			},
			"Import observation tick finished",
		);
		if (failedCount || unavailableCount) throw new Error(IMPORT_OBSERVATION_FAILURE);
	}

	private async selectLegacyConnections(now: Date): Promise<ConnectionKey[]> {
		if (now.getTime() < this.legacyRetryAt) return [];
		let rows = await selectLegacyImportConnections(this.context.prisma, this.legacyCursor);
		if (rows.length === 0 && this.legacyCursor) {
			this.legacyCursor = null;
			for (const key of this.legacyPositions.keys()) {
				if (!this.legacySeen.has(key)) this.legacyPositions.delete(key);
			}
			this.legacySeen.clear();
			rows = await selectLegacyImportConnections(this.context.prisma, null);
		}
		if (rows.length === 0) {
			this.legacyPositions.clear();
			this.legacySeen.clear();
			this.legacyRetryAt = now.getTime() + LEGACY_SWEEP_RETRY_MS;
		}
		return rows;
	}
}
