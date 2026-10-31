import { parseSessionSnapshotMeasurement } from "../../plugins/lib/session-snapshot-measurements.js";
import type { Prisma, PrismaClient } from "../prisma.js";

const SESSION_SNAPSHOT_PAGE_SIZE = 500;
const READ_TRANSACTION_MAX_WAIT_MS = 5_000;
const READ_TRANSACTION_TIMEOUT_MS = 10_000;

export type SessionSnapshotService = "PLEX" | "JELLYFIN" | "EMBY";
export type SessionSnapshotPagesOrder = "chronological" | "reverse-chronological";

export interface SessionSnapshotPageRow {
	id: string;
	/** Retained for source-scoped native actor identities, never mutation authority. */
	instanceId: string;
	capturedAt: Date;
	sessionsJson: string;
	concurrentStreams: number;
	measurementJson: string | null;
}

export const SESSION_SNAPSHOT_METRICS_SELECT = {
	id: true,
	capturedAt: true,
	concurrentStreams: true,
	totalBandwidth: true,
	lanBandwidth: true,
	wanBandwidth: true,
	directPlayCount: true,
	transcodeCount: true,
	directStreamCount: true,
	measurementJson: true,
} satisfies Prisma.SessionSnapshotSelect;

export type SessionSnapshotMetricsPageRow = Prisma.SessionSnapshotGetPayload<{
	select: typeof SESSION_SNAPSHOT_METRICS_SELECT;
}>;

export type SessionSnapshotMetricsOrder = "chronological" | "most-concurrent";

export interface ReadSessionSnapshotPagesInput {
	userId: string;
	services: readonly SessionSnapshotService[];
	cutoff: Date;
	onPage: (page: readonly SessionSnapshotPageRow[]) => void;
	/** Retain raw collection counts for daily coverage before filtering activity. */
	includeCollectionByDate?: boolean;
}

export interface ReadSessionSnapshotPagesResult {
	instanceCount: number;
	/** Active/legacy sample count; idle and failed collection are not activity. */
	snapshotCount: number;
	collection: SessionSnapshotCollectionCounts;
	collectionByDate?: Record<string, SessionSnapshotCollectionCounts>;
}

export interface SessionSnapshotCollectionCounts {
	activeSnapshots: number;
	idleSnapshots: number;
	failedSnapshots: number;
	legacySnapshots: number;
	invalidSnapshots: number;
}

type SnapshotCursor = { capturedAt: Date; id: string };
type RankedSnapshotCursor = SnapshotCursor & { concurrentStreams: number };

async function readScopedSessionSnapshotPages<
	T extends { capturedAt: Date; measurementJson: string | null; concurrentStreams: number },
>(
	prisma: PrismaClient,
	input: Omit<ReadSessionSnapshotPagesInput, "onPage"> & { onPage: (page: readonly T[]) => void },
	queryPage: (
		tx: Prisma.TransactionClient,
		instanceIds: string[],
		cutoff: Date,
		cursor: SnapshotCursor | RankedSnapshotCursor | undefined,
	) => Promise<T[]>,
	getCursor: (page: readonly T[]) => SnapshotCursor | RankedSnapshotCursor,
): Promise<ReadSessionSnapshotPagesResult> {
	const collection: SessionSnapshotCollectionCounts = {
		activeSnapshots: 0,
		idleSnapshots: 0,
		failedSnapshots: 0,
		legacySnapshots: 0,
		invalidSnapshots: 0,
	};
	const collectionByDate: Record<string, SessionSnapshotCollectionCounts> = {};
	const recordCollection = (row: T, category: keyof SessionSnapshotCollectionCounts) => {
		collection[category] += 1;
		if (!input.includeCollectionByDate) return;
		const date = row.capturedAt.toISOString().slice(0, 10);
		const daily = collectionByDate[date] ?? {
			activeSnapshots: 0,
			idleSnapshots: 0,
			failedSnapshots: 0,
			legacySnapshots: 0,
			invalidSnapshots: 0,
		};
		daily[category] += 1;
		collectionByDate[date] = daily;
	};
	if (input.services.length === 0) return { instanceCount: 0, snapshotCount: 0, collection };

	return prisma.$transaction(
		async (tx) => {
			const instances = await tx.serviceInstance.findMany({
				where: { userId: input.userId, service: { in: [...input.services] }, enabled: true },
				select: { id: true },
			});
			if (instances.length === 0) return { instanceCount: 0, snapshotCount: 0, collection };

			const instanceIds = instances.map((instance) => instance.id);
			let snapshotCount = 0;
			let cursor: SnapshotCursor | RankedSnapshotCursor | undefined;
			while (true) {
				const page = await queryPage(tx, instanceIds, input.cutoff, cursor);
				if (page.length === 0) break;

				const samples = page.filter((row) => {
					const parsed = parseSessionSnapshotMeasurement(row.measurementJson);
					if (parsed.status === "legacy") {
						if (!Number.isInteger(row.concurrentStreams) || row.concurrentStreams < 0) {
							recordCollection(row, "invalidSnapshots");
							return false;
						}
						recordCollection(row, "legacySnapshots");
						return true;
					}
					if (
						parsed.status === "invalid" ||
						(parsed.measurement.observedSessions !== null &&
							parsed.measurement.observedSessions !== row.concurrentStreams)
					) {
						recordCollection(row, "invalidSnapshots");
						return false;
					}
					switch (parsed.measurement.status) {
						case "active":
							recordCollection(row, "activeSnapshots");
							return true;
						case "idle":
							recordCollection(row, "idleSnapshots");
							return false;
						case "failed":
							recordCollection(row, "failedSnapshots");
							return false;
						default:
							return false;
					}
				});
				input.onPage(samples);
				snapshotCount += samples.length;
				// The cursor and termination use the raw page, never the eligible subset.
				cursor = getCursor(page);
				if (page.length < SESSION_SNAPSHOT_PAGE_SIZE) break;
			}

			return {
				instanceCount: instances.length,
				snapshotCount,
				collection,
				...(input.includeCollectionByDate ? { collectionByDate } : {}),
			};
		},
		{
			isolationLevel: "Serializable",
			maxWait: READ_TRANSACTION_MAX_WAIT_MS,
			timeout: READ_TRANSACTION_TIMEOUT_MS,
		},
	);
}

/** Read every JSON snapshot in stable chronological pages for JSON analytics callers. */
export async function readSessionSnapshotPages(
	prisma: PrismaClient,
	input: ReadSessionSnapshotPagesInput,
	order: SessionSnapshotPagesOrder = "chronological",
): Promise<ReadSessionSnapshotPagesResult> {
	return readScopedSessionSnapshotPages(
		prisma,
		input,
		(tx, instanceIds, cutoff, cursor) =>
			tx.sessionSnapshot.findMany({
				where: {
					instanceId: { in: instanceIds },
					capturedAt: { gte: cutoff },
					...(cursor
						? {
								OR: [
									{
										capturedAt: {
											[order === "chronological" ? "gt" : "lt"]: cursor.capturedAt,
										},
									},
									{
										capturedAt: cursor.capturedAt,
										id: { [order === "chronological" ? "gt" : "lt"]: cursor.id },
									},
								],
							}
						: {}),
				},
				select: {
					id: true,
					instanceId: true,
					capturedAt: true,
					sessionsJson: true,
					concurrentStreams: true,
					measurementJson: true,
				},
				orderBy:
					order === "chronological"
						? [{ capturedAt: "asc" }, { id: "asc" }]
						: [{ capturedAt: "desc" }, { id: "desc" }],
				take: SESSION_SNAPSHOT_PAGE_SIZE,
			}),
		(page) => {
			const last = page[page.length - 1]!;
			return { capturedAt: last.capturedAt, id: last.id };
		},
	);
}

export interface ReadSessionSnapshotMetricsPagesInput {
	userId: string;
	services: readonly SessionSnapshotService[];
	cutoff: Date;
	onPage: (page: readonly SessionSnapshotMetricsPageRow[]) => void;
	includeCollectionByDate?: boolean;
}

/** Read numeric-only statistics projections, optionally in ranked most-concurrent order. */
export async function readSessionSnapshotMetricsPages(
	prisma: PrismaClient,
	input: ReadSessionSnapshotMetricsPagesInput,
	order: SessionSnapshotMetricsOrder = "chronological",
): Promise<ReadSessionSnapshotPagesResult> {
	return readScopedSessionSnapshotPages(
		prisma,
		input,
		(tx, instanceIds, cutoff, cursor) =>
			tx.sessionSnapshot.findMany({
				where: {
					instanceId: { in: instanceIds },
					capturedAt: { gte: cutoff },
					...(cursor && order === "chronological"
						? {
								OR: [
									{ capturedAt: { gt: cursor.capturedAt } },
									{ capturedAt: cursor.capturedAt, id: { gt: cursor.id } },
								],
							}
						: {}),
					...(cursor && order === "most-concurrent"
						? {
								OR: [
									{ concurrentStreams: { lt: (cursor as RankedSnapshotCursor).concurrentStreams } },
									{
										concurrentStreams: (cursor as RankedSnapshotCursor).concurrentStreams,
										capturedAt: { gt: cursor.capturedAt },
									},
									{
										concurrentStreams: (cursor as RankedSnapshotCursor).concurrentStreams,
										capturedAt: cursor.capturedAt,
										id: { gt: cursor.id },
									},
								],
							}
						: {}),
				},
				select: SESSION_SNAPSHOT_METRICS_SELECT,
				orderBy:
					order === "most-concurrent"
						? [{ concurrentStreams: "desc" }, { capturedAt: "asc" }, { id: "asc" }]
						: [{ capturedAt: "asc" }, { id: "asc" }],
				take: SESSION_SNAPSHOT_PAGE_SIZE,
			}),
		(page) => {
			const last = page[page.length - 1]!;
			return {
				capturedAt: last.capturedAt,
				id: last.id,
				...(order === "most-concurrent" ? { concurrentStreams: last.concurrentStreams } : {}),
			};
		},
	);
}
