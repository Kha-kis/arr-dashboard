import { randomUUID } from "node:crypto";
import type { QuiActionPayload, QuiDrawerAuditSummary, QuiLoggedOperation } from "@arr/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { assertQuiActionTargets } from "./action-target-authority.js";
import type { QuiClient } from "./client-factory.js";

export interface ExecuteQuiActionResult {
	logRowCount: number;
	status: "success" | "failed" | "uncertain" | "audit_unsettled";
	error: string | null;
	failureCategory?: "tracker_lookup" | "selection";
}

export interface ExecuteQuiFencedActionArgs {
	app: FastifyInstance;
	client: QuiClient;
	userId: string;
	serviceInstanceId: string;
	qbitInstanceId: number;
	hashes: string[];
	action: QuiLoggedOperation;
	auditPayload: QuiActionPayload | QuiDrawerAuditSummary | null;
	log?: FastifyBaseLogger;
	/** Server-owned preparation/read path; returns only a trusted dispatch closure. */
	prepareDispatch: () => Promise<() => Promise<void>>;
}

export class QuiPreflightError extends Error {
	constructor(
		readonly category: "tracker_lookup" | "selection",
		readonly publicMessage: string,
	) {
		super(publicMessage);
		this.name = "QuiPreflightError";
	}
}

const HELD_TARGET =
	"qUI action outcome is unresolved for a selected torrent; inspect My Actions before retrying";
const PRE_DISPATCH_TARGET = "qUI action target could not be verified; no command was dispatched";
const PRE_DISPATCH_AUDIT_UNSETTLED =
	"No qUI command was dispatched, but dashboard audit bookkeeping failed; inspect My Actions before retrying";

class LegacyActionHoldError extends Error {}
class QuiAttemptRevokedError extends Error {}
class QuiAttemptUnsettledError extends Error {}

function isUniqueClaimConflict(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

export async function executeQuiFencedAction(
	args: ExecuteQuiFencedActionArgs,
): Promise<ExecuteQuiActionResult> {
	const {
		app,
		client,
		userId,
		serviceInstanceId,
		qbitInstanceId,
		hashes,
		action,
		auditPayload,
		prepareDispatch,
		log = app.log,
	} = args;

	if (hashes.length === 0) return { logRowCount: 0, status: "success", error: null };

	try {
		await assertQuiActionTargets(client, qbitInstanceId, hashes);
	} catch {
		log.warn({ action, hashCount: hashes.length }, "qUI action target verification failed");
		return { logRowCount: 0, status: "failed", error: "qUI action target could not be verified" };
	}

	const payloadString =
		auditPayload && Object.keys(auditPayload).length > 0 ? JSON.stringify(auditPayload) : null;
	const requestedAt = new Date();
	const attemptId = randomUUID();
	const normalizedHashes = hashes.map((hash) => hash.toLowerCase());
	const targetHashes = new Set(normalizedHashes);
	try {
		await app.prisma.$transaction(async (tx) => {
			await tx.quiActionClaim.createMany({
				data: normalizedHashes.map((torrentHash) => ({
					userId,
					serviceInstanceId,
					qbitInstanceId,
					torrentHash,
					attemptId,
				})),
			});
			const unresolved = await tx.quiActionLog.findMany({
				where: { status: { in: ["pending", "uncertain"] } },
				select: { torrentHash: true },
			});
			if (unresolved.some((row) => targetHashes.has(row.torrentHash.toLowerCase()))) {
				throw new LegacyActionHoldError(HELD_TARGET);
			}
			await tx.quiActionLog.createMany({
				data: hashes.map((torrentHash) => ({
					userId,
					serviceInstanceId,
					qbitInstanceId,
					torrentHash,
					action,
					payload: payloadString,
					status: "pending",
					attemptId,
					requestedAt,
				})),
			});
		});
	} catch (error) {
		if (error instanceof LegacyActionHoldError || isUniqueClaimConflict(error)) {
			return { logRowCount: 0, status: "failed", error: HELD_TARGET };
		}
		throw error;
	}

	const abortBeforeDispatch = async (error: unknown): Promise<ExecuteQuiActionResult> => {
		const baseError =
			error instanceof QuiPreflightError ? error.publicMessage : PRE_DISPATCH_TARGET;
		const publicError = /no tracker mutation was dispatched|no command was dispatched/i.test(
			baseError,
		)
			? baseError
			: `${baseError}; no command was dispatched`;
		const failureCategory = error instanceof QuiPreflightError ? error.category : undefined;
		try {
			await app.prisma.$transaction(async (tx) => {
				const updated = await tx.quiActionLog.updateMany({
					where: {
						userId,
						serviceInstanceId,
						qbitInstanceId,
						attemptId,
						torrentHash: { in: hashes },
						status: "pending",
					},
					data: { status: "failed", error: publicError, completedAt: new Date() },
				});
				if (updated.count !== hashes.length)
					throw new Error("qUI pre-dispatch audit settlement count mismatch");
				const released = await tx.quiActionClaim.deleteMany({
					where: {
						userId,
						serviceInstanceId,
						qbitInstanceId,
						attemptId,
						torrentHash: { in: normalizedHashes },
					},
				});
				if (released.count !== hashes.length)
					throw new Error("qUI pre-dispatch claim release count mismatch");
			});
		} catch (auditError) {
			log.error(
				{ err: auditError, attemptId, hashCount: hashes.length },
				"qUI pre-dispatch audit settlement failed; claim retained",
			);
			return {
				logRowCount: hashes.length,
				status: "audit_unsettled",
				error: PRE_DISPATCH_AUDIT_UNSETTLED,
			};
		}
		return { logRowCount: hashes.length, status: "failed", error: publicError, failureCategory };
	};

	try {
		await assertQuiActionTargets(client, qbitInstanceId, hashes);
	} catch {
		log.warn(
			{ action, hashCount: hashes.length },
			"qUI action target verification failed under claim",
		);
		return await abortBeforeDispatch(new Error(PRE_DISPATCH_TARGET));
	}

	let dispatch: () => Promise<void>;
	try {
		dispatch = await prepareDispatch();
	} catch (error) {
		log.warn({ action, hashCount: hashes.length }, "qUI action preparation failed under claim");
		return await abortBeforeDispatch(error);
	}

	try {
		await app.prisma.$transaction(async (tx) => {
			// The no-op update takes SQLite's writer lock so reconciliation cannot
			// revoke this attempt between validation and the following reads.
			const locked = await tx.quiActionLog.updateMany({
				where: { userId, serviceInstanceId, qbitInstanceId, attemptId, status: "pending" },
				data: { status: "pending" },
			});
			const pendingRows = await tx.quiActionLog.findMany({
				where: { userId, serviceInstanceId, qbitInstanceId, attemptId },
				select: { torrentHash: true, status: true },
			});
			const claims = await tx.quiActionClaim.findMany({
				where: { userId, serviceInstanceId, qbitInstanceId, attemptId },
				select: { torrentHash: true },
			});
			const pendingHashes = pendingRows
				.filter((row) => row.status === "pending")
				.map((row) => row.torrentHash.toLowerCase())
				.sort();
			const claimedHashes = claims.map((claim) => claim.torrentHash.toLowerCase()).sort();
			const expectedHashes = [...normalizedHashes].sort();
			if (
				locked.count === hashes.length &&
				pendingHashes.length === hashes.length &&
				claimedHashes.length === hashes.length &&
				pendingHashes.every((hash, index) => hash === expectedHashes[index]) &&
				claimedHashes.every((hash, index) => hash === expectedHashes[index])
			)
				return;

			const revoked =
				pendingRows.length === hashes.length &&
				claims.length === 0 &&
				pendingRows.every((row) => row.status.startsWith("operator_verified_"));
			if (revoked) throw new QuiAttemptRevokedError();
			throw new QuiAttemptUnsettledError();
		});
	} catch (error) {
		if (error instanceof QuiAttemptRevokedError) {
			return {
				logRowCount: hashes.length,
				status: "failed",
				error: "The qUI action attempt was resolved before dispatch; no qUI command was dispatched",
			};
		}
		log.warn(
			{ action, hashCount: hashes.length },
			"qUI action attempt ownership could not be verified",
		);
		return {
			logRowCount: hashes.length,
			status: "audit_unsettled",
			error: PRE_DISPATCH_AUDIT_UNSETTLED,
		};
	}

	try {
		await dispatch();
	} catch {
		try {
			await app.prisma.quiActionLog.updateMany({
				where: { userId, serviceInstanceId, qbitInstanceId, attemptId, status: "pending" },
				data: { status: "uncertain" },
			});
		} catch (auditError) {
			log.error(
				{ err: auditError, attemptId },
				"qUI uncertain action audit update failed; claim retained",
			);
		}
		log.warn(
			{ action, hashCount: hashes.length },
			"qUI action outcome uncertain; target claims require reconciliation",
		);
		return { logRowCount: hashes.length, status: "uncertain", error: HELD_TARGET };
	}

	const completedAt = new Date();
	try {
		await app.prisma.$transaction(async (tx) => {
			const updated = await tx.quiActionLog.updateMany({
				where: { userId, serviceInstanceId, qbitInstanceId, attemptId, status: "pending" },
				data: { status: "success", completedAt },
			});
			if (updated.count !== hashes.length)
				throw new Error("qUI action audit finalization count mismatch");
			const released = await tx.quiActionClaim.deleteMany({
				where: { userId, serviceInstanceId, qbitInstanceId, attemptId },
			});
			if (released.count !== hashes.length)
				throw new Error("qUI action claim release count mismatch");
		});
	} catch (updateErr) {
		log.error(
			{ err: updateErr, attemptId, userId, serviceInstanceId, action, hashCount: hashes.length },
			"qUI action succeeded but audit finalization failed; claims retained for manual reconciliation",
		);
		return {
			logRowCount: hashes.length,
			status: "audit_unsettled",
			error:
				"qUI acknowledged the action, but the dashboard audit is unresolved; inspect My Actions before retrying",
		};
	}
	log.info(
		{ userId, serviceInstanceId, qbitInstanceId, action, hashCount: hashes.length },
		"qUI action succeeded",
	);
	return { logRowCount: hashes.length, status: "success", error: null };
}
