import { randomUUID } from "node:crypto";
import { Prisma } from "../prisma.js";
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

async function updateCleanupRunClaim(
	prisma: CleanupExecutorDeps["prisma"],
	where: Prisma.LibraryCleanupConfigWhereUniqueInput,
	data: Prisma.LibraryCleanupConfigUpdateInput,
): Promise<boolean> {
	try {
		// Keep the full guard on a scalar update so SQLite needs no deferred
		// transaction with an earlier read snapshot.
		await prisma.libraryCleanupConfig.update({ where, data, select: { id: true } });
		return true;
	} catch (error) {
		if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025")
			return false;
		throw error;
	}
}

export async function acquireCleanupRunLease(
	prisma: CleanupExecutorDeps["prisma"],
	userId: string,
	configId: string,
	now: Date = new Date(),
	runClaimToken: string = randomUUID(),
): Promise<string | null> {
	const claimed = await updateCleanupRunClaim(
		prisma,
		{
			id: configId,
			userId,
			OR: [
				{ runClaimToken: null },
				{ runClaimedAt: null },
				{ runClaimedAt: { lt: new Date(now.getTime() - CLEANUP_RUN_LEASE_MS) } },
			],
		},
		{ runClaimToken, runClaimedAt: now },
	);
	return claimed ? runClaimToken : null;
}

export async function releaseCleanupRunLease(
	prisma: CleanupExecutorDeps["prisma"],
	userId: string,
	configId: string,
	runClaimToken: string,
): Promise<boolean> {
	return updateCleanupRunClaim(
		prisma,
		{ id: configId, userId, runClaimToken },
		{ runClaimToken: null, runClaimedAt: null },
	);
}

export async function renewCleanupRunLease(
	prisma: CleanupExecutorDeps["prisma"],
	userId: string,
	configId: string,
	runClaimToken: string,
	now: Date = new Date(),
): Promise<boolean> {
	return updateCleanupRunClaim(
		prisma,
		{ id: configId, userId, runClaimToken },
		{ runClaimedAt: now },
	);
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
