import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "../prisma.js";
import type {
	ObservationRunUnitSeed,
	ObservationUnitClaim,
} from "../provider-observation/observation-run-types.js";
import {
	buildObservationActiveSlotKey,
	buildObservationAuthorityKey,
} from "../provider-observation/observation-run-types.js";
import type { ProviderCacheRefreshAttempt } from "../services/provider-cache-status.js";
import { JELLYFIN_CACHE_PUBLICATION_CHUNK_SIZE } from "./jellyfin-cache-refresher.js";
import type { JellyfinEpisodeItemsPage } from "./jellyfin-client.js";
import {
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
	decodeJellyfinLibraryGenerationMetadata,
	encodeJellyfinEpisodeGenerationMetadata,
	fingerprintJellyfinEpisodeRows,
	fingerprintJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
	hasJellyfinEpisodeParentReceipt,
	type JellyfinLibraryRowFingerprintInput,
} from "./jellyfin-generation-metadata.js";

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
	/** Test-only fault injection; production callers never provide these hooks. */
	testHooks?: {
		beforePublish?: (tx: Prisma.TransactionClient) => void | Promise<void>;
		afterPublish?: (tx: Prisma.TransactionClient) => void | Promise<void>;
	};
}

/**
 * Scope payloads contain opaque IDs and, for V2, the original parent provenance.
 * Provenance does not change the structural plan identity: resuming a compatible
 * run retains its saved provenance instead of inheriting newer watch authority.
 * Verify units carry zero work so the generic coordinator retains the scope count.
 */
export function buildJellyfinEpisodeScopePlan(
	scopes: readonly JellyfinEpisodeScope[],
	parentProvenance?: JellyfinEpisodePlanProvenance,
): {
	targetDigest: string;
	targetCount: number;
	units: readonly ObservationRunUnitSeed[];
} {
	if (parentProvenance !== undefined && !validParentProvenance(parentProvenance)) {
		throw new Error("Jellyfin episode parent provenance is invalid");
	}
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
			scopePayload: JSON.stringify({ ...scope, ...provenance, ...catalogReference }),
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
					? `${unit.ordinal === 0 ? "catalogProvenance" : "catalogGenerationKey"}\0libraryId\0parentLibraryDependencyFingerprint\0parentLibraryGenerationId\0parentLibraryMetadataFingerprint\0userId`
					: "libraryId\0parentLibraryGenerationId\0parentLibraryMetadataFingerprint\0userId";
			if (payloadKeys !== expectedPayloadKeys) return null;
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
		const plan = buildJellyfinEpisodeScopePlan(scopes, {
			...provenance,
			...(catalogProvenance ? { catalogProvenance } : {}),
		});
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

function validPage(
	page: JellyfinEpisodeItemsPage,
	cursor: number,
	expected: number | null,
	allowGrowth = false,
) {
	if (
		!Number.isSafeInteger(page.startIndex) ||
		page.startIndex !== cursor ||
		!Number.isSafeInteger(page.totalRecordCount) ||
		page.totalRecordCount < 0 ||
		(expected !== null &&
			(allowGrowth ? page.totalRecordCount < expected : page.totalRecordCount !== expected)) ||
		page.items.length > 1_000
	)
		return false;
	if (page.items.length === 0 && cursor < page.totalRecordCount) return false;
	if (cursor + page.items.length > page.totalRecordCount) return false;
	const ids = new Set<string>();
	for (const item of page.items) {
		if (
			item.type !== "Episode" ||
			typeof item.id !== "string" ||
			item.id.length === 0 ||
			ids.has(item.id) ||
			typeof item.seriesId !== "string" ||
			item.seriesId.length === 0 ||
			!Number.isSafeInteger(item.seasonNumber) ||
			(item.seasonNumber as number) < 0 ||
			!Number.isSafeInteger(item.episodeNumber) ||
			(item.episodeNumber as number) < 0 ||
			typeof item.played !== "boolean" ||
			(item.playCount !== undefined &&
				item.playCount !== null &&
				(!Number.isSafeInteger(item.playCount) || item.playCount < 0)) ||
			(item.lastPlayedDate !== null &&
				(typeof item.lastPlayedDate !== "string" ||
					!Number.isFinite(Date.parse(item.lastPlayedDate))))
		)
			return false;
		ids.add(item.id);
	}
	return true;
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
	const allowCatalogGrowth = catalogKey !== null;
	if (
		!persistedScope ||
		persistedScope.userId !== scope.userId ||
		persistedScope.libraryId !== scope.libraryId ||
		(claim.phase !== "collect" && claim.phase !== "verify") ||
		!validPage(page, claim.cursor, claim.expectedRawCount, allowCatalogGrowth)
	)
		return false;
	const userKeyDigest = digest(["jellyfin-user", scope.userId]);
	return await prisma.$transaction(async (tx) => {
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
		if (!run) return false;
		if (catalogKey !== null && catalogKey !== run.parentGenerationId) return false;
		if (
			!run.instance.enabled ||
			(run.instance.service !== "JELLYFIN" && run.instance.service !== "EMBY") ||
			run.instance.connectionGeneration !== run.connectionGeneration ||
			run.instance.identityGeneration !== run.identityGeneration
		)
			return false;
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
			unit.scopeDigest !== scopeDigest(claim.phase, persistedScope)
		)
			return false;
		const nextCursor = page.startIndex + page.items.length;
		const observedRawCount = unit.observedRawCount + page.items.length;
		const expectedRawCount = page.totalRecordCount;
		if (nextCursor !== observedRawCount || nextCursor > expectedRawCount) return false;
		if (page.items.length) {
			let newItems = page.items;
			if (allowCatalogGrowth) {
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
				for (const item of page.items) {
					const prior = existingByItemId.get(item.id);
					if (!prior) continue;
					if (
						prior.unitId !== unit.id ||
						prior.seriesId !== item.seriesId ||
						prior.seasonNumber !== item.seasonNumber ||
						prior.episodeNumber !== item.episodeNumber
					)
						return false;
				}
				newItems = page.items.filter((item) => !existingByItemId.has(item.id));
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
						nextAttemptAt: null,
						completedAt: now,
					}
				: {
						state: "pending",
						claimToken: null,
						cursor: nextCursor,
						expectedRawCount,
						observedRawCount,
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
	});
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

/**
 * Finalization begins with a strict no-mutation gate. Publication is only
 * permitted after every completed scope has an identical collect/verify view;
 * callers layer current-parent and attempt reproof before the replacement step.
 */
export async function finalizeJellyfinEpisodeRun(
	input: FinalizeJellyfinEpisodeRunInput,
): Promise<{ published: boolean; itemCount: number }> {
	const now = input.now ?? new Date();
	const finalize = async (tx: Prisma.TransactionClient) => {
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
		if (!instance || !run) return { published: false, itemCount: 0 };
		const invalidate = async () => {
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
		if ((isV2Run || isV3Run) && (!originalParent || (isV3Run && !originalCatalog)))
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
			return await invalidate();
		const stages = await tx.jellyfinEpisodeObservationStage.findMany({
			where: { runId: run.id },
			orderBy: [{ userKeyDigest: "asc" }, { jellyfinId: "asc" }],
		});
		const collect = stages.filter((stage) => stage.pass === "collect");
		const verify = stages.filter((stage) => stage.pass === "verify");
		const unitsById = new Map(run.units.map((unit) => [unit.id, unit]));
		const stagesByUnit = new Map<string, typeof stages>();
		for (const stage of stages) {
			const rows = stagesByUnit.get(stage.unitId) ?? [];
			rows.push(stage);
			stagesByUnit.set(stage.unitId, rows);
		}
		// V3 publishes partial observations: raw page positions can exceed unique
		// staged identities after overlap. Neither count grants absence authority.
		const invalidStageCardinality = run.units.some((unit) => {
			const stageCount = stagesByUnit.get(unit.id)?.length ?? 0;
			return isV3Run
				? stageCount > unit.observedRawCount || (unit.observedRawCount > 0 && stageCount === 0)
				: stageCount !== unit.observedRawCount;
		});
		if (
			stages.some((stage) => {
				const unit = unitsById.get(stage.unitId);
				return !unit || stage.pass !== unit.phase;
			}) ||
			invalidStageCardinality
		)
			return await invalidate();
		// V3 cannot publish unwatched rows. Their omission or duplicate coordinates
		// must not turn unrelated, verified positive observations into an outage.
		// Retain every staged row for raw coverage accounting below.
		const publicationCandidates = isV3Run ? collect.filter((row) => row.played) : collect;
		const itemIds = new Set<string>();
		const coordinates = new Set<string>();
		const sourceCoordinateByItemId = new Map<string, string>();
		if (isV3Run) {
			const positiveItemIds = new Set(publicationCandidates.map((row) => row.jellyfinId));
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
		for (const row of publicationCandidates) {
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
				? !hasV3StableCoordinateSuperset(publicationCandidates, verify)
				: collect.length !== verify.length ||
					JSON.stringify(canonicalStageRows(collect, false)) !==
						JSON.stringify(canonicalStageRows(verify, false))
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
			return await invalidate();
		const parentDependencyFingerprint = fingerprintJellyfinEpisodeParentDependency(
			instance.id,
			parent.metadata,
			parentRows.map((row) => ({
				...row,
				mediaType: row.mediaType as "movie" | "series",
			})) as JellyfinLibraryRowFingerprintInput[],
		);
		if (!parentDependencyFingerprint) return await invalidate();
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
			let missingMappings = 0;
			let sourceBindings = 0;
			for (const row of stagesByUnit.get(unit.id) ?? []) {
				const showTmdbId = mapped.get(
					isV3Run ? `${unitLibraryById.get(unit.id) ?? ""}\u0000${row.seriesId}` : row.seriesId,
				);
				if (showTmdbId === undefined || showTmdbId === null) {
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
		const publishedRows = isV3Run ? rows.filter((row) => row.watched) : rows;
		const publishedCoordinates = new Set(
			publishedRows.map((row) => `${row.showTmdbId}\0${row.seasonNumber}\0${row.episodeNumber}`),
		);
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
			return { published: false, itemCount: 0 };
		const hasMissingMappings =
			isV3Run || [...coverageByUnit.values()].some((coverage) => coverage.missingMappings > 0);
		const coverageUnits = run.units.map((unit) => {
			const coverage = coverageByUnit.get(unit.id)!;
			const pages = Math.max(1, Math.ceil(unit.expectedRawCount! / 1_000));
			// Raw/source counts still describe the complete observed pass. V3's
			// canonical count describes only coordinates admitted to publication.
			const admittedCoordinates = new Set<string>();
			if (isV3Run)
				for (const row of stagesByUnit.get(unit.id) ?? []) {
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
				acceptedSkips:
					coverage.missingMappings > 0
						? [{ reason: "missing-supported-mapping" as const, count: coverage.missingMappings }]
						: [],
				fatalCount: 0,
			};
		});
		const receipt = hasMissingMappings
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
		const metadata = encodeJellyfinEpisodeGenerationMetadata({
			version: isV3Run ? 3 : isV2Run ? 2 : 1,
			provider: instance.service === "EMBY" ? "emby" : "jellyfin",
			cacheType: "jellyfin_episode",
			publicationLevel: isV3Run || hasMissingMappings ? "positive-only" : "authoritative",
			completeness: isV3Run || hasMissingMappings ? "partial" : "complete",
			canonicalizationVersion: 1,
			itemCount: publishedRows.length,
			connectionGeneration: run.connectionGeneration,
			identityGeneration: run.identityGeneration,
			parentLibraryGenerationId:
				originalParent?.parentLibraryGenerationId ?? parentStatus.generationId,
			parentLibraryMetadataFingerprint:
				originalParent?.parentLibraryMetadataFingerprint ??
				fingerprintJellyfinLibraryGenerationMetadata(parent.metadata),
			...(isV2Run || isV3Run
				? {
						parentLibraryDependencyFingerprint: isV3Run
							? (originalParent?.parentLibraryDependencyFingerprint ?? parentDependencyFingerprint)
							: parentDependencyFingerprint,
					}
				: {}),
			...(isV3Run ? { catalogProvenance: originalCatalog } : {}),
			contentFingerprint: fingerprintJellyfinEpisodeRows(publishedRows),
			coverageReceipt: receipt,
		});
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
				generationId: crypto.randomUUID(),
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
		await tx.jellyfinEpisodeObservationStage.deleteMany({ where: { runId: run.id } });
		return { published: true, itemCount: publishedRows.length };
	};
	if (input.transaction) return await finalize(input.transaction);
	return await input.prisma.$transaction(finalize);
}
