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
import { authorizeProviderEvidenceUse } from "../provider-observation/evidence-capabilities.js";
import { projectWatchDisplayEvidence } from "../provider-observation/watch-display-evidence.js";

export type JellyfinInsightWatchRow = {
	tmdbId: number;
	mediaType: string;
	watchCount: number;
	watchCountSemantics?: "exact" | "lower-bound";
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
	const rows: JellyfinInsightWatchRow[] = displayEvidence.sources.flatMap((source) => {
		if (!configuredIds.has(source.instanceId)) return [];
		if (arithmeticSourceIds.has(source.instanceId)) {
			return source.rows.map(({ tmdbId, mediaType, watchCount, lastWatchedAt }) => ({
				tmdbId,
				mediaType,
				watchCount,
				lastWatchedAt,
			}));
		}
		const statuses = sourceStatuses.filter((entry) => entry.instanceId === source.instanceId);
		if (statuses.length !== 1) return [];
		const status = statuses[0]!.status;
		return source.rows.flatMap((row) => {
			const display = projectWatchDisplayEvidence({ status, row });
			if (display.watchCount === null || display.watchCountSemantics === "unknown") return [];
			const decision = authorizeProviderEvidenceUse(status, {
				domain: "watch-count",
				use: "positive-predicate",
				field: "watch-count",
				operator: "greater_than",
				threshold: 0,
				observedValue: display.watchCount,
				targetObserved: true,
			});
			return decision.authorized
				? [
						{
							tmdbId: row.tmdbId,
							mediaType: row.mediaType,
							watchCount: display.watchCount,
							watchCountSemantics: display.watchCountSemantics,
							lastWatchedAt: display.lastWatchedAt ? new Date(display.lastWatchedAt) : null,
						},
					]
				: [];
		});
	});
	const hasPositiveEvidence = arithmeticSourceIds.size > 0 || rows.length > 0;
	const negativeClaimsAuthoritative =
		exactCoverage &&
		sourceStatuses.length > 0 &&
		sourceStatuses.every(
			({ status }) => status.availability === "current" && status.evidence === "complete",
		);

	return {
		configured: true,
		rows,
		providerStatus,
		hasPositiveEvidence,
		negativeClaimsAuthoritative,
	};
}
