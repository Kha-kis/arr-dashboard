import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	nativeRefresh: vi.fn(),
	beginAttempt: vi.fn(),
	finishAttempt: vi.fn(),
	createSnapshot: vi.fn(),
	refreshCacheWithAttempt: vi.fn(),
	refreshEpisodesWithAttempt: vi.fn(),
	claimAttempt: vi.fn(),
	createRun: vi.fn(),
	claimUnit: vi.fn(),
	failUnit: vi.fn(),
	hasExhaustedRetries: vi.fn(),
	stage: vi.fn(),
	finalize: vi.fn(),
	collect: vi.fn(),
	readParents: vi.fn(),
	readUnit: vi.fn(),
	guardPublication: vi.fn(),
}));

vi.mock("../provider-observation/native-inventory-refresh.js", () => ({
	refreshNativeInventory: mocks.nativeRefresh,
}));

vi.mock("../services/provider-cache-status.js", () => ({
	beginPlexCacheRefreshAttempt: mocks.beginAttempt,
	claimProviderCacheRefreshAttempt: mocks.claimAttempt,
	finishPlexCacheRefreshAttemptFailure: mocks.finishAttempt,
}));

vi.mock("../services/provider-identity-guard.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../services/provider-identity-guard.js")>()),
	withGuardedProviderPublication: mocks.guardPublication,
}));

vi.mock("../provider-observation/observation-run-repository.js", () => ({
	createOrLoadObservationRun: mocks.createRun,
	claimObservationUnit: mocks.claimUnit,
	failObservationUnit: mocks.failUnit,
	hasExhaustedObservationRunRetries: mocks.hasExhaustedRetries,
}));
vi.mock("./plex-authority-service.js", () => ({
	PlexAuthorityService: class {
		readPositiveEpisodeParents = mocks.readParents;
	},
}));
vi.mock("./plex-episode-live-collector.js", () => ({ collectPlexEpisodeUnit: mocks.collect }));
vi.mock("./plex-episode-refresh-repository.js", () => ({
	stagePlexEpisodeUnitInTransaction: mocks.stage,
	finalizePlexEpisodeRun: mocks.finalize,
}));
vi.mock("./plex-client.js", () => ({ PlexClient: class {} }));

vi.mock("./plex-cache-refresher.js", () => ({
	createOwnedPlexPublicationSnapshot: mocks.createSnapshot,
	refreshPlexCacheWithAttempt: mocks.refreshCacheWithAttempt,
}));

vi.mock("./plex-episode-cache-refresher.js", () => ({
	refreshPlexEpisodeCacheWithAttempt: mocks.refreshEpisodesWithAttempt,
}));

import { buildObservationAuthorityKey } from "../provider-observation/observation-run-types.js";
import { ProviderIdentityGuardError } from "../services/provider-identity-guard.js";
import { digestPlexEpisodeUnit } from "./plex-episode-refresh-plan.js";
import {
	createPlexEpisodeWorkItemRunner,
	refreshOwnedPlexCache,
	refreshOwnedPlexCacheWithAttempt,
	refreshOwnedPlexEpisodeCache,
	refreshOwnedPlexEpisodeCacheWithAttempt,
	runNextPlexEpisodeWorkItem,
} from "./plex-refresh-orchestration.js";

const log = { warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
const instance = {
	id: "plex-1",
	userId: "user-1",
	service: "PLEX",
	label: "Primary Plex",
	baseUrl: "https://plex.invalid?token=url-secret",
	enabled: true,
	encryptedApiKey: "ciphertext-secret",
	encryptionIv: "iv-secret",
	encryptedHttpAuthCredentials: "basic-ciphertext",
	httpAuthEncryptionIv: "basic-iv",
	expectedIdentity: "raw-provider-identity",
	identityStatus: "VERIFIED",
	connectionGeneration: 7,
	identityGeneration: 11,
} as const;
const authority = {
	id: instance.id,
	userId: instance.userId,
	service: instance.service,
	baseUrl: instance.baseUrl,
	enabled: instance.enabled,
	encryptedApiKey: instance.encryptedApiKey,
	encryptionIv: instance.encryptionIv,
	encryptedHttpAuthCredentials: instance.encryptedHttpAuthCredentials,
	httpAuthEncryptionIv: instance.httpAuthEncryptionIv,
	expectedIdentity: instance.expectedIdentity,
	identityStatus: instance.identityStatus,
	connectionGeneration: instance.connectionGeneration,
	identityGeneration: instance.identityGeneration,
};
const expectedScopeDigest = digestPlexEpisodeUnit(0, [
	{
		instanceId: "plex-1",
		generationId: "parent",
		showTmdbId: 1,
		sectionId: "shows",
		sectionUuid: "uuid",
		mediaType: "series",
		tvdbId: 1,
		ratingKey: "show",
	},
]);
const snapshot = {
	...authority,
	apiKey: "api-key-secret",
	httpAuthHeaders: { authorization: "Basic username:password" },
};
const attempt = {
	attemptedAt: new Date("2026-08-20T12:00:00.000Z"),
	resultMarker: "in_progress:attempt-a",
};
const context = {
	prisma: {} as never,
	encryptor: {} as never,
	instance: instance as never,
	log,
};
let latestRunTargetDigest = "d".repeat(64);
let latestRunAuthorityKey = "uninitialized";

beforeEach(() => {
	mocks.nativeRefresh.mockReset().mockResolvedValue({ status: "published" });
	mocks.beginAttempt.mockReset().mockResolvedValue(attempt);
	mocks.finishAttempt.mockReset().mockResolvedValue("recorded");
	mocks.createSnapshot.mockReset().mockReturnValue(snapshot);
	mocks.refreshCacheWithAttempt.mockReset().mockResolvedValue({
		complete: true,
		completedAt: new Date("2026-08-20T12:01:00.000Z"),
		upserted: 1,
		errors: 0,
		errorMessages: [],
	});
	mocks.refreshEpisodesWithAttempt.mockReset().mockResolvedValue({
		complete: true,
		completedAt: new Date("2026-08-20T12:01:00.000Z"),
		upserted: 1,
		errors: 0,
		errorMessages: [],
		eligibleShows: 1,
		refreshedShows: 1,
		coverageIncomplete: false,
		capacityDegraded: false,
	});
	mocks.claimAttempt.mockReset().mockResolvedValue({ status: "acquired", attempt });
	latestRunTargetDigest = "d".repeat(64);
	mocks.readParents.mockReset().mockResolvedValue({
		available: true,
		generationId: "parent",
		connectionGeneration: 7,
		identityGeneration: 11,
		targets: [
			{
				instanceId: "plex-1",
				generationId: "parent",
				tmdbId: 1,
				sectionId: "shows",
				sectionUuid: "uuid",
				mediaType: "series",
				tvdbId: 1,
				ratingKey: "show",
			},
		],
	});
	mocks.readUnit.mockReset().mockImplementation(async () => ({
		id: "unit",
		runId: "run",
		state: "running",
		claimToken: "claim",
		phase: "collect",
		ordinal: 0,
		scopeKey: "plex-episode-unit:0",
		scopeDigest: expectedScopeDigest,
		expectedTargets: 1,
		run: {
			id: "run",
			instanceId: "plex-1",
			provider: "plex_episode",
			cacheType: "plex_episode",
			state: "running",
			activeSlotKey: "slot",
			authorityKey: latestRunAuthorityKey,
			targetDigest: latestRunTargetDigest,
			parentGenerationId: "parent",
			connectionGeneration: 7,
			identityGeneration: 11,
		},
	}));
	mocks.createRun.mockReset().mockImplementation(async (_prisma, input) => {
		latestRunTargetDigest = input.authority.targetDigest;
		latestRunAuthorityKey = buildObservationAuthorityKey(input.authority);
		return {
			id: "run",
			instanceId: "plex-1",
			provider: "plex_episode",
			cacheType: "plex_episode",
			parentGenerationId: "parent",
			targetDigest: input.authority.targetDigest,
			authorityKey: latestRunAuthorityKey,
			connectionGeneration: 7,
			identityGeneration: 11,
		};
	});
	mocks.claimUnit.mockReset().mockImplementation(async () => ({
		runId: "run",
		unitId: "unit",
		claimToken: "claim",
		authorityKey: latestRunAuthorityKey,
		scopeKey: "plex-episode-unit:0",
		scopePayload: JSON.stringify({ ordinal: 0 }),
		phase: "collect",
	}));
	mocks.failUnit.mockReset().mockResolvedValue(true);
	mocks.hasExhaustedRetries.mockReset().mockResolvedValue(false);
	mocks.stage.mockReset().mockResolvedValue(true);
	mocks.guardPublication
		.mockReset()
		.mockImplementation(
			async (_prisma, _snapshot, _log, collect, publish) =>
				await publish({ transaction: true }, await collect()),
		);
	mocks.finalize.mockReset().mockResolvedValue({
		published: false,
		itemCount: 0,
		outcome: "incomplete",
	});
	mocks.collect.mockReset().mockResolvedValue({ complete: true, refreshedTargets: 1, rows: [] });
});

describe("Plex refresh preparation authority", () => {
	it.each([["Plex", "plex", refreshOwnedPlexCache]] as const)(
		"revokes %s authority before a credential-preparation failure and records only safe diagnostics",
		async (_label, cacheType, refresh) => {
			mocks.createSnapshot.mockImplementation(() => {
				throw new Error(
					"api-key-secret ciphertext-secret iv-secret Basic username:password https://plex.invalid?token=url-secret raw-provider-identity",
				);
			});

			const result = await refresh(context);

			expect(mocks.beginAttempt).toHaveBeenCalledWith(context.prisma, cacheType, authority, {});
			expect(mocks.finishAttempt).toHaveBeenCalledWith(
				context.prisma,
				cacheType,
				"Plex refresh preparation failed before publication",
				authority,
				attempt,
				context.log,
				{},
			);
			expect(result).toMatchObject({ complete: false, errors: 1, upserted: 0 });
			const diagnostics = JSON.stringify({
				result,
				storedFailureMessage: mocks.finishAttempt.mock.calls[0]?.[2],
				logs: (log.error as unknown as { mock: { calls: unknown[][] } }).mock.calls,
			});
			for (const secret of [
				"api-key-secret",
				"ciphertext-secret",
				"iv-secret",
				"username:password",
				"url-secret",
				"raw-provider-identity",
				instance.id,
			]) {
				expect(diagnostics).not.toContain(secret);
			}
		},
	);

	it("transfers the exact pre-acquired Plex attempt into the lower-level refresher", async () => {
		await refreshOwnedPlexCache(context);

		expect(mocks.refreshCacheWithAttempt).toHaveBeenCalledWith(
			{
				prisma: context.prisma,
				instance: snapshot,
				log: context.log,
			},
			attempt,
		);
	});

	it.each([["library", refreshOwnedPlexCacheWithAttempt, mocks.refreshCacheWithAttempt]] as const)(
		"continues a preclaimed %s refresh without beginning or replacing it",
		async (_label, refresh, lowerRefresh) => {
			const callerAttempt = {
				attemptedAt: new Date("2026-08-20T13:00:00.000Z"),
				resultMarker: "in_progress:22222222-2222-4222-8222-222222222222",
			};

			await refresh(context, callerAttempt);

			expect(mocks.beginAttempt).not.toHaveBeenCalled();
			expect(lowerRefresh).toHaveBeenCalledWith(
				{
					prisma: context.prisma,
					instance: snapshot,
					log: context.log,
				},
				callerAttempt,
			);
		},
	);

	it("does not let an older preparation failure overwrite a newer attempt", async () => {
		mocks.createSnapshot.mockImplementation(() => {
			throw new Error("credentials unavailable");
		});
		mocks.finishAttempt.mockResolvedValue("superseded");

		const result = await refreshOwnedPlexCache(context);

		expect(result).toMatchObject({ complete: false, errors: 0, upserted: 0, superseded: true });
	});
});

describe("Plex episode durable orchestration", () => {
	it.each([
		{ exhausted: false, finish: "recorded", retains: true },
		{ exhausted: true, finish: "recorded", retains: false },
		{ exhausted: true, finish: "superseded", retains: false },
		{ exhausted: true, finish: "failed", retains: true },
	])(
		"retains ownership after a unit failure only while the attempt remains live: %j",
		async ({ exhausted, finish, retains }) => {
			mocks.collect.mockResolvedValue({ complete: false, reasonCode: "provider-unavailable" });
			mocks.hasExhaustedRetries.mockResolvedValue(exhausted);
			mocks.finishAttempt.mockResolvedValue(finish);
			const prisma = {
				serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
				providerObservationUnit: { findFirst: mocks.readUnit },
				providerObservationRun: {
					findUnique: vi.fn().mockResolvedValue({
						state: "failed",
						completedUnits: 0,
						totalUnits: 2,
						completedWork: 0,
						totalWork: 2,
						lastReasonCode: "provider-unavailable",
					}),
				},
			};
			const result = await runNextPlexEpisodeWorkItem({ ...context, prisma: prisma as never });
			expect(mocks.failUnit).toHaveBeenCalledOnce();
			expect(result.continuationAttempt).toEqual(retains ? attempt : undefined);
		},
	);

	it("uses the production runner factory seam without replacing durable claim or stage mechanics", async () => {
		const createClient = vi.fn(() => ({ getEpisodes: vi.fn().mockResolvedValue([]) }) as never);
		const createParentAuthority = vi.fn(() => ({ readPositiveEpisodeParents: mocks.readParents }));
		const runner = createPlexEpisodeWorkItemRunner({ createClient, createParentAuthority });
		const prisma = {
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
			providerObservationUnit: { findFirst: mocks.readUnit },
			providerObservationRun: {
				findUnique: vi.fn().mockResolvedValue({
					state: "running",
					completedUnits: 0,
					totalUnits: 1,
					completedWork: 0,
					totalWork: 1,
					lastReasonCode: null,
				}),
			},
		};

		const result = await runner({ ...context, prisma: prisma as never });

		expect(createParentAuthority).toHaveBeenCalledWith({ prisma, log: context.log });
		expect(createClient).toHaveBeenCalledOnce();
		expect(mocks.createRun).toHaveBeenCalledOnce();
		expect(mocks.claimUnit).toHaveBeenCalledOnce();
		expect(mocks.stage).toHaveBeenCalledOnce();
		expect(mocks.stage.mock.calls[0]?.[0]).toEqual({ transaction: true });
		expect(result).toMatchObject({ continuationAttempt: attempt });
	});

	it("does not finish a foreign attempt when its borrowed run has exhausted retries", async () => {
		mocks.claimAttempt.mockResolvedValue({ status: "already-running", attempt });
		mocks.collect.mockResolvedValue({ complete: false, reasonCode: "provider-unavailable" });
		mocks.hasExhaustedRetries.mockResolvedValue(true);
		const prisma = {
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
			providerObservationUnit: { findFirst: mocks.readUnit },
			providerObservationRun: {
				findUnique: vi.fn().mockResolvedValue({
					state: "failed",
					completedUnits: 0,
					totalUnits: 2,
					completedWork: 0,
					totalWork: 2,
					lastReasonCode: "provider-unavailable",
				}),
			},
		};
		const result = await runNextPlexEpisodeWorkItem({ ...context, prisma: prisma as never });
		expect(mocks.failUnit).toHaveBeenCalledOnce();
		expect(mocks.finishAttempt).not.toHaveBeenCalled();
		expect(result.continuationAttempt).toBeUndefined();
	});

	it("re-reads the current owned service before decrypt/I/O and finalizes a no-claim restart", async () => {
		const fresh = {
			...instance,
			label: "Freshly re-read Plex",
		};
		const prisma = {
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(fresh) },
			providerObservationUnit: { findFirst: mocks.readUnit },
			providerObservationRun: {
				findUnique: vi.fn().mockResolvedValue({
					state: "running",
					completedUnits: 1,
					totalUnits: 1,
					completedWork: 1,
					totalWork: 1,
					lastReasonCode: null,
				}),
			},
		};
		await runNextPlexEpisodeWorkItem({ ...context, prisma: prisma as never });
		expect(prisma.serviceInstance.findFirst).toHaveBeenCalled();
		expect(mocks.createSnapshot).toHaveBeenCalledWith(context.encryptor, fresh);
		expect(mocks.finalize).toHaveBeenCalledWith(expect.objectContaining({ attempt }));
		expect(mocks.collect).toHaveBeenCalledTimes(1);
		expect(mocks.claimUnit).toHaveBeenCalledTimes(1);
		expect(mocks.stage).toHaveBeenCalledTimes(1);
	});

	it("rejects a persisted claimed-unit drift before decrypt or Plex collection", async () => {
		const prisma = {
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
			providerObservationUnit: { findFirst: mocks.readUnit },
			providerObservationRun: {
				findUnique: vi.fn().mockResolvedValue({
					state: "running",
					completedUnits: 0,
					totalUnits: 1,
					completedWork: 0,
					totalWork: 1,
					lastReasonCode: null,
				}),
			},
		};
		mocks.readUnit.mockResolvedValue({
			id: "unit",
			runId: "run",
			state: "running",
			claimToken: "claim",
			phase: "collect",
			ordinal: 0,
			scopeKey: "plex-episode-unit:0",
			scopeDigest: "drifted".padEnd(64, "0"),
			expectedTargets: 1,
			run: {
				id: "run",
				instanceId: "plex-1",
				provider: "plex_episode",
				cacheType: "plex_episode",
				state: "running",
				activeSlotKey: "slot",
				authorityKey: "key",
				targetDigest: "d".repeat(64),
				parentGenerationId: "parent",
				connectionGeneration: 7,
				identityGeneration: 11,
			},
		});

		await runNextPlexEpisodeWorkItem({ ...context, prisma: prisma as never });

		expect(mocks.createSnapshot).not.toHaveBeenCalled();
		expect(mocks.collect).not.toHaveBeenCalled();
	});

	it("rejects a verified-to-mismatch identity transition before decrypt or Plex collection", async () => {
		const prisma = {
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue({ ...instance, identityStatus: "MISMATCH" }),
			},
			providerObservationUnit: { findFirst: mocks.readUnit },
			providerObservationRun: {
				findUnique: vi.fn().mockResolvedValue({
					state: "running",
					completedUnits: 0,
					totalUnits: 1,
					completedWork: 0,
					totalWork: 1,
					lastReasonCode: null,
				}),
			},
		};

		await runNextPlexEpisodeWorkItem({ ...context, prisma: prisma as never });

		expect(mocks.createSnapshot).not.toHaveBeenCalled();
		expect(mocks.collect).not.toHaveBeenCalled();
		expect(mocks.stage).not.toHaveBeenCalled();
	});

	it("settles the exact outer attempt only after the owned durable run exhausts retries", async () => {
		const prisma = {
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
			providerObservationUnit: { findFirst: mocks.readUnit },
			providerObservationRun: {
				findUnique: vi.fn().mockResolvedValue({
					state: "failed",
					completedUnits: 0,
					totalUnits: 1,
					completedWork: 0,
					totalWork: 1,
					lastReasonCode: "provider-unavailable",
				}),
			},
		};
		mocks.collect.mockRejectedValue(new Error("provider timeout"));

		await runNextPlexEpisodeWorkItem({ ...context, prisma: prisma as never });
		expect(mocks.finishAttempt).not.toHaveBeenCalled();

		mocks.hasExhaustedRetries.mockResolvedValue(true);
		await runNextPlexEpisodeWorkItem({ ...context, prisma: prisma as never });

		expect(mocks.finishAttempt).toHaveBeenCalledOnce();
		expect(mocks.finishAttempt).toHaveBeenCalledWith(
			prisma,
			"plex_episode",
			"provider-unavailable",
			authority,
			attempt,
			context.log,
			{},
			expect.any(Function),
		);
	});

	it("never settles an outer attempt for a durable run that does not own its authority", async () => {
		mocks.createRun.mockResolvedValue({
			id: "run",
			instanceId: "plex-1",
			provider: "plex_episode",
			cacheType: "plex_episode",
			parentGenerationId: "parent",
			targetDigest: "wrong-target-digest",
			authorityKey: "key",
			connectionGeneration: 7,
			identityGeneration: 11,
		});
		mocks.collect.mockRejectedValue(new Error("provider timeout"));
		mocks.hasExhaustedRetries.mockResolvedValue(true);
		const prisma = {
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
			providerObservationUnit: { findFirst: mocks.readUnit },
			providerObservationRun: {
				findUnique: vi.fn().mockResolvedValue({
					state: "failed",
					completedUnits: 0,
					totalUnits: 1,
					completedWork: 0,
					totalWork: 1,
					lastReasonCode: "provider-unavailable",
				}),
			},
		};

		await runNextPlexEpisodeWorkItem({ ...context, prisma: prisma as never });

		expect(mocks.finishAttempt).not.toHaveBeenCalled();
	});

	it("does one provider unit per invocation and a restart finalizes without recollecting completed units", async () => {
		mocks.claimUnit.mockResolvedValue(null);
		const prisma = {
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
			providerObservationRun: {
				findUnique: vi.fn().mockResolvedValue({
					state: "running",
					completedUnits: 1,
					totalUnits: 1,
					completedWork: 1,
					totalWork: 1,
					lastReasonCode: null,
				}),
			},
		};
		await runNextPlexEpisodeWorkItem({ ...context, prisma: prisma as never });
		expect(mocks.collect).not.toHaveBeenCalled();
		expect(mocks.finalize).toHaveBeenCalledTimes(1);
	});

	it("returns a bounded dependency retry after finalization finds the parent refresh in progress", async () => {
		mocks.claimUnit.mockResolvedValue(null);
		mocks.finalize.mockResolvedValue({
			published: false,
			itemCount: 0,
			outcome: "parent-refresh-in-progress",
		});
		const prisma = {
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
			providerObservationRun: {
				findUnique: vi.fn().mockResolvedValue({
					state: "running",
					completedUnits: 1,
					totalUnits: 1,
					completedWork: 1,
					totalWork: 1,
					lastReasonCode: null,
				}),
			},
		};

		const result = await refreshOwnedPlexEpisodeCache({ ...context, prisma: prisma as never });

		expect(result).toMatchObject({
			complete: false,
			errors: 0,
			coverageIncomplete: true,
			retryCategory: "parent-refresh-in-progress",
			continuationAttempt: attempt,
		});
	});

	it("returns the committed item count and completion time after durable publication", async () => {
		mocks.claimUnit.mockResolvedValue(null);
		mocks.finalize.mockResolvedValue({ published: true, itemCount: 37 });
		const prisma = {
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
			providerObservationRun: {
				findUnique: vi
					.fn()
					.mockResolvedValueOnce({
						state: "running",
						completedUnits: 1,
						totalUnits: 1,
						completedWork: 1,
						totalWork: 1,
						lastReasonCode: null,
					})
					.mockResolvedValue({
						state: "complete",
						completedUnits: 1,
						totalUnits: 1,
						completedWork: 1,
						totalWork: 1,
						lastReasonCode: null,
					}),
			},
		};

		const result = await refreshOwnedPlexEpisodeCache({ ...context, prisma: prisma as never });

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 37 });
		expect(result.completedAt).toBeInstanceOf(Date);
		expect(mocks.finalize).toHaveBeenCalledWith(
			expect.objectContaining({ now: result.completedAt, transaction: { transaction: true } }),
		);
	});

	it.each([true, false])(
		"bounds an unavailable finalization identity and settles only an owned attempt (owned=%s)",
		async (owned) => {
			mocks.claimAttempt.mockResolvedValue({
				status: owned ? "acquired" : "already-running",
				attempt,
			});
			mocks.claimUnit.mockResolvedValue(null);
			mocks.guardPublication.mockRejectedValue(
				new ProviderIdentityGuardError("IDENTITY_UNAVAILABLE", "generic unavailable"),
			);
			const prisma = {
				serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
				providerObservationRun: {
					findUnique: vi.fn().mockResolvedValue({
						state: "running",
						completedUnits: 1,
						totalUnits: 1,
						completedWork: 1,
						totalWork: 1,
						lastReasonCode: null,
					}),
				},
			};

			const result = await refreshOwnedPlexEpisodeCache({ ...context, prisma: prisma as never });

			expect(result).toMatchObject({
				complete: false,
				errors: 1,
				retryCategory: "identity-unavailable",
			});
			if (!owned) {
				expect(mocks.finishAttempt).not.toHaveBeenCalled();
				expect(result.continuationAttempt).toBeUndefined();
				return;
			}
			expect(mocks.finishAttempt).toHaveBeenCalledWith(
				prisma,
				"plex_episode",
				"provider-unavailable",
				authority,
				attempt,
				context.log,
				{},
				expect.any(Function),
			);
		},
	);

	it("does not retain a claimed unit after the live identity guard supersedes collection", async () => {
		mocks.guardPublication.mockRejectedValue(
			new ProviderIdentityGuardError("IDENTITY_MISMATCH", "generic mismatch"),
		);
		const prisma = {
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
			providerObservationUnit: { findFirst: mocks.readUnit },
			providerObservationRun: {
				findUnique: vi.fn().mockResolvedValue({
					state: "invalidated",
					completedUnits: 0,
					totalUnits: 1,
					completedWork: 0,
					totalWork: 1,
					lastReasonCode: null,
				}),
			},
		};

		const result = await refreshOwnedPlexEpisodeCache({ ...context, prisma: prisma as never });

		expect(result).toMatchObject({ complete: false, errors: 0, superseded: true });
		expect(mocks.failUnit).not.toHaveBeenCalled();
		expect(mocks.stage).not.toHaveBeenCalled();
	});

	it("returns superseded instead of continuing after finalization loses its exact attempt", async () => {
		mocks.claimUnit.mockResolvedValue(null);
		mocks.finalize.mockResolvedValue({
			published: false,
			itemCount: 0,
			outcome: "superseded",
		});
		const prisma = {
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
			providerObservationRun: {
				findUnique: vi.fn().mockResolvedValue({
					state: "running",
					completedUnits: 1,
					totalUnits: 1,
					completedWork: 1,
					totalWork: 1,
					lastReasonCode: null,
				}),
			},
		};

		const result = await refreshOwnedPlexEpisodeCache({ ...context, prisma: prisma as never });

		expect(result).toMatchObject({ complete: false, superseded: true });
	});

	it("keeps an acquired attempt in progress while a valid current parent refresh runs", async () => {
		mocks.readParents.mockResolvedValue({
			available: false,
			evidence: {
				availability: "last-known",
				authority: "unavailable",
				attemptState: "in_progress",
				publicationLevel: "unavailable",
				completeness: "unknown",
				reasonCodes: ["latest_attempt_in_progress"],
				publishedGeneration: {
					generationId: "parent-generation",
					publicationLevel: "authoritative",
					publishedAt: "2026-08-20T11:00:00.000Z",
					itemCount: 1,
				},
			},
		});
		const result = await refreshOwnedPlexEpisodeCache(context);
		expect(mocks.finishAttempt).not.toHaveBeenCalled();
		expect(mocks.failUnit).not.toHaveBeenCalled();
		expect(mocks.createRun).not.toHaveBeenCalled();
		expect(mocks.collect).not.toHaveBeenCalled();
		expect(mocks.stage).not.toHaveBeenCalled();
		expect(result).toMatchObject({ errors: 0, coverageIncomplete: true });
		expect(result).toMatchObject({
			retryCategory: "parent-refresh-in-progress",
		});
		expect(result).toMatchObject({ continuationAttempt: attempt });
	});

	it("does not grant a losing already-running caller continuation ownership", async () => {
		mocks.claimAttempt.mockResolvedValue({ status: "already-running", attempt });
		mocks.readParents.mockResolvedValue({
			available: false,
			evidence: {
				availability: "last-known",
				authority: "unavailable",
				attemptState: "in_progress",
				publicationLevel: "unavailable",
				completeness: "unknown",
				reasonCodes: ["latest_attempt_in_progress"],
				publishedGeneration: {
					generationId: "parent-generation",
					publicationLevel: "authoritative",
					publishedAt: "2026-08-20T11:00:00.000Z",
					itemCount: 1,
				},
			},
		});

		const result = await runNextPlexEpisodeWorkItem(context);

		expect(result).toMatchObject({
			state: "running",
			retryCategory: "parent-refresh-in-progress",
		});
		expect(result).not.toHaveProperty("continuationAttempt");
		expect(mocks.finishAttempt).not.toHaveBeenCalled();
	});

	it("keeps bounded failure behavior for malformed parent in-progress evidence", async () => {
		mocks.readParents.mockResolvedValue({
			available: false,
			evidence: { attemptState: "in_progress" },
		});
		const result = await runNextPlexEpisodeWorkItem(context);
		expect(mocks.finishAttempt).toHaveBeenCalledWith(
			context.prisma,
			"plex_episode",
			"coverage-incomplete",
			authority,
			attempt,
			context.log,
			{},
		);
		expect(result).toMatchObject({
			state: "failed",
			retryCategory: "parent-refresh-unavailable",
		});
	});

	it("retries unavailable parent evidence while the parent scheduler can recover", async () => {
		mocks.readParents.mockResolvedValue({
			available: false,
			evidence: { attemptState: "error" },
		});

		const result = await runNextPlexEpisodeWorkItem(context);

		expect(result).toMatchObject({ retryCategory: "parent-refresh-unavailable" });
	});

	it("does not terminate an already-running attempt when it cannot obtain parent work", async () => {
		mocks.claimAttempt.mockResolvedValue({ status: "already-running", attempt });
		mocks.readParents.mockResolvedValue({ available: false });
		await runNextPlexEpisodeWorkItem(context);
		expect(mocks.finishAttempt).not.toHaveBeenCalled();
	});

	it("uses an exact episode preclaim without a second claim and forwards it to finalization", async () => {
		const prisma = {
			cacheRefreshStatus: {
				findUnique: vi.fn().mockResolvedValue({
					lastAttemptAt: attempt.attemptedAt,
					lastAttemptResult: attempt.resultMarker,
					connectionGeneration: 7,
					identityGeneration: 11,
				}),
			},
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
			providerObservationUnit: { findFirst: mocks.readUnit },
			providerObservationRun: {
				findUnique: vi.fn().mockResolvedValue({
					state: "running",
					completedUnits: 1,
					totalUnits: 1,
					completedWork: 1,
					totalWork: 1,
					lastReasonCode: null,
				}),
			},
		};
		await refreshOwnedPlexEpisodeCacheWithAttempt({ ...context, prisma: prisma as never }, attempt);
		expect(mocks.claimAttempt).not.toHaveBeenCalled();
		expect(mocks.createRun).toHaveBeenCalledWith(
			prisma,
			expect.objectContaining({
				authority: expect.objectContaining({
					targetDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
				}),
			}),
		);
		expect(mocks.finalize).toHaveBeenCalledWith(expect.objectContaining({ attempt }));
	});
});

describe("native Plex inventory companion", () => {
	it("publishes presence before an unavailable canonical watch refresh", async () => {
		mocks.refreshCacheWithAttempt.mockResolvedValue({
			complete: false,
			upserted: 0,
			errors: 1,
			errorMessages: ["provider-unavailable"],
		});
		const result = await refreshOwnedPlexCacheWithAttempt(context, attempt);
		expect(result).toMatchObject({ complete: false, nativeInventoryStatus: "published" });
		expect(mocks.nativeRefresh).toHaveBeenCalledWith(
			expect.objectContaining({
				instance: snapshot,
				cacheType: "plex",
				attempt,
				domains: ["library", "episode"],
			}),
		);
		expect(mocks.nativeRefresh.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.refreshCacheWithAttempt.mock.invocationCallOrder[0]!,
		);
	});
	it("retains canonical success while exposing a native failure for recovery", async () => {
		mocks.nativeRefresh.mockResolvedValue({ status: "failed" });
		expect(await refreshOwnedPlexCache(context)).toMatchObject({
			complete: true,
			upserted: 1,
			nativeInventoryStatus: "failed",
		});
	});
});
