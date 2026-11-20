import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import type { ServiceInstance } from "../../prisma.js";

const observedAt = new Date("2026-09-25T10:00:00.000Z");
const attempt = {
	attemptedAt: new Date("2026-09-25T09:59:00.000Z"),
	resultMarker: "in_progress:11111111-1111-4111-8111-111111111111",
};
const candidate = {
	userKeyDigest: "a".repeat(64),
	libraryId: "library-a",
	jellyfinId: "episode-a",
	seriesId: "series-a",
	seasonNumber: 1,
	episodeNumber: 1,
	played: true,
	playCount: 1,
	lastPlayedAt: observedAt,
};

let directory: string;
let prisma: ReturnType<typeof createTestPrismaClient>;
let instance: ServiceInstance;

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "jellyfin-positive-watch-repository-"));
	const dbPath = join(directory, "test.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});
	prisma = createTestPrismaClient(dbPath);
	await prisma.user.create({ data: { id: "owner", username: "positive-watch-owner" } });
	instance = await prisma.serviceInstance.create({
		data: {
			id: "jellyfin-instance",
			userId: "owner",
			service: "JELLYFIN",
			label: "Synthetic",
			baseUrl: "http://jellyfin.invalid",
			encryptedApiKey: "cipher",
			encryptionIv: "iv",
			identityStatus: "VERIFIED",
			expectedIdentity: "server-a",
			connectionGeneration: 1,
			identityGeneration: 1,
		},
	});
}, 30_000);

afterAll(async () => {
	await prisma?.$disconnect();
	if (directory) rmSync(directory, { recursive: true, force: true });
});

beforeEach(async () => {
	await prisma.cacheRefreshStatus.deleteMany();
	await prisma.serviceInstance.update({
		where: { id: instance.id },
		data: { identityGeneration: 1, connectionGeneration: 1 },
	});
	await prisma.cacheRefreshStatus.create({
		data: {
			instanceId: instance.id,
			cacheType: "jellyfin_episode_positive",
			lastRefreshedAt: attempt.attemptedAt,
			lastResult: "error",
			lastAttemptAt: attempt.attemptedAt,
			lastAttemptResult: attempt.resultMarker,
			connectionGeneration: 1,
			identityGeneration: 1,
		},
	});
});

async function publisher() {
	const module = await import("../jellyfin-positive-watch-repository.js").catch(() => null);
	expect(module?.publishJellyfinPositiveWatchGeneration).toEqual(expect.any(Function));
	return module!.publishJellyfinPositiveWatchGeneration;
}

describe("Jellyfin positive watch publication", { timeout: 30_000 }, () => {
	it("atomically publishes only a generation-bound positive row and matching status", async () => {
		const publish = await publisher();
		await prisma.$transaction(async (tx) => {
			await publish(tx, {
				instance,
				attempt,
				generationId: "positive-generation-a",
				observedAt,
				candidates: [candidate],
			});
		});
		const status = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: {
				instanceId_cacheType: {
					instanceId: instance.id,
					cacheType: "jellyfin_episode_positive",
				},
			},
		});
		expect(status).toMatchObject({
			lastResult: "success",
			lastAttemptResult: "success",
			generationId: "positive-generation-a",
			itemCount: 1,
		});
		const rows = await prisma.$queryRaw<Array<{ jellyfinId: string; generationId: string }>>`
			SELECT "jellyfinId", "generationId" FROM "jellyfin_positive_watch_rows"
		`;
		expect(rows).toEqual([{ jellyfinId: "episode-a", generationId: "positive-generation-a" }]);
	});

	it("rejects a superseded attempt without replacing the prior generation", async () => {
		const publish = await publisher();
		await prisma.$transaction(async (tx) => {
			await publish(tx, {
				instance,
				attempt,
				generationId: "positive-generation-a",
				observedAt,
				candidates: [candidate],
			});
		});
		await expect(
			prisma.$transaction(async (tx) => {
				await publish(tx, {
					instance,
					attempt,
					generationId: "positive-generation-b",
					observedAt: new Date(observedAt.getTime() + 60_000),
					candidates: [],
				});
			}),
		).rejects.toThrow(/superseded/i);
		const rows = await prisma.$queryRaw<Array<{ generationId: string }>>`
			SELECT "generationId" FROM "jellyfin_positive_watch_rows"
		`;
		expect(rows).toEqual([{ generationId: "positive-generation-a" }]);
	});
});
