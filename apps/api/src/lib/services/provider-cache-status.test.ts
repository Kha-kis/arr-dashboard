import type { ProviderObservationStatus } from "@arr/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	beginPlexCacheRefreshAttempt,
	claimProviderCacheRefreshAttempt,
	classifyProviderCacheStatusGeneration,
	finishPlexCacheRefreshAttemptFailure,
	finishProviderCacheRefreshAttemptFailure,
	projectProviderObservationUi,
	reconcileInterruptedProviderCacheRefreshAttempts,
	recordPlexCacheRefreshFailure,
	recordWatchProviderCacheRefreshFailure,
} from "./provider-cache-status.js";
import type { OwnedProviderPublicationSnapshot } from "./provider-identity-guard.js";

const log = { warn: vi.fn() };

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

function plexSnapshot(
	overrides: Partial<OwnedProviderPublicationSnapshot> = {},
): OwnedProviderPublicationSnapshot {
	return {
		id: "plex-1",
		userId: "user-1",
		service: "PLEX",
		label: "Primary Plex",
		baseUrl: "https://plex.invalid",
		apiKey: "decrypted-token",
		httpAuthHeaders: { Authorization: "Basic proxy" },
		enabled: true,
		encryptedApiKey: "encrypted-token",
		encryptionIv: "token-iv",
		encryptedHttpAuthCredentials: "encrypted-proxy",
		httpAuthEncryptionIv: "proxy-iv",
		expectedIdentity: "plex-machine-a",
		identityStatus: "VERIFIED",
		connectionGeneration: 4,
		identityGeneration: 9,
		...overrides,
	};
}

function publicationFixture(
	current: OwnedProviderPublicationSnapshot,
	status: {
		id?: string;
		connectionGeneration: number | null;
		identityGeneration: number | null;
		lastAttemptAt?: Date | null;
		lastAttemptResult?: string | null;
	} | null,
) {
	const tx = {
		libraryCleanupConfig: {
			upsert: vi.fn(async () => ({ id: "cleanup-user-1" })),
			findUnique: vi.fn(async () => ({ id: "cleanup-user-1", runClaimToken: null })),
		},
		serviceInstance: {
			findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
				Object.entries(where).every(
					([key, value]) => current[key as keyof OwnedProviderPublicationSnapshot] === value,
				)
					? { id: current.id }
					: null,
			),
		},
		cacheRefreshStatus: {
			findUnique: vi.fn().mockResolvedValue(status),
			upsert: vi.fn().mockResolvedValue({}),
			create: vi.fn().mockResolvedValue({}),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
	};
	const prisma = {
		$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
			callback(tx),
		),
	};
	return { prisma, tx };
}

describe("provider cache status generation classifier", () => {
	it.each([
		["null/null", { connectionGeneration: null, identityGeneration: null }, "obsolete"],
		["current/current", { connectionGeneration: 4, identityGeneration: 9 }, "current"],
		["current/null", { connectionGeneration: 4, identityGeneration: null }, "obsolete"],
		["null/current", { connectionGeneration: null, identityGeneration: 9 }, "obsolete"],
		["older connection", { connectionGeneration: 3, identityGeneration: 9 }, "obsolete"],
		["older identity", { connectionGeneration: 4, identityGeneration: 8 }, "obsolete"],
		["both older", { connectionGeneration: 3, identityGeneration: 8 }, "obsolete"],
		[
			"newer connection",
			{ connectionGeneration: 5, identityGeneration: 9 },
			"future-or-inconsistent",
		],
		[
			"newer identity",
			{ connectionGeneration: 4, identityGeneration: 10 },
			"future-or-inconsistent",
		],
		[
			"crossed older connection",
			{ connectionGeneration: 3, identityGeneration: 10 },
			"future-or-inconsistent",
		],
		[
			"crossed older identity",
			{ connectionGeneration: 5, identityGeneration: 8 },
			"future-or-inconsistent",
		],
		["negative", { connectionGeneration: -1, identityGeneration: 9 }, "future-or-inconsistent"],
		[
			"unsafe",
			{ connectionGeneration: Number.MAX_SAFE_INTEGER + 1, identityGeneration: 9 },
			"future-or-inconsistent",
		],
		[
			"fractional status connection",
			{ connectionGeneration: 3.5, identityGeneration: 9 },
			"future-or-inconsistent",
		],
		[
			"fractional status identity",
			{ connectionGeneration: 4, identityGeneration: 8.5 },
			"future-or-inconsistent",
		],
		[
			"malformed status",
			{ connectionGeneration: "4", identityGeneration: 9 },
			"future-or-inconsistent",
		],
		[
			"malformed authority",
			{ connectionGeneration: 4, identityGeneration: 9 },
			"future-or-inconsistent",
			{ connectionGeneration: 4, identityGeneration: Number.NaN },
		],
		[
			"fractional authority connection",
			{ connectionGeneration: 4, identityGeneration: 9 },
			"future-or-inconsistent",
			{ connectionGeneration: 4.5, identityGeneration: 9 },
		],
		[
			"fractional authority identity",
			{ connectionGeneration: 4, identityGeneration: 9 },
			"future-or-inconsistent",
			{ connectionGeneration: 4, identityGeneration: 9.5 },
		],
	] as const)(
		"classifies %s provenance",
		(_name, status, expected, authority = { connectionGeneration: 4, identityGeneration: 9 }) => {
			expect(classifyProviderCacheStatusGeneration(status, authority)).toBe(expected);
		},
	);
});

describe("provider observation UI projection", () => {
	it("fails closed instead of throwing for malformed runtime status", () => {
		expect(() => projectProviderObservationUi({ availability: "current" } as never)).not.toThrow();
		expect(projectProviderObservationUi({ availability: "current" } as never)).toEqual({
			condition: "unavailable",
		});
	});

	it("keeps current mapped data usable while exposing deterministic mapping gaps as informational", () => {
		expect(
			projectProviderObservationUi({
				availability: "partial",
				evidence: "partial",
				observedAt: "2026-09-07T00:00:00.000Z",
				ageSeconds: 0,
				latestAttempt: "successful",
				reasonCodes: ["accepted-skips", "coverage-incomplete"],
				domains: [
					{
						domain: "library-inventory",
						availability: "current",
						evidence: "complete",
						valueSemantics: "exact",
						observedAt: "2026-09-07T00:00:00.000Z",

						reasonCodes: [],
					},
					{
						domain: "mapping",
						availability: "current",
						evidence: "partial",
						valueSemantics: "lower-bound",
						observedAt: "2026-09-07T00:00:00.000Z",
						reasonCodes: ["accepted-skips"],
					},
				],
			}),
		).toEqual({ condition: "informational-gap" });
	});

	it.each([
		[
			"fails closed when unavailable unknown evidence only reports a provider limit",
			{
				availability: "unavailable",
				evidence: "unknown",
				observedAt: null,
				ageSeconds: null,
				latestAttempt: "successful",
				reasonCodes: ["provider-limit"],
			},
			undefined,
			"unavailable",
		],
		[
			"keeps unknown unavailable evidence collecting while durable work is active",
			{
				availability: "unavailable",
				evidence: "unknown",
				observedAt: null,
				ageSeconds: null,
				latestAttempt: "running",
				reasonCodes: ["provider-limit", "no-publication", "refresh-running"],
			},
			{ state: "running" },
			"collecting",
		],
		[
			"marks a current usable domain with accepted skips as informational",
			{
				availability: "current",
				evidence: "unknown",
				observedAt: "2026-09-07T00:00:00.000Z",
				ageSeconds: 0,
				latestAttempt: "successful",
				reasonCodes: ["accepted-skips"],
				domains: [
					{
						domain: "library-inventory",
						availability: "current",
						evidence: "complete",
						valueSemantics: "exact",
						observedAt: "2026-09-07T00:00:00.000Z",
						reasonCodes: [],
					},
				],
			},
			undefined,
			"informational-gap",
		],
		[
			"does not infer usable data from current unknown evidence",
			{
				availability: "current",
				evidence: "unknown",
				observedAt: "2026-09-07T00:00:00.000Z",
				ageSeconds: 0,
				latestAttempt: "successful",
				reasonCodes: [],
			},
			undefined,
			"unavailable",
		],
		[
			"fails closed for partial evidence with an invalid receipt and no usable domain",
			{
				availability: "partial",
				evidence: "partial",
				observedAt: "2026-09-07T00:00:00.000Z",
				ageSeconds: 0,
				latestAttempt: "successful",
				reasonCodes: ["receipt-invalid"],
			},
			undefined,
			"unavailable",
		],
	] as const)("%s", (_name, status, work, expected) => {
		expect(
			projectProviderObservationUi(status as unknown as ProviderObservationStatus, work as never),
		).toEqual({ condition: expected });
	});

	it("projects an active durable run as collecting with only bounded numeric progress", () => {
		const projection = projectProviderObservationUi(
			{
				availability: "unavailable",
				evidence: "unknown",
				observedAt: null,
				ageSeconds: null,
				latestAttempt: "running",
				reasonCodes: ["no-publication", "refresh-running"],
			},
			{
				state: "running",
				completedUnits: 7,
				totalUnits: 13,
				completedWork: 7,
				totalWork: 13,
			},
		);

		expect(projection).toEqual({
			condition: "collecting",
			progress: {
				completedUnits: 7,
				totalUnits: 13,
				completedWork: 7,
				totalWork: 13,
			},
		});
		expect(JSON.stringify(projection)).not.toMatch(
			/run-|scope|provider-|title|label|user|https?:|error/i,
		);
	});

	it.each([
		["negative", { completedUnits: -1, totalUnits: 13, completedWork: 0, totalWork: 13 }],
		["fractional", { completedUnits: 1.5, totalUnits: 13, completedWork: 0, totalWork: 13 }],
		[
			"unsafe",
			{
				completedUnits: Number.MAX_SAFE_INTEGER + 1,
				totalUnits: Number.MAX_SAFE_INTEGER + 1,
				completedWork: 0,
				totalWork: 13,
			},
		],
		["exceeds total", { completedUnits: 14, totalUnits: 13, completedWork: 0, totalWork: 13 }],
		["missing denominator", { completedUnits: 7, totalUnits: 13, completedWork: 7 }],
	] as const)("omits %s progress", (_name, progress) => {
		const projection = projectProviderObservationUi(
			{
				availability: "unavailable",
				evidence: "unknown",
				observedAt: null,
				ageSeconds: null,
				latestAttempt: "running",
				reasonCodes: ["no-publication", "refresh-running"],
			},
			{ state: "running", ...progress },
		);
		expect(projection).toEqual({ condition: "collecting" });
	});
});

describe("Plex cache refresh attempt lifecycle", () => {
	it("claims a Tautulli attempt with a bounded non-secret initial reason", async () => {
		const current = plexSnapshot({
			id: "tautulli-1",
			service: "TAUTULLI",
			expectedIdentity: "tautulli-pms-a",
		});
		const state = publicationFixture(current, null);

		const attempt = await beginPlexCacheRefreshAttempt(
			state.prisma as never,
			"tautulli" as never,
			current,
		);

		expect(attempt?.resultMarker).toMatch(/^in_progress:/);
		expect(state.tx.cacheRefreshStatus.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					cacheType: "tautulli",
					lastErrorMessage: "refresh_in_progress",
					lastAttemptResult: attempt?.resultMarker,
				}),
			}),
		);
	});

	it("creates an unpublished current-generation in-progress status when none exists", async () => {
		const current = plexSnapshot();
		const state = publicationFixture(current, null);

		const attempt = await beginPlexCacheRefreshAttempt(state.prisma as never, "plex", current);

		expect(attempt?.resultMarker).toMatch(/^in_progress:/);
		expect(state.tx.cacheRefreshStatus.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastResult: "error",
					lastErrorMessage: "provider cache refresh has not published a generation",
					connectionGeneration: current.connectionGeneration,
					identityGeneration: current.identityGeneration,
					lastAttemptResult: attempt?.resultMarker,
				}),
			}),
		);
	});

	it.each([
		["plex", "crossed future status", { connectionGeneration: 3, identityGeneration: 10 }, {}],
		[
			"plex_episode",
			"crossed future status",
			{ connectionGeneration: 3, identityGeneration: 10 },
			{},
		],
		[
			"plex",
			"fractional status connection",
			{ connectionGeneration: 3.5, identityGeneration: 9 },
			{},
		],
		[
			"plex_episode",
			"fractional status connection",
			{ connectionGeneration: 3.5, identityGeneration: 9 },
			{},
		],
		[
			"plex",
			"fractional status identity",
			{ connectionGeneration: 4, identityGeneration: 8.5 },
			{},
		],
		[
			"plex_episode",
			"fractional status identity",
			{ connectionGeneration: 4, identityGeneration: 8.5 },
			{},
		],
		[
			"plex",
			"fractional authority connection",
			{ connectionGeneration: 4, identityGeneration: 9 },
			{ connectionGeneration: 4.5 },
		],
		[
			"plex_episode",
			"fractional authority connection",
			{ connectionGeneration: 4, identityGeneration: 9 },
			{ connectionGeneration: 4.5 },
		],
		[
			"plex",
			"fractional authority identity",
			{ connectionGeneration: 4, identityGeneration: 9 },
			{ identityGeneration: 9.5 },
		],
		[
			"plex_episode",
			"fractional authority identity",
			{ connectionGeneration: 4, identityGeneration: 9 },
			{ identityGeneration: 9.5 },
		],
	] as const)("does not modify or own %s %s", async (cacheType, _name, status, authority) => {
		const current = plexSnapshot(authority);
		const state = publicationFixture(current, {
			id: "future-status",
			...status,
			lastAttemptAt: new Date("2026-08-20T11:00:00.000Z"),
			lastAttemptResult: "success",
		});

		await expect(
			beginPlexCacheRefreshAttempt(state.prisma as never, cacheType, current),
		).resolves.toBeNull();

		expect(state.tx.cacheRefreshStatus.updateMany).not.toHaveBeenCalled();
		expect(state.tx.cacheRefreshStatus.create).not.toHaveBeenCalled();
	});

	it.each([
		["plex", "null/null", null, null],
		["plex_episode", "null/null", null, null],
		["plex", "current/null", 4, null],
		["plex_episode", "current/null", 4, null],
		["plex", "null/current", null, 9],
		["plex_episode", "null/current", null, 9],
		["plex", "older connection", 3, 9],
		["plex_episode", "older connection", 3, 9],
		["plex", "older identity", 4, 8],
		["plex_episode", "older identity", 4, 8],
		["plex", "both older", 3, 8],
		["plex_episode", "both older", 3, 8],
	] as const)(
		"takes over retained %s %s provenance through its exact CAS",
		async (cacheType, _shape, connectionGeneration, identityGeneration) => {
			const current = plexSnapshot();
			const retainedAttemptAt = new Date("2026-08-20T11:00:00.000Z");
			const state = publicationFixture(current, {
				id: `${cacheType}-status`,
				connectionGeneration,
				identityGeneration,
				lastAttemptAt: retainedAttemptAt,
				lastAttemptResult: "success",
			});

			const attempt = await beginPlexCacheRefreshAttempt(state.prisma as never, cacheType, current);

			expect(attempt?.resultMarker).toMatch(/^in_progress:/);
			expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
			expect(state.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledWith({
				where: {
					id: `${cacheType}-status`,
					instanceId: current.id,
					cacheType,
					connectionGeneration,
					identityGeneration,
					lastAttemptAt: retainedAttemptAt,
					lastAttemptResult: "success",
				},
				data: expect.objectContaining({
					lastRefreshedAt: attempt?.attemptedAt,
					lastResult: "error",
					lastErrorMessage: "provider cache refresh has not published a generation",
					itemCount: 0,
					generationId: null,
					generationMetadata: null,
					lastAttemptAt: attempt?.attemptedAt,
					lastAttemptResult: attempt?.resultMarker,
					lastAttemptErrorMessage: null,
					connectionGeneration: current.connectionGeneration,
					identityGeneration: current.identityGeneration,
				}),
			});
		},
	);

	it("reclaims an invalid current in-progress marker", async () => {
		const current = plexSnapshot();
		const state = publicationFixture(current, {
			connectionGeneration: current.connectionGeneration,
			identityGeneration: current.identityGeneration,
			lastAttemptAt: new Date("2026-08-20T11:00:00.000Z"),
			lastAttemptResult: "in_progress:older",
		});

		await expect(
			beginPlexCacheRefreshAttempt(state.prisma as never, "plex", current),
		).resolves.toMatchObject({ resultMarker: expect.stringMatching(/^in_progress:/) });
		expect(state.tx.cacheRefreshStatus.create).not.toHaveBeenCalled();
	});

	it("returns an exact already-running claim without overwriting it", async () => {
		const current = plexSnapshot();
		const attemptedAt = new Date("2026-08-20T11:00:00.000Z");
		const resultMarker = "in_progress:00000000-0000-4000-8000-000000000001";
		const state = publicationFixture(current, {
			connectionGeneration: current.connectionGeneration,
			identityGeneration: current.identityGeneration,
			lastAttemptAt: attemptedAt,
			lastAttemptResult: resultMarker,
		});

		await expect(
			claimProviderCacheRefreshAttempt(state.prisma as never, "plex", current),
		).resolves.toEqual({
			status: "already-running",
			attempt: { attemptedAt, resultMarker },
		});
		expect(state.tx.cacheRefreshStatus.updateMany).not.toHaveBeenCalled();
		expect(state.tx.cacheRefreshStatus.create).not.toHaveBeenCalled();
	});

	it("claims a current terminal row with a compare-and-set predicate", async () => {
		const current = plexSnapshot();
		const attemptedAt = new Date("2026-08-20T11:00:00.000Z");
		const state = publicationFixture(current, {
			id: "current-status",
			connectionGeneration: current.connectionGeneration,
			identityGeneration: current.identityGeneration,
			lastAttemptAt: attemptedAt,
			lastAttemptResult: "success",
		});

		const result = await claimProviderCacheRefreshAttempt(state.prisma as never, "plex", current);

		expect(result.status).toBe("acquired");
		if (result.status === "acquired") expect(result.attempt.resultMarker).toMatch(/^in_progress:/);
		expect(state.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledWith({
			where: {
				id: "current-status",
				instanceId: current.id,
				cacheType: "plex",
				connectionGeneration: current.connectionGeneration,
				identityGeneration: current.identityGeneration,
				lastAttemptAt: attemptedAt,
				lastAttemptResult: "success",
			},
			data: expect.objectContaining({
				lastAttemptResult: expect.stringMatching(/^in_progress:/),
			}),
		});
	});

	it("supersedes a terminal claim when any observed publication scalar changed", async () => {
		const current = plexSnapshot();
		const status = {
			id: "current-status",
			connectionGeneration: current.connectionGeneration,
			identityGeneration: current.identityGeneration,
			lastRefreshedAt: new Date("2026-08-20T10:00:00.000Z"),
			lastResult: "success",
			lastErrorMessage: null,
			itemCount: 4,
			generationId: "published-generation",
			generationMetadata: "published-metadata",
			lastAttemptAt: new Date("2026-08-20T11:00:00.000Z"),
			lastAttemptResult: "success",
			lastAttemptErrorMessage: null,
		};
		const state = publicationFixture(current, status);
		state.tx.cacheRefreshStatus.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			claimProviderCacheRefreshAttempt(state.prisma as never, "plex", current),
		).resolves.toEqual({
			status: "superseded",
		});
		expect(state.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({
				lastRefreshedAt: status.lastRefreshedAt,
				lastResult: status.lastResult,
				lastErrorMessage: status.lastErrorMessage,
				itemCount: status.itemCount,
				generationId: status.generationId,
				generationMetadata: status.generationMetadata,
				lastAttemptErrorMessage: status.lastAttemptErrorMessage,
			}),
			data: expect.any(Object),
		});
	});

	it("reclaims a current malformed in-progress marker without replacing publication fields", async () => {
		const current = plexSnapshot();
		const state = publicationFixture(current, {
			connectionGeneration: current.connectionGeneration,
			identityGeneration: current.identityGeneration,
			lastAttemptAt: new Date("2026-08-20T11:00:00.000Z"),
			lastAttemptResult: "in_progress:unknown",
		});

		const claim = await claimProviderCacheRefreshAttempt(state.prisma as never, "plex", current);

		expect(claim).toMatchObject({
			status: "acquired",
			attempt: { resultMarker: expect.stringMatching(/^in_progress:/) },
		});
		expect(state.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastAttemptResult: expect.stringMatching(/^in_progress:/),
					lastAttemptErrorMessage: null,
				}),
			}),
		);
		expect(state.tx.cacheRefreshStatus.create).not.toHaveBeenCalled();
	});

	it("rejects two CAS-losing obsolete takeover retries without weakening the fence", async () => {
		const current = plexSnapshot();
		const status = {
			id: "retained-status",
			connectionGeneration: 3,
			identityGeneration: 8,
			lastAttemptAt: new Date("2026-08-20T11:00:00.000Z"),
			lastAttemptResult: "success",
		};
		const state = publicationFixture(current, status);
		state.tx.cacheRefreshStatus.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			beginPlexCacheRefreshAttempt(state.prisma as never, "plex", current),
		).resolves.toBeNull();
		await expect(
			beginPlexCacheRefreshAttempt(state.prisma as never, "plex", current),
		).resolves.toBeNull();

		expect(state.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledTimes(2);
		expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("rejects a valid marker whose claim time is in the future", async () => {
		const current = plexSnapshot();
		const state = publicationFixture(current, {
			connectionGeneration: current.connectionGeneration,
			identityGeneration: current.identityGeneration,
			lastAttemptAt: new Date("2026-08-20T12:00:00.000Z"),
			lastAttemptResult: "in_progress:00000000-0000-4000-8000-000000000001",
		});

		await expect(
			claimProviderCacheRefreshAttempt(state.prisma as never, "plex", current, {
				now: () => new Date("2026-08-20T11:00:00.000Z"),
			}),
		).resolves.toEqual({ status: "superseded" });
		expect(state.tx.cacheRefreshStatus.updateMany).not.toHaveBeenCalled();
	});

	it("rejects a terminal row whose attempt time is in the future", async () => {
		const current = plexSnapshot();
		const state = publicationFixture(current, {
			id: "future-terminal",
			connectionGeneration: current.connectionGeneration,
			identityGeneration: current.identityGeneration,
			lastAttemptAt: new Date("2026-08-20T12:00:00.000Z"),
			lastAttemptResult: "success",
		});

		await expect(
			claimProviderCacheRefreshAttempt(state.prisma as never, "plex", current, {
				now: () => new Date("2026-08-20T11:00:00.000Z"),
			}),
		).resolves.toEqual({ status: "superseded" });
		expect(state.tx.cacheRefreshStatus.updateMany).not.toHaveBeenCalled();
	});

	it.each(["plex", "plex_episode"] as const)(
		"marks %s in progress without replacing prior publication fields",
		async (cacheType) => {
			const current = plexSnapshot();
			const state = publicationFixture(current, {
				connectionGeneration: 4,
				identityGeneration: 9,
			});

			const attempt = await beginPlexCacheRefreshAttempt(state.prisma as never, cacheType, current);

			expect(attempt?.resultMarker).toMatch(/^in_progress:/);
			expect(state.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						lastAttemptAt: attempt?.attemptedAt,
						lastAttemptResult: attempt?.resultMarker,
						lastAttemptErrorMessage: null,
					}),
				}),
			);
			expect(state.tx.cacheRefreshStatus.updateMany.mock.calls[0]![0].data).not.toEqual(
				expect.objectContaining({
					lastRefreshedAt: expect.anything(),
					lastResult: expect.anything(),
					itemCount: expect.anything(),
					generationId: expect.anything(),
				}),
			);
		},
	);

	it("finishes only the exact still-current attempt token", async () => {
		const current = plexSnapshot();
		const state = publicationFixture(current, {
			connectionGeneration: 4,
			identityGeneration: 9,
		});
		const attempt = {
			attemptedAt: new Date("2026-08-20T12:00:00.000Z"),
			resultMarker: "in_progress:attempt-a",
		};

		const result = await finishPlexCacheRefreshAttemptFailure(
			state.prisma as never,
			"plex",
			"upstream failed",
			current,
			attempt,
			log,
		);

		expect(result).toBe("recorded");
		expect(state.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({
				lastAttemptAt: attempt.attemptedAt,
				lastAttemptResult: attempt.resultMarker,
			}),
			data: {
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "upstream failed",
			},
		});
	});

	it("does not finish an attempt when its transactional precondition is false", async () => {
		const current = plexSnapshot();
		const state = publicationFixture(current, {
			connectionGeneration: 4,
			identityGeneration: 9,
		});
		const precondition = vi.fn().mockResolvedValue(false);

		const result = await finishProviderCacheRefreshAttemptFailure(
			state.prisma as never,
			"plex_episode",
			"provider-unavailable",
			current,
			{
				attemptedAt: new Date("2026-08-20T12:00:00.000Z"),
				resultMarker: "in_progress:attempt-a",
			},
			log,
			{},
			precondition,
		);

		expect(result).toBe("superseded");
		expect(precondition).toHaveBeenCalledWith(state.tx);
		expect(state.tx.cacheRefreshStatus.updateMany).not.toHaveBeenCalled();
	});

	it("redacts non-allowlisted Tautulli failure text before persistence", async () => {
		const current = plexSnapshot({ id: "tautulli-1", service: "TAUTULLI" });
		const state = publicationFixture(current, {
			connectionGeneration: 4,
			identityGeneration: 9,
		});
		const attempt = {
			attemptedAt: new Date("2026-08-20T12:00:00.000Z"),
			resultMarker: "in_progress:tautulli-a",
		};

		await finishProviderCacheRefreshAttemptFailure(
			state.prisma as never,
			"tautulli",
			"https://tautulli.invalid?apikey=secret ratingKey=42",
			current,
			attempt,
			log,
		);

		expect(state.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { lastAttemptResult: "error", lastAttemptErrorMessage: "legacy_error_redacted" },
			}),
		);
	});

	it("preserves every shared bounded Tautulli observation reason code", async () => {
		const current = plexSnapshot({ id: "tautulli-1", service: "TAUTULLI" });
		const reasonCodes = [
			"publication-superseded",
			"receipt-invalid",
			"coverage-incomplete",
			"accepted-skips",
			"provider-limit",
			"provider-unavailable",
			"rows-inconsistent",
			"positive-only",
			"unknown-failure",
		] as const;

		for (const reasonCode of reasonCodes) {
			const state = publicationFixture(current, {
				connectionGeneration: 4,
				identityGeneration: 9,
			});
			await finishProviderCacheRefreshAttemptFailure(
				state.prisma as never,
				"tautulli",
				reasonCode,
				current,
				{
					attemptedAt: new Date("2026-08-20T12:00:00.000Z"),
					resultMarker: "in_progress:tautulli-a",
				},
				log,
			);
			expect(state.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					data: { lastAttemptResult: "error", lastAttemptErrorMessage: reasonCode },
				}),
			);
		}
	});

	it("cannot overwrite a newer attempt marker with an older failure", async () => {
		const current = plexSnapshot();
		const state = publicationFixture(current, {
			connectionGeneration: 4,
			identityGeneration: 9,
		});
		state.tx.cacheRefreshStatus.updateMany.mockResolvedValue({ count: 0 });

		const result = await finishPlexCacheRefreshAttemptFailure(
			state.prisma as never,
			"plex",
			"older attempt failed",
			current,
			{
				attemptedAt: new Date("2026-08-20T12:00:00.000Z"),
				resultMarker: "in_progress:attempt-a",
			},
			log,
		);

		expect(result).toBe("superseded");
	});
});

describe("recordPlexCacheRefreshFailure", () => {
	it.each(["plex", "plex_episode"] as const)(
		"does not create a %s failure after an identity-only replacement",
		async (cacheType) => {
			const attempt = plexSnapshot();
			const state = publicationFixture(plexSnapshot({ identityGeneration: 10 }), null);

			const result = await recordPlexCacheRefreshFailure(
				state.prisma as never,
				cacheType,
				"outgoing identity failed",
				attempt,
				log,
			);

			expect(result).toBe("superseded");
			expect(state.tx.cacheRefreshStatus.create).not.toHaveBeenCalled();
		},
	);

	it.each(["plex", "plex_episode"] as const)(
		"does not degrade a newer %s success after an identity-only replacement",
		async (cacheType) => {
			const attempt = plexSnapshot();
			const newerStatus = { connectionGeneration: 4, identityGeneration: 10 };
			const state = publicationFixture(plexSnapshot({ identityGeneration: 10 }), newerStatus);

			const result = await recordPlexCacheRefreshFailure(
				state.prisma as never,
				cacheType,
				"outgoing identity failed",
				attempt,
				log,
			);

			expect(result).toBe("superseded");
			expect(state.tx.cacheRefreshStatus.create).not.toHaveBeenCalled();
		},
	);

	it.each(["plex", "plex_episode"] as const)(
		"creates a %s failure with both publication generations",
		async (cacheType) => {
			const attempt = plexSnapshot();
			const state = publicationFixture(attempt, null);

			const result = await recordPlexCacheRefreshFailure(
				state.prisma as never,
				cacheType,
				"current identity failed",
				attempt,
				log,
			);

			expect(result).toBe("recorded");
			expect(state.tx.cacheRefreshStatus.upsert).toHaveBeenCalledWith(
				expect.objectContaining({
					create: expect.objectContaining({
						connectionGeneration: 4,
						identityGeneration: 9,
					}),
				}),
			);
		},
	);

	it("does not update an existing status from another generation", async () => {
		const attempt = plexSnapshot();
		const state = publicationFixture(attempt, {
			connectionGeneration: 4,
			identityGeneration: 10,
		});

		const result = await recordPlexCacheRefreshFailure(
			state.prisma as never,
			"plex",
			"stale attempt failed",
			attempt,
			log,
		);

		expect(result).toBe("superseded");
		expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});
});

describe("provider cache startup recovery", () => {
	it("marks inherited valid claims as bounded errors without changing publication fields", async () => {
		const attemptedAt = new Date("2026-08-20T11:00:00.000Z");
		const status = {
			id: "tautulli-status",
			instanceId: "tautulli-1",
			cacheType: "tautulli",
			lastRefreshedAt: new Date("2026-08-20T10:00:00.000Z"),
			lastResult: "success",
			lastErrorMessage: null,
			itemCount: 3,
			generationId: "published-generation",
			generationMetadata: "published-metadata",
			lastAttemptAt: attemptedAt,
			lastAttemptResult: "in_progress:00000000-0000-4000-8000-000000000001",
			lastAttemptErrorMessage: null,
			connectionGeneration: 4,
			identityGeneration: 9,
			instance: { service: "TAUTULLI" },
		};
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const prisma = {
			$transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
				callback({
					cacheRefreshStatus: {
						findMany: vi.fn().mockResolvedValue([status]),
						updateMany,
					},
					providerObservationRun: {
						findMany: vi.fn().mockResolvedValue([]),
					},
				}),
			),
		};

		await expect(reconcileInterruptedProviderCacheRefreshAttempts(prisma as never)).resolves.toBe(
			1,
		);
		expect(updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: status.id,
				instanceId: status.instanceId,
				cacheType: status.cacheType,
				lastAttemptAt: status.lastAttemptAt,
				lastAttemptResult: status.lastAttemptResult,
				connectionGeneration: status.connectionGeneration,
				identityGeneration: status.identityGeneration,
			}),
			data: {
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "unknown_failure",
			},
		});
	});
});

describe("recordWatchProviderCacheRefreshFailure", () => {
	it("sanitizes an attempt-status write failure log", async () => {
		const privateInstance = plexSnapshot({ id: "PRIVATE_INSTANCE_ID" });
		const privateError = "PRIVATE_DATABASE_ERROR token=PRIVATE_CREDENTIAL";
		const state = {
			$transaction: vi.fn().mockRejectedValue(new Error(privateError)),
		};
		const result = await finishProviderCacheRefreshAttemptFailure(
			state as never,
			"tautulli",
			"provider-unavailable",
			{ ...privateInstance, service: "TAUTULLI" },
			{
				attemptedAt: new Date("2026-08-20T12:00:00.000Z"),
				resultMarker: "in_progress:tautulli-a",
			},
			log,
		);

		expect(result).toBe("failed");
		expect(log.warn).toHaveBeenCalledWith(
			{ cacheType: "tautulli", reasonCode: "attempt_status_write_failed" },
			expect.any(String),
		);
		expect(JSON.stringify(log.warn.mock.calls)).not.toContain("PRIVATE_INSTANCE_ID");
		expect(JSON.stringify(log.warn.mock.calls)).not.toContain(privateError);
	});

	it("sanitizes a failure-status write failure log", async () => {
		const privateInstance = plexSnapshot({ id: "PRIVATE_INSTANCE_ID" });
		const privateError = "PRIVATE_DATABASE_ERROR token=PRIVATE_CREDENTIAL";
		const state = {
			$transaction: vi.fn().mockRejectedValue(new Error(privateError)),
		};
		const result = await recordWatchProviderCacheRefreshFailure(
			state as never,
			"tautulli",
			"provider-unavailable",
			{ ...privateInstance, service: "TAUTULLI" },
			log,
		);

		expect(result).toBe("failed");
		expect(log.warn).toHaveBeenCalledWith(
			{ cacheType: "tautulli", reasonCode: "failure_status_write_failed" },
			expect.any(String),
		);
		expect(JSON.stringify(log.warn.mock.calls)).not.toContain("PRIVATE_INSTANCE_ID");
		expect(JSON.stringify(log.warn.mock.calls)).not.toContain(privateError);
	});

	it.each([
		["JELLYFIN", "jellyfin"],
		["EMBY", "jellyfin_episode"],
		["TAUTULLI", "tautulli"],
	] as const)("fences %s %s failure status by identity generation", async (service, cacheType) => {
		const attempt = plexSnapshot({ id: `${service}-1`, service, identityGeneration: 4 });
		const current = plexSnapshot({ id: `${service}-1`, service, identityGeneration: 5 });
		const state = publicationFixture(current, {
			connectionGeneration: attempt.connectionGeneration,
			identityGeneration: current.identityGeneration,
		});

		const result = await recordWatchProviderCacheRefreshFailure(
			state.prisma as never,
			cacheType,
			"outgoing attempt failed",
			attempt,
			log,
		);

		expect(result).toBe("superseded");
		expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it.each([
		["JELLYFIN", "jellyfin"],
		["EMBY", "jellyfin_episode"],
		["TAUTULLI", "tautulli"],
	] as const)("creates %s %s failure status with both generations", async (service, cacheType) => {
		const attempt = plexSnapshot({ id: `${service}-1`, service });
		const state = publicationFixture(attempt, null);

		const result = await recordWatchProviderCacheRefreshFailure(
			state.prisma as never,
			cacheType,
			"current attempt failed",
			attempt,
			log,
		);

		expect(result).toBe("recorded");
		expect(state.tx.cacheRefreshStatus.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					connectionGeneration: 4,
					identityGeneration: 9,
				}),
			}),
		);
	});

	it("records a current failed attempt without replacing prior success fields", async () => {
		const attempt = plexSnapshot({ id: "JELLYFIN-1", service: "JELLYFIN" });
		const state = publicationFixture(attempt, {
			connectionGeneration: attempt.connectionGeneration,
			identityGeneration: attempt.identityGeneration,
		});

		const result = await recordWatchProviderCacheRefreshFailure(
			state.prisma as never,
			"jellyfin",
			"credential decrypt failed",
			attempt,
			log,
		);

		expect(result).toBe("recorded");
		expect(state.tx.cacheRefreshStatus.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				update: expect.not.objectContaining({
					lastRefreshedAt: expect.anything(),
					lastResult: expect.anything(),
					lastErrorMessage: expect.anything(),
					itemCount: expect.anything(),
				}),
			}),
		);
	});
});
