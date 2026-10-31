import { randomUUID } from "node:crypto";
import { createEvidenceFingerprintArrayAccumulator } from "../evidence-fingerprint.js";
import { Prisma, type PrismaClient } from "../prisma.js";
import {
	fingerprintJellyfinEpisodeRows,
	type JellyfinEpisodeRowFingerprintInput,
	projectJellyfinEpisodeRow,
} from "./jellyfin-generation-metadata.js";
import { retryJellyfinSnapshotTransaction } from "./jellyfin-snapshot-transaction.js";

type PreparationInput = {
	userId: string;
	instanceId: string;
	runId: string;
	generationId: string;
	now: Date;
};

export const JELLYFIN_EPISODE_PREPARATION_LEASE_MS = 5 * 60 * 1_000;
const EPISODE_STAGE_BATCH_SIZE = 500;

type EpisodeRow = Pick<
	JellyfinEpisodeRowFingerprintInput,
	| "showTmdbId"
	| "seasonNumber"
	| "episodeNumber"
	| "jellyfinId"
	| "title"
	| "watched"
	| "watchedByUsers"
	| "lastWatchedAt"
>;

type EpisodePreparationInput = PreparationInput & {
	token: string;
	rows: readonly EpisodeRow[];
	expectedFingerprint: string;
	observedAt?: Date;
	/** Exact catalog coverage may include shows with no episode rows. */
	coveredShowTmdbIds?: readonly number[];
	/** A fake clock is used only by real-database expiry tests. */
	clock?: () => Date;
};

function currentLeaseTime(input: PreparationInput, clock: () => Date): Date {
	const current = clock();
	return new Date(Math.max(input.now.getTime(), current.getTime()));
}

function episodeCoordinate(row: EpisodeRow): string {
	return `${row.showTmdbId}:${row.seasonNumber}:${row.episodeNumber}`;
}

function orderedRows(rows: readonly EpisodeRow[]): EpisodeRow[] {
	return [...rows].sort(
		(left, right) =>
			left.showTmdbId - right.showTmdbId ||
			left.seasonNumber - right.seasonNumber ||
			left.episodeNumber - right.episodeNumber,
	);
}

function expectedShowReceipts(rows: readonly EpisodeRow[], coveredShowTmdbIds?: readonly number[]) {
	const receipts: Array<{
		showTmdbId: number;
		rowCount: number;
		contentFingerprint: string;
	}> = [];
	for (let start = 0; start < rows.length; ) {
		const showTmdbId = rows[start]!.showTmdbId;
		let end = start + 1;
		while (end < rows.length && rows[end]!.showTmdbId === showTmdbId) end += 1;
		receipts.push({
			showTmdbId,
			rowCount: end - start,
			contentFingerprint: fingerprintJellyfinEpisodeRows(rows.slice(start, end)),
		});
		start = end;
	}
	if (coveredShowTmdbIds) {
		const known = new Set(receipts.map((receipt) => receipt.showTmdbId));
		const covered = new Set(coveredShowTmdbIds);
		if (
			covered.size !== coveredShowTmdbIds.length ||
			coveredShowTmdbIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
			[...known].some((id) => !covered.has(id))
		)
			throw new Error("Jellyfin episode catalog coverage is inconsistent");
		for (const showTmdbId of covered) {
			if (!known.has(showTmdbId))
				receipts.push({
					showTmdbId,
					rowCount: 0,
					contentFingerprint: fingerprintJellyfinEpisodeRows([]),
				});
		}
		receipts.sort((left, right) => left.showTmdbId - right.showTmdbId);
	}
	return receipts;
}

async function requireLiveLease(
	tx: Prisma.TransactionClient,
	input: PreparationInput & { token: string },
): Promise<void> {
	if (!(await renewJellyfinEpisodePreparation(tx, input)))
		throw new Error("Jellyfin episode preparation lease is unavailable");
}

/** Reset is deliberately paged: a failed attempt never has to erase 250k rows in one lock. */
async function clearInvisibleGeneration(
	prisma: PrismaClient,
	input: PreparationInput & { token: string },
	clock: () => Date,
): Promise<void> {
	for (;;) {
		const rows = await prisma.jellyfinEpisodeGenerationRow.findMany({
			where: { instanceId: input.instanceId, generationId: input.generationId },
			select: { id: true },
			orderBy: { id: "asc" },
			take: EPISODE_STAGE_BATCH_SIZE,
		});
		if (rows.length === 0) break;
		await prisma.$transaction(async (tx) => {
			await requireLiveLease(tx, { ...input, now: currentLeaseTime(input, clock) });
			await tx.jellyfinEpisodeGenerationRow.deleteMany({
				where: {
					instanceId: input.instanceId,
					generationId: input.generationId,
					id: { in: rows.map((row) => row.id) },
				},
			});
		});
	}
	for (;;) {
		const receipts = await prisma.jellyfinEpisodeGenerationShowReceipt.findMany({
			where: { instanceId: input.instanceId, generationId: input.generationId },
			select: { id: true },
			orderBy: { id: "asc" },
			take: EPISODE_STAGE_BATCH_SIZE,
		});
		if (receipts.length === 0) break;
		await prisma.$transaction(async (tx) => {
			await requireLiveLease(tx, { ...input, now: currentLeaseTime(input, clock) });
			await tx.jellyfinEpisodeGenerationShowReceipt.deleteMany({
				where: {
					instanceId: input.instanceId,
					generationId: input.generationId,
					id: { in: receipts.map((receipt) => receipt.id) },
				},
			});
		});
	}
}

export async function prepareJellyfinEpisodeGeneration(
	prisma: PrismaClient,
	input: EpisodePreparationInput,
): Promise<{ rowCount: number; receiptCount: number; fingerprint: string }> {
	if (!validInput(input) || !input.token.trim())
		throw new Error("Invalid Jellyfin episode preparation");
	if (input.observedAt && !Number.isFinite(input.observedAt.getTime()))
		throw new Error("Invalid Jellyfin episode observation time");
	const rows = orderedRows(input.rows);
	for (let index = 1; index < rows.length; index += 1) {
		if (episodeCoordinate(rows[index - 1]!) === episodeCoordinate(rows[index]!))
			throw new Error("Duplicate Jellyfin episode coordinate");
	}
	if (fingerprintJellyfinEpisodeRows(rows) !== input.expectedFingerprint)
		throw new Error("Jellyfin episode candidate fingerprint mismatch");
	const receipts = expectedShowReceipts(rows, input.coveredShowTmdbIds);
	const clock = input.clock ?? (() => new Date());
	await prisma.$transaction(async (tx) => {
		await requireLiveLease(tx, { ...input, now: currentLeaseTime(input, clock) });
		await tx.jellyfinEpisodePreparation.update({
			where: { runId: input.runId },
			data: {
				state: "preparing",
				expectedRowCount: null,
				expectedReceiptCount: null,
				contentFingerprint: null,
				observedAt: null,
			},
		});
	});
	await clearInvisibleGeneration(prisma, input, clock);
	for (let index = 0; index < rows.length; index += EPISODE_STAGE_BATCH_SIZE) {
		const chunk = rows.slice(index, index + EPISODE_STAGE_BATCH_SIZE);
		await prisma.$transaction(async (tx) => {
			await requireLiveLease(tx, { ...input, now: currentLeaseTime(input, clock) });
			const instance = await tx.serviceInstance.findUniqueOrThrow({
				where: { id: input.instanceId },
				select: { connectionGeneration: true, identityGeneration: true },
			});
			await tx.jellyfinEpisodeGenerationRow.createMany({
				data: chunk.map((row) => ({
					instanceId: input.instanceId,
					generationId: input.generationId,
					showTmdbId: row.showTmdbId,
					seasonNumber: row.seasonNumber,
					episodeNumber: row.episodeNumber,
					jellyfinId: row.jellyfinId,
					title: row.title,
					watched: row.watched,
					watchedByUsers: row.watchedByUsers,
					lastWatchedAt: row.lastWatchedAt,
					connectionGeneration: instance.connectionGeneration,
					identityGeneration: instance.identityGeneration,
				})),
			});
		});
	}
	for (let index = 0; index < receipts.length; index += EPISODE_STAGE_BATCH_SIZE) {
		const chunk = receipts.slice(index, index + EPISODE_STAGE_BATCH_SIZE);
		await prisma.$transaction(async (tx) => {
			await requireLiveLease(tx, { ...input, now: currentLeaseTime(input, clock) });
			await tx.jellyfinEpisodeGenerationShowReceipt.createMany({
				data: chunk.map((receipt) => ({
					...receipt,
					instanceId: input.instanceId,
					generationId: input.generationId,
				})),
			});
		});
	}
	await prisma.$transaction(async (tx) => {
		await requireLiveLease(tx, { ...input, now: currentLeaseTime(input, clock) });
		await tx.jellyfinEpisodePreparation.update({
			where: { runId: input.runId },
			data: {
				expectedRowCount: rows.length,
				expectedReceiptCount: receipts.length,
				contentFingerprint: input.expectedFingerprint,
				observedAt: input.observedAt ?? null,
			},
		});
	});
	if (
		!(await verifyPreparedJellyfinEpisodeGeneration(prisma, {
			...input,
			now: currentLeaseTime(input, clock),
		}))
	)
		throw new Error("Jellyfin episode generation readback failed");
	await prisma.$transaction(async (tx) => {
		await requireLiveLease(tx, { ...input, now: currentLeaseTime(input, clock) });
		await tx.jellyfinEpisodePreparation.update({
			where: { runId: input.runId },
			data: { state: "verified" },
		});
	});
	return {
		rowCount: rows.length,
		receiptCount: receipts.length,
		fingerprint: input.expectedFingerprint,
	};
}

export async function verifyPreparedJellyfinEpisodeGeneration(
	prisma: PrismaClient,
	input: PreparationInput & { token: string },
): Promise<boolean> {
	if (!validInput(input) || !input.token.trim()) return false;
	const manifest = await prisma.jellyfinEpisodePreparation.findUnique({
		where: { runId: input.runId },
	});
	if (
		!manifest ||
		manifest.instanceId !== input.instanceId ||
		manifest.generationId !== input.generationId ||
		manifest.token !== input.token ||
		manifest.expectedRowCount === null ||
		manifest.expectedReceiptCount === null ||
		!manifest.contentFingerprint ||
		!(["preparing", "verified"] as string[]).includes(manifest.state)
	)
		return false;
	const run = await prisma.providerObservationRun.findFirst({
		where: { id: input.runId, instanceId: input.instanceId },
		select: { connectionGeneration: true, identityGeneration: true },
	});
	if (!run) return false;
	const accumulator = createEvidenceFingerprintArrayAccumulator();
	let rowCount = 0;
	let receiptCount = 0;
	let currentShow: number | null = null;
	let showCount = 0;
	const seenShows = new Set<number>();
	let showAccumulator = createEvidenceFingerprintArrayAccumulator();
	let cursor: {
		showTmdbId: number;
		seasonNumber: number;
		episodeNumber: number;
	} | null = null;
	const finishShow = async () => {
		if (currentShow === null) return true;
		const receipt = await prisma.jellyfinEpisodeGenerationShowReceipt.findUnique({
			where: {
				instanceId_generationId_showTmdbId: {
					instanceId: input.instanceId,
					generationId: input.generationId,
					showTmdbId: currentShow,
				},
			},
		});
		receiptCount += 1;
		seenShows.add(currentShow);
		return (
			receipt?.rowCount === showCount && receipt.contentFingerprint === showAccumulator.digest()
		);
	};
	for (;;) {
		const live = await prisma.$transaction((tx) =>
			renewJellyfinEpisodePreparation(tx, {
				...input,
				now: new Date(Math.max(input.now.getTime(), Date.now())),
			}),
		);
		if (!live) return false;
		const seek: Prisma.Sql = cursor
			? Prisma.sql`AND ("showTmdbId", "seasonNumber", "episodeNumber") > (${cursor.showTmdbId}, ${cursor.seasonNumber}, ${cursor.episodeNumber})`
			: Prisma.empty;
		const page: Array<
			JellyfinEpisodeRowFingerprintInput & {
				connectionGeneration: number;
				identityGeneration: number;
			}
		> = await prisma.$queryRaw(Prisma.sql`
			SELECT * FROM "jellyfin_episode_generation_rows"
			WHERE "instanceId" = ${input.instanceId} AND "generationId" = ${input.generationId} ${seek}
			ORDER BY "showTmdbId", "seasonNumber", "episodeNumber"
			LIMIT ${EPISODE_STAGE_BATCH_SIZE}
		`);
		if (page.length === 0) break;
		for (const row of page) {
			if (
				row.connectionGeneration !== run.connectionGeneration ||
				row.identityGeneration !== run.identityGeneration
			)
				return false;
			if (row.showTmdbId !== currentShow) {
				if (!(await finishShow())) return false;
				currentShow = row.showTmdbId;
				showCount = 0;
				showAccumulator = createEvidenceFingerprintArrayAccumulator();
			}
			const canonical = projectJellyfinEpisodeRow(row);
			accumulator.append(canonical);
			showAccumulator.append(canonical);
			rowCount += 1;
			showCount += 1;
			if (rowCount > manifest.expectedRowCount) return false;
		}
		const last = page[page.length - 1]!;
		cursor = {
			showTmdbId: last.showTmdbId,
			seasonNumber: last.seasonNumber,
			episodeNumber: last.episodeNumber,
		};
	}
	if (!(await finishShow())) return false;
	let zeroCursor: string | undefined;
	for (;;) {
		const zeroReceipts = await prisma.jellyfinEpisodeGenerationShowReceipt.findMany({
			where: {
				instanceId: input.instanceId,
				generationId: input.generationId,
				rowCount: 0,
			},
			select: { id: true, showTmdbId: true, contentFingerprint: true },
			orderBy: { id: "asc" },
			take: EPISODE_STAGE_BATCH_SIZE,
			...(zeroCursor ? { cursor: { id: zeroCursor }, skip: 1 } : {}),
		});
		if (zeroReceipts.length === 0) break;
		for (const receipt of zeroReceipts) {
			if (
				seenShows.has(receipt.showTmdbId) ||
				receipt.contentFingerprint !== fingerprintJellyfinEpisodeRows([])
			)
				return false;
			receiptCount += 1;
		}
		zeroCursor = zeroReceipts[zeroReceipts.length - 1]!.id;
	}
	return (
		rowCount === manifest.expectedRowCount &&
		receiptCount === manifest.expectedReceiptCount &&
		accumulator.digest() === manifest.contentFingerprint &&
		(await prisma.jellyfinEpisodeGenerationShowReceipt.count({
			where: { instanceId: input.instanceId, generationId: input.generationId },
		})) === receiptCount
	);
}

function validInput(input: PreparationInput): boolean {
	return (
		input.userId.trim() !== "" &&
		input.instanceId.trim() !== "" &&
		input.runId.trim() !== "" &&
		input.generationId === input.runId &&
		Number.isFinite(input.now.getTime())
	);
}

function leaseExpiration(now: Date): Date {
	return new Date(now.getTime() + JELLYFIN_EPISODE_PREPARATION_LEASE_MS);
}

async function eligibleUnpublishedRun(
	tx: Prisma.TransactionClient,
	input: PreparationInput,
): Promise<boolean> {
	if (!validInput(input)) return false;
	const instance = await tx.serviceInstance.findFirst({
		where: {
			id: input.instanceId,
			userId: input.userId,
			enabled: true,
			service: { in: ["JELLYFIN", "EMBY"] },
			identityStatus: "VERIFIED",
		},
		select: {
			expectedIdentity: true,
			connectionGeneration: true,
			identityGeneration: true,
		},
	});
	if (!instance?.expectedIdentity?.trim()) return false;
	const run = await tx.providerObservationRun.findFirst({
		where: {
			id: input.runId,
			instanceId: input.instanceId,
			provider: "jellyfin_episode",
			cacheType: "jellyfin_episode",
			state: "running",
			activeSlotKey: { not: null },
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
		},
		select: {
			completedUnits: true,
			totalUnits: true,
			completedWork: true,
			totalWork: true,
		},
	});
	if (!run || run.completedUnits !== run.totalUnits || run.completedWork !== run.totalWork)
		return false;
	const pointer = await tx.jellyfinNativeWatchPublication.findUnique({
		where: { instanceId: input.instanceId },
		select: { activeRunId: true, previousRunId: true },
	});
	if (pointer?.activeRunId === input.runId || pointer?.previousRunId === input.runId) return false;
	const status = await tx.cacheRefreshStatus.findUnique({
		where: {
			instanceId_cacheType: {
				instanceId: input.instanceId,
				cacheType: "jellyfin_episode",
			},
		},
		select: { generationId: true, lastResult: true },
	});
	return status?.generationId !== input.generationId || status.lastResult !== "success";
}

export async function acquireJellyfinEpisodePreparation(
	prisma: PrismaClient,
	input: PreparationInput,
): Promise<{ token: string } | null> {
	if (!validInput(input)) return null;
	return await retryJellyfinSnapshotTransaction(() =>
		prisma.$transaction(async (tx) => {
			if (!(await eligibleUnpublishedRun(tx, input))) return null;
			const token = randomUUID();
			const existing = await tx.jellyfinEpisodePreparation.findUnique({
				where: { runId: input.runId },
			});
			if (!existing) {
				await tx.jellyfinEpisodePreparation.create({
					data: {
						runId: input.runId,
						instanceId: input.instanceId,
						generationId: input.generationId,
						token,
						leaseExpiresAt: leaseExpiration(input.now),
						state: "preparing",
					},
				});
				return { token };
			}
			if (
				existing.instanceId !== input.instanceId ||
				existing.generationId !== input.generationId ||
				existing.state === "published" ||
				existing.leaseExpiresAt.getTime() > input.now.getTime()
			)
				return null;
			const replaced = await tx.jellyfinEpisodePreparation.updateMany({
				where: {
					runId: input.runId,
					instanceId: input.instanceId,
					generationId: input.generationId,
					token: existing.token,
					state: { in: ["preparing", "verified"] },
					leaseExpiresAt: { lte: input.now },
				},
				data: {
					token,
					leaseExpiresAt: leaseExpiration(input.now),
					state: "preparing",
					expectedRowCount: null,
					expectedReceiptCount: null,
					contentFingerprint: null,
					observedAt: null,
				},
			});
			return replaced.count === 1 ? { token } : null;
		}),
	);
}

export async function renewJellyfinEpisodePreparation(
	tx: Prisma.TransactionClient,
	input: PreparationInput & { token: string },
): Promise<boolean> {
	if (!validInput(input) || !input.token.trim()) return false;
	// SQLite's deferred transactions cannot safely upgrade a read snapshot to
	// a writer while another connection holds a write reservation. Touch only
	// this still-live, token-owned lease first; the full authority check below
	// remains mandatory before extending it.
	const owned = await tx.$executeRaw`
		UPDATE "jellyfin_episode_preparations"
		SET "token" = "token"
		WHERE "runId" = ${input.runId}
			AND "instanceId" = ${input.instanceId}
			AND "generationId" = ${input.generationId}
			AND "token" = ${input.token}
			AND "state" IN ('preparing', 'verified')
			AND "leaseExpiresAt" > ${input.now}
			AND EXISTS (
				SELECT 1 FROM "ServiceInstance"
				WHERE "id" = ${input.instanceId} AND "userId" = ${input.userId}
			)
	`;
	if (owned !== 1 || !(await eligibleUnpublishedRun(tx, input))) return false;
	const renewed = await tx.jellyfinEpisodePreparation.updateMany({
		where: {
			runId: input.runId,
			instanceId: input.instanceId,
			generationId: input.generationId,
			token: input.token,
			state: { in: ["preparing", "verified"] },
			leaseExpiresAt: { gt: input.now },
		},
		data: { leaseExpiresAt: leaseExpiration(input.now) },
	});
	return renewed.count === 1;
}

export async function releaseJellyfinEpisodePreparation(
	prisma: PrismaClient,
	input: PreparationInput & { token: string },
): Promise<boolean> {
	if (!validInput(input) || !input.token.trim()) return false;
	return await prisma.$transaction(async (tx) => {
		const instance = await tx.serviceInstance.findFirst({
			where: { id: input.instanceId, userId: input.userId },
			select: { id: true },
		});
		if (!instance) return false;
		const pointer = await tx.jellyfinNativeWatchPublication.findUnique({
			where: { instanceId: input.instanceId },
			select: { activeRunId: true, previousRunId: true },
		});
		if (pointer?.activeRunId === input.runId || pointer?.previousRunId === input.runId)
			return false;
		const status = await tx.cacheRefreshStatus.findUnique({
			where: {
				instanceId_cacheType: {
					instanceId: input.instanceId,
					cacheType: "jellyfin_episode",
				},
			},
			select: { generationId: true, lastResult: true },
		});
		if (status?.generationId === input.generationId && status.lastResult === "success")
			return false;
		const released = await tx.jellyfinEpisodePreparation.updateMany({
			where: {
				runId: input.runId,
				instanceId: input.instanceId,
				generationId: input.generationId,
				token: input.token,
				state: { in: ["preparing", "verified"] },
				leaseExpiresAt: { gt: input.now },
			},
			data: { leaseExpiresAt: input.now },
		});
		return released.count === 1;
	});
}

async function terminalCleanupAllowed(
	tx: Prisma.TransactionClient,
	input: Pick<PreparationInput, "userId" | "instanceId" | "runId" | "generationId">,
): Promise<boolean> {
	if (!input.userId.trim() || !input.instanceId.trim() || input.generationId !== input.runId)
		return false;
	const run = await tx.providerObservationRun.findFirst({
		where: {
			id: input.runId,
			instanceId: input.instanceId,
			provider: "jellyfin_episode",
			cacheType: "jellyfin_episode",
			state: { in: ["complete", "invalidated"] },
			instance: { userId: input.userId },
		},
		select: { id: true },
	});
	if (!run) return false;
	const pointer = await tx.jellyfinNativeWatchPublication.findUnique({
		where: { instanceId: input.instanceId },
		select: { activeRunId: true, previousRunId: true },
	});
	if (pointer?.activeRunId === input.runId || pointer?.previousRunId === input.runId) return false;
	const status = await tx.cacheRefreshStatus.findUnique({
		where: {
			instanceId_cacheType: {
				instanceId: input.instanceId,
				cacheType: "jellyfin_episode",
			},
		},
		select: { generationId: true, lastResult: true },
	});
	return status?.generationId !== input.generationId || status.lastResult !== "success";
}

/** Replayable reclamation of only an unpublished, terminal generation. */
export async function cleanupUnpublishedJellyfinEpisodeGeneration(
	prisma: PrismaClient,
	input: Pick<PreparationInput, "userId" | "instanceId" | "runId" | "generationId">,
): Promise<boolean> {
	if (!(await prisma.$transaction((tx) => terminalCleanupAllowed(tx, input)))) return false;
	for (;;) {
		const rows = await prisma.jellyfinEpisodeGenerationRow.findMany({
			where: { instanceId: input.instanceId, generationId: input.generationId },
			select: { id: true },
			orderBy: { id: "asc" },
			take: EPISODE_STAGE_BATCH_SIZE,
		});
		if (rows.length === 0) break;
		await prisma.$transaction(async (tx) => {
			if (!(await terminalCleanupAllowed(tx, input)))
				throw new Error("Jellyfin episode generation cleanup authority changed");
			await tx.jellyfinEpisodeGenerationRow.deleteMany({
				where: {
					instanceId: input.instanceId,
					generationId: input.generationId,
					id: { in: rows.map((row) => row.id) },
				},
			});
		});
	}
	for (;;) {
		const receipts = await prisma.jellyfinEpisodeGenerationShowReceipt.findMany({
			where: { instanceId: input.instanceId, generationId: input.generationId },
			select: { id: true },
			orderBy: { id: "asc" },
			take: EPISODE_STAGE_BATCH_SIZE,
		});
		if (receipts.length === 0) break;
		await prisma.$transaction(async (tx) => {
			if (!(await terminalCleanupAllowed(tx, input)))
				throw new Error("Jellyfin episode generation cleanup authority changed");
			await tx.jellyfinEpisodeGenerationShowReceipt.deleteMany({
				where: {
					instanceId: input.instanceId,
					generationId: input.generationId,
					id: { in: receipts.map((receipt) => receipt.id) },
				},
			});
		});
	}
	await prisma.$transaction(async (tx) => {
		if (!(await terminalCleanupAllowed(tx, input)))
			throw new Error("Jellyfin episode generation cleanup authority changed");
		await tx.jellyfinEpisodePreparation.deleteMany({
			where: {
				runId: input.runId,
				instanceId: input.instanceId,
				generationId: input.generationId,
			},
		});
	});
	return true;
}

/** Retain the current and previous publications while reclaiming terminal predecessors. */
export async function cleanupObsoleteJellyfinEpisodeGenerations(
	prisma: PrismaClient,
	input: { userId: string; instanceId: string },
): Promise<number> {
	if (!input.userId.trim() || !input.instanceId.trim()) return 0;
	let retired = 0;
	let cursor: string | undefined;
	for (;;) {
		const page = await prisma.jellyfinEpisodePreparation.findMany({
			where: {
				instanceId: input.instanceId,
				...(cursor ? { runId: { gt: cursor } } : {}),
			},
			select: { runId: true, generationId: true },
			orderBy: { runId: "asc" },
			take: EPISODE_STAGE_BATCH_SIZE,
		});
		if (page.length === 0) break;
		for (const preparation of page) {
			const removed = await cleanupUnpublishedJellyfinEpisodeGeneration(prisma, {
				...input,
				runId: preparation.runId,
				generationId: preparation.generationId,
			});
			if (removed) retired += 1;
		}
		cursor = page[page.length - 1]!.runId;
	}
	return retired;
}
