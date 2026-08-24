import type {
	PlexCoverageReasonCode,
	PlexEvidenceSummary,
	PlexGenerationSection,
} from "@arr/shared";
import type { PlexCache, PlexEpisodeCache, PrismaClientInstance } from "../prisma.js";
import {
	createEvidenceFingerprintArrayAccumulator,
	type EvidenceFingerprintArrayAccumulator,
} from "../evidence-fingerprint.js";
import {
	countPlexEpisodeCacheRows,
	countPlexCacheRows,
	listPlexCacheRows,
	listPlexEpisodeCacheRows,
	listPlexEpisodeRowsForShows,
	listSelectedPlexCacheRows,
	scanPlexEpisodeParentPolicyRows,
	scanPlexPolicyCacheRows,
	type PlexCacheRowSelection,
	type PlexEpisodeParentPolicyRow,
	type PlexPolicyCacheRow,
	readPlexEpisodeGenerationStatus,
	readPlexGenerationStatus,
} from "./plex-cache-storage.js";
import {
	type DecodedPlexGenerationMetadata,
	evaluatePlexLatestAttemptTrust,
	evaluatePublishedPlexGeneration,
} from "./plex-generation-metadata.js";

// Mutation authority retains the established 24-hour cutoff. The schedulers'
// 12-hour threshold is an earlier operational warning/refresh cadence, not a
// second authority policy.
export const DEFAULT_PLEX_EVIDENCE_FRESHNESS_MS = 24 * 60 * 60 * 1000;

type PlexEvidencePrisma = Pick<
	PrismaClientInstance,
	"serviceInstance" | "cacheRefreshStatus" | "plexCache" | "plexEpisodeCache"
>;

export type PlexEvidenceInstance = {
	id: string;
	userId: string;
	service: string;
	enabled: boolean;
	label: string;
	connectionGeneration: number;
	identityGeneration: number;
	identityStatus: string;
	expectedIdentity: string | null;
	identityKind: string | null;
	identityVerifiedAt: Date | null;
	updatedAt: Date;
};

export type AvailablePlexInstanceEvidence = {
	available: true;
	instanceId: string;
	instanceName: string;
	generationId: string;
	publishedAt: Date;
	itemCount: number;
	connectionGeneration: number;
	identityGeneration: number;
	metadata: DecodedPlexGenerationMetadata;
	generationStatus: {
		instanceId: string;
		lastRefreshedAt: Date;
		lastResult: string;
		lastErrorMessage: string | null;
		lastAttemptAt: Date | null;
		lastAttemptResult: string | null;
		lastAttemptErrorMessage: string | null;
		itemCount: number;
		connectionGeneration: number | null;
		identityGeneration: number | null;
		generationId: string | null;
		generationMetadata: string | null;
	};
	sections: PlexGenerationSection[];
	rows: PlexPolicyCacheRow[];
	evidence: PlexEvidenceSummary;
};

export type UnavailablePlexInstanceEvidence = {
	available: false;
	instanceId?: string;
	evidence: PlexEvidenceSummary;
};

export type PlexInstanceEvidence = AvailablePlexInstanceEvidence | UnavailablePlexInstanceEvidence;

export type AvailablePlexPolicyEvidence = Omit<AvailablePlexInstanceEvidence, "rows"> & {
	rowCount: number;
	rowFingerprint: string;
};

export type PlexPolicyScanEvidence = AvailablePlexPolicyEvidence | UnavailablePlexInstanceEvidence;

export type PlexPolicyScanInstance = Omit<AvailablePlexInstanceEvidence, "rows">;

export type PlexPolicyBatchHandler = (input: {
	instance: PlexPolicyScanInstance;
	rows: readonly PlexPolicyCacheRow[];
}) => void | Promise<void>;

export type PlexEpisodeParentPolicyBatchHandler = (input: {
	instance: PlexPolicyScanInstance;
	rows: readonly PlexEpisodeParentPolicyRow[];
}) => void | Promise<void>;

export type AvailablePlexEpisodeEvidence = {
	available: true;
	instanceId: string;
	generationId: string;
	parentGenerationId: string;
	publishedAt: Date;
	connectionGeneration: number;
	identityGeneration: number;
	rows: PlexEpisodeCache[];
	generationStatus: AvailablePlexInstanceEvidence["generationStatus"];
	evidence: PlexEvidenceSummary;
};

export type PlexEpisodeEvidence = AvailablePlexEpisodeEvidence | UnavailablePlexInstanceEvidence;

export type SelectedPlexEpisodeEvidence = PlexEpisodeEvidence;

function unavailable(reasonCode: PlexCoverageReasonCode): UnavailablePlexInstanceEvidence {
	return {
		available: false,
		evidence: {
			availability: "unavailable",
			authority: "unavailable",
			attemptState: "unknown",
			publicationLevel: "unavailable",
			completeness: "unknown",
			reasonCodes: [reasonCode],
		},
	};
}

function unavailableFromEvidence(evidence: PlexEvidenceSummary): UnavailablePlexInstanceEvidence {
	return { available: false, evidence };
}

class PlexPolicyProvenanceError extends Error {
	constructor(readonly reasonCode: PlexCoverageReasonCode) {
		super(reasonCode);
		this.name = "PlexPolicyProvenanceError";
	}
}

function mutationUnavailable(evidence: {
	evidence: PlexEvidenceSummary;
}): UnavailablePlexInstanceEvidence {
	return {
		available: false,
		evidence: {
			...evidence.evidence,
			authority: "unavailable",
			publicationLevel: "unavailable",
			completeness: "unknown",
			reasonCodes:
				evidence.evidence.reasonCodes.length > 0
					? evidence.evidence.reasonCodes
					: ["mutation_authority_unavailable"],
		},
	};
}

export function hasCurrentPlexMutationAuthority(evidence: {
	available: boolean;
	evidence: PlexEvidenceSummary;
	generationStatus?: AvailablePlexInstanceEvidence["generationStatus"];
}): boolean {
	if (
		!evidence.available ||
		!evidence.generationStatus ||
		evidence.evidence.publicationLevel !== "authoritative" ||
		evidence.evidence.completeness !== "complete" ||
		evidence.evidence.reasonCodes.length > 0
	) {
		return false;
	}
	return statusHasCurrentAttemptAuthority(evidence.generationStatus);
}

function statusHasCurrentAttemptAuthority(status: {
	lastErrorMessage: string | null;
	lastRefreshedAt: Date;
	lastAttemptAt: Date | null;
	lastAttemptResult: string | null;
	lastAttemptErrorMessage: string | null;
}): boolean {
	return (
		status.lastErrorMessage == null &&
		status.lastAttemptErrorMessage == null &&
		status.lastAttemptResult === "success" &&
		status.lastAttemptAt instanceof Date &&
		Number.isFinite(status.lastAttemptAt.getTime()) &&
		status.lastAttemptAt.getTime() >= status.lastRefreshedAt.getTime()
	);
}

function isCurrentVerifiedPlexInstance(instance: PlexEvidenceInstance): boolean {
	return (
		instance.service === "PLEX" &&
		instance.identityStatus === "VERIFIED" &&
		typeof instance.expectedIdentity === "string" &&
		instance.expectedIdentity.trim() !== "" &&
		instance.identityKind !== null &&
		instance.identityVerifiedAt !== null &&
		Number.isSafeInteger(instance.connectionGeneration) &&
		instance.connectionGeneration >= 0 &&
		Number.isSafeInteger(instance.identityGeneration) &&
		instance.identityGeneration > 0
	);
}

function validateExplicitStatusGenerationBinding(
	instance: PlexEvidenceInstance,
	status: {
		connectionGeneration: number | null;
		identityGeneration: number | null;
	},
): PlexCoverageReasonCode | null {
	if (
		status.connectionGeneration === null ||
		status.connectionGeneration !== instance.connectionGeneration
	) {
		return "connection_generation_mismatch";
	}
	if (
		status.identityGeneration === null ||
		status.identityGeneration !== instance.identityGeneration ||
		instance.identityVerifiedAt === null
	) {
		return "identity_generation_mismatch";
	}
	return null;
}

function publishedGenerationsMatch(
	before: {
		generationId: string;
		publishedAt: Date;
		itemCount: number;
		metadata: DecodedPlexGenerationMetadata;
		evidence: PlexEvidenceSummary;
	},
	after: {
		generationId: string;
		publishedAt: Date;
		itemCount: number;
		metadata: DecodedPlexGenerationMetadata;
		evidence: PlexEvidenceSummary;
	},
): PlexCoverageReasonCode | null {
	if (after.generationId !== before.generationId || after.itemCount !== before.itemCount) {
		return "generation_changed";
	}
	if (after.publishedAt.getTime() !== before.publishedAt.getTime()) {
		return "published_timestamp_changed";
	}
	if (
		after.evidence.availability !== before.evidence.availability ||
		after.evidence.authority !== before.evidence.authority ||
		after.evidence.attemptState !== before.evidence.attemptState ||
		after.evidence.publicationLevel !== before.evidence.publicationLevel ||
		after.evidence.completeness !== before.evidence.completeness ||
		after.evidence.reasonCodes.join("\u0000") !== before.evidence.reasonCodes.join("\u0000")
	) {
		return "generation_changed";
	}
	if (JSON.stringify(after.metadata) !== JSON.stringify(before.metadata)) {
		return "generation_changed";
	}
	return null;
}

function withDefaultFreshness<T extends { maxAgeMs?: number }>(input: T): T & { maxAgeMs: number } {
	return {
		...input,
		maxAgeMs: input.maxAgeMs ?? DEFAULT_PLEX_EVIDENCE_FRESHNESS_MS,
	};
}

async function loadOwnedInstanceEvidence(
	prisma: PlexEvidencePrisma,
	instance: PlexEvidenceInstance,
	options: { now?: Date; maxAgeMs?: number },
): Promise<PlexInstanceEvidence> {
	if (!instance.enabled) return unavailable("disabled_instance");
	if (!isCurrentVerifiedPlexInstance(instance)) return unavailable("identity_generation_mismatch");
	try {
		const before = await readPlexGenerationStatus(prisma, instance.id);
		const publishedBefore = evaluatePublishedPlexGeneration(before, options);
		if (!publishedBefore.available) return publishedBefore;
		const beforeBinding = validateExplicitStatusGenerationBinding(instance, before!);
		if (beforeBinding) return unavailable(beforeBinding);

		const rows = await listPlexCacheRows(prisma, instance.id);
		const after = await readPlexGenerationStatus(prisma, instance.id);
		const publishedAfter = evaluatePublishedPlexGeneration(after, options);
		if (!publishedAfter.available) return publishedAfter;
		const afterBinding = validateExplicitStatusGenerationBinding(instance, after!);
		if (afterBinding) return unavailable(afterBinding);

		const generationMismatch = publishedGenerationsMatch(publishedBefore, publishedAfter);
		if (generationMismatch) return unavailable(generationMismatch);
		if (rows.length !== publishedBefore.itemCount) return unavailable("row_count_mismatch");
		for (const row of rows) {
			if (
				row.instanceId !== instance.id ||
				row.connectionGeneration !== instance.connectionGeneration
			) {
				return unavailable("connection_generation_mismatch");
			}
			if (row.identityGeneration !== instance.identityGeneration) {
				return unavailable("identity_generation_mismatch");
			}
		}

		return {
			available: true,
			instanceId: instance.id,
			instanceName: instance.label,
			generationId: publishedBefore.generationId,
			publishedAt: publishedBefore.publishedAt,
			itemCount: publishedBefore.itemCount,
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
			metadata: publishedBefore.metadata,
			generationStatus: {
				instanceId: before!.instanceId,
				lastRefreshedAt: before!.lastRefreshedAt,
				lastResult: before!.lastResult,
				lastErrorMessage: before!.lastErrorMessage,
				lastAttemptAt: before!.lastAttemptAt,
				lastAttemptResult: before!.lastAttemptResult,
				lastAttemptErrorMessage: before!.lastAttemptErrorMessage,
				itemCount: before!.itemCount,
				connectionGeneration: before!.connectionGeneration,
				identityGeneration: before!.identityGeneration,
				generationId: before!.generationId,
				generationMetadata: before!.generationMetadata,
			},
			sections: publishedBefore.metadata.sections,
			rows,
			evidence: publishedBefore.evidence,
		};
	} catch {
		return unavailable("query_failed");
	}
}

async function scanOwnedPolicyEvidence(
	prisma: PlexEvidencePrisma,
	instance: PlexEvidenceInstance,
	options: { now?: Date; maxAgeMs?: number; onBatch?: PlexPolicyBatchHandler },
): Promise<PlexPolicyScanEvidence> {
	if (!instance.enabled) return unavailable("disabled_instance");
	if (!isCurrentVerifiedPlexInstance(instance)) return unavailable("identity_generation_mismatch");
	try {
		const before = await readPlexGenerationStatus(prisma, instance.id);
		const publishedBefore = evaluatePublishedPlexGeneration(before, options);
		if (!publishedBefore.available) return publishedBefore;
		const beforeBinding = validateExplicitStatusGenerationBinding(instance, before!);
		if (beforeBinding) return unavailable(beforeBinding);

		const policyInstance: PlexPolicyScanInstance = {
			available: true,
			instanceId: instance.id,
			instanceName: instance.label,
			generationId: publishedBefore.generationId,
			publishedAt: publishedBefore.publishedAt,
			itemCount: publishedBefore.itemCount,
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
			metadata: publishedBefore.metadata,
			generationStatus: {
				instanceId: before!.instanceId,
				lastRefreshedAt: before!.lastRefreshedAt,
				lastResult: before!.lastResult,
				lastErrorMessage: before!.lastErrorMessage,
				lastAttemptAt: before!.lastAttemptAt,
				lastAttemptResult: before!.lastAttemptResult,
				lastAttemptErrorMessage: before!.lastAttemptErrorMessage,
				itemCount: before!.itemCount,
				connectionGeneration: before!.connectionGeneration,
				identityGeneration: before!.identityGeneration,
				generationId: before!.generationId,
				generationMetadata: before!.generationMetadata,
			},
			sections: publishedBefore.metadata.sections,
			evidence: publishedBefore.evidence,
		};
		const fingerprint: EvidenceFingerprintArrayAccumulator =
			createEvidenceFingerprintArrayAccumulator();
		let rowCount = 0;
		await scanPlexPolicyCacheRows(prisma, instance.id, async (rows) => {
			for (const row of rows) {
				if (
					row.instanceId !== instance.id ||
					row.connectionGeneration !== instance.connectionGeneration
				) {
					throw new PlexPolicyProvenanceError("connection_generation_mismatch");
				}
				if (row.identityGeneration !== instance.identityGeneration) {
					throw new PlexPolicyProvenanceError("identity_generation_mismatch");
				}
				fingerprint.append(row);
				rowCount += 1;
			}
			await options.onBatch?.({ instance: policyInstance, rows });
		});

		if (rowCount !== publishedBefore.itemCount) return unavailable("row_count_mismatch");
		const after = await readPlexGenerationStatus(prisma, instance.id);
		const publishedAfter = evaluatePublishedPlexGeneration(after, options);
		if (!publishedAfter.available) return publishedAfter;
		const afterBinding = validateExplicitStatusGenerationBinding(instance, after!);
		if (afterBinding) return unavailable(afterBinding);
		const generationMismatch = publishedGenerationsMatch(publishedBefore, publishedAfter);
		if (generationMismatch) return unavailable(generationMismatch);

		return { ...policyInstance, rowCount, rowFingerprint: fingerprint.digest() };
	} catch (error) {
		if (error instanceof PlexPolicyProvenanceError) return unavailable(error.reasonCode);
		return unavailable("query_failed");
	}
}

export async function scanInstancePolicyEvidence(
	prisma: PlexEvidencePrisma,
	input: {
		userId: string;
		instanceId: string;
		now?: Date;
		maxAgeMs?: number;
		onBatch?: PlexPolicyBatchHandler;
	},
): Promise<PlexPolicyScanEvidence> {
	try {
		const instance = (await prisma.serviceInstance.findFirst({
			where: { id: input.instanceId, userId: input.userId, service: "PLEX" },
		})) as PlexEvidenceInstance | null;
		if (!instance) return unavailable("missing_status");
		return scanOwnedPolicyEvidence(prisma, instance, withDefaultFreshness(input));
	} catch {
		return unavailable("query_failed");
	}
}

export async function scanInstanceEpisodeParentPolicyEvidence(
	prisma: PlexEvidencePrisma,
	input: {
		userId: string;
		instanceId: string;
		now?: Date;
		maxAgeMs?: number;
		onBatch?: PlexEpisodeParentPolicyBatchHandler;
	},
): Promise<PlexPolicyScanEvidence> {
	try {
		const instance = (await prisma.serviceInstance.findFirst({
			where: { id: input.instanceId, userId: input.userId, service: "PLEX" },
		})) as PlexEvidenceInstance | null;
		if (!instance) return unavailable("missing_status");
		if (!instance.enabled) return unavailable("disabled_instance");
		if (!isCurrentVerifiedPlexInstance(instance))
			return unavailable("identity_generation_mismatch");

		const options = withDefaultFreshness(input);
		const before = await readPlexGenerationStatus(prisma, instance.id);
		const publishedBefore = evaluatePublishedPlexGeneration(before, options);
		if (!publishedBefore.available) return publishedBefore;
		const beforeBinding = validateExplicitStatusGenerationBinding(instance, before!);
		if (beforeBinding) return unavailable(beforeBinding);
		const [totalCount, boundCount] = await Promise.all([
			countPlexCacheRows(prisma, { instanceId: instance.id }),
			countPlexCacheRows(prisma, {
				instanceId: instance.id,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
			}),
		]);
		if (totalCount !== publishedBefore.itemCount || boundCount !== totalCount) {
			return unavailable("row_count_mismatch");
		}

		const policyInstance: PlexPolicyScanInstance = {
			available: true,
			instanceId: instance.id,
			instanceName: instance.label,
			generationId: publishedBefore.generationId,
			publishedAt: publishedBefore.publishedAt,
			itemCount: publishedBefore.itemCount,
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
			metadata: publishedBefore.metadata,
			generationStatus: {
				instanceId: before!.instanceId,
				lastRefreshedAt: before!.lastRefreshedAt,
				lastResult: before!.lastResult,
				lastErrorMessage: before!.lastErrorMessage,
				lastAttemptAt: before!.lastAttemptAt,
				lastAttemptResult: before!.lastAttemptResult,
				lastAttemptErrorMessage: before!.lastAttemptErrorMessage,
				itemCount: before!.itemCount,
				connectionGeneration: before!.connectionGeneration,
				identityGeneration: before!.identityGeneration,
				generationId: before!.generationId,
				generationMetadata: before!.generationMetadata,
			},
			sections: publishedBefore.metadata.sections,
			evidence: publishedBefore.evidence,
		};
		const fingerprint = createEvidenceFingerprintArrayAccumulator();
		let rowCount = 0;
		let provenanceFailure: PlexCoverageReasonCode | undefined;
		await scanPlexEpisodeParentPolicyRows(prisma, instance.id, async (rows) => {
			for (const row of rows) {
				if (
					row.instanceId !== instance.id ||
					row.connectionGeneration !== instance.connectionGeneration
				) {
					provenanceFailure = "connection_generation_mismatch";
					return;
				}
				if (row.identityGeneration !== instance.identityGeneration) {
					provenanceFailure = "identity_generation_mismatch";
					return;
				}
				fingerprint.append(row);
				rowCount += 1;
			}
			if (!provenanceFailure) await input.onBatch?.({ instance: policyInstance, rows });
		});
		if (provenanceFailure) return unavailable(provenanceFailure);

		const after = await readPlexGenerationStatus(prisma, instance.id);
		const publishedAfter = evaluatePublishedPlexGeneration(after, options);
		if (!publishedAfter.available) return publishedAfter;
		const afterBinding = validateExplicitStatusGenerationBinding(instance, after!);
		if (afterBinding) return unavailable(afterBinding);
		const generationMismatch = publishedGenerationsMatch(publishedBefore, publishedAfter);
		if (generationMismatch) return unavailable(generationMismatch);

		return { ...policyInstance, rowCount, rowFingerprint: fingerprint.digest() };
	} catch {
		return unavailable("query_failed");
	}
}

export async function scanPolicyEvidenceForOwnedInstances(
	prisma: PlexEvidencePrisma,
	input: {
		instances: PlexEvidenceInstance[];
		now?: Date;
		maxAgeMs?: number;
		onBatch?: PlexPolicyBatchHandler;
	},
): Promise<PlexPolicyScanEvidence[]> {
	const evidence: PlexPolicyScanEvidence[] = [];
	for (const instance of [...input.instances].sort((left, right) =>
		left.id.localeCompare(right.id),
	)) {
		const entry = await scanOwnedPolicyEvidence(prisma, instance, withDefaultFreshness(input));
		evidence.push(entry.available ? entry : { ...entry, instanceId: instance.id });
	}
	// Recheck every completed source after the last instance scan. This closes
	// the multi-instance window where an earlier instance could publish while a
	// later instance was still being consumed. Callers discard their incremental
	// aggregates whenever any entry becomes unavailable.
	for (const instance of [...input.instances].sort((left, right) =>
		left.id.localeCompare(right.id),
	)) {
		const index = evidence.findIndex((entry) => entry.instanceId === instance.id);
		const entry = evidence[index];
		if (!entry?.available) continue;
		const status = await readPlexGenerationStatus(prisma, instance.id);
		const current = evaluatePublishedPlexGeneration(status, withDefaultFreshness(input));
		const bindingFailure = current.available
			? validateExplicitStatusGenerationBinding(instance, status!)
			: undefined;
		if (
			!current.available ||
			bindingFailure !== null ||
			publishedGenerationsMatch(entry, current)
		) {
			evidence[index] = { ...unavailable("generation_changed"), instanceId: instance.id };
		}
	}
	return evidence;
}

export async function scanMutationPolicyEvidenceForOwnedInstances(
	prisma: PlexEvidencePrisma,
	input: {
		instances: PlexEvidenceInstance[];
		now?: Date;
		maxAgeMs?: number;
		onBatch?: PlexPolicyBatchHandler;
	},
): Promise<PlexPolicyScanEvidence[]> {
	const evidence = await scanPolicyEvidenceForOwnedInstances(prisma, input);
	return evidence.map((entry) =>
		hasCurrentPlexMutationAuthority(entry)
			? entry
			: { ...mutationUnavailable(entry), instanceId: entry.instanceId },
	);
}

export async function scanUserPolicyEvidence(
	prisma: PlexEvidencePrisma,
	input: { userId: string; now?: Date; maxAgeMs?: number; onBatch?: PlexPolicyBatchHandler },
): Promise<PlexPolicyScanEvidence[]> {
	try {
		const instances = (await prisma.serviceInstance.findMany({
			where: { userId: input.userId, service: "PLEX", enabled: true },
			orderBy: { id: "asc" },
		})) as PlexEvidenceInstance[];
		return scanPolicyEvidenceForOwnedInstances(prisma, { ...input, instances });
	} catch {
		return [unavailable("query_failed")];
	}
}

export async function loadInstanceEvidence(
	prisma: PlexEvidencePrisma,
	input: { userId: string; instanceId: string; now?: Date; maxAgeMs?: number },
): Promise<PlexInstanceEvidence> {
	try {
		const instance = (await prisma.serviceInstance.findFirst({
			where: { id: input.instanceId, userId: input.userId, service: "PLEX" },
		})) as PlexEvidenceInstance | null;
		if (!instance) return unavailable("missing_status");
		return loadOwnedInstanceEvidence(prisma, instance, withDefaultFreshness(input));
	} catch {
		return unavailable("query_failed");
	}
}

export async function loadInstanceMutationEvidence(
	prisma: PlexEvidencePrisma,
	input: { userId: string; instanceId: string; now?: Date; maxAgeMs?: number },
): Promise<PlexInstanceEvidence> {
	const evidence = await loadInstanceEvidence(prisma, input);
	return hasCurrentPlexMutationAuthority(evidence) ? evidence : mutationUnavailable(evidence);
}

export async function loadUserEvidence(
	prisma: PlexEvidencePrisma,
	input: { userId: string; now?: Date; maxAgeMs?: number },
): Promise<PlexInstanceEvidence[]> {
	try {
		const instances = (await prisma.serviceInstance.findMany({
			where: { userId: input.userId, service: "PLEX", enabled: true },
			orderBy: { id: "asc" },
		})) as PlexEvidenceInstance[];
		const evidence: PlexInstanceEvidence[] = [];
		for (const instance of instances) {
			const entry = await loadOwnedInstanceEvidence(prisma, instance, withDefaultFreshness(input));
			evidence.push(entry.available ? entry : { ...entry, instanceId: instance.id });
		}
		return evidence;
	} catch {
		return [unavailable("query_failed")];
	}
}

export async function loadEvidenceForOwnedInstances(
	prisma: PlexEvidencePrisma,
	input: { instances: PlexEvidenceInstance[]; now?: Date; maxAgeMs?: number },
): Promise<PlexInstanceEvidence[]> {
	const evidence: PlexInstanceEvidence[] = [];
	for (const instance of input.instances) {
		const entry = await loadOwnedInstanceEvidence(prisma, instance, withDefaultFreshness(input));
		evidence.push(entry.available ? entry : { ...entry, instanceId: instance.id });
	}
	return evidence;
}

export async function loadMutationEvidenceForOwnedInstances(
	prisma: PlexEvidencePrisma,
	input: { instances: PlexEvidenceInstance[]; now?: Date; maxAgeMs?: number },
): Promise<PlexInstanceEvidence[]> {
	const evidence = await loadEvidenceForOwnedInstances(prisma, input);
	return evidence.map((entry) =>
		hasCurrentPlexMutationAuthority(entry)
			? entry
			: { ...mutationUnavailable(entry), instanceId: entry.instanceId },
	);
}

export type AvailableSelectedPlexEvidence = Omit<AvailablePlexInstanceEvidence, "rows"> & {
	rows: PlexCache[];
	selection: PlexCacheRowSelection;
};

export type SelectedPlexEvidence = AvailableSelectedPlexEvidence | UnavailablePlexInstanceEvidence;

async function loadOwnedSelectedEvidence(
	prisma: PlexEvidencePrisma,
	instance: PlexEvidenceInstance,
	selection: PlexCacheRowSelection,
	options: { now?: Date; maxAgeMs?: number },
): Promise<SelectedPlexEvidence> {
	if (!instance.enabled) return unavailable("disabled_instance");
	if (!isCurrentVerifiedPlexInstance(instance)) return unavailable("identity_generation_mismatch");
	try {
		const before = await readPlexGenerationStatus(prisma, instance.id);
		const publishedBefore = evaluatePublishedPlexGeneration(before, options);
		if (!publishedBefore.available) return publishedBefore;
		const beforeBinding = validateExplicitStatusGenerationBinding(instance, before!);
		if (beforeBinding) return unavailable(beforeBinding);

		const [totalCount, boundCount, rows] = await Promise.all([
			countPlexCacheRows(prisma, { instanceId: instance.id }),
			countPlexCacheRows(prisma, {
				instanceId: instance.id,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
			}),
			listSelectedPlexCacheRows(prisma, instance.id, selection),
		]);
		const after = await readPlexGenerationStatus(prisma, instance.id);
		const publishedAfter = evaluatePublishedPlexGeneration(after, options);
		if (!publishedAfter.available) return publishedAfter;
		const afterBinding = validateExplicitStatusGenerationBinding(instance, after!);
		if (afterBinding) return unavailable(afterBinding);
		const generationMismatch = publishedGenerationsMatch(publishedBefore, publishedAfter);
		if (generationMismatch) return unavailable(generationMismatch);
		if (totalCount !== publishedBefore.itemCount || boundCount !== totalCount) {
			return unavailable("row_count_mismatch");
		}
		for (const row of rows) {
			if (
				row.instanceId !== instance.id ||
				row.connectionGeneration !== instance.connectionGeneration
			) {
				return unavailable("connection_generation_mismatch");
			}
			if (row.identityGeneration !== instance.identityGeneration) {
				return unavailable("identity_generation_mismatch");
			}
		}

		return {
			available: true,
			instanceId: instance.id,
			instanceName: instance.label,
			generationId: publishedBefore.generationId,
			publishedAt: publishedBefore.publishedAt,
			itemCount: publishedBefore.itemCount,
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
			metadata: publishedBefore.metadata,
			generationStatus: {
				instanceId: before!.instanceId,
				lastRefreshedAt: before!.lastRefreshedAt,
				lastResult: before!.lastResult,
				lastErrorMessage: before!.lastErrorMessage,
				lastAttemptAt: before!.lastAttemptAt,
				lastAttemptResult: before!.lastAttemptResult,
				lastAttemptErrorMessage: before!.lastAttemptErrorMessage,
				itemCount: before!.itemCount,
				connectionGeneration: before!.connectionGeneration,
				identityGeneration: before!.identityGeneration,
				generationId: before!.generationId,
				generationMetadata: before!.generationMetadata,
			},
			sections: publishedBefore.metadata.sections,
			rows,
			selection,
			evidence: publishedBefore.evidence,
		};
	} catch {
		return unavailable("query_failed");
	}
}

export async function loadInstanceSelectedEvidence(
	prisma: PlexEvidencePrisma,
	input: {
		userId: string;
		instanceId: string;
		selection: PlexCacheRowSelection;
		now?: Date;
		maxAgeMs?: number;
	},
): Promise<SelectedPlexEvidence> {
	try {
		const instance = (await prisma.serviceInstance.findFirst({
			where: { id: input.instanceId, userId: input.userId, service: "PLEX" },
		})) as PlexEvidenceInstance | null;
		if (!instance) return unavailable("missing_status");
		return loadOwnedSelectedEvidence(
			prisma,
			instance,
			input.selection,
			withDefaultFreshness(input),
		);
	} catch {
		return unavailable("query_failed");
	}
}

export async function loadInstanceSelectedMutationEvidence(
	prisma: PlexEvidencePrisma,
	input: {
		userId: string;
		instanceId: string;
		selection: PlexCacheRowSelection;
		now?: Date;
		maxAgeMs?: number;
	},
): Promise<SelectedPlexEvidence> {
	const evidence = await loadInstanceSelectedEvidence(prisma, input);
	return hasCurrentPlexMutationAuthority(evidence) ? evidence : mutationUnavailable(evidence);
}

export async function loadUserSelectedEvidence(
	prisma: PlexEvidencePrisma,
	input: { userId: string; selection: PlexCacheRowSelection; now?: Date; maxAgeMs?: number },
): Promise<SelectedPlexEvidence[]> {
	try {
		const instances = (await prisma.serviceInstance.findMany({
			where: { userId: input.userId, service: "PLEX", enabled: true },
			orderBy: { id: "asc" },
		})) as PlexEvidenceInstance[];
		const evidence: SelectedPlexEvidence[] = [];
		for (const instance of instances) {
			const entry = await loadOwnedSelectedEvidence(
				prisma,
				instance,
				input.selection,
				withDefaultFreshness(input),
			);
			evidence.push(entry.available ? entry : { ...entry, instanceId: instance.id });
		}
		return evidence;
	} catch {
		return [unavailable("query_failed")];
	}
}

export function hasAuthoritativeSelectedPlexEvidence(
	evidence: SelectedPlexEvidence[],
): evidence is AvailableSelectedPlexEvidence[] {
	return (
		evidence.length > 0 &&
		evidence.every((entry) => entry.available && isCurrentAuthoritativePlexEvidence(entry.evidence))
	);
}

export function isCurrentAuthoritativePlexEvidence(evidence: PlexEvidenceSummary): boolean {
	return (
		evidence.publicationLevel === "authoritative" &&
		evidence.completeness === "complete" &&
		evidence.reasonCodes.length === 0 &&
		(evidence.availability === undefined || evidence.availability === "current") &&
		(evidence.authority === undefined || evidence.authority === "authoritative")
	);
}

export function listObservedRows(evidence: PlexInstanceEvidence[]): PlexPolicyCacheRow[] {
	return evidence.flatMap((entry) => (entry.available ? entry.rows : []));
}

export function listPublishedSections(
	evidence: Array<PlexInstanceEvidence | PlexPolicyScanEvidence>,
): Array<PlexGenerationSection & { instanceId: string; instanceName: string }> {
	return evidence.flatMap((entry) =>
		entry.available
			? entry.sections.map((section) => ({
					...section,
					instanceId: entry.instanceId,
					instanceName: entry.instanceName,
				}))
			: [],
	);
}

export function hasAuthoritativePlexEvidence(
	evidence: Array<PlexInstanceEvidence | PlexPolicyScanEvidence>,
): boolean {
	return (
		evidence.length > 0 &&
		evidence.every((entry) => entry.available && isCurrentAuthoritativePlexEvidence(entry.evidence))
	);
}

export function hasCompleteAuthoritativePlexEvidence(
	evidence: Array<{ available: boolean; evidence: PlexEvidenceSummary }>,
): boolean {
	return (
		evidence.length > 0 &&
		evidence.every((entry) => entry.available && isCurrentAuthoritativePlexEvidence(entry.evidence))
	);
}

export function summarizePlexEvidence(
	evidence: Array<{ available: boolean; evidence: PlexEvidenceSummary }>,
): PlexEvidenceSummary {
	if (evidence.length === 0) return unavailable("missing_status").evidence;
	if (evidence.length === 1) return evidence[0]!.evidence;
	const unavailableEntries = evidence.filter(
		(entry) => !entry.available || entry.evidence.publicationLevel === "unavailable",
	);
	if (unavailableEntries.length > 0) {
		const lastKnown = unavailableEntries.every(
			(entry) => entry.available && entry.evidence.availability === "last-known",
		);
		const attemptStates = new Set(
			unavailableEntries.flatMap((entry) =>
				entry.evidence.attemptState ? [entry.evidence.attemptState] : [],
			),
		);
		return {
			availability: lastKnown ? "last-known" : "unavailable",
			authority: "unavailable",
			attemptState: attemptStates.size === 1 ? [...attemptStates][0] : "unknown",
			publicationLevel: "unavailable",
			completeness: "unknown",
			reasonCodes: [...new Set(unavailableEntries.flatMap((entry) => entry.evidence.reasonCodes))],
		};
	}
	const available = evidence.filter((entry) => entry.available);
	const positiveOnly = available.some(
		(entry) =>
			entry.evidence.publicationLevel === "positive-only" ||
			entry.evidence.completeness === "partial",
	);
	return {
		availability: "current",
		authority: positiveOnly ? "positive-only" : "authoritative",
		attemptState: positiveOnly ? "partial" : "success",
		publicationLevel: positiveOnly ? "positive-only" : "authoritative",
		completeness: positiveOnly ? "partial" : "complete",
		reasonCodes: [...new Set(available.flatMap((entry) => entry.evidence.reasonCodes))],
	};
}

export async function loadAuthoritativePolicySnapshot(
	prisma: PlexEvidencePrisma,
	input: { userId: string; now?: Date; maxAgeMs?: number },
): Promise<AvailablePlexInstanceEvidence[] | undefined> {
	const observations = await loadUserEvidence(prisma, {
		...input,
		maxAgeMs: input.maxAgeMs ?? DEFAULT_PLEX_EVIDENCE_FRESHNESS_MS,
	});
	const evidence = observations.map((entry) =>
		hasCurrentPlexMutationAuthority(entry)
			? entry
			: { ...mutationUnavailable(entry), instanceId: entry.instanceId },
	);
	return hasAuthoritativePlexEvidence(evidence)
		? (evidence as AvailablePlexInstanceEvidence[])
		: undefined;
}

async function loadOwnedPublishedGenerationObservation(
	prisma: PlexEvidencePrisma,
	instance: PlexEvidenceInstance,
	options: { now?: Date; maxAgeMs?: number },
): Promise<
	| {
			available: true;
			instanceId: string;
			instanceName: string;
			generationId: string;
			publishedAt: Date;
			itemCount: number;
			connectionGeneration: number;
			identityGeneration: number;
			metadata: DecodedPlexGenerationMetadata;
			sections: PlexGenerationSection[];
			generationStatus: AvailablePlexInstanceEvidence["generationStatus"];
			evidence: PlexEvidenceSummary;
	  }
	| UnavailablePlexInstanceEvidence
> {
	if (!instance.enabled) return unavailable("disabled_instance");
	if (!isCurrentVerifiedPlexInstance(instance)) return unavailable("identity_generation_mismatch");
	try {
		const before = await readPlexGenerationStatus(prisma, instance.id);
		const publishedBefore = evaluatePublishedPlexGeneration(before, options);
		if (!publishedBefore.available) return publishedBefore;
		const binding = validateExplicitStatusGenerationBinding(instance, before!);
		if (binding) return unavailable(binding);
		const [totalCount, boundCount] = await Promise.all([
			countPlexCacheRows(prisma, { instanceId: instance.id }),
			countPlexCacheRows(prisma, {
				instanceId: instance.id,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
			}),
		]);
		if (totalCount !== publishedBefore.itemCount || boundCount !== totalCount) {
			return unavailable("row_count_mismatch");
		}
		const after = await readPlexGenerationStatus(prisma, instance.id);
		const publishedAfter = evaluatePublishedPlexGeneration(after, options);
		if (!publishedAfter.available) return publishedAfter;
		const afterBinding = validateExplicitStatusGenerationBinding(instance, after!);
		if (afterBinding) return unavailable(afterBinding);
		const generationMismatch = publishedGenerationsMatch(publishedBefore, publishedAfter);
		if (generationMismatch) return unavailable(generationMismatch);
		return {
			available: true,
			instanceId: instance.id,
			instanceName: instance.label,
			generationId: publishedBefore.generationId,
			publishedAt: publishedBefore.publishedAt,
			itemCount: publishedBefore.itemCount,
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
			metadata: publishedBefore.metadata,
			sections: publishedBefore.metadata.sections,
			generationStatus: {
				instanceId: before!.instanceId,
				lastRefreshedAt: before!.lastRefreshedAt,
				lastResult: before!.lastResult,
				lastErrorMessage: before!.lastErrorMessage,
				lastAttemptAt: before!.lastAttemptAt,
				lastAttemptResult: before!.lastAttemptResult,
				lastAttemptErrorMessage: before!.lastAttemptErrorMessage,
				itemCount: before!.itemCount,
				connectionGeneration: before!.connectionGeneration,
				identityGeneration: before!.identityGeneration,
				generationId: before!.generationId,
				generationMetadata: before!.generationMetadata,
			},
			evidence: publishedBefore.evidence,
		};
	} catch {
		return unavailable("query_failed");
	}
}

export async function getPublishedGenerationObservation(
	prisma: PlexEvidencePrisma,
	input: { userId: string; instanceId: string; now?: Date; maxAgeMs?: number },
) {
	try {
		const instance = (await prisma.serviceInstance.findFirst({
			where: { id: input.instanceId, userId: input.userId, service: "PLEX" },
		})) as PlexEvidenceInstance | null;
		if (!instance) return unavailable("missing_status");
		return loadOwnedPublishedGenerationObservation(prisma, instance, withDefaultFreshness(input));
	} catch {
		return unavailable("query_failed");
	}
}

export async function getPublishedGenerationObservationForOwnedInstance(
	prisma: PlexEvidencePrisma,
	input: { instance: PlexEvidenceInstance; now?: Date; maxAgeMs?: number },
) {
	return loadOwnedPublishedGenerationObservation(
		prisma,
		input.instance,
		withDefaultFreshness(input),
	);
}

export async function getCurrentPlexMutationAuthorityForOwnedInstance(
	prisma: PlexEvidencePrisma,
	input: { instance: PlexEvidenceInstance; now?: Date; maxAgeMs?: number },
) {
	const evidence = await getPublishedGenerationObservationForOwnedInstance(prisma, input);
	return hasCurrentPlexMutationAuthority(evidence) ? evidence : mutationUnavailable(evidence);
}

export async function loadUserGenerationObservations(
	prisma: PlexEvidencePrisma,
	input: { userId: string; now?: Date; maxAgeMs?: number },
) {
	try {
		const instances = (await prisma.serviceInstance.findMany({
			where: { userId: input.userId, service: "PLEX", enabled: true },
			orderBy: { id: "asc" },
		})) as PlexEvidenceInstance[];
		const evidence = [];
		for (const instance of instances) {
			const entry = await loadOwnedPublishedGenerationObservation(
				prisma,
				instance,
				withDefaultFreshness(input),
			);
			evidence.push(entry.available ? entry : { ...entry, instanceId: instance.id });
		}
		return evidence;
	} catch {
		return [unavailable("query_failed")];
	}
}

export async function loadGenerationObservationsForOwnedInstances(
	prisma: PlexEvidencePrisma,
	input: { instances: PlexEvidenceInstance[]; now?: Date; maxAgeMs?: number },
) {
	const evidence = [];
	for (const instance of input.instances) {
		const entry = await loadOwnedPublishedGenerationObservation(
			prisma,
			instance,
			withDefaultFreshness(input),
		);
		evidence.push(entry.available ? entry : { ...entry, instanceId: instance.id });
	}
	return evidence;
}

export function decodePlexEpisodeGenerationMetadata(raw: string | null):
	| {
			ok: true;
			parentGenerationId: string;
			connectionGeneration: number;
			identityGeneration: number;
	  }
	| { ok: false } {
	if (!raw) return { ok: false };
	try {
		const value = JSON.parse(raw) as Record<string, unknown>;
		if (
			value.version !== 2 ||
			typeof value.parentPlexGenerationId !== "string" ||
			value.parentPlexGenerationId.trim() === "" ||
			value.parentPublicationLevel !== "authoritative" ||
			value.parentMetadataVersion !== 3 ||
			value.canonicalizationVersion !== 1 ||
			typeof value.episodeDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.episodeDigest) ||
			!Number.isSafeInteger(value.connectionGeneration) ||
			(value.connectionGeneration as number) < 0 ||
			!Number.isSafeInteger(value.identityGeneration) ||
			(value.identityGeneration as number) <= 0
		) {
			return { ok: false };
		}
		return {
			ok: true,
			parentGenerationId: value.parentPlexGenerationId,
			connectionGeneration: value.connectionGeneration as number,
			identityGeneration: value.identityGeneration as number,
		};
	} catch {
		return { ok: false };
	}
}

export async function loadInstanceEpisodeEvidence(
	prisma: PlexEvidencePrisma,
	input: {
		userId: string;
		instanceId: string;
		instance?: PlexEvidenceInstance;
		now?: Date;
		maxAgeMs?: number;
	},
): Promise<PlexEpisodeEvidence> {
	try {
		const options = withDefaultFreshness(input);
		const instance =
			input.instance ??
			((await prisma.serviceInstance.findFirst({
				where: { id: input.instanceId, userId: input.userId, service: "PLEX" },
			})) as PlexEvidenceInstance | null);
		if (!instance) return unavailable("missing_status");
		const parentBefore = await loadOwnedPublishedGenerationObservation(prisma, instance, options);
		if (!parentBefore.available) return parentBefore;
		if (!hasCurrentPlexMutationAuthority(parentBefore)) {
			return unavailableFromEvidence(parentBefore.evidence);
		}
		const before = await readPlexEpisodeGenerationStatus(prisma, instance.id);
		if (before?.lastResult !== "success") return unavailable("missing_status");
		if (!before.generationId?.trim()) return unavailable("missing_generation_id");
		const episodePublishedAt = before.lastRefreshedAt.getTime();
		const now = options.now ?? new Date();
		const episodeAttempt = evaluatePlexLatestAttemptTrust(before, now);
		if (episodeAttempt.reasonCode !== null) {
			const result = unavailable(episodeAttempt.reasonCode);
			result.evidence.availability = "last-known";
			result.evidence.attemptState = episodeAttempt.attemptState;
			result.evidence.publishedGeneration = {
				generationId: before.generationId,
				publicationLevel: "authoritative",
				publishedAt: before.lastRefreshedAt.toISOString(),
				itemCount: before.itemCount,
			};
			return result;
		}
		if (!Number.isFinite(episodePublishedAt) || episodePublishedAt > now.getTime()) {
			return unavailable("published_timestamp_changed");
		}
		if (now.getTime() - episodePublishedAt > options.maxAgeMs) {
			return unavailable("published_generation_stale");
		}
		const binding = validateExplicitStatusGenerationBinding(instance, before);
		if (binding) return unavailable(binding);
		const parentMetadata = decodePlexEpisodeGenerationMetadata(before.generationMetadata);
		if (!parentMetadata.ok) return unavailable("malformed_metadata");
		if (
			parentMetadata.parentGenerationId !== parentBefore.generationId ||
			parentMetadata.connectionGeneration !== instance.connectionGeneration ||
			parentMetadata.identityGeneration !== instance.identityGeneration
		) {
			return unavailable("parent_generation_unavailable");
		}
		const rows = await listPlexEpisodeCacheRows(prisma, instance.id);
		if (rows.length !== before.itemCount) return unavailable("row_count_mismatch");
		if (
			rows.some(
				(row) =>
					row.instanceId !== instance.id ||
					row.connectionGeneration !== instance.connectionGeneration ||
					row.identityGeneration !== instance.identityGeneration,
			)
		) {
			return unavailable("connection_generation_mismatch");
		}
		const after = await readPlexEpisodeGenerationStatus(prisma, instance.id);
		if (
			after?.lastResult !== "success" ||
			after.generationId !== before.generationId ||
			after.lastRefreshedAt.getTime() !== before.lastRefreshedAt.getTime() ||
			after.lastErrorMessage !== before.lastErrorMessage ||
			after.lastAttemptAt?.getTime() !== before.lastAttemptAt?.getTime() ||
			after.lastAttemptResult !== before.lastAttemptResult ||
			after.lastAttemptErrorMessage !== before.lastAttemptErrorMessage ||
			after.itemCount !== before.itemCount ||
			after.generationMetadata !== before.generationMetadata
		) {
			return unavailable("generation_changed");
		}
		const afterBinding = validateExplicitStatusGenerationBinding(instance, after);
		if (afterBinding) return unavailable(afterBinding);
		const parentAfter = await loadOwnedPublishedGenerationObservation(prisma, instance, options);
		if (
			!parentAfter.available ||
			!hasCurrentPlexMutationAuthority(parentAfter) ||
			parentAfter.generationId !== parentBefore.generationId
		) {
			return unavailable("parent_generation_unavailable");
		}
		return {
			available: true,
			instanceId: instance.id,
			generationId: before.generationId,
			parentGenerationId: parentMetadata.parentGenerationId,
			publishedAt: before.lastRefreshedAt,
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
			rows,
			generationStatus: {
				instanceId: before.instanceId,
				lastRefreshedAt: before.lastRefreshedAt,
				lastResult: before.lastResult,
				lastErrorMessage: before.lastErrorMessage,
				lastAttemptAt: before.lastAttemptAt,
				lastAttemptResult: before.lastAttemptResult,
				lastAttemptErrorMessage: before.lastAttemptErrorMessage,
				itemCount: before.itemCount,
				connectionGeneration: before.connectionGeneration,
				identityGeneration: before.identityGeneration,
				generationId: before.generationId,
				generationMetadata: before.generationMetadata,
			},
			evidence: {
				availability: "current",
				authority: "authoritative",
				attemptState: "success",
				publicationLevel: "authoritative",
				completeness: "complete",
				reasonCodes: [],
				publishedGeneration: {
					generationId: before.generationId,
					publicationLevel: "authoritative",
					publishedAt: before.lastRefreshedAt.toISOString(),
					itemCount: before.itemCount,
				},
			},
		};
	} catch {
		return unavailable("query_failed");
	}
}

/**
 * Reads selected episode rows without weakening the full-generation authority
 * checks that make a partial selection safe to return.
 */
export async function loadInstanceSelectedEpisodeEvidence(
	prisma: PlexEvidencePrisma,
	input: {
		userId: string;
		instanceId: string;
		showTmdbIds: number[];
		instance?: PlexEvidenceInstance;
		now?: Date;
		maxAgeMs?: number;
	},
): Promise<SelectedPlexEpisodeEvidence> {
	try {
		const options = withDefaultFreshness(input);
		const instance =
			input.instance ??
			((await prisma.serviceInstance.findFirst({
				where: { id: input.instanceId, userId: input.userId, service: "PLEX" },
			})) as PlexEvidenceInstance | null);
		if (!instance) return unavailable("missing_status");
		const parentBefore = await loadOwnedPublishedGenerationObservation(prisma, instance, options);
		if (!parentBefore.available) return parentBefore;
		if (!hasCurrentPlexMutationAuthority(parentBefore)) {
			return unavailableFromEvidence(parentBefore.evidence);
		}
		const before = await readPlexEpisodeGenerationStatus(prisma, instance.id);
		if (before?.lastResult !== "success") return unavailable("missing_status");
		if (!before.generationId?.trim()) return unavailable("missing_generation_id");
		const episodePublishedAt = before.lastRefreshedAt.getTime();
		const now = options.now ?? new Date();
		const episodeAttempt = evaluatePlexLatestAttemptTrust(before, now);
		if (episodeAttempt.reasonCode !== null) {
			const result = unavailable(episodeAttempt.reasonCode);
			result.evidence.availability = "last-known";
			result.evidence.attemptState = episodeAttempt.attemptState;
			result.evidence.publishedGeneration = {
				generationId: before.generationId,
				publicationLevel: "authoritative",
				publishedAt: before.lastRefreshedAt.toISOString(),
				itemCount: before.itemCount,
			};
			return result;
		}
		if (!Number.isFinite(episodePublishedAt) || episodePublishedAt > now.getTime()) {
			return unavailable("published_timestamp_changed");
		}
		if (now.getTime() - episodePublishedAt > options.maxAgeMs) {
			return unavailable("published_generation_stale");
		}
		const binding = validateExplicitStatusGenerationBinding(instance, before);
		if (binding) return unavailable(binding);
		const parentMetadata = decodePlexEpisodeGenerationMetadata(before.generationMetadata);
		if (!parentMetadata.ok) return unavailable("malformed_metadata");
		if (
			parentMetadata.parentGenerationId !== parentBefore.generationId ||
			parentMetadata.connectionGeneration !== instance.connectionGeneration ||
			parentMetadata.identityGeneration !== instance.identityGeneration
		) {
			return unavailable("parent_generation_unavailable");
		}
		const [totalCount, boundCount, rows] = await Promise.all([
			countPlexEpisodeCacheRows(prisma, { instanceId: instance.id }),
			countPlexEpisodeCacheRows(prisma, {
				instanceId: instance.id,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
			}),
			listPlexEpisodeRowsForShows(
				prisma,
				instance.id,
				input.showTmdbIds,
				instance.connectionGeneration,
				instance.identityGeneration,
			),
		]);
		if (totalCount !== before.itemCount || boundCount !== totalCount) {
			return unavailable("row_count_mismatch");
		}
		if (
			rows.some(
				(row) =>
					row.instanceId !== instance.id ||
					row.connectionGeneration !== instance.connectionGeneration ||
					row.identityGeneration !== instance.identityGeneration,
			)
		) {
			return unavailable("connection_generation_mismatch");
		}
		const after = await readPlexEpisodeGenerationStatus(prisma, instance.id);
		if (
			after?.lastResult !== "success" ||
			after.generationId !== before.generationId ||
			after.lastRefreshedAt.getTime() !== before.lastRefreshedAt.getTime() ||
			after.lastErrorMessage !== before.lastErrorMessage ||
			after.lastAttemptAt?.getTime() !== before.lastAttemptAt?.getTime() ||
			after.lastAttemptResult !== before.lastAttemptResult ||
			after.lastAttemptErrorMessage !== before.lastAttemptErrorMessage ||
			after.itemCount !== before.itemCount ||
			after.generationMetadata !== before.generationMetadata
		) {
			return unavailable("generation_changed");
		}
		const afterBinding = validateExplicitStatusGenerationBinding(instance, after);
		if (afterBinding) return unavailable(afterBinding);
		const parentAfter = await loadOwnedPublishedGenerationObservation(prisma, instance, options);
		if (
			!parentAfter.available ||
			!hasCurrentPlexMutationAuthority(parentAfter) ||
			parentAfter.generationId !== parentBefore.generationId
		) {
			return unavailable("parent_generation_unavailable");
		}
		return {
			available: true,
			instanceId: instance.id,
			generationId: before.generationId,
			parentGenerationId: parentMetadata.parentGenerationId,
			publishedAt: before.lastRefreshedAt,
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
			rows,
			generationStatus: {
				instanceId: before.instanceId,
				lastRefreshedAt: before.lastRefreshedAt,
				lastResult: before.lastResult,
				lastErrorMessage: before.lastErrorMessage,
				lastAttemptAt: before.lastAttemptAt,
				lastAttemptResult: before.lastAttemptResult,
				lastAttemptErrorMessage: before.lastAttemptErrorMessage,
				itemCount: before.itemCount,
				connectionGeneration: before.connectionGeneration,
				identityGeneration: before.identityGeneration,
				generationId: before.generationId,
				generationMetadata: before.generationMetadata,
			},
			evidence: {
				availability: "current",
				authority: "authoritative",
				attemptState: "success",
				publicationLevel: "authoritative",
				completeness: "complete",
				reasonCodes: [],
				publishedGeneration: {
					generationId: before.generationId,
					publicationLevel: "authoritative",
					publishedAt: before.lastRefreshedAt.toISOString(),
					itemCount: before.itemCount,
				},
			},
		};
	} catch {
		return unavailable("query_failed");
	}
}

export type AvailablePlexEpisodeGenerationObservation = Omit<
	AvailablePlexEpisodeEvidence,
	"rows"
> & {
	itemCount: number;
};

async function loadOwnedEpisodeGenerationObservation(
	prisma: PlexEvidencePrisma,
	instance: PlexEvidenceInstance,
	input: { now?: Date; maxAgeMs?: number },
): Promise<AvailablePlexEpisodeGenerationObservation | UnavailablePlexInstanceEvidence> {
	const options = withDefaultFreshness(input);
	if (!instance.enabled) return unavailable("disabled_instance");
	if (!isCurrentVerifiedPlexInstance(instance)) return unavailable("identity_generation_mismatch");
	try {
		const parentBefore = await loadOwnedPublishedGenerationObservation(prisma, instance, options);
		if (!parentBefore.available) return unavailable("parent_generation_unavailable");
		const before = await readPlexEpisodeGenerationStatus(prisma, instance.id);
		if (before?.lastResult !== "success") return unavailable("missing_status");
		if (!before.generationId?.trim()) return unavailable("missing_generation_id");
		const publishedAt = before.lastRefreshedAt.getTime();
		const now = options.now ?? new Date();
		const episodeAttempt = evaluatePlexLatestAttemptTrust(before, now);
		if (!Number.isFinite(publishedAt) || publishedAt > now.getTime()) {
			return unavailable("published_timestamp_changed");
		}
		if (now.getTime() - publishedAt > options.maxAgeMs) {
			return unavailable("published_generation_stale");
		}
		const binding = validateExplicitStatusGenerationBinding(instance, before);
		if (binding) return unavailable(binding);
		const parentMetadata = decodePlexEpisodeGenerationMetadata(before.generationMetadata);
		if (!parentMetadata.ok) return unavailable("malformed_metadata");
		if (
			parentMetadata.parentGenerationId !== parentBefore.generationId ||
			parentMetadata.connectionGeneration !== instance.connectionGeneration ||
			parentMetadata.identityGeneration !== instance.identityGeneration
		) {
			return unavailable("parent_generation_unavailable");
		}
		const [totalCount, boundCount] = await Promise.all([
			countPlexEpisodeCacheRows(prisma, { instanceId: instance.id }),
			countPlexEpisodeCacheRows(prisma, {
				instanceId: instance.id,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
			}),
		]);
		if (totalCount !== before.itemCount || boundCount !== totalCount) {
			return unavailable("row_count_mismatch");
		}
		const after = await readPlexEpisodeGenerationStatus(prisma, instance.id);
		if (
			after?.lastResult !== "success" ||
			after.generationId !== before.generationId ||
			after.lastRefreshedAt.getTime() !== before.lastRefreshedAt.getTime() ||
			after.lastErrorMessage !== before.lastErrorMessage ||
			after.lastAttemptAt?.getTime() !== before.lastAttemptAt?.getTime() ||
			after.lastAttemptResult !== before.lastAttemptResult ||
			after.lastAttemptErrorMessage !== before.lastAttemptErrorMessage ||
			after.itemCount !== before.itemCount ||
			after.generationMetadata !== before.generationMetadata
		) {
			return unavailable("generation_changed");
		}
		const afterBinding = validateExplicitStatusGenerationBinding(instance, after);
		if (afterBinding) return unavailable(afterBinding);
		const parentAfter = await loadOwnedPublishedGenerationObservation(prisma, instance, options);
		if (
			!parentAfter.available ||
			parentAfter.generationId !== parentBefore.generationId ||
			parentAfter.evidence.availability !== parentBefore.evidence.availability ||
			parentAfter.evidence.authority !== parentBefore.evidence.authority ||
			parentAfter.evidence.attemptState !== parentBefore.evidence.attemptState ||
			parentAfter.evidence.reasonCodes.join("\u0000") !==
				parentBefore.evidence.reasonCodes.join("\u0000")
		) {
			return unavailable("parent_generation_unavailable");
		}
		const parentCurrent = hasCurrentPlexMutationAuthority(parentBefore);
		const current = parentCurrent && episodeAttempt.reasonCode === null;
		const reasonCodes: PlexCoverageReasonCode[] = current
			? []
			: parentCurrent
				? [episodeAttempt.reasonCode ?? "mutation_authority_unavailable"]
				: parentBefore.evidence.reasonCodes.length > 0
					? parentBefore.evidence.reasonCodes
					: ["parent_generation_unavailable"];
		return {
			available: true,
			instanceId: instance.id,
			generationId: before.generationId,
			parentGenerationId: parentMetadata.parentGenerationId,
			publishedAt: before.lastRefreshedAt,
			itemCount: before.itemCount,
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
			generationStatus: {
				instanceId: before.instanceId,
				lastRefreshedAt: before.lastRefreshedAt,
				lastResult: before.lastResult,
				lastErrorMessage: before.lastErrorMessage,
				lastAttemptAt: before.lastAttemptAt,
				lastAttemptResult: before.lastAttemptResult,
				lastAttemptErrorMessage: before.lastAttemptErrorMessage,
				itemCount: before.itemCount,
				connectionGeneration: before.connectionGeneration,
				identityGeneration: before.identityGeneration,
				generationId: before.generationId,
				generationMetadata: before.generationMetadata,
			},
			evidence: {
				availability: current ? "current" : "last-known",
				authority: current ? "authoritative" : "unavailable",
				attemptState: parentCurrent
					? episodeAttempt.attemptState
					: (parentBefore.evidence.attemptState ?? "unknown"),
				publicationLevel: current ? "authoritative" : "unavailable",
				completeness: current ? "complete" : "unknown",
				reasonCodes,
				publishedGeneration: {
					generationId: before.generationId,
					publicationLevel: "authoritative",
					publishedAt: before.lastRefreshedAt.toISOString(),
					itemCount: before.itemCount,
				},
			},
		};
	} catch {
		return unavailable("query_failed");
	}
}

export async function getPublishedEpisodeGenerationObservation(
	prisma: PlexEvidencePrisma,
	input: {
		userId: string;
		instanceId: string;
		instance?: PlexEvidenceInstance;
		now?: Date;
		maxAgeMs?: number;
	},
) {
	try {
		const instance =
			input.instance ??
			((await prisma.serviceInstance.findFirst({
				where: { id: input.instanceId, userId: input.userId, service: "PLEX" },
			})) as PlexEvidenceInstance | null);
		if (!instance) return unavailable("missing_status");
		return loadOwnedEpisodeGenerationObservation(prisma, instance, input);
	} catch {
		return unavailable("query_failed");
	}
}

export function getTargetEvidence(
	evidence: PlexInstanceEvidence,
	target: { tmdbId: number; mediaType: "movie" | "series" },
): PlexPolicyCacheRow[] {
	if (!evidence.available) return [];
	return evidence.rows.filter(
		(row) => row.tmdbId === target.tmdbId && row.mediaType === target.mediaType,
	);
}
