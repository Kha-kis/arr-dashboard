import type { FastifyInstance } from "fastify";
import type { QueueCapableClient } from "../arr/client-factory.js";
import { serializeImportStatus } from "../arr/import-operations/status.js";
import { ConflictError } from "../errors.js";
import type { PrismaClient, ServiceInstance } from "../prisma.js";
import { queueDownloadKey } from "./import-receipt.js";
import { readCompleteQueue } from "./queue-observation.js";

export interface ImportDeletionFence {
	receiptCount: number;
	operationCount: number;
	queuedSourceKeys: string[];
}

type ImportDeletionPrisma = Pick<
	PrismaClient,
	"queueCleanerImportReceipt" | "arrImportOperation" | "arrImportFileProof"
>;

function unresolvedImport(): ConflictError {
	return new ConflictError(
		"This connection has an unresolved import. Check command activity and imported files in ARR, then run Queue Cleaner to reconcile it before deleting the connection. No import was cancelled.",
	);
}

function unavailableCoverage(): ConflictError {
	return new ConflictError(
		"Import source coverage is unavailable or its read deadline expired. Restore ARR connectivity and retry connection deletion; safety receipts were retained.",
	);
}

async function readBeforeDeadline<T>(read: () => Promise<T>, deadline: number): Promise<T> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw unavailableCoverage();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		// This may detach only a read. The underlying SDK timeout also aborts the request.
		// A late response cannot resume queue pagination or authorize the delete.
		return await Promise.race([
			read(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(unavailableCoverage()), remaining);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Completed means the exact command and every submitted file were positively
 * verified by the cleaner. That historical fact must not require ARR to keep
 * its old logs forever. Only current shared-source absence is re-observed here.
 */
export async function prepareImportDeletion(
	app: FastifyInstance,
	instance: ServiceInstance,
): Promise<ImportDeletionFence> {
	const owner = { instanceId: instance.id, instance: { userId: instance.userId } };
	const deadline = Date.now() + 15_000;
	const receiptCount = await app.prisma.queueCleanerImportReceipt.count({ where: owner });
	const operationCount = await app.prisma.arrImportOperation.count({
		where: { userId: instance.userId, originalInstanceId: instance.id },
	});
	const fence: ImportDeletionFence = { receiptCount, operationCount, queuedSourceKeys: [] };
	if (
		await app.prisma.queueCleanerImportReceipt.findFirst({
			where: { ...owner, state: { not: "completed" } },
			select: { id: true },
		})
	)
		throw unresolvedImport();
	const submittedOperations = await assertSettledImportOperations(
		app.prisma,
		instance.userId,
		instance.id,
		operationCount,
		deadline,
	);
	if (receiptCount === 0 && !submittedOperations) return fence;

	try {
		const connections = await app.prisma.serviceInstance.findMany({
			where: {
				userId: instance.userId,
				service: { in: ["SONARR", "RADARR", "LIDARR", "READARR"] },
			},
		});
		const sourceKeys = new Set<string>();
		// Disabled connections can still hold sources. Foreign-owner queues are never inspected.
		for (const connection of connections) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw unavailableCoverage();
			const client = app.arrClientFactory.create(connection, {
				timeout: remaining,
			}) as QueueCapableClient;
			const boundedClient = {
				queue: {
					get: (options: Parameters<QueueCapableClient["queue"]["get"]>[0]) =>
						readBeforeDeadline<unknown>(
							() =>
								client.queue.get({
									page: options?.page,
									pageSize: options?.pageSize,
									sortKey: options?.sortKey,
									sortDirection: options?.sortDirection,
									...(connection.service === "RADARR" ? { includeUnknownMovieItems: true } : {}),
								}),
							deadline,
						),
				},
			} as unknown as QueueCapableClient;
			const queue = await readCompleteQueue(boundedClient, connection.service);
			for (const item of queue) {
				const key = queueDownloadKey(item);
				if (key === null) throw unavailableCoverage();
				sourceKeys.add(key);
			}
		}
		fence.queuedSourceKeys = [...sourceKeys];
		await assertNoQueuedReceipt(app.prisma, owner, fence.queuedSourceKeys, deadline);
		if (Date.now() >= deadline) throw unavailableCoverage();
	} catch (error) {
		if (error instanceof ConflictError) throw error;
		throw unavailableCoverage();
	}
	return fence;
}

async function assertNoQueuedReceipt(
	prisma: ImportDeletionPrisma,
	owner: { instanceId: string; instance: { userId: string } },
	keys: string[],
	deadline?: number,
): Promise<void> {
	// Match active source keys in indexed batches rather than loading every lifetime receipt.
	for (let offset = 0; offset < keys.length; offset += 500) {
		if (deadline !== undefined && Date.now() >= deadline) throw unavailableCoverage();
		const batch = keys.slice(offset, offset + 500);
		if (
			(await prisma.queueCleanerImportReceipt.findFirst({
				where: { ...owner, downloadKey: { in: batch } },
				select: { id: true },
			})) ||
			(await prisma.arrImportFileProof.findFirst({
				where: {
					downloadKey: { in: batch },
					operation: {
						userId: owner.instance.userId,
						originalInstanceId: owner.instanceId,
						submissionStartedAt: { not: null },
					},
				},
				select: { id: true },
			}))
		)
			throw new ConflictError(
				"An imported source is still queued on an owned ARR connection. Resolve that queue in ARR before deleting this connection. No source was removed.",
			);
	}
}

async function assertSettledImportOperations(
	prisma: ImportDeletionPrisma,
	userId: string,
	instanceId: string,
	expectedCount: number,
	deadline: number,
): Promise<boolean> {
	let seen = 0;
	let afterId: string | undefined;
	let submitted = false;
	// Bounded projections, not encrypted lookups or provider History payloads.
	while (seen < expectedCount) {
		if (Date.now() >= deadline) throw unavailableCoverage();
		const operations = await prisma.arrImportOperation.findMany({
			where: {
				userId,
				originalInstanceId: instanceId,
				...(afterId ? { id: { gt: afterId } } : {}),
			},
			orderBy: { id: "asc" },
			take: 40,
			select: {
				id: true,
				state: true,
				reason: true,
				selectedFileCount: true,
				verifiedFileCount: true,
				commandId: true,
				commandState: true,
				commandTerminal: true,
				submissionStartedAt: true,
				files: { take: 1001, select: { fileFingerprint: true, verifiedAt: true } },
			},
		});
		if (operations.length === 0) throw unresolvedImport();
		for (const operation of operations) {
			try {
				const status = serializeImportStatus(operation);
				if (status.state === "not-submitted" && status.canConsiderNewAttempt) continue;
				if (status.state !== "completed") throw unresolvedImport();
				submitted = true;
			} catch {
				throw unresolvedImport();
			}
		}
		seen += operations.length;
		afterId = operations.at(-1)!.id;
	}
	if (seen !== expectedCount || Date.now() >= deadline) throw unresolvedImport();
	return submitted;
}

/** Recheck command states and source matches in the same transaction as the cascade. */
export async function assertImportDeletionFence(
	prisma: ImportDeletionPrisma,
	userId: string,
	instanceId: string,
	fence: ImportDeletionFence,
): Promise<void> {
	const owner = { instanceId, instance: { userId } };
	if (
		(await prisma.queueCleanerImportReceipt.count({ where: owner })) !== fence.receiptCount ||
		(await prisma.arrImportOperation.count({
			where: { userId, originalInstanceId: instanceId },
		})) !== fence.operationCount ||
		(await prisma.queueCleanerImportReceipt.findFirst({
			where: { ...owner, state: { not: "completed" } },
			select: { id: true },
		}))
	)
		throw unresolvedImport();
	await assertSettledImportOperations(
		prisma,
		userId,
		instanceId,
		fence.operationCount,
		Date.now() + 5000,
	);
	await assertNoQueuedReceipt(prisma, owner, fence.queuedSourceKeys);
}
