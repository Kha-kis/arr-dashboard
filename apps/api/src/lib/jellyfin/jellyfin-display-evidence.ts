import type { ProviderObservationStatus, ProviderObservationStatusEnvelope } from "@arr/shared";
import {
	aggregateProviderObservationStatuses,
	providerObservationSourceStatusSchema,
} from "@arr/shared";
import type { ServiceInstance } from "../prisma.js";
import {
	type JellyfinEpisodeObservation,
	type JellyfinEpisodeRow,
	type JellyfinEvidencePrisma,
	type JellyfinLibraryRow,
	type JellyfinObservation,
	readOwnedJellyfinObservation,
} from "./jellyfin-evidence-repository.js";

export type JellyfinDisplayInstance = Pick<ServiceInstance, "id" | "label"> & {
	service: "JELLYFIN" | "EMBY";
};

export type JellyfinLibraryDisplaySource = {
	instanceId: string;
	instanceName: string;
	rows: JellyfinLibraryRow[];
};

export type JellyfinLibraryDisplayEvidence = {
	sources: JellyfinLibraryDisplaySource[];
	providerStatus: ProviderObservationStatusEnvelope | undefined;
};

export type JellyfinEpisodeDisplaySource = {
	instanceId: string;
	instanceName: string;
	rows: JellyfinEpisodeRow[];
};

export type JellyfinEpisodeDisplayEvidence = {
	sources: JellyfinEpisodeDisplaySource[];
	providerStatus: ProviderObservationStatusEnvelope | undefined;
};

export type ReadOwnedJellyfinLibraryDisplaySourcesInput = {
	prisma: JellyfinEvidencePrisma;
	userId: string;
	instances: readonly JellyfinDisplayInstance[];
	now?: Date;
	maxAgeMs?: number;
};

const unavailableStatus: ProviderObservationStatus = {
	availability: "unavailable",
	evidence: "unknown",
	observedAt: null,
	ageSeconds: null,
	latestAttempt: "idle",
	reasonCodes: ["unknown-failure"],
};

function publicSourceStatus(instance: JellyfinDisplayInstance, status: ProviderObservationStatus) {
	return providerObservationSourceStatusSchema.parse({
		instanceId: instance.id,
		service: instance.service === "EMBY" ? "emby" : "jellyfin",
		cacheType: "jellyfin",
		status: { ...status, reasonCodes: [...status.reasonCodes] },
	});
}

function publicEpisodeSourceStatus(
	instance: JellyfinDisplayInstance,
	status: ProviderObservationStatus,
) {
	return providerObservationSourceStatusSchema.parse({
		instanceId: instance.id,
		service: instance.service === "EMBY" ? "emby" : "jellyfin",
		cacheType: "jellyfin_episode",
		status: { ...status, reasonCodes: [...status.reasonCodes] },
	});
}

function isAdmittedObservation(
	observation: JellyfinObservation | null,
): observation is JellyfinObservation & { cacheType: "jellyfin" } {
	const aggregateAvailable =
		observation !== null &&
		observation.cacheType === "jellyfin" &&
		observation.available &&
		(observation.providerStatus.availability === "current" ||
			observation.providerStatus.availability === "last-known" ||
			observation.providerStatus.availability === "partial");
	if (!aggregateAvailable || observation === null || observation.cacheType !== "jellyfin")
		return false;
	const libraryDomain = observation.providerStatus.domains?.find(
		(domain) => domain.domain === "library-inventory",
	);
	return (
		libraryDomain === undefined ||
		((libraryDomain.availability === "current" || libraryDomain.availability === "last-known") &&
			(libraryDomain.valueSemantics === "exact" || libraryDomain.valueSemantics === "lower-bound"))
	);
}

function isAdmittedEpisodeObservation(
	observation: JellyfinObservation | null,
): observation is JellyfinEpisodeObservation {
	return (
		observation !== null &&
		observation.cacheType === "jellyfin_episode" &&
		observation.available &&
		(observation.providerStatus.availability === "current" ||
			observation.providerStatus.availability === "last-known" ||
			observation.providerStatus.availability === "partial") &&
		(observation.providerStatus.evidence === "complete" ||
			observation.providerStatus.evidence === "positive-only")
	);
}

export function isArithmeticAuthoritativeProviderObservationStatus(
	providerStatus: ProviderObservationStatusEnvelope | undefined,
): boolean {
	if (!providerStatus || providerStatus.sources.length === 0) return false;
	const allCurrentComplete = providerStatus.sources.every(
		({ status }) => status.availability === "current" && status.evidence === "complete",
	);
	const allLastKnownComplete = providerStatus.sources.every(
		({ status }) => status.availability === "last-known" && status.evidence === "complete",
	);
	if (!allCurrentComplete && !allLastKnownComplete) return false;
	const librarySources = providerStatus.sources.filter((source) => source.cacheType === "jellyfin");
	if (librarySources.length === 0) return true;
	if (librarySources.length !== providerStatus.sources.length) return false;
	const expectedDomains = new Set([
		"library-inventory",
		"mapping",
		"watch-count",
		"watch-attribution",
		"on-deck",
	] as const);
	return librarySources.every(({ status }) => {
		if (!status.domains || status.domains.length !== expectedDomains.size) return false;
		const domains = new Set(status.domains.map((domain) => domain.domain));
		return (
			domains.size === expectedDomains.size &&
			[...expectedDomains].every((domain) => domains.has(domain)) &&
			status.domains.every(
				(domain) =>
					domain.evidence === "complete" &&
					domain.valueSemantics === "exact" &&
					(domain.availability === "current" || domain.availability === "last-known"),
			)
		);
	});
}

export async function readOwnedJellyfinLibraryDisplaySources({
	prisma,
	userId,
	instances,
	now,
	maxAgeMs,
}: ReadOwnedJellyfinLibraryDisplaySourcesInput): Promise<JellyfinLibraryDisplayEvidence> {
	if (instances.length === 0) return { sources: [], providerStatus: undefined };
	const effectiveNow = now ?? new Date();

	const observations = await Promise.all(
		instances.map(async (instance) => {
			let observation: JellyfinObservation | null;
			try {
				observation = await readOwnedJellyfinObservation({
					prisma,
					userId,
					instanceId: instance.id,
					cacheType: "jellyfin",
					mode: "display",
					now: effectiveNow,
					maxAgeMs,
				});
			} catch {
				observation = null;
			}

			const sourceStatus = publicSourceStatus(
				instance,
				observation?.providerStatus ?? unavailableStatus,
			);
			return {
				instanceId: instance.id,
				instanceName: instance.label,
				rows: isAdmittedObservation(observation) ? [...observation.rows] : [],
				status: sourceStatus,
			};
		}),
	);

	const providerStatus = aggregateProviderObservationStatuses(
		observations.map(({ status }) => status),
	);
	return {
		sources: observations.map(({ instanceId, instanceName, rows }) => ({
			instanceId,
			instanceName,
			rows,
		})),
		providerStatus,
	};
}

export type ReadOwnedJellyfinEpisodeDisplaySourcesInput =
	ReadOwnedJellyfinLibraryDisplaySourcesInput;

export async function readOwnedJellyfinEpisodeDisplaySources({
	prisma,
	userId,
	instances,
	now,
	maxAgeMs,
}: ReadOwnedJellyfinEpisodeDisplaySourcesInput): Promise<JellyfinEpisodeDisplayEvidence> {
	if (instances.length === 0) return { sources: [], providerStatus: undefined };
	const effectiveNow = now ?? new Date();

	const observations = await Promise.all(
		instances.map(async (instance) => {
			let observation: JellyfinObservation | null;
			try {
				observation = await readOwnedJellyfinObservation({
					prisma,
					userId,
					instanceId: instance.id,
					cacheType: "jellyfin_episode",
					mode: "display",
					now: effectiveNow,
					maxAgeMs,
				});
			} catch {
				observation = null;
			}

			const sourceStatus = publicEpisodeSourceStatus(
				instance,
				observation?.providerStatus ?? unavailableStatus,
			);
			return {
				instanceId: instance.id,
				instanceName: instance.label,
				rows: isAdmittedEpisodeObservation(observation)
					? observation.rows
							// Partial observations prove positive watch facts only. Omitted
							// rows and false flags cannot establish unwatched state.
							.filter((row) => observation.providerStatus.evidence === "complete" || row.watched)
							.map((row) => ({ ...row }))
					: [],
				status: sourceStatus,
			};
		}),
	);

	const providerStatus = aggregateProviderObservationStatuses(
		observations.map(({ status }) => status),
	);
	return {
		sources: observations.map(({ instanceId, instanceName, rows }) => ({
			instanceId,
			instanceName,
			rows,
		})),
		providerStatus,
	};
}
