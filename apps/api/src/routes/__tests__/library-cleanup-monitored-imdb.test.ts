import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerLibraryCleanupRoutes, serializeRule } from "../library-cleanup.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

const NOW = new Date("2026-08-03T00:00:00.000Z");

function storedRule(overrides: Record<string, unknown> = {}) {
	return {
		id: "rule-1",
		configId: "config-1",
		name: "Rule",
		enabled: true,
		priority: 0,
		ruleType: "monitored",
		parameters: "{}",
		serviceFilter: null,
		instanceFilter: null,
		excludeTags: null,
		excludeTitles: null,
		plexLibraryFilter: null,
		targetScope: "series",
		action: "delete",
		operator: null,
		conditions: null,
		retentionMode: false,
		scanMediaServerAfterDelete: false,
		useGlobalRejectionMemory: true,
		rejectionMemoryDays: 0,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

describe("monitored and IMDb cleanup rule routes", () => {
	let app: FastifyInstance;
	let createRule: ReturnType<typeof vi.fn>;
	let updateRule: ReturnType<typeof vi.fn>;
	let findRule: ReturnType<typeof vi.fn>;
	let findServiceInstances: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		createRule = vi
			.fn()
			.mockImplementation(({ data }) =>
				Promise.resolve(storedRule(data as Record<string, unknown>)),
			);
		updateRule = vi
			.fn()
			.mockImplementation(({ data }) =>
				Promise.resolve(storedRule(data as Record<string, unknown>)),
			);
		findRule = vi.fn().mockResolvedValue(storedRule());
		findServiceInstances = vi
			.fn()
			.mockImplementation(({ where }) =>
				Promise.resolve(
					(where.id.in as string[]).filter((id) => id === "radarr-1").map((id) => ({ id })),
				),
			);

		app = Fastify({ logger: false });
		setupAuthInjection(app);
		registerTestErrorHandler(app);
		app.decorate("prisma", {
			libraryCleanupConfig: {
				findUnique: vi.fn().mockResolvedValue({ id: "config-1" }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			libraryCleanupRule: { create: createRule, findFirst: findRule, update: updateRule },
			serviceInstance: { findMany: findServiceInstances },
		} as never);
		await app.register(registerLibraryCleanupRoutes);
		await app.ready();
	});

	afterEach(async () => app.close());

	it("round-trips monitored as a parameterless rule", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/rules", {
			body: {
				name: "Currently monitored",
				ruleType: "monitored",
				parameters: {},
				serviceFilter: ["RADARR", "SONARR"],
			},
		});
		expect(response.statusCode).toBe(201);
		expect(JSON.parse(response.payload)).toMatchObject({
			ruleType: "monitored",
			parameters: {},
			serviceFilter: ["RADARR", "SONARR"],
		});
	});

	it("persists the opt-in post-delete media-server scan setting", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/rules", {
			body: {
				name: "Delete and refresh",
				ruleType: "age",
				parameters: { operator: "older_than", days: 30 },
				action: "delete",
				scanMediaServerAfterDelete: true,
			},
		});

		expect(response.statusCode).toBe(201);
		expect(createRule).toHaveBeenCalledWith({
			data: expect.objectContaining({ scanMediaServerAfterDelete: true }),
		});
		expect(JSON.parse(response.payload).scanMediaServerAfterDelete).toBe(true);
	});

	it("serializes standalone, legacy, and nested IMDb rules as Radarr-only", () => {
		const imdb = {
			type: "condition",
			ruleType: "imdb_rating",
			parameters: { operator: "unrated" },
		};
		for (const rule of [
			storedRule({ ruleType: "imdb_rating" }),
			storedRule({
				ruleType: "composite",
				operator: "AND",
				conditions: JSON.stringify([{ ruleType: "imdb_rating", parameters: imdb.parameters }]),
			}),
			storedRule({
				ruleType: "composite",
				conditions: JSON.stringify({ version: 1, root: { type: "not", child: imdb } }),
			}),
		]) {
			expect(serializeRule(rule).serviceFilter).toEqual(["RADARR"]);
		}
	});

	it("canonicalizes nested IMDb create scope and validates owned enabled Radarr instances", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/rules", {
			body: {
				name: "Nested IMDb",
				ruleType: "composite",
				parameters: {},
				expression: {
					version: 1,
					root: {
						type: "not",
						child: {
							type: "condition",
							ruleType: "imdb_rating",
							parameters: { operator: "unrated" },
						},
					},
				},
				instanceFilter: ["radarr-1", "radarr-1"],
			},
		});
		expect(response.statusCode).toBe(201);
		expect(createRule).toHaveBeenCalledWith({
			data: expect.objectContaining({
				serviceFilter: JSON.stringify(["RADARR"]),
				instanceFilter: JSON.stringify(["radarr-1"]),
			}),
		});
		expect(findServiceInstances).toHaveBeenCalledWith({
			where: {
				id: { in: ["radarr-1"] },
				userId: "user-1",
				enabled: true,
				service: "RADARR",
			},
			select: { id: true },
		});
	});

	it.each([
		{ instanceFilter: ["sonarr-1"] },
		{ instanceFilter: ["radarr-1", "sonarr-1"] },
		{ instanceFilter: ["missing-1"] },
	])("rejects incompatible IMDb instance scope $instanceFilter", async ({ instanceFilter }) => {
		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/rules", {
			body: {
				name: "IMDb",
				ruleType: "imdb_rating",
				parameters: { operator: "unrated" },
				instanceFilter,
			},
		});
		expect(response.statusCode).toBe(400);
		expect(response.payload).toContain("enabled Radarr instances owned by this user");
	});

	it("rejects Sonarr service scope and canonicalizes a legacy IMDb update", async () => {
		findRule.mockResolvedValue(storedRule({ ruleType: "imdb_rating" }));
		const inject = createInjectAuthenticated(app);
		const rejected = await inject("PUT", "/library-cleanup/rules/rule-1", {
			body: { serviceFilter: ["SONARR"] },
		});
		expect(rejected.statusCode).toBe(400);

		const accepted = await inject("PUT", "/library-cleanup/rules/rule-1", {
			body: { name: "Renamed" },
		});
		expect(accepted.statusCode).toBe(200);
		expect(updateRule).toHaveBeenCalledWith({
			where: { id: "rule-1" },
			data: expect.objectContaining({ serviceFilter: JSON.stringify(["RADARR"]) }),
		});
	});
});
