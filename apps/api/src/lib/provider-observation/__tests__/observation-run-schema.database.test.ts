import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";

const schemaPath = join(process.cwd(), "prisma", "schema.prisma");
const EXCLUSION_RELATION = "  jellyfinEpisodeExclusions JellyfinEpisodeObservationExclusion[]\n";
const EXCLUSION_MODEL = `model JellyfinEpisodeObservationExclusion {
  id            String   @id @default(cuid())
  runId         String
  unitId        String
  userKeyDigest String
  pass          String
  jellyfinId    String
  reason        String
  unit          ProviderObservationUnit @relation(fields: [runId, unitId], references: [runId, id], onDelete: Cascade)

  @@unique([runId, pass, userKeyDigest, jellyfinId])
  @@index([runId, unitId])
  @@map("jellyfin_episode_observation_exclusions")
}
`;
type ObservationDelegate<T> = {
	create(args: { data: Record<string, unknown> }): Promise<T>;
	count(): Promise<number>;
};

type ObservationPrisma = {
	providerObservationRun: ObservationDelegate<{ id: string }>;
	providerObservationUnit: ObservationDelegate<{ id: string }>;
	plexEpisodeObservationStage: ObservationDelegate<{ id: string }>;
	jellyfinEpisodeObservationStage: ObservationDelegate<{ id: string }>;
	jellyfinEpisodeObservationExclusion: ObservationDelegate<{ id: string }>;
};

function pushSchema(databasePath: string): void {
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", schemaPath], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		stdio: "ignore",
	});
}

function pushSchemaFile(databasePath: string, schemaPath: string): void {
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
			await observation.jellyfinEpisodeObservationExclusion.create({
				data: {
					runId: run.id,
					unitId: secondUnit.id,
					userKeyDigest: "user-digest",
					pass: "head",
					jellyfinId: "episode-missing-metadata",
					reason: "missing-episode-metadata",
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
			expect(await observation.jellyfinEpisodeObservationExclusion.count()).toBe(0);
		} finally {
			await prisma.$disconnect();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 120_000);

	it("upgrades the base schema additively with only exclusion objects", async () => {
		const directory = mkdtempSync(join(tmpdir(), "provider-observation-schema-upgrade-"));
		const databasePath = join(directory, "test.db");
		const baseSchemaPath = join(directory, "base-schema.prisma");
		const candidateSchema = readFileSync(schemaPath, "utf8");
		expect(candidateSchema).toContain(EXCLUSION_RELATION);
		expect(candidateSchema).toContain(EXCLUSION_MODEL);
		const baseSchema = candidateSchema.replace(EXCLUSION_RELATION, "").replace(EXCLUSION_MODEL, "");
		writeFileSync(baseSchemaPath, baseSchema);
		const prisma = createTestPrismaClient(databasePath);

		try {
			pushSchemaFile(databasePath, baseSchemaPath);
			const user = await prisma.user.create({
				data: { username: "observation-schema-upgrade-user" },
			});
			const instance = await prisma.serviceInstance.create({
				data: {
					userId: user.id,
					service: "JELLYFIN",
					label: "observation-schema-upgrade-instance",
					baseUrl: "http://127.0.0.1:8096",
					encryptedApiKey: "encrypted",
					encryptionIv: "iv",
				},
			});
			const run = await prisma.providerObservationRun.create({
				data: {
					instanceId: instance.id,
					provider: "jellyfin_episode",
					cacheType: "jellyfin_episode",
					authorityKey: "a".repeat(64),
					targetDigest: "b".repeat(64),
					targetCount: 1,
					connectionGeneration: 0,
					identityGeneration: 0,
					state: "running",
					totalUnits: 1,
					totalWork: 1,
				},
			});
			const unit = await prisma.providerObservationUnit.create({
				data: {
					runId: run.id,
					ordinal: 0,
					scopeKey: "upgrade-scope",
					scopeDigest: "c".repeat(64),
					phase: "collect",
					expectedTargets: 1,
					state: "pending",
				},
			});
			const beforeRun = await prisma.providerObservationRun.findUniqueOrThrow({
				where: { id: run.id },
			});
			const beforeUnit = await prisma.providerObservationUnit.findUniqueOrThrow({
				where: { id: unit.id },
			});
			const beforeUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
			const beforeInstance = await prisma.serviceInstance.findUniqueOrThrow({
				where: { id: instance.id },
			});
			const beforeObjects = await prisma.$queryRawUnsafe<
				Array<{ type: string; name: string; tbl_name: string; sql: string | null }>
			>(
				"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
			);

			pushSchema(databasePath);

			const afterRun = await prisma.providerObservationRun.findUniqueOrThrow({
				where: { id: run.id },
			});
			const afterUnit = await prisma.providerObservationUnit.findUniqueOrThrow({
				where: { id: unit.id },
			});
			const afterUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
			const afterInstance = await prisma.serviceInstance.findUniqueOrThrow({
				where: { id: instance.id },
			});
			const afterObjects = await prisma.$queryRawUnsafe<
				Array<{ type: string; name: string; tbl_name: string; sql: string | null }>
			>(
				"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
			);
			const beforeByName = new Map(beforeObjects.map((object) => [object.name, object]));
			const afterByName = new Map(afterObjects.map((object) => [object.name, object]));
			const addedObjects = afterObjects.filter((object) => !beforeByName.has(object.name));

			expect(afterUser).toEqual(beforeUser);
			expect(afterInstance).toEqual(beforeInstance);
			expect(afterRun).toEqual(beforeRun);
			expect(afterUnit).toEqual(beforeUnit);
			for (const beforeObject of beforeObjects) {
				expect(afterByName.get(beforeObject.name), beforeObject.name).toEqual(beforeObject);
			}
			expect(addedObjects).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "table",
						name: "jellyfin_episode_observation_exclusions",
						tbl_name: "jellyfin_episode_observation_exclusions",
					}),
					expect.objectContaining({
						type: "index",
						name: "jellyfin_episode_observation_exclusions_runId_pass_userKeyDigest_jellyfinId_key",
						tbl_name: "jellyfin_episode_observation_exclusions",
					}),
					expect.objectContaining({
						type: "index",
						name: "jellyfin_episode_observation_exclusions_runId_unitId_idx",
						tbl_name: "jellyfin_episode_observation_exclusions",
					}),
				]),
			);
			expect(addedObjects).toHaveLength(3);
		} finally {
			await prisma.$disconnect();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 120_000);
});
