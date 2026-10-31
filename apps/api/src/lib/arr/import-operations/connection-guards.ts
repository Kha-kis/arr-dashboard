import type { PrismaClient } from "../../prisma.js";

type ConnectionGuard = { readers: number; writer: boolean };
const connections = new Map<string, ConnectionGuard>();

export class ImportConnectionConflictError extends Error {
	readonly statusCode = 409;
	constructor() {
		super(
			"This connection has an active or unresolved import. Observe and reconcile the import before changing its connection; no import was cancelled.",
		);
		this.name = "ImportConnectionConflictError";
	}
}

async function withConnectionGuard<T>(
	userId: string,
	instanceId: string,
	write: boolean,
	operation: () => Promise<T>,
): Promise<T> {
	if (!userId || !instanceId) throw new ImportConnectionConflictError();
	const key = JSON.stringify([userId, instanceId]);
	const state = connections.get(key) ?? { readers: 0, writer: false };
	if (state.writer || (write && state.readers > 0)) throw new ImportConnectionConflictError();
	if (write) state.writer = true;
	else state.readers += 1;
	connections.set(key, state);
	try {
		return await operation();
	} finally {
		if (write) state.writer = false;
		else state.readers -= 1;
		if (!state.writer && state.readers === 0) connections.delete(key);
	}
}

/** One-API actual-settlement guard, independent of a caller's timeout or async context. */
export function withImportConnectionReadGuard<T>(
	userId: string,
	instanceId: string,
	operation: () => Promise<T>,
): Promise<T> {
	return withConnectionGuard(userId, instanceId, false, operation);
}

export function withImportConnectionWriteGuard<T>(
	userId: string,
	instanceId: string,
	operation: () => Promise<T>,
): Promise<T> {
	return withConnectionGuard(userId, instanceId, true, operation);
}

/**
 * Recheck in the connection-write transaction. True command terminality permits
 * a connection edit, not cleanup: retained file evidence/source protection is
 * independent. A legacy failed state alone does not prove command settlement.
 */
export async function assertNoUnsettledImportConnection(
	prisma: Pick<PrismaClient, "arrImportOperation" | "queueCleanerImportReceipt">,
	userId: string,
	instanceId: string,
): Promise<void> {
	if (!userId || !instanceId) throw new ImportConnectionConflictError();
	const legacy = await prisma.queueCleanerImportReceipt.findFirst({
		where: {
			instanceId,
			instance: { userId },
			OR: [{ state: { not: "completed" } }, { commandId: null }, { commandId: { lte: 0 } }],
		},
		select: { id: true },
	});
	if (legacy) throw new ImportConnectionConflictError();
	const unresolved = await prisma.arrImportOperation.findFirst({
		where: {
			userId,
			originalInstanceId: instanceId,
			// Explicit null branches matter: SQL NOT(positive predicate) does not
			// select UNKNOWN/null. Missing command evidence must remain a blocker.
			OR: [
				{ state: { notIn: ["not-submitted", "unknown", "partial", "failed", "completed"] } },
				{ state: "not-submitted", submissionStartedAt: { not: null } },
				{
					state: { not: "not-submitted" },
					OR: [
						{ submissionStartedAt: null },
						{ commandId: null },
						{ commandId: { lte: 0 } },
						{ commandTerminal: false },
						{ commandState: null },
						{ commandState: { notIn: ["completed", "failed"] } },
					],
				},
			],
		},
		select: { id: true },
	});
	if (unresolved) throw new ImportConnectionConflictError();
}
