import type { ProviderObservationStatus } from "@arr/shared";
import { evidenceFingerprint } from "../evidence-fingerprint.js";
import type { CacheRefreshStatus, Prisma, ServiceInstance } from "../prisma.js";
import {
	evaluateProviderCoverageReceipt,
	type ProviderCoverageEvaluation,
} from "../provider-observation/coverage-receipt.js";
import { projectProviderObservationStatus } from "../provider-observation/status-projection.js";
import {
	isJellyfinEpisodeCatalogCompatible,
	jellyfinEpisodeCatalogScopesFromReceipt,
} from "./jellyfin-episode-catalog-provenance.js";
import { fingerprintJellyfinEpisodeParentDependency } from "./jellyfin-episode-parent-dependency.js";
import {
	decodeJellyfinEpisodeGenerationMetadata,
	decodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinEpisodeRows,
	fingerprintJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
	hasAuthoritativeJellyfinLibraryReceipt,
	hasJellyfinEpisodeParentReceipt,
	type JellyfinEpisodeGenerationMetadata,
	type JellyfinEpisodeRowFingerprintInput,
	type JellyfinLibraryGenerationMetadataV1,
	type JellyfinLibraryRowFingerprintInput,
} from "./jellyfin-generation-metadata.js";

export const JELLYFIN_EVIDENCE_READ_PAGE_SIZE = 500;
export const JELLYFIN_EVIDENCE_MAX_ROWS = 100_000;
export const DEFAULT_JELLYFIN_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_JELLYFIN_EVIDENCE_MAX_AGE_MS = 7 * DEFAULT_JELLYFIN_EVIDENCE_MAX_AGE_MS;
const JELLYFIN_EVIDENCE_TRANSACTION_TIMEOUT_MS = 10_000;
const JELLYFIN_ATTEMPT_MARKER =
	/^in_progress:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LIBRARY_ROW_SELECT = {
	id: true,
	instanceId: true,
	tmdbId: true,
	mediaType: true,
	libraryId: true,
	libraryName: true,
	title: true,
	jellyfinId: true,
	lastWatchedAt: true,
	watchCount: true,
	watchedByUsers: true,
	onDeck: true,
	userRating: true,
	collections: true,
	addedAt: true,
	thumb: true,
	connectionGeneration: true,
	identityGeneration: true,
} as const;

const EPISODE_ROW_SELECT = {
	id: true,
	instanceId: true,
	showTmdbId: true,
	seasonNumber: true,
	episodeNumber: true,
	jellyfinId: true,
	title: true,
	watched: true,
	watchedByUsers: true,
	lastWatchedAt: true,
	connectionGeneration: true,
	identityGeneration: true,
} as const;

const STATUS_SELECT = {
	instanceId: true,
	cacheType: true,
	lastRefreshedAt: true,
	lastResult: true,
	lastErrorMessage: true,
	itemCount: true,
	generationId: true,
	generationMetadata: true,
	lastAttemptAt: true,
	lastAttemptResult: true,
	lastAttemptErrorMessage: true,
	connectionGeneration: true,
	identityGeneration: true,
} as const;

const INSTANCE_SELECT = {
	id: true,
	service: true,
	enabled: true,
	expectedIdentity: true,
	identityStatus: true,
	connectionGeneration: true,
	identityGeneration: true,
} as const;

export type JellyfinLibraryRow = Prisma.JellyfinCacheGetPayload<{
	select: typeof LIBRARY_ROW_SELECT;
}>;
export type JellyfinEpisodeRow = Prisma.JellyfinEpisodeCacheGetPayload<{
	select: typeof EPISODE_ROW_SELECT;
}>;
type EvidenceRow = JellyfinLibraryRow | JellyfinEpisodeRow;

type JellyfinCacheType = "jellyfin" | "jellyfin_episode";
type JellyfinObservationMode = "display" | "mutation";
type JellyfinProviderService = "JELLYFIN" | "EMBY";
type JellyfinMetadata = JellyfinLibraryGenerationMetadataV1 | JellyfinEpisodeGenerationMetadata;
type JellyfinInstance = Pick<
	ServiceInstance,
	| "id"
	| "service"
	| "enabled"
	| "expectedIdentity"
	| "identityStatus"
	| "connectionGeneration"
	| "identityGeneration"
>;

type EvidenceTransactionOptions = {
	isolationLevel?: "Serializable";
	timeout?: number;
};

export type JellyfinEvidencePrisma = {
	$transaction(
		operation: (tx: TransactionReader) => Promise<unknown>,
		options?: EvidenceTransactionOptions,
	): Promise<unknown>;
	serviceInstance: {
		findFirst(args: {
			where: { id: string; userId: string };
			select: typeof INSTANCE_SELECT;
		}): Promise<JellyfinInstance | null>;
	};
	cacheRefreshStatus: {
		findUnique(args: {
			where: {
				instanceId_cacheType: { instanceId: string; cacheType: JellyfinCacheType };
				instance: { userId: string };
			};
			select: typeof STATUS_SELECT;
		}): Promise<CacheStatus | null>;
	};
	jellyfinCache: {
		findMany(args: {
			where: { instanceId: string; instance: { userId: string } };
			select: typeof LIBRARY_ROW_SELECT;
			take: number;
			orderBy: { id: "asc" };
			skip?: number;
			cursor?: { id: string };
		}): Promise<JellyfinLibraryRow[]>;
	};
	jellyfinEpisodeCache: {
		findMany(args: {
			where: { instanceId: string; instance: { userId: string } };
			select: typeof EPISODE_ROW_SELECT;
			take: number;
			orderBy: { id: "asc" };
			skip?: number;
			cursor?: { id: string };
		}): Promise<JellyfinEpisodeRow[]>;
	};
};

export type JellyfinObservationInput = {
	prisma: JellyfinEvidencePrisma;
	userId: string;
	instanceId: string;
	cacheType: JellyfinCacheType;
	mode: JellyfinObservationMode;
	now?: Date;
	maxAgeMs?: number;
};

export type JellyfinObservationTransactionInput = Omit<JellyfinObservationInput, "prisma">;

export type JellyfinObservationAuthority = {
	generationId: string;
	publishedAt: Date;
	itemCount: number;
	connectionGeneration: number;
	identityGeneration: number;
	statusFingerprint: string;
	rowFingerprint: string;
};

export type JellyfinLibraryObservation = {
	available: boolean;
	instanceId: string;
	service: JellyfinProviderService;
	cacheType: "jellyfin";
	generationId: string | null;
	publishedAt: Date | null;
	metadata: JellyfinLibraryGenerationMetadataV1 | null;
	rows: JellyfinLibraryRow[];
	providerStatus: ProviderObservationStatus;
	mutationAvailable: boolean;
	authority: JellyfinObservationAuthority | null;
};

export type JellyfinEpisodeObservation = {
	available: boolean;
	instanceId: string;
	service: JellyfinProviderService;
	cacheType: "jellyfin_episode";
	generationId: string | null;
	publishedAt: Date | null;
	metadata: JellyfinEpisodeGenerationMetadata | null;
	rows: JellyfinEpisodeRow[];
	providerStatus: ProviderObservationStatus;
	mutationAvailable: boolean;
	authority: JellyfinObservationAuthority | null;
};

export type JellyfinObservation = JellyfinLibraryObservation | JellyfinEpisodeObservation;

export type CacheStatus = Pick<
	CacheRefreshStatus,
	| "instanceId"
	| "cacheType"
	| "lastRefreshedAt"
	| "lastResult"
	| "lastErrorMessage"
	| "itemCount"
	| "generationId"
	| "generationMetadata"
	| "lastAttemptAt"
	| "lastAttemptResult"
	| "lastAttemptErrorMessage"
	| "connectionGeneration"
	| "identityGeneration"
>;

type StrictPublication<Row, Metadata extends JellyfinMetadata> = {
	status: CacheStatus;
	metadata: Metadata;
	rows: Row[];
	evaluation: ProviderCoverageEvaluation;
};

export type TransactionReader = Pick<
	JellyfinEvidencePrisma,
	"serviceInstance" | "cacheRefreshStatus" | "jellyfinCache" | "jellyfinEpisodeCache"
>;

function validDate(value: unknown): value is Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}

function safeCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function currentProviderService(value: unknown): value is JellyfinProviderService {
	return value === "JELLYFIN" || value === "EMBY";
}

function currentIdentity(instance: JellyfinInstance): boolean {
	return (
		instance.enabled &&
		instance.identityStatus === "VERIFIED" &&
		typeof instance.expectedIdentity === "string" &&
		instance.expectedIdentity.trim() !== "" &&
		safeCount(instance.connectionGeneration) &&
		safeCount(instance.identityGeneration)
	);
}

function unavailableStatus(
	reason:
		| "no-publication"
		| "identity-unverified"
		| "identity-changed"
		| "receipt-invalid"
		| "rows-inconsistent"
		| "unknown-failure",
	latestAttempt: "idle" | "running" | "failed" | "successful" = "idle",
): ProviderObservationStatus {
	return {
		availability: "unavailable",
		evidence: "unknown",
		observedAt: null,
		ageSeconds: null,
		latestAttempt,
		reasonCodes: [reason],
	};
}

function lastAttempt(
	status: CacheStatus,
): { state: "running" | "failed" | "successful"; attemptedAt: Date } | null {
	if (!validDate(status.lastAttemptAt)) return null;
	if (status.lastAttemptResult === "success")
		return { state: "successful", attemptedAt: status.lastAttemptAt };
	if (status.lastAttemptResult === "error")
		return { state: "failed", attemptedAt: status.lastAttemptAt };
	if (
		typeof status.lastAttemptResult === "string" &&
		JELLYFIN_ATTEMPT_MARKER.test(status.lastAttemptResult)
	)
		return { state: "running", attemptedAt: status.lastAttemptAt };
	return null;
}

function statusFingerprint(status: CacheStatus): string {
	return evidenceFingerprint({
		lastRefreshedAt: validDate(status.lastRefreshedAt)
			? status.lastRefreshedAt.toISOString()
			: null,
		lastResult: status.lastResult,
		lastErrorMessage: status.lastErrorMessage,
		itemCount: status.itemCount,
		generationId: status.generationId,
		generationMetadata: status.generationMetadata,
		lastAttemptAt: validDate(status.lastAttemptAt) ? status.lastAttemptAt.toISOString() : null,
		lastAttemptResult: status.lastAttemptResult,
		lastAttemptErrorMessage: status.lastAttemptErrorMessage,
		connectionGeneration: status.connectionGeneration,
		identityGeneration: status.identityGeneration,
	});
}

function authorityStatusFingerprint(instance: JellyfinInstance, status: CacheStatus): string {
	return evidenceFingerprint({
		identity: {
			id: instance.id,
			service: instance.service,
			enabled: instance.enabled,
			expectedIdentity: instance.expectedIdentity,
			identityStatus: instance.identityStatus,
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
		},
		status: statusFingerprint(status),
	});
}

function authorityRowFingerprint(rows: EvidenceRow[]): string {
	return evidenceFingerprint([...rows].sort((left, right) => left.id.localeCompare(right.id)));
}

function identityFingerprint(instance: JellyfinInstance): string {
	return evidenceFingerprint({
		service: instance.service,
		enabled: instance.enabled,
		expectedIdentity: instance.expectedIdentity,
		identityStatus: instance.identityStatus,
		connectionGeneration: instance.connectionGeneration,
		identityGeneration: instance.identityGeneration,
	});
}

function safeJsonArray(value: unknown): boolean {
	if (typeof value !== "string" || value.length > 1_000_000) return false;
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string");
	} catch {
		return false;
	}
}

function safeLibraryRow(
	row: JellyfinLibraryRow,
	instance: JellyfinInstance,
	strict: boolean,
): boolean {
	return (
		typeof row.id === "string" &&
		row.id.trim() !== "" &&
		row.instanceId === instance.id &&
		safeCount(row.tmdbId) &&
		(row.mediaType === "movie" || row.mediaType === "series") &&
		typeof row.libraryId === "string" &&
		typeof row.libraryName === "string" &&
		typeof row.title === "string" &&
		(row.jellyfinId === null || typeof row.jellyfinId === "string") &&
		safeCount(row.watchCount) &&
		typeof row.onDeck === "boolean" &&
		(row.userRating === null ||
			(typeof row.userRating === "number" && Number.isFinite(row.userRating))) &&
		safeJsonArray(row.watchedByUsers) &&
		safeJsonArray(row.collections) &&
		(row.lastWatchedAt === null || validDate(row.lastWatchedAt)) &&
		(row.addedAt === null || validDate(row.addedAt)) &&
		(!strict ||
			(row.connectionGeneration === instance.connectionGeneration &&
				row.identityGeneration === instance.identityGeneration))
	);
}

function safeEpisodeRow(
	row: JellyfinEpisodeRow,
	instance: JellyfinInstance,
	strict: boolean,
): boolean {
	return (
		typeof row.id === "string" &&
		row.id.trim() !== "" &&
		row.instanceId === instance.id &&
		safeCount(row.showTmdbId) &&
		safeCount(row.seasonNumber) &&
		safeCount(row.episodeNumber) &&
		typeof row.jellyfinId === "string" &&
		row.jellyfinId.trim() !== "" &&
		typeof row.title === "string" &&
		typeof row.watched === "boolean" &&
		safeJsonArray(row.watchedByUsers) &&
		(row.lastWatchedAt === null || validDate(row.lastWatchedAt)) &&
		(!strict ||
			(row.connectionGeneration === instance.connectionGeneration &&
				row.identityGeneration === instance.identityGeneration))
	);
}

async function readStatus(
	tx: TransactionReader,
	instanceId: string,
	userId: string,
	cacheType: JellyfinCacheType,
): Promise<CacheStatus | null> {
	return await tx.cacheRefreshStatus.findUnique({
		where: {
			instanceId_cacheType: { instanceId, cacheType },
			instance: { userId },
		},
		select: STATUS_SELECT,
	});
}

async function readRows(
	tx: TransactionReader,
	instanceId: string,
	userId: string,
	cacheType: JellyfinCacheType,
): Promise<JellyfinLibraryRow[] | JellyfinEpisodeRow[]> {
	const rows: EvidenceRow[] = [];
	let cursor: string | undefined;
	let previousLastId: string | undefined;
	while (true) {
		const page =
			cacheType === "jellyfin"
				? await tx.jellyfinCache.findMany({
						where: { instanceId, instance: { userId } },
						select: LIBRARY_ROW_SELECT,
						take: JELLYFIN_EVIDENCE_READ_PAGE_SIZE,
						orderBy: { id: "asc" },
						...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
					})
				: await tx.jellyfinEpisodeCache.findMany({
						where: { instanceId, instance: { userId } },
						select: EPISODE_ROW_SELECT,
						take: JELLYFIN_EVIDENCE_READ_PAGE_SIZE,
						orderBy: { id: "asc" },
						...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
					});
		if (page.length === 0) break;
		if (
			page.length > JELLYFIN_EVIDENCE_READ_PAGE_SIZE ||
			rows.length + page.length > JELLYFIN_EVIDENCE_MAX_ROWS
		) {
			throw new Error("row-cap");
		}
		const firstId = page[0]?.id;
		const lastId = page[page.length - 1]?.id;
		if (typeof firstId !== "string" || typeof lastId !== "string") {
			throw new Error("cursor-invalid");
		}
		if (cursor && firstId <= cursor) throw new Error("cursor-invalid");
		if (previousLastId && firstId <= previousLastId) throw new Error("cursor-invalid");
		for (let index = 1; index < page.length; index++) {
			const currentId = page[index]?.id;
			const priorId = page[index - 1]?.id;
			if (typeof currentId !== "string" || typeof priorId !== "string" || currentId <= priorId) {
				throw new Error("cursor-invalid");
			}
		}
		rows.push(...(page as EvidenceRow[]));
		if (page.length < JELLYFIN_EVIDENCE_READ_PAGE_SIZE) break;
		previousLastId = lastId;
		cursor = lastId;
	}
	return cacheType === "jellyfin" ? (rows as JellyfinLibraryRow[]) : (rows as JellyfinEpisodeRow[]);
}

function strictMetadata(
	status: CacheStatus,
	instance: JellyfinInstance,
	cacheType: JellyfinCacheType,
	now: Date,
	allowPositiveOnly = false,
): { metadata: JellyfinMetadata; evaluation: ProviderCoverageEvaluation } | null {
	if (
		status.cacheType !== cacheType ||
		status.instanceId !== instance.id ||
		status.lastResult !== "success" ||
		!validDate(status.lastRefreshedAt) ||
		!validDate(now) ||
		status.lastRefreshedAt.getTime() > now.getTime() ||
		typeof status.generationId !== "string" ||
		status.generationId.trim() === "" ||
		!safeCount(status.itemCount) ||
		status.connectionGeneration !== instance.connectionGeneration ||
		status.identityGeneration !== instance.identityGeneration ||
		typeof status.generationMetadata !== "string" ||
		(status.lastAttemptResult !== null &&
			status.lastAttemptResult !== "success" &&
			status.lastAttemptResult !== "error" &&
			!(
				typeof status.lastAttemptResult === "string" &&
				JELLYFIN_ATTEMPT_MARKER.test(status.lastAttemptResult)
			)) ||
		(status.lastAttemptResult === null && status.lastAttemptAt !== null) ||
		(status.lastAttemptResult !== null && !validDate(status.lastAttemptAt)) ||
		(validDate(status.lastAttemptAt) && status.lastAttemptAt.getTime() > now.getTime()) ||
		(status.lastErrorMessage !== null &&
			(typeof status.lastErrorMessage !== "string" || status.lastErrorMessage.length > 4_000)) ||
		(status.lastAttemptErrorMessage !== null &&
			(typeof status.lastAttemptErrorMessage !== "string" ||
				status.lastAttemptErrorMessage.length > 4_000)) ||
		(status.lastResult === "success" && status.lastErrorMessage !== null) ||
		(status.lastAttemptResult === "success" && status.lastAttemptErrorMessage !== null) ||
		(status.lastAttemptResult === "success" &&
			status.lastAttemptAt!.getTime() > status.lastRefreshedAt.getTime())
	)
		return null;
	const decoded =
		cacheType === "jellyfin"
			? decodeJellyfinLibraryGenerationMetadata(status.generationMetadata)
			: decodeJellyfinEpisodeGenerationMetadata(status.generationMetadata);
	if (!decoded.ok) return null;
	const metadata = decoded.metadata;
	const expectedProvider = instance.service === "EMBY" ? "emby" : "jellyfin";
	if (
		metadata.provider !== expectedProvider ||
		metadata.cacheType !== cacheType ||
		metadata.itemCount !== status.itemCount ||
		metadata.connectionGeneration !== instance.connectionGeneration ||
		metadata.identityGeneration !== instance.identityGeneration
	)
		return null;
	const evaluation = evaluateProviderCoverageReceipt(metadata.coverageReceipt);
	const authoritativeV2LibraryReceipt =
		metadata.cacheType === "jellyfin" &&
		hasAuthoritativeJellyfinLibraryReceipt(metadata.coverageReceipt);
	if (
		!evaluation.valid ||
		(metadata.publicationLevel === "authoritative"
			? (!evaluation.complete || evaluation.evidence !== "complete") &&
				!authoritativeV2LibraryReceipt
			: !allowPositiveOnly || evaluation.evidence !== "positive-only") ||
		evaluation.publishedCanonicalEntities !== status.itemCount ||
		metadata.coverageReceipt.observedAt !== status.lastRefreshedAt.toISOString()
	)
		return null;
	return { metadata, evaluation };
}

function strictRows(
	rows: JellyfinLibraryRow[] | JellyfinEpisodeRow[],
	instance: JellyfinInstance,
	cacheType: JellyfinCacheType,
): boolean {
	if (cacheType === "jellyfin") {
		return (rows as JellyfinLibraryRow[]).every((row) => safeLibraryRow(row, instance, true));
	}
	return (rows as JellyfinEpisodeRow[]).every((row) => safeEpisodeRow(row, instance, true));
}

async function strictPublication(
	tx: TransactionReader,
	instance: JellyfinInstance,
	userId: string,
	cacheType: JellyfinCacheType,
	now: Date,
	allowEpisodeParentReceipt = false,
): Promise<StrictPublication<JellyfinLibraryRow | JellyfinEpisodeRow, JellyfinMetadata> | null> {
	const status = await readStatus(tx, instance.id, userId, cacheType);
	if (!status) return null;
	const decoded = strictMetadata(status, instance, cacheType, now, allowEpisodeParentReceipt);
	if (!decoded) return null;
	if (
		allowEpisodeParentReceipt &&
		(cacheType !== "jellyfin" || !hasJellyfinEpisodeParentReceipt(decoded.metadata.coverageReceipt))
	)
		return null;
	const rows = await readRows(tx, instance.id, userId, cacheType);
	if (rows.length !== status.itemCount || !strictRows(rows, instance, cacheType)) return null;
	const fingerprint =
		cacheType === "jellyfin"
			? fingerprintJellyfinLibraryRows(
					rows as JellyfinLibraryRow[] as JellyfinLibraryRowFingerprintInput[],
				)
			: fingerprintJellyfinEpisodeRows(
					rows as JellyfinEpisodeRow[] as JellyfinEpisodeRowFingerprintInput[],
				);
	if (fingerprint !== decoded.metadata.contentFingerprint) return null;
	const statusAfter = await readStatus(tx, instance.id, userId, cacheType);
	if (!statusAfter || statusFingerprint(statusAfter) !== statusFingerprint(status)) return null;
	return { status, metadata: decoded.metadata, rows, evaluation: decoded.evaluation };
}

function legacyDisplayRows(
	rows: JellyfinLibraryRow[] | JellyfinEpisodeRow[],
	instance: JellyfinInstance,
	cacheType: JellyfinCacheType,
): JellyfinLibraryRow[] | JellyfinEpisodeRow[] {
	const provenance = rows.map((row) => [row.connectionGeneration, row.identityGeneration]);
	const hasNullProvenance = provenance.some(
		([connection, identity]) => connection === null || identity === null,
	);
	const hasCompleteProvenance = provenance.some(
		([connection, identity]) => connection !== null && identity !== null,
	);
	if (hasNullProvenance && hasCompleteProvenance) return [];
	const completeProvenance = provenance.filter(
		([connection, identity]) => connection !== null && identity !== null,
	);
	if (
		completeProvenance.some(
			([connection, identity]) =>
				connection !== completeProvenance[0]?.[0] || identity !== completeProvenance[0]?.[1],
		)
	) {
		return [];
	}
	if (
		completeProvenance.some(
			([connection, identity]) =>
				connection !== instance.connectionGeneration || identity !== instance.identityGeneration,
		)
	) {
		return [];
	}
	if (cacheType === "jellyfin") {
		return rows.every((row) => safeLibraryRow(row as JellyfinLibraryRow, instance, false))
			? (rows as JellyfinLibraryRow[])
			: [];
	}
	return rows.every((row) => safeEpisodeRow(row as JellyfinEpisodeRow, instance, false))
		? (rows as JellyfinEpisodeRow[])
		: [];
}

function legacyRowsMatchStatus(rows: EvidenceRow[], status: CacheStatus): boolean {
	const statusHasCurrentProvenance =
		status.connectionGeneration !== null && status.identityGeneration !== null;
	return rows.every((row) => {
		const rowHasCurrentProvenance =
			row.connectionGeneration !== null && row.identityGeneration !== null;
		const rowHasNullProvenance =
			row.connectionGeneration === null && row.identityGeneration === null;
		if (!rowHasCurrentProvenance && !rowHasNullProvenance) return false;
		if (rowHasCurrentProvenance !== statusHasCurrentProvenance) return false;
		return (
			!rowHasCurrentProvenance ||
			(row.connectionGeneration === status.connectionGeneration &&
				row.identityGeneration === status.identityGeneration)
		);
	});
}

function legacyStatus(status?: CacheStatus): ProviderObservationStatus {
	const attempt = status ? lastAttempt(status) : null;
	const newerAttempt =
		attempt &&
		validDate(status?.lastRefreshedAt) &&
		attempt.attemptedAt.getTime() > status.lastRefreshedAt.getTime()
			? attempt
			: null;
	return {
		availability: "last-known",
		evidence: "unknown",
		observedAt: null,
		ageSeconds: null,
		latestAttempt: newerAttempt?.state ?? "idle",
		reasonCodes:
			newerAttempt?.state === "running"
				? ["receipt-invalid", "refresh-running"]
				: newerAttempt?.state === "failed"
					? ["receipt-invalid", "refresh-failed"]
					: ["receipt-invalid"],
	};
}

function noPublicationStatus(status: CacheStatus): ProviderObservationStatus {
	const attempt = lastAttempt(status);
	return unavailableStatus("no-publication", attempt?.state ?? "idle");
}

function isTrueLegacyStatus(
	status: CacheStatus,
	instance: JellyfinInstance,
	cacheType: JellyfinCacheType,
	now: Date,
): boolean {
	if (
		status.instanceId !== instance.id ||
		status.cacheType !== cacheType ||
		status.lastResult !== "success" ||
		status.generationId !== null ||
		status.generationMetadata !== null ||
		!safeCount(status.itemCount) ||
		!validDate(status.lastRefreshedAt) ||
		!validDate(now) ||
		status.lastRefreshedAt.getTime() > now.getTime() ||
		status.lastErrorMessage !== null ||
		(status.lastAttemptErrorMessage !== null &&
			(typeof status.lastAttemptErrorMessage !== "string" ||
				status.lastAttemptErrorMessage.length > 4_000))
	) {
		return false;
	}

	const allNullLegacy =
		status.connectionGeneration === null &&
		status.identityGeneration === null &&
		status.lastAttemptAt === null &&
		status.lastAttemptResult === null &&
		status.lastAttemptErrorMessage === null;
	if (allNullLegacy) return true;

	const currentPreReceipt =
		status.connectionGeneration === instance.connectionGeneration &&
		status.identityGeneration === instance.identityGeneration &&
		validDate(status.lastAttemptAt) &&
		status.lastAttemptResult !== null &&
		(status.lastAttemptResult === "success" ||
			status.lastAttemptResult === "error" ||
			(typeof status.lastAttemptResult === "string" &&
				JELLYFIN_ATTEMPT_MARKER.test(status.lastAttemptResult))) &&
		status.lastAttemptAt.getTime() <= now.getTime();
	if (!currentPreReceipt) return false;
	const attemptAt = status.lastAttemptAt;
	if (!validDate(attemptAt)) return false;
	if (status.lastAttemptResult === "success") {
		return (
			attemptAt.getTime() === status.lastRefreshedAt.getTime() &&
			status.lastAttemptErrorMessage === null
		);
	}
	return attemptAt.getTime() >= status.lastRefreshedAt.getTime();
}

function resultFor(
	instance: JellyfinInstance,
	cacheType: JellyfinCacheType,
	mode: JellyfinObservationMode,
	status: CacheStatus | null,
	metadata: JellyfinMetadata | null,
	rows: JellyfinLibraryRow[] | JellyfinEpisodeRow[],
	providerStatus: ProviderObservationStatus,
	available: boolean,
	mutationAvailable: boolean,
): JellyfinObservation {
	const safeRows = available && (mode === "display" || mutationAvailable) ? rows : [];
	const safeMetadata = !available ? null : metadata;
	const authority =
		mode === "mutation" &&
		available &&
		mutationAvailable &&
		status &&
		metadata &&
		validDate(status.lastRefreshedAt) &&
		typeof status.generationId === "string" &&
		status.generationId.trim() !== "" &&
		safeCount(status.connectionGeneration) &&
		safeCount(status.identityGeneration)
			? {
					generationId: status.generationId,
					publishedAt: status.lastRefreshedAt,
					itemCount: status.itemCount,
					connectionGeneration: status.connectionGeneration,
					identityGeneration: status.identityGeneration,
					statusFingerprint: authorityStatusFingerprint(instance, status),
					rowFingerprint: authorityRowFingerprint(rows),
				}
			: null;
	const common = {
		available,
		instanceId: instance.id,
		service: instance.service as JellyfinProviderService,
		generationId: status?.generationId ?? null,
		publishedAt: validDate(status?.lastRefreshedAt) ? status.lastRefreshedAt : null,
		providerStatus,
		mutationAvailable,
		authority,
	};
	if (cacheType === "jellyfin") {
		return {
			...common,
			cacheType,
			metadata: safeMetadata?.cacheType === "jellyfin" ? safeMetadata : null,
			rows: safeRows as JellyfinLibraryRow[],
		};
	}
	return {
		...common,
		cacheType,
		metadata: safeMetadata?.cacheType === "jellyfin_episode" ? safeMetadata : null,
		rows: safeRows as JellyfinEpisodeRow[],
	};
}

function retryableDatabaseConflict(error: unknown, seen = new Set<object>()): boolean {
	if (!error || typeof error !== "object" || seen.has(error)) return false;
	seen.add(error);
	const value = error as Record<string, unknown>;
	const codes = [value.code, value.originalCode].filter(
		(code): code is string => typeof code === "string",
	);
	const message = [value.message, value.originalMessage]
		.filter((entry): entry is string => typeof entry === "string")
		.join(" ");
	if (
		codes.some((code) => /^(P2034|SQLITE_BUSY|SQLITE_LOCKED|40001)$/i.test(code)) ||
		/serialization|deadlock|database[- ]locked|transaction[- ]write[- ]conflict/i.test(message)
	) {
		return true;
	}
	return Object.values(value).some((nested) => retryableDatabaseConflict(nested, seen));
}

async function runSerializable<T>(
	prisma: JellyfinEvidencePrisma,
	operation: (tx: TransactionReader) => Promise<T>,
	fallback: T,
): Promise<T> {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return (await prisma.$transaction(operation, {
				isolationLevel: "Serializable",
				timeout: JELLYFIN_EVIDENCE_TRANSACTION_TIMEOUT_MS,
			})) as T;
		} catch (error) {
			if (!retryableDatabaseConflict(error) || attempt === 2) return fallback;
			await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 15));
		}
	}
	return fallback;
}

async function readOwnedJellyfinObservationCore(
	tx: TransactionReader,
	input: JellyfinObservationTransactionInput,
	now: Date,
	maxAgeMs: number,
): Promise<JellyfinObservation | null> {
	const instance = (await tx.serviceInstance.findFirst({
		where: { id: input.instanceId, userId: input.userId },
		select: INSTANCE_SELECT,
	})) as JellyfinInstance | null;
	if (!instance || !currentProviderService(instance.service)) return null;
	const status = await readStatus(tx, instance.id, input.userId, input.cacheType);
	if (!currentIdentity(instance)) {
		return resultFor(
			instance,
			input.cacheType,
			input.mode,
			status,
			null,
			[],
			unavailableStatus(
				instance.identityStatus === "MISMATCH" ? "identity-changed" : "identity-unverified",
			),
			false,
			false,
		);
	}
	let rows: JellyfinLibraryRow[] | JellyfinEpisodeRow[];
	try {
		rows = await readRows(tx, instance.id, input.userId, input.cacheType);
	} catch {
		return resultFor(
			instance,
			input.cacheType,
			input.mode,
			status,
			null,
			[],
			unavailableStatus("rows-inconsistent"),
			false,
			false,
		);
	}
	if (!status) {
		return resultFor(
			instance,
			input.cacheType,
			input.mode,
			null,
			null,
			[],
			unavailableStatus("no-publication"),
			false,
			false,
		);
	}
	const statusAfter = await readStatus(tx, instance.id, input.userId, input.cacheType);
	if (!statusAfter || statusFingerprint(statusAfter) !== statusFingerprint(status)) {
		return resultFor(
			instance,
			input.cacheType,
			input.mode,
			status,
			null,
			[],
			unavailableStatus("rows-inconsistent"),
			false,
			false,
		);
	}
	const instanceAfter = await tx.serviceInstance.findFirst({
		where: { id: input.instanceId, userId: input.userId },
		select: INSTANCE_SELECT,
	});
	if (
		!instanceAfter ||
		!currentProviderService(instanceAfter.service) ||
		identityFingerprint(instanceAfter) !== identityFingerprint(instance)
	) {
		return resultFor(
			instance,
			input.cacheType,
			input.mode,
			status,
			null,
			[],
			unavailableStatus("identity-changed"),
			false,
			false,
		);
	}
	const strict = status
		? strictMetadata(
				status,
				instance,
				input.cacheType,
				now,
				input.cacheType === "jellyfin" || input.cacheType === "jellyfin_episode",
			)
		: null;
	if (
		!strict ||
		!strictRows(rows, instance, input.cacheType) ||
		rows.length !== status?.itemCount
	) {
		if (
			isTrueLegacyStatus(status, instance, input.cacheType, now) &&
			input.mode === "display" &&
			rows.length === status.itemCount &&
			legacyRowsMatchStatus(rows, status)
		) {
			const safeLegacyRows = legacyDisplayRows(rows, instance, input.cacheType);
			if (safeLegacyRows.length !== rows.length) {
				return resultFor(
					instance,
					input.cacheType,
					input.mode,
					status,
					null,
					[],
					unavailableStatus("rows-inconsistent"),
					false,
					false,
				);
			}
			return resultFor(
				instance,
				input.cacheType,
				input.mode,
				status,
				null,
				safeLegacyRows,
				legacyStatus(status),
				true,
				false,
			);
		}
		const hasPublishedStatus =
			status.lastResult === "success" &&
			validDate(status.lastRefreshedAt) &&
			typeof status.generationId === "string" &&
			status.generationId.trim() !== "" &&
			typeof status.generationMetadata === "string";
		if (!hasPublishedStatus) {
			return resultFor(
				instance,
				input.cacheType,
				input.mode,
				status,
				null,
				[],
				noPublicationStatus(status),
				false,
				false,
			);
		}
		return resultFor(
			instance,
			input.cacheType,
			input.mode,
			status,
			null,
			[],
			unavailableStatus("receipt-invalid"),
			false,
			false,
		);
	}
	const fingerprint =
		input.cacheType === "jellyfin"
			? fingerprintJellyfinLibraryRows(
					rows as JellyfinLibraryRow[] as JellyfinLibraryRowFingerprintInput[],
				)
			: fingerprintJellyfinEpisodeRows(
					rows as JellyfinEpisodeRow[] as JellyfinEpisodeRowFingerprintInput[],
				);
	if (fingerprint !== strict.metadata.contentFingerprint) {
		return resultFor(
			instance,
			input.cacheType,
			input.mode,
			status,
			strict.metadata,
			[],
			unavailableStatus("rows-inconsistent"),
			false,
			false,
		);
	}
	let episodeParentCurrent = true;
	if (input.cacheType === "jellyfin_episode") {
		const parent = await strictPublication(
			tx,
			instance,
			input.userId,
			"jellyfin",
			now,
			input.mode === "display",
		);
		const episodeMetadata = strict.metadata as JellyfinEpisodeGenerationMetadata;
		const parentDependencyFingerprint =
			parent === null
				? null
				: fingerprintJellyfinEpisodeParentDependency(
						instance.id,
						parent.metadata,
						parent.rows as JellyfinLibraryRowFingerprintInput[],
					);
		const exactParentProvenance =
			parent !== null &&
			episodeMetadata.parentLibraryGenerationId === parent.status.generationId &&
			episodeMetadata.parentLibraryMetadataFingerprint ===
				fingerprintJellyfinLibraryGenerationMetadata(
					parent.metadata as JellyfinLibraryGenerationMetadataV1,
				);
		let catalogCompatible = false;
		if (episodeMetadata.version === 3) {
			const currentScopes = parent
				? jellyfinEpisodeCatalogScopesFromReceipt(parent.metadata.coverageReceipt)
				: null;
			const originalCanonicalIds = new Set(
				episodeMetadata.catalogProvenance.bindings.map((binding) => binding.tmdbId),
			);
			catalogCompatible =
				parent !== null &&
				currentScopes !== null &&
				isJellyfinEpisodeCatalogCompatible(
					episodeMetadata.catalogProvenance,
					parent.rows as JellyfinLibraryRowFingerprintInput[],
					currentScopes,
				) &&
				(rows as JellyfinEpisodeRow[]).every((row) => originalCanonicalIds.has(row.showTmdbId));
			// V3 observations retain their original bindings. A missing/remapped
			// binding cannot be presented under a current canonical series, even
			// with a last-known label. Partial evidence never grants mutation.
			if (!catalogCompatible || input.mode !== "display") {
				return resultFor(
					instance,
					input.cacheType,
					input.mode,
					status,
					strict.metadata,
					[],
					unavailableStatus("rows-inconsistent"),
					false,
					false,
				);
			}
		}
		episodeParentCurrent =
			parent !== null &&
			(input.mode === "display"
				? isCurrentEpisodeParentPublication(
						parent.status,
						parent.metadata as JellyfinLibraryGenerationMetadataV1,
						now,
						maxAgeMs,
					)
				: isCurrentPublication(parent.status, parent.evaluation, now, maxAgeMs)) &&
			(episodeMetadata.version === 3
				? catalogCompatible
				: episodeMetadata.version === 2
					? episodeMetadata.parentLibraryDependencyFingerprint === parentDependencyFingerprint &&
						// Structural compatibility preserves display, not permission to act on
						// old episode watch state after a newer parent publication.
						(input.mode === "display" || exactParentProvenance)
					: exactParentProvenance);
		const episodeStatusAfterParent = await readStatus(
			tx,
			instance.id,
			input.userId,
			input.cacheType,
		);
		if (
			!episodeStatusAfterParent ||
			statusFingerprint(episodeStatusAfterParent) !== statusFingerprint(status)
		) {
			return resultFor(
				instance,
				input.cacheType,
				input.mode,
				status,
				null,
				[],
				unavailableStatus("rows-inconsistent"),
				false,
				false,
			);
		}
		if (!episodeParentCurrent && input.mode === "mutation") {
			return resultFor(
				instance,
				input.cacheType,
				input.mode,
				status,
				strict.metadata,
				[],
				unavailableStatus("rows-inconsistent"),
				false,
				false,
			);
		}
	}
	const projected = projectProviderObservationStatus({
		identity: "current",
		publication: { observedAt: status!.lastRefreshedAt, evaluation: strict.evaluation },
		latestAttempt: lastAttempt(status!),
		now,
		maxAgeMs,
	});
	const mutationAvailable =
		input.mode === "mutation" &&
		episodeParentCurrent &&
		projected.availability === "current" &&
		status!.lastAttemptResult === "success" &&
		validDate(status!.lastAttemptAt) &&
		status!.lastAttemptAt.getTime() === status!.lastRefreshedAt.getTime();
	if (input.mode === "mutation" && !mutationAvailable) {
		return resultFor(
			instance,
			input.cacheType,
			input.mode,
			status,
			strict.metadata,
			[],
			projected,
			false,
			false,
		);
	}
	const finalProviderStatus =
		input.cacheType === "jellyfin_episode" && !episodeParentCurrent
			? {
					...projected,
					availability: "last-known" as const,
					reasonCodes: Array.from(
						new Set([...projected.reasonCodes, "publication-superseded" as const]),
					),
				}
			: projected;
	return resultFor(
		instance,
		input.cacheType,
		input.mode,
		status,
		strict.metadata,
		rows,
		finalProviderStatus,
		true,
		mutationAvailable,
	);
}

export async function readOwnedJellyfinObservationInTransaction(
	reader: TransactionReader,
	input: JellyfinObservationTransactionInput,
): Promise<JellyfinObservation | null> {
	const now = validDate(input.now) ? input.now : new Date();
	const maxAgeMs =
		typeof input.maxAgeMs === "number" &&
		Number.isFinite(input.maxAgeMs) &&
		input.maxAgeMs >= 0 &&
		input.maxAgeMs <= MAX_JELLYFIN_EVIDENCE_MAX_AGE_MS
			? input.maxAgeMs
			: DEFAULT_JELLYFIN_EVIDENCE_MAX_AGE_MS;
	return readOwnedJellyfinObservationCore(reader, input, now, maxAgeMs);
}

export async function readOwnedJellyfinObservation(
	input: JellyfinObservationInput,
): Promise<JellyfinObservation | null> {
	const now = validDate(input.now) ? input.now : new Date();
	const maxAgeMs =
		typeof input.maxAgeMs === "number" &&
		Number.isFinite(input.maxAgeMs) &&
		input.maxAgeMs >= 0 &&
		input.maxAgeMs <= MAX_JELLYFIN_EVIDENCE_MAX_AGE_MS
			? input.maxAgeMs
			: DEFAULT_JELLYFIN_EVIDENCE_MAX_AGE_MS;
	const fallback: JellyfinObservation = {
		available: false,
		instanceId: input.instanceId,
		service: "JELLYFIN",
		cacheType: input.cacheType,
		generationId: null,
		publishedAt: null,
		metadata: null,
		rows: [],
		providerStatus: unavailableStatus("unknown-failure"),
		mutationAvailable: false,
		authority: null,
	};
	return runSerializable(
		input.prisma,
		(tx) => readOwnedJellyfinObservationCore(tx, input, now, maxAgeMs),
		fallback,
	);
}

function isCurrentPublication(
	status: CacheStatus,
	evaluation: ProviderCoverageEvaluation,
	now: Date,
	maxAgeMs: number,
): boolean {
	if (!validDate(status.lastRefreshedAt) || status.lastResult !== "success") return false;
	if (
		status.lastAttemptResult !== "success" ||
		!validDate(status.lastAttemptAt) ||
		status.lastAttemptAt.getTime() !== status.lastRefreshedAt.getTime()
	) {
		return false;
	}
	const projected = projectProviderObservationStatus({
		identity: "current",
		publication: { observedAt: status.lastRefreshedAt, evaluation },
		latestAttempt: lastAttempt(status),
		now,
		maxAgeMs,
	});
	return projected.availability === "current";
}

function isCurrentEpisodeParentPublication(
	status: CacheStatus,
	metadata: JellyfinLibraryGenerationMetadataV1,
	now: Date,
	maxAgeMs: number,
): boolean {
	if (
		!validDate(status.lastRefreshedAt) ||
		!validDate(now) ||
		status.lastResult !== "success" ||
		status.lastRefreshedAt.getTime() > now.getTime() ||
		now.getTime() - status.lastRefreshedAt.getTime() > maxAgeMs ||
		status.lastAttemptResult !== "success" ||
		!validDate(status.lastAttemptAt) ||
		status.lastAttemptAt.getTime() !== status.lastRefreshedAt.getTime()
	) {
		return false;
	}
	return hasJellyfinEpisodeParentReceipt(metadata.coverageReceipt);
}
