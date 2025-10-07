import type { PrismaClient } from "@prisma/client";

/**
 * Tag management utilities
 */

/**
 * Upserts tags for a user and returns tag IDs
 */
export async function upsertTags(
	prisma: PrismaClient,
	userId: string,
	tagNames: string[],
): Promise<Array<{ tagId: string }>> {
	return await Promise.all(
		tagNames.map(async (name) => {
			const tag = await prisma.serviceTag.upsert({
				where: { userId_name: { userId, name } },
				update: {},
				create: { userId, name },
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
	userId: string,
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
				where: { userId_name: { userId, name } },
				update: {},
				create: { userId, name },
			});
			return { instanceId, tagId: tag.id };
		}),
	);

	if (connections.length > 0) {
		await prisma.serviceInstanceTag.createMany({ data: connections });
	}
}
