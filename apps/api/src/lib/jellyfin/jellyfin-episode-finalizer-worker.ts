import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { FastifyBaseLogger } from "fastify";
import {
	openRestoreRuntimeWorker,
	type RestoreRuntime,
} from "../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../backup/restore-runtime-client.js";
import type { PrismaClientInstance } from "../prisma.js";
import {
	type OwnedProviderPublicationSnapshot,
	ProviderIdentityGuardError,
	withGuardedProviderPublication,
} from "../services/provider-identity-guard.js";
import { startFinalizerLoopObservation } from "./finalizer-loop-observation.js";
import { JELLYFIN_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS } from "./jellyfin-cache-refresher.js";
import type {
	JellyfinEpisodeFinalizationWorkerPayload,
	JellyfinEpisodeFinalizationWorkerResult,
	JellyfinEpisodeFinalizerFailureCode,
	JellyfinEpisodeFinalizerFailureStage,
	NativeWatchStageFailureDiagnostics,
} from "./jellyfin-episode-finalizer-worker-transport.js";
import {
	acquireJellyfinEpisodePreparation,
	cleanupObsoleteJellyfinEpisodeGenerations,
	cleanupUnpublishedJellyfinEpisodeGeneration,
	prepareJellyfinEpisodeGeneration,
	releaseJellyfinEpisodePreparation,
	renewJellyfinEpisodePreparation,
} from "./jellyfin-episode-generation-repository.js";
import {
	commitPreparedJellyfinEpisodeRun,
	type JellyfinEpisodeFinalizationTiming,
	prepareJellyfinEpisodeRun,
	readCompletedJellyfinEpisodePublication,
	settleInvalidJellyfinEpisodeRun,
} from "./jellyfin-episode-refresh-repository.js";
import {
	cleanupPublishedJellyfinEpisodeArtifacts,
	JellyfinNativeWatchLeaseLostError,
	type NativeWatchPreparationStage,
	type NativeWatchPreparationTransactionKind,
	prepareNativeWatchGeneration,
} from "./jellyfin-native-watch-repository.js";

const silentLog = {
	trace() {},
	debug() {},
	info() {},
	warn() {},
	error() {},
	fatal() {},
	child() {
		return this;
	},
} as unknown as FastifyBaseLogger;

export async function executeJellyfinEpisodeFinalization(
	payload: JellyfinEpisodeFinalizationWorkerPayload,
	options: { signal?: AbortSignal } = {},
): Promise<JellyfinEpisodeFinalizationWorkerResult> {
	if (options.signal?.aborted) return { status: "cancelled" };
	let runtime: RestoreRuntime | undefined;
	const stopLoopObservation = startFinalizerLoopObservation(payload.loopObservationBuffer);
	const startedAt = performance.now();
	try {
		if (/^postgres(ql)?:\/\//i.test(payload.databaseUrl)) return { status: "failed" };
		runtime = await openRestoreRuntimeWorker(payload.runtimeBinding, payload.databaseUrl);
		if (options.signal?.aborted) return { status: "cancelled" };
		const { prisma } = createRuntimePrismaClient(runtime, { sqliteTransactionIntent: "write" });
		const operation = () => finalizeAdmitted(payload, prisma, options.signal);
		return payload.runtimeBinding!.record.phase === "starting"
			? await runtime.runStarting(operation)
			: await runtime.runOperation(operation);
	} catch {
		return {
			status: "failed",
			failurePhase: "connection",
			failureStage: "connect",
			failureCategory: "unknown",
			failureElapsedMs: elapsed(startedAt),
		};
	} finally {
		// Closure is outside the ticket to avoid self-drain. A failed physical
		// close is not a result: parent recovery re-reads a committed marker.
		try {
			// Freeze execution gaps before runtime cleanup; cleanup delay is excluded.
			stopLoopObservation();
		} finally {
			await runtime?.close();
		}
	}
}

async function finalizeAdmitted(
	payload: JellyfinEpisodeFinalizationWorkerPayload,
	prisma: PrismaClientInstance,
	signal?: AbortSignal,
): Promise<JellyfinEpisodeFinalizationWorkerResult> {
	const checkCancellation = () => {
		if (signal?.aborted)
			throw new ProviderIdentityGuardError(
				"PUBLICATION_CANCELLED",
				"Episode publication cancelled.",
			);
	};
	let failurePhase: "connection" | "publication" = "connection";
	let failureStage: JellyfinEpisodeFinalizerFailureStage = "connect";
	let ownedPreparation: { generationId: string; token: string } | undefined;
	let nativeWatchStage:
		| { stage: NativeWatchPreparationStage; startedAt: number; count?: number }
		| undefined;
	let previousNativeWatchStage:
		| { stage: NativeWatchPreparationStage; elapsedMs: number; count?: number }
		| undefined;
	let nativeWatchTransaction:
		| {
				kind: NativeWatchPreparationTransactionKind;
				requestedAt: number;
				callbackEnteredAt?: number;
		  }
		| undefined;
	const workerStartedAt = performance.now();
	try {
		await prisma.$connect();
		failurePhase = "publication";
		failureStage = "read-completed";
		const completedCount = await readCompletedJellyfinEpisodePublication(prisma as never, {
			userId: payload.userId,
			instanceId: payload.instance.id,
			runId: payload.runId,
			attempt: payload.attempt,
		});
		if (completedCount !== null) {
			const cleanupStartedAt = performance.now();
			let cleanupFailed = false;
			try {
				await cleanupPublishedJellyfinEpisodeArtifacts(prisma, payload.instance.id, payload.runId);
				await cleanupObsoleteJellyfinEpisodeGenerations(prisma as never, {
					userId: payload.userId,
					instanceId: payload.instance.id,
				});
			} catch {
				cleanupFailed = true;
			}
			return {
				status: "published",
				itemCount: completedCount,
				finalizationCallMs: elapsed(workerStartedAt),
				outerOverheadMs: 0,
				cleanupMs: elapsed(cleanupStartedAt),
				cleanupFailed,
			};
		}
		checkCancellation();

		let timing: JellyfinEpisodeFinalizationTiming | undefined;
		let rawPrepareMs = 0;
		let nativeStagingMs = 0;
		let commitMs = 0;
		let nonPublicationReason: "run-not-ready" | "lease-busy" | "lease-lost" | "commit-rejected" =
			"commit-rejected";
		const finalizationStartedAt = performance.now();
		failureStage = "identity-before";
		const finalized = await withGuardedProviderPublication(
			prisma,
			payload.instance as OwnedProviderPublicationSnapshot,
			silentLog,
			async () => {
				failureStage = "prepare";
				const prepared = await prepareJellyfinEpisodeRun({
					prisma: prisma as never,
					userId: payload.userId,
					instance: payload.instance,
					runId: payload.runId,
					scopes: payload.scopes,
					attempt: payload.attempt,
					now: payload.now,
					recordTiming: (value, raw) => {
						timing = value;
						rawPrepareMs = raw;
					},
				});
				checkCancellation();
				if (prepared.kind !== "ready") {
					if (prepared.kind === "not-published") nonPublicationReason = "run-not-ready";
					return prepared;
				}
				failureStage = "acquire-lease";
				const lease = await acquireJellyfinEpisodePreparation(prisma as never, {
					userId: payload.userId,
					instanceId: payload.instance.id,
					runId: payload.runId,
					generationId: prepared.cacheGenerationId,
					now: new Date(),
				});
				if (!lease) {
					nonPublicationReason = "lease-busy";
					return { kind: "not-published" as const };
				}
				ownedPreparation = { generationId: prepared.cacheGenerationId, token: lease.token };
				checkCancellation();
				failureStage = "episode-stage";
				await prepareJellyfinEpisodeGeneration(prisma as never, {
					userId: payload.userId,
					instanceId: payload.instance.id,
					runId: payload.runId,
					generationId: prepared.cacheGenerationId,
					token: lease.token,
					rows: prepared.publishedRows,
					...(prepared.coveredShowTmdbIds
						? { coveredShowTmdbIds: prepared.coveredShowTmdbIds }
						: {}),
					expectedFingerprint: prepared.contentFingerprint,
					observedAt: prepared.observedAt,
					now: new Date(),
				});
				checkCancellation();
				if (prepared.nativePublication) {
					failureStage = "native-watch-stage";
					const stagingStartedAt = performance.now();
					await prepareNativeWatchGeneration(
						prisma as never,
						{
							...prepared.nativePublication,
							userId: payload.userId,
							preparationToken: lease.token,
						},
						(event) => {
							const now = performance.now();
							if (nativeWatchStage) {
								previousNativeWatchStage = {
									stage: nativeWatchStage.stage,
									elapsedMs: Math.max(0, Math.round(now - nativeWatchStage.startedAt)),
									...(nativeWatchStage.count === undefined
										? {}
										: { count: nativeWatchStage.count }),
								};
							}
							nativeWatchStage = {
								stage: event.stage,
								startedAt: now,
								...(event.count === undefined ? {} : { count: event.count }),
							};
						},
						(event) => {
							if (event.phase === "requested") {
								nativeWatchTransaction = { kind: event.kind, requestedAt: performance.now() };
							} else if (event.phase === "callback-entered" && nativeWatchTransaction) {
								nativeWatchTransaction.callbackEnteredAt = performance.now();
							} else if (event.phase === "succeeded") {
								nativeWatchTransaction = undefined;
							}
						},
						async () => {
							// Deliver parentPort cancellation between joined native batches.
							await new Promise<void>((resolve) => setImmediate(resolve));
							checkCancellation();
						},
					);
					nativeStagingMs = elapsed(stagingStartedAt);
				}
				checkCancellation();
				failureStage = "renew-lease";
				const live = await prisma!.$transaction((tx) =>
					renewJellyfinEpisodePreparation(tx, {
						userId: payload.userId,
						instanceId: payload.instance.id,
						runId: payload.runId,
						generationId: prepared.cacheGenerationId,
						token: lease.token,
						now: new Date(),
					}),
				);
				if (!live) {
					nonPublicationReason = "lease-lost";
					return { kind: "not-published" as const };
				}
				checkCancellation();
				failureStage = "identity-after";
				return { ...prepared, episodePreparationToken: lease.token };
			},
			async (transaction, prepared) => {
				failureStage = "commit";
				const input = {
					prisma: prisma as never,
					transaction,
					userId: payload.userId,
					instance: payload.instance,
					runId: payload.runId,
					scopes: payload.scopes,
					attempt: payload.attempt,
					now: payload.now,
				};
				if (prepared.kind === "not-published")
					return { published: false, itemCount: 0, invalidated: false };
				if (prepared.kind === "invalid")
					return {
						published: false,
						itemCount: 0,
						invalidated: await settleInvalidJellyfinEpisodeRun(transaction, input, prepared),
					};
				const commitStartedAt = performance.now();
				const committed = await commitPreparedJellyfinEpisodeRun(transaction, input, prepared);
				commitMs = elapsed(commitStartedAt);
				return {
					...committed,
					invalidated: false,
				};
			},
			{
				signal,
				cleanupRunClaimToken: payload.cleanupRunClaimToken,
				now: () => payload.now,
				timeout: JELLYFIN_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS,
			},
		);
		const finalizationCallMs = elapsed(finalizationStartedAt);
		if (!finalized.published) {
			if (finalized.invalidated) {
				try {
					await cleanupPublishedJellyfinEpisodeArtifacts(
						prisma,
						payload.instance.id,
						payload.runId,
					);
					await cleanupUnpublishedJellyfinEpisodeGeneration(prisma as never, {
						userId: payload.userId,
						instanceId: payload.instance.id,
						runId: payload.runId,
						generationId: payload.runId,
					});
				} catch {
					// Interrupted terminal-run cleanup is replayed by the scheduler.
				}
			}
			return {
				status: "not-published",
				reason: finalized.invalidated ? "invalidated" : nonPublicationReason,
			};
		}

		const cleanupStartedAt = performance.now();
		let cleanupFailed = false;
		try {
			await cleanupPublishedJellyfinEpisodeArtifacts(prisma, payload.instance.id, payload.runId);
			await cleanupObsoleteJellyfinEpisodeGenerations(prisma as never, {
				userId: payload.userId,
				instanceId: payload.instance.id,
			});
		} catch {
			cleanupFailed = true;
		}
		const cleanupMs = elapsed(cleanupStartedAt);
		if (timing)
			timing = {
				...timing,
				episodeWriteMs: commitMs,
				nativeWatchWriteMs: nativeStagingMs,
				totalMs: finalizationCallMs,
			};
		return {
			status: "published",
			itemCount: finalized.itemCount,
			...(timing ? { timing } : {}),
			finalizationCallMs,
			outerOverheadMs: Math.max(
				0,
				Math.round(finalizationCallMs - rawPrepareMs - nativeStagingMs - commitMs),
			),
			cleanupMs,
			cleanupFailed,
		};
	} catch (error) {
		// Freeze the failing operation's age before best-effort lease release.
		const failedAt = performance.now();
		const nativeWatchDiagnostics: NativeWatchStageFailureDiagnostics =
			isNativeWatchFailureStage(failureStage) && nativeWatchStage
				? {
						nativeWatchStage: nativeWatchStage.stage,
						nativeWatchStageElapsedMs: Math.max(
							0,
							Math.round(failedAt - nativeWatchStage.startedAt),
						),
						...(nativeWatchStage.count === undefined
							? {}
							: { nativeWatchStageCount: nativeWatchStage.count }),
						...(previousNativeWatchStage
							? {
									nativeWatchPreviousStage: previousNativeWatchStage.stage,
									nativeWatchPreviousStageElapsedMs: previousNativeWatchStage.elapsedMs,
									...(previousNativeWatchStage.count === undefined
										? {}
										: { nativeWatchPreviousStageCount: previousNativeWatchStage.count }),
								}
							: {}),
						...(nativeWatchTransaction
							? {
									nativeWatchTransactionKind: nativeWatchTransaction.kind,
									nativeWatchTransactionElapsedMs: Math.max(
										0,
										Math.round(failedAt - nativeWatchTransaction.requestedAt),
									),
									nativeWatchTransactionCallbackEntered:
										nativeWatchTransaction.callbackEnteredAt !== undefined,
									...(nativeWatchTransaction.callbackEnteredAt === undefined
										? {}
										: {
												nativeWatchTransactionWaitMs: Math.max(
													0,
													Math.round(
														nativeWatchTransaction.callbackEnteredAt -
															nativeWatchTransaction.requestedAt,
													),
												),
												nativeWatchTransactionCallbackElapsedMs: Math.max(
													0,
													Math.round(failedAt - nativeWatchTransaction.callbackEnteredAt),
												),
											}),
								}
							: {}),
					}
				: {};
		if (prisma && ownedPreparation) {
			try {
				await releaseJellyfinEpisodePreparation(prisma as never, {
					userId: payload.userId,
					instanceId: payload.instance.id,
					runId: payload.runId,
					generationId: ownedPreparation.generationId,
					token: ownedPreparation.token,
					now: new Date(),
				});
			} catch {
				// An unavailable release must not hide the original publication failure.
			}
		}
		if (error instanceof JellyfinNativeWatchLeaseLostError)
			return { status: "not-published", reason: "lease-lost" };
		if (error instanceof ProviderIdentityGuardError) {
			if (error.code === "PUBLICATION_CANCELLED") return { status: "cancelled" };
			if (error.code === "IDENTITY_UNAVAILABLE") return { status: "identity-unavailable" };
			if (error.code === "PUBLICATION_SUPERSEDED") return { status: "superseded" };
		}
		const failureCode = allowlistedFailureCode(error);
		return {
			status: "failed",
			failurePhase,
			failureStage,
			failureCategory: classifyWorkerFailure(error),
			...(failureCode ? { failureCode } : {}),
			failureElapsedMs: elapsed(workerStartedAt),
			...nativeWatchDiagnostics,
		};
	}
}

function isNativeWatchFailureStage(stage: JellyfinEpisodeFinalizerFailureStage): boolean {
	return stage === "native-watch-stage";
}

function allowlistedFailureCode(error: unknown): JellyfinEpisodeFinalizerFailureCode | undefined {
	const code =
		typeof error === "object" && error !== null && "code" in error
			? (error as { code: unknown }).code
			: undefined;
	if (
		code === "P1008" ||
		code === "P2024" ||
		code === "P2028" ||
		code === "P2034" ||
		code === "SQLITE_BUSY" ||
		code === "SQLITE_BUSY_SNAPSHOT" ||
		code === "SQLITE_LOCKED"
	)
		return code;
	return undefined;
}

function classifyWorkerFailure(
	error: unknown,
): "transaction-expired" | "database-contention" | "unknown" {
	const code =
		typeof error === "object" && error !== null && "code" in error
			? (error as { code: unknown }).code
			: undefined;
	if (code === "P2028") return "transaction-expired";
	if (
		code === "P1008" ||
		code === "P2024" ||
		code === "P2034" ||
		code === "SQLITE_BUSY" ||
		code === "SQLITE_BUSY_SNAPSHOT" ||
		code === "SQLITE_LOCKED"
	) {
		return "database-contention";
	}
	return "unknown";
}

function elapsed(startedAt: number): number {
	return Math.max(0, Math.round(performance.now() - startedAt));
}

const workerPort = parentPort;
if (!isMainThread && workerPort) {
	const cancellation = new AbortController();
	const cancelRead = (message: unknown) => {
		if (
			typeof message === "object" &&
			message !== null &&
			"kind" in message &&
			message.kind === "cancel"
		)
			cancellation.abort();
	};
	workerPort.on("message", cancelRead);
	void executeJellyfinEpisodeFinalization(workerData as JellyfinEpisodeFinalizationWorkerPayload, {
		signal: cancellation.signal,
	}).then(
		(result) => {
			workerPort.postMessage(result);
			workerPort.off("message", cancelRead);
			workerPort.close();
		},
		() => {
			workerPort.postMessage({ status: "failed" });
			workerPort.off("message", cancelRead);
			workerPort.close();
		},
	);
}
