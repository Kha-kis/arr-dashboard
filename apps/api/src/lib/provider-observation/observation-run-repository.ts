import { randomBytes } from "node:crypto";
import type { ProviderObservationReasonCode } from "@arr/shared";
import type {
	Prisma,
	PrismaClient,
	ProviderObservationRun,
	ProviderObservationUnit,
} from "../prisma.js";
import {
	buildObservationActiveSlotKey,
	buildObservationAuthorityKey,
	decodeProviderObservationReasonCode,
	type ObservationRunAuthority,
	type ObservationRunProvider,
	type ObservationRunUnitSeed,
	type ObservationUnitClaim,
	observationCountSchema,
	observationRunAuthoritySchema,
	parseObservationRunUnitSeed,
} from "./observation-run-types.js";

const AUTOMATIC_ATTEMPT_LIMIT = 3;
const BACKOFF_MS = [30_000, 120_000, 600_000] as const;
export const OBSERVATION_CLAIM_LEASE_MS = 60 * 60 * 1000;
const MAX_CREATE_RETRIES = 3;

type Db = PrismaClient;
type Tx = Parameters<Db["$transaction"]>[0] extends (arg: infer T) => unknown ? T : never;

function activeStateWhere() {
	return { activeSlotKey: { not: null }, state: { in: ["running", "failed"] } };
}

function validateUnitSeeds(
	units: readonly ObservationRunUnitSeed[],
	authority: ObservationRunAuthority,
): ObservationRunUnitSeed[] {
	// Reject duplicate root candidates before parsing any potentially large payload.
	if (units.filter((unit) => unit.ordinal === 0).length > 1)
		throw new Error("Observation root ordinal must be unique");
	const parsed = units.map((unit) => parseObservationRunUnitSeed(unit, authority));
	if (parsed.length === 0 || parsed.every((unit) => unit.phase !== "collect")) {
		throw new Error("Provider observation runs require at least one collect unit");
	}
	const ordinals = new Set<number>();
	const scopes = new Set<string>();
	for (const unit of parsed) {
		if (ordinals.has(unit.ordinal) || scopes.has(unit.scopeKey)) {
			throw new Error("Provider observation unit ordinals and scope keys must be unique");
		}
		ordinals.add(unit.ordinal);
		scopes.add(unit.scopeKey);
	}
	let sawVerify = false;
	let sawCollect = false;
	for (const unit of [...parsed].sort((left, right) => left.ordinal - right.ordinal)) {
		if (unit.phase === "verify") {
			if (!sawCollect)
				throw new Error("Provider observation runs require collect units before verify units");
			sawVerify = true;
		} else {
			if (sawVerify)
				throw new Error("Provider observation collect units must precede verify units");
			sawCollect = true;
		}
	}
	const total = parsed.reduce((sum, unit) => sum + unit.expectedTargets, 0);
	observationCountSchema.parse(total);
	return parsed;
}

/** Serialize observation work against a ServiceInstance generation update. */
async function lockObservationAuthority(
	tx: Pick<Tx, "$executeRaw">,
	instanceId: string,
	connectionGeneration: number,
	identityGeneration: number,
): Promise<boolean> {
	const affected = await tx.$executeRaw`
		UPDATE "ServiceInstance"
		SET "connectionGeneration" = "connectionGeneration"
		WHERE "id" = ${instanceId}
		  AND "connectionGeneration" = ${connectionGeneration}
		  AND "identityGeneration" = ${identityGeneration}
	`;
	return affected === 1;
}

function runCreateData(
	authority: ObservationRunAuthority,
	units: readonly ObservationRunUnitSeed[],
	authorityKey: string,
	slotKey: string,
) {
	const parsedAuthority = observationRunAuthoritySchema.parse(authority);
	const parsedUnits = validateUnitSeeds(units, authority);
	if (
		parsedAuthority.provider === "plex_episode" &&
		parsedUnits.some((unit) => unit.phase === "verify")
	) {
		throw new Error("Plex observation runs do not support verify units");
	}
	return {
		instanceId: parsedAuthority.instanceId,
		provider: parsedAuthority.provider,
		cacheType: parsedAuthority.cacheType,
		authorityKey,
		activeSlotKey: slotKey,
		parentGenerationId: parsedAuthority.parentGenerationId ?? null,
		targetDigest: parsedAuthority.targetDigest,
		targetCount: parsedUnits.reduce((total, unit) => total + unit.expectedTargets, 0),
		connectionGeneration: parsedAuthority.connectionGeneration,
		identityGeneration: parsedAuthority.identityGeneration,
		state: "running",
		totalUnits: parsedUnits.length,
		totalWork: parsedUnits.reduce((total, unit) => total + unit.expectedTargets, 0),
		completedUnits: 0,
		completedWork: 0,
		completedAt: parsedUnits.length === 0 ? new Date() : null,
		units: {
			create: parsedUnits.map((unit) => ({
				ordinal: unit.ordinal,
				scopeKey: unit.scopeKey,
				scopeDigest: unit.scopeDigest,
				scopePayload: unit.scopePayload ?? null,
				phase: unit.phase,
				expectedTargets: unit.expectedTargets,
				state: "pending",
			})),
		},
	};
}

function isRetryableUnit(
	unit: { state: string; attemptCount: number; nextAttemptAt: Date | null },
	now: Date,
) {
	return (
		(unit.state === "pending" ||
			(unit.state === "failed" && unit.attemptCount <= AUTOMATIC_ATTEMPT_LIMIT)) &&
		(unit.nextAttemptAt === null || unit.nextAttemptAt.getTime() <= now.getTime())
	);
}

export async function createOrLoadObservationRun(
	prisma: Db,
	input: {
		authority: ObservationRunAuthority;
		units: readonly ObservationRunUnitSeed[];
		resumeFailed?: boolean;
	},
): Promise<ProviderObservationRun> {
	const authority = {
		...observationRunAuthoritySchema.parse(input.authority),
		parentGenerationId: input.authority.parentGenerationId ?? null,
	};
	const units = validateUnitSeeds(input.units, authority);
	if (authority.provider === "plex_episode" && units.some((unit) => unit.phase === "verify")) {
		throw new Error("Plex observation runs do not support verify units");
	}
	const authorityKey = buildObservationAuthorityKey(authority);
	const slotKey = buildObservationActiveSlotKey({
		instanceId: authority.instanceId,
		cacheType: authority.cacheType,
	});
	if (authority.provider !== authority.cacheType)
		throw new Error("Provider and cache type must match");
	for (let attempt = 0; attempt < MAX_CREATE_RETRIES; attempt++) {
		try {
			return await prisma.$transaction(async (tx) => {
				if (
					!(await lockObservationAuthority(
						tx,
						authority.instanceId,
						authority.connectionGeneration,
						authority.identityGeneration,
					))
				)
					throw new Error("Provider observation authority is stale");
				const active = await tx.providerObservationRun.findFirst({
					where: {
						instanceId: authority.instanceId,
						cacheType: authority.cacheType,
						...activeStateWhere(),
					},
					orderBy: { createdAt: "desc" },
					include: { units: true },
				});
				if (active?.authorityKey === authorityKey) {
					if (input.resumeFailed && active.state === "failed") {
						await tx.providerObservationUnit.updateMany({
							where: { runId: active.id, state: "failed" },
							data: {
								state: "pending",
								claimToken: null,
								attemptCount: 0,
								nextAttemptAt: null,
								lastReasonCode: null,
							},
						});
						return await tx.providerObservationRun.update({
							where: { id: active.id },
							data: {
								state: "running",
								activeSlotKey: slotKey,
								nextAttemptAt: null,
								lastReasonCode: null,
							},
							include: { units: true },
						});
					}
					return active;
				}
				if (active) {
					await invalidateRun(tx, active.id);
				}
				return await tx.providerObservationRun.create({
					data: runCreateData(authority, units, authorityKey, slotKey),
					include: { units: true },
				});
			});
		} catch (error) {
			if (attempt === MAX_CREATE_RETRIES - 1 || !isUniqueOrSerializationConflict(error))
				throw error;
			const winner = await prisma.$transaction(async (tx) => {
				if (
					!(await lockObservationAuthority(
						tx,
						authority.instanceId,
						authority.connectionGeneration,
						authority.identityGeneration,
					))
				)
					return null;
				return await tx.providerObservationRun.findFirst({
					where: {
						activeSlotKey: slotKey,
						state: { in: ["running", "failed"] },
						connectionGeneration: authority.connectionGeneration,
						identityGeneration: authority.identityGeneration,
					},
					include: { units: true },
				});
			});
			if (winner?.authorityKey === authorityKey) return winner;
		}
	}
	throw new Error("Observation run creation retries exhausted");
}

function isUniqueOrSerializationConflict(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		["P2002", "P2034"].includes(String(error.code))
	);
}

async function invalidateRun(tx: Tx, runId: string): Promise<void> {
	await tx.plexEpisodeObservationStage.deleteMany({ where: { runId } });
	await tx.jellyfinEpisodeObservationStage.deleteMany({ where: { runId } });
	await tx.providerObservationUnit.updateMany({
		where: { runId, state: { notIn: ["complete", "invalidated"] } },
		data: { state: "invalidated", claimToken: null, nextAttemptAt: null },
	});
	await tx.providerObservationRun.update({
		where: { id: runId },
		data: {
			state: "invalidated",
			activeSlotKey: null,
			nextAttemptAt: null,
			completedAt: new Date(),
		},
	});
}

export async function claimObservationUnit(
	prisma: Db,
	input: { runId: string; now: Date; claimToken?: string },
): Promise<ObservationUnitClaim | null> {
	const token = input.claimToken ?? randomBytes(32).toString("hex");
	return await prisma.$transaction(async (tx) => {
		const authorityRow = await tx.providerObservationRun.findFirst({
			where: {
				id: input.runId,
				activeSlotKey: { not: null },
				state: { in: ["running", "failed"] },
			},
			select: { id: true, instanceId: true, connectionGeneration: true, identityGeneration: true },
		});
		if (!authorityRow) return null;
		if (
			!(await lockObservationAuthority(
				tx,
				authorityRow.instanceId,
				authorityRow.connectionGeneration,
				authorityRow.identityGeneration,
			))
		) {
			await invalidateRun(tx, authorityRow.id);
			return null;
		}
		const activeRun = await tx.providerObservationRun.findUnique({
			where: { id: authorityRow.id },
			include: { instance: true },
		});
		if (
			!activeRun ||
			activeRun.activeSlotKey === null ||
			!["running", "failed"].includes(activeRun.state)
		)
			return null;
		if (
			activeRun.instance.connectionGeneration !== activeRun.connectionGeneration ||
			activeRun.instance.identityGeneration !== activeRun.identityGeneration
		) {
			await invalidateRun(tx, activeRun.id);
			return null;
		}
		await tx.providerObservationUnit.updateMany({
			where: { runId: input.runId, state: "running", nextAttemptAt: { lte: input.now } },
			data: { state: "pending", claimToken: null, nextAttemptAt: null },
		});
		const liveClaims = await tx.providerObservationUnit.count({
			where: { runId: input.runId, state: "running" },
		});
		if (liveClaims > 0) return null;
		if (
			activeRun.state === "failed" &&
			(activeRun.nextAttemptAt === null || activeRun.nextAttemptAt.getTime() > input.now.getTime())
		) {
			return null;
		}
		const candidates = await tx.providerObservationUnit.findFirst({
			where: {
				runId: input.runId,
				...(activeRun.state === "failed"
					? { state: "failed", attemptCount: { lte: AUTOMATIC_ATTEMPT_LIMIT } }
					: {
							OR: [
								{ state: "pending" },
								{ state: "failed", attemptCount: { lte: AUTOMATIC_ATTEMPT_LIMIT } },
							],
						}),
				AND: [{ OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: input.now } }] }],
			},
			orderBy: { ordinal: "asc" },
		});
		if (!candidates || !isRetryableUnit(candidates, input.now)) return null;
		if (candidates.phase === "verify") {
			const incompleteCollect = await tx.providerObservationUnit.count({
				where: { runId: input.runId, phase: "collect", state: { not: "complete" } },
			});
			if (incompleteCollect > 0) return null;
		}
		const result = await tx.providerObservationUnit.updateMany({
			where: {
				id: candidates.id,
				runId: input.runId,
				state: candidates.state,
				claimToken: candidates.claimToken,
				OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: input.now } }],
			},
			data: {
				state: "running",
				claimToken: token,
				nextAttemptAt: new Date(input.now.getTime() + OBSERVATION_CLAIM_LEASE_MS),
			},
		});
		if (result.count !== 1) return null;
		await tx.providerObservationRun.updateMany({
			where: { id: input.runId, state: "failed" },
			data: { state: "running", nextAttemptAt: null, lastReasonCode: null },
		});
		const claimed = await tx.providerObservationUnit.findUnique({ where: { id: candidates.id } });
		if (!claimed) return null;
		const run = await tx.providerObservationRun.findUnique({ where: { id: input.runId } });
		if (!run) return null;
		return {
			runId: run.id,
			unitId: claimed.id,
			claimToken: token,
			authorityKey: run.authorityKey,
			scopeKey: claimed.scopeKey,
			scopePayload: claimed.scopePayload,
			phase: claimed.phase as "collect" | "verify",
			cursor: claimed.cursor,
			expectedRawCount: claimed.expectedRawCount,
			observedRawCount: claimed.observedRawCount,
		};
	});
}

/**
 * Proves that an active failed run has exhausted automatic retries without a
 * live/retryable unit. Pending units are expected after the first exhausted
 * unit because a failed run deliberately blocks the rest until an explicit
 * resume epoch.
 */
export async function hasExhaustedObservationRunRetries(
	prisma: Pick<Tx, "providerObservationRun" | "providerObservationUnit">,
	input: { runId: string; authorityKey: string },
): Promise<boolean> {
	const run = await prisma.providerObservationRun.findFirst({
		where: {
			id: input.runId,
			authorityKey: input.authorityKey,
			activeSlotKey: { not: null },
			state: "failed",
			nextAttemptAt: null,
		},
		select: {
			totalUnits: true,
			completedUnits: true,
			totalWork: true,
			completedWork: true,
		},
	});
	if (!run) return false;
	const units = await readObservationUnitLedger(prisma, input.runId);
	if (!observationLedgerIsConsistent(run, units)) return false;
	const exhaustedFailures = units.filter(
		(unit) =>
			unit.state === "failed" &&
			unit.attemptCount > AUTOMATIC_ATTEMPT_LIMIT &&
			unit.nextAttemptAt === null,
	).length;
	const blocked = units.some(
		(unit) =>
			unit.state === "running" ||
			unit.state === "invalidated" ||
			(unit.state === "failed" &&
				(unit.attemptCount <= AUTOMATIC_ATTEMPT_LIMIT || unit.nextAttemptAt !== null)),
	);
	return exhaustedFailures > 0 && !blocked;
}

export type AutomaticObservationRenewalMode = "provider-unavailable-cooldown";

export type AutomaticObservationRenewalResult = "renewed" | "deferred";

export type AutomaticObservationRenewalInput = {
	runId: string;
	instanceId: string;
	userId: string;
	authorityKey: string;
	parentGenerationId: string;
	targetDigest: string;
	connectionGeneration: number;
	identityGeneration: number;
	now: Date;
};

type AutomaticObservationRenewalProofInput = {
	runId: string;
	instanceId: string;
	authorityKey: string;
	parentGenerationId: string;
	targetDigest: string;
	connectionGeneration: number;
	identityGeneration: number;
	now: Date;
};

export const PROVIDER_UNAVAILABLE_RENEWAL_COOLDOWN_MS = 30 * 60 * 1000;
const JELLYFIN_EPISODE_V3_PARENT_PATTERN = /^jellyfin-episode-parent-v3:[a-f0-9]{64}$/;
const OBSERVATION_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Reads the same fully validated exhausted V3 outage proof used by mutation
 * admission. A caller may use the returned deadline as a scheduling hint, but
 * must still run renewExhaustedObservationRun before changing retry state.
 */
export async function getAutomaticObservationRenewalDeadline(
	prisma: Db,
	input: AutomaticObservationRenewalInput,
): Promise<Date | null> {
	if (!Number.isFinite(input.now.getTime())) return null;
	return await prisma.$transaction(async (tx) => {
		const candidate = await readAutomaticRenewalCandidate(tx, input);
		return candidate?.deadline ?? null;
	});
}

async function readAutomaticRenewalCandidate(
	prisma: Pick<Tx, "serviceInstance" | "providerObservationRun">,
	input: AutomaticObservationRenewalInput,
): Promise<{
	run: ProviderObservationRun & { units: ProviderObservationUnit[] };
	deadline: Date;
} | null> {
	if (
		!Number.isFinite(input.now.getTime()) ||
		!Number.isSafeInteger(input.connectionGeneration) ||
		!Number.isSafeInteger(input.identityGeneration) ||
		!JELLYFIN_EPISODE_V3_PARENT_PATTERN.test(input.parentGenerationId) ||
		!OBSERVATION_DIGEST_PATTERN.test(input.targetDigest)
	)
		return null;
	const expectedAuthorityKey = buildObservationAuthorityKey({
		provider: "jellyfin_episode",
		cacheType: "jellyfin_episode",
		instanceId: input.instanceId,
		parentGenerationId: input.parentGenerationId,
		targetDigest: input.targetDigest,
		connectionGeneration: input.connectionGeneration,
		identityGeneration: input.identityGeneration,
	});
	if (input.authorityKey !== expectedAuthorityKey) return null;
	const instance = await prisma.serviceInstance.findUnique({
		where: { id: input.instanceId },
		select: {
			userId: true,
			service: true,
			enabled: true,
			identityStatus: true,
			connectionGeneration: true,
			identityGeneration: true,
		},
	});
	if (
		!instance ||
		instance.userId !== input.userId ||
		!instance.enabled ||
		!(instance.service === "JELLYFIN" || instance.service === "EMBY") ||
		instance.identityStatus !== "VERIFIED" ||
		instance.connectionGeneration !== input.connectionGeneration ||
		instance.identityGeneration !== input.identityGeneration
	)
		return null;
	const run = await prisma.providerObservationRun.findUnique({
		where: { id: input.runId },
		include: { units: true },
	});
	if (!run || run.instanceId !== input.instanceId) return null;
	const deadline = automaticRenewalDeadlineForRun(run, input);
	return deadline === null ? null : { run, deadline };
}

function automaticRenewalDeadlineForRun(
	run: ProviderObservationRun & { units: ProviderObservationUnit[] },
	input: Pick<
		AutomaticObservationRenewalInput,
		| "instanceId"
		| "authorityKey"
		| "parentGenerationId"
		| "targetDigest"
		| "connectionGeneration"
		| "identityGeneration"
		| "now"
	>,
): Date | null {
	if (
		run.provider !== "jellyfin_episode" ||
		run.cacheType !== "jellyfin_episode" ||
		run.authorityKey !== input.authorityKey ||
		run.parentGenerationId !== input.parentGenerationId ||
		run.targetDigest !== input.targetDigest ||
		run.connectionGeneration !== input.connectionGeneration ||
		run.identityGeneration !== input.identityGeneration ||
		run.activeSlotKey !==
			buildObservationActiveSlotKey({
				instanceId: input.instanceId,
				cacheType: "jellyfin_episode",
			}) ||
		run.state !== "failed" ||
		run.nextAttemptAt !== null ||
		run.lastReasonCode !== "provider-unavailable" ||
		!observationLedgerIsConsistent(run, run.units)
	)
		return null;
	const failedUnits = run.units.filter((unit) => unit.state === "failed");
	if (failedUnits.length === 0) return null;
	for (const unit of run.units) {
		if (unit.state === "complete") continue;
		if (unit.state === "pending") {
			if (unit.claimToken !== null || unit.nextAttemptAt !== null) return null;
			continue;
		}
		if (
			unit.state !== "failed" ||
			unit.attemptCount <= AUTOMATIC_ATTEMPT_LIMIT ||
			unit.nextAttemptAt !== null ||
			unit.claimToken !== null ||
			unit.lastReasonCode !== "provider-unavailable"
		)
			return null;
	}
	const relevantTimestamps = [run.updatedAt, ...failedUnits.map((unit) => unit.updatedAt)];
	if (
		relevantTimestamps.some(
			(value) => !isValidObservationDate(value) || value.getTime() > input.now.getTime(),
		)
	)
		return null;
	const latest = Math.max(...relevantTimestamps.map((value) => value.getTime()));
	const deadline = new Date(latest + PROVIDER_UNAVAILABLE_RENEWAL_COOLDOWN_MS);
	return isValidObservationDate(deadline) ? deadline : null;
}

/**
 * Reopens one exhausted Jellyfin V3 run for a periodic provider-outage retry.
 * The caller must have already validated the saved V3 plan and current parent;
 * this transaction repeats the durable run and authority fences before changing
 * any retry state.
 */
export async function renewExhaustedObservationRun(
	prisma: Db,
	input: AutomaticObservationRenewalInput & { mode: AutomaticObservationRenewalMode },
): Promise<AutomaticObservationRenewalResult> {
	if (input.mode !== "provider-unavailable-cooldown" || !Number.isFinite(input.now.getTime()))
		return "deferred";

	const casLost = Symbol("automatic observation renewal CAS lost");
	try {
		return await prisma.$transaction(async (tx) => {
			if (
				!(await lockObservationAuthority(
					tx,
					input.instanceId,
					input.connectionGeneration,
					input.identityGeneration,
				))
			)
				return "deferred";
			const candidate = await readAutomaticRenewalCandidate(tx, input);
			if (!candidate || candidate.deadline.getTime() > input.now.getTime()) return "deferred";
			const { run } = candidate;
			const failedUnits = run.units.filter((unit) => unit.state === "failed");

			const updatedRun = await tx.providerObservationRun.updateMany({
				where: {
					id: input.runId,
					instanceId: input.instanceId,
					provider: "jellyfin_episode",
					cacheType: "jellyfin_episode",
					authorityKey: input.authorityKey,
					parentGenerationId: input.parentGenerationId,
					targetDigest: input.targetDigest,
					activeSlotKey: run.activeSlotKey,
					connectionGeneration: input.connectionGeneration,
					identityGeneration: input.identityGeneration,
					state: "failed",
					nextAttemptAt: null,
					lastReasonCode: "provider-unavailable",
					updatedAt: run.updatedAt,
				},
				data: { state: "running", nextAttemptAt: null, lastReasonCode: null },
			});
			if (updatedRun.count !== 1) throw casLost;

			for (const unit of failedUnits) {
				const updatedUnit = await tx.providerObservationUnit.updateMany({
					where: {
						id: unit.id,
						runId: input.runId,
						state: "failed",
						attemptCount: { gt: AUTOMATIC_ATTEMPT_LIMIT },
						nextAttemptAt: null,
						claimToken: null,
						lastReasonCode: "provider-unavailable",
						updatedAt: unit.updatedAt,
					},
					data: {
						state: "pending",
						claimToken: null,
						attemptCount: 0,
						nextAttemptAt: null,
						lastReasonCode: null,
					},
				});
				if (updatedUnit.count !== 1) throw casLost;
			}
			return "renewed";
		});
	} catch (error) {
		if (error === casLost) return "deferred";
		throw error;
	}
}

/**
 * Proves that an owned automatic renewal may settle its outer marker without
 * changing the observation run. The marker transaction calls this through the
 * current provider-authority fence, so a renewed, claimed, or changed run is
 * never reported as a local collection deferral.
 */
export async function canSettleAutomaticObservationRenewalDeferred(
	prisma: Pick<Tx, "$executeRaw" | "providerObservationRun">,
	input: AutomaticObservationRenewalProofInput,
): Promise<boolean> {
	if (
		!Number.isFinite(input.now.getTime()) ||
		!JELLYFIN_EPISODE_V3_PARENT_PATTERN.test(input.parentGenerationId)
	)
		return false;
	const expectedAuthorityKey = buildObservationAuthorityKey({
		provider: "jellyfin_episode",
		cacheType: "jellyfin_episode",
		instanceId: input.instanceId,
		parentGenerationId: input.parentGenerationId,
		targetDigest: input.targetDigest,
		connectionGeneration: input.connectionGeneration,
		identityGeneration: input.identityGeneration,
	});
	if (input.authorityKey !== expectedAuthorityKey) return false;
	const candidate = await prisma.providerObservationRun.findUnique({
		where: { id: input.runId },
		include: { units: true },
	});
	if (!candidate) return false;
	if (!isAutomaticRenewalDeferredProof(candidate, input, expectedAuthorityKey)) return false;
	const lockedRun = await prisma.$executeRaw`
		UPDATE "provider_observation_runs"
		SET "updatedAt" = "updatedAt"
		WHERE "id" = ${candidate.id} AND "updatedAt" = ${candidate.updatedAt}
	`;
	if (lockedRun !== 1) return false;
	for (const unit of candidate.units) {
		const lockedUnit = await prisma.$executeRaw`
			UPDATE "provider_observation_units"
			SET "updatedAt" = "updatedAt"
			WHERE "id" = ${unit.id}
			  AND "runId" = ${candidate.id}
			  AND "updatedAt" = ${unit.updatedAt}
		`;
		if (lockedUnit !== 1) return false;
	}
	const current = await prisma.providerObservationRun.findUnique({
		where: { id: input.runId },
		include: { units: true },
	});
	return isAutomaticRenewalDeferredProof(current, input, expectedAuthorityKey);
}

function isAutomaticRenewalDeferredProof(
	run: (ProviderObservationRun & { units: ProviderObservationUnit[] }) | null,
	input: AutomaticObservationRenewalProofInput,
	expectedAuthorityKey: string,
): boolean {
	if (
		!run ||
		run.instanceId !== input.instanceId ||
		run.provider !== "jellyfin_episode" ||
		run.cacheType !== "jellyfin_episode" ||
		run.authorityKey !== expectedAuthorityKey ||
		run.parentGenerationId !== input.parentGenerationId ||
		run.targetDigest !== input.targetDigest ||
		run.connectionGeneration !== input.connectionGeneration ||
		run.identityGeneration !== input.identityGeneration ||
		run.activeSlotKey !==
			buildObservationActiveSlotKey({
				instanceId: input.instanceId,
				cacheType: "jellyfin_episode",
			}) ||
		run.state !== "failed" ||
		run.nextAttemptAt !== null ||
		typeof run.lastReasonCode !== "string" ||
		!isRenewalCutoffDate(run.updatedAt, input.now, input.now) ||
		!observationLedgerIsConsistent(run, run.units)
	)
		return false;
	const failedUnits = run.units.filter((unit) => unit.state === "failed");
	if (failedUnits.length === 0) return false;
	return run.units.every((unit) => {
		if (unit.state === "complete") return true;
		if (unit.state === "pending") return unit.claimToken === null && unit.nextAttemptAt === null;
		return (
			unit.state === "failed" &&
			unit.attemptCount > AUTOMATIC_ATTEMPT_LIMIT &&
			unit.claimToken === null &&
			unit.nextAttemptAt === null &&
			typeof unit.lastReasonCode === "string" &&
			isRenewalCutoffDate(unit.updatedAt, input.now, input.now)
		);
	});
}

function isRenewalCutoffDate(value: Date, cutoff: Date, now: Date): boolean {
	const timestamp = value.getTime();
	return Number.isFinite(timestamp) && timestamp <= cutoff.getTime() && timestamp <= now.getTime();
}

export type RecoverableObservationRunForCacheAttempt = {
	runId: string;
	authorityKey: string;
	connectionGeneration: number;
	identityGeneration: number;
	hasInheritedClaim: boolean;
	inheritedClaims: Array<{ unitId: string; claimToken: string }>;
};

/**
 * Inspects a restart-inherited episode attempt only when a matching active run
 * has a sound ledger. A running unit is reported separately because startup
 * recovery must rotate the outer attempt marker before reclaiming that lease.
 */
export async function inspectRecoverableObservationRunForCacheAttempt(
	prisma: Pick<Tx, "providerObservationRun" | "providerObservationUnit">,
	input: {
		instanceId: string;
		cacheType: ObservationRunProvider;
		connectionGeneration: number;
		identityGeneration: number;
	},
): Promise<RecoverableObservationRunForCacheAttempt | null> {
	const run = await prisma.providerObservationRun.findFirst({
		where: {
			instanceId: input.instanceId,
			provider: input.cacheType,
			cacheType: input.cacheType,
			connectionGeneration: input.connectionGeneration,
			identityGeneration: input.identityGeneration,
			activeSlotKey: { not: null },
			state: { in: ["running", "failed"] },
		},
		orderBy: { createdAt: "desc" },
		select: {
			id: true,
			authorityKey: true,
			state: true,
			connectionGeneration: true,
			identityGeneration: true,
			totalUnits: true,
			completedUnits: true,
			totalWork: true,
			completedWork: true,
		},
	});
	if (!run) return null;
	const units = await readObservationUnitLedger(prisma, run.id);
	if (!observationLedgerIsConsistent(run, units)) return null;
	if (run.completedUnits >= run.totalUnits) return null;
	if (run.state === "failed" && !units.some((unit) => unit.state === "failed")) return null;
	if (run.state === "failed" && units.some((unit) => unit.state === "running")) return null;
	if (units.some((unit) => unit.state === "invalidated")) return null;
	const inheritedClaims = units
		.filter(
			(unit): unit is typeof unit & { id: string; claimToken: string } =>
				unit.state === "running" && typeof unit.claimToken === "string",
		)
		.map((unit) => ({ unitId: unit.id, claimToken: unit.claimToken }));
	return {
		runId: run.id,
		authorityKey: run.authorityKey,
		connectionGeneration: run.connectionGeneration,
		identityGeneration: run.identityGeneration,
		hasInheritedClaim: inheritedClaims.length > 0,
		inheritedClaims,
	};
}

/** Release only the exact claim proven to be inherited by startup recovery. */
export async function releaseInheritedObservationUnitClaim(
	prisma: Pick<Tx, "providerObservationRun" | "providerObservationUnit" | "$executeRaw">,
	input: {
		runId: string;
		unitId: string;
		claimToken: string;
		instanceId: string;
		cacheType: ObservationRunProvider;
		authorityKey: string;
		connectionGeneration: number;
		identityGeneration: number;
	},
): Promise<boolean> {
	const run = await prisma.providerObservationRun.findUnique({
		where: { id: input.runId },
		select: {
			id: true,
			instanceId: true,
			provider: true,
			cacheType: true,
			authorityKey: true,
			activeSlotKey: true,
			state: true,
			connectionGeneration: true,
			identityGeneration: true,
		},
	});
	if (
		!run ||
		run.instanceId !== input.instanceId ||
		run.provider !== input.cacheType ||
		run.cacheType !== input.cacheType ||
		run.authorityKey !== input.authorityKey ||
		run.activeSlotKey === null ||
		!(["running", "failed"] as string[]).includes(run.state) ||
		run.connectionGeneration !== input.connectionGeneration ||
		run.identityGeneration !== input.identityGeneration ||
		!(await lockObservationAuthority(
			prisma,
			run.instanceId,
			run.connectionGeneration,
			run.identityGeneration,
		))
	) {
		return false;
	}
	const result = await prisma.providerObservationUnit.updateMany({
		where: {
			id: input.unitId,
			runId: input.runId,
			state: "running",
			claimToken: input.claimToken,
		},
		data: { state: "pending", claimToken: null, nextAttemptAt: null },
	});
	return result.count === 1;
}

export async function hasRecoverableObservationRunForCacheAttempt(
	prisma: Pick<Tx, "providerObservationRun" | "providerObservationUnit">,
	input: {
		instanceId: string;
		cacheType: ObservationRunProvider;
		connectionGeneration: number;
		identityGeneration: number;
	},
): Promise<boolean> {
	return (await inspectRecoverableObservationRunForCacheAttempt(prisma, input)) !== null;
}

type ObservationRunLedger = {
	totalUnits: number;
	completedUnits: number;
	totalWork: number;
	completedWork: number;
};

type ObservationUnitLedger = {
	id: string;
	state: string;
	attemptCount: number;
	nextAttemptAt: Date | null;
	expectedTargets: number;
	claimToken: string | null;
};

async function readObservationUnitLedger(
	prisma: Pick<Tx, "providerObservationUnit">,
	runId: string,
): Promise<ObservationUnitLedger[]> {
	return await prisma.providerObservationUnit.findMany({
		where: { runId },
		select: {
			id: true,
			state: true,
			attemptCount: true,
			nextAttemptAt: true,
			expectedTargets: true,
			claimToken: true,
		},
	});
}

function observationLedgerIsConsistent(
	run: ObservationRunLedger,
	units: readonly ObservationUnitLedger[],
): boolean {
	if (
		![run.totalUnits, run.completedUnits, run.totalWork, run.completedWork].every(
			(value) => Number.isSafeInteger(value) && value >= 0,
		) ||
		units.length !== run.totalUnits
	)
		return false;
	let completedUnits = 0;
	let totalWork = 0;
	let completedWork = 0;
	for (const unit of units) {
		if (
			!["pending", "running", "complete", "failed", "invalidated"].includes(unit.state) ||
			!Number.isSafeInteger(unit.attemptCount) ||
			unit.attemptCount < 0 ||
			!Number.isSafeInteger(unit.expectedTargets) ||
			unit.expectedTargets < 0 ||
			(unit.nextAttemptAt !== null && !isValidObservationDate(unit.nextAttemptAt)) ||
			(unit.state === "running"
				? typeof unit.claimToken !== "string" || unit.claimToken.length === 0
				: unit.claimToken !== null)
		)
			return false;
		totalWork += unit.expectedTargets;
		if (!Number.isSafeInteger(totalWork)) return false;
		if (unit.state === "complete") {
			completedUnits += 1;
			completedWork += unit.expectedTargets;
			if (!Number.isSafeInteger(completedWork)) return false;
		}
	}
	return (
		completedUnits === run.completedUnits &&
		totalWork === run.totalWork &&
		completedWork === run.completedWork
	);
}

function isValidObservationDate(value: Date): boolean {
	return Number.isFinite(value.getTime());
}

export async function advanceObservationUnit(
	prisma: Db,
	input: {
		claim: ObservationUnitClaim;
		cursor: number;
		expectedRawCount: number;
		observedRawCount: number;
		now?: Date;
	},
): Promise<boolean> {
	const cursor = observationCountSchema.parse(input.cursor);
	const expectedRawCount = observationCountSchema.parse(input.expectedRawCount);
	const observedRawCount = observationCountSchema.parse(input.observedRawCount);
	const now = input.now ?? new Date();
	const result = await prisma.providerObservationUnit.updateMany({
		where: {
			id: input.claim.unitId,
			runId: input.claim.runId,
			state: "running",
			claimToken: input.claim.claimToken,
		},
		data: {
			cursor,
			expectedRawCount,
			observedRawCount,
			nextAttemptAt: new Date(now.getTime() + OBSERVATION_CLAIM_LEASE_MS),
		},
	});
	return result.count === 1;
}

export async function completeObservationUnit(
	prisma: Db,
	input: { claim: ObservationUnitClaim; expectedRawCount: number; observedRawCount: number },
): Promise<boolean> {
	const expectedRawCount = observationCountSchema.parse(input.expectedRawCount);
	const observedRawCount = observationCountSchema.parse(input.observedRawCount);
	return await prisma.$transaction(async (tx) => {
		const result = await tx.providerObservationUnit.updateMany({
			where: {
				id: input.claim.unitId,
				runId: input.claim.runId,
				state: "running",
				claimToken: input.claim.claimToken,
			},
			data: {
				state: "complete",
				claimToken: null,
				expectedRawCount,
				observedRawCount,
				nextAttemptAt: null,
				completedAt: new Date(),
			},
		});
		if (result.count !== 1) return false;
		const completedUnit = await tx.providerObservationUnit.findUnique({
			where: { id: input.claim.unitId },
		});
		if (!completedUnit) return false;
		const updatedRun = await tx.providerObservationRun.update({
			where: { id: input.claim.runId },
			data: {
				completedUnits: { increment: 1 },
				completedWork: { increment: completedUnit.expectedTargets },
			},
		});
		if (updatedRun.completedUnits >= updatedRun.totalUnits) {
			await tx.providerObservationRun.updateMany({
				where: { id: input.claim.runId, state: { in: ["running", "failed"] } },
				data: {
					state: "complete",
					activeSlotKey: null,
					completedAt: new Date(),
					nextAttemptAt: null,
				},
			});
		}
		return true;
	});
}

export async function failObservationUnit(
	prisma: Db,
	input: {
		claim: ObservationUnitClaim;
		reasonCode: ProviderObservationReasonCode;
		now: Date;
		resetProgress?: boolean;
	},
): Promise<boolean> {
	const reason = decodeProviderObservationReasonCode(input.reasonCode);
	return await prisma.$transaction(async (tx) => {
		const current = await tx.providerObservationUnit.findFirst({
			where: {
				id: input.claim.unitId,
				runId: input.claim.runId,
				state: "running",
				claimToken: input.claim.claimToken,
			},
		});
		if (!current) return false;
		const nextAttemptCount = current.attemptCount + 1;
		const delay =
			nextAttemptCount <= AUTOMATIC_ATTEMPT_LIMIT ? BACKOFF_MS[nextAttemptCount - 1]! : null;
		const result = await tx.providerObservationUnit.updateMany({
			where: {
				id: input.claim.unitId,
				runId: input.claim.runId,
				state: "running",
				claimToken: input.claim.claimToken,
			},
			data: {
				state: "failed",
				claimToken: null,
				...(input.resetProgress
					? { cursor: 0, expectedRawCount: null, observedRawCount: 0, completedAt: null }
					: {}),
				attemptCount: nextAttemptCount,
				nextAttemptAt: delay === null ? null : new Date(input.now.getTime() + delay),
				lastReasonCode: reason,
			},
		});
		if (result.count !== 1) return false;
		if (input.resetProgress) {
			await tx.plexEpisodeObservationStage.deleteMany({
				where: { runId: input.claim.runId, unitId: input.claim.unitId },
			});
			await tx.jellyfinEpisodeObservationStage.deleteMany({
				where: { runId: input.claim.runId, unitId: input.claim.unitId },
			});
		}
		await tx.providerObservationRun.updateMany({
			where: { id: input.claim.runId, state: { in: ["running", "failed"] } },
			data: {
				state: "failed",
				nextAttemptAt: delay === null ? null : new Date(input.now.getTime() + delay),
				lastReasonCode: reason,
			},
		});
		return true;
	});
}

export async function invalidateObservationRuns(
	prisma: Db,
	input: {
		instanceId: string;
		cacheType?: "plex_episode" | "jellyfin_episode";
		exceptAuthorityKey?: string;
	},
): Promise<number> {
	return await prisma.$transaction(
		async (tx) => await invalidateObservationRunsInTransaction(tx, input),
	);
}

/** Revoke unpublished durable work inside an existing authority transaction. */
export async function invalidateObservationRunsInTransaction(
	tx: Prisma.TransactionClient,
	input: {
		instanceId: string;
		cacheType?: "plex_episode" | "jellyfin_episode";
		exceptAuthorityKey?: string;
	},
): Promise<number> {
	const runs = await tx.providerObservationRun.findMany({
		where: {
			instanceId: input.instanceId,
			...(input.cacheType ? { cacheType: input.cacheType } : {}),
			activeSlotKey: { not: null },
			...(input.exceptAuthorityKey ? { authorityKey: { not: input.exceptAuthorityKey } } : {}),
		},
		select: { id: true },
	});
	for (const run of runs) await invalidateRun(tx, run.id);
	return runs.length;
}

export async function recoverAbandonedObservationRuns(prisma: Db): Promise<number> {
	const runs = await prisma.providerObservationRun.findMany({
		where: { state: "running", activeSlotKey: { not: null } },
		select: { id: true },
	});
	let recovered = 0;
	for (const run of runs) {
		recovered += await prisma.$transaction(async (tx) => {
			const authorityRow = await tx.providerObservationRun.findUnique({
				where: { id: run.id },
				select: {
					id: true,
					instanceId: true,
					connectionGeneration: true,
					identityGeneration: true,
				},
			});
			if (!authorityRow) return 0;
			if (
				!(await lockObservationAuthority(
					tx,
					authorityRow.instanceId,
					authorityRow.connectionGeneration,
					authorityRow.identityGeneration,
				))
			) {
				await invalidateRun(tx, authorityRow.id);
				return 1;
			}
			const current = await tx.providerObservationRun.findUnique({
				where: { id: run.id },
				include: { instance: true },
			});
			if (current?.state !== "running" || current.activeSlotKey === null) return 0;
			if (
				current.connectionGeneration !== current.instance.connectionGeneration ||
				current.identityGeneration !== current.instance.identityGeneration
			) {
				await invalidateRun(tx, current.id);
				return 1;
			}
			const inheritedClaims = await tx.providerObservationUnit.count({
				where: { runId: current.id, state: "running" },
			});
			if (inheritedClaims > 0) {
				throw new Error("unmatched provider observation claim");
			}
			return 0;
		});
	}
	return recovered;
}

export const observationRunRetryDelaysMs = BACKOFF_MS;
export const maxObservationAutomaticAttempts = AUTOMATIC_ATTEMPT_LIMIT;
