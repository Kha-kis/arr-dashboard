import { z } from "zod";
import { createArrServiceFingerprint } from "../arr/service-fingerprint.js";
import { ConflictError } from "../errors.js";
import type { Prisma, PrismaClientInstance, ServiceInstance } from "../prisma.js";
import { lockSearchGrabConnectionRow } from "./grab-repository.js";

type ConnectionSnapshot = Pick<
	ServiceInstance,
	| "id"
	| "service"
	| "enabled"
	| "baseUrl"
	| "encryptedApiKey"
	| "encryptionIv"
	| "encryptedHttpAuthCredentials"
	| "httpAuthEncryptionIv"
>;
type ConnectionChanges = Partial<Omit<ConnectionSnapshot, "id">>;
const serializationRollback = z.object({
	code: z.literal("P2010"),
	meta: z.object({
		driverAdapterError: z.object({
			cause: z.object({
				kind: z.literal("TransactionWriteConflict"),
				originalCode: z.literal("40001"),
			}),
		}),
	}),
});

function connectionConflict(kind: "held" | "changed" | "unavailable") {
	return new ConflictError(
		kind === "held"
			? "This connection has an active or uncertain submission. Inspect its recorded status before changing its identity or deleting it; no submission was cancelled."
			: kind === "changed"
				? "The connection changed while this operation was starting. Review it before trying again."
				: "The connection write could not be safely established. Review its current state before trying again.",
		{ code: `SEARCH_GRAB_CONNECTION_${kind.toUpperCase()}` },
	);
}

/** No network await or automatic replay belongs in this short local transaction. */
export async function withSearchGrabConnectionTransaction<T>(
	prisma: PrismaClientInstance,
	operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
	try {
		return await prisma.$transaction(operation, { isolationLevel: "Serializable" });
	} catch (error) {
		if (
			z.object({ code: z.literal("P2034") }).safeParse(error).success ||
			serializationRollback.safeParse(error).success
		)
			throw connectionConflict("changed");
		throw error;
	}
}

/** Recheck owner/binding and held state under the same row lock as new admission. */
export async function assertSearchGrabConnectionMutation(
	tx: Prisma.TransactionClient,
	options: {
		userId: string;
		expected: ConnectionSnapshot;
		changes?: ConnectionChanges;
		deleting?: boolean;
	},
): Promise<void> {
	const current = await lockSearchGrabConnectionRow(tx, options.userId, options.expected.id);
	const held = await tx.searchGrabClaim.findFirst({
		where: { userId: options.userId, serviceInstanceId: current.id },
		select: { attemptId: true },
	});
	const replacement = { ...current, ...options.changes };
	if (
		!held &&
		current.service !== "PROWLARR" &&
		options.expected.service !== "PROWLARR" &&
		replacement.service !== "PROWLARR"
	)
		return;
	let currentFingerprint: string, expectedFingerprint: string, replacementFingerprint: string;
	try {
		currentFingerprint = createArrServiceFingerprint(current);
		expectedFingerprint = createArrServiceFingerprint(options.expected);
		replacementFingerprint = createArrServiceFingerprint(replacement);
	} catch {
		throw connectionConflict("unavailable");
	}
	if (currentFingerprint !== expectedFingerprint || current.enabled !== options.expected.enabled)
		throw connectionConflict("changed");
	if (held && (options.deleting || replacementFingerprint !== currentFingerprint))
		throw connectionConflict("held");
}
