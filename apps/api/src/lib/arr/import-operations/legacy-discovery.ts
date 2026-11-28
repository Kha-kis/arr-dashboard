import { Prisma, type PrismaClient } from "../../prisma.js";

export interface LegacyImportConnectionKey {
	userId: string;
	originalInstanceId: string;
}

/** Key-only discovery. The owner is resolved by the receipt's actual connection. */
export async function selectLegacyImportConnections(
	prisma: Pick<PrismaClient, "$queryRaw">,
	cursor: LegacyImportConnectionKey | null,
): Promise<LegacyImportConnectionKey[]> {
	return prisma.$queryRaw<LegacyImportConnectionKey[]>(Prisma.sql`
		SELECT s."userId", r."instanceId" AS "originalInstanceId"
		FROM "queue_cleaner_import_receipts" r
		JOIN "ServiceInstance" s ON s."id" = r."instanceId"
		WHERE s."enabled" = ${true}
		AND s."service" IN ('SONARR', 'RADARR', 'LIDARR', 'READARR')
		AND r."state" IN ('submitting', 'pending', 'unknown', 'completed', 'failed')
		${cursor === null ? Prisma.empty : Prisma.sql`AND (s."userId" > ${cursor.userId} OR (s."userId" = ${cursor.userId} AND r."instanceId" > ${cursor.originalInstanceId}))`}
		AND NOT EXISTS (
			SELECT 1 FROM "arr_import_operations" o
			WHERE o."userId" = s."userId" AND o."legacyReceiptId" = r."id"
		)
		GROUP BY s."userId", r."instanceId"
		ORDER BY s."userId", r."instanceId"
		LIMIT ${4}
	`);
}

/** No unbounded adoption-ID list or private receipt/provider fields are loaded. */
export async function selectOwnedLegacyImportReceipt(
	prisma: Pick<PrismaClient, "$queryRaw">,
	connection: LegacyImportConnectionKey,
	floor: string | null,
): Promise<string | null> {
	const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
		SELECT r."id" FROM "queue_cleaner_import_receipts" r
		JOIN "ServiceInstance" s ON s."id" = r."instanceId"
		WHERE s."userId" = ${connection.userId}
		AND r."instanceId" = ${connection.originalInstanceId}
		AND s."enabled" = ${true}
		AND s."service" IN ('SONARR', 'RADARR', 'LIDARR', 'READARR')
		AND r."state" IN ('submitting', 'pending', 'unknown', 'completed', 'failed')
		${floor === null ? Prisma.empty : Prisma.sql`AND r."id" > ${floor}`}
		AND NOT EXISTS (
			SELECT 1 FROM "arr_import_operations" o
			WHERE o."userId" = ${connection.userId} AND o."legacyReceiptId" = r."id"
		)
		ORDER BY r."id" LIMIT ${1}
	`);
	return rows[0]?.id ?? null;
}
