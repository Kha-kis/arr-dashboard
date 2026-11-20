import {
	decodePlexGenerationMetadata,
	evaluatePublishedPlexGeneration,
	type PlexGenerationMetadataV6,
} from "./plex-generation-metadata.js";
import {
	type PlexGenerationTarget,
	verifyPlexGenerationTargetIntegrity,
} from "./plex-generation-target-ledger.js";

/** One publication's verification data, replaced atomically with its episode rows. */
export type PlexPositiveEpisodeParentProof = {
	instanceId: string;
	generationId: string;
	connectionGeneration: number;
	identityGeneration: number;
	providerIdentity: string;
	sourceFingerprint: string;
	publishedAt: string;
	attemptedAt: string;
	attemptResult: "success" | "partial";
	itemCount: number;
	metadata: PlexGenerationMetadataV6;
	targets: PlexGenerationTarget[];
};

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "" && !value.includes("\0");
}

function iso(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const time = Date.parse(value);
	return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** Decode and recompute the archived parent binding; a digest alone is insufficient. */
export function decodePlexPositiveEpisodeParentProof(
	value: unknown,
): PlexPositiveEpisodeParentProof | null {
	try {
		if (
			!exact(value, [
				"instanceId",
				"generationId",
				"connectionGeneration",
				"identityGeneration",
				"providerIdentity",
				"sourceFingerprint",
				"publishedAt",
				"attemptedAt",
				"attemptResult",
				"itemCount",
				"metadata",
				"targets",
			]) ||
			!nonempty(value.instanceId) ||
			!nonempty(value.generationId) ||
			!nonempty(value.providerIdentity) ||
			typeof value.sourceFingerprint !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.sourceFingerprint) ||
			!Number.isSafeInteger(value.connectionGeneration) ||
			(value.connectionGeneration as number) < 0 ||
			!Number.isSafeInteger(value.identityGeneration) ||
			(value.identityGeneration as number) <= 0 ||
			!Number.isSafeInteger(value.itemCount) ||
			(value.itemCount as number) < 0 ||
			!iso(value.publishedAt) ||
			!iso(value.attemptedAt) ||
			(value.attemptResult !== "success" && value.attemptResult !== "partial") ||
			Date.parse(value.attemptedAt) !== Date.parse(value.publishedAt) ||
			!Array.isArray(value.targets) ||
			value.targets.some(
				(target) =>
					!exact(target, [
						"instanceId",
						"generationId",
						"sectionId",
						"sectionUuid",
						"mediaType",
						"tmdbId",
						"tvdbId",
						"ratingKey",
					]),
			)
		)
			return null;
		const decoded = decodePlexGenerationMetadata(JSON.stringify(value.metadata));
		if (
			!decoded.ok ||
			decoded.metadata.version !== 6 ||
			(decoded.metadata.publicationLevel === "positive-only" &&
				decoded.metadata.ambiguousTmdbCandidates === null)
		)
			return null;
		const metadata = decoded.metadata;
		const published = evaluatePublishedPlexGeneration(
			{
				generationId: value.generationId,
				generationMetadata: JSON.stringify(metadata),
				lastResult: "success",
				lastRefreshedAt: new Date(value.publishedAt),
				lastErrorMessage: null,
				lastAttemptAt: new Date(value.attemptedAt),
				lastAttemptResult: value.attemptResult,
				lastAttemptErrorMessage: null,
				itemCount: value.itemCount as number,
			},
			{ now: new Date(value.publishedAt) },
		);
		if (
			!published.available ||
			published.evidence.availability !== "current" ||
			published.evidence.authority !== metadata.publicationLevel
		)
			return null;
		const verified = verifyPlexGenerationTargetIntegrity({
			targets: value.targets,
			expected: {
				instanceId: value.instanceId,
				generationId: value.generationId,
				connectionGeneration: value.connectionGeneration as number,
				identityGeneration: value.identityGeneration as number,
				targetLedgerVersion: 1,
				targetCount: metadata.targetCount,
				targetDigest: metadata.targetDigest,
			},
			sections: metadata.sections,
		});
		if (!verified.ok) return null;
		return { ...value, metadata, targets: verified.targets } as PlexPositiveEpisodeParentProof;
	} catch {
		return null;
	}
}

/** A display proof cannot renew either the parent or episode observation's age. */
export function isCurrentPlexPositiveEpisodeParentProof(
	proof: PlexPositiveEpisodeParentProof,
	input: {
		instanceId: string;
		connectionGeneration: number;
		identityGeneration: number;
		providerIdentity: string | null;
		sourceFingerprint: string | null;
		episodePublishedAt: Date;
		now: Date;
		maxAgeMs: number;
	},
): boolean {
	const parentTime = Date.parse(proof.publishedAt),
		episodeTime = input.episodePublishedAt.getTime(),
		now = input.now.getTime();
	return (
		proof.instanceId === input.instanceId &&
		proof.connectionGeneration === input.connectionGeneration &&
		proof.identityGeneration === input.identityGeneration &&
		proof.providerIdentity === input.providerIdentity &&
		proof.sourceFingerprint === input.sourceFingerprint &&
		Number.isFinite(now) &&
		Number.isFinite(episodeTime) &&
		parentTime <= episodeTime &&
		episodeTime <= now &&
		now - parentTime <= input.maxAgeMs &&
		now - episodeTime <= input.maxAgeMs
	);
}
