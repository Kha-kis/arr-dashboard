import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
	openRestoreRuntimeWorker,
	type RestoreRuntime,
} from "../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../backup/restore-runtime-client.js";
import {
	nativeInventoryRetentionDiagnosticsFrom,
	nativeInventoryRetentionFailureCode,
	type NativeInventoryRetentionFailureDiagnostics,
	type NativeInventoryRetentionFailurePhase,
	NativeInventoryRetentionWorkerError,
} from "./native-inventory-retention-diagnostics.js";
import { pruneNativeInventoryRetentionSlice } from "./native-inventory-retention.js";
import {
	parseNativeInventoryRetentionWorkerPayload,
	type NativeInventoryRetentionWorkerResult,
} from "./native-inventory-retention-worker-transport.js";

export async function executeNativeInventoryRetentionSlice(
	value: unknown,
	options: { signal?: AbortSignal } = {},
): Promise<NativeInventoryRetentionWorkerResult> {
	if (options.signal?.aborted) return { status: "cancelled" };
	const input = parseNativeInventoryRetentionWorkerPayload(value);
	if (!input) return { status: "failed" };
	let runtime: RestoreRuntime | undefined;
	let failurePhase: NativeInventoryRetentionFailurePhase = "runtime-open";
	let firstFailure: NativeInventoryRetentionFailureDiagnostics | undefined;
	try {
		runtime = await openRestoreRuntimeWorker(input.runtimeBinding, input.databaseUrl);
		if (options.signal?.aborted) return { status: "cancelled" };
		failurePhase = "client-create";
		const { prisma } = createRuntimePrismaClient(runtime, { sqliteTransactionIntent: "write" });
		failurePhase = "retention";
		const operation = async (): Promise<NativeInventoryRetentionWorkerResult> => ({
			status: "completed",
			...(await pruneNativeInventoryRetentionSlice(prisma, input.cutoff, {
				rowLimit: input.rowLimit,
				scanLimit: input.scanLimit,
				cursor: input.cursor,
				signal: options.signal,
			})),
		});
		return input.runtimeBinding!.record.phase === "starting"
			? await runtime.runStarting(operation)
			: await runtime.runOperation(operation);
	} catch (error) {
		firstFailure = { failurePhase, failureCode: nativeInventoryRetentionFailureCode(error) };
		return { status: "failed", ...firstFailure };
	} finally {
		// Outside the ordinary ticket: successful physical closure precedes any
		// posted result. Failure here cannot turn committed work into success.
		await runtime?.close().catch((error) => {
			throw new NativeInventoryRetentionWorkerError(
				firstFailure ?? {
					failurePhase: "runtime-close",
					failureCode: nativeInventoryRetentionFailureCode(error),
				},
			);
		});
	}
}

const port = parentPort;
if (!isMainThread && port) {
	const cancellation = new AbortController();
	const cancel = (message: unknown) => {
		if (
			typeof message === "object" &&
			message !== null &&
			"kind" in message &&
			message.kind === "cancel"
		)
			cancellation.abort();
	};
	port.on("message", cancel);
	const finish = (result: NativeInventoryRetentionWorkerResult) => {
		port.postMessage(result);
		port.off("message", cancel);
		port.close();
	};
	void executeNativeInventoryRetentionSlice(workerData, { signal: cancellation.signal }).then(
		finish,
		(error) => finish({ status: "failed", ...nativeInventoryRetentionDiagnosticsFrom(error) }),
	);
}
