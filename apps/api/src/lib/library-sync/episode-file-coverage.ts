import { createHash } from "node:crypto";

export interface EpisodeFileIdentity {
	arrEpisodeFileId: number;
	path: string;
	size: bigint;
}

export interface SonarrEpisodeFileCandidate {
	id?: number;
	seriesId?: number;
	seasonNumber?: number;
	relativePath?: string | null;
	path?: string | null;
	size?: number;
}

/** Sonarr counts episodes linked to files, not distinct physical files. */
export interface SonarrSeriesFileEvidence {
	episodeWithFileCount: number;
	sizeOnDisk: bigint;
}

function parseSeriesFileEvidence(count: unknown, size: unknown): SonarrSeriesFileEvidence | null {
	if (
		typeof count !== "number" ||
		!Number.isSafeInteger(count) ||
		count <= 0 ||
		typeof size !== "number" ||
		!Number.isSafeInteger(size) ||
		size <= 0
	) {
		return null;
	}
	return { episodeWithFileCount: count, sizeOnDisk: BigInt(size) };
}

export function currentSonarrSeriesFileEvidence(
	series: unknown,
	expectedSeriesId: number,
): SonarrSeriesFileEvidence | null {
	if (typeof series !== "object" || series === null) return null;
	const value = series as Record<string, unknown>;
	if (value.id !== expectedSeriesId) return null;
	const statistics = value.statistics;
	if (typeof statistics !== "object" || statistics === null) return null;
	const stats = statistics as Record<string, unknown>;
	return parseSeriesFileEvidence(stats.episodeFileCount, stats.sizeOnDisk);
}

export function episodeFileIdentitiesFromSonarr(
	files: readonly SonarrEpisodeFileCandidate[],
	expectedSeriesId: number,
): EpisodeFileIdentity[] | null {
	if (files.length === 0) return null;
	const identities: EpisodeFileIdentity[] = [];
	const seen = new Set<number>();
	for (const file of files) {
		if (
			typeof file.id !== "number" ||
			!Number.isSafeInteger(file.id) ||
			file.id <= 0 ||
			typeof file.seasonNumber !== "number" ||
			!Number.isSafeInteger(file.seasonNumber) ||
			typeof file.size !== "number" ||
			!Number.isSafeInteger(file.size) ||
			file.size <= 0 ||
			!file.path ||
			!file.relativePath ||
			(file.seriesId !== undefined && file.seriesId !== expectedSeriesId) ||
			seen.has(file.id)
		) {
			return null;
		}
		seen.add(file.id);
		identities.push({ arrEpisodeFileId: file.id, path: file.path, size: BigInt(file.size) });
	}
	return identities;
}

export function cachedSonarrSeriesFileEvidence(
	seriesData: string,
): SonarrSeriesFileEvidence | null {
	try {
		const parsed: unknown = JSON.parse(seriesData);
		if (typeof parsed !== "object" || parsed === null) return null;
		const value = parsed as Record<string, unknown>;
		const statistics = value.statistics;
		if (typeof statistics !== "object" || statistics === null) return null;
		return parseSeriesFileEvidence(
			(statistics as Record<string, unknown>).episodeFileCount,
			value.sizeOnDisk,
		);
	} catch {
		return null;
	}
}

function inventoryDigest(files: readonly EpisodeFileIdentity[]): string | null {
	if (files.length === 0) return null;
	const seen = new Set<number>();
	const identities: Array<[number, string, string]> = [];
	for (const file of files) {
		if (
			!Number.isSafeInteger(file.arrEpisodeFileId) ||
			file.arrEpisodeFileId <= 0 ||
			typeof file.path !== "string" ||
			file.path.length === 0 ||
			typeof file.size !== "bigint" ||
			file.size <= 0n ||
			seen.has(file.arrEpisodeFileId)
		) {
			return null;
		}
		seen.add(file.arrEpisodeFileId);
		identities.push([file.arrEpisodeFileId, file.path, file.size.toString()]);
	}
	identities.sort((left, right) => left[0] - right[0]);
	return createHash("sha256").update(JSON.stringify(identities)).digest("hex");
}

export function createEpisodeFileInventoryReceipt(
	seriesCachedAt: Date,
	files: readonly EpisodeFileIdentity[],
	evidence: SonarrSeriesFileEvidence,
): string | null {
	const digest = inventoryDigest(files);
	if (
		!digest ||
		!Number.isFinite(seriesCachedAt.getTime()) ||
		!Number.isSafeInteger(evidence.episodeWithFileCount) ||
		evidence.episodeWithFileCount <= 0 ||
		evidence.sizeOnDisk <= 0n ||
		files.reduce((sum, file) => sum + file.size, 0n) !== evidence.sizeOnDisk
	) {
		return null;
	}
	return JSON.stringify({
		v: 2,
		seriesCachedAt: seriesCachedAt.toISOString(),
		fileCount: files.length,
		episodeWithFileCount: evidence.episodeWithFileCount,
		sourceSizeBytes: evidence.sizeOnDisk.toString(),
		digest,
	});
}

export function hasCompleteEpisodeFileInventory(
	receipt: string | null | undefined,
	seriesCachedAt: Date | null | undefined,
	files: readonly EpisodeFileIdentity[],
): boolean {
	if (!receipt || !seriesCachedAt || !Number.isFinite(seriesCachedAt.getTime())) return false;
	const digest = inventoryDigest(files);
	if (!digest) return false;
	try {
		const parsed: unknown = JSON.parse(receipt);
		if (typeof parsed !== "object" || parsed === null) return false;
		const value = parsed as Record<string, unknown>;
		return (
			value.v === 2 &&
			value.seriesCachedAt === seriesCachedAt.toISOString() &&
			value.fileCount === files.length &&
			typeof value.episodeWithFileCount === "number" &&
			Number.isSafeInteger(value.episodeWithFileCount) &&
			value.episodeWithFileCount > 0 &&
			value.sourceSizeBytes === files.reduce((sum, file) => sum + file.size, 0n).toString() &&
			value.digest === digest
		);
	} catch {
		return false;
	}
}
