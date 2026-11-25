import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
	openRestoreRuntimeWorker,
	type RestoreRuntime,
} from "../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../backup/restore-runtime-client.js";
import { pruneNativeInventoryRetentionSlice } from "./native-inventory-retention.js";
import {
	type NativeInventoryRetentionFailureDiagnostics,
	type NativeInventoryRetentionFailurePhase,
	NativeInventoryRetentionWorkerError,
	nativeInventoryRetentionDiagnosticsFrom,
	nativeInventoryRetentionFailureCode,
} from "./native-inventory-retention-diagnostics.js";
import {
	type NativeInventoryRetentionWorkerResult,
	parseNativeInventoryRetentionWorkerPayload,
} from "./native-inventory-retention-worker-transport.js";

function diagnosticElapsedMs(startedAt: number): number {
	// Rounded and capped; this is timing evidence, never an admission input.
	return Math.min(60_000, Math.ceil(Math.max(0, performance.now() - startedAt) / 100) * 100);
}

export async function executeNativeInventoryRetentionSlice(
	value: unknown,
	options: { signal?: AbortSignal } = {},
): Promise<NativeInventoryRetentionWorkerResult> {
	if (options.signal?.aborted) return { status: "cancelled" };
	const input = parseNativeInventoryRetentionWorkerPayload(value);
	if (!input) return { status: "failed" };
	let runtime: RestoreRuntime | undefined;
	const startedAt = performance.now();
	let failurePhase: NativeInventoryRetentionFailurePhase = "runtime-open";
	let retentionCallbackEntered = false;
	let retentionCallbackCompleted = false;
	let firstFailure: NativeInventoryRetentionFailureDiagnostics | undefined;
	try {
		runtime = await openRestoreRuntimeWorker(input.runtimeBinding, input.databaseUrl);
		if (options.signal?.aborted) return { status: "cancelled" };
		failurePhase = "client-create";
		const { prisma } = createRuntimePrismaClient(runtime, { sqliteTransactionIntent: "write" });
		failurePhase = "runtime-admission";
		const operation = async (): Promise<NativeInventoryRetentionWorkerResult> => {
			retentionCallbackEntered = true;
			failurePhase = "retention";
			const result = await pruneNativeInventoryRetentionSlice(prisma, input.cutoff, {
				rowLimit: input.rowLimit,
				scanLimit: input.scanLimit,
				cursor: input.cursor,
				signal: options.signal,
			});
			retentionCallbackCompleted = true;
			return { status: "completed", ...result };
		};
		return input.runtimeBinding!.record.phase === "starting"
			? await runtime.runStarting(operation)
			: await runtime.runOperation(operation);
	} catch (error) {
		firstFailure = {
			...nativeInventoryRetentionDiagnosticsFrom(error),
			failurePhase: retentionCallbackCompleted
				? "runtime-release"
				: retentionCallbackEntered
					? "retention"
					: failurePhase,
			failureCode: nativeInventoryRetentionFailureCode(error),
		};
		return {
			status: "failed",
			...firstFailure,
			elapsedMs: diagnosticElapsedMs(startedAt),
			outcome: "failed",
		};
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
