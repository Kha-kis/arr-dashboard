import type { ProviderObservationStatus } from "@arr/shared";
import type { Prisma, PrismaClient } from "../prisma.js";
import { evaluateProviderCoverageReceipt } from "../provider-observation/coverage-receipt.js";
import { projectProviderObservationStatus } from "../provider-observation/status-projection.js";
import {
	isJellyfinEpisodeCatalogCompatible,
	jellyfinEpisodeCatalogScopesFromReceipt,
} from "./jellyfin-episode-catalog-provenance.js";
import { fingerprintJellyfinEpisodeParentDependency } from "./jellyfin-episode-parent-dependency.js";
import {
	type JellyfinEpisodeObservation,
	type JellyfinEpisodeRow,
	type JellyfinLibraryObservation,
	materializeOwnedJellyfinLibraryDisplayInTransaction,
	type TransactionReader,
	validateOwnedJellyfinLibraryDisplaySnapshot,
} from "./jellyfin-evidence-repository.js";
import {
	decodeJellyfinEpisodeGenerationMetadata,
	fingerprintJellyfinEpisodeRows,
	fingerprintJellyfinLibraryGenerationMetadata,
	hasJellyfinEpisodeParentReceipt,
	type JellyfinEpisodeGenerationMetadataV4,
	type JellyfinLibraryRowFingerprintInput,
} from "./jellyfin-generation-metadata.js";

const MAX_SCOPED_SHOWS = 200;
const MAX_SCOPED_EPISODE_ROWS = 100_000;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

// The map keys prove receipt coverage. Values carry only coordinates omitted
// from the existing positive-only rows, never episode metadata.
export const jellyfinSeriesProgressProof = Symbol("jellyfin-series-progress-proof");
type EpisodeCoordinate = Pick<JellyfinEpisodeRow, "seasonNumber" | "episodeNumber" | "watched">;
export type JellyfinSeriesProgressProof = {
	[jellyfinSeriesProgressProof]?: ReadonlyMap<number, readonly EpisodeCoordinate[]>;
};
type ScopedEpisodeDisplay = JellyfinEpisodeObservation & JellyfinSeriesProgressProof;

type Input = {
	prisma: PrismaClient;
	userId: string;
	instanceId: string;
	showTmdbIds?: readonly number[];
	includeSeriesProgressProof?: boolean;
	now?: Date;
	maxAgeMs?: number;
};

function unavailable(
	reason: "identity-unverified" | "receipt-invalid" | "rows-inconsistent",
): ProviderObservationStatus {
	return {
		availability: "unavailable",
		evidence: "unknown",
		observedAt: null,
		ageSeconds: null,
		latestAttempt: "idle",
		reasonCodes: [reason],
	};
}

function attemptFromStatus(status: {
	lastAttemptAt: Date | null;
	lastAttemptResult: string | null;
}) {
	if (!status.lastAttemptAt) return null;
	if (status.lastAttemptResult === "success")
		return { state: "successful" as const, attemptedAt: status.lastAttemptAt };
	if (status.lastAttemptResult === "error")
		return { state: "failed" as const, attemptedAt: status.lastAttemptAt };
	if (status.lastAttemptResult?.startsWith("in_progress:"))
		return { state: "running" as const, attemptedAt: status.lastAttemptAt };
	return null;
}

/** Null means this instance does not have a V4 publication; unavailable is explicit otherwise. */
export async function readOwnedGenerationScopedEpisodeDisplay(
	input: Input,
): Promise<ScopedEpisodeDisplay | null> {
	return (await readGenerationScopedDisplay(input)).episodes;
}

export async function readOwnedGenerationScopedLibraryAndEpisodeDisplay(
	input: Input & { showTmdbIds: readonly number[] },
) {
	// Match the independent library reader's snapshot isolation and lease timeout.
	return readGenerationScopedDisplay(input, { isolationLevel: "Serializable", timeout: 10_000 });
}

async function readGenerationScopedDisplay(
	input: Input,
	transactionOptions?: { isolationLevel: "Serializable"; timeout: number },
): Promise<{
	// Undefined means the scoped episode path did not read a parent.
	library: JellyfinLibraryObservation | null | undefined;
	episodes: ScopedEpisodeDisplay | null;
}> {
	const now = input.now ?? new Date();
	const maxAgeMs = input.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	const requested = [...new Set(input.showTmdbIds ?? [])];
	if (
		!Number.isFinite(now.getTime()) ||
		!Number.isFinite(maxAgeMs) ||
		maxAgeMs < 0 ||
		maxAgeMs > 7 * DEFAULT_MAX_AGE_MS ||
		requested.length > MAX_SCOPED_SHOWS ||
		requested.some((id) => !Number.isSafeInteger(id) || id <= 0)
	)
		throw new Error("Invalid Jellyfin episode display scope");
	async function readSnapshot(tx: Prisma.TransactionClient) {
		const instance = await tx.serviceInstance.findFirst({
			where: { id: input.instanceId, userId: input.userId, service: { in: ["JELLYFIN", "EMBY"] } },
			select: {
				id: true,
				service: true,
				enabled: true,
				expectedIdentity: true,
				identityStatus: true,
				connectionGeneration: true,
				identityGeneration: true,
			},
		});
		if (!instance || (instance.service !== "JELLYFIN" && instance.service !== "EMBY")) return null;
		const service = instance.service as "JELLYFIN" | "EMBY";
		const status = await tx.cacheRefreshStatus.findUnique({
			where: {
				instanceId_cacheType: { instanceId: instance.id, cacheType: "jellyfin_episode" },
			},
		});
		if (!status?.generationMetadata) return null;
		const decoded = decodeJellyfinEpisodeGenerationMetadata(status.generationMetadata);
		if (!decoded.ok || decoded.metadata.version !== 4) return null;
		const metadata = decoded.metadata as JellyfinEpisodeGenerationMetadataV4;
		const fail = (
			reason: "identity-unverified" | "receipt-invalid" | "rows-inconsistent",
		): JellyfinEpisodeObservation => ({
			available: false,
			instanceId: instance.id,
			service,
			cacheType: "jellyfin_episode",
			generationId: status.generationId,
			publishedAt: status.lastRefreshedAt,
			metadata: null,
			rows: [],
			providerStatus: unavailable(reason),
			mutationAvailable: false,
			authority: null,
		});
		if (
			!instance.enabled ||
			instance.identityStatus !== "VERIFIED" ||
			!instance.expectedIdentity?.trim()
		)
			return fail("identity-unverified");
		if (
			status.lastResult !== "success" ||
			!status.lastRefreshedAt ||
			status.lastRefreshedAt.getTime() > now.getTime() ||
			status.generationId?.trim() === "" ||
			!status.generationId ||
			status.itemCount !== metadata.itemCount ||
			status.connectionGeneration !== instance.connectionGeneration ||
			status.identityGeneration !== instance.identityGeneration ||
			metadata.connectionGeneration !== instance.connectionGeneration ||
			metadata.identityGeneration !== instance.identityGeneration ||
			metadata.provider !== (instance.service === "EMBY" ? "emby" : "jellyfin") ||
			metadata.coverageReceipt.observedAt !== status.lastRefreshedAt.toISOString()
		)
			return fail("receipt-invalid");
		const evaluation = evaluateProviderCoverageReceipt(metadata.coverageReceipt);
		if (!evaluation.valid || evaluation.publishedCanonicalEntities !== status.itemCount)
			return fail("receipt-invalid");
		const preparation = await tx.jellyfinEpisodePreparation.findUnique({
			where: { runId: status.generationId },
		});
		const pointer = await tx.jellyfinNativeWatchPublication.findUnique({
			where: { instanceId: instance.id },
			select: { activeRunId: true, activeCacheGenerationId: true },
		});
		if (
			preparation?.instanceId !== instance.id ||
			preparation.generationId !== status.generationId ||
			preparation.state !== "published" ||
			preparation.expectedRowCount !== status.itemCount ||
			preparation.contentFingerprint !== metadata.contentFingerprint ||
			preparation.observedAt?.getTime() !== status.lastRefreshedAt.getTime() ||
			(metadata.sourceVersion === 3 &&
				(pointer?.activeRunId !== status.generationId ||
					pointer.activeCacheGenerationId !== status.generationId))
		)
			return fail("rows-inconsistent");
		const originalCatalogIds =
			metadata.sourceVersion === 3 && metadata.publicationLevel === "positive-only"
				? new Set(metadata.catalogProvenance?.bindings.map((binding) => binding.tmdbId) ?? [])
				: null;
		const eligible = requested.filter((id) => !originalCatalogIds || originalCatalogIds.has(id));
		const receipts = eligible.length
			? await tx.jellyfinEpisodeGenerationShowReceipt.findMany({
					where: {
						instanceId: instance.id,
						generationId: status.generationId,
						showTmdbId: { in: eligible },
						instance: { userId: input.userId, enabled: true },
					},
					take: eligible.length,
				})
			: [];
		const receiptsByShow = new Map<number, (typeof receipts)[number]>();
		for (const receipt of receipts) {
			if (
				receipt.instanceId !== instance.id ||
				receipt.generationId !== status.generationId ||
				!eligible.includes(receipt.showTmdbId) ||
				receiptsByShow.has(receipt.showTmdbId)
			)
				return fail("rows-inconsistent");
			receiptsByShow.set(receipt.showTmdbId, receipt);
		}
		// Validate and discard each requested scope here to retain the existing
		// accepted-row cap plus one fetched scope, rather than retaining all scopes.
		const rows: JellyfinEpisodeRow[] = [];
		const receiptedShows: number[] = [];
		let incompleteRequestedScope = false;
		for (const showTmdbId of requested) {
			if (originalCatalogIds && !originalCatalogIds.has(showTmdbId)) {
				incompleteRequestedScope = true;
				continue;
			}
			const receipt = receiptsByShow.get(showTmdbId);
			if (!receipt) {
				incompleteRequestedScope = true;
				continue;
			}
			const showRows = await tx.jellyfinEpisodeGenerationRow.findMany({
				where: { instanceId: instance.id, generationId: status.generationId, showTmdbId },
				select: {
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
				},
				take: MAX_SCOPED_EPISODE_ROWS + 1,
			});
			if (
				showRows.length !== receipt.rowCount ||
				showRows.length + rows.length > MAX_SCOPED_EPISODE_ROWS ||
				showRows.some(
					(row) =>
						row.instanceId !== instance.id ||
						row.showTmdbId !== showTmdbId ||
						row.connectionGeneration !== instance.connectionGeneration ||
						row.identityGeneration !== instance.identityGeneration ||
						!row.jellyfinId.trim(),
				) ||
				fingerprintJellyfinEpisodeRows(showRows) !== receipt.contentFingerprint
			) {
				incompleteRequestedScope = true;
				continue;
			}
			rows.push(...showRows);
			if (input.includeSeriesProgressProof) receiptedShows.push(showTmdbId);
		}
		const parentSnapshot = await materializeOwnedJellyfinLibraryDisplayInTransaction(
			tx as unknown as TransactionReader,
			{ userId: input.userId, instanceId: instance.id, now, maxAgeMs },
		);
		return {
			instance,
			service,
			status,
			metadata,
			evaluation,
			fail,
			parentSnapshot,
			originalCatalogIds,
			rows,
			receiptedShows,
			incompleteRequestedScope,
		};
	}
	const snapshot = await input.prisma.$transaction(readSnapshot, transactionOptions);
	if (!snapshot || "available" in snapshot) return { library: undefined, episodes: snapshot };
	const {
		instance,
		service,
		status,
		metadata,
		evaluation,
		fail,
		parentSnapshot,
		originalCatalogIds,
		rows,
		receiptedShows,
		incompleteRequestedScope,
	} = snapshot;
	// Parent row validation and canonical hashing must not occupy the outer lease,
	// including health reads which request no episode rows.
	const validatedParent = await validateOwnedJellyfinLibraryDisplaySnapshot(parentSnapshot);
	const parent =
		validatedParent?.cacheType === "jellyfin" &&
		validatedParent.instanceId === instance.id &&
		validatedParent.service === service
			? validatedParent
			: null;
	if (
		!parent?.available ||
		!parent.metadata ||
		!parent.generationId ||
		!parent.publishedAt ||
		!hasJellyfinEpisodeParentReceipt(parent.metadata.coverageReceipt)
	)
		return { library: parent, episodes: fail("rows-inconsistent") };
	const exactParent =
		metadata.parentLibraryGenerationId === parent.generationId &&
		metadata.parentLibraryMetadataFingerprint ===
			fingerprintJellyfinLibraryGenerationMetadata(parent.metadata);
	const currentScopes = jellyfinEpisodeCatalogScopesFromReceipt(parent.metadata.coverageReceipt);
	const catalogCompatible =
		originalCatalogIds !== null &&
		metadata.catalogProvenance !== undefined &&
		currentScopes !== null &&
		isJellyfinEpisodeCatalogCompatible(
			metadata.catalogProvenance,
			parent.rows as JellyfinLibraryRowFingerprintInput[],
			currentScopes,
		);
	if (
		metadata.sourceVersion === 3 && metadata.publicationLevel === "positive-only"
			? !catalogCompatible
			: metadata.parentLibraryDependencyFingerprint !==
				fingerprintJellyfinEpisodeParentDependency(
					instance.id,
					parent.metadata,
					parent.rows as JellyfinLibraryRowFingerprintInput[],
				)
	)
		return { library: parent, episodes: fail("rows-inconsistent") };
	const parentCurrent =
		exactParent &&
		(parent.providerStatus.availability === "current" ||
			parent.providerStatus.availability === "partial") &&
		now.getTime() - parent.publishedAt.getTime() <= maxAgeMs;

	let providerStatus = projectProviderObservationStatus({
		identity: "current",
		publication: { observedAt: status.lastRefreshedAt, evaluation },
		latestAttempt: attemptFromStatus(status),
		now,
		maxAgeMs,
	});
	if (!parentCurrent && providerStatus.availability !== "unavailable") {
		providerStatus = {
			...providerStatus,
			availability: "last-known",
			reasonCodes: [...new Set([...providerStatus.reasonCodes, "publication-superseded" as const])],
		};
	}
	const seriesProgressProof =
		providerStatus.availability === "current" &&
		providerStatus.evidence === "complete" &&
		receiptedShows.length > 0
			? new Map<number, EpisodeCoordinate[]>(receiptedShows.map((showTmdbId) => [showTmdbId, []]))
			: undefined;
	if (incompleteRequestedScope && providerStatus.availability !== "unavailable") {
		providerStatus = {
			...providerStatus,
			availability: "partial",
			evidence: "positive-only",
			reasonCodes: [...new Set([...providerStatus.reasonCodes, "coverage-incomplete" as const])],
		};
	}
	const visibleRows =
		providerStatus.evidence === "complete"
			? rows
			: rows.filter(({ showTmdbId, seasonNumber, episodeNumber, watched }) => {
					if (watched) return true;
					seriesProgressProof?.get(showTmdbId)?.push({ seasonNumber, episodeNumber, watched });
					return false;
				});
	return {
		library: parent,
		episodes: {
			available: providerStatus.availability !== "unavailable",
			instanceId: instance.id,
			service,
			cacheType: "jellyfin_episode",
			generationId: status.generationId,
			publishedAt: status.lastRefreshedAt,
			metadata,
			rows: visibleRows,
			providerStatus,
			...(seriesProgressProof && { [jellyfinSeriesProgressProof]: seriesProgressProof }),
			mutationAvailable: false,
			authority: null,
		},
	};
}
