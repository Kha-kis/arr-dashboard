import type { ProviderCoverageReceipt, ProviderCoverageReceiptV1 } from "@arr/shared";
import { evidenceFingerprint } from "../evidence-fingerprint.js";
import {
	evaluateProviderCoverageReceipt,
	evaluateProviderDomainCoverageMap,
} from "../provider-observation/coverage-receipt.js";
import {
	decodeJellyfinEpisodeCatalogProvenance,
	type JellyfinEpisodeCatalogProvenance,
} from "./jellyfin-episode-catalog-provenance.js";

interface JellyfinLibraryGenerationMetadataBaseV1 {
	version: 1;
	provider: "jellyfin" | "emby";
	cacheType: "jellyfin";
	canonicalizationVersion: 1;
	itemCount: number;
	connectionGeneration: number;
	identityGeneration: number;
	contentFingerprint: string;
	coverageReceipt: ProviderCoverageReceipt;
}

export interface JellyfinAuthoritativeLibraryGenerationMetadataV1
	extends JellyfinLibraryGenerationMetadataBaseV1 {
	publicationLevel: "authoritative";
	completeness: "complete";
}

export interface JellyfinPositiveOnlyLibraryGenerationMetadataV1
	extends JellyfinLibraryGenerationMetadataBaseV1 {
	publicationLevel: "positive-only";
	completeness: "partial";
}

export type JellyfinLibraryGenerationMetadataV1 =
	| JellyfinAuthoritativeLibraryGenerationMetadataV1
	| JellyfinPositiveOnlyLibraryGenerationMetadataV1;

interface JellyfinEpisodeGenerationMetadataBaseV1 {
	version: 1;
	provider: "jellyfin" | "emby";
	cacheType: "jellyfin_episode";
	publicationLevel: "authoritative" | "positive-only";
	completeness: "complete" | "partial";
	canonicalizationVersion: 1;
	itemCount: number;
	connectionGeneration: number;
	identityGeneration: number;
	parentLibraryGenerationId: string;
	parentLibraryMetadataFingerprint: string;
	contentFingerprint: string;
	coverageReceipt: ProviderCoverageReceipt;
}

export type JellyfinEpisodeGenerationMetadataV1 =
	| (JellyfinEpisodeGenerationMetadataBaseV1 & {
			publicationLevel: "authoritative";
			completeness: "complete";
	  })
	| (JellyfinEpisodeGenerationMetadataBaseV1 & {
			publicationLevel: "positive-only";
			completeness: "partial";
	  });

interface JellyfinEpisodeGenerationMetadataBaseV2 {
	version: 2;
	provider: "jellyfin" | "emby";
	cacheType: "jellyfin_episode";
	publicationLevel: "authoritative" | "positive-only";
	completeness: "complete" | "partial";
	canonicalizationVersion: 1;
	itemCount: number;
	connectionGeneration: number;
	identityGeneration: number;
	parentLibraryGenerationId: string;
	parentLibraryMetadataFingerprint: string;
	parentLibraryDependencyFingerprint: string;
	contentFingerprint: string;
	coverageReceipt: ProviderCoverageReceipt;
}

export type JellyfinEpisodeGenerationMetadataV2 =
	| (JellyfinEpisodeGenerationMetadataBaseV2 & {
			publicationLevel: "authoritative";
			completeness: "complete";
	  })
	| (JellyfinEpisodeGenerationMetadataBaseV2 & {
			publicationLevel: "positive-only";
			completeness: "partial";
	  });

interface JellyfinEpisodeGenerationMetadataBaseV3 {
	version: 3;
	provider: "jellyfin" | "emby";
	cacheType: "jellyfin_episode";
	publicationLevel: "positive-only";
	completeness: "partial";
	canonicalizationVersion: 1;
	itemCount: number;
	connectionGeneration: number;
	identityGeneration: number;
	parentLibraryGenerationId: string;
	parentLibraryMetadataFingerprint: string;
	parentLibraryDependencyFingerprint: string;
	catalogProvenance: JellyfinEpisodeCatalogProvenance;
	contentFingerprint: string;
	coverageReceipt: ProviderCoverageReceipt;
}

export type JellyfinEpisodeGenerationMetadataV3 = JellyfinEpisodeGenerationMetadataBaseV3;

export type JellyfinEpisodeGenerationMetadata =
	| JellyfinEpisodeGenerationMetadataV1
	| JellyfinEpisodeGenerationMetadataV2
	| JellyfinEpisodeGenerationMetadataV3;

export type JellyfinGenerationMetadataV1 =
	| JellyfinLibraryGenerationMetadataV1
	| JellyfinEpisodeGenerationMetadataV1;

export type JellyfinGenerationMetadata =
	| JellyfinLibraryGenerationMetadataV1
	| JellyfinEpisodeGenerationMetadata;

type MetadataDecodeResult<T> = { ok: true; metadata: T } | { ok: false };
type JellyfinProvider = "jellyfin" | "emby";
type JellyfinReceiptProvider = "jellyfin" | "jellyfin_episode" | "emby" | "emby_episode";
type JellyfinLibraryDiscriminator =
	| { publicationLevel: "authoritative"; completeness: "complete" }
	| { publicationLevel: "positive-only"; completeness: "partial" };

const INVALID_METADATA_ERROR = "Invalid Jellyfin generation metadata";
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

const LIBRARY_KEYS = [
	"version",
	"provider",
	"cacheType",
	"publicationLevel",
	"completeness",
	"canonicalizationVersion",
	"itemCount",
	"connectionGeneration",
	"identityGeneration",
	"contentFingerprint",
	"coverageReceipt",
] as const;

const EPISODE_KEYS = [
	"version",
	"provider",
	"cacheType",
	"publicationLevel",
	"completeness",
	"canonicalizationVersion",
	"itemCount",
	"connectionGeneration",
	"identityGeneration",
	"parentLibraryGenerationId",
	"parentLibraryMetadataFingerprint",
	"contentFingerprint",
	"coverageReceipt",
] as const;

const EPISODE_V2_KEYS = [
	"version",
	"provider",
	"cacheType",
	"publicationLevel",
	"completeness",
	"canonicalizationVersion",
	"itemCount",
	"connectionGeneration",
	"identityGeneration",
	"parentLibraryGenerationId",
	"parentLibraryMetadataFingerprint",
	"parentLibraryDependencyFingerprint",
	"contentFingerprint",
	"coverageReceipt",
] as const;

const EPISODE_V3_KEYS = [
	"version",
	"provider",
	"cacheType",
	"publicationLevel",
	"completeness",
	"canonicalizationVersion",
	"itemCount",
	"connectionGeneration",
	"identityGeneration",
	"parentLibraryGenerationId",
	"parentLibraryMetadataFingerprint",
	"parentLibraryDependencyFingerprint",
	"catalogProvenance",
	"contentFingerprint",
	"coverageReceipt",
] as const;

const LIBRARY_RECEIPT_DOMAINS = [
	"library-inventory",
	"mapping",
	"watch-count",
	"watch-attribution",
	"on-deck",
] as const;

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return (
		actual.length === sortedExpected.length &&
		actual.every((key, index) => key === sortedExpected[index])
	);
}

function parseObject(raw: unknown): Record<string, unknown> | null {
	if (typeof raw !== "string" || raw.trim() === "") return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

function hasUniqueV2DomainScopes(receipt: Record<string, unknown>): boolean {
	if (receipt.version !== 2 || !Array.isArray(receipt.domains) || receipt.domains.length !== 5) {
		return false;
	}
	const domainNames = new Set<string>();
	for (const rawDomain of receipt.domains) {
		if (typeof rawDomain !== "object" || rawDomain === null || Array.isArray(rawDomain)) {
			return false;
		}
		const domain = rawDomain as Record<string, unknown>;
		if (typeof domain.domain !== "string" || domainNames.has(domain.domain)) return false;
		domainNames.add(domain.domain);
		if (!Array.isArray(domain.units)) continue;
		const scopes = new Set<string>();
		for (const rawUnit of domain.units) {
			if (typeof rawUnit !== "object" || rawUnit === null || Array.isArray(rawUnit)) continue;
			const scopeKey = (rawUnit as Record<string, unknown>).scopeKey;
			if (typeof scopeKey === "string" && scopes.has(scopeKey)) return false;
			if (typeof scopeKey === "string") scopes.add(scopeKey);
		}
	}
	return true;
}

export function hasAuthoritativeJellyfinLibraryReceipt(receipt: ProviderCoverageReceipt): boolean {
	if (receipt.version !== 2 || receipt.evidence !== "complete") return false;
	const domains = evaluateProviderDomainCoverageMap(receipt);
	return LIBRARY_RECEIPT_DOMAINS.slice(0, 2).every((domain) => {
		const evaluation = domains.get(domain);
		return (
			evaluation?.availability === "current" &&
			evaluation.evidence === "complete" &&
			evaluation.valueSemantics === "exact"
		);
	});
}

/** Episode collection admits an exact inventory with a current mapped lower bound. */
export function hasJellyfinEpisodeParentReceipt(receipt: ProviderCoverageReceipt): boolean {
	const overall = evaluateProviderCoverageReceipt(receipt);
	if (!overall.valid) return false;
	if (receipt.version !== 2) return overall.complete && overall.evidence === "complete";
	const domains = evaluateProviderDomainCoverageMap(receipt);
	const inventory = domains.get("library-inventory");
	const mapping = domains.get("mapping");
	return (
		inventory?.availability === "current" &&
		inventory.evidence === "complete" &&
		inventory.valueSemantics === "exact" &&
		mapping?.availability === "current" &&
		((mapping.evidence === "complete" && mapping.valueSemantics === "exact") ||
			(mapping.evidence === "positive-only" && mapping.valueSemantics === "lower-bound"))
	);
}

function isSafeNonnegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFingerprint(value: unknown): value is string {
	return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}

function isProvider(value: unknown): value is JellyfinProvider {
	return value === "jellyfin" || value === "emby";
}

function expectedReceiptProvider(
	provider: JellyfinProvider,
	episode: boolean,
): JellyfinReceiptProvider {
	if (episode) return provider === "emby" ? "emby_episode" : "jellyfin_episode";
	return provider;
}

function decodeReceipt(
	value: unknown,
	provider: JellyfinProvider,
	episode: boolean,
	itemCount: number,
	requireComplete: boolean,
): ProviderCoverageReceipt | null {
	const evaluation = evaluateProviderCoverageReceipt(value);
	const receipt = value as ProviderCoverageReceipt;
	if (
		!evaluation.valid ||
		evaluation.provider !== expectedReceiptProvider(provider, episode) ||
		evaluation.publishedCanonicalEntities !== itemCount
	) {
		return null;
	}
	if (receipt.version === 2) {
		if (episode) {
			const domains = evaluateProviderDomainCoverageMap(receipt);
			if (domains.size !== 1 || !domains.has("episode-inventory")) return null;
			return requireComplete
				? evaluation.complete && evaluation.evidence === "complete"
					? receipt
					: null
				: evaluation.evidence === "positive-only" && !evaluation.complete
					? receipt
					: null;
		}
		if (!hasUniqueV2DomainScopes(receipt as unknown as Record<string, unknown>)) return null;
		const domains = evaluateProviderDomainCoverageMap(receipt);
		const expectedDomains = [
			"library-inventory",
			"mapping",
			"watch-count",
			"watch-attribution",
			"on-deck",
		] as const;
		if (
			domains.size !== expectedDomains.length ||
			!expectedDomains.every((domain) => domains.has(domain))
		) {
			return null;
		}
		const rawDomains = receipt.domains;
		for (const domain of rawDomains) {
			if (domain.domain === "mapping" && domain.publishedCanonicalEntities !== itemCount) {
				return null;
			}
		}
		if (requireComplete) {
			return evaluation.complete && evaluation.evidence === "complete"
				? receipt
				: hasAuthoritativeJellyfinLibraryReceipt(receipt)
					? receipt
					: null;
		}
		return evaluation.evidence === "positive-only" && !evaluation.complete ? receipt : null;
	}
	if (requireComplete) {
		return evaluation.complete && evaluation.evidence === "complete"
			? (receipt as ProviderCoverageReceiptV1)
			: null;
	}
	return evaluation.evidence === "positive-only" &&
		hasCompletePositiveCoverage(receipt as ProviderCoverageReceiptV1) &&
		hasConservedSources(receipt as ProviderCoverageReceiptV1)
		? (receipt as ProviderCoverageReceiptV1)
		: null;
}

function hasCompletePositiveCoverage(receipt: ProviderCoverageReceiptV1): boolean {
	return receipt.units.every(
		(unit) =>
			unit.pagesAttempted === unit.pagesCompleted &&
			unit.fatalCount === 0 &&
			(unit.expectedRawCount === null || unit.expectedRawCount === unit.rawObserved),
	);
}

function hasConservedSources(receipt: ProviderCoverageReceiptV1): boolean {
	return receipt.units.every((unit) => {
		const acceptedSkipCount = unit.acceptedSkips.reduce(
			(total, acceptedSkip) => total + acceptedSkip.count,
			0,
		);
		const sourceTotal = unit.sourceBindings + acceptedSkipCount;
		return (
			Number.isSafeInteger(acceptedSkipCount) &&
			Number.isSafeInteger(sourceTotal) &&
			sourceTotal === unit.rawObserved
		);
	});
}

function decodeBase(
	value: Record<string, unknown>,
	episode: boolean,
):
	| ({
			provider: JellyfinProvider;
			itemCount: number;
			version: 1 | 2 | 3;
	  } & JellyfinLibraryDiscriminator)
	| null {
	const expectedKeys = episode
		? value.version === 3
			? EPISODE_V3_KEYS
			: value.version === 2
				? EPISODE_V2_KEYS
				: EPISODE_KEYS
		: LIBRARY_KEYS;
	if (!hasExactKeys(value, expectedKeys)) return null;
	const validDiscriminator = episode
		? (value.publicationLevel === "authoritative" && value.completeness === "complete") ||
			(value.publicationLevel === "positive-only" && value.completeness === "partial")
		: (value.publicationLevel === "authoritative" && value.completeness === "complete") ||
			(value.publicationLevel === "positive-only" && value.completeness === "partial");
	if (
		(!episode && value.version !== 1) ||
		(episode && value.version !== 1 && value.version !== 2 && value.version !== 3) ||
		!isProvider(value.provider) ||
		value.cacheType !== (episode ? "jellyfin_episode" : "jellyfin") ||
		!validDiscriminator ||
		value.canonicalizationVersion !== 1 ||
		!isSafeNonnegativeInteger(value.itemCount) ||
		(!episode && value.publicationLevel === "positive-only" && value.itemCount === 0) ||
		!isSafeNonnegativeInteger(value.connectionGeneration) ||
		!isSafeNonnegativeInteger(value.identityGeneration) ||
		!isFingerprint(value.contentFingerprint)
	) {
		return null;
	}
	if (episode) {
		if (
			typeof value.parentLibraryGenerationId !== "string" ||
			value.parentLibraryGenerationId.trim() === "" ||
			value.parentLibraryGenerationId.includes("\0") ||
			value.parentLibraryGenerationId.length > 500 ||
			!isFingerprint(value.parentLibraryMetadataFingerprint) ||
			((value.version === 2 || value.version === 3) &&
				!isFingerprint(value.parentLibraryDependencyFingerprint))
		) {
			return null;
		}
	}
	return {
		version: value.version as 1 | 2 | 3,
		provider: value.provider,
		itemCount: value.itemCount,
		publicationLevel: value.publicationLevel,
		completeness: value.completeness,
	} as {
		provider: JellyfinProvider;
		itemCount: number;
		version: 1 | 2 | 3;
	} & JellyfinLibraryDiscriminator;
}

export function decodeJellyfinLibraryGenerationMetadata(
	raw: unknown,
): MetadataDecodeResult<JellyfinLibraryGenerationMetadataV1> {
	const value = parseObject(raw);
	if (!value) return { ok: false };
	const base = decodeBase(value, false);
	if (!base) return { ok: false };
	const coverageReceipt = decodeReceipt(
		value.coverageReceipt,
		base.provider,
		false,
		base.itemCount,
		base.publicationLevel === "authoritative",
	);
	if (!coverageReceipt) return { ok: false };
	return {
		ok: true,
		metadata: { ...value, coverageReceipt } as JellyfinLibraryGenerationMetadataV1,
	};
}

export function decodeJellyfinEpisodeGenerationMetadata(
	raw: unknown,
): MetadataDecodeResult<JellyfinEpisodeGenerationMetadata> {
	const value = parseObject(raw);
	if (!value) return { ok: false };
	const base = decodeBase(value, true);
	if (!base) return { ok: false };
	const coverageReceipt = decodeReceipt(
		value.coverageReceipt,
		base.provider,
		true,
		base.itemCount,
		base.publicationLevel === "authoritative",
	);
	if (!coverageReceipt) return { ok: false };
	if (base.version === 3) {
		if (base.publicationLevel !== "positive-only" || base.completeness !== "partial")
			return { ok: false };
		const catalogProvenance = decodeJellyfinEpisodeCatalogProvenance(value.catalogProvenance);
		if (!catalogProvenance) return { ok: false };
		return {
			ok: true,
			metadata: {
				...value,
				coverageReceipt,
				catalogProvenance,
			} as JellyfinEpisodeGenerationMetadataV3,
		};
	}
	return {
		ok: true,
		metadata: { ...value, coverageReceipt } as JellyfinEpisodeGenerationMetadata,
	};
}

export function encodeJellyfinLibraryGenerationMetadata(metadata: unknown): string {
	try {
		const encoded = JSON.stringify(metadata);
		if (!encoded || !decodeJellyfinLibraryGenerationMetadata(encoded).ok) {
			throw new Error(INVALID_METADATA_ERROR);
		}
		return encoded;
	} catch {
		throw new Error(INVALID_METADATA_ERROR);
	}
}

export function encodeJellyfinEpisodeGenerationMetadata(metadata: unknown): string {
	try {
		const encoded = JSON.stringify(metadata);
		if (!encoded || !decodeJellyfinEpisodeGenerationMetadata(encoded).ok) {
			throw new Error(INVALID_METADATA_ERROR);
		}
		return encoded;
	} catch {
		throw new Error(INVALID_METADATA_ERROR);
	}
}

export function fingerprintJellyfinLibraryGenerationMetadata(
	metadata: JellyfinLibraryGenerationMetadataV1,
): string {
	return evidenceFingerprint(metadata);
}

/**
 * Fingerprints the persisted semantic fields of a library cache generation.
 * Database identity, service instance ownership, and generation columns are
 * intentionally excluded so staged collection rows and database rows share
 * the same content identity.
 */
export interface JellyfinLibraryRowFingerprintInput {
	/** Optional database-only fields; all are deliberately excluded. */
	id?: string;
	/** Optional persisted ownership field; it is deliberately not projected. */
	instanceId?: string;
	connectionGeneration?: number | null;
	identityGeneration?: number | null;
	tmdbId: number;
	mediaType: "movie" | "series";
	libraryId: string;
	libraryName: string;
	title: string;
	jellyfinId: string | null;
	lastWatchedAt: Date | string | null;
	watchCount: number;
	watchedByUsers: string;
	onDeck: boolean;
	userRating: number | null;
	collections: string;
	addedAt: Date | string | null;
	thumb: string | null;
}

type CanonicalJellyfinLibraryRow = Omit<
	JellyfinLibraryRowFingerprintInput,
	"lastWatchedAt" | "addedAt"
> & {
	lastWatchedAt: string | null;
	addedAt: string | null;
};

function canonicalDate(value: Date | string | null): string | null {
	return value instanceof Date ? value.toISOString() : value;
}

function projectJellyfinLibraryRow(
	row: JellyfinLibraryRowFingerprintInput,
): CanonicalJellyfinLibraryRow {
	return {
		tmdbId: row.tmdbId,
		mediaType: row.mediaType,
		libraryId: row.libraryId,
		libraryName: row.libraryName,
		title: row.title,
		jellyfinId: row.jellyfinId,
		lastWatchedAt: canonicalDate(row.lastWatchedAt),
		watchCount: row.watchCount,
		watchedByUsers: row.watchedByUsers,
		onDeck: row.onDeck,
		userRating: row.userRating,
		collections: row.collections,
		addedAt: canonicalDate(row.addedAt),
		thumb: row.thumb,
	};
}

export function fingerprintJellyfinLibraryRows(
	rows: readonly JellyfinLibraryRowFingerprintInput[],
): string {
	const projected = rows.map(projectJellyfinLibraryRow);
	const decorated = projected.map((row) => ({ row, tieBreaker: evidenceFingerprint(row) }));
	decorated.sort(
		(left, right) =>
			left.row.mediaType.localeCompare(right.row.mediaType) ||
			left.row.tmdbId - right.row.tmdbId ||
			left.row.libraryId.localeCompare(right.row.libraryId) ||
			left.tieBreaker.localeCompare(right.tieBreaker),
	);
	return evidenceFingerprint(decorated.map(({ row }) => row));
}

export interface JellyfinEpisodeRowFingerprintInput {
	/** Optional database-only fields; all are deliberately excluded. */
	id?: string;
	instanceId?: string;
	connectionGeneration?: number | null;
	identityGeneration?: number | null;
	showTmdbId: number;
	seasonNumber: number;
	episodeNumber: number;
	jellyfinId: string;
	title: string;
	watched: boolean;
	watchedByUsers: string;
	lastWatchedAt: Date | string | null;
}

type CanonicalJellyfinEpisodeRow = Omit<
	JellyfinEpisodeRowFingerprintInput,
	"watchedByUsers" | "lastWatchedAt"
> & {
	watchedByUsers: string;
	lastWatchedAt: string | null;
};

function canonicalWatchedByUsers(value: string): string {
	try {
		const parsed: unknown = JSON.parse(value);
		if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
			return JSON.stringify([...new Set(parsed)].sort());
		}
	} catch {
		// Preserve malformed legacy values as distinct evidence.
	}
	return value;
}

function canonicalEpisodeDate(value: Date | string | null): string | null {
	if (value === null) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isFinite(date.getTime())
		? date.toISOString()
		: value instanceof Date
			? null
			: value;
}

function projectJellyfinEpisodeRow(
	row: JellyfinEpisodeRowFingerprintInput,
): CanonicalJellyfinEpisodeRow {
	return {
		showTmdbId: row.showTmdbId,
		seasonNumber: row.seasonNumber,
		episodeNumber: row.episodeNumber,
		jellyfinId: row.jellyfinId,
		title: row.title,
		watched: row.watched,
		watchedByUsers: canonicalWatchedByUsers(row.watchedByUsers),
		lastWatchedAt: canonicalEpisodeDate(row.lastWatchedAt),
	};
}

export function fingerprintJellyfinEpisodeRows(
	rows: readonly JellyfinEpisodeRowFingerprintInput[],
): string {
	const projected = rows.map(projectJellyfinEpisodeRow);
	const decorated = projected.map((row) => ({ row, tieBreaker: evidenceFingerprint(row) }));
	decorated.sort(
		(left, right) =>
			left.row.showTmdbId - right.row.showTmdbId ||
			left.row.seasonNumber - right.row.seasonNumber ||
			left.row.episodeNumber - right.row.episodeNumber ||
			left.tieBreaker.localeCompare(right.tieBreaker),
	);
	return evidenceFingerprint(decorated.map(({ row }) => row));
}
