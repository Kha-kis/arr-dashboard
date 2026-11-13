import type { Prisma } from "../prisma.js";
import {
	parseRestoreRuntimeRecord,
	prepareRestoreRuntimeCommitRecord,
	RestoreRuntimeStateError,
	type RestoreRuntimeCommitRequest,
	type RestoreRuntimeRecord,
} from "./restore-runtime-state.js";

type RuntimeClient = Pick<Prisma.TransactionClient, "restoreRuntimeControl">;

const SELECT = {
	id: true,
	protocolVersion: true,
	phase: true,
	runtimeEpoch: true,
	ownerBackendPid: true,
	activeRestoreId: true,
	lastCommittedRestoreId: true,
	lastCommittedAt: true,
	destinationInstallationId: true,
} as const satisfies Prisma.RestoreRuntimeControlSelect;

/** Installation-local evidence; missing or ambiguous state never initializes an owner. */
export async function readRestoreRuntimeControl(
	client: RuntimeClient,
): Promise<Readonly<RestoreRuntimeRecord>> {
	try {
		const rows = await client.restoreRuntimeControl.findMany({ select: SELECT, take: 2 });
		if (rows.length !== 1) throw new RestoreRuntimeStateError();
		return parseRestoreRuntimeRecord(rows[0]);
	} catch {
		throw new RestoreRuntimeStateError();
	}
}

/** Supply the replacement transaction; this helper grants no runtime ownership. */
export async function writeRestoreRuntimeCommit(
	client: RuntimeClient,
	request: RestoreRuntimeCommitRequest,
): Promise<void> {
	try {
		const current = await readRestoreRuntimeControl(client);
		const next = prepareRestoreRuntimeCommitRecord(current, request);
		if (next.lastCommittedRestoreId === null || next.lastCommittedAt === null) {
			throw new RestoreRuntimeStateError();
		}
		const result = await client.restoreRuntimeControl.updateMany({
			where: {
				...current,
				lastCommittedAt:
					current.lastCommittedAt === null ? null : new Date(current.lastCommittedAt),
			},
			data: {
				phase: next.phase,
				lastCommittedRestoreId: next.lastCommittedRestoreId,
				lastCommittedAt: new Date(next.lastCommittedAt),
			},
		});
		if (result.count !== 1) throw new RestoreRuntimeStateError();
	} catch {
		// No raw Prisma error, private identifier or prospective success escapes.
		throw new RestoreRuntimeStateError();
	}
}
