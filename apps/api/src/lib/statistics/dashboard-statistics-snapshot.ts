import { createHash } from "node:crypto";
import {
	ARR_SERVICES_UPPER,
	type DashboardStatisticsResponse,
	dashboardStatisticsResponseSchema,
} from "@arr/shared";
import type {
	DashboardStatisticsSnapshot,
	Prisma,
	PrismaClient,
	ServiceInstance,
} from "../../lib/prisma.js";
import { withIsolatedRuntimePrismaTransaction } from "../backup/restore-runtime-client.js";
import { withSqliteTransactionWriteIntent } from "../sqlite-transaction-intent.js";

type DashboardStatisticsSource = Pick<ServiceInstance, "id" | "service" | "enabled" | "updatedAt">;

export function fingerprintDashboardSources(
	instances: readonly DashboardStatisticsSource[],
): string {
	const sources = instances
		.filter(
			(instance) =>
				instance.enabled && (ARR_SERVICES_UPPER as readonly string[]).includes(instance.service),
		)
		.map((instance) => [instance.id, instance.service, instance.updatedAt.toISOString()])
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	return createHash("sha256").update(JSON.stringify(sources)).digest("hex");
}

export type DashboardSnapshotRead = {
	availability: "current" | "partial" | "last-known" | "collecting" | "unavailable";
	observedAt: Date | null;
	data: DashboardStatisticsResponse | null;
	refreshDue: boolean;
};

const CLAIM_LEASE_MS = 120_000;
const COMPLETE_FRESH_MS = 15 * 60_000;
const PARTIAL_RETRY_MS = 60_000;
const LAST_KNOWN_MAX_MS = 24 * 60 * 60_000;

/** Reserve a short known writer before guard reads pin a stale WAL snapshot. */
function withStatisticsWrite<T>(
	prisma: PrismaClient,
	operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
	return withSqliteTransactionWriteIntent(() =>
		withIsolatedRuntimePrismaTransaction(prisma, operation),
	);
}

function isClaimConflict(error: unknown, snapshotConflictIsRefusal = false): boolean {
	if (
		error instanceof Error &&
		error.name === "DriverAdapterError" &&
		error.message === "SocketTimeout"
	) {
		return true;
	}
	if (!error || typeof error !== "object" || !("code" in error)) return false;
	// A stale WAL transaction cannot retry its write. Refusing new admission
	// preserves cached reads; renewal must throw so its next heartbeat can retry.
	if (error.code === "SQLITE_BUSY_SNAPSHOT") return snapshotConflictIsRefusal;
	return ["P1008", "P2002", "P2028", "P2034", "SQLITE_BUSY", "SQLITE_LOCKED"].includes(
		String(error.code),
	);
}

export async function claimDashboardRefresh(
	prisma: PrismaClient,
	userId: string,
	fingerprint: string,
	token: string,
	now: Date,
): Promise<boolean> {
	if (!fingerprint || !token || !Number.isFinite(now.getTime())) return false;
	const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS);
	try {
		const existing = await prisma.dashboardStatisticsSnapshot.findUnique({ where: { userId } });
		if (!existing) {
			const sources = await prisma.serviceInstance.findMany({
				where: { userId, enabled: true },
				select: { id: true, service: true, enabled: true, updatedAt: true },
			});
			if (fingerprintDashboardSources(sources) !== fingerprint) return false;
			await prisma.dashboardStatisticsSnapshot.create({
				data: { userId, claimFingerprint: fingerprint, claimToken: token, leaseUntil },
			});
			return true;
		}
		return await withStatisticsWrite(prisma, async (tx) => {
			const sources = await tx.serviceInstance.findMany({
				where: { userId, enabled: true },
				select: { id: true, service: true, enabled: true, updatedAt: true },
			});
			if (fingerprintDashboardSources(sources) !== fingerprint) return false;
			const live = await tx.dashboardStatisticsSnapshot.findUnique({ where: { userId } });
			if (!live || !classifyDashboardSnapshotRow(live, fingerprint, now).refreshDue) return false;
			const claimed = await tx.dashboardStatisticsSnapshot.updateMany({
				where: {
					userId,
					sourceFingerprint: live.sourceFingerprint,
					observedAt: live.observedAt,
					claimToken: live.claimToken,
					leaseUntil: live.leaseUntil,
					claimFingerprint: live.claimFingerprint,
					retryAt: live.retryAt,
					retryFingerprint: live.retryFingerprint,
				},
				data: { claimFingerprint: fingerprint, claimToken: token, leaseUntil },
			});
			return claimed.count === 1;
		});
	} catch (error) {
		if (isClaimConflict(error, true)) return false;
		throw error;
	}
}

/** Extend only the still-live, exact fenced claim during a long provider read. */
export async function renewDashboardRefreshClaim(
	prisma: PrismaClient,
	userId: string,
	fingerprint: string,
	token: string,
	now: Date,
): Promise<boolean> {
	if (!fingerprint || !token || !Number.isFinite(now.getTime())) return false;
	// A storage refusal is not proof of a lost lease. The existing heartbeat
	// retries rejected renewals; only an actual failed source/token fence is false.
	return withStatisticsWrite(prisma, async (tx) => {
		const sources = await tx.serviceInstance.findMany({
			where: { userId, enabled: true },
			select: { id: true, service: true, enabled: true, updatedAt: true },
		});
		if (fingerprintDashboardSources(sources) !== fingerprint) return false;
		const renewed = await tx.dashboardStatisticsSnapshot.updateMany({
			where: {
				userId,
				claimFingerprint: fingerprint,
				claimToken: token,
				leaseUntil: { gt: now },
			},
			data: { leaseUntil: new Date(now.getTime() + CLAIM_LEASE_MS) },
		});
		return renewed.count === 1;
	});
}

export async function publishDashboardSnapshot(
	prisma: PrismaClient,
	userId: string,
	fingerprint: string,
	token: string,
	observedAt: Date,
	payload: DashboardStatisticsResponse,
	result: "complete" | "partial",
	now: Date,
): Promise<boolean> {
	if (
		!fingerprint ||
		!token ||
		!Number.isFinite(observedAt.getTime()) ||
		!Number.isFinite(now.getTime()) ||
		observedAt > now
	) {
		return false;
	}
	const parsed = dashboardStatisticsResponseSchema.safeParse(payload);
	if (!parsed.success) return false;
	try {
		return await withStatisticsWrite(prisma, async (tx) => {
			const row = await tx.dashboardStatisticsSnapshot.findUnique({ where: { userId } });
			if (
				!row ||
				row.claimFingerprint !== fingerprint ||
				row.claimToken !== token ||
				!row.leaseUntil ||
				row.leaseUntil <= now
			) {
				return false;
			}
			const sources = await tx.serviceInstance.findMany({
				where: { userId, enabled: true },
				select: { id: true, service: true, enabled: true, updatedAt: true },
			});
			if (fingerprintDashboardSources(sources) !== fingerprint) return false;
			const published = await tx.dashboardStatisticsSnapshot.updateMany({
				where: {
					userId,
					claimFingerprint: fingerprint,
					claimToken: token,
					leaseUntil: { gt: now },
				},
				data: {
					sourceFingerprint: fingerprint,
					payload: JSON.stringify(parsed.data),
					result,
					observedAt,
					claimFingerprint: null,
					claimToken: null,
					leaseUntil: null,
					retryAt: result === "partial" ? new Date(now.getTime() + PARTIAL_RETRY_MS) : null,
					retryFingerprint: result === "partial" ? fingerprint : null,
					lastFailureCategory: null,
				},
			});
			return published.count === 1;
		});
	} catch (error) {
		if (isClaimConflict(error)) return false;
		throw error;
	}
}

export type DashboardRefreshFailureCategory =
	| "provider-unavailable"
	| "timeout"
	| "source-changed"
	| "storage-error"
	| "unknown";

export async function failDashboardRefresh(
	prisma: PrismaClient,
	userId: string,
	fingerprint: string,
	token: string,
	now: Date,
	category: DashboardRefreshFailureCategory,
): Promise<boolean> {
	if (!fingerprint || !token || !Number.isFinite(now.getTime())) return false;
	const cleared = await prisma.dashboardStatisticsSnapshot.updateMany({
		where: { userId, claimFingerprint: fingerprint, claimToken: token },
		data: {
			claimFingerprint: null,
			claimToken: null,
			leaseUntil: null,
			retryAt: new Date(now.getTime() + PARTIAL_RETRY_MS),
			retryFingerprint: fingerprint,
			lastFailureCategory: category,
		},
	});
	return cleared.count === 1;
}

export async function readDashboardSnapshot(
	prisma: PrismaClient,
	userId: string,
	fingerprint: string,
	now: Date,
): Promise<DashboardSnapshotRead> {
	const row = await prisma.dashboardStatisticsSnapshot.findUnique({ where: { userId } });
	return classifyDashboardSnapshotRow(row, fingerprint, now);
}

function classifyDashboardSnapshotRow(
	row: DashboardStatisticsSnapshot | null,
	fingerprint: string,
	now: Date,
): DashboardSnapshotRead {
	if (!row) {
		return { availability: "unavailable", observedAt: null, data: null, refreshDue: true };
	}
	const claimActive =
		row.claimFingerprint === fingerprint &&
		row.claimToken !== null &&
		row.leaseUntil !== null &&
		row.leaseUntil > now;
	const sourceMatches = row.sourceFingerprint === fingerprint;
	const ageMs = row.observedAt
		? now.getTime() - row.observedAt.getTime()
		: Number.POSITIVE_INFINITY;
	let data: DashboardStatisticsResponse | null = null;
	if (
		sourceMatches &&
		ageMs >= 0 &&
		ageMs <= LAST_KNOWN_MAX_MS &&
		(row.result === "complete" || row.result === "partial") &&
		row.payload
	) {
		try {
			const parsed = dashboardStatisticsResponseSchema.safeParse(JSON.parse(row.payload));
			if (parsed.success) data = parsed.data;
		} catch {
			// A corrupt stored snapshot is unavailable, never a zero-valued success.
		}
	}
	const availability: DashboardSnapshotRead["availability"] = data
		? row.result === "partial"
			? "partial"
			: ageMs <= COMPLETE_FRESH_MS
				? "current"
				: "last-known"
		: claimActive
			? "collecting"
			: "unavailable";
	const matchingRetry = row.retryFingerprint === fingerprint ? row.retryAt?.getTime() : undefined;
	const dueAt =
		matchingRetry ??
		(sourceMatches && row.result === "partial"
			? (row.observedAt?.getTime() ?? 0) + PARTIAL_RETRY_MS
			: (row.observedAt?.getTime() ?? 0) + COMPLETE_FRESH_MS);
	const refreshDue =
		!claimActive &&
		(!data || availability !== "current") &&
		(matchingRetry !== undefined
			? matchingRetry <= now.getTime()
			: !sourceMatches || dueAt <= now.getTime());
	return { availability, observedAt: data ? row.observedAt : null, data, refreshDue };
}
