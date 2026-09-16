import type {
	PlexCoverageReasonCode,
	PlexEvidenceSummary,
	PlexGenerationMetadataV3,
	PlexGenerationMetadataV5,
	PlexGenerationSection,
	PlexPositiveGenerationMetadataV4,
	ProviderObservationStatus,
} from "@arr/shared";
import {
	createEvidenceFingerprintArrayAccumulator,
	type EvidenceFingerprintArrayAccumulator,
} from "../evidence-fingerprint.js";
import type { PlexCache, PlexEpisodeCache, PrismaClientInstance } from "../prisma.js";
import { authorizeTargetScopedWatchCountMutation } from "../provider-observation/evidence-capabilities.js";
import {
	countPlexCacheRows,
	countPlexEpisodeCacheRows,
	listPlexCacheRows,
	listPlexEpisodeCacheRows,
	listPlexEpisodeRowsForShows,
	listSelectedPlexCacheRows,
	type PlexCacheRowSelection,
	type PlexEpisodeParentPolicyRow,
	type PlexPolicyCacheRow,
	readPlexEpisodeGenerationStatus,
	readPlexGenerationStatus,
	scanPlexEpisodeParentPolicyRows,
	scanPlexPolicyCacheRows,
} from "./plex-cache-storage.js";
import {
	type DecodedPlexGenerationMetadata,
	evaluatePlexLatestAttemptTrust,
	evaluatePlexMutationAuthority,
	evaluatePublishedPlexGeneration,
	isCompleteAuthoritativePlexGenerationMetadata,
	type PlexGenerationMetadataV6,
	projectPlexProviderObservationStatus,
} from "./plex-generation-metadata.js";
import {
	readPlexGenerationTargetsForSelection,
	verifyPersistedPlexGenerationTargets,
} from "./plex-generation-target-ledger.js";
import {
	decodePlexPositiveEpisodeGenerationMetadata,
	type PlexPositiveEpisodeGenerationMetadata,
} from "./plex-positive-episode-generation-metadata.js";

type PlexAuthoritativeGenerationMetadataV5 = Extract<
	PlexGenerationMetadataV5,
	{ publicationLevel: "authoritative" }
>;
type PlexAuthoritativeGenerationMetadataV6 = Extract<
	PlexGenerationMetadataV6,
	{ publicationLevel: "authoritative" }
>;
type PlexPositiveGenerationMetadataV6 = Extract<
	PlexGenerationMetadataV6,
	{ publicationLevel: "positive-only" }
>;
type PlexPositiveGenerationMetadataV5 = Extract<
	PlexGenerationMetadataV5,
	{ publicationLevel: "positive-only" }
>;

// Mutation authority retains the established 24-hour cutoff. The schedulers'
// 12-hour threshold is an earlier operational warning/refresh cadence, not a
// second authority policy.
export const DEFAULT_PLEX_EVIDENCE_FRESHNESS_MS = 24 * 60 * 60 * 1000;

type PlexEvidencePrisma = Pick<
	PrismaClientInstance,
	| "serviceInstance"
	| "cacheRefreshStatus"
	| "plexCache"
	| "plexEpisodeCache"
	| "plexGenerationTarget"
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
	providerStatus: ProviderObservationStatus;
};

export type UnavailablePlexInstanceEvidence = {
	available: false;
	instanceId?: string;
	evidence: PlexEvidenceSummary;
	providerStatus: ProviderObservationStatus;
};

export type PlexInstanceEvidence = AvailablePlexInstanceEvidence | UnavailablePlexInstanceEvidence;

export type AvailablePositiveEpisodeParentEvidence = Omit<
	AvailablePlexInstanceEvidence,
	"metadata" | "rows"
> & {
	metadata:
		| PlexGenerationMetadataV3
		| PlexPositiveGenerationMetadataV4
		| PlexAuthoritativeGenerationMetadataV5
		| PlexPositiveGenerationMetadataV5
		| PlexAuthoritativeGenerationMetadataV6
		| PlexPositiveGenerationMetadataV6;
	rows: PlexPolicyCacheRow[];
};

export type PositiveEpisodeParentEvidence =
	| AvailablePositiveEpisodeParentEvidence
	| UnavailablePlexInstanceEvidence;

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
	providerStatus: ProviderObservationStatus;
};

export type PlexEpisodeEvidence = AvailablePlexEpisodeEvidence | UnavailablePlexInstanceEvidence;

/**
 * A single target-bound V6 watch-count proof. This is intentionally separate
 * from aggregate Plex policy evidence: a partial publication cannot populate a
 * reusable map for unrelated cleanup rules.
 */
export type TargetScopedPlexWatchCountMutationEvidence =
	| {
			available: true;
			instanceId: string;
			generationId: string;
			connectionGeneration: number;
			identityGeneration: number;
			targetKey: string;
			coordinate: string;
			observedValue: number;
			providerStatus: ProviderObservationStatus;
			evidence: PlexEvidenceSummary;
	  }
	| UnavailablePlexInstanceEvidence;

export type SelectedPlexEpisodeEvidence = PlexEpisodeEvidence;

export type AvailablePositivePlexEpisodeEvidence = {
	available: true;
	instanceId: string;
	generationId: string;
	parentGenerationId: string;
	publishedAt: Date;
	connectionGeneration: number;
	identityGeneration: number;
	metadata: PlexPositiveEpisodeGenerationMetadata;
	parentMetadata:
		| PlexPositiveGenerationMetadataV4
		| Extract<PlexGenerationMetadataV5, { publicationLevel: "positive-only" }>
		| PlexAuthoritativeGenerationMetadataV6
		| PlexPositiveGenerationMetadataV6;
	rows: PlexEpisodeCache[];
	generationStatus: AvailablePlexInstanceEvidence["generationStatus"];
	evidence: PlexEvidenceSummary;
	providerStatus: ProviderObservationStatus;
};

export type PositivePlexEpisodeEvidence =
	| AvailablePositivePlexEpisodeEvidence
	| UnavailablePlexInstanceEvidence;

function unavailable(
	reasonCode: PlexCoverageReasonCode,
	providerStatus = projectPlexProviderObservationStatus({ status: null }),
): UnavailablePlexInstanceEvidence {
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
		providerStatus,
	};
}

function unavailableFromEvidence(
	evidence: PlexEvidenceSummary,
	providerStatus = projectPlexProviderObservationStatus({ status: null }),
): UnavailablePlexInstanceEvidence {
	return {
		available: false,
		evidence,
		providerStatus,
	};
}

class PlexPolicyProvenanceError extends Error {
	constructor(readonly reasonCode: PlexCoverageReasonCode) {
		super(reasonCode);
		this.name = "PlexPolicyProvenanceError";
	}
}

class PlexPolicyMutationError extends Error {
	constructor(readonly result: UnavailablePlexInstanceEvidence) {
		super("mutation authority unavailable");
	}
}

function mutationUnavailable(evidence: {
	evidence: PlexEvidenceSummary;
	providerStatus?: ProviderObservationStatus;
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
		providerStatus:
			evidence.providerStatus ?? projectPlexProviderObservationStatus({ status: null }),
	};
}

function hasCurrentEpisodeParentReaderAuthority(evidence: {
	evidence: PlexEvidenceSummary;
	metadata: DecodedPlexGenerationMetadata;
}): evidence is {
	evidence: PlexEvidenceSummary;
	metadata:
		| PlexGenerationMetadataV3
		| PlexPositiveGenerationMetadataV4
		| PlexAuthoritativeGenerationMetadataV5
		| PlexPositiveGenerationMetadataV5
		| PlexAuthoritativeGenerationMetadataV6
		| PlexPositiveGenerationMetadataV6;
} {
	return (
		(evidence.metadata.version === 3 && isCurrentAuthoritativePlexEvidence(evidence.evidence)) ||
		(evidence.metadata.version === 5 &&
			evidence.metadata.publicationLevel === "authoritative" &&
			evidence.metadata.completeness === "complete" &&
			isCurrentAuthoritativePlexEvidence(evidence.evidence)) ||
		(evidence.metadata.version === 6 &&
			evidence.metadata.publicationLevel === "authoritative" &&
			evidence.metadata.completeness === "complete" &&
			isCurrentAuthoritativePlexEvidence(evidence.evidence)) ||
		(evidence.metadata.version === 5 &&
			evidence.metadata.publicationLevel === "positive-only" &&
			evidence.metadata.completeness === "partial" &&
			evidence.evidence.availability === "current" &&
			evidence.evidence.authority === "positive-only" &&
			evidence.metadata.capabilities.length === 1 &&
			evidence.metadata.capabilities[0].domain === "episode-parents" &&
			evidence.metadata.capabilities[0].field === "membership" &&
			evidence.metadata.capabilities[0].semantics === "observed-targets-only" &&
			evidence.metadata.capabilities[0].operators.length === 0) ||
		(evidence.metadata.version === 6 &&
			evidence.metadata.publicationLevel === "positive-only" &&
			evidence.metadata.completeness === "partial" &&
			evidence.evidence.availability === "current" &&
			evidence.evidence.authority === "positive-only" &&
			evidence.metadata.capabilities.length === 1 &&
			evidence.metadata.capabilities[0].domain === "episode-parents" &&
			evidence.metadata.capabilities[0].field === "membership" &&
			evidence.metadata.capabilities[0].semantics === "observed-targets-only" &&
			evidence.metadata.capabilities[0].operators.length === 0) ||
		(evidence.metadata.version === 4 &&
			evidence.metadata.publicationLevel === "positive-only" &&
			evidence.metadata.completeness === "partial" &&
			evidence.metadata.capabilities.length === 1 &&
			evidence.metadata.capabilities[0].domain === "episode-parents" &&
			evidence.metadata.capabilities[0].field === "membership" &&
			evidence.metadata.capabilities[0].semantics === "observed-targets-only" &&
			evidence.metadata.capabilities[0].operators.length === 0)
	);
}

function hasCurrentPositiveEpisodeReaderParentAuthority(
	evidence: {
		evidence: PlexEvidenceSummary;
		metadata: DecodedPlexGenerationMetadata;
	},
	allowLastKnownAttempt = false,
): evidence is {
	evidence: PlexEvidenceSummary;
	metadata:
		| PlexPositiveGenerationMetadataV4
		| Extract<PlexGenerationMetadataV5, { publicationLevel: "positive-only" }>
		| PlexAuthoritativeGenerationMetadataV6
		| PlexPositiveGenerationMetadataV6;
} {
	const metadata = evidence.metadata;
	const displayableLastKnown =
		allowLastKnownAttempt &&
		evidence.evidence.availability === "last-known" &&
		evidence.evidence.reasonCodes.length === 1 &&
		["latest_attempt_in_progress", "latest_attempt_failed", "latest_attempt_partial"].includes(
			evidence.evidence.reasonCodes[0]!,
		);
	const currentOrDisplayable = evidence.evidence.availability === "current" || displayableLastKnown;
	if (metadata.version === 5) {
		return (
			metadata.publicationLevel === "positive-only" &&
			metadata.completeness === "partial" &&
			currentOrDisplayable &&
			(evidence.evidence.authority === "positive-only" || displayableLastKnown) &&
			metadata.capabilities.length === 1 &&
			metadata.capabilities[0].domain === "episode-parents" &&
			metadata.capabilities[0].field === "membership" &&
			metadata.capabilities[0].semantics === "observed-targets-only" &&
			metadata.capabilities[0].operators.length === 0
		);
	}
	if (metadata.version === 6) {
		return (
			(metadata.publicationLevel === "positive-only" ||
				metadata.publicationLevel === "authoritative") &&
			(metadata.completeness === "partial" || metadata.completeness === "complete") &&
			currentOrDisplayable &&
			((metadata.publicationLevel === "positive-only" &&
				(evidence.evidence.authority === "positive-only" || displayableLastKnown) &&
				metadata.capabilities.length === 1 &&
				metadata.capabilities[0].domain === "episode-parents" &&
				metadata.capabilities[0].field === "membership" &&
				metadata.capabilities[0].semantics === "observed-targets-only" &&
				metadata.capabilities[0].operators.length === 0) ||
				(metadata.publicationLevel === "authoritative" &&
					(evidence.evidence.authority === "authoritative" || displayableLastKnown)))
		);
	}
	return (
		metadata.version === 4 &&
		metadata.publicationLevel === "positive-only" &&
		metadata.completeness === "partial" &&
		metadata.capabilities.length === 1 &&
		metadata.capabilities[0].domain === "episode-parents" &&
		metadata.capabilities[0].field === "membership" &&
		metadata.capabilities[0].semantics === "observed-targets-only" &&
		metadata.capabilities[0].operators.length === 0
	);
}

export function hasCurrentPlexMutationAuthority(
	evidence: {
		available: boolean;
		evidence: PlexEvidenceSummary;
		metadata?: DecodedPlexGenerationMetadata;
		generationStatus?: AvailablePlexInstanceEvidence["generationStatus"];
	},
	options: { now?: Date; maxAgeMs?: number } = {},
): boolean {
	if (!evidence.available || !evidence.generationStatus) return false;
	const strict = evaluatePlexMutationAuthority(evidence.generationStatus, {
		...options,
		maxAgeMs: options.maxAgeMs ?? DEFAULT_PLEX_EVIDENCE_FRESHNESS_MS,
	});
	return strict.available && isCompleteAuthoritativePlexGenerationMetadata(strict.metadata);
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

function samePlexMutationInstance(
	left: PlexEvidenceInstance,
	right: PlexEvidenceInstance,
): boolean {
	return (
		left.id === right.id &&
		left.userId === right.userId &&
		left.service === right.service &&
		left.enabled === right.enabled &&
		left.connectionGeneration === right.connectionGeneration &&
		left.identityGeneration === right.identityGeneration &&
		left.identityStatus === right.identityStatus &&
		left.expectedIdentity === right.expectedIdentity &&
		left.identityKind === right.identityKind &&
		left.identityVerifiedAt?.getTime() === right.identityVerifiedAt?.getTime()
	);
}

function hasCurrentV6TargetScopedWatchCountAuthority(evidence: {
	evidence: PlexEvidenceSummary;
	metadata: DecodedPlexGenerationMetadata;
}): evidence is {
	evidence: PlexEvidenceSummary;
	metadata: PlexAuthoritativeGenerationMetadataV6 | PlexPositiveGenerationMetadataV6;
} {
	return (
		evidence.metadata.version === 6 &&
		evidence.evidence.availability === "current" &&
		((evidence.metadata.publicationLevel === "positive-only" &&
			evidence.metadata.completeness === "partial" &&
			evidence.evidence.authority === "positive-only") ||
			(evidence.metadata.publicationLevel === "authoritative" &&
				evidence.metadata.completeness === "complete" &&
				evidence.evidence.authority === "authoritative"))
	);
}

function unavailableForIdentity(instance: PlexEvidenceInstance): UnavailablePlexInstanceEvidence {
	return unavailable(
		"identity_generation_mismatch",
		projectPlexProviderObservationStatus({
			status: null,
			identity: instance.identityStatus === "MISMATCH" ? "changed" : "unverified",
		}),
	);
}

function unavailableForBinding(
	reasonCode: PlexCoverageReasonCode,
	status: Parameters<typeof evaluatePublishedPlexGeneration>[0],
	metadata?: DecodedPlexGenerationMetadata,
): UnavailablePlexInstanceEvidence {
	return unavailable(
		reasonCode,
		projectPlexProviderObservationStatus({ status, metadata, identity: "changed" }),
	);
}

function unavailableAfterPublication(
	reasonCode: PlexCoverageReasonCode,
	providerStatus: ProviderObservationStatus,
	reason: ProviderObservationStatus["reasonCodes"][number],
): UnavailablePlexInstanceEvidence {
	return unavailable(reasonCode, {
		...providerStatus,
		availability: "unavailable",
		evidence: "unknown",
		observedAt: null,
		ageSeconds: null,
		reasonCodes: [reason],
	});
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
	if (!isCurrentVerifiedPlexInstance(instance)) return unavailableForIdentity(instance);
	let providerStatus: ProviderObservationStatus | undefined;
	try {
		const before = await readPlexGenerationStatus(prisma, instance.id);
		const publishedBefore = evaluatePublishedPlexGeneration(before, options);
		if (!publishedBefore.available) return publishedBefore;
		const beforeBinding = validateExplicitStatusGenerationBinding(instance, before!);
		if (beforeBinding)
			return unavailableForBinding(beforeBinding, before, publishedBefore.metadata);
		providerStatus = publishedBefore.providerStatus;

		const rows = await listPlexCacheRows(prisma, instance.id);
		const after = await readPlexGenerationStatus(prisma, instance.id);
		const publishedAfter = evaluatePublishedPlexGeneration(after, options);
		if (!publishedAfter.available) return publishedAfter;
		const afterBinding = validateExplicitStatusGenerationBinding(instance, after!);
		if (afterBinding) return unavailableForBinding(afterBinding, after, publishedAfter.metadata);

		const generationMismatch = publishedGenerationsMatch(publishedBefore, publishedAfter);
		if (generationMismatch)
			return unavailableAfterPublication(generationMismatch, providerStatus, "rows-inconsistent");
		if (rows.length !== publishedBefore.itemCount)
			return unavailableAfterPublication("row_count_mismatch", providerStatus, "rows-inconsistent");
		for (const row of rows) {
			if (
				row.instanceId !== instance.id ||
				row.connectionGeneration !== instance.connectionGeneration
			) {
				return unavailableForBinding(
					"connection_generation_mismatch",
					before,
					publishedBefore.metadata,
				);
			}
			if (row.identityGeneration !== instance.identityGeneration) {
				return unavailableForBinding(
					"identity_generation_mismatch",
					before,
					publishedBefore.metadata,
				);
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
			providerStatus: projectPlexProviderObservationStatus({
				status: before,
				metadata: publishedBefore.metadata,
				now: options.now,
				maxAgeMs: options.maxAgeMs,
			}),
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
		return providerStatus
			? unavailableAfterPublication("query_failed", providerStatus, "unknown-failure")
			: unavailable("query_failed");
	}
}

async function scanOwnedPolicyEvidence(
	prisma: PlexEvidencePrisma,
	instance: PlexEvidenceInstance,
	options: { now?: Date; maxAgeMs?: number; mutation?: boolean; onBatch?: PlexPolicyBatchHandler },
): Promise<PlexPolicyScanEvidence> {
	if (!instance.enabled) return unavailable("disabled_instance");
	if (!isCurrentVerifiedPlexInstance(instance)) return unavailableForIdentity(instance);
	let providerStatus: ProviderObservationStatus | undefined;
	try {
		const before = await readPlexGenerationStatus(prisma, instance.id);
		const publishedBefore = evaluatePublishedPlexGeneration(before, options);
		if (!publishedBefore.available) return publishedBefore;
		const beforeBinding = validateExplicitStatusGenerationBinding(instance, before!);
		if (beforeBinding)
			return unavailableForBinding(beforeBinding, before, publishedBefore.metadata);
		providerStatus = publishedBefore.providerStatus;
		if (options.mutation) {
			const strict = evaluatePlexMutationAuthority(before, options);
			if (!strict.available) return mutationUnavailable(strict);
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
			providerStatus: projectPlexProviderObservationStatus({
				status: before,
				metadata: publishedBefore.metadata,
				now: options.now,
				maxAgeMs: options.maxAgeMs,
			}),
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
			if (options.mutation) {
				const status = await readPlexGenerationStatus(prisma, instance.id);
				const strict = evaluatePlexMutationAuthority(status, options);
				if (!strict.available) throw new PlexPolicyMutationError(mutationUnavailable(strict));
				const binding = validateExplicitStatusGenerationBinding(instance, status!);
				if (binding)
					throw new PlexPolicyMutationError(
						unavailableForBinding(binding, status, strict.metadata),
					);
				if (publishedGenerationsMatch(publishedBefore, strict))
					throw new PlexPolicyMutationError(
						unavailableAfterPublication(
							"generation_changed",
							strict.providerStatus,
							"rows-inconsistent",
						),
					);
			}
			await options.onBatch?.({ instance: policyInstance, rows });
		});

		if (rowCount !== publishedBefore.itemCount)
			return unavailableAfterPublication("row_count_mismatch", providerStatus, "rows-inconsistent");
		const after = await readPlexGenerationStatus(prisma, instance.id);
		const publishedAfter = evaluatePublishedPlexGeneration(after, options);
		if (!publishedAfter.available) return publishedAfter;
		const afterBinding = validateExplicitStatusGenerationBinding(instance, after!);
		if (afterBinding) return unavailableForBinding(afterBinding, after, publishedAfter.metadata);
		if (options.mutation) {
			const strict = evaluatePlexMutationAuthority(after, options);
			if (!strict.available) return mutationUnavailable(strict);
		}
		const generationMismatch = publishedGenerationsMatch(publishedBefore, publishedAfter);
		if (generationMismatch)
			return unavailableAfterPublication(generationMismatch, providerStatus, "rows-inconsistent");

		return { ...policyInstance, rowCount, rowFingerprint: fingerprint.digest() };
	} catch (error) {
		if (error instanceof PlexPolicyMutationError) return error.result;
		if (error instanceof PlexPolicyProvenanceError) {
			return providerStatus
				? unavailableAfterPublication(error.reasonCode, providerStatus, "identity-changed")
				: unavailable(error.reasonCode);
		}
		return providerStatus
			? unavailableAfterPublication("query_failed", providerStatus, "unknown-failure")
			: unavailable("query_failed");
	}
}

export async function scanInstancePolicyEvidence(
	prisma: PlexEvidencePrisma,
	input: {
		userId: string;
		instanceId: string;
		now?: Date;
		maxAgeMs?: number;
		mutation?: boolean;
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
		mutation?: boolean;
		onBatch?: PlexEpisodeParentPolicyBatchHandler;
	},
): Promise<PlexPolicyScanEvidence> {
	let priorProviderStatus: ProviderObservationStatus | undefined;
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
		priorProviderStatus = publishedBefore.providerStatus;
		const beforeBinding = validateExplicitStatusGenerationBinding(instance, before!);
		if (beforeBinding)
			return unavailableForBinding(beforeBinding, before, publishedBefore.metadata);
		if (input.mutation) {
			const strict = evaluatePlexMutationAuthority(before, options);
			if (!strict.available) return mutationUnavailable(strict);
			const strictBinding = validateExplicitStatusGenerationBinding(instance, before!);
			if (strictBinding) return unavailableForBinding(strictBinding, before, strict.metadata);
			const strictGenerationMismatch = publishedGenerationsMatch(publishedBefore, strict);
			if (strictGenerationMismatch) {
				return unavailableAfterPublication(
					strictGenerationMismatch,
					strict.providerStatus,
					"rows-inconsistent",
				);
			}
		}
		const [totalCount, boundCount] = await Promise.all([
			countPlexCacheRows(prisma, { instanceId: instance.id }),
			countPlexCacheRows(prisma, {
				instanceId: instance.id,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
			}),
		]);
		if (totalCount !== publishedBefore.itemCount || boundCount !== totalCount) {
			return unavailableAfterPublication(
				"row_count_mismatch",
				publishedBefore.providerStatus,
				"rows-inconsistent",
			);
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
			providerStatus: projectPlexProviderObservationStatus({
				status: before,
				metadata: publishedBefore.metadata,
				now: options.now,
				maxAgeMs: options.maxAgeMs,
			}),
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
			if (provenanceFailure) return;
			if (input.mutation) {
				const status = await readPlexGenerationStatus(prisma, instance.id);
				const strict = evaluatePlexMutationAuthority(status, options);
				if (!strict.available) throw new PlexPolicyMutationError(mutationUnavailable(strict));
				const binding = validateExplicitStatusGenerationBinding(instance, status!);
				if (binding)
					throw new PlexPolicyMutationError(
						unavailableForBinding(binding, status, strict.metadata),
					);
				if (publishedGenerationsMatch(publishedBefore, strict))
					throw new PlexPolicyMutationError(
						unavailableAfterPublication(
							"generation_changed",
							strict.providerStatus,
							"rows-inconsistent",
						),
					);
			}
			await input.onBatch?.({ instance: policyInstance, rows });
		});
		if (provenanceFailure)
			return unavailableAfterPublication(
				provenanceFailure,
				publishedBefore.providerStatus,
				"rows-inconsistent",
			);

		const after = await readPlexGenerationStatus(prisma, instance.id);
		const publishedAfter = evaluatePublishedPlexGeneration(after, options);
		if (!publishedAfter.available) {
			return unavailableAfterPublication(
				"generation_changed",
				publishedAfter.providerStatus,
				"unknown-failure",
			);
		}
		const afterBinding = validateExplicitStatusGenerationBinding(instance, after!);
		if (afterBinding) return unavailableForBinding(afterBinding, after, publishedAfter.metadata);
		const generationMismatch = publishedGenerationsMatch(publishedBefore, publishedAfter);
		if (generationMismatch)
			return unavailableAfterPublication(
				generationMismatch,
				publishedAfter.providerStatus,
				"rows-inconsistent",
			);
		if (input.mutation) {
			const strict = evaluatePlexMutationAuthority(after, options);
			if (!strict.available) return mutationUnavailable(strict);
			const strictBinding = validateExplicitStatusGenerationBinding(instance, after!);
			if (strictBinding) return unavailableForBinding(strictBinding, after, strict.metadata);
			const strictGenerationMismatch = publishedGenerationsMatch(publishedBefore, strict);
			if (strictGenerationMismatch) {
				return unavailableAfterPublication(
					strictGenerationMismatch,
					strict.providerStatus,
					"rows-inconsistent",
				);
			}
		}

		return { ...policyInstance, rowCount, rowFingerprint: fingerprint.digest() };
	} catch (error) {
		if (error instanceof PlexPolicyMutationError) return error.result;
		return priorProviderStatus
			? unavailableAfterPublication("query_failed", priorProviderStatus, "unknown-failure")
			: unavailable("query_failed");
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
	const evidence: PlexPolicyScanEvidence[] = [];
	for (const instance of [...input.instances].sort((left, right) =>
		left.id.localeCompare(right.id),
	)) {
		// The scanner's own status check is the mutation gate. Do not preload a
		// display result and filter after batches have already been delivered.
		const entry = await scanOwnedPolicyEvidence(prisma, instance, {
			...withDefaultFreshness(input),
			mutation: true,
		});
		evidence.push(entry.available ? entry : { ...entry, instanceId: instance.id });
	}
	for (const instance of [...input.instances].sort((left, right) =>
		left.id.localeCompare(right.id),
	)) {
		const index = evidence.findIndex((entry) => entry.instanceId === instance.id);
		const entry = evidence[index];
		if (!entry?.available) continue;
		const status = await readPlexGenerationStatus(prisma, instance.id);
		const strict = evaluatePlexMutationAuthority(status, withDefaultFreshness(input));
		if (!strict.available) {
			evidence[index] = { ...mutationUnavailable(strict), instanceId: instance.id };
			continue;
		}
		const bindingFailure = validateExplicitStatusGenerationBinding(instance, status!);
		if (bindingFailure) {
			evidence[index] = {
				...unavailableForBinding(bindingFailure, status, strict.metadata),
				instanceId: instance.id,
			};
			continue;
		}
		if (publishedGenerationsMatch(entry, strict)) {
			evidence[index] = {
				...unavailableAfterPublication(
					"generation_changed",
					strict.providerStatus,
					"rows-inconsistent",
				),
				instanceId: instance.id,
			};
		}
	}
	return evidence;
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

/**
 * Deliberately narrow V5/V4 access seam. It exposes only observed Show-parent
 * rows; callers must still verify the bound target ledger before interpreting
 * a row as a positive parent fact. Absence is therefore never represented as
 * an exact empty/zero result.
 */
export async function loadPositiveEpisodeParentEvidence(
	prisma: PlexEvidencePrisma,
	input: { userId: string; instanceId: string; now?: Date; maxAgeMs?: number },
): Promise<PositiveEpisodeParentEvidence> {
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
		if (!hasCurrentEpisodeParentReaderAuthority(publishedBefore)) {
			return mutationUnavailable(publishedBefore);
		}
		const beforeBinding = validateExplicitStatusGenerationBinding(instance, before!);
		if (beforeBinding)
			return unavailableForBinding(beforeBinding, before, publishedBefore.metadata);

		const [totalCount, boundCount, allRows] = await Promise.all([
			countPlexCacheRows(prisma, { instanceId: instance.id }),
			countPlexCacheRows(prisma, {
				instanceId: instance.id,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
			}),
			listPlexCacheRows(prisma, instance.id),
		]);
		const after = await readPlexGenerationStatus(prisma, instance.id);
		const publishedAfter = evaluatePublishedPlexGeneration(after, options);
		if (!publishedAfter.available) return publishedAfter;
		if (!hasCurrentEpisodeParentReaderAuthority(publishedAfter)) {
			return mutationUnavailable(publishedAfter);
		}
		const afterBinding = validateExplicitStatusGenerationBinding(instance, after!);
		if (afterBinding) return unavailableForBinding(afterBinding, after, publishedAfter.metadata);
		const generationMismatch = publishedGenerationsMatch(publishedBefore, publishedAfter);
		if (generationMismatch) return unavailable(generationMismatch);
		if (totalCount !== publishedBefore.itemCount || boundCount !== totalCount) {
			return unavailable("row_count_mismatch");
		}
		if (
			allRows.some(
				(row) =>
					row.instanceId !== instance.id ||
					row.connectionGeneration !== instance.connectionGeneration ||
					row.identityGeneration !== instance.identityGeneration,
			)
		) {
			return unavailable("identity_generation_mismatch");
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
			providerStatus: projectPlexProviderObservationStatus({
				status: before,
				metadata: publishedBefore.metadata,
				now: options.now,
				maxAgeMs: options.maxAgeMs,
			}),
			rows: allRows.filter((row) => row.mediaType === "series" && row.ratingKey?.trim()),
			evidence: publishedBefore.evidence,
		};
	} catch {
		return unavailable("query_failed");
	}
}

/**
 * Reads one V6 positive-only watch-count target for mutation. Unlike generic
 * Plex policy readers, this never aggregates rows or treats an omission as a
 * zero: the requested target must have exactly one intact ledger coordinate
 * and exactly one matching current cache row.
 */
export async function loadTargetScopedPlexWatchCountMutationEvidence(
	prisma: PlexEvidencePrisma,
	input: {
		userId: string;
		instanceId: string;
		mediaType: "movie" | "series";
		tmdbId: number;
		operator: "greater_than";
		threshold: number;
		now?: Date;
		maxAgeMs?: number;
	},
): Promise<TargetScopedPlexWatchCountMutationEvidence> {
	const batch = await loadTargetScopedPlexWatchCountMutationEvidenceBatch(prisma, {
		userId: input.userId,
		instanceId: input.instanceId,
		targets: [{ mediaType: input.mediaType, tmdbId: input.tmdbId }],
		now: input.now,
		maxAgeMs: input.maxAgeMs,
	});
	if (!batch.available) return unavailable("target_ledger_invalid");
	const target = batch.targets[0];
	if (!target) return unavailable("target_ledger_invalid", batch.providerStatus);
	const decision = authorizeTargetScopedWatchCountMutation(batch.providerStatus, {
		domain: "watch-count",
		use: "mutation",
		field: "watch-count",
		operator: input.operator,
		threshold: input.threshold,
		observedValue: target.observedValue,
		targetObserved: true,
	});
	if (!decision.authorized) return unavailable("target_ledger_invalid", batch.providerStatus);
	return {
		available: true,
		instanceId: batch.instanceId,
		generationId: batch.generationId,
		connectionGeneration: batch.connectionGeneration,
		identityGeneration: batch.identityGeneration,
		targetKey: `${target.mediaType}:${target.tmdbId}`,
		coordinate: target.coordinate,
		observedValue: target.observedValue,
		providerStatus: batch.providerStatus,
		evidence: batch.evidence,
	};
}

/**
 * Bounded V6 target proof reader. It verifies the owning instance and complete
 * ledger once, then reads only requested cache/ledger coordinates in chunks.
 */
export async function loadTargetScopedPlexWatchCountMutationEvidenceBatch(
	prisma: PlexEvidencePrisma,
	input: {
		userId: string;
		instanceId: string;
		targets: readonly { mediaType: "movie" | "series"; tmdbId: number }[];
		now?: Date;
		maxAgeMs?: number;
	},
): Promise<
	| {
			available: true;
			instanceId: string;
			generationId: string;
			connectionGeneration: number;
			identityGeneration: number;
			providerStatus: ProviderObservationStatus;
			evidence: PlexEvidenceSummary;
			targets: Array<{
				mediaType: "movie" | "series";
				tmdbId: number;
				coordinate: string;
				sectionTitle: string;
				observedValue: number;
			}>;
	  }
	| { available: false }
> {
	try {
		const requested = [
			...new Map(
				input.targets.map((target) => [`${target.mediaType}:${target.tmdbId}`, target]),
			).values(),
		].filter((target) => Number.isSafeInteger(target.tmdbId) && target.tmdbId > 0);
		if (requested.length !== input.targets.length) return { available: false };
		const instance = (await prisma.serviceInstance.findFirst({
			where: { id: input.instanceId, userId: input.userId, service: "PLEX" },
		})) as PlexEvidenceInstance | null;
		if (!instance?.enabled || !isCurrentVerifiedPlexInstance(instance)) return { available: false };
		const options = withDefaultFreshness(input);
		const before = await readPlexGenerationStatus(prisma, instance.id);
		const published = evaluatePublishedPlexGeneration(before, options);
		if (!published.available || !hasCurrentV6TargetScopedWatchCountAuthority(published))
			return { available: false };
		if (validateExplicitStatusGenerationBinding(instance, before!)) return { available: false };
		const status = projectPlexProviderObservationStatus({
			status: before,
			metadata: published.metadata,
			now: options.now,
			maxAgeMs: options.maxAgeMs,
		});
		const selectedTargetBatches = await Promise.all(
			Array.from({ length: Math.ceil(requested.length / 250) }, (_, index) =>
				readPlexGenerationTargetsForSelection(
					prisma,
					{ instanceId: instance.id, generationId: published.generationId },
					requested.slice(index * 250, (index + 1) * 250),
				),
			),
		);
		const [totalCount, boundCount, ledger, rows] = await Promise.all([
			countPlexCacheRows(prisma, { instanceId: instance.id }),
			countPlexCacheRows(prisma, {
				instanceId: instance.id,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
			}),
			verifyPersistedPlexGenerationTargets(prisma, {
				expected: {
					instanceId: instance.id,
					generationId: published.generationId,
					connectionGeneration: instance.connectionGeneration,
					identityGeneration: instance.identityGeneration,
					targetLedgerVersion: published.metadata.targetLedgerVersion,
					targetCount: published.metadata.targetCount,
					targetDigest: published.metadata.targetDigest,
				},
				sections: published.metadata.sections,
			}),
			listSelectedPlexCacheRows(prisma, instance.id, { kind: "targets", targets: requested }),
		]);
		const selectedTargets = selectedTargetBatches.flat();
		if (!ledger.ok || totalCount !== published.itemCount || boundCount !== totalCount)
			return { available: false };
		const targetsByMediaTypeAndTmdbId = new Map<string, typeof selectedTargets>();
		for (const target of selectedTargets) {
			const key = `${target.mediaType}:${target.tmdbId}`;
			const matching = targetsByMediaTypeAndTmdbId.get(key) ?? [];
			matching.push(target);
			targetsByMediaTypeAndTmdbId.set(key, matching);
		}
		const rowsByMediaTypeAndTmdbId = new Map<string, typeof rows>();
		for (const row of rows) {
			const key = `${row.mediaType}:${row.tmdbId}`;
			const matching = rowsByMediaTypeAndTmdbId.get(key) ?? [];
			matching.push(row);
			rowsByMediaTypeAndTmdbId.set(key, matching);
		}
		const after = await readPlexGenerationStatus(prisma, instance.id);
		const currentInstance = (await prisma.serviceInstance.findFirst({
			where: { id: input.instanceId, userId: input.userId, service: "PLEX" },
		})) as PlexEvidenceInstance | null;
		const afterPublished = evaluatePublishedPlexGeneration(after, options);
		if (
			!currentInstance ||
			!samePlexMutationInstance(instance, currentInstance) ||
			!afterPublished.available ||
			!hasCurrentV6TargetScopedWatchCountAuthority(afterPublished) ||
			validateExplicitStatusGenerationBinding(currentInstance, after!) ||
			publishedGenerationsMatch(published, afterPublished)
		)
			return { available: false };
		const exact = [] as Array<{
			mediaType: "movie" | "series";
			tmdbId: number;
			coordinate: string;
			sectionTitle: string;
			observedValue: number;
		}>;
		for (const requestedTarget of requested) {
			const key = `${requestedTarget.mediaType}:${requestedTarget.tmdbId}`;
			const targets = targetsByMediaTypeAndTmdbId.get(key) ?? [];
			const matchingRows = rowsByMediaTypeAndTmdbId.get(key) ?? [];
			if (targets.length !== 1 || matchingRows.length !== 1) continue;
			const target = targets[0]!;
			const row = matchingRows[0]!;
			const sectionTitle = published.metadata.sections.find(
				(section) => section.key === target.sectionId,
			)?.title;
			if (
				!sectionTitle ||
				target.instanceId !== instance.id ||
				target.generationId !== published.generationId ||
				row.instanceId !== instance.id ||
				row.sectionId !== target.sectionId ||
				row.ratingKey !== target.ratingKey ||
				row.connectionGeneration !== instance.connectionGeneration ||
				row.identityGeneration !== instance.identityGeneration ||
				!Number.isSafeInteger(row.watchCount) ||
				row.watchCount < 0
			)
				continue;
			exact.push({
				mediaType: requestedTarget.mediaType,
				tmdbId: requestedTarget.tmdbId,
				coordinate: `${target.sectionId}:${target.ratingKey}`,
				sectionTitle,
				observedValue: row.watchCount,
			});
		}
		return {
			available: true,
			instanceId: instance.id,
			generationId: published.generationId,
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
			providerStatus: status,
			evidence: published.evidence,
			targets: exact,
		};
	} catch {
		return { available: false };
	}
}

export async function loadInstanceMutationEvidence(
	prisma: PlexEvidencePrisma,
	input: { userId: string; instanceId: string; now?: Date; maxAgeMs?: number },
): Promise<PlexInstanceEvidence> {
	const evidence = await loadInstanceEvidence(prisma, input);
	return hasCurrentPlexMutationAuthority(evidence, input)
		? evidence
		: mutationUnavailable(evidence);
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
		hasCurrentPlexMutationAuthority(entry, input)
			? entry
			: { ...mutationUnavailable(entry), instanceId: entry.instanceId },
	);
}

export type AvailableSelectedPlexEvidence = Omit<AvailablePlexInstanceEvidence, "rows"> & {
	rows: PlexCache[];
	selection: PlexCacheRowSelection;
};

export type SelectedPlexEvidence = AvailableSelectedPlexEvidence | UnavailablePlexInstanceEvidence;

export function listDisplayableSelectedPlexEvidence(
	evidence: SelectedPlexEvidence[],
): AvailableSelectedPlexEvidence[] {
	return evidence.filter(
		(entry): entry is AvailableSelectedPlexEvidence => entry.available === true,
	);
}

async function loadOwnedSelectedEvidence(
	prisma: PlexEvidencePrisma,
	instance: PlexEvidenceInstance,
	selection: PlexCacheRowSelection,
	options: { now?: Date; maxAgeMs?: number },
): Promise<SelectedPlexEvidence> {
	if (!instance.enabled) return unavailable("disabled_instance");
	if (!isCurrentVerifiedPlexInstance(instance)) return unavailable("identity_generation_mismatch");
	let providerStatus: ProviderObservationStatus | undefined;
	try {
		const before = await readPlexGenerationStatus(prisma, instance.id);
		const publishedBefore = evaluatePublishedPlexGeneration(before, options);
		if (!publishedBefore.available) return publishedBefore;
		const beforeBinding = validateExplicitStatusGenerationBinding(instance, before!);
		if (beforeBinding)
			return unavailableForBinding(beforeBinding, before, publishedBefore.metadata);
		providerStatus = publishedBefore.providerStatus;

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
		if (afterBinding) return unavailableForBinding(afterBinding, after, publishedAfter.metadata);
		const generationMismatch = publishedGenerationsMatch(publishedBefore, publishedAfter);
		if (generationMismatch)
			return unavailableAfterPublication(generationMismatch, providerStatus, "rows-inconsistent");
		if (totalCount !== publishedBefore.itemCount || boundCount !== totalCount) {
			return unavailableAfterPublication("row_count_mismatch", providerStatus, "rows-inconsistent");
		}
		for (const row of rows) {
			if (
				row.instanceId !== instance.id ||
				row.connectionGeneration !== instance.connectionGeneration
			) {
				return unavailableForBinding(
					"connection_generation_mismatch",
					before,
					publishedBefore.metadata,
				);
			}
			if (row.identityGeneration !== instance.identityGeneration) {
				return unavailableForBinding(
					"identity_generation_mismatch",
					before,
					publishedBefore.metadata,
				);
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
			providerStatus: projectPlexProviderObservationStatus({
				status: before,
				metadata: publishedBefore.metadata,
				now: options.now,
				maxAgeMs: options.maxAgeMs,
			}),
			rows,
			selection,
			evidence: publishedBefore.evidence,
		};
	} catch {
		return providerStatus
			? unavailableAfterPublication("query_failed", providerStatus, "unknown-failure")
			: unavailable("query_failed");
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
	return hasCurrentPlexMutationAuthority(evidence, input)
		? evidence
		: mutationUnavailable(evidence);
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
	const available = evidence.filter((entry) => entry.available);
	const partial = available.some(
		(entry) =>
			entry.evidence.publicationLevel === "positive-only" ||
			entry.evidence.completeness === "partial",
	);
	if (unavailableEntries.length > 0) {
		const lastKnown = unavailableEntries.every(
			(entry) => entry.available && entry.evidence.availability === "last-known",
		);
		const preservePartialProvenance = partial;
		const attemptStates = new Set(
			unavailableEntries.flatMap((entry) =>
				entry.evidence.attemptState ? [entry.evidence.attemptState] : [],
			),
		);
		const inProgress = evidence.some((entry) => entry.evidence.attemptState === "in_progress");
		return {
			availability: lastKnown ? "last-known" : "unavailable",
			authority: preservePartialProvenance ? "positive-only" : "unavailable",
			attemptState: inProgress
				? "in_progress"
				: preservePartialProvenance
					? "partial"
					: attemptStates.size === 1
						? [...attemptStates][0]
						: "unknown",
			publicationLevel: preservePartialProvenance ? "positive-only" : "unavailable",
			completeness: preservePartialProvenance ? "partial" : "unknown",
			reasonCodes: [...new Set(evidence.flatMap((entry) => entry.evidence.reasonCodes))],
		};
	}
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
		hasCurrentPlexMutationAuthority(entry, input)
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
			providerStatus: ProviderObservationStatus;
	  }
	| UnavailablePlexInstanceEvidence
> {
	if (!instance.enabled) return unavailable("disabled_instance");
	if (!isCurrentVerifiedPlexInstance(instance)) return unavailable("identity_generation_mismatch");
	let providerStatus: ProviderObservationStatus | undefined;
	try {
		const before = await readPlexGenerationStatus(prisma, instance.id);
		const publishedBefore = evaluatePublishedPlexGeneration(before, options);
		if (!publishedBefore.available) return publishedBefore;
		const binding = validateExplicitStatusGenerationBinding(instance, before!);
		if (binding) return unavailableForBinding(binding, before, publishedBefore.metadata);
		providerStatus = publishedBefore.providerStatus;
		const [totalCount, boundCount] = await Promise.all([
			countPlexCacheRows(prisma, { instanceId: instance.id }),
			countPlexCacheRows(prisma, {
				instanceId: instance.id,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
			}),
		]);
		if (totalCount !== publishedBefore.itemCount || boundCount !== totalCount) {
			return unavailableAfterPublication("row_count_mismatch", providerStatus, "rows-inconsistent");
		}
		const after = await readPlexGenerationStatus(prisma, instance.id);
		const publishedAfter = evaluatePublishedPlexGeneration(after, options);
		if (!publishedAfter.available) return publishedAfter;
		const afterBinding = validateExplicitStatusGenerationBinding(instance, after!);
		if (afterBinding) return unavailableForBinding(afterBinding, after, publishedAfter.metadata);
		const generationMismatch = publishedGenerationsMatch(publishedBefore, publishedAfter);
		if (generationMismatch)
			return unavailableAfterPublication(generationMismatch, providerStatus, "rows-inconsistent");
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
			providerStatus: projectPlexProviderObservationStatus({
				status: before,
				metadata: publishedBefore.metadata,
				now: options.now,
				maxAgeMs: options.maxAgeMs,
			}),
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
		return providerStatus
			? unavailableAfterPublication("query_failed", providerStatus, "unknown-failure")
			: unavailable("query_failed");
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
	return hasCurrentPlexMutationAuthority(evidence, input)
		? evidence
		: mutationUnavailable(evidence);
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
			version: 2 | 3;
			parentMetadataVersion: 3 | 5;
			parentGenerationId: string;
			connectionGeneration: number;
			identityGeneration: number;
	  }
	| { ok: false } {
	if (!raw) return { ok: false };
	try {
		const value = JSON.parse(raw) as Record<string, unknown>;
		if (
			(value.version !== 2 && value.version !== 3) ||
			typeof value.parentPlexGenerationId !== "string" ||
			value.parentPlexGenerationId.trim() === "" ||
			value.parentPublicationLevel !== "authoritative" ||
			value.parentMetadataVersion !== (value.version === 2 ? 3 : 5) ||
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
			version: value.version as 2 | 3,
			parentMetadataVersion: value.parentMetadataVersion as 3 | 5,
			parentGenerationId: value.parentPlexGenerationId,
			connectionGeneration: value.connectionGeneration as number,
			identityGeneration: value.identityGeneration as number,
		};
	} catch {
		return { ok: false };
	}
}

/**
 * Deliberately narrow V5/V4/V3 access seam for persisted positive episode facts.
 * It accepts only positive lower-bound episode observations bound to the
 * current positive parent generation; absent rows intentionally remain unknown.
 */
async function loadPositiveEpisodeEvidenceInternal(
	prisma: PlexEvidencePrisma,
	input: {
		userId: string;
		instanceId: string;
		instance?: PlexEvidenceInstance;
		now?: Date;
		maxAgeMs?: number;
	},
	mode: { allowLastKnownAttempt: boolean },
): Promise<PositivePlexEpisodeEvidence> {
	let parentProviderStatus: ProviderObservationStatus | undefined;
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
		parentProviderStatus = parentBefore.providerStatus;
		const parentPublishedAt = parentBefore.publishedAt.getTime();
		const now = options.now ?? new Date();
		if (
			mode.allowLastKnownAttempt &&
			(!Number.isFinite(parentPublishedAt) || parentPublishedAt > now.getTime())
		) {
			return unavailable("published_timestamp_changed", parentBefore.providerStatus);
		}
		if (mode.allowLastKnownAttempt && now.getTime() - parentPublishedAt > options.maxAgeMs) {
			return unavailable("published_generation_stale", parentBefore.providerStatus);
		}
		if (!hasCurrentPositiveEpisodeReaderParentAuthority(parentBefore, mode.allowLastKnownAttempt)) {
			return unavailableFromEvidence(parentBefore.evidence, parentBefore.providerStatus);
		}
		const parentUnavailable = (reasonCode: PlexCoverageReasonCode) =>
			unavailable(reasonCode, parentBefore.providerStatus);

		const before = await readPlexEpisodeGenerationStatus(prisma, instance.id);
		if (before?.lastResult !== "success") return parentUnavailable("missing_status");
		if (!before.generationId?.trim()) return parentUnavailable("missing_generation_id");
		const episodeAttempt = evaluatePlexLatestAttemptTrust(before, options.now ?? new Date());
		const acceptedAttempt =
			episodeAttempt.attemptState === "partial" &&
			episodeAttempt.reasonCode === "latest_attempt_partial";
		const acceptedLastKnownAttempt =
			mode.allowLastKnownAttempt &&
			(episodeAttempt.reasonCode === "latest_attempt_in_progress" ||
				episodeAttempt.reasonCode === "latest_attempt_failed" ||
				acceptedAttempt);
		if (!acceptedAttempt && !acceptedLastKnownAttempt) {
			return parentUnavailable(episodeAttempt.reasonCode ?? "metadata_invalid");
		}
		const episodePublishedAt = before.lastRefreshedAt.getTime();
		if (!Number.isFinite(episodePublishedAt) || episodePublishedAt > now.getTime()) {
			return parentUnavailable("published_timestamp_changed");
		}
		if (now.getTime() - episodePublishedAt > options.maxAgeMs) {
			return parentUnavailable("published_generation_stale");
		}
		const binding = validateExplicitStatusGenerationBinding(instance, before);
		if (binding) return unavailable(binding, parentBefore.providerStatus);
		const decoded = decodePlexPositiveEpisodeGenerationMetadata(before.generationMetadata);
		if (!decoded.ok) return parentUnavailable("malformed_metadata");
		const metadata = decoded.metadata;
		if (metadata.itemCount !== before.itemCount) return parentUnavailable("row_count_mismatch");
		if (
			metadata.parentPlexGenerationId !== parentBefore.generationId ||
			metadata.parentMetadataVersion !== parentBefore.metadata.version ||
			metadata.parentPublicationLevel !== parentBefore.metadata.publicationLevel ||
			(parentBefore.metadata.publicationLevel !== "positive-only" &&
				parentBefore.metadata.publicationLevel !== "authoritative")
		) {
			return parentUnavailable("parent_generation_unavailable");
		}
		if (metadata.parentTargetDigest !== parentBefore.metadata.targetDigest) {
			return parentUnavailable("target_digest_mismatch");
		}
		if (
			metadata.connectionGeneration !== instance.connectionGeneration ||
			metadata.identityGeneration !== instance.identityGeneration
		) {
			return parentUnavailable("parent_generation_unavailable");
		}

		const rows = await listPlexEpisodeCacheRows(prisma, instance.id);
		if (rows.length !== before.itemCount) return parentUnavailable("row_count_mismatch");
		if (
			rows.some(
				(row) =>
					row.instanceId !== instance.id ||
					row.connectionGeneration !== instance.connectionGeneration ||
					row.identityGeneration !== instance.identityGeneration,
			)
		) {
			return parentUnavailable("connection_generation_mismatch");
		}
		if (
			rows.some((row) => !Number.isSafeInteger(row.watchCount) || (row.watchCount as number) <= 0)
		) {
			return parentUnavailable("metadata_invalid");
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
			return parentUnavailable("generation_changed");
		}
		const afterBinding = validateExplicitStatusGenerationBinding(instance, after);
		if (afterBinding) return unavailable(afterBinding, parentBefore.providerStatus);
		const parentAfter = await loadOwnedPublishedGenerationObservation(prisma, instance, options);
		const parentAfterPublishedAt = parentAfter.available ? parentAfter.publishedAt.getTime() : NaN;
		if (
			!parentAfter.available ||
			(mode.allowLastKnownAttempt &&
				(!Number.isFinite(parentAfterPublishedAt) ||
					parentAfterPublishedAt > now.getTime() ||
					now.getTime() - parentAfterPublishedAt > options.maxAgeMs)) ||
			!hasCurrentPositiveEpisodeReaderParentAuthority(parentAfter, mode.allowLastKnownAttempt) ||
			parentAfter.generationId !== parentBefore.generationId ||
			parentAfter.metadata.targetDigest !== parentBefore.metadata.targetDigest
		) {
			return parentUnavailable("parent_generation_unavailable");
		}
		const displayLastKnown =
			mode.allowLastKnownAttempt &&
			(parentBefore.evidence.attemptState === "in_progress" ||
				parentBefore.evidence.attemptState === "error" ||
				parentBefore.evidence.reasonCodes.includes("latest_attempt_in_progress") ||
				parentBefore.evidence.reasonCodes.includes("latest_attempt_failed") ||
				episodeAttempt.reasonCode === "latest_attempt_in_progress" ||
				episodeAttempt.reasonCode === "latest_attempt_failed");
		const displayAttemptState =
			parentBefore.evidence.attemptState === "in_progress" ||
			episodeAttempt.attemptState === "in_progress"
				? "in_progress"
				: parentBefore.evidence.attemptState === "error" || episodeAttempt.attemptState === "error"
					? "error"
					: episodeAttempt.attemptState;
		const displayReasonCodes = [
			...parentBefore.evidence.reasonCodes.filter(
				(reasonCode) =>
					reasonCode === "latest_attempt_in_progress" ||
					reasonCode === "latest_attempt_failed" ||
					reasonCode === "latest_attempt_partial",
			),
			...(episodeAttempt.reasonCode ? [episodeAttempt.reasonCode] : []),
		].filter((reasonCode, index, reasonCodes) => reasonCodes.indexOf(reasonCode) === index);

		return {
			available: true,
			instanceId: instance.id,
			generationId: before.generationId,
			parentGenerationId: metadata.parentPlexGenerationId,
			publishedAt: before.lastRefreshedAt,
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
			metadata,
			parentMetadata: parentBefore.metadata,
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
			providerStatus: parentBefore.providerStatus,
			evidence: {
				availability: displayLastKnown ? "last-known" : "current",
				authority: displayLastKnown ? "unavailable" : "positive-only",
				attemptState: displayAttemptState,
				publicationLevel: "positive-only",
				completeness: "partial",
				reasonCodes:
					displayReasonCodes.length > 0 ? displayReasonCodes : ["latest_attempt_partial"],
				publishedGeneration: {
					generationId: before.generationId,
					publicationLevel: "positive-only",
					publishedAt: before.lastRefreshedAt.toISOString(),
					itemCount: before.itemCount,
				},
			},
		};
	} catch {
		return parentProviderStatus
			? unavailable("query_failed", parentProviderStatus)
			: unavailable("query_failed");
	}
}

export async function loadPositiveEpisodeEvidence(
	prisma: PlexEvidencePrisma,
	input: {
		userId: string;
		instanceId: string;
		instance?: PlexEvidenceInstance;
		now?: Date;
		maxAgeMs?: number;
	},
): Promise<PositivePlexEpisodeEvidence> {
	return loadPositiveEpisodeEvidenceInternal(prisma, input, { allowLastKnownAttempt: false });
}

/**
 * Display-only positive rows may use a still-fresh published snapshot while
 * its newer attempt is running or failed. The result is explicitly last-known
 * and never mutation authority.
 */
export async function loadPositiveEpisodeDisplayEvidence(
	prisma: PlexEvidencePrisma,
	input: {
		userId: string;
		instanceId: string;
		instance?: PlexEvidenceInstance;
		now?: Date;
		maxAgeMs?: number;
	},
): Promise<PositivePlexEpisodeEvidence> {
	return loadPositiveEpisodeEvidenceInternal(prisma, input, { allowLastKnownAttempt: true });
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
	let parentProviderStatus: ProviderObservationStatus | undefined;
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
		parentProviderStatus = parentBefore.providerStatus;
		if (!hasCurrentPlexMutationAuthority(parentBefore, options)) {
			return unavailableFromEvidence(parentBefore.evidence, parentBefore.providerStatus);
		}
		const before = await readPlexEpisodeGenerationStatus(prisma, instance.id);
		if (before?.lastResult !== "success")
			return unavailable("missing_status", parentBefore.providerStatus);
		if (!before.generationId?.trim())
			return unavailable("missing_generation_id", parentBefore.providerStatus);
		const episodePublishedAt = before.lastRefreshedAt.getTime();
		const now = options.now ?? new Date();
		const episodeAttempt = evaluatePlexLatestAttemptTrust(before, now);
		if (episodeAttempt.reasonCode !== null) {
			const result = unavailable(episodeAttempt.reasonCode, parentBefore.providerStatus);
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
			return unavailable("published_timestamp_changed", parentBefore.providerStatus);
		}
		if (now.getTime() - episodePublishedAt > options.maxAgeMs) {
			return unavailable("published_generation_stale", parentBefore.providerStatus);
		}
		const binding = validateExplicitStatusGenerationBinding(instance, before);
		if (binding) return unavailableForBinding(binding, before);
		const parentMetadata = decodePlexEpisodeGenerationMetadata(before.generationMetadata);
		if (!parentMetadata.ok) return unavailable("malformed_metadata", parentBefore.providerStatus);
		if (
			parentMetadata.parentGenerationId !== parentBefore.generationId ||
			parentMetadata.parentMetadataVersion !== parentBefore.metadata.version ||
			parentBefore.metadata.publicationLevel !== "authoritative" ||
			parentMetadata.connectionGeneration !== instance.connectionGeneration ||
			parentMetadata.identityGeneration !== instance.identityGeneration
		) {
			return unavailable("parent_generation_unavailable", parentBefore.providerStatus);
		}
		const rows = await listPlexEpisodeCacheRows(prisma, instance.id);
		if (rows.length !== before.itemCount)
			return unavailable("row_count_mismatch", parentBefore.providerStatus);
		if (
			rows.some(
				(row) =>
					row.instanceId !== instance.id ||
					row.connectionGeneration !== instance.connectionGeneration ||
					row.identityGeneration !== instance.identityGeneration,
			)
		) {
			return unavailable("connection_generation_mismatch", parentBefore.providerStatus);
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
			return unavailable("generation_changed", parentBefore.providerStatus);
		}
		const afterBinding = validateExplicitStatusGenerationBinding(instance, after);
		if (afterBinding) return unavailable(afterBinding, parentBefore.providerStatus);
		const parentAfter = await loadOwnedPublishedGenerationObservation(prisma, instance, options);
		if (
			!parentAfter.available ||
			!hasCurrentPlexMutationAuthority(parentAfter, options) ||
			parentAfter.generationId !== parentBefore.generationId
		) {
			return unavailable("parent_generation_unavailable", parentBefore.providerStatus);
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
			providerStatus: parentBefore.providerStatus,
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
		return unavailable(
			"query_failed",
			parentProviderStatus ?? projectPlexProviderObservationStatus({ status: null }),
		);
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
	let parentProviderStatus: ProviderObservationStatus | undefined;
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
		parentProviderStatus = parentBefore.providerStatus;
		if (!hasCurrentPlexMutationAuthority(parentBefore, options)) {
			return unavailableFromEvidence(parentBefore.evidence, parentBefore.providerStatus);
		}
		const before = await readPlexEpisodeGenerationStatus(prisma, instance.id);
		if (before?.lastResult !== "success")
			return unavailable("missing_status", parentBefore.providerStatus);
		if (!before.generationId?.trim())
			return unavailable("missing_generation_id", parentBefore.providerStatus);
		const episodePublishedAt = before.lastRefreshedAt.getTime();
		const now = options.now ?? new Date();
		const episodeAttempt = evaluatePlexLatestAttemptTrust(before, now);
		if (episodeAttempt.reasonCode !== null) {
			const result = unavailable(episodeAttempt.reasonCode, parentBefore.providerStatus);
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
			return unavailable("published_timestamp_changed", parentBefore.providerStatus);
		}
		if (now.getTime() - episodePublishedAt > options.maxAgeMs) {
			return unavailable("published_generation_stale", parentBefore.providerStatus);
		}
		const binding = validateExplicitStatusGenerationBinding(instance, before);
		if (binding) return unavailableForBinding(binding, before);
		const parentMetadata = decodePlexEpisodeGenerationMetadata(before.generationMetadata);
		if (!parentMetadata.ok) return unavailable("malformed_metadata", parentBefore.providerStatus);
		if (
			parentMetadata.parentGenerationId !== parentBefore.generationId ||
			parentMetadata.parentMetadataVersion !== parentBefore.metadata.version ||
			parentBefore.metadata.publicationLevel !== "authoritative" ||
			parentMetadata.connectionGeneration !== instance.connectionGeneration ||
			parentMetadata.identityGeneration !== instance.identityGeneration
		) {
			return unavailable("parent_generation_unavailable", parentBefore.providerStatus);
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
			return unavailable("row_count_mismatch", parentBefore.providerStatus);
		}
		if (
			rows.some(
				(row) =>
					row.instanceId !== instance.id ||
					row.connectionGeneration !== instance.connectionGeneration ||
					row.identityGeneration !== instance.identityGeneration,
			)
		) {
			return unavailable("connection_generation_mismatch", parentBefore.providerStatus);
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
			return unavailable("generation_changed", parentBefore.providerStatus);
		}
		const afterBinding = validateExplicitStatusGenerationBinding(instance, after);
		if (afterBinding) return unavailable(afterBinding, parentBefore.providerStatus);
		const parentAfter = await loadOwnedPublishedGenerationObservation(prisma, instance, options);
		if (
			!parentAfter.available ||
			!hasCurrentPlexMutationAuthority(parentAfter, options) ||
			parentAfter.generationId !== parentBefore.generationId
		) {
			return unavailable("parent_generation_unavailable", parentBefore.providerStatus);
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
			providerStatus: parentBefore.providerStatus,
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
		return unavailable(
			"query_failed",
			parentProviderStatus ?? projectPlexProviderObservationStatus({ status: null }),
		);
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
	let parentProviderStatus: ProviderObservationStatus | undefined;
	try {
		const parentBefore = await loadOwnedPublishedGenerationObservation(prisma, instance, options);
		if (!parentBefore.available) return unavailable("parent_generation_unavailable");
		parentProviderStatus = parentBefore.providerStatus;
		// Health observations retain validated last-known data during parent work.
		// The display reader preserves unavailable mutation authority and avoids
		// treating a positive envelope as malformed authoritative metadata.
		if (hasCurrentPositiveEpisodeReaderParentAuthority(parentBefore, true)) {
			const positive = await loadPositiveEpisodeDisplayEvidence(prisma, {
				...input,
				userId: instance.userId,
				instanceId: instance.id,
				instance,
			});
			if (!positive.available) return positive;
			return {
				available: true as const,
				instanceId: positive.instanceId,
				generationId: positive.generationId,
				parentGenerationId: positive.parentGenerationId,
				publishedAt: positive.publishedAt,
				itemCount: positive.metadata.itemCount,
				connectionGeneration: positive.connectionGeneration,
				identityGeneration: positive.identityGeneration,
				generationStatus: positive.generationStatus,
				providerStatus: positive.providerStatus,
				evidence: positive.evidence,
			};
		}
		const before = await readPlexEpisodeGenerationStatus(prisma, instance.id);
		if (before?.lastResult !== "success")
			return unavailable("missing_status", parentBefore.providerStatus);
		if (!before.generationId?.trim())
			return unavailable("missing_generation_id", parentBefore.providerStatus);
		const publishedAt = before.lastRefreshedAt.getTime();
		const now = options.now ?? new Date();
		const episodeAttempt = evaluatePlexLatestAttemptTrust(before, now);
		if (!Number.isFinite(publishedAt) || publishedAt > now.getTime()) {
			return unavailable("published_timestamp_changed", parentBefore.providerStatus);
		}
		if (now.getTime() - publishedAt > options.maxAgeMs) {
			return unavailable("published_generation_stale", parentBefore.providerStatus);
		}
		const binding = validateExplicitStatusGenerationBinding(instance, before);
		if (binding) return unavailableForBinding(binding, before);
		const parentMetadata = decodePlexEpisodeGenerationMetadata(before.generationMetadata);
		if (!parentMetadata.ok) return unavailable("malformed_metadata", parentBefore.providerStatus);
		if (
			parentMetadata.parentGenerationId !== parentBefore.generationId ||
			parentMetadata.parentMetadataVersion !== parentBefore.metadata.version ||
			parentBefore.metadata.publicationLevel !== "authoritative" ||
			parentMetadata.connectionGeneration !== instance.connectionGeneration ||
			parentMetadata.identityGeneration !== instance.identityGeneration
		) {
			return unavailable("parent_generation_unavailable", parentBefore.providerStatus);
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
			return unavailableAfterPublication(
				"row_count_mismatch",
				parentBefore.providerStatus,
				"rows-inconsistent",
			);
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
			return unavailableAfterPublication(
				"generation_changed",
				parentBefore.providerStatus,
				"rows-inconsistent",
			);
		}
		const afterBinding = validateExplicitStatusGenerationBinding(instance, after);
		if (afterBinding) return unavailableForBinding(afterBinding, after);
		const parentAfter = await loadOwnedPublishedGenerationObservation(prisma, instance, options);
		if (!parentAfter.available || parentAfter.evidence.availability === "last-known") {
			return unavailableFromEvidence(parentAfter.evidence, parentAfter.providerStatus);
		}
		if (
			parentAfter.generationId !== parentBefore.generationId ||
			parentAfter.evidence.availability !== parentBefore.evidence.availability ||
			parentAfter.evidence.authority !== parentBefore.evidence.authority ||
			parentAfter.evidence.attemptState !== parentBefore.evidence.attemptState ||
			parentAfter.evidence.reasonCodes.join("\u0000") !==
				parentBefore.evidence.reasonCodes.join("\u0000")
		) {
			return unavailableAfterPublication(
				"parent_generation_unavailable",
				parentAfter.providerStatus,
				"rows-inconsistent",
			);
		}
		const parentCurrent = hasCurrentPlexMutationAuthority(parentBefore, options);
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
			providerStatus: parentBefore.providerStatus,
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
		return parentProviderStatus
			? unavailableAfterPublication("query_failed", parentProviderStatus, "unknown-failure")
			: unavailable("query_failed");
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
