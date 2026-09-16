import type { ProviderObservationReasonCode } from "@arr/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../prisma.js";
import type {
	OwnedProviderPublicationSnapshot,
	ProviderPublicationAuthority,
} from "../../services/provider-identity-guard.js";
import {
	ProviderObservationCoordinatorError,
	runClaimedProviderObservationAttempt,
	runProviderObservationAttempt,
} from "../coordinator.js";
import type { ProviderCoverageReceiptV1 } from "../coverage-receipt.js";

const lifecycle = vi.hoisted(() => ({
	begin: vi.fn(),
	finishFailure: vi.fn(),
	finishSuccess: vi.fn(),
	guard: vi.fn(),
}));

vi.mock("../../services/provider-cache-status.js", () => ({
	beginProviderCacheRefreshAttempt: lifecycle.begin,
	finishProviderCacheRefreshAttemptFailure: lifecycle.finishFailure,
	finishProviderCacheRefreshAttemptSuccess: lifecycle.finishSuccess,
}));

vi.mock("../../services/provider-identity-guard.js", () => ({
	withGuardedProviderPublication: lifecycle.guard,
}));

const authority: ProviderPublicationAuthority = {
	id: "provider-1",
	userId: "user-1",
	service: "PLEX",
	baseUrl: "https://plex.invalid",
	enabled: true,
	encryptedApiKey: "ciphertext",
	encryptionIv: "iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	expectedIdentity: "machine-a",
	identityStatus: "VERIFIED",
	connectionGeneration: 4,
	identityGeneration: 9,
};

const prepared = {
	...authority,
	apiKey: "secret",
	httpAuthHeaders: {},
} as OwnedProviderPublicationSnapshot;

function receipt(attemptStartedAt: Date, observedAt: Date): ProviderCoverageReceiptV1 {
	return {
		version: 1 as const,
		provider: "plex" as const,
		attemptStartedAt: attemptStartedAt.toISOString(),
		observedAt: observedAt.toISOString(),
		evidence: "complete" as const,
		units: [
			{
				scopeKey: "library:one",
				expectedRawCount: 2,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: 2,
				sourceBindings: 2,
				canonicalEntities: 2,
				acceptedSkips: [],
				fatalCount: 0,
			},
		],
	};
}

function setup() {
	const attemptedAt = new Date("2026-09-02T12:00:00.000Z");
	const observedAt = new Date("2026-09-02T12:01:00.000Z");
	const attempt = {
		attemptedAt,
		resultMarker: "in_progress:00000000-0000-4000-8000-000000000001",
	};
	const events: string[] = [];
	lifecycle.begin.mockImplementation(async () => {
		events.push("begin-attempt");
		return attempt;
	});
	lifecycle.finishFailure.mockImplementation(async () => "recorded");
	lifecycle.finishSuccess.mockImplementation(async () => {
		events.push("finish-success");
		return "recorded";
	});
	lifecycle.guard.mockImplementation(async (_prisma, _snapshot, _log, collect, publish) => {
		const collected = await collect();
		events.push("guard-recheck");
		events.push("publish-transaction");
		return await publish({} as never, collected);
	});
	return { attempt, attemptedAt, observedAt, events };
}

const input = (overrides: Partial<Parameters<typeof runProviderObservationAttempt>[0]> = {}) => ({
	prisma: {} as PrismaClient,
	authority,
	cacheType: "plex" as const,
	log: { warn: vi.fn() } as never,
	prepare: vi.fn(() => prepared),
	collect: vi.fn(async (value: OwnedProviderPublicationSnapshot) => ({ value })),
	publish: vi.fn(async (_tx, _collected, _attempt) => {
		const attemptedAt = new Date("2026-09-02T12:00:00.000Z");
		const observedAt = new Date("2026-09-02T12:01:00.000Z");
		return {
			result: "published",
			publication: {
				receipt: receipt(attemptedAt, observedAt),
				observedAt,
				itemCount: 2,
				generationId: "generation-1",
				generationMetadata: "metadata",
			},
		};
	}),
	failureReason: vi.fn((): ProviderObservationReasonCode => "provider-unavailable"),
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("runProviderObservationAttempt", () => {
	it("executes a supplied durable claim without beginning a second attempt", async () => {
		const state = setup();
		const value = input();

		await expect(runClaimedProviderObservationAttempt(value, state.attempt)).resolves.toBe(
			"published",
		);
		expect(lifecycle.begin).not.toHaveBeenCalled();
		expect(value.collect).toHaveBeenCalledWith(prepared, state.attempt);
	});

	it("claims before credentials, guards collection, publishes, and finishes success", async () => {
		const state = setup();
		const value = input({
			prepare: vi.fn(() => {
				state.events.push("prepare-credentials");
				return prepared;
			}),
			collect: vi.fn(async () => {
				state.events.push("collect");
				return "collected";
			}),
		});

		await expect(runProviderObservationAttempt(value)).resolves.toBe("published");
		expect(state.events).toEqual([
			"begin-attempt",
			"prepare-credentials",
			"collect",
			"guard-recheck",
			"publish-transaction",
			"finish-success",
		]);
	});

	it("passes the durably claimed attempt to the collector", async () => {
		const state = setup();
		const collect = vi.fn(async () => "collected");
		const value = input({ collect });

		await expect(runProviderObservationAttempt(value)).resolves.toBe("published");
		expect(collect).toHaveBeenCalledWith(prepared, state.attempt);
	});

	it.each([
		["the exact explicit global count", 1, 1, true],
		["a smaller publication item count", 0, 1, false],
		["a larger publication item count", 2, 1, false],
	])(
		"uses %s for publication item-count validation",
		async (_name, itemCount, globalCount, succeeds) => {
			const state = setup();
			const value = input({
				publish: vi.fn(async () => ({
					result: "published",
					publication: {
						receipt: {
							...receipt(state.attemptedAt, state.observedAt),
							units: receipt(state.attemptedAt, state.observedAt).units.map((unit) => ({
								...unit,
								canonicalEntities: 1,
							})),
							publishedCanonicalEntities: globalCount,
						},
						observedAt: state.observedAt,
						itemCount,
						generationId: null,
						generationMetadata: null,
					},
				})),
			});

			if (succeeds) await expect(runProviderObservationAttempt(value)).resolves.toBe("published");
			else
				await expect(runProviderObservationAttempt(value)).rejects.toMatchObject({
					code: "receipt-invalid",
				});
		},
	);

	it("records a bounded failure when preparation throws", async () => {
		const state = setup();
		const secret = "provider secret must not escape";
		const value = input({
			prepare: vi.fn(() => {
				throw new Error(secret);
			}),
		});

		const error = await runProviderObservationAttempt(value).catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(ProviderObservationCoordinatorError);
		expect(error).not.toHaveProperty("message", expect.stringContaining(secret));
		expect(lifecycle.finishFailure).toHaveBeenCalledWith(
			value.prisma,
			value.cacheType,
			"provider-unavailable",
			value.authority,
			state.attempt,
			value.log,
			value.options,
		);
		expect(value.collect).not.toHaveBeenCalled();
	});

	it("rejects a prepared snapshot that is not the claimed authority", async () => {
		const state = setup();
		const privateB = "private-provider-b-credential";
		const preparedB = {
			...prepared,
			id: "provider-b",
			userId: "user-b",
			service: "PLEX" as const,
			baseUrl: "https://plex-b.invalid",
			enabled: true,
			encryptedApiKey: "ciphertext-b",
			encryptionIv: "iv-b",
			encryptedHttpAuthCredentials: "proxy-ciphertext-b",
			httpAuthEncryptionIv: "proxy-iv-b",
			expectedIdentity: "machine-b",
			identityStatus: "VERIFIED" as const,
			connectionGeneration: 5,
			identityGeneration: 10,
			apiKey: privateB,
		} as OwnedProviderPublicationSnapshot;
		const log = { warn: vi.fn() };
		const value = input({
			log: log as never,
			prepare: vi.fn(() => preparedB),
			failureReason: vi.fn((): ProviderObservationReasonCode => "publication-superseded"),
		});

		await expect(runProviderObservationAttempt(value)).rejects.toMatchObject({
			code: "publication-superseded",
		});
		expect(value.collect).not.toHaveBeenCalled();
		expect(lifecycle.guard).not.toHaveBeenCalled();
		expect(value.publish).not.toHaveBeenCalled();
		expect(lifecycle.finishSuccess).not.toHaveBeenCalled();
		expect(lifecycle.finishFailure).toHaveBeenCalledWith(
			value.prisma,
			value.cacheType,
			"publication-superseded",
			value.authority,
			state.attempt,
			log as never,
			value.options,
		);
		expect(JSON.stringify(log.warn.mock.calls)).not.toContain(privateB);
		expect(JSON.stringify(lifecycle.finishFailure.mock.calls)).not.toContain(privateB);
	});

	it("does not prepare or finish when the attempt is already superseded", async () => {
		setup();
		lifecycle.begin.mockResolvedValue(null);
		const value = input();

		await expect(runProviderObservationAttempt(value)).rejects.toMatchObject({
			code: "publication-superseded",
		});
		expect(value.prepare).not.toHaveBeenCalled();
		expect(lifecycle.finishFailure).not.toHaveBeenCalled();
	});

	it("rejects a mismatched receipt and records only a bounded reason", async () => {
		const state = setup();
		const value = input({
			publish: vi.fn(async () => ({
				result: "published",
				publication: {
					receipt: receipt(new Date("2026-09-02T11:59:00.000Z"), state.observedAt),
					observedAt: state.observedAt,
					itemCount: 2,
					generationId: null,
					generationMetadata: null,
				},
			})),
			failureReason: vi.fn((): ProviderObservationReasonCode => "receipt-invalid"),
		});

		await expect(runProviderObservationAttempt(value)).rejects.toMatchObject({
			code: "receipt-invalid",
		});
		expect(lifecycle.finishSuccess).not.toHaveBeenCalled();
		expect(lifecycle.finishFailure).toHaveBeenCalledOnce();
	});

	it("rejects a future receipt before the success CAS with a bounded reason", async () => {
		const state = setup();
		const futureObservedAt = new Date("2026-09-02T12:02:00.000Z");
		const value = input({
			options: { now: () => state.observedAt },
			publish: vi.fn(async () => ({
				result: "published",
				publication: {
					receipt: receipt(state.attemptedAt, futureObservedAt),
					observedAt: futureObservedAt,
					itemCount: 2,
					generationId: null,
					generationMetadata: null,
				},
			})),
			failureReason: vi.fn((): ProviderObservationReasonCode => "receipt-invalid"),
		});

		await expect(runProviderObservationAttempt(value)).rejects.toMatchObject({
			code: "receipt-invalid",
		});
		expect(lifecycle.finishSuccess).not.toHaveBeenCalled();
		expect(lifecycle.finishFailure).toHaveBeenCalledWith(
			value.prisma,
			value.cacheType,
			"receipt-invalid",
			value.authority,
			state.attempt,
			value.log,
			value.options,
		);
	});

	it("keeps a collection failure bounded and does not publish", async () => {
		setup();
		const secret = "provider response secret";
		const value = input({
			collect: vi.fn(async () => {
				throw new Error(secret);
			}),
		});

		const error = await runProviderObservationAttempt(value).catch((reason: unknown) => reason);
		expect(error).toMatchObject({ code: "provider-unavailable" });
		expect(error).not.toHaveProperty("message", expect.stringContaining(secret));
		expect(value.publish).not.toHaveBeenCalled();
		expect(lifecycle.finishFailure).toHaveBeenCalledOnce();
	});

	it("does not publish after the identity guard rejects rotation", async () => {
		setup();
		lifecycle.guard.mockRejectedValue(new Error("rotated provider identity"));
		const value = input({
			failureReason: vi.fn((): ProviderObservationReasonCode => "identity-changed"),
		});

		await expect(runProviderObservationAttempt(value)).rejects.toMatchObject({
			code: "identity-changed",
		});
		expect(value.publish).not.toHaveBeenCalled();
		expect(lifecycle.finishFailure).toHaveBeenCalledOnce();
	});

	it("turns a late success CAS into a bounded superseded failure", async () => {
		setup();
		lifecycle.finishSuccess.mockResolvedValue("superseded");
		const value = input();

		await expect(runProviderObservationAttempt(value)).rejects.toMatchObject({
			code: "publication-superseded",
		});
		expect(lifecycle.finishFailure).toHaveBeenCalledOnce();
	});

	it("contains a transaction failure without returning its raw cause", async () => {
		setup();
		const secret = "database transaction details";
		lifecycle.finishSuccess.mockRejectedValue(new Error(secret));
		const value = input({
			failureReason: vi.fn((): ProviderObservationReasonCode => "unknown-failure"),
		});

		const error = await runProviderObservationAttempt(value).catch((reason: unknown) => reason);
		expect(error).toMatchObject({ code: "unknown-failure" });
		expect(error).not.toHaveProperty("message", expect.stringContaining(secret));
		expect(lifecycle.finishFailure).toHaveBeenCalledOnce();
	});
});
