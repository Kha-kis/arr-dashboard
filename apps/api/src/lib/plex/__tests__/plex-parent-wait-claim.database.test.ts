import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderObservationStatus } from "@arr/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const identityMocks = vi.hoisted(() => ({ readProviderIdentity: vi.fn() }));

vi.mock("../../services/service-identity.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../services/service-identity.js")>()),
	readProviderIdentity: identityMocks.readProviderIdentity,
}));

import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import {
	claimObservationUnit,
	completeObservationUnit,
	createOrLoadObservationRun,
} from "../../provider-observation/observation-run-repository.js";
import {
	claimProviderCacheRefreshAttempt,
	finishPlexCacheRefreshAttemptFailure,
	reconcileInterruptedProviderCacheRefreshAttempts,
} from "../../services/provider-cache-status.js";
import type { ProviderPublicationAuthority } from "../../services/provider-identity-guard.js";
import {
	createPlexEpisodeWorkItemRunner,
	type OwnedPlexRefreshContext,
} from "../plex-refresh-orchestration.js";

const databases: Array<{ directory: string; prisma: ReturnType<typeof createTestPrismaClient> }> =
	[];

beforeEach(() => {
	identityMocks.readProviderIdentity.mockReset().mockResolvedValue({
		service: "PLEX",
		identityKind: "plex-machine-identifier",
		rawIdentity: "verified-provider",
		confirmationDigest: "a".repeat(64),
		fingerprint: "a".repeat(12),
	});
});

afterEach(async () => {
	for (const { directory, prisma } of databases.splice(0)) {
		await prisma.$disconnect();
		rmSync(directory, { recursive: true, force: true });
	}
});

const authority: ProviderPublicationAuthority = {
	id: "plex-1",
	userId: "user-1",
	service: "PLEX",
	baseUrl: "https://plex.invalid",
	enabled: true,
	encryptedApiKey: "encrypted-token",
	encryptionIv: "token-iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	expectedIdentity: "verified-provider",
	identityStatus: "VERIFIED",
	connectionGeneration: 4,
	identityGeneration: 9,
};

async function database() {
	const directory = mkdtempSync(join(tmpdir(), "plex-parent-wait-"));
	const dbPath = join(directory, "test.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});
	const prisma = createTestPrismaClient(dbPath);
	databases.push({ directory, prisma });
	await prisma.user.create({
		data: { id: authority.userId, username: "plex-parent-wait" },
	});
	await prisma.serviceInstance.create({
		data: {
			...authority,
			label: "Plex",
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityVerifiedAt: new Date("2026-09-06T00:00:00.000Z"),
		},
	});
	return prisma;
}

const pendingParents = {
	available: false as const,
	providerStatus: {
		availability: "last-known",
		evidence: "unknown",
		observedAt: null,
		ageSeconds: null,
		latestAttempt: "running",
		reasonCodes: [],
	} satisfies ProviderObservationStatus,
	evidence: {
		availability: "last-known" as const,
		authority: "unavailable" as const,
		attemptState: "in_progress" as const,
		publicationLevel: "unavailable" as const,
		completeness: "unknown" as const,
		reasonCodes: ["latest_attempt_in_progress" as const],
		publishedGeneration: {
			generationId: "parent-generation",
			publicationLevel: "authoritative" as const,
			publishedAt: "2026-09-06T00:00:00.000Z",
			itemCount: 1,
		},
	},
};

const unavailableParents = {
	available: false as const,
	providerStatus: {
		availability: "unavailable",
		evidence: "unknown",
		observedAt: null,
		ageSeconds: null,
		latestAttempt: "failed",
		reasonCodes: [],
	} satisfies ProviderObservationStatus,
	evidence: {
		availability: "unavailable" as const,
		authority: "unavailable" as const,
		attemptState: "error" as const,
		publicationLevel: "unavailable" as const,
		completeness: "unknown" as const,
		reasonCodes: ["latest_attempt_failed" as const],
	},
};

describe("Plex parent-wait claim continuation", () => {
	it("terminalizes only its retained marker after parent loss and permits a fresh claim", async () => {
		const prisma = await database();
		const readParents = vi
			.fn()
			.mockResolvedValueOnce(pendingParents)
			.mockResolvedValueOnce(pendingParents)
			.mockResolvedValueOnce(unavailableParents)
			.mockResolvedValueOnce(unavailableParents);
		const runner = createPlexEpisodeWorkItemRunner({
			createParentAuthority: () => ({ readPositiveEpisodeParents: readParents }),
			createClient: () => {
				throw new Error("episode client must not be created while parent evidence is unavailable");
			},
		});
		const context: OwnedPlexRefreshContext = {
			prisma,
			encryptor: { decrypt: () => "plaintext" },
			instance: await prisma.serviceInstance.findUniqueOrThrow({ where: { id: authority.id } }),
			log: { warn: vi.fn(), error: vi.fn() } as never,
		};

		const first = await runner(context);
		expect(first).toMatchObject({ state: "running", retryCategory: "parent-refresh-in-progress" });
		const retainedAttempt = (
			first as typeof first & {
				continuationAttempt?: { attemptedAt: Date; resultMarker: string };
			}
		).continuationAttempt;
		expect(retainedAttempt).toBeDefined();
		const pendingStatus = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId: authority.id, cacheType: "plex_episode" } },
		});
		expect(pendingStatus.lastAttemptResult).toBe(retainedAttempt?.resultMarker);
		expect(pendingStatus.lastAttemptErrorMessage).toBeNull();

		const losingWait = await runner(context);
		expect(losingWait.continuationAttempt).toBeUndefined();
		await runner(context, losingWait.continuationAttempt);
		expect(
			await prisma.cacheRefreshStatus.findUniqueOrThrow({
				where: { instanceId_cacheType: { instanceId: authority.id, cacheType: "plex_episode" } },
			}),
		).toEqual(pendingStatus);

		const second = await runner(context, retainedAttempt);
		expect(second).toMatchObject({ state: "failed", retryCategory: "parent-refresh-unavailable" });
		const terminalStatus = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId: authority.id, cacheType: "plex_episode" } },
		});
		expect(terminalStatus.lastAttemptResult).toBe("error");
		expect(terminalStatus.lastAttemptErrorMessage).toBe("coverage-incomplete");

		const fresh = await claimProviderCacheRefreshAttempt(prisma, "plex_episode", authority, {
			now: () => new Date(Date.now() + 60_000),
		});
		expect(fresh.status).toBe("acquired");
		if (fresh.status !== "acquired" || !retainedAttempt) return;
		expect(fresh.attempt.resultMarker).not.toBe(retainedAttempt.resultMarker);
		const staleFinish = await finishPlexCacheRefreshAttemptFailure(
			prisma,
			"plex_episode",
			"coverage-incomplete",
			authority,
			retainedAttempt,
			context.log,
		);
		expect(staleFinish).toBe("superseded");
		const freshStatus = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId: authority.id, cacheType: "plex_episode" } },
		});
		expect(freshStatus.lastAttemptResult).toBe(fresh.attempt.resultMarker);
		expect(readParents).toHaveBeenCalledTimes(4);
	}, 120_000);

	it("releases an interrupted between-unit attempt without losing saved work when the parent has failed", async () => {
		const prisma = await database();
		const original = await claimProviderCacheRefreshAttempt(prisma, "plex_episode", authority);
		expect(original.status).toBe("acquired");
		if (original.status !== "acquired") throw new Error("fixture claim failed");
		const run = await createOrLoadObservationRun(prisma, {
			authority: {
				provider: "plex_episode",
				cacheType: "plex_episode",
				instanceId: authority.id,
				parentGenerationId: "parent-generation",
				targetDigest: "d".repeat(64),
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
			},
			units: [0, 1].map((ordinal) => ({
				ordinal,
				scopeKey: `scope:${ordinal}`,
				scopeDigest: "e".repeat(64),
				phase: "collect" as const,
				expectedTargets: 1,
			})),
		});
		const claim = await claimObservationUnit(prisma, { runId: run.id, now: new Date() });
		if (!claim) throw new Error("fixture unit claim failed");
		await prisma.plexEpisodeObservationStage.create({
			data: {
				runId: run.id,
				unitId: claim.unitId,
				showTmdbId: 1,
				parentRatingKey: "show-1",
				seasonNumber: 1,
				episodeNumber: 1,
				ratingKey: "episode-1",
				title: "Fixture episode",
				watched: true,
				watchedByUsers: "[]",
				watchCount: 1,
				refreshedAt: new Date(),
				sourceFingerprint: "fixture",
			},
		});
		expect(
			await completeObservationUnit(prisma, { claim, expectedRawCount: 1, observedRawCount: 1 }),
		).toBe(true);
		const waitingRunner = createPlexEpisodeWorkItemRunner({
			createParentAuthority: () => ({ readPositiveEpisodeParents: async () => pendingParents }),
			createClient: () => {
				throw new Error("pending parent must prevent provider I/O");
			},
		});
		expect(
			await waitingRunner(
				{
					prisma,
					log: { warn: vi.fn(), error: vi.fn() } as never,
					encryptor: { decrypt: () => "plaintext" },
					instance: await prisma.serviceInstance.findUniqueOrThrow({ where: { id: authority.id } }),
				},
				original.attempt,
			),
		).toMatchObject({
			state: "running",
			retryCategory: "parent-refresh-in-progress",
			continuationAttempt: original.attempt,
		});
		const savedRun = await prisma.providerObservationRun.findUniqueOrThrow({
			where: { id: run.id },
			include: { units: true },
		});
		const savedRows = await prisma.plexEpisodeObservationStage.findMany({
			where: { runId: run.id },
		});
		expect(savedRun).toMatchObject({ state: "running", completedUnits: 1, totalUnits: 2 });
		expect(savedRun.units.every((unit) => unit.claimToken === null)).toBe(true);
		expect(await reconcileInterruptedProviderCacheRefreshAttempts(prisma)).toBe(1);
		expect(
			await prisma.providerObservationRun.findUniqueOrThrow({
				where: { id: run.id },
				include: { units: true },
			}),
		).toEqual(savedRun);
		expect(await prisma.plexEpisodeObservationStage.findMany({ where: { runId: run.id } })).toEqual(
			savedRows,
		);
		expect(await reconcileInterruptedProviderCacheRefreshAttempts(prisma)).toBe(0);

		const log = { warn: vi.fn(), error: vi.fn() } as never;
		const runner = createPlexEpisodeWorkItemRunner({
			createParentAuthority: () => ({ readPositiveEpisodeParents: async () => unavailableParents }),
			createClient: () => {
				throw new Error("unavailable parent must prevent provider I/O");
			},
		});
		const result = await runner({
			prisma,
			log,
			encryptor: { decrypt: () => "plaintext" },
			instance: await prisma.serviceInstance.findUniqueOrThrow({ where: { id: authority.id } }),
		});
		expect(result).toMatchObject({ state: "failed", retryCategory: "parent-refresh-unavailable" });
		const fresh = await claimProviderCacheRefreshAttempt(prisma, "plex_episode", authority);
		expect(fresh.status).toBe("acquired");
		expect(
			await finishPlexCacheRefreshAttemptFailure(
				prisma,
				"plex_episode",
				"coverage-incomplete",
				authority,
				original.attempt,
				log,
			),
		).toBe("superseded");
		expect(await prisma.plexEpisodeObservationStage.findMany({ where: { runId: run.id } })).toEqual(
			savedRows,
		);
	}, 120_000);
});
