import type { Prisma } from "../prisma.js";
import type { PlexCacheRefreshAttempt } from "../services/provider-cache-status.js";
import type { OwnedProviderPublicationSnapshot } from "../services/provider-identity-guard.js";
import { hasSamePersistedPlexCacheRows } from "./plex-cache-storage.js";
import { decodePlexGenerationMetadata } from "./plex-generation-metadata.js";
import {
	type PlexGenerationTarget,
	type PlexTargetLedgerBinding,
	readPlexGenerationTargetsForReuse,
	samePlexGenerationTargetSet,
	verifyPlexGenerationTargetIntegrity,
} from "./plex-generation-target-ledger.js";

export type PlexGenerationPublication = {
	generationId: string;
	targets: PlexGenerationTarget[];
	targetLedger: PlexTargetLedgerBinding;
	generationMetadata: string;
};

function comparableMetadata(raw: string): string {
	const metadata = JSON.parse(raw);
	delete metadata.coverageReceipt.attemptStartedAt;
	delete metadata.coverageReceipt.observedAt;
	// Object property order is not a semantic difference. Array contents/order are retained.
	return JSON.stringify(metadata, (_key, value) =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(
					Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
				)
			: value,
	);
}

/**
 * Optimization only, called inside the existing owned publication transaction.
 * The surrounding identity guard owns the current owner/connection predicate;
 * storage still owns the attempt CAS and atomic replacement, even on reuse.
 * Any incomplete old proof takes the normal fresh-generation publication path.
 */
export async function findReusablePlexGeneration(
	tx: Prisma.TransactionClient,
	input: {
		instance: OwnedProviderPublicationSnapshot;
		attempt: PlexCacheRefreshAttempt;
		rows: readonly Prisma.PlexCacheCreateManyInput[];
		publication: (generationId: string) => PlexGenerationPublication;
	},
): Promise<PlexGenerationPublication | null> {
	try {
		const { instance, attempt, rows } = input;
		const prior = await tx.cacheRefreshStatus.findUnique({
			where: { instanceId_cacheType: { instanceId: instance.id, cacheType: "plex" } },
		});
		if (
			!prior ||
			prior.instanceId !== instance.id ||
			prior.cacheType !== "plex" ||
			prior.lastResult !== "success" ||
			prior.lastErrorMessage !== null ||
			!prior.generationId?.trim() ||
			prior.generationId.includes("\0") ||
			prior.connectionGeneration !== instance.connectionGeneration ||
			prior.identityGeneration !== instance.identityGeneration ||
			prior.lastAttemptAt?.getTime() !== attempt.attemptedAt.getTime() ||
			prior.lastAttemptResult !== attempt.resultMarker ||
			prior.lastAttemptErrorMessage !== null ||
			prior.itemCount !== rows.length ||
			!Number.isFinite(prior.lastRefreshedAt.getTime()) ||
			prior.lastRefreshedAt.getTime() > attempt.attemptedAt.getTime()
		)
			return null;
		const decoded = decodePlexGenerationMetadata(prior.generationMetadata);
		if (
			!decoded.ok ||
			decoded.metadata.version !== 6 ||
			decoded.metadata.itemCount !== rows.length ||
			decoded.metadata.coverageReceipt.observedAt !== prior.lastRefreshedAt.toISOString()
		)
			return null;
		// The digest binds generationId: encode this fresh observation using the
		// proposed old id before comparing, never compare two unrelated digests.
		const candidate = input.publication(prior.generationId);
		const fresh = decodePlexGenerationMetadata(candidate.generationMetadata);
		if (
			!fresh.ok ||
			fresh.metadata.version !== 6 ||
			comparableMetadata(prior.generationMetadata!) !==
				comparableMetadata(candidate.generationMetadata)
		)
			return null;
		const targets = await readPlexGenerationTargetsForReuse(
			tx,
			instance.id,
			candidate.targets.length,
		);
		if (targets === null) return null;
		const integrity = verifyPlexGenerationTargetIntegrity({
			targets,
			expected: {
				...decoded.metadata,
				instanceId: instance.id,
				generationId: prior.generationId,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
			},
			sections: decoded.metadata.sections,
		});
		if (!integrity.ok || !samePlexGenerationTargetSet(integrity.targets, candidate.targets))
			return null;
		return (await hasSamePersistedPlexCacheRows(tx, instance.id, rows)) ? candidate : null;
	} catch {
		return null;
	}
}
