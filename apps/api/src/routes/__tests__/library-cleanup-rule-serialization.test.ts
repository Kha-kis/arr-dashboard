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
let ruleFindFirst: ReturnType<typeof vi.fn>;
let ruleCreate: ReturnType<typeof vi.fn>;
let ruleUpdate: ReturnType<typeof vi.fn>;

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
	ruleFindFirst = vi.fn().mockResolvedValue(rule);
	ruleCreate = vi.fn().mockImplementation(async ({ data }) => ({ ...rule, ...data }));
	ruleUpdate = vi.fn().mockImplementation(async ({ data }) => ({ ...rule, ...data }));

	app = Fastify({ logger: false });
	setupAuthInjection(app, { id: USER_ID, username: "admin" });
	registerTestErrorHandler(app);
	app.decorate("prisma", {
		libraryCleanupConfig: { findUnique: configFindUnique },
		libraryCleanupRule: {
			findFirst: ruleFindFirst,
			create: ruleCreate,
			update: ruleUpdate,
		},
		serviceInstance: { findMany: vi.fn().mockResolvedValue([{ id: "sonarr-1", label: "Sonarr" }]) },
		episodeFileCache: { findMany: vi.fn().mockResolvedValue([]) },
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
