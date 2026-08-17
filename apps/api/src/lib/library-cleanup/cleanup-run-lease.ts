import { randomUUID } from "node:crypto";
import {
	withCleanupOperationGuard,
	withExclusiveCleanupOperationGuard,
} from "./cleanup-maintenance-gate.js";
import type { CleanupExecutorDeps } from "./types.js";

export const CLEANUP_RUN_LEASE_MS = 2 * 60 * 60 * 1000;
const CLEANUP_RUN_HEARTBEAT_MS = 60 * 1000;

export class CleanupRunAlreadyInProgressError extends Error {
	constructor() {
		super("A cleanup operation is already in progress");
		this.name = "CleanupRunAlreadyInProgressError";
	}
}

export class CleanupRunLeaseLostError extends Error {
	constructor() {
		super("The cleanup run lost its database execution lease");
		this.name = "CleanupRunLeaseLostError";
	}
}

export class CleanupTopologyMutationConflictError extends Error {
	readonly statusCode = 409;

	constructor() {
		super("Service instances cannot be changed while a library cleanup operation is in progress");
		this.name = "CleanupTopologyMutationConflictError";
	}
}

export class CleanupPolicyMutationConflictError extends Error {
	readonly statusCode = 409;

	constructor() {
		super("Library cleanup settings cannot be changed while a cleanup operation is in progress");
		this.name = "CleanupPolicyMutationConflictError";
	}
}

export async function acquireCleanupRunLease(
	prisma: CleanupExecutorDeps["prisma"],
	userId: string,
	configId: string,
	now: Date = new Date(),
	runClaimToken: string = randomUUID(),
): Promise<string | null> {
	const claim = await prisma.libraryCleanupConfig.updateMany({
		where: {
			id: configId,
			userId,
			OR: [
				{ runClaimToken: null },
				{ runClaimedAt: null },
				{ runClaimedAt: { lt: new Date(now.getTime() - CLEANUP_RUN_LEASE_MS) } },
			],
		},
		data: { runClaimToken, runClaimedAt: now },
	});
	return claim.count === 1 ? runClaimToken : null;
}

export async function releaseCleanupRunLease(
	prisma: CleanupExecutorDeps["prisma"],
	userId: string,
	configId: string,
	runClaimToken: string,
): Promise<boolean> {
	const release = await prisma.libraryCleanupConfig.updateMany({
		where: { id: configId, userId, runClaimToken },
		data: { runClaimToken: null, runClaimedAt: null },
	});
	return release.count === 1;
}

export async function renewCleanupRunLease(
	prisma: CleanupExecutorDeps["prisma"],
	userId: string,
	configId: string,
	runClaimToken: string,
	now: Date = new Date(),
): Promise<boolean> {
	const renewal = await prisma.libraryCleanupConfig.updateMany({
		where: { id: configId, userId, runClaimToken },
		data: { runClaimedAt: now },
	});
	return renewal.count === 1;
}

export interface CleanupRunLease {
	/** Internal token used to coordinate provider publication with this exact run. */
	claimToken: string;
	assertOwnership: () => Promise<void>;
	release: () => Promise<void>;
}

export async function startCleanupRunLease(
	deps: Pick<CleanupExecutorDeps, "prisma" | "log">,
	userId: string,
	configId: string,
): Promise<CleanupRunLease> {
	const { prisma, log } = deps;
	const runClaimToken = await acquireCleanupRunLease(prisma, userId, configId);
	if (!runClaimToken) throw new CleanupRunAlreadyInProgressError();

	let runLeaseLost = false;
	const assertOwnership = async () => {
		if (runLeaseLost) throw new CleanupRunLeaseLostError();
		try {
			if (!(await renewCleanupRunLease(prisma, userId, configId, runClaimToken))) {
				runLeaseLost = true;
				throw new CleanupRunLeaseLostError();
			}
		} catch (error) {
			runLeaseLost = true;
			if (error instanceof CleanupRunLeaseLostError) throw error;
			log.error({ err: error, configId }, "Library cleanup could not renew its database run lease");
			throw new CleanupRunLeaseLostError();
		}
	};
	const heartbeat = setInterval(() => {
		assertOwnership().catch((error) => {
			log.error(
				{ err: error, configId },
				"Library cleanup database run lease heartbeat failed; mutations will stop",
			);
		});
	}, CLEANUP_RUN_HEARTBEAT_MS);
	heartbeat.unref();

	return {
		claimToken: runClaimToken,
		assertOwnership,
		release: async () => {
			clearInterval(heartbeat);
			await releaseCleanupRunLease(prisma, userId, configId, runClaimToken)
				.then((released) => {
					if (!released) {
						log.warn(
							{ configId },
							"Library cleanup finished after its database run lease ownership changed",
						);
					}
				})
				.catch((error) => {
					log.error(
						{ err: error, configId },
						"Library cleanup finished but its database run lease could not be released",
					);
				});
		},
	};
}

async function withCleanupMutationLease<T>(
	deps: Pick<CleanupExecutorDeps, "prisma" | "log">,
	userId: string,
	mutate: () => Promise<T>,
	conflictError: () => Error,
	options: {
		configId?: string;
		leaseRowMayBeDeleted?: boolean;
		exclusiveOperation?: boolean;
	} = {},
): Promise<T> {
	const runWithOperationGuard = options.exclusiveOperation
		? withExclusiveCleanupOperationGuard
		: withCleanupOperationGuard;
	return await runWithOperationGuard(async () => {
		const { prisma, log } = deps;
		// Ensure the per-user coordination row exists when the caller does not
		// already have its ID. This closes the initialization race between a
		// cleanup-sensitive write and the first cleanup run.
		const config = options.configId
			? { id: options.configId }
			: await prisma.libraryCleanupConfig.upsert({
					where: { userId },
					update: {},
					create: { userId },
					select: { id: true },
				});
		const runClaimToken = await acquireCleanupRunLease(prisma, userId, config.id);
		if (!runClaimToken) throw conflictError();

		try {
			return await mutate();
		} finally {
			await releaseCleanupRunLease(prisma, userId, config.id, runClaimToken)
				.then((released) => {
					if (!released && !options.leaseRowMayBeDeleted) {
						log.warn(
							{ configId: config.id },
							"Service topology mutation finished after its cleanup lease ownership changed",
						);
					}
				})
				.catch((error) => {
					log.error(
						{ err: error, configId: config.id },
						"Service topology mutation finished but its cleanup lease could not be released",
					);
				});
		}
	});
}

export async function withCleanupTopologyMutationLease<T>(
	deps: Pick<CleanupExecutorDeps, "prisma" | "log">,
	userId: string,
	mutate: () => Promise<T>,
	options: { leaseRowMayBeDeleted?: boolean } = {},
): Promise<T> {
	return await withCleanupMutationLease(
		deps,
		userId,
		mutate,
		() => new CleanupTopologyMutationConflictError(),
		options,
	);
}

/** Serialize destructive ARR service deletion against every cleanup/TRaSH mutation. */
export async function withExclusiveCleanupTopologyMutationLease<T>(
	deps: Pick<CleanupExecutorDeps, "prisma" | "log">,
	userId: string,
	mutate: () => Promise<T>,
	options: { leaseRowMayBeDeleted?: boolean } = {},
): Promise<T> {
	return await withCleanupMutationLease(
		deps,
		userId,
		mutate,
		() => new CleanupTopologyMutationConflictError(),
		{ ...options, exclusiveOperation: true },
	);
}

export async function withCleanupPolicyMutationLease<T>(
	deps: Pick<CleanupExecutorDeps, "prisma" | "log">,
	userId: string,
	mutate: () => Promise<T>,
	options: { configId?: string } = {},
): Promise<T> {
	return await withCleanupMutationLease(
		deps,
		userId,
		mutate,
		() => new CleanupPolicyMutationConflictError(),
		options,
	);
}
