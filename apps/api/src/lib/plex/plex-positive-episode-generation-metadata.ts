const POSITIVE_EPISODE_PARTIAL_REASON_CODES = [
	"ambiguous_episode_parent_targets",
	"currentItemsWithoutTmdbMetadata",
	"currentLibraryItemsWithoutRatingKeys",
	"currentHistoryItemsWithoutMappedMetadata",
	"historyItemsWithoutUsableMediaKey",
	"historyItemsWithUnknownAccounts",
	"onDeckFetchFailures",
	"onDeckItemsWithoutMappedMetadata",
] as const;

const allowedReasonCodes = new Set<string>(POSITIVE_EPISODE_PARTIAL_REASON_CODES);

export type PlexPositiveEpisodePartialReason = {
	code: (typeof POSITIVE_EPISODE_PARTIAL_REASON_CODES)[number];
	count: number;
};

export type PlexPositiveEpisodeGenerationMetadataV3 = {
	version: 3;
	publicationLevel: "positive-only";
	completeness: "partial";
	itemCount: number;
	canonicalizationVersion: 1;
	capability: {
		domain: "episodes";
		field: "watchCount";
		semantics: "lower-bound";
		operator: "greater_than";
	};
	parentPlexGenerationId: string;
	parentMetadataVersion: 4;
	parentPublicationLevel: "positive-only";
	parentTargetDigest: string;
	episodeDigest: string;
	partialReasons: readonly PlexPositiveEpisodePartialReason[];
	connectionGeneration: number;
	identityGeneration: number;
};

function isNonemptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "" && !value.includes("\0");
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function decodePartialReasons(value: unknown): PlexPositiveEpisodePartialReason[] | null {
	if (
		!Array.isArray(value) ||
		value.length < 1 ||
		value.length > POSITIVE_EPISODE_PARTIAL_REASON_CODES.length
	)
		return null;
	const reasons: PlexPositiveEpisodePartialReason[] = [];
	let previous = "";
	for (const rawReason of value) {
		if (typeof rawReason !== "object" || rawReason === null || Array.isArray(rawReason))
			return null;
		const reason = rawReason as Record<string, unknown>;
		if (
			!hasExactKeys(reason, ["code", "count"]) ||
			typeof reason.code !== "string" ||
			!allowedReasonCodes.has(reason.code) ||
			typeof reason.count !== "number" ||
			!Number.isSafeInteger(reason.count) ||
			reason.count < 1 ||
			reason.code <= previous
		) {
			return null;
		}
		previous = reason.code;
		reasons.push({
			code: reason.code as PlexPositiveEpisodePartialReason["code"],
			count: reason.count,
		});
	}
	return reasons;
}

/**
 * Strictly decodes the positive-only episode envelope. It intentionally does
 * not share the authoritative V2 decoder: a V3 envelope grants only the named
 * lower-bound capability and existing exact readers must continue to reject it.
 */
export function decodePlexPositiveEpisodeGenerationMetadata(
	raw: string | null | undefined,
): { ok: true; metadata: PlexPositiveEpisodeGenerationMetadataV3 } | { ok: false } {
	if (!raw) return { ok: false };
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			return { ok: false };
		const value = parsed as Record<string, unknown>;
		if (
			!hasExactKeys(value, [
				"version",
				"publicationLevel",
				"completeness",
				"itemCount",
				"canonicalizationVersion",
				"capability",
				"parentPlexGenerationId",
				"parentMetadataVersion",
				"parentPublicationLevel",
				"parentTargetDigest",
				"episodeDigest",
				"partialReasons",
				"connectionGeneration",
				"identityGeneration",
			]) ||
			value.version !== 3 ||
			value.publicationLevel !== "positive-only" ||
			value.completeness !== "partial" ||
			typeof value.itemCount !== "number" ||
			!Number.isSafeInteger(value.itemCount) ||
			value.itemCount < 0 ||
			value.canonicalizationVersion !== 1 ||
			!isNonemptyString(value.parentPlexGenerationId) ||
			value.parentMetadataVersion !== 4 ||
			value.parentPublicationLevel !== "positive-only" ||
			typeof value.parentTargetDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.parentTargetDigest) ||
			typeof value.episodeDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.episodeDigest) ||
			typeof value.connectionGeneration !== "number" ||
			!Number.isSafeInteger(value.connectionGeneration) ||
			value.connectionGeneration < 0 ||
			typeof value.identityGeneration !== "number" ||
			!Number.isSafeInteger(value.identityGeneration) ||
			value.identityGeneration <= 0 ||
			typeof value.capability !== "object" ||
			value.capability === null ||
			Array.isArray(value.capability)
		) {
			return { ok: false };
		}
		const capability = value.capability as Record<string, unknown>;
		if (
			!hasExactKeys(capability, ["domain", "field", "semantics", "operator"]) ||
			capability.domain !== "episodes" ||
			capability.field !== "watchCount" ||
			capability.semantics !== "lower-bound" ||
			capability.operator !== "greater_than"
		) {
			return { ok: false };
		}
		const partialReasons = decodePartialReasons(value.partialReasons);
		if (!partialReasons) return { ok: false };
		return {
			ok: true,
			metadata: {
				version: 3,
				publicationLevel: "positive-only",
				completeness: "partial",
				itemCount: value.itemCount,
				canonicalizationVersion: 1,
				capability: {
					domain: "episodes",
					field: "watchCount",
					semantics: "lower-bound",
					operator: "greater_than",
				},
				parentPlexGenerationId: value.parentPlexGenerationId,
				parentMetadataVersion: 4,
				parentPublicationLevel: "positive-only",
				parentTargetDigest: value.parentTargetDigest,
				episodeDigest: value.episodeDigest,
				partialReasons,
				connectionGeneration: value.connectionGeneration,
				identityGeneration: value.identityGeneration,
			},
		};
	} catch {
		return { ok: false };
	}
}

export function encodePlexPositiveEpisodeGenerationMetadata(
	metadata: PlexPositiveEpisodeGenerationMetadataV3,
): string {
	const encoded = JSON.stringify(metadata);
	if (!decodePlexPositiveEpisodeGenerationMetadata(encoded).ok) {
		throw new Error("Invalid positive-only Plex episode generation metadata");
	}
	return encoded;
}
