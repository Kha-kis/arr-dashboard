/**
 * Unit tests for triggerLabelSyncForItem — the foundation that B/C/D all
 * use to fire Label Sync rules in response to per-item events.
 *
 * Mocks the rule-execution layer (executeLabelSyncRule) since this file
 * is just orchestration: rule lookup + tmdbId resolution + per-rule
 * isolated invocation.
 */

import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted; use vi.hoisted to share state cleanly with the factory.
const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../execute-rule.js", () => ({
	executeLabelSyncRule: executeMock,
}));

import { triggerLabelSyncForItem } from "../trigger-for-item.js";

const log = {
	child: vi.fn().mockReturnThis(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
} as unknown as FastifyBaseLogger;

const okOutcome = {
	status: "success" as const,
	message: "ok",
	totals: {
		sourceInstancesScanned: 1,
		taggedItemsFound: 1,
		destMatchesFound: 1,
		labelsApplied: 1,
		failures: 0,
	},
};

const makePrisma = (overrides: { rules?: unknown[]; cacheData?: string | null }) =>
	({
		labelSyncRule: {
			findMany: vi.fn().mockResolvedValue(overrides.rules ?? []),
		},
		libraryCache: {
			findFirst: vi
				.fn()
				.mockResolvedValue(
					overrides.cacheData !== undefined ? { data: overrides.cacheData } : null,
				),
		},
	}) as never;

const makeArgs = (over: Partial<Parameters<typeof triggerLabelSyncForItem>[0]> = {}) => ({
	userId: "user-1",
	sourceService: "RADARR" as const,
	sourceInstanceId: "inst-1",
	arrItemId: 100,
	itemType: "movie" as const,
	tagName: "kids",
	prisma: makePrisma({}),
	arrClientFactory: {} as never,
	encryptor: {} as never,
	log,
	...over,
});

describe("triggerLabelSyncForItem", () => {
	beforeEach(() => {
		executeMock.mockReset();
		executeMock.mockResolvedValue(okOutcome);
	});

	it("returns zero result when no matching rules exist", async () => {
		const result = await triggerLabelSyncForItem(makeArgs({ prisma: makePrisma({ rules: [] }) }));
		expect(result.rulesFired).toBe(0);
		expect(executeMock).not.toHaveBeenCalled();
	});

	it("looks up rules with lowercased sourceService and the optional tagName filter", async () => {
		const prisma = makePrisma({
			rules: [
				{
					id: "r1",
					name: "kids",
					userId: "user-1",
					sourceService: "radarr",
					sourceInstanceId: "inst-1",
					sourceTagName: "kids",
					destService: "plex",
					destInstanceId: "plex-1",
					destTagName: "kids",
				},
			],
			cacheData: JSON.stringify({ tmdbId: 555 }),
		});
		await triggerLabelSyncForItem(makeArgs({ prisma }));

		const findMany = (
			prisma as unknown as { labelSyncRule: { findMany: ReturnType<typeof vi.fn> } }
		).labelSyncRule.findMany;
		expect(findMany).toHaveBeenCalledOnce();
		const where = findMany.mock.calls[0]?.[0]?.where;
		expect(where.sourceService).toBe("radarr"); // lowercased!
		expect(where.userId).toBe("user-1");
		expect(where.enabled).toBe(true);
		expect(where.sourceTagName).toBe("kids");
	});

	it("skips when tmdbId is unresolvable (item not in cache)", async () => {
		const prisma = makePrisma({
			rules: [
				{
					id: "r1",
					name: "kids",
					userId: "user-1",
					sourceService: "radarr",
					sourceInstanceId: "inst-1",
					sourceTagName: "kids",
					destService: "plex",
					destInstanceId: "plex-1",
					destTagName: "kids",
				},
			],
			cacheData: null, // no cache row
		});
		const result = await triggerLabelSyncForItem(makeArgs({ prisma }));
		expect(result.rulesFired).toBe(0);
		expect(executeMock).not.toHaveBeenCalled();
	});

	it("uses explicit tmdbId when provided (no cache lookup)", async () => {
		const prisma = makePrisma({
			rules: [
				{
					id: "r1",
					name: "kids",
					userId: "user-1",
					sourceService: "radarr",
					sourceInstanceId: "inst-1",
					sourceTagName: "kids",
					destService: "plex",
					destInstanceId: "plex-1",
					destTagName: "kids",
				},
			],
		});
		await triggerLabelSyncForItem(makeArgs({ prisma, tmdbId: 999 }));

		expect(executeMock).toHaveBeenCalledOnce();
		expect(executeMock.mock.calls[0]?.[0]?.targetTmdbId).toBe(999);
		const findFirst = (
			prisma as unknown as { libraryCache: { findFirst: ReturnType<typeof vi.fn> } }
		).libraryCache.findFirst;
		expect(findFirst).not.toHaveBeenCalled();
	});

	it("fires every matching rule independently — one failure doesn't block others", async () => {
		const prisma = makePrisma({
			rules: [
				{
					id: "r1",
					name: "kids",
					userId: "user-1",
					sourceService: "radarr",
					sourceInstanceId: "inst-1",
					sourceTagName: "kids",
					destService: "plex",
					destInstanceId: "plex-1",
					destTagName: "kids",
				},
				{
					id: "r2",
					name: "kids-jelly",
					userId: "user-1",
					sourceService: "radarr",
					sourceInstanceId: "inst-1",
					sourceTagName: "kids",
					destService: "jellyfin",
					destInstanceId: "jelly-1",
					destTagName: "kids",
				},
			],
		});
		executeMock
			.mockResolvedValueOnce({ ...okOutcome })
			.mockRejectedValueOnce(new Error("plex unreachable"));

		const result = await triggerLabelSyncForItem(makeArgs({ prisma, tmdbId: 100 }));

		expect(result.rulesFired).toBe(2);
		expect(result.results).toHaveLength(2);
		expect(result.results[0]?.outcome.status).toBe("success");
		expect(result.results[1]?.outcome.status).toBe("failed");
		expect(result.totals.failures).toBe(1);
		expect(result.totals.labelsApplied).toBe(1);
	});

	it("includes rules with sourceInstanceId=null (match-all-instances rules)", async () => {
		// Schema allows null sourceInstanceId meaning "match every enabled
		// instance of the source service". The trigger lookup must include
		// these via OR.
		const prisma = makePrisma({});
		await triggerLabelSyncForItem(makeArgs({ prisma, tmdbId: 1 }));

		const findMany = (
			prisma as unknown as { labelSyncRule: { findMany: ReturnType<typeof vi.fn> } }
		).labelSyncRule.findMany;
		const where = findMany.mock.calls[0]?.[0]?.where;
		expect(where.OR).toEqual([{ sourceInstanceId: "inst-1" }, { sourceInstanceId: null }]);
	});

	it("omits sourceTagName filter when tagName not provided (D — fire-all-rules-for-instance)", async () => {
		const prisma = makePrisma({});
		await triggerLabelSyncForItem(makeArgs({ tagName: undefined, prisma, tmdbId: 1 }));
		const findMany = (
			prisma as unknown as { labelSyncRule: { findMany: ReturnType<typeof vi.fn> } }
		).labelSyncRule.findMany;
		const where = findMany.mock.calls[0]?.[0]?.where;
		expect(where.sourceTagName).toBeUndefined();
	});
});
