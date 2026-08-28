import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	evaluateTautulliCacheAuthority,
	readOwnedTautulliCacheAuthority,
	readUserSelectedTautulliCache,
} from "../tautulli-cache-authority.js";

const allowedProductionAccess = new Set([
	path.normalize("src/lib/tautulli/tautulli-cache-authority.ts"),
	path.normalize("src/lib/tautulli/tautulli-cache-refresher.ts"),
	path.normalize("src/lib/services/service-identity-lifecycle.ts"),
]);

async function productionTypeScriptFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (
				["__tests__", "fixtures", "generated", "node_modules", "dist", ".next"].includes(entry.name)
			) {
				continue;
			}
			files.push(...(await productionTypeScriptFiles(absolute)));
			continue;
		}
		if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
		files.push(absolute);
	}
	return files;
}

const now = new Date("2026-08-28T12:00:00.000Z");
const instance = {
	id: "tautulli-1",
	userId: "user-1",
	service: "TAUTULLI",
	enabled: true,
	expectedIdentity: "pms-a",
	identityStatus: "VERIFIED",
	connectionGeneration: 4,
	identityGeneration: 9,
};
const status = {
	lastRefreshedAt: new Date("2026-08-28T11:00:00.000Z"),
	lastResult: "success",
	lastErrorMessage: null,
	itemCount: 2,
	lastAttemptAt: new Date("2026-08-28T11:00:00.000Z"),
	lastAttemptResult: "success",
	lastAttemptErrorMessage: null,
	connectionGeneration: 4,
	identityGeneration: 9,
};

describe("Tautulli cache authority", () => {
	it("recognizes only a fresh complete exact-generation publication", () => {
		expect(
			evaluateTautulliCacheAuthority(instance, status, { total: 2, exact: 2 }, { now }),
		).toEqual(
			expect.objectContaining({
				available: true,
				state: "healthy_complete",
				reasonCodes: [],
				cachedItems: 2,
			}),
		);
	});

	it.each([
		["disabled", { instance: { enabled: false }, reason: "instance_disabled" }],
		["unverified", { instance: { identityStatus: "UNVERIFIED" }, reason: "identity_unverified" }],
		["missing identity", { instance: { expectedIdentity: null }, reason: "identity_unverified" }],
		["missing status", { status: null, reason: "no_publication", state: "no_publication" }],
		[
			"in progress",
			{
				status: { lastAttemptResult: "in_progress:new" },
				reason: "refresh_in_progress",
				state: "in_progress",
			},
		],
		[
			"failed attempt",
			{
				status: { lastAttemptResult: "error", lastAttemptErrorMessage: "provider leaked text" },
				reason: "refresh_failed",
			},
		],
		[
			"stale status generation",
			{ status: { identityGeneration: 8 }, reason: "cache_generation_stale" },
		],
		["mixed row generations", { counts: { total: 2, exact: 1 }, reason: "cache_rows_stale" }],
		["row count mismatch", { counts: { total: 1, exact: 1 }, reason: "cache_rows_stale" }],
		[
			"expired publication",
			{
				status: {
					lastRefreshedAt: new Date("2026-08-27T22:00:00.000Z"),
					lastAttemptAt: new Date("2026-08-27T22:00:00.000Z"),
				},
				reason: "cache_stale",
			},
		],
	] as const)("fails closed for %s", (_label, scenario) => {
		const scenarioRecord = scenario as {
			instance?: Partial<typeof instance>;
			status?: Partial<typeof status> | null;
			counts?: { total: number; exact: number };
			reason: string;
			state?: string;
		};
		const evaluated = evaluateTautulliCacheAuthority(
			{ ...instance, ...(scenarioRecord.instance ?? {}) },
			scenarioRecord.status === null ? null : { ...status, ...(scenarioRecord.status ?? {}) },
			scenarioRecord.counts ?? { total: 2, exact: 2 },
			{ now },
		);
		expect(evaluated.available).toBe(false);
		expect(evaluated.state).toBe(scenarioRecord.state ?? "failed_unavailable");
		expect(evaluated.reasonCodes).toContain(scenarioRecord.reason);
		expect(evaluated.cachedItems).toBeNull();
		expect(JSON.stringify(evaluated)).not.toContain("provider leaked text");
	});

	it("scopes every status and row query through the owned instance relation", async () => {
		const prisma = {
			$transaction: vi.fn(
				async (operation: (tx: unknown) => Promise<unknown>) => await operation(prisma),
			),
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
			cacheRefreshStatus: { findFirst: vi.fn().mockResolvedValue(status) },
			tautulliCache: { count: vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(2) },
		};

		const result = await readOwnedTautulliCacheAuthority(prisma as never, {
			userId: "user-1",
			instanceId: "tautulli-1",
			now,
		});

		expect(result?.available).toBe(true);
		expect(prisma.serviceInstance.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "tautulli-1", userId: "user-1" }),
			}),
		);
		expect(prisma.cacheRefreshStatus.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					instanceId: "tautulli-1",
					cacheType: "tautulli",
					instance: { userId: "user-1" },
				},
				select: expect.objectContaining({
					connectionGeneration: true,
					identityGeneration: true,
					lastAttemptResult: true,
				}),
			}),
		);
		for (const call of prisma.tautulliCache.count.mock.calls) {
			expect(call[0].where.instance).toEqual({ userId: "user-1" });
		}
		expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
			isolationLevel: "Serializable",
			timeout: expect.any(Number),
		});
	});

	it("does not combine a pre-claim status with reads after a new attempt claim", async () => {
		let durableStatus = { ...status };
		const postClaimSnapshot = {
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
			cacheRefreshStatus: {
				findFirst: vi.fn(async () => durableStatus),
			},
			tautulliCache: { count: vi.fn().mockResolvedValue(2) },
		};
		const prisma = {
			$transaction: vi.fn(async (operation: (tx: typeof postClaimSnapshot) => Promise<unknown>) => {
				durableStatus = { ...status, lastAttemptResult: "in_progress:new-token" };
				return await operation(postClaimSnapshot);
			}),
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
			cacheRefreshStatus: {
				findFirst: vi.fn(async () => {
					const observed = durableStatus;
					durableStatus = { ...status, lastAttemptResult: "in_progress:new-token" };
					return observed;
				}),
			},
			tautulliCache: { count: vi.fn().mockResolvedValue(2) },
		};

		await expect(
			readOwnedTautulliCacheAuthority(prisma as never, {
				userId: "user-1",
				instanceId: "tautulli-1",
				now,
			}),
		).resolves.toMatchObject({
			available: false,
			state: "in_progress",
			reasonCodes: ["refresh_in_progress"],
			cachedItems: null,
		});
		expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
			isolationLevel: "Serializable",
			timeout: expect.any(Number),
		});
		expect(prisma.serviceInstance.findFirst).not.toHaveBeenCalled();
		expect(prisma.cacheRefreshStatus.findFirst).not.toHaveBeenCalled();
		expect(prisma.tautulliCache.count).not.toHaveBeenCalled();
	});

	it("retries the complete authority snapshot after a transaction conflict", async () => {
		const postClaimSnapshot = {
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
			cacheRefreshStatus: {
				findFirst: vi.fn().mockResolvedValue({
					...status,
					lastAttemptResult: "in_progress:new-token",
				}),
			},
			tautulliCache: { count: vi.fn().mockResolvedValue(2) },
		};
		const transaction = vi
			.fn()
			.mockRejectedValueOnce(Object.assign(new Error("transaction conflict"), { code: "P2034" }))
			.mockImplementationOnce(
				async (operation: (tx: typeof postClaimSnapshot) => Promise<unknown>) =>
					await operation(postClaimSnapshot),
			);

		await expect(
			readOwnedTautulliCacheAuthority({ $transaction: transaction } as never, {
				userId: "user-1",
				instanceId: "tautulli-1",
				now,
			}),
		).resolves.toMatchObject({
			available: false,
			state: "in_progress",
			reasonCodes: ["refresh_in_progress"],
			cachedItems: null,
		});
		expect(transaction).toHaveBeenCalledTimes(2);
		expect(postClaimSnapshot.serviceInstance.findFirst).toHaveBeenCalledOnce();
	});

	it("returns bounded unavailable after exhausting authority snapshot retries", async () => {
		const transaction = vi.fn().mockRejectedValue(
			Object.assign(new Error("database is locked: secret-provider-path"), {
				code: "SQLITE_BUSY",
			}),
		);

		const result = await readOwnedTautulliCacheAuthority({ $transaction: transaction } as never, {
			userId: "user-1",
			instanceId: "tautulli-1",
			now,
		});

		expect(result).toEqual({
			available: false,
			state: "failed_unavailable",
			reasonCodes: ["unknown_failure"],
			cachedItems: null,
			lastRefreshedAt: null,
		});
		expect(JSON.stringify(result)).not.toContain("secret-provider-path");
		expect(transaction).toHaveBeenCalledTimes(3);
	});

	it("makes a foreign instance indistinguishable from a missing instance", async () => {
		const prisma = {
			$transaction: vi.fn(
				async (operation: (tx: unknown) => Promise<unknown>) => await operation(prisma),
			),
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(null) },
			cacheRefreshStatus: { findFirst: vi.fn() },
			tautulliCache: { count: vi.fn() },
		};
		await expect(
			readOwnedTautulliCacheAuthority(prisma as never, {
				userId: "user-2",
				instanceId: "tautulli-1",
				now,
			}),
		).resolves.toBeNull();
		expect(prisma.cacheRefreshStatus.findFirst).not.toHaveBeenCalled();
		expect(prisma.tautulliCache.count).not.toHaveBeenCalled();
	});

	it("cursor-paginates selected rows with tenant and exact-generation scope on every page", async () => {
		const rows = Array.from({ length: 101 }, (_, index) => ({
			id: `row-${String(index + 1).padStart(3, "0")}`,
			instanceId: "tautulli-1",
			tmdbId: index + 1,
			mediaType: index % 2 === 0 ? "movie" : "series",
		}));
		const prisma = {
			$transaction: vi.fn(
				async (operation: (tx: unknown) => Promise<unknown>) => await operation(prisma),
			),
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([instance]),
				findFirst: vi.fn().mockResolvedValue(instance),
			},
			cacheRefreshStatus: {
				findFirst: vi.fn().mockResolvedValue({ ...status, itemCount: rows.length }),
			},
			tautulliCache: {
				count: vi.fn().mockResolvedValue(rows.length),
				findMany: vi
					.fn()
					.mockResolvedValueOnce(rows.slice(0, 100))
					.mockResolvedValueOnce(rows.slice(100)),
			},
		};

		const result = await readUserSelectedTautulliCache(prisma as never, {
			userId: "user-1",
			targets: rows.map((row) => ({
				tmdbId: row.tmdbId,
				mediaType: row.mediaType as "movie" | "series",
			})),
			now,
		});

		expect(result).toMatchObject({ configured: true, available: true, rows });
		expect(prisma.tautulliCache.findMany).toHaveBeenCalledTimes(2);
		for (const call of prisma.tautulliCache.findMany.mock.calls) {
			expect(call[0].where).toEqual(
				expect.objectContaining({
					instance: { userId: "user-1" },
					instanceId: "tautulli-1",
					connectionGeneration: 4,
					identityGeneration: 9,
				}),
			);
		}
		expect(prisma.tautulliCache.findMany.mock.calls.map(([query]) => query.take)).toEqual([
			100, 100,
		]);
	});

	it("keeps lifecycle clearing between validation and row loading inside one Serializable snapshot", async () => {
		const selectedRow = {
			id: "row-1",
			instanceId: "tautulli-1",
			tmdbId: 1,
			mediaType: "movie",
			lastWatchedAt: now,
			watchCount: 2,
			watchedByUsers: "[]",
		};
		const snapshotPrisma = {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([instance]),
				findFirst: vi.fn().mockResolvedValue(instance),
			},
			cacheRefreshStatus: { findFirst: vi.fn().mockResolvedValue({ ...status, itemCount: 1 }) },
			tautulliCache: {
				count: vi.fn().mockResolvedValue(1),
				findMany: vi.fn().mockResolvedValue([selectedRow]),
			},
		};
		const prisma = {
			$transaction: vi.fn(
				async (operation: (tx: typeof snapshotPrisma) => Promise<unknown>) =>
					await operation(snapshotPrisma),
			),
			// These root delegates model the mixed split-read result after the
			// lifecycle reset clears status and rows between validation and use.
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([instance]),
				findFirst: vi.fn().mockResolvedValue(instance),
			},
			cacheRefreshStatus: { findFirst: vi.fn().mockResolvedValue({ ...status, itemCount: 1 }) },
			tautulliCache: {
				count: vi.fn().mockResolvedValue(1),
				findMany: vi.fn().mockResolvedValue([]),
			},
		};

		await expect(
			readUserSelectedTautulliCache(prisma as never, {
				userId: "user-1",
				targets: [{ tmdbId: 1, mediaType: "movie" }],
				now,
			}),
		).resolves.toMatchObject({
			configured: true,
			available: true,
			reasonCodes: [],
			rows: [selectedRow],
		});
		expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
			isolationLevel: "Serializable",
			timeout: expect.any(Number),
		});
		expect(prisma.serviceInstance.findMany).not.toHaveBeenCalled();
	});

	it("quarantines ambiguous multiple Tautulli sources before any row read", async () => {
		const prisma = {
			$transaction: vi.fn(
				async (operation: (tx: unknown) => Promise<unknown>) => await operation(prisma),
			),
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([instance, { ...instance, id: "tautulli-2" }]),
			},
			tautulliCache: { findMany: vi.fn() },
		};
		await expect(
			readUserSelectedTautulliCache(prisma as never, {
				userId: "user-1",
				targets: [{ tmdbId: 1, mediaType: "movie" }],
			}),
		).resolves.toMatchObject({
			configured: true,
			available: false,
			reasonCodes: ["tautulli_mapping_required"],
			rows: [],
		});
		expect(prisma.tautulliCache.findMany).not.toHaveBeenCalled();
	});

	it("retries the complete Serializable snapshot after a transaction conflict", async () => {
		const postResetSnapshot = {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([{ ...instance, connectionGeneration: 5 }]),
				findFirst: vi.fn().mockResolvedValue({ ...instance, connectionGeneration: 5 }),
			},
			cacheRefreshStatus: { findFirst: vi.fn().mockResolvedValue(null) },
			tautulliCache: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn() },
		};
		const transaction = vi
			.fn()
			.mockRejectedValueOnce(
				Object.assign(new Error("transaction conflict"), {
					code: "P2010",
					meta: { driverAdapterError: { cause: { originalCode: "40001" } } },
				}),
			)
			.mockImplementationOnce(
				async (operation: (tx: typeof postResetSnapshot) => Promise<unknown>) =>
					await operation(postResetSnapshot),
			);

		await expect(
			readUserSelectedTautulliCache({ $transaction: transaction } as never, {
				userId: "user-1",
				targets: [{ tmdbId: 1, mediaType: "movie" }],
				now,
			}),
		).resolves.toMatchObject({
			configured: true,
			available: false,
			reasonCodes: ["no_publication"],
			rows: [],
		});
		expect(transaction).toHaveBeenCalledTimes(2);
		expect(postResetSnapshot.serviceInstance.findMany).toHaveBeenCalledOnce();
	});

	it("returns bounded unavailable after exhausting transaction retries", async () => {
		const transaction = vi.fn().mockRejectedValue(
			Object.assign(new Error("database is locked: secret-provider-path"), {
				code: "SQLITE_BUSY",
			}),
		);

		const result = await readUserSelectedTautulliCache({ $transaction: transaction } as never, {
			userId: "user-1",
			targets: [{ tmdbId: 1, mediaType: "movie" }],
			now,
		});

		expect(result).toEqual({
			configured: true,
			available: false,
			reasonCodes: ["unknown_failure"],
			rows: [],
		});
		expect(JSON.stringify(result)).not.toContain("secret-provider-path");
		expect(transaction).toHaveBeenCalledTimes(3);
	});

	it("rejects an oversized selection before opening a transaction", async () => {
		const transaction = vi.fn();
		const targets = Array.from({ length: 201 }, (_, index) => ({
			tmdbId: index + 1,
			mediaType: "movie" as const,
		}));

		await expect(
			readUserSelectedTautulliCache({ $transaction: transaction } as never, {
				userId: "user-1",
				targets,
			}),
		).resolves.toEqual({
			configured: true,
			available: false,
			reasonCodes: ["unknown_failure"],
			rows: [],
		});
		expect(transaction).not.toHaveBeenCalled();
	});

	it("keeps every production Prisma access behind publication, lifecycle, or currentness", async () => {
		const sourceRoot = path.resolve(process.cwd(), "src");
		const bypasses: string[] = [];
		for (const file of await productionTypeScriptFiles(sourceRoot)) {
			const relative = path.normalize(path.relative(process.cwd(), file));
			if (allowedProductionAccess.has(relative)) continue;
			const source = await readFile(file, "utf8");
			for (const [index, line] of source.split("\n").entries()) {
				if (/\.tautulliCache\s*(?:\?\.|\.)/.test(line)) {
					bypasses.push(`${relative}:${index + 1}: ${line.trim()}`);
				}
			}
		}
		expect(bypasses, `Direct production Tautulli cache access:\n${bypasses.join("\n")}`).toEqual(
			[],
		);
	});
});
