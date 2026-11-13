import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	connect: vi.fn(),
	disconnect: vi.fn(),
	guard: vi.fn(),
	finalize: vi.fn(),
	prepare: vi.fn(),
	readCompleted: vi.fn(),
	prepareNative: vi.fn(),
	acquireEpisode: vi.fn(),
	stageEpisode: vi.fn(),
	renewEpisode: vi.fn(),
	releaseEpisode: vi.fn(),
	cleanupEpisode: vi.fn(),
	cleanupObsolete: vi.fn(),
	commit: vi.fn(),
	settleInvalid: vi.fn(),
	cleanup: vi.fn(),
	transactionOptions: undefined as unknown,
	requireWriteIntent: false,
}));

vi.mock("../backup/restore-runtime-client.js", () => ({
	createRuntimePrismaClient: (
		_runtime: unknown,
		options?: { sqliteTransactionIntent?: string },
	) => {
		if (mocks.requireWriteIntent && options?.sqliteTransactionIntent !== "write")
			throw new Error("Finalizer must reserve the SQLite writer before guard reads");
		return {
			prisma: {
				$connect: mocks.connect,
				$disconnect: mocks.disconnect,
				$transaction: async (callback: (tx: object) => Promise<unknown>) => callback({}),
			},
		};
	},
}));
vi.mock("../backup/restore-runtime-admission.js", () => ({
	openRestoreRuntimeWorker: async () => ({
		runStarting: async (operation: () => Promise<unknown>) => operation(),
		runOperation: async (operation: () => Promise<unknown>) => operation(),
		close: mocks.disconnect,
	}),
}));
vi.mock("../services/provider-identity-guard.js", () => ({
	ProviderIdentityGuardError: class ProviderIdentityGuardError extends Error {
		code: string;
		constructor(code: string) {
			super(code);
			this.code = code;
		}
	},
	withGuardedProviderPublication: mocks.guard,
}));
vi.mock("./jellyfin-episode-refresh-repository.js", () => ({
	finalizeJellyfinEpisodeRun: mocks.finalize,
	prepareJellyfinEpisodeRun: mocks.prepare,
	readCompletedJellyfinEpisodePublication: mocks.readCompleted,
	commitPreparedJellyfinEpisodeRun: mocks.commit,
	settleInvalidJellyfinEpisodeRun: mocks.settleInvalid,
}));
vi.mock("./jellyfin-native-watch-repository.js", () => ({
	JellyfinNativeWatchLeaseLostError: class JellyfinNativeWatchLeaseLostError extends Error {},
	cleanupPublishedJellyfinEpisodeArtifacts: mocks.cleanup,
	prepareNativeWatchGeneration: mocks.prepareNative,
}));
vi.mock("./jellyfin-episode-generation-repository.js", () => ({
	acquireJellyfinEpisodePreparation: mocks.acquireEpisode,
	prepareJellyfinEpisodeGeneration: mocks.stageEpisode,
	renewJellyfinEpisodePreparation: mocks.renewEpisode,
	releaseJellyfinEpisodePreparation: mocks.releaseEpisode,
	cleanupUnpublishedJellyfinEpisodeGeneration: mocks.cleanupEpisode,
	cleanupObsoleteJellyfinEpisodeGenerations: mocks.cleanupObsolete,
}));
vi.mock("./jellyfin-cache-refresher.js", () => ({
	JELLYFIN_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS: 60_000,
}));

import { ProviderIdentityGuardError } from "../services/provider-identity-guard.js";
import {
	createFinalizerLoopObservationBuffer,
	readFinalizerLoopObservation,
} from "./finalizer-loop-observation.js";
import { executeJellyfinEpisodeFinalization } from "./jellyfin-episode-finalizer-worker.js";
import { JellyfinNativeWatchLeaseLostError } from "./jellyfin-native-watch-repository.js";

const payload = {
	databaseUrl: "file:/private/config/prod.db",
	runtimeBinding: { record: { phase: "running" } } as never,
	userId: "private-user-id",
	instance: {
		id: "private-instance-id",
		userId: "private-user-id",
		service: "JELLYFIN" as const,
		baseUrl: "https://private.example.invalid",
		apiKey: "private-api-key",
		enabled: true,
		encryptedApiKey: "encrypted-private-api-key",
		encryptionIv: "private-iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		expectedIdentity: "private-provider-identity",
		identityStatus: "VERIFIED" as const,
		connectionGeneration: 3,
		identityGeneration: 4,
	},
	runId: "private-run-id",
	scopes: [],
	attempt: { attemptedAt: new Date("2026-09-24T00:00:00.000Z"), resultMarker: "private-marker" },
	now: new Date("2026-09-24T00:00:00.000Z"),
};

describe("Jellyfin episode finalizer worker execution", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.requireWriteIntent = false;
		mocks.connect.mockResolvedValue(undefined);
		mocks.disconnect.mockResolvedValue(undefined);
		mocks.guard.mockImplementation(async (_prisma, _snapshot, _log, collect, publish, options) => {
			mocks.transactionOptions = options;
			return await publish({}, await collect());
		});
		mocks.finalize.mockResolvedValue({ published: true, itemCount: 17 });
		mocks.prepare.mockResolvedValue({
			kind: "ready",
			cacheGenerationId: payload.runId,
			publishedRows: [],
			contentFingerprint: "synthetic",
			observedAt: payload.now,
			nativePublication: null,
		});
		mocks.prepareNative.mockResolvedValue(undefined);
		mocks.readCompleted.mockResolvedValue(null);
		mocks.acquireEpisode.mockResolvedValue({ token: "synthetic-token" });
		mocks.stageEpisode.mockResolvedValue({
			rowCount: 0,
			receiptCount: 0,
			fingerprint: "synthetic",
		});
		mocks.renewEpisode.mockResolvedValue(true);
		mocks.releaseEpisode.mockResolvedValue(true);
		mocks.cleanupEpisode.mockResolvedValue(true);
		mocks.cleanupObsolete.mockResolvedValue(0);
		mocks.commit.mockResolvedValue({ published: true, itemCount: 17 });
		mocks.settleInvalid.mockResolvedValue(true);
		mocks.cleanup.mockResolvedValue(undefined);
	});
	it("carries actual observed native preparation intervals in a successful worker result", async () => {
		let now = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
		try {
			mocks.prepare.mockResolvedValueOnce({
				kind: "ready",
				cacheGenerationId: payload.runId,
				publishedRows: [],
				contentFingerprint: "synthetic",
				observedAt: payload.now,
				nativePublication: { candidates: [], receipts: [] },
			});
			mocks.prepareNative.mockImplementationOnce(
				async (_prisma, _input, _stageObserver, observe) => {
					observe({ kind: "row-chunk", phase: "requested" });
					now = 10;
					observe({ kind: "row-chunk", phase: "callback-entered" });
					now = 50;
					observe({ kind: "row-chunk", phase: "succeeded" });
				},
			);
			const result = await executeJellyfinEpisodeFinalization(payload);
			expect(result).toMatchObject({
				status: "published",
				itemCount: 17,
				nativeWatchPreparationTiming: {
					version: 1,
					transactions: {
						"row-chunk": {
							requested: 1,
							callbackEntered: 1,
							succeeded: 1,
							failed: 0,
							admissionTotalMs: 10,
							admissionMaxMs: 10,
							callbackToSuccessTotalMs: 40,
							callbackToSuccessMaxMs: 40,
						},
					},
				},
			});
		} finally {
			clock.mockRestore();
		}
	});
	it.each(["no-native", "already-completed"])(
		"omits native preparation timing for %s",
		async (mode) => {
			if (mode === "already-completed") mocks.readCompleted.mockResolvedValueOnce(17);
			const result = await executeJellyfinEpisodeFinalization(payload);
			expect(result).toMatchObject({ status: "published", itemCount: 17 });
			expect(result).not.toHaveProperty("nativeWatchPreparationTiming");
		},
	);
	it("refuses pre-aborted finalization before connecting or publishing", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			executeJellyfinEpisodeFinalization(payload, { signal: controller.signal }),
		).resolves.toEqual({ status: "cancelled" });
		expect(mocks.connect).not.toHaveBeenCalled();
		expect(mocks.commit).not.toHaveBeenCalled();
	});
	it("joins entered preparation then cancels before publication without invalidating the run", async () => {
		const controller = new AbortController();
		let release!: () => void, entered!: () => void;
		const held = new Promise<void>((resolve) => {
				release = resolve;
			}),
			ready = new Promise<void>((resolve) => {
				entered = resolve;
			});
		mocks.stageEpisode.mockImplementationOnce(async () => {
			entered();
			await held;
		});
		let settled = false;
		const pending = executeJellyfinEpisodeFinalization(payload, {
			signal: controller.signal,
		}).finally(() => {
			settled = true;
		});
		await ready;
		controller.abort();
		await Promise.resolve();
		const prematurelySettled = settled;
		release();
		expect(await pending).toEqual({ status: "cancelled" });
		expect(prematurelySettled).toBe(false);
		expect(mocks.commit).not.toHaveBeenCalled();
		expect(mocks.settleInvalid).not.toHaveBeenCalled();
		expect(mocks.releaseEpisode).toHaveBeenCalledOnce();
	});
	it("joins an entered atomic publisher and retains its completed result after cancellation", async () => {
		const controller = new AbortController();
		let release!: () => void, entered!: () => void;
		const held = new Promise<void>((resolve) => {
				release = resolve;
			}),
			ready = new Promise<void>((resolve) => {
				entered = resolve;
			});
		mocks.commit.mockImplementationOnce(async () => {
			entered();
			await held;
			return { published: true, itemCount: 17 };
		});
		let settled = false;
		const pending = executeJellyfinEpisodeFinalization(payload, {
			signal: controller.signal,
		}).finally(() => {
			settled = true;
		});
		await ready;
		controller.abort();
		await Promise.resolve();
		expect(settled).toBe(false);
		release();
		await expect(pending).resolves.toMatchObject({ status: "published", itemCount: 17 });
	});
	it.each(["published", "failed"] as const)(
		"freezes %s worker execution before runtime close and clears its timer",
		async (status) => {
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
			let clock = 1000n;
			const timer = vi.spyOn(process.hrtime, "bigint").mockImplementation(() => clock * 1_000_000n);
			const buffer = createFinalizerLoopObservationBuffer();
			mocks.connect.mockImplementationOnce(async () => {
				clock = 1050n;
				if (status === "failed") throw new Error("private");
			});
			mocks.disconnect.mockImplementationOnce(async () => {
				clock = 9000n;
			});
			try {
				const result = await executeJellyfinEpisodeFinalization({
					...payload,
					loopObservationBuffer: buffer,
				});
				expect(result.status).toBe(status);
				expect(readFinalizerLoopObservation(buffer)).toEqual({
					state: "warming",
					sampleCount: 0,
					sampleSpanMs: 0,
					maxCompletedGapMs: 0,
					currentGapMs: 50,
				});
				expect(mocks.disconnect).toHaveBeenCalledOnce();
				expect(vi.getTimerCount()).toBe(0);
				if (status === "published") expect(result).not.toHaveProperty("loopObservation");
			} finally {
				timer.mockRestore();
				vi.useRealTimers();
			}
		},
	);

	it("prepares and stages with runtime write intent before the guarded commit", async () => {
		mocks.requireWriteIntent = true;
		const events: string[] = [];
		mocks.prepare.mockImplementation(async () => {
			events.push("prepare");
			return {
				kind: "ready",
				cacheGenerationId: payload.runId,
				publishedRows: [],
				contentFingerprint: "synthetic",
				observedAt: payload.now,
				nativePublication: { candidates: [], receipts: [] },
			};
		});
		mocks.acquireEpisode.mockImplementation(async () => {
			events.push("lease");
			return { token: "synthetic-token" };
		});
		mocks.stageEpisode.mockImplementation(async () => {
			events.push("episodes");
		});
		mocks.prepareNative.mockImplementation(async () => {
			events.push("stage");
		});
		mocks.guard.mockImplementation(async (_prisma, _snapshot, _log, collect, publish) => {
			events.push("identity-before");
			const prepared = await collect();
			events.push("identity-after");
			return await publish({}, prepared);
		});
		mocks.commit.mockImplementation(async () => {
			events.push("commit");
			return { published: true, itemCount: 17 };
		});

		const result = await executeJellyfinEpisodeFinalization(payload);

		expect(result.status).toBe("published");
		expect(result).not.toHaveProperty("nativeWatchStage");
		expect(result).not.toHaveProperty("nativeWatchStageElapsedMs");
		expect(result).not.toHaveProperty("nativeWatchStageCount");
		expect(events).toEqual([
			"identity-before",
			"prepare",
			"lease",
			"episodes",
			"stage",
			"identity-after",
			"commit",
		]);
	});

	it.each(["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT"])(
		"classifies preparation conflict %s without publishing",
		async (failureCode) => {
			mocks.prepare.mockResolvedValue({
				kind: "ready",
				cacheGenerationId: payload.runId,
				publishedRows: [],
				contentFingerprint: "synthetic",
				observedAt: payload.now,
				nativePublication: { candidates: [], receipts: [] },
			});
			mocks.prepareNative.mockRejectedValueOnce({
				code: failureCode,
				message: "private synthetic database detail",
			});

			const result = await executeJellyfinEpisodeFinalization(payload);

			expect(result).toMatchObject({
				status: "failed",
				failureCategory: "database-contention",
				failureStage: "native-watch-stage",
				failureCode,
			});
			expect(mocks.commit).not.toHaveBeenCalled();
			expect(JSON.stringify(result)).not.toContain("private");
		},
	);

	it("defers an unavailable run without committing or deleting stages", async () => {
		mocks.prepare.mockResolvedValueOnce({ kind: "not-published" });

		const result = await executeJellyfinEpisodeFinalization(payload);

		expect(result).toEqual({ status: "not-published", reason: "run-not-ready" });
		expect(mocks.commit).not.toHaveBeenCalled();
		expect(mocks.cleanup).not.toHaveBeenCalled();
	});

	it("returns the current native write marker and freezes its duration before lease release", async () => {
		mocks.prepare.mockResolvedValueOnce({
			kind: "ready",
			cacheGenerationId: payload.runId,
			publishedRows: [],
			nativePublication: { candidates: [], receipts: [] },
		});
		let clock = 100;
		const timer = vi.spyOn(performance, "now").mockImplementation(() => clock);
		mocks.prepareNative.mockImplementationOnce(async (_prisma, _input, observe) => {
			observe?.({ stage: "lease-checkpoint" });
			clock = 110;
			observe?.({ stage: "receipt-chunk-write", count: 3 });
			clock = 127;
			throw { code: "P2028", message: "private synthetic database details" };
		});
		mocks.releaseEpisode.mockImplementationOnce(async () => {
			clock = 500;
			return true;
		});
		try {
			const result = await executeJellyfinEpisodeFinalization(payload);
			expect(result).toMatchObject({
				status: "failed",
				failureStage: "native-watch-stage",
				failureCode: "P2028",
				nativeWatchStage: "receipt-chunk-write",
				nativeWatchStageElapsedMs: 17,
				nativeWatchStageCount: 3,
			});
			expect(JSON.stringify(result)).not.toContain("private");
			expect(mocks.commit).not.toHaveBeenCalled();
		} finally {
			timer.mockRestore();
		}
	});

	it.each(["entered", "not-entered", "succeeded", "later-stage"] as const)(
		"freezes preceding-stage and transaction timing on %s failure without leaking stale context",
		async (scenario) => {
			mocks.prepare.mockResolvedValueOnce({
				kind: "ready",
				cacheGenerationId: payload.runId,
				publishedRows: [],
				nativePublication: { candidates: [], receipts: [] },
			});
			let clock = 100;
			const timer = vi.spyOn(performance, "now").mockImplementation(() => clock);
			mocks.prepareNative.mockImplementationOnce(async (_prisma, _input, observe, transaction) => {
				observe({ stage: "row-chunk-write", count: 500 });
				transaction?.({ kind: "row-chunk", phase: "requested" });
				clock = 120;
				transaction?.({ kind: "row-chunk", phase: "callback-entered" });
				clock = 5_100;
				observe({ stage: "authority-check" });
				if (scenario === "not-entered") {
					transaction?.({ kind: "row-chunk", phase: "succeeded" });
					transaction?.({ kind: "receipt-chunk", phase: "requested" });
				} else if (scenario === "succeeded" || scenario === "later-stage") {
					transaction?.({ kind: "row-chunk", phase: "succeeded" });
				}
				clock = 5_102;
				if (scenario === "later-stage") return;
				if (scenario !== "succeeded")
					transaction?.({
						kind: scenario === "not-entered" ? "receipt-chunk" : "row-chunk",
						phase: "failed",
					});
				throw { code: "P2028", message: "private failure" };
			});
			if (scenario === "later-stage") mocks.renewEpisode.mockRejectedValueOnce({ code: "P2028" });
			mocks.releaseEpisode.mockImplementationOnce(async () => {
				clock = 10_000;
				return true;
			});
			try {
				const result = await executeJellyfinEpisodeFinalization(payload);
				expect(result).toMatchObject({
					status: "failed",
					failureCode: "P2028",
					failureStage: scenario === "later-stage" ? "renew-lease" : "native-watch-stage",
				});
				const diagnostics = Object.fromEntries(
					Object.entries(result).filter(([key]) => key.startsWith("nativeWatch")),
				);
				expect(diagnostics).toEqual(
					scenario === "later-stage"
						? {}
						: {
								nativeWatchStage: "authority-check",
								nativeWatchStageElapsedMs: 2,
								nativeWatchPreviousStage: "row-chunk-write",
								nativeWatchPreviousStageElapsedMs: 5_000,
								nativeWatchPreviousStageCount: 500,
								...(scenario === "entered"
									? {
											nativeWatchTransactionKind: "row-chunk",
											nativeWatchTransactionElapsedMs: 5_002,
											nativeWatchTransactionCallbackEntered: true,
											nativeWatchTransactionWaitMs: 20,
											nativeWatchTransactionCallbackElapsedMs: 4_982,
										}
									: scenario === "not-entered"
										? {
												nativeWatchTransactionKind: "receipt-chunk",
												nativeWatchTransactionElapsedMs: 2,
												nativeWatchTransactionCallbackEntered: false,
											}
										: {}),
							},
				);
				expect(mocks.releaseEpisode).toHaveBeenCalledTimes(1);
				expect(mocks.commit).not.toHaveBeenCalled();
				expect(JSON.stringify(result)).not.toContain("private");
			} finally {
				timer.mockRestore();
			}
		},
	);

	it("reports a busy preparation lease as retryable without committing or deleting stages", async () => {
		mocks.acquireEpisode.mockResolvedValueOnce(null);

		const result = await executeJellyfinEpisodeFinalization(payload);

		expect(result).toEqual({ status: "not-published", reason: "lease-busy" });
		expect(mocks.commit).not.toHaveBeenCalled();
		expect(mocks.cleanup).not.toHaveBeenCalled();
	});

	it("releases its own staged lease when the post-staging identity check is unavailable", async () => {
		let leaseActive = false;
		mocks.acquireEpisode.mockImplementation(async () => {
			if (leaseActive) return null;
			leaseActive = true;
			return { token: "synthetic-token" };
		});
		mocks.releaseEpisode.mockImplementation(async (_prisma, input) => {
			if (input.token !== "synthetic-token") return false;
			leaseActive = false;
			return true;
		});
		mocks.guard.mockImplementationOnce(async (_prisma, _snapshot, _log, collect) => {
			await collect();
			throw new ProviderIdentityGuardError("IDENTITY_UNAVAILABLE", "synthetic outage");
		});

		const first = await executeJellyfinEpisodeFinalization(payload);
		expect(first).toEqual({ status: "identity-unavailable" });
		expect(mocks.releaseEpisode).toHaveBeenCalledOnce();
		expect(mocks.releaseEpisode).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ token: "synthetic-token" }),
		);
		expect(leaseActive).toBe(false);
		const second = await executeJellyfinEpisodeFinalization(payload);

		expect(second.status).toBe("published");
		expect(mocks.commit).toHaveBeenCalledOnce();
	});

	it("reports a lost preparation lease without committing", async () => {
		mocks.renewEpisode.mockResolvedValueOnce(false);

		const result = await executeJellyfinEpisodeFinalization(payload);

		expect(result).toEqual({ status: "not-published", reason: "lease-lost" });
		expect(mocks.commit).not.toHaveBeenCalled();
	});

	it("does not settle a shared attempt when native staging loses its lease to a takeover", async () => {
		mocks.prepare.mockResolvedValueOnce({
			kind: "ready",
			cacheGenerationId: payload.runId,
			publishedRows: [],
			contentFingerprint: "synthetic",
			observedAt: payload.now,
			nativePublication: { candidates: [], receipts: [] },
		});
		mocks.prepareNative.mockRejectedValueOnce(new JellyfinNativeWatchLeaseLostError());

		const result = await executeJellyfinEpisodeFinalization(payload);

		expect(result).toEqual({ status: "not-published", reason: "lease-lost" });
		expect(mocks.commit).not.toHaveBeenCalled();
	});

	it("cleans terminal staging only after a proven-invalid run is settled", async () => {
		mocks.prepare.mockResolvedValueOnce({ kind: "invalid", authority: { runId: payload.runId } });

		const result = await executeJellyfinEpisodeFinalization(payload);

		expect(result).toEqual({ status: "not-published", reason: "invalidated" });
		expect(mocks.settleInvalid).toHaveBeenCalledOnce();
		expect(mocks.cleanup).toHaveBeenCalledOnce();
		expect(mocks.commit).not.toHaveBeenCalled();
	});

	it("reports bounded preparation and commit timing without private worker data", async () => {
		mocks.prepare.mockImplementation(async (input) => {
			input.recordTiming(
				{
					authorityMs: 1,
					stageLoadMs: 2,
					computeMs: 3,
					episodeWriteMs: 0,
					nativeProjectionMs: 1,
					nativeWatchWriteMs: 0,
					totalMs: 6,
					stageRows: 7,
					nativeCandidates: 8,
				},
				6,
			);
			return {
				kind: "ready",
				cacheGenerationId: payload.runId,
				publishedRows: [],
				contentFingerprint: "synthetic",
				observedAt: payload.now,
				nativePublication: null,
			};
		});

		const result = await executeJellyfinEpisodeFinalization(payload);

		expect(result).toMatchObject({
			status: "published",
			timing: { authorityMs: 1, stageLoadMs: 2, computeMs: 3, stageRows: 7, nativeCandidates: 8 },
		});
		expect(JSON.stringify(result)).not.toContain("private");
	});

	it("preserves committed success if optional timing diagnostics are absent", async () => {
		const result = await executeJellyfinEpisodeFinalization(payload);

		expect(result.status).toBe("published");
		if (result.status !== "published") throw new Error("publication unexpectedly failed");
		expect(result.itemCount).toBe(17);
		expect(result.timing).toBeUndefined();
		expect(mocks.transactionOptions).toEqual({
			cleanupRunClaimToken: undefined,
			now: expect.any(Function),
			timeout: 60_000,
		});
		expect(mocks.cleanup).toHaveBeenCalledOnce();
	});

	it("acknowledges a previously committed exact run without staging a second time", async () => {
		mocks.readCompleted.mockResolvedValueOnce(17);
		const result = await executeJellyfinEpisodeFinalization(payload);
		expect(result).toMatchObject({ status: "published", itemCount: 17 });
		expect(mocks.prepare).not.toHaveBeenCalled();
		expect(mocks.stageEpisode).not.toHaveBeenCalled();
		expect(mocks.commit).not.toHaveBeenCalled();
	});

	it("classifies an expired publication transaction without exposing its error", async () => {
		mocks.guard.mockRejectedValueOnce({
			code: "P2028",
			message: "private database path and provider credential",
		});

		const result = await executeJellyfinEpisodeFinalization(payload);

		expect(result).toMatchObject({
			status: "failed",
			failurePhase: "publication",
			failureCategory: "transaction-expired",
			failureElapsedMs: expect.any(Number),
		});
		expect(JSON.stringify(result)).not.toContain("private");
	});
});
