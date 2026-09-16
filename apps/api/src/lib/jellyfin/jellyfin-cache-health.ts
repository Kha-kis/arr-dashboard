import type {
	CacheHealthItem,
	ProviderObservationStatus,
	ProviderObservationStatusEnvelope,
} from "@arr/shared";
import {
	providerObservationSourceStatusSchema,
	providerObservationStatusEnvelopeSchema,
	providerObservationStatusSchema,
} from "@arr/shared";
import type { ServiceInstance } from "../prisma.js";
import {
	type JellyfinEvidencePrisma,
	type JellyfinObservation,
	readOwnedJellyfinObservation,
} from "./jellyfin-evidence-repository.js";

export const DEFAULT_JELLYFIN_CACHE_HEALTH_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export type JellyfinCacheHealthInstance = Pick<ServiceInstance, "id" | "label" | "createdAt"> & {
	service: "JELLYFIN" | "EMBY";
};

export type JellyfinCacheHealthSource = {
	item: CacheHealthItem;
	fallbackObservedAt: string | null;
};

export type ReadOwnedJellyfinCacheHealthSourcesInput = {
	prisma: JellyfinEvidencePrisma;
	userId: string;
	instances: readonly JellyfinCacheHealthInstance[];
	now?: Date;
	maxAgeMs?: number;
};

const CACHE_TYPES = ["jellyfin", "jellyfin_episode"] as const;
type JellyfinCacheType = (typeof CACHE_TYPES)[number];

const UNAVAILABLE_STATUS: ProviderObservationStatus = {
	availability: "unavailable",
	evidence: "unknown",
	observedAt: null,
	ageSeconds: null,
	latestAttempt: "idle",
	reasonCodes: ["unknown-failure"],
};

const IN_PROGRESS_MESSAGE = "Cache refresh is in progress; current values are unavailable";
const FAILED_REFRESH_MESSAGE = "Cache refresh failed; last-known values are retained";
const STALE_MESSAGE = "Published cache evidence is stale or degraded";
const INCOMPLETE_MESSAGE = "Cache evidence is incomplete; only observed values are shown";
const UNAVAILABLE_MESSAGE = "Published cache evidence is unavailable";

function validDate(value: unknown): value is Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}

function cloneStatus(value: unknown): ProviderObservationStatus | null {
	const parsed = providerObservationStatusSchema.safeParse(value);
	if (!parsed.success) return null;
	const status = parsed.data;
	const legacyLastKnownUnknown =
		status.availability === "last-known" &&
		status.evidence === "unknown" &&
		status.observedAt === null &&
		status.ageSeconds === null &&
		(status.latestAttempt === "idle" ||
			status.latestAttempt === "running" ||
			status.latestAttempt === "failed") &&
		status.reasonCodes.length > 0 &&
		(status.reasonCodes.includes("receipt-invalid") ||
			status.reasonCodes.includes("publication-superseded")) &&
		status.reasonCodes.every(
			(reason) =>
				reason === "receipt-invalid" ||
				reason === "publication-superseded" ||
				reason === "refresh-running" ||
				reason === "refresh-failed",
		);
	const validEvidence =
		(status.availability === "current" && status.evidence === "complete") ||
		(status.availability === "last-known" &&
			(status.evidence === "complete" ||
				status.evidence === "partial" ||
				status.evidence === "positive-only" ||
				legacyLastKnownUnknown)) ||
		(status.availability === "partial" &&
			(status.evidence === "partial" || status.evidence === "positive-only")) ||
		(status.availability === "unavailable" && status.evidence === "unknown");
	if (!validEvidence) return null;
	return { ...status, reasonCodes: [...status.reasonCodes] };
}

function publicCacheType(
	service: JellyfinCacheHealthInstance["service"],
	cacheType: JellyfinCacheType,
): CacheHealthItem["cacheType"] {
	if (service === "EMBY") return cacheType === "jellyfin" ? "emby" : "emby_episode";
	return cacheType;
}

function publicService(service: JellyfinCacheHealthInstance["service"]): "jellyfin" | "emby" {
	return service === "EMBY" ? "emby" : "jellyfin";
}

function unavailableStatusEnvelope(
	instance: JellyfinCacheHealthInstance,
	cacheType: JellyfinCacheType,
): ProviderObservationStatusEnvelope {
	return publicStatusEnvelope(instance, cacheType, UNAVAILABLE_STATUS);
}

function publicStatusEnvelope(
	instance: JellyfinCacheHealthInstance,
	cacheType: JellyfinCacheType,
	status: ProviderObservationStatus,
): ProviderObservationStatusEnvelope {
	const source = providerObservationSourceStatusSchema.parse({
		instanceId: instance.id,
		service: publicService(instance.service),
		cacheType,
		status: { ...status, reasonCodes: [...status.reasonCodes] },
	});
	return providerObservationStatusEnvelopeSchema.parse({
		availability: status.availability,
		sources: [source],
	});
}

type AdmittedObservation = {
	status: ProviderObservationStatus;
	rows: unknown[];
};

function admitObservation(
	instance: JellyfinCacheHealthInstance,
	cacheType: JellyfinCacheType,
	observation: JellyfinObservation | null,
): AdmittedObservation | null {
	if (observation === null || typeof observation !== "object") return null;
	if (observation.instanceId !== instance.id) return null;
	if (observation.service !== instance.service) return null;
	if (observation.cacheType !== cacheType) return null;
	const status = cloneStatus(observation.providerStatus);
	if (status === null || !Array.isArray(observation.rows)) return null;
	if (status.availability === "unavailable") return { status, rows: [] };
	if (observation.available !== true) return null;
	return { status, rows: observation.rows };
}

function publicItem(
	instance: JellyfinCacheHealthInstance,
	cacheType: JellyfinCacheType,
	observation: AdmittedObservation | null,
): CacheHealthItem {
	const itemCacheType = publicCacheType(instance.service, cacheType);
	const fallback = {
		instanceId: instance.id,
		instanceName: instance.label,
		cacheType: itemCacheType,
		lastRefreshedAt: null,
		lastResult: "error" as const,
		lastErrorMessage: UNAVAILABLE_MESSAGE,
		itemCount: null,
		isStale: false,
	};
	if (observation === null) {
		return { ...fallback, providerStatus: unavailableStatusEnvelope(instance, cacheType) };
	}

	const { status, rows } = observation;
	const providerStatus = publicStatusEnvelope(instance, cacheType, status);
	const complete = status.evidence === "complete";
	const available = status.availability !== "unavailable";
	const observedAt = available ? status.observedAt : null;
	if (status.availability === "current" && complete && available) {
		return {
			...fallback,
			lastRefreshedAt: observedAt,
			lastResult: "success",
			lastErrorMessage: null,
			itemCount: rows.length,
			isStale: false,
			providerStatus,
		};
	}

	if (status.availability === "last-known" && complete && available) {
		const { reasonCodes } = status;
		const isRunning = reasonCodes.includes("refresh-running");
		const isFailed = reasonCodes.includes("refresh-failed");
		const stale = reasonCodes.includes("publication-stale");
		return {
			...fallback,
			lastRefreshedAt: observedAt,
			lastResult: isRunning ? "in_progress" : isFailed ? "error" : "partial",
			lastErrorMessage: isRunning
				? IN_PROGRESS_MESSAGE
				: isFailed
					? FAILED_REFRESH_MESSAGE
					: STALE_MESSAGE,
			itemCount: rows.length,
			isStale: stale,
			providerStatus,
		};
	}

	if (status.availability === "last-known" && available) {
		const isRunning = status.reasonCodes.includes("refresh-running");
		const isFailed = status.reasonCodes.includes("refresh-failed");
		return {
			...fallback,
			lastRefreshedAt: observedAt,
			lastResult: isRunning ? "in_progress" : isFailed ? "error" : "partial",
			lastErrorMessage: isRunning
				? IN_PROGRESS_MESSAGE
				: isFailed
					? FAILED_REFRESH_MESSAGE
					: INCOMPLETE_MESSAGE,
			itemCount: null,
			observedItemCount: rows.length,
			isStale: status.reasonCodes.includes("publication-stale"),
			providerStatus,
		};
	}

	if (
		available &&
		(status.availability === "partial" || !complete || status.evidence === "positive-only")
	) {
		return {
			...fallback,
			lastRefreshedAt: observedAt,
			lastResult: "partial",
			lastErrorMessage: INCOMPLETE_MESSAGE,
			itemCount: null,
			observedItemCount: rows.length,
			isStale: status.reasonCodes.includes("publication-stale"),
			providerStatus,
		};
	}

	const unavailableActive =
		status.latestAttempt === "running" || status.reasonCodes.includes("refresh-running");
	return {
		...fallback,
		lastResult: unavailableActive ? "in_progress" : "error",
		lastErrorMessage: unavailableActive ? IN_PROGRESS_MESSAGE : UNAVAILABLE_MESSAGE,
		providerStatus,
	};
}

function fallbackObservedAt(instance: JellyfinCacheHealthInstance): string | null {
	return validDate(instance.createdAt) ? instance.createdAt.toISOString() : null;
}

export async function readOwnedJellyfinCacheHealthSources({
	prisma,
	userId,
	instances,
	now,
	maxAgeMs,
}: ReadOwnedJellyfinCacheHealthSourcesInput): Promise<JellyfinCacheHealthSource[]> {
	if (instances.length === 0) return [];
	const effectiveNow = validDate(now) ? now : new Date();
	const effectiveMaxAgeMs =
		typeof maxAgeMs === "number" && Number.isFinite(maxAgeMs) && maxAgeMs >= 0
			? maxAgeMs
			: DEFAULT_JELLYFIN_CACHE_HEALTH_MAX_AGE_MS;
	const sortedInstances = [...instances].sort((left, right) => left.id.localeCompare(right.id));
	const results: JellyfinCacheHealthSource[] = [];

	for (const instance of sortedInstances) {
		for (const cacheType of CACHE_TYPES) {
			let observation: JellyfinObservation | null = null;
			try {
				observation = await readOwnedJellyfinObservation({
					prisma,
					userId,
					instanceId: instance.id,
					cacheType,
					mode: "display",
					now: effectiveNow,
					maxAgeMs: effectiveMaxAgeMs,
				});
			} catch {
				observation = null;
			}
			const admitted = admitObservation(instance, cacheType, observation);
			results.push({
				item: publicItem(instance, cacheType, admitted),
				fallbackObservedAt: fallbackObservedAt(instance),
			});
		}
	}
	return results;
}
