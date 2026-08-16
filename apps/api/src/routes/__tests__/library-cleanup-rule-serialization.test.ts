import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executorMocks = vi.hoisted(() => ({
	buildEvalContext: vi.fn(),
	CleanupPolicyMutationConflictError: class CleanupPolicyMutationConflictError extends Error {},
	CleanupRunAlreadyInProgressError: class CleanupRunAlreadyInProgressError extends Error {},
	executeApprovedItems: vi.fn(),
	executeCleanupPreview: vi.fn(),
	executeCleanupRun: vi.fn(),
	executeRetryItems: vi.fn(),
	withCleanupPolicyMutationLease: vi.fn(
		async (_deps: unknown, _userId: string, mutate: () => Promise<unknown>) => await mutate(),
	),
}));

vi.mock("../../lib/library-cleanup/cleanup-executor.js", () => executorMocks);

import { registerLibraryCleanupRoutes } from "../library-cleanup.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

const USER_ID = "user-rule-scope";
const timestamp = new Date("2026-08-12T00:00:00.000Z");
const recursiveExpression = {
	version: 1,
	root: {
		all: [
			{ kind: "age", params: { operator: "older_than", days: 30 } },
			{
				any: [{ kind: "year_range", params: { operator: "before", year: 2030 } }],
			},
		],
	},
};

function makeRule(overrides: Record<string, unknown> = {}) {
	return {
		id: "rule-1",
		configId: "cleanup-config",
		name: "Episode cleanup",
		enabled: true,
		priority: 0,
		ruleType: "plex_watch_count",
		parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
		serviceFilter: JSON.stringify(["SONARR"]),
		instanceFilter: null,
		excludeTags: null,
		excludeTitles: null,
		plexLibraryFilter: null,
		targetScope: "episode",
		action: "delete",
		scanMediaServerAfterDelete: false,
		scanMediaServerInstanceIds: null,
		operator: null,
		conditions: null,
		retentionMode: false,
		useGlobalRejectionMemory: true,
		rejectionMemoryDays: 0,
		createdAt: timestamp,
		updatedAt: timestamp,
		...overrides,
	};
}

let app: FastifyInstance;
let configFindUnique: ReturnType<typeof vi.fn>;
let configUpsert: ReturnType<typeof vi.fn>;
let configUpdate: ReturnType<typeof vi.fn>;
let prismaTransaction: ReturnType<typeof vi.fn>;
let ruleFindFirst: ReturnType<typeof vi.fn>;
let ruleCreate: ReturnType<typeof vi.fn>;
let ruleUpdate: ReturnType<typeof vi.fn>;
let serviceInstanceFindMany: ReturnType<typeof vi.fn>;

beforeEach(async () => {
	const rule = makeRule();
	configFindUnique = vi.fn().mockResolvedValue({
		id: "cleanup-config",
		userId: USER_ID,
		enabled: false,
		intervalHours: 24,
		lastRunAt: null,
		nextRunAt: null,
		dryRunMode: true,
		maxRemovalsPerRun: 10,
		requireApproval: true,
		respectQuiSeeding: false,
		rejectionMemoryDays: 0,
		rules: [rule],
	});
	configUpsert = vi.fn().mockImplementation(async () => configFindUnique.mock.results[0]?.value);
	configUpdate = vi.fn();
	prismaTransaction = vi.fn().mockResolvedValue([]);
	ruleFindFirst = vi.fn().mockResolvedValue(rule);
	ruleCreate = vi.fn().mockImplementation(async ({ data }) => ({ ...rule, ...data }));
	ruleUpdate = vi.fn().mockImplementation(async ({ data }) => ({ ...rule, ...data }));
	serviceInstanceFindMany = vi
		.fn()
		.mockResolvedValue([{ id: "sonarr-1", label: "Sonarr", service: "SONARR" }]);

	app = Fastify({ logger: false });
	setupAuthInjection(app, { id: USER_ID, username: "admin" });
	registerTestErrorHandler(app);
	app.decorate("prisma", {
		libraryCleanupConfig: {
			findUnique: configFindUnique,
			upsert: configUpsert,
			update: configUpdate,
		},
		libraryCleanupRule: {
			findFirst: ruleFindFirst,
			create: ruleCreate,
			update: ruleUpdate,
		},
		serviceInstance: { findMany: serviceInstanceFindMany },
		episodeFileCache: { findMany: vi.fn().mockResolvedValue([]) },
		$transaction: prismaTransaction,
	} as never);
	app.decorate("arrClientFactory", {} as never);
	app.decorate("encryptor", {} as never);
	await app.register(registerLibraryCleanupRoutes);
	await app.ready();
});

afterEach(async () => {
	await app.close();
});

describe("library cleanup rule scope persistence", () => {
	it("stores a recursive expression in the canonical composite representation", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/rules", {
			body: {
				name: "Nested cleanup",
				enabled: true,
				priority: 0,
				ruleType: "composite",
				parameters: {},
				expression: recursiveExpression,
			},
		});

		expect(response.statusCode).toBe(201);
		expect(ruleCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					ruleType: "composite",
					parameters: "{}",
					operator: null,
					conditions: JSON.stringify(recursiveExpression),
				}),
			}),
		);
		expect(response.json()).toMatchObject({
			expression: recursiveExpression,
			conditions: null,
		});
	});

	it("rejects NOT expressions until false evidence is authoritative", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/rules", {
			body: {
				name: "Unsafe negation",
				ruleType: "composite",
				parameters: {},
				expression: {
					version: 1,
					root: { not: { kind: "age", params: { operator: "older_than", days: 30 } } },
				},
			},
		});

		expect(response.statusCode).toBe(400);
		expect(response.json().error).toContain("NOT cleanup expressions are not supported");
		expect(ruleCreate).not.toHaveBeenCalled();
	});

	it("serializes canonical rows separately from legacy composite conditions", async () => {
		const legacyConditions = [
			{ ruleType: "age", parameters: { operator: "older_than", days: 30 } },
		];
		configFindUnique.mockResolvedValueOnce({
			id: "cleanup-config",
			enabled: false,
			intervalHours: 24,
			lastRunAt: null,
			nextRunAt: null,
			dryRunMode: true,
			maxRemovalsPerRun: 10,
			requireApproval: true,
			respectQuiSeeding: false,
			rejectionMemoryDays: 0,
			rules: [
				makeRule({
					ruleType: "composite",
					parameters: "{}",
					operator: null,
					conditions: JSON.stringify(recursiveExpression),
					targetScope: "series",
				}),
				makeRule({
					id: "rule-legacy",
					ruleType: "composite",
					parameters: "{}",
					operator: "AND",
					conditions: JSON.stringify(legacyConditions),
					targetScope: "series",
				}),
				makeRule({
					id: "rule-legacy-null-operator",
					ruleType: "composite",
					parameters: "{}",
					operator: null,
					conditions: JSON.stringify(legacyConditions),
					targetScope: "series",
				}),
			],
		});

		const response = await createInjectAuthenticated(app)("GET", "/library-cleanup/config");

		expect(response.statusCode).toBe(200);
		expect(response.json().rules).toEqual([
			expect.objectContaining({ expression: recursiveExpression, conditions: null }),
			expect.objectContaining({ expression: null, conditions: legacyConditions }),
			expect.objectContaining({ expression: null, conditions: legacyConditions }),
		]);
	});

	it("rejects a config mutation before changing authority when a stored expression is invalid", async () => {
		configFindUnique.mockResolvedValueOnce({
			id: "cleanup-config",
			rules: [
				makeRule({
					ruleType: "composite",
					operator: null,
					conditions: '{"version":1,"root":{"not":false}}',
				}),
			],
		});

		const response = await createInjectAuthenticated(app)("PUT", "/library-cleanup/config", {
			body: { dryRunMode: false },
		});

		expect(response.statusCode).toBe(409);
		expect(configUpsert).not.toHaveBeenCalled();
		expect(configUpdate).not.toHaveBeenCalled();
	});

	it("rejects a reorder before its transaction when a stored expression is invalid", async () => {
		configFindUnique.mockResolvedValueOnce({ id: "cleanup-config" }).mockResolvedValueOnce({
			id: "cleanup-config",
			rules: [
				makeRule({
					ruleType: "composite",
					operator: null,
					conditions: '{"version":1,"root":{"not":false}}',
				}),
			],
		});

		const response = await createInjectAuthenticated(app)("PUT", "/library-cleanup/rules/reorder", {
			body: { ruleIds: ["rule-1"] },
		});

		expect(response.statusCode).toBe(409);
		expect(prismaTransaction).not.toHaveBeenCalled();
	});

	it.each([
		["malformed", '{"version":1,"root":{"not":false}}', "invalid"],
		["empty", JSON.stringify({ version: 1, root: { all: [] } }), "empty all group"],
	] as const)(
		"fails closed for a %s stored canonical expression",
		async (_label, conditions, message) => {
			configFindUnique.mockResolvedValueOnce({
				id: "cleanup-config",
				enabled: false,
				intervalHours: 24,
				lastRunAt: null,
				nextRunAt: null,
				dryRunMode: true,
				maxRemovalsPerRun: 10,
				requireApproval: true,
				respectQuiSeeding: false,
				rejectionMemoryDays: 0,
				rules: [
					makeRule({
						ruleType: "composite",
						parameters: "{}",
						operator: null,
						conditions,
						targetScope: "series",
					}),
				],
			});

			const response = await createInjectAuthenticated(app)("GET", "/library-cleanup/config");

			expect(response.statusCode).toBe(409);
			expect(response.json().message).toContain(message);
		},
	);

	it.each([
		[
			"legacy conditions",
			{
				operator: "AND",
				conditions: [{ ruleType: "age", parameters: { operator: "older_than", days: 30 } }],
			},
		],
		["legacy parameters", { parameters: { operator: "older_than", days: 30 } }],
		["an empty group", { expression: { version: 1, root: { all: [] } } }],
	] as const)("rejects an expression mixed with %s on create", async (_label, overrides) => {
		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/rules", {
			body: {
				name: "Ambiguous cleanup",
				enabled: true,
				priority: 0,
				ruleType: "composite",
				parameters: {},
				expression: recursiveExpression,
				...overrides,
			},
		});

		expect(response.statusCode).toBe(400);
		expect(ruleCreate).not.toHaveBeenCalled();
	});

	it("rejects legacy composite conditions without an operator", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/rules", {
			body: {
				name: "Incomplete legacy composite",
				ruleType: "composite",
				parameters: {},
				conditions: [
					{
						ruleType: "age",
						parameters: { operator: "older_than", days: 30 },
					},
				],
			},
		});

		expect(response.statusCode).toBe(400);
		expect(ruleCreate).not.toHaveBeenCalled();
	});

	it("preserves a canonical expression when an update changes unrelated fields", async () => {
		const stored = makeRule({
			ruleType: "composite",
			parameters: "{}",
			operator: null,
			conditions: JSON.stringify(recursiveExpression),
			targetScope: "series",
		});
		ruleFindFirst.mockResolvedValueOnce(stored);
		ruleUpdate.mockImplementationOnce(async ({ data }) => ({ ...stored, ...data }));

		const response = await createInjectAuthenticated(app)("PUT", "/library-cleanup/rules/rule-1", {
			body: { name: "Renamed nested cleanup" },
		});

		expect(response.statusCode).toBe(200);
		expect(ruleUpdate).toHaveBeenCalledWith({
			where: { id: "rule-1" },
			data: { name: "Renamed nested cleanup" },
		});
		expect(response.json()).toMatchObject({ expression: recursiveExpression, conditions: null });
	});

	it("preserves a stored retired predicate during an unrelated update", async () => {
		const retiredExpression = {
			version: 1,
			root: { kind: "retired_cleanup_kind", params: {} },
		};
		const stored = makeRule({
			ruleType: "composite",
			parameters: "{}",
			operator: null,
			conditions: JSON.stringify(retiredExpression),
			targetScope: "series",
		});
		ruleFindFirst.mockResolvedValueOnce(stored);
		ruleUpdate.mockImplementationOnce(async ({ data }) => ({ ...stored, ...data }));

		const response = await createInjectAuthenticated(app)("PUT", "/library-cleanup/rules/rule-1", {
			body: { name: "Renamed retired cleanup" },
		});

		expect(response.statusCode).toBe(200);
		expect(ruleUpdate).toHaveBeenCalledWith({
			where: { id: "rule-1" },
			data: { name: "Renamed retired cleanup" },
		});
		expect(response.json()).toMatchObject({ expression: retiredExpression, conditions: null });
	});

	it("rejects canonical representation edits when expression is omitted", async () => {
		const stored = makeRule({
			ruleType: "composite",
			parameters: "{}",
			operator: null,
			conditions: JSON.stringify(recursiveExpression),
			targetScope: "series",
		});
		ruleFindFirst.mockResolvedValueOnce(stored);

		const response = await createInjectAuthenticated(app)("PUT", "/library-cleanup/rules/rule-1", {
			body: { parameters: { operator: "older_than", days: 60 } },
		});

		expect(response.statusCode).toBe(400);
		expect(ruleUpdate).not.toHaveBeenCalled();
	});

	it("requires a complete legacy replacement when clearing a canonical expression", async () => {
		const stored = makeRule({
			ruleType: "composite",
			parameters: "{}",
			operator: null,
			conditions: JSON.stringify(recursiveExpression),
			targetScope: "series",
		});
		ruleFindFirst.mockResolvedValueOnce(stored);

		const response = await createInjectAuthenticated(app)("PUT", "/library-cleanup/rules/rule-1", {
			body: { expression: null },
		});

		expect(response.statusCode).toBe(400);
		expect(ruleUpdate).not.toHaveBeenCalled();
	});

	it("converts a canonical expression to a complete legacy replacement", async () => {
		const stored = makeRule({
			ruleType: "composite",
			parameters: "{}",
			operator: null,
			conditions: JSON.stringify(recursiveExpression),
			targetScope: "series",
		});
		ruleFindFirst.mockResolvedValueOnce(stored);
		ruleUpdate.mockImplementationOnce(async ({ data }) => ({ ...stored, ...data }));

		const response = await createInjectAuthenticated(app)("PUT", "/library-cleanup/rules/rule-1", {
			body: {
				expression: null,
				ruleType: "age",
				parameters: { operator: "older_than", days: 60 },
			},
		});

		expect(response.statusCode).toBe(200);
		expect(ruleUpdate).toHaveBeenCalledWith({
			where: { id: "rule-1" },
			data: {
				ruleType: "age",
				parameters: JSON.stringify({ operator: "older_than", days: 60 }),
				operator: null,
				conditions: null,
			},
		});
		expect(response.json()).toMatchObject({ expression: null, ruleType: "age", conditions: null });
	});

	it("converts a legacy rule to canonical recursive storage on update", async () => {
		const stored = makeRule({ targetScope: "series" });
		ruleFindFirst.mockResolvedValueOnce(stored);
		ruleUpdate.mockImplementationOnce(async ({ data }) => ({ ...stored, ...data }));

		const response = await createInjectAuthenticated(app)("PUT", "/library-cleanup/rules/rule-1", {
			body: { expression: recursiveExpression },
		});

		expect(response.statusCode).toBe(200);
		expect(ruleUpdate).toHaveBeenCalledWith({
			where: { id: "rule-1" },
			data: {
				ruleType: "composite",
				parameters: "{}",
				operator: null,
				conditions: JSON.stringify(recursiveExpression),
			},
		});
		expect(response.json()).toMatchObject({ expression: recursiveExpression, conditions: null });
	});

	it("stores and serializes an exact canonical media-server rescan selection", async () => {
		serviceInstanceFindMany.mockResolvedValueOnce([
			{ id: "jellyfin-primary" },
			{ id: "plex-primary" },
		]);

		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/rules", {
			body: {
				name: "Delete old media",
				ruleType: "age",
				parameters: { field: "arrAddedAt", operator: "older_than", days: 30 },
				action: "delete",
				scanMediaServerAfterDelete: true,
				scanMediaServerInstanceIds: ["plex-primary", "jellyfin-primary"],
			},
		});

		expect(response.statusCode).toBe(201);
		expect(ruleCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					scanMediaServerAfterDelete: true,
					scanMediaServerInstanceIds: JSON.stringify(["jellyfin-primary", "plex-primary"]),
				}),
			}),
		);
		expect(response.json()).toMatchObject({
			scanMediaServerAfterDelete: true,
			scanMediaServerInstanceIds: ["jellyfin-primary", "plex-primary"],
		});
	});

	it("rejects media-server targets that are not enabled and owned by the current user", async () => {
		serviceInstanceFindMany.mockResolvedValueOnce([{ id: "plex-primary" }]);

		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/rules", {
			body: {
				name: "Delete old media",
				ruleType: "age",
				parameters: { field: "arrAddedAt", operator: "older_than", days: 30 },
				action: "delete",
				scanMediaServerAfterDelete: true,
				scanMediaServerInstanceIds: ["plex-primary", "foreign-server"],
			},
		});

		expect(response.statusCode).toBe(400);
		expect(response.json()).toMatchObject({
			error: expect.stringContaining("enabled Plex, Jellyfin, or Emby"),
		});
		expect(ruleCreate).not.toHaveBeenCalled();
	});

	it("clears stored media-server targets when scanning is disabled", async () => {
		const stored = makeRule({
			targetScope: "series",
			scanMediaServerAfterDelete: true,
			scanMediaServerInstanceIds: JSON.stringify(["plex-primary"]),
		});
		ruleFindFirst.mockResolvedValueOnce(stored);
		ruleUpdate.mockImplementationOnce(async ({ data }) => ({ ...stored, ...data }));

		const response = await createInjectAuthenticated(app)("PUT", "/library-cleanup/rules/rule-1", {
			body: { scanMediaServerAfterDelete: false },
		});

		expect(response.statusCode).toBe(200);
		expect(ruleUpdate).toHaveBeenCalledWith({
			where: { id: "rule-1" },
			data: {
				scanMediaServerAfterDelete: false,
				scanMediaServerInstanceIds: null,
			},
		});
		expect(response.json()).toMatchObject({
			scanMediaServerAfterDelete: false,
			scanMediaServerInstanceIds: [],
		});
	});

	it.each([
		["a legacy row", undefined, "series"],
		["an unknown persisted scope", "future-scope", "series"],
		["an explicit episode scope", "episode", "episode"],
	] as const)(
		"serializes %s without changing the stored compatibility default",
		async (_label, targetScope, expected) => {
			configFindUnique.mockResolvedValueOnce({
				id: "cleanup-config",
				enabled: false,
				intervalHours: 24,
				lastRunAt: null,
				nextRunAt: null,
				dryRunMode: true,
				maxRemovalsPerRun: 10,
				requireApproval: true,
				respectQuiSeeding: false,
				rejectionMemoryDays: 0,
				rules: [makeRule({ targetScope })],
			});

			const response = await createInjectAuthenticated(app)("GET", "/library-cleanup/config");

			expect(response.statusCode).toBe(200);
			expect(response.json().rules[0]).toMatchObject({ targetScope: expected });
		},
	);

	it("persists an explicit supported episode scope", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/rules", {
			body: {
				name: "Episode cleanup",
				enabled: true,
				priority: 0,
				ruleType: "plex_watch_count",
				parameters: { operator: "greater_than", count: 0 },
				serviceFilter: ["SONARR"],
				targetScope: "episode",
			},
		});

		expect(response.statusCode).toBe(201);
		expect(ruleCreate).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ targetScope: "episode" }) }),
		);
	});

	it("rejects an unsupported complete episode rule before it can be stored", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/rules", {
			body: {
				name: "Invalid episode cleanup",
				enabled: true,
				priority: 0,
				ruleType: "plex_watch_count",
				parameters: { operator: "greater_than", count: 0 },
				serviceFilter: ["RADARR"],
				targetScope: "episode",
			},
		});

		expect(response.statusCode).toBe(400);
		expect(ruleCreate).not.toHaveBeenCalled();
	});

	it("keeps an existing episode scope when an update omits it", async () => {
		const response = await createInjectAuthenticated(app)("PUT", "/library-cleanup/rules/rule-1", {
			body: { name: "Renamed episode cleanup" },
		});

		expect(response.statusCode).toBe(200);
		expect(ruleUpdate).toHaveBeenCalledWith({
			where: { id: "rule-1" },
			data: { name: "Renamed episode cleanup" },
		});
		expect(response.json()).toMatchObject({ targetScope: "episode" });
	});

	it("rejects a partial update that makes the complete stored episode rule invalid", async () => {
		const response = await createInjectAuthenticated(app)("PUT", "/library-cleanup/rules/rule-1", {
			body: { serviceFilter: ["RADARR"] },
		});

		expect(response.statusCode).toBe(400);
		expect(ruleUpdate).not.toHaveBeenCalled();
	});

	it("round-trips episode coordinates through preview without changing the series title", async () => {
		const providerEvidence = {
			version: 1 as const,
			dependencies: ["plex", "plex_episode"],
			fingerprint: "a".repeat(64),
			sources: [],
		};
		executorMocks.executeCleanupPreview.mockResolvedValueOnce({
			isDryRun: true,
			status: "completed",
			itemsEvaluated: 1,
			itemsFlagged: 1,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: 0,
			details: [
				{
					instanceId: "sonarr-1",
					arrItemId: 101,
					itemType: "series",
					targetScope: "episode",
					arrEpisodeId: 202,
					seasonNumber: 1,
					episodeNumber: 2,
					episodeFileId: 7002,
					title: "Example Series",
					seriesTitle: "Example Series",
					episodeTitle: "The Second Episode",
					rule: "Episode cleanup",
					reason: "Plex watch count 1 > 0",
					action: "delete",
					sizeOnDisk: "1000",
				},
			],
			durationMs: 1,
			providerEvidence,
		} as never);

		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/preview");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			providerEvidence,
			items: [
				{
					targetScope: "episode",
					arrEpisodeId: 202,
					seasonNumber: 1,
					episodeNumber: 2,
					title: "Example Series",
					seriesTitle: "Example Series",
					episodeTitle: "The Second Episode",
				},
			],
		});
	});
});
