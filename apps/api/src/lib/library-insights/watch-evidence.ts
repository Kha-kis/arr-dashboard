import type {
	ProviderObservationSourceStatus,
	ProviderObservationStatusEnvelope,
} from "@arr/shared";
import {
	isArithmeticAuthoritativeProviderObservationStatus,
	type JellyfinDisplayInstance,
	readOwnedJellyfinLibraryDisplaySources,
} from "../jellyfin/jellyfin-display-evidence.js";
import type { JellyfinEvidencePrisma } from "../jellyfin/jellyfin-evidence-repository.js";

export type JellyfinInsightWatchRow = {
	tmdbId: number;
	mediaType: string;
	watchCount: number;
	lastWatchedAt: Date | null;
};

export type JellyfinInsightWatchEvidence = {
	configured: boolean;
	rows: JellyfinInsightWatchRow[];
	providerStatus: ProviderObservationStatusEnvelope | undefined;
	hasPositiveEvidence: boolean;
	negativeClaimsAuthoritative: boolean;
};

function isArithmeticSource(source: ProviderObservationSourceStatus): boolean {
	return isArithmeticAuthoritativeProviderObservationStatus({
		availability: source.status.availability,
		sources: [source],
	});
}

export async function readOwnedJellyfinInsightWatchEvidence({
	prisma,
	userId,
	instances,
}: {
	prisma: JellyfinEvidencePrisma;
	userId: string;
	instances: readonly JellyfinDisplayInstance[];
}): Promise<JellyfinInsightWatchEvidence> {
	if (instances.length === 0) {
		return {
			configured: false,
			rows: [],
			providerStatus: undefined,
			hasPositiveEvidence: false,
			negativeClaimsAuthoritative: false,
		};
	}

	const displayEvidence = await readOwnedJellyfinLibraryDisplaySources({
		prisma,
		userId,
		instances,
	});
	const providerStatus = displayEvidence.providerStatus;
	const sourceStatuses = providerStatus?.sources ?? [];
	const arithmeticSourceIds = new Set(
		sourceStatuses.filter(isArithmeticSource).map((source) => source.instanceId),
	);
	const configuredIds = new Set(instances.map((instance) => instance.id));
	const sourceIds = sourceStatuses.map((source) => source.instanceId);
	const exactCoverage =
		sourceIds.length === configuredIds.size &&
		new Set(sourceIds).size === configuredIds.size &&
		sourceIds.every((instanceId) => configuredIds.has(instanceId));
	const hasPositiveEvidence = arithmeticSourceIds.size > 0;
	const negativeClaimsAuthoritative =
		exactCoverage &&
		sourceStatuses.length > 0 &&
		sourceStatuses.every(
			({ status }) => status.availability === "current" && status.evidence === "complete",
		);

	return {
		configured: true,
		rows: displayEvidence.sources
			.filter((source) => arithmeticSourceIds.has(source.instanceId))
			.flatMap((source) =>
				source.rows.map(({ tmdbId, mediaType, watchCount, lastWatchedAt }) => ({
					tmdbId,
					mediaType,
					watchCount,
					lastWatchedAt,
				})),
			),
		providerStatus,
		hasPositiveEvidence,
		negativeClaimsAuthoritative,
	};
}
