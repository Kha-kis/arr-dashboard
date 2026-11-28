import {
	isMonitoringResourceForTarget,
	monitoringSourceWhere,
} from "../library/monitoring-confirmation.js";
import type { Prisma, ServiceInstance } from "../prisma.js";
import {
	assertVerifiedArrTargetUnchanged,
	createArrServiceFingerprint,
	type SharedMediaSafetyPlan,
	type VerifiedArrTargetIdentity,
} from "./shared-plex-safety.js";
import type { CleanupExecutorDeps } from "./types.js";
export const UNMONITOR_CACHE_PUBLICATION_WARNING =
	"The confirmed monitoring change was recorded, but the Library cache could not be verified or updated. Run a normal Library refresh and check the instance settings before relying on its monitoring state.";

type Preimage = Readonly<{
	where: Prisma.LibraryCacheWhereInput;
	id: string;
	data: string;
	updatedAt: Date;
	monitored: boolean;
	instance: ServiceInstance;
	arrItemId: number;
	target: VerifiedArrTargetIdentity;
}>;
const object = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid monitoring projection");
	return value as Record<string, unknown>;
};

/** Read-model preimage only; a missing capture never grants mutation authority. */
export async function captureUnmonitorCachePreimage(
	options: Pick<CleanupExecutorDeps, "prisma"> & {
		userId: string;
		instance: ServiceInstance;
		arrItemId: number;
		itemType: string;
		plan: SharedMediaSafetyPlan;
	},
): Promise<Preimage | undefined> {
	try {
		const { prisma, userId, instance, arrItemId, itemType, plan } = options;
		if (
			userId !== instance.userId ||
			!Number.isSafeInteger(arrItemId) ||
			arrItemId <= 0 ||
			plan.kind !== "verified_arr_target" ||
			(instance.service === "RADARR"
				? itemType !== "movie"
				: instance.service === "SONARR"
					? itemType !== "series"
					: true)
		)
			return undefined;
		const where = {
			instanceId: instance.id,
			arrItemId,
			itemType: itemType as "movie" | "series",
			instance: monitoringSourceWhere(instance),
		};
		const cached = await prisma.libraryCache.findFirst({ where });
		if (!cached) return undefined;
		const prior = object(JSON.parse(cached.data));
		if (
			prior.id !== arrItemId ||
			prior.instanceId !== instance.id ||
			prior.type !== itemType ||
			prior.service !== instance.service.toLowerCase() ||
			typeof prior.monitored !== "boolean" ||
			prior.monitored !== cached.monitored ||
			object(prior._arrDashboardSource).serviceFingerprint !== createArrServiceFingerprint(instance)
		)
			return undefined;
		assertVerifiedArrTargetUnchanged(
			instance,
			object(prior.remoteIds)[instance.service === "RADARR" ? "tmdbId" : "tvdbId"],
			prior.path,
			plan.target,
		);
		return {
			where,
			id: cached.id,
			data: cached.data,
			updatedAt: cached.updatedAt,
			monitored: cached.monitored,
			instance,
			arrItemId,
			target: plan.target,
		};
	} catch {
		return undefined;
	}
}

/** One source/preimage-fenced native statement; no HTTP, mutation grant or freshness receipt. */
export async function publishConfirmedUnmonitor(
	options: Pick<CleanupExecutorDeps, "prisma"> & {
		preimage: Preimage | undefined;
		observation: unknown;
	},
): Promise<{ published: true } | { published: false; warning: string }> {
	try {
		const { preimage, observation, prisma } = options;
		if (
			!preimage ||
			!isMonitoringResourceForTarget(observation, preimage.arrItemId) ||
			observation.monitored !== false
		)
			throw new Error("Unconfirmed parent monitoring");
		assertVerifiedArrTargetUnchanged(
			preimage.instance,
			observation[preimage.instance.service === "RADARR" ? "tmdbId" : "tvdbId"],
			observation.path,
			preimage.target,
		);
		const changed = await prisma.libraryCache.updateMany({
			where: {
				...preimage.where,
				id: preimage.id,
				data: preimage.data,
				updatedAt: preimage.updatedAt,
				monitored: preimage.monitored,
			},
			data: {
				monitored: false,
				data: JSON.stringify({ ...object(JSON.parse(preimage.data)), monitored: false }),
			},
		});
		if (changed.count !== 1) throw new Error("Monitoring projection changed");
		return { published: true };
	} catch {
		return { published: false, warning: UNMONITOR_CACHE_PUBLICATION_WARNING };
	}
}
