import { afterEach, describe, expect, it } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	interceptScopedWriteCompetition,
	recordScopedWriteEvidence,
} from "../../__tests__/scoped-write-intent-fixture.js";
import {
	claimObservationUnit,
	createOrLoadObservationRun,
} from "../../provider-observation/observation-run-repository.js";
import {
	buildJellyfinEpisodeScopePlan,
	stageJellyfinEpisodePage,
} from "../jellyfin-episode-refresh-repository.js";

afterEach(closeScopedWriteFixtures);

async function stagingFixture() {
	const f = await createScopedWriteFixture();
	const scope = {
		userId: "synthetic-viewer",
		userName: "Synthetic",
		libraryId: "synthetic-library",
	};
	const plan = buildJellyfinEpisodeScopePlan([scope]);
	const run = await createOrLoadObservationRun(f.plain, {
		authority: {
			provider: "jellyfin_episode",
			cacheType: "jellyfin_episode",
			instanceId: "synthetic-jellyfin",
			parentGenerationId: "synthetic-parent",
			targetDigest: plan.targetDigest,
			connectionGeneration: 1,
			identityGeneration: 1,
		},
		units: plan.units,
	});
	const now = new Date("2026-10-30T00:00:00.000Z");
	const claim = await claimObservationUnit(f.plain, {
		runId: run.id,
		now,
		claimToken: "synthetic-claim",
	});
	if (!claim) throw new Error("Synthetic stage fixture did not produce a claim");
	const page = {
		startIndex: 0,
		totalRecordCount: 1,
		items: [
			{
				type: "Episode" as const,
				id: "synthetic-episode",
				name: "Synthetic",
				seriesId: "synthetic-series",
				seasonNumber: 1,
				episodeNumber: 1,
				played: false,
				playCount: null,
				lastPlayedDate: null,
			},
		],
	};
	return { f, scope, run, now, claim, page };
}

describe("Jellyfin page staging WAL write intent", { timeout: 30_000 }, () => {
	// Removing only staging's scoped reservation must fail at its real stage
	// INSERT, before cursor/unit/run progress or any cache publication changes.
	it("stages a real claimed episode page through ordinary guarded runtime under WAL competition", async () => {
		const { f, scope, run, now, claim, page } = await stagingFixture();
		const unitBefore = await f.plain.providerObservationUnit.findUniqueOrThrow({
			where: { id: claim.unitId },
		});
		const runBefore = await f.plain.providerObservationRun.findUniqueOrThrow({
			where: { id: run.id },
		});
		const competition = interceptScopedWriteCompetition(f, { compete: true });
		let failure: unknown;
		let result: unknown;
		try {
			result = await f.runtime.runOperation(() =>
				stageJellyfinEpisodePage(f.client.prisma, claim, scope, page, now),
			);
		} catch (error) {
			failure = error;
		}
		recordScopedWriteEvidence("stage", {
			competition,
			error:
				failure instanceof Error
					? { name: failure.name, code: Reflect.get(failure, "code") }
					: null,
			result,
		});
		expect(competition.commits + competition.blocked).toBe(1);
		if (failure) {
			expect(
				await f.plain.providerObservationUnit.findUniqueOrThrow({ where: { id: claim!.unitId } }),
			).toEqual(unitBefore);
			expect(
				await f.plain.providerObservationRun.findUniqueOrThrow({ where: { id: run.id } }),
			).toEqual(runBefore);
			expect(await f.plain.jellyfinEpisodeObservationStage.count()).toBe(0);
			expect(competition.rollbacks).toBeGreaterThan(0);
		}
		expect(
			failure,
			"real Jellyfin staging should survive the controlled competing WAL attempt",
		).toBeUndefined();
		expect(result).toBe(true);
		expect(await f.plain.jellyfinEpisodeObservationStage.findMany()).toEqual([
			expect.objectContaining({
				runId: run.id,
				unitId: claim!.unitId,
				jellyfinId: "synthetic-episode",
				pass: "collect",
			}),
		]);
		expect(
			await f.plain.providerObservationUnit.findUniqueOrThrow({ where: { id: claim!.unitId } }),
		).toMatchObject({
			state: "complete",
			claimToken: null,
			cursor: 1,
			observedRawCount: 1,
			expectedRawCount: 1,
			completedPages: 1,
		});
		expect(
			await f.plain.providerObservationRun.findUniqueOrThrow({ where: { id: run.id } }),
		).toMatchObject({
			completedUnits: 1,
			completedWork: 1,
			authorityKey: runBefore.authorityKey,
			activeSlotKey: runBefore.activeSlotKey,
		});
		expect(await f.plain.jellyfinEpisodeCache.count()).toBe(0);
		expect(f.losses).toEqual([]);
	});

	// Reservation must not accept a superseded run, stale unit claim or changed
	// provider identity generation, nor advance progress on these rejections.
	it.each(["run", "unit-claim", "identity-generation"] as const)(
		"preserves stage and progress when %s authority changes",
		async (kind) => {
			const { f, scope, run, now, claim, page } = await stagingFixture();
			if (kind === "run")
				await f.plain.providerObservationRun.update({
					where: { id: run.id },
					data: { state: "invalidated", activeSlotKey: null },
				});
			if (kind === "unit-claim")
				await f.plain.providerObservationUnit.update({
					where: { id: claim.unitId },
					data: { claimToken: "synthetic-other-claim" },
				});
			if (kind === "identity-generation")
				await f.plain.serviceInstance.update({
					where: { id: "synthetic-jellyfin" },
					data: { identityGeneration: 2 },
				});
			const runBefore = await f.plain.providerObservationRun.findUniqueOrThrow({
				where: { id: run.id },
			});
			const unitBefore = await f.plain.providerObservationUnit.findUniqueOrThrow({
				where: { id: claim.unitId },
			});
			const rejected: string[] = [];
			const result = await f.runtime.runOperation(() =>
				stageJellyfinEpisodePage(f.client.prisma, claim, scope, page, now, (reason) =>
					rejected.push(reason),
				),
			);
			expect(result).toBe(false);
			expect(rejected).toEqual([
				kind === "run"
					? "run-unavailable"
					: kind === "unit-claim"
						? "claim-mismatch"
						: "instance-authority-mismatch",
			]);
			expect(
				await f.plain.providerObservationRun.findUniqueOrThrow({ where: { id: run.id } }),
			).toEqual(runBefore);
			expect(
				await f.plain.providerObservationUnit.findUniqueOrThrow({ where: { id: claim.unitId } }),
			).toEqual(unitBefore);
			expect(await f.plain.jellyfinEpisodeObservationStage.count()).toBe(0);
			expect(await f.plain.jellyfinEpisodeCache.count()).toBe(0);
			expect(f.losses).toEqual([]);
		},
	);
});
