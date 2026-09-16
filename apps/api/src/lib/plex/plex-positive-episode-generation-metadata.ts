import { type ProviderCoverageReceiptV2, providerCoverageReceiptV2Schema } from "@arr/shared";
import { evaluateProviderCoverageReceipt } from "../provider-observation/coverage-receipt.js";

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

export type PlexPositiveEpisodeGenerationMetadataV4 = Omit<
	PlexPositiveEpisodeGenerationMetadataV3,
	"version" | "parentMetadataVersion"
> & {
	version: 4;
	parentMetadataVersion: 5;
};

/** Durable shard publication. V5 binds positive rows to either current V6 parent level. */
export type PlexPositiveEpisodeGenerationMetadataV5 = Omit<
	PlexPositiveEpisodeGenerationMetadataV3,
	"version" | "parentMetadataVersion" | "parentPublicationLevel"
> & {
	version: 5;
	parentMetadataVersion: 6;
	parentPublicationLevel: "authoritative" | "positive-only";
	coverageReceipt: ProviderCoverageReceiptV2;
};

export type PlexPositiveEpisodeGenerationMetadata =
	| PlexPositiveEpisodeGenerationMetadataV3
	| PlexPositiveEpisodeGenerationMetadataV4
	| PlexPositiveEpisodeGenerationMetadataV5;

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

/** V5 is a durable publication proof, not a shape-only receipt envelope. */
function decodeV5Receipt(value: unknown): ProviderCoverageReceiptV2 | null {
	const parsed = providerCoverageReceiptV2Schema.safeParse(value);
	if (!parsed.success) return null;
	const receipt = parsed.data;
	if (
		receipt.provider !== "plex_episode" ||
		receipt.evidence !== "positive-only" ||
		receipt.units.length < 1 ||
		receipt.publishedCanonicalEntities === undefined ||
		receipt.units.some(
			(unit) =>
				unit.expectedRawCount !== null ||
				unit.pagesAttempted < 1 ||
				unit.pagesCompleted !== unit.pagesAttempted ||
				unit.sourceBindings !== unit.rawObserved ||
				unit.canonicalEntities > unit.rawObserved ||
				unit.acceptedSkips.length !== 0 ||
				unit.fatalCount !== 0,
		) ||
		receipt.domains.length !== 2
	)
		return null;
	const evaluation = evaluateProviderCoverageReceipt(receipt);
	if (!evaluation.valid || evaluation.provider !== "plex_episode") return null;
	const canonicalUnits = JSON.stringify(receipt.units);
	const domains = new Set<string>();
	for (const domain of receipt.domains) {
		if (
			(domain.domain !== "episode-inventory" && domain.domain !== "watch-count") ||
			domains.has(domain.domain) ||
			domain.evidence !== "positive-only" ||
			domain.valueSemantics !== "lower-bound" ||
			domain.publishedCanonicalEntities !== receipt.publishedCanonicalEntities ||
			JSON.stringify(domain.units) !== canonicalUnits
		)
			return null;
		domains.add(domain.domain);
	}
	return domains.size === 2 ? receipt : null;
}

/**
 * Strictly decodes the positive-only episode envelope. It intentionally does
 * not share the authoritative V2 decoder: a V3 envelope grants only the named
 * lower-bound capability and existing exact readers must continue to reject it.
 */
export function decodePlexPositiveEpisodeGenerationMetadata(
	raw: string | null | undefined,
): { ok: true; metadata: PlexPositiveEpisodeGenerationMetadata } | { ok: false } {
	if (!raw) return { ok: false };
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			return { ok: false };
		const value = parsed as Record<string, unknown>;
		const v5 = value.version === 5;
		if (
			!hasExactKeys(
				value,
				v5
					? [
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
							"coverageReceipt",
							"connectionGeneration",
							"identityGeneration",
						]
					: [
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
						],
			) ||
			(value.version !== 3 && value.version !== 4 && value.version !== 5) ||
			value.publicationLevel !== "positive-only" ||
			value.completeness !== "partial" ||
			typeof value.itemCount !== "number" ||
			!Number.isSafeInteger(value.itemCount) ||
			value.itemCount < 0 ||
			value.canonicalizationVersion !== 1 ||
			!isNonemptyString(value.parentPlexGenerationId) ||
			value.parentMetadataVersion !== (value.version === 3 ? 4 : value.version === 4 ? 5 : 6) ||
			(!v5 && value.parentPublicationLevel !== "positive-only") ||
			(v5 &&
				value.parentPublicationLevel !== "positive-only" &&
				value.parentPublicationLevel !== "authoritative") ||
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
		const partialReasons =
			v5 && Array.isArray(value.partialReasons) && value.partialReasons.length === 0
				? []
				: decodePartialReasons(value.partialReasons);
		if (!partialReasons) return { ok: false };
		if (v5) {
			const receipt = decodeV5Receipt(value.coverageReceipt);
			if (!receipt) return { ok: false };
			return {
				ok: true,
				metadata: {
					version: 5,
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
					parentMetadataVersion: 6,
					parentPublicationLevel: value.parentPublicationLevel as "authoritative" | "positive-only",
					parentTargetDigest: value.parentTargetDigest,
					episodeDigest: value.episodeDigest,
					partialReasons,
					coverageReceipt: receipt,
					connectionGeneration: value.connectionGeneration,
					identityGeneration: value.identityGeneration,
				},
			};
		}
		const version = value.version as 3 | 4;
		const parentMetadataVersion = (version === 3 ? 4 : 5) as 4 | 5;
		return {
			ok: true,
			metadata: {
				version,
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
				parentMetadataVersion,
				parentPublicationLevel: "positive-only",
				parentTargetDigest: value.parentTargetDigest,
				episodeDigest: value.episodeDigest,
				partialReasons,
				connectionGeneration: value.connectionGeneration,
				identityGeneration: value.identityGeneration,
			} as PlexPositiveEpisodeGenerationMetadata,
		};
	} catch {
		return { ok: false };
	}
}

export function encodePlexPositiveEpisodeGenerationMetadata(
	metadata: PlexPositiveEpisodeGenerationMetadata,
): string {
	const encoded = JSON.stringify(metadata);
	if (!decodePlexPositiveEpisodeGenerationMetadata(encoded).ok) {
		throw new Error("Invalid positive-only Plex episode generation metadata");
	}
	return encoded;
}
