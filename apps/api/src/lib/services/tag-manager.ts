import type { PrismaClient } from "../../lib/prisma.js";

/**
 * Tag management utilities
 */

/**
 * Upserts tags and returns tag IDs
 */
export async function upsertTags(
	prisma: PrismaClient,
	tagNames: string[],
): Promise<Array<{ tagId: string }>> {
	return await Promise.all(
		tagNames.map(async (name) => {
			const tag = await prisma.serviceTag.upsert({
				where: { name },
				update: {},
				create: { name },
			});
			return { tagId: tag.id };
		}),
	);
}

/**
 * Updates tags for a service instance
 */
export async function updateInstanceTags(
	prisma: PrismaClient,
	instanceId: string,
	tagNames: string[],
): Promise<void> {
	// Delete existing tags
	await prisma.serviceInstanceTag.deleteMany({
		where: { instanceId },
	});

	// Create new tag connections
	const connections = await Promise.all(
		tagNames.map(async (name) => {
			const tag = await prisma.serviceTag.upsert({
				where: { name },
				update: {},
				create: { name },
			});
			return { instanceId, tagId: tag.id };
		}),
	);

	if (connections.length > 0) {
		await prisma.serviceInstanceTag.createMany({ data: connections });
	}
}
