import { afterEach, describe, expect, it, vi } from "vitest";
import {
	beginPlexCacheRefreshAttempt,
	beginTautulliCacheRefreshAttempt,
	classifyProviderCacheStatusGeneration,
	finishPlexCacheRefreshAttemptFailure,
	finishTautulliCacheRefreshAttemptFailure,
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

describe("Plex cache refresh attempt lifecycle", () => {
	it("creates an unpublished current-generation in-progress status when none exists", async () => {
		const current = plexSnapshot();
		const state = publicationFixture(current, null);

		const attempt = await beginPlexCacheRefreshAttempt(state.prisma as never, "plex", current);

		expect(attempt?.resultMarker).toMatch(/^in_progress:/);
		expect(state.tx.cacheRefreshStatus.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					lastResult: "error",
					lastErrorMessage: "Plex cache refresh has not published a generation",
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
		expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
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
					lastErrorMessage: "Plex cache refresh has not published a generation",
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

	it("supersedes a current in-progress attempt with a later current attempt", async () => {
		const current = plexSnapshot();
		const state = publicationFixture(current, {
			connectionGeneration: current.connectionGeneration,
			identityGeneration: current.identityGeneration,
			lastAttemptAt: new Date("2026-08-20T11:00:00.000Z"),
			lastAttemptResult: "in_progress:older",
		});

		const older = await beginPlexCacheRefreshAttempt(state.prisma as never, "plex", current);
		const later = await beginPlexCacheRefreshAttempt(state.prisma as never, "plex", current);

		expect(older?.resultMarker).toMatch(/^in_progress:/);
		expect(later?.resultMarker).toMatch(/^in_progress:/);
		expect(later?.resultMarker).not.toBe(older?.resultMarker);
		expect(state.tx.cacheRefreshStatus.upsert).toHaveBeenCalledTimes(2);
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
			expect(state.tx.cacheRefreshStatus.upsert).toHaveBeenCalledWith(
				expect.objectContaining({
					update: expect.objectContaining({
						lastAttemptAt: attempt?.attemptedAt,
						lastAttemptResult: attempt?.resultMarker,
						lastAttemptErrorMessage: null,
					}),
				}),
			);
			expect(state.tx.cacheRefreshStatus.upsert.mock.calls[0]![0].update).not.toEqual(
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

describe("Tautulli cache refresh attempt lifecycle", () => {
	it("uses the provider-neutral CAS while persisting only a bounded Tautulli reason", async () => {
		const current = plexSnapshot({ id: "tautulli-1", service: "TAUTULLI", label: "Tautulli" });
		const state = publicationFixture(current, null);

		const attempt = await beginTautulliCacheRefreshAttempt(state.prisma as never, current);

		expect(attempt?.resultMarker).toMatch(/^in_progress:/);
		expect(state.tx.cacheRefreshStatus.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					cacheType: "tautulli",
					lastErrorMessage: "unknown_failure",
				}),
			}),
		);

		await finishTautulliCacheRefreshAttemptFailure(
			state.prisma as never,
			"catalog_changed",
			current,
			attempt!,
			log,
		);
		expect(state.tx.cacheRefreshStatus.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					cacheType: "tautulli",
					lastAttemptResult: attempt?.resultMarker,
				}),
				data: { lastAttemptResult: "error", lastAttemptErrorMessage: "catalog_changed" },
			}),
		);
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
			expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
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
			expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
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

describe("recordWatchProviderCacheRefreshFailure", () => {
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
