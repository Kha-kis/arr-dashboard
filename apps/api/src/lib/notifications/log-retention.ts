/**
 * Notification log retention cleanup.
 *
 * Purges old NotificationLog rows beyond the configured retention period.
 * Designed to be called periodically (e.g., from a scheduler tick).
 */

import type { PrismaClientInstance } from "../prisma.js";

const BATCH_SIZE = 1000;

/**
 * Delete notification logs older than the retention period.
 * Returns the number of rows deleted.
 */
export async function purgeOldLogs(prisma: PrismaClientInstance, retentionDays: number): Promise<number> {
	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - retentionDays);

	const result = await prisma.notificationLog.deleteMany({
		where: {
			sentAt: { lt: cutoff },
		},
	});

	return result.count;
}

/**
 * Batched purge — deletes in chunks to avoid long-running transactions.
 * Returns total number of rows deleted.
 */
export async function purgeOldLogsBatched(prisma: PrismaClientInstance, retentionDays: number): Promise<number> {
	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - retentionDays);

	let totalDeleted = 0;
	let hasMore = true;

	while (hasMore) {
		const batch = await prisma.notificationLog.findMany({
			where: { sentAt: { lt: cutoff } },
			select: { id: true },
			take: BATCH_SIZE,
		});

		if (batch.length === 0) {
			hasMore = false;
			break;
		}

		await prisma.notificationLog.deleteMany({
			where: { id: { in: batch.map((r) => r.id) } },
		});

		totalDeleted += batch.length;

		if (batch.length < BATCH_SIZE) {
			hasMore = false;
		}
	}

	return totalDeleted;
}
