import { afterEach, describe, expect, it } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	snapshotProtectedRows,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { claimObservationUnit } from "../../provider-observation/observation-run-repository.js";
import type { JellyfinEpisodeItemsPage } from "../jellyfin-client.js";
import {
	buildJellyfinEpisodeScopePlan,
	stageJellyfinEpisodePage,
} from "../jellyfin-episode-refresh-repository.js";

afterEach(closeScopedWriteFixtures);

async function fullPageFixture() {
	const f = await createScopedWriteFixture();
	const scope = { userId: "synthetic-viewer", libraryId: "synthetic-library", userName: "" };
	const plan = buildJellyfinEpisodeScopePlan([scope], undefined, 2_000);
	const run = await f.plain.providerObservationRun.create({
		data: {
			instanceId: "synthetic-jellyfin",
			provider: "jellyfin_episode",
			cacheType: "jellyfin_episode",
			authorityKey: "synthetic-authority",
			activeSlotKey: "synthetic-active-slot",
			targetDigest: plan.targetDigest,
			targetCount: 1,
			connectionGeneration: 1,
			identityGeneration: 1,
			state: "running",
			totalUnits: 2,
			totalWork: 1,
			units: { create: plan.units.map((unit) => ({ ...unit, state: "pending" })) },
		},
	});
	const claim = await claimObservationUnit(f.plain, { runId: run.id, now: new Date() });
	if (!claim) throw new Error("Synthetic claim missing");
	const page: JellyfinEpisodeItemsPage = {
		startIndex: 0,
		totalRecordCount: 2_001,
		items: Array.from({ length: 2_000 }, (_, i) => ({
			id: `synthetic-episode-${i}`,
			name: "Synthetic episode",
			type: "Episode",
			seriesId: "synthetic-series",
			seasonNumber: 1,
			episodeNumber: i + 1,
			played: false,
			playCount: 0,
			lastPlayedDate: null,
		})),
	};
	await f.runtime.runOperation(() => f.client.prisma.$connect());
	return { f, scope, run, claim, page };
}

describe("guarded full-size Jellyfin episode staging", { timeout: 20_000 }, () => {
	// Catches a real guarded adapter/parameter/transaction regression at the
	// production page size; a plain unguarded Prisma fixture cannot prove this.
	it("commits 2000 rows and advances only the matching claim without publishing", async () => {
		const { f, scope, run, claim, page } = await fullPageFixture();
		const before = snapshotProtectedRows(f);
		await expect(
			f.runtime.runOperation(() => stageJellyfinEpisodePage(f.client.prisma, claim, scope, page)),
		).resolves.toBe(true);
		expect(await f.plain.jellyfinEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(
			2_000,
		);
		expect(
			await f.plain.providerObservationUnit.findUnique({ where: { id: claim.unitId } }),
		).toMatchObject({
			state: "pending",
			claimToken: null,
			cursor: 2_000,
			observedRawCount: 2_000,
			completedPages: 1,
			attemptCount: 0,
		});
		expect(await f.plain.jellyfinEpisodeCache.count()).toBe(0);
		expect(snapshotProtectedRows(f)).toEqual(before);
		expect(f.losses).toEqual([]);
	});

	// Catches a failed BEGIN/write reservation consuming the claim, leaving a
	// transaction open, or preventing the identical page from being retried.
	it("preserves the exact claim after a held writer and stages it after rollback", async () => {
		const { f, scope, run, claim, page } = await fullPageFixture();
		const before = snapshotProtectedRows(f);
		f.writer.exec("BEGIN IMMEDIATE");
		try {
			await expect(
				f.runtime.runOperation(() => stageJellyfinEpisodePage(f.client.prisma, claim, scope, page)),
			).rejects.toMatchObject({
				code: "P1008",
				meta: { driverAdapterError: { cause: { originalCode: "SQLITE_BUSY" } } },
			});
		} finally {
			f.writer.exec("ROLLBACK");
		}
		expect(await f.plain.jellyfinEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(
			0,
		);
		expect(
			await f.plain.providerObservationUnit.findUnique({ where: { id: claim.unitId } }),
		).toMatchObject({
			state: "running",
			claimToken: claim.claimToken,
			cursor: 0,
			completedPages: 0,
			attemptCount: 0,
		});
		await expect(
			f.runtime.runOperation(() => stageJellyfinEpisodePage(f.client.prisma, claim, scope, page)),
		).resolves.toBe(true);
		expect(await f.plain.jellyfinEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(
			2_000,
		);
		expect(await f.plain.jellyfinEpisodeCache.count()).toBe(0);
		expect(snapshotProtectedRows(f)).toEqual(before);
		expect(f.losses).toEqual([]);
	});
});
