import { type MessagePort, Worker } from "node:worker_threads";
import {
	attachRestoreRuntimeWorker,
	type RestoreRuntimeWorkerBinding,
} from "../backup/restore-runtime-admission.js";
import {
	readRestoreRuntimeWorkerLoss,
	type RestoreRuntimeLossReason,
	sanitizeRestoreRuntimeLossReason,
} from "../backup/restore-runtime-loss.js";
import {
	createFinalizerLoopObservationBuffer,
	type FinalizerLoopDiagnostics,
	readFinalizerLoopDiagnostics,
	sanitizeFinalizerLoopDiagnostics,
	startFinalizerLoopObservation,
} from "./finalizer-loop-observation.js";
import type { JellyfinEpisodeFinalizationTiming } from "./jellyfin-episode-refresh-repository.js";
import type { NativeWatchProjectionDiagnostics } from "./jellyfin-native-watch-projection.js";
import type {
	NativeWatchPreparationStage,
	NativeWatchPreparationTransactionKind,
} from "./jellyfin-native-watch-repository.js";

export type { JellyfinEpisodeFinalizationTiming };

export type NativeWatchStageFailureDiagnostics = {
	nativeWatchStage?: NativeWatchPreparationStage;
	nativeWatchStageElapsedMs?: number;
	nativeWatchStageCount?: number;
	nativeWatchPreviousStage?: NativeWatchPreparationStage;
	nativeWatchPreviousStageElapsedMs?: number;
	nativeWatchPreviousStageCount?: number;
	nativeWatchTransactionKind?: NativeWatchPreparationTransactionKind;
	nativeWatchTransactionElapsedMs?: number;
	nativeWatchTransactionCallbackEntered?: boolean;
	nativeWatchTransactionWaitMs?: number;
	nativeWatchTransactionCallbackElapsedMs?: number;
};

export type JellyfinEpisodeFinalizerFailureStage =
	| "connect"
	| "read-completed"
	| "identity-before"
	| "prepare"
	| "acquire-lease"
	| "episode-stage"
	| "native-watch-stage"
	| "renew-lease"
	| "identity-after"
	| "commit";

export type JellyfinEpisodeFinalizerFailureCode =
	| "P1008"
	| "P2024"
	| "P2028"
	| "P2034"
	| "SQLITE_BUSY"
	| "SQLITE_BUSY_SNAPSHOT"
	| "SQLITE_LOCKED";

export type JellyfinEpisodeFinalizationWorkerResult =
	| {
			status: "published";
			itemCount: number;
			timing?: JellyfinEpisodeFinalizationTiming;
			finalizationCallMs: number;
			outerOverheadMs: number;
			cleanupMs: number;
			cleanupFailed: boolean;
	  }
	| { status: "identity-unavailable" | "superseded" | "cancelled" }
	| {
			status: "not-published";
			reason?: "run-not-ready" | "lease-busy" | "lease-lost" | "invalidated" | "commit-rejected";
	  }
	| ({
			status: "failed";
			failurePhase?: "connection" | "publication";
			failureCategory?: "transaction-expired" | "database-contention" | "unknown";
			failureStage?: JellyfinEpisodeFinalizerFailureStage;
			failureCode?: JellyfinEpisodeFinalizerFailureCode;
			failureElapsedMs?: number;
			loopObservation?: FinalizerLoopDiagnostics;
	  } & NativeWatchStageFailureDiagnostics);

export type JellyfinEpisodeFinalizationWorkerPayload = {
	databaseUrl: string;
	runtimeBinding?: RestoreRuntimeWorkerBinding;
	loopObservationBuffer?: SharedArrayBuffer;
	userId: string;
	instance: {
		id: string;
		userId: string;
		service: "JELLYFIN" | "EMBY";
		baseUrl: string;
		apiKey: string;
		httpAuthHeaders?: Record<string, string>;
		enabled: boolean;
		encryptedApiKey: string;
		encryptionIv: string;
		encryptedHttpAuthCredentials: string | null;
		httpAuthEncryptionIv: string | null;
		expectedIdentity: string | null;
		identityStatus: "UNVERIFIED" | "VERIFIED" | "MISMATCH";
		connectionGeneration: number;
		identityGeneration: number;
		label?: string | null;
	};
	runId: string;
	scopes: Array<{ userId: string; userName: string; libraryId: string }>;
	attempt: { attemptedAt: Date; resultMarker: string };
	now: Date;
	cleanupRunClaimToken?: string;
};

type WorkerLike = {
	postMessage?(message: { kind: "cancel" }): void;
	on(event: "message", listener: (message: unknown) => void): WorkerLike;
	on(event: "error", listener: (error: unknown) => void): WorkerLike;
	on(event: "exit", listener: (code: number) => void): WorkerLike;
	terminate(): Promise<number> | number;
};

type FinalizerTransportFailure =
	| "attach-failed"
	| "worker-construction-failed"
	| "worker-error"
	| "invalid-worker-result"
	| "worker-exited-without-result"
	| "runtime-bridge-unavailable"
	| "bridge-close-failed";

export type FinalizerTransportFailureDiagnostics = {
	transportFailure?: FinalizerTransportFailure;
	runtimeLossReason?: RestoreRuntimeLossReason;
};

/** Error carriers are untrusted: never invoke accessors or retain arbitrary fields. */
export function finalizerTransportDiagnosticsFrom(
	value: unknown,
): FinalizerTransportFailureDiagnostics {
	try {
		if (typeof value !== "object" || value === null) return {};
		const failure = Object.getOwnPropertyDescriptor(value, "transportFailure")?.value;
		switch (failure) {
			case "attach-failed":
			case "worker-construction-failed":
			case "worker-error":
			case "invalid-worker-result":
			case "worker-exited-without-result":
			case "runtime-bridge-unavailable":
			case "bridge-close-failed":
				break;
			default:
				return {};
		}
		const reason = Object.getOwnPropertyDescriptor(value, "runtimeLossReason")?.value;
		return {
			transportFailure: failure,
			...(failure === "runtime-bridge-unavailable" &&
			typeof reason === "string" &&
			reason === sanitizeRestoreRuntimeLossReason(reason)
				? { runtimeLossReason: reason as RestoreRuntimeLossReason }
				: {}),
		};
	} catch {
		return {};
	}
}

export class JellyfinEpisodeFinalizerWorkerError extends Error {
	readonly category = "worker-failed";
	readonly loopObservation: FinalizerLoopDiagnostics;
	declare readonly transportFailure?: FinalizerTransportFailure;
	declare readonly runtimeLossReason?: RestoreRuntimeLossReason;

	constructor(
		loopObservation?: FinalizerLoopDiagnostics,
		diagnostics?: FinalizerTransportFailureDiagnostics,
	) {
		super("Jellyfin episode finalization worker failed");
		this.name = "JellyfinEpisodeFinalizerWorkerError";
		this.loopObservation = sanitizeFinalizerLoopDiagnostics(loopObservation);
		Object.assign(this, finalizerTransportDiagnosticsFrom(diagnostics));
	}
}

export function jellyfinEpisodeFinalizerWorkerUrl(moduleUrl = import.meta.url): URL {
	if (moduleUrl.endsWith("/jellyfin-episode-finalizer-worker-transport.ts")) {
		return new URL("./jellyfin-episode-finalizer-worker.ts", moduleUrl);
	}
	return new URL("./lib/jellyfin/jellyfin-episode-finalizer-worker.js", moduleUrl);
}

export async function runJellyfinEpisodeFinalizerWorker(
	payload: JellyfinEpisodeFinalizationWorkerPayload,
	options: {
		signal?: AbortSignal;
		createWorker?: (
			url: URL,
			workerData: JellyfinEpisodeFinalizationWorkerPayload,
			transferList: MessagePort[],
		) => WorkerLike;
	} = {},
): Promise<JellyfinEpisodeFinalizationWorkerResult> {
	if (options.signal?.aborted) return { status: "cancelled" };
	let worker: WorkerLike;
	let bridge: Awaited<ReturnType<typeof attachRestoreRuntimeWorker>> | undefined;
	let parentBuffer: SharedArrayBuffer | undefined;
	let workerBuffer: SharedArrayBuffer | undefined;
	let stopParentObservation = () => {};
	let firstFailureObservation: FinalizerLoopDiagnostics | undefined;
	const captureFailureObservation = () =>
		(firstFailureObservation ??= readFinalizerLoopDiagnostics(parentBuffer, workerBuffer));
	let firstTransportFailure: FinalizerTransportFailureDiagnostics | undefined;
	const captureTransportFailure = (transportFailure: FinalizerTransportFailure) => {
		if (!firstTransportFailure) {
			firstTransportFailure = { transportFailure };
			if (transportFailure === "runtime-bridge-unavailable" && bridge) {
				const reason = readRestoreRuntimeWorkerLoss(new Int32Array(bridge.binding.fence));
				if (reason) firstTransportFailure.runtimeLossReason = reason;
			}
		}
		captureFailureObservation();
		return firstTransportFailure;
	};
	let setupFailure: FinalizerTransportFailure = "attach-failed";
	try {
		bridge = await attachRestoreRuntimeWorker(payload.databaseUrl);
		if (options.signal?.aborted) {
			setupFailure = "bridge-close-failed";
			await bridge.close();
			return { status: "cancelled" };
		}
		parentBuffer = createFinalizerLoopObservationBuffer();
		workerBuffer = createFinalizerLoopObservationBuffer();
		stopParentObservation = startFinalizerLoopObservation(parentBuffer);
		const workerPayload = {
			...payload,
			databaseUrl: bridge.binding.databaseUrl,
			runtimeBinding: bridge.binding,
			loopObservationBuffer: workerBuffer,
		};
		setupFailure = "worker-construction-failed";
		worker = (
			options.createWorker ??
			((url, workerData, transferList) => {
				if (url.pathname.endsWith(".ts")) {
					// Source-mode workers need their own tsx registration. The app's
					// loader does not apply .js-to-.ts resolution inside a new thread.
					const bootstrap = `const { parentPort } = require("node:worker_threads");
(async () => {
	const { register } = await import("tsx/esm/api");
	register();
	await import(${JSON.stringify(url.href)});
})().catch(() => parentPort.postMessage({ status: "failed" }));`;
					return new Worker(bootstrap, {
						eval: true,
						workerData,
						transferList,
					}) as unknown as WorkerLike;
				}
				return new Worker(url, { workerData, transferList }) as unknown as WorkerLike;
			})
		)(jellyfinEpisodeFinalizerWorkerUrl(), workerPayload, [bridge.binding.port]);
	} catch {
		const diagnostics = captureTransportFailure(setupFailure);
		try {
			await bridge?.close();
		} catch {
			// Cleanup failure cannot erase the first rejected admission/construction.
		} finally {
			stopParentObservation();
		}
		throw new JellyfinEpisodeFinalizerWorkerError(captureFailureObservation(), diagnostics);
	}

	let cancelRead: (() => void) | undefined;
	const closeBridge = async () => {
		try {
			await bridge!.close();
		} catch {
			const diagnostics = captureTransportFailure("bridge-close-failed");
			throw new JellyfinEpisodeFinalizerWorkerError(captureFailureObservation(), diagnostics);
		} finally {
			stopParentObservation();
		}
	};
	try {
		return await new Promise<JellyfinEpisodeFinalizationWorkerResult>((resolve, reject) => {
			let settled = false;
			let exited = false;
			let stopRequested = false;
			let received = false;
			let failed = false;
			let result: JellyfinEpisodeFinalizationWorkerResult | null = null;
			cancelRead = () => {
				if (exited || received) return;
				// A finalizer may already own an atomic publisher. Never terminate it
				// on read cancellation; its cooperative result and real exit own truth.
				try {
					worker.postMessage?.({ kind: "cancel" });
				} catch {}
			};
			options.signal?.addEventListener("abort", cancelRead, { once: true });
			const settleAfterExit = () => {
				if (settled || !exited) return;
				settled = true;
				if (result && !failed) resolve(result);
				else
					reject(
						new JellyfinEpisodeFinalizerWorkerError(
							captureFailureObservation(),
							captureTransportFailure("worker-exited-without-result"),
						),
					);
			};
			const requestStop = () => {
				if (stopRequested || exited) return;
				stopRequested = true;
				try {
					void Promise.resolve(worker.terminate()).catch(() => {
						// A rejected stop request proves nothing about a still-live thread.
						// Keep its caller's lifetime until the independent exit event arrives.
					});
				} catch {
					// Synchronous refusal likewise cannot release accepted parent work.
				}
			};

			worker.on("exit", () => {
				exited = true;
				settleAfterExit();
			});
			worker.on("error", () => {
				if (settled) return;
				captureTransportFailure("worker-error");
				failed = true;
				requestStop();
			});
			worker.on("message", (message) => {
				if (settled || received || failed) return;
				received = true;
				result = sanitizeWorkerResult(message);
				if (!result) {
					captureTransportFailure("invalid-worker-result");
					failed = true;
				} else if (result.status === "failed") {
					result = { ...result, loopObservation: captureFailureObservation() };
				}
				requestStop();
			});
			bridge!.onUnavailable(() => {
				if (settled) return;
				captureTransportFailure("runtime-bridge-unavailable");
				failed = true;
				requestStop();
			});
			if (options.signal?.aborted) cancelRead();
		});
	} finally {
		if (cancelRead) options.signal?.removeEventListener("abort", cancelRead);
		// Only the exit event reaches this point. Proof handlers also settle
		// before the caller's accepted parent operation can end.
		await closeBridge();
	}
}

function sanitizeWorkerResult(value: unknown): JellyfinEpisodeFinalizationWorkerResult | null {
	if (typeof value !== "object" || value === null) return null;
	const result = value as Record<string, unknown>;
	if (
		result.status === "identity-unavailable" ||
		result.status === "superseded" ||
		result.status === "cancelled"
	) {
		return { status: result.status };
	}
	if (result.status === "not-published") {
		switch (result.reason) {
			case "run-not-ready":
			case "lease-busy":
			case "lease-lost":
			case "invalidated":
			case "commit-rejected":
				return { status: "not-published", reason: result.reason };
			default:
				return { status: "not-published" };
		}
	}
	if (result.status === "failed") {
		const phase = result.failurePhase;
		const category = result.failureCategory;
		const stage = result.failureStage;
		const code = result.failureCode;
		const elapsedMs = result.failureElapsedMs;
		if (
			(phase === "connection" || phase === "publication") &&
			(category === "transaction-expired" ||
				category === "database-contention" ||
				category === "unknown") &&
			isNonNegativeSafeInteger(elapsedMs)
		) {
			return {
				status: "failed",
				failurePhase: phase,
				failureCategory: category,
				...(isFailureStage(stage) ? { failureStage: stage } : {}),
				...(isFailureCode(code) ? { failureCode: code } : {}),
				failureElapsedMs: elapsedMs,
				...sanitizeNativeWatchStageFailureDiagnostics(stage, result),
			};
		}
		return { status: "failed" };
	}
	if (
		result.status !== "published" ||
		!isNonNegativeSafeInteger(result.itemCount) ||
		!isNonNegativeSafeInteger(result.finalizationCallMs) ||
		!isNonNegativeSafeInteger(result.outerOverheadMs) ||
		!isNonNegativeSafeInteger(result.cleanupMs) ||
		typeof result.cleanupFailed !== "boolean" ||
		(result.timing !== undefined && (typeof result.timing !== "object" || result.timing === null))
	) {
		return null;
	}
	const timing =
		result.timing === undefined
			? undefined
			: sanitizeTiming(result.timing as Record<string, unknown>);
	if (result.timing !== undefined && !timing) return null;
	return {
		status: "published",
		itemCount: result.itemCount,
		...(timing ? { timing } : {}),
		finalizationCallMs: result.finalizationCallMs,
		outerOverheadMs: result.outerOverheadMs,
		cleanupMs: result.cleanupMs,
		cleanupFailed: result.cleanupFailed,
	};
}

function isFailureStage(value: unknown): value is JellyfinEpisodeFinalizerFailureStage {
	return (
		value === "connect" ||
		value === "read-completed" ||
		value === "identity-before" ||
		value === "prepare" ||
		value === "acquire-lease" ||
		value === "episode-stage" ||
		value === "native-watch-stage" ||
		value === "renew-lease" ||
		value === "identity-after" ||
		value === "commit"
	);
}

function isNativeWatchPreparationStage(value: unknown): value is NativeWatchPreparationStage {
	return (
		value === "lease-checkpoint" ||
		value === "authority-check" ||
		value === "own-row-reset" ||
		value === "own-receipt-reset" ||
		value === "row-chunk-write" ||
		value === "receipt-chunk-write" ||
		value === "row-verification" ||
		value === "receipt-verification"
	);
}

/** Only closed staging diagnostics may cross the worker and warning boundaries. */
export function sanitizeNativeWatchStageFailureDiagnostics(
	failureStage: unknown,
	value: unknown,
): NativeWatchStageFailureDiagnostics {
	if (failureStage !== "native-watch-stage" || typeof value !== "object" || value === null)
		return {};
	const fields = value as Record<string, unknown>;
	if (!isNativeWatchPreparationStage(fields.nativeWatchStage)) return {};
	const result: NativeWatchStageFailureDiagnostics = { nativeWatchStage: fields.nativeWatchStage };
	if (isNonNegativeSafeInteger(fields.nativeWatchStageElapsedMs))
		result.nativeWatchStageElapsedMs = fields.nativeWatchStageElapsedMs;
	if (isChunkCount(fields.nativeWatchStageCount))
		result.nativeWatchStageCount = fields.nativeWatchStageCount;
	if (isNativeWatchPreparationStage(fields.nativeWatchPreviousStage)) {
		result.nativeWatchPreviousStage = fields.nativeWatchPreviousStage;
		if (isNonNegativeSafeInteger(fields.nativeWatchPreviousStageElapsedMs))
			result.nativeWatchPreviousStageElapsedMs = fields.nativeWatchPreviousStageElapsedMs;
		if (isChunkCount(fields.nativeWatchPreviousStageCount))
			result.nativeWatchPreviousStageCount = fields.nativeWatchPreviousStageCount;
	}
	if (
		fields.nativeWatchTransactionKind === "lease-checkpoint" ||
		fields.nativeWatchTransactionKind === "row-chunk" ||
		fields.nativeWatchTransactionKind === "receipt-chunk"
	) {
		result.nativeWatchTransactionKind = fields.nativeWatchTransactionKind;
		if (isNonNegativeSafeInteger(fields.nativeWatchTransactionElapsedMs))
			result.nativeWatchTransactionElapsedMs = fields.nativeWatchTransactionElapsedMs;
		if (typeof fields.nativeWatchTransactionCallbackEntered === "boolean")
			result.nativeWatchTransactionCallbackEntered = fields.nativeWatchTransactionCallbackEntered;
		if (fields.nativeWatchTransactionCallbackEntered === true) {
			if (isNonNegativeSafeInteger(fields.nativeWatchTransactionWaitMs))
				result.nativeWatchTransactionWaitMs = fields.nativeWatchTransactionWaitMs;
			if (isNonNegativeSafeInteger(fields.nativeWatchTransactionCallbackElapsedMs))
				result.nativeWatchTransactionCallbackElapsedMs =
					fields.nativeWatchTransactionCallbackElapsedMs;
		}
	}
	return result;
}

function isChunkCount(value: unknown): value is number {
	return isNonNegativeSafeInteger(value) && value <= 500;
}

function isFailureCode(value: unknown): value is JellyfinEpisodeFinalizerFailureCode {
	return (
		value === "P1008" ||
		value === "P2024" ||
		value === "P2028" ||
		value === "P2034" ||
		value === "SQLITE_BUSY" ||
		value === "SQLITE_BUSY_SNAPSHOT" ||
		value === "SQLITE_LOCKED"
	);
}

function sanitizeTiming(value: Record<string, unknown>): JellyfinEpisodeFinalizationTiming | null {
	const keys = [
		"authorityMs",
		"stageLoadMs",
		"computeMs",
		"episodeWriteMs",
		"nativeProjectionMs",
		"nativeWatchWriteMs",
		"totalMs",
		"stageRows",
		"nativeCandidates",
	] as const;
	if (!keys.every((key) => isNonNegativeSafeInteger(value[key]))) return null;
	const diagnosticValue = value.nativeWatchDiagnostics;
	if (
		diagnosticValue !== undefined &&
		(typeof diagnosticValue !== "object" ||
			diagnosticValue === null ||
			Array.isArray(diagnosticValue))
	)
		return null;
	const nativeWatchDiagnostics =
		diagnosticValue === undefined
			? undefined
			: sanitizeNativeWatchDiagnostics(diagnosticValue as Record<string, unknown>);
	if (diagnosticValue !== undefined && !nativeWatchDiagnostics) return null;
	return {
		authorityMs: value.authorityMs as number,
		stageLoadMs: value.stageLoadMs as number,
		computeMs: value.computeMs as number,
		episodeWriteMs: value.episodeWriteMs as number,
		nativeProjectionMs: value.nativeProjectionMs as number,
		nativeWatchWriteMs: value.nativeWatchWriteMs as number,
		totalMs: value.totalMs as number,
		stageRows: value.stageRows as number,
		nativeCandidates: value.nativeCandidates as number,
		...(nativeWatchDiagnostics ? { nativeWatchDiagnostics } : {}),
	};
}

function sanitizeNativeWatchDiagnostics(
	value: Record<string, unknown>,
): NativeWatchProjectionDiagnostics | null {
	const keys = [
		"invalidCollectRows",
		"invalidVerifyRows",
		"conflictedCoordinates",
		"duplicateCollectCoordinates",
		"missingVerifyCoordinates",
		"duplicateVerifyCoordinates",
		"changedObservationCoordinates",
		"verifyOnlyCoordinates",
	] as const;
	if (!keys.every((key) => isNonNegativeSafeInteger(value[key]))) return null;
	return {
		invalidCollectRows: value.invalidCollectRows as number,
		invalidVerifyRows: value.invalidVerifyRows as number,
		conflictedCoordinates: value.conflictedCoordinates as number,
		duplicateCollectCoordinates: value.duplicateCollectCoordinates as number,
		missingVerifyCoordinates: value.missingVerifyCoordinates as number,
		duplicateVerifyCoordinates: value.duplicateVerifyCoordinates as number,
		changedObservationCoordinates: value.changedObservationCoordinates as number,
		verifyOnlyCoordinates: value.verifyOnlyCoordinates as number,
	};
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}
