import type { ProviderCoverageReceiptV1, ProviderCoverageReceiptV2 } from "@arr/shared";
import { evidenceFingerprint } from "../evidence-fingerprint.js";
import type { JellyfinLibraryRowFingerprintInput } from "./jellyfin-generation-metadata.js";
import {
	decodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
	hasJellyfinEpisodeParentReceipt,
	type JellyfinLibraryGenerationMetadataV1,
} from "./jellyfin-generation-metadata.js";

type CoverageUnit = ProviderCoverageReceiptV1["units"][number];
export const JELLYFIN_EPISODE_PARENT_KEY_PREFIX = "jellyfin-episode-parent-v2:";

export function jellyfinEpisodeParentGenerationKey(dependencyFingerprint: string): string {
	if (!/^[a-f0-9]{64}$/.test(dependencyFingerprint)) {
		throw new Error("Invalid Jellyfin episode parent dependency fingerprint");
	}
	return `${JELLYFIN_EPISODE_PARENT_KEY_PREFIX}${dependencyFingerprint}`;
}

function validDate(value: unknown): boolean {
	if (value === null) return true;
	if (value instanceof Date) return Number.isFinite(value.getTime());
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validJsonStringArray(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string");
	} catch {
		return false;
	}
}

function validParentRow(
	instanceId: string,
	metadata: JellyfinLibraryGenerationMetadataV1,
	row: JellyfinLibraryRowFingerprintInput,
): boolean {
	return (
		typeof row.id === "string" &&
		row.id.trim() !== "" &&
		row.instanceId === instanceId &&
		Number.isSafeInteger(row.tmdbId) &&
		row.tmdbId > 0 &&
		(row.mediaType === "movie" || row.mediaType === "series") &&
		typeof row.libraryId === "string" &&
		row.libraryId.trim() !== "" &&
		typeof row.libraryName === "string" &&
		typeof row.title === "string" &&
		(row.jellyfinId === null || typeof row.jellyfinId === "string") &&
		Number.isSafeInteger(row.watchCount) &&
		row.watchCount >= 0 &&
		validJsonStringArray(row.watchedByUsers) &&
		typeof row.onDeck === "boolean" &&
		(row.userRating === null ||
			(typeof row.userRating === "number" && Number.isFinite(row.userRating))) &&
		validJsonStringArray(row.collections) &&
		validDate(row.lastWatchedAt) &&
		validDate(row.addedAt) &&
		(row.thumb === null || typeof row.thumb === "string") &&
		row.connectionGeneration === metadata.connectionGeneration &&
		row.identityGeneration === metadata.identityGeneration
	);
}

function projectCoverageUnit(unit: CoverageUnit) {
	return {
		scopeKey: unit.scopeKey,
		expectedRawCount: unit.expectedRawCount,
		rawObserved: unit.rawObserved,
		sourceBindings: unit.sourceBindings,
		canonicalEntities: unit.canonicalEntities,
		acceptedSkips: [...unit.acceptedSkips].sort((left, right) =>
			left.reason.localeCompare(right.reason),
		),
		fatalCount: unit.fatalCount,
	};
}

function projectLegacyCoverage(receipt: ProviderCoverageReceiptV1) {
	return {
		version: 1,
		evidence: receipt.evidence,
		publishedCanonicalEntities: receipt.publishedCanonicalEntities ?? null,
		units: [...receipt.units]
			.sort((left, right) => left.scopeKey.localeCompare(right.scopeKey))
			.map(projectCoverageUnit),
	};
}

function projectV2Coverage(receipt: ProviderCoverageReceiptV2) {
	return {
		version: 2,
		domains: receipt.domains
			.filter((domain) => domain.domain === "library-inventory" || domain.domain === "mapping")
			.sort((left, right) => left.domain.localeCompare(right.domain))
			.map((domain) => ({
				domain: domain.domain,
				evidence: domain.evidence,
				valueSemantics: domain.valueSemantics,
				publishedCanonicalEntities: domain.publishedCanonicalEntities ?? null,
				units: [...domain.units]
					.sort((left, right) => left.scopeKey.localeCompare(right.scopeKey))
					.map(projectCoverageUnit),
			})),
	};
}

function decodeLibraryMetadata(input: unknown): JellyfinLibraryGenerationMetadataV1 | null {
	const raw =
		typeof input === "string"
			? input
			: (() => {
					try {
						return JSON.stringify(input);
					} catch {
						return undefined;
					}
				})();
	if (raw === undefined) return null;
	const decoded = decodeJellyfinLibraryGenerationMetadata(raw);
	return decoded.ok ? decoded.metadata : null;
}

export function fingerprintJellyfinEpisodeParentDependency(
	instanceId: string,
	metadataInput: unknown,
	rows: readonly JellyfinLibraryRowFingerprintInput[],
): string | null {
	try {
		if (typeof instanceId !== "string" || instanceId.trim() === "") return null;
		const metadata = decodeLibraryMetadata(metadataInput);
		if (!metadata || !hasJellyfinEpisodeParentReceipt(metadata.coverageReceipt)) return null;
		if (metadata.itemCount !== rows.length) return null;
		if (rows.some((row) => !validParentRow(instanceId, metadata, row))) return null;
		if (fingerprintJellyfinLibraryRows(rows) !== metadata.contentFingerprint) return null;

		const bindings = rows
			.filter((row) => row.mediaType === "series")
			.map((row) => ({
				libraryId: row.libraryId,
				mediaType: row.mediaType,
				jellyfinId: row.jellyfinId,
				tmdbId: row.tmdbId,
			}))
			.sort((left, right) => {
				return (
					left.libraryId.localeCompare(right.libraryId) ||
					left.mediaType.localeCompare(right.mediaType) ||
					(left.jellyfinId ?? "").localeCompare(right.jellyfinId ?? "") ||
					left.tmdbId - right.tmdbId
				);
			});
		const coverage =
			metadata.coverageReceipt.version === 2
				? projectV2Coverage(metadata.coverageReceipt)
				: projectLegacyCoverage(metadata.coverageReceipt);
		return evidenceFingerprint({
			version: 2,
			instanceId,
			provider: metadata.provider,
			cacheType: metadata.cacheType,
			canonicalizationVersion: metadata.canonicalizationVersion,
			connectionGeneration: metadata.connectionGeneration,
			identityGeneration: metadata.identityGeneration,
			bindings,
			coverage,
		});
	} catch {
		return null;
	}
}
