import { parentPort, workerData } from "node:worker_threads";
import {
	acquireSqliteRestoreOperationLock,
	acquireSqliteRestoreRuntimeOwnership,
	type SqliteRestoreOperationLock,
	type SqliteRestoreRuntimeOwnership,
} from "../../restore-runtime-sqlite.js";

const databaseUrl: string = workerData?.databaseUrl ?? process.argv[2];
const mode: string = workerData?.mode ?? process.argv[3];
const emit = (message: { kind: string; value?: boolean }) => {
	if (parentPort) parentPort.postMessage(message);
	else process.send?.(message);
};
const finish = () => {
	if (parentPort) parentPort.close();
	else if (process.connected) process.disconnect?.();
};

async function main(): Promise<void> {
	let owner: SqliteRestoreRuntimeOwnership | undefined;
	let participant: SqliteRestoreOperationLock | undefined;
	try {
		if (mode === "owner") owner = await acquireSqliteRestoreRuntimeOwnership(databaseUrl);
		else if (mode === "participant")
			participant = await acquireSqliteRestoreOperationLock(databaseUrl);
		else throw new Error("Invalid synthetic actor mode");
		emit({ kind: "ready" });
	} catch {
		emit({ kind: "unavailable" });
		finish();
		return;
	}
	const command = async (message: unknown) => {
		try {
			if (message === "exclusive" && owner) {
				emit({ kind: "exclusive", value: await owner.tryAcquireExclusive() });
			} else if (message === "assert") {
				if (owner) await owner.assertOwned();
				else await participant!.assertHeld();
				emit({ kind: "assert", value: true });
			} else if (message === "release" && owner) {
				await owner.releaseExclusive();
				emit({ kind: "release" });
			} else if (message === "close") {
				await (owner ?? participant)!.close();
				emit({ kind: "closed" });
				finish();
			} else {
				emit({ kind: "invalid-command" });
			}
		} catch {
			emit({ kind: "unavailable" });
		}
	};
	if (parentPort) parentPort.on("message", command);
	else process.on("message", command);
}

void main().catch(() => {
	emit({ kind: "unavailable" });
	finish();
});
