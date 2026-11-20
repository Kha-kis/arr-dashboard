import { createHash, randomUUID } from "node:crypto";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { z } from "zod";
import { createArrServiceFingerprint } from "../arr/service-fingerprint.js";
import type { Encryptor } from "../auth/encryption.js";
import {
	assertRestoreRuntimeOperation,
	getRestoreRuntimeClientContext,
	type RestoreRuntime,
} from "../backup/restore-runtime-admission.js";
import { Prisma, type PrismaClientInstance, type SearchGrabAttempt } from "../prisma.js";
import { type SearchGrabTarget, searchGrabTargetSchema } from "./grab-selector.js";

export type SearchGrabOutcome = "acknowledged" | "rejected" | "uncertain";
export type SearchGrabOutcomeCategory =
	| "transport-unconfirmed"
	| "provider-rejected"
	| "interrupted-before-dispatch"
	| "interrupted-after-marker"
	| "predecessor-acknowledged";

export class SearchGrabRepositoryError extends Error {
	readonly statusCode = 409;
	constructor(
		readonly category:
			| "intent-conflict"
			| "target-held"
			| "retry-invalid"
			| "connection-unavailable"
			| "attempt-unavailable",
	) {
		super("Submission could not be admitted; inspect its recorded status before retrying.");
		this.name = "SearchGrabRepositoryError";
	}
}

type Admission = {
	intentId: string;
	target: SearchGrabTarget;
	retry?: { predecessorId: string; duplicateRiskConfirmed: boolean };
};
const uuid = z.string().uuid();
const rawSerializationRollback = z.object({
	cause: z.object({
		kind: z.literal("TransactionWriteConflict"),
		originalCode: z.literal("40001"),
	}),
});

/** Common owned row fence for admission, dispatch and connection mutation. */
export async function lockSearchGrabConnectionRow(
	tx: Prisma.TransactionClient,
	userId: string,
	instanceId: string,
) {
	const matched = await tx.$executeRaw(Prisma.sql`
		UPDATE "ServiceInstance" SET "id" = "id" WHERE "id" = ${instanceId} AND "userId" = ${userId}
	`);
	if (matched !== 1) throw new SearchGrabRepositoryError("connection-unavailable");
	const instance = await tx.serviceInstance.findFirst({
		where: { id: instanceId, userId },
	});
	if (!instance) throw new SearchGrabRepositoryError("connection-unavailable");
	return instance;
}

export async function lockSearchGrabConnection(
	tx: Prisma.TransactionClient,
	userId: string,
	instanceId: string,
) {
	const instance = await lockSearchGrabConnectionRow(tx, userId, instanceId);
	if (!instance.enabled || instance.service !== "PROWLARR")
		throw new SearchGrabRepositoryError("connection-unavailable");
	return instance;
}

/** Internal durable storage boundary. Provider I/O belongs in the submission service. */
export function createSearchGrabRepository(
	prisma: PrismaClientInstance,
	runtime: RestoreRuntime,
	encryptor: Encryptor,
	userId: string,
) {
	const context = getRestoreRuntimeClientContext(runtime);
	const epoch = context.runtimeEpoch;
	const attemptWhere = (id: string) => ({ id, userId });
	async function write<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
		await assertRestoreRuntimeOperation(runtime);
		const value = await prisma.$transaction(operation, { isolationLevel: "Serializable" });
		await assertRestoreRuntimeOperation(runtime);
		return value;
	}
	function targetHash(target: SearchGrabTarget): string {
		return createHash("sha256")
			.update(
				JSON.stringify([
					"arr-dashboard:search-grab-target",
					1,
					userId,
					target.serviceInstanceId,
					target.connectionFingerprint,
					target.guid,
					target.indexerId,
				]),
			)
			.digest("hex");
	}
	function claimWhere(attempt: SearchGrabAttempt) {
		return {
			userId,
			serviceInstanceId: attempt.serviceInstanceId,
			targetHash: attempt.targetHash,
			attemptId: attempt.id,
		};
	}
	async function ownAttempt(tx: Prisma.TransactionClient, id: string) {
		const attempt = await tx.searchGrabAttempt.findFirst({ where: attemptWhere(id) });
		if (!attempt) throw new SearchGrabRepositoryError("attempt-unavailable");
		return attempt;
	}
	async function releaseRejectedClaim(tx: Prisma.TransactionClient, attempt: SearchGrabAttempt) {
		// A late old result has no authority over a claim already transferred away.
		if (!(await tx.searchGrabClaim.findFirst({ where: claimWhere(attempt) }))) return;
		const visited = new Set([attempt.id]);
		let predecessorId = attempt.predecessorId;
		while (predecessorId) {
			if (visited.has(predecessorId)) throw new SearchGrabRepositoryError("retry-invalid");
			visited.add(predecessorId);
			const previous = await tx.searchGrabAttempt.findFirst({ where: attemptWhere(predecessorId) });
			if (
				!previous ||
				previous.serviceInstanceId !== attempt.serviceInstanceId ||
				previous.connectionFingerprint !== attempt.connectionFingerprint ||
				previous.targetHash !== attempt.targetHash ||
				!previous.dispatchedAt ||
				!["uncertain", "acknowledged", "rejected"].includes(previous.state)
			)
				throw new SearchGrabRepositoryError("retry-invalid");
			if (previous.state === "acknowledged") break;
			if (previous.state === "uncertain") {
				const returned = await tx.searchGrabClaim.updateMany({
					where: claimWhere(attempt),
					data: { attemptId: previous.id },
				});
				if (returned.count !== 1) throw new SearchGrabRepositoryError("target-held");
				return;
			}
			predecessorId = previous.predecessorId;
		}
		await tx.searchGrabClaim.deleteMany({ where: claimWhere(attempt) });
	}
	async function checkConnection(
		tx: Prisma.TransactionClient,
		instanceId: string,
		fingerprint: string,
	) {
		const instance = await lockSearchGrabConnection(tx, userId, instanceId);
		if (createArrServiceFingerprint(instance) !== fingerprint)
			throw new SearchGrabRepositoryError("connection-unavailable");
	}
	const findByIntent = (intentId: string) =>
		prisma.searchGrabAttempt.findFirst({ where: { userId, intentId } });
	/** Observation only: no connection lock, recovery, marker or attempt mutation. */
	async function findForTarget(value: SearchGrabTarget) {
		await assertRestoreRuntimeOperation(runtime);
		const parsed = searchGrabTargetSchema.safeParse(value);
		if (!parsed.success || parsed.data.userId !== userId)
			throw new SearchGrabRepositoryError("attempt-unavailable");
		const target = parsed.data,
			hash = targetHash(target);
		const attempt = await prisma.$transaction(
			async (tx) => {
				const instance = await tx.serviceInstance.findFirst({
					where: { userId, id: target.serviceInstanceId, service: "PROWLARR" },
				});
				if (!instance || createArrServiceFingerprint(instance) !== target.connectionFingerprint)
					throw new SearchGrabRepositoryError("connection-unavailable");
				const where = { userId, serviceInstanceId: target.serviceInstanceId, targetHash: hash };
				const held = await tx.searchGrabClaim.findFirst({ where });
				if (held) {
					const current = await tx.searchGrabAttempt.findFirst({
						where: { ...where, id: held.attemptId },
					});
					if (
						!current ||
						current.connectionFingerprint !== target.connectionFingerprint ||
						!["prepared", "submitting", "uncertain"].includes(current.state)
					)
						throw new SearchGrabRepositoryError("attempt-unavailable");
					return current;
				}
				return tx.searchGrabAttempt.findFirst({
					where: { ...where, connectionFingerprint: target.connectionFingerprint },
					orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
				});
			},
			{ isolationLevel: "Serializable" },
		);
		await assertRestoreRuntimeOperation(runtime);
		return attempt;
	}
	/** Compare a previously recorded contract without ever creating an attempt or marker. */
	async function observe(input: Admission) {
		await assertRestoreRuntimeOperation(runtime);
		const parsed = searchGrabTargetSchema.safeParse(input.target);
		const predecessorId = input.retry?.predecessorId ?? null;
		if (
			!parsed.success ||
			parsed.data.userId !== userId ||
			!uuid.safeParse(input.intentId).success ||
			(input.retry &&
				(!uuid.safeParse(predecessorId).success || input.retry.duplicateRiskConfirmed !== true))
		)
			throw new SearchGrabRepositoryError("intent-conflict");
		const attempt = await findByIntent(input.intentId);
		if (
			!attempt ||
			attempt.targetHash !== targetHash(parsed.data) ||
			attempt.predecessorId !== predecessorId
		)
			throw new SearchGrabRepositoryError("intent-conflict");
		await assertRestoreRuntimeOperation(runtime);
		return attempt;
	}
	async function admit(input: Admission) {
		const parsed = searchGrabTargetSchema.safeParse(input.target);
		if (!parsed.success || parsed.data.userId !== userId || !uuid.safeParse(input.intentId).success)
			throw new SearchGrabRepositoryError("intent-conflict");
		const target = parsed.data;
		const hash = targetHash(target);
		const predecessorId = input.retry?.predecessorId ?? null;
		if (
			input.retry &&
			(!uuid.safeParse(predecessorId).success || input.retry.duplicateRiskConfirmed !== true)
		)
			throw new SearchGrabRepositoryError("retry-invalid");
		for (let retry = 0; ; retry++) {
			try {
				return await write(async (tx) => {
					const existing = await tx.searchGrabAttempt.findFirst({
						where: { userId, intentId: input.intentId },
					});
					if (existing) {
						if (existing.targetHash !== hash || existing.predecessorId !== predecessorId)
							throw new SearchGrabRepositoryError("intent-conflict");
						return { attempt: existing, created: false };
					}
					await checkConnection(tx, target.serviceInstanceId, target.connectionFingerprint);
					const held = await tx.searchGrabClaim.findFirst({
						where: { userId, serviceInstanceId: target.serviceInstanceId, targetHash: hash },
					});
					if (predecessorId) {
						const previous = await ownAttempt(tx, predecessorId);
						if (
							previous.state !== "uncertain" ||
							previous.targetHash !== hash ||
							previous.serviceInstanceId !== target.serviceInstanceId ||
							previous.connectionFingerprint !== target.connectionFingerprint ||
							held?.attemptId !== previous.id
						)
							throw new SearchGrabRepositoryError("retry-invalid");
					} else if (held) throw new SearchGrabRepositoryError("target-held");
					const encrypted = encryptor.encrypt(
						JSON.stringify({
							purpose: "arr-dashboard:search-grab-target",
							version: 1,
							guid: target.guid,
							indexerId: target.indexerId,
						}),
					);
					const attempt = await tx.searchGrabAttempt.create({
						data: {
							id: randomUUID(),
							userId,
							intentId: input.intentId,
							serviceInstanceId: target.serviceInstanceId,
							connectionFingerprint: target.connectionFingerprint,
							targetHash: hash,
							encryptedTarget: encrypted.value,
							targetIv: encrypted.iv,
							workerEpoch: epoch,
							predecessorId,
						},
					});
					if (held) {
						const changed = await tx.searchGrabClaim.updateMany({
							where: {
								userId,
								serviceInstanceId: target.serviceInstanceId,
								targetHash: hash,
								attemptId: predecessorId!,
							},
							data: { attemptId: attempt.id },
						});
						if (changed.count !== 1) throw new SearchGrabRepositoryError("target-held");
					} else
						await tx.searchGrabClaim.create({
							data: {
								userId,
								serviceInstanceId: target.serviceInstanceId,
								targetHash: hash,
								attemptId: attempt.id,
							},
						});
					return { attempt, created: true };
				});
			} catch (error) {
				// These codes prove transaction rollback; retry only unsent admission, never a POST.
				if (
					retry < 2 &&
					error instanceof Prisma.PrismaClientKnownRequestError &&
					(["P2002", "P2034"].includes(error.code) ||
						(error.code === "P2010" &&
							rawSerializationRollback.safeParse(error.meta?.driverAdapterError).success))
				)
					continue;
				throw error;
			}
		}
	}
	async function claimDispatch(attemptId: string) {
		return write(async (tx) => {
			const attempt = await ownAttempt(tx, attemptId);
			if (
				attempt.state !== "prepared" ||
				attempt.workerEpoch !== epoch ||
				attempt.dispatchedAt !== null
			)
				return { attempt, admitted: false };
			await checkConnection(tx, attempt.serviceInstanceId, attempt.connectionFingerprint);
			if (!(await tx.searchGrabClaim.findFirst({ where: claimWhere(attempt) })))
				throw new SearchGrabRepositoryError("target-held");
			if (attempt.predecessorId) {
				const previous = await ownAttempt(tx, attempt.predecessorId);
				if (previous.state === "acknowledged") {
					const declined = await tx.searchGrabAttempt.updateMany({
						where: {
							...attemptWhere(attempt.id),
							state: "prepared",
							workerEpoch: epoch,
							dispatchedAt: null,
						},
						data: {
							state: "rejected",
							outcomeCategory: "predecessor-acknowledged",
							completedAt: new Date(),
						},
					});
					if (declined.count !== 1) throw new SearchGrabRepositoryError("attempt-unavailable");
					await tx.searchGrabClaim.deleteMany({ where: claimWhere(attempt) });
					return { attempt: await ownAttempt(tx, attempt.id), admitted: false };
				}
				if (previous.state !== "uncertain") throw new SearchGrabRepositoryError("retry-invalid");
			}
			const marker = await tx.searchGrabAttempt.updateMany({
				where: {
					...attemptWhere(attempt.id),
					state: "prepared",
					workerEpoch: epoch,
					dispatchedAt: null,
				},
				data: { state: "submitting", dispatchedAt: new Date() },
			});
			if (marker.count !== 1) throw new SearchGrabRepositoryError("attempt-unavailable");
			return { attempt: await ownAttempt(tx, attempt.id), admitted: true };
		});
	}
	/** Only the winning admission handler may settle its failed, provably unmarked work. */
	async function rejectUnsent(attemptId: string) {
		return write(async (tx) => {
			const attempt = await ownAttempt(tx, attemptId);
			if (attempt.workerEpoch !== epoch || attempt.dispatchedAt !== null)
				throw new SearchGrabRepositoryError("attempt-unavailable");
			if (attempt.state === "rejected" && attempt.outcomeCategory === "interrupted-before-dispatch")
				return attempt;
			if (attempt.state !== "prepared") throw new SearchGrabRepositoryError("attempt-unavailable");
			// A disabled connection is not dispatchable, but its exact unmarked claim can be settled.
			await lockSearchGrabConnectionRow(tx, userId, attempt.serviceInstanceId);
			if (!(await tx.searchGrabClaim.findFirst({ where: claimWhere(attempt) })))
				throw new SearchGrabRepositoryError("target-held");
			const changed = await tx.searchGrabAttempt.updateMany({
				where: {
					...attemptWhere(attempt.id),
					state: "prepared",
					workerEpoch: epoch,
					dispatchedAt: null,
				},
				data: {
					state: "rejected",
					outcomeCategory: "interrupted-before-dispatch",
					completedAt: new Date(),
				},
			});
			if (changed.count !== 1) throw new SearchGrabRepositoryError("attempt-unavailable");
			await releaseRejectedClaim(tx, attempt);
			return ownAttempt(tx, attempt.id);
		});
	}
	async function settle(
		attemptId: string,
		state: SearchGrabOutcome,
		category?: SearchGrabOutcomeCategory,
	) {
		return write(async (tx) => {
			const attempt = await ownAttempt(tx, attemptId);
			if (attempt.state === "acknowledged" || attempt.state === "rejected") return attempt;
			if (
				attempt.workerEpoch !== epoch ||
				!attempt.dispatchedAt ||
				!["submitting", "uncertain"].includes(attempt.state)
			)
				throw new SearchGrabRepositoryError("attempt-unavailable");
			const changed = await tx.searchGrabAttempt.updateMany({
				where: {
					...attemptWhere(attempt.id),
					workerEpoch: epoch,
					state: { in: ["submitting", "uncertain"] },
					dispatchedAt: { not: null },
				},
				data: { state, outcomeCategory: category ?? null, completedAt: new Date() },
			});
			if (changed.count !== 1) throw new SearchGrabRepositoryError("attempt-unavailable");
			if (state === "rejected") await releaseRejectedClaim(tx, attempt);
			else if (state === "acknowledged")
				await tx.searchGrabClaim.deleteMany({ where: claimWhere(attempt) });
			return ownAttempt(tx, attempt.id);
		});
	}
	async function recoverPreviousRuntime() {
		const totals = { unsentRejected: 0, uncertain: 0 };
		for (;;) {
			const batch = await write(async (tx) => {
				const prior = await tx.searchGrabAttempt.findMany({
					take: 100,
					where: {
						userId,
						state: { in: ["prepared", "submitting"] },
						OR: [{ workerEpoch: { not: epoch } }, { workerEpoch: null }],
					},
				});
				let unsentRejected = 0,
					uncertain = 0;
				for (const attempt of prior) {
					const unsent = attempt.state === "prepared" && attempt.dispatchedAt === null;
					const changed = await tx.searchGrabAttempt.updateMany({
						where: {
							...attemptWhere(attempt.id),
							state: attempt.state,
							workerEpoch: attempt.workerEpoch,
						},
						data: {
							state: unsent ? "rejected" : "uncertain",
							outcomeCategory: unsent ? "interrupted-before-dispatch" : "interrupted-after-marker",
							completedAt: new Date(),
						},
					});
					if (changed.count !== 1) throw new SearchGrabRepositoryError("attempt-unavailable");
					if (unsent) {
						await releaseRejectedClaim(tx, attempt);
						unsentRejected++;
					} else uncertain++;
				}
				return { unsentRejected, uncertain, processed: prior.length };
			});
			totals.unsentRejected += batch.unsentRejected;
			totals.uncertain += batch.uncertain;
			if (batch.processed < 100) return totals;
			await yieldEventLoop();
		}
	}
	return Object.freeze({
		admit,
		observe,
		claimDispatch,
		rejectUnsent,
		settle,
		findByIntent,
		findForTarget,
		recoverPreviousRuntime,
	});
}
