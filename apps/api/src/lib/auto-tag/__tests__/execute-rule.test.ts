/**
 * Auto-tag executor orchestration tests.
 *
 * Mocks the criteria evaluator + prefetch context builder to focus on the
 * orchestration logic in `executeAutoTagRule`: instance resolution, item
 * filtering, tag-write batching, idempotency, partial failures.
 *
 * The criteria-evaluation correctness itself is covered by library-cleanup's
 * own evaluator tests (we share the same `evaluateSingleCondition`).
 */

import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceInstance } from "../../prisma.js";
import type { AutoTagRuleInput } from "../execute-rule.js";

// Hoist-friendly mock holders the vi.mock factory writes into / reads from.
const mockState: {
	evaluateReason: string | null;
	evaluateCalls: number;
	buildContextThrows: boolean;
} = {
	evaluateReason: "matched",
	evaluateCalls: 0,
	buildContextThrows: false,
};

vi.mock("../../library-cleanup/rule-evaluators.js", () => ({
	evaluateSingleCondition: vi.fn(() => {
		mockState.evaluateCalls++;
		return mockState.evaluateReason;
	}),
}));

vi.mock("../../library-cleanup/cleanup-executor.js", () => ({
	buildEvalContext: vi.fn(async () => {
		if (mockState.buildContextThrows) {
			throw new Error("prefetch failed");
		}
		return { now: new Date() };
	}),
}));

import { executeAutoTagRule } from "../execute-rule.js";

const log = {
	child: vi.fn().mockReturnThis(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
} as unknown as FastifyBaseLogger;

function makeInstance(overrides: Partial<ServiceInstance> = {}): ServiceInstance {
	return {
		id: "inst-1",
		userId: "user-1",
		service: "RADARR",
		label: "Radarr",
		baseUrl: "http://radarr:7878",
		externalUrl: null,
		encryptedApiKey: "x",
		encryptionIv: "y",
		enabled: true,
		isDefault: true,
		storageGroupId: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	} as ServiceInstance;
}

function makeCacheItem(over: {
	id: string;
	arrItemId: number;
	itemType: "movie" | "series";
	existingTags?: number[];
}) {
	const data = JSON.stringify({ tags: over.existingTags ?? [] });
	return {
		id: over.id,
		instanceId: "inst-1",
		arrItemId: over.arrItemId,
		itemType: over.itemType,
		title: `Title ${over.arrItemId}`,
		year: 2020,
		monitored: true,
		hasFile: true,
		status: "available",
		qualityProfileId: 1,
		qualityProfileName: "HD",
		sizeOnDisk: BigInt(1000000),
		arrAddedAt: new Date(),
		data,
	};
}

function makeRule(over: Partial<AutoTagRuleInput> = {}): AutoTagRuleInput {
	return {
		id: "rule-1",
		userId: "user-1",
		name: "Tag premium",
		ruleType: "audio_channels",
		parameters: { operator: "greater_than", channels: 5 },
		operator: null,
		conditions: null,
		serviceFilter: null,
		instanceFilter: null,
		excludeTags: null,
		excludeTitles: null,
		plexLibraryFilter: null,
		tagName: "premium",
		...over,
	};
}

interface MockArrClient {
	tag: {
		getAll: ReturnType<typeof vi.fn>;
		create: ReturnType<typeof vi.fn>;
	};
	movie: {
		update: ReturnType<typeof vi.fn>;
	};
	series: {
		update: ReturnType<typeof vi.fn>;
	};
}

function makeArrClient(): MockArrClient {
	return {
		tag: {
			getAll: vi.fn().mockResolvedValue([{ id: 7, label: "premium" }]),
			create: vi.fn().mockResolvedValue({ id: 7, label: "premium" }),
		},
		movie: { update: vi.fn().mockResolvedValue({}) },
		series: { update: vi.fn().mockResolvedValue({}) },
	};
}

describe("executeAutoTagRule (orchestration)", () => {
	beforeEach(async () => {
		mockState.evaluateReason = "matched";
		mockState.evaluateCalls = 0;
		mockState.buildContextThrows = false;

		// Restore the default mock implementation — individual tests sometimes
		// override `evaluateSingleCondition.mockImplementation(...)` and the
		// override would otherwise leak into subsequent tests.
		const evalMod = await import("../../library-cleanup/rule-evaluators.js");
		(evalMod.evaluateSingleCondition as ReturnType<typeof vi.fn>).mockImplementation(() => {
			mockState.evaluateCalls++;
			return mockState.evaluateReason;
		});
	});

	it("happy path: matched item gets the tag applied via series/movie.update", async () => {
		const arrClient = makeArrClient();
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([makeInstance()]) },
			libraryCache: {
				findMany: vi
					.fn()
					.mockResolvedValue([makeCacheItem({ id: "li-1", arrItemId: 100, itemType: "movie" })]),
			},
		};
		const arrClientFactory = { create: vi.fn().mockReturnValue(arrClient) };

		const result = await executeAutoTagRule({
			rule: makeRule(),
			prisma: prisma as never,
			arrClientFactory: arrClientFactory as never,
			encryptor: {} as never,
			log,
		});

		expect(result.status).toBe("success");
		expect(result.totals.itemsMatched).toBe(1);
		expect(result.totals.tagsApplied).toBe(1);
		expect(arrClient.movie.update).toHaveBeenCalledWith(100, { id: 100, tags: [7] });
	});

	it("idempotent: item that already has the tag counts as applied without re-update", async () => {
		const arrClient = makeArrClient();
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([makeInstance()]) },
			libraryCache: {
				findMany: vi
					.fn()
					.mockResolvedValue([
						makeCacheItem({ id: "li-1", arrItemId: 100, itemType: "movie", existingTags: [7] }),
					]),
			},
		};
		const arrClientFactory = { create: vi.fn().mockReturnValue(arrClient) };

		const result = await executeAutoTagRule({
			rule: makeRule(),
			prisma: prisma as never,
			arrClientFactory: arrClientFactory as never,
			encryptor: {} as never,
			log,
		});

		expect(result.status).toBe("success");
		expect(result.totals.tagsApplied).toBe(1);
		expect(arrClient.movie.update).not.toHaveBeenCalled(); // skipped — already tagged
	});

	it("merges new tag id with existing tags rather than replacing", async () => {
		const arrClient = makeArrClient();
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([makeInstance()]) },
			libraryCache: {
				findMany: vi.fn().mockResolvedValue([
					makeCacheItem({
						id: "li-1",
						arrItemId: 100,
						itemType: "movie",
						existingTags: [3, 5],
					}),
				]),
			},
		};
		const arrClientFactory = { create: vi.fn().mockReturnValue(arrClient) };

		await executeAutoTagRule({
			rule: makeRule(),
			prisma: prisma as never,
			arrClientFactory: arrClientFactory as never,
			encryptor: {} as never,
			log,
		});

		expect(arrClient.movie.update).toHaveBeenCalledWith(100, {
			id: 100,
			tags: [3, 5, 7],
		});
	});

	it("non-matching item: no write, status success with 'no items matched' message", async () => {
		mockState.evaluateReason = null;
		const arrClient = makeArrClient();
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([makeInstance()]) },
			libraryCache: {
				findMany: vi
					.fn()
					.mockResolvedValue([makeCacheItem({ id: "li-1", arrItemId: 100, itemType: "movie" })]),
			},
		};
		const arrClientFactory = { create: vi.fn().mockReturnValue(arrClient) };

		const result = await executeAutoTagRule({
			rule: makeRule(),
			prisma: prisma as never,
			arrClientFactory: arrClientFactory as never,
			encryptor: {} as never,
			log,
		});

		expect(result.status).toBe("success");
		expect(result.totals.itemsMatched).toBe(0);
		expect(arrClient.movie.update).not.toHaveBeenCalled();
	});

	it("excludeTags filter: items carrying any excluded tag are skipped before evaluation", async () => {
		const arrClient = makeArrClient();
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([makeInstance()]) },
			libraryCache: {
				findMany: vi
					.fn()
					.mockResolvedValue([
						makeCacheItem({ id: "li-1", arrItemId: 100, itemType: "movie", existingTags: [99] }),
						makeCacheItem({ id: "li-2", arrItemId: 200, itemType: "movie", existingTags: [] }),
					]),
			},
		};
		const arrClientFactory = { create: vi.fn().mockReturnValue(arrClient) };

		const result = await executeAutoTagRule({
			rule: makeRule({ excludeTags: [99] }),
			prisma: prisma as never,
			arrClientFactory: arrClientFactory as never,
			encryptor: {} as never,
			log,
		});

		expect(result.totals.itemsScanned).toBe(2);
		expect(result.totals.itemsMatched).toBe(1); // only li-2 evaluated
		expect(result.totals.tagsApplied).toBe(1);
	});

	it("composite AND rule: requires every condition to match", async () => {
		const arrClient = makeArrClient();
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([makeInstance()]) },
			libraryCache: {
				findMany: vi
					.fn()
					.mockResolvedValue([makeCacheItem({ id: "li-1", arrItemId: 100, itemType: "movie" })]),
			},
		};
		const arrClientFactory = { create: vi.fn().mockReturnValue(arrClient) };

		// First condition matches, second does not — AND should be false
		let callCount = 0;
		const reasons: Array<string | null> = ["matched", null];
		mockState.evaluateReason = "matched"; // overridden per-call below
		const evalMod = await import("../../library-cleanup/rule-evaluators.js");
		(evalMod.evaluateSingleCondition as ReturnType<typeof vi.fn>).mockImplementation(() => {
			return reasons[callCount++] ?? null;
		});

		const result = await executeAutoTagRule({
			rule: makeRule({
				ruleType: "composite",
				operator: "AND",
				conditions: [
					{ ruleType: "genre", parameters: { operator: "includes_any", genres: ["family"] } },
					{ ruleType: "year_range", parameters: { operator: "after", year: 2020 } },
				],
			}),
			prisma: prisma as never,
			arrClientFactory: arrClientFactory as never,
			encryptor: {} as never,
			log,
		});

		expect(result.totals.itemsMatched).toBe(0);
	});

	it("no enabled *arr instances → failed without scanning", async () => {
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([]) },
			libraryCache: { findMany: vi.fn() },
		};

		const result = await executeAutoTagRule({
			rule: makeRule(),
			prisma: prisma as never,
			arrClientFactory: { create: vi.fn() } as never,
			encryptor: {} as never,
			log,
		});

		expect(result.status).toBe("failed");
		expect(prisma.libraryCache.findMany).not.toHaveBeenCalled();
	});

	it("partial: tag-create succeeds, but one item update fails", async () => {
		const arrClient = makeArrClient();
		arrClient.movie.update.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("API error"));

		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([makeInstance()]) },
			libraryCache: {
				findMany: vi
					.fn()
					.mockResolvedValue([
						makeCacheItem({ id: "li-1", arrItemId: 100, itemType: "movie" }),
						makeCacheItem({ id: "li-2", arrItemId: 200, itemType: "movie" }),
					]),
			},
		};
		const arrClientFactory = { create: vi.fn().mockReturnValue(arrClient) };

		const result = await executeAutoTagRule({
			rule: makeRule(),
			prisma: prisma as never,
			arrClientFactory: arrClientFactory as never,
			encryptor: {} as never,
			log,
		});

		expect(result.status).toBe("partial");
		expect(result.totals.tagsApplied).toBe(1);
		expect(result.totals.failures).toBe(1);
	});

	it("buildEvalContext throwing falls back to empty context (rule still runs)", async () => {
		mockState.buildContextThrows = true;
		const arrClient = makeArrClient();
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([makeInstance()]) },
			libraryCache: {
				findMany: vi
					.fn()
					.mockResolvedValue([makeCacheItem({ id: "li-1", arrItemId: 100, itemType: "movie" })]),
			},
		};
		const arrClientFactory = { create: vi.fn().mockReturnValue(arrClient) };

		const result = await executeAutoTagRule({
			rule: makeRule(),
			prisma: prisma as never,
			arrClientFactory: arrClientFactory as never,
			encryptor: {} as never,
			log,
		});

		expect(result.totals.itemsMatched).toBe(1);
	});
});
