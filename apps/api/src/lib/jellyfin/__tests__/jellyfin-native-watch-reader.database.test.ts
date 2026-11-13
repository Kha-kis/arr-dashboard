import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import type { NativeInventoryRow } from "../../provider-observation/native-inventory.js";
import { readNativeEpisodeWatchPage } from "../jellyfin-native-watch-reader.js";
import { readOwnedNativeWatchCoverage } from "../jellyfin-native-watch-coverage.js";

const now = new Date("2026-09-24T12:00:00.000Z");
const inventory = (nativeId = "episode-a"): NativeInventoryRow => ({
	nativeId,
	mediaType: "episode",
	libraryIds: ["library-a"],
	parentNativeId: "series-a",
	seasonNumber: 1,
	episodeNumber: nativeId === "episode-a" ? 1 : 2,
	title: "Synthetic episode",
});

let directory: string;
let prisma: ReturnType<typeof createTestPrismaClient>;

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "jellyfin-watch-reader-"));
	const dbPath = join(directory, "test.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});
	prisma = createTestPrismaClient(dbPath);
	await prisma.user.create({ data: { id: "owner", username: "native-watch-reader-owner" } });
	await prisma.user.create({ data: { id: "other", username: "native-watch-reader-other" } });
	await prisma.serviceInstance.create({
		data: {
			id: "jellyfin-instance",
			userId: "owner",
			service: "JELLYFIN",
			label: "Test",
			baseUrl: "http://jellyfin.invalid",
			encryptedApiKey: "cipher",
			encryptionIv: "iv",
			identityStatus: "VERIFIED",
			expectedIdentity: "server-id",
			connectionGeneration: 1,
			identityGeneration: 1,
		},
	});
	await prisma.serviceInstance.create({
		data: {
			id: "plex-instance",
			userId: "owner",
			service: "PLEX",
			label: "Plex",
			baseUrl: "http://plex.invalid",
			encryptedApiKey: "cipher",
			encryptionIv: "iv",
			identityStatus: "VERIFIED",
			expectedIdentity: "plex-server-id",
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
	await prisma.jellyfinPositiveWatchRow.deleteMany();
	await prisma.jellyfinNativeWatchRow.deleteMany();
	await prisma.jellyfinNativeWatchScopeReceipt.deleteMany();
	await prisma.jellyfinNativeWatchPublication.deleteMany();
	await prisma.cacheRefreshStatus.deleteMany();
	await prisma.serviceInstance.update({
		where: { id: "jellyfin-instance" },
		data: {
			service: "JELLYFIN",
			identityGeneration: 1,
			connectionGeneration: 1,
			identityStatus: "VERIFIED",
		},
	});
	await prisma.cacheRefreshStatus.create({
		data: {
			instanceId: "jellyfin-instance",
			cacheType: "jellyfin_episode",
			lastRefreshedAt: now,
			lastResult: "success",
			lastAttemptAt: now,
			lastAttemptResult: "success",
			generationId: "current-generation",
			connectionGeneration: 1,
			identityGeneration: 1,
		},
	});
});

async function seedPublication(
	options: {
		runId?: string;
		observedAt?: Date;
		previousRunId?: string;
		previousObservedAt?: Date;
		expectedScopeCount?: number;
	} = {},
) {
	const runId = options.runId ?? "current-run";
	const observedAt = options.observedAt ?? now;
	await prisma.jellyfinNativeWatchPublication.create({
		data: {
			instanceId: "jellyfin-instance",
			activeRunId: runId,
			activeCacheGenerationId: "current-generation",
			activeObservedAt: observedAt,
			activeExpectedScopeCount: options.expectedScopeCount ?? 1,
			previousRunId: options.previousRunId ?? null,
			previousObservedAt: options.previousObservedAt ?? null,
			previousExpectedScopeCount: options.previousRunId ? 1 : null,
			connectionGeneration: 1,
			identityGeneration: 1,
		},
	});
}

async function seedScope(
	options: {
		runId?: string;
		userKeyDigest?: string;
		libraryId?: string;
		exact?: boolean;
		observedAt?: Date;
	} = {},
) {
	await prisma.jellyfinNativeWatchScopeReceipt.create({
		data: {
			instanceId: "jellyfin-instance",
			runId: options.runId ?? "current-run",
			userKeyDigest: options.userKeyDigest ?? "user-a",
			libraryId: options.libraryId ?? "library-a",
			expectedRawCount: 2,
			observedRawCount: options.exact === false ? 3 : 2,
			exact: options.exact ?? true,
			contentFingerprint: "a".repeat(64),
			observedAt: options.observedAt ?? now,
			connectionGeneration: 1,
			identityGeneration: 1,
		},
	});
}

async function seedWatch(
	options: {
		runId?: string;
		userKeyDigest?: string;
		libraryId?: string;
		jellyfinId?: string;
		seriesId?: string;
		played?: boolean;
		observedAt?: Date;
		episodeNumber?: number;
	} = {},
) {
	await prisma.jellyfinNativeWatchRow.create({
		data: {
			instanceId: "jellyfin-instance",
			runId: options.runId ?? "current-run",
			userKeyDigest: options.userKeyDigest ?? "user-a",
			libraryId: options.libraryId ?? "library-a",
			jellyfinId: options.jellyfinId ?? "episode-a",
			seriesId: options.seriesId ?? "series-a",
			seasonNumber: 1,
			episodeNumber: options.episodeNumber ?? 1,
			played: options.played ?? false,
			playCount: options.played ? 1 : 0,
			lastPlayedAt: null,
			observedAt: options.observedAt ?? now,
			connectionGeneration: 1,
			identityGeneration: 1,
		},
	});
}

const read = (rows: NativeInventoryRow[], userId = "owner") =>
	readNativeEpisodeWatchPage(prisma, { userId, instanceId: "jellyfin-instance", rows, now });

async function seedPositive(
	options: {
		observedAt?: Date;
		generationId?: string;
		libraryId?: string;
		seriesId?: string;
		lastResult?: string;
	} = {},
) {
	const observedAt = options.observedAt ?? new Date(now.getTime() + 60_000);
	const generationId = options.generationId ?? "positive-generation";
	await prisma.cacheRefreshStatus.create({
		data: {
			instanceId: "jellyfin-instance",
			cacheType: "jellyfin_episode_positive",
			lastRefreshedAt: observedAt,
			lastResult: options.lastResult ?? "success",
			lastAttemptAt: observedAt,
			lastAttemptResult: "success",
			generationId,
			itemCount: 1,
			connectionGeneration: 1,
			identityGeneration: 1,
		},
	});
	await prisma.jellyfinPositiveWatchRow.create({
		data: {
			instanceId: "jellyfin-instance",
			generationId,
			userKeyDigest: "a".repeat(64),
			libraryId: options.libraryId ?? "library-a",
			jellyfinId: "episode-a",
			seriesId: options.seriesId ?? "series-a",
			seasonNumber: 1,
			episodeNumber: 1,
			playCount: 1,
			lastPlayedAt: observedAt,
			observedAt,
			connectionGeneration: 1,
			identityGeneration: 1,
		},
	});
}

describe("native episode watch page", { timeout: 30_000 }, () => {
	it.each([null, "{", '{"forged":"private"}', " ".repeat(2049)])(
		"keeps valid values and freshness independent of unavailable diagnostics %#",
		async (diagnosticsJson) => {
			await seedPublication();
			await seedScope({ exact: false });
			await seedWatch();
			await prisma.jellyfinNativeWatchScopeReceipt.updateMany({ data: { diagnosticsJson } });
			expect((await read([inventory()])).get("episode-a")).toEqual({
				state: "unwatched",
				freshness: "current",
				valueSemantics: "exact",
				observedAt: now.toISOString(),
			});
			expect(
				await readOwnedNativeWatchCoverage(prisma, {
					userId: "owner",
					instanceId: "jellyfin-instance",
				}),
			).toMatchObject({
				status: "available",
				verifiedScopes: 0,
				incompleteScopes: 1,
				diagnosticStatus: "unavailable",
			});
		},
	);
	it("does not expose recorded coverage for wrong owner, disabled source or changed identity", async () => {
		await seedPublication();
		await seedScope();
		expect(
			await readOwnedNativeWatchCoverage(prisma, {
				userId: "other",
				instanceId: "jellyfin-instance",
			}),
		).toEqual({ status: "unavailable", reason: "not-owned" });
		await prisma.serviceInstance.update({
			where: { id: "jellyfin-instance" },
			data: { enabled: false },
		});
		expect(
			await readOwnedNativeWatchCoverage(prisma, {
				userId: "owner",
				instanceId: "jellyfin-instance",
			}),
		).toEqual({ status: "unavailable", reason: "not-owned" });
		await prisma.serviceInstance.update({
			where: { id: "jellyfin-instance" },
			data: { enabled: true, identityGeneration: 2 },
		});
		expect(
			await readOwnedNativeWatchCoverage(prisma, {
				userId: "owner",
				instanceId: "jellyfin-instance",
			}),
		).toEqual({ status: "unavailable", reason: "identity-changed" });
	});
	it("shows a newer positive without a full watch publication, never a negative for its absence", async () => {
		await seedPositive({ observedAt: now });
		const result = await read([inventory(), inventory("episode-b")]);
		expect(result.get("episode-a")).toMatchObject({
			state: "watched",
			valueSemantics: "lower-bound",
			freshness: "current",
		});
		expect(result.get("episode-b")?.state).toBe("unknown");
	});

	it("reads both refresh statuses once and applies newer positive evidence over the full scan", async () => {
		const prior = new Date(now.getTime() - 60_000);
		await prisma.cacheRefreshStatus.update({
			where: {
				instanceId_cacheType: { instanceId: "jellyfin-instance", cacheType: "jellyfin_episode" },
			},
			data: { lastRefreshedAt: prior },
		});
		await seedPublication({ observedAt: prior });
		await seedScope({ observedAt: prior });
		await seedWatch({ observedAt: prior });
		await seedWatch({ jellyfinId: "episode-b", episodeNumber: 2, observedAt: prior });
		await seedPositive({ observedAt: now });
		let statusReads = 0;
		const observed = prisma.$extends({
			query: {
				cacheRefreshStatus: {
					$allOperations({ args, query }) {
						statusReads++;
						return query(args);
					},
				},
			},
		});
		const result = await readNativeEpisodeWatchPage(observed as unknown as typeof prisma, {
			userId: "owner",
			instanceId: "jellyfin-instance",
			rows: [inventory(), inventory("episode-b")],
			now,
		});
		expect(result.get("episode-a")).toMatchObject({
			state: "watched",
			valueSemantics: "lower-bound",
			freshness: "current",
		});
		expect(result.get("episode-b")).toMatchObject({ state: "unwatched", freshness: "last-known" });
		expect(statusReads).toBe(1);
	});

	it("rejects mismatched positive coordinates, identity, and stale or failed pointers", async () => {
		await seedPositive({ observedAt: now, seriesId: "series-b" });
		expect((await read([inventory()])).get("episode-a")?.state).toBe("unknown");
		await prisma.jellyfinPositiveWatchRow.updateMany({ data: { seriesId: "series-a" } });
		await prisma.serviceInstance.update({
			where: { id: "jellyfin-instance" },
			data: { identityGeneration: 2 },
		});
		expect((await read([inventory()])).get("episode-a")?.state).toBe("unknown");
		await prisma.serviceInstance.update({
			where: { id: "jellyfin-instance" },
			data: { identityGeneration: 1 },
		});
		await prisma.cacheRefreshStatus.update({
			where: {
				instanceId_cacheType: {
					instanceId: "jellyfin-instance",
					cacheType: "jellyfin_episode_positive",
				},
			},
			data: { lastResult: "error" },
		});
		expect((await read([inventory()])).get("episode-a")?.state).toBe("unknown");
	});

	it("fails closed when the positive pointer count is inconsistent with stored rows", async () => {
		await seedPositive({ observedAt: now });
		await prisma.cacheRefreshStatus.update({
			where: {
				instanceId_cacheType: {
					instanceId: "jellyfin-instance",
					cacheType: "jellyfin_episode_positive",
				},
			},
			data: { itemCount: 2 },
		});
		expect((await read([inventory()])).get("episode-a")?.state).toBe("unknown");
	});

	it("keeps a failed positive refresh as last-known without losing its published row", async () => {
		await seedPositive({ observedAt: now });
		await prisma.cacheRefreshStatus.update({
			where: {
				instanceId_cacheType: {
					instanceId: "jellyfin-instance",
					cacheType: "jellyfin_episode_positive",
				},
			},
			data: { lastAttemptResult: "error" },
		});
		expect((await read([inventory()])).get("episode-a")).toMatchObject({
			state: "watched",
			freshness: "last-known",
		});
	});

	it("never attaches Jellyfin-only positive observations to an Emby instance", async () => {
		await seedPositive({ observedAt: now });
		await prisma.serviceInstance.update({
			where: { id: "jellyfin-instance" },
			data: { service: "EMBY" },
		});
		expect((await read([inventory()])).get("episode-a")?.state).toBe("unknown");
	});
	it("shows exact watched and unwatched facts without TMDB or ARR links", async () => {
		await seedPublication();
		await seedScope();
		await seedWatch({ played: true });
		await seedWatch({ jellyfinId: "episode-b", episodeNumber: 2 });
		const result = await read([inventory(), inventory("episode-b")]);
		expect(result.get("episode-a")).toEqual({
			state: "watched",
			freshness: "current",
			valueSemantics: "exact",
			observedAt: now.toISOString(),
		});
		expect(result.get("episode-b")).toEqual({
			state: "unwatched",
			freshness: "current",
			valueSemantics: "exact",
			observedAt: now.toISOString(),
		});
	});

	it("never interprets one missing expected user as unwatched", async () => {
		await seedPublication({ expectedScopeCount: 2 });
		await seedScope();
		await seedScope({ userKeyDigest: "user-b" });
		await seedWatch();
		const result = await read([inventory()]);
		expect(result.get("episode-a")?.state).toBe("unknown");
		expect(result.get("episode-a")?.valueSemantics).toBe("unknown");
	});

	it("shows a matched unplayed episode even when unrelated rows make its scope partial", async () => {
		await seedPublication();
		await seedScope({ exact: false });
		await seedWatch();
		const result = await read([inventory()]);
		expect(result.get("episode-a")).toMatchObject({
			state: "unwatched",
			valueSemantics: "exact",
			freshness: "current",
		});
	});

	it("keeps a partial-scope unplayed episode unknown when another expected user is missing", async () => {
		await seedPublication({ expectedScopeCount: 2 });
		await seedScope({ exact: false });
		await seedScope({ userKeyDigest: "user-b", exact: false });
		await seedWatch();
		const result = await read([inventory()]);
		expect(result.get("episode-a")).toMatchObject({
			state: "unknown",
			valueSemantics: "unknown",
		});
	});

	it("does not certify an exact negative when inventory has a newer unobserved library", async () => {
		await seedPublication();
		await seedScope();
		await seedWatch();
		const result = await read([{ ...inventory(), libraryIds: ["library-a", "library-b"] }]);
		expect(result.get("episode-a")?.state).toBe("unknown");
		expect(result.get("episode-a")?.valueSemantics).toBe("unknown");
	});

	it("keeps a positive as a lower bound when inventory has a newer unobserved library", async () => {
		await seedPublication();
		await seedScope();
		await seedWatch({ played: true });
		const result = await read([{ ...inventory(), libraryIds: ["library-a", "library-b"] }]);
		expect(result.get("episode-a")).toMatchObject({
			state: "watched",
			valueSemantics: "lower-bound",
		});
	});

	it("shows a verified positive only as a lower bound when another scope is incomplete", async () => {
		await seedPublication({ expectedScopeCount: 2 });
		await seedScope();
		await seedScope({ userKeyDigest: "user-b", exact: false });
		await seedWatch({ played: true });
		const result = await read([inventory()]);
		expect(result.get("episode-a")).toMatchObject({
			state: "watched",
			valueSemantics: "lower-bound",
		});
	});

	it("rejects a same-ID cross-library parent collision", async () => {
		await seedPublication({ expectedScopeCount: 2 });
		await seedScope();
		await seedScope({ libraryId: "library-b" });
		await seedWatch({ played: true });
		await seedWatch({ libraryId: "library-b", seriesId: "series-b", played: true });
		const result = await read([{ ...inventory(), libraryIds: ["library-a", "library-b"] }]);
		expect(result.get("episode-a")?.state).toBe("unknown");
	});

	it("labels previous evidence last-known and expires it after 24 hours", async () => {
		const prior = new Date(now.getTime() - 60_000);
		await seedPublication({ previousRunId: "previous-run", previousObservedAt: prior });
		await seedScope();
		await seedScope({ runId: "previous-run", observedAt: prior });
		await seedWatch({ runId: "previous-run", observedAt: prior, played: true });
		expect((await read([inventory()])).get("episode-a")).toMatchObject({
			state: "watched",
			freshness: "last-known",
			observedAt: prior.toISOString(),
		});
		await prisma.jellyfinNativeWatchPublication.update({
			where: { instanceId: "jellyfin-instance" },
			data: { previousObservedAt: new Date(now.getTime() - 25 * 60 * 60 * 1_000) },
		});
		expect((await read([inventory()])).get("episode-a")?.state).toBe("unknown");
	});

	it("hides evidence after identity change or for another owner", async () => {
		await seedPublication();
		await seedScope();
		await seedWatch({ played: true });
		expect((await read([inventory()], "other")).has("episode-a")).toBe(false);
		await prisma.serviceInstance.update({
			where: { id: "jellyfin-instance" },
			data: { identityGeneration: 2 },
		});
		expect((await read([inventory()])).get("episode-a")?.state).toBe("unknown");
	});

	it("does not attach Jellyfin watch categories to Plex episodes", async () => {
		const result = await readNativeEpisodeWatchPage(prisma, {
			userId: "owner",
			instanceId: "plex-instance",
			rows: [inventory()],
			now,
		});
		expect(result.has("episode-a")).toBe(false);
	});

	it("rejects a changed inventory parent or coordinate", async () => {
		await seedPublication();
		await seedScope();
		await seedWatch({ played: true });
		expect(
			(await read([{ ...inventory(), parentNativeId: "series-b" }])).get("episode-a")?.state,
		).toBe("unknown");
		expect((await read([{ ...inventory(), episodeNumber: 2 }])).get("episode-a")?.state).toBe(
			"unknown",
		);
	});
});
