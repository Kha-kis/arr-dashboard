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
		getById: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
	};
	series: {
		getById: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
	};
}

// Minimal full-resource shapes for getById mocks. Fields chosen to mirror
// what Radarr/Sonarr's strict PUT validators check — qualityProfileId>0
// is the field that broke production (see issue #384).
const fullMovie = (id: number, tags: number[] = []) => ({
	id,
	title: `Movie ${id}`,
	tmdbId: id,
	qualityProfileId: 1,
	monitored: true,
	hasFile: true,
	tags,
	rootFolderPath: "/movies",
	minimumAvailability: "released",
});

const fullSeries = (id: number, tags: number[] = []) => ({
	id,
	title: `Series ${id}`,
	tvdbId: id,
	qualityProfileId: 1,
	monitored: true,
	tags,
	rootFolderPath: "/tv",
	seasonFolder: true,
	languageProfileId: 1,
});

function makeArrClient(): MockArrClient {
	return {
		tag: {
			getAll: vi.fn().mockResolvedValue([{ id: 7, label: "premium" }]),
			create: vi.fn().mockResolvedValue({ id: 7, label: "premium" }),
		},
		movie: {
			getById: vi.fn((id: number) => Promise.resolve(fullMovie(id))),
			update: vi.fn().mockResolvedValue({}),
		},
		series: {
			getById: vi.fn((id: number) => Promise.resolve(fullSeries(id))),
			update: vi.fn().mockResolvedValue({}),
		},
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
		// Update body must include the full Radarr/Sonarr resource — Radarr's
		// PUT validator rejects partial bodies with "'Quality Profile Id' must
		// be greater than '0'" (issue #384). Spreading the getById result
		// preserves qualityProfileId, rootFolderPath, etc.
		expect(arrClient.movie.getById).toHaveBeenCalledWith(100);
		expect(arrClient.movie.update).toHaveBeenCalledWith(
			100,
			expect.objectContaining({
				id: 100,
				tags: [7],
				qualityProfileId: 1,
			}),
		);
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

		expect(arrClient.movie.update).toHaveBeenCalledWith(
			100,
			expect.objectContaining({
				id: 100,
				tags: [3, 5, 7],
				qualityProfileId: 1,
			}),
		);
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

	// ── Edge cases (PR C — defensive coverage) ────────────────────────

	it("instanceFilter to a deleted instance → graceful failure, no crash", async () => {
		// User had `instanceFilter: ["inst-old"]` and then deleted that
		// instance from settings. The serviceInstance.findMany returns
		// empty for the (instance-id + userId + enabled) intersection.
		// Executor must handle this without throwing and report a clear
		// failure message.
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([]) },
			libraryCache: { findMany: vi.fn() },
		};

		const result = await executeAutoTagRule({
			rule: makeRule({ instanceFilter: ["inst-deleted-and-gone"] }),
			prisma: prisma as never,
			arrClientFactory: { create: vi.fn() } as never,
			encryptor: {} as never,
			log,
		});

		expect(result.status).toBe("failed");
		expect(result.message).toMatch(/no enabled.*instance/i);
		// Library cache should not be queried — we bailed before that.
		expect(prisma.libraryCache.findMany).not.toHaveBeenCalled();
	});

	it("rule referencing a different user's instance is invisible (userId scope)", async () => {
		// Auto-tagger queries serviceInstance with userId in WHERE — a rule
		// pointing at instance-X owned by user B will see findMany return []
		// when run as user A. We assert the executor reports the same
		// "no instances" failure rather than silently picking up the other
		// user's instance.
		const findMany = vi.fn().mockResolvedValue([]); // Prisma WHERE filters out other user's instances
		const prisma = {
			serviceInstance: { findMany },
			libraryCache: { findMany: vi.fn() },
		};

		const result = await executeAutoTagRule({
			rule: makeRule({ userId: "user-A", instanceFilter: ["inst-owned-by-user-B"] }),
			prisma: prisma as never,
			arrClientFactory: { create: vi.fn() } as never,
			encryptor: {} as never,
			log,
		});

		expect(result.status).toBe("failed");
		// Verify the WHERE clause includes our userId — proves cross-user leak
		// would require Prisma itself to fail, not just our code.
		const callArgs = findMany.mock.calls[0]?.[0];
		expect(callArgs?.where).toMatchObject({ userId: "user-A" });
	});

	it("corrupted JSON in rule.parameters → wraps gracefully (executor doesn't see parse errors)", async () => {
		// The executor's input is `AutoTagRuleInput` (parsed parameters).
		// Corruption manifests at the route layer when reading the DB row —
		// `parseJsonRecord` returns {} on bad JSON. So the executor itself
		// never sees corrupted input; it sees an empty params object.
		// This test verifies the resulting empty-params rule doesn't crash
		// the executor — it just won't match anything (the per-rule-type
		// evaluator handles missing operator/value).
		mockState.evaluateReason = null; // empty params → no match
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
			rule: makeRule({ parameters: {} }), // empty params (post-parse-corruption)
			prisma: prisma as never,
			arrClientFactory: arrClientFactory as never,
			encryptor: {} as never,
			log,
		});

		// No throw — that's the test. Status is success-with-no-matches.
		expect(result.status).toBe("success");
		expect(arrClient.movie.update).not.toHaveBeenCalled();
	});

	it("ensureTag failure (e.g. tag name length rejected by *arr) → counts as failure for all matched items", async () => {
		// Sonarr/Radarr APIs reject tags above ~255 chars. The executor's
		// `ensureTag` does tag.create which throws ArrError. We expect the
		// rule's per-item write to count as failures (tag id never resolved)
		// rather than crashing the whole tick.
		const arrClient = makeArrClient();
		(arrClient.tag.getAll as ReturnType<typeof vi.fn>).mockResolvedValue([]); // tag not present
		(arrClient.tag.create as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("Tag name exceeds 255 chars"),
		);
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
			rule: makeRule({ tagName: "x".repeat(300) }),
			prisma: prisma as never,
			arrClientFactory: arrClientFactory as never,
			encryptor: {} as never,
			log,
		});

		expect(result.status).toBe("failed");
		expect(result.totals.tagsApplied).toBe(0);
		expect(result.totals.failures).toBeGreaterThan(0);
		// item.update must NOT have been called — there's no tag id to merge
		expect(arrClient.movie.update).not.toHaveBeenCalled();
	});

	it("excludeTitles regex with malformed pattern is silently skipped, not crashed", async () => {
		// User typed an invalid regex like `[unclosed`. The compileTitlePatterns
		// helper logs a warn and skips the bad pattern; the rule still runs
		// against other criteria.
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
			rule: makeRule({ excludeTitles: ["[unclosed-bracket"] }), // invalid regex
			prisma: prisma as never,
			arrClientFactory: arrClientFactory as never,
			encryptor: {} as never,
			log,
		});

		// No throw, executor proceeds normally — the bad pattern is dropped.
		// Item still matches (mock evaluator returns truthy).
		expect(result.status).toBe("success");
		expect(arrClient.movie.update).toHaveBeenCalledTimes(1);
	});
});
