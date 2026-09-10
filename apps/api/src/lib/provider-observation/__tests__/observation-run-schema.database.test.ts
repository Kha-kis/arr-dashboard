import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";

const schemaPath = join(process.cwd(), "prisma", "schema.prisma");
type ObservationDelegate<T> = {
	create(args: { data: Record<string, unknown> }): Promise<T>;
	count(): Promise<number>;
};

type ObservationPrisma = {
	providerObservationRun: ObservationDelegate<{ id: string }>;
	providerObservationUnit: ObservationDelegate<{ id: string }>;
	plexEpisodeObservationStage: ObservationDelegate<{ id: string }>;
	jellyfinEpisodeObservationStage: ObservationDelegate<{ id: string }>;
};

function pushSchema(databasePath: string): void {
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", schemaPath], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		stdio: "ignore",
	});
}

describe("provider observation run schema", () => {
	it("cascades service deletion and rejects cross-run unit ownership", async () => {
		const directory = mkdtempSync(join(tmpdir(), "provider-observation-schema-"));
		const databasePath = join(directory, "test.db");
		const prisma = createTestPrismaClient(databasePath);

		try {
			pushSchema(databasePath);
			const user = await prisma.user.create({ data: { username: "observation-schema-user" } });
			const instance = await prisma.serviceInstance.create({
				data: {
					userId: user.id,
					service: "PLEX",
					label: "observation-schema-instance",
					baseUrl: "http://127.0.0.1:32400",
					encryptedApiKey: "encrypted",
					encryptionIv: "iv",
				},
			});
			const observation = prisma as unknown as ObservationPrisma;
			const run = await observation.providerObservationRun.create({
				data: {
					instanceId: instance.id,
					provider: "plex_episode",
					cacheType: "plex_episode",
					authorityKey: "a".repeat(64),
					activeSlotKey: "c".repeat(64),
					parentGenerationId: "parent-1",
					targetDigest: "b".repeat(64),
					targetCount: 2,
					connectionGeneration: 4,
					identityGeneration: 7,
					state: "running",
					totalUnits: 1,
					completedUnits: 0,
					totalWork: 2,
					completedWork: 0,
				},
			});
			const firstUnit = await observation.providerObservationUnit.create({
				data: {
					runId: run.id,
					ordinal: 0,
					scopeKey: "scope-1",
					scopeDigest: "d".repeat(64),
					scopePayload: '{"ratingKey":"parent-1"}',
					phase: "collect",
					expectedTargets: 2,
					cursor: 0,
					observedRawCount: 0,
					state: "pending",
				},
			});
			const secondUnit = await observation.providerObservationUnit.create({
				data: {
					runId: run.id,
					ordinal: 1,
					scopeKey: "scope-2",
					scopeDigest: "e".repeat(64),
					phase: "collect",
					expectedTargets: 2,
					cursor: 0,
					observedRawCount: 0,
					state: "pending",
				},
			});
			const otherRun = await observation.providerObservationRun.create({
				data: {
					instanceId: instance.id,
					provider: "plex_episode",
					cacheType: "plex_episode",
					authorityKey: "f".repeat(64),
					targetDigest: "g".repeat(64),
					targetCount: 1,
					connectionGeneration: 4,
					identityGeneration: 7,
					state: "running",
					totalUnits: 1,
					totalWork: 1,
				},
			});
			const otherUnit = await observation.providerObservationUnit.create({
				data: {
					runId: otherRun.id,
					ordinal: 0,
					scopeKey: "other-scope",
					scopeDigest: "h".repeat(64),
					phase: "collect",
					expectedTargets: 1,
					state: "pending",
				},
			});

			const refreshedAt = new Date("2026-09-06T00:00:00.000Z");
			await observation.plexEpisodeObservationStage.create({
				data: {
					runId: run.id,
					unitId: firstUnit.id,
					showTmdbId: 1,
					parentRatingKey: "parent-1",
					seasonNumber: 1,
					episodeNumber: 1,
					ratingKey: "episode-1",
					title: "Episode",
					watched: true,
					watchedByUsers: "[]",
					lastWatchedAt: refreshedAt,
					watchCount: 1,
					refreshedAt,
					sourceFingerprint: "fingerprint-1",
				},
			});
			await observation.jellyfinEpisodeObservationStage.create({
				data: {
					runId: run.id,
					unitId: secondUnit.id,
					userKeyDigest: "user-digest",
					pass: "head",
					jellyfinId: "episode-2",
					seriesId: "series-1",
					seasonNumber: 1,
					episodeNumber: 2,
					title: "Episode two",
					played: true,
					playCount: 1,
					lastPlayedAt: refreshedAt,
					userName: "test-user",
				},
			});

			await expect(
				observation.plexEpisodeObservationStage.create({
					data: {
						runId: run.id,
						unitId: otherUnit.id,
						showTmdbId: 2,
						parentRatingKey: "parent-2",
						seasonNumber: 1,
						episodeNumber: 1,
						ratingKey: "episode-invalid",
						title: "Invalid",
						watched: false,
						watchedByUsers: "[]",
						watchCount: 0,
						refreshedAt,
						sourceFingerprint: "fingerprint-invalid",
					},
				}),
			).rejects.toThrow();

			await prisma.serviceInstance.delete({ where: { id: instance.id } });
			expect(await observation.providerObservationRun.count()).toBe(0);
			expect(await observation.providerObservationUnit.count()).toBe(0);
			expect(await observation.plexEpisodeObservationStage.count()).toBe(0);
			expect(await observation.jellyfinEpisodeObservationStage.count()).toBe(0);
		} finally {
			await prisma.$disconnect();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 120_000);
});
