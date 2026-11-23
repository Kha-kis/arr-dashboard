import { createHash } from "node:crypto";
import { EPISODE_INVENTORY_REFRESH_MS } from "./episode-inventory-policy.js";

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
			(value.v === 2 || (value.v === 3 && validObservationFields(value))) &&
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

function validIsoTime(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function validDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validObservationFields(value: Record<string, unknown>): boolean {
	return (
		validIsoTime(value.observedAt) &&
		validDigest(value.seriesContentDigest) &&
		validDigest(value.sourceFingerprint)
	);
}

type InventorySource =
	| { status: "legacy" | "invalid" }
	| { status: "current"; sourceFingerprint: string; seriesContentDigest: string };

/** Only absent historical provenance may use the legacy publication contract. */
export function readEpisodeFileInventorySource(
	seriesData: string,
	sourceFingerprint: string | null,
): InventorySource {
	try {
		const data: unknown = JSON.parse(seriesData);
		if (typeof data !== "object" || data === null || Array.isArray(data))
			return { status: "invalid" };
		const value = data as Record<string, unknown>;
		if (!Object.hasOwn(value, "_arrDashboardSource")) return { status: "legacy" };
		const marker = value._arrDashboardSource;
		if (
			!validDigest(sourceFingerprint) ||
			typeof marker !== "object" ||
			marker === null ||
			(marker as Record<string, unknown>).serviceFingerprint !== sourceFingerprint
		)
			return { status: "invalid" };
		return {
			status: "current",
			sourceFingerprint,
			seriesContentDigest: createHash("sha256").update(seriesData).digest("hex"),
		};
	} catch {
		return { status: "invalid" };
	}
}

/** New provider observations only; never upgrades an existing receipt. */
export function createEpisodeFileObservationReceipt(
	seriesCachedAt: Date,
	files: readonly EpisodeFileIdentity[],
	evidence: SonarrSeriesFileEvidence,
	seriesData: string,
	sourceFingerprint: string | null,
	observedAt: Date,
): string | null {
	const legacy = createEpisodeFileInventoryReceipt(seriesCachedAt, files, evidence);
	const source = readEpisodeFileInventorySource(seriesData, sourceFingerprint);
	if (!legacy || source.status !== "current" || !Number.isFinite(observedAt.getTime())) return null;
	return JSON.stringify({
		...JSON.parse(legacy),
		v: 3,
		observedAt: observedAt.toISOString(),
		seriesContentDigest: source.seriesContentDigest,
		sourceFingerprint: source.sourceFingerprint,
	});
}

export interface EpisodeInventoryDisplay {
	status: "fresh" | "stale" | "unknown";
	observedAt: string | null;
}

/** Display evidence only. This must never authorize cache pruning or mutation. */
export function readEpisodeFileInventoryDisplay(
	receipt: string | null | undefined,
	seriesCachedAt: Date | null | undefined,
	files: readonly EpisodeFileIdentity[],
	seriesData: string | null | undefined,
	sourceFingerprint: string | null,
	now = Date.now(),
): { complete: boolean; sourceMatches: boolean; episodeInventory?: EpisodeInventoryDisplay } {
	const unknown: EpisodeInventoryDisplay = { status: "unknown", observedAt: null };
	const source = readEpisodeFileInventorySource(seriesData ?? "{}", sourceFingerprint);
	// Revocation or a legacy/malformed receipt must never bypass a known
	// source mismatch. An absent historical marker remains distinguishable.
	if (source.status === "invalid")
		return { complete: false, sourceMatches: false, episodeInventory: unknown };
	const incomplete = {
		complete: false,
		sourceMatches: true,
		...(source.status === "current" ? { episodeInventory: unknown } : {}),
	};
	let value: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(receipt ?? "null");
		if (typeof parsed !== "object" || parsed === null) return incomplete;
		value = parsed as Record<string, unknown>;
	} catch {
		return incomplete;
	}
	if (value.v === 2)
		return {
			complete: hasCompleteEpisodeFileInventory(receipt, seriesCachedAt, files),
			sourceMatches: true,
		};
	const sourceMatches =
		source.status === "current" && value.sourceFingerprint === source.sourceFingerprint;
	if (
		value.v !== 3 ||
		!sourceMatches ||
		source.status !== "current" ||
		!validObservationFields(value) ||
		!validIsoTime(value.seriesCachedAt) ||
		value.seriesContentDigest !== source.seriesContentDigest ||
		!hasCompleteEpisodeFileInventory(receipt, new Date(value.seriesCachedAt), files)
	)
		return { complete: false, sourceMatches, episodeInventory: unknown };
	const observedAt = value.observedAt as string;
	const age = now - Date.parse(observedAt);
	if (!Number.isFinite(age) || age < 0)
		return { complete: false, sourceMatches, episodeInventory: unknown };
	const status = age < EPISODE_INVENTORY_REFRESH_MS ? "fresh" : "stale";
	return { complete: status === "fresh", sourceMatches, episodeInventory: { status, observedAt } };
}
