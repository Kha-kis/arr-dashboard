import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import type { PrismaClient, ServiceInstance } from "../../prisma.js";
import {
	beginNativeInventoryAttempt,
	beginNativeInventoryAttemptInTransaction,
	failNativeInventoryAttempt,
	type NativeInventoryRow,
	publishNativeInventoriesInTransaction,
	readNativeInventoryPage,
} from "../native-inventory.js";

const databases: Array<{ directory: string; prisma: PrismaClient }> = [];
const NOW = new Date("2026-09-14T12:00:00.000Z");

afterEach(async () => {
	for (const database of databases.splice(0)) {
		await database.prisma.$disconnect();
		rmSync(database.directory, { recursive: true, force: true });
	}
});

async function database(): Promise<{
	prisma: PrismaClient;
	plex: ServiceInstance;
	otherPlex: ServiceInstance;
}> {
	const directory = mkdtempSync(join(tmpdir(), "native-inventory-"));
	const dbPath = join(directory, "test.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});

	const prisma = createTestPrismaClient(dbPath);
	databases.push({ directory, prisma });
	await prisma.user.createMany({
		data: [
			{ id: "user-1", username: "native-user" },
			{ id: "user-2", username: "other-user" },
		],
	});
	const base = {
		service: "PLEX" as const,
		label: "Plex",
		baseUrl: "http://plex.invalid",
		encryptedApiKey: "cipher",
		encryptionIv: "iv",
		connectionGeneration: 2,
		expectedIdentity: "verified-provider",
		identityStatus: "VERIFIED" as const,
		identityGeneration: 3,
		identityKind: "PLEX_MACHINE_IDENTIFIER" as const,
		identityVerifiedAt: NOW,
	};
	await prisma.serviceInstance.create({ data: { ...base, id: "plex-1", userId: "user-1" } });
	await prisma.serviceInstance.create({
		data: { ...base, id: "plex-2", userId: "user-1", label: "Second Plex" },
	});
	await prisma.serviceInstance.create({ data: { ...base, id: "plex-foreign", userId: "user-2" } });
	const plex = await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-1" } });
	const otherPlex = await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex-2" } });
	return { prisma, plex, otherPlex };
}

const libraryRows: NativeInventoryRow[] = [
	{
		nativeId: "movie-1",
		mediaType: "movie" as const,
		libraryIds: ["movies"],
		parentNativeId: null,
		seasonNumber: null,
		episodeNumber: null,
		title: "Unmapped movie",
	},
	{
		nativeId: "show-1",
		mediaType: "series" as const,
		libraryIds: ["shows"],
		parentNativeId: null,
		seasonNumber: null,
		episodeNumber: null,
		title: "Same title",
	},
];
async function publish(
	prisma: PrismaClient,
	plex: ServiceInstance,
	rows = libraryRows,
	options: { domain?: "library" | "episode"; now?: Date } = {},
) {
	const domain = options.domain ?? "library";
	const begun = await beginNativeInventoryAttempt(prisma, {
		userId: "user-1",
		instance: plex,
		domains: [domain],
		now: options.now ?? NOW,
	});
	expect(begun.status).toBe("acquired");
	if (begun.status !== "acquired") throw new Error("attempt was not acquired");
	const published = await prisma.$transaction((tx) =>
		publishNativeInventoriesInTransaction(tx, {
			userId: "user-1",
			authority: begun.authority,
			attempt: begun.attempt,
			snapshots: [
				{ domain, scopeKeys: domain === "library" ? ["movies", "shows"] : ["shows"], rows },
			],
			now: options.now ?? NOW,
		}),
	);
	return { begun, published };
}

describe("native inventory storage on disposable SQLite", { timeout: 30_000 }, () => {
	it("yields during multi-chunk publication without losing parameterized row values", async () => {
		const { prisma, plex } = await database();
		const rows = Array.from({ length: 1_201 }, (_, index) => ({
			...libraryRows[0]!,
			nativeId: `native-${index}`,
			title: `Synthetic 'quoted' title; -- ${index} 日本語`,
			externalIds: { tmdb: [index + 1] },
		}));
		const begun = await beginNativeInventoryAttempt(prisma, {
			userId: plex.userId,
			instance: plex,
			domains: ["library"],
			now: NOW,
		});
		if (begun.status !== "acquired") throw new Error("attempt not acquired");
		let yielded = false;
		const result = await prisma.$transaction(async (tx) => {
			const heartbeat = setImmediate(() => {
				yielded = true;
			});
			try {
				const published = await publishNativeInventoriesInTransaction(tx, {
					userId: plex.userId,
					authority: begun.authority,
					attempt: begun.attempt,
					snapshots: [{ domain: "library", scopeKeys: ["movies"], rows }],
					now: NOW,
				});
				return { published, yieldedDuringPublication: yielded };
			} finally {
				clearImmediate(heartbeat);
			}
		});
		expect(result.published.status).toBe("published");
		expect(result.yieldedDuringPublication).toBe(true);
		expect(await prisma.providerNativeInventoryItem.count()).toBe(rows.length);
		const stored = await prisma.providerNativeInventoryItem.findFirstOrThrow({
			where: { nativeId: "native-1200" },
		});
		expect(stored.title).toBe(rows[1_200]!.title);
		expect(stored.externalIds).toBe(JSON.stringify({ tmdb: [1_201] }));
		expect(stored.parentNativeId).toBeNull();
	});

	it.each(["reject", "skip"])(
		"rolls back earlier chunks when a later native insert must %s",
		async (mode) => {
			const { prisma, plex } = await database();
			const previous = await publish(prisma, plex);
			if (previous.published.status !== "published") throw new Error("publication failed");
			if (mode === "skip") {
				await prisma.$executeRaw`
				CREATE TRIGGER reject_synthetic_native_row BEFORE INSERT ON provider_native_inventory_items
				WHEN NEW.nativeId = 'reject-later-chunk'
				BEGIN SELECT RAISE(IGNORE); END
			`;
			} else {
				await prisma.$executeRaw`
				CREATE TRIGGER reject_synthetic_native_row BEFORE INSERT ON provider_native_inventory_items
				WHEN NEW.nativeId = 'reject-later-chunk'
				BEGIN SELECT RAISE(ABORT, 'synthetic later chunk rejection'); END
			`;
			}
			const rows = Array.from({ length: 1_001 }, (_, index) => ({
				...libraryRows[0]!,
				nativeId: index === 1_000 ? "reject-later-chunk" : `replacement-${index}`,
			}));
			await expect(publish(prisma, plex, rows)).rejects.toThrow();
			const snapshot = await prisma.providerNativeInventorySnapshot.findUniqueOrThrow({
				where: { instanceId_domain: { instanceId: plex.id, domain: "library" } },
			});
			expect(snapshot.generationId).toBe(previous.published.generationId);
			expect(snapshot.itemCount).toBe(libraryRows.length);
			const stored = await prisma.providerNativeInventoryItem.findMany({
				where: { snapshotId: snapshot.id },
				orderBy: { nativeId: "asc" },
				select: { nativeId: true },
			});
			expect(stored.map((row) => row.nativeId)).toEqual(["movie-1", "show-1"]);
		},
	);

	it("persists normalized native external identifier evidence and defaults legacy rows", async () => {
		const { prisma, plex } = await database();
		await publish(prisma, plex, [
			{
				...libraryRows[0]!,
				externalIds: { tmdb: [100, 100, 0, -1], tvdb: [200, 300] },
			},
			libraryRows[1]!,
		]);

		const page = await readNativeInventoryPage(prisma, {
			userId: "user-1",
			instanceId: "plex-1",
			domain: "library",
			now: NOW,
		});
		expect(page.status).toBe("available");
		if (page.status !== "available") throw new Error("page unavailable");
		expect(page.rows[0]?.externalIds).toEqual({ tmdb: [100], tvdb: [200, 300] });
		expect(page.rows[1]?.externalIds).toEqual({});
	});

	it("publishes unmapped and unwatched native rows and paginates them", async () => {
		const { prisma, plex } = await database();
		await publish(prisma, plex);

		const page = await readNativeInventoryPage(prisma, {
			userId: "user-1",
			instanceId: "plex-1",
			domain: "library",
			limit: 1,
			now: NOW,
		});
		expect(page.status).toBe("available");
		if (page.status !== "available") throw new Error("page unavailable");
		expect(page.freshness).toBe("current");
		expect(page.complete).toBe(true);
		expect(page.rows[0]?.nativeId).toBe("movie-1");
		expect(page.nextNativeId).toBe("movie-1");
		const next = await readNativeInventoryPage(prisma, {
			userId: "user-1",
			instanceId: "plex-1",
			domain: "library",
			afterNativeId: page.nextNativeId ?? undefined,
			expectedGenerationId: page.generationId,
			now: NOW,
		});
		expect(next.status).toBe("available");
		if (next.status !== "available") throw new Error("page unavailable");
		expect(next.rows.map((row) => row.nativeId)).toEqual(["show-1"]);
		await publish(prisma, plex, [libraryRows[0]!], { now: new Date(NOW.getTime() + 1_000) });
		const changed = await readNativeInventoryPage(prisma, {
			userId: "user-1",
			instanceId: "plex-1",
			domain: "library",
			afterNativeId: page.nextNativeId ?? undefined,
			expectedGenerationId: page.generationId,
			now: new Date(NOW.getTime() + 1_000),
		});
		expect(changed).toEqual({ status: "unavailable", reason: "snapshot-changed" });
	});

	it("replaces items atomically and retains the prior publication on rejected input", async () => {
		const { prisma, plex } = await database();
		await publish(prisma, plex);
		const malformed = [{ ...libraryRows[0]!, nativeId: "" }];
		const begun = await beginNativeInventoryAttempt(prisma, {
			userId: "user-1",
			instance: plex,
			domains: ["library"],
			now: new Date(NOW.getTime() + 1_000),
		});
		expect(begun.status).toBe("acquired");
		if (begun.status !== "acquired") throw new Error("attempt was not acquired");
		await expect(
			prisma.$transaction((tx) =>
				publishNativeInventoriesInTransaction(tx, {
					userId: "user-1",
					authority: begun.authority,
					attempt: begun.attempt,
					snapshots: [{ domain: "library", scopeKeys: ["movies"], rows: malformed }],
					now: new Date(NOW.getTime() + 1_000),
				}),
			),
		).rejects.toThrow();
		const page = await readNativeInventoryPage(prisma, {
			userId: "user-1",
			instanceId: "plex-1",
			domain: "library",
			now: new Date(NOW.getTime() + 1_000),
		});
		expect(page.status).toBe("available");
		if (page.status !== "available") throw new Error("page unavailable");
		expect(page.rows.map((row) => row.nativeId)).toEqual(["movie-1", "show-1"]);
	});

	it("keeps instances and same-title rows separate and rejects foreign or invalid authority", async () => {
		const { prisma, plex, otherPlex } = await database();
		await publish(prisma, plex);
		await publish(prisma, otherPlex, [{ ...libraryRows[1]!, nativeId: "same-show" }]);
		const first = await readNativeInventoryPage(prisma, {
			userId: "user-1",
			instanceId: "plex-1",
			domain: "library",
			now: NOW,
		});
		const second = await readNativeInventoryPage(prisma, {
			userId: "user-1",
			instanceId: "plex-2",
			domain: "library",
			now: NOW,
		});
		expect(first.status).toBe("available");
		expect(second.status).toBe("available");
		if (first.status !== "available" || second.status !== "available")
			throw new Error("page unavailable");
		expect(first.rows.map((row) => row.title)).toEqual(["Unmapped movie", "Same title"]);
		expect(second.rows.map((row) => row.title)).toEqual(["Same title"]);
		expect(
			(
				await readNativeInventoryPage(prisma, {
					userId: "user-2",
					instanceId: "plex-1",
					domain: "library",
					now: NOW,
				})
			).status,
		).toBe("unavailable");
		await prisma.serviceInstance.update({ where: { id: "plex-1" }, data: { enabled: false } });
		expect(
			(
				await readNativeInventoryPage(prisma, {
					userId: "user-1",
					instanceId: "plex-1",
					domain: "library",
					now: NOW,
				})
			).status,
		).toBe("unavailable");
	});

	it("records failures and lets a newer attempt supersede stale publication work", async () => {
		const { prisma, plex } = await database();
		const first = await publish(prisma, plex);
		expect(first.published.status).toBe("published");
		if (first.published.status !== "published") throw new Error("initial publication failed");
		const second = await beginNativeInventoryAttempt(prisma, {
			userId: "user-1",
			instance: plex,
			domains: ["library"],
			now: new Date(NOW.getTime() + 1_000),
		});
		const third = await beginNativeInventoryAttempt(prisma, {
			userId: "user-1",
			instance: plex,
			domains: ["library"],
			now: new Date(NOW.getTime() + 2_000),
		});
		expect(second.status).toBe("acquired");
		expect(third.status).toBe("acquired");
		if (second.status !== "acquired" || third.status !== "acquired")
			throw new Error("attempt was not acquired");
		expect(
			(
				await failNativeInventoryAttempt(prisma, {
					userId: "user-1",
					authority: first.begun.authority,
					attempt: second.attempt,
					reason: "provider-unavailable",
				})
			).status,
		).toBe("superseded");
		expect(
			(
				await failNativeInventoryAttempt(prisma, {
					userId: "user-1",
					authority: third.authority,
					attempt: third.attempt,
					reason: "provider-unavailable",
				})
			).status,
		).toBe("recorded");
		const page = await readNativeInventoryPage(prisma, {
			userId: "user-1",
			instanceId: "plex-1",
			domain: "library",
			now: new Date(NOW.getTime() + 3_000),
		});
		expect(page.status).toBe("available");
		if (page.status !== "available") throw new Error("page unavailable");
		expect(page.freshness).toBe("last-known");
		expect(page.rows).toHaveLength(2);
	});

	it("rejects a stale publisher after a newer attempt wins the native CAS", async () => {
		const { prisma, plex } = await database();
		const first = await publish(prisma, plex);
		expect(first.published.status).toBe("published");
		if (first.published.status !== "published") throw new Error("initial publication failed");
		const stale = await beginNativeInventoryAttempt(prisma, {
			userId: "user-1",
			instance: plex,
			domains: ["library"],
			now: new Date(NOW.getTime() + 1_000),
		});
		const newer = await beginNativeInventoryAttempt(prisma, {
			userId: "user-1",
			instance: plex,
			domains: ["library"],
			now: new Date(NOW.getTime() + 2_000),
		});
		expect(stale.status).toBe("acquired");
		expect(newer.status).toBe("acquired");
		if (stale.status !== "acquired" || newer.status !== "acquired")
			throw new Error("attempt was not acquired");
		await expect(
			prisma.$transaction((tx) =>
				publishNativeInventoriesInTransaction(tx, {
					userId: "user-1",
					authority: stale.authority,
					attempt: stale.attempt,
					snapshots: [{ domain: "library", scopeKeys: ["movies"], rows: [] }],
					now: new Date(NOW.getTime() + 2_000),
				}),
			),
		).resolves.toEqual({ status: "superseded" });
		const snapshot = await prisma.providerNativeInventorySnapshot.findUniqueOrThrow({
			where: { instanceId_domain: { instanceId: "plex-1", domain: "library" } },
		});
		expect(snapshot.generationId).toBe(first.published.generationId);
	});

	it("rejects publication and reads after the connection or identity generation changes", async () => {
		const { prisma, plex } = await database();
		await publish(prisma, plex);
		await prisma.serviceInstance.update({
			where: { id: "plex-1" },
			data: {
				connectionGeneration: 3,
				identityGeneration: 4,
				expectedIdentity: "changed-provider",
			},
		});
		const changed = await readNativeInventoryPage(prisma, {
			userId: "user-1",
			instanceId: "plex-1",
			domain: "library",
			now: new Date(NOW.getTime() + 1_000),
		});
		expect(changed).toEqual({ status: "unavailable", reason: "malformed-publication" });
		const staleAttempt = await beginNativeInventoryAttempt(prisma, {
			userId: "user-1",
			instance: plex,
			domains: ["library"],
			now: new Date(NOW.getTime() + 1_000),
		});
		expect(staleAttempt.status).toBe("superseded");
	});

	it("rejects selected malformed rows and row-count mismatches", async () => {
		const { prisma, plex } = await database();
		await publish(prisma, plex);
		await prisma.providerNativeInventoryItem.updateMany({
			where: { snapshot: { is: { instanceId: "plex-1", domain: "library" } }, nativeId: "movie-1" },
			data: { libraryIds: "not-json" },
		});
		expect(
			await readNativeInventoryPage(prisma, {
				userId: "user-1",
				instanceId: "plex-1",
				domain: "library",
				now: NOW,
			}),
		).toEqual({ status: "unavailable", reason: "malformed-publication" });
		await prisma.providerNativeInventoryItem.updateMany({
			where: { snapshot: { is: { instanceId: "plex-1", domain: "library" } }, nativeId: "movie-1" },
			data: { libraryIds: JSON.stringify(["movies"]) },
		});
		await prisma.providerNativeInventoryItem.deleteMany({
			where: { snapshot: { is: { instanceId: "plex-1", domain: "library" } }, nativeId: "show-1" },
		});
		expect(
			await readNativeInventoryPage(prisma, {
				userId: "user-1",
				instanceId: "plex-1",
				domain: "library",
				now: NOW,
			}),
		).toEqual({ status: "unavailable", reason: "malformed-publication" });
	});

	it("publishes an empty complete domain without inventing rows", async () => {
		const { prisma, plex } = await database();
		await publish(prisma, plex, [], { domain: "episode" });
		const page = await readNativeInventoryPage(prisma, {
			userId: "user-1",
			instanceId: "plex-1",
			domain: "episode",
			now: NOW,
		});
		expect(page.status).toBe("available");
		if (page.status !== "available") throw new Error("page unavailable");
		expect(page.complete).toBe(true);
		expect(page.rows).toEqual([]);
	});

	it("rolls back item replacement and metadata together when the transaction fails", async () => {
		const { prisma, plex } = await database();
		await publish(prisma, plex);
		await publish(prisma, plex, [], { domain: "episode" });
		const begun = await prisma.$transaction((tx) =>
			beginNativeInventoryAttemptInTransaction(tx, {
				userId: "user-1",
				instance: plex,
				domains: ["library", "episode"],
				now: new Date(NOW.getTime() + 1_000),
			}),
		);
		expect(begun.status).toBe("acquired");
		if (begun.status !== "acquired") throw new Error("attempt was not acquired");
		await expect(
			prisma.$transaction(async (tx) => {
				await publishNativeInventoriesInTransaction(tx, {
					userId: "user-1",
					authority: begun.authority,
					attempt: begun.attempt,
					snapshots: [
						{ domain: "library", scopeKeys: ["movies"], rows: [libraryRows[0]!] },
						{ domain: "episode", scopeKeys: ["shows"], rows: [] },
					],
					now: new Date(NOW.getTime() + 1_000),
				});
				throw new Error("fault after complete native publication");
			}),
		).rejects.toThrow("fault after complete native publication");
		const page = await readNativeInventoryPage(prisma, {
			userId: "user-1",
			instanceId: "plex-1",
			domain: "library",
			now: new Date(NOW.getTime() + 1_000),
		});
		expect(page.status).toBe("available");
		if (page.status !== "available") throw new Error("page unavailable");
		expect(page.rows.map((row) => row.nativeId)).toEqual(["movie-1", "show-1"]);
	});

	it("rejects invalid date and pagination inputs before reading or publishing", async () => {
		const { prisma, plex } = await database();
		await expect(
			readNativeInventoryPage(prisma, {
				userId: "user-1",
				instanceId: "plex-1",
				domain: "library",
				afterNativeId: "cursor",
			}),
		).rejects.toThrow();
		await expect(
			readNativeInventoryPage(prisma, {
				userId: "user-1",
				instanceId: "plex-1",
				domain: "library",
				limit: 0,
			}),
		).rejects.toThrow();
		await expect(
			readNativeInventoryPage(prisma, {
				userId: "user-1",
				instanceId: "plex-1",
				domain: "library",
				now: new Date("invalid"),
			}),
		).rejects.toThrow();
		const begun = await beginNativeInventoryAttempt(prisma, {
			userId: "user-1",
			instance: plex,
			domains: ["library"],
			now: NOW,
		});
		expect(begun.status).toBe("acquired");
		if (begun.status !== "acquired") throw new Error("attempt was not acquired");
		await expect(
			prisma.$transaction((tx) =>
				publishNativeInventoriesInTransaction(tx, {
					userId: "user-1",
					authority: begun.authority,
					attempt: begun.attempt,
					snapshots: [{ domain: "library", scopeKeys: ["movies"], rows: [] }],
					now: new Date("invalid"),
				}),
			),
		).rejects.toThrow();
	});
});
