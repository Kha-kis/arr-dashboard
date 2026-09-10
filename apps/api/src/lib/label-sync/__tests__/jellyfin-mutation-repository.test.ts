import { describe, expect, it } from "vitest";
import {
	deriveActiveOperationKey,
	JellyfinMutationRepository,
	type MutationClaimInput,
	type StoredMutationSnapshot,
	validateMutationClaimInput,
} from "../jellyfin-mutation-repository.js";
import { MAX_LABEL_SYNC_MUTATION_ATTEMPTS } from "../jellyfin-mutation-state.js";

const input: MutationClaimInput = {
	userId: "owner-1",
	ruleId: "rule-1",
	destinationInstanceId: "destination-1",
	provider: "jellyfin",
	mediaType: "movie",
	tmdbId: 42,
	connectionGeneration: 3,
	identityGeneration: 7,
	targetItemId: "item-1",
	libraryId: "library-1",
	intentFingerprint: "intent-fingerprint",
	ruleFingerprint: "rule-fingerprint",
	destinationTag: "managed",
};

describe("JellyfinMutationRepository", () => {
	it("derives a versioned lowercase SHA-256 key from stable identity only", () => {
		const key = deriveActiveOperationKey(input);
		expect(key).toMatch(/^v1:[0-9a-f]{64}$/);
		expect(deriveActiveOperationKey({ ...input, connectionGeneration: 99 })).toBe(key);
		expect(deriveActiveOperationKey({ ...input, targetItemId: "moved" })).toBe(key);
		expect(deriveActiveOperationKey({ ...input, intentFingerprint: "changed" })).toBe(key);
		expect(deriveActiveOperationKey({ ...input, destinationTag: "other" })).not.toBe(key);
		expect(deriveActiveOperationKey({ ...input, tmdbId: 43 })).not.toBe(key);
	});

	it("rejects malformed claim input before repository construction", () => {
		expect(() => validateMutationClaimInput({ ...input, provider: "JELLYFIN" })).toThrow(
			"Invalid mutation claim input",
		);
		expect(() => validateMutationClaimInput({ ...input, tmdbId: 0 })).toThrow();
		expect(() => validateMutationClaimInput({ ...input, connectionGeneration: -1 })).toThrow();
		expect(() => validateMutationClaimInput({ ...input, destinationTag: "" })).toThrow();
		expect(() => validateMutationClaimInput({ ...input, claimToken: "forged" })).toThrow();
	});

	it("validates malformed claims before opening a transaction", async () => {
		let transactions = 0;
		const repository = new JellyfinMutationRepository({
			$transaction: async () => {
				transactions += 1;
				return undefined;
			},
		});
		await expect(repository.claim({ ...input, tmdbId: Number.NaN })).rejects.toThrow(
			"Invalid mutation claim input",
		);
		expect(transactions).toBe(0);
	});

	it("requires a complete tokenless stored snapshot and exact transition counters", () => {
		const snapshot: StoredMutationSnapshot = {
			id: "attempt-1",
			userId: input.userId,
			ruleId: input.ruleId,
			destinationInstanceId: input.destinationInstanceId,
			provider: input.provider,
			mediaType: input.mediaType,
			tmdbId: input.tmdbId,
			connectionGeneration: input.connectionGeneration,
			identityGeneration: input.identityGeneration,
			targetItemId: input.targetItemId,
			libraryId: input.libraryId,
			intentFingerprint: input.intentFingerprint,
			ruleFingerprint: input.ruleFingerprint,
			destinationTag: input.destinationTag,
			activeOperationKey: deriveActiveOperationKey(input),
			sendAttemptCount: 1,
			reconcileAttemptCount: 0,
			requestStartedAt: new Date("2026-09-05T00:00:00.000Z"),
			lastObservedAt: null,
			completedAt: null,
			status: "unknown",
			reasonCode: "uncertain_send",
		};
		expect("claimToken" in snapshot).toBe(false);
		expect(snapshot.activeOperationKey).toMatch(/^v1:[0-9a-f]{64}$/);
	});

	it("rejects invalid outcome pairings and future outcome keys", async () => {
		const repository = new JellyfinMutationRepository({
			$transaction: async () => ({ count: 0 }),
		});
		const common = {
			...input,
			id: "attempt-1",
			activeOperationKey: deriveActiveOperationKey(input),
			claimToken: "opaque-token",
			sendAttemptCount: 1,
		};
		await expect(
			repository.completeSend({
				...common,
				status: "verified",
				reasonCode: "provider_unavailable",
			}),
		).rejects.toThrow();
		await expect(
			repository.completeSend({ ...common, status: "failed", reasonCode: "applied" }),
		).rejects.toThrow();
		await expect(
			repository.completeSend({ ...common, status: "unknown", reasonCode: "future" as never }),
		).rejects.toThrow();
		await expect(
			repository.completeReconciliation({
				...common,
				reconcileAttemptCount: 1,
				outcome: { status: "unknown", reasonCode: "attempt_limit", extra: "private" } as never,
			}),
		).rejects.toThrow();
	});

	it("fences fabricated keys, tokens, and counters without mutating", async () => {
		let updates = 0;
		const repository = new JellyfinMutationRepository({
			$transaction: async (work) =>
				work({
					labelSyncMutationAttempt: {
						updateMany: async () => {
							updates += 1;
							return { count: 0 };
						},
						findFirst: async () => null,
					},
				}),
		});
		const common = {
			id: "attempt-1",
			userId: input.userId,
			ruleId: input.ruleId,
			destinationInstanceId: input.destinationInstanceId,
			activeOperationKey: "v1:0000000000000000000000000000000000000000000000000000000000000000",
			claimToken: "forged-token",
		};
		await expect(repository.markSending({ ...common, sendAttemptCount: 0 })).resolves.toEqual({
			kind: "superseded",
		});
		await expect(
			repository.completeSend({
				...common,
				sendAttemptCount: 1,
				status: "failed",
				reasonCode: "confirmed_absent",
				lastObservedAt: new Date("2026-09-05T00:00:00.000Z"),
			}),
		).resolves.toEqual({ kind: "superseded" });
		await expect(repository.acquireReconciliation({ ...common })).resolves.toEqual({
			kind: "not-reconcilable",
		});
		await expect(
			repository.completeReconciliation({
				...common,
				reconcileAttemptCount: 1,
				outcome: { status: "unknown", reasonCode: "attempt_limit" },
			}),
		).resolves.toEqual({ kind: "superseded" });
		await expect(repository.markSending({ ...common, sendAttemptCount: 1 })).rejects.toThrow();
		expect(updates).toBe(3);
	});

	it("rechecks the exact row when an attempt-limit CAS loses without ownership", async () => {
		const activeOperationKey = deriveActiveOperationKey(input);
		const current = {
			id: "attempt-1",
			...input,
			activeOperationKey,
			claimToken: null,
			sendAttemptCount: 1,
			reconcileAttemptCount: MAX_LABEL_SYNC_MUTATION_ATTEMPTS,
			requestStartedAt: new Date("2026-09-05T00:00:00.000Z"),
			lastObservedAt: null,
			completedAt: null,
			status: "unknown",
			reasonCode: "reconciliation_unavailable",
			createdAt: new Date("2026-09-05T00:00:00.000Z"),
			updatedAt: new Date("2026-09-05T00:00:00.000Z"),
		};
		let reads = 0;
		const queries: Array<Record<string, unknown>> = [];
		const repository = new JellyfinMutationRepository({
			$transaction: async (work) =>
				work({
					labelSyncMutationAttempt: {
						findFirst: async (args: { where: Record<string, unknown> }) => {
							queries.push(args.where);
							reads += 1;
							return reads === 1 ? current : { ...current, reasonCode: "attempt_limit" };
						},
						updateMany: async () => ({ count: 0 }),
					},
				}),
		});

		await expect(
			repository.acquireReconciliation({
				id: current.id,
				userId: input.userId,
				ruleId: input.ruleId,
				destinationInstanceId: input.destinationInstanceId,
				activeOperationKey,
			}),
		).resolves.toMatchObject({
			kind: "attempt-limit",
			id: current.id,
			reconcileAttemptCount: MAX_LABEL_SYNC_MUTATION_ATTEMPTS,
		});
		expect(reads).toBe(2);
		expect(queries[1]).toMatchObject({
			userId: input.userId,
			ruleId: input.ruleId,
			destinationInstanceId: input.destinationInstanceId,
			activeOperationKey,
			status: "unknown",
		});
	});

	it("does not expose provider modules or raw input in generic errors", async () => {
		const repository = new JellyfinMutationRepository(
			{
				$transaction: async () => {
					throw new Error("private-tag provider URL raw database detail");
				},
			},
			{
				clock: () => new Date("2026-09-05T00:00:00.000Z"),
				tokenFactory: () => "opaque-token",
			},
		);
		await expect(repository.claim({ ...input, userId: "private-owner" })).rejects.toThrow(
			/Mutation repository dependency failure/,
		);
		await expect(repository.claim({ ...input, destinationTag: "private-tag" })).rejects.not.toThrow(
			/private-tag/,
		);
	});

	it("rejects impossible terminal completions before opening a transaction", async () => {
		let transactions = 0;
		let updates = 0;
		const repository = new JellyfinMutationRepository({
			$transaction: async (work) => {
				transactions += 1;
				return work({
					labelSyncMutationAttempt: {
						updateMany: async () => {
							updates += 1;
							return { count: 0 };
						},
					},
				});
			},
		});
		const common = {
			id: "attempt-1",
			userId: input.userId,
			ruleId: input.ruleId,
			destinationInstanceId: input.destinationInstanceId,
			activeOperationKey: deriveActiveOperationKey(input),
			claimToken: "opaque-token",
		};

		await expect(
			repository.completePreSend({
				...common,
				sendAttemptCount: 0,
				status: "noop",
				reasonCode: "already_applied",
			}),
		).rejects.toThrow();
		const authorityReasons = [
			"identity_changed",
			"rule_changed",
			"destination_changed",
			"generation_changed",
			"target_missing",
			"target_ambiguous",
			"target_changed",
			"library_ancestry_changed",
		] as const;
		for (const reasonCode of authorityReasons) {
			await expect(
				repository.completeSend({
					...common,
					sendAttemptCount: 1,
					status: "blocked" as never,
					reasonCode,
				}),
			).rejects.toThrow();
			await expect(
				repository.completeReconciliation({
					...common,
					reconcileAttemptCount: 1,
					outcome: { status: "blocked", reasonCode } as never,
				}),
			).rejects.toThrow();
		}
		expect(transactions).toBe(0);
		expect(updates).toBe(0);
	});

	it("rejects malformed CAS envelopes before opening any completion transaction", async () => {
		let transactions = 0;
		let updates = 0;
		const repository = new JellyfinMutationRepository({
			$transaction: async (work) => {
				transactions += 1;
				return work({
					labelSyncMutationAttempt: {
						updateMany: async () => {
							updates += 1;
							return { count: 0 };
						},
					},
				});
			},
		});
		const malformed = {
			id: "attempt-1",
			userId: input.userId,
			ruleId: input.ruleId,
			destinationInstanceId: input.destinationInstanceId,
			activeOperationKey: deriveActiveOperationKey(input),
			claimToken: "opaque-token",
		};
		await expect(
			repository.completePreSend({
				...malformed,
				id: " ",
				sendAttemptCount: 0,
				status: "failed",
				reasonCode: "provider_unavailable",
			}),
		).rejects.toThrow();
		await expect(
			repository.completeSend({
				...malformed,
				userId: "x".repeat(513),
				sendAttemptCount: 1,
				status: "failed",
				reasonCode: "confirmed_absent",
				lastObservedAt: new Date("2026-09-05T00:00:00.000Z"),
			}),
		).rejects.toThrow();
		await expect(
			repository.completeReconciliation({
				...malformed,
				claimToken: "",
				reconcileAttemptCount: 1,
				outcome: { status: "unknown", reasonCode: "attempt_limit" },
			}),
		).rejects.toThrow();
		expect(transactions).toBe(0);
		expect(updates).toBe(0);
	});

	it("accepts every authority reason for a zero-send pre-send block", async () => {
		let updates = 0;
		const repository = new JellyfinMutationRepository({
			$transaction: async (work) =>
				work({
					labelSyncMutationAttempt: {
						updateMany: async () => {
							updates += 1;
							return { count: 1 };
						},
					},
				}),
		});
		const common = {
			id: "attempt-1",
			userId: input.userId,
			ruleId: input.ruleId,
			destinationInstanceId: input.destinationInstanceId,
			activeOperationKey: deriveActiveOperationKey(input),
			claimToken: "opaque-token",
			sendAttemptCount: 0,
			status: "blocked" as const,
		};
		const authorityReasons = [
			"identity_changed",
			"rule_changed",
			"destination_changed",
			"generation_changed",
			"target_missing",
			"target_ambiguous",
			"target_changed",
			"library_ancestry_changed",
		] as const;
		for (const reasonCode of authorityReasons) {
			await expect(repository.completePreSend({ ...common, reasonCode })).resolves.toEqual({
				kind: "applied",
				status: "blocked",
			});
		}
		expect(updates).toBe(authorityReasons.length);
	});
});
