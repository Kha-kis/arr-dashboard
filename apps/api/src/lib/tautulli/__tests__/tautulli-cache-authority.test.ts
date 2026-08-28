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
		expect(JSON.stringify(evaluated)).not.toContain("provider leaked text");
	});

	it("scopes every status and row query through the owned instance relation", async () => {
		const prisma = {
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
		expect(prisma.cacheRefreshStatus.findFirst).toHaveBeenCalledWith({
			where: {
				instanceId: "tautulli-1",
				cacheType: "tautulli",
				instance: { userId: "user-1" },
			},
		});
		for (const call of prisma.tautulliCache.count.mock.calls) {
			expect(call[0].where.instance).toEqual({ userId: "user-1" });
		}
	});

	it("makes a foreign instance indistinguishable from a missing instance", async () => {
		const prisma = {
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
		const rows = [
			{ id: "row-1", instanceId: "tautulli-1", tmdbId: 1, mediaType: "movie" },
			{ id: "row-2", instanceId: "tautulli-1", tmdbId: 2, mediaType: "series" },
		];
		const prisma = {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([instance]),
				findFirst: vi.fn().mockResolvedValue(instance),
			},
			cacheRefreshStatus: { findFirst: vi.fn().mockResolvedValue(status) },
			tautulliCache: {
				count: vi.fn().mockResolvedValue(2),
				findMany: vi.fn().mockResolvedValueOnce([rows[0]]).mockResolvedValueOnce([rows[1]]),
			},
		};

		const result = await readUserSelectedTautulliCache(prisma as never, {
			userId: "user-1",
			targets: [
				{ tmdbId: 1, mediaType: "movie" },
				{ tmdbId: 2, mediaType: "series" },
			],
			now,
			pageSize: 1,
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
	});

	it("quarantines ambiguous multiple Tautulli sources before any row read", async () => {
		const prisma = {
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
