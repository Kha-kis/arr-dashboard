import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, ServiceInstance } from "../prisma.js";
import type { ObservationUnitClaim } from "../provider-observation/observation-run-types.js";
import type { PlexCacheRefreshAttempt } from "../services/provider-cache-status.js";
import {
	createProviderPublicationAuthority,
	type ProviderPublicationAuthority,
	sameProviderPublicationAuthority,
	withCurrentProviderPublicationAuthority,
} from "../services/provider-identity-guard.js";
import {
	listPlexParentGenerationVerificationRows,
	PlexRefreshAttemptSupersededError,
	publishPositivePlexEpisodeGeneration,
} from "./plex-cache-storage.js";
import {
	type CollectedPlexEpisodeUnit,
	createPositivePlexEpisodeDigest,
	type PlexEpisodeRow,
	type PlexPositiveEpisodeParentTarget,
} from "./plex-episode-live-collector.js";
import {
	digestPlexEpisodeUnit,
	type PlannedPlexEpisodeUnit,
	planPlexEpisodeRefresh,
} from "./plex-episode-refresh-plan.js";
import {
	evaluatePlexLatestAttemptTrust,
	evaluatePublishedPlexGeneration,
	type PublishedPlexStatus,
} from "./plex-generation-metadata.js";
import {
	type PlexGenerationTarget,
	readPlexGenerationTargetsForSelection,
	verifyPersistedPlexGenerationTargets,
} from "./plex-generation-target-ledger.js";
import { encodePlexPositiveEpisodeGenerationMetadata } from "./plex-positive-episode-generation-metadata.js";
import { plexConnectionFingerprint } from "./service-instance-fingerprint.js";

const WRITE_CHUNK_SIZE = 100;

function safeCount(value: number): value is number {
	return Number.isSafeInteger(value) && value >= 0;
}

function parentMetadataForFinalization(
	parent: PublishedPlexStatus & {
		connectionGeneration: number | null;
		identityGeneration: number | null;
	},
	run: {
		parentGenerationId: string | null;
		connectionGeneration: number;
		identityGeneration: number;
	},
	now: Date,
) {
	if (
		parent.connectionGeneration !== run.connectionGeneration ||
		parent.identityGeneration !== run.identityGeneration
	)
		return null;
	const evaluated = evaluatePublishedPlexGeneration(parent, { now });
	const retryableParentRefresh =
		evaluated.available &&
		evaluated.evidence.attemptState === "in_progress" &&
		evaluated.evidence.reasonCodes.length === 1 &&
		evaluated.evidence.reasonCodes[0] === "latest_attempt_in_progress";
	if (
		!evaluated.available ||
		(evaluated.evidence.availability !== "current" && !retryableParentRefresh) ||
		evaluated.generationId !== run.parentGenerationId ||
		evaluated.metadata.version !== 6 ||
		(evaluated.metadata.publicationLevel !== "authoritative" &&
			evaluated.metadata.publicationLevel !== "positive-only")
	)
		return null;
	if (
		!safeCount(evaluated.metadata.targetCount) ||
		!/^[a-f0-9]{64}$/.test(evaluated.metadata.targetDigest)
	)
		return null;
	return evaluated.metadata;
}

function mergeRows(
	rows: readonly {
		showTmdbId: number;
		seasonNumber: number;
		episodeNumber: number;
		ratingKey: string;
		title: string;
		watched: boolean;
		watchedByUsers: string;
		lastWatchedAt: Date | null;
		watchCount: number;
		refreshedAt: Date;
		sourceFingerprint: string;
	}[],
) {
	const merged = new Map<string, (typeof rows)[number]>();
	for (const row of rows) {
		const key = `${row.showTmdbId}:${row.seasonNumber}:${row.episodeNumber}`;
		const existing = merged.get(key);
		if (
			!existing ||
			row.watchCount > existing.watchCount ||
			(row.watchCount === existing.watchCount &&
				row.ratingKey.localeCompare(existing.ratingKey) < 0)
		)
			merged.set(key, row);
	}
	return [...merged.values()].sort(
		(left, right) =>
			left.showTmdbId - right.showTmdbId ||
			left.seasonNumber - right.seasonNumber ||
			left.episodeNumber - right.episodeNumber,
	);
}

/** Claim-bound Plex staging deliberately retains the active run after its last unit. */
export async function stagePlexEpisodeUnit(
	prisma: PrismaClient,
	claim: ObservationUnitClaim,
	expectedUnit: PlannedPlexEpisodeUnit,
	result: Extract<CollectedPlexEpisodeUnit, { complete: true }>,
): Promise<boolean> {
	return await prisma.$transaction(
		async (tx) => await stagePlexEpisodeUnitInTransaction(tx, claim, expectedUnit, result),
	);
}

/** Stage and complete one unit inside the caller's exact publication-authority transaction. */
export async function stagePlexEpisodeUnitInTransaction(
	tx: Prisma.TransactionClient,
	claim: ObservationUnitClaim,
	expectedUnit: PlannedPlexEpisodeUnit,
	result: Extract<CollectedPlexEpisodeUnit, { complete: true }>,
): Promise<boolean> {
	let canonicalExpectedUnit: PlannedPlexEpisodeUnit | undefined;
	try {
		if (!Number.isSafeInteger(expectedUnit.ordinal) || expectedUnit.ordinal < 0) return false;
		const normalizedPlan = planPlexEpisodeRefresh(expectedUnit.targets);
		const normalizedUnit = normalizedPlan.units[0];
		if (!normalizedUnit || normalizedPlan.units.length !== 1) return false;
		const expectedScopeKey = `plex-episode-unit:${expectedUnit.ordinal}`;
		const expectedScopeDigest = digestPlexEpisodeUnit(expectedUnit.ordinal, normalizedUnit.targets);
		if (
			expectedUnit.scopeKey !== expectedScopeKey ||
			expectedUnit.scopeDigest !== expectedScopeDigest
		)
			return false;
		canonicalExpectedUnit = {
			ordinal: expectedUnit.ordinal,
			scopeKey: expectedScopeKey,
			scopeDigest: expectedScopeDigest,
			targets: normalizedUnit.targets,
		};
	} catch {
		return false;
	}
	if (!canonicalExpectedUnit || result.refreshedTargets !== canonicalExpectedUnit.targets.length)
		return false;
	const run = await tx.providerObservationRun.findFirst({
		where: {
			id: claim.runId,
			provider: "plex_episode",
			cacheType: "plex_episode",
			state: "running",
			activeSlotKey: { not: null },
			authorityKey: claim.authorityKey,
		},
		include: { instance: true },
	});
	if (!run) return false;
	if (
		run.instance.service !== "PLEX" ||
		!run.instance.enabled ||
		run.instance.identityStatus !== "VERIFIED" ||
		!run.instance.expectedIdentity ||
		run.instance.connectionGeneration !== run.connectionGeneration ||
		run.instance.identityGeneration !== run.identityGeneration
	)
		return false;
	if (
		claim.phase !== "collect" ||
		claim.authorityKey !== run.authorityKey ||
		canonicalExpectedUnit.targets.some(
			(target) =>
				target.instanceId !== run.instanceId || target.generationId !== run.parentGenerationId,
		)
	)
		return false;
	const unit = await tx.providerObservationUnit.findFirst({
		where: {
			id: claim.unitId,
			runId: run.id,
			state: "running",
			claimToken: claim.claimToken,
			phase: "collect",
			scopeKey: claim.scopeKey,
		},
	});
	if (
		!unit ||
		unit.ordinal !== canonicalExpectedUnit.ordinal ||
		unit.scopeKey !== canonicalExpectedUnit.scopeKey ||
		unit.scopeDigest !== canonicalExpectedUnit.scopeDigest ||
		unit.phase !== "collect" ||
		unit.expectedTargets !== canonicalExpectedUnit.targets.length ||
		unit.expectedTargets !== result.refreshedTargets
	)
		return false;
	const expectedFingerprint = plexConnectionFingerprint(run.instance);
	const expectedParents = new Set(canonicalExpectedUnit.targets.map((target) => target.ratingKey));
	const seen = new Set<string>();
	for (const row of result.rows) {
		if (
			!safeCount(row.watchCount) ||
			row.watchCount <= 0 ||
			!safeCount(row.showTmdbId) ||
			row.showTmdbId <= 0 ||
			!safeCount(row.seasonNumber) ||
			!safeCount(row.episodeNumber) ||
			row.instanceId !== run.instanceId ||
			row.sourceFingerprint !== expectedFingerprint ||
			!row.watched ||
			row.watchedByUsers !== "[]" ||
			row.lastWatchedAt !== null ||
			!row.parentRatingKey ||
			!row.ratingKey ||
			!row.title ||
			!row.sourceFingerprint ||
			!expectedParents.has(row.parentRatingKey) ||
			!canonicalExpectedUnit.targets.some(
				(target) =>
					target.ratingKey === row.parentRatingKey && target.showTmdbId === row.showTmdbId,
			)
		)
			return false;
		const key = `${row.parentRatingKey}:${row.seasonNumber}:${row.episodeNumber}`;
		if (seen.has(key)) return false;
		seen.add(key);
	}
	await tx.plexEpisodeObservationStage.deleteMany({ where: { runId: run.id, unitId: unit.id } });
	for (let offset = 0; offset < result.rows.length; offset += WRITE_CHUNK_SIZE) {
		await tx.plexEpisodeObservationStage.createMany({
			data: result.rows.slice(offset, offset + WRITE_CHUNK_SIZE).map((row) => ({
				runId: run.id,
				unitId: unit.id,
				showTmdbId: row.showTmdbId,
				parentRatingKey: row.parentRatingKey,
				seasonNumber: row.seasonNumber,
				episodeNumber: row.episodeNumber,
				ratingKey: row.ratingKey,
				title: row.title,
				watched: row.watched,
				watchedByUsers: row.watchedByUsers,
				lastWatchedAt: row.lastWatchedAt,
				watchCount: row.watchCount,
				refreshedAt: row.refreshedAt,
				sourceFingerprint: row.sourceFingerprint,
			})),
		});
	}
	const completed = await tx.providerObservationUnit.updateMany({
		where: { id: unit.id, runId: run.id, state: "running", claimToken: claim.claimToken },
		data: {
			state: "complete",
			claimToken: null,
			expectedRawCount: null,
			observedRawCount: result.rows.length,
			nextAttemptAt: null,
			completedAt: new Date(),
		},
	});
	if (completed.count !== 1) throw new Error("Plex episode unit claim was superseded");
	const updated = await tx.providerObservationRun.updateMany({
		where: {
			id: run.id,
			state: "running",
			activeSlotKey: { not: null },
			connectionGeneration: run.connectionGeneration,
			identityGeneration: run.identityGeneration,
		},
		data: {
			completedUnits: { increment: 1 },
			completedWork: { increment: unit.expectedTargets },
		},
	});
	if (updated.count !== 1) throw new Error("Plex episode run was superseded");
	return true;
}

export interface FinalizePlexEpisodeRunInput {
	prisma: PrismaClient;
	userId: string;
	instance: ServiceInstance;
	runId: string;
	plexAuthority: unknown;
	attempt: PlexCacheRefreshAttempt;
	now?: Date;
	cleanupRunClaimToken?: string;
	transaction?: Prisma.TransactionClient;
	/** Test-only fault injection; production callers never provide these hooks. */
	testHooks?: {
		beforePublish?: (tx: Prisma.TransactionClient) => void | Promise<void>;
		afterPublish?: (tx: Prisma.TransactionClient) => void | Promise<void>;
	};
}

export type FinalizePlexEpisodeRunResult =
	| { published: true; itemCount: number }
	| {
			published: false;
			itemCount: 0;
			outcome:
				| "incomplete"
				| "parent-refresh-in-progress"
				| "terminal-no-publication"
				| "superseded";
	  };

function unpublishedPlexEpisodeRun(
	outcome: Exclude<FinalizePlexEpisodeRunResult, { published: true }>["outcome"],
): FinalizePlexEpisodeRunResult {
	return { published: false, itemCount: 0, outcome };
}

/** Publishes only a fully staged run, in the same transaction that terminalizes it. */
export async function finalizePlexEpisodeRun(
	input: FinalizePlexEpisodeRunInput,
): Promise<FinalizePlexEpisodeRunResult> {
	const now = input.now ?? new Date();
	let authority: ProviderPublicationAuthority;
	try {
		authority = createProviderPublicationAuthority(input.instance);
	} catch {
		return unpublishedPlexEpisodeRun("superseded");
	}
	if (
		authority.userId !== input.userId ||
		!authority.enabled ||
		authority.identityStatus !== "VERIFIED" ||
		!authority.expectedIdentity
	)
		return unpublishedPlexEpisodeRun("superseded");

	const guardOptions =
		input.cleanupRunClaimToken === undefined
			? {}
			: { cleanupRunClaimToken: input.cleanupRunClaimToken };
	const finalize = async (tx: Prisma.TransactionClient): Promise<FinalizePlexEpisodeRunResult> => {
		const instance = await tx.serviceInstance.findFirst({
			where: { id: authority.id, userId: authority.userId, service: "PLEX", enabled: true },
		});
		if (
			!instance ||
			!sameProviderPublicationAuthority(createProviderPublicationAuthority(instance), authority)
		)
			return unpublishedPlexEpisodeRun("superseded");

		const run = await tx.providerObservationRun.findFirst({
			where: {
				id: input.runId,
				instanceId: authority.id,
				provider: "plex_episode",
				cacheType: "plex_episode",
				state: "running",
				activeSlotKey: { not: null },
			},
			include: { units: true },
		});
		if (
			!run ||
			run.connectionGeneration !== authority.connectionGeneration ||
			run.identityGeneration !== authority.identityGeneration
		)
			return unpublishedPlexEpisodeRun("superseded");

		const status = await tx.cacheRefreshStatus.findUnique({
			where: { instanceId_cacheType: { instanceId: instance.id, cacheType: "plex_episode" } },
		});
		if (
			!status?.lastAttemptAt ||
			status.lastAttemptAt.getTime() !== input.attempt.attemptedAt.getTime() ||
			status.lastAttemptResult !== input.attempt.resultMarker ||
			status.connectionGeneration !== run.connectionGeneration ||
			status.identityGeneration !== run.identityGeneration
		)
			return unpublishedPlexEpisodeRun("superseded");

		const settleWithoutPublication = async (
			outcome: "parent-refresh-in-progress" | "terminal-no-publication",
			invalidate: boolean,
		): Promise<FinalizePlexEpisodeRunResult> => {
			const finished = await tx.cacheRefreshStatus.updateMany({
				where: {
					instanceId: instance.id,
					cacheType: "plex_episode",
					lastAttemptAt: input.attempt.attemptedAt,
					lastAttemptResult: input.attempt.resultMarker,
					connectionGeneration: run.connectionGeneration,
					identityGeneration: run.identityGeneration,
				},
				data: {
					lastAttemptResult: "error",
					lastAttemptErrorMessage: "coverage-incomplete",
				},
			});
			if (finished.count !== 1) throw new PlexRefreshAttemptSupersededError();
			if (invalidate) {
				await tx.plexEpisodeObservationStage.deleteMany({ where: { runId: run.id } });
				await tx.providerObservationUnit.updateMany({
					where: { runId: run.id, state: { notIn: ["complete", "invalidated"] } },
					data: { state: "invalidated", claimToken: null, nextAttemptAt: null },
				});
				const invalidated = await tx.providerObservationRun.updateMany({
					where: {
						id: run.id,
						state: "running",
						activeSlotKey: { not: null },
						authorityKey: run.authorityKey,
						connectionGeneration: run.connectionGeneration,
						identityGeneration: run.identityGeneration,
					},
					data: {
						state: "invalidated",
						activeSlotKey: null,
						nextAttemptAt: null,
						completedAt: now,
						lastReasonCode: "coverage-incomplete",
					},
				});
				if (invalidated.count !== 1) throw new PlexRefreshAttemptSupersededError();
			}
			return unpublishedPlexEpisodeRun(outcome);
		};

		const structurallyValidRun =
			run.totalUnits > 0 &&
			run.totalWork > 0 &&
			run.units.length === run.totalUnits &&
			run.units.every(
				(unit) =>
					unit.phase === "collect" &&
					unit.expectedTargets > 0 &&
					unit.scopeKey === `plex-episode-unit:${unit.ordinal}` &&
					["pending", "running", "complete"].includes(unit.state),
			);
		const completeUnits = run.units.filter((unit) => unit.state === "complete");
		const computedCompletedWork = completeUnits.reduce(
			(total, unit) => total + unit.expectedTargets,
			0,
		);
		if (
			!structurallyValidRun ||
			run.completedUnits !== completeUnits.length ||
			run.completedWork !== computedCompletedWork ||
			run.completedUnits > run.totalUnits ||
			run.completedWork > run.totalWork
		)
			return await settleWithoutPublication("terminal-no-publication", true);
		if (run.completedUnits < run.totalUnits) return unpublishedPlexEpisodeRun("incomplete");
		if (run.completedWork !== run.totalWork || run.units.some((unit) => unit.state !== "complete"))
			return await settleWithoutPublication("terminal-no-publication", true);

		const parent = await tx.cacheRefreshStatus.findUnique({
			where: { instanceId_cacheType: { instanceId: instance.id, cacheType: "plex" } },
		});
		const parentMetadata = parent ? parentMetadataForFinalization(parent, run, now) : null;
		if (!parent || !parentMetadata)
			return await settleWithoutPublication("terminal-no-publication", true);
		const parentTrust = evaluatePlexLatestAttemptTrust(parent, now);
		const exactPositiveOnlyParentAttempt =
			parentTrust.attemptState === "partial" &&
			parentTrust.reasonCode === "latest_attempt_partial" &&
			parentMetadata.version === 6 &&
			parentMetadata.publicationLevel === "positive-only" &&
			parentMetadata.completeness === "partial" &&
			parent.lastAttemptAt?.getTime() === parent.lastRefreshedAt.getTime();
		if (parentTrust.reasonCode !== null && !exactPositiveOnlyParentAttempt) {
			return await settleWithoutPublication(
				parentTrust.attemptState === "in_progress"
					? "parent-refresh-in-progress"
					: "terminal-no-publication",
				parentTrust.attemptState !== "in_progress",
			);
		}

		const ledger = await verifyPersistedPlexGenerationTargets(tx, {
			expected: {
				instanceId: instance.id,
				generationId: run.parentGenerationId!,
				connectionGeneration: run.connectionGeneration,
				identityGeneration: run.identityGeneration,
				targetLedgerVersion: parentMetadata.targetLedgerVersion,
				targetCount: parentMetadata.targetCount,
				targetDigest: parentMetadata.targetDigest,
			},
			sections: parentMetadata.sections,
		});
		if (!ledger.ok) return await settleWithoutPublication("terminal-no-publication", true);
		const [ledgerTargets, parentRows] = await Promise.all([
			readPlexGenerationTargetsForSelection(tx, {
				instanceId: instance.id,
				generationId: run.parentGenerationId!,
			}),
			listPlexParentGenerationVerificationRows(
				tx,
				instance.id,
				run.connectionGeneration,
				run.identityGeneration,
			),
		]);
		if (parentRows.length !== parent.itemCount)
			return await settleWithoutPublication("terminal-no-publication", true);
		const seriesTargets = ledgerTargets.filter((target) => target.mediaType === "series");
		const byRatingKey = new Map(seriesTargets.map((target) => [target.ratingKey, target]));
		const byCoordinate = new Map<string, typeof seriesTargets>();
		for (const target of seriesTargets) {
			const key = `${target.tmdbId}:${target.sectionId}`;
			byCoordinate.set(key, [...(byCoordinate.get(key) ?? []), target]);
		}
		const observed = new Map<string, (typeof seriesTargets)[number]>();
		for (const row of parentRows.filter((row) => row.mediaType === "series")) {
			if (!row.ratingKey) return await settleWithoutPublication("terminal-no-publication", true);
			const target = byRatingKey.get(row.ratingKey);
			if (!target || target.tmdbId !== row.tmdbId || target.sectionId !== row.sectionId)
				return await settleWithoutPublication("terminal-no-publication", true);
			for (const coordinateTarget of byCoordinate.get(`${row.tmdbId}:${row.sectionId}`) ?? [])
				observed.set(coordinateTarget.ratingKey, coordinateTarget);
		}
		let plan: ReturnType<typeof planPlexEpisodeRefresh>;
		try {
			plan = planPlexEpisodeRefresh(
				[...observed.values()].map((target) => ({
					instanceId: target.instanceId,
					generationId: target.generationId,
					showTmdbId: target.tmdbId,
					sectionId: target.sectionId,
					sectionUuid: target.sectionUuid,
					mediaType: "series" as const,
					tvdbId: target.tvdbId,
					ratingKey: target.ratingKey,
				})),
			);
		} catch {
			return await settleWithoutPublication("terminal-no-publication", true);
		}
		if (
			plan.targetCount === 0 ||
			run.targetCount !== plan.targetCount ||
			run.totalWork !== plan.targetCount ||
			run.targetDigest !== plan.targetDigest ||
			plan.units.length !== run.totalUnits ||
			run.units.some((unit) => {
				const expected = plan.units[unit.ordinal];
				return (
					!expected ||
					unit.scopeKey !== expected.scopeKey ||
					unit.scopeDigest !== expected.scopeDigest ||
					unit.expectedTargets !== expected.targets.length
				);
			})
		)
			return await settleWithoutPublication("terminal-no-publication", true);

		const stages = await tx.plexEpisodeObservationStage.findMany({
			where: { runId: run.id },
			orderBy: [
				{ showTmdbId: "asc" },
				{ seasonNumber: "asc" },
				{ episodeNumber: "asc" },
				{ ratingKey: "asc" },
			],
		});
		const stageUnits = new Set(stages.map((row) => row.unitId));
		const expectedFingerprint = plexConnectionFingerprint(instance);
		if (
			stageUnits.size > run.totalUnits ||
			stages.some(
				(row) =>
					!run.units.some((unit) => unit.id === row.unitId) ||
					observed.get(row.parentRatingKey)?.tmdbId !== row.showTmdbId ||
					row.sourceFingerprint !== expectedFingerprint ||
					!safeCount(row.showTmdbId) ||
					row.showTmdbId < 1 ||
					!safeCount(row.seasonNumber) ||
					!safeCount(row.episodeNumber) ||
					!safeCount(row.watchCount) ||
					row.watchCount < 1 ||
					!row.watched ||
					row.watchedByUsers !== "[]" ||
					row.lastWatchedAt !== null,
			)
		)
			return await settleWithoutPublication("terminal-no-publication", true);
		const merged = mergeRows(stages);
		const soleParentGroups = new Map<number, PlexGenerationTarget[]>();
		for (const target of ledgerTargets) {
			if (target.mediaType !== "series") continue;
			const group = soleParentGroups.get(target.tmdbId) ?? [];
			group.push(target);
			soleParentGroups.set(target.tmdbId, group);
		}
		const soleParentTargets: PlexPositiveEpisodeParentTarget[] = [...soleParentGroups.values()]
			.filter((group) => group.length === 1)
			.map((group) => {
				const target = group[0]!;
				return {
					instanceId: target.instanceId,
					generationId: target.generationId,
					showTmdbId: target.tmdbId,
					sectionId: target.sectionId,
					sectionUuid: target.sectionUuid,
					mediaType: "series",
					tvdbId: target.tvdbId,
					ratingKey: target.ratingKey,
				};
			});
		const digestEpisodeRows: PlexEpisodeRow[] = merged.map((row) => ({
			instanceId: instance.id,
			showTmdbId: row.showTmdbId,
			seasonNumber: row.seasonNumber,
			episodeNumber: row.episodeNumber,
			ratingKey: row.ratingKey,
			title: row.title,
			watched: true,
			watchedByUsers: "[]",
			lastWatchedAt: null,
			watchCount: row.watchCount,
			refreshedAt: row.refreshedAt,
			sourceFingerprint: row.sourceFingerprint,
		}));
		const receiptUnits = [...run.units]
			.sort((a, b) => a.ordinal - b.ordinal)
			.map((unit) => {
				const unitRows = stages.filter((row) => row.unitId === unit.id);
				const coordinates = new Set(
					unitRows.map((row) => `${row.showTmdbId}:${row.seasonNumber}:${row.episodeNumber}`),
				);
				return {
					scopeKey: unit.scopeKey,
					expectedRawCount: null,
					pagesAttempted: unit.expectedTargets,
					pagesCompleted: unit.expectedTargets,
					rawObserved: unitRows.length,
					sourceBindings: unitRows.length,
					canonicalEntities: coordinates.size,
					acceptedSkips: [],
					fatalCount: 0,
				};
			});
		const receipt = {
			version: 2 as const,
			provider: "plex_episode" as const,
			attemptStartedAt: status.lastAttemptAt.toISOString(),
			observedAt: now.toISOString(),
			evidence: "positive-only" as const,
			units: receiptUnits,
			publishedCanonicalEntities: merged.length,
			domains: ["episode-inventory", "watch-count"].map((domain) => ({
				domain: domain as "episode-inventory" | "watch-count",
				evidence: "positive-only" as const,
				valueSemantics: "lower-bound" as const,
				units: receiptUnits,
				publishedCanonicalEntities: merged.length,
			})),
		};
		const metadata = encodePlexPositiveEpisodeGenerationMetadata({
			version: 5,
			publicationLevel: "positive-only",
			completeness: "partial",
			itemCount: merged.length,
			canonicalizationVersion: 1,
			capability: {
				domain: "episodes",
				field: "watchCount",
				semantics: "lower-bound",
				operator: "greater_than",
			},
			parentPlexGenerationId: run.parentGenerationId!,
			parentMetadataVersion: 6,
			parentPublicationLevel: parentMetadata.publicationLevel,
			parentTargetDigest: parentMetadata.targetDigest,
			episodeDigest: createPositivePlexEpisodeDigest(soleParentTargets, digestEpisodeRows),
			partialReasons: [],
			coverageReceipt: receipt,
			connectionGeneration: run.connectionGeneration,
			identityGeneration: run.identityGeneration,
		});
		await input.testHooks?.beforePublish?.(tx);
		const publicationInstance = await tx.serviceInstance.findFirst({
			where: { id: authority.id, userId: authority.userId, service: "PLEX", enabled: true },
		});
		if (
			!publicationInstance ||
			!sameProviderPublicationAuthority(
				createProviderPublicationAuthority(publicationInstance),
				authority,
			)
		)
			throw new PlexRefreshAttemptSupersededError();
		await publishPositivePlexEpisodeGeneration(tx, {
			instance: publicationInstance as never,
			rows: merged.map((row) => ({
				instanceId: instance.id,
				showTmdbId: row.showTmdbId,
				seasonNumber: row.seasonNumber,
				episodeNumber: row.episodeNumber,
				ratingKey: row.ratingKey,
				title: row.title,
				watched: true,
				watchedByUsers: "[]",
				lastWatchedAt: null,
				watchCount: row.watchCount,
				refreshedAt: row.refreshedAt,
				sourceFingerprint: row.sourceFingerprint,
				connectionGeneration: run.connectionGeneration,
				identityGeneration: run.identityGeneration,
			})),
			completedAt: now,
			generationId: randomUUID(),
			generationMetadata: metadata,
			attempt: input.attempt,
		});
		await input.testHooks?.afterPublish?.(tx);
		const terminal = await tx.providerObservationRun.updateMany({
			where: {
				id: run.id,
				state: "running",
				activeSlotKey: { not: null },
				authorityKey: run.authorityKey,
				connectionGeneration: run.connectionGeneration,
				identityGeneration: run.identityGeneration,
			},
			data: { state: "complete", activeSlotKey: null, completedAt: now, nextAttemptAt: null },
		});
		if (terminal.count !== 1) throw new PlexRefreshAttemptSupersededError();
		await tx.plexEpisodeObservationStage.deleteMany({ where: { runId: run.id } });
		return { published: true as const, itemCount: merged.length };
	};
	try {
		if (input.transaction) return await finalize(input.transaction);
		const guarded = await withCurrentProviderPublicationAuthority(
			input.prisma,
			authority,
			finalize,
			guardOptions,
		);
		return guarded.matched ? guarded.value : unpublishedPlexEpisodeRun("superseded");
	} catch (error) {
		if (error instanceof PlexRefreshAttemptSupersededError)
			return unpublishedPlexEpisodeRun("superseded");
		throw error;
	}
}
