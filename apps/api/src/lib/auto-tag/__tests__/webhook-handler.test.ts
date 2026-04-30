/**
 * Auto-tagger webhook handler tests.
 *
 * Mocks the criteria evaluator + arr SDK client to focus on the webhook's
 * orchestration logic: payload parsing, instance/payload-type matching,
 * single-item evaluation, tag-write batching, idempotency.
 */

import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoTagRule, ServiceInstance, User } from "../../prisma.js";

// Mock the evaluator + prefetch context builder. The evaluator returns a
// reason string (truthy = match) by default; tests can override per-call.
const evalState: { reason: string | null } = { reason: "matched" };

vi.mock("../../library-cleanup/rule-evaluators.js", () => ({
	evaluateSingleCondition: vi.fn(() => evalState.reason),
}));

vi.mock("../../library-cleanup/cleanup-executor.js", () => ({
	buildEvalContext: vi.fn(async () => ({ now: new Date() })),
}));

import { processWebhook, resolveUserFromBearer } from "../webhook-handler.js";

const log = {
	child: vi.fn().mockReturnThis(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
} as unknown as FastifyBaseLogger;

// Plaintext bearer token used in tests; the user row stores its SHA-256 hash.
const TEST_BEARER = "secret-abc-123-456-7890-aaaaaaaaaaa";

function hashForTest(plaintext: string): string {
	// Computed via Node's createHash; mirrored here so tests don't import crypto twice.
	const { createHash } = require("node:crypto") as typeof import("node:crypto");
	return createHash("sha256").update(plaintext).digest("hex");
}

function makeUser(over: Partial<User> = {}): User {
	return {
		id: "user-1",
		username: "khak1s",
		hashedPassword: null,
		mustChangePassword: false,
		failedLoginAttempts: 0,
		lockedUntil: null,
		encryptedTmdbApiKey: null,
		tmdbEncryptionIv: null,
		hashedWebhookSecret: hashForTest(TEST_BEARER),
		createdAt: new Date(),
		updatedAt: new Date(),
		...over,
	} as User;
}

function makeInstance(over: Partial<ServiceInstance> = {}): ServiceInstance {
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
		...over,
	} as ServiceInstance;
}

function makeRule(over: Partial<AutoTagRule> = {}): AutoTagRule {
	return {
		id: "rule-1",
		userId: "user-1",
		name: "Tag premium",
		enabled: true,
		ruleType: "audio_channels",
		parameters: JSON.stringify({ operator: "greater_than", channels: 5 }),
		operator: null,
		conditions: null,
		serviceFilter: null,
		instanceFilter: null,
		excludeTags: null,
		excludeTitles: null,
		plexLibraryFilter: null,
		tagName: "premium",
		lastRunAt: null,
		lastRunStatus: null,
		lastRunMessage: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...over,
	} as AutoTagRule;
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

function makeArrClient(itemOverride: Partial<{ id: number; tags: number[] }> = {}): MockArrClient {
	const movie = {
		id: itemOverride.id ?? 100,
		title: "The Movie",
		year: 2023,
		monitored: true,
		hasFile: true,
		status: "available",
		qualityProfileId: 1,
		sizeOnDisk: 5_000_000,
		added: new Date().toISOString(),
		tags: itemOverride.tags ?? [],
	};
	const series = { ...movie, statistics: { episodeFileCount: 10 } };
	return {
		tag: {
			getAll: vi.fn().mockResolvedValue([{ id: 7, label: "premium" }]),
			create: vi.fn().mockResolvedValue({ id: 7, label: "premium" }),
		},
		movie: {
			getById: vi.fn().mockResolvedValue(movie),
			update: vi.fn().mockResolvedValue({}),
		},
		series: {
			getById: vi.fn().mockResolvedValue(series),
			update: vi.fn().mockResolvedValue({}),
		},
	};
}

describe("resolveUserFromBearer", () => {
	it("returns null when header missing", async () => {
		const prisma = { user: { findUnique: vi.fn() } };
		const r = await resolveUserFromBearer(prisma as never, undefined);
		expect(r).toBeNull();
	});

	it("returns null when scheme is not Bearer", async () => {
		const prisma = { user: { findUnique: vi.fn() } };
		const r = await resolveUserFromBearer(prisma as never, "Basic abc");
		expect(r).toBeNull();
		expect(prisma.user.findUnique).not.toHaveBeenCalled();
	});

	it("rejects very short tokens without DB query", async () => {
		const prisma = { user: { findUnique: vi.fn() } };
		const r = await resolveUserFromBearer(prisma as never, "Bearer abc");
		expect(r).toBeNull();
		expect(prisma.user.findUnique).not.toHaveBeenCalled();
	});

	it("queries by hashed bearer (plaintext is hashed before DB lookup)", async () => {
		const user = makeUser();
		const prisma = { user: { findUnique: vi.fn().mockResolvedValue(user) } };
		const r = await resolveUserFromBearer(prisma as never, `Bearer ${TEST_BEARER}`);
		expect(r).toEqual(user);
		expect(prisma.user.findUnique).toHaveBeenCalledWith({
			where: { hashedWebhookSecret: hashForTest(TEST_BEARER) },
		});
	});

	it("does not leak the plaintext token in the DB query", async () => {
		const user = makeUser();
		const prisma = { user: { findUnique: vi.fn().mockResolvedValue(user) } };
		await resolveUserFromBearer(prisma as never, `Bearer ${TEST_BEARER}`);
		const callArg = prisma.user.findUnique.mock.calls[0]?.[0];
		expect(JSON.stringify(callArg)).not.toContain(TEST_BEARER);
	});
});

describe("processWebhook", () => {
	beforeEach(() => {
		evalState.reason = "matched";
	});

	it("test event returns status 'test' without invoking *arr API", async () => {
		const arrClientFactory = { create: vi.fn() };
		const prisma = {
			autoTagRule: { findMany: vi.fn() },
		};

		const result = await processWebhook({
			deps: {
				prisma: prisma as never,
				arrClientFactory: arrClientFactory as never,
				encryptor: {} as never,
				log,
			},
			user: makeUser(),
			instance: makeInstance(),
			payload: { eventType: "Test" },
		});

		expect(result.status).toBe("test");
		expect(arrClientFactory.create).not.toHaveBeenCalled();
		expect(prisma.autoTagRule.findMany).not.toHaveBeenCalled();
	});

	it("payload without series.id or movie.id → ignored", async () => {
		const result = await processWebhook({
			deps: { prisma: {} as never, arrClientFactory: {} as never, encryptor: {} as never, log },
			user: makeUser(),
			instance: makeInstance(),
			payload: { eventType: "Download" },
		});
		expect(result.status).toBe("ignored");
	});

	it("payload media type mismatching instance type → error", async () => {
		const result = await processWebhook({
			deps: { prisma: {} as never, arrClientFactory: {} as never, encryptor: {} as never, log },
			user: makeUser(),
			instance: makeInstance({ service: "SONARR" }),
			payload: { eventType: "Download", movie: { id: 100 } },
		});
		expect(result.status).toBe("error");
		expect(result.message).toMatch(/Instance is SONARR but webhook payload is for movie/i);
	});

	it("happy path: matched rule applies tag via movie.update", async () => {
		const arrClient = makeArrClient();
		const prisma = {
			autoTagRule: { findMany: vi.fn().mockResolvedValue([makeRule()]) },
		};
		const arrClientFactory = { create: vi.fn().mockReturnValue(arrClient) };

		const result = await processWebhook({
			deps: {
				prisma: prisma as never,
				arrClientFactory: arrClientFactory as never,
				encryptor: {} as never,
				log,
			},
			user: makeUser(),
			instance: makeInstance(),
			payload: { eventType: "Download", movie: { id: 100 } },
		});

		expect(result.status).toBe("ok");
		expect(result.tagsApplied).toBe(1);
		expect(arrClient.movie.update).toHaveBeenCalledWith(100, { id: 100, tags: [7] });
	});

	it("idempotent: item already has the tag → no update call, still status ok", async () => {
		const arrClient = makeArrClient({ tags: [7] });
		const prisma = {
			autoTagRule: { findMany: vi.fn().mockResolvedValue([makeRule()]) },
		};
		const arrClientFactory = { create: vi.fn().mockReturnValue(arrClient) };

		const result = await processWebhook({
			deps: {
				prisma: prisma as never,
				arrClientFactory: arrClientFactory as never,
				encryptor: {} as never,
				log,
			},
			user: makeUser(),
			instance: makeInstance(),
			payload: { eventType: "Download", movie: { id: 100 } },
		});

		expect(result.status).toBe("ok");
		expect(arrClient.movie.update).not.toHaveBeenCalled();
	});

	it("merges new tag with existing item tags", async () => {
		const arrClient = makeArrClient({ tags: [3, 5] });
		const prisma = {
			autoTagRule: { findMany: vi.fn().mockResolvedValue([makeRule()]) },
		};
		const arrClientFactory = { create: vi.fn().mockReturnValue(arrClient) };

		await processWebhook({
			deps: {
				prisma: prisma as never,
				arrClientFactory: arrClientFactory as never,
				encryptor: {} as never,
				log,
			},
			user: makeUser(),
			instance: makeInstance(),
			payload: { eventType: "Download", movie: { id: 100 } },
		});

		expect(arrClient.movie.update).toHaveBeenCalledWith(100, {
			id: 100,
			tags: [3, 5, 7],
		});
	});

	it("non-matching rule → status ok, no update", async () => {
		evalState.reason = null;
		const arrClient = makeArrClient();
		const prisma = {
			autoTagRule: { findMany: vi.fn().mockResolvedValue([makeRule()]) },
		};
		const arrClientFactory = { create: vi.fn().mockReturnValue(arrClient) };

		const result = await processWebhook({
			deps: {
				prisma: prisma as never,
				arrClientFactory: arrClientFactory as never,
				encryptor: {} as never,
				log,
			},
			user: makeUser(),
			instance: makeInstance(),
			payload: { eventType: "Download", movie: { id: 100 } },
		});

		expect(result.status).toBe("ok");
		expect(result.message).toMatch(/no rules matched/i);
		expect(arrClient.movie.update).not.toHaveBeenCalled();
	});

	it("rule with non-matching instanceFilter is skipped", async () => {
		const arrClient = makeArrClient();
		const ruleScopedElsewhere = makeRule({
			instanceFilter: JSON.stringify(["different-instance"]),
		});
		const prisma = {
			autoTagRule: { findMany: vi.fn().mockResolvedValue([ruleScopedElsewhere]) },
		};
		const arrClientFactory = { create: vi.fn().mockReturnValue(arrClient) };

		const result = await processWebhook({
			deps: {
				prisma: prisma as never,
				arrClientFactory: arrClientFactory as never,
				encryptor: {} as never,
				log,
			},
			user: makeUser(),
			instance: makeInstance(),
			payload: { eventType: "Download", movie: { id: 100 } },
		});

		expect(result.message).toMatch(/no enabled rules apply/i);
		expect(arrClient.movie.update).not.toHaveBeenCalled();
	});

	it("multiple rules matching → all unique tags applied in one merged update", async () => {
		const arrClient = makeArrClient();
		// Two distinct tags created in sequence
		(arrClient.tag.getAll as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce([{ id: 7, label: "premium" }])
			.mockResolvedValueOnce([
				{ id: 7, label: "premium" },
				{ id: 8, label: "kids" },
			]);
		const prisma = {
			autoTagRule: {
				findMany: vi
					.fn()
					.mockResolvedValue([
						makeRule({ id: "r1", tagName: "premium" }),
						makeRule({ id: "r2", tagName: "kids" }),
					]),
			},
		};
		const arrClientFactory = { create: vi.fn().mockReturnValue(arrClient) };

		const result = await processWebhook({
			deps: {
				prisma: prisma as never,
				arrClientFactory: arrClientFactory as never,
				encryptor: {} as never,
				log,
			},
			user: makeUser(),
			instance: makeInstance(),
			payload: { eventType: "Download", movie: { id: 100 } },
		});

		expect(result.tagsApplied).toBe(2);
		// Single update call with both new tags merged
		expect(arrClient.movie.update).toHaveBeenCalledTimes(1);
	});

	// ── Coverage for findings #3 + #8 from the code review ─────────────────

	it("non-allowlisted event type with series/movie id → ignored (finding #8)", async () => {
		const arrClientFactory = { create: vi.fn() };
		const result = await processWebhook({
			deps: {
				prisma: {} as never,
				arrClientFactory: arrClientFactory as never,
				encryptor: {} as never,
				log,
			},
			user: makeUser(),
			instance: makeInstance(),
			payload: { eventType: "Health", movie: { id: 100 } },
		});
		expect(result.status).toBe("ignored");
		// Critical: arr client must NOT be created for ignored events
		expect(arrClientFactory.create).not.toHaveBeenCalled();
	});

	it("idempotency: partially-tagged item — only the missing tag is added, existing ones preserved (finding #3)", async () => {
		// Item already has tag id 7 (from rule "premium"); rule for "kids" → tag id 8
		// will be added. Existing [3, 5, 7] must NOT be erased.
		const arrClient = makeArrClient({ tags: [3, 5, 7] });
		(arrClient.tag.getAll as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce([{ id: 7, label: "premium" }])
			.mockResolvedValueOnce([
				{ id: 7, label: "premium" },
				{ id: 8, label: "kids" },
			]);
		const prisma = {
			autoTagRule: {
				findMany: vi
					.fn()
					.mockResolvedValue([
						makeRule({ id: "r1", tagName: "premium" }),
						makeRule({ id: "r2", tagName: "kids" }),
					]),
			},
		};
		const arrClientFactory = { create: vi.fn().mockReturnValue(arrClient) };

		await processWebhook({
			deps: {
				prisma: prisma as never,
				arrClientFactory: arrClientFactory as never,
				encryptor: {} as never,
				log,
			},
			user: makeUser(),
			instance: makeInstance(),
			payload: { eventType: "Download", movie: { id: 100 } },
		});

		expect(arrClient.movie.update).toHaveBeenCalledTimes(1);
		// Critical: existing tags (3, 5, 7) preserved, only the missing one (8) added
		expect(arrClient.movie.update).toHaveBeenCalledWith(100, {
			id: 100,
			tags: [3, 5, 7, 8],
		});
		// And we must NOT have done a second getById (the prior bug fetched
		// the item twice with a silent fallback that erased existing tags on
		// transient failures).
		expect(arrClient.movie.getById).toHaveBeenCalledTimes(1);
	});
});
