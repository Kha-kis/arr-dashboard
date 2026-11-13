import type { ProviderObservationStatus, ProviderObservationStatusEnvelope } from "@arr/shared";
import {
	aggregateProviderObservationStatuses,
	providerObservationSourceStatusSchema,
} from "@arr/shared";
import type { PrismaClient, ServiceInstance } from "../prisma.js";
import {
	type JellyfinEpisodeObservation,
	type JellyfinEpisodeRow,
	type JellyfinEvidencePrisma,
	type JellyfinLibraryRow,
	type JellyfinObservation,
	readOwnedJellyfinObservation,
} from "./jellyfin-evidence-repository.js";
import {
	type JellyfinSeriesProgressProof,
	jellyfinLastKnownSeriesProgress,
	jellyfinMappedSeriesProgressProof,
	jellyfinSeriesProgressProof,
	jellyfinSeriesWithoutCatalogMatch,
	readOwnedGenerationScopedEpisodeDisplay,
	readOwnedGenerationScopedLibraryAndEpisodeDisplay,
} from "./jellyfin-generation-scoped-display.js";

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

export type JellyfinEpisodeDisplaySource = JellyfinSeriesProgressProof & {
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

type InstanceReadInput = Pick<
	ReadOwnedJellyfinLibraryDisplaySourcesInput,
	"prisma" | "userId" | "maxAgeMs"
> & { instanceId: string; now: Date };

async function readDisplayObservation(
	input: InstanceReadInput,
	cacheType: "jellyfin" | "jellyfin_episode",
): Promise<JellyfinObservation | null> {
	try {
		return await readOwnedJellyfinObservation({ ...input, cacheType, mode: "display" });
	} catch {
		return null;
	}
}

async function readEpisodeDisplayObservation(
	input: InstanceReadInput,
	showTmdbIds: readonly number[] | undefined,
	includeSeriesProgressProof?: boolean,
	includeLastKnownSeriesProgress = false,
): Promise<(JellyfinObservation & JellyfinSeriesProgressProof) | null> {
	try {
		const scoped =
			typeof input.prisma.$transaction === "function"
				? await readOwnedGenerationScopedEpisodeDisplay({
						...input,
						prisma: input.prisma as unknown as PrismaClient,
						showTmdbIds,
						includeSeriesProgressProof,
						includeLastKnownSeriesProgress,
					})
				: null;
		return scoped ?? (await readDisplayObservation(input, "jellyfin_episode"));
	} catch {
		return null;
	}
}

function libraryDisplaySource(
	instance: JellyfinDisplayInstance,
	observation: JellyfinObservation | null,
) {
	return {
		instanceId: instance.id,
		instanceName: instance.label,
		rows: isAdmittedObservation(observation) ? [...observation.rows] : [],
		status: publicSourceStatus(instance, observation?.providerStatus ?? unavailableStatus),
	};
}

function episodeDisplaySource(
	instance: JellyfinDisplayInstance,
	observation: (JellyfinObservation & JellyfinSeriesProgressProof) | null,
) {
	const admitted = isAdmittedEpisodeObservation(observation);
	const proof = admitted ? observation[jellyfinSeriesProgressProof] : undefined;
	const lastKnown = admitted ? observation[jellyfinLastKnownSeriesProgress] : undefined;
	const mappedProof = admitted ? observation[jellyfinMappedSeriesProgressProof] : undefined;
	const withoutMatch = admitted ? observation[jellyfinSeriesWithoutCatalogMatch] : undefined;
	return {
		instanceId: instance.id,
		instanceName: instance.label,
		rows: admitted
			? observation.rows
					// Partial observations prove positive watch facts only. Omitted
					// rows and false flags cannot establish unwatched state.
					.filter((row) => observation.providerStatus.evidence === "complete" || row.watched)
					.map((row) => ({ ...row }))
			: [],
		status: publicEpisodeSourceStatus(instance, observation?.providerStatus ?? unavailableStatus),
		...(proof && { [jellyfinSeriesProgressProof]: proof }),
		...(mappedProof && { [jellyfinMappedSeriesProgressProof]: mappedProof }),
		...(lastKnown && { [jellyfinLastKnownSeriesProgress]: lastKnown }),
		...(withoutMatch && { [jellyfinSeriesWithoutCatalogMatch]: withoutMatch }),
	};
}

function displayEvidence<Row>(
	observations: readonly (JellyfinSeriesProgressProof & {
		instanceId: string;
		instanceName: string;
		rows: Row[];
		status: ProviderObservationStatusEnvelope["sources"][number];
	})[],
) {
	return {
		sources: observations.map(
			({
				instanceId,
				instanceName,
				rows,
				[jellyfinSeriesProgressProof]: proof,
				[jellyfinMappedSeriesProgressProof]: mappedProof,
				[jellyfinLastKnownSeriesProgress]: lastKnown,
				[jellyfinSeriesWithoutCatalogMatch]: withoutMatch,
			}) => ({
				instanceId,
				instanceName,
				rows,
				...(proof && { [jellyfinSeriesProgressProof]: proof }),
				...(mappedProof && { [jellyfinMappedSeriesProgressProof]: mappedProof }),
				...(lastKnown && { [jellyfinLastKnownSeriesProgress]: lastKnown }),
				...(withoutMatch && { [jellyfinSeriesWithoutCatalogMatch]: withoutMatch }),
			}),
		),
		providerStatus: observations.length
			? aggregateProviderObservationStatuses(observations.map(({ status }) => status))
			: undefined,
	};
}

export async function readOwnedJellyfinLibraryDisplaySources({
	prisma,
	userId,
	instances,
	now = new Date(),
	maxAgeMs,
}: ReadOwnedJellyfinLibraryDisplaySourcesInput): Promise<JellyfinLibraryDisplayEvidence> {
	const observations = await Promise.all(
		instances.map(async (instance) =>
			libraryDisplaySource(
				instance,
				await readDisplayObservation(
					{ prisma, userId, instanceId: instance.id, now, maxAgeMs },
					"jellyfin",
				),
			),
		),
	);
	return displayEvidence(observations);
}

export type ReadOwnedJellyfinEpisodeDisplaySourcesInput =
	ReadOwnedJellyfinLibraryDisplaySourcesInput & {
		showTmdbIds?: readonly number[];
		includeSeriesProgressProof?: boolean;
	};

export async function readOwnedJellyfinEpisodeDisplaySources({
	prisma,
	userId,
	instances,
	showTmdbIds,
	includeSeriesProgressProof,
	now = new Date(),
	maxAgeMs,
}: ReadOwnedJellyfinEpisodeDisplaySourcesInput): Promise<JellyfinEpisodeDisplayEvidence> {
	const observations = await Promise.all(
		instances.map(async (instance) =>
			episodeDisplaySource(
				instance,
				await readEpisodeDisplayObservation(
					{ prisma, userId, instanceId: instance.id, now, maxAgeMs },
					showTmdbIds,
					includeSeriesProgressProof,
					instances.length === 1,
				),
			),
		),
	);
	return displayEvidence(observations);
}

export async function readOwnedJellyfinLibraryAndEpisodeDisplaySources({
	prisma,
	userId,
	instances,
	showTmdbIds,
	now = new Date(),
	maxAgeMs,
}: ReadOwnedJellyfinLibraryDisplaySourcesInput & { showTmdbIds: readonly number[] }): Promise<{
	library: JellyfinLibraryDisplayEvidence;
	episodes: JellyfinEpisodeDisplayEvidence;
}> {
	const observations = await Promise.all(
		instances.map(async (instance) => {
			const input = { prisma, userId, instanceId: instance.id, now, maxAgeMs };
			const scoped =
				typeof prisma.$transaction === "function"
					? await readOwnedGenerationScopedLibraryAndEpisodeDisplay({
							...input,
							prisma: prisma as unknown as PrismaClient,
							showTmdbIds,
							includeSeriesProgressProof: true,
							includeLastKnownSeriesProgress: instances.length === 1,
						}).catch(() => undefined)
					: undefined;
			const library =
				scoped?.library === undefined
					? await readDisplayObservation(input, "jellyfin")
					: scoped.library;
			const episodes = scoped
				? (scoped.episodes ?? (await readDisplayObservation(input, "jellyfin_episode")))
				: await readEpisodeDisplayObservation(input, showTmdbIds, true, instances.length === 1);
			return {
				library: libraryDisplaySource(instance, library),
				episodes: episodeDisplaySource(instance, episodes),
			};
		}),
	);
	return {
		library: displayEvidence(observations.map(({ library }) => library)),
		episodes: displayEvidence(observations.map(({ episodes }) => episodes)),
	};
}
