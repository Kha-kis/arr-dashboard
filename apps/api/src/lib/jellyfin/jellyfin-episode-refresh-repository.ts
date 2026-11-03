import { createHash } from "node:crypto";
import { withIsolatedRuntimePrismaTransaction } from "../backup/restore-runtime-client.js";
import {
	type JellyfinEpisodeObservationExclusion,
	type JellyfinEpisodeObservationStage,
	Prisma,
	type PrismaClient,
	type ProviderObservationUnit,
} from "../prisma.js";
import type {
	ObservationRunUnitSeed,
	ObservationUnitClaim,
} from "../provider-observation/observation-run-types.js";
import {
	buildObservationActiveSlotKey,
	buildObservationAuthorityKey,
} from "../provider-observation/observation-run-types.js";
import type { ProviderCacheRefreshAttempt } from "../services/provider-cache-status.js";
import { withSqliteTransactionWriteIntent } from "../sqlite-transaction-intent.js";
import { JELLYFIN_CACHE_PUBLICATION_CHUNK_SIZE } from "./jellyfin-cache-refresher.js";
import type { JellyfinEpisodeItemsPage } from "./jellyfin-client.js";
import {
	buildJellyfinEpisodeCatalogProvenance,
	decodeJellyfinEpisodeCatalogProvenance,
	isJellyfinEpisodeCatalogCompatible,
	JELLYFIN_EPISODE_PARENT_V3_KEY_PREFIX,
	type JellyfinEpisodeCatalogProvenance,
	jellyfinEpisodeCatalogGenerationKey,
	jellyfinEpisodeCatalogScopesFromReceipt,
} from "./jellyfin-episode-catalog-provenance.js";
import {
	fingerprintJellyfinEpisodeParentDependency,
	JELLYFIN_EPISODE_PARENT_KEY_PREFIX,
	jellyfinEpisodeParentGenerationKey,
} from "./jellyfin-episode-parent-dependency.js";
import { JELLYFIN_EPISODE_SUCCESSFUL_PROGRESS_CONTINUATION_DELAY_MS } from "./jellyfin-episode-refresh-policy.js";
import {
	decodeJellyfinEpisodeGenerationMetadata,
	decodeJellyfinLibraryGenerationMetadata,
	encodeJellyfinEpisodeGenerationMetadata,
	fingerprintJellyfinEpisodeRows,
	fingerprintJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
	hasAuthoritativeJellyfinLibraryReceipt,
	hasJellyfinEpisodeParentReceipt,
	type JellyfinLibraryRowFingerprintInput,
} from "./jellyfin-generation-metadata.js";
import { serializeNativeWatchScopeDiagnostics } from "./jellyfin-native-watch-diagnostics.js";
import {
	deriveNativeWatchCandidates,
	emptyNativeWatchProjectionDiagnostics,
	type NativeWatchProjectionDiagnostics,
	type NativeWatchScopedProjectionDiagnostics,
} from "./jellyfin-native-watch-projection.js";
import {
	type NativeWatchPublicationInput,
	publishNativeWatchGeneration,
	publishPreparedNativeWatchGeneration,
} from "./jellyfin-native-watch-repository.js";

export interface JellyfinEpisodeScope {
	userId: string;
	userName: string;
	libraryId: string;
}

export interface JellyfinEpisodeParentProvenance {
	parentLibraryGenerationId: string;
	parentLibraryMetadataFingerprint: string;
	parentLibraryDependencyFingerprint?: string;
}

export interface JellyfinEpisodePlanProvenance extends JellyfinEpisodeParentProvenance {
	catalogProvenance?: JellyfinEpisodeCatalogProvenance;
}

export type JellyfinEpisodePageSize = 1_000 | 2_000;
export const JELLYFIN_EPISODE_NEW_RUN_PAGE_SIZE: JellyfinEpisodePageSize = 2_000;
export const MAX_JELLYFIN_FINALIZER_STAGE_ROWS = 600_000;
const JELLYFIN_FINALIZER_STAGE_READ_PAGE_SIZE = 1_000;

/** Absence is the immutable page size of runs admitted before the larger-page rollout. */
export function jellyfinEpisodePageSizeFromPayload(
	payload: string | null,
): JellyfinEpisodePageSize | null {
	if (!payload) return null;
	try {
		const value: unknown = JSON.parse(payload);
		if (typeof value !== "object" || value === null) return null;
		const size = (value as { pageSize?: unknown }).pageSize;
		return size === undefined || size === 1_000 ? 1_000 : size === 2_000 ? 2_000 : null;
	} catch {
		return null;
	}
}

export function hasPlausibleJellyfinEpisodePageCount(
	observedRawCount: number,
	completedPages: number,
	pageSize: JellyfinEpisodePageSize,
): boolean {
	return (
		Number.isSafeInteger(observedRawCount) &&
		observedRawCount >= 0 &&
		Number.isSafeInteger(completedPages) &&
		completedPages >= Math.max(1, Math.ceil(observedRawCount / pageSize)) &&
		completedPages <= Math.max(1, observedRawCount)
	);
}

export type JellyfinEpisodePageRejectionReason =
	| "invalid-scope-or-phase"
	| "total-count-decreased"
	| "invalid-page-envelope-or-row"
	| "run-unavailable"
	| "catalog-authority-mismatch"
	| "instance-authority-mismatch"
	| "claim-mismatch"
	| "cursor-accounting-mismatch"
	| "source-coordinate-conflict";

export type JellyfinEpisodePageRejectionReporter = (
	reason: JellyfinEpisodePageRejectionReason,
) => void;

function validParentProvenance(value: unknown): value is JellyfinEpisodeParentProvenance {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<JellyfinEpisodeParentProvenance>;
	return (
		typeof candidate.parentLibraryGenerationId === "string" &&
		candidate.parentLibraryGenerationId.trim() !== "" &&
		candidate.parentLibraryGenerationId.length <= 256 &&
		typeof candidate.parentLibraryMetadataFingerprint === "string" &&
		/^[a-f0-9]{64}$/.test(candidate.parentLibraryMetadataFingerprint) &&
		(candidate.parentLibraryDependencyFingerprint === undefined ||
			(typeof candidate.parentLibraryDependencyFingerprint === "string" &&
				/^[a-f0-9]{64}$/.test(candidate.parentLibraryDependencyFingerprint)))
	);
}

function parseParentProvenance(payload: string | null): JellyfinEpisodeParentProvenance | null {
	try {
		const value: unknown = payload === null ? null : JSON.parse(payload);
		return validParentProvenance(value)
			? {
					parentLibraryGenerationId: value.parentLibraryGenerationId,
					parentLibraryMetadataFingerprint: value.parentLibraryMetadataFingerprint,
					...(value.parentLibraryDependencyFingerprint
						? { parentLibraryDependencyFingerprint: value.parentLibraryDependencyFingerprint }
						: {}),
				}
			: null;
	} catch {
		return null;
	}
}

export const JELLYFIN_EPISODE_PARENT_MUTATION_AUTHORITY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function finalizationUnitFingerprint(units: readonly ProviderObservationUnit[]): string {
	return digest(
		[...units]
			.sort((left, right) => left.ordinal - right.ordinal)
			.map((unit) => [
				unit.id,
				unit.ordinal,
				unit.scopeKey,
				unit.scopeDigest,
				unit.scopePayload,
				unit.phase,
				unit.expectedTargets,
				unit.expectedRawCount,
				unit.cursor,
				unit.observedRawCount,
				unit.state,
				unit.claimToken,
			]),
	);
}

function canonicalScopes(scopes: readonly JellyfinEpisodeScope[]) {
	const normalized = scopes.map((scope) => {
		if (
			typeof scope.userId !== "string" ||
			scope.userId.trim() === "" ||
			typeof scope.libraryId !== "string" ||
			scope.libraryId.trim() === ""
		) {
			throw new Error("Jellyfin episode scope is invalid");
		}
		return { userId: scope.userId, libraryId: scope.libraryId };
	});
	normalized.sort(
		(left, right) =>
			left.userId.localeCompare(right.userId) || left.libraryId.localeCompare(right.libraryId),
	);
	if (
		new Set(normalized.map((scope) => `${scope.userId}\u0000${scope.libraryId}`)).size !==
		normalized.length
	) {
		throw new Error("Jellyfin episode scope is ambiguous");
	}
	return normalized;
}

export type JellyfinEpisodeFinalizationTiming = {
	authorityMs: number;
	stageLoadMs: number;
	computeMs: number;
	episodeWriteMs: number;
	nativeProjectionMs: number;
	nativeWatchWriteMs: number;
	totalMs: number;
	stageRows: number;
	nativeCandidates: number;
	nativeWatchDiagnostics?: NativeWatchProjectionDiagnostics;
};

export interface FinalizeJellyfinEpisodeRunInput {
	prisma: PrismaClient;
	/** Existing provider-authority transaction; omitted for direct repository callers. */
	transaction?: Prisma.TransactionClient;
	userId: string;
	instance: { id: string };
	runId: string;
	scopes?: readonly JellyfinEpisodeScope[];
	attempt?: ProviderCacheRefreshAttempt;
	now?: Date;
	/** Numeric diagnostics only; a reporting failure cannot alter publication. */
	recordTiming?: (timing: JellyfinEpisodeFinalizationTiming, rawTotalMs: number) => void;
	/** Test-only fault injection; production callers never provide these hooks. */
	testHooks?: {
		beforePublish?: (tx: Prisma.TransactionClient) => void | Promise<void>;
		afterPublish?: (tx: Prisma.TransactionClient) => void | Promise<void>;
		commitClock?: () => Date;
	};
}

type PreparedEpisodeRow = {
	showTmdbId: number;
	seasonNumber: number;
	episodeNumber: number;
	jellyfinId: string;
	title: string;
	watched: boolean;
	watchedByUsers: string;
	lastWatchedAt: Date | null;
};

type PreparedRunAuthority = {
	instanceId: string;
	userId: string;
	runId: string;
	authorityKey: string;
	parentGenerationId: string | null;
	targetDigest: string;
	completedUnits: number;
	completedWork: number;
	totalUnits: number;
	totalWork: number;
	connectionGeneration: number;
	identityGeneration: number;
};

export type PreparedJellyfinEpisodeRun =
	| { kind: "not-published" }
	| { kind: "invalid"; authority: PreparedRunAuthority }
	| {
			kind: "ready";
			authority: PreparedRunAuthority;
			observedAt: Date;
			cacheGenerationId: string;
			publishedRows: readonly PreparedEpisodeRow[];
			coveredShowTmdbIds: readonly number[] | null;
			contentFingerprint: string;
			/** Set only after the invisible generation has passed exact readback. */
			episodePreparationToken?: string;
			generationMetadata: string;
			nativePublication: NativeWatchPublicationInput | null;
			attempt: ProviderCacheRefreshAttempt;
			scopesFingerprint: string;
			unitFingerprint: string;
			priorCacheGenerationId: string | null;
			parentStatus: {
				generationId: string;
				generationMetadata: string | null;
				lastRefreshedAt: Date;
				itemCount: number;
			};
			statusId: string;
	  };

/**
 * Scope payloads contain opaque IDs and, for V2, the original parent provenance.
 * Provenance does not change the structural plan identity: resuming a compatible
 * run retains its saved provenance instead of inheriting newer watch authority.
 * Verify units carry zero work so the generic coordinator retains the scope count.
 */
export function buildJellyfinEpisodeScopePlan(
	scopes: readonly JellyfinEpisodeScope[],
	parentProvenance?: JellyfinEpisodePlanProvenance,
	pageSize: JellyfinEpisodePageSize = 1_000,
): {
	targetDigest: string;
	targetCount: number;
	units: readonly ObservationRunUnitSeed[];
} {
	if (parentProvenance !== undefined && !validParentProvenance(parentProvenance)) {
		throw new Error("Jellyfin episode parent provenance is invalid");
	}
	if (pageSize !== 1_000 && pageSize !== 2_000) {
		throw new Error("Jellyfin episode page size is invalid");
	}
	const pageSizePayload = pageSize === 2_000 ? { pageSize } : {};
	const provenance =
		parentProvenance === undefined
			? {}
			: {
					parentLibraryGenerationId: parentProvenance.parentLibraryGenerationId,
					parentLibraryMetadataFingerprint: parentProvenance.parentLibraryMetadataFingerprint,
					...(parentProvenance.parentLibraryDependencyFingerprint
						? {
								parentLibraryDependencyFingerprint:
									parentProvenance.parentLibraryDependencyFingerprint,
							}
						: {}),
				};
	const catalog = parentProvenance?.catalogProvenance;
	const catalogGenerationKey = catalog ? jellyfinEpisodeCatalogGenerationKey(catalog) : null;
	if (catalog && !catalogGenerationKey) throw new Error("Jellyfin episode catalog is invalid");
	const catalogReference = catalogGenerationKey ? { catalogGenerationKey } : {};
	const canonical = canonicalScopes(scopes);
	const collect = canonical.map(
		(scope, ordinal): ObservationRunUnitSeed => ({
			ordinal,
			scopeKey: `collect:${scope.userId}:${scope.libraryId}`,
			scopeDigest: digest(["jellyfin-episode", "collect", scope.userId, scope.libraryId]),
			scopePayload: JSON.stringify({
				...scope,
				...provenance,
				...pageSizePayload,
				...(catalog ? (ordinal === 0 ? { catalogProvenance: catalog } : catalogReference) : {}),
			}),
			phase: "collect",
			expectedTargets: 1,
		}),
	);
	const verify = canonical.map(
		(scope, index): ObservationRunUnitSeed => ({
			ordinal: canonical.length + index,
			scopeKey: `verify:${scope.userId}:${scope.libraryId}`,
			scopeDigest: digest(["jellyfin-episode", "verify", scope.userId, scope.libraryId]),
			scopePayload: JSON.stringify({
				...scope,
				...provenance,
				...pageSizePayload,
				...catalogReference,
			}),
			phase: "verify",
			expectedTargets: 0,
		}),
	);
	return {
		targetDigest: digest(canonical),
		targetCount: canonical.length,
		units: [...collect, ...verify],
	};
}

type JellyfinEpisodeSavedPlanRun = {
	provider: string;
	cacheType: string;
	instanceId: string;
	parentGenerationId: string | null;
	authorityKey: string;
	totalUnits: number;
	targetDigest: string;
	targetCount: number;
	connectionGeneration: number;
	identityGeneration: number;
	state: string;
	activeSlotKey: string | null;
};

type JellyfinEpisodeSavedPlanUnit = {
	ordinal: number;
	scopeKey: string;
	scopeDigest: string;
	scopePayload: string | null;
	phase: string;
	expectedTargets: number;
	state: string;
};

/**
 * Reconstructs only a bounded, structurally exact V2 plan from durable rows.
 * The returned names are deliberately empty: names are display data and must
 * be rediscovered inside the final guarded publication phase.
 */
export function validateJellyfinEpisodeSavedV2Plan(input: {
	run: JellyfinEpisodeSavedPlanRun;
	units: readonly JellyfinEpisodeSavedPlanUnit[];
	instanceId: string;
	parentGenerationId: string;
	connectionGeneration: number;
	identityGeneration: number;
}): {
	plan: ReturnType<typeof buildJellyfinEpisodeScopePlan>;
	scopes: JellyfinEpisodeScope[];
} | null {
	return validateJellyfinEpisodeSavedPlan(input, 2);
}

export function validateJellyfinEpisodeSavedV3Plan(input: {
	run: JellyfinEpisodeSavedPlanRun;
	units: readonly JellyfinEpisodeSavedPlanUnit[];
	instanceId: string;
	parentGenerationId: string;
	connectionGeneration: number;
	identityGeneration: number;
}): {
	plan: ReturnType<typeof buildJellyfinEpisodeScopePlan>;
	scopes: JellyfinEpisodeScope[];
} | null {
	return validateJellyfinEpisodeSavedPlan(input, 3);
}

function validateJellyfinEpisodeSavedPlan(
	input: {
		run: JellyfinEpisodeSavedPlanRun;
		units: readonly JellyfinEpisodeSavedPlanUnit[];
		instanceId: string;
		parentGenerationId: string;
		connectionGeneration: number;
		identityGeneration: number;
	},
	expectedVersion: 2 | 3,
): {
	plan: ReturnType<typeof buildJellyfinEpisodeScopePlan>;
	scopes: JellyfinEpisodeScope[];
} | null {
	try {
		const { run, units } = input;
		if (
			run.provider !== "jellyfin_episode" ||
			run.cacheType !== "jellyfin_episode" ||
			run.instanceId !== input.instanceId ||
			run.parentGenerationId !== input.parentGenerationId ||
			run.connectionGeneration !== input.connectionGeneration ||
			run.identityGeneration !== input.identityGeneration ||
			!(
				run.state === "running" ||
				(expectedVersion === 3 &&
					run.state === "failed" &&
					units.some((unit) => unit.state === "failed") &&
					!units.some((unit) => unit.state === "running"))
			) ||
			run.activeSlotKey === null ||
			run.targetCount <= 0 ||
			!Number.isSafeInteger(run.targetCount) ||
			typeof run.parentGenerationId !== "string" ||
			!(expectedVersion === 2
				? run.parentGenerationId.startsWith(JELLYFIN_EPISODE_PARENT_KEY_PREFIX)
				: run.parentGenerationId.startsWith(JELLYFIN_EPISODE_PARENT_V3_KEY_PREFIX)) ||
			!/^[a-f0-9]{64}$/.test(
				run.parentGenerationId.slice(
					expectedVersion === 2
						? JELLYFIN_EPISODE_PARENT_KEY_PREFIX.length
						: JELLYFIN_EPISODE_PARENT_V3_KEY_PREFIX.length,
				),
			) ||
			units.length === 0 ||
			units.length > 20_000 ||
			units.length !== run.totalUnits ||
			units.length !== run.targetCount * 2
		)
			return null;
		const authority = {
			provider: "jellyfin_episode" as const,
			cacheType: "jellyfin_episode" as const,
			instanceId: run.instanceId,
			parentGenerationId: run.parentGenerationId,
			targetDigest: run.targetDigest,
			connectionGeneration: run.connectionGeneration,
			identityGeneration: run.identityGeneration,
		};
		if (
			run.authorityKey !== buildObservationAuthorityKey(authority) ||
			run.activeSlotKey !== buildObservationActiveSlotKey(authority)
		)
			return null;
		const scopesByKey = new Map<string, JellyfinEpisodeScope>();
		const ordinals = new Set<number>();
		const pageSize = jellyfinEpisodePageSizeFromPayload(units[0]?.scopePayload ?? null);
		if (pageSize === null) return null;
		let provenance: JellyfinEpisodeParentProvenance | undefined;
		let catalogProvenance: JellyfinEpisodeCatalogProvenance | undefined;
		for (const unit of units) {
			if (
				!Number.isSafeInteger(unit.ordinal) ||
				unit.ordinal < 0 ||
				unit.ordinal >= units.length ||
				ordinals.has(unit.ordinal) ||
				(unit.phase !== "collect" && unit.phase !== "verify") ||
				unit.expectedTargets !== (unit.phase === "collect" ? 1 : 0) ||
				!["pending", "running", "complete", "failed"].includes(unit.state) ||
				typeof unit.scopePayload !== "string"
			)
				return null;
			ordinals.add(unit.ordinal);
			const payload = JSON.parse(unit.scopePayload);
			if (
				typeof payload !== "object" ||
				payload === null ||
				typeof (payload as { userId?: unknown }).userId !== "string" ||
				typeof (payload as { libraryId?: unknown }).libraryId !== "string"
			)
				return null;
			const scope = {
				userId: (payload as { userId: string }).userId,
				userName: "",
				libraryId: (payload as { libraryId: string }).libraryId,
			};
			if (scope.userId.trim() === "" || scope.libraryId.trim() === "") return null;
			const payloadKeys = Object.keys(payload as object)
				.sort()
				.join("\0");
			const expectedPayloadKeys =
				expectedVersion === 3
					? `${unit.ordinal === 0 ? "catalogProvenance" : "catalogGenerationKey"}\0libraryId\0${pageSize === 2_000 ? "pageSize\0" : ""}parentLibraryDependencyFingerprint\0parentLibraryGenerationId\0parentLibraryMetadataFingerprint\0userId`
					: `libraryId\0${pageSize === 2_000 ? "pageSize\0" : ""}parentLibraryGenerationId\0parentLibraryMetadataFingerprint\0userId`;
			if (
				payloadKeys !== expectedPayloadKeys ||
				jellyfinEpisodePageSizeFromPayload(unit.scopePayload) !== pageSize
			)
				return null;
			const unitProvenance = parseParentProvenance(unit.scopePayload);
			if (!unitProvenance) return null;
			const unitCatalog =
				expectedVersion === 3 && unit.ordinal === 0
					? decodeJellyfinEpisodeCatalogProvenance(
							(payload as Record<string, unknown>).catalogProvenance,
						)
					: null;
			if (expectedVersion === 3) {
				if (unit.ordinal === 0 && !unitCatalog) return null;
				if (
					unit.ordinal !== 0 &&
					(payload as Record<string, unknown>).catalogGenerationKey !== run.parentGenerationId
				)
					return null;
			}
			if (
				expectedVersion === 3 &&
				unitCatalog &&
				jellyfinEpisodeCatalogGenerationKey(unitCatalog) !== run.parentGenerationId
			)
				return null;
			if (
				provenance &&
				(provenance.parentLibraryGenerationId !== unitProvenance.parentLibraryGenerationId ||
					provenance.parentLibraryMetadataFingerprint !==
						unitProvenance.parentLibraryMetadataFingerprint)
			)
				return null;
			provenance = unitProvenance;
			if (unitCatalog) {
				if (catalogProvenance && JSON.stringify(catalogProvenance) !== JSON.stringify(unitCatalog))
					return null;
				catalogProvenance = unitCatalog;
			}
			const scopeKey = JSON.stringify([scope.userId, scope.libraryId]);
			if (unit.phase === "collect") {
				if (scopesByKey.has(scopeKey)) return null;
				scopesByKey.set(scopeKey, scope);
			}
		}
		if (
			!provenance ||
			scopesByKey.size !== run.targetCount ||
			(expectedVersion === 3 && !catalogProvenance)
		)
			return null;
		const scopes = [...scopesByKey.values()];
		const plan = buildJellyfinEpisodeScopePlan(
			scopes,
			{
				...provenance,
				...(catalogProvenance ? { catalogProvenance } : {}),
			},
			pageSize,
		);
		if (plan.targetDigest !== run.targetDigest || plan.units.length !== units.length) return null;
		for (const unit of units) {
			const expected = plan.units[unit.ordinal];
			if (
				!expected ||
				unit.scopeKey !== expected.scopeKey ||
				unit.scopeDigest !== expected.scopeDigest ||
				unit.scopePayload !== (expected.scopePayload ?? null) ||
				unit.phase !== expected.phase ||
				unit.expectedTargets !== expected.expectedTargets
			)
				return null;
		}
		return { plan, scopes };
	} catch {
		return null;
	}
}

function scopeDigest(phase: "collect" | "verify", scope: { userId: string; libraryId: string }) {
	return digest(["jellyfin-episode", phase, scope.userId, scope.libraryId]);
}

function parseScope(value: string | null) {
	if (!value) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof (parsed as { userId?: unknown }).userId !== "string" ||
			typeof (parsed as { libraryId?: unknown }).libraryId !== "string"
		)
			return null;
		return parsed as { userId: string; libraryId: string };
	} catch {
		return null;
	}
}

function pageRejectionReason(
	page: JellyfinEpisodeItemsPage,
	cursor: number,
	expected: number | null,
	pageSize: JellyfinEpisodePageSize,
	allowTotalDrift = false,
): JellyfinEpisodePageRejectionReason | null {
	if (
		!Number.isSafeInteger(page.startIndex) ||
		page.startIndex !== cursor ||
		!Number.isSafeInteger(page.totalRecordCount) ||
		page.totalRecordCount < 0 ||
		(expected !== null && !allowTotalDrift && page.totalRecordCount !== expected)
	)
		return "invalid-page-envelope-or-row";
	if (page.items.length > pageSize) return "invalid-page-envelope-or-row";
	if (page.items.length === 0 && cursor < page.totalRecordCount)
		return "invalid-page-envelope-or-row";
	if (cursor + page.items.length > page.totalRecordCount) return "invalid-page-envelope-or-row";
	const ids = new Set<string>();
	for (const item of page.items) {
		if (
			item.type !== "Episode" ||
			typeof item.id !== "string" ||
			!item.id.trim() ||
			ids.has(item.id)
		)
			return "invalid-page-envelope-or-row";
		ids.add(item.id);
		if (item.excludedReason !== undefined) {
			if (!allowTotalDrift || item.excludedReason !== "missing-episode-metadata")
				return "invalid-page-envelope-or-row";
			continue;
		}
		if (
			item.type !== "Episode" ||
			typeof item.id !== "string" ||
			item.id.length === 0 ||
			typeof item.seriesId !== "string" ||
			item.seriesId.length === 0 ||
			!Number.isSafeInteger(item.seasonNumber) ||
			(item.seasonNumber as number) < 0 ||
			!Number.isSafeInteger(item.episodeNumber) ||
			(item.episodeNumber as number) < 0 ||
			(item.playCount !== undefined &&
				item.playCount !== null &&
				(!Number.isSafeInteger(item.playCount) || item.playCount < 0)) ||
			typeof item.played !== "boolean" ||
			(item.lastPlayedDate !== null &&
				(typeof item.lastPlayedDate !== "string" ||
					!Number.isFinite(Date.parse(item.lastPlayedDate))))
		)
			return "invalid-page-envelope-or-row";
	}
	return null;
}

function reportPageRejection(
	onRejected: JellyfinEpisodePageRejectionReporter | undefined,
	reason: JellyfinEpisodePageRejectionReason,
): false {
	try {
		onRejected?.(reason);
	} catch {
		// Diagnostics must never change the durable page result.
	}
	return false;
}

/**
 * The only durable continuation transition. Provider data has already been
 * decoded before this transaction begins; this transaction re-proves the
 * exact claim and releases it back to pending after a non-final page.
 */
export async function stageJellyfinEpisodePage(
	prisma: PrismaClient,
	claim: ObservationUnitClaim,
	scope: JellyfinEpisodeScope,
	page: JellyfinEpisodeItemsPage,
	now = new Date(),
	onRejected?: JellyfinEpisodePageRejectionReporter,
): Promise<boolean> {
	const persistedScope = parseScope(claim.scopePayload);
	let catalogKey: string | null = null;
	try {
		const payload = JSON.parse(claim.scopePayload ?? "{}") as Record<string, unknown>;
		const catalog = decodeJellyfinEpisodeCatalogProvenance(payload.catalogProvenance);
		catalogKey = catalog
			? jellyfinEpisodeCatalogGenerationKey(catalog)
			: typeof payload.catalogGenerationKey === "string" &&
					/^jellyfin-episode-parent-v3:[a-f0-9]{64}$/.test(payload.catalogGenerationKey)
				? payload.catalogGenerationKey
				: null;
	} catch {
		catalogKey = null;
	}
	const allowV3TotalDrift = catalogKey !== null;
	const pageSize = jellyfinEpisodePageSizeFromPayload(claim.scopePayload);
	if (
		!persistedScope ||
		pageSize === null ||
		persistedScope.userId !== scope.userId ||
		persistedScope.libraryId !== scope.libraryId ||
		(claim.phase !== "collect" && claim.phase !== "verify")
	)
		return reportPageRejection(onRejected, "invalid-scope-or-phase");
	const pageReason = pageRejectionReason(
		page,
		claim.cursor,
		claim.expectedRawCount,
		pageSize,
		allowV3TotalDrift,
	);
	if (pageReason) return reportPageRejection(onRejected, pageReason);
	const userKeyDigest = digest(["jellyfin-user", scope.userId]);
	return await withSqliteTransactionWriteIntent(() =>
		withIsolatedRuntimePrismaTransaction(prisma, async (tx) => {
			const run = await tx.providerObservationRun.findFirst({
				where: {
					id: claim.runId,
					provider: "jellyfin_episode",
					cacheType: "jellyfin_episode",
					state: "running",
					activeSlotKey: { not: null },
					authorityKey: claim.authorityKey,
				},
				include: { instance: true },
			});
			if (!run) return reportPageRejection(onRejected, "run-unavailable");
			if (catalogKey !== null && catalogKey !== run.parentGenerationId)
				return reportPageRejection(onRejected, "catalog-authority-mismatch");
			if (
				!run.instance.enabled ||
				(run.instance.service !== "JELLYFIN" && run.instance.service !== "EMBY") ||
				run.instance.connectionGeneration !== run.connectionGeneration ||
				run.instance.identityGeneration !== run.identityGeneration
			)
				return reportPageRejection(onRejected, "instance-authority-mismatch");
			const unit = await tx.providerObservationUnit.findFirst({
				where: {
					id: claim.unitId,
					runId: run.id,
					state: "running",
					claimToken: claim.claimToken,
					phase: claim.phase,
					scopeKey: claim.scopeKey,
				},
			});
			if (
				!unit ||
				unit.cursor !== claim.cursor ||
				unit.expectedRawCount !== claim.expectedRawCount ||
				unit.observedRawCount !== claim.observedRawCount ||
				unit.scopePayload !== claim.scopePayload ||
				unit.scopeDigest !== scopeDigest(claim.phase, persistedScope)
			)
				return reportPageRejection(onRejected, "claim-mismatch");
			const nextCursor = page.startIndex + page.items.length;
			const observedRawCount = unit.observedRawCount + page.items.length;
			const expectedRawCount = page.totalRecordCount;
			if (nextCursor !== observedRawCount || nextCursor > expectedRawCount)
				return reportPageRejection(onRejected, "cursor-accounting-mismatch");
			if (page.items.length) {
				const admittedItems = page.items.filter((item) => item.excludedReason === undefined);
				const excludedItems = page.items.filter((item) => item.excludedReason !== undefined);
				let newItems = admittedItems;
				if (allowV3TotalDrift) {
					// Offset shifts may repeat an identity; retain its first observation only
					// when the same scan unit still proves the exact source coordinate.
					const existing = await tx.jellyfinEpisodeObservationStage.findMany({
						where: {
							runId: run.id,
							pass: claim.phase,
							userKeyDigest,
							jellyfinId: { in: page.items.map((item) => item.id) },
						},
						select: {
							unitId: true,
							jellyfinId: true,
							seriesId: true,
							seasonNumber: true,
							episodeNumber: true,
						},
					});
					const existingByItemId = new Map(existing.map((row) => [row.jellyfinId, row]));
					for (const item of admittedItems) {
						const prior = existingByItemId.get(item.id);
						if (!prior) continue;
						if (
							prior.unitId !== unit.id ||
							prior.seriesId !== item.seriesId ||
							prior.seasonNumber !== item.seasonNumber ||
							prior.episodeNumber !== item.episodeNumber
						)
							return reportPageRejection(onRejected, "source-coordinate-conflict");
					}
					newItems = admittedItems.filter((item) => !existingByItemId.has(item.id));
					const priorExclusions = await tx.jellyfinEpisodeObservationExclusion.findMany({
						where: {
							runId: run.id,
							pass: claim.phase,
							userKeyDigest,
							jellyfinId: { in: page.items.map((item) => item.id) },
						},
					});
					if (
						priorExclusions.some(
							(row) => row.unitId !== unit.id || row.reason !== "missing-episode-metadata",
						)
					)
						return reportPageRejection(onRejected, "source-coordinate-conflict");
					const priorExcludedIds = new Set(priorExclusions.map((row) => row.jellyfinId));
					const newExclusions = excludedItems.filter((item) => !priorExcludedIds.has(item.id));
					if (newExclusions.length)
						await tx.jellyfinEpisodeObservationExclusion.createMany({
							data: newExclusions.map((item) => ({
								runId: run.id,
								unitId: unit.id,
								pass: claim.phase,
								userKeyDigest,
								jellyfinId: item.id,
								reason: item.excludedReason,
							})),
						});
				}
				if (newItems.length) {
					await tx.jellyfinEpisodeObservationStage.createMany({
						data: newItems.map((item) => ({
							runId: run.id,
							unitId: unit.id,
							userKeyDigest,
							pass: claim.phase,
							jellyfinId: item.id,
							seriesId: item.seriesId!,
							seasonNumber: item.seasonNumber!,
							episodeNumber: item.episodeNumber!,
							title: item.name,
							played: item.played,
							playCount: item.playCount ?? null,
							lastPlayedAt: item.lastPlayedDate ? new Date(item.lastPlayedDate) : null,
							// The legacy stage schema requires this column, but usernames are
							// display data rather than durable observation authority.
							userName: "",
						})),
					});
				}
			}
			const complete = nextCursor === expectedRawCount;
			const updated = await tx.providerObservationUnit.updateMany({
				where: { id: unit.id, runId: run.id, state: "running", claimToken: claim.claimToken },
				data: complete
					? {
							state: "complete",
							claimToken: null,
							cursor: nextCursor,
							expectedRawCount,
							observedRawCount,
							completedPages: { increment: 1 },
							nextAttemptAt: null,
							completedAt: now,
						}
					: {
							state: "pending",
							claimToken: null,
							cursor: nextCursor,
							expectedRawCount,
							observedRawCount,
							completedPages: { increment: 1 },
							nextAttemptAt: new Date(
								now.getTime() + JELLYFIN_EPISODE_SUCCESSFUL_PROGRESS_CONTINUATION_DELAY_MS,
							),
						},
			});
			if (updated.count !== 1) throw new Error("Jellyfin episode page claim was superseded");
			if (!complete) return true;
			const advanced = await tx.providerObservationRun.updateMany({
				where: { id: run.id, state: "running", activeSlotKey: { not: null } },
				data: {
					completedUnits: { increment: 1 },
					completedWork: { increment: unit.expectedTargets },
				},
			});
			if (advanced.count !== 1) throw new Error("Jellyfin episode run was superseded");
			return true;
		}),
	);
}

/**
 * Discards only this run's unpublished evidence and releases its active slot.
 * It deliberately never touches the published episode cache or its generation.
 */
export async function invalidateJellyfinEpisodeRun(
	prisma: PrismaClient,
	runId: string,
	now = new Date(),
): Promise<boolean> {
	return await prisma.$transaction(async (tx) => {
		const run = await tx.providerObservationRun.findFirst({
			where: {
				id: runId,
				provider: "jellyfin_episode",
				cacheType: "jellyfin_episode",
				state: { in: ["running", "failed"] },
				activeSlotKey: { not: null },
			},
			select: { id: true },
		});
		if (!run) return false;
		await tx.jellyfinEpisodeObservationExclusion.deleteMany({ where: { runId } });
		await tx.jellyfinEpisodeObservationStage.deleteMany({ where: { runId } });
		await tx.providerObservationUnit.updateMany({
			where: { runId, state: { not: "invalidated" } },
			data: { state: "invalidated", claimToken: null, nextAttemptAt: null },
		});
		const invalidated = await tx.providerObservationRun.updateMany({
			where: { id: runId, state: { in: ["running", "failed"] }, activeSlotKey: { not: null } },
			data: { state: "invalidated", activeSlotKey: null, nextAttemptAt: null, completedAt: now },
		});
		return invalidated.count === 1;
	});
}

function canonicalStageRows(
	rows: readonly {
		userKeyDigest: string;
		jellyfinId: string;
		seriesId: string;
		seasonNumber: number;
		episodeNumber: number;
		played: boolean;
		playCount: number | null;
		lastPlayedAt: Date | null;
	}[],
	stableCoordinates = false,
) {
	return rows
		.map((row) => [
			row.userKeyDigest,
			row.jellyfinId,
			row.seriesId,
			row.seasonNumber,
			row.episodeNumber,
			...(stableCoordinates
				? []
				: [row.played, row.playCount, row.lastPlayedAt?.toISOString() ?? null]),
		])
		.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function hasV3StableCoordinateSuperset(
	collect: readonly {
		userKeyDigest: string;
		jellyfinId: string;
		seriesId: string;
		seasonNumber: number;
		episodeNumber: number;
	}[],
	verify: readonly {
		userKeyDigest: string;
		jellyfinId: string;
		seriesId: string;
		seasonNumber: number;
		episodeNumber: number;
	}[],
): boolean {
	const byItem = new Map<string, string>();
	for (const row of verify) {
		const itemKey = `${row.userKeyDigest}\u0000${row.jellyfinId}`;
		const coordinate = `${row.seriesId}\u0000${row.seasonNumber}\u0000${row.episodeNumber}`;
		const prior = byItem.get(itemKey);
		if (prior !== undefined && prior !== coordinate) return false;
		byItem.set(itemKey, coordinate);
	}
	const seenCollected = new Set<string>();
	for (const row of collect) {
		const itemKey = `${row.userKeyDigest}\u0000${row.jellyfinId}`;
		const coordinate = `${row.seriesId}\u0000${row.seasonNumber}\u0000${row.episodeNumber}`;
		if (seenCollected.has(itemKey) || byItem.get(itemKey) !== coordinate) return false;
		seenCollected.add(itemKey);
	}
	return true;
}

function hasV3ExactPassEquality(
	collect: readonly {
		userKeyDigest: string;
		jellyfinId: string;
		seriesId: string;
		seasonNumber: number;
		episodeNumber: number;
		played: boolean;
		playCount: number | null;
		lastPlayedAt: Date | null;
	}[],
	verify: readonly {
		userKeyDigest: string;
		jellyfinId: string;
		seriesId: string;
		seasonNumber: number;
		episodeNumber: number;
		played: boolean;
		playCount: number | null;
		lastPlayedAt: Date | null;
	}[],
): boolean {
	return (
		collect.length === verify.length &&
		JSON.stringify(canonicalStageRows(collect)) === JSON.stringify(canonicalStageRows(verify))
	);
}

function hasV3ExactNativeIdentityConsistency(
	rows: readonly {
		jellyfinId: string;
		seriesId: string;
		seasonNumber: number;
		episodeNumber: number;
	}[],
): boolean {
	const coordinatesByItemId = new Map<string, string>();
	for (const row of rows) {
		const coordinate = `${row.seriesId}\u0000${row.seasonNumber}\u0000${row.episodeNumber}`;
		const prior = coordinatesByItemId.get(row.jellyfinId);
		if (prior !== undefined && prior !== coordinate) return false;
		coordinatesByItemId.set(row.jellyfinId, coordinate);
	}
	return true;
}

/**
 * Finalization begins with a strict no-mutation gate. Publication is only
 * permitted after every completed scope has an identical collect/verify view;
 * callers layer current-parent and attempt reproof before the replacement step.
 */
async function evaluateJellyfinEpisodeRun(
	input: FinalizeJellyfinEpisodeRunInput,
	mode: "prepare" | "publish",
): Promise<PreparedJellyfinEpisodeRun | { published: boolean; itemCount: number }> {
	const now = input.now ?? new Date();
	const finalize = async (tx: Prisma.TransactionClient) => {
		const startedAt = performance.now();
		const instance = await tx.serviceInstance.findFirst({
			where: { id: input.instance.id, userId: input.userId, enabled: true },
		});
		const run = await tx.providerObservationRun.findFirst({
			where: {
				id: input.runId,
				instanceId: input.instance.id,
				provider: "jellyfin_episode",
				cacheType: "jellyfin_episode",
				state: "running",
				activeSlotKey: { not: null },
			},
			include: { units: true },
		});
		// A caller that cannot prove both user ownership and the exact run must
		// never be allowed to invalidate another owner's unpublished work.
		if (!instance || !run)
			return mode === "prepare"
				? ({ kind: "not-published" } as const)
				: { published: false, itemCount: 0 };
		const invalidate = async () => {
			if (mode === "prepare")
				return {
					kind: "invalid" as const,
					authority: {
						instanceId: instance.id,
						userId: input.userId,
						runId: run.id,
						authorityKey: run.authorityKey,
						parentGenerationId: run.parentGenerationId,
						targetDigest: run.targetDigest,
						completedUnits: run.completedUnits,
						completedWork: run.completedWork,
						totalUnits: run.totalUnits,
						totalWork: run.totalWork,
						connectionGeneration: run.connectionGeneration,
						identityGeneration: run.identityGeneration,
					},
				};
			await tx.jellyfinEpisodeObservationExclusion.deleteMany({ where: { runId: input.runId } });
			await tx.jellyfinEpisodeObservationStage.deleteMany({ where: { runId: input.runId } });
			await tx.providerObservationUnit.updateMany({
				where: { runId: input.runId, state: { notIn: ["complete", "invalidated"] } },
				data: { state: "invalidated", claimToken: null, nextAttemptAt: null },
			});
			await tx.providerObservationRun.updateMany({
				where: { id: input.runId, state: { in: ["running", "failed"] } },
				data: { state: "invalidated", activeSlotKey: null, nextAttemptAt: null, completedAt: now },
			});
			return { published: false, itemCount: 0 };
		};
		const unavailableDependency = async () =>
			mode === "prepare" ? ({ kind: "not-published" } as const) : await invalidate();
		if (
			(instance.service !== "JELLYFIN" && instance.service !== "EMBY") ||
			instance.connectionGeneration !== run.connectionGeneration ||
			instance.identityGeneration !== run.identityGeneration ||
			run.completedUnits !== run.totalUnits ||
			run.completedWork !== run.totalWork ||
			run.units.length !== run.totalUnits ||
			run.units.some((unit) => unit.state !== "complete")
		)
			return await invalidate();
		if (!input.scopes || !input.attempt) return await invalidate();
		const status = await tx.cacheRefreshStatus.findUnique({
			where: { instanceId_cacheType: { instanceId: instance.id, cacheType: "jellyfin_episode" } },
		});
		if (
			!status ||
			status.lastAttemptAt?.getTime() !== input.attempt.attemptedAt.getTime() ||
			status.lastAttemptResult !== input.attempt.resultMarker
		)
			// Attempt settlement is intentionally separate from durable run authority.
			// A newer marker may own the same plan-bound run; a stale caller must not
			// invalidate its staged work, but cannot publish because its exact CAS lost.
			return mode === "prepare"
				? ({ kind: "not-published" } as const)
				: { published: false, itemCount: 0 };
		const runParentGenerationId = run.parentGenerationId;
		if (typeof runParentGenerationId !== "string" || runParentGenerationId.trim() === "")
			return await invalidate();
		const isV2Run = runParentGenerationId.startsWith(JELLYFIN_EPISODE_PARENT_KEY_PREFIX);
		const isV3Run = runParentGenerationId.startsWith(JELLYFIN_EPISODE_PARENT_V3_KEY_PREFIX);
		const rootUnit = run.units.find((unit) => unit.ordinal === 0);
		const originalParent =
			isV2Run || isV3Run ? parseParentProvenance(rootUnit?.scopePayload ?? null) : null;
		const originalCatalog = isV3Run
			? decodeJellyfinEpisodeCatalogProvenance(
					(() => {
						try {
							return (JSON.parse(rootUnit?.scopePayload ?? "{}") as Record<string, unknown>)
								.catalogProvenance;
						} catch {
							return null;
						}
					})(),
				)
			: null;
		const pageSize = jellyfinEpisodePageSizeFromPayload(rootUnit?.scopePayload ?? null);
		if (
			pageSize === null ||
			((isV2Run || isV3Run) && (!originalParent || (isV3Run && !originalCatalog)))
		)
			return await invalidate();
		let plan: ReturnType<typeof buildJellyfinEpisodeScopePlan>;
		try {
			// Exact payload equality below proves every unit retains the same
			// original provenance as well as its expected scope and phase.
			plan = buildJellyfinEpisodeScopePlan(
				input.scopes,
				originalParent
					? {
							...originalParent,
							...(originalCatalog ? { catalogProvenance: originalCatalog } : {}),
						}
					: undefined,
				pageSize,
			);
		} catch {
			return await invalidate();
		}
		if (
			run.targetDigest !== plan.targetDigest ||
			run.targetCount !== plan.targetCount ||
			run.units.some((unit) => {
				const expected = plan.units[unit.ordinal];
				return (
					!expected ||
					unit.scopeKey !== expected.scopeKey ||
					unit.scopeDigest !== expected.scopeDigest ||
					unit.scopePayload !== (expected.scopePayload ?? null) ||
					unit.phase !== expected.phase ||
					unit.expectedTargets !== expected.expectedTargets ||
					unit.expectedRawCount === null ||
					unit.cursor !== unit.expectedRawCount ||
					unit.observedRawCount !== unit.expectedRawCount ||
					unit.claimToken !== null
				);
			})
		)
			return await invalidate();
		if (
			pageSize === 2_000 &&
			run.units.some(
				(unit) =>
					!hasPlausibleJellyfinEpisodePageCount(
						unit.observedRawCount,
						unit.completedPages,
						pageSize,
					),
			)
		)
			return await invalidate();
		const parentStatus = await tx.cacheRefreshStatus.findUnique({
			where: { instanceId_cacheType: { instanceId: instance.id, cacheType: "jellyfin" } },
		});
		const parent = parentStatus
			? decodeJellyfinLibraryGenerationMetadata(parentStatus.generationMetadata)
			: { ok: false as const };
		if (
			!parentStatus ||
			!parent.ok ||
			parentStatus.lastResult !== "success" ||
			parentStatus.lastAttemptResult !== "success" ||
			!(parentStatus.lastRefreshedAt instanceof Date) ||
			!(parentStatus.lastAttemptAt instanceof Date) ||
			!Number.isFinite(parentStatus.lastRefreshedAt.getTime()) ||
			!Number.isFinite(parentStatus.lastAttemptAt.getTime()) ||
			!Number.isFinite(now.getTime()) ||
			parentStatus.lastRefreshedAt.getTime() > now.getTime() ||
			parentStatus.lastAttemptAt.getTime() !== parentStatus.lastRefreshedAt.getTime() ||
			now.getTime() - parentStatus.lastRefreshedAt.getTime() >
				JELLYFIN_EPISODE_PARENT_MUTATION_AUTHORITY_MAX_AGE_MS ||
			parent.metadata.coverageReceipt.observedAt !== parentStatus.lastRefreshedAt.toISOString() ||
			parentStatus.connectionGeneration !== run.connectionGeneration ||
			parentStatus.identityGeneration !== run.identityGeneration ||
			typeof parentStatus.generationId !== "string" ||
			parentStatus.generationId.trim() === "" ||
			parent.metadata.connectionGeneration !== run.connectionGeneration ||
			parent.metadata.identityGeneration !== run.identityGeneration ||
			!hasJellyfinEpisodeParentReceipt(parent.metadata.coverageReceipt)
		)
			return await unavailableDependency();
		const stageLoadStartedAt = performance.now();
		let expectedStageRows = 0;
		for (const unit of run.units) {
			expectedStageRows += unit.observedRawCount;
			if (expectedStageRows > MAX_JELLYFIN_FINALIZER_STAGE_ROWS)
				return await unavailableDependency();
		}
		const stages: JellyfinEpisodeObservationStage[] = [];
		let stageCursor:
			| {
					runId: string;
					pass: string;
					userKeyDigest: string;
					jellyfinId: string;
			  }
			| undefined;
		for (;;) {
			const seek = stageCursor
				? Prisma.sql`AND ("pass", "userKeyDigest", "jellyfinId") > (${stageCursor.pass}, ${stageCursor.userKeyDigest}, ${stageCursor.jellyfinId})`
				: Prisma.empty;
			const page = await tx.$queryRaw<JellyfinEpisodeObservationStage[]>(Prisma.sql`
				SELECT * FROM "jellyfin_episode_observation_stage"
				WHERE "runId" = ${run.id} ${seek}
				ORDER BY "pass", "userKeyDigest", "jellyfinId"
				LIMIT ${JELLYFIN_FINALIZER_STAGE_READ_PAGE_SIZE}
			`);
			if (stages.length + page.length > MAX_JELLYFIN_FINALIZER_STAGE_ROWS)
				return await unavailableDependency();
			stages.push(...page);
			if (page.length < JELLYFIN_FINALIZER_STAGE_READ_PAGE_SIZE) break;
			const last = page[page.length - 1]!;
			stageCursor = {
				runId: run.id,
				pass: last.pass,
				userKeyDigest: last.userKeyDigest,
				jellyfinId: last.jellyfinId,
			};
		}
		const collect = stages.filter((stage) => stage.pass === "collect");
		const verify = stages.filter((stage) => stage.pass === "verify");
		const unitsById = new Map(run.units.map((unit) => [unit.id, unit]));
		const exclusions: JellyfinEpisodeObservationExclusion[] = [];
		let exclusionCursor:
			| {
					runId: string;
					pass: string;
					userKeyDigest: string;
					jellyfinId: string;
			  }
			| undefined;
		for (;;) {
			const seek = exclusionCursor
				? Prisma.sql`AND ("pass", "userKeyDigest", "jellyfinId") > (${exclusionCursor.pass}, ${exclusionCursor.userKeyDigest}, ${exclusionCursor.jellyfinId})`
				: Prisma.empty;
			const page = await tx.$queryRaw<JellyfinEpisodeObservationExclusion[]>(Prisma.sql`
				SELECT * FROM "jellyfin_episode_observation_exclusions"
				WHERE "runId" = ${run.id} ${seek}
				ORDER BY "pass", "userKeyDigest", "jellyfinId"
				LIMIT ${JELLYFIN_FINALIZER_STAGE_READ_PAGE_SIZE}
			`);
			if (stages.length + exclusions.length + page.length > MAX_JELLYFIN_FINALIZER_STAGE_ROWS)
				return await unavailableDependency();
			exclusions.push(...page);
			if (page.length < JELLYFIN_FINALIZER_STAGE_READ_PAGE_SIZE) break;
			const last = page[page.length - 1]!;
			exclusionCursor = {
				runId: run.id,
				pass: last.pass,
				userKeyDigest: last.userKeyDigest,
				jellyfinId: last.jellyfinId,
			};
		}
		const stageLoadedAt = performance.now();
		if (
			(!isV3Run && exclusions.length > 0) ||
			exclusions.some((row) => {
				const unit = unitsById.get(row.unitId);
				const scope = unit && parseScope(unit.scopePayload);
				return (
					!unit ||
					!scope ||
					row.pass !== unit.phase ||
					row.userKeyDigest !== digest(["jellyfin-user", scope.userId]) ||
					!row.jellyfinId.trim() ||
					row.reason !== "missing-episode-metadata"
				);
			})
		)
			return await invalidate();
		// An unavailable mapping in either pass/user cannot corroborate a positive
		// observation for that identity. Other independently verified IDs remain usable.
		const excludedIds = new Set(exclusions.map((row) => row.jellyfinId));
		const exclusionsByUnit = new Map<string, Set<string>>();
		for (const row of exclusions) {
			const ids = exclusionsByUnit.get(row.unitId) ?? new Set<string>();
			ids.add(row.jellyfinId);
			exclusionsByUnit.set(row.unitId, ids);
		}
		const stagesByUnit = new Map<string, typeof stages>();
		for (const stage of stages) {
			const rows = stagesByUnit.get(stage.unitId) ?? [];
			rows.push(stage);
			stagesByUnit.set(stage.unitId, rows);
		}
		// V3 publishes partial observations: raw page positions can exceed unique
		// staged identities after overlap. Neither count grants absence authority.
		const invalidStageCardinality = run.units.some((unit) => {
			const stageCount = new Set([
				...(stagesByUnit.get(unit.id) ?? []).map((row) => row.jellyfinId),
				...(exclusionsByUnit.get(unit.id) ?? []),
			]).size;
			return isV3Run
				? stageCount > unit.observedRawCount || (unit.observedRawCount > 0 && stageCount === 0)
				: (stagesByUnit.get(unit.id)?.length ?? 0) !== unit.observedRawCount;
		});
		if (
			stages.some((stage) => {
				const unit = unitsById.get(stage.unitId);
				const scope = unit && parseScope(unit.scopePayload);
				return (
					!unit ||
					!scope ||
					stage.pass !== unit.phase ||
					stage.userKeyDigest !== digest(["jellyfin-user", scope.userId])
				);
			}) ||
			invalidStageCardinality
		)
			return await invalidate();
		const parentRows = await tx.jellyfinCache.findMany({
			where: {
				instanceId: instance.id,
			},
			select: {
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
			},
		});
		if (
			parentRows.length !== parentStatus.itemCount ||
			parentRows.some(
				(row) =>
					row.connectionGeneration !== run.connectionGeneration ||
					row.identityGeneration !== run.identityGeneration ||
					(row.mediaType !== "movie" && row.mediaType !== "series"),
			) ||
			fingerprintJellyfinLibraryRows(
				parentRows.map((row) => ({
					...row,
					mediaType: row.mediaType as "movie" | "series",
				})),
			) !== parent.metadata.contentFingerprint
		)
			return await unavailableDependency();
		const parentDependencyFingerprint = fingerprintJellyfinEpisodeParentDependency(
			instance.id,
			parent.metadata,
			parentRows.map((row) => ({
				...row,
				mediaType: row.mediaType as "movie" | "series",
			})) as JellyfinLibraryRowFingerprintInput[],
		);
		if (!parentDependencyFingerprint) return await unavailableDependency();
		if (
			(isV2Run &&
				runParentGenerationId !==
					jellyfinEpisodeParentGenerationKey(parentDependencyFingerprint)) ||
			(isV3Run &&
				(!originalCatalog ||
					!isJellyfinEpisodeCatalogCompatible(
						originalCatalog,
						parentRows.map((row) => ({ ...row, mediaType: row.mediaType as "movie" | "series" })),
						jellyfinEpisodeCatalogScopesFromReceipt(parent.metadata.coverageReceipt) ?? [],
					) ||
					runParentGenerationId !== jellyfinEpisodeCatalogGenerationKey(originalCatalog))) ||
			(!isV2Run && !isV3Run && parentStatus.generationId !== runParentGenerationId)
		)
			return await unavailableDependency();
		const currentCatalog = isV3Run
			? (() => {
					const currentScopes = jellyfinEpisodeCatalogScopesFromReceipt(
						parent.metadata.coverageReceipt,
					);
					return currentScopes
						? buildJellyfinEpisodeCatalogProvenance(
								parentRows.map((row) => ({
									...row,
									mediaType: row.mediaType as "movie" | "series",
								})),
								currentScopes,
							)
						: null;
				})()
			: null;
		const exactCurrentV3Catalog =
			originalCatalog !== null &&
			currentCatalog !== null &&
			JSON.stringify(originalCatalog) === JSON.stringify(currentCatalog) &&
			(() => {
				try {
					const currentScopes = jellyfinEpisodeCatalogScopesFromReceipt(
						parent.metadata.coverageReceipt,
					);
					return (
						currentScopes !== null &&
						JSON.stringify(currentScopes) === JSON.stringify(originalCatalog.scopes)
					);
				} catch {
					return false;
				}
			})();
		// V3 cannot publish unwatched rows. Their omission or duplicate coordinates
		// must not turn unrelated, verified positive observations into an outage.
		// Retain every staged row for raw coverage accounting below.
		const positivePublicationCandidates = isV3Run
			? collect.filter((row) => row.played && !excludedIds.has(row.jellyfinId))
			: collect;
		const itemIds = new Set<string>();
		const coordinates = new Set<string>();
		const sourceCoordinateByItemId = new Map<string, string>();
		if (isV3Run) {
			const positiveItemIds = new Set(positivePublicationCandidates.map((row) => row.jellyfinId));
			// A published item's identity must remain consistent across users and
			// passes, including conflicting observations whose watched flag is false.
			for (const row of stages) {
				if (!positiveItemIds.has(row.jellyfinId)) continue;
				const coordinate = `${row.seriesId}\u0000${row.seasonNumber}\u0000${row.episodeNumber}`;
				const prior = sourceCoordinateByItemId.get(row.jellyfinId);
				if (prior !== undefined && prior !== coordinate) return await invalidate();
				sourceCoordinateByItemId.set(row.jellyfinId, coordinate);
			}
		}
		for (const row of positivePublicationCandidates) {
			const key = `${row.userKeyDigest}\u0000${row.jellyfinId}`;
			const coordinate = `${row.userKeyDigest}\u0000${row.seriesId}\u0000${row.seasonNumber}\u0000${row.episodeNumber}`;
			const sourceCoordinate = `${row.seriesId}\u0000${row.seasonNumber}\u0000${row.episodeNumber}`;
			const priorCoordinate = sourceCoordinateByItemId.get(row.jellyfinId);
			if (itemIds.has(key) || coordinates.has(coordinate)) return await invalidate();
			if (priorCoordinate !== undefined && priorCoordinate !== sourceCoordinate)
				return await invalidate();
			itemIds.add(key);
			coordinates.add(coordinate);
			sourceCoordinateByItemId.set(row.jellyfinId, sourceCoordinate);
		}
		if (
			isV3Run
				? !hasV3StableCoordinateSuperset(positivePublicationCandidates, verify)
				: collect.length !== verify.length ||
					JSON.stringify(canonicalStageRows(collect, false)) !==
						JSON.stringify(canonicalStageRows(verify, false))
		)
			return await invalidate();
		const mapped = new Map<string, number | null>();
		const originalBindings = new Map<string, number>();
		for (const binding of originalCatalog?.bindings ?? []) {
			originalBindings.set(`${binding.libraryId}\u0000${binding.seriesId}`, binding.tmdbId);
		}
		for (const row of parentRows) {
			if (row.mediaType !== "series" || !row.jellyfinId) continue;
			const key = isV3Run ? `${row.libraryId}\u0000${row.jellyfinId}` : row.jellyfinId;
			if (isV3Run && !originalBindings.has(key)) continue;
			const existing = mapped.get(key);
			if (existing === undefined) mapped.set(key, row.tmdbId);
			else if (existing !== row.tmdbId) mapped.set(key, null);
		}
		const unitLibraryById = new Map(
			run.units.map((unit) => {
				try {
					const payload = JSON.parse(unit.scopePayload ?? "{}") as { libraryId?: string };
					return [unit.id, payload.libraryId ?? ""] as const;
				} catch {
					return [unit.id, ""] as const;
				}
			}),
		);
		const coverageByUnit = new Map<
			string,
			{ sourceBindings: number; canonicalEntities: number; missingMappings: number }
		>();
		for (const unit of run.units) {
			const canonicalCoordinates = new Set<string>();
			const stagedIds = new Set((stagesByUnit.get(unit.id) ?? []).map((row) => row.jellyfinId));
			let missingMappings = [...(exclusionsByUnit.get(unit.id) ?? [])].filter(
				(id) => !stagedIds.has(id),
			).length;
			let sourceBindings = 0;
			for (const row of stagesByUnit.get(unit.id) ?? []) {
				const showTmdbId = mapped.get(
					isV3Run ? `${unitLibraryById.get(unit.id) ?? ""}\u0000${row.seriesId}` : row.seriesId,
				);
				if (excludedIds.has(row.jellyfinId) || showTmdbId === undefined || showTmdbId === null) {
					missingMappings += 1;
					continue;
				}
				sourceBindings += 1;
				canonicalCoordinates.add(
					`${showTmdbId}\u0000${row.seasonNumber}\u0000${row.episodeNumber}`,
				);
			}
			coverageByUnit.set(unit.id, {
				sourceBindings: isV3Run ? sourceBindings : unit.observedRawCount - missingMappings,
				canonicalEntities: canonicalCoordinates.size,
				missingMappings,
			});
		}
		const exactV3Identity =
			isV3Run &&
			instance.identityStatus === "VERIFIED" &&
			typeof instance.expectedIdentity === "string" &&
			instance.expectedIdentity.trim() !== "";
		let exactV3Mapping = true;
		const exactCanonicalCoordinates = new Set<string>();
		const canonicalByNativeId = new Map<string, string>();
		if (exactV3Identity) {
			for (const row of collect) {
				const showTmdbId = mapped.get(
					`${unitLibraryById.get(row.unitId) ?? ""}\u0000${row.seriesId}`,
				);
				if (showTmdbId === undefined || showTmdbId === null) {
					exactV3Mapping = false;
					break;
				}
				const nativeCanonicalIdentity = `${showTmdbId}\u0000${row.seasonNumber}\u0000${row.episodeNumber}`;
				const priorCanonicalIdentity = canonicalByNativeId.get(row.jellyfinId);
				if (
					priorCanonicalIdentity !== undefined &&
					priorCanonicalIdentity !== nativeCanonicalIdentity
				) {
					exactV3Mapping = false;
					break;
				}
				canonicalByNativeId.set(row.jellyfinId, nativeCanonicalIdentity);
				const coordinate = `${row.userKeyDigest}\u0000${showTmdbId}\u0000${row.seasonNumber}\u0000${row.episodeNumber}`;
				if (exactCanonicalCoordinates.has(coordinate)) {
					exactV3Mapping = false;
					break;
				}
				exactCanonicalCoordinates.add(coordinate);
			}
		}
		const exactV3Catalog =
			exactV3Identity &&
			hasAuthoritativeJellyfinLibraryReceipt(parent.metadata.coverageReceipt) &&
			typeof parentStatus.generationId === "string" &&
			parentStatus.generationId.trim() !== "" &&
			exactCurrentV3Catalog;
		const exactV3Cardinality =
			exactV3Catalog &&
			exclusions.length === 0 &&
			run.units.every((unit) => {
				const unitStages = stagesByUnit.get(unit.id) ?? [];
				const stageIds = new Set(unitStages.map((row) => row.jellyfinId));
				const scope = parseScope(unit.scopePayload);
				return (
					unit.expectedRawCount === unit.observedRawCount &&
					unitStages.length === unit.observedRawCount &&
					stageIds.size === unit.observedRawCount &&
					scope !== null &&
					unitStages.every((row) => row.userKeyDigest === digest(["jellyfin-user", scope.userId]))
				);
			});
		const exactV3Passes =
			exactV3Cardinality &&
			exactV3Mapping &&
			hasV3ExactNativeIdentityConsistency([...collect, ...verify]) &&
			run.units.every(
				(unit) =>
					coverageByUnit.get(unit.id)?.missingMappings === 0 &&
					coverageByUnit.get(unit.id)?.sourceBindings === unit.observedRawCount,
			) &&
			hasV3ExactPassEquality(collect, verify);
		const exactV3Publication = exactV3Passes;
		const publicationCandidates = exactV3Publication ? collect : positivePublicationCandidates;
		const userNames = new Map(
			input.scopes.map((scope) => [digest(["jellyfin-user", scope.userId]), scope.userName]),
		);
		const aggregates = new Map<
			string,
			{
				showTmdbId: number;
				seasonNumber: number;
				episodeNumber: number;
				jellyfinId: string;
				title: string;
				watched: boolean;
				names: Set<string>;
				lastWatchedAt: Date | null;
			}
		>();
		for (const row of publicationCandidates) {
			const showTmdbId = mapped.get(
				isV3Run ? `${unitLibraryById.get(row.unitId) ?? ""}\u0000${row.seriesId}` : row.seriesId,
			);
			// A conflicting or missing parent mapping leaves only that provider
			// coordinate unknown. It cannot erase exact, generation-bound rows
			// for other mapped series in the same current inventory.
			if (showTmdbId === undefined || showTmdbId === null) continue;
			const name = userNames.get(row.userKeyDigest);
			if (!name) return await invalidate();
			const key = `${showTmdbId}:${row.seasonNumber}:${row.episodeNumber}`;
			const aggregate = aggregates.get(key) ?? {
				showTmdbId,
				seasonNumber: row.seasonNumber,
				episodeNumber: row.episodeNumber,
				jellyfinId: row.jellyfinId,
				title: row.title,
				watched: false,
				names: new Set<string>(),
				lastWatchedAt: null,
			};
			if (row.jellyfinId.localeCompare(aggregate.jellyfinId) < 0) {
				aggregate.jellyfinId = row.jellyfinId;
				aggregate.title = row.title;
			} else if (
				row.jellyfinId === aggregate.jellyfinId &&
				row.title.localeCompare(aggregate.title) < 0
			) {
				aggregate.title = row.title;
			}
			aggregate.watched ||= row.played;
			if (row.played) aggregate.names.add(name);
			if (
				row.lastPlayedAt &&
				(!aggregate.lastWatchedAt || row.lastPlayedAt > aggregate.lastWatchedAt)
			)
				aggregate.lastWatchedAt = row.lastPlayedAt;
			aggregates.set(key, aggregate);
		}
		const rows = [...aggregates.values()]
			.sort(
				(a, b) =>
					a.showTmdbId - b.showTmdbId ||
					a.seasonNumber - b.seasonNumber ||
					a.episodeNumber - b.episodeNumber,
			)
			.map((row) => ({ ...row, watchedByUsers: JSON.stringify([...row.names].sort()) }));
		const publishedRows = exactV3Publication || !isV3Run ? rows : rows.filter((row) => row.watched);
		const publishedCoordinates = new Set(
			publishedRows.map((row) => `${row.showTmdbId}\0${row.seasonNumber}\0${row.episodeNumber}`),
		);
		const hasMissingMappings = [...coverageByUnit.values()].some(
			(coverage) => coverage.missingMappings > 0,
		);
		const coverageUnits = run.units.map((unit) => {
			const coverage = coverageByUnit.get(unit.id)!;
			const stageCount = new Set([
				...(stagesByUnit.get(unit.id) ?? []).map((row) => row.jellyfinId),
				...(exclusionsByUnit.get(unit.id) ?? []),
			]).size;
			const duplicateSourceObservations = isV3Run ? unit.observedRawCount - stageCount : 0;
			const pages =
				pageSize === 2_000
					? unit.completedPages
					: Math.max(1, Math.ceil(unit.expectedRawCount! / pageSize));
			// Raw/source counts still describe the complete observed pass. V3's
			// canonical count describes only coordinates admitted to publication.
			const admittedCoordinates = new Set<string>();
			if (isV3Run)
				for (const row of stagesByUnit.get(unit.id) ?? []) {
					if (excludedIds.has(row.jellyfinId)) continue;
					const tmdbId = mapped.get(`${unitLibraryById.get(unit.id) ?? ""}\0${row.seriesId}`);
					const coordinate = `${tmdbId}\0${row.seasonNumber}\0${row.episodeNumber}`;
					if (publishedCoordinates.has(coordinate)) admittedCoordinates.add(coordinate);
				}
			return {
				scopeKey: unit.scopeKey,
				expectedRawCount: unit.expectedRawCount,
				pagesAttempted: pages,
				pagesCompleted: pages,
				rawObserved: unit.observedRawCount,
				sourceBindings: coverage.sourceBindings,
				canonicalEntities: isV3Run ? admittedCoordinates.size : coverage.canonicalEntities,
				acceptedSkips: [
					...(coverage.missingMappings > 0
						? [{ reason: "missing-supported-mapping" as const, count: coverage.missingMappings }]
						: []),
					...(duplicateSourceObservations > 0
						? [
								{
									reason: "duplicate-source-observation" as const,
									count: duplicateSourceObservations,
								},
							]
						: []),
				],
				fatalCount: 0,
			};
		});
		const positiveOnly = !exactV3Publication && (isV3Run || hasMissingMappings);
		const receipt = positiveOnly
			? {
					version: 2 as const,
					provider:
						instance.service === "EMBY" ? ("emby_episode" as const) : ("jellyfin_episode" as const),
					attemptStartedAt: input.attempt.attemptedAt.toISOString(),
					observedAt: now.toISOString(),
					evidence: "positive-only" as const,
					units: coverageUnits,
					publishedCanonicalEntities: publishedRows.length,
					domains: [
						{
							domain: "episode-inventory" as const,
							evidence: "positive-only" as const,
							valueSemantics: "lower-bound" as const,
							units: coverageUnits,
							publishedCanonicalEntities: publishedRows.length,
						},
					],
				}
			: {
					version: 1 as const,
					provider:
						instance.service === "EMBY" ? ("emby_episode" as const) : ("jellyfin_episode" as const),
					attemptStartedAt: input.attempt.attemptedAt.toISOString(),
					observedAt: now.toISOString(),
					evidence: "complete" as const,
					units: coverageUnits,
					publishedCanonicalEntities: publishedRows.length,
				};
		const contentFingerprint = fingerprintJellyfinEpisodeRows(publishedRows);
		const metadata = encodeJellyfinEpisodeGenerationMetadata({
			version: mode === "prepare" ? 4 : exactV3Publication ? 2 : isV3Run ? 3 : isV2Run ? 2 : 1,
			...(mode === "prepare"
				? {
						storage: "generation-scoped" as const,
						sourceVersion: isV3Run ? 3 : isV2Run ? 2 : 1,
					}
				: {}),
			provider: instance.service === "EMBY" ? "emby" : "jellyfin",
			cacheType: "jellyfin_episode",
			publicationLevel: positiveOnly ? "positive-only" : "authoritative",
			completeness: positiveOnly ? "partial" : "complete",
			canonicalizationVersion: 1,
			itemCount: publishedRows.length,
			connectionGeneration: run.connectionGeneration,
			identityGeneration: run.identityGeneration,
			parentLibraryGenerationId: exactV3Publication
				? parentStatus.generationId!
				: (originalParent?.parentLibraryGenerationId ?? parentStatus.generationId),
			parentLibraryMetadataFingerprint: exactV3Publication
				? fingerprintJellyfinLibraryGenerationMetadata(parent.metadata)
				: (originalParent?.parentLibraryMetadataFingerprint ??
					fingerprintJellyfinLibraryGenerationMetadata(parent.metadata)),
			...(mode === "prepare" || isV2Run || isV3Run
				? {
						parentLibraryDependencyFingerprint: exactV3Publication
							? parentDependencyFingerprint
							: isV3Run
								? (originalParent?.parentLibraryDependencyFingerprint ??
									parentDependencyFingerprint)
								: parentDependencyFingerprint,
					}
				: {}),
			...(isV3Run && !exactV3Publication ? { catalogProvenance: originalCatalog } : {}),
			contentFingerprint,
			coverageReceipt: receipt,
		});
		const nativeProjectionStartedAt = performance.now();
		const cacheGenerationId = mode === "prepare" ? run.id : crypto.randomUUID();
		let nativePublication: NativeWatchPublicationInput | null = null;
		let nativeWatchDiagnostics: NativeWatchProjectionDiagnostics | undefined;
		let scopedNativeWatchDiagnostics: readonly NativeWatchScopedProjectionDiagnostics[] = [];
		if (isV3Run && instance.identityStatus === "VERIFIED" && instance.expectedIdentity?.trim()) {
			const scopedRows = (rows: typeof stages) =>
				rows.map((row) => ({
					userKeyDigest: row.userKeyDigest,
					libraryId: unitLibraryById.get(row.unitId) ?? "",
					jellyfinId: row.jellyfinId,
					seriesId: row.seriesId,
					seasonNumber: row.seasonNumber,
					episodeNumber: row.episodeNumber,
					played: row.played,
					playCount: row.playCount,
					lastPlayedAt: row.lastPlayedAt,
				}));
			const candidates = deriveNativeWatchCandidates(
				scopedRows(collect),
				scopedRows(verify),
				(diagnostics) => {
					nativeWatchDiagnostics = diagnostics;
				},
				(scopes) => {
					scopedNativeWatchDiagnostics = scopes;
				},
			);
			const receipts = input.scopes.map((scope) => {
				const userKeyDigest = digest(["jellyfin-user", scope.userId]);
				const matchingUnits = run.units.filter((unit) => {
					const persisted = parseScope(unit.scopePayload);
					return persisted?.userId === scope.userId && persisted.libraryId === scope.libraryId;
				});
				const collectUnit = matchingUnits.find((unit) => unit.phase === "collect");
				const verifyUnit = matchingUnits.find((unit) => unit.phase === "verify");
				const collectRows = collectUnit ? (stagesByUnit.get(collectUnit.id) ?? []) : [];
				const verifyRows = verifyUnit ? (stagesByUnit.get(verifyUnit.id) ?? []) : [];
				const scopeCandidates = candidates.filter(
					(row) => row.userKeyDigest === userKeyDigest && row.libraryId === scope.libraryId,
				);
				const exact =
					matchingUnits.length === 2 &&
					collectUnit?.expectedRawCount === verifyUnit?.expectedRawCount &&
					collectRows.length === collectUnit?.observedRawCount &&
					verifyRows.length === verifyUnit?.observedRawCount &&
					collectRows.length === scopeCandidates.length &&
					verifyRows.length === scopeCandidates.length &&
					!matchingUnits.some((unit) => (exclusionsByUnit.get(unit.id)?.size ?? 0) > 0);
				return {
					userKeyDigest,
					libraryId: scope.libraryId,
					expectedRawCount: collectUnit?.observedRawCount ?? 0,
					observedRawCount: verifyUnit?.observedRawCount ?? 0,
					exact,
					diagnosticsJson: serializeNativeWatchScopeDiagnostics({
						version: 1,
						...(scopedNativeWatchDiagnostics.find(
							(entry) =>
								entry.userKeyDigest === userKeyDigest && entry.libraryId === scope.libraryId,
						)?.diagnostics ?? emptyNativeWatchProjectionDiagnostics()),
						collectUnits: matchingUnits.filter((unit) => unit.phase === "collect").length,
						verifyUnits: matchingUnits.filter((unit) => unit.phase === "verify").length,
						collectStageRows: collectRows.length,
						verifyStageRows: verifyRows.length,
						expectedCountsMatch:
							collectUnit !== undefined &&
							verifyUnit !== undefined &&
							collectUnit.expectedRawCount === verifyUnit.expectedRawCount,
						excludedRows: matchingUnits.reduce(
							(count, unit) => count + (exclusionsByUnit.get(unit.id)?.size ?? 0),
							0,
						),
					}),
					contentFingerprint: digest(
						scopeCandidates.map((row) => [
							row.jellyfinId,
							row.seriesId,
							row.seasonNumber,
							row.episodeNumber,
							row.played,
							row.playCount,
							row.lastPlayedAt?.toISOString() ?? null,
						]),
					),
				};
			});
			nativePublication = {
				instanceId: instance.id,
				runId: run.id,
				cacheGenerationId,
				connectionGeneration: run.connectionGeneration,
				identityGeneration: run.identityGeneration,
				observedAt: now,
				expectedScopeCount: input.scopes.length,
				candidates,
				receipts,
			};
		}
		const nativeProjectionFinishedAt = performance.now();
		if (mode === "prepare") {
			const preparedAt = performance.now();
			try {
				const ms = (duration: number) => Math.max(0, Math.round(duration));
				input.recordTiming?.(
					{
						authorityMs: ms(stageLoadStartedAt - startedAt),
						stageLoadMs: ms(stageLoadedAt - stageLoadStartedAt),
						computeMs: ms(preparedAt - stageLoadedAt),
						episodeWriteMs: 0,
						nativeProjectionMs: ms(nativeProjectionFinishedAt - nativeProjectionStartedAt),
						nativeWatchWriteMs: 0,
						totalMs: ms(preparedAt - startedAt),
						stageRows: stages.length,
						nativeCandidates: nativePublication?.candidates.length ?? 0,
						...(nativeWatchDiagnostics ? { nativeWatchDiagnostics } : {}),
					},
					preparedAt - startedAt,
				);
			} catch {
				// Diagnostics cannot replace otherwise valid prepared evidence.
			}
			return {
				kind: "ready" as const,
				authority: {
					instanceId: instance.id,
					userId: input.userId,
					runId: run.id,
					authorityKey: run.authorityKey,
					parentGenerationId: run.parentGenerationId,
					targetDigest: run.targetDigest,
					completedUnits: run.completedUnits,
					completedWork: run.completedWork,
					totalUnits: run.totalUnits,
					totalWork: run.totalWork,
					connectionGeneration: run.connectionGeneration,
					identityGeneration: run.identityGeneration,
				},
				observedAt: now,
				cacheGenerationId,
				publishedRows,
				coveredShowTmdbIds: positiveOnly
					? null
					: [...new Set([...mapped.values()].filter((id): id is number => id !== null))].sort(
							(left, right) => left - right,
						),
				contentFingerprint,
				generationMetadata: metadata,
				nativePublication,
				attempt: input.attempt,
				scopesFingerprint: digest(input.scopes),
				unitFingerprint: finalizationUnitFingerprint(run.units),
				priorCacheGenerationId: status.generationId,
				parentStatus: {
					generationId: parentStatus.generationId!,
					generationMetadata: parentStatus.generationMetadata,
					lastRefreshedAt: parentStatus.lastRefreshedAt!,
					itemCount: parentStatus.itemCount,
				},
				statusId: status.id,
			};
		}
		const computeFinishedAt = performance.now();
		await input.testHooks?.beforePublish?.(tx);
		await tx.jellyfinEpisodeCache.deleteMany({ where: { instanceId: instance.id } });
		for (
			let start = 0;
			start < publishedRows.length;
			start += JELLYFIN_CACHE_PUBLICATION_CHUNK_SIZE
		) {
			const chunk = publishedRows.slice(start, start + JELLYFIN_CACHE_PUBLICATION_CHUNK_SIZE);
			await tx.jellyfinEpisodeCache.createMany({
				data: chunk.map((row) => ({
					instanceId: instance.id,
					showTmdbId: row.showTmdbId,
					seasonNumber: row.seasonNumber,
					episodeNumber: row.episodeNumber,
					jellyfinId: row.jellyfinId,
					title: row.title,
					watched: row.watched,
					watchedByUsers: row.watchedByUsers,
					lastWatchedAt: row.lastWatchedAt,
					connectionGeneration: run.connectionGeneration,
					identityGeneration: run.identityGeneration,
				})),
			});
		}
		const statusUpdated = await tx.cacheRefreshStatus.updateMany({
			where: {
				id: status.id,
				instanceId: instance.id,
				cacheType: "jellyfin_episode",
				lastAttemptAt: status.lastAttemptAt,
				lastAttemptResult: status.lastAttemptResult,
				connectionGeneration: run.connectionGeneration,
				identityGeneration: run.identityGeneration,
			},
			data: {
				lastRefreshedAt: now,
				lastResult: "success",
				lastErrorMessage: null,
				itemCount: publishedRows.length,
				generationId: cacheGenerationId,
				generationMetadata: metadata,
				lastAttemptResult: "success",
				lastAttemptErrorMessage: null,
				connectionGeneration: run.connectionGeneration,
				identityGeneration: run.identityGeneration,
			},
		});
		if (statusUpdated.count !== 1) throw new Error("Jellyfin episode publication was superseded");
		await input.testHooks?.afterPublish?.(tx);
		const completed = await tx.providerObservationRun.updateMany({
			where: {
				id: run.id,
				state: "running",
				activeSlotKey: { not: null },
				authorityKey: run.authorityKey,
				parentGenerationId: run.parentGenerationId,
				targetDigest: run.targetDigest,
				connectionGeneration: run.connectionGeneration,
				identityGeneration: run.identityGeneration,
				completedUnits: run.completedUnits,
				completedWork: run.completedWork,
			},
			data: { state: "complete", activeSlotKey: null, completedAt: now, nextAttemptAt: null },
		});
		if (completed.count !== 1) throw new Error("Jellyfin episode finalization was superseded");
		const episodeWrittenAt = performance.now();
		const nativeCandidates = nativePublication?.candidates.length ?? 0;
		let nativeWriteStartedAt: number | null = null;
		let nativeWriteFinishedAt: number | null = null;
		if (nativePublication) {
			nativeWriteStartedAt = performance.now();
			await publishNativeWatchGeneration(tx, nativePublication);
			nativeWriteFinishedAt = performance.now();
		}
		const nativeWatchWrittenAt = performance.now();
		try {
			const ms = (duration: number) => Math.max(0, Math.round(duration));
			input.recordTiming?.(
				{
					authorityMs: ms(stageLoadStartedAt - startedAt),
					stageLoadMs: ms(stageLoadedAt - stageLoadStartedAt),
					computeMs: ms(computeFinishedAt - stageLoadedAt),
					episodeWriteMs: ms(episodeWrittenAt - computeFinishedAt),
					nativeProjectionMs: ms(nativeProjectionFinishedAt - nativeProjectionStartedAt),
					nativeWatchWriteMs: ms(
						nativeWriteStartedAt === null || nativeWriteFinishedAt === null
							? 0
							: nativeWriteFinishedAt - nativeWriteStartedAt,
					),
					totalMs: ms(nativeWatchWrittenAt - startedAt),
					stageRows: stages.length,
					nativeCandidates,
					...(nativeWatchDiagnostics ? { nativeWatchDiagnostics } : {}),
				},
				nativeWatchWrittenAt - startedAt,
			);
		} catch {
			// A diagnostic sink must never replace an otherwise valid publication.
		}
		// These rows cease to be authoritative as soon as the cache and native-watch
		// pointers commit. Reclaim them in bounded post-commit batches so a large
		// provider inventory cannot hold SQLite's write lock through health checks.
		return {
			published: true,
			itemCount: publishedRows.length,
		};
	};
	if (mode === "prepare") return await finalize(input.prisma);
	if (input.transaction) return await finalize(input.transaction);
	return await input.prisma.$transaction(finalize);
}

export async function prepareJellyfinEpisodeRun(
	input: Omit<FinalizeJellyfinEpisodeRunInput, "transaction">,
): Promise<PreparedJellyfinEpisodeRun> {
	return (await evaluateJellyfinEpisodeRun(input, "prepare")) as PreparedJellyfinEpisodeRun;
}

/** An exact persisted acknowledgement for a worker that lost its reply after commit. */
export async function readCompletedJellyfinEpisodePublication(
	prisma: PrismaClient,
	input: {
		userId: string;
		instanceId: string;
		runId: string;
		attempt: ProviderCacheRefreshAttempt;
	},
): Promise<number | null> {
	if (!input.userId.trim() || !input.instanceId.trim() || !input.runId.trim()) return null;
	return await prisma.$transaction(async (tx) => {
		const instance = await tx.serviceInstance.findFirst({
			where: {
				id: input.instanceId,
				userId: input.userId,
				enabled: true,
				service: { in: ["JELLYFIN", "EMBY"] },
				identityStatus: "VERIFIED",
			},
			select: { expectedIdentity: true, connectionGeneration: true, identityGeneration: true },
		});
		if (!instance?.expectedIdentity?.trim()) return null;
		const run = await tx.providerObservationRun.findFirst({
			where: {
				id: input.runId,
				instanceId: input.instanceId,
				provider: "jellyfin_episode",
				cacheType: "jellyfin_episode",
				state: "complete",
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
			},
			select: { id: true },
		});
		if (!run) return null;
		const status = await tx.cacheRefreshStatus.findUnique({
			where: {
				instanceId_cacheType: {
					instanceId: input.instanceId,
					cacheType: "jellyfin_episode",
				},
			},
			select: {
				generationId: true,
				generationMetadata: true,
				lastResult: true,
				lastAttemptResult: true,
				lastAttemptAt: true,
				itemCount: true,
				connectionGeneration: true,
				identityGeneration: true,
			},
		});
		const pointer = await tx.jellyfinNativeWatchPublication.findUnique({
			where: { instanceId: input.instanceId },
			select: { activeRunId: true, activeCacheGenerationId: true },
		});
		const preparation = await tx.jellyfinEpisodePreparation.findUnique({
			where: { runId: input.runId },
			select: {
				instanceId: true,
				generationId: true,
				state: true,
				expectedRowCount: true,
			},
		});
		const decoded = decodeJellyfinEpisodeGenerationMetadata(status?.generationMetadata);
		return status?.generationId === input.runId &&
			decoded.ok &&
			decoded.metadata.version === 4 &&
			status.lastResult === "success" &&
			status.lastAttemptResult === "success" &&
			status.lastAttemptAt?.getTime() === input.attempt.attemptedAt.getTime() &&
			status.connectionGeneration === instance.connectionGeneration &&
			status.identityGeneration === instance.identityGeneration &&
			(decoded.metadata.sourceVersion !== 3 ||
				(pointer?.activeRunId === input.runId &&
					pointer.activeCacheGenerationId === input.runId)) &&
			preparation?.instanceId === input.instanceId &&
			preparation.generationId === input.runId &&
			preparation.state === "published" &&
			preparation.expectedRowCount === status.itemCount
			? status.itemCount
			: null;
	});
}

export async function finalizeJellyfinEpisodeRun(
	input: FinalizeJellyfinEpisodeRunInput,
): Promise<{ published: boolean; itemCount: number }> {
	return (await evaluateJellyfinEpisodeRun(input, "publish")) as {
		published: boolean;
		itemCount: number;
	};
}

/** Only short, execution-time authority checks and visible publication run here. */
export async function commitPreparedJellyfinEpisodeRun(
	tx: Prisma.TransactionClient,
	input: FinalizeJellyfinEpisodeRunInput,
	prepared: Extract<PreparedJellyfinEpisodeRun, { kind: "ready" }>,
): Promise<{ published: boolean; itemCount: number }> {
	const rejected = { published: false, itemCount: 0 };
	const authority = prepared.authority;
	const now = input.testHooks?.commitClock?.() ?? new Date();
	if (
		input.userId !== authority.userId ||
		input.instance.id !== authority.instanceId ||
		input.runId !== authority.runId ||
		!input.scopes ||
		!input.attempt ||
		digest(input.scopes) !== prepared.scopesFingerprint ||
		input.attempt.attemptedAt.getTime() !== prepared.attempt.attemptedAt.getTime() ||
		input.attempt.resultMarker !== prepared.attempt.resultMarker ||
		!Number.isFinite(now.getTime())
	)
		return rejected;
	const instance = await tx.serviceInstance.findFirst({
		where: {
			id: authority.instanceId,
			userId: authority.userId,
			enabled: true,
			service: { in: ["JELLYFIN", "EMBY"] },
			identityStatus: "VERIFIED",
			connectionGeneration: authority.connectionGeneration,
			identityGeneration: authority.identityGeneration,
		},
		select: { expectedIdentity: true },
	});
	const run = await tx.providerObservationRun.findFirst({
		where: {
			id: authority.runId,
			instanceId: authority.instanceId,
			provider: "jellyfin_episode",
			cacheType: "jellyfin_episode",
			state: "running",
			activeSlotKey: { not: null },
			authorityKey: authority.authorityKey,
			parentGenerationId: authority.parentGenerationId,
			targetDigest: authority.targetDigest,
			connectionGeneration: authority.connectionGeneration,
			identityGeneration: authority.identityGeneration,
		},
		include: { units: true },
	});
	if (
		!instance?.expectedIdentity?.trim() ||
		!run ||
		run.completedUnits !== authority.completedUnits ||
		run.completedWork !== authority.completedWork ||
		run.totalUnits !== authority.totalUnits ||
		run.totalWork !== authority.totalWork ||
		run.completedUnits !== run.totalUnits ||
		run.completedWork !== run.totalWork ||
		run.units.length !== run.totalUnits ||
		run.units.some((unit) => unit.state !== "complete") ||
		finalizationUnitFingerprint(run.units) !== prepared.unitFingerprint
	)
		return rejected;
	const status = await tx.cacheRefreshStatus.findUnique({
		where: {
			instanceId_cacheType: { instanceId: authority.instanceId, cacheType: "jellyfin_episode" },
		},
	});
	if (
		!status ||
		status.id !== prepared.statusId ||
		status.lastAttemptAt?.getTime() !== prepared.attempt.attemptedAt.getTime() ||
		status.lastAttemptResult !== prepared.attempt.resultMarker ||
		status.generationId !== prepared.priorCacheGenerationId ||
		status.connectionGeneration !== authority.connectionGeneration ||
		status.identityGeneration !== authority.identityGeneration
	)
		return rejected;
	const parentStatus = await tx.cacheRefreshStatus.findUnique({
		where: { instanceId_cacheType: { instanceId: authority.instanceId, cacheType: "jellyfin" } },
	});
	if (
		!parentStatus ||
		parentStatus.lastResult !== "success" ||
		parentStatus.lastAttemptResult !== "success" ||
		parentStatus.generationId !== prepared.parentStatus.generationId ||
		parentStatus.generationMetadata !== prepared.parentStatus.generationMetadata ||
		parentStatus.lastRefreshedAt?.getTime() !== prepared.parentStatus.lastRefreshedAt.getTime() ||
		parentStatus.lastAttemptAt?.getTime() !== parentStatus.lastRefreshedAt?.getTime() ||
		parentStatus.itemCount !== prepared.parentStatus.itemCount ||
		parentStatus.connectionGeneration !== authority.connectionGeneration ||
		parentStatus.identityGeneration !== authority.identityGeneration ||
		now.getTime() - prepared.parentStatus.lastRefreshedAt.getTime() >
			JELLYFIN_EPISODE_PARENT_MUTATION_AUTHORITY_MAX_AGE_MS ||
		prepared.parentStatus.lastRefreshedAt.getTime() > now.getTime()
	)
		return rejected;
	if (
		authority.parentGenerationId?.startsWith(JELLYFIN_EPISODE_PARENT_V3_KEY_PREFIX) &&
		!prepared.nativePublication
	)
		return rejected;
	const decodedPreparedMetadata = decodeJellyfinEpisodeGenerationMetadata(
		prepared.generationMetadata,
	);
	if (
		!decodedPreparedMetadata.ok ||
		decodedPreparedMetadata.metadata.itemCount !== prepared.publishedRows.length ||
		decodedPreparedMetadata.metadata.contentFingerprint !== prepared.contentFingerprint ||
		decodedPreparedMetadata.metadata.connectionGeneration !== authority.connectionGeneration ||
		decodedPreparedMetadata.metadata.identityGeneration !== authority.identityGeneration ||
		decodedPreparedMetadata.metadata.coverageReceipt.observedAt !==
			prepared.observedAt.toISOString()
	)
		return rejected;
	const preparation = prepared.episodePreparationToken
		? await tx.jellyfinEpisodePreparation.findFirst({
				where: {
					runId: authority.runId,
					instanceId: authority.instanceId,
					generationId: prepared.cacheGenerationId,
					token: prepared.episodePreparationToken,
					state: "verified",
					leaseExpiresAt: { gt: new Date() },
				},
			})
		: null;
	if (
		prepared.cacheGenerationId !== authority.runId ||
		!preparation ||
		preparation.expectedRowCount !== prepared.publishedRows.length ||
		preparation.expectedReceiptCount === null ||
		preparation.contentFingerprint !== prepared.contentFingerprint ||
		preparation.observedAt?.getTime() !== prepared.observedAt.getTime()
	)
		return rejected;
	await input.testHooks?.beforePublish?.(tx);
	const statusUpdated = await tx.cacheRefreshStatus.updateMany({
		where: {
			id: status.id,
			instanceId: authority.instanceId,
			cacheType: "jellyfin_episode",
			lastAttemptAt: status.lastAttemptAt,
			lastAttemptResult: status.lastAttemptResult,
			generationId: prepared.priorCacheGenerationId,
			connectionGeneration: authority.connectionGeneration,
			identityGeneration: authority.identityGeneration,
		},
		data: {
			lastRefreshedAt: prepared.observedAt,
			lastResult: "success",
			lastErrorMessage: null,
			itemCount: prepared.publishedRows.length,
			generationId: prepared.cacheGenerationId,
			generationMetadata: prepared.generationMetadata,
			lastAttemptResult: "success",
			lastAttemptErrorMessage: null,
			connectionGeneration: authority.connectionGeneration,
			identityGeneration: authority.identityGeneration,
		},
	});
	if (statusUpdated.count !== 1) throw new Error("Prepared Jellyfin publication was superseded");
	await input.testHooks?.afterPublish?.(tx);
	const completed = await tx.providerObservationRun.updateMany({
		where: {
			id: authority.runId,
			state: "running",
			activeSlotKey: { not: null },
			authorityKey: authority.authorityKey,
			parentGenerationId: authority.parentGenerationId,
			targetDigest: authority.targetDigest,
			connectionGeneration: authority.connectionGeneration,
			identityGeneration: authority.identityGeneration,
			completedUnits: authority.completedUnits,
			completedWork: authority.completedWork,
		},
		data: {
			state: "complete",
			activeSlotKey: null,
			completedAt: prepared.observedAt,
			nextAttemptAt: null,
		},
	});
	if (completed.count !== 1) throw new Error("Prepared Jellyfin finalization was superseded");
	if (prepared.nativePublication) {
		const { candidates, receipts, ...native } = prepared.nativePublication;
		await publishPreparedNativeWatchGeneration(tx, {
			...native,
			userId: authority.userId,
			candidateCount: candidates.length,
			receiptCount: receipts.length,
		});
	}
	const sealed = await tx.jellyfinEpisodePreparation.updateMany({
		where: {
			runId: authority.runId,
			instanceId: authority.instanceId,
			generationId: prepared.cacheGenerationId,
			token: prepared.episodePreparationToken,
			state: "verified",
			leaseExpiresAt: { gt: new Date() },
		},
		data: { state: "published" },
	});
	if (sealed.count !== 1) throw new Error("Prepared Jellyfin generation lease was superseded");
	return { published: true, itemCount: prepared.publishedRows.length };
}

/** Quarantine proven-invalid evidence without deleting its large staging in the guard. */
export async function settleInvalidJellyfinEpisodeRun(
	tx: Prisma.TransactionClient,
	input: FinalizeJellyfinEpisodeRunInput,
	prepared: Extract<PreparedJellyfinEpisodeRun, { kind: "invalid" }>,
): Promise<boolean> {
	const authority = prepared.authority;
	if (
		input.userId !== authority.userId ||
		input.instance.id !== authority.instanceId ||
		input.runId !== authority.runId ||
		!input.attempt
	)
		return false;
	const instance = await tx.serviceInstance.findFirst({
		where: {
			id: authority.instanceId,
			userId: authority.userId,
			enabled: true,
			service: { in: ["JELLYFIN", "EMBY"] },
			connectionGeneration: authority.connectionGeneration,
			identityGeneration: authority.identityGeneration,
		},
		select: { id: true },
	});
	const status = await tx.cacheRefreshStatus.findUnique({
		where: {
			instanceId_cacheType: { instanceId: authority.instanceId, cacheType: "jellyfin_episode" },
		},
		select: { lastAttemptAt: true, lastAttemptResult: true },
	});
	if (
		!instance ||
		status?.lastAttemptAt?.getTime() !== input.attempt.attemptedAt.getTime() ||
		status.lastAttemptResult !== input.attempt.resultMarker
	)
		return false;
	const invalidated = await tx.providerObservationRun.updateMany({
		where: {
			id: authority.runId,
			instanceId: authority.instanceId,
			provider: "jellyfin_episode",
			cacheType: "jellyfin_episode",
			state: "running",
			activeSlotKey: { not: null },
			authorityKey: authority.authorityKey,
			parentGenerationId: authority.parentGenerationId,
			targetDigest: authority.targetDigest,
			completedUnits: authority.completedUnits,
			completedWork: authority.completedWork,
			connectionGeneration: authority.connectionGeneration,
			identityGeneration: authority.identityGeneration,
		},
		data: {
			state: "invalidated",
			activeSlotKey: null,
			completedAt: input.now ?? new Date(),
			nextAttemptAt: null,
		},
	});
	if (invalidated.count !== 1) return false;
	await tx.providerObservationUnit.updateMany({
		where: { runId: authority.runId, state: { not: "invalidated" } },
		data: { state: "invalidated", claimToken: null, nextAttemptAt: null },
	});
	return true;
}
