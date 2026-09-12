import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import {
	advanceObservationUnit,
	canSettleAutomaticObservationRenewalDeferred,
	claimObservationUnit,
	completeObservationUnit,
	createOrLoadObservationRun,
	failObservationUnit,
	getAutomaticObservationRenewalDeadline,
	hasExhaustedObservationRunRetries,
	invalidateObservationRuns,
	recoverAbandonedObservationRuns,
	renewExhaustedObservationRun,
} from "../observation-run-repository.js";
import {
	buildObservationActiveSlotKey,
	buildObservationAuthorityKey,
	type ObservationRunAuthority,
	type ObservationRunUnitSeed,
} from "../observation-run-types.js";

const databases: Array<{ directory: string; prisma: ReturnType<typeof createTestPrismaClient> }> =
	[];
const authority: ObservationRunAuthority = {
	provider: "plex_episode",
	cacheType: "plex_episode",
	instanceId: "instance-1",
	parentGenerationId: "parent-1",
	targetDigest: "a".repeat(64),
	connectionGeneration: 2,
	identityGeneration: 3,
};
const units: ObservationRunUnitSeed[] = [
	{
		ordinal: 0,
		scopeKey: "scope:one",
		scopeDigest: "b".repeat(64),
		phase: "collect",
		expectedTargets: 2,
	},
	{
		ordinal: 1,
		scopeKey: "scope:two",
		scopeDigest: "c".repeat(64),
		phase: "collect",
		expectedTargets: 1,
	},
];
const renewalAuthority: ObservationRunAuthority = {
	provider: "jellyfin_episode",
	cacheType: "jellyfin_episode",
	instanceId: "instance-1",
	parentGenerationId: `jellyfin-episode-parent-v3:${"d".repeat(64)}`,
	targetDigest: "e".repeat(64),
	connectionGeneration: 2,
	identityGeneration: 3,
};
const renewalUnits: ObservationRunUnitSeed[] = [
	{
		ordinal: 0,
		scopeKey: "library:one",
		scopeDigest: "f".repeat(64),
		scopePayload: JSON.stringify({ catalogProvenance: { version: 3 } }),
		phase: "collect",
		expectedTargets: 2,
	},
	{
		ordinal: 1,
		scopeKey: "library:two",
		scopeDigest: "1".repeat(64),
		scopePayload: JSON.stringify({ catalogProvenance: { version: 3 } }),
		phase: "collect",
		expectedTargets: 1,
	},
	{
		ordinal: 2,
		scopeKey: "library:three",
		scopeDigest: "2".repeat(64),
		scopePayload: JSON.stringify({ catalogProvenance: { version: 3 } }),
		phase: "collect",
		expectedTargets: 3,
	},
];

async function database() {
	const directory = mkdtempSync(join(tmpdir(), "provider-observation-run-"));
	const dbPath = join(directory, "test.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});
	const prisma = createTestPrismaClient(dbPath);
	databases.push({ directory, prisma });
	await prisma.user.create({
		data: { id: "user-1", username: `observation-${Date.now()}-${Math.random()}` },
	});
	await prisma.serviceInstance.create({
		data: {
			id: authority.instanceId,
			userId: "user-1",
			service: "PLEX",
			label: "observation",
			baseUrl: "http://127.0.0.1:32400",
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
			connectionGeneration: authority.connectionGeneration,
			identityGeneration: authority.identityGeneration,
		},
	});
	return prisma;
}

async function renewalDatabase() {
	const prisma = await database();
	await prisma.serviceInstance.update({
		where: { id: renewalAuthority.instanceId },
		data: { service: "JELLYFIN", identityStatus: "VERIFIED" },
	});
	return prisma;
}

async function exhaustedRenewalRun(prisma: Awaited<ReturnType<typeof renewalDatabase>>) {
	const run = await createOrLoadObservationRun(prisma, {
		authority: renewalAuthority,
		units: renewalUnits,
	});
	const old = new Date("2026-09-10T05:00:00.000Z");
	const unit = await prisma.providerObservationUnit.findFirstOrThrow({ where: { runId: run.id } });
	const completedUnit = await prisma.providerObservationUnit.findFirstOrThrow({
		where: { runId: run.id, ordinal: 1 },
	});
	await prisma.providerObservationUnit.update({
		where: { id: completedUnit.id },
		data: { state: "complete" },
	});
	await prisma.providerObservationUnit.update({
		where: { id: unit.id },
		data: {
			cursor: 17,
			expectedRawCount: 20,
			observedRawCount: 18,
			state: "failed",
			attemptCount: 4,
			nextAttemptAt: null,
			lastReasonCode: "provider-unavailable",
		},
	});
	await prisma.providerObservationRun.update({
		where: { id: run.id },
		data: {
			state: "failed",
			completedUnits: 1,
			completedWork: 1,
			nextAttemptAt: null,
			lastReasonCode: "provider-unavailable",
		},
	});
	await prisma.$executeRaw`UPDATE "provider_observation_runs" SET "updatedAt" = ${old} WHERE "id" = ${run.id}`;
	await prisma.$executeRaw`UPDATE "provider_observation_units" SET "updatedAt" = ${old} WHERE "id" = ${unit.id}`;
	return { run, unit, old };
}

afterEach(async () => {
	for (const entry of databases.splice(0)) {
		await entry.prisma.$disconnect();
		rmSync(entry.directory, { recursive: true, force: true });
	}
});

describe("provider observation run repository SQLite lifecycle", { timeout: 30_000 }, () => {
	it.each([
		["exactly at cutoff", "2026-09-10T05:30:00.000Z"],
		["after cutoff", "2026-09-10T05:30:00.001Z"],
	])("renews an exhausted V3 provider outage %s", async (_label, nowValue) => {
		const prisma = await renewalDatabase();
		const { run, unit } = await exhaustedRenewalRun(prisma);
		const result = await renewExhaustedObservationRun(prisma, {
			mode: "provider-unavailable-cooldown",
			runId: run.id,
			instanceId: renewalAuthority.instanceId,
			userId: "user-1",
			authorityKey: buildObservationAuthorityKey(renewalAuthority),
			parentGenerationId: renewalAuthority.parentGenerationId!,
			targetDigest: renewalAuthority.targetDigest,
			connectionGeneration: renewalAuthority.connectionGeneration,
			identityGeneration: renewalAuthority.identityGeneration,
			now: new Date(nowValue),
		});
		expect(result).toBe("renewed");
		expect(await prisma.providerObservationRun.findUnique({ where: { id: run.id } })).toMatchObject(
			{
				state: "running",
				activeSlotKey: buildObservationActiveSlotKey(renewalAuthority),
				completedUnits: 1,
				completedWork: 1,
			},
		);
		expect(
			await prisma.providerObservationUnit.findUnique({ where: { id: unit.id } }),
		).toMatchObject({
			state: "pending",
			attemptCount: 0,
			cursor: 17,
			expectedRawCount: 20,
			observedRawCount: 18,
			claimToken: null,
		});
	});

	it("returns the latest exhausted provider timestamp plus the recovery cooldown", async () => {
		const prisma = await renewalDatabase();
		const { run, unit } = await exhaustedRenewalRun(prisma);
		const now = new Date("2026-09-10T05:20:00.000Z");
		const deadline = await getAutomaticObservationRenewalDeadline(prisma, {
			runId: run.id,
			instanceId: renewalAuthority.instanceId,
			userId: "user-1",
			authorityKey: buildObservationAuthorityKey(renewalAuthority),
			parentGenerationId: renewalAuthority.parentGenerationId!,
			targetDigest: renewalAuthority.targetDigest,
			connectionGeneration: renewalAuthority.connectionGeneration,
			identityGeneration: renewalAuthority.identityGeneration,
			now,
		});
		expect(deadline).toEqual(new Date("2026-09-10T05:30:00.000Z"));
		await prisma.$executeRaw`UPDATE "provider_observation_units" SET "updatedAt" = ${new Date("2026-09-10T05:15:00.000Z")} WHERE "id" = ${unit.id}`;
		await prisma.$executeRaw`UPDATE "provider_observation_runs" SET "updatedAt" = ${new Date("2026-09-10T05:15:00.000Z")} WHERE "id" = ${run.id}`;
		expect(
			await getAutomaticObservationRenewalDeadline(prisma, {
				runId: run.id,
				instanceId: renewalAuthority.instanceId,
				userId: "user-1",
				authorityKey: buildObservationAuthorityKey(renewalAuthority),
				parentGenerationId: renewalAuthority.parentGenerationId!,
				targetDigest: renewalAuthority.targetDigest,
				connectionGeneration: renewalAuthority.connectionGeneration,
				identityGeneration: renewalAuthority.identityGeneration,
				now,
			}),
		).toEqual(new Date("2026-09-10T05:45:00.000Z"));
	});

	it("proves deferred marker ownership only for the unchanged exhausted V3 run", async () => {
		const prisma = await renewalDatabase();
		const { run } = await exhaustedRenewalRun(prisma);
		const input = {
			runId: run.id,
			instanceId: renewalAuthority.instanceId,
			authorityKey: buildObservationAuthorityKey(renewalAuthority),
			parentGenerationId: renewalAuthority.parentGenerationId!,
			targetDigest: renewalAuthority.targetDigest,
			connectionGeneration: renewalAuthority.connectionGeneration,
			identityGeneration: renewalAuthority.identityGeneration,
			now: new Date("2026-09-10T12:00:00.000Z"),
		};
		expect(await canSettleAutomaticObservationRenewalDeferred(prisma, input)).toBe(true);
		await prisma.providerObservationRun.update({
			where: { id: run.id },
			data: { state: "running" },
		});
		expect(await canSettleAutomaticObservationRenewalDeferred(prisma, input)).toBe(false);
	});

	it.each([
		"fresh run",
		"future timestamp",
		"mixed reason",
		"null reason",
		"active claim",
		"wrong authority",
		"wrong authority key",
		"wrong owner",
		"disabled instance",
		"unverified identity",
		"wrong service",
		"legacy parent",
	])("defers renewal for %s", async (caseName) => {
		const prisma = await renewalDatabase();
		const { run, unit } = await exhaustedRenewalRun(prisma);
		if (caseName === "fresh run") {
			await prisma.$executeRaw`UPDATE "provider_observation_runs" SET "updatedAt" = ${new Date("2026-09-10T11:45:00.000Z")} WHERE "id" = ${run.id}`;
		}
		if (caseName === "future timestamp") {
			await prisma.$executeRaw`UPDATE "provider_observation_runs" SET "updatedAt" = ${new Date("2026-09-10T13:00:00.000Z")} WHERE "id" = ${run.id}`;
		}
		if (caseName === "mixed reason") {
			await prisma.providerObservationUnit.update({
				where: { id: unit.id },
				data: { lastReasonCode: "coverage-incomplete" },
			});
			await prisma.$executeRaw`UPDATE "provider_observation_units" SET "updatedAt" = ${new Date("2026-09-10T05:00:00.000Z")} WHERE "id" = ${unit.id}`;
		}
		if (caseName === "null reason") {
			await prisma.providerObservationUnit.update({
				where: { id: unit.id },
				data: { lastReasonCode: null },
			});
			await prisma.$executeRaw`UPDATE "provider_observation_units" SET "updatedAt" = ${new Date("2026-09-10T05:00:00.000Z")} WHERE "id" = ${unit.id}`;
		}
		if (caseName === "active claim") {
			await prisma.providerObservationUnit.update({
				where: { id: unit.id },
				data: { state: "running", claimToken: "claim-token" },
			});
			await prisma.$executeRaw`UPDATE "provider_observation_units" SET "updatedAt" = ${new Date("2026-09-10T05:00:00.000Z")} WHERE "id" = ${unit.id}`;
		}
		if (caseName === "wrong owner") {
			await prisma.user.create({ data: { id: "user-2", username: "other-owner" } });
			await prisma.serviceInstance.update({
				where: { id: renewalAuthority.instanceId },
				data: { userId: "user-2" },
			});
		}
		if (caseName === "disabled instance") {
			await prisma.serviceInstance.update({
				where: { id: renewalAuthority.instanceId },
				data: { enabled: false },
			});
		}
		if (caseName === "unverified identity") {
			await prisma.serviceInstance.update({
				where: { id: renewalAuthority.instanceId },
				data: { identityStatus: "UNVERIFIED" },
			});
		}
		if (caseName === "wrong service") {
			await prisma.serviceInstance.update({
				where: { id: renewalAuthority.instanceId },
				data: { service: "PLEX" },
			});
		}
		const input = {
			mode: "provider-unavailable-cooldown" as const,
			runId: run.id,
			instanceId: renewalAuthority.instanceId,
			userId: "user-1",
			authorityKey: buildObservationAuthorityKey(renewalAuthority),
			parentGenerationId: renewalAuthority.parentGenerationId!,
			targetDigest: renewalAuthority.targetDigest,
			connectionGeneration: renewalAuthority.connectionGeneration,
			identityGeneration: renewalAuthority.identityGeneration,
			now: new Date("2026-09-10T12:00:00.000Z"),
		};
		if (caseName === "wrong authority") input.connectionGeneration += 1;
		if (caseName === "wrong authority key") input.authorityKey = "wrong-authority-key";
		if (caseName === "legacy parent")
			input.parentGenerationId = "jellyfin-episode-parent-v2:legacy";
		expect(await renewExhaustedObservationRun(prisma, input)).toBe("deferred");
		const deadline = await getAutomaticObservationRenewalDeadline(prisma, input);
		expect(deadline).toEqual(
			caseName === "fresh run" ? new Date("2026-09-10T12:15:00.000Z") : null,
		);
		expect(await prisma.providerObservationRun.findUnique({ where: { id: run.id } })).toMatchObject(
			{
				state: "failed",
			},
		);
	});

	it("allows only one concurrent automatic renewal", async () => {
		const prisma = await renewalDatabase();
		const { run } = await exhaustedRenewalRun(prisma);
		const input = {
			mode: "provider-unavailable-cooldown" as const,
			runId: run.id,
			instanceId: renewalAuthority.instanceId,
			userId: "user-1",
			authorityKey: buildObservationAuthorityKey(renewalAuthority),
			parentGenerationId: renewalAuthority.parentGenerationId!,
			targetDigest: renewalAuthority.targetDigest,
			connectionGeneration: renewalAuthority.connectionGeneration,
			identityGeneration: renewalAuthority.identityGeneration,
			now: new Date("2026-09-10T12:00:00.000Z"),
		};
		const results = await Promise.all([
			renewExhaustedObservationRun(prisma, input),
			renewExhaustedObservationRun(prisma, input),
		]);
		expect(results.sort()).toEqual(["deferred", "renewed"]);
	});

	it("allows one concurrent claim and rejects stale-token writes", async () => {
		const prisma = await database();
		const run = await createOrLoadObservationRun(prisma, { authority, units: [units[0]!] });
		const now = new Date("2026-09-06T00:00:00.000Z");
		const claims = await Promise.all([
			claimObservationUnit(prisma, { runId: run.id, now }),
			claimObservationUnit(prisma, { runId: run.id, now }),
		]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		const claim = claims.find(Boolean)!;
		expect(
			await advanceObservationUnit(prisma, {
				claim,
				cursor: 2,
				expectedRawCount: 2,
				observedRawCount: 2,
			}),
		).toBe(true);
		expect(
			await completeObservationUnit(prisma, {
				claim: { ...claim, claimToken: "stale-token" },
				expectedRawCount: 2,
				observedRawCount: 2,
			}),
		).toBe(false);
		expect(
			await completeObservationUnit(prisma, { claim, expectedRawCount: 2, observedRawCount: 2 }),
		).toBe(true);
		const stored = await prisma.providerObservationUnit.findUnique({ where: { id: claim.unitId } });
		expect(stored?.state).toBe("complete");
	});

	it("increments completed counters exactly once per unit and clears the active slot at terminal completion", async () => {
		const prisma = await database();
		const run = await createOrLoadObservationRun(prisma, { authority, units });
		const now = new Date("2026-09-06T00:00:00.000Z");
		const first = await claimObservationUnit(prisma, { runId: run.id, now });
		expect(
			await completeObservationUnit(prisma, {
				claim: first!,
				expectedRawCount: 2,
				observedRawCount: 2,
			}),
		).toBe(true);
		expect(
			await completeObservationUnit(prisma, {
				claim: first!,
				expectedRawCount: 2,
				observedRawCount: 2,
			}),
		).toBe(false);
		expect(await prisma.providerObservationRun.findUnique({ where: { id: run.id } })).toMatchObject(
			{ completedUnits: 1, completedWork: 2, state: "running" },
		);
		const second = await claimObservationUnit(prisma, { runId: run.id, now });
		expect(
			await completeObservationUnit(prisma, {
				claim: second!,
				expectedRawCount: 1,
				observedRawCount: 1,
			}),
		).toBe(true);
		expect(await prisma.providerObservationRun.findUnique({ where: { id: run.id } })).toMatchObject(
			{ completedUnits: 2, completedWork: 3, state: "complete", activeSlotKey: null },
		);
	});

	it("applies exact retry boundaries and exhausts ordinary continuation after three failures", async () => {
		const prisma = await database();
		const run = await createOrLoadObservationRun(prisma, { authority, units: [units[0]!] });
		let now = new Date("2026-09-06T00:00:00.000Z");
		for (const delay of [30_000, 120_000, 600_000]) {
			const claim = await claimObservationUnit(prisma, { runId: run.id, now });
			expect(claim).not.toBeNull();
			expect(
				await failObservationUnit(prisma, {
					claim: claim!,
					reasonCode: "provider-unavailable",
					now,
				}),
			).toBe(true);
			const stored = await prisma.providerObservationUnit.findUnique({
				where: { id: claim!.unitId },
			});
			expect(stored?.nextAttemptAt).toEqual(new Date(now.getTime() + delay));
			now = new Date(now.getTime() + delay);
		}
		const fourth = await claimObservationUnit(prisma, { runId: run.id, now });
		expect(fourth).not.toBeNull();
		expect(
			await failObservationUnit(prisma, {
				claim: fourth!,
				reasonCode: "provider-unavailable",
				now,
			}),
		).toBe(true);
		expect(await claimObservationUnit(prisma, { runId: run.id, now })).toBeNull();
		const resumed = await createOrLoadObservationRun(prisma, {
			authority,
			units: [units[0]!],
			resumeFailed: true,
		});
		expect(resumed.id).toBe(run.id);
		expect((await claimObservationUnit(prisma, { runId: run.id, now }))?.unitId).toBeDefined();
	});

	it("blocks every other unit through four failures and retries only the scheduled unit", async () => {
		const prisma = await database();
		const run = await createOrLoadObservationRun(prisma, { authority, units });
		let now = new Date("2026-09-06T00:00:00.000Z");
		const first = await claimObservationUnit(prisma, { runId: run.id, now });
		expect(first?.scopeKey).toBe("scope:one");
		expect(await claimObservationUnit(prisma, { runId: run.id, now })).toBeNull();
		let claim = first;
		for (const delay of [30_000, 120_000, 600_000]) {
			expect(
				await failObservationUnit(prisma, {
					claim: claim!,
					reasonCode: "provider-unavailable",
					now,
				}),
			).toBe(true);
			const due = new Date(now.getTime() + delay);
			expect(
				await claimObservationUnit(prisma, { runId: run.id, now: new Date(due.getTime() - 1) }),
			).toBeNull();
			now = due;
			claim = await claimObservationUnit(prisma, { runId: run.id, now });
			expect(claim?.unitId).toBe(first?.unitId);
			expect(await claimObservationUnit(prisma, { runId: run.id, now })).toBeNull();
		}
		expect(
			await failObservationUnit(prisma, {
				claim: claim!,
				reasonCode: "provider-unavailable",
				now,
			}),
		).toBe(true);
		expect(await claimObservationUnit(prisma, { runId: run.id, now })).toBeNull();
		expect(
			await prisma.$transaction(
				async (tx) =>
					await hasExhaustedObservationRunRetries(tx, {
						runId: run.id,
						authorityKey: run.authorityKey,
					}),
			),
		).toBe(true);
		await prisma.providerObservationRun.update({
			where: { id: run.id },
			data: { totalWork: { increment: 1 } },
		});
		expect(
			await prisma.$transaction(
				async (tx) =>
					await hasExhaustedObservationRunRetries(tx, {
						runId: run.id,
						authorityKey: run.authorityKey,
					}),
			),
		).toBe(false);
		await prisma.providerObservationRun.update({
			where: { id: run.id },
			data: { totalWork: { decrement: 1 } },
		});
		const pending = await prisma.providerObservationUnit.findFirst({
			where: { runId: run.id, ordinal: 1 },
		});
		expect(pending?.state).toBe("pending");
		await prisma.providerObservationUnit.update({
			where: { id: pending!.id },
			data: { state: "corrupt" },
		});
		expect(
			await prisma.$transaction(
				async (tx) =>
					await hasExhaustedObservationRunRetries(tx, {
						runId: run.id,
						authorityKey: run.authorityKey,
					}),
			),
		).toBe(false);
		await prisma.providerObservationUnit.update({
			where: { id: pending!.id },
			data: { state: "pending" },
		});
		await createOrLoadObservationRun(prisma, { authority, units, resumeFailed: true });
		expect(
			await prisma.$transaction(
				async (tx) =>
					await hasExhaustedObservationRunRetries(tx, {
						runId: run.id,
						authorityKey: run.authorityKey,
					}),
			),
		).toBe(false);
		expect((await claimObservationUnit(prisma, { runId: run.id, now }))?.unitId).toBe(
			first?.unitId,
		);
	});

	it("renews a lease only for the exact token and expiry boundary", async () => {
		const prisma = await database();
		const run = await createOrLoadObservationRun(prisma, { authority, units: [units[0]!] });
		const started = new Date("2026-09-06T00:00:00.000Z");
		const claim = await claimObservationUnit(prisma, { runId: run.id, now: started });
		expect(claim).not.toBeNull();
		const renewed = new Date(started.getTime() + 10 * 60 * 1000);
		expect(
			await advanceObservationUnit(prisma, {
				claim: { ...claim!, claimToken: "stale" },
				cursor: 1,
				expectedRawCount: 1,
				observedRawCount: 1,
				now: renewed,
			}),
		).toBe(false);
		expect(
			await advanceObservationUnit(prisma, {
				claim: claim!,
				cursor: 1,
				expectedRawCount: 1,
				observedRawCount: 1,
				now: renewed,
			}),
		).toBe(true);
		expect(
			(await prisma.providerObservationUnit.findUnique({ where: { id: claim!.unitId } }))
				?.nextAttemptAt,
		).toEqual(new Date(renewed.getTime() + 60 * 60 * 1000));
		expect(
			await claimObservationUnit(prisma, {
				runId: run.id,
				now: new Date(started.getTime() + 60 * 60 * 1000),
			}),
		).toBeNull();
		const renewedClaim = await claimObservationUnit(prisma, {
			runId: run.id,
			now: new Date(renewed.getTime() + 60 * 60 * 1000),
		});
		expect(renewedClaim).not.toBeNull();
		const before = await prisma.providerObservationUnit.findUnique({
			where: { id: claim!.unitId },
		});
		expect(
			await advanceObservationUnit(prisma, {
				claim: claim!,
				cursor: 9,
				expectedRawCount: 9,
				observedRawCount: 9,
			}),
		).toBe(false);
		expect(
			await failObservationUnit(prisma, {
				claim: claim!,
				reasonCode: "provider-unavailable",
				now: new Date(renewed.getTime() + 60 * 60 * 1000),
			}),
		).toBe(false);
		expect(
			await completeObservationUnit(prisma, {
				claim: claim!,
				expectedRawCount: 9,
				observedRawCount: 9,
			}),
		).toBe(false);
		expect(
			await prisma.providerObservationUnit.findUnique({ where: { id: claim!.unitId } }),
		).toEqual(before);
	});

	it("invalidates the active slot and permits a replacement with the same authority", async () => {
		const prisma = await database();
		const first = await createOrLoadObservationRun(prisma, { authority, units });
		expect(await invalidateObservationRuns(prisma, { instanceId: authority.instanceId })).toBe(1);
		expect(
			(await prisma.providerObservationRun.findUnique({ where: { id: first.id } }))?.activeSlotKey,
		).toBeNull();
		const replacement = await createOrLoadObservationRun(prisma, { authority, units });
		expect(replacement.id).not.toBe(first.id);
	});

	it("does not steal a live lease and reclaims it only at the exact expiry", async () => {
		const prisma = await database();
		const run = await createOrLoadObservationRun(prisma, { authority, units: [units[0]!] });
		const started = new Date("2026-09-06T00:00:00.000Z");
		const claim = await claimObservationUnit(prisma, { runId: run.id, now: started });
		expect(claim).not.toBeNull();
		const halfLease = new Date(started.getTime() + 59 * 60 * 1000);
		expect(await claimObservationUnit(prisma, { runId: run.id, now: halfLease })).toBeNull();
		expect(
			await claimObservationUnit(prisma, {
				runId: run.id,
				now: new Date(started.getTime() + 60 * 60 * 1000),
			}),
		).not.toBeNull();
	});

	it("holds Jellyfin verify units until every collect unit is complete", async () => {
		const prisma = await database();
		const jellyfinAuthority = {
			...authority,
			provider: "jellyfin_episode" as const,
			cacheType: "jellyfin_episode" as const,
		};
		const run = await createOrLoadObservationRun(prisma, {
			authority: jellyfinAuthority,
			units: [
				{
					ordinal: 0,
					scopeKey: "collect",
					scopeDigest: "d".repeat(64),
					phase: "collect",
					expectedTargets: 1,
				},
				{
					ordinal: 1,
					scopeKey: "verify",
					scopeDigest: "e".repeat(64),
					phase: "verify",
					expectedTargets: 1,
				},
			],
		});
		const now = new Date("2026-09-06T00:00:00.000Z");
		expect(await claimObservationUnit(prisma, { runId: run.id, now })).not.toBeNull();
		// The first claim is collect; verify remains unavailable until collect finalizes.
		expect(await claimObservationUnit(prisma, { runId: run.id, now })).toBeNull();
	});

	it("startup recovery refuses to release an unmatched inherited claim", async () => {
		const prisma = await database();
		const run = await createOrLoadObservationRun(prisma, { authority, units: [units[0]!] });
		const started = new Date("2026-09-06T00:00:00.000Z");
		const claim = await claimObservationUnit(prisma, { runId: run.id, now: started });
		expect(claim).not.toBeNull();
		await prisma.providerObservationUnit.update({
			where: { id: claim!.unitId },
			data: { cursor: 7, expectedRawCount: 5, observedRawCount: 4, attemptCount: 2 },
		});
		await prisma.plexEpisodeObservationStage.create({
			data: {
				runId: run.id,
				unitId: claim!.unitId,
				showTmdbId: 1,
				parentRatingKey: "parent",
				seasonNumber: 1,
				episodeNumber: 1,
				ratingKey: "recovery-stage",
				title: "Episode",
				watched: false,
				watchedByUsers: "[]",
				watchCount: 0,
				refreshedAt: started,
				sourceFingerprint: "recovery-fingerprint",
			},
		});
		await expect(recoverAbandonedObservationRuns(prisma)).rejects.toThrow(
			"unmatched provider observation claim",
		);
		expect(
			await prisma.providerObservationUnit.findUnique({ where: { id: claim!.unitId } }),
		).toMatchObject({
			state: "running",
			claimToken: claim!.claimToken,
			cursor: 7,
			expectedRawCount: 5,
			observedRawCount: 4,
			attemptCount: 2,
		});
		expect(await claimObservationUnit(prisma, { runId: run.id, now: started })).toBeNull();
		expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(1);
		const mismatched = await createOrLoadObservationRun(prisma, {
			authority: { ...authority, targetDigest: "f".repeat(64) },
			units: [units[0]!],
		});
		await prisma.serviceInstance.update({
			where: { id: authority.instanceId },
			data: { connectionGeneration: 9 },
		});
		expect(await recoverAbandonedObservationRuns(prisma)).toBe(1);
		expect(
			(await prisma.providerObservationRun.findUnique({ where: { id: mismatched.id } }))?.state,
		).toBe("invalidated");
		const currentAuthority = {
			...authority,
			connectionGeneration: 9,
			targetDigest: "1".repeat(64),
		};
		const current = await createOrLoadObservationRun(prisma, {
			authority: currentAuthority,
			units: [units[0]!],
		});
		await expect(
			createOrLoadObservationRun(prisma, { authority, units: [units[0]!] }),
		).rejects.toThrow();
		expect(
			(await prisma.providerObservationRun.findUnique({ where: { id: current.id } }))?.state,
		).toBe("running");
		await prisma.serviceInstance.update({
			where: { id: authority.instanceId },
			data: { connectionGeneration: 10 },
		});
		expect(await claimObservationUnit(prisma, { runId: current.id, now: started })).toBeNull();
		expect(
			(await prisma.providerObservationRun.findUnique({ where: { id: current.id } }))?.state,
		).toBe("invalidated");
	});

	it("preserves completed progress and stages when resuming a failed unit", async () => {
		const prisma = await database();
		const run = await createOrLoadObservationRun(prisma, { authority, units });
		const now = new Date("2026-09-06T00:00:00.000Z");
		const first = await claimObservationUnit(prisma, { runId: run.id, now });
		expect(
			await completeObservationUnit(prisma, {
				claim: first!,
				expectedRawCount: 2,
				observedRawCount: 2,
			}),
		).toBe(true);
		await prisma.plexEpisodeObservationStage.create({
			data: {
				runId: run.id,
				unitId: first!.unitId,
				showTmdbId: 1,
				parentRatingKey: "parent",
				seasonNumber: 1,
				episodeNumber: 1,
				ratingKey: "episode",
				title: "Episode",
				watched: true,
				watchedByUsers: "[]",
				watchCount: 1,
				refreshedAt: now,
				sourceFingerprint: "fingerprint",
			},
		});
		await prisma.jellyfinEpisodeObservationExclusion.create({
			data: {
				runId: run.id,
				unitId: first!.unitId,
				userKeyDigest: "resume-user",
				pass: "collect",
				jellyfinId: "resume-excluded-episode",
				reason: "missing-episode-metadata",
			},
		});
		let second = await claimObservationUnit(prisma, { runId: run.id, now });
		for (const delay of [30_000, 120_000, 600_000]) {
			expect(second).not.toBeNull();
			await failObservationUnit(prisma, {
				claim: second!,
				reasonCode: "provider-unavailable",
				now,
			});
			second = await claimObservationUnit(prisma, {
				runId: run.id,
				now: new Date(now.getTime() + delay),
			});
		}
		expect(second).not.toBeNull();
		await failObservationUnit(prisma, { claim: second!, reasonCode: "provider-unavailable", now });
		await createOrLoadObservationRun(prisma, { authority, units, resumeFailed: true });
		expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(1);
		expect(
			await prisma.jellyfinEpisodeObservationExclusion.count({ where: { runId: run.id } }),
		).toBe(1);
		expect(
			(await prisma.providerObservationUnit.findUnique({ where: { id: first!.unitId } }))?.state,
		).toBe("complete");
	});

	it("resets only the claimed unit after a rejected page and rejects stale-token deletion", async () => {
		const prisma = await database();
		const run = await createOrLoadObservationRun(prisma, { authority, units });
		const started = new Date("2026-09-06T00:00:00.000Z");
		const first = await claimObservationUnit(prisma, { runId: run.id, now: started });
		expect(first).not.toBeNull();
		expect(
			await advanceObservationUnit(prisma, {
				claim: first!,
				cursor: 7,
				expectedRawCount: 11,
				observedRawCount: 7,
			}),
		).toBe(true);
		const second = await prisma.providerObservationUnit.findFirst({
			where: { runId: run.id, ordinal: 1 },
		});
		await prisma.providerObservationUnit.update({
			where: { id: second!.id },
			data: { state: "complete", cursor: 1, expectedRawCount: 1, observedRawCount: 1 },
		});
		await prisma.providerObservationRun.update({
			where: { id: run.id },
			data: { completedUnits: 1, completedWork: 1 },
		});
		const refreshedAt = new Date("2026-09-06T00:01:00.000Z");
		for (const unitId of [first!.unitId, second!.id]) {
			await prisma.plexEpisodeObservationStage.create({
				data: {
					runId: run.id,
					unitId,
					showTmdbId: unitId === first!.unitId ? 1 : 2,
					parentRatingKey: `parent-${unitId}`,
					seasonNumber: 1,
					episodeNumber: 1,
					ratingKey: `episode-${unitId}`,
					title: "Episode",
					watched: true,
					watchedByUsers: "[]",
					watchCount: 1,
					refreshedAt,
					sourceFingerprint: `fingerprint-${unitId}`,
				},
			});
			await prisma.jellyfinEpisodeObservationStage.create({
				data: {
					runId: run.id,
					unitId,
					userKeyDigest: `user-${unitId}`,
					pass: "collect",
					jellyfinId: `jelly-${unitId}`,
					seriesId: "series",
					seasonNumber: 1,
					episodeNumber: 1,
					title: "Episode",
					played: true,
					playCount: 1,
					lastPlayedAt: refreshedAt,
					userName: "user",
				},
			});
			await prisma.jellyfinEpisodeObservationExclusion.create({
				data: {
					runId: run.id,
					unitId,
					userKeyDigest: `user-${unitId}`,
					pass: "collect",
					jellyfinId: `excluded-${unitId}`,
					reason: "missing-episode-metadata",
				},
			});
		}

		const retryAt = new Date(started.getTime() + 30_000);
		expect(
			await failObservationUnit(prisma, {
				claim: first!,
				reasonCode: "coverage-incomplete",
				now: started,
				resetProgress: true,
			}),
		).toBe(true);
		expect(
			await prisma.providerObservationUnit.findUnique({ where: { id: first!.unitId } }),
		).toMatchObject({
			state: "failed",
			cursor: 0,
			expectedRawCount: null,
			observedRawCount: 0,
			attemptCount: 1,
			nextAttemptAt: retryAt,
			lastReasonCode: "coverage-incomplete",
		});
		expect(await prisma.providerObservationRun.findUnique({ where: { id: run.id } })).toMatchObject(
			{ state: "failed", nextAttemptAt: retryAt },
		);
		const remainingPlexRows = await prisma.plexEpisodeObservationStage.findMany();
		expect(remainingPlexRows).toHaveLength(1);
		expect(remainingPlexRows[0]?.unitId).toBe(second!.id);
		const remainingJellyfinRows = await prisma.jellyfinEpisodeObservationStage.findMany();
		expect(remainingJellyfinRows).toHaveLength(1);
		expect(remainingJellyfinRows[0]?.unitId).toBe(second!.id);
		const remainingExclusions = await prisma.jellyfinEpisodeObservationExclusion.findMany();
		expect(remainingExclusions).toHaveLength(1);
		expect(remainingExclusions[0]?.unitId).toBe(second!.id);
		expect(
			await prisma.providerObservationUnit.findUnique({ where: { id: second!.id } }),
		).toMatchObject({ state: "complete", cursor: 1, expectedRawCount: 1, observedRawCount: 1 });

		const reclaimed = await claimObservationUnit(prisma, { runId: run.id, now: retryAt });
		expect(reclaimed).not.toBeNull();
		await prisma.plexEpisodeObservationStage.create({
			data: {
				runId: run.id,
				unitId: reclaimed!.unitId,
				showTmdbId: 3,
				parentRatingKey: "parent-new",
				seasonNumber: 1,
				episodeNumber: 2,
				ratingKey: "episode-new",
				title: "New evidence",
				watched: false,
				watchedByUsers: "[]",
				watchCount: 0,
				refreshedAt: retryAt,
				sourceFingerprint: "new-fingerprint",
			},
		});
		expect(
			await failObservationUnit(prisma, {
				claim: { ...reclaimed!, claimToken: "stale-token" },
				reasonCode: "coverage-incomplete",
				now: retryAt,
				resetProgress: true,
			}),
		).toBe(false);
		expect(
			await prisma.plexEpisodeObservationStage.count({ where: { unitId: reclaimed!.unitId } }),
		).toBe(1);
		expect(
			await prisma.providerObservationUnit.findUnique({ where: { id: reclaimed!.unitId } }),
		).toMatchObject({ state: "running", claimToken: reclaimed!.claimToken, cursor: 0 });
	});

	it("deletes both provider staging tables and clears claims during invalidation", async () => {
		const prisma = await database();
		const run = await createOrLoadObservationRun(prisma, { authority, units: [units[0]!] });
		const claim = await claimObservationUnit(prisma, {
			runId: run.id,
			now: new Date("2026-09-06T00:00:00.000Z"),
		});
		const at = new Date("2026-09-06T00:00:00.000Z");
		await prisma.plexEpisodeObservationStage.create({
			data: {
				runId: run.id,
				unitId: claim!.unitId,
				showTmdbId: 1,
				parentRatingKey: "parent",
				seasonNumber: 1,
				episodeNumber: 1,
				ratingKey: "ep",
				title: "Episode",
				watched: true,
				watchedByUsers: "[]",
				watchCount: 1,
				refreshedAt: at,
				sourceFingerprint: "fp",
			},
		});
		await prisma.jellyfinEpisodeObservationStage.create({
			data: {
				runId: run.id,
				unitId: claim!.unitId,
				userKeyDigest: "user",
				pass: "collect",
				jellyfinId: "jelly",
				seriesId: "series",
				seasonNumber: 1,
				episodeNumber: 1,
				title: "Episode",
				played: true,
				playCount: 1,
				lastPlayedAt: at,
				userName: "user",
			},
		});
		await prisma.jellyfinEpisodeObservationExclusion.create({
			data: {
				runId: run.id,
				unitId: claim!.unitId,
				userKeyDigest: "user",
				pass: "collect",
				jellyfinId: "excluded-jelly",
				reason: "missing-episode-metadata",
			},
		});
		expect(await invalidateObservationRuns(prisma, { instanceId: authority.instanceId })).toBe(1);
		expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(0);
		expect(await prisma.jellyfinEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(
			0,
		);
		expect(
			await prisma.jellyfinEpisodeObservationExclusion.count({ where: { runId: run.id } }),
		).toBe(0);
		expect(
			await prisma.providerObservationUnit.findUnique({ where: { id: claim!.unitId } }),
		).toMatchObject({ state: "invalidated", claimToken: null, nextAttemptAt: null });
	});
});
