import type { FastifyBaseLogger } from "fastify";
import { recordCacheRefreshFailure } from "../cache-refresh-status.js";
import type { PrismaClient } from "../prisma.js";
import {
	type ProviderConnectionIdentity,
	withCurrentProviderConnection,
} from "./provider-connection-guard.js";

export async function recordProviderCacheRefreshFailure(
	prisma: Pick<PrismaClient, "$transaction">,
	instanceId: string,
	cacheType: string,
	message: string,
	expected: ProviderConnectionIdentity,
	log: Pick<FastifyBaseLogger, "warn">,
): Promise<"recorded" | "superseded" | "failed"> {
	try {
		const result = await withCurrentProviderConnection(
			prisma,
			instanceId,
			expected,
			async (tx) =>
				await recordCacheRefreshFailure(tx, instanceId, cacheType, message.slice(0, 500)),
		);
		return result.matched ? "recorded" : "superseded";
	} catch (error) {
		log.warn(
			{ err: error, instanceId, cacheType },
			"Failed to record provider cache failure status",
		);
		return "failed";
	}
}
